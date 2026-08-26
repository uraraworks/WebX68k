// scripts/probe-opfs-load.html を配信し、既存 scripts/probe-opfs.mjs と同じ枠組み
// (--serve でHTTPS配信 / puppeteerでChrome自動実行 / POST /result で結果回収) で実行する。
//
// probe-opfs.mjs との違いは「能力があるか」ではなく「コア相当の負荷をかけながら同期I/Oした
// ときに干渉が起きるか」を測ること。ポートは既存(5401)と衝突しないよう5402を使う。
//
//   node scripts/probe-opfs-load.mjs              … 自動実行して結果を出す
//   node scripts/probe-opfs-load.mjs --serve      … 配信だけして待つ(iOS実機用)
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const PORT = Number(process.env.PROBE_LOAD_PORT || 5402);
const serveOnly = process.argv.includes('--serve');
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript' };
const RESULT_DIR = join(SCRIPT_DIR, '..', '_local', 'opfs-probe-load');
const CERT_DIR = process.env.PROBE_CERT_DIR || join(SCRIPT_DIR, '..', '_local', 'probe-cert');

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

const handler = async (req, res) => {
  if (serveOnly && req.method === 'POST' && (req.url || '/').split('?')[0] === '/result') {
    try {
      const raw = await readBody(req);
      JSON.parse(raw);
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
  const name = (req.url || '/').split('?')[0].replace(/^\/+/, '') || 'probe-opfs-load.html';
  if (name.includes('..')) { res.writeHead(400).end(); return; }
  try {
    const body = await readFile(join(SCRIPT_DIR, name));
    res.writeHead(200, { 'content-type': MIME[extname(name)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end('not found'); }
};

let server;
let scheme;
if (serveOnly) {
  let key, cert;
  try {
    [key, cert] = await Promise.all([
      readFile(join(CERT_DIR, 'key.pem')),
      readFile(join(CERT_DIR, 'cert.pem')),
    ]);
  } catch (e) {
    console.error(`証明書が無いので HTTPS で配信できない(${CERT_DIR} に key.pem/cert.pem が必要): ${e.message}`);
    process.exit(1);
  }
  server = createHttpsServer({ key, cert }, handler);
  scheme = 'https';
} else {
  server = createHttpServer(handler);
  scheme = 'http';
}
await new Promise((r) => server.listen(PORT, serveOnly ? '0.0.0.0' : '127.0.0.1', r));

const url = `${scheme}://127.0.0.1:${PORT}/probe-opfs-load.html`;
if (serveOnly) {
  const lan = Object.values(networkInterfaces()).flat().find((n) => n && n.family === 'IPv4' && !n.internal);
  console.log(`配信中: ${url}`);
  if (lan) console.log(`LAN から: ${scheme}://${lan.address}:${PORT}/probe-opfs-load.html`);
  console.log('Ctrl+C で停止。項目2(バックグラウンド復帰)を試す場合はホーム画面へ戻って10秒待ってから戻ってくること。');
} else {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: false, args: ['--no-first-run'] });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
    await page.goto(url, { waitUntil: 'load' });
    console.log('version:', await browser.version());
    await page.click('#run');
    // 項目2はバックグラウンド化しないPCのChromeでは必ずタイムアウト(60秒)経由で進む。
    // その分、全体のタイムアウトは長めに取る。
    await page.waitForFunction(
      () => { const t = document.getElementById('out').textContent; return t.includes('== 完了 ==') || t.includes('中断'); },
      { timeout: 120000 });
    console.log(await page.$eval('#out', (el) => el.textContent));
  } finally { await browser.close(); server.close(); }
}
