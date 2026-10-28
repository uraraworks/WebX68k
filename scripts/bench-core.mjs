#!/usr/bin/env node
// 使い方: node scripts/bench-core.mjs ラベル=コアディレクトリ ...
// 先頭の1巡をウォームアップとして除外し、同一プロセスで6巡する。
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';

const root = fileURLToPath(new URL('..', import.meta.url));
const variants = process.argv.slice(2).map(arg => { const i = arg.indexOf('='); if (i < 1) throw Error('ラベル=ディレクトリを指定してください'); return { name: arg.slice(0, i), dir: resolve(arg.slice(i + 1)) }; });
if (variants.length < 2) throw Error('比較対象を2個以上指定してください');
const bundle = await build({ stdin: { contents: `export { LibretroHost } from './src/libretro-host'; export { buildCoreOptions } from './src/core-options'; export { RETROK } from './src/keyboard';`, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', define: { 'import.meta.env.DEV': 'false' }, write: false });
const { LibretroHost, buildCoreOptions, RETROK } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const asset = name => readFileSync(resolve(root, 'public/system', name));
const percentile = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)]; };
const stats = values => ({ median: percentile(values, .5), p90: percentile(values, .9) });
const originalDate = Date.now;
// コアの診断ログは JSON 出力と混ぜない。
console.log = (...args) => console.error(...args);
process.env.TZ = 'UTC';
async function run(v) {
  let now = 946684800000;
  Date.now = () => now;
  const js = resolve(v.dir, 'px68k_libretro.js');
  const module = { exports: {} };
  runInThisContext(`(function(module,exports,require,__filename,__dirname){${readFileSync(js, 'utf8')}\n})`, { filename: js })(module, module.exports, createRequire(js), js, dirname(js));
  globalThis.PX68K = options => module.exports({ ...options, locateFile: () => resolve(v.dir, 'px68k_libretro.wasm') });
  const canvas = { width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }), putImageData: () => {} }) };
  const host = new LibretroHost(canvas, () => {});
  await host.init(asset('iplrom.dat'), asset('cgrom.dat'));
  for (const [key, value] of Object.entries(buildCoreOptions({ cpuSpeed: '16Mhz', ramSize: '2MB', joyType1CoreValue: 'Default (2 Buttons)', joyType2CoreValue: 'Default (2 Buttons)' }))) host.setCoreOption(key, value);
  if (!host.loadGame(host.writeDiskImage('human302.xdf', asset('human302.xdf')))) throw Error('ディスク起動失敗');
  const originalRun = host.mod._retro_run;
  let inner = 0;
  host.mod._retro_run = () => { const start = performance.now(); originalRun(); inner += performance.now() - start; };
  const retro = [], frameTimes = [], keys = [RETROK.d, RETROK.i, RETROK.r, RETROK.RETURN];
  for (let frame = 0; frame < 1200; frame++) {
    const pos = frame - 900;
    if (pos >= 0 && pos < 48) { if (pos % 12 === 0) host.setKey(keys[Math.floor(pos / 12)], true); if (pos % 12 === 6) host.setKey(keys[Math.floor(pos / 12)], false); }
    now += 18; host.setVideoSkip(false); inner = 0;
    const start = performance.now(); host.runFrame(); frameTimes.push(performance.now() - start); retro.push(inner);
  }
  const screen = host.readTextScreen().lines.join('\n');
  if (!screen.includes('A>dir') || !screen.includes('CONFIG')) throw Error('dir 表示を確認できません');
  host.unloadGame();
  return { retro: stats(retro), runFrame: stats(frameTimes) };
}
try {
  const results = variants.map(v => { const wasm = readFileSync(resolve(v.dir, 'px68k_libretro.wasm')); return { name: v.name, wasm: wasm.length, gzip: gzipSync(wasm).length, rounds: [] }; });
  for (let round = 0; round < 6; round++) for (let i = 0; i < variants.length; i++) {
    const value = await run(variants[i]); results[i].rounds.push(value);
    process.stderr.write(`${round === 0 ? 'warmup' : round} ${variants[i].name}: ${JSON.stringify(value)}\n`);
  }
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
} finally { Date.now = originalDate; delete globalThis.PX68K; }
