// WebX68k の「起動ボタンの実クリック」直前から、Human68k のプロンプトが安定して
// 表示されるまでの所要時間を反復計測するスクリプト。
// 完了条件を単純な `A>` の一致や前方一致にしないのは、点滅カーソルが末尾に1文字
// 付いたり消えたりする一方、AUTOEXEC 実行中にも `A>ECHO OFF` が現れるためである。
// `A>` で始まる最後の行を「`A>` + 最大1文字」に限定し、それを3回連続で
// 観測して完了とする。プロンプトより下の案内行は判定対象にしない。

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const POLL_INTERVAL_MS = 100;
const REQUIRED_STABLE_POLLS = 3;
const VALID_FAULTS = new Set(['no-disk', 'wrong-marker']);

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

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
    const match = /^--(port|runs|timeout|output|fault)=(.+)$/.exec(arg);
    if (!match) throw new Error(`不明な引数です: ${arg}`);
    values[match[1]] = match[2];
  }
  return values;
}

function printHelp() {
  console.log(`Usage: node scripts/measure-boot.mjs [options]

  --port=<number>       dev server のポート (既定: 5183)
  --runs=<number>       反復回数 (既定: 20)
  --timeout=<ms>        各試行のタイムアウト (既定: 60000)
  --output=<path>       JSON の保存先
  --fault=<name>        no-disk または wrong-marker

環境変数: WEBX68K_PORT, WEBX68K_RUNS, WEBX68K_TIMEOUT_MS,
          WEBX68K_MEASURE_OUTPUT, WEBX68K_URL, CHROME_PATH`);
}

function defaultOutputPath() {
  const serial = new Date().toISOString().replace(/[:.]/g, '-');
  return join(REPO_ROOT, '_local', 'measure', `boot-${serial}.json`);
}

function buildConfig(args) {
  const urlFromEnv = process.env.WEBX68K_URL;
  const envUrl = urlFromEnv ? new URL(urlFromEnv) : null;
  const port = parsePositiveInteger(
    args.port ?? process.env.WEBX68K_PORT ?? envUrl?.port ?? '5183',
    'port',
  );
  const baseUrl = envUrl ?? new URL(`http://localhost:${port}`);
  baseUrl.port = String(port);

  const outputValue =
    args.output ?? process.env.WEBX68K_MEASURE_OUTPUT ?? defaultOutputPath();
  const outputPath = isAbsolute(outputValue) ? outputValue : resolve(REPO_ROOT, outputValue);
  const fault = args.fault ?? null;
  if (fault !== null && !VALID_FAULTS.has(fault)) {
    throw new Error(`fault は no-disk または wrong-marker を指定してください: ${fault}`);
  }

  return {
    baseUrl: baseUrl.href.replace(/\/$/, ''),
    port,
    runs: parsePositiveInteger(args.runs ?? process.env.WEBX68K_RUNS ?? '20', 'runs'),
    timeoutMs: parsePositiveInteger(
      args.timeout ?? process.env.WEBX68K_TIMEOUT_MS ?? '60000',
      'timeout',
    ),
    outputPath,
    executablePath: process.env.CHROME_PATH ?? DEFAULT_CHROME,
    fault,
  };
}

/** `npm run dev` を専用ポートで起動し、Vite の ready 表示を待つ。 */
async function startDevServer(port) {
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
  let ready = false;
  let startupError = '';
  child.stdout.on('data', (buffer) => {
    if (buffer.toString().includes('ready in')) ready = true;
  });
  child.stderr.on('data', (buffer) => {
    startupError += buffer.toString();
  });

  const deadline = Date.now() + 20000;
  while (!ready && child.exitCode === null && Date.now() < deadline) await sleep(300);
  if (!ready) {
    await stopDevServer(child);
    throw new Error(
      `dev server を起動できませんでした${startupError ? `: ${startupError.trim()}` : ''}`,
    );
  }
  await sleep(500);
  return child;
}

function stopDevServer(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveStop) => {
    child.once('exit', resolveStop);
    child.kill('SIGTERM');
    setTimeout(resolveStop, 3000);
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

function summarize(samples) {
  if (samples.length === 0) {
    return { medianMs: null, p95Ms: null, p99Ms: null, minMs: null, maxMs: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    minMs: sorted[0],
    maxMs: sorted.at(-1),
  };
}

/** TVRAM の行が「marker + 最大1文字」なら true。 */
function isPromptLine(line, marker) {
  return line.startsWith(marker) && Array.from(line.slice(marker.length)).length <= 1;
}

async function waitForStablePrompt(page, marker, startedAt, timeoutMs) {
  let consecutive = 0;
  let lastNonEmptyLine = null;
  let lastMarkerLine = null;
  let lastAPromptLine = null;

  while (performance.now() - startedAt < timeoutMs) {
    const dump = await page.evaluate(() => window.__webx68kDebug?.screenText?.() ?? null);
    if (dump?.available && Array.isArray(dump.lines)) {
      const nonEmptyLines = dump.lines.filter((line) => line.length > 0);
      lastNonEmptyLine = nonEmptyLines.at(-1) ?? null;
      lastMarkerLine = nonEmptyLines.filter((line) => line.startsWith(marker)).at(-1) ?? null;
      lastAPromptLine = nonEmptyLines.filter((line) => line.startsWith('A>')).at(-1) ?? null;
      consecutive =
        lastMarkerLine !== null && isPromptLine(lastMarkerLine, marker) ? consecutive + 1 : 0;
      if (consecutive >= REQUIRED_STABLE_POLLS) {
        return {
          elapsedMs: performance.now() - startedAt,
          lastNonEmptyLine,
          lastMarkerLine,
          lastAPromptLine,
        };
      }
    } else {
      // デバッグAPIやTVRAMがまだ利用不能なら、安定判定をリセットして待ち続ける。
      consecutive = 0;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  return {
    elapsedMs: performance.now() - startedAt,
    lastNonEmptyLine,
    lastMarkerLine,
    lastAPromptLine,
    timedOut: true,
  };
}

async function measureOnce(browser, config, trial) {
  // 各試行を新しい BrowserContext に分離する。IndexedDB を個別に削除する方式では、
  // ページが開いた接続により削除が待たされる可能性があるためである。新コンテキストなら
  // IndexedDB を含む同一オリジンの状態を確実に持ち越さず、ページも毎回新規ロードになる。
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 2 });
    await page.bringToFront();
    await page.goto(config.baseUrl, { waitUntil: 'networkidle2' });
    await page.bringToFront();

    const buttonSelector = config.fault === 'no-disk' ? '#btn-boot-plain' : '#btn-boot-system';
    await page.waitForSelector(buttonSelector, { visible: true });

    // Node 側の単調時計だけを使う。Puppeteer の実クリック要求を出す直前が始点。
    const startedAt = performance.now();
    await page.click(buttonSelector);

    const marker = config.fault === 'wrong-marker' ? 'Z>' : 'A>';
    const observed = await waitForStablePrompt(page, marker, startedAt, config.timeoutMs);
    const durationMs = Math.round(observed.elapsedMs * 1000) / 1000;
    if (observed.timedOut) {
      return {
        trial,
        success: false,
        durationMs,
        reason: 'timeout',
        lastNonEmptyLine: observed.lastNonEmptyLine,
        lastAPromptLine: observed.lastAPromptLine ?? '該当行なし',
      };
    }
    return {
      trial,
      success: true,
      durationMs,
      marker,
      lastNonEmptyLine: observed.lastNonEmptyLine,
      lastMarkerLine: observed.lastMarkerLine,
    };
  } catch (error) {
    return {
      trial,
      success: false,
      durationMs: null,
      reason: 'measurement-error',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await context.close();
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const config = buildConfig(args);
  let devServer;
  let browser;
  let profile;

  try {
    devServer = await startDevServer(config.port);
    profile = await mkdtemp(join(tmpdir(), 'webx68k-measure-boot-'));
    browser = await puppeteer.launch({
      executablePath: config.executablePath,
      userDataDir: profile,
      // headless では rAF がスロットルされるため、ヘッドフルかつ前面タブで計測する。
      headless: false,
      args: ['--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=1000,900'],
    });

    const positiveControl = config.fault
      ? await measureOnce(browser, { ...config, fault: null }, 1)
      : null;
    const attempts = [];
    if (!positiveControl || positiveControl.success) {
      for (let trial = 1; trial <= config.runs; trial++) {
        attempts.push(await measureOnce(browser, config, trial));
      }
    }

    const samplesMs = attempts.filter((attempt) => attempt.success).map((attempt) => attempt.durationMs);
    const failures = attempts.filter((attempt) => !attempt.success);
    const failureByReason = Object.fromEntries(
      [...new Set(failures.map((failure) => failure.reason))].map((reason) => [
        reason,
        failures.filter((failure) => failure.reason === reason).length,
      ]),
    );
    const positiveControlPassed = positiveControl?.success ?? null;
    const faultCheck = config.fault
      ? {
          expectedFailure: 'timeout',
          positiveControlPassed,
          passed:
            positiveControlPassed === true &&
            samplesMs.length === 0 &&
            failures.length === config.runs &&
            failures.every((failure) => failure.reason === 'timeout'),
          reason:
            positiveControlPassed !== true
              ? 'positive-control-failed'
              : failures.length === config.runs &&
                  failures.every((failure) => failure.reason === 'timeout')
                ? null
                : 'fault-not-detected',
        }
      : null;
    const result = {
      schemaVersion: 1,
      measuredAt: new Date().toISOString(),
      measurement: '起動ボタンの実クリック直前からHuman68kプロンプト安定表示まで',
      config: {
        baseUrl: config.baseUrl,
        port: config.port,
        runs: config.runs,
        timeoutMs: config.timeoutMs,
        pollIntervalMs: POLL_INTERVAL_MS,
        requiredStablePolls: REQUIRED_STABLE_POLLS,
        fault: config.fault,
      },
      samplesMs,
      attempts,
      positiveControl,
      summary: {
        total: attempts.length,
        succeeded: samplesMs.length,
        failed: failures.length,
        failureByReason,
        ...summarize(samplesMs),
      },
      faultCheck,
    };

    await mkdir(dirname(config.outputPath), { recursive: true });
    await writeFile(config.outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

    const stats = result.summary;
    console.log(
      `起動計測: 成功 ${stats.succeeded}/${stats.total}, 失敗 ${stats.failed}, ` +
        `中央値 ${stats.medianMs ?? '-'} ms, p95 ${stats.p95Ms ?? '-'} ms, ` +
        `p99 ${stats.p99Ms ?? '-'} ms, 出力 ${config.outputPath}`,
    );
    if (faultCheck) {
      console.log(
        `陽性対照: ${positiveControl.success ? '成功' : '失敗'}${
          positiveControl.durationMs === null ? '' : ` (${positiveControl.durationMs} ms)`
        }`,
      );
      console.log(
        `故障注入 ${config.fault}: ${
          !positiveControl.success
            ? '検出力を確認できない'
            : faultCheck.passed
              ? '期待どおり検出'
              : '検出失敗'
        }`,
      );
      if (!faultCheck.passed) process.exitCode = 1;
    } else if (failures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (browser) await browser.close();
    if (profile) await rm(profile, { recursive: true, force: true });
    await stopDevServer(devServer);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
