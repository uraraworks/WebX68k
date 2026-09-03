// buildRgb565Lut() の網羅テスト。65536値すべてについて、LUTの中身が
// handleVideoRefresh() の正典の変換式(RGB565→RGBA)と一致することを確認する。
// 期待値はここで独立に計算し、LUT側の実装は呼び出さない。

import { describe, expect, it } from 'vitest';
import { buildRgb565Lut } from '../src/rgb565.ts';

describe('buildRgb565Lut', () => {
  it('リトルエンディアン: 全65536値でRGBAバイト列が正典の式と一致する', () => {
    const lut = buildRgb565Lut(true);
    expect(lut.length).toBe(65536);
    for (let px = 0; px < 65536; px++) {
      const r5 = (px >> 11) & 0x1f;
      const g6 = (px >> 5) & 0x3f;
      const b5 = px & 0x1f;
      const r = (r5 << 3) | (r5 >> 2);
      const g = (g6 << 2) | (g6 >> 4);
      const b = (b5 << 3) | (b5 >> 2);

      const v = lut[px];
      const byte0 = v & 0xff; // R
      const byte1 = (v >>> 8) & 0xff; // G
      const byte2 = (v >>> 16) & 0xff; // B
      const byte3 = (v >>> 24) & 0xff; // A

      expect(byte0).toBe(r);
      expect(byte1).toBe(g);
      expect(byte2).toBe(b);
      expect(byte3).toBe(255);
    }
  });

  it('ビッグエンディアン: 全65536値でRGBAバイト列が正典の式と一致する', () => {
    const lut = buildRgb565Lut(false);
    expect(lut.length).toBe(65536);
    for (let px = 0; px < 65536; px++) {
      const r5 = (px >> 11) & 0x1f;
      const g6 = (px >> 5) & 0x3f;
      const b5 = px & 0x1f;
      const r = (r5 << 3) | (r5 >> 2);
      const g = (g6 << 2) | (g6 >> 4);
      const b = (b5 << 3) | (b5 >> 2);

      const v = lut[px];
      const byte0 = (v >>> 24) & 0xff; // R
      const byte1 = (v >>> 16) & 0xff; // G
      const byte2 = (v >>> 8) & 0xff; // B
      const byte3 = v & 0xff; // A

      expect(byte0).toBe(r);
      expect(byte1).toBe(g);
      expect(byte2).toBe(b);
      expect(byte3).toBe(255);
    }
  });
});
