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
//
// 占有率ゲート(2026-09-04追加、呼び出し元指摘の是正): 既定経路(src/main.ts loop())には
// 「コア実行が実時間に追いつけない設定では、次のtickの開始を実時間で遅らせて入力・UIの
// 余地を残す」ゲート(FRAME_LOOP_MAX_DUTY)があるが、runTick()には無かった。無制限モード用の
// runUnlimitedTick()には既に同種のゲートがある(あちらは「目標倍率が無い」別経路)ため、
// こちらは既定経路と全く同じ考え方(cantKeepUp=1フレームの実測コスト>実時間1フレーム、
// のときだけ発動)を持ち込む。now/frameCostMsIn/nextAllowedAtMsIn/maxDutyは末尾に追加した
// 引数で、省略時(now省略→常に0を返す・frameCostMsIn省略→0)は cantKeepUp が常に偽になり
// 旧来の(ゲート無し)動作と完全に一致する。追いついている通常時・倍速時はこの初期値のまま
// 呼ばれてもゲートが実質かからないのと同じ理屈(既定経路のコメント参照)で、既存呼び出し・
// 既存テスト(この引数を渡さない5引数呼び出し)の挙動は変えない。

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
  /** 更新後の1フレームあたりコスト推定(ms、指数移動平均)。次回呼び出し時に
   * frameCostMsIn としてそのまま渡すこと(呼び出し側=core-worker.tsがモジュールスコープの
   * 変数として持ち越す。runUnlimitedTick()のUnlimitedTickResult.frameCostMsと同じ流儀)。
   * ∞MHzのクロック決定(src/main.tsのautoClockFrameCostMs相当)にもこの値を使う。 */
  frameCostMs: number;
  /** 次にこのtick(通常速度経路)でコアを回してよい時刻(ms、nowと同じ時刻系)。
   * cantKeepUpでなかった(=ゲートが働かなかった)tickでは、呼び出し側から渡された値を
   * そのまま返す(変化しない)。呼び出し側は次回呼び出し時にnextAllowedAtMsInとして
   * そのまま渡すこと。 */
  nextAllowedAtMs: number;
}

const NO_ACCESS: DiskAccessFlags = { fddReading: false, fddDrive: -1, hddAccessing: false };

/**
 * 通常速度(非無制限)tickの占有率ゲート用の上限。既定経路(src/main.ts)の
 * FRAME_LOOP_MAX_DUTY(=0.85)と同じ値をそのまま流用する: 「コア実行に C ミリ秒かかったら、
 * 次に走らせるのは C/FRAME_LOOP_MAX_DUTY ミリ秒後まで待つ」という目的自体が既定経路と
 * 完全に同じ(追いつけない設定でも入力・UIの余地を実時間で残す)ため、専用の値を
 * 新設する理由が無い。
 */
export const FRAME_LOOP_MAX_DUTY = 0.85;

/** now引数省略時の既定値。常に0を返すため、frameCostMsIn省略時の0と組み合わさって
 * cantKeepUpが常に偽になり、ゲート自体が無かった旧実装と同じ挙動になる。 */
function zeroClock(): number {
  return 0;
}

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
 * @param now 時刻取得(ms)。省略時は常に0を返す擬似クロック(ゲートを無効化する)。
 *   実運用では呼び出し側(src/core-worker.ts)が ctx.performance.now() を注入すること。
 * @param frameCostMsIn 1フレームあたりコストの実測移動平均の持ち越し値(ms)。省略時0。
 *   cantKeepUp(このtickでゲートを効かせるか)の判定に使う。
 * @param nextAllowedAtMsIn 前回このtickが返したnextAllowedAtMs(初回は0でよい)。
 *   cantKeepUpのときだけ意味を持つ(cantKeepUpでなければ無視される)。
 * @param maxDuty 実時間に対してコア実行に使ってよい占有率の上限(0〜1)。省略時
 *   FRAME_LOOP_MAX_DUTY(既定経路と同じ値)。
 */
export function runTick(
  dt: number,
  fps: number,
  accumulatorIn: number,
  speedMultiplier: number,
  runFrameOnce: () => DiskAccessFlags,
  now: () => number = zeroClock,
  frameCostMsIn = 0,
  nextAllowedAtMsIn = 0,
  maxDuty = FRAME_LOOP_MAX_DUTY,
): TickResult {
  const frameInterval = 1 / (fps * speedMultiplier);
  let accumulator = accumulatorIn + dt;
  // 音声キュー未移行のため queued=0 固定(±2%補正なし。ファイル冒頭コメント参照)。
  const budget = computeFrameBudget(dt, frameInterval, 0, speedMultiplier);

  // ゲートを効かせるのは「1フレームの実行そのものが実時間1フレームより長い」ときだけ。
  // 追いついている通常時・倍速時はこの条件が偽なので、下のwhileループは従来と完全に
  // 同じ条件(accumulator/budgetのみ)で回る(既定経路のloop()と同じ線引き)。
  const realFrameMs = 1000 / fps;
  const cantKeepUp = frameCostMsIn > realFrameMs;
  const tickStart = now();
  const coreTickDeadline = tickStart + realFrameMs * maxDuty;

  let ranFrames = 0;
  let fddReading = false;
  let fddDrive = -1;
  let hddAccessing = false;
  let frameCostMs = frameCostMsIn;
  while (
    accumulator >= frameInterval &&
    ranFrames < budget &&
    (!cantKeepUp || now() >= nextAllowedAtMsIn)
  ) {
    const frameStart = now();
    const access = runFrameOnce();
    const cost = now() - frameStart;
    frameCostMs = frameCostMs === 0 ? cost : frameCostMs * 0.9 + cost * 0.1;
    if (access.fddReading) {
      fddReading = true;
      fddDrive = access.fddDrive;
    }
    if (access.hddAccessing) hddAccessing = true;
    accumulator -= frameInterval;
    ranFrames++;
    if (cantKeepUp && now() >= coreTickDeadline) break;
  }
  // 破綻(タブ非アクティブ復帰等)からの復帰。メインループのloop()と同じ保険。
  if (accumulator > frameInterval * 4) accumulator = 0;

  let nextAllowedAtMs = nextAllowedAtMsIn;
  if (cantKeepUp && ranFrames > 0) {
    const coreCostMs = now() - tickStart;
    nextAllowedAtMs = tickStart + coreCostMs / maxDuty;
  }

  return {
    ranFrames,
    accumulator,
    access: ranFrames > 0 ? { fddReading, fddDrive, hddAccessing } : NO_ACCESS,
    frameCostMs,
    nextAllowedAtMs,
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
 * 画面提示のthrottle(2026-09-04追記、既定経路との挙動揃え): 当初は「frame eventは
 * 音声サンプルも相乗りさせて運ぶため間引くと音声が枯れる」という理由でthrottleを
 * 入れていなかった。しかしその後、既定経路(src/main.ts)に合わせて無制限中は音声を
 * 丸ごと捨てる(pushAudioSamples側でunlimitedActiveを見て破棄する)方針に変えたため、
 * この理由は解消した。呼び出し側(src/core-worker.ts)がWORKER_UNLIMITED_PRESENT_INTERVAL_MS
 * 間隔でしかframe eventを出さないよう間引く際、このtickが「提示するtickか」を
 * presentFinalFrame引数で受け取り、提示しないtickでは最後の保証フレームも
 * setVideoSkip(true)のまま回す(=映像変換(RGB565→RGBA)そのものを省く。フレームは
 * 回るのでframeNoは進む)。「中間フレームの映像変換」だけを省く、という設計自体は
 * 変えていない。
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
 * @param presentFinalFrame 最後の1フレームを映像提示するか(既定true=従来どおり)。
 *   falseのときは最後の保証フレームも setVideoSkip(true) のまま回す(呼び出し側
 *   src/core-worker.ts が frame event の間引き(WORKER_UNLIMITED_PRESENT_INTERVAL_MS)を
 *   行うための追加パラメータ。falseでも runFrameOnce() は必ず呼ばれ frameNo は進む。
 *   このフラグは提示するかどうかだけを決め、フレームを回すかどうかには関与しない
 *   (無制限中でも1tick 1フレームは必ず回る=経過時間の消費が既定経路と変わらないままにする)。
 */
export function runUnlimitedTick(
  now: () => number,
  budgetMs: number,
  maxDuty: number,
  nextAllowedAtMsIn: number,
  frameCostMsIn: number,
  runFrameOnce: () => DiskAccessFlags,
  setVideoSkip: (skip: boolean) => void,
  presentFinalFrame: boolean = true,
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
    // 例外が起きても中間フレームのスキップ状態を必ず解除する。ただしpresentFinalFrame=false
    // (このtickは提示しない=frame eventの間引き対象)のときは、最後の保証フレームも
    // 映像を作る必要が無いためskip状態を維持する(setVideoSkip(true)のまま)。
    setVideoSkip(!presentFinalFrame ? true : false);
  }

  // 最後の1フレームは必ず回す(presentFinalFrame=falseのときはsetVideoSkipがtrueのまま
  // なので映像は作らない。それでもrunFrameOnce()はretro_run()を実行しframeNoを進める。
  // これにより予算が極端に小さい/尽きていても最低1フレームは進む)。
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

/**
 * 無制限速度モード中、このtickでframe event(映像+音声を相乗りさせる転送)を出すべきかの
 * 判定(2026-09-04追加、frame eventの間引き)。
 *
 * 既定経路(src/main.ts)は無制限中、画面提示をUNLIMITED_PRESENT_INTERVAL_MS(33ms)まで
 * 間引いている(提示の固定費が実測6.56msと大きく、毎tickやると予算が尽きるため)。
 * Worker経路にはこれが無かったため、同じ理由で間引く。ただしWorker経路では
 * frame eventがInputUpdateの往復のトリガーも兼ねる(src/main.tsがframe event契機で
 * InputUpdateを送る)ため、33msより粗くしてはいけない(intervalMsに
 * WORKER_UNLIMITED_PRESENT_INTERVAL_MS(=33、既定経路のUNLIMITED_PRESENT_INTERVAL_MSと
 * 同じ値)以外を渡さないこと。呼び出し側src/core-worker.tsのコメント参照)。
 *
 * lastPresentAtMs===0(まだ一度もframe eventを出していない、または無制限モードに
 * 切り替わった直後でリセットされた)のときは無条件でtrueを返す(切り替え直後に
 * 最初のフレームが届くまで最大intervalMs待たされるのを防ぐ。runUnlimitedTick()の
 * nextAllowedAtMsリセットと同じ考え方)。
 *
 * @param nowMs 現在時刻(ms)。呼び出し側のtick開始時刻(performance.now())を渡すこと。
 * @param lastPresentAtMs 直近にframe eventを出した時刻(ms)。まだ一度も出していない/
 *   リセット直後は0。
 * @param intervalMs 提示の最小間隔(ms)。
 */
export function shouldPresentUnlimitedFrame(
  nowMs: number,
  lastPresentAtMs: number,
  intervalMs: number,
): boolean {
  if (lastPresentAtMs === 0) return true;
  return nowMs - lastPresentAtMs >= intervalMs;
}
