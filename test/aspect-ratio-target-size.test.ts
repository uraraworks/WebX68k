import { describe, expect, it } from 'vitest';
import { getTargetSize, resolveAspectMode } from '../src/aspect';

// getTargetSize() は src/aspect.ts に切り出した DOM 非依存の純関数(main.ts からは
// getTargetSize(aspectMode, w, h) の形で呼ばれる)。main.ts 自体はモジュール初期化時に
// DOM要素を直接 querySelector するなどして副作用を起こすため、Node環境(vitest
// environment: 'node')には直接importできない(gamepad.test.ts の既存テストと同じ制約)が、
// aspect.ts はDOMに触れないためここで直接importして製品コードそのものを検証できる。
//
// 検証したい不変条件は「4:3化は常に拡大方向で行い、どちらの軸も縮小しない」こと。
// canvas は style.css で image-rendering: pixelated(最近傍補間)にしているため、
// 縮小方向で4:3化すると1ドット幅の縦線が間引かれて消え、テキスト画面の文字が潰れる
// 不具合を実機で踏んだ(2026-08)。将来また縮小方向に戻されないよう、ここで固定する。

describe('4:3表示モードの目標サイズ(src/aspect.ts の getTargetSize)', () => {
  it('512x512(アスペクト比 < 4/3)は縦を保ち横を広げる(683x512)', () => {
    const result = getTargetSize('4:3', 512, 512);
    expect(result.height).toBe(512);
    expect(result.width).toBeCloseTo((512 * 4) / 3, 6);
    expect(result.width).toBeGreaterThan(512); // 縮小になっていないこと
  });

  it('768x512(アスペクト比 > 4/3)は横を保ち縦を伸ばす(768x576)', () => {
    const result = getTargetSize('4:3', 768, 512);
    expect(result.width).toBe(768);
    expect(result.height).toBeCloseTo(576, 6);
    expect(result.height).toBeGreaterThan(512); // 縮小になっていないこと
  });

  it('640x480(ちょうど4/3)は変化なし', () => {
    const result = getTargetSize('4:3', 640, 480);
    expect(result.width).toBe(640);
    expect(result.height).toBe(480);
  });

  it('どのケースでも元の実解像度を下回らない(縮小しない)', () => {
    const cases: Array<[number, number]> = [
      [512, 512],
      [256, 256],
      [768, 512],
      [1024, 848],
      [640, 480],
    ];
    for (const [w, h] of cases) {
      const result = getTargetSize('4:3', w, h);
      expect(result.width).toBeGreaterThanOrEqual(w);
      expect(result.height).toBeGreaterThanOrEqual(h);
    }
  });

  it("'native' モードでは補正せずそのまま返す", () => {
    const cases: Array<[number, number]> = [
      [512, 512],
      [768, 512],
      [1024, 848],
    ];
    for (const [w, h] of cases) {
      const result = getTargetSize('native', w, h);
      expect(result).toEqual({ width: w, height: h });
    }
  });
});

// 表示モードの既定値判定(src/aspect.ts の resolveAspectMode)。
// localStorage 未設定(初回起動)時の既定は '4:3'(実機モニタ相当)。
// 2026-09-12 (bc9498d) のシャープ・バイリニア導入で4:3表示のぼやけが解消したため、
// 2026-09-13 に既定を native から 4:3 へ変更した(2026-08 時点では既存ユーザーの見た目を
// 変えないことを優先して native を既定にしていた)。
// native は明示的に選ぶオプション。
// ただし既に明示的に選んで保存済みの値がある場合はそれを尊重し、上書きしないこと。
describe('表示モードの既定値判定(src/aspect.ts の resolveAspectMode)', () => {
  it('localStorage 未設定(null)のときは既定の 4:3 になる', () => {
    expect(resolveAspectMode(null)).toBe('4:3');
  });

  it('不正な値が保存されていた場合も既定の 4:3 にフォールバックする', () => {
    expect(resolveAspectMode('bogus')).toBe('4:3');
    expect(resolveAspectMode('')).toBe('4:3');
  });

  it("保存済みの 'native' は尊重され、既定値で上書きされない", () => {
    expect(resolveAspectMode('native')).toBe('native');
  });

  it("保存済みの '4:3' はそのまま尊重される", () => {
    expect(resolveAspectMode('4:3')).toBe('4:3');
  });
});
