// scripts/probe-opfs.html を配信し、計測ハーネスと同じ Chrome で実行して結果を標準出力へ出す。
//
//   node scripts/probe-opfs.mjs              … 自動実行して結果を出す
//   node scripts/probe-opfs.mjs --serve      … 配信だけして待つ(iOS実機や、普段のプロファイルの
//                                              Chrome で開いて persist() を見たいとき)
//
// 測っているのは「能力があるか」であってホスト負荷に依存しないが、末尾のスループットだけは
// 参考値であり、実行環境の影響を受ける(Electron製のブラウザで走らせると30倍遅い値が出た)。
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const PORT = Number(process.env.PROBE_PORT || 5401);
const serveOnly = process.argv.includes('--serve');
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript' };
// 実機(iOS Safari等)から回収した結果の保存先。_local/ は .gitignore 済みなのでコミット事故が起きない。
const RESULT_DIR = join(SCRIPT_DIR, '..', '_local', 'opfs-probe');

function timestampName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `ios-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (req, res) => {
  if (serveOnly && req.method === 'POST' && (req.url || '/').split('?')[0] === '/result') {
    try {
      const raw = await readBody(req);
      JSON.parse(raw); // 妥当なJSONであることだけ確認(内容の検証はしない)
      await mkdir(RESULT_DIR, { recursive: true });
      const path = join(RESULT_DIR, timestampName());
      await writeFile(path, raw, 'utf8');
      console.log('保存しました:', path);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    } catch (e) {
      console.error('[result] 保存に失敗:', e && e.message);
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: String(e && e.message) }));
    }
    return;
  }
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
