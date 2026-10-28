import { expect, it, vi } from 'vitest';
import { LibretroHost } from '../src/libretro-host';

function createHost() {
  const put = vi.fn();
  const ctx = { createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }), putImageData: put };
  const canvas = { width: 1, height: 1, getContext: () => ctx } as unknown as HTMLCanvasElement;
  return { host: new LibretroHost(canvas, () => {}), put };
}

it('非表示中のフレームと dupe は画素を読まない', () => {
  const { host } = createHost();
  const readHeap = vi.fn(() => { throw new Error('非表示中に画素を読んだ'); });
  (host as any).mod = { get HEAPU16() { return readHeap(); } };
  host.setVideoHidden(true);
  (host as any).handleVideoRefresh(4, 2, 1, 6);
  (host as any).handleVideoRefresh(0, 2, 1, 6);
  expect(readHeap).not.toHaveBeenCalled();
});

it('非表示中の reset 後は古いフレームを復帰時に提示しない', () => {
  const { host, put } = createHost();
  const reset = vi.fn();
  const readHeap = vi.fn(() => new Uint16Array(32));
  (host as any).mod = { get HEAPU16() { return readHeap(); }, _retro_reset: reset };
  host.setVideoHidden(true);
  (host as any).handleVideoRefresh(4, 2, 1, 6);
  host.reset();
  expect(reset).toHaveBeenCalledOnce();
  expect(host.setVideoHidden(false)).toBe(false);
  expect(readHeap).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
});
