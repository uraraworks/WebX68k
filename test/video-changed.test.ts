import { expect, it, vi } from 'vitest';
import { LibretroHost } from '../src/libretro-host';

it('変化のない画像は変換せず、未提示の変化と解像度変更は提示する', () => {
  const put = vi.fn();
  const ctx = { createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }), putImageData: put };
  const host = new LibretroHost({ width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement, () => {});
  let changed = 1;
  (host as any).mod = { HEAPU16: new Uint16Array(64), _webx68k_video_changed: () => changed };
  const refresh = (width = 2) => (host as any).handleVideoRefresh(4, width, 1, 8);
  refresh();
  changed = 0;
  refresh();
  expect(put).toHaveBeenCalledTimes(1);
  host.setVideoSkip(true);
  changed = 1;
  refresh();
  changed = 0;
  host.setVideoSkip(false);
  refresh();
  expect(put).toHaveBeenCalledTimes(2);
  refresh(3);
  expect(put).toHaveBeenCalledTimes(3);
  host.setVideoHidden(true);
  changed = 1;
  refresh(3);
  changed = 0;
  expect(host.setVideoHidden(false)).toBe(true);
  expect(put).toHaveBeenCalledTimes(4);
  (host as any).handleVideoRefresh(6, 3, 1, 8);
  expect(put).toHaveBeenCalledTimes(5);
});

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { buildCoreOptions } from '../src/core-options';
import { RETROK } from '../src/keyboard';

it('実コアで静止、打鍵、非表示、間引き、メニューとステート復元を検証する', async () => {
  const asset = (path: string) => readFileSync(fileURLToPath(new URL(`../public/${path}`, import.meta.url)));
  const path = fileURLToPath(new URL('../public/core/px68k_libretro.js', import.meta.url));
  const module = { exports: {} as any };
  runInThisContext(`(function(module,exports,require,__filename,__dirname){${readFileSync(path, 'utf8')}\n})`, { filename: path })(module, module.exports, createRequire(path), path, dirname(path));
  let pixels = Buffer.alloc(0), count = 0, now = 946684800000;
  const ctx = { createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }), putImageData: (image: ImageData) => { pixels = Buffer.from(image.data); count++; } };
  const host = new LibretroHost({ width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement, () => {});
  const old = (globalThis as any).PX68K;
  (globalThis as any).PX68K = (options: any) => module.exports({ ...options, locateFile: () => fileURLToPath(new URL('../public/core/px68k_libretro.wasm', import.meta.url)) });
  const date = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const tz = process.env.TZ; process.env.TZ = 'UTC';
  const run = (n = 1) => { for (let i = 0; i < n; i++) { now += 18; host.runFrame(); } };
  try {
    await host.init(asset('system/iplrom.dat'), asset('system/cgrom.dat'));
    for (const [key, value] of Object.entries(buildCoreOptions({ cpuSpeed: '16Mhz', ramSize: '2MB', joyType1CoreValue: 'Default (2 Buttons)', joyType2CoreValue: 'Default (2 Buttons)' }))) host.setCoreOption(key, value);
    expect(host.loadGame(host.writeDiskImage('human302.xdf', asset('system/human302.xdf')))).toBe(true);
    run(900);
    // Wait through cursor blinking and find a stable interval.
    let stable = false;
    for (let i = 0; i < 120; i++) { const before = count; run(3); if (count === before) { stable = true; break; } }
    expect(stable).toBe(true);
    const before = Buffer.from(pixels); const beforeCount = count;
    host.setKey(RETROK.d, true); run(6); host.setKey(RETROK.d, false); run(6);
    expect(count).toBeGreaterThan(beforeCount); expect(pixels.equals(before)).toBe(false);
    const base = host.serialize(); expect(base).not.toBeNull();
    host.setKey(RETROK.i, true); run(6); host.setKey(RETROK.i, false); run(6);
    run(); const expected = Buffer.from(pixels);
    expect(host.unserialize(base!)).toBe(true);
    host.setVideoSkip(true); host.setKey(RETROK.i, true); run(6); host.setKey(RETROK.i, false); run(6);
    const skipped = host.serialize(); expect(skipped).not.toBeNull();
    host.setVideoSkip(false); run(); expect(pixels.equals(expected)).toBe(true);
    expect(host.unserialize(skipped!)).toBe(true); run(); expect(pixels.equals(expected)).toBe(true);
    expect(host.unserialize(base!)).toBe(true);
    host.setVideoHidden(true); host.setKey(RETROK.i, true); run(6); host.setKey(RETROK.i, false); run(6);
    host.setVideoHidden(false); run(); expect(pixels.equals(expected)).toBe(true);
    const normal = Buffer.from(pixels);
    host.setKey(RETROK.F12, true); run(3); host.setKey(RETROK.F12, false); run(3);
    expect(pixels.equals(normal)).toBe(false);
    host.setKey(RETROK.F12, true); run(3); host.setKey(RETROK.F12, false); run(3);
    expect(pixels.equals(normal)).toBe(true);
    host.unloadGame();
  } finally { (globalThis as any).PX68K = old; date.mockRestore(); if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
}, 180_000);
