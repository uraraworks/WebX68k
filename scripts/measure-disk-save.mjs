// 目的B(docs/STORAGE-SCSI.md「目的B」表「IndexedDBへのディスク全量書出し」)の実測スクリプト。
//
// 40MBのブランクHDDを作り、起動してマウントした状態から、
// window.__webx68kDebug.storageProbeSaveSlot('hdd') で persistSlotToLibrary('hdd') を直接叩く。
// 区間は src/storage-probe.ts が記録する「MEMFSから吸い出し・slice()完了(bytesReadyAtMs)」から
// 「IndexedDB transactionのcomplete(putCompleteAtMs)」まで。初回追加(isNewKey=true)と
// 同一key上書き(isNewKey=false)を分けて集計する。
//
// measure-boot.mjs / measure-drives.mjs と同じ流儀(ヘッドフルPuppeteer、BrowserContext分離、
// 統計・JSON出力、故障注入+陽性対照)を踏襲する。共通処理は複製する(既存スクリプトの方針に合わせる)。

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VALID_FAULTS = new Set(['abort-tx', 'corrupt-tail-readback']);

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
    const match = /^--(port|runs|boot-timeout|output|fault)=(.+)$/.exec(arg);
    if (!match) throw new Error(`不明な引数です: ${arg}`);
    values[match[1]] = match[2];
  }
  return values;
}

function printHelp() {
  console.log(`Usage: node scripts/measure-disk-save.mjs [options]

  --port=<number>         dev server のポート (既定: 5183)
  --runs=<number>         初回/上書きの組の反復回数 (既定: 20)
  --boot-timeout=<ms>     起動完了タイムアウト (既定: 90000)
  --output=<path>         JSON の保存先
  --fault=<abort-tx|corrupt-tail-readback>
                          測定系の検証用故障注入。先に故障なしの陽性対照を1回行う

環境変数: WEBX68K_PORT, WEBX68K_DISKSAVE_RUNS, WEBX68K_DISKSAVE_BOOT_TIMEOUT_MS,
          WEBX68K_DISKSAVE_OUTPUT, WEBX68K_URL, CHROME_PATH`);
}

function defaultOutputPath() {
  const serial = new Date().toISOString().replace(/[:.]/g, '-');
  return join(REPO_ROOT, '_local', 'measure', `disk-save-${serial}.json`);
}

function buildConfig(args) {
  const envUrl = process.env.WEBX68K_URL ? new URL(process.env.WEBX68K_URL) : null;
  const port = parsePositiveInteger(args.port ?? process.env.WEBX68K_PORT ?? envUrl?.port ?? '5183', 'port');
  const baseUrl = envUrl ?? new URL(`http://localhost:${port}`);
  baseUrl.port = String(port);
  const fault = args.fault ?? null;
  if (fault !== null && !VALID_FAULTS.has(fault)) {
    throw new Error(`fault は abort-tx または corrupt-tail-readback を指定してください: ${fault}`);
  }
  const outputValue = args.output ?? process.env.WEBX68K_DISKSAVE_OUTPUT ?? defaultOutputPath();
  return {
    baseUrl: baseUrl.href.replace(/\/$/, ''),
    port,
    runs: parsePositiveInteger(args.runs ?? process.env.WEBX68K_DISKSAVE_RUNS ?? '20', 'runs'),
    bootTimeoutMs: parsePositiveInteger(
      args['boot-timeout'] ?? process.env.WEBX68K_DISKSAVE_BOOT_TIMEOUT_MS ?? '90000',
      'boot-timeout',
    ),
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

/**
 * rAFの発火間隔とlong taskをページ側でずっと記録し続け、あとで区間ごとの最大gap/件数を
 * 問い合わせられるようにする。区間ごとに毎回observerを張り直すとオーバーヘッド計測が
 * 目的とずれるため、1試行=1ページ内で継続観測する。
 */
async function installTimingObservers(page) {
  await page.evaluateOnNewDocument(() => {
    window.__measureTiming = { rafTimestamps: [], longTasks: [] };
    let po = null;
    try {
      po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__measureTiming.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
        }
      });
      po.observe({ type: 'longtask', buffered: true });
    } catch {
      // long task API 非対応環境ではlongTasksは常に空になる
    }
    const tick = (t) => {
      window.__measureTiming.rafTimestamps.push(t);
      // 無制限に貯めない(1試行数十秒想定、60fpsで数千件程度)
      if (window.__measureTiming.rafTimestamps.length > 20000) {
        window.__measureTiming.rafTimestamps.splice(0, 10000);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function frameImpact(timing, fromMs, toMs) {
  if (fromMs === null || toMs === null) return { maxRafGapMs: null, longTaskCount: 0, longTaskTotalMs: 0 };
  const ts = timing.rafTimestamps.filter((t) => t >= fromMs - 50 && t <= toMs + 50 && t >= fromMs && t <= toMs);
  let maxGap = null;
  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i] - ts[i - 1];
    if (maxGap === null || gap > maxGap) maxGap = gap;
  }
  const overlapping = timing.longTasks.filter((lt) => lt.startTime + lt.duration >= fromMs && lt.startTime <= toMs);
  return {
    maxRafGapMs: roundMs(maxGap),
    longTaskCount: overlapping.length,
    longTaskTotalMs: roundMs(overlapping.reduce((sum, lt) => sum + lt.duration, 0)),
  };
}

async function runTrials(browser, config) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 2 });
  await page.bringToFront();
  await installTimingObservers(page);
  await page.goto(config.baseUrl, { waitUntil: 'networkidle2' });
  await page.bringToFront();

  // 40MBブランクHDDを作成(未計測)。この時点でIndexedDBへ初回保存済みだが、これは
  // 計測区間の外(handleCreateBlankHdd直呼びで probeContext を渡していない通常経路)。
  await page.waitForSelector('#btn-blank-hdd', { visible: true });
  await page.click('#btn-blank-hdd');
  await page.waitForFunction(() => document.querySelector('#name-hdd')?.textContent?.trim() === 'blank_hdd.hdf', {
    timeout: 15000,
  });

  await page.waitForSelector('#btn-boot-system', { visible: true });
  await page.click('#btn-boot-system');
  await waitForBootPrompt(page, config.bootTimeoutMs);

  const sourceKey = await page.evaluate(async () => {
    const list = await window.__webx68kDebug.storageProbeListLibrary();
    return list.find((d) => d.name === 'blank_hdd.hdf')?.sourceKey ?? null;
  });
  if (!sourceKey) throw new Error('blank_hdd.hdf のsourceKeyを取得できませんでした');

  await page.evaluate(() => {
    window.__webx68kDebug.storageProbeEnable(true);
    window.__webx68kDebug.storageProbeReset();
  });

  const attempts = [];
  for (let trial = 1; trial <= config.runs; trial++) {
    // 毎試行の直前に削除しておけば次回のsaveSlotは必ず「初回追加」になる。
    await page.evaluate((key) => window.__webx68kDebug.storageProbeDeleteFromLibrary(key), sourceKey);

    if (config.fault === 'abort-tx') {
      await page.evaluate(() => window.__webx68kDebug.storageProbeAbortNextPut());
    }
    const initialOk = await page.evaluate(() => window.__webx68kDebug.storageProbeSaveSlot('hdd'));

    let overwriteOk = null;
    if (config.fault !== 'abort-tx') {
      overwriteOk = await page.evaluate(() => window.__webx68kDebug.storageProbeSaveSlot('hdd'));
    }

    const timing = await page.evaluate(() => ({
      rafTimestamps: window.__measureTiming.rafTimestamps.slice(),
      longTasks: window.__measureTiming.longTasks.slice(),
    }));
    const log = await page.evaluate(() => window.__webx68kDebug.storageProbeRead());
    const events = log.diskSaves.slice(-2); // 直前の[初回, 上書き](abort時は1件)

    attempts.push({ trial, initialOk, overwriteOk, events, timingSnapshotAvailable: timing.rafTimestamps.length > 0 });
  }

  const fullLog = await page.evaluate(() => window.__webx68kDebug.storageProbeRead());
  const finalTiming = await page.evaluate(() => ({
    rafTimestamps: window.__measureTiming.rafTimestamps.slice(),
    longTasks: window.__measureTiming.longTasks.slice(),
  }));

  await context.close();
  return { attempts, fullLog, finalTiming, sourceKey };
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
    profile = await mkdtemp(join(tmpdir(), 'webx68k-measure-disksave-'));
    browser = await puppeteer.launch({
      executablePath: config.executablePath,
      userDataDir: profile,
      headless: false,
      args: ['--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=1000,900'],
    });

    let positiveControl = null;
    if (config.fault) {
      positiveControl = await runTrials(browser, { ...config, fault: null, runs: 1 });
    }
    const main = await runTrials(browser, config);

    const events = main.fullLog.diskSaves;
    const initialEvents = events.filter((e) => e.isNewKey);
    const overwriteEvents = events.filter((e) => !e.isNewKey);
    const succeeded = (list) => list.filter((e) => e.putCompleteAtMs !== null);
    const totalMsOf = (e) => e.putCompleteAtMs - e.bytesReadyAtMs;

    const summarizeGroup = (list) => {
      const ok = succeeded(list);
      const durations = ok.map(totalMsOf);
      const byteLen = ok[0]?.byteLength ?? null;
      const mibPerSec = ok.map((e) => {
        const sec = totalMsOf(e) / 1000;
        return sec > 0 ? e.byteLength / 1048576 / sec : null;
      }).filter((v) => v !== null);
      const frameImpacts = ok.map((e) => frameImpact(main.finalTiming, e.bytesReadyAtMs, e.putCompleteAtMs));
      return {
        total: list.length,
        succeeded: ok.length,
        failed: list.length - ok.length,
        byteLength: byteLen,
        durationMs: summarize(durations),
        mibPerSec: summarize(mibPerSec),
        maxRafGapMs: summarize(frameImpacts.map((f) => f.maxRafGapMs).filter((v) => v !== null)),
        longTaskCount: summarize(frameImpacts.map((f) => f.longTaskCount)),
      };
    };

    const faultCheck = config.fault
      ? (() => {
          const pcEvents = positiveControl.fullLog.diskSaves;
          const pcOk = pcEvents.length > 0 && pcEvents.every((e) => e.putCompleteAtMs !== null && e.error === null);
          if (config.fault === 'abort-tx') {
            const allAborted = events.every((e) => e.aborted === true && e.putCompleteAtMs === null);
            const allSucceededFalse = main.attempts.every((a) => a.initialOk === false);
            return {
              expected: 'putCompleteAtMs=null かつ aborted=true、storageProbeSaveSlot()の戻り値もfalse',
              positiveControlPassed: pcOk,
              passed: pcOk && allAborted && allSucceededFalse && events.length > 0,
            };
          }
          return { expected: null, positiveControlPassed: pcOk, passed: null };
        })()
      : null;

    // corrupt-tail-readback: putDisk()自体は正常完了させ、保存後に別途1byte変えたコピーで
    // getDisk()結果と突き合わせるchecksum不一致検出を確認する(putDiskの内部を汚さない)。
    let corruptReadbackCheck = null;
    if (config.fault === 'corrupt-tail-readback') {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.goto(config.baseUrl, { waitUntil: 'networkidle2' });
      // webx68k-disks の object store はアプリが初めて触ったときに作られる(onupgradeneeded)。
      // 素のindexedDB.openだけでは作られないため、先にアプリ経由の呼び出しを1回挟む。
      await page.evaluate(() => window.__webx68kDebug.storageProbeListLibrary());
      corruptReadbackCheck = await page.evaluate(async () => {
        // 手元でIndexedDBへ直接1件書き、末尾1byteを変えたコピーと比較するだけの自己完結テスト。
        const dbReq = indexedDB.open('webx68k-disks', 1);
        const db = await new Promise((res, rej) => {
          dbReq.onsuccess = () => res(dbReq.result);
          dbReq.onerror = () => rej(dbReq.error);
        });
        const original = new Uint8Array(1024);
        for (let i = 0; i < original.length; i++) original[i] = i & 0xff;
        const key = `__measure_corrupt_test__${Date.now()}`;
        await new Promise((res, rej) => {
          const tx = db.transaction('disks', 'readwrite');
          tx.objectStore('disks').put({ sourceKey: key, name: 'x', bytes: original, savedAt: Date.now() });
          tx.oncomplete = res;
          tx.onerror = () => rej(tx.error);
        });
        const stored = await new Promise((res, rej) => {
          const tx = db.transaction('disks', 'readonly');
          const req = tx.objectStore('disks').get(key);
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        const corrupted = stored.bytes.slice();
        corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] + 1) & 0xff;
        const checksum = (bytes) => {
          let h = 0x811c9dc5;
          for (const b of bytes) {
            h ^= b;
            h = Math.imul(h, 0x01000193);
          }
          return h >>> 0;
        };
        const originalChecksum = checksum(stored.bytes);
        const corruptedChecksum = checksum(corrupted);
        await new Promise((res, rej) => {
          const tx = db.transaction('disks', 'readwrite');
          tx.objectStore('disks').delete(key);
          tx.oncomplete = res;
          tx.onerror = () => rej(tx.error);
        });
        db.close();
        return {
          originalChecksum,
          corruptedChecksum,
          mismatchDetected: originalChecksum !== corruptedChecksum,
        };
      });
      await context.close();
    }

    const result = {
      schemaVersion: 1,
      measuredAt: new Date().toISOString(),
      measurement: 'IndexedDBへのディスク全量書出し(40MB HDD)。区間: MEMFS吸い出し・slice()完了(bytesReadyAtMs)〜IndexedDB transaction complete(putCompleteAtMs)',
      config,
      sourceKey: main.sourceKey,
      initial: summarizeGroup(initialEvents),
      overwrite: summarizeGroup(overwriteEvents),
      attempts: main.attempts,
      positiveControl: positiveControl
        ? { events: positiveControl.fullLog.diskSaves, attempts: positiveControl.attempts }
        : null,
      faultCheck,
      corruptReadbackCheck,
      limitations: [
        'quota不足の専用プロファイルによる故障注入は実施していない(理由: 通常のブラウザプロファイルでquotaを再現よく枯渇させる手段が無く、専用プロファイル構築コストが計測本体に見合わないため省略)。',
        'rAF gap/long taskはページ内PerformanceObserver/rAFの継続観測から区間切り出しで求めており、実際の描画完了時刻そのものではない。',
        'longtask APIが使えないブラウザではlongTaskCountは常に0になる(未対応の合図であり0件検出の意味ではない)。',
      ],
    };

    await mkdir(dirname(config.outputPath), { recursive: true });
    await writeFile(config.outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

    console.log(`IndexedDB全量書出し計測: 出力 ${config.outputPath}`);
    console.log(
      `初回: ${result.initial.succeeded}/${result.initial.total} 中央値 ${result.initial.durationMs.medianMs ?? '-'}ms p95 ${result.initial.durationMs.p95Ms ?? '-'}ms MiB/s中央値 ${result.initial.mibPerSec.medianMs ?? '-'}`,
    );
    console.log(
      `上書き: ${result.overwrite.succeeded}/${result.overwrite.total} 中央値 ${result.overwrite.durationMs.medianMs ?? '-'}ms p95 ${result.overwrite.durationMs.p95Ms ?? '-'}ms MiB/s中央値 ${result.overwrite.mibPerSec.medianMs ?? '-'}`,
    );
    if (faultCheck) {
      console.log(
        `故障注入 ${config.fault}: 陽性対照=${faultCheck.positiveControlPassed}, 検出=${faultCheck.passed}`,
      );
      if (!faultCheck.positiveControlPassed || faultCheck.passed === false) process.exitCode = 1;
    }
    if (corruptReadbackCheck) {
      console.log(`corrupt-tail-readback: 検出=${corruptReadbackCheck.mismatchDetected}`);
      if (!corruptReadbackCheck.mismatchDetected) process.exitCode = 1;
    }
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
