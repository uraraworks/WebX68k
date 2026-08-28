// 目的B(docs/STORAGE-SCSI.md「目的B」表「起動時のRAM展開」)の実測スクリプト。
//
// ROM(IPLROM/CGROM。既定は同梱ROMのnetwork fetch)、FDD1(1.23MB、ライブラリ=IndexedDB経由)、
// HDD(40MB、同じくライブラリ経由)を対象に、
//   - IndexedDB get要求から全bytes取得まで(FDD1/HDDのみ。ROMは既定でIndexedDBを経由しないため対象外)
//   - Uint8Array準備からMEMFS writeFile完了・サイズ/末尾/checksum確認まで
// の2区間を src/storage-probe.ts のフック経由で実測する。
//
// measure-boot.mjs / measure-drives.mjs と同じ流儀(ヘッドフルPuppeteer、BrowserContext分離、
// 統計・JSON出力、故障注入+陽性対照)を踏襲する。共通処理は複製する(既存スクリプトの方針)。

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VALID_FAULTS = new Set(['skip-write', 'truncate-tail', 'corrupt-checksum']);

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
  console.log(`Usage: node scripts/measure-ram-expansion.mjs [options]

  --port=<number>         dev server のポート (既定: 5183)
  --runs=<number>         反復回数 (既定: 20)
  --boot-timeout=<ms>     起動完了タイムアウト (既定: 90000)
  --output=<path>         JSON の保存先
  --fault=<skip-write|truncate-tail|corrupt-checksum>
                          測定系の検証用故障注入。先に故障なしの陽性対照を1回行う

環境変数: WEBX68K_PORT, WEBX68K_RAMEXPANSION_RUNS, WEBX68K_RAMEXPANSION_BOOT_TIMEOUT_MS,
          WEBX68K_RAMEXPANSION_OUTPUT, WEBX68K_URL, CHROME_PATH`);
}

function defaultOutputPath() {
  const serial = new Date().toISOString().replace(/[:.]/g, '-');
  return join(REPO_ROOT, '_local', 'measure', `ram-expansion-${serial}.json`);
}

function buildConfig(args) {
  const envUrl = process.env.WEBX68K_URL ? new URL(process.env.WEBX68K_URL) : null;
  const port = parsePositiveInteger(args.port ?? process.env.WEBX68K_PORT ?? envUrl?.port ?? '5183', 'port');
  const baseUrl = envUrl ?? new URL(`http://localhost:${port}`);
  baseUrl.port = String(port);
  const fault = args.fault ?? null;
  if (fault !== null && !VALID_FAULTS.has(fault)) {
    throw new Error(`fault は skip-write, truncate-tail, corrupt-checksum のいずれかで指定してください: ${fault}`);
  }
  const outputValue = args.output ?? process.env.WEBX68K_RAMEXPANSION_OUTPUT ?? defaultOutputPath();
  return {
    baseUrl: baseUrl.href.replace(/\/$/, ''),
    port,
    runs: parsePositiveInteger(args.runs ?? process.env.WEBX68K_RAMEXPANSION_RUNS ?? '20', 'runs'),
    bootTimeoutMs: parsePositiveInteger(
      args['boot-timeout'] ?? process.env.WEBX68K_RAMEXPANSION_BOOT_TIMEOUT_MS ?? '90000',
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

/** FDD1(1.23MB)とHDD(40MB)のブランクを作り、ライブラリのsourceKeyを返す(未計測区間)。 */
async function prepareLibraryFixtures(page) {
  await page.waitForSelector('#btn-blank-fdd1', { visible: true });
  await page.click('#btn-blank-fdd1');
  await page.waitForFunction(
    () => document.querySelector('#name-fdd1')?.textContent?.trim() === 'blank_2hd1232.xdf',
    { timeout: 15000 },
  );
  await page.waitForSelector('#btn-blank-hdd', { visible: true });
  await page.click('#btn-blank-hdd');
  await page.waitForFunction(() => document.querySelector('#name-hdd')?.textContent?.trim() === 'blank_hdd.hdf', {
    timeout: 15000,
  });

  const keys = await page.evaluate(async () => {
    const list = await window.__webx68kDebug.storageProbeListLibrary();
    return {
      fdd1: list.find((d) => d.name === 'blank_2hd1232.xdf')?.sourceKey ?? null,
      hdd: list.find((d) => d.name === 'blank_hdd.hdf')?.sourceKey ?? null,
    };
  });
  if (!keys.fdd1 || !keys.hdd) throw new Error('ブランクディスクのsourceKeyを取得できませんでした');

  // 「メモリに載ったまま」状態を払い落とし、次のstorageProbeLoadFromLibraryで
  // 必ずgetDisk()経由の読み込みになるようにする。
  await page.evaluate(() => {
    window.__webx68kDebug.storageProbeEjectSlot('fdd1');
    window.__webx68kDebug.storageProbeEjectSlot('hdd');
  });
  return keys;
}

async function peakHeapMiB(page) {
  return page.evaluate(() => {
    const mem = performance.memory;
    return mem ? mem.usedJSHeapSize / 1048576 : null;
  });
}

async function measureMainTrial(browser, config, trial) {
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 2 });
    await page.bringToFront();
    await page.goto(config.baseUrl, { waitUntil: 'networkidle2' });
    await page.bringToFront();

    const keys = await prepareLibraryFixtures(page);
    await page.evaluate(() => {
      window.__webx68kDebug.storageProbeEnable(true);
      window.__webx68kDebug.storageProbeReset();
    });

    const heapBeforeMiB = await peakHeapMiB(page);
    await page.evaluate(
      async (k) => {
        await window.__webx68kDebug.storageProbeLoadFromLibrary(k.fdd1, 'fdd1');
        await window.__webx68kDebug.storageProbeLoadFromLibrary(k.hdd, 'hdd');
      },
      keys,
    );

    await page.waitForSelector('#btn-boot-system', { visible: true });
    const clickedAt = Date.now();
    await page.click('#btn-boot-system');
    await waitForBootPrompt(page, config.bootTimeoutMs);
    const promptAt = Date.now();
    const heapAfterMiB = await peakHeapMiB(page);

    const log = await page.evaluate(() => window.__webx68kDebug.storageProbeRead());
    await context.close();
    return {
      trial,
      success: true,
      bootDurationMs: promptAt - clickedAt,
      heapBeforeMiB,
      heapAfterMiB,
      ramExpansions: log.ramExpansions,
      libraryLoads: log.libraryLoads,
    };
  } catch (error) {
    await context.close();
    return { trial, success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function measureFaultTrial(browser, config, fault) {
  // 故障注入はROM(IPLROM)書込みを対象にする(FDD1/HDD無しの最小起動で足りるため高速)。
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await page.goto(config.baseUrl, { waitUntil: 'networkidle2' });
    await page.evaluate((f) => {
      window.__webx68kDebug.storageProbeEnable(true);
      window.__webx68kDebug.storageProbeReset();
      if (f) window.__webx68kDebug.storageProbeSetNextRamFault(f);
    }, fault);
    await page.waitForSelector('#btn-boot-system', { visible: true });
    await page.click('#btn-boot-system');
    // ROM書込みの検証記録(probedMemfsWrite)は host.init() の中、retro_init()より前の
    // 同期処理で既に確定している。skip-write等の重い故障はその後の retro_init()/起動処理を
    // ハングさせうるため、プロンプト到達を待たずに一定時間後は必ずログだけ読みにいく
    // (ここで読めなければ「起動そのものが止まった」という、それ自体が検出の一形態になる)。
    // 陽性対照(fault=null)は通常どおり config.bootTimeoutMs まで待つ。故障注入側だけ、
    // ハングして起動タイムアウトいっぱい待たされるのを避けるため短いキャップを掛ける。
    const waitMs = fault ? Math.min(config.bootTimeoutMs, 20000) : config.bootTimeoutMs;
    let bootReached = false;
    let bootError = null;
    try {
      await waitForBootPrompt(page, waitMs);
      bootReached = true;
    } catch (error) {
      bootError = error instanceof Error ? error.message : String(error);
    }
    const log = await page.evaluate(() => window.__webx68kDebug.storageProbeRead());
    await context.close();
    return {
      success: true,
      bootReached,
      bootError,
      romIplEvent: log.ramExpansions.find((e) => e.kind === 'rom-ipl') ?? null,
    };
  } catch (error) {
    await context.close();
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function summarizeKind(trials, kind) {
  const events = trials.filter((t) => t.success).flatMap((t) => t.ramExpansions.filter((e) => e.kind === kind));
  const durations = events.map((e) => e.memfsWriteEndAtMs - e.memfsWriteStartAtMs);
  const byteLength = events[0]?.byteLength ?? null;
  const msPerMiB = events.map((e) => {
    const mib = e.byteLength / 1048576;
    return mib > 0 ? (e.memfsWriteEndAtMs - e.memfsWriteStartAtMs) / mib : null;
  }).filter((v) => v !== null);
  const verifyOkCount = events.filter((e) => e.verify.ok).length;
  return {
    sampleCount: events.length,
    byteLength,
    memfsWriteMs: summarize(durations),
    msPerMiB: summarize(msPerMiB),
    verifyOkCount,
    verifyFailCount: events.length - verifyOkCount,
  };
}

function summarizeLibraryLoad(trials, slot) {
  const events = trials.filter((t) => t.success).flatMap((t) => t.libraryLoads.filter((e) => e.slot === slot));
  const durations = events.map((e) => e.idbGetEndAtMs - e.idbGetStartAtMs);
  return {
    sampleCount: events.length,
    byteLength: events[0]?.byteLength ?? null,
    idbGetMs: summarize(durations),
  };
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
    profile = await mkdtemp(join(tmpdir(), 'webx68k-measure-ramexp-'));
    browser = await puppeteer.launch({
      executablePath: config.executablePath,
      userDataDir: profile,
      headless: false,
      args: ['--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=1000,900', '--enable-precise-memory-info'],
    });

    const trials = [];
    for (let trial = 1; trial <= config.runs; trial++) {
      trials.push(await measureMainTrial(browser, config, trial));
    }
    const failures = trials.filter((t) => !t.success);

    let faultCheck = null;
    if (config.fault) {
      const positiveControl = await measureFaultTrial(browser, { ...config }, null);
      const faulted = await measureFaultTrial(browser, config, config.fault);
      const pcOk =
        positiveControl.success && positiveControl.bootReached && positiveControl.romIplEvent?.verify.ok === true;
      let detectionOk = false;
      let detail = null;
      if (faulted.success && faulted.romIplEvent) {
        const v = faulted.romIplEvent.verify;
        detail = v;
        if (config.fault === 'skip-write') detectionOk = v.ok === false;
        if (config.fault === 'truncate-tail') detectionOk = v.sizeMatch === false && v.tailMatch === false;
        if (config.fault === 'corrupt-checksum') {
          detectionOk = v.sizeMatch === true && v.tailMatch === true && v.checksumMatch === false;
        }
      } else if (faulted.success && !faulted.romIplEvent) {
        // ログ自体が読めた(=main threadは生きている)がイベントが無い異常。検出失敗として扱う。
        detectionOk = false;
      }
      // skip-writeはコアの起動処理自体を止めうる。verify.ok===falseは既にretro_init()より前の
      // 同期区間で記録済みなので、起動未到達(bootReached=false)はここでは失敗ではなく、
      // 「もっと重い形の検出」として別途 detail.bootHang に記録する。
      faultCheck = {
        fault: config.fault,
        positiveControlPassed: pcOk,
        positiveControlVerify: positiveControl.romIplEvent?.verify ?? null,
        positiveControlSuccess: positiveControl.success,
        positiveControlBootReached: positiveControl.bootReached ?? null,
        positiveControlError: positiveControl.error ?? positiveControl.bootError ?? null,
        faultedSuccess: faulted.success,
        faultedBootReached: faulted.bootReached ?? null,
        faultedBootError: faulted.bootError ?? null,
        faultedError: faulted.error ?? null,
        detectionPassed: detectionOk,
        detail,
      };
    }

    const bootDurations = trials.filter((t) => t.success).map((t) => t.bootDurationMs);
    const romIpl = summarizeKind(trials, 'rom-ipl');
    const romCg = summarizeKind(trials, 'rom-cg');
    const fdd1 = summarizeKind(trials, 'fdd1');
    const hdd = summarizeKind(trials, 'hdd');
    const fdd1Load = summarizeLibraryLoad(trials, 'fdd1');
    const hddLoad = summarizeLibraryLoad(trials, 'hdd');

    const shareOfBoot = (memfsMedianMs, idbMedianMs) => {
      const bootMedian = summarize(bootDurations).medianMs;
      if (bootMedian === null) return null;
      const total = (memfsMedianMs ?? 0) + (idbMedianMs ?? 0);
      return roundMs((total / bootMedian) * 100);
    };

    const heapDeltasMiB = trials
      .filter((t) => t.success && t.heapBeforeMiB !== null && t.heapAfterMiB !== null)
      .map((t) => t.heapAfterMiB - t.heapBeforeMiB);

    const result = {
      schemaVersion: 1,
      measuredAt: new Date().toISOString(),
      measurement:
        '起動時のRAM展開。IndexedDB get要求から全bytes取得まで(FDD1/HDDのみ)、Uint8Array準備からMEMFS writeFile完了・検査完了までをROM/FDD1/HDD別に計測',
      config,
      trials: trials.map((t) => ({ trial: t.trial, success: t.success, error: t.error ?? null, bootDurationMs: t.bootDurationMs ?? null })),
      failures,
      bootDurationMs: summarize(bootDurations),
      heapDeltaMiB: summarize(heapDeltasMiB),
      heapApiAvailable: trials.some((t) => t.success && t.heapBeforeMiB !== null),
      romIpl: { ...romIpl, idbGet: 'ROMは既定で同梱ROMをnetwork fetchするためIndexedDB get区間は対象外(未測定)' },
      romCg: { ...romCg, idbGet: 'ROMは既定で同梱ROMをnetwork fetchするためIndexedDB get区間は対象外(未測定)' },
      fdd1: { ...fdd1, idbGet: fdd1Load, shareOfBootPercent: shareOfBoot(fdd1.memfsWriteMs.medianMs, fdd1Load.idbGetMs.medianMs) },
      hdd: { ...hdd, idbGet: hddLoad, shareOfBootPercent: shareOfBoot(hdd.memfsWriteMs.medianMs, hddLoad.idbGetMs.medianMs) },
      faultCheck,
      limitations: [
        'peak JS/Wasm memoryはChromeのperformance.memory(非標準)がある場合のみ取得しており、Wasmヒープ専用の値ではない。取得不可のブラウザではheapApiAvailable=falseとして値をnullのままにする。',
        'ROMのIndexedDB get区間は既定構成(同梱ROM)では発生しないため測定していない。ユーザーがROMを独自アップロードした場合の経路は別途の検証が必要。',
        '起動時間に占める割合は、同一試行内のFDD1/HDD書込み・IndexedDB get区間の中央値合計とbootDurationMs中央値の比であり、試行ごとの対応を厳密に取った値ではない。',
      ],
    };

    await mkdir(dirname(config.outputPath), { recursive: true });
    await writeFile(config.outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

    console.log(`起動時RAM展開計測: 出力 ${config.outputPath}`);
    console.log(`成功 ${trials.length - failures.length}/${trials.length}, 起動時間中央値 ${result.bootDurationMs.medianMs ?? '-'}ms`);
    for (const [name, s] of [['ROM(IPL)', romIpl], ['ROM(CG)', romCg], ['FDD1', fdd1], ['HDD', hdd]]) {
      console.log(
        `  ${name}: ${s.sampleCount}件, ${s.byteLength ?? '-'}bytes, MEMFS書込 中央値 ${s.memfsWriteMs.medianMs ?? '-'}ms, ms/MiB中央値 ${s.msPerMiB.medianMs ?? '-'}, 検証OK ${s.verifyOkCount}/${s.sampleCount}`,
      );
    }
    if (faultCheck) {
      console.log(
        `故障注入 ${config.fault}: 陽性対照=${faultCheck.positiveControlPassed}, 検出=${faultCheck.detectionPassed}`,
      );
      if (!faultCheck.positiveControlPassed || !faultCheck.detectionPassed) process.exitCode = 1;
    }
    if (failures.length > 0) {
      console.log(`失敗 ${failures.length}件`);
      process.exitCode = 1;
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
