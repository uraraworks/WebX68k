import { describe, expect, it } from 'vitest';
import { computeFrameBudget } from '../src/frameBudget';
import { AudioEngine } from '../src/audio';

// 60Hz相当のフレーム間隔(speedMultiplier=1時の既定fps)
const FRAME_INTERVAL_60HZ = 1 / 60;
// 通常時(過多でも枯渇でもない)のキュー滞留量
const NORMAL_QUEUED = AudioEngine.TARGET_LATENCY_SEC;

describe('computeFrameBudget', () => {
  it('60Hz相当(dt≈16ms)では通常のbudgetを返す', () => {
    const budget = computeFrameBudget(1 / 60, FRAME_INTERVAL_60HZ, NORMAL_QUEUED, 1);
    expect(budget).toBe(2);
  });

  it('30Hz相当(dt≈33ms)では60Hz相当よりも多いフレーム数を返す(供給不足を埋める)', () => {
    const budget60 = computeFrameBudget(1 / 60, FRAME_INTERVAL_60HZ, NORMAL_QUEUED, 1);
    const budget30 = computeFrameBudget(1 / 30, FRAME_INTERVAL_60HZ, NORMAL_QUEUED, 1);
    expect(budget30).toBeGreaterThan(budget60);
    expect(budget30).toBe(3);
  });

  it('dt=5秒(タブ復帰直後等)ではクランプが効き、maxBudgetを超えない', () => {
    const budget = computeFrameBudget(5, FRAME_INTERVAL_60HZ, NORMAL_QUEUED, 1);
    const maxBudget = Math.max(2, Math.ceil(8 * 1));
    expect(budget).toBe(maxBudget);
    expect(budget).toBeLessThan(100);
  });

  it('音声キューが溢れ気味(MAX_LATENCY_SECの80%超)なら0を返す', () => {
    const overQueued = AudioEngine.MAX_LATENCY_SEC * 0.85;
    const budget = computeFrameBudget(1 / 60, FRAME_INTERVAL_60HZ, overQueued, 1);
    expect(budget).toBe(0);
  });

  it('音声キューが枯渇気味(TARGET_LATENCY_SECの40%未満)なら通常より+1される', () => {
    const starvedQueued = AudioEngine.TARGET_LATENCY_SEC * 0.3;
    const normalBudget = computeFrameBudget(1 / 60, FRAME_INTERVAL_60HZ, NORMAL_QUEUED, 1);
    const starvedBudget = computeFrameBudget(1 / 60, FRAME_INTERVAL_60HZ, starvedQueued, 1);
    expect(starvedBudget).toBe(normalBudget + 1);
  });

  it('speedMultiplier=4ではクランプ上限が比例して緩む', () => {
    const budget = computeFrameBudget(5, FRAME_INTERVAL_60HZ, NORMAL_QUEUED, 4);
    const maxBudget = Math.max(2, Math.ceil(8 * 4));
    expect(maxBudget).toBe(32);
    expect(budget).toBe(32);
  });

  it('dt=0では最低1を返しNaN/Infinityにならない', () => {
    const budget = computeFrameBudget(0, FRAME_INTERVAL_60HZ, NORMAL_QUEUED, 1);
    expect(budget).toBe(1);
    expect(Number.isFinite(budget)).toBe(true);
  });

  it('dt=NaNでは最低1を返しNaN/Infinityにならない', () => {
    const budget = computeFrameBudget(NaN, FRAME_INTERVAL_60HZ, NORMAL_QUEUED, 1);
    expect(budget).toBe(1);
    expect(Number.isFinite(budget)).toBe(true);
  });

  it('frameInterval=0でもガードが効き最低1を返す', () => {
    const budget = computeFrameBudget(1 / 60, 0, NORMAL_QUEUED, 1);
    expect(budget).toBe(1);
    expect(Number.isFinite(budget)).toBe(true);
  });

  it('dt負値でもガードが効き最低1を返す', () => {
    const budget = computeFrameBudget(-1, FRAME_INTERVAL_60HZ, NORMAL_QUEUED, 1);
    expect(budget).toBe(1);
  });
});
