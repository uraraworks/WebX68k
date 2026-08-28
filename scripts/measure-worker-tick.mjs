// `?worker=1` 起動の「コア稼働後〜プロンプト安定」区間が既定経路より大幅に遅い実測
// (docs/STORAGE-SCSI.md参照。同一ビルドで既定9,688ms→Worker40,841ms、約4.2倍)を切り分ける
// ための計測専用スクリプト。src/core-worker.ts に追加した workerTickProbe (DEV限定・既定off)
// を起動前に有効化し、起動中(遅い区間そのもの)のtick内訳を丸ごと採取する。
//
// dev サーバー(vite dev。import.meta.env.DEV が true になる唯一のモード。prodビルドでは
// probeのコードごと消える)+ 実Chrome(ヘッドフル)で駆動する。measure-boot.mjs /
// measure-frame-timing.mjs と同じ流儀(BrowserContext分離、故障注入+陽性対照、統計・JSON出力)
// を踏襲するが、共通処理は複製する(measure-frame-timing.mjsの前例と同じ方針)。
//
// 使い方:
//   node scripts/measure-worker-tick.mjs --target=worker --runs=3
//   node scripts/measure-worker-tick.mjs --target=default --runs=3
//   node scripts/measure-worker-tick.mjs --target=worker --cost-check   (プローブ自体のコスト)
//   node scripts/measure-worker-tick.mjs --target=worker --fault-check  (故障注入による検証)

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const roundMs = (v) => (v === null || v === undefined ? null : Math.round(v * 1000) / 1000);

// タブ非アクティブ扱いによるスロットリングで「対象でない理由」の遅延を踏まないため必須
// (docs/STORAGE-SCSI.md参照。今日実際に踏んだ)。
const CHROME_FOREGROUND_ARGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
];

function parseArgs(argv) {
  const v = {};
  for (const a of argv) {
    if (a === '--help') {
      v.help = true;
      continue;
    }
    if (a === '--cost-check') {
      v.costCheck = true;
      continue;
    }
    if (a === '--reverse') {
      v.reverse = true;
      v.costCheck = true;
      continue;
    }
    if (a === '--fault-check') {
      v.faultCheck = true;
      continue;
    }
    const m = /^--(target|port|runs|boot-timeout|output)=(.+)$/.exec(a);
    if (!m) throw new Error(`不明な引数です: ${a}`);
    v[m[1]] = m[2];
  }
  return v;
}

function printHelp() {
  console.log(`Usage: node scripts/measure-worker-tick.mjs [options]

  --target=<worker|default>  計測対象 (既定: worker)
  --port=<number>            dev server のポート (既定: 5196)
  --runs=<number>            通常計測の反復回数 (既定: 3)
  --boot-timeout=<ms>        起動完了タイムアウト (既定: 90000)
  --output=<path>            JSON の保存先
  --cost-check               プローブ有効/無効での起動時間を比較する(コスト測定)
  --fault-check              故障注入(固定busy wait)で内訳が正しく検出できるか検証する
`);
}

function defaultOutputPath(target, suffix) {
  const serial = new Date().toISOString().replace(/[:.]/g, '-');
  return join(REPO_ROOT, '_local', 'measure', `worker-tick-${target}${suffix ? `-${suffix}` : ''}-${serial}.json`);
}

async function startServer(port) {
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
  let ready = false;
  let startupOutput = '';
  const inspect = (buf) => {
    const s = buf.toString();
    startupOutput += s;
    if (/ready in|Local:\s+http/.test(s)) ready = true;
  };
  child.stdout.on('data', inspect);
  child.stderr.on('data', inspect);
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
  const idx = (sorted.length - 1) * fraction;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summarize(samples) {
  if (samples.length === 0) return { medianMs: null, p95Ms: null, minMs: null, maxMs: null, n: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    minMs: sorted[0],
    maxMs: sorted.at(-1),
    n: sorted.length,
  };
}

/**
 * ページ内で `A>` プロンプトの安定を待つ。measure-boot.mjs の observeBoot() と同じ判定条件
 * (`A>` + 最大1文字の行を3回連続)だが、こちらは高精度な区間計測を目的としないため、
 * Node側からポーリングする単純な形にしてある。
 */
async function waitForPromptStable(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let stableCount = 0;
  let lastDump = null;
  while (Date.now() < deadline) {
    const dump = await page.evaluate(async () => {
      try {
        return (await window.__webx68kDebug?.screenText?.()) ?? null;
      } catch {
        return null;
      }
    });
    lastDump = dump;
    // readTextScreen() は TextScreenDump ({ available, lines, diagnostics }) を返す
    // (単純な文字列ではない。src/text-screen.ts参照。measure-boot.mjsのobserveBoot()と同じ判定)。
    if (dump?.available && Array.isArray(dump.lines)) {
      const nonEmptyLines = dump.lines.filter((line) => line.length > 0);
      const lastAPromptLine = nonEmptyLines.filter((line) => line.startsWith('A>')).at(-1) ?? null;
      const remainderLen = lastAPromptLine === null ? Infinity : Array.from(lastAPromptLine.slice(2)).length;
      if (lastAPromptLine !== null && remainderLen <= 1) {
        stableCount++;
        if (stableCount >= 3) return { stable: true, text: lastDump };
      } else {
        stableCount = 0;
      }
    } else {
      stableCount = 0;
    }
    await sleep(150);
  }
  return { stable: false, text: lastDump };
}

async function bootAndCollect(browser, config, { probeEnabled, busyWaitFault }) {
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 1 });
    await page.bringToFront();

    const url = new URL(config.baseUrl);
    url.searchParams.set('system', '1');
    url.searchParams.set('run', '1');
    if (config.target === 'worker') url.searchParams.set('worker', '1');

    const bootStartAtMs = Date.now();
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await page.waitForFunction(
      () =>
        typeof window.__webx68kDebug?.workerTickProbeEnable === 'function' &&
        typeof window.__webx68kDebug?.frameProbeEnable === 'function',
      { timeout: 20000 },
    );

    // 起動(bootWorkerCore/bootCore)が実際に走り出す前にプローブを立てる。BIOSフェッチ等で
    // 起動には数秒かかるため、ここでのenableは十分間に合う(main.tsのworkerTickProbeWanted参照)。
    if (config.target === 'worker') {
      await page.evaluate(() => window.__webx68kDebug.workerTickProbeReset());
      await page.evaluate((en) => window.__webx68kDebug.workerTickProbeEnable(en), probeEnabled);
      await page.evaluate((f) => window.__webx68kDebug.workerTickProbeSetBusyWaitFault(f), busyWaitFault);
    } else {
      await page.evaluate(() => window.__webx68kDebug.frameProbeReset());
      await page.evaluate((en) => window.__webx68kDebug.frameProbeEnable(en), probeEnabled);
      await page.evaluate((f) => window.__webx68kDebug.frameProbeSetBusyWaitFault(f), busyWaitFault);
    }

    const { stable, text } = await waitForPromptStable(page, config.bootTimeoutMs);
    const bootEndAtMs = Date.now();
    const bootDurationMs = bootEndAtMs - bootStartAtMs;

    let tickEvents = null;
    let frameProbeData = null;
    if (config.target === 'worker') {
      tickEvents = await page.evaluate(() => window.__webx68kDebug.workerTickProbeRead());
    } else {
      frameProbeData = await page.evaluate(() => window.__webx68kDebug.frameProbeRead());
    }

    return { success: stable, bootDurationMs, lastScreenText: text, tickEvents, frameProbeData };
  } finally {
    await context.close();
  }
}

function analyzeWorkerTicks(events) {
  if (!events || events.length === 0) return null;
  const ranFramesCounts = {};
  for (const e of events) {
    ranFramesCounts[e.ranFrames] = (ranFramesCounts[e.ranFrames] ?? 0) + 1;
  }
  const runTotals = events.map((e) => e.runTotalMs).filter((v) => Number.isFinite(v));
  const convertTimes = events.map((e) => e.convertMs).filter((v) => v !== null && Number.isFinite(v));
  const postTimes = events.map((e) => e.postMs).filter((v) => v !== null && Number.isFinite(v));
  const sinceLastTick = events.map((e) => e.sinceLastTickMs).filter((v) => Number.isFinite(v));
  const totalFrames = events.reduce((sum, e) => sum + e.ranFrames, 0);
  const totalWallMs = events.reduce((sum, e) => sum + e.sinceLastTickMs, 0);
  const effectiveFps = totalWallMs > 0 ? (totalFrames / totalWallMs) * 1000 : null;

  // 時間帯ごとの推移: イベント配列を4分割し、それぞれの区間で有効fpsを再計算する。
  const quarterCount = 4;
  const quarterSize = Math.ceil(events.length / quarterCount);
  const timeline = [];
  let cursorMs = 0;
  for (let i = 0; i < events.length; i += quarterSize) {
    const chunk = events.slice(i, i + quarterSize);
    const chunkWallMs = chunk.reduce((s, e) => s + e.sinceLastTickMs, 0);
    const chunkFrames = chunk.reduce((s, e) => s + e.ranFrames, 0);
    timeline.push({
      tickRange: [i, Math.min(i + quarterSize, events.length) - 1],
      wallStartMs: roundMs(cursorMs),
      wallEndMs: roundMs(cursorMs + chunkWallMs),
      ranFrames: chunkFrames,
      effectiveFps: chunkWallMs > 0 ? roundMs((chunkFrames / chunkWallMs) * 1000) : null,
      runTotalMsSum: roundMs(chunk.reduce((s, e) => s + e.runTotalMs, 0)),
      convertMsSum: roundMs(chunk.reduce((s, e) => s + (e.convertMs ?? 0), 0)),
      postMsSum: roundMs(chunk.reduce((s, e) => s + (e.postMs ?? 0), 0)),
    });
    cursorMs += chunkWallMs;
  }

  // 最大の停滞tick上位20件(内訳の何がその停滞を占めているかを見るため)。
  const topStalls = [...events]
    .sort((a, b) => b.sinceLastTickMs - a.sinceLastTickMs)
    .slice(0, 20)
    .map((e) => ({
      tickIndex: e.tickIndex,
      sinceLastTickMs: roundMs(e.sinceLastTickMs),
      ranFrames: e.ranFrames,
      runTotalMs: roundMs(e.runTotalMs),
      convertMs: roundMs(e.convertMs),
      postMs: roundMs(e.postMs),
      busyWaitInjectedMs: e.busyWaitInjectedMs,
    }));

  return {
    tickCount: events.length,
    totalFrames,
    totalWallMs: roundMs(totalWallMs),
    effectiveFps: roundMs(effectiveFps),
    ranFramesHistogram: ranFramesCounts,
    topStalls,
    sinceLastTickMs: summarize(sinceLastTick),
    runTotalMs: summarize(runTotals),
    convertMs: summarize(convertTimes),
    postMs: summarize(postTimes),
    timeline,
  };
}

function analyzeFrameProbe(data) {
  if (!data || !data.runEvents || data.runEvents.length === 0) return null;
  const events = data.runEvents;
  const first = events[0].runStartAtMs;
  const last = events.at(-1).runEndAtMs;
  const totalWallMs = last - first;
  const effectiveFps = totalWallMs > 0 ? (events.length / totalWallMs) * 1000 : null;
  const runDurations = events.map((e) => e.runEndAtMs - e.runStartAtMs);
  return {
    frameCount: events.length,
    totalWallMs: roundMs(totalWallMs),
    effectiveFps: roundMs(effectiveFps),
    runDurationMs: summarize(runDurations),
    fps: data.fps,
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const target = args.target === 'default' ? 'default' : 'worker';
  const port = Number(args.port ?? 5196);
  const bootTimeoutMs = Number(args['boot-timeout'] ?? 90000);
  const runs = Number(args.runs ?? 3);
  const baseUrl = `http://localhost:${port}`;
  const config = { baseUrl, target, bootTimeoutMs };

  let server;
  let browser;
  let profile;
  try {
    server = await startServer(port);
    profile = await mkdtemp(join(tmpdir(), 'webx68k-measure-worker-tick-'));
    browser = await puppeteer.launch({
      executablePath: process.env.CHROME_PATH ?? DEFAULT_CHROME,
      userDataDir: profile,
      headless: false,
      args: ['--hide-scrollbars', '--window-size=1000,900', ...CHROME_FOREGROUND_ARGS],
    });

    const output = { schemaVersion: 1, measuredAt: new Date().toISOString(), target, mode: null, trials: [] };

    if (args.costCheck) {
      output.mode = 'cost-check';
      // 実測(1回目): 順序を変えると符号ごと反転する巨大な差(devサーバーのモジュール変換
      // キャッシュが「そのポートで最初に開いたページ」だけコールドスタートするための一時的
      // コスト)が出た。これはプローブのコストではなく実行順そのものの効果なので、
      // 交互に複数回実行し、各変種内の中央値(1回目のコールドスタート分は残るが両変種に
      // 同程度乗るはずなので、trial1を除いた分布で比較する)で見る。
      const trialsPerVariant = Number(args.runs ?? 3);
      const withProbeSamples = [];
      const withoutProbeSamples = [];
      for (let i = 0; i < trialsPerVariant; i++) {
        // 交互に実行(withProbeが先/後どちらかに固定されないようにする)。
        const probeFirst = i % 2 === 0;
        const a = await bootAndCollect(browser, config, { probeEnabled: probeFirst, busyWaitFault: false });
        const b = await bootAndCollect(browser, config, { probeEnabled: !probeFirst, busyWaitFault: false });
        withProbeSamples.push(probeFirst ? a.bootDurationMs : b.bootDurationMs);
        withoutProbeSamples.push(probeFirst ? b.bootDurationMs : a.bootDurationMs);
      }
      output.costCheck = {
        trialsPerVariant,
        withProbeSamplesMs: withProbeSamples,
        withoutProbeSamplesMs: withoutProbeSamples,
        withProbe: summarize(withProbeSamples),
        withoutProbe: summarize(withoutProbeSamples),
        // 1回目(このプロセスで最初に開いたページ)はコールドスタートの影響が残るため除いた中央値。
        withProbeExcludingFirst: summarize(withProbeSamples.slice(1)),
        withoutProbeExcludingFirst: summarize(withoutProbeSamples.slice(1)),
      };
      console.log(JSON.stringify(output.costCheck, null, 2));
    } else if (args.faultCheck) {
      output.mode = 'fault-check';
      const positiveControl = await bootAndCollect(browser, config, { probeEnabled: false, busyWaitFault: false });
      const withFault = await bootAndCollect(browser, config, { probeEnabled: true, busyWaitFault: true });
      const analysis = target === 'worker' ? analyzeWorkerTicks(withFault.tickEvents) : analyzeFrameProbe(withFault.frameProbeData);
      const injectedCount =
        target === 'worker'
          ? (withFault.tickEvents ?? []).filter((e) => e.busyWaitInjectedMs > 0).length
          : null;
      output.faultCheck = {
        positiveControlSuccess: positiveControl.success,
        withFaultSuccess: withFault.success,
        injectedCount,
        analysis,
      };
      console.log(
        JSON.stringify(
          { positiveControlSuccess: positiveControl.success, withFaultSuccess: withFault.success, injectedCount, effectiveFps: analysis?.effectiveFps },
          null,
          2,
        ),
      );
    } else {
      output.mode = 'main';
      for (let trial = 1; trial <= runs; trial++) {
        const result = await bootAndCollect(browser, config, { probeEnabled: true, busyWaitFault: false });
        const analysis = target === 'worker' ? analyzeWorkerTicks(result.tickEvents) : analyzeFrameProbe(result.frameProbeData);
        output.trials.push({
          trial,
          success: result.success,
          bootDurationMs: result.bootDurationMs,
          analysis,
        });
        console.log(
          `試行${trial}: success=${result.success} bootDurationMs=${result.bootDurationMs} effectiveFps=${analysis?.effectiveFps}`,
        );
      }
    }

    const outputPath = args.output
      ? isAbsolute(args.output)
        ? args.output
        : resolve(REPO_ROOT, args.output)
      : defaultOutputPath(target, args.costCheck ? 'cost' : args.faultCheck ? 'fault' : 'main');
    await mkdir(join(outputPath, '..'), { recursive: true });
    await writeFile(outputPath, JSON.stringify(output, null, 2));
    console.log(`保存先: ${outputPath}`);
  } finally {
    if (browser) await browser.close();
    if (profile) await rm(profile, { recursive: true, force: true });
    await stopServer(server);
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
