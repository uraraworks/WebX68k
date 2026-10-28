// 再生成: GOLDEN_AV_UPDATE=1 npx vitest run test/golden-av-trace.test.ts
// 2回の独立起動が一致し、入力後の画面変化も確認できた場合だけ書き出す。
// fixture はコア・ROM・起動条件の変更を確認してから意図的に更新する。
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { LibretroHost, type PX68KModule } from '../src/libretro-host';
import { buildCoreOptions } from '../src/core-options';
import { RETROK } from '../src/keyboard';

const frames = 1200;
const fixture = fileURLToPath(new URL('./fixtures/golden-av-trace.json', import.meta.url));
const asset = (path: string) => readFileSync(fileURLToPath(new URL(`../public/${path}`, import.meta.url)));
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
type Trace = { video: string; audio: string }[];
type Factory = (options: Record<string, unknown>) => Promise<PX68KModule>;

function coreFactory(): Factory {
  const path = fileURLToPath(new URL('../public/core/px68k_libretro.js', import.meta.url));
  const module = { exports: {} as unknown };
  const wrapper = runInThisContext(`(function(module,exports,require,__filename,__dirname){${readFileSync(path, 'utf8')}\n})`, { filename: path });
  wrapper(module, module.exports, createRequire(path), path, dirname(path));
  return module.exports as Factory;
}

function canvasCapture() {
  let pixels = new Uint8Array();
  let width = 0, height = 0;
  const context = {
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: (image: ImageData) => { pixels = new Uint8Array(image.data); width = image.width; height = image.height; },
  };
  const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
  return { canvas, digest: () => hash(Buffer.concat([Buffer.from(`${width}x${height}:`), pixels])) };
}

async function trace(interval = 1): Promise<Trace> {
  let now = 946684800000;
  const date = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const previousTZ = process.env.TZ;
  process.env.TZ = 'UTC';
  const display = canvasCapture();
  const coreDisplay = canvasCapture();
  let chunks: Buffer[] = [];
  const host = new LibretroHost(display.canvas, (samples) => chunks.push(Buffer.from(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength))));
  const reference = new LibretroHost(coreDisplay.canvas, () => {});
  const factory = coreFactory();
  const oldFactory = (globalThis as unknown as { PX68K?: unknown }).PX68K;
  (globalThis as unknown as { PX68K: unknown }).PX68K = async (options: Record<string, unknown>) => {
    const mod = await factory({ ...options, locateFile: () => fileURLToPath(new URL('../public/core/px68k_libretro.wasm', import.meta.url)) });
    // もう一つの本番変換器へ生のコールバックを渡す。配送を省略しても
    // コアが出した画像と最終提示画像を各フレームで比較できる。
    (reference as unknown as { mod: PX68KModule }).mod = mod;
    const addFunction = mod.addFunction.bind(mod);
    mod.addFunction = ((fn: (...args: number[]) => number | void, signature: string) => {
      if (signature !== 'viiii') return addFunction(fn, signature);
      return addFunction((...args: number[]) => {
        (reference as unknown as { handleVideoRefresh(...args: number[]): void }).handleVideoRefresh(...args);
        return fn(...args);
      }, signature);
    }) as typeof mod.addFunction;
    return mod;
  };
  try {
    await host.init(asset('system/iplrom.dat'), asset('system/cgrom.dat'));
    for (const [key, value] of Object.entries(buildCoreOptions({ cpuSpeed: '16Mhz', ramSize: '2MB', joyType1CoreValue: 'Default (2 Buttons)', joyType2CoreValue: 'Default (2 Buttons)' }))) host.setCoreOption(key, value);
    const disk = host.writeDiskImage('human302.xdf', asset('system/human302.xdf'));
    expect(host.loadGame(disk)).toBe(true);
    const result: Trace = [];
    const keys = [RETROK.d, RETROK.i, RETROK.r, RETROK.RETURN];
    for (let frame = 0; frame < frames; frame++) {
      const position = frame - 900;
      if (position >= 0 && position < keys.length * 12) {
        if (position % 12 === 0) host.setKey(keys[Math.floor(position / 12)], true);
        if (position % 12 === 6) host.setKey(keys[Math.floor(position / 12)], false);
      }
      chunks = [];
      now += 18;
      host.setVideoSkip(frame % interval !== interval - 1);
      host.runFrame();
      const video = display.digest();
      if (interval === 1) expect(video, `frame ${frame}: core image and displayed image`).toBe(coreDisplay.digest());
      result.push({ video, audio: hash(Buffer.concat(chunks)) });
    }
    const screen = host.readTextScreen().lines.join('\n');
    expect(screen).toContain('A>dir');
    expect(screen).toContain('CONFIG');
    host.unloadGame();
    return result;
  } finally {
    (globalThis as unknown as { PX68K?: unknown }).PX68K = oldFactory;
    date.mockRestore();
    if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ;
  }
}

it('実コアの各フレームの提示画像と音声がゴールデンに一致する', async () => {
  const first = await trace();
  const second = await trace();
  expect(second).toEqual(first);
  expect(new Set(first.slice(900).map((frame) => frame.video)).size).toBeGreaterThan(1);
  if (process.env.GOLDEN_AV_UPDATE === '1') writeFileSync(fixture, JSON.stringify(first, null, 0) + '\n');
  expect(first).toEqual(JSON.parse(readFileSync(fixture, 'utf8')));
}, 180_000);

for (const interval of [2, 3, 7]) {
  it(`${interval} フレームに一度の提示でも映像と全音声が一致する`, async () => {
    const actual = await trace(interval);
    const golden: Trace = JSON.parse(readFileSync(fixture, 'utf8'));
    for (let frame = 0; frame < frames; frame++) {
      expect(actual[frame].audio, `audio frame ${frame}`).toBe(golden[frame].audio);
      if (frame % interval === interval - 1)
        expect(actual[frame].video, `video frame ${frame}`).toBe(golden[frame].video);
    }
  }, 180_000);
}
