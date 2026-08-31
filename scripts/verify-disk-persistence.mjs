// 手順8(FDD/MEMFSの不可分操作とオートセーブ)の永続化を末端まで検証するハーネス。
//
// scripts/measure-disk-save.mjs は既定経路のIndexedDB書き込み「性能」を測るもので、
// 「ゲストが書いた内容がリロード後も残るか」という機能そのものは検証しない。本スクリプトは
// レイテンシ計測ではなく機能検証であり、既存の measure-*.mjs と同じ流儀(引数パース、--help、
// dev server起動、ヘッドフルPuppeteer、結果JSON出力、故障注入+陽性対照)を踏襲しつつ、
// 「合格/不合格」を判定するために作る(measure-drives.mjsのDIR合成キー入力方式を流用)。
//
// 検証手順:
//   1. ?system=1&run=1&fd2=/system/human302.xdf (--worker指定時は&worker=1) で起動しA>を待つ
//   2. fd2ディスクがライブラリ(IndexedDB)に登録されていることを確認(無ければハーネスエラー)
//   3. ゲストに B: へ書き込ませる(MKDIR B:WKTEST)。打鍵後にコマンド行を読み直して検証し、
//      食い違っていれば行をクリアして打ち直す(リトライ)。
//   4. DIR B: でWKTESTが作成できたことを画面で確認(できていなければハーネスエラー)
//   5. オートセーブでライブラリのレコードが更新されるのを待つ(固定sleepではなくポーリング)
//   6. ページをリロードし、同じURLで再起動
//   7. DIR B: でWKTESTが残っていることを確認 → 合格/不合格
//
// 「ハーネスエラー」(前提条件が満たせず検証が成立しなかった)と「不合格」(検証は成立したが
// 症状(WKTESTが無い)が出た)を区別する。SKIPが合格の顔をする事故(過去の教訓)を避けるため。
//
// 2026-08-31追記(コーディネータ指摘への対応、2巡目):
// (1) --fault は当初、引数パース・ヘルプ・結果JSONへの記録だけで実際に何も壊していなかった
//     (陽性対照として機能しない、実行者が誤解する事故が実際に起きた)。src/main.ts に
//     dev限定・既定offのURLパラメータ(debugDisableAutosave=1 / debugForceUrlRefetch=1、
//     docs/STORAGE-SCSI.md「末端の永続化検証」参照)を追加し、--fault 指定時はこれらの
//     URLパラメータを実際に付与して起動することで、ソースの手編集なしで陽性対照を
//     再現できるようにした。URLパラメータなのでページのリロードをまたいでも同じ値が効く
//     (JS変数だとリロードで消える。--fault=disable-reload-resume はまさにリロードを
//     またいで効く必要がある)。
// (2) 負荷が高いと合成キー入力が取りこぼされ(実測: 'k'や't'が落ちる)、
//     `harness-error`になる(判定としては正しいが回帰ゲートとして使いにくい)ことが
//     報告された。打鍵直後にコマンド行を読み直して期待どおりか検証し、食い違っていれば
//     行をクリアして打ち直すリトライ機構を入れた(measure-key.mjsのBackspaceによる行クリア
//     作法を流用)。リトライ回数は結果JSONに記録する(黙って隠さない)。ただしこれが
//     ハーネス固有の問題かエミュレータ本体の入力取りこぼしなのかは切り分けていない
//     (docs参照。断定しない)。

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VALID_FAULTS = new Set(['disable-autosave', 'disable-reload-resume']);
const FD2_PATH = '/system/human302.xdf';
const MARKER = 'WKTEST';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 検証の前提条件が満たせなかった(検証そのものが成立しなかった)ことを表す。
 * 合格/不合格とは別の第三の状態として扱う(SKIPが合格の顔をする事故を避けるため)。 */
class HarnessError extends Error {}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} は正の整数で指定してください: ${value}`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} は0以上の整数で指定してください: ${value}`);
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
    const match =
      /^--(port|boot-timeout|autosave-timeout|poll-interval|key-hold|key-gap|type-retries|output|fault)=(.+)$/.exec(
        arg,
      );
    if (!match) throw new Error(`不明な引数です: ${arg}`);
    values[match[1]] = match[2];
  }
  return values;
}

function printHelp() {
  console.log(`Usage: node scripts/verify-disk-persistence.mjs [options]

ゲストが書いた内容がリロード後もディスクライブラリ(IndexedDB)経由で残るかを検証する
機能ハーネス(レイテンシ計測ではない)。

  --port=<number>            dev server のポート (既定: 5186)
  --worker                   ?worker=1 (Worker経路)で検証する。既定は既定経路。
  --boot-timeout=<ms>        起動完了(A>到達)タイムアウト (既定: 90000)
  --autosave-timeout=<ms>    オートセーブ反映待ちのタイムアウト (既定: 30000)
  --poll-interval=<ms>       ライブラリレコード更新のポーリング間隔 (既定: 500)
  --key-hold=<ms>            合成キー押下の保持時間 (既定: 70)
  --key-gap=<ms>             合成キー間の間隔 (既定: 70)
  --type-retries=<number>    コマンド行の打鍵検証・リトライ上限 (既定: 3)
  --output=<path>            結果JSONの保存先
  --fault=<disable-autosave|disable-reload-resume>
                             故障注入。実装側(src/main.ts)に用意した
                             dev限定・既定offのURLパラメータを実際に付与して起動する
                             (ソースの手編集は不要。付与するパラメータ:
                             disable-autosave -> debugDisableAutosave=1,
                             disable-reload-resume -> debugForceUrlRefetch=1)。
                             不合格(fail)になることを確認する陽性対照用。

環境変数: WEBX68K_PORT, WEBX68K_VERIFY_BOOT_TIMEOUT_MS, WEBX68K_VERIFY_OUTPUT,
          WEBX68K_URL, CHROME_PATH`);
}

function defaultOutputPath() {
  const serial = new Date().toISOString().replace(/[:.]/g, '-');
  return join(REPO_ROOT, '_local', 'measure', `disk-persistence-${serial}.json`);
}

function buildConfig(args) {
  const envUrl = process.env.WEBX68K_URL ? new URL(process.env.WEBX68K_URL) : null;
  const port = parsePositiveInteger(args.port ?? process.env.WEBX68K_PORT ?? envUrl?.port ?? '5186', 'port');
  const baseUrl = envUrl ?? new URL(`http://localhost:${port}`);
  baseUrl.port = String(port);
  const fault = args.fault ?? null;
  if (fault !== null && !VALID_FAULTS.has(fault)) {
    throw new Error(`fault は disable-autosave または disable-reload-resume を指定してください: ${fault}`);
  }
  const outputValue = args.output ?? process.env.WEBX68K_VERIFY_OUTPUT ?? defaultOutputPath();
  return {
    baseUrl: baseUrl.href.replace(/\/$/, ''),
    port,
    worker: args.worker === true,
    bootTimeoutMs: parsePositiveInteger(
      args['boot-timeout'] ?? process.env.WEBX68K_VERIFY_BOOT_TIMEOUT_MS ?? '90000',
      'boot-timeout',
    ),
    autosaveTimeoutMs: parsePositiveInteger(args['autosave-timeout'] ?? '30000', 'autosave-timeout'),
    pollIntervalMs: parsePositiveInteger(args['poll-interval'] ?? '500', 'poll-interval'),
    keyHoldMs: parsePositiveInteger(args['key-hold'] ?? '70', 'key-hold'),
    keyGapMs: parsePositiveInteger(args['key-gap'] ?? '70', 'key-gap'),
    typeRetries: parseNonNegativeInteger(args['type-retries'] ?? '3', 'type-retries'),
    outputPath: isAbsolute(outputValue) ? outputValue : resolve(REPO_ROOT, outputValue),
    executablePath: process.env.CHROME_PATH ?? DEFAULT_CHROME,
    fault,
  };
}

async function startServer(port) {
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
  let ready = false;
  let startupOutput = '';
  child.stdout.on('data', (b) => {
    startupOutput += b.toString();
    if (/ready in|Local:\s+http/.test(startupOutput)) ready = true;
  });
  child.stderr.on('data', (b) => {
    startupOutput += b.toString();
  });
  const deadline = Date.now() + 20000;
  while (!ready && child.exitCode === null && Date.now() < deadline) await sleep(300);
  if (!ready) {
    await stopServer(child);
    throw new Error(`dev server を起動できませんでした: ${startupOutput.trim()}`);
  }
  await sleep(500);
  return child;
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((r) => {
    const timer = setTimeout(r, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      r();
    });
    child.kill('SIGTERM');
  });
}

/** 故障注入は src/main.ts に用意した dev限定・既定offのURLパラメータを実際に付与する形で
 * 行う(コメント冒頭の2026-08-31追記(1)参照)。ソースの手編集は不要。 */
function buildUrl(config) {
  const url = new URL(config.baseUrl);
  url.searchParams.set('system', '1');
  url.searchParams.set('run', '1');
  url.searchParams.set('fd2', FD2_PATH);
  if (config.worker) url.searchParams.set('worker', '1');
  if (config.fault === 'disable-autosave') url.searchParams.set('debugDisableAutosave', '1');
  if (config.fault === 'disable-reload-resume') url.searchParams.set('debugForceUrlRefetch', '1');
  return url.href;
}

async function waitForBootPrompt(page, timeoutMs) {
  await page.waitForFunction(
    async () => {
      const dump = await window.__webx68kDebug?.screenText?.();
      if (!dump?.available) return false;
      const lines = dump.lines.filter((l) => l.length > 0);
      const last = lines.filter((l) => l.startsWith('A>')).at(-1);
      return last !== undefined && last.length <= 2;
    },
    { timeout: timeoutMs, polling: 100 },
  );
}

/** 1文字 -> 合成KeyboardEventのcode/key。今回使う範囲(英字・数字・space・colon)だけをカバーする。
 * コロンは実測済みの Quote code で送る(Semicolonではない。measure-drives.mjsと同じ)。 */
function keySpecForChar(ch) {
  if (/^[a-z]$/.test(ch)) return { code: `Key${ch.toUpperCase()}`, key: ch };
  if (/^[0-9]$/.test(ch)) return { code: `Digit${ch}`, key: ch };
  if (ch === ' ') return { code: 'Space', key: ' ' };
  if (ch === ':') return { code: 'Quote', key: ':' };
  throw new Error(`keySpecForChar: 未対応の文字です: ${JSON.stringify(ch)}`);
}

/** 合成KeyboardEventの配列をページ内で順に送る(keydown→保持→keyup→間隔)。measure-drives.mjs
 * のexecuteDirと同じ理由でページ内で完結させる(ゲストはフレーム単位でキーをポーリングする
 * ため、keyup直後の次のkeydownまでにポーリングが複数回走るよう間隔を十分空ける必要がある)。 */
async function dispatchKeys(page, specs, config) {
  await page.evaluate(
    async ({ keySpecs, keyHold, keyGap }) => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      for (const spec of keySpecs) {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { code: spec.code, key: spec.key, bubbles: true, composed: true, cancelable: true }),
        );
        await wait(keyHold);
        window.dispatchEvent(
          new KeyboardEvent('keyup', { code: spec.code, key: spec.key, bubbles: true, composed: true, cancelable: true }),
        );
        await wait(keyGap);
      }
    },
    { keySpecs: specs, keyHold: config.keyHoldMs, keyGap: config.keyGapMs },
  );
}

async function readScreenLines(page) {
  return page.evaluate(async () => {
    const dump = await window.__webx68kDebug?.screenText?.();
    return dump?.available && Array.isArray(dump.lines) ? dump.lines.filter((l) => l.length > 0) : [];
  });
}

async function readPromptLine(page) {
  const lines = await readScreenLines(page);
  return lines.filter((l) => l.startsWith('A>')).at(-1) ?? null;
}

/** カーソルが行末に1文字だけ付くことがある(measure-drives.mjsのcommandLineMatchesと同じ
 * 配慮)。完全一致、または「期待値+末尾ちょうど1文字」だけを一致とみなす。 */
function promptLineMatches(line, expected) {
  if (line === expected) return true;
  if (line === null || !line.startsWith(expected)) return false;
  return Array.from(line.slice(expected.length)).length === 1;
}

/** 直近のプロンプト行(A>...)が確定するまで待つ(打鍵直後はTVRAM反映にラグがあるため)。 */
async function waitForPromptSettled(page, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  let lastLine = null;
  let stableCount = 0;
  while (Date.now() < deadline) {
    const line = await readPromptLine(page);
    if (line !== null && line === lastLine) {
      stableCount++;
      if (stableCount >= 3) return line;
    } else {
      stableCount = 0;
    }
    lastLine = line;
    await sleep(pollIntervalMs);
  }
  return lastLine;
}

/**
 * コマンド文字列を打鍵し、コマンド行を読み直して期待どおりかを検証する。食い違っていれば
 * (負荷による打鍵取りこぼし等)行をクリアして打ち直す。Enterは送らない(呼び出し側が
 * 検証成功後に別途送る)。
 *
 * 2026-08-31追記(2)への対応: 負荷が高いと合成キーが落ちる実測(measure-drives.mjsのDIR入力
 * でも同種の対策あり)を踏まえ、無検証で送りっぱなしにしない。リトライしても一致しなければ
 * HarnessErrorとして報告する(症状ではなく前提条件の欠落として扱う。打鍵そのものの信頼性は
 * 検証対象の外側にあるため)。
 */
async function typeCommandVerified(page, command, config) {
  const expected = `A>${command}`;
  for (let attempt = 0; attempt <= config.typeRetries; attempt++) {
    if (attempt > 0) {
      const current = await readPromptLine(page);
      const typedLength = current && current.startsWith('A>') ? Array.from(current.slice(2)).length : 0;
      const backspaceCount = Math.max(8, Math.min(80, typedLength + 4));
      const backspaces = Array.from({ length: backspaceCount }, () => ({ code: 'Backspace', key: 'Backspace' }));
      await dispatchKeys(page, backspaces, config);
      await sleep(300);
    }
    const specs = Array.from(command).map((ch) => keySpecForChar(ch));
    await dispatchKeys(page, specs, config);
    await sleep(300);
    const line = await readPromptLine(page);
    if (promptLineMatches(line, expected)) {
      return { retries: attempt, observedLine: line };
    }
  }
  const finalLine = await readPromptLine(page);
  throw new HarnessError(
    `コマンド行の打鍵が${config.typeRetries}回リトライしても一致しませんでした(症状ではなくハーネスの入力信頼性の問題として扱う): ` +
      `expected=${JSON.stringify(expected)}, observed=${JSON.stringify(finalLine)}`,
  );
}

/** DIR B: を実行し、直後の画面出力にMARKERが含まれるかを返す。打鍵はtypeCommandVerified経由。 */
async function checkMarkerViaDir(page, config) {
  const typing = await typeCommandVerified(page, 'dir b:', config);
  await dispatchKeys(page, [{ code: 'Enter', key: 'Enter' }], config);
  // DIRの出力が揃うまで少し待つ(ドライブ内容は小さいので長くは掛からない)。
  await sleep(Math.max(1000, config.keyHoldMs + config.keyGapMs) * 3);
  const lines = await readScreenLines(page);
  const text = lines.join('\n').toUpperCase();
  return { found: text.includes(MARKER), lines, retries: typing.retries };
}

/** ライブラリ(IndexedDB)のsourceKey一覧を軽量な形(bytesを含まない)で読む。 */
async function readLibrarySummary(page) {
  return page.evaluate(async () => {
    const list = await window.__webx68kDebug.storageProbeListLibrary();
    return list.map((d) => ({ sourceKey: d.sourceKey, name: d.name, savedAt: d.savedAt, byteLength: d.bytes.byteLength }));
  });
}

/** fd2のsourceKey(=URL文字列)のsavedAt/byteLengthが、baselineから変化するまでポーリングする。
 * 固定sleepではなく実際のレコード更新を条件にする(コーディネータ指摘どおり)。 */
async function waitForLibraryUpdated(page, sourceKey, baseline, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await readLibrarySummary(page);
    const entry = list.find((d) => d.sourceKey === sourceKey);
    if (entry && (entry.savedAt !== baseline.savedAt || entry.byteLength !== baseline.byteLength)) {
      return { updated: true, entry };
    }
    await sleep(pollIntervalMs);
  }
  return { updated: false, entry: null };
}

async function verifyOnce(browser, config) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 2 });
  await page.bringToFront();
  const url = buildUrl(config);
  const steps = [];
  const retries = {};

  const closeAndReturn = async (result) => {
    await context.close();
    return { ...result, retries };
  };

  await page.goto(url, { waitUntil: 'networkidle2' });
  await page.bringToFront();
  try {
    await waitForBootPrompt(page, config.bootTimeoutMs);
  } catch (err) {
    throw new HarnessError(`起動タイムアウト(A>に到達しませんでした): ${err.message}`);
  }
  steps.push('boot');

  // 手順2: fd2ディスクがライブラリに登録されていることを確認。
  let library = await readLibrarySummary(page);
  let fd2Entry = library.find((d) => d.sourceKey === FD2_PATH);
  if (!fd2Entry) {
    throw new HarnessError(
      `fd2ディスク(${FD2_PATH})がライブラリに登録されていません。sourceKeyの一覧: ${JSON.stringify(library.map((d) => d.sourceKey))}`,
    );
  }
  steps.push('library-registered');
  const baseline = { savedAt: fd2Entry.savedAt, byteLength: fd2Entry.byteLength };

  // 手順3: B: へ書き込ませる(打鍵検証・リトライ込み)。
  const mkdirTyping = await typeCommandVerified(page, 'mkdir b:wktest', config);
  retries.mkdir = mkdirTyping.retries;
  await dispatchKeys(page, [{ code: 'Enter', key: 'Enter' }], config);
  await waitForPromptSettled(page, 8000, 200);
  steps.push('mkdir-sent');

  // 手順4: DIR B: で作成できたことを画面で確認。
  const createdCheck = await checkMarkerViaDir(page, config);
  retries.dirAfterMkdir = createdCheck.retries;
  if (!createdCheck.found) {
    throw new HarnessError(
      `MKDIR B:WKTEST の作成を画面で確認できませんでした(DIR B: の出力にWKTESTが無い)。出力: ${JSON.stringify(createdCheck.lines)}`,
    );
  }
  steps.push('mkdir-confirmed');

  // 手順5: オートセーブでライブラリのレコードが更新されるのを待つ(ポーリング、固定sleepではない)。
  const waitResult = await waitForLibraryUpdated(page, FD2_PATH, baseline, config.autosaveTimeoutMs, config.pollIntervalMs);
  if (!waitResult.updated) {
    // ここは前提条件の欠落ではなく、検証対象そのもの(オートセーブ)の不合格。
    return closeAndReturn({
      result: 'fail',
      reason: `オートセーブが${config.autosaveTimeoutMs}ms以内にライブラリへ反映されませんでした(症状: 永続化されない)`,
      steps: [...steps, 'autosave-timeout'],
    });
  }
  steps.push('autosave-observed');

  // 手順6: リロード。
  await page.goto(url, { waitUntil: 'networkidle2' });
  await page.bringToFront();
  try {
    await waitForBootPrompt(page, config.bootTimeoutMs);
  } catch (err) {
    throw new HarnessError(`リロード後の起動タイムアウト: ${err.message}`);
  }
  steps.push('reload-boot');

  // 手順7: DIR B: でWKTESTが残っていることを確認。
  const survivedCheck = await checkMarkerViaDir(page, config);
  retries.dirAfterReload = survivedCheck.retries;
  if (!survivedCheck.found) {
    return closeAndReturn({
      result: 'fail',
      reason: `リロード後、DIR B: の出力にWKTESTが見つかりませんでした(症状: 書き込みが失われた)。出力: ${JSON.stringify(survivedCheck.lines)}`,
      steps: [...steps, 'reload-check-failed'],
    });
  }
  steps.push('reload-check-passed');

  return closeAndReturn({ result: 'pass', reason: 'DIR B: にWKTESTが残っていることを確認した', steps });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const config = buildConfig(args);
  let server;
  let browser;
  let profile;
  const startedAt = new Date().toISOString();
  let outcome;
  try {
    server = await startServer(config.port);
    profile = await mkdtemp(join(tmpdir(), 'webx68k-verify-disk-persistence-'));
    browser = await puppeteer.launch({
      executablePath: config.executablePath,
      userDataDir: profile,
      headless: false,
      args: ['--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=1000,900'],
    });

    try {
      outcome = await verifyOnce(browser, config);
    } catch (err) {
      if (err instanceof HarnessError) {
        outcome = { result: 'harness-error', reason: err.message, steps: [], retries: {} };
      } else {
        throw err;
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await stopServer(server);
  }

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    config: {
      worker: config.worker,
      port: config.port,
      bootTimeoutMs: config.bootTimeoutMs,
      autosaveTimeoutMs: config.autosaveTimeoutMs,
      typeRetries: config.typeRetries,
      fault: config.fault,
    },
    outcome,
  };

  await mkdir(dirname(config.outputPath), { recursive: true });
  await writeFile(config.outputPath, JSON.stringify(report, null, 2));

  console.log(`経路: ${config.worker ? 'Worker(?worker=1)' : '既定'}`);
  console.log(`故障注入: ${config.fault ?? '(なし)'}`);
  console.log(`結果: ${outcome.result}`);
  console.log(`理由: ${outcome.reason}`);
  console.log(`ステップ: ${outcome.steps.join(' -> ')}`);
  console.log(`打鍵リトライ: ${JSON.stringify(outcome.retries)}`);
  console.log(`結果JSON: ${config.outputPath}`);

  if (outcome.result !== 'pass') process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
