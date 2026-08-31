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
//   3. ゲストに B: へ書き込ませる(MKDIR B:WKTEST)
//   4. DIR B: でWKTESTが作成できたことを画面で確認(できていなければハーネスエラー)
//   5. オートセーブでライブラリのレコードが更新されるのを待つ(固定sleepではなくポーリング)
//   6. ページをリロードし、同じURLで再起動
//   7. DIR B: でWKTESTが残っていることを確認 → 合格/不合格
//
// 「ハーネスエラー」(前提条件が満たせず検証が成立しなかった)と「不合格」(検証は成立したが
// 症状(WKTESTが無い)が出た)を区別する。SKIPが合格の顔をする事故(過去の教訓)を避けるため。

import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
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
    const match = /^--(port|boot-timeout|autosave-timeout|poll-interval|key-hold|key-gap|output|fault)=(.+)$/.exec(
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
  --output=<path>            結果JSONの保存先
  --fault=<disable-autosave|disable-reload-resume>
                             故障注入の動作確認用(実装側を一時的に壊した状態で使う。
                             詳細は本ファイルのコメントおよびdocsを参照)

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

function buildUrl(config) {
  const url = new URL(config.baseUrl);
  url.searchParams.set('system', '1');
  url.searchParams.set('run', '1');
  url.searchParams.set('fd2', FD2_PATH);
  if (config.worker) url.searchParams.set('worker', '1');
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

/** コマンド文字列を打鍵しEnterを送る。ページ内で完結させる(measure-drives.mjsのexecuteDirと
 * 同じ理由: ゲストはフレーム単位でキーをポーリングするため、keyup直後の次のkeydownまでに
 * ポーリングが複数回走るよう、保持時間とキー間隔を十分に空ける必要がある)。 */
async function typeCommandAndEnter(page, command, config) {
  const specs = Array.from(command).map((ch) => keySpecForChar(ch));
  specs.push({ code: 'Enter', key: 'Enter' });
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

/** 直近のプロンプト行(A>...)が確定するまで待つ(打鍵直後はTVRAM反映にラグがあるため)。 */
async function waitForPromptSettled(page, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  let lastLine = null;
  let stableCount = 0;
  while (Date.now() < deadline) {
    const lines = await readScreenLines(page);
    const line = lines.filter((l) => l.startsWith('A>')).at(-1) ?? null;
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

/** DIR B: を実行し、直後の画面出力にMARKERが含まれるかを返す。 */
async function checkMarkerViaDir(page, config) {
  await typeCommandAndEnter(page, 'dir b:', config);
  // DIRの出力が揃うまで少し待つ(ドライブ内容は小さいので長くは掛からない)。
  await sleep(Math.max(1000, config.keyHoldMs + config.keyGapMs) * 3);
  const lines = await readScreenLines(page);
  const text = lines.join('\n').toUpperCase();
  return { found: text.includes(MARKER), lines };
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

  const closeAndReturn = async (result) => {
    await context.close();
    return result;
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

  // 手順3: B: へ書き込ませる。
  await typeCommandAndEnter(page, 'mkdir b:wktest', config);
  await waitForPromptSettled(page, 8000, 200);
  steps.push('mkdir-sent');

  // 手順4: DIR B: で作成できたことを画面で確認。
  const createdCheck = await checkMarkerViaDir(page, config);
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
        outcome = { result: 'harness-error', reason: err.message, steps: [] };
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
      fault: config.fault,
    },
    outcome,
  };

  await mkdir(dirname(config.outputPath), { recursive: true });
  await writeFile(config.outputPath, JSON.stringify(report, null, 2));

  console.log(`経路: ${config.worker ? 'Worker(?worker=1)' : '既定'}`);
  console.log(`結果: ${outcome.result}`);
  console.log(`理由: ${outcome.reason}`);
  console.log(`ステップ: ${outcome.steps.join(' -> ')}`);
  console.log(`結果JSON: ${config.outputPath}`);

  if (outcome.result !== 'pass') process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
