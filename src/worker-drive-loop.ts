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
// (computeFrameBudget()にはqueued=0を渡す。docs/STORAGE-SCSI.md参照)。
//
// speedMultiplier(手順9で追加): 以前は1固定だった(「速度ボタンは未移行」)。呼び出し側
// (src/core-worker.ts)がSPEED_UPDATE_KINDで受け取った値をそのまま渡す。既定経路の
// loop()と同じ式(frameInterval = 1/(fps*speedMultiplier))をここでも使う。

import { computeFrameBudget } from './frameBudget';

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
 * @param speedMultiplier 実効速度倍率(1が等倍)。手順9で追加。0以下・非有限値は
 *   呼び出し側(src/core-worker.ts)で1に丸めてから渡すこと(ここでは丸めない)。
 * @param runFrameOnce 1フレーム進め、そのフレームのディスクアクセス状態を返すコールバック
 *   (呼び出し側が host.runFrame() + host.readDiskAccess() をまとめて渡す)。
 */
export function runTick(
  dt: number,
  fps: number,
  accumulatorIn: number,
  speedMultiplier: number,
  runFrameOnce: () => DiskAccessFlags,
): TickResult {
  const frameInterval = 1 / (fps * speedMultiplier);
  let accumulator = accumulatorIn + dt;
  // 音声キュー未移行のため queued=0 固定(±2%補正なし。ファイル冒頭コメント参照)。
  const budget = computeFrameBudget(dt, frameInterval, 0, speedMultiplier);

  let ranFrames = 0;
  let fddReading = false;
  let fddDrive = -1;
  let hddAccessing = false;
  while (accumulator >= frameInterval && ranFrames < budget) {
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

/** runUnlimitedTick() の戻り値。runTick()のTickResultと同じ流儀だが、無制限モードは
 * accumulatorを使わない(常に0)ため意味を持たない値として返す。 */
export interface UnlimitedTickResult {
  /** このtickで実際に進めたフレーム数(映像提示用の最後の1フレームを含む)。占有率の
   * 上限に引っかかって何もしなかったtickでは0。 */
  ranFrames: number;
  /** 無制限モードでは使わないため常に0(呼び出し側は捨ててよい)。 */
  accumulator: number;
  /** runTickと同じ、tick内の複数フレームのORで合成したディスクアクセス状態。 */
  access: DiskAccessFlags;
  /** 更新後の1フレームあたりコスト推定(ms、指数移動平均)。次回呼び出し時に
   * frameCostMsIn としてそのまま渡すこと(呼び出し側=core-worker.tsがモジュールスコープの
   * 変数として持ち越す)。 */
  frameCostMs: number;
  /** 次にretro_run()を回してよい時刻(ms、nowと同じ時刻系)。呼び出し側は次回呼び出し時に
   * nextAllowedAtMsInとしてそのまま渡すこと(占有率の上限を実時間で守るため。
   * src/frameBudget.tsのWORKER_UNLIMITED_MAX_DUTYのコメント参照)。 */
  nextAllowedAtMs: number;
}

/**
 * 無制限速度モード用のWorker側1tickぶんの駆動ロジック(純粋関数)。runTick()と対になる
 * 別経路: 「目標倍率」が無いため fps/accumulator/computeFrameBudget() は一切使わず、
 * 時間予算(budgetMs、src/frameBudget.ts の WORKER_UNLIMITED_TICK_BUDGET_MS)いっぱいまで
 * retro_run() を回し切る。budgetMsはtick間隔(TICK_MS)に縛られない絶対値であり、1tickを
 * またいで走り続けてよい(src/frameBudget.tsの2026-09-04コメント参照。旧実装は
 * tick間隔に収めようとしたため、フレーム単価が刻みの半分を超える環境で1フレームしか
 * 回せなかった)。
 *
 * 占有率の上限は「1tickの中の割合」ではなく「実際にかかった時間から、次に走ってよい
 * 時刻を決める」方式で守る(master(既定経路)のmain.tsのunlimitedNextAllowedAtと同じ
 * 考え方)。呼び出し側から渡されたnextAllowedAtMsInより前に呼ばれたtickは、
 * retro_run()を1回も回さず即座に戻る。
 *
 * 画面提示のthrottleは入れない(master(メインスレッド専用実装)の
 * UNLIMITED_PRESENT_INTERVAL_MSはここには持ち込まない): frame event は音声サンプルも
 * 相乗りさせて運ぶため、tickごとに出す頻度を落とすと音声が枯れる。ここで省くのは
 * 「中間フレームの映像変換(RGB565→RGBA)」だけであり、setVideoSkip(true)で
 * host側の変換・描画そのものをスキップさせる(src/libretro-host.ts参照)。
 *
 * 「入らないフレームは始めない」(master と同じ考え方): 次の中間フレームを回した場合の
 * 見込みコストと、最後に必ず回す映像提示フレームぶんのコストの両方が予算内に収まる
 * 場合だけ中間フレームを続ける。1フレームあたりの実測コストは指数移動平均
 * (frameCostMs = frameCostMs*0.8 + measured*0.2)で持ち越す。
 *
 * @param now 時刻取得(ms)。呼び出し側がWorkerグローバル(performance.now())等を注入する。
 * @param budgetMs このtickでretro_run()に使ってよい時間(ms)の総量(絶対値。tick間隔に
 *   縛られない)。
 * @param maxDuty 実時間に対してretro_run()に使ってよい占有率の上限(0〜1)。
 * @param nextAllowedAtMsIn 前回このtickが返したnextAllowedAtMs(初回は0でよい)。
 *   nowがこれより前ならこのtickは何もしない。
 * @param frameCostMsIn 1フレームあたりコストの実測移動平均の持ち越し値(ms)。
 * @param runFrameOnce 1フレーム進め、ディスクアクセス状態を返すコールバック(runTickと同じ)。
 * @param setVideoSkip 中間フレームの映像変換・描画をスキップするかを切り替えるコールバック
 *   (host.setVideoSkip をそのまま注入する想定)。
 */
export function runUnlimitedTick(
  now: () => number,
  budgetMs: number,
  maxDuty: number,
  nextAllowedAtMsIn: number,
  frameCostMsIn: number,
  runFrameOnce: () => DiskAccessFlags,
  setVideoSkip: (skip: boolean) => void,
): UnlimitedTickResult {
  const tickStart = now();
  // 占有率の上限(実時間ベース)。前回のtickがまだ「次に走ってよい時刻」に達していなければ
  // retro_run()を1回も回さず即座に戻る(頻繁に呼ばれてもここで間引かれる)。
  if (tickStart < nextAllowedAtMsIn) {
    return { ranFrames: 0, accumulator: 0, access: NO_ACCESS, frameCostMs: frameCostMsIn, nextAllowedAtMs: nextAllowedAtMsIn };
  }

  const deadline = tickStart + budgetMs;
  let frameCostMs = frameCostMsIn;
  let ranFrames = 0;
  let fddReading = false;
  let fddDrive = -1;
  let hddAccessing = false;

  const merge = (access: DiskAccessFlags): void => {
    if (access.fddReading) {
      fddReading = true;
      fddDrive = access.fddDrive;
    }
    if (access.hddAccessing) hddAccessing = true;
  };

  try {
    setVideoSkip(true);
    // 中間フレーム: 「次の1フレーム + 最後の映像提示フレーム」ぶんの見込みコストが
    // 予算内に収まる間だけ続ける(踏み越え防止。最後の映像提示フレームは常に別枠で回す
    // ためここでは数えない)。
    while (now() + frameCostMs * 2 <= deadline) {
      const frameStart = now();
      merge(runFrameOnce());
      frameCostMs = frameCostMs * 0.8 + (now() - frameStart) * 0.2;
      ranFrames++;
    }
  } finally {
    // 例外が起きても中間フレームのスキップ状態を必ず解除する。
    setVideoSkip(false);
  }

  // 最後の1フレームは必ず映像を作る(setVideoSkipは既にfalse)。
  // これにより予算が極端に小さい/尽きていても最低1フレームは進む。
  const presentStart = now();
  merge(runFrameOnce());
  frameCostMs = frameCostMs * 0.8 + (now() - presentStart) * 0.2;
  ranFrames++;

  // 実際にかかった時間costMsから、占有率がmaxDutyを超えないだけの間隔を空ける
  // (予算値ではなく実コストを使うので、遅いホストでは自動的に間隔が広がる)。
  const costMs = now() - tickStart;
  const nextAllowedAtMs = tickStart + costMs / maxDuty;

  return {
    ranFrames,
    accumulator: 0,
    access: ranFrames > 0 ? { fddReading, fddDrive, hddAccessing } : NO_ACCESS,
    frameCostMs,
    nextAllowedAtMs,
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
