import { describe, expect, it } from 'vitest';
import { DEVICE_SNAP_TOLERANCE, fitDeviceScale } from '../src/aspect';

/*
 * fitDeviceScale(): 端数倍のときに「物理ピクセルで整数倍」へ寄せる判定。
 * 寄せられない(ロスが大きい)ときは端数のまま使い、補間(smooth)へ落としてモアレを消す。
 * 最近傍のまま端数倍にすると、1ドット幅の線や市松が周期的に間引かれて見える。
 */
describe('fitDeviceScale', () => {
  it('物理倍率が整数に近ければ切り下げてスナップし、最近傍のままにする', () => {
    // DPR2 / rawScale 0.5375 → 物理 1.075 (ロス7%)
    const got = fitDeviceScale(0.5375, 2);
    expect(got).toEqual({ scale: 0.5, smooth: false });
  });

  it('ロスが大きいときは面積を優先して端数のまま使い、補間へ落とす', () => {
    // DPR2 / rawScale 0.573 → 物理 1.146 (ロス13%)
    const got = fitDeviceScale(0.573, 2);
    expect(got).toEqual({ scale: 0.573, smooth: true });
  });

  it('1倍以上(没入モードの端数倍)にも効く', () => {
    // DPR2 / rawScale 1.55 → 物理 3.1 (ロス3%) → 1.5倍へスナップ
    expect(fitDeviceScale(1.55, 2)).toEqual({ scale: 1.5, smooth: false });
    // DPR2 / rawScale 1.7 → 物理 3.4 (ロス12%) → 端数のまま補間
    expect(fitDeviceScale(1.7, 2)).toEqual({ scale: 1.7, smooth: true });
  });

  it('物理倍率が1未満まで小さいとスナップ先が無いので補間へ落とす', () => {
    expect(fitDeviceScale(0.4, 2)).toEqual({ scale: 0.4, smooth: true });
  });

  it('既に物理整数倍ならそのまま(最近傍を保つ)', () => {
    expect(fitDeviceScale(2, 1)).toEqual({ scale: 2, smooth: false });
    expect(fitDeviceScale(1, 3)).toEqual({ scale: 1, smooth: false });
    // 浮動小数の誤差で1段落ちないこと(3 * (1/3) は 0.9999... になりうる)
    expect(fitDeviceScale(1 / 3, 3).smooth).toBe(false);
  });

  it('DPRが取れない/異常値のときは1として扱う', () => {
    for (const dpr of [0, -1, Number.NaN]) {
      expect(fitDeviceScale(2.05, dpr)).toEqual({ scale: 2, smooth: false });
    }
  });

  it('スナップは必ず切り下げ(元の倍率を超えない=はみ出さない)', () => {
    for (const dpr of [1, 2, 3]) {
      for (let raw = 0.3; raw <= 4; raw += 0.017) {
        const got = fitDeviceScale(raw, dpr);
        expect(got.scale).toBeLessThanOrEqual(raw + 1e-9);
        expect(got.scale).toBeGreaterThan(0);
        // スナップしたなら、ロスは許容率以内でなければならない。
        if (!got.smooth) expect((raw - got.scale) / raw).toBeLessThanOrEqual(DEVICE_SNAP_TOLERANCE + 1e-9);
      }
    }
  });
});
