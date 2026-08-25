// AudioContext.outputLatency が同一マシン・同一ビルドで 0.168 / 0.016 / 0.032 秒の3値を取る件の切り分け。
//
//   node scripts/probe-audio-latency.mjs [--runs=N] [--label=<文字列>]
//
// 1回の Chrome 起動の中で、次の3軸を振って outputLatency を読む。
//   (1) 読み取る時刻      … 生成直後 / resume直後 / 実際に音が流れて 0.5秒・1.5秒・3秒後
//   (2) latencyHint       … 既定 / interactive / balanced / playback / 数値指定
//   (3) sampleRate の強制 … 44100を強制(アプリと同じ) / 強制しない(デバイス任せ)
// あわせて macOS 側の既定出力デバイスを実行の前後で記録する。デバイスが実行中に
// 変わっていたら、その回の結果は条件が揃っていないので信用しない。
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const PORT = Number(process.env.PROBE_PORT || 5402);
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)=(.*)$/.exec(a); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const RUNS = Number(args.runs || 1);
const LABEL = args.label || '';

/** macOS の既定出力デバイスを名前と現在のサンプルレートで返す。 */
function defaultOutputDevice() {
  const r = spawnSync('system_profiler', ['SPAudioDataType', '-json'], { encoding: 'utf8', maxBuffer: 8 << 20 });
  if (r.status !== 0) return { error: 'system_profiler 失敗', raw: (r.stderr || '').slice(0, 200) };
  try {
    const items = JSON.parse(r.stdout).SPAudioDataType?.[0]?._items ?? [];
    const hit = items.find((d) => d.coreaudio_default_audio_output_device === 'spaudio_yes');
    if (!hit) return { name: null, note: '既定出力デバイスが見つからない' };
    return {
      name: hit._name ?? null,
      sampleRate: hit.coreaudio_device_srate ?? null,
      transport: hit.coreaudio_device_transport ?? null,
      outputChannels: hit.coreaudio_device_output ?? null,
    };
  } catch (e) { return { error: String(e) }; }
}

const server = createServer(async (req, res) => {
  const name = (req.url || '/').split('?')[0].replace(/^\/+/, '') || 'probe-audio-latency.html';
  if (name.includes('..')) { res.writeHead(400).end(); return; }
  try {
    const body = await readFile(join(SCRIPT_DIR, name));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const results = [];
for (let i = 0; i < RUNS; i++) {
  const deviceBefore = defaultOutputDevice();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    args: ['--no-first-run', '--autoplay-policy=no-user-gesture-required'],
  });
  let measured;
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/probe-audio-latency.html`, { waitUntil: 'load' });
    measured = await page.evaluate(() => window.__probeAudioLatency());
    if (i === 0) console.log('chrome:', await browser.version());
  } finally { await browser.close(); }
  const deviceAfter = defaultOutputDevice();
  results.push({ run: i + 1, label: LABEL, deviceBefore, deviceAfter, deviceStable: JSON.stringify(deviceBefore) === JSON.stringify(deviceAfter), ...measured });
}
server.close();
console.log(JSON.stringify(results, null, 2));
