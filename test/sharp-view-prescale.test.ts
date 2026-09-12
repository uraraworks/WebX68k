import { describe, expect, it } from 'vitest';
import { computePrescale } from '../src/sharp-view';

/*
 * computePrescale(): 実解像度→CSS表示サイズへの拡大のうち、最近傍で行うべき
 * 整数倍率(kx, ky)を求める。残りの端数倍だけがCSS側の補間(auto)に任される。
 */
describe('computePrescale', () => {
  it('768x512 を 4:3 で css 1536x1152, dpr 2 → 4倍', () => {
    expect(computePrescale(768, 512, 1536, 1152, 2)).toEqual({ kx: 4, ky: 4 });
  });

  it('768x512 を css 768x576, dpr 1 → 1倍', () => {
    expect(computePrescale(768, 512, 768, 576, 1)).toEqual({ kx: 1, ky: 1 });
  });

  it('768x512 を css 768x576, dpr 2 → 2倍', () => {
    expect(computePrescale(768, 512, 768, 576, 2)).toEqual({ kx: 2, ky: 2 });
  });

  it('512x512 を css 1365x1024 (4:3, 2倍), dpr 1 → 2倍', () => {
    expect(computePrescale(512, 512, 1365, 1024, 1)).toEqual({ kx: 2, ky: 2 });
  });

  it('dpr が 0/NaN のときは1として扱う', () => {
    expect(computePrescale(768, 512, 768, 512, 0)).toEqual({ kx: 1, ky: 1 });
    expect(computePrescale(768, 512, 768, 512, Number.NaN)).toEqual({ kx: 1, ky: 1 });
  });

  it('中間バッファが上限(1辺8192 / 総画素16,777,216)を超えないよう倍率を落とす', () => {
    const { kx, ky } = computePrescale(1024, 1024, 8000, 8000, 2);
    expect(1024 * kx).toBeLessThanOrEqual(8192);
    expect(1024 * ky).toBeLessThanOrEqual(8192);
    expect(1024 * kx * 1024 * ky).toBeLessThanOrEqual(16_777_216);
  });

  it('css が native より小さい(縮小)ときは1倍のまま', () => {
    expect(computePrescale(768, 512, 384, 256, 1)).toEqual({ kx: 1, ky: 1 });
  });
});
