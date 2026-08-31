// 帰属計測(「注入の遅れ」「観測の遅れ」の切り分け)の純粋ロジック。
// Worker経路(src/core-worker.ts)と既定経路(src/libretro-host.ts / src/main.ts)の両方が
// 同じ定義・同じ数え方を使う必要がある(定義がずれると比較の意味が消えるため。
// docs/STORAGE-SCSI.md「帰属の定義」参照)ため、この1箇所に集約する。
//
// 単位は常に「コアが進めた累積フレーム数」(_retro_run() が完了した回数の通しカウンタ)。
// 別スレッド(Worker)のperformance.now()はtimeOriginが揃わないため時間では比較しない、
// という決定に基づく。

/** KeyBuf書き込みポインタの「動いたフレーム」追跡状態。sticky(動いていない間は前回値を保持)。 */
export interface KeyBufWriteTrackerState {
  /** 直近にチェックしたwritePointerの値。-1は「まだ一度もチェックしていない」を表す。 */
  lastWritePointer: number;
  /** writePointerが最後に動いた(=何かが書き込まれた)ときのフレーム番号。null=まだ未検出。 */
  writeFrameNo: number | null;
}

export function initialTrackerState(): KeyBufWriteTrackerState {
  return { lastWritePointer: -1, writeFrameNo: null };
}

/**
 * writePointerが前回チェック時点(state.lastWritePointer)から動いていれば、そのフレーム番号
 * (frameNo。呼び出し側は「このチェックに対応する現在のフレーム番号」を渡す)を「書かれた
 * フレーム」として更新した新しい state を返す。動いていなければ、既存の state をそのまま返す
 * (sticky: 前回検出済みの writeFrameNo を保持し続ける)。
 *
 * 副作用を持たない(呼び出し側で `state = trackKeyBufWrite(state, writePointer, frameNo)` と
 * 代入する)。src/core-worker.ts の sendFrame() 内の従来インライン実装と同じ意味を持つ
 * (2026-08-31 帰属計測のずれ防止のためここへ切り出し、Worker側もこの関数を使うよう揃えた)。
 */
export function trackKeyBufWrite(
  state: KeyBufWriteTrackerState,
  writePointer: number,
  frameNo: number,
): KeyBufWriteTrackerState {
  if (writePointer === state.lastWritePointer) return state;
  return { lastWritePointer: writePointer, writeFrameNo: frameNo };
}

/**
 * 2つのフレーム番号の差(帰属の基本単位)。どちらかが null/undefined(=未検出・計測不能)なら
 * null を返す(0 と未検出を混同しない)。
 *   注入フレーム数 = frameDelta(writeFrameNo, sendFrameNo)
 *   観測フレーム数 = frameDelta(observeFrameNo, writeFrameNo)
 */
export function frameDelta(
  laterFrameNo: number | null | undefined,
  earlierFrameNo: number | null | undefined,
): number | null {
  if (laterFrameNo === null || laterFrameNo === undefined) return null;
  if (earlierFrameNo === null || earlierFrameNo === undefined) return null;
  return laterFrameNo - earlierFrameNo;
}
