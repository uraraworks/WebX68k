// メインループの1tickあたりに実行してよいフレーム数(budget)の計算。
// rAF が 30Hz 等に落ちる環境(低電力モード/サーマルスロットリング)でも
// 供給不足が起きないよう、固定値ではなく実測dtから必要フレーム数を導出する。
// 純粋関数として切り出してユニットテスト可能にしてある。

import { AudioEngine } from './audio';

/**
 * @param dt 前フレームからの経過時間(秒)
 * @param frameInterval エミュレーション1フレームぶんの目標間隔(秒)。fps・speedMultiplier・
 *   音声キューによる±2%補正込みで呼び出し側が計算済みのもの。
 * @param queued 音声キューの滞留量(秒)
 * @param speedMultiplier 実効速度倍率。上限クランプの緩和に使う
 */
export function computeFrameBudget(
  dt: number,
  frameInterval: number,
  queued: number,
  speedMultiplier: number,
): number {
  // 音声キューが溢れ気味なら供給を止める(既存の抑制ロジックを維持)。
  if (queued > AudioEngine.MAX_LATENCY_SEC * 0.8) return 0;

  // dt/frameInterval が不正な値(NaN/Infinity)を生まないようにガードする。
  // タブ復帰直後などで dt が異常値になっても、ここでは単に「最低1」に丸める。
  if (!Number.isFinite(dt) || dt <= 0 || !Number.isFinite(frameInterval) || frameInterval <= 0) {
    return 1;
  }

  let needed = Math.ceil(dt / frameInterval) + 1;
  // 音声キューが枯渇気味なら1フレーム多く回して追い込む。
  if (queued < AudioEngine.TARGET_LATENCY_SEC * 0.4) needed += 1;

  // タブ復帰直後等でdtが数秒に跳ねても、1tickで数百フレーム回してフリーズしないための上限。
  const maxBudget = Math.max(2, Math.ceil(8 * speedMultiplier));
  return Math.min(needed, maxBudget);
}
