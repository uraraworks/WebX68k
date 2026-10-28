import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import type { LibretroHost as Host, PX68KModule } from '../src/libretro-host';
import { buildCoreOptions } from '../src/core-options';
import { RETROK } from '../src/keyboard';

vi.mock('../src/scsi-opfs', () => ({ setupScsiOpfs: async () => ({ mode: 'none' }) }));
vi.mock('../src/hostfs/worker-bridge', async (original) => ({ ...(await original()), installHostFsBridge: () => ({ installed: false }) }));

const asset = (path: string) => readFileSync(fileURLToPath(new URL(`../public/${path}`, import.meta.url)));
const bytes = (data: Buffer) => Uint8Array.from(data).buffer;

async function checkVisibility(changes: boolean) {
  const { LibretroHost } = await import('../src/libretro-host');
  const golden: { video: string }[] = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/golden-av-trace.json', import.meta.url)), 'utf8'));
  const path = fileURLToPath(new URL('../public/core/px68k_libretro.js', import.meta.url));
  const module = { exports: {} as unknown };
  runInThisContext(`(function(module,exports,require,__filename,__dirname){${readFileSync(path, 'utf8')}\n})`, { filename: path })(module, module.exports, createRequire(path), path, dirname(path));
  const factory = module.exports as (options: Record<string, unknown>) => Promise<PX68KModule>;
  let now = 946684800000, clock = 1, tick = () => {}, count = 0;
  let pixels = Buffer.alloc(0), width = 0, height = 0, compared = 0, rgba = 0;
  let hidden = false, resumed = false, hiddenAudio = 0, hiddenFrames = 0, resumeHash = '', resumeFrame = -1;
  const responses = new Map<number, any>();
  const previousTZ = process.env.TZ;
  process.env.TZ = 'UTC';
  const date = vi.spyOn(Date, 'now').mockImplementation(() => now);
  // 実コアはディスク名を表示するため、Worker の接頭辞をゴールデンの名前に揃える。
  const originalDisk = LibretroHost.prototype.writeDiskImage;
  vi.spyOn(LibretroHost.prototype, 'writeDiskImage').mockImplementation(function (this: Host, name, data) { return originalDisk.call(this, name.replace(/^fdd0_/, ''), data); });
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
      if (frame.video.kind === 'rgba') {
        const video = frame.video;
        pixels = Buffer.from(video.bytes.slice(0)); width = video.width; height = video.height; rgba++;

        const returned = structuredClone(video.bytes, { transfer: [video.bytes] });
        expect(video.bytes.byteLength).toBe(0);
        worker.onmessage({ data: { kind: 'returnFrameBuffer', buffer: returned } });
      }
      const digest = createHash('sha256').update(`${width}x${height}:`).update(pixels).digest('hex');
      if (hidden) {
        expect(frame.video.kind).toBe('offscreen');
        hiddenFrames++;
        hiddenAudio += frame.audio.sampleFrames;
      } else if (resumed && !resumeHash && frame.video.kind === 'rgba') {
        resumeHash = digest; resumeFrame = count;
      }

    },
  };
  // 復帰直後の dupe で変換を延期し、変更フラグが次のフレームまで保持されることを検証する。
  const proto = LibretroHost.prototype as any;
  const videoRefresh = proto.handleVideoRefresh;
  vi.spyOn(proto, 'handleVideoRefresh').mockImplementation(function (this: Host, data: number, width: number, height: number, pitch: number) {
    videoRefresh.call(this, changes && count === 1016 ? 0 : data, width, height, pitch);
  });
  vi.spyOn(LibretroHost.prototype, 'runFrame').mockImplementation(function (this: Host) {
    const keys = [RETROK.d, RETROK.i, RETROK.r, RETROK.RETURN];
    const pos = count - 900;
    if (pos >= 0 && pos < 48 && (pos % 12 === 0 || pos % 12 === 6)) {
      worker.onmessage({ data: { kind: 'inputUpdate', update: { keys: pos % 12 === 0 ? [keys[Math.floor(pos / 12)]] : [], pads: [0, 0], mouseButtons: { left: false, right: false }, mouseDelta: { dx: 0, dy: 0 }, inputGeneration: 0, keyMakes: [] } } });
    }
    count++; now += 18; originalRun.call(this);

  });
  vi.stubGlobal('self', worker);
  vi.stubGlobal('OffscreenCanvas', class { width = 1; height = 1; pixels = new Uint8ClampedArray(); getContext() { return { createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }), putImageData: (img: ImageData) => { this.pixels = new Uint8ClampedArray(img.data); }, getImageData: () => ({ data: this.pixels }) }; } });
  vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => '' }));
  vi.stubGlobal('__BUILD_ID__', 'test');
  vi.stubGlobal('PX68K', (options: Record<string, unknown>) => factory({ ...options, locateFile: () => fileURLToPath(new URL('../public/core/px68k_libretro.wasm', import.meta.url)) }));
  try {
    await import('../src/core-worker');
    const send = (data: unknown) => worker.onmessage({ data });
    send({ kind: 'command', op: 'initialize', generation: 1, requestId: 1, payload: { coreBaseUrl: '/', biosIpl: bytes(asset('system/iplrom.dat')), biosCg: bytes(asset('system/cgrom.dat')), initialDisks: [{ slot: 'fdd0', name: 'human302.xdf', bytes: bytes(asset('system/human302.xdf')) }] } });
    await vi.waitFor(() => expect(responses.get(1)?.ok).toBe(true), { timeout: 30000 });
    for (const [key, value] of Object.entries(buildCoreOptions({ cpuSpeed: '16Mhz', ramSize: '2MB', joyType1CoreValue: 'Default (2 Buttons)', joyType2CoreValue: 'Default (2 Buttons)' }))) send({ kind: 'coreOptionUpdate', key, value });
    send({ kind: 'command', op: 'loadGame', generation: 1, requestId: 2, payload: { path: '/game/human302.xdf' } });
    await vi.waitFor(() => expect(responses.get(2)?.result).toBe(true), { timeout: 30000 });
    send({ kind: 'command', op: 'setRunning', generation: 1, requestId: 3, payload: { running: true } });
    const start = changes ? 1000 : 1040;
    const end = changes ? 1015 : 1050;
    while (count < start) { clock += 1; tick(); }
    hidden = true;
    send({ kind: 'visibilityUpdate', hidden: true });
    while (count < end) { clock += 1; tick(); }
    hidden = false; resumed = true;
    send({ kind: 'visibilityUpdate', hidden: false });
    expect(hiddenFrames).toBeGreaterThan(0);
    expect(hiddenAudio).toBeGreaterThan(0);
    if (changes) {
      expect(golden[end - 1].video).not.toBe(golden[start - 1].video);
      expect(resumeHash).toBe('');
      while (!resumeHash && count < end + 20) { clock += 1; tick(); }
      expect(resumeFrame).toBeGreaterThan(end);
    } else {
      expect(resumeFrame).toBe(end);
    }
    expect(resumeHash).toBe(golden[resumeFrame - 1].video);

  } finally {
    date.mockRestore(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules();
    if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ;
  }
}

it('非表示中の画面変化を復帰後の最初の映像に反映する', () => checkVisibility(true), 180_000);
it('非表示中に画面が変わらなければ復帰時に映像を送る', () => checkVisibility(false), 180_000);
