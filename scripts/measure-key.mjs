// WebX68k のキー入力が末端(コア内 KeyBuf、および Human68k が消費した後の TVRAM)へ
// 到達するまでを計測する。docs/STORAGE-SCSI.md の「目的A：回帰の基準値」表の
// 「キー入力の末端到達」行の定義に従う。
//
// 2経路を同じ刺激(1回の合成キー押下/解放)から同時に観測するが、結果は別々の集計として
// 記録する。KeyBuf 経路は window.__webx68kDebug.keybuf() (src/libretro-host.ts の
// readKeyBufWindow、wasm の _webx68k_keybuf_peek/_webx68k_keybuf_write_pointer を薄く
// 包んだだけの受動読み取り)を使う。TVRAM 経路は screenText() のコマンド行を使う。
//
// 実装様式は scripts/measure-boot.mjs / scripts/measure-drives.mjs に合わせている
// (ヘッドフル Puppeteer、BrowserContext 分離、故障注入は --fault=、故障前に陽性対照、
// 短いスリープを避けて rAF ベースで待つ、キー保持/間隔は70ms以上、実行前に全キー解除)。

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { collectEnvironment, startLoadSampler, snapshotProcesses, buildLoadReport } from './measure-env.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const REQUIRED_STABLE_POLLS = 3;
const VALID_FAULTS = new Set(['drop-make', 'wrong-code', 'drop-break']);

// RETROK_TO_SCANCODE(src/keyboard.ts)から、複数のスキャンコード領域にまたがるよう
// 6キーを選んだ固定集合。0(RETROK[0])は make が2回書かれる特例のため avoid する
// (test/core-keyboard-integration.test.ts 参照)。
const TEST_KEYS = [
  { name: 'a', code: 'KeyA', key: 'a', char: 'a', scancode: 0x1e },
  { name: 'x', code: 'KeyX', key: 'x', char: 'x', scancode: 0x2b },
  { name: 'z', code: 'KeyZ', key: 'z', char: 'z', scancode: 0x2a },
  { name: '1', code: 'Digit1', key: '1', char: '1', scancode: 0x02 },
  { name: '2', code: 'Digit2', key: '2', char: '2', scancode: 0x03 },
  { name: 'c', code: 'KeyC', key: 'c', char: 'c', scancode: 0x2c },
];
// releaseAllKeys で解除する対象。TEST_KEYS 本体に加え、Backspace(行クリア)と
// リカバリ用の Enter/Ctrl+C も含める。
const ALL_KEY_SPECS = [
  ...TEST_KEYS.map(({ code, key }) => ({ code, key })),
  { code: 'Backspace', key: 'Backspace' },
  { code: 'Enter', key: 'Enter' },
  { code: 'ControlLeft', key: 'Control' },
  { code: 'KeyC', key: 'c' },
];

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const roundMs = (value) => (value === null || value === undefined ? null : Math.round(value * 1000) / 1000);

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} は正の整数で指定してください: ${value}`);
  }
  return parsed;
}

function parseKeyDelay(value, name) {
  const parsed = parsePositiveInteger(value, name);
  if (parsed < 34) throw new Error(`${name} は2フレーム相当の34ms以上で指定してください: ${value}`);
  return parsed;
}

function parseArgs(argv) {
  const values = {};
  for (const arg of argv) {
    if (arg === '--help') {
      values.help = true;
      continue;
    }
    if (arg === '--worker') {
      values.worker = true;
      continue;
    }
    const match =
      /^--(port|runs|fault-runs|boot-timeout|stimulus-timeout|poll-interval|key-hold|key-gap|clear-key-hold|clear-key-gap|output|fault)=(.+)$/.exec(
        arg,
      );
    if (!match) throw new Error(`不明な引数です: ${arg}`);
    values[match[1]] = match[2];
  }
  return values;
}

function printHelp() {
  console.log(`Usage: node scripts/measure-key.mjs [options]

  --port=<number>              dev server のポート (既定: 5183)
  --runs=<number>               本計測の刺激回数 (既定: 30)
  --fault-runs=<number>         故障注入1件あたりの刺激回数 (既定: 6、TEST_KEYS 1周分)
  --boot-timeout=<ms>           起動完了タイムアウト (既定: 90000)
  --stimulus-timeout=<ms>       刺激1回あたりのタイムアウト (既定: 3000)
  --poll-interval=<ms>          KeyBuf/TVRAM ポーリング間隔 (既定: 16、約1フレーム)
  --key-hold=<ms>                測定対象キーの保持時間 (既定: 70)
  --key-gap=<ms>                 測定対象キーの解放後の間隔 (既定: 70)
  --clear-key-hold=<ms>          コマンド行クリア用Backspaceの保持時間 (既定: 40)
  --clear-key-gap=<ms>           コマンド行クリア用Backspaceの間隔 (既定: 40)
  --output=<path>               JSON の保存先
  --fault=<drop-make|wrong-code|drop-break>  故障注入。先に故障なしの陽性対照を行う
  --worker                      計測対象URLに ?worker=1 を付け、起動完了後に
                                 window.__webx68kDebug.keybufProbeEnable(true) を呼んで
                                 Worker経路のKeyBufプローブ(frame event相乗り方式、
                                 docs/STORAGE-SCSI.md「KeyBufプローブのWorker対応」参照)
                                 を有効化する。未指定時の挙動には一切影響しない

環境変数: WEBX68K_PORT, WEBX68K_KEY_RUNS, WEBX68K_KEY_FAULT_RUNS,
          WEBX68K_KEY_BOOT_TIMEOUT_MS, WEBX68K_KEY_STIMULUS_TIMEOUT_MS,
          WEBX68K_KEY_POLL_INTERVAL_MS, WEBX68K_KEY_HOLD_MS, WEBX68K_KEY_GAP_MS,
          WEBX68K_KEY_CLEAR_HOLD_MS, WEBX68K_KEY_CLEAR_GAP_MS,
          WEBX68K_KEY_MEASURE_OUTPUT, WEBX68K_URL, CHROME_PATH`);
}

function defaultOutputPath() {
  const serial = new Date().toISOString().replace(/[:.]/g, '-');
  return join(REPO_ROOT, '_local', 'measure', `key-${serial}.json`);
}

function buildConfig(args) {
  const envUrl = process.env.WEBX68K_URL ? new URL(process.env.WEBX68K_URL) : null;
  const port = parsePositiveInteger(args.port ?? process.env.WEBX68K_PORT ?? envUrl?.port ?? '5183', 'port');
  const baseUrl = envUrl ?? new URL(`http://localhost:${port}`);
  baseUrl.port = String(port);
  const outputValue = args.output ?? process.env.WEBX68K_KEY_MEASURE_OUTPUT ?? defaultOutputPath();
  const fault = args.fault ?? null;
  if (fault !== null && !VALID_FAULTS.has(fault)) {
    throw new Error(`fault は drop-make・wrong-code・drop-break のいずれかを指定してください: ${fault}`);
  }
  return {
    baseUrl: baseUrl.href.replace(/\/$/, ''),
    port,
    runs: parsePositiveInteger(args.runs ?? process.env.WEBX68K_KEY_RUNS ?? '30', 'runs'),
    faultRuns: parsePositiveInteger(
      args['fault-runs'] ?? process.env.WEBX68K_KEY_FAULT_RUNS ?? String(TEST_KEYS.length),
      'fault-runs',
    ),
    bootTimeoutMs: parsePositiveInteger(
      args['boot-timeout'] ?? process.env.WEBX68K_KEY_BOOT_TIMEOUT_MS ?? '90000',
      'boot-timeout',
    ),
    stimulusTimeoutMs: parsePositiveInteger(
      args['stimulus-timeout'] ?? process.env.WEBX68K_KEY_STIMULUS_TIMEOUT_MS ?? '3000',
      'stimulus-timeout',
    ),
    pollIntervalMs: parsePositiveInteger(
      args['poll-interval'] ?? process.env.WEBX68K_KEY_POLL_INTERVAL_MS ?? '16',
      'poll-interval',
    ),
    keyHoldMs: parseKeyDelay(args['key-hold'] ?? process.env.WEBX68K_KEY_HOLD_MS ?? '70', 'key-hold'),
    keyGapMs: parseKeyDelay(args['key-gap'] ?? process.env.WEBX68K_KEY_GAP_MS ?? '70', 'key-gap'),
    clearKeyHoldMs: parseKeyDelay(
      args['clear-key-hold'] ?? process.env.WEBX68K_KEY_CLEAR_HOLD_MS ?? '40',
      'clear-key-hold',
    ),
    clearKeyGapMs: parseKeyDelay(
      args['clear-key-gap'] ?? process.env.WEBX68K_KEY_CLEAR_GAP_MS ?? '40',
      'clear-key-gap',
    ),
    outputPath: isAbsolute(outputValue) ? outputValue : resolve(REPO_ROOT, outputValue),
    executablePath: process.env.CHROME_PATH ?? DEFAULT_CHROME,
    fault,
    // Worker経路(?worker=1)の計測かどうか。既定はfalseで、既定計測(measurementUrl組み立て・
    // その他すべての挙動)には一切影響しない(scripts/measure-boot.mjsのworkerと同じ作法)。
    // resultのconfigへそのまま乗るため、結果ファイルだけを見てどちらの経路の測定かが
    // 必ず分かる(過去に結果ファイルから条件が分からず比較が無効になった事故があるため)。
    worker: args.worker === true,
  };
}

async function startServer(port) {
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
  let ready = false;
  let startupOutput = '';
  let spawnError = null;
  const inspectOutput = (buffer) => {
    const output = buffer.toString();
    startupOutput += output;
    if (output.includes('ready in') || /Local:\s+http/.test(output)) ready = true;
  };
  child.stdout.on('data', inspectOutput);
  child.stderr.on('data', inspectOutput);
  child.once('error', (error) => {
    spawnError = error;
  });

  const deadline = Date.now() + 20000;
  while (!ready && child.exitCode === null && !spawnError && Date.now() < deadline) await sleep(300);
  if (!ready) {
    await stopServer(child);
    const detail = spawnError?.message ?? startupOutput.trim();
    throw new Error(`dev server を起動できませんでした${detail ? `: ${detail}` : ''}`);
  }
  await sleep(500);
  return child;
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveStop) => {
    const timer = setTimeout(resolveStop, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill('SIGTERM');
  });
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

// docs/STORAGE-SCSI.md の「共通条件と記録形式」: 標本数・失敗数・最小・中央値・p90・p95・p99・
// 最大・MAD を持つ。
function summarize(samples, failedCount) {
  const sampleCount = samples.length;
  if (sampleCount === 0) {
    return {
      sampleCount: 0,
      failedCount,
      minMs: null,
      medianMs: null,
      p90Ms: null,
      p95Ms: null,
      p99Ms: null,
      maxMs: null,
      madMs: null,
    };
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const medianMs = percentile(sorted, 0.5);
  const deviations = sorted.map((value) => Math.abs(value - medianMs)).sort((left, right) => left - right);
  return {
    sampleCount,
    failedCount,
    minMs: roundMs(sorted[0]),
    medianMs: roundMs(medianMs),
    p90Ms: roundMs(percentile(sorted, 0.9)),
    p95Ms: roundMs(percentile(sorted, 0.95)),
    p99Ms: roundMs(percentile(sorted, 0.99)),
    maxMs: roundMs(sorted.at(-1)),
    madMs: roundMs(percentile(deviations, 0.5)),
  };
}

async function releaseAllKeys(page) {
  await page.evaluate((specs) => {
    for (const spec of specs) {
      window.dispatchEvent(
        new KeyboardEvent('keyup', {
          code: spec.code,
          key: spec.key,
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );
    }
  }, ALL_KEY_SPECS);
}

async function clickNamedButton(page, selector) {
  await page.waitForSelector(selector, { visible: true });
  const clicked = await page.evaluate((sel) => {
    const button = document.querySelector(sel);
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  }, selector);
  if (!clicked) throw new Error(`ボタンが見つかりません: ${selector}`);
}

async function waitForBootPrompt(page, timeoutMs, pollIntervalMs) {
  return page.evaluate(
    async ({ timeout, pollInterval, stablePolls }) => {
      const startedAt = performance.now();
      let lastPollAt = -Infinity;
      let consecutive = 0;
      let lastAPromptLine = null;
      while (performance.now() - startedAt < timeout) {
        await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
        const now = performance.now();
        if (now - lastPollAt < pollInterval) continue;
        lastPollAt = now;
        let dump = null;
        try {
          dump = (await window.__webx68kDebug?.screenText?.()) ?? null;
        } catch {
          consecutive = 0;
          continue;
        }
        if (!dump?.available || !Array.isArray(dump.lines)) {
          consecutive = 0;
          continue;
        }
        const lines = dump.lines.filter((line) => line.length > 0);
        lastAPromptLine = lines.filter((line) => line.startsWith('A>')).at(-1) ?? null;
        const remainderLength =
          lastAPromptLine === null ? Number.POSITIVE_INFINITY : Array.from(lastAPromptLine.slice(2)).length;
        consecutive = lastAPromptLine !== null && remainderLength <= 1 ? consecutive + 1 : 0;
        if (consecutive >= stablePolls) {
          return { success: true, durationMs: performance.now() - startedAt, lastAPromptLine };
        }
      }
      return { success: false, durationMs: performance.now() - startedAt, lastAPromptLine };
    },
    { timeout: timeoutMs, pollInterval: pollIntervalMs, stablePolls: REQUIRED_STABLE_POLLS },
  );
}

/**
 * 1回の刺激(合成キー押下→保持→解放)を、KeyBuf経路とTVRAM経路を同時に観測しながら実行する。
 * 故障注入は実際のDOMイベント送出そのものを変える(コアや src/ を変更しない):
 *   drop-make  : keydown を送らない → KeyBuf に make が一切書かれない
 *   wrong-code : 期待と異なるキーの code/key を送る → 期待スキャンコード/文字と食い違う
 *   drop-break : keyup を観測窓の間送らない(窓が閉じた後にだけ後始末で送る) → break が残留
 * KeyBuf は window.__webx68kDebug.keybuf(start, count) (受動読み取りのみ、毎フレーム処理には
 * 関与しない)。TVRAM はコマンド行のカーソル1文字だけを許容する既存の慣習
 * (measure-drives.mjs の commandLineMatches と同じ考え方)に揃える。
 */
function runStimulus(page, keySpec, wrongSpec, config, faultKind) {
  return page.evaluate(
    async ({ spec, wrong, keyHold, keyGap, pollInterval, timeout, fault, worker }) => {
      const nextFrame = () => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      const dispatch = (type, code, key) => {
        window.dispatchEvent(
          new KeyboardEvent(type, { code, key, bubbles: true, composed: true, cancelable: true }),
        );
      };
      const readPromptLine = async () => {
        const dump = await window.__webx68kDebug?.screenText?.();
        if (!dump?.available || !Array.isArray(dump.lines)) return null;
        const lines = dump.lines.filter((line) => line.length > 0);
        return lines.filter((line) => line.startsWith('A>')).at(-1) ?? null;
      };
      const readKeyBuf = (start, count) => window.__webx68kDebug?.keybuf?.(start, count) ?? null;
      // 帰属計測(コーディネータ指摘の訂正、docs/STORAGE-SCSI.md「帰属の切り分け」参照)。
      // worker経路でのみ意味を持つ。frameNoベースなので既定経路(host直読み)には無関係。
      const readAttribution = () => (worker ? (window.__webx68kDebug?.keybufAttribution?.() ?? null) : null);
      // カーソルは点滅により行末へ1文字だけ付いたり消えたりし、U+FFFD として観測される
      // (docs/STORAGE-SCSI.md の予備確認結果)。実際に入力された文字の重複と区別するため、
      // 「target と完全一致」「target + 末尾ちょうど1個のU+FFFD」だけを一致とみなし、
      // それ以外の末尾付加(同じ文字の重複を含む)は一致とみなさない。
      const classifyAgainstTarget = (line, target) => {
        if (line === null) return 'missing';
        if (line === target) return 'exact';
        if (!line.startsWith(target)) return 'mismatch';
        const tail = Array.from(line.slice(target.length));
        if (tail.length === 1 && tail[0].codePointAt(0) === 0xfffd) return 'cursor';
        return 'extra';
      };
      // カーソルの点滅だけによる見かけ上の変化を「入力による変化」と誤認しないよう、
      // 末尾のU+FFFD1個を取り除いた「実内容」で比較する。
      const stripTrailingCursor = (line) => {
        if (line === null) return null;
        const chars = Array.from(line);
        if (chars.length > 0 && chars.at(-1).codePointAt(0) === 0xfffd) return chars.slice(0, -1).join('');
        return line;
      };

      const baselineLine = await readPromptLine();
      const baselineContent = stripTrailingCursor(baselineLine);
      const startProbe = readKeyBuf(0, 0);
      if (startProbe === null || startProbe.workerProbeDisabled || startProbe.workerProbePending) {
        // null(既定経路のみ): wasmにexportが無い(古いwasmの可能性)。
        // workerProbeDisabled(Worker経路のみ): keybufProbeEnable(true)を呼び忘れている。
        // workerProbePending(Worker経路のみ): 有効化直後でまだ1フレームも届いていない
        // (通常はmeasureOnce側の起動直後の待機で解消されるはずだが、念のため個々の刺激でも
        // 区別できるようにしてある)。
        let harnessError;
        if (startProbe && startProbe.workerProbeDisabled) {
          harnessError =
            'Worker経路のKeyBufプローブが無効です(window.__webx68kDebug.keybufProbeEnable(true)を呼び忘れています)';
        } else if (startProbe && startProbe.workerProbePending) {
          harnessError = 'Worker経路のKeyBufプローブがまだ1フレームも届いていません(起動直後の可能性があります)';
        } else {
          harnessError =
            'KeyBufプローブが利用できません。既定経路の古いwasmの可能性があります(scripts/build-core.sh で再ビルドが必要)';
        }
        return { harnessError };
      }
      const startWp = startProbe.writePointer;

      const dispatchCode = fault === 'wrong-code' ? wrong.code : spec.code;
      const dispatchKey = fault === 'wrong-code' ? wrong.key : spec.key;
      // 期待するコマンド行は常に「A>」+入力対象の文字。行クリアが不完全な場合はそもそも
      // baselineLine が汚れているはずなので、その状態も結果へ残す。
      const targetLine = `A>${spec.char}`;

      const t0 = performance.now();
      // makeの送信直前(dispatchの直前)に、mainがこの瞬間に知っているWorker側frameNoを
      // 控える。keydownハンドラ(applyKey→sendWorkerInputUpdate、即時送信化済み)は
      // dispatchEvent()の中で同期的に呼ばれるため、dispatch直後に読めば「この送信が
      // 使ったframeNo」が取れる。
      let makeSendFrameNo = null;
      if (fault !== 'drop-make') {
        dispatch('keydown', dispatchCode, dispatchKey);
        makeSendFrameNo = readAttribution()?.inputSendFrameNo ?? null;
      }

      let makeByte = null;
      let makeAt = null;
      let makeWriteFrameNo = null;
      let makeObserveFrameNo = null;
      let firstChangedLine = null;
      let firstChangedLineClass = null;
      let echoAt = null;
      let keyupAt = null;
      let breakSendFrameNo = null;
      const holdDeadline = t0 + keyHold;
      let lastPollAt = -Infinity;

      while (performance.now() - t0 < timeout) {
        await nextFrame();
        const now = performance.now();
        if (now - lastPollAt >= pollInterval) {
          lastPollAt = now;
          if (makeAt === null) {
            // KeyBufは128バイトのリングで、start位置には何周も前の古い値(0以外もありうる。
            // 実測でBackspaceのmakeコード0x0fが居残っていた)が残っている可能性がある。
            // 「値が0以外になった」ではなく「書き込みポインタがstartを追い越した」ことを
            // 新規書き込みの根拠にする。
            const probe = readKeyBuf(startWp, 1);
            if (probe && probe.writePointer !== startWp) {
              makeByte = probe.bytes[0];
              makeAt = now;
              // 帰属計測: 検出したこの瞬間のwriteFrameNo(書かれたフレーム)と
              // currentFrameNo(mainが受信済みの最新フレーム。観測の遅れの終点)を控える。
              const attribution = readAttribution();
              if (attribution) {
                makeWriteFrameNo = attribution.writeFrameNo;
                makeObserveFrameNo = attribution.currentFrameNo;
              }
            }
          }
          if (echoAt === null) {
            const line = await readPromptLine();
            const content = stripTrailingCursor(line);
            // カーソル点滅だけの揺らぎ(実内容が baseline と同じ)は無視し、実内容が
            // baseline と異なる場合だけを「入力が反映された」とみなす。
            if (content !== null && content !== baselineContent) {
              firstChangedLine = line;
              firstChangedLineClass = classifyAgainstTarget(line, targetLine);
              echoAt = now;
            }
          }
        }
        if (keyupAt === null && now >= holdDeadline) {
          keyupAt = now;
          if (fault !== 'drop-make' && fault !== 'drop-break') {
            dispatch('keyup', dispatchCode, dispatchKey);
            breakSendFrameNo = readAttribution()?.inputSendFrameNo ?? null;
          }
        }
        // make・echo・keyupが出揃ってから、break到達確認のため最低でも数フレーム分は
        // 観測を続ける(直後に打ち切ると残留押下を取りこぼす)。Worker経路はKeyBufが
        // frame event相乗り方式(docs/STORAGE-SCSI.md「KeyBufプローブのWorker対応」参照)で、
        // 入力の反映(main→Worker)と観測(Worker→main)の両方にpostMessageの往復が挟まるため、
        // 既定経路の6ポーリングぶんの余裕では足りず陽性対照がまれに揺らぐことを実測で確認した。
        // そのため経路ごとに余裕を変える(既定経路の挙動・タイミングは変えない)。
        //
        // ただし drop-break だけは例外にする: この故障注入は「観測窓の間 keyup を送らない」
        // ことで break 欠落を作るため、keyupAt はここでは実際の送出時刻ではなく単なる目印で
        // あり、margin を延ばすほどキーを物理的に押しっぱなしにする時間(keyHold + margin)が
        // 延びる。Worker側の余裕(18ポーリング=288ms)まで延ばすと合計保持時間が
        // KeyRepeaterのリピート開始しきい値を越え、観測窓の間に自動リピートのmakeが
        // KeyBufへ追加注入されてしまい、break欠落ではなく「誤字/重複」として誤検出される
        // ことを実測で確認した(worker経路固有。Worker側のSRAMキーリピート追従は未移行の
        // ため既定のリピート間隔で走る)。drop-break は元々この延長を必要としない
        // (keyupを送っていないのだから、待っても break は書かれない)ため、常に既定経路と
        // 同じ短い margin のままにする。
        const breakMarginPolls = worker && fault !== 'drop-break' ? 18 : 6;
        if (makeAt !== null && echoAt !== null && keyupAt !== null && now - keyupAt > pollInterval * breakMarginPolls) {
          break;
        }
      }

      // drop-break の観測窓はここで終わる。後始末として、次の刺激へ影響しないよう
      // 実際に離す(観測窓の外なので breakAt の測定対象にはしない)。
      if (fault === 'drop-break' && keyupAt === null) {
        keyupAt = performance.now();
      }
      if (fault === 'drop-break') dispatch('keyup', dispatchCode, dispatchKey);

      const breakProbe = readKeyBuf(startWp, 2);
      const breakByte = breakProbe ? breakProbe.bytes[1] : null;
      const finalWp = breakProbe ? breakProbe.writePointer : null;
      const breakAttribution = readAttribution();

      return {
        harnessError: null,
        dispatchCode,
        dispatchKey,
        startWp,
        finalWp,
        baselineLine,
        targetLine,
        firstChangedLine,
        firstChangedLineClass,
        makeByte,
        makeAtMs: makeAt === null ? null : makeAt - t0,
        echoAtMs: echoAt === null ? null : echoAt - t0,
        // 帰属計測(worker経路のみ非null。既定経路は常にnull)。
        attribution: worker
          ? {
              makeSendFrameNo,
              makeWriteFrameNo,
              makeObserveFrameNo,
              breakSendFrameNo,
              breakWriteFrameNo: breakAttribution?.writeFrameNo ?? null,
              breakObserveFrameNo: breakAttribution?.currentFrameNo ?? null,
            }
          : null,
        breakByte,
        timedOut: makeAt === null || echoAt === null,
      };
    },
    {
      spec: keySpec,
      wrong: wrongSpec,
      keyHold: config.keyHoldMs,
      keyGap: config.keyGapMs,
      pollInterval: config.pollIntervalMs,
      timeout: config.stimulusTimeoutMs,
      fault: faultKind,
      worker: config.worker,
    },
  );
}

async function clearCommandLine(page, config, faultKind) {
  const backspaceCount = faultKind ? 12 : 4;
  await page.evaluate(
    async ({ count, keyHold, keyGap }) => {
      const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
      for (let i = 0; i < count; i++) {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            code: 'Backspace',
            key: 'Backspace',
            bubbles: true,
            composed: true,
            cancelable: true,
          }),
        );
        await wait(keyHold);
        window.dispatchEvent(
          new KeyboardEvent('keyup', {
            code: 'Backspace',
            key: 'Backspace',
            bubbles: true,
            composed: true,
            cancelable: true,
          }),
        );
        await wait(keyGap);
      }
    },
    { count: backspaceCount, keyHold: config.clearKeyHoldMs, keyGap: config.clearKeyGapMs },
  );
}

async function readPromptLineOnPage(page) {
  return page.evaluate(async () => {
    const dump = await window.__webx68kDebug?.screenText?.();
    if (!dump?.available || !Array.isArray(dump.lines)) return null;
    const lines = dump.lines.filter((line) => line.length > 0);
    return lines.filter((line) => line.startsWith('A>')).at(-1) ?? null;
  });
}

function isCleanPromptLine(line) {
  if (line === null) return false;
  if (line === 'A>') return true;
  if (!line.startsWith('A>')) return false;
  const tail = Array.from(line.slice(2));
  // カーソル点滅により末尾へ1文字だけ付くことを許容する(値の種類は問わない。空プロンプト
  // の段階では既知のU+FFFD以外の値は観測されていないが、識別できない揺らぎまで
  // 「未クリア」と誤診しないための余裕)。
  return tail.length <= 1;
}

/**
 * コマンド行を「A>」(+カーソル1文字まで)へ確実に戻す。不完全なクリアを残したまま次の
 * 刺激へ進むと、その刺激の入力が残留文字の直後に挿入され、TVRAM経路の誤字判定が
 * 実際の入力とは無関係な原因で発生してしまうため、クリア後に必ず検証し、汚れていれば
 * 追加でクリアし直す。
 */
async function ensureCleanPromptLine(page, config, faultKind) {
  const maxAttempts = 3;
  const warnings = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await clearCommandLine(page, config, faultKind);
    const line = await readPromptLineOnPage(page);
    if (isCleanPromptLine(line)) return { clean: true, attempts: attempt, warnings };
    warnings.push({ attempt, line });
  }
  return { clean: false, attempts: maxAttempts, warnings };
}

/**
 * 1件の刺激の生結果を、KeyBuf経路・TVRAM経路それぞれの分類へ変換する。
 * 欠落/誤字/重複/残留押下は排他的に判定する(欠落でなければ誤字判定、というように)。
 */
function classifyStimulus(spec, wrongSpec, faultKind, raw) {
  if (raw.harnessError) {
    return { harnessError: raw.harnessError };
  }
  const expectedScancode = spec.scancode;
  const expectedChar = spec.char;
  const expectedBreakByte = expectedScancode | 0x80;

  // finalWp は clearCommandLine 等の後始末より前、刺激1件の観測窓の終わりに読んだ値。
  // startWpからの増分(& 127)で「本当に何バイト書かれたか」を判定する。KeyBufはリングで
  // 古い値が残るため、breakByte(=peek(start+1))の中身が非0であることを根拠にはできない
  // (何周も前のBackspaceのbreakコードが残っていた実例がある)。増分が2未満なら、break位置は
  // まだ今回の書き込みで上書きされていないとみなし、欠落として扱う。
  const incrementMasked = raw.finalWp === null ? null : (raw.finalWp - raw.startWp) & 127;
  const keybufMissingMake = raw.makeByte === null;
  const keybufWrongMake = !keybufMissingMake && raw.makeByte !== expectedScancode;
  const keybufMissingBreak = keybufMissingMake || incrementMasked === null || incrementMasked < 2;
  const keybufWrongBreak =
    !keybufMissingBreak && raw.breakByte !== expectedBreakByte;
  const keybufDuplicate =
    !keybufMissingMake && !keybufMissingBreak && incrementMasked !== null && incrementMasked !== 2;

  const baselineLen = raw.baselineLine === null ? 0 : Array.from(raw.baselineLine.slice(2)).length;
  const tvramMissingEcho = raw.firstChangedLine === null;
  const tvramWrongEcho = !tvramMissingEcho && raw.firstChangedLineClass === 'mismatch';
  const tvramDuplicateEcho = !tvramMissingEcho && raw.firstChangedLineClass === 'extra';

  // 帰属(worker経路のみ、docs/STORAGE-SCSI.md「帰属の切り分け」参照)。
  //   注入フレーム数 = writeFrameNo - sendFrameNo (keydown/keyup発生→updateInput送信→実際に
  //     適用されたフレームまでの遅れ)
  //   観測フレーム数 = observeFrameNo - writeFrameNo (書かれたフレーム→mainが知るフレームまでの遅れ)
  // いずれかがnullなら計算できない(未検出・既定経路)ためnullのまま残す。
  const framesDiff = (a, b) => (a === null || a === undefined || b === null || b === undefined ? null : a - b);
  const attribution = raw.attribution
    ? {
        makeInjectionFrames: framesDiff(raw.attribution.makeWriteFrameNo, raw.attribution.makeSendFrameNo),
        makeObservationFrames: framesDiff(raw.attribution.makeObserveFrameNo, raw.attribution.makeWriteFrameNo),
        breakInjectionFrames: framesDiff(raw.attribution.breakWriteFrameNo, raw.attribution.breakSendFrameNo),
        breakObservationFrames: framesDiff(raw.attribution.breakObserveFrameNo, raw.attribution.breakWriteFrameNo),
        raw: raw.attribution,
      }
    : null;

  return {
    harnessError: null,
    key: spec.name,
    dispatchedKey: faultKind === 'wrong-code' ? wrongSpec.name : spec.name,
    expectedScancode,
    expectedChar,
    baselineLen,
    keybuf: {
      startWp: raw.startWp,
      finalWp: raw.finalWp,
      incrementMasked,
      makeByte: raw.makeByte,
      breakByte: raw.breakByte,
      makeAtMs: roundMs(raw.makeAtMs),
      missingMake: keybufMissingMake,
      wrongMake: keybufWrongMake,
      missingBreak: keybufMissingBreak,
      wrongBreak: keybufWrongBreak,
      duplicate: keybufDuplicate,
      ok: !keybufMissingMake && !keybufWrongMake && !keybufMissingBreak && !keybufWrongBreak && !keybufDuplicate,
    },
    tvram: {
      baselineLine: raw.baselineLine,
      firstChangedLine: raw.firstChangedLine,
      echoAtMs: roundMs(raw.echoAtMs),
      missingEcho: tvramMissingEcho,
      wrongEcho: tvramWrongEcho,
      duplicateEcho: tvramDuplicateEcho,
      ok: !tvramMissingEcho && !tvramWrongEcho && !tvramDuplicateEcho,
    },
    attribution,
  };
}

// 環境収集(scripts/measure-env.mjs)は最初の試行のページが開いている間・context.close()の
// 前に1回だけ行う(envCapture.valueがundefinedの間だけ実行)。
async function measureOnce(browser, config, trial, faultKind, stimulusCount, envCapture) {
  const context = await browser.createBrowserContext();
  let page = null;
  try {
    page = await context.newPage();
    await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 2 });
    await page.bringToFront();
    let measurementUrl = config.baseUrl;
    if (config.worker) {
      // 既定(--worker未指定)ではこの分岐に入らず、measurementUrl は従来どおり
      // (scripts/measure-boot.mjs と同じ作法)。
      const url = new URL(measurementUrl);
      url.searchParams.set('worker', '1');
      measurementUrl = url.href;
    }
    await page.goto(measurementUrl, { waitUntil: 'networkidle2' });
    await page.bringToFront();

    // 前試行が例外・タイムアウトで中断されていても、開始前に全キーを解放する。
    await releaseAllKeys(page);
    await clickNamedButton(page, '#btn-boot-system');
    const boot = await waitForBootPrompt(page, config.bootTimeoutMs, config.pollIntervalMs);
    if (!boot.success) {
      throw new Error(`起動完了を確認できませんでした (lastAPromptLine=${boot.lastAPromptLine ?? 'なし'})`);
    }
    if (config.worker) {
      // Worker経路のKeyBufプローブ(frame event相乗り方式)を有効化する。刺激開始前に、
      // 実際に1フレームぶんのデータが届くまで待つ(有効化直後はまだ workerProbePending の
      // ことがある。docs/STORAGE-SCSI.md「KeyBufプローブのWorker対応」参照)。
      await page.evaluate(() => {
        window.__webx68kDebug?.keybufProbeEnable?.(true);
      });
      const probeReady = await page.evaluate(async () => {
        for (let i = 0; i < 120; i++) {
          const probe = window.__webx68kDebug?.keybuf?.(0, 0);
          if (probe && !probe.workerProbeDisabled && !probe.workerProbePending) return true;
          await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
        }
        return false;
      });
      if (!probeReady) {
        throw new Error(
          'Worker経路のKeyBufプローブがkeybufProbeEnable(true)後も120フレーム以内に届きませんでした',
        );
      }
    }
    // プロンプト安定判定はポーリング間隔の粒度で「連続3回」を見ているだけであり、
    // ゲスト側の入力ポーリングが同じ瞬間に確実に回っている保証ではない。実測で、安定判定
    // 直後の最初の刺激だけがまれにKeyBuf/TVRAMのどちらにも一切現れないことがあったため、
    // 最初の刺激の前だけ数フレーム分の余裕を入れる(短いスリープの多用ではなくrAFベース)。
    await page.evaluate(async () => {
      for (let i = 0; i < 20; i++) await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
    });
    // 起動直後の行が想定外に汚れている場合に備え、最初に一度クリアしておく。
    const cleanBeforeAny = await ensureCleanPromptLine(page, config, faultKind);

    const stimuli = [];
    const uncleanBefore = [];
    for (let i = 0; i < stimulusCount; i++) {
      const spec = TEST_KEYS[i % TEST_KEYS.length];
      const wrongSpec = TEST_KEYS[(i + 1) % TEST_KEYS.length];
      const raw = await runStimulus(page, spec, wrongSpec, config, faultKind);
      const classified = classifyStimulus(spec, wrongSpec, faultKind, raw);
      stimuli.push({ index: i, ...classified });
      await sleep(config.keyGapMs);
      const cleaned = await ensureCleanPromptLine(page, config, faultKind);
      if (!cleaned.clean) uncleanBefore.push({ afterStimulus: i, ...cleaned });
    }

    const harnessErrors = stimuli.filter((s) => s.harnessError);
    if (harnessErrors.length > 0) {
      throw new Error(harnessErrors[0].harnessError);
    }

    const keybufOkCount = stimuli.filter((s) => s.keybuf.ok).length;
    const tvramOkCount = stimuli.filter((s) => s.tvram.ok).length;
    return {
      trial,
      fault: faultKind,
      success:
        keybufOkCount === stimuli.length && tvramOkCount === stimuli.length && uncleanBefore.length === 0,
      boot: { ...boot, durationMs: roundMs(boot.durationMs) },
      cleanBeforeAny,
      uncleanBefore,
      stimuli,
      counts: {
        total: stimuli.length,
        keybuf: {
          ok: keybufOkCount,
          missingMake: stimuli.filter((s) => s.keybuf.missingMake).length,
          wrongMake: stimuli.filter((s) => s.keybuf.wrongMake).length,
          missingBreak: stimuli.filter((s) => s.keybuf.missingBreak).length,
          wrongBreak: stimuli.filter((s) => s.keybuf.wrongBreak).length,
          duplicate: stimuli.filter((s) => s.keybuf.duplicate).length,
        },
        tvram: {
          ok: tvramOkCount,
          missingEcho: stimuli.filter((s) => s.tvram.missingEcho).length,
          wrongEcho: stimuli.filter((s) => s.tvram.wrongEcho).length,
          duplicateEcho: stimuli.filter((s) => s.tvram.duplicateEcho).length,
        },
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      trial,
      fault: faultKind,
      success: false,
      reason: 'measurement-error',
      error: message,
      stimuli: [],
      counts: null,
    };
  } finally {
    if (page && !page.isClosed()) {
      try {
        await releaseAllKeys(page);
      } catch {
        // ページが壊れていても context.close() は必ず続行する。
      }
    }
    if (envCapture && envCapture.value === undefined && page) {
      envCapture.value = await collectEnvironment(page).catch(() => null);
    }
    await context.close();
  }
}

function buildFaultCheck(faultKind, positiveControl, faultTrial) {
  if (!faultKind) return null;
  const positiveControlPassed = positiveControl?.success === true;
  if (!positiveControlPassed) {
    return {
      fault: faultKind,
      positiveControlPassed: false,
      passed: false,
      reason: 'positive-control-failed: 正常系が成功せず検出力を確認できない',
    };
  }
  if (!faultTrial || faultTrial.counts === null) {
    return {
      fault: faultKind,
      positiveControlPassed: true,
      passed: false,
      reason: `故障注入試行がエラーで完走しなかった: ${faultTrial?.error ?? '不明'}`,
    };
  }
  const c = faultTrial.counts;
  const total = c.total;
  let expectationsMet;
  let description;
  if (faultKind === 'drop-make') {
    expectationsMet =
      c.keybuf.missingMake === total &&
      c.keybuf.wrongMake === 0 &&
      c.keybuf.duplicate === 0 &&
      c.tvram.missingEcho === total &&
      c.tvram.wrongEcho === 0 &&
      c.tvram.duplicateEcho === 0;
    description = 'KeyBufのmake欠落とTVRAMエコー欠落が全試行で発生し、他の異常は発生しない';
  } else if (faultKind === 'wrong-code') {
    expectationsMet =
      c.keybuf.wrongMake === total &&
      c.keybuf.missingMake === 0 &&
      c.tvram.wrongEcho === total &&
      c.tvram.missingEcho === 0 &&
      c.tvram.duplicateEcho === 0;
    description = 'KeyBufの誤スキャンコードとTVRAMの誤字が全試行で発生し、欠落は発生しない';
  } else {
    expectationsMet =
      c.keybuf.missingBreak === total &&
      c.keybuf.missingMake === 0 &&
      c.keybuf.wrongMake === 0;
    description = 'KeyBufのbreak欠落(残留押下)が全試行で発生し、makeは正常に届く';
  }
  return {
    fault: faultKind,
    positiveControlPassed: true,
    description,
    counts: c,
    passed: expectationsMet,
    reason: expectationsMet ? null : '期待した異常パターンと一致しない(詳細は counts を参照)',
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const config = buildConfig(args);
  let server = null;
  let browser = null;
  let profile = null;
  let loadSampler = null;
  try {
    // 負荷の記録: 計測の全区間(反復試行すべて)にわたって os.loadavg() を継続
    // サンプリングする。計測窓の「外」の前後1回だけプロセススナップショットを取る。
    const processesBefore = await snapshotProcesses();
    loadSampler = startLoadSampler();
    server = await startServer(config.port);
    profile = await mkdtemp(join(tmpdir(), 'webx68k-measure-key-'));
    browser = await puppeteer.launch({
      executablePath: config.executablePath,
      userDataDir: profile,
      // headless では rAF がスロットルされるため、ヘッドフル・前面タブで計測する。
      headless: false,
      args: ['--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=1000,900'],
    });

    let positiveControl = null;
    let faultTrial = null;
    let mainTrial = null;
    // 環境収集は全試行を通して1回だけ行う(measure-boot.mjsと同じ方式)。
    const envCapture = { value: undefined };

    if (config.fault) {
      // 故障注入の前に、故障なしの正常系が成功として検出できることを必ず確認する。
      // 常に失敗する検出器も故障注入だけなら通過してしまうため。
      positiveControl = await measureOnce(browser, config, 0, null, config.faultRuns, envCapture);
      if (positiveControl.success) {
        faultTrial = await measureOnce(browser, config, 1, config.fault, config.faultRuns, envCapture);
      }
    } else {
      mainTrial = await measureOnce(browser, config, 1, null, config.runs, envCapture);
    }
    if (envCapture.value === undefined) {
      const fallbackContext = await browser.createBrowserContext();
      try {
        const fallbackPage = await fallbackContext.newPage();
        envCapture.value = await collectEnvironment(fallbackPage).catch(() => null);
      } finally {
        await fallbackContext.close();
      }
    }

    // 負荷の記録: 反復試行がすべて終わった時点でサンプラーを止め、終了直後のプロセス
    // スナップショットを取って load レポートを組み立てる。
    const processesAfter = await snapshotProcesses();
    const loadReport = buildLoadReport({
      sampler: loadSampler.stop(),
      processesBefore,
      processesAfter,
    });
    if (envCapture.value) {
      envCapture.value.load = loadReport;
    } else {
      envCapture.value = { load: loadReport };
    }

    const faultCheck = config.fault ? buildFaultCheck(config.fault, positiveControl, faultTrial) : null;

    let result;
    if (config.fault) {
      result = {
        schemaVersion: 1,
        measuredAt: new Date().toISOString(),
        environment: envCapture.value ?? null,
        measurement: 'キー入力の末端到達(KeyBuf経路・TVRAM経路)の測定系検証(故障注入)',
        config,
        positiveControl,
        faultTrial,
        faultCheck,
      };
    } else {
      const stimuli = mainTrial?.stimuli ?? [];
      const keybufSamples = stimuli
        .filter((s) => s.keybuf?.ok && Number.isFinite(s.keybuf.makeAtMs))
        .map((s) => s.keybuf.makeAtMs);
      const tvramSamples = stimuli
        .filter((s) => s.tvram?.ok && Number.isFinite(s.tvram.echoAtMs))
        .map((s) => s.tvram.echoAtMs);
      const keybufFailed = stimuli.filter((s) => !s.keybuf?.ok).length;
      const tvramFailed = stimuli.filter((s) => !s.tvram?.ok).length;
      // 帰属(worker経路のみ、docs/STORAGE-SCSI.md「帰属の切り分け」参照)。フレーム数は
      // 整数の小さな系列なので、summarize()のms向けラウンディングは使わずシンプルに集計する。
      const frameStats = (values) => {
        const finite = values.filter((v) => Number.isFinite(v));
        if (finite.length === 0) return { sampleCount: 0, minFrames: null, medianFrames: null, maxFrames: null };
        const sorted = [...finite].sort((a, b) => a - b);
        return {
          sampleCount: finite.length,
          minFrames: sorted[0],
          medianFrames: percentile(sorted, 0.5),
          maxFrames: sorted.at(-1),
        };
      };
      const attribution = config.worker
        ? {
            makeInjectionFrames: frameStats(stimuli.map((s) => s.attribution?.makeInjectionFrames)),
            makeObservationFrames: frameStats(stimuli.map((s) => s.attribution?.makeObservationFrames)),
            breakInjectionFrames: frameStats(stimuli.map((s) => s.attribution?.breakInjectionFrames)),
            breakObservationFrames: frameStats(stimuli.map((s) => s.attribution?.breakObservationFrames)),
          }
        : null;
      result = {
        schemaVersion: 1,
        measuredAt: new Date().toISOString(),
        environment: envCapture.value ?? null,
        measurement:
          'キー入力の末端到達: 合成KeyboardEventからKeyBuf到達(コア末端)・TVRAMエコーバック(アプリ末端)までの時間',
        config,
        mainTrial,
        summary: {
          success: mainTrial?.success ?? false,
          totalStimuli: stimuli.length,
          keybuf: {
            ...summarize(keybufSamples, keybufFailed),
            missingMake: stimuli.filter((s) => s.keybuf?.missingMake).length,
            wrongMake: stimuli.filter((s) => s.keybuf?.wrongMake).length,
            missingBreak: stimuli.filter((s) => s.keybuf?.missingBreak).length,
            duplicate: stimuli.filter((s) => s.keybuf?.duplicate).length,
          },
          tvram: {
            ...summarize(tvramSamples, tvramFailed),
            missingEcho: stimuli.filter((s) => s.tvram?.missingEcho).length,
            wrongEcho: stimuli.filter((s) => s.tvram?.wrongEcho).length,
            duplicateEcho: stimuli.filter((s) => s.tvram?.duplicateEcho).length,
          },
          attribution,
        },
        limitations: [
          '自動計測は合成KeyboardEvent経由のDOMイベント経路であり、物理キーボードの保証にはならない',
          'KeyBuf到達時間・TVRAMエコー時間はいずれもポーリング観測であり、最大でpollIntervalMs分の観測遅延を含む',
          'TEST_KEYSの6キー(a/x/z/1/2/c)のみを対象とし、全キーを網羅していない',
        ],
      };
    }

    await mkdir(dirname(config.outputPath), { recursive: true });
    await writeFile(config.outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

    if (config.fault) {
      console.log(
        `陽性対照: ${positiveControl.success ? '成功' : '失敗(検出力を確認できない)'}${
          positiveControl.counts ? ` (keybuf ok=${positiveControl.counts.keybuf.ok}/${positiveControl.counts.total}, tvram ok=${positiveControl.counts.tvram.ok}/${positiveControl.counts.total})` : ''
        }`,
      );
      if (faultTrial?.counts) {
        console.log(
          `故障注入 ${config.fault}: keybuf ${JSON.stringify(faultTrial.counts.keybuf)}, ` +
            `tvram ${JSON.stringify(faultTrial.counts.tvram)}`,
        );
      }
      console.log(`故障注入 ${config.fault}: ${faultCheck.passed ? '期待どおり検出' : `検出失敗(${faultCheck.reason})`}`);
      console.log(`出力: ${config.outputPath}`);
      if (!faultCheck.passed) process.exitCode = 1;
    } else {
      const s = result.summary;
      // 移行前基準の表は「機能失敗(欠落/誤字/重複)は0件、1件でも出たら不合格」と定めている。
      // 中央値等のtimingを先に読ませると位置づけを誤りやすいため、合否を必ず先頭に出す。
      console.log(
        `キー入力計測(経路: ${config.worker ? 'worker' : '既定'}): ${s.success ? '合格' : '不合格'}` +
          `(機能失敗 keybuf ${s.keybuf.missingMake + s.keybuf.wrongMake + s.keybuf.missingBreak + s.keybuf.duplicate}件 / ` +
          `tvram ${s.tvram.missingEcho + s.tvram.wrongEcho + s.tvram.duplicateEcho}件), ` +
          `刺激数 ${s.totalStimuli}, 出力 ${config.outputPath}`,
      );
      console.log(
        `KeyBuf経路(timing参考値。不合格でも中央値自体は出る): ok ${s.keybuf.sampleCount}/${s.totalStimuli}, ` +
          `中央値 ${s.keybuf.medianMs ?? '-'} ms, p95 ${s.keybuf.p95Ms ?? '-'} ms, p99 ${s.keybuf.p99Ms ?? '-'} ms, ` +
          `欠落make ${s.keybuf.missingMake}, 誤字make ${s.keybuf.wrongMake}, ` +
          `欠落break ${s.keybuf.missingBreak}, 重複 ${s.keybuf.duplicate}`,
      );
      console.log(
        `TVRAM経路: ok ${s.tvram.sampleCount}/${s.totalStimuli}, 中央値 ${s.tvram.medianMs ?? '-'} ms, ` +
          `p95 ${s.tvram.p95Ms ?? '-'} ms, p99 ${s.tvram.p99Ms ?? '-'} ms, ` +
          `欠落 ${s.tvram.missingEcho}, 誤字 ${s.tvram.wrongEcho}, 重複 ${s.tvram.duplicateEcho}`,
      );
      if (s.attribution) {
        const a = s.attribution;
        console.log(
          `帰属(フレーム数、worker経路のみ): make注入 中央値${a.makeInjectionFrames.medianFrames ?? '-'} ` +
            `(${a.makeInjectionFrames.sampleCount}件), make観測 中央値${a.makeObservationFrames.medianFrames ?? '-'} ` +
            `(${a.makeObservationFrames.sampleCount}件), break注入 中央値${a.breakInjectionFrames.medianFrames ?? '-'} ` +
            `(${a.breakInjectionFrames.sampleCount}件), break観測 中央値${a.breakObservationFrames.medianFrames ?? '-'} ` +
            `(${a.breakObservationFrames.sampleCount}件)`,
        );
      }
      if (!s.success) process.exitCode = 1;
    }
  } finally {
    // 例外発生時にもサンプラーが残らないよう、ここでも念のため止める(冪等)。
    if (loadSampler) loadSampler.stop();
    if (browser) await browser.close();
    if (profile) await rm(profile, { recursive: true, force: true });
    await stopServer(server);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
