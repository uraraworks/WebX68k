// 目的B(docs/STORAGE-SCSI.md「目的B」表「フレーム時間の分布」)の実測スクリプト。
//
// 測るもの: retro_run()完了間隔、video callbackのRGB565→RGBA変換時間、putImageData()復帰までの
// 時間、前面タブのrAF観測間隔、long task件数/秒。これらは src/storage-probe.ts の frameProbe と、
// src/libretro-host.ts(runFrame()/handleVideoRefresh())・src/main.ts(独立rAFチェーン・
// PerformanceObserver('longtask'))へ追加した計測点で採取する(既定off、DEV限定)。
//
// このスクリプトはさらに、アプリ内蔵のframeProbeとは独立した「外部オラクル」(Puppeteer側から
// evaluateOnNewDocumentで注入するrAF/longtask観測)を常時有効に持つ。frameProbeのon/offに
// 影響されない値で「計測点のコスト」(--mode=cost)を測るため。
//
// measure-boot.mjs / measure-ram-expansion.mjs と同じ流儀(ヘッドフルPuppeteer、
// BrowserContext分離、統計・JSON出力、故障注入+陽性対照)を踏襲する。共通処理は複製する。

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VALID_MODES = new Set(['main', 'cost', 'fault']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const roundMs = (v) => (v === null || v === undefined ? null : Math.round(v * 1000) / 1000);

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
    const match = /^--(port|mode|duration-ms|boot-timeout|output)=(.+)$/.exec(arg);
    if (!match) throw new Error(`不明な引数です: ${arg}`);
    values[match[1]] = match[2];
  }
  return values;
}

function printHelp() {
  console.log(`Usage: node scripts/measure-frame-timing.mjs [options]

  --port=<number>       dev server のポート (既定: 5194)
  --mode=<main|cost|fault>
                         main: 起動〜定常状態のフレーム時間分布を採る(既定)
                         cost: frameProbe有効/無効での外部オラクル指標を比較する(計測点のコスト)
                         fault: 陽性対照+60フレームごと50ms busy wait注入で測定系を検証する
  --duration-ms=<number> 起動完了後の観測窓(ms) (既定: 12000)
  --boot-timeout=<ms>    起動完了タイムアウト (既定: 90000)
  --output=<path>        JSON の保存先

環境変数: WEBX68K_PORT, WEBX68K_FRAMETIMING_OUTPUT, WEBX68K_URL, CHROME_PATH`);
}

function defaultOutputPath(mode) {
  const serial = new Date().toISOString().replace(/[:.]/g, '-');
  return join(REPO_ROOT, '_local', 'measure', `frame-timing-${mode}-${serial}.json`);
}

function buildConfig(args) {
  const envUrl = process.env.WEBX68K_URL ? new URL(process.env.WEBX68K_URL) : null;
  const port = parsePositiveInteger(args.port ?? process.env.WEBX68K_PORT ?? envUrl?.port ?? '5194', 'port');
  const baseUrl = envUrl ?? new URL(`http://localhost:${port}`);
  baseUrl.port = String(port);
  const mode = args.mode ?? 'main';
  if (!VALID_MODES.has(mode)) throw new Error(`mode は main, cost, fault のいずれかで指定してください: ${mode}`);
  const outputValue = args.output ?? process.env.WEBX68K_FRAMETIMING_OUTPUT ?? defaultOutputPath(mode);
  return {
    baseUrl: baseUrl.href.replace(/\/$/, ''),
    port,
    mode,
    durationMs: parsePositiveInteger(args['duration-ms'] ?? '12000', 'duration-ms'),
    bootTimeoutMs: parsePositiveInteger(args['boot-timeout'] ?? '90000', 'boot-timeout'),
    outputPath: isAbsolute(outputValue) ? outputValue : resolve(REPO_ROOT, outputValue),
    executablePath: process.env.CHROME_PATH ?? DEFAULT_CHROME,
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
    return { sampleCount: 0, medianMs: null, p95Ms: null, p99Ms: null, minMs: null, maxMs: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    sampleCount: samples.length,
    medianMs: roundMs(percentile(sorted, 0.5)),
    p95Ms: roundMs(percentile(sorted, 0.95)),
    p99Ms: roundMs(percentile(sorted, 0.99)),
    minMs: roundMs(sorted[0]),
    maxMs: roundMs(sorted.at(-1)),
  };
}

function diffs(samples) {
  const out = [];
  for (let i = 1; i < samples.length; i++) out.push(samples[i] - samples[i - 1]);
  return out;
}

async function waitForBootPrompt(page, timeoutMs) {
  await page.waitForFunction(
    () => {
      const dump = window.__webx68kDebug?.screenText?.();
      if (!dump?.available) return false;
      const lines = dump.lines.filter((l) => l.length > 0);
      const last = lines.filter((l) => l.startsWith('A>')).at(-1);
      return last !== undefined && last.length <= 2;
    },
    { timeout: timeoutMs, polling: 100 },
  );
}

/** frameProbeとは独立した外部オラクル(常時有効)。cost比較で probe on/off に依存しない値を採る。 */
async function injectExternalObservers(page) {
  await page.evaluateOnNewDocument(() => {
    window.__extRaf = [];
    window.__extLongTasks = [];
    function tick() {
      window.__extRaf.push(performance.now());
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__extLongTasks.push({ startAtMs: entry.startTime, durationMs: entry.duration });
        }
      });
      po.observe({ entryTypes: ['longtask'] });
    } catch {
      // long task API 非対応。__extLongTasksは空のまま。
    }
  });
}

async function readExternalObservers(page) {
  return page.evaluate(() => ({
    extRaf: window.__extRaf ?? [],
    extLongTasks: window.__extLongTasks ?? [],
  }));
}

async function newPage(browser, config) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await injectExternalObservers(page);
  await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 2 });
  await page.bringToFront();
  await page.goto(config.baseUrl, { waitUntil: 'networkidle2' });
  await page.bringToFront();
  return { context, page };
}

async function bootAndObserve(browser, config, { busyWaitFault }) {
  const { context, page } = await newPage(browser, config);
  try {
    await page.evaluate(() => {
      window.__webx68kDebug.frameProbeReset();
      window.__webx68kDebug.frameProbeEnable(true);
    });
    if (busyWaitFault) {
      await page.evaluate(() => window.__webx68kDebug.frameProbeSetBusyWaitFault(true));
    }
    await page.waitForSelector('#btn-boot-system', { visible: true });
    const clickedAt = Date.now();
    const clickedAtMs = await page.evaluate(() => performance.now());
    await page.click('#btn-boot-system');
    let bootReached = true;
    let bootError = null;
    try {
      await waitForBootPrompt(page, config.bootTimeoutMs);
    } catch (error) {
      bootReached = false;
      bootError = error instanceof Error ? error.message : String(error);
    }
    const promptAt = Date.now();
    const promptAtMs = await page.evaluate(() => performance.now());
    // 起動完了後も観測窓ぶん定常状態(アイドルのHuman68kプロンプト)を観測し続ける。
    await sleep(config.durationMs);
    const frameProbeLog = await page.evaluate(() => window.__webx68kDebug.frameProbeRead());
    const ext = await readExternalObservers(page);
    await context.close();
    return {
      success: true,
      bootReached,
      bootError,
      bootDurationMs: bootReached ? promptAt - clickedAt : null,
      clickedAtMs,
      promptAtMs: bootReached ? promptAtMs : null,
      frameProbeLog,
      ext,
    };
  } catch (error) {
    await context.close();
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function bootPlainWithProbe(browser, config, probeEnabled) {
  const { context, page } = await newPage(browser, config);
  try {
    await page.evaluate((enabled) => {
      window.__webx68kDebug.frameProbeReset();
      window.__webx68kDebug.frameProbeEnable(enabled);
    }, probeEnabled);
    await page.waitForSelector('#btn-boot-system', { visible: true });
    await page.click('#btn-boot-system');
    let bootReached = true;
    try {
      await waitForBootPrompt(page, config.bootTimeoutMs);
    } catch {
      bootReached = false;
    }
    const promptAtMs = await page.evaluate(() => performance.now());
    // 起動時間はprobe on/offで大きくばらつく(wasmコンパイル等の外乱が支配的)ため、
    // costの比較対象にはしない。プロンプト到達後の定常状態の窓だけを比較する
    // (extRaf/extLongTasksはページ読込み直後から蓄積されているため、promptAtMs未満を捨てる)。
    await sleep(config.durationMs);
    const extAll = await readExternalObservers(page);
    const ext = {
      extRaf: extAll.extRaf.filter((t) => t >= promptAtMs),
      extLongTasks: extAll.extLongTasks.filter((t) => t.startAtMs >= promptAtMs),
    };
    const frameProbeLog = probeEnabled ? await page.evaluate(() => window.__webx68kDebug.frameProbeRead()) : null;
    await context.close();
    return { success: true, bootReached, ext, frameProbeLog };
  } catch (error) {
    await context.close();
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// --- main モード: 解像度別に分けたフレーム時間分布 ---

function resolutionKey(e) {
  return `${e.width}x${e.height}@${e.fps ?? '?'}`;
}

/**
 * steadyFromMs(起動プロンプト到達時刻、page内performance.now()epoch)以降だけを対象にする。
 * 未指定ならフィルタしない(=起動シーケンス中の重い処理も含めた全体像)。
 * 起動シーケンス中はROM/フォント読込み等の重い同期処理が乗り、定常状態の分布を大きく歪めるため、
 * 「main」モードの主指標は steady 側を使い、起動由来の外れ値は別枠で報告する。
 */
function analyzeFrameLog(log, steadyFromMs = null) {
  const filterByTime = (arr, keyFn) =>
    steadyFromMs === null ? arr : arr.filter((x) => keyFn(x) >= steadyFromMs);
  const runEvents = filterByTime(log.runEvents, (e) => e.runStartAtMs);
  const videoEvents = filterByTime(log.videoEvents, (e) => e.convertStartAtMs);
  const rafSamples = steadyFromMs === null ? log.rafSamples : log.rafSamples.filter((t) => t >= steadyFromMs);
  const longTasks = filterByTime(log.longTasks, (t) => t.startAtMs);
  const videoReal = videoEvents.filter((e) => !e.dupe);
  const dupeCount = videoEvents.length - videoReal.length;

  // 解像度別(width x height @ fps)の遷移順序(初出のframeIndexだけ)。
  const seen = new Set();
  const resolutionTransitions = [];
  for (const e of videoEvents) {
    const key = resolutionKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    resolutionTransitions.push({ key, firstFrameIndex: e.frameIndex, width: e.width, height: e.height, fps: e.fps });
  }

  const byResolution = {};
  for (const key of seen) {
    const events = videoReal.filter((e) => resolutionKey(e) === key);
    const convertMs = events.map((e) => e.convertEndAtMs - e.convertStartAtMs);
    const putMs = events.map((e) => e.putEndAtMs - e.putStartAtMs);
    const putEnds = events.map((e) => e.putEndAtMs);
    const canvasEndIntervalMs = diffs(putEnds);
    const fps = events[0]?.fps ?? null;
    const budgetMs = fps ? 1000 / fps : null;
    const overrunCount = budgetMs === null ? null : canvasEndIntervalMs.filter((v) => v > budgetMs).length;
    byResolution[key] = {
      sampleCount: events.length,
      fps,
      budgetMs: roundMs(budgetMs),
      convertMs: summarize(convertMs),
      putImageDataMs: summarize(putMs),
      canvasEndIntervalMs: summarize(canvasEndIntervalMs),
      budgetOverrunRatePercent:
        overrunCount === null || canvasEndIntervalMs.length === 0
          ? null
          : roundMs((overrunCount / canvasEndIntervalMs.length) * 100),
    };
  }

  const runEndTimes = runEvents.map((e) => e.runEndAtMs);
  const runCompletionIntervalMs = diffs(runEndTimes);
  const rafIntervalMs = diffs(rafSamples);
  const busyWaitCount = runEvents.filter((e) => e.busyWaitInjectedMs > 0).length;

  return {
    dupeFrameCount: dupeCount,
    realFrameCount: videoReal.length,
    resolutionTransitions,
    byResolution,
    runCompletionIntervalMs: summarize(runCompletionIntervalMs),
    internalRafIntervalMs: summarize(rafIntervalMs),
    longTaskCount: longTasks.length,
    longTaskDurationMs: summarize(longTasks.map((t) => t.durationMs)),
    busyWaitInjectedCount: busyWaitCount,
  };
}

async function runMain(browser, config) {
  const trial = await bootAndObserve(browser, config, { busyWaitFault: false });
  if (!trial.success || !trial.bootReached) {
    return { success: false, trial };
  }
  // 全体(起動シーケンス中の重い同期処理を含む)と、起動完了(プロンプト到達)後だけの定常状態を
  // 分けて出す。解像度遷移一覧は全体側から取る(起動中の遷移を含めるため)。
  const overall = analyzeFrameLog(trial.frameProbeLog);
  const steady = analyzeFrameLog(trial.frameProbeLog, trial.promptAtMs);
  const overallExtRaf = summarize(diffs(trial.ext.extRaf));
  const steadyExtRaf = summarize(diffs(trial.ext.extRaf.filter((t) => t >= trial.promptAtMs)));
  const steadyExtLongTasks = trial.ext.extLongTasks.filter((t) => t.startAtMs >= trial.promptAtMs);
  const durationSec = config.durationMs / 1000;
  const result = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    measurement:
      'フレーム時間の分布(main): resolutionTransitions/dupeFrameCount等は起動〜観測窓終了までの全体、' +
      'steadyはHuman68kプロンプト到達後(定常状態)だけに絞った値。',
    config,
    bootDurationMs: trial.bootDurationMs,
    resolutionTransitions: overall.resolutionTransitions,
    dupeFrameCount: overall.dupeFrameCount,
    realFrameCount: overall.realFrameCount,
    overall: {
      byResolution: overall.byResolution,
      runCompletionIntervalMs: overall.runCompletionIntervalMs,
      internalRafIntervalMs: overall.internalRafIntervalMs,
      externalRafIntervalMs: overallExtRaf,
      longTaskCount: overall.longTaskCount,
      longTaskDurationMs: overall.longTaskDurationMs,
    },
    steady: {
      byResolution: steady.byResolution,
      runCompletionIntervalMs: steady.runCompletionIntervalMs,
      internalRafIntervalMs: steady.internalRafIntervalMs,
      externalRafIntervalMs: steadyExtRaf,
      longTaskCount: steadyExtLongTasks.length,
      longTaskPerSec: roundMs(steadyExtLongTasks.length / durationSec),
      longTaskDurationMs: summarize(steadyExtLongTasks.map((t) => t.durationMs)),
    },
    limitations: [
      '実表示時刻は取得できないため、putImageData()復帰までを「canvas更新完了」として扱い、物理表示済みとは称さない。',
      '解像度別の比較は、起動シーケンス中に実際に発生した遷移の範囲でのみ取れる。X-BASICでの明示的な解像度切替は本計測では使っていない(docs参照)。',
      'この結果はframeProbe自体の計測点が乗った状態の値。計測点のコストは--mode=costで別途評価する。',
      'steadyのlongTaskCount/DurationMsは外部オラクル(page注入observer)由来。overallのlongTaskCount/DurationMsはframeProbe内蔵observer由来で、集計元が異なる(重複計上ではない)。',
    ],
  };
  return { success: true, result };
}

// --- cost モード: frameProbe on/off での外部オラクル比較 ---

async function runCost(browser, config) {
  const off = await bootPlainWithProbe(browser, config, false);
  const on = await bootPlainWithProbe(browser, config, true);
  if (!off.success || !on.success || !off.bootReached || !on.bootReached) {
    return { success: false, off, on };
  }
  const offRaf = summarize(diffs(off.ext.extRaf));
  const onRaf = summarize(diffs(on.ext.extRaf));
  const offLongTasks = off.ext.extLongTasks.length;
  const onLongTasks = on.ext.extLongTasks.length;
  const relDiffPercent = (a, b) => (a === null || b === null || a === 0 ? null : roundMs(((b - a) / a) * 100));

  const result = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    measurement:
      '計測点のコスト(cost): frameProbe無効/有効それぞれで起動完了後 durationMs のうち、' +
      'アプリ内蔵frameProbeとは独立な外部rAF/long task観測(evaluateOnNewDocumentで注入)を比較する。',
    config,
    probeDisabled: { extRafIntervalMs: offRaf, extLongTaskCount: offLongTasks },
    probeEnabled: { extRafIntervalMs: onRaf, extLongTaskCount: onLongTasks },
    medianIntervalDiffPercent: relDiffPercent(offRaf.medianMs, onRaf.medianMs),
    p95IntervalDiffPercent: relDiffPercent(offRaf.p95Ms, onRaf.p95Ms),
    note: 'medianIntervalDiffPercent > 0 は、probe有効時のほうがrAF間隔(=フレーム供給間隔)が伸びた=コストが乗ったことを意味する。',
  };
  return { success: true, result };
}

// --- fault モード: 陽性対照 + busy wait注入での測定系検証 ---

async function runFault(browser, config) {
  const positiveControl = await bootAndObserve(browser, config, { busyWaitFault: false });
  if (!positiveControl.success || !positiveControl.bootReached) {
    return { success: false, stage: 'positiveControl', trial: positiveControl };
  }
  // busy waitは定常状態(起動プロンプト到達後)だけで評価する。起動シーケンス中の
  // 重い同期処理と混ざると、注入由来の裾かどうかを切り分けられないため。
  const pcAnalysis = analyzeFrameLog(positiveControl.frameProbeLog, positiveControl.promptAtMs);
  const pcExtRaf = summarize(diffs(positiveControl.ext.extRaf.filter((t) => t >= positiveControl.promptAtMs)));

  const faulted = await bootAndObserve(browser, config, { busyWaitFault: true });
  if (!faulted.success || !faulted.bootReached) {
    return { success: false, stage: 'faulted', trial: faulted, positiveControl: { pcAnalysis, pcExtRaf } };
  }
  const faultAnalysis = analyzeFrameLog(faulted.frameProbeLog, faulted.promptAtMs);
  const faultExtRaf = summarize(diffs(faulted.ext.extRaf.filter((t) => t >= faulted.promptAtMs)));

  // busy wait(50ms)を注入したフレームが実際にあったか。
  const busyWaitInjectedCount = faultAnalysis.busyWaitInjectedCount;

  // 各指標に「裾が現れた」ことの判定: 故障注入試行のmax/p99が陽性対照のmax/p99を
  // 明確に上回っていること(busy waitの半分=25ms超の余分マージンを閾値にする)。
  const TAIL_MARGIN_MS = 25;
  const tailAppeared = (pc, fault) => {
    if (pc.maxMs === null || fault.maxMs === null) return null;
    return fault.maxMs - pc.maxMs > TAIL_MARGIN_MS || (fault.p99Ms ?? 0) - (pc.p99Ms ?? 0) > TAIL_MARGIN_MS;
  };

  const canvasEndIntervalTail = (() => {
    // 解像度別に出ているので、サンプル数最大の解像度(=定常状態の主解像度)を比較対象にする。
    const pickMain = (byRes) => {
      const keys = Object.keys(byRes);
      if (keys.length === 0) return null;
      keys.sort((a, b) => byRes[b].sampleCount - byRes[a].sampleCount);
      return byRes[keys[0]];
    };
    const pcMain = pickMain(pcAnalysis.byResolution);
    const faultMain = pickMain(faultAnalysis.byResolution);
    if (!pcMain || !faultMain) return { appeared: null, pc: pcMain, fault: faultMain };
    return {
      appeared: tailAppeared(pcMain.canvasEndIntervalMs, faultMain.canvasEndIntervalMs),
      pc: pcMain.canvasEndIntervalMs,
      fault: faultMain.canvasEndIntervalMs,
      pcBudgetOverrunRatePercent: pcMain.budgetOverrunRatePercent,
      faultBudgetOverrunRatePercent: faultMain.budgetOverrunRatePercent,
    };
  })();

  const indicators = {
    rafIntervalExternal: {
      appeared: tailAppeared(pcExtRaf, faultExtRaf),
      pc: pcExtRaf,
      fault: faultExtRaf,
    },
    canvasEndInterval: canvasEndIntervalTail,
    longTaskCount: {
      appeared: faultAnalysis.longTaskCount > pcAnalysis.longTaskCount,
      pc: pcAnalysis.longTaskCount,
      fault: faultAnalysis.longTaskCount,
    },
    budgetOverrunRate: {
      appeared:
        canvasEndIntervalTail.faultBudgetOverrunRatePercent !== null &&
        canvasEndIntervalTail.pcBudgetOverrunRatePercent !== null
          ? canvasEndIntervalTail.faultBudgetOverrunRatePercent > canvasEndIntervalTail.pcBudgetOverrunRatePercent
          : null,
    },
  };

  const allTailsAppeared = Object.values(indicators).every((v) => v.appeared === true);

  const result = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    measurement:
      '測定系の検証(fault): 60フレームごと50msのbusy waitを注入し、陽性対照(注入なし)と比較して' +
      'rAF間隔・canvas末端時間・long task・予算超過率のすべてに裾が現れることを確認する。',
    config,
    positiveControlBusyWaitInjectedCount: pcAnalysis.busyWaitInjectedCount,
    faultBusyWaitInjectedCount: busyWaitInjectedCount,
    indicators,
    allTailsAppeared,
  };
  return { success: true, result };
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
  try {
    server = await startServer(config.port);
    profile = await mkdtemp(join(tmpdir(), 'webx68k-measure-frametiming-'));
    browser = await puppeteer.launch({
      executablePath: config.executablePath,
      userDataDir: profile,
      headless: false,
      args: ['--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=1000,900'],
    });

    let outcome;
    if (config.mode === 'main') outcome = await runMain(browser, config);
    else if (config.mode === 'cost') outcome = await runCost(browser, config);
    else outcome = await runFault(browser, config);

    await mkdir(dirname(config.outputPath), { recursive: true });
    await writeFile(config.outputPath, `${JSON.stringify(outcome, null, 2)}\n`, 'utf8');
    console.log(`フレーム時間計測(${config.mode}): 出力 ${config.outputPath}`);
    console.log(JSON.stringify(outcome.result ?? outcome, null, 2).slice(0, 4000));

    if (!outcome.success) process.exitCode = 1;
    if (config.mode === 'fault' && outcome.success && !outcome.result.allTailsAppeared) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (profile) await rm(profile, { recursive: true, force: true });
    await stopServer(server);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
