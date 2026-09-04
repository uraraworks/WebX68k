// メインループの1tickあたりに実行してよいフレーム数(budget)の計算。
// rAF が 30Hz 等に落ちる環境(低電力モード/サーマルスロットリング)でも
// 供給不足が起きないよう、固定値ではなく実測dtから必要フレーム数を導出する。
// 純粋関数として切り出してユニットテスト可能にしてある。

import { AudioEngine } from './audio';

/**
 * 無制限速度モードで1tickに使ってよい main スレッド時間の**総量**(ms)。
 * コア実行(retro_run() の連打)だけでなく、画面提示(RGB565→RGBA変換+putImageData)の
 * コストもこの予算に含める。
 *
 * 無制限モードには「目標倍率」が無いため computeFrameBudget() のフレーム数ベースの
 * 計算は使わず、この時間予算いっぱいまで retro_run() を回し続ける別経路(main.ts の
 * loop())を通る。ただし予算が無制限では rAF の1tickを丸ごと食い潰して画面もUI操作も
 * 固まってしまうため、無制限モードでも上限は必ず要る。ホストが速いほどこの予算内で
 * 多くフレームを回せる=処理速度がホストのスペック任せになる、という意味での「無制限」。
 *
 * 【2026-09-03 実測(513tick分の中央値)による設計ミスの修正】
 * 旧実装は本定数を「コア実行だけの予算」として使い、画面提示のコスト(putImageData含め
 * 毎tick 6.56ms)を予算の外に置いていた。結果、tick間隔(dt)19.74msの内訳が
 *   コア実行 12.37ms(予算10msを2.4ms超過) + 画面提示 6.56ms = 19.74ms
 * となり、メインスレッド占有率が95.9%に達した。60Hz rAF の1周期(16.7ms)に対して
 * 19.74msは1周期を超えており、ページが外部からの単純なJS実行(45秒タイムアウト)すら
 * 受け付けなくなるほど操作不能になった。
 *
 * 対策として、画面提示のコストも本定数の予算内に含めて配分するよう main.ts 側を変更した。
 * 12ms/16.7ms ≈ 72% であり、95.9%(操作不能だった実測値)より十分低い。
 */
export const UNLIMITED_TICK_BUDGET_MS = 12;

/**
 * 無制限モードで画面を提示する最小間隔(ms)。33ms ≈ 30fps。
 *
 * 画面提示(RGB565→RGBA変換+putImageData)は実測6.56ms/回という固定費が大きく、
 * 毎tick行うとコア実行に回せる時間がほとんど残らない。fps上限を30に落として
 * 固定費の支払い頻度を半分にし、コア実行側に予算を残す。
 */
export const UNLIMITED_PRESENT_INTERVAL_MS = 33;

/**
 * 無制限モードで main スレッドを占有してよい割合の上限。
 *
 * 無制限モードは呼ばれるたびに UNLIMITED_TICK_BUDGET_MS を使い切るため、駆動経路の数と
 * 頻度がそのまま占有率になる。WebX68k には rAF・setTimeout(32)・AudioWorklet の tick という
 * 3つの駆動経路があり、2026-09-03 の実測では 96 tick/秒・占有率 99.8% まで上がって
 * ページが操作不能になった(rAF 60→8.4fps、setTimeout(0) の遅延 0.1→229ms)。
 * 予算だけでは頻度を抑えられないので、実時間に対する占有率で上限を掛ける。
 */
export const UNLIMITED_MAX_DUTY = 0.7;

/**
 * 【2026-09-04 実測による修正: 「1tickの中に収める」という設計そのものが誤りだった】
 *
 * 旧実装は `workerUnlimitedBudgetMs(tickMs) = tickMs(16) * WORKER_UNLIMITED_MAX_DUTY(0.7)
 * = 11.2ms` を1tickの予算とし、さらに「入らないフレームは始めない」ために予算から
 * 1フレームぶんの見込みコストを引いてdeadlineを決めていた(runUnlimitedTick()参照)。
 *
 * 実機計測(Worker経路、workerStats().frameNoの増分で実測):
 *   等倍 55.6fps / 2倍 110.3fps(正しく2倍) / 4倍 122.7fps(頭打ち=この環境の上限)
 *   無制限 62.5fps ← 2倍より遅い。全く機能していなかった
 *
 * 上限122.7fpsから逆算すると、この環境の1フレームのコストは約8.3ms。旧予算11.2msから
 * 「1フレームぶん(8.3ms)を引いたdeadline」は2.9msしか残らず、2フレーム目のコストは
 * 原理的に賄えない。結果「1tickにつき必ず1フレームしか回らない」状態になり、
 * 1フレーム/tick × 62.5tick/秒 = 62.5fps という観測値と完全に一致する。
 *
 * フレーム単価がtickの刻み(16ms)の半分を超える環境では、「1tickの中に収める」設計は
 * 原理的に複数フレームを回せない。無制限モードは刻みをまたいで回り続けられないと
 * 意味が無いため、tick間隔に縛られない絶対値の予算に切り替えた
 * (WORKER_UNLIMITED_TICK_BUDGET_MS)。占有率の上限は「1tickの中の割合」ではなく
 * 「実際にかかった時間から、次に走ってよい時刻を決める」方式(master(既定経路)の
 * main.tsのunlimitedNextAllowedAtと同じ考え方。ただし定数はWorker用に別途決める。
 * runUnlimitedTick()参照)に変えた。
 */

/**
 * Worker経路(?worker=1)の無制限速度モードで、1tickあたりretro_run()に使ってよい絶対時間(ms)。
 * tick間隔(TICK_MS=16ms)には縛られない: 上のコメントの通り、tick間隔に収めようとすると
 * フレーム単価が刻みの半分を超える環境で1フレームしか回せなくなる。
 *
 * 初期値33 = 表示1コマ(約16.7ms)の2つぶん。実機で観測したフレーム単価(約8.3ms)なら
 * 33ms予算で4フレーム程度入る見込み(実測では「入らないフレームは始めない」判定の
 * 余裕分だけ少なくなる)。
 */
export const WORKER_UNLIMITED_TICK_BUDGET_MS = 33;

/**
 * 無制限モードでWorkerがretro_run()に使ってよい、実時間に対する占有率の上限。
 *
 * 「1tickの中の割合」ではなく「実時間に対して retro_run に使ってよい割合」に意味を変えた
 * (上のコメント参照)。1tickぶんの予算(WORKER_UNLIMITED_TICK_BUDGET_MS)を使い切った後、
 * 実際にかかった時間costMsから `次に走ってよい時刻 = tick開始時刻 + costMs / この値` を
 * 求め、それより前のtickは何もせず即座に戻る(runUnlimitedTick()参照)。
 *
 * master(既定経路のUNLIMITED_MAX_DUTY=0.7)より高い0.9にしている: Workerはメインスレッドの
 * ようにUIや画面提示を同居させていない(画面提示はメイン側の別スレッドの仕事)ため、
 * イベントループを明け渡す猶予をより多く占有に回せる。
 */
export const WORKER_UNLIMITED_MAX_DUTY = 0.9;

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
