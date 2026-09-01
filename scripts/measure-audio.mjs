// WebX68k の音声遅延のうち、計測計画「目的A：回帰の基準値」表「音声遅延」行の(1)
// 「AudioWorkletが報告する待ちキュー時間(ms)の時系列と分布、underflow/上限超過・
// 破棄回数」を計測する。(2)の物理スピーカー出力の端点間遅延は自動化できないため、
// このスクリプトでは扱わない(docs/STORAGE-SCSI.md「基準値：音声遅延」の
// 「未確認・限界」に人手手順として書き残す)。
//
// 測る場所は音声の送り側(audioPush呼出時刻)ではなく、AudioWorklet自身がtickで報告する
// 未再生キュー末尾(src/audio.ts の AudioEngine.startQueueProbe/stopQueueProbe、
// window.__webx68kDebug.startQueueProbe() 経由)。
//
// 実装様式は scripts/measure-boot.mjs / measure-drives.mjs / measure-key.mjs に合わせる
// (ヘッドフル Puppeteer、BrowserContext 分離、故障注入は --fault=、故障前に陽性対照、
// rAF ベースの待機)。音を出す固定操作(起動 → BASIC2\BASIC → BEEP)は
// 「予備確認：音を出す固定操作の有無」で確定済みのものをそのまま使う。

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { collectEnvironment, startLoadSampler, snapshotProcesses, buildLoadReport } from './measure-env.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const REQUIRED_STABLE_POLLS = 3;
const VALID_FAULTS = new Set(['delay-200ms', 'drop-chunk', 'stall-main']);
// stall-main故障注入(欠音の「イベント単位」集計が実際に機能することの検証用)でメイン
// スレッドを止める長さ。300ms止めれば44.1kHzで13000サンプル以上の欠音が確実に起きる。
const STALL_MAIN_MS = 300;

// BASIC2\BASIC 起動後の "Ok" プロンプト検出、A> プロンプト検出で共有する。
// 半角記号の入力は Backslash コードを使う(src/keyboard.ts の CODE_TO_RETROK 参照)。
const CHAR_TO_CODE = {};
for (let c = 97; c <= 122; c++) {
  const ch = String.fromCharCode(c);
  CHAR_TO_CODE[ch] = `Key${ch.toUpperCase()}`;
}
for (let d = 0; d <= 9; d++) CHAR_TO_CODE[String(d)] = `Digit${d}`;
CHAR_TO_CODE['\\'] = 'Backslash';
CHAR_TO_CODE[' '] = 'Space';
// ':' はJIS配列でQuoteキー無シフト(src/keyboard.ts PLAIN_KEYS参照)。条件D用のBASICプログラム
// 入力(`10 beep:goto 10`)で使う。
CHAR_TO_CODE[':'] = 'Quote';

// 条件D(打鍵なしで音が鳴り続ける対照。docs/STORAGE-SCSI.md「基準値：音声遅延」追記節
// 「打鍵なしでBEEPを鳴らすfixture」参照)。`BEEP`単体は前の減衰を待たずに次のBEEPが
// 再トリガするため、`10 BEEP:GOTO 10`をRUNするだけで実質的に鳴りっぱなしの連続音になる
// ことを予備確認(振幅プローブ、nonSilentCount≒sampleCount)で確認済み。FOR/NEXTでウェイトを
// 挟む案も試したが、この用途(打鍵ゼロで音を鳴らし続ける)には不要だった。
// 別行(`20 FOR N=1 TO ...:NEXT N`)で試した際、NEXTに変数名を付けると
// (`I`に限らず`N`でも)「文末の記述が誤っています」の構文エラーになる現象が確認できた
// (原因未調査。`NEXT`単体=変数名なしなら通る)。1行で完結する`10 BEEP:GOTO 10`を採用した
// ことで、この構文の癖を踏まずに済んでいる。
const LOOP_BEEP_PROGRAM_LINE = '10 beep:goto 10';
// プログラム投入(打鍵)とRUN実行後、計測窓(打鍵ゼロ)を開くまでの待ち。
// 予備確認(_local/smoke.mjs、リポジトリには残していない使い捨てスクリプト)で、
// RUN実行から3秒後の時点で振幅プローブが継続的な非無音を報告していることを複数回
// (1秒間隔で6回)確認できたため、余裕を見て3000msとした。
const LOOP_BEEP_SETTLE_MS = 3000;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const roundMs = (value) => (value === null || value === undefined ? null : Math.round(value * 1000) / 1000);

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} は正の整数で指定してください: ${value}`);
  }
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
    const match = /^--(port|beep-duration|idle-duration|beep-interval|boot-timeout|output|fault|loopbeep-duration|scenario)=(.+)$/.exec(arg);
    if (!match) throw new Error(`不明な引数です: ${arg}`);
    values[match[1]] = match[2];
  }
  return values;
}

function printHelp() {
  console.log(`Usage: node scripts/measure-audio.mjs [options]

  --port=<number>          dev server のポート (既定: 5183)
  --beep-duration=<ms>     BEEP区間の採取時間 (既定: 60000。計画の目安5分から短縮、理由は結果に記録)
  --idle-duration=<ms>     定常(無音)区間の採取時間 (既定: 60000。同上)
  --beep-interval=<ms>     BEEP実行の間隔 (既定: 3000)
  --boot-timeout=<ms>      起動完了タイムアウト (既定: 90000)
  --output=<path>          JSON の保存先
  --fault=<delay-200ms|drop-chunk|stall-main>  測定系の検証用故障注入。先に陽性対照を行う
  --loopbeep-duration=<ms> 条件D(打鍵なしBEEPループ)の採取時間 (既定: 60000)
  --scenario=d             条件D単体のみ実行する(既定の動作=beep/idleは変更しない)
  --worker                 計測対象URLに ?worker=1 を付ける(Worker経路の計測)。
                           未指定時の挙動には一切影響しない

生ログ: 各試行のAudioWorklet tick時系列(rawLog)は、結果JSONとは別に
        "<結果ファイル名>-rawlog-<kind>.json" として同じディレクトリへ保存される
        (結果JSON側にはrawLogPathのみ記録)。

環境変数: WEBX68K_PORT, WEBX68K_AUDIO_BEEP_MS, WEBX68K_AUDIO_IDLE_MS,
          WEBX68K_AUDIO_LOOPBEEP_MS, WEBX68K_AUDIO_MEASURE_OUTPUT, WEBX68K_URL, CHROME_PATH`);
}

function defaultOutputPath(suffix) {
  const serial = new Date().toISOString().replace(/[:.]/g, '-');
  return join(REPO_ROOT, '_local', 'measure', `audio-${suffix}-${serial}.json`);
}

function buildConfig(args) {
  const envUrl = process.env.WEBX68K_URL ? new URL(process.env.WEBX68K_URL) : null;
  const port = parsePositiveInteger(args.port ?? process.env.WEBX68K_PORT ?? envUrl?.port ?? '5183', 'port');
  const baseUrl = envUrl ?? new URL(`http://localhost:${port}`);
  baseUrl.port = String(port);
  const fault = args.fault ?? null;
  if (fault !== null && !VALID_FAULTS.has(fault)) {
    throw new Error(`fault は delay-200ms・drop-chunk・stall-main のいずれかを指定してください: ${fault}`);
  }
  const scenario = args.scenario ?? null;
  if (scenario !== null && scenario !== 'd') {
    throw new Error(`scenario は d のみ指定できます: ${scenario}`);
  }
  const outputValue =
    args.output ??
    process.env.WEBX68K_AUDIO_MEASURE_OUTPUT ??
    defaultOutputPath(fault ?? (scenario === 'd' ? 'loopbeep' : 'main'));
  return {
    baseUrl: baseUrl.href.replace(/\/$/, ''),
    port,
    beepDurationMs: parsePositiveInteger(
      args['beep-duration'] ?? process.env.WEBX68K_AUDIO_BEEP_MS ?? '60000',
      'beep-duration',
    ),
    idleDurationMs: parsePositiveInteger(
      args['idle-duration'] ?? process.env.WEBX68K_AUDIO_IDLE_MS ?? '60000',
      'idle-duration',
    ),
    beepIntervalMs: parsePositiveInteger(args['beep-interval'] ?? '3000', 'beep-interval'),
    bootTimeoutMs: parsePositiveInteger(args['boot-timeout'] ?? '90000', 'boot-timeout'),
    loopBeepDurationMs: parsePositiveInteger(
      args['loopbeep-duration'] ?? process.env.WEBX68K_AUDIO_LOOPBEEP_MS ?? '60000',
      'loopbeep-duration',
    ),
    outputPath: isAbsolute(outputValue) ? outputValue : resolve(REPO_ROOT, outputValue),
    executablePath: process.env.CHROME_PATH ?? DEFAULT_CHROME,
    fault,
    scenario,
    // Worker経路(?worker=1)の計測かどうか。既定はfalseで、既定計測(measurementUrl組み立て・
    // その他すべての挙動)には一切影響しない。
    worker: args.worker === true,
  };
}

// 既定(worker未指定)ではmeasurementUrlはconfig.baseUrlのまま変わらない。runMainScenario/
// runFaultTrialの両方から呼ばれるため、既存クエリを保ったままworker=1を付けるロジックを
// ここに1箇所だけ持つ(measure-boot.mjsの同名ロジックの複製ではなく共通化)。
function buildMeasurementUrl(config) {
  if (!config.worker) return config.baseUrl;
  const url = new URL(config.baseUrl);
  url.searchParams.set('worker', '1');
  return url.href;
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
// 最大・MAD を持つ。単位はms。
function summarize(samplesMs) {
  const sampleCount = samplesMs.length;
  if (sampleCount === 0) {
    return { sampleCount: 0, minMs: null, medianMs: null, p90Ms: null, p95Ms: null, p99Ms: null, maxMs: null, madMs: null };
  }
  const sorted = [...samplesMs].sort((left, right) => left - right);
  const medianMs = percentile(sorted, 0.5);
  const deviations = sorted.map((value) => Math.abs(value - medianMs)).sort((left, right) => left - right);
  return {
    sampleCount,
    minMs: roundMs(sorted[0]),
    medianMs: roundMs(medianMs),
    p90Ms: roundMs(percentile(sorted, 0.9)),
    p95Ms: roundMs(percentile(sorted, 0.95)),
    p99Ms: roundMs(percentile(sorted, 0.99)),
    maxMs: roundMs(sorted.at(-1)),
    madMs: roundMs(percentile(deviations, 0.5)),
  };
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

async function waitForBootPrompt(page, timeoutMs) {
  return page.evaluate(
    async ({ timeout, stablePolls }) => {
      const startedAt = performance.now();
      let lastPollAt = -Infinity;
      let consecutive = 0;
      let lastAPromptLine = null;
      while (performance.now() - startedAt < timeout) {
        await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
        const now = performance.now();
        if (now - lastPollAt < 50) continue;
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
    { timeout: timeoutMs, stablePolls: REQUIRED_STABLE_POLLS },
  );
}

/** 文字列をコマンド行へ打鍵し、Enterまで送る(小文字・Human68k/X-BASICは大文字小文字を区別しない)。 */
async function typeLineAndEnter(page, text, charMap) {
  await page.evaluate(
    async ({ text, charMap }) => {
      const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
      const dispatch = (type, code, key) => {
        window.dispatchEvent(
          new KeyboardEvent(type, { code, key, bubbles: true, composed: true, cancelable: true }),
        );
      };
      for (const ch of text) {
        const code = charMap[ch];
        if (!code) continue;
        dispatch('keydown', code, ch);
        await wait(35);
        dispatch('keyup', code, ch);
        await wait(35);
      }
      dispatch('keydown', 'Enter', 'Enter');
      await wait(35);
      dispatch('keyup', 'Enter', 'Enter');
    },
    { text, charMap },
  );
}

/** 直近の非空行が prefix + (末尾カーソル1文字まで) に一致するまで待つ(A>/Ok共通の判定形)。 */
async function waitForPromptLine(page, prefix, timeoutMs) {
  return page.evaluate(
    async ({ prefix, timeout, stablePolls }) => {
      const startedAt = performance.now();
      let lastPollAt = -Infinity;
      let consecutive = 0;
      let lastLine = null;
      while (performance.now() - startedAt < timeout) {
        await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
        const now = performance.now();
        if (now - lastPollAt < 50) continue;
        lastPollAt = now;
        const dump = await window.__webx68kDebug?.screenText?.();
        if (!dump?.available || !Array.isArray(dump.lines)) {
          consecutive = 0;
          continue;
        }
        const lines = dump.lines.filter((line) => line.length > 0);
        lastLine = lines.filter((line) => line.startsWith(prefix)).at(-1) ?? null;
        const remainderLength =
          lastLine === null ? Number.POSITIVE_INFINITY : Array.from(lastLine.slice(prefix.length)).length;
        consecutive = lastLine !== null && remainderLength <= 1 ? consecutive + 1 : 0;
        if (consecutive >= stablePolls) return { success: true, lastLine };
      }
      return { success: false, lastLine };
    },
    { prefix, timeout: timeoutMs, stablePolls: REQUIRED_STABLE_POLLS },
  );
}

/** 起動してBASIC2\BASICへ入り、"Ok"プロンプトに到達するところまで共通で行う。 */
async function bootAndEnterBasic(page, config) {
  await page.evaluate(() => {
    for (const spec of [{ code: 'Enter', key: 'Enter' }, { code: 'Backspace', key: 'Backspace' }]) {
      window.dispatchEvent(new KeyboardEvent('keyup', { code: spec.code, key: spec.key, bubbles: true, composed: true }));
    }
  });
  await clickNamedButton(page, '#btn-boot-system');
  const boot = await waitForBootPrompt(page, config.bootTimeoutMs);
  if (!boot.success) {
    throw new Error(`起動完了を確認できませんでした (lastAPromptLine=${boot.lastAPromptLine ?? 'なし'})`);
  }
  // measure-key.mjs と同じ理由(プロンプト安定判定直後はゲストの入力ポーリングが
  // 確実に回っている保証がない)で、rAFベースの余裕を入れる。
  await page.evaluate(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
  });
  return boot;
}

async function enterBasic(page, config) {
  await typeLineAndEnter(page, 'basic2\\basic', CHAR_TO_CODE);
  const ok = await waitForPromptLine(page, 'Ok', 20000);
  if (!ok.success) {
    throw new Error(`X-BASICの"Ok"プロンプトに到達できませんでした (lastLine=${ok.lastLine ?? 'なし'})`);
  }
  return ok;
}

/**
 * 条件D(打鍵なしでBEEPが鳴り続ける対照)のプログラムを投入してRUNする。
 * `LOOP_BEEP_PROGRAM_LINE`定義のコメント参照。ここでの打鍵(プログラム投入・RUN)は
 * 計測窓の外(startQueueProbe呼出前)で完結させ、投入後はLOOP_BEEP_SETTLE_MSだけ
 * 待ってから返す(この待ちの根拠もLOOP_BEEP_SETTLE_MS定義のコメント参照)。
 */
async function startLoopBeepProgram(page) {
  await typeLineAndEnter(page, LOOP_BEEP_PROGRAM_LINE, CHAR_TO_CODE);
  await typeLineAndEnter(page, 'run', CHAR_TO_CODE);
  await sleep(LOOP_BEEP_SETTLE_MS);
}

/**
 * 条件Dの無限ループを止める(BREAKキー、DOM code='Pause' → src/keyboard.tsで
 * RETROK.PAUSE→X68kスキャンコード0x61=BREAK)。予備確認で「breakしました」の表示と
 * ともにOkプロンプトへ戻ることを確認済み。各試行は新規BrowserContextでcontext.close()
 * するため機能的には不要だが、ログ上の後始末として呼ぶ。
 */
async function breakLoopBeepProgram(page) {
  await page.evaluate(() => {
    const dispatch = (type) =>
      window.dispatchEvent(new KeyboardEvent(type, { code: 'Pause', key: 'Pause', bubbles: true, composed: true, cancelable: true }));
    dispatch('keydown');
  });
  await sleep(80);
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Pause', key: 'Pause', bubbles: true, composed: true, cancelable: true }));
  });
}

/**
 * 条件D用のキュープローブ採取。startLoopBeepProgram()でプログラム投入・RUN・settleまで
 * 済ませてから呼ぶこと。計測窓中(startQueueProbe〜stopQueueProbeの間)は一切の打鍵を
 * 行わない(sleepのみ)。これがcollectQueueProbeの'beep'条件(打鍵ありBEEP)との違い。
 */
async function collectLoopBeepProbe(page, durationMs) {
  const startedAtWall = Date.now();
  await page.evaluate(() => window.__webx68kDebug?.startQueueProbe?.());
  await sleep(durationMs);
  const log = await page.evaluate(() => window.__webx68kDebug?.stopQueueProbe?.() ?? []);
  const actualCapturedMs = Date.now() - startedAtWall;
  await breakLoopBeepProgram(page);
  return { log, actualCapturedMs };
}

/**
 * AudioWorklet内キュープローブを開始し、指定時間ぶん採取する。kindが'beep'なら
 * intervalMsごとにBEEPを実行し続ける(区間全体を通しての分布を見るため、鳴っている
 * 瞬間と鳴らし終えた後の両方を含める)。'idle'なら何もしない。
 * faultSetup(page)を渡すとプローブ開始直後に一度だけ呼ぶ(故障注入用)。
 */
async function collectQueueProbe(page, kind, durationMs, intervalMs, faultSetup) {
  const startedAtWall = Date.now();
  await page.evaluate(() => window.__webx68kDebug?.startQueueProbe?.());
  if (faultSetup) await faultSetup(page);

  if (kind === 'beep') {
    const beepCount = Math.max(1, Math.round(durationMs / intervalMs));
    for (let i = 0; i < beepCount; i++) {
      await typeLineAndEnter(page, 'beep', CHAR_TO_CODE);
      await sleep(intervalMs);
    }
  } else {
    await sleep(durationMs);
  }

  const log = await page.evaluate(() => window.__webx68kDebug?.stopQueueProbe?.() ?? []);
  const actualCapturedMs = Date.now() - startedAtWall;
  return { log, actualCapturedMs };
}

// underflow(累積フレーム数)が増加している連続tickの並びを1件の欠音イベントとみなす。
// 背景: 同一日・同一ビルドのidle 60秒計測でunderflow計が9919/0/8368と二値的に振れ、
// 累積値どうしの大小比較が成立しなかった。生ログを見るとunderflowは60秒に散らばって
// おらず、1回のバーストに固まっていた(q=0.0ms uf=0→303→815→1071のように一瞬で積み上がり、
// 増分は512の倍数=ワークレットの処理単位)。件数の大小でなく「何回・何ms分の欠音が
// 起きたか」をイベント単位で見えるようにする(docs/STORAGE-SCSI.md「基準値：音声遅延」)。
//
// sampleRateが不明(古い生ログにワークレット時刻が無い等)でもクラッシュしないこと。
// その場合はlostMs側をnullにし、件数(count)とframesLostだけで扱えるようにする。
function detectUnderflowEvents(log, sampleRate) {
  const events = [];
  let prevUnderflow = 0;
  let current = null;
  for (let i = 0; i < log.length; i++) {
    const sample = log[i];
    const underflow = sample.underflow ?? 0;
    const delta = underflow - prevUnderflow;
    if (delta > 0) {
      if (!current) {
        // イベント直前のキュー滞留量(ms)。バースト最初のtick自身は既に欠音発生後の
        // 値なので、1つ前のtick(無ければ自分自身)を「直前」として使う。
        const prevSample = log[i - 1] ?? sample;
        current = {
          startTMs: sample.tMs ?? null,
          startWorkletFrame: sample.workletFrame ?? null,
          framesLost: 0,
          queuedMsBefore: roundMs((prevSample.qSec ?? 0) * 1000),
        };
      }
      current.framesLost += delta;
    } else if (current) {
      events.push(finalizeUnderflowEvent(current, sampleRate));
      current = null;
    }
    prevUnderflow = underflow;
  }
  if (current) events.push(finalizeUnderflowEvent(current, sampleRate));
  return events;
}

function finalizeUnderflowEvent(current, sampleRate) {
  return {
    startTMs: current.startTMs,
    startWorkletFrame: current.startWorkletFrame,
    framesLost: current.framesLost,
    lostMs: sampleRate ? roundMs((current.framesLost / sampleRate) * 1000) : null,
    queuedMsBeforeMs: current.queuedMsBefore,
  };
}

function summarizeUnderflowEvents(log, sampleRate) {
  const events = detectUnderflowEvents(log, sampleRate);
  if (events.length === 0) {
    return { count: 0, totalLostMs: 0, maxLostMs: 0, medianLostMs: 0, events };
  }
  const lostMsValues = events.map((e) => e.lostMs);
  if (lostMsValues.some((v) => v === null)) {
    // sampleRate不明でms換算できない場合。件数・生の欠損フレーム数は events 側に残す。
    return { count: events.length, totalLostMs: null, maxLostMs: null, medianLostMs: null, events };
  }
  const sorted = [...lostMsValues].sort((left, right) => left - right);
  return {
    count: events.length,
    totalLostMs: roundMs(lostMsValues.reduce((sum, value) => sum + value, 0)),
    maxLostMs: sorted.at(-1),
    medianLostMs: percentile(sorted, 0.5),
    events,
  };
}

function summarizeQueueLog(log, sampleRate) {
  const qSamplesMs = log.map((s) => s.qSec * 1000);
  const lastEntry = log.at(-1) ?? null;
  return {
    tickCount: log.length,
    queuedSec: summarize(qSamplesMs),
    underflowFrames: lastEntry?.underflow ?? 0,
    trimEvents: lastEntry?.trimEvents ?? 0,
    droppedSamples: lastEntry?.dropped ?? 0,
    underflowEvents: summarizeUnderflowEvents(log, sampleRate ?? null),
  };
}

// 環境収集(scripts/measure-env.mjs)は各試行のキュープローブ採取(stopQueueProbe)が
// 終わった後・context.close()の前に行う。rAFを1秒回すため、キュー計測窓の中では
// 絶対に呼ばない。envCapture.valueがundefinedの間だけ、最初に開いたページ上で捕捉する
// (このタイミングなら起動済みでAudioContextが実在するため、他スクリプトと違いaudioが
// nullにならず実測できる)。
async function runMainScenario(browser, config, kind, envCapture) {
  const context = await browser.createBrowserContext();
  let page;
  try {
    page = await context.newPage();
    await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 2 });
    await page.bringToFront();
    await page.goto(buildMeasurementUrl(config), { waitUntil: 'networkidle2' });
    await page.bringToFront();

    const boot = await bootAndEnterBasic(page, config);
    if (kind === 'beep' || kind === 'loop-beep') await enterBasic(page, config);

    const durationMs =
      kind === 'beep' ? config.beepDurationMs : kind === 'loop-beep' ? config.loopBeepDurationMs : config.idleDurationMs;
    const { log, actualCapturedMs } =
      kind === 'loop-beep'
        ? await (async () => {
            await startLoopBeepProgram(page);
            return collectLoopBeepProbe(page, durationMs);
          })()
        : await collectQueueProbe(page, kind, durationMs, config.beepIntervalMs, null);
    // 欠損時間(ms)算出用のsampleRate。ハードコードせず、実際のAudioContextから読む
    // (audioEnv()はsrc/audio.tsのAudioEngine.audioEnv()、環境収集(measure-env.mjs)が
    // 使うのと同じ経路)。取得できない場合はnullのままsummarizeQueueLogへ渡し、
    // lostMs側だけnullにして件数集計はそのまま行う。
    const sampleRate = await page.evaluate(() => window.__webx68kDebug?.audioEnv?.()?.sampleRate ?? null).catch(() => null);

    return { kind, success: true, boot: { ...boot, durationMs: roundMs(boot.durationMs) }, requestedDurationMs: durationMs, actualCapturedMs, ...summarizeQueueLog(log, sampleRate), rawLog: log };
  } catch (error) {
    return { kind, success: false, error: error instanceof Error ? error.message : String(error), rawLog: [] };
  } finally {
    if (envCapture && envCapture.value === undefined && page) {
      envCapture.value = await collectEnvironment(page).catch(() => null);
    }
    await context.close();
  }
}

async function runFaultTrial(browser, config, kind, faultSetup, durationMs, envCapture) {
  const context = await browser.createBrowserContext();
  let page;
  try {
    page = await context.newPage();
    await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 2 });
    await page.bringToFront();
    await page.goto(buildMeasurementUrl(config), { waitUntil: 'networkidle2' });
    await page.bringToFront();

    const boot = await bootAndEnterBasic(page, config);
    await enterBasic(page, config);

    const { log, actualCapturedMs } = await collectQueueProbe(page, kind, durationMs, config.beepIntervalMs, faultSetup);
    const sampleRate = await page.evaluate(() => window.__webx68kDebug?.audioEnv?.()?.sampleRate ?? null).catch(() => null);
    return { success: true, boot: { ...boot, durationMs: roundMs(boot.durationMs) }, actualCapturedMs, ...summarizeQueueLog(log, sampleRate), rawLog: log };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error), rawLog: [] };
  } finally {
    if (envCapture && envCapture.value === undefined && page) {
      envCapture.value = await collectEnvironment(page).catch(() => null);
    }
    await context.close();
  }
}

/**
 * 故障注入 --fault=stall-main 用。メインスレッドを既知の時間(STALL_MAIN_MS)だけ
 * 同期的にビジーウェイトさせ、実際にメインスレッドを止める(本物の故障)。
 * 「欠音イベント集計が本当に働くか」を既知の入力で確かめるためのもの
 * (「値が変わらない測定は採用しない」規律。累積underflow計だけを見ていた頃、
 * idle60秒で9919/0/8368と二値的に振れて大小比較が成立しなかった経緯への対応)。
 * 故障注入コードはこのファイル(計測スクリプト側)にのみ置き、src/には触れない。
 */
async function faultStallMain(page) {
  await page.evaluate((ms) => {
    const until = performance.now() + ms;
    // eslint 等の空ループ警告は無視してよい: メインスレッドを本当に占有するのが目的。
    while (performance.now() < until) {
      /* busy wait */
    }
  }, STALL_MAIN_MS);
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
    profile = await mkdtemp(join(tmpdir(), 'webx68k-measure-audio-'));
    browser = await puppeteer.launch({
      executablePath: config.executablePath,
      userDataDir: profile,
      headless: false,
      args: ['--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=1000,900'],
    });

    // 環境収集は全試行を通して1回だけ行う(runMainScenario/runFaultTrial内のfinally参照)。
    const envCapture = { value: undefined };
    let result;
    if (config.scenario === 'd') {
      // 条件D単体: 打鍵なしでBEEPが鳴り続けるfixtureでのunderflow実測
      // (docs/STORAGE-SCSI.md「基準値：音声遅延」追記節「打鍵なしでBEEPを鳴らすfixture」参照)。
      const loopBeep = await runMainScenario(browser, config, 'loop-beep', envCapture);
      const loopBeepFinal = await finalizeTrial(config.outputPath, 'loop-beep', loopBeep);
      result = {
        schemaVersion: 1,
        measuredAt: new Date().toISOString(),
        environment: envCapture.value ?? null,
        measurement:
          '音声遅延(条件D): 打鍵なしでBEEPが鳴り続けるBASICループ(`10 BEEP:GOTO 10`)での' +
          'AudioWorklet内未再生キュー時間の時系列・分布、underflow/上限超過/破棄回数。' +
          '計測窓(startQueueProbe〜stopQueueProbeの間)は打鍵ゼロ。',
        config,
        loopBeepProgramLine: LOOP_BEEP_PROGRAM_LINE,
        settleMs: LOOP_BEEP_SETTLE_MS,
        scenario: loopBeepFinal,
      };
      console.log(
        `loop-beep(条件D): 成功 ${loopBeep.success}, tick数 ${loopBeep.tickCount ?? 0}, 実採取 ${loopBeep.actualCapturedMs ?? '-'}ms, 中央値 ${loopBeep.queuedSec?.medianMs ?? '-'}ms, p99 ${loopBeep.queuedSec?.p99Ms ?? '-'}ms, underflow ${loopBeep.underflowFrames ?? '-'}, trim ${loopBeep.trimEvents ?? '-'}, dropped ${loopBeep.droppedSamples ?? '-'}`,
      );
      if (!loopBeep.success) process.exitCode = 1;
    } else if (config.fault === 'delay-200ms') {
      // 陽性対照: 故障なしでidle区間を短く採取し、キュー時間の分布が正常な形(0以上、
      // MAX_LATENCY_SEC以下)で得られることを確認する。
      const shortMs = 8000;
      const positiveControl = await runMainScenario(browser, { ...config, idleDurationMs: shortMs }, 'idle', envCapture);
      let faultTrial = null;
      let faultCheck;
      if (positiveControl.success && positiveControl.queuedSec.sampleCount > 0) {
        faultTrial = await runFaultTrial(
          browser,
          config,
          'idle',
          (page) => page.evaluate(() => window.__webx68kDebug?.faultDelayReportSec?.(0.2)),
          shortMs,
          envCapture,
        );
        if (faultTrial.success && faultTrial.queuedSec.sampleCount > 0) {
          const shiftMs = faultTrial.queuedSec.medianMs - positiveControl.queuedSec.medianMs;
          const passed = Math.abs(shiftMs - 200) <= 40; // ±40ms許容
          faultCheck = { fault: 'delay-200ms', positiveControlPassed: true, baselineMedianMs: positiveControl.queuedSec.medianMs, faultMedianMs: faultTrial.queuedSec.medianMs, shiftMs: roundMs(shiftMs), passed, reason: passed ? null : `分布の移動幅が200msから乖離: ${roundMs(shiftMs)}ms` };
        } else {
          faultCheck = { fault: 'delay-200ms', positiveControlPassed: true, passed: false, reason: `故障注入試行が完走しなかった: ${faultTrial.error ?? '標本数0'}` };
        }
      } else {
        faultCheck = { fault: 'delay-200ms', positiveControlPassed: false, passed: false, reason: `陽性対照が成功しなかった: ${positiveControl.error ?? '標本数0'}` };
      }
      const positiveControlFinal = await finalizeTrial(config.outputPath, 'positive-control', positiveControl);
      const faultTrialFinal = faultTrial ? await finalizeTrial(config.outputPath, 'fault', faultTrial) : null;
      result = { schemaVersion: 1, measuredAt: new Date().toISOString(), environment: envCapture.value ?? null, measurement: '音声遅延: 測定経路(AudioWorklet tick報告)への既知200ms遅延注入検証', config, positiveControl: positiveControlFinal, faultTrial: faultTrialFinal, faultCheck };
      console.log(`陽性対照: ${positiveControl.success ? '成功' : '失敗'} (標本数 ${positiveControl.queuedSec?.sampleCount ?? 0})`);
      console.log(`故障注入 delay-200ms: 移動幅 ${faultCheck.shiftMs ?? '-'} ms -> ${faultCheck.passed ? '期待どおり検出' : `検出失敗(${faultCheck.reason})`}`);
      if (!faultCheck.passed) process.exitCode = 1;
    } else if (config.fault === 'drop-chunk') {
      const shortMs = 8000;
      const shortInterval = 2000;
      // 陽性対照: 故障なしでBEEP区間を短く採取し、droppedSamplesが0のまま(自然発生の
      // 誤検出が無い)ことを確認する。
      const positiveControl = await runMainScenario(browser, { ...config, beepDurationMs: shortMs, beepIntervalMs: shortInterval }, 'beep', envCapture);
      let faultTrial = null;
      let faultCheck;
      const positiveClean = positiveControl.success && positiveControl.droppedSamples === 0;
      if (positiveClean) {
        faultTrial = await runFaultTrial(
          browser,
          { ...config, beepIntervalMs: shortInterval },
          'beep',
          (page) => page.evaluate(() => window.__webx68kDebug?.faultDropNextChunk?.()),
          shortMs,
          envCapture,
        );
        const dropped = faultTrial.success ? faultTrial.droppedSamples : 0;
        const passed = faultTrial.success && dropped > 0;
        faultCheck = { fault: 'drop-chunk', positiveControlPassed: true, positiveControlDropped: positiveControl.droppedSamples, faultDroppedSamples: dropped, passed, reason: passed ? null : `故障注入後もdroppedSamplesが増えなかった: ${faultTrial.error ?? dropped}` };
      } else {
        faultCheck = { fault: 'drop-chunk', positiveControlPassed: false, passed: false, reason: `陽性対照でdroppedSamplesが既に非0、または失敗: ${positiveControl.error ?? positiveControl.droppedSamples}` };
      }
      const positiveControlFinal = await finalizeTrial(config.outputPath, 'positive-control', positiveControl);
      const faultTrialFinal = faultTrial ? await finalizeTrial(config.outputPath, 'fault', faultTrial) : null;
      result = { schemaVersion: 1, measuredAt: new Date().toISOString(), environment: envCapture.value ?? null, measurement: '音声遅延: 1チャンク破棄による欠音カウンタ検出検証', config, positiveControl: positiveControlFinal, faultTrial: faultTrialFinal, faultCheck };
      console.log(`陽性対照: ${positiveClean ? '成功(dropped=0)' : '失敗'} `);
      console.log(`故障注入 drop-chunk: droppedSamples ${faultCheck.faultDroppedSamples ?? 0} -> ${faultCheck.passed ? '期待どおり検出' : `検出失敗(${faultCheck.reason})`}`);
      if (!faultCheck.passed) process.exitCode = 1;
    } else if (config.fault === 'stall-main') {
      // 陽性対照: 故障なしでidle区間を短く採取し、正常に完走することを確認する
      // (idleは自然発生の欠音イベントが0件とは限らないため、drop-chunkと違い
      // 「イベント0件」までは陽性対照の条件にしない)。
      const shortMs = 8000;
      const positiveControl = await runMainScenario(browser, { ...config, idleDurationMs: shortMs }, 'idle', envCapture);
      let faultTrial = null;
      let faultCheck;
      if (positiveControl.success && positiveControl.queuedSec.sampleCount > 0) {
        faultTrial = await runFaultTrial(browser, config, 'idle', (page) => faultStallMain(page), shortMs, envCapture);
        if (faultTrial.success) {
          const events = faultTrial.underflowEvents;
          const passed = events.count >= 1 && events.totalLostMs !== null && events.totalLostMs > 0;
          faultCheck = {
            fault: 'stall-main',
            positiveControlPassed: true,
            eventCount: events.count,
            totalLostMs: events.totalLostMs,
            passed,
            reason: passed ? null : `欠音イベントが検出されなかった: count=${events.count}, totalLostMs=${events.totalLostMs}`,
          };
        } else {
          faultCheck = { fault: 'stall-main', positiveControlPassed: true, passed: false, reason: `故障注入試行が完走しなかった: ${faultTrial.error ?? '不明'}` };
        }
      } else {
        faultCheck = { fault: 'stall-main', positiveControlPassed: false, passed: false, reason: `陽性対照が成功しなかった: ${positiveControl.error ?? '標本数0'}` };
      }
      const positiveControlFinal = await finalizeTrial(config.outputPath, 'positive-control', positiveControl);
      const faultTrialFinal = faultTrial ? await finalizeTrial(config.outputPath, 'fault', faultTrial) : null;
      result = {
        schemaVersion: 1,
        measuredAt: new Date().toISOString(),
        environment: envCapture.value ?? null,
        measurement: `音声遅延: メインスレッドを${STALL_MAIN_MS}msブロックする故障注入による欠音イベント集計の検証`,
        config,
        stallMainMs: STALL_MAIN_MS,
        positiveControl: positiveControlFinal,
        faultTrial: faultTrialFinal,
        faultCheck,
      };
      console.log(`陽性対照: ${positiveControl.success ? '成功' : '失敗'} (標本数 ${positiveControl.queuedSec?.sampleCount ?? 0})`);
      console.log(
        `故障注入 stall-main: イベント件数 ${faultCheck.eventCount ?? '-'}, 欠損時間合計 ${faultCheck.totalLostMs ?? '-'}ms -> ${faultCheck.passed ? '期待どおり検出' : `検出失敗(${faultCheck.reason})`}`,
      );
      if (!faultCheck.passed) process.exitCode = 1;
    } else {
      const beep = await runMainScenario(browser, config, 'beep', envCapture);
      const idle = await runMainScenario(browser, config, 'idle', envCapture);
      const beepFinal = await finalizeTrial(config.outputPath, 'beep', beep);
      const idleFinal = await finalizeTrial(config.outputPath, 'idle', idle);
      result = {
        schemaVersion: 1,
        measuredAt: new Date().toISOString(),
        environment: envCapture.value ?? null,
        measurement: '音声遅延(1): AudioWorklet内未再生キュー時間の時系列・分布、underflow/上限超過/破棄回数',
        config,
        scenarios: { beep: beepFinal, idle: idleFinal },
        shortenedNote: `計画の目安(定常区間5分以上)に対し、beep=${config.beepDurationMs}ms・idle=${config.idleDurationMs}msへ短縮した。実際の採取時間はactualCapturedMsに記録している。`,
        limitations: [
          '(2)物理スピーカー出力の端点間遅延は本スクリプトでは計測していない(docs/STORAGE-SCSI.mdの手順参照)。',
          'BEEP区間はintervalMsごとにBEEPを打鍵し続けており、実機の任意のゲームや音楽再生とは負荷パターンが異なる。',
        ],
      };
      console.log(`beep: 成功 ${beep.success}, tick数 ${beep.tickCount ?? 0}, 実採取 ${beep.actualCapturedMs ?? '-'}ms, 中央値 ${beep.queuedSec?.medianMs ?? '-'}ms, p99 ${beep.queuedSec?.p99Ms ?? '-'}ms, underflow ${beep.underflowFrames ?? '-'}, trim ${beep.trimEvents ?? '-'}, dropped ${beep.droppedSamples ?? '-'}`);
      console.log(`idle: 成功 ${idle.success}, tick数 ${idle.tickCount ?? 0}, 実採取 ${idle.actualCapturedMs ?? '-'}ms, 中央値 ${idle.queuedSec?.medianMs ?? '-'}ms, p99 ${idle.queuedSec?.p99Ms ?? '-'}ms, underflow ${idle.underflowFrames ?? '-'}, trim ${idle.trimEvents ?? '-'}, dropped ${idle.droppedSamples ?? '-'}`);
      if (!beep.success || !idle.success) process.exitCode = 1;
    }

    // 試行が1件も走らなかった場合のフォールバック: 専用ページを開いて収集する。
    if (envCapture.value === undefined) {
      const fallbackContext = await browser.createBrowserContext();
      try {
        const fallbackPage = await fallbackContext.newPage();
        envCapture.value = await collectEnvironment(fallbackPage).catch(() => null);
      } finally {
        await fallbackContext.close();
      }
      if (result) result.environment = envCapture.value ?? null;
    }

    // 負荷の記録: 反復試行がすべて終わった時点でサンプラーを止め、終了直後のプロセス
    // スナップショットを取って load レポートを組み立てる。result.environment は
    // envCapture.value への参照を持つため、ここで envCapture.value を更新すれば
    // (または result.environment を明示的に張り替えれば)result 側にも反映される。
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
    if (result) result.environment = envCapture.value;

    // 生ログ(rawLog)は各試行ごとに既に別ファイルへ保存済み(finalizeTrial参照、結果本体を
    // 軽くするため)。ここで書き出すresultにはrawLogPath(リポジトリ相対パス)のみが載る。
    await mkdir(dirname(config.outputPath), { recursive: true });
    await writeFile(config.outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`出力: ${config.outputPath}`);
  } finally {
    // 例外発生時にもサンプラーが残らないよう、ここでも念のため止める(冪等)。
    if (loadSampler) loadSampler.stop();
    if (browser) await browser.close();
    if (profile) await rm(profile, { recursive: true, force: true });
    await stopServer(server);
  }
}

function stripRawLog(trial) {
  if (!trial) return trial;
  const { rawLog, ...rest } = trial;
  return { ...rest, rawLogSampleCount: rawLog?.length ?? 0 };
}

// rawLog(AudioWorkletが報告するtick時系列。1試行で5000件超になりうる)を結果JSONの
// 外側の独立ファイルへ丸ごと保存する。間引き・丸めは行わない。
// 保存先は結果ファイルと同じディレクトリ、命名は「<結果ファイルのベース名>-rawlog-<kind>.json」。
function rawLogFilePath(outputPath, kind) {
  const dir = dirname(outputPath);
  const base = basename(outputPath).replace(/\.json$/i, '');
  return join(dir, `${base}-rawlog-${kind}.json`);
}

// rawLogファイルを書き出し、直後に読み戻して件数が一致することを確認する(自己検査)。
// 一致しない場合は黙って続行せず、process.exitCodeを1にしてコンソールへ明示する。
// samplesが空配列(試行が失敗した等)でもファイルは作り、sampleCount: 0で区別できるようにする。
async function saveRawLog(outputPath, kind, samples) {
  const filePath = rawLogFilePath(outputPath, kind);
  const payload = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    kind,
    sampleCount: samples.length,
    resultPath: relative(REPO_ROOT, outputPath),
    samples,
  };
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const readBack = JSON.parse(await readFile(filePath, 'utf8'));
  if (!Array.isArray(readBack.samples) || readBack.samples.length !== samples.length) {
    console.error(
      `[rawLog自己検査失敗] ${filePath}: 書き戻したsamples数(${readBack.samples?.length ?? 'なし'})が` +
        `書き出した件数(${samples.length})と不一致。生ログの保存が壊れている可能性がある。`,
    );
    process.exitCode = 1;
  }
  return relative(REPO_ROOT, filePath);
}

// trial(runMainScenario/runFaultTrialの戻り値)からrawLogを別ファイルへ保存し、
// stripRawLogした本体にrawLogPath(リポジトリ相対)を足したものを返す。
async function finalizeTrial(outputPath, kind, trial) {
  if (!trial) return trial;
  const samples = trial.rawLog ?? [];
  const rawLogPath = await saveRawLog(outputPath, kind, samples);
  return { ...stripRawLog(trial), rawLogPath };
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
