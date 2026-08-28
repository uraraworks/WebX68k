// scripts/probe-worker.html を配信し、ヘッドフル実Chromeで駆動して
// ワーカー移行 手順5・7 の未決事項(A: 映像経路, B: frame event, C: スケジューラ)を実測する。
//
//   node scripts/probe-worker.mjs [--out=<path>]
//
// 同期実行(このスクリプト自体が最後まで待つ)。puppeteerでタブの前面/背面を実際に
// 切り替えて hidden 条件を作る(page.evaluateでvisibilityStateを偽装しない)。
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { collectEnvironment } from './measure-env.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const PORT = Number(process.env.PROBE_PORT || 5403);
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)=(.*)$/.exec(a); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const OUT_DIR = args.out || '/private/tmp/claude-501/-Users-haruurara-MyProject--emulator-X68K/482ec7e0-f1a0-44a6-8c27-512c5bee99b3/scratchpad';

const TRIALS = 3;
const A_DURATION_MS = 6000;
const B_DURATION_MS = 6000;
const C_DURATION_MS = 5000;

const server = createServer(async (req, res) => {
  const name = (req.url || '/').split('?')[0].replace(/^\/+/, '') || 'probe-worker.html';
  if (name.includes('..')) { res.writeHead(400).end(); return; }
  try {
    const body = await readFile(join(SCRIPT_DIR, name));
    const ext = name.endsWith('.mjs') || name.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': ext }).end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const url = `http://127.0.0.1:${PORT}/probe-worker.html`;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: false, args: ['--no-first-run'],
  protocolTimeout: 60000, // workerのonerrorが必ずrejectするので、ハング検知は短めでよい
});
const report = { startedAt: new Date().toISOString() };

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(url, { waitUntil: 'load' });
  report.chromeVersion = await browser.version();
  console.log('chrome:', report.chromeVersion);

  report.env = await collectEnvironment(page);

  // --- A. 映像経路: 可否3点 -------------------------------------------------
  console.log('A: 可否3点を確認中…');
  report.aFeasibility = await page.evaluate(() => window.__pwFeasibility());
  console.log('A feasibility:', JSON.stringify(report.aFeasibility));

  // --- A. 故障注入(陽性対照): 描画を意図的にサボらせ、検出できることを確認 ---
  console.log('A: 故障注入中(offscreen)…');
  report.aFaultInjectionOffscreen = await page.evaluate(() => window.__pwFaultInjectionA('offscreen'));
  console.log('A: 故障注入中(transfer)…');
  report.aFaultInjectionTransfer = await page.evaluate(() => window.__pwFaultInjectionA('transfer'));
  console.log('A fault injection:', JSON.stringify({ offscreen: report.aFaultInjectionOffscreen, transfer: report.aFaultInjectionTransfer }));

  // --- A. 速度(3試行 x 2方式) ------------------------------------------------
  console.log('A: offscreen 速度計測(3試行)…');
  report.aOffscreen = await page.evaluate((n, d) => window.__pwSpeedA('offscreen', n, d), TRIALS, A_DURATION_MS);
  console.log('A: transfer 速度計測(3試行)…');
  report.aTransfer = await page.evaluate((n, d) => window.__pwSpeedA('transfer', n, d), TRIALS, A_DURATION_MS);

  // --- B. frame event の費用(静穏 / メイン多忙) -----------------------------
  console.log('B: 静穏時(3試行)…');
  report.bQuiet = await page.evaluate((n, d) => window.__pwB(n, d, false), TRIALS, B_DURATION_MS);
  console.log('B: メイン多忙時(3試行)…');
  report.bBusy = await page.evaluate((n, d) => window.__pwB(n, d, true), TRIALS, B_DURATION_MS);

  // --- C. スケジューラ: 前面 ---------------------------------------------
  console.log('C: setTimeout 前面(3試行)…');
  report.cTimeoutForeground = await page.evaluate((n, d) => window.__pwC('timeout', n, d), TRIALS, C_DURATION_MS);
  console.log('C: setInterval 前面(3試行)…');
  report.cIntervalForeground = await page.evaluate((n, d) => window.__pwC('interval', n, d), TRIALS, C_DURATION_MS);

  // --- C. スケジューラ: 背面(実際に別タブを前面へ出してhiddenにする) --------
  const page2 = await browser.newPage();
  await page2.goto('about:blank');
  await page2.bringToFront();
  const visBefore = await page.evaluate(() => window.__pwVisibility());
  console.log('page1 visibilityState (別タブ前面化後):', visBefore);
  report.hiddenConfirmed = visBefore === 'hidden';

  console.log('C: setTimeout 背面(3試行)…');
  report.cTimeoutHidden = await page.evaluate((n, d) => window.__pwC('timeout', n, d), TRIALS, C_DURATION_MS);
  console.log('C: setInterval 背面(3試行)…');
  report.cIntervalHidden = await page.evaluate((n, d) => window.__pwC('interval', n, d), TRIALS, C_DURATION_MS);

  await page2.close();
  await page.bringToFront();
  const visAfter = await page.evaluate(() => window.__pwVisibility());
  report.visibilityAfterRestore = visAfter;

  report.finishedAt = new Date().toISOString();
} finally {
  await browser.close();
  server.close();
}

await mkdir(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `probe-worker-${Date.now()}.json`);
await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log('結果を保存しました:', outPath);
console.log('=== 要点 ===');
console.log('toDataURLAfterTransfer:', JSON.stringify(report.aFeasibility.toDataURLAfterTransfer));
console.log('getImageDataAfterTransfer:', JSON.stringify(report.aFeasibility.getImageDataAfterTransfer));
console.log('retransferSameCanvas:', JSON.stringify(report.aFeasibility.retransferSameCanvas));
console.log('newCanvasTransferAfterRegen:', JSON.stringify(report.aFeasibility.newCanvasTransferAfterRegen));
console.log('hiddenConfirmed:', report.hiddenConfirmed);
