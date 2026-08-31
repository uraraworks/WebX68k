// Worker側駆動ループ(段階移行 手順7)の純粋ロジックだけを切り出したモジュール。
//
// src/core-worker.ts は `self`/OffscreenCanvas/fetch に依存する実 Worker 専用のグローバル
// 環境で動くため、Node(vitest)から直接 import して単体テストするのは前例(test/
// core-worker-build-format.test.ts)でも避けている(静的検査に留めている)。ここでは
// 「遅れたフレームの取り戻し」と「frameバッファのプール」という、実際にはWorkerグローバルに
// 依存しない純粋なロジックだけを本体から切り離し、実行可能な単体テストの対象にする。
//
// runTick(): 既存メインループ(src/main.ts の loop())と同じ考え方(computeFrameBudget()に
// よる取り戻し)。1フレーム進める処理(runFrameOnce)を呼び出し側から注入してもらう形にして、
// 実コア(LibretroHost)に依存せずテストできるようにしてある。メインループと違い音声キューが
// 無いため、frameIntervalの±2%補正(音声キュー深さ由来)はここでは行わない
// (computeFrameBudget()にはqueued=0, speedMultiplier=1を渡す。docs/STORAGE-SCSI.md参照)。

import { computeFrameBudget } from './frameBudget';

// --- Worker注入レイテンシ対策 (2026-08-31、KeyBuf帰属計測での実測を受けての対応) --------
//
// Worker は単一スレッドなので、`runTick()` の while ループ(取り戻しで複数フレームを
// 連続実行する区間)の最中は `ctx.onmessage`(INPUT_UPDATE_KINDを含む)が一切割り込めない。
// 届いた入力更新はそのtickの実行が終わってから初めてイベントループに乗り、次tick以降の
// フレームで初めて反映される。取り戻しバーストが長いほど、その間に届いた入力の反映が
// 遅れる(親セッションが実測した「make注入フレーム数」の裾: 既定経路は1/1/1で決定的なのに対し
// Worker経路は中央2・最大13)。
//
// computeFrameBudget() 自体(既定経路のmain.ts loop()も使う共通ロジック)には手を入れない
// (docs/STORAGE-SCSI.md「決定C」: 取り戻しがあるからこそ55.5fpsを維持できているため、
// 取り戻し量そのものは変えてはいけない)。代わりに、runTick() 呼び出し側(Worker専用)が
// 1tickあたりに連続実行してよいフレーム数の上限を追加で絞り、余った取り戻し分は
// accumulatorへ持ち越して次tick(TICK_MS=16ms後の次のsetInterval発火、すなわち
// ctx.onmessageが割り込める本物のマクロタスク境界)へ回す。
//
// 値の根拠(シミュレーションで確認。docs/STORAGE-SCSI.md参照): X68000のfps=55.5
// (frameInterval=18.018ms) はTICK_MS=16msよりわずかに長いため、定常状態では1tickあたり
// 1フレーム未満〜1フレームしか要らない。上限を2に絞っても、dtに数百ms相当のスパイクを
// 注入したシミュレーションで実効fpsは55.5付近を維持したまま(取り戻しに要するtick数が
// 増えるだけで、取り戻しきれず恒常的に遅れていく退行は起きない)。
export const WORKER_MAX_FRAMES_PER_TICK = 2;

export interface DiskAccessFlags {
  fddReading: boolean;
  fddDrive: number;
  hddAccessing: boolean;
}

export interface TickResult {
  /** このtickで実際に進めたフレーム数。 */
  ranFrames: number;
  /** 次tickへ持ち越すaccumulator(秒)。 */
  accumulator: number;
  /** このtick内のいずれかのフレームでアクセスがあれば立つ(runFrame()直後でないと
   * コア側がクリアしてしまうため、tick内で複数フレーム進めた場合はORで合成する)。 */
  access: DiskAccessFlags;
}

const NO_ACCESS: DiskAccessFlags = { fddReading: false, fddDrive: -1, hddAccessing: false };

/**
 * 駆動ループ1tickぶんの取り戻しロジック。
 *
 * @param dt 前tickからの実経過秒(setIntervalの発火間隔そのものではなく、performance.now()の
 *   実測差分を渡すこと。タイマーの遅延・スロットリングを取り戻すにはこれが必須)。
 * @param fps コアの現在fps(host.avInfo?.fps)。
 * @param accumulatorIn 前tickから持ち越したaccumulator(秒)。
 * @param runFrameOnce 1フレーム進め、そのフレームのディスクアクセス状態を返すコールバック
 *   (呼び出し側が host.runFrame() + host.readDiskAccess() をまとめて渡す)。
 * @param maxFramesPerTick 1tickで連続実行してよいフレーム数の追加上限(省略時は無制限=
 *   computeFrameBudget()の値のみでクランプ)。Worker側のctx.onmessage割り込み不能区間を
 *   短く保つための呼び出し側ポリシー(WORKER_MAX_FRAMES_PER_TICK参照)。computeFrameBudget()
 *   による取り戻し量そのものは変えない(超過分はaccumulatorに残り次tickへ持ち越される)。
 */
export function runTick(
  dt: number,
  fps: number,
  accumulatorIn: number,
  runFrameOnce: () => DiskAccessFlags,
  maxFramesPerTick?: number,
): TickResult {
  const frameInterval = 1 / fps;
  let accumulator = accumulatorIn + dt;
  // 音声キュー未移行のため queued=0, speedMultiplier=1 固定(±2%補正なし。ファイル冒頭コメント参照)。
  const budget = computeFrameBudget(dt, frameInterval, 0, 1);
  const effectiveBudget = maxFramesPerTick !== undefined ? Math.min(budget, maxFramesPerTick) : budget;

  let ranFrames = 0;
  let fddReading = false;
  let fddDrive = -1;
  let hddAccessing = false;
  while (accumulator >= frameInterval && ranFrames < effectiveBudget) {
    const access = runFrameOnce();
    if (access.fddReading) {
      fddReading = true;
      fddDrive = access.fddDrive;
    }
    if (access.hddAccessing) hddAccessing = true;
    accumulator -= frameInterval;
    ranFrames++;
  }
  // 破綻(タブ非アクティブ復帰等)からの復帰。メインループのloop()と同じ保険。
  if (accumulator > frameInterval * 4) accumulator = 0;

  return {
    ranFrames,
    accumulator,
    access: ranFrames > 0 ? { fddReading, fddDrive, hddAccessing } : NO_ACCESS,
  };
}

/**
 * frame event で main へ転送する ArrayBuffer のプール(手順5「バッファ返却あり」)。
 * byteLength をキーにしたスタック。main が putImageData() し終えたバッファを release() で
 * 返してもらい、次の acquire() で使い回す。プールが空のときだけ新規確保し、その回数を
 * misses として数える(返却が黙って効かなくなったときに気づくための観測値。
 * docs/STORAGE-SCSI.md「決定」参照。GC スパイク低減の効果自体は未確認)。
 */
export class FrameBufferPool {
  private readonly pool = new Map<number, ArrayBuffer[]>();
  private missCount = 0;

  /** プールが空で新規確保した累積回数。 */
  get misses(): number {
    return this.missCount;
  }

  acquire(byteLength: number): ArrayBuffer {
    const list = this.pool.get(byteLength);
    if (list && list.length > 0) return list.pop()!;
    this.missCount++;
    return new ArrayBuffer(byteLength);
  }

  release(buffer: ArrayBuffer): void {
    const list = this.pool.get(buffer.byteLength);
    if (list) list.push(buffer);
    else this.pool.set(buffer.byteLength, [buffer]);
  }
}
