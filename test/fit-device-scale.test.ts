import { describe, expect, it } from 'vitest';
import { DEVICE_SNAP_TOLERANCE, fitDeviceScale, pickUpscale } from '../src/aspect';

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

/*
 * pickUpscale(): 1倍以上のスケールの決め方。整数倍(n=round(fit))の近傍(目標サイズ
 * 基準でINTEGER_SNAP_PX=16px以内)なら吸着してドットのまま、それ以外は縦横比を保った
 * 端数倍のままシャープ・バイリニア表示(smooth)に委ねる。target は WebX68k の
 * reserveTarget(4:3基準の目標サイズ)相当として 768x576 を例に使う。
 */
describe('pickUpscale', () => {
  it('ちょうど整数倍(fit=2.0)は吸着してsmooth=false', () => {
    expect(pickUpscale(2.0, 768, 576)).toEqual({ scale: 2, smooth: false });
  });

  it('ちょうど1.0倍はそのまま1倍', () => {
    expect(pickUpscale(1.0, 768, 576)).toEqual({ scale: 1, smooth: false });
  });

  it('整数倍との差が16px以内(下方向、fit=1.98)なら吸着する', () => {
    // n=2との差0.02 * 768 = 15.36px <= 16px
    const r = pickUpscale(1.98, 768, 576);
    expect(r).toEqual({ scale: 2, smooth: false });
  });

  it('整数倍との差が16px以内(上方向、fit=2.02)なら吸着する', () => {
    // n=2との差0.02 * 768 = 15.36px <= 16px
    const r = pickUpscale(2.02, 768, 576);
    expect(r).toEqual({ scale: 2, smooth: false });
  });

  it('整数倍との差が大きい(fit=1.5)ときは端数倍のまま補間', () => {
    const r = pickUpscale(1.5, 768, 576);
    expect(r.smooth).toBe(true);
    expect(r.scale).toBe(1.5);
  });

  it('1673x1232ウィンドウ相当の1.917倍(768x576)は端数のまま補間', () => {
    // n=2との差0.083 * 768 ≒ 63.7px > 16px なので吸着しない。
    const r = pickUpscale(1.917, 768, 576);
    expect(r.smooth).toBe(true);
    expect(r.scale).toBe(1.917);
  });
});
