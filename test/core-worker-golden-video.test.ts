import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { LibretroHost, type PX68KModule } from '../src/libretro-host';
import { buildCoreOptions } from '../src/core-options';
import { RETROK } from '../src/keyboard';
import { AudioEngine } from '../src/audio';
import { createResampleState } from '../src/speed';
import { deliverWorkerAudio } from '../src/worker-audio';

vi.mock('../src/scsi-opfs', () => ({ setupScsiOpfs: async () => ({ mode: 'none' }) }));
vi.mock('../src/hostfs/worker-bridge', async (original) => ({ ...(await original()), installHostFsBridge: () => ({ installed: false }) }));

const coreDir = process.env.WEBX68K_CORE_DIR || fileURLToPath(new URL('../public/core', import.meta.url));
const asset = (path: string) => readFileSync(fileURLToPath(new URL(`../public/${path}`, import.meta.url)));
const bytes = (data: Buffer) => Uint8Array.from(data).buffer;

it('実 Worker の提示画像をフレーム番号に対応するゴールデンと照合する', async () => {
  const golden: { video: string; audio: string }[] = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/golden-av-trace.json', import.meta.url)), 'utf8'));
  const path = join(coreDir, 'px68k_libretro.js');
  const module = { exports: {} as unknown };
  runInThisContext(`(function(module,exports,require,__filename,__dirname){${readFileSync(path, 'utf8')}\n})`, { filename: path })(module, module.exports, createRequire(path), path, dirname(path));
  const factory = module.exports as (options: Record<string, unknown>) => Promise<PX68KModule>;
  let now = 946684800000, clock = 1, tick = () => {}, count = 0;
  let pixels = Buffer.alloc(0), width = 0, height = 0, compared = 0, rgba = 0;
  let lastSource = 0, lastPitch = 0;
  let resizedPixels = Buffer.alloc(0);
  const responses = new Map<number, any>();
  const audio = new AudioEngine();
  const audioState = createResampleState();
  let delivered: Buffer[] = [];
  (audio as any).node = { port: { postMessage: (chunk: Float32Array, transfer: ArrayBuffer[]) => {
    const received = structuredClone(chunk, { transfer });
    expect(chunk.buffer.byteLength).toBe(0);
    delivered.push(Buffer.from(received.buffer, received.byteOffset, received.byteLength));
  } } };
  let lastAudioFrame = 0;
  const frameAudioBytes: number[] = [];
  let currentAudioBytes = 0;
  const previousTZ = process.env.TZ;
  process.env.TZ = 'UTC';
  const date = vi.spyOn(Date, 'now').mockImplementation(() => now);
  // 実コアはディスク名を表示するため、Worker の接頭辞をゴールデンの名前に揃える。
  const originalDisk = LibretroHost.prototype.writeDiskImage;
  vi.spyOn(LibretroHost.prototype, 'writeDiskImage').mockImplementation(function (this: LibretroHost, name, data) { return originalDisk.call(this, name.replace(/^fdd0_/, ''), data); });
  const originalRun = LibretroHost.prototype.runFrame;
  const worker = {
    onmessage: null as any,
    performance: { now: () => clock },
    setInterval: (fn: () => void) => { tick = fn; return 1; },
    clearInterval: () => {},
    postMessage: (message: any, transfer: ArrayBuffer[] = []) => {
      const received = structuredClone(message, { transfer });
      if (received.kind === 'response') responses.set(received.requestId, received);
      if (received.event !== 'frame') return;
      const frame = received.snapshot;
      delivered = [];
      deliverWorkerAudio(frame.audio.chunks, 1, audioState, audio);
      if (frame.frameNo <= 1200) {
        // tick が複数フレームを含む場合も、コールバックの長さで境界を復元する。
        const combined = Buffer.concat(delivered);
        let offset = 0;
        for (let i = lastAudioFrame; i < frame.frameNo; i++) {
          const end = offset + frameAudioBytes[i];
          expect(createHash('sha256').update(combined.subarray(offset, end)).digest('hex'), `audio frame ${i + 1}`).toBe(golden[i].audio);
          offset = end;
        }
        expect(offset).toBe(combined.length);
        lastAudioFrame = frame.frameNo;
      }
      if (frame.video.kind === 'rgba') {
        const video = frame.video;
        pixels = Buffer.from(video.bytes.slice(0)); width = video.width; height = video.height; rgba++;

        const returned = structuredClone(video.bytes, { transfer: [video.bytes] });
        expect(video.bytes.byteLength).toBe(0);
        worker.onmessage({ data: { kind: 'returnFrameBuffer', buffer: returned } });
      }
      const digest = createHash('sha256').update(`${width}x${height}:`).update(pixels).digest('hex');
      if (frame.frameNo === 1) return;
      if (frame.frameNo <= 1200) {
        expect(digest, `Worker frameNo ${frame.frameNo}, golden index ${frame.frameNo - 1}`).toBe(golden[frame.frameNo - 1].video);
        compared++;
      } else if (frame.frameNo === 1201) {
        expect([width, height]).toEqual([2, 2]);
        expect(pixels).toEqual(resizedPixels);
      } else {
        expect(['offscreen', 'rgba']).toContain(frame.video.kind);
        expect(pixels).toEqual(resizedPixels);
      }
    },
  };
  // 実コアの映像コールバックを捕捉し、最後に解像度変更と dupe を注入する。
  const proto = LibretroHost.prototype as any;
  const audioBatch = proto.handleAudioBatch;
  vi.spyOn(proto, 'handleAudioBatch').mockImplementation(function (this: LibretroHost, data: number, frames: number) {
    currentAudioBytes += frames * 8;
    return audioBatch.call(this, data, frames);
  });
  const videoRefresh = proto.handleVideoRefresh;
  vi.spyOn(proto, 'handleVideoRefresh').mockImplementation(function (this: LibretroHost, data: number, width: number, height: number, pitch: number) {
    if (data) { lastSource = data; lastPitch = pitch; }
    videoRefresh.call(this, count === 1202 ? 0 : data, width, height, pitch);
  });
  vi.spyOn(LibretroHost.prototype, 'runFrame').mockImplementation(function (this: LibretroHost) {
    const keys = [RETROK.d, RETROK.i, RETROK.r, RETROK.RETURN];
    const pos = count - 900;
    if (pos >= 0 && pos < 48 && (pos % 12 === 0 || pos % 12 === 6)) {
      worker.onmessage({ data: { kind: 'inputUpdate', update: { keys: pos % 12 === 0 ? [keys[Math.floor(pos / 12)]] : [], pads: [0, 0], mouseButtons: { left: false, right: false }, mouseDelta: { dx: 0, dy: 0 }, inputGeneration: 0, keyMakes: [] } } });
    }
    count++; now += 18; currentAudioBytes = 0; originalRun.call(this); frameAudioBytes.push(currentAudioBytes);
    if (count === 1201) {
      const heap = (this as any).mod.HEAPU16 as Uint16Array;
      const pixels: number[] = [];
      for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
        const px = heap[(lastSource >> 1) + y * (lastPitch >> 1) + x];
        const r = px >> 11, g = (px >> 5) & 63, b = px & 31;
        pixels.push((r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2), 255);
      }
      resizedPixels = Buffer.from(pixels);
      videoRefresh.call(this, lastSource, 2, 2, lastPitch);
    }
  });
  vi.stubGlobal('self', worker);
  vi.stubGlobal('OffscreenCanvas', class { width = 1; height = 1; pixels = new Uint8ClampedArray(); getContext() { return { createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }), putImageData: (img: ImageData) => { this.pixels = new Uint8ClampedArray(img.data); }, getImageData: () => ({ data: this.pixels }) }; } });
  vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => '' }));
  vi.stubGlobal('__BUILD_ID__', 'test');
  vi.stubGlobal('PX68K', (options: Record<string, unknown>) => factory({ ...options, locateFile: () => join(coreDir, 'px68k_libretro.wasm') }));
  try {
    await import('../src/core-worker');
    const send = (data: unknown) => worker.onmessage({ data });
    send({ kind: 'command', op: 'initialize', generation: 1, requestId: 1, payload: { coreBaseUrl: '/', biosIpl: bytes(asset('system/iplrom.dat')), biosCg: bytes(asset('system/cgrom.dat')), initialDisks: [{ slot: 'fdd0', name: 'human302.xdf', bytes: bytes(asset('system/human302.xdf')) }] } });
    await vi.waitFor(() => expect(responses.get(1)?.ok).toBe(true), { timeout: 30000 });
    for (const [key, value] of Object.entries(buildCoreOptions({ cpuSpeed: '16Mhz', ramSize: '2MB', joyType1CoreValue: 'Default (2 Buttons)', joyType2CoreValue: 'Default (2 Buttons)' }))) send({ kind: 'coreOptionUpdate', key, value });
    send({ kind: 'command', op: 'loadGame', generation: 1, requestId: 2, payload: { path: '/game/human302.xdf' } });
    await vi.waitFor(() => expect(responses.get(2)?.result).toBe(true), { timeout: 30000 });
    send({ kind: 'command', op: 'setRunning', generation: 1, requestId: 3, payload: { running: true } });
    while (count < 1202) { clock += 1; tick(); }
    expect(compared).toBe(1199);
    expect(rgba).toBeGreaterThan(0);

  } finally {
    date.mockRestore(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules();
    if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ;
  }
}, 180_000);
