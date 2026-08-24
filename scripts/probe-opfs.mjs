// scripts/probe-opfs.html を配信し、計測ハーネスと同じ Chrome で実行して結果を標準出力へ出す。
//
//   node scripts/probe-opfs.mjs              … 自動実行して結果を出す
//   node scripts/probe-opfs.mjs --serve      … 配信だけして待つ(iOS実機や、普段のプロファイルの
//                                              Chrome で開いて persist() を見たいとき)
//
// 測っているのは「能力があるか」であってホスト負荷に依存しないが、末尾のスループットだけは
// 参考値であり、実行環境の影響を受ける(Electron製のブラウザで走らせると30倍遅い値が出た)。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const PORT = Number(process.env.PROBE_PORT || 5401);
const serveOnly = process.argv.includes('--serve');
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript' };

const server = createServer(async (req, res) => {
  const name = (req.url || '/').split('?')[0].replace(/^\/+/, '') || 'probe-opfs.html';
  if (name.includes('..')) { res.writeHead(400).end(); return; }
  try {
    const body = await readFile(join(SCRIPT_DIR, name));
    res.writeHead(200, { 'content-type': MIME[extname(name)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(PORT, serveOnly ? '0.0.0.0' : '127.0.0.1', r));

const url = `http://127.0.0.1:${PORT}/probe-opfs.html`;
if (serveOnly) {
  const lan = Object.values(networkInterfaces()).flat().find((n) => n && n.family === 'IPv4' && !n.internal);
  console.log(`配信中: ${url}`);
  if (lan) console.log(`LAN から: http://${lan.address}:${PORT}/probe-opfs.html`);
  console.log('Ctrl+C で停止。');
} else {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: false, args: ['--no-first-run'] });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
    await page.goto(url, { waitUntil: 'load' });
    console.log('version:', await browser.version());
    await page.click('#run');
    await page.waitForFunction(
      () => { const t = document.getElementById('out').textContent; return t.includes('== 完了 ==') || t.includes('中断'); },
      { timeout: 300000 });
    console.log(await page.$eval('#out', (el) => el.textContent));
  } finally { await browser.close(); server.close(); }
}
