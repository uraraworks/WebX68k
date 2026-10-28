import { expect, it, vi } from 'vitest';
import { LibretroHost } from '../src/libretro-host';

it('メイン側は非表示中の最終生画像を dupe 後の復帰時に提示する', () => {
  const put = vi.fn();
  const presented = vi.fn();
  const ctx = { createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }), putImageData: put };
  const canvas = { width: 1, height: 1, getContext: () => ctx } as unknown as HTMLCanvasElement;
  const host = new LibretroHost(canvas, () => {});
  const heap = new Uint16Array(32);
  (host as any).mod = { HEAPU16: heap };
  host.onFramePresented = presented;
  const refresh = (data: number) => (host as any).handleVideoRefresh(data, 2, 1, 6);
  host.setVideoHidden(true);
  heap.set([0xf800, 0x07e0], 2);
  refresh(4);
  heap.set([0x001f, 0xffff], 2);
  refresh(4);
  host.setVideoSkip(true);
  refresh(0);
  expect(put).not.toHaveBeenCalled();
  expect(presented).not.toHaveBeenCalled();
  expect(host.setVideoHidden(false)).toBe(true);
  expect(put).toHaveBeenCalledTimes(1);
  expect(presented).toHaveBeenCalledTimes(1);
  expect([...put.mock.calls[0][0].data]).toEqual([0, 0, 255, 255, 255, 255, 255, 255]);
});
