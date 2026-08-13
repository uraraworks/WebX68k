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
const DEFAULT_POLL_INTERVAL_MS = 50;
const REQUIRED_STABLE_POLLS = 3;
const VALID_FAULTS = new Set(['no-disk', 'wrong-marker']);
const INTERVAL_LABELS = {
  clickToWasmFetchComplete: 'クリック→wasm取得完了',
  wasmFetchCompleteToCoreReady: 'wasm取得完了→コア稼働',
  coreReadyToFirstGuestOutput: 'コア稼働→ゲスト初出力',
  firstGuestOutputToPromptStable: 'ゲスト初出力→プロンプト安定',
};

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
    const match = /^--(port|runs|timeout|poll-interval|output|fault)=(.+)$/.exec(arg);
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
  --poll-interval=<ms>  ページ内ポーリング間隔 (既定: 50)
  --output=<path>       JSON の保存先
  --fault=<name>        no-disk または wrong-marker

環境変数: WEBX68K_PORT, WEBX68K_RUNS, WEBX68K_TIMEOUT_MS,
          WEBX68K_POLL_INTERVAL_MS,
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
    pollIntervalMs: parsePositiveInteger(
      args['poll-interval'] ??
        process.env.WEBX68K_POLL_INTERVAL_MS ??
        String(DEFAULT_POLL_INTERVAL_MS),
      'poll-interval',
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

/**
 * 実クリック後の状態をページ内クロックだけで観測する。
 * 間隔を短くすると時刻の上限誤差は減るが、stat/screenText の呼び出し負荷は増える。
 */
function observeBoot(page, buttonSelector, marker, timeoutMs, pollIntervalMs) {
  return page.evaluate(
    async ({ selector, expectedMarker, timeout, pollInterval, stablePolls }) => {
      const observedResources = [];
      let resourceObserverSupported = true;
      let resourceObserverError = null;
      let resourceObserver = null;
      const serializeResource = (entry) => ({
        name: entry.name,
        initiatorType: entry.initiatorType,
        startTime: entry.startTime,
        responseEnd: entry.responseEnd,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
      });

      try {
        resourceObserver = new PerformanceObserver((list) => {
          observedResources.push(...list.getEntries().map(serializeResource));
        });
        resourceObserver.observe({ type: 'resource', buffered: true });
      } catch (error) {
        resourceObserverSupported = false;
        resourceObserverError = error instanceof Error ? error.message : String(error);
      }

      const button = document.querySelector(selector);
      if (!button) throw new Error(`起動ボタンが見つかりません: ${selector}`);

      const readDebugState = () => {
        const debug = window.__webx68kDebug;
        let statValue = null;
        let statError = null;
        try {
          statValue = typeof debug?.stat === 'function' ? debug.stat() : null;
        } catch (error) {
          statError = error instanceof Error ? error.message : String(error);
        }
        // queuedSec は音声初期化だけで数値になり、コア生成前にも成立し得る。
        // fetchAvInfo() 後に設定される fps の有限数だけをコア稼働の根拠にする。
        const statValid = statValue !== null && Number.isFinite(statValue.fps);

        let screenValue = null;
        let screenError = null;
        try {
          screenValue = typeof debug?.screenText === 'function' ? debug.screenText() : null;
        } catch (error) {
          screenError = error instanceof Error ? error.message : String(error);
        }
        const nonEmptyLines =
          screenValue?.available && Array.isArray(screenValue.lines)
            ? screenValue.lines.filter((line) => line.length > 0)
            : [];
        const markerLine =
          nonEmptyLines.filter((line) => line.startsWith(expectedMarker)).at(-1) ?? null;
        const promptRemainderLength =
          markerLine === null
            ? Number.POSITIVE_INFINITY
            : Array.from(markerLine.slice(expectedMarker.length)).length;

        return {
          debugDefined: debug !== undefined,
          stat: { callable: typeof debug?.stat === 'function', value: statValue, error: statError },
          screenText: {
            callable: typeof debug?.screenText === 'function',
            available: screenValue?.available === true,
            error: screenError,
          },
          conditions: {
            wasmFetchComplete: performance
              .getEntriesByType('resource')
              .some((entry) => /\.wasm(?:[?#]|$)/i.test(entry.name) && entry.responseEnd > 0),
            coreReady: statValid,
            firstGuestOutput: nonEmptyLines.length > 0,
            promptStable: markerLine !== null && promptRemainderLength <= 1,
          },
        };
      };

      // クリック前から成立している判定は起動マイルストーンとして使えないため、
      // 実クリック待受を設置する直前に全条件を一度記録して結果へ残す。
      const preClickState = readDebugState();
      const clickedAt = await new Promise((resolveClick) => {
        button.addEventListener('click', () => resolveClick(performance.now()), {
          capture: true,
          once: true,
        });
      });

      let coreReadyAt = null;
      let firstGuestOutputAt = null;
      let promptStableAt = null;
      let consecutive = 0;
      let lastNonEmptyLine = null;
      let lastMarkerLine = null;
      let lastAPromptLine = null;
      let timedOut = false;

      while (true) {
        const now = performance.now();
        const debug = window.__webx68kDebug;
        if (coreReadyAt === null && typeof debug?.stat === 'function') {
          try {
            const stat = debug.stat();
            if (stat !== null && Number.isFinite(stat.fps)) {
              coreReadyAt = now;
            }
          } catch {
            // stat がまだ有効な状態を返せない間は、次回ポーリングで再試行する。
          }
        }

        let dump = null;
        try {
          dump = debug?.screenText?.() ?? null;
        } catch {
          // TVRAM がまだ利用不能なら、次回ポーリングで再試行する。
        }
        if (dump?.available && Array.isArray(dump.lines)) {
          const nonEmptyLines = dump.lines.filter((line) => line.length > 0);
          if (firstGuestOutputAt === null && nonEmptyLines.length > 0) {
            firstGuestOutputAt = now;
          }
          lastNonEmptyLine = nonEmptyLines.at(-1) ?? null;
          lastMarkerLine =
            nonEmptyLines.filter((line) => line.startsWith(expectedMarker)).at(-1) ?? null;
          lastAPromptLine = nonEmptyLines.filter((line) => line.startsWith('A>')).at(-1) ?? null;
          const promptRemainderLength =
            lastMarkerLine === null
              ? Number.POSITIVE_INFINITY
              : Array.from(lastMarkerLine.slice(expectedMarker.length)).length;
          consecutive =
            lastMarkerLine !== null && promptRemainderLength <= 1 ? consecutive + 1 : 0;
          if (consecutive >= stablePolls) {
            promptStableAt = now;
            break;
          }
        } else {
          // デバッグAPIやTVRAMがまだ利用不能なら、安定判定をリセットして待ち続ける。
          consecutive = 0;
        }

        if (now - clickedAt >= timeout) {
          timedOut = true;
          break;
        }
        await new Promise((resolvePoll) => setTimeout(resolvePoll, pollInterval));
      }

      resourceObserver?.takeRecords().forEach((entry) => {
        observedResources.push(serializeResource(entry));
      });
      resourceObserver?.disconnect();
      const finalResources = performance.getEntriesByType('resource').map(serializeResource);
      const uniqueResources = [...observedResources, ...finalResources].filter(
        (entry, index, entries) =>
          entries.findIndex(
            (candidate) =>
              candidate.name === entry.name &&
              candidate.startTime === entry.startTime &&
              candidate.responseEnd === entry.responseEnd,
          ) === index,
      );
      const wasmResources = uniqueResources.filter((entry) =>
        /\.wasm(?:[?#]|$)/i.test(entry.name),
      );

      return {
        clickedAt,
        preClickState,
        observationEndedAt: performance.now(),
        coreReadyAt,
        firstGuestOutputAt,
        promptStableAt,
        timedOut,
        lastNonEmptyLine,
        lastMarkerLine,
        lastAPromptLine,
        wasmResources,
        resourceObserver: {
          supported: resourceObserverSupported,
          error: resourceObserverError,
        },
      };
    },
    {
      selector: buttonSelector,
      expectedMarker: marker,
      timeout: timeoutMs,
      pollInterval: pollIntervalMs,
      stablePolls: REQUIRED_STABLE_POLLS,
    },
  );
}

const roundMs = (value) => (value === null ? null : Math.round(value * 1000) / 1000);

function buildTimingDetails(observed) {
  const wasmFetchCompleteAt =
    observed.wasmResources.length === 0
      ? null
      : Math.max(...observed.wasmResources.map((entry) => entry.responseEnd));
  const milestones = {
    click: { pageTimeMs: roundMs(observed.clickedAt), status: 'valid', reason: null },
    wasmFetchComplete: {
      pageTimeMs: roundMs(wasmFetchCompleteAt),
      status: wasmFetchCompleteAt === null ? 'unavailable' : 'valid',
      reason:
        wasmFetchCompleteAt === null
          ? 'Resource Timing に .wasm のエントリが見つからなかった'
          : null,
    },
    coreReady: {
      pageTimeMs: roundMs(observed.coreReadyAt),
      status: observed.coreReadyAt === null ? 'unavailable' : 'valid',
      reason:
        observed.coreReadyAt === null
          ? 'タイムアウトまでに __webx68kDebug.stat() が有限数の fps を返さなかった'
          : null,
    },
    firstGuestOutput: {
      pageTimeMs: roundMs(observed.firstGuestOutputAt),
      status: observed.firstGuestOutputAt === null ? 'unavailable' : 'valid',
      reason:
        observed.firstGuestOutputAt === null
          ? 'タイムアウトまでに TVRAM の非空行を観測できなかった'
          : null,
    },
    promptStable: {
      pageTimeMs: roundMs(observed.promptStableAt),
      status: observed.promptStableAt === null ? 'unavailable' : 'valid',
      reason: observed.promptStableAt === null ? 'プロンプト安定前にタイムアウトした' : null,
    },
  };
  const invalidMilestones = new Set();
  const interval = (fromName, toName) => {
    const from = milestones[fromName].pageTimeMs;
    const to = milestones[toName].pageTimeMs;
    if (from === null || to === null) return null;
    const value = roundMs(to - from);
    if (value < 0) {
      // 負の区間は時刻順序の逆転、つまり意図した事象を測れていない合図であり、
      // 統計値として扱うと中央値等を誤らせるため、後側のマイルストーンを無効化する。
      invalidMilestones.add(toName);
      milestones[toName].status = 'invalid';
      milestones[toName].invalid = true;
      milestones[toName].reason = `${fromName} より前に観測されたため invalid`;
      return null;
    }
    return value;
  };
  const intervalReason = (fromName, toName) => {
    const reasons = [milestones[fromName].reason, milestones[toName].reason].filter(Boolean);
    return reasons.length === 0 ? null : reasons.join('; ');
  };
  const intervalsMs = {
    clickToWasmFetchComplete: interval('click', 'wasmFetchComplete'),
    wasmFetchCompleteToCoreReady: interval('wasmFetchComplete', 'coreReady'),
    coreReadyToFirstGuestOutput: interval('coreReady', 'firstGuestOutput'),
    firstGuestOutputToPromptStable: interval('firstGuestOutput', 'promptStable'),
  };
  return {
    milestones,
    invalidMilestones: [...invalidMilestones],
    intervalsMs,
    intervalReasons: {
      clickToWasmFetchComplete: intervalReason('click', 'wasmFetchComplete'),
      wasmFetchCompleteToCoreReady: intervalReason('wasmFetchComplete', 'coreReady'),
      coreReadyToFirstGuestOutput: intervalReason('coreReady', 'firstGuestOutput'),
      firstGuestOutputToPromptStable: intervalReason('firstGuestOutput', 'promptStable'),
    },
    wasmResources: observed.wasmResources.map((entry) => ({
      ...entry,
      startTime: roundMs(entry.startTime),
      responseEnd: roundMs(entry.responseEnd),
    })),
  };
}

function emptyTimingDetails(reason) {
  return {
    milestones: Object.fromEntries(
      ['click', 'wasmFetchComplete', 'coreReady', 'firstGuestOutput', 'promptStable'].map(
        (name) => [name, { pageTimeMs: null, status: 'unavailable', reason }],
      ),
    ),
    intervalsMs: Object.fromEntries(Object.keys(INTERVAL_LABELS).map((name) => [name, null])),
    invalidMilestones: [],
    intervalReasons: Object.fromEntries(
      Object.keys(INTERVAL_LABELS).map((name) => [name, reason]),
    ),
    wasmResources: [],
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

    const marker = config.fault === 'wrong-marker' ? 'Z>' : 'A>';
    const observationPromise = observeBoot(
      page,
      buttonSelector,
      marker,
      config.timeoutMs,
      config.pollIntervalMs,
    );
    // Node 側のクリック要求時刻と、ページ側の実クリックイベント時刻の対応は
    // この1組だけを記録する。区間計算にはページ側時刻だけを使う。
    const nodeClickCommandAt = performance.now();
    const [observed] = await Promise.all([observationPromise, page.click(buttonSelector)]);
    const timing = buildTimingDetails(observed);
    const durationMs = roundMs(
      (observed.promptStableAt ?? observed.observationEndedAt) - observed.clickedAt,
    );
    const common = {
      durationMs,
      preClickState: observed.preClickState,
      clockMapping: {
        nodeClickCommandPerformanceNowMs: roundMs(nodeClickCommandAt),
        pageClickEventPerformanceNowMs: roundMs(observed.clickedAt),
        note: '対応関係の記録のみ。区間計算は page performance.now() のみを使用',
      },
      ...timing,
      resourceObserver: observed.resourceObserver,
    };
    if (observed.timedOut) {
      return {
        trial,
        success: false,
        ...common,
        reason: 'timeout',
        lastNonEmptyLine: observed.lastNonEmptyLine,
        lastAPromptLine: observed.lastAPromptLine ?? '該当行なし',
      };
    }
    return {
      trial,
      success: true,
      ...common,
      marker,
      lastNonEmptyLine: observed.lastNonEmptyLine,
      lastMarkerLine: observed.lastMarkerLine,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      trial,
      success: false,
      durationMs: null,
      reason: 'measurement-error',
      error: errorMessage,
      clockMapping: null,
      ...emptyTimingDetails(`計測エラーのため取得不能: ${errorMessage}`),
      resourceObserver: null,
      preClickState: null,
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
    const intervalSummary = Object.fromEntries(
      Object.keys(INTERVAL_LABELS).map((name) => {
        const samples = attempts
          .map((attempt) => attempt.intervalsMs?.[name])
          .filter((value) => Number.isFinite(value));
        return [name, { sampleCount: samples.length, ...summarize(samples) }];
      }),
    );
    const measuredTrials = [
      ...(positiveControl ? [{ label: '陽性対照', value: positiveControl }] : []),
      ...attempts.map((attempt) => ({ label: `試行 ${attempt.trial}`, value: attempt })),
    ];
    for (const measured of measuredTrials) {
      for (const milestone of measured.value.invalidMilestones ?? []) {
        console.log(
          `警告: ${measured.label} のマイルストーン ${milestone} は時刻順序が逆転したため invalid`,
        );
      }
    }
    const result = {
      schemaVersion: 3,
      measuredAt: new Date().toISOString(),
      measurement: '起動ボタンの実クリック直前からHuman68kプロンプト安定表示まで',
      config: {
        baseUrl: config.baseUrl,
        port: config.port,
        runs: config.runs,
        timeoutMs: config.timeoutMs,
        pollIntervalMs: config.pollIntervalMs,
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
        intervals: intervalSummary,
      },
      faultCheck,
      limitations: [
        'wasm取得完了からコア稼働までにはwasmのコンパイルと初期化が含まれるが、ページ外観測だけでは分解できない',
        'ポーリングで得るコア稼働・ゲスト初出力・プロンプト安定の時刻には最大で概ねpollIntervalMs分の観測遅延がある',
      ],
    };

    await mkdir(dirname(config.outputPath), { recursive: true });
    await writeFile(config.outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

    const stats = result.summary;
    console.log(
      `起動計測: 成功 ${stats.succeeded}/${stats.total}, 失敗 ${stats.failed}, ` +
        `中央値 ${stats.medianMs ?? '-'} ms, p95 ${stats.p95Ms ?? '-'} ms, ` +
        `p99 ${stats.p99Ms ?? '-'} ms, 出力 ${config.outputPath}`,
    );
    console.log('区間中央値（大きい順）:');
    Object.entries(intervalSummary)
      .sort(([, left], [, right]) => (right.medianMs ?? -Infinity) - (left.medianMs ?? -Infinity))
      .forEach(([name, intervalStats]) => {
        console.log(
          `  ${INTERVAL_LABELS[name]}: 中央値 ${intervalStats.medianMs ?? '-'} ms, ` +
            `p95 ${intervalStats.p95Ms ?? '-'} ms (${intervalStats.sampleCount}件)`,
        );
      });
    attempts.forEach((attempt) => {
      console.log(`試行 ${attempt.trial} preClickState: ${JSON.stringify(attempt.preClickState)}`);
    });
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
