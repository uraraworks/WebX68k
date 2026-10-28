// 実 Worker のメッセージ処理と駆動タイマーを通す。コアと canvas はスタブ。
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ frames: 0 }));
vi.mock('../src/scsi-opfs', () => ({ setupScsiOpfs: async () => ({ mode: 'none' }) }));
vi.mock('../src/hostfs/worker-bridge', () => ({ installHostFsBridge: () => ({ installed: false }) }));
vi.mock('../src/libretro-host', () => ({
  LibretroHost: class {
    avInfo = { fps: 60, sampleRate: 44100 };
    async init() {}
    writeFile() {}
    fetchAvInfo() { return this.avInfo; }
    runFrame() { state.frames++; }
    readDiskAccess() { return { fddReading: false, fddDrive: -1, hddAccessing: false }; }
    readDirtyState() { return { fddMask: 0, hdd: false }; }
    scsiBootControlTransferred() { return null; }
    serialGuestBaudRate() { return 0; }
    readTextScreen() { return { lines: ['paused'] }; }
    dispose() {}
  },
}));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

it('停止中は駆動タイマーが起きず、コマンドが応答し、再開直後に追いかけ実行しない', async () => {
  vi.useFakeTimers();
  state.frames = 0;
  const sent: any[] = [];
  const worker = { onmessage: null as any, postMessage: (message: unknown) => sent.push(message),
    setInterval, clearInterval, performance: { now: () => Date.now() } };
  vi.stubGlobal('self', worker);
  vi.stubGlobal('OffscreenCanvas', class { width = 1; height = 1; getContext() { return { getImageData: () => ({ data: new Uint8ClampedArray(4) }) }; } });
  vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => '' }));
  vi.stubGlobal('__BUILD_ID__', 'test');
  await import('../src/core-worker');
  const send = (data: unknown) => worker.onmessage({ data });
  send({ op: 'initialize', generation: 1, requestId: 1, payload: { coreBaseUrl: '/', biosIpl: new ArrayBuffer(0), biosCg: new ArrayBuffer(0) } });
  await vi.waitFor(() => expect(sent.find(m => m.requestId === 1)).toBeDefined());
  expect(sent.find(m => m.requestId === 1)?.ok).toBe(true);
  send({ op: 'setRunning', generation: 1, requestId: 2, payload: { running: true } });
  await vi.advanceTimersByTimeAsync(50);
  expect(state.frames).toBeGreaterThan(0);
  send({ kind: 'pauseUpdate', update: { paused: true } });
  expect(vi.getTimerCount()).toBe(0);
  const before = state.frames;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(state.frames).toBe(before);
  send({ op: 'readTextScreen', generation: 1, requestId: 3 });
  await vi.waitFor(() => expect(sent.some(m => m.requestId === 3 && m.ok)).toBe(true));
  send({ kind: 'pauseUpdate', update: { paused: false } });
  await vi.advanceTimersByTimeAsync(16);
  expect(state.frames).toBe(before);
  await vi.advanceTimersByTimeAsync(32);
  expect(state.frames - before).toBeLessThanOrEqual(2);
});
