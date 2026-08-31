// Worker のエントリポイント (docs/STORAGE-SCSI.md「段階移行の順序」手順4〜7)。
//
// `?worker=1` のとき、この Worker 上のコアが本体そのものとして使われる(メインスレッド側には
// もう1本のコアは立たない。src/main.ts 参照)。実装しているのは
// initialize→ready / loadGame / fetchAvInfo / setRunning / readTextScreen / dispose /
// hotSwapFdd / captureDirtyMedia / markDirty の command/response、映像を運ぶ frame event、
// バッファ返却、入力更新(INPUT_UPDATE_KIND、手順6)の系統。
// 音声・SRAM・ステート保存/復元は今回のスコープ外で、
// 该当opは引き続き UNSUPPORTED を返す(src/main.ts 側で「未対応」を利用者に見える形にする)。
// マウスの閉ループ追従(手順6後半、2026-08-31実装)はこのファイル内で完結する(mouseTracker、
// MOUSE_TRACK_UPDATE_KIND/MOUSE_TRACK_RESYNC_KIND ハンドラ参照。docs/STORAGE-SCSI.md
// 「ワーカー移行 手順6後半」参照)。FDD/MEMFSの不可分操作とオートセーブ(手順8、
// 2026-08-31実装)は src/worker-dirty-capture.ts の WorkerMediaState、および
// handleHotSwapFdd/handleCaptureDirtyMedia/handleMarkDirty 参照。
//
// 実コアの駆動には既存の LibretroHost / LocalCoreProxy をそのまま再利用する。
// LibretroHost は内部で canvas.getContext('2d') / width / height / createImageData /
// putImageData しか使わない(src/libretro-host.ts 参照)ため、Worker内では
// OffscreenCanvas を「実際には誰も画面として表示しない描画先」として渡す。
// docs の決定A(転送方式・メイン側canvas維持): OffscreenCanvasをメインへ渡す方式は採らない
// (メイン側で getImageData が使えなくなり screenHash が壊れる等、docs/STORAGE-SCSI.md
// 「決定」参照)。代わりに、この scratch canvas に描かれた1フレームぶんのRGBAを
// 毎フレーム getImageData() で読み出し、transferable として main へ postMessage する。
//
// バッファ返却: main が putImageData() し終えた ArrayBuffer を送り返してもらい、
// 同じ byteLength のプールへ積んで次フレームの送信に使い回す(RETURN_FRAME_BUFFER_KIND、
// core-protocol.ts参照)。プールが空で新規確保した回数を poolMisses として数え、frame event に
// 載せて main 側から観測できるようにする(返却が黙って効かなくなったときに気づくため。
// 実測では GC スパイク低減の効果は確認できていない。採用理由は毎フレームの
// `new ArrayBuffer()` による確保そのものを無くすことにある)。
//
// 駆動ループ: setInterval + accumulator で駆動する(docs「決定」: setTimeoutは固定delayで
// 系統的にドリフトし、素のsetIntervalは遅れた回を取り戻さないため、素の setInterval だけでは
// 不十分)。既存メインループ(src/main.ts の loop())が使っている computeFrameBudget()
// (src/frameBudget.ts)をそのまま呼ぶ。ただしメインループにある「音声キュー深さによる
// ±2%のフレーム間隔補正」は今回入れない(音声が未移行のため補正すべきキューが無い)。
// computeFrameBudget() には queued=0, speedMultiplier=1 を渡す(補正なし・速度ボタンは
// 未移行のため常に等倍)。
//
// Worker のビルド形式について(実測により訂正): vite dev server はクラシックworker
// 指定(type省略)でも、返す中身に ESM の import 文をそのまま残す(`?worker_file&type=classic`
// として配信されるが本文は `import { ... } from '/src/...'` を含む)。クラシックworkerは
// import を解釈できず構文エラーで即死するため、src/core-proxy.ts の defaultCreateWorker()
// では `{ type: 'module' }` を明示してモジュールworkerとして生成する。
//
// モジュールworkerでは importScripts() が使えない。一方 px68k_libretro.js
// (emscripten glue)はクラシックスクリプトで、グローバル(`self.PX68K` / `window.PX68K`)へ
// 代入する形式(index.htmlの<script src="/core/px68k_libretro.js">と同じもの)なので、
// `import()` で読み込むとモジュールスコープで実行されグローバルに何も設定されない。
// そのため fetch してソースを取得し、ワーカーのグローバルスコープで直接評価する
// (`(0, eval)(src)` の間接eval形にして、この関数のローカルスコープを汚さずグローバル
// self に代入させる)。実ブラウザで self.PX68K が設定されることを確認済み(docs参照)。

import {
  collectTransferables,
  createCoreError,
  CoreProxyError,
  isInputUpdateMessage,
  isMouseTrackResyncMessage,
  isMouseTrackUpdateMessage,
  isReturnFrameBufferMessage,
  WORKER_BOOT_ACK_KIND,
  type CoreCommand,
  type CoreError,
  type FrameSnapshot,
  type Generation,
  type InputUpdate,
  type WorkerToMain,
} from './core-protocol';
import { LocalCoreProxy, toOwnedArrayBuffer } from './core-proxy';
import { LibretroHost } from './libretro-host';
import { computeFrameBudget } from './frameBudget';
import { FrameBufferPool, runTick } from './worker-drive-loop';
import { WorkerInputState } from './worker-input';
import { MouseTracker } from './mouse-track';
import { initialTrackerState, trackKeyBufWrite, type KeyBufWriteTrackerState } from './keybuf-attribution';
import { WorkerMediaState, type DiskSlotId } from './worker-dirty-capture';

// --- DEV専用: 駆動ループ内訳プローブ (性能調査。既定off) --------------------------------
//
// `?worker=1` の起動が既定経路の1.76倍かかり、遅れが「コア稼働後〜プロンプト安定」の区間に
// 集中している実測(docs/STORAGE-SCSI.md参照)を切り分けるための計測専用フック。
// frameProbe/storageProbe(src/storage-probe.ts)と同じ作法: 既定 enabled=false で
// `if (workerTickProbe.enabled)` の外側ではコストを一切払わない。import.meta.env.DEV は
// ビルド時定数のため、prodビルドでは分岐ごと消える(既存フックと同様。既定経路の挙動は不変)。
//
// メインスレッドの window を Worker から直接触れないため、CoreCommand の判別union を汚さない
// 専用の生メッセージ(__devTickProbe / __devTickProbeData)で enable/disable/reset/read/
// busy-wait故障注入を制御する。main側の結線は src/core-proxy.ts の devPostRawMessage /
// setDevMessageHandler、src/main.ts の workerTickProbe* フック参照。
export interface WorkerTickEvent {
  tickIndex: number;
  /** ctx.performance.now() で見たこのtick実行時点の絶対時刻(ms)。他系列(commandEvents等)との
   * 突き合わせ・経過時間帯でのバケット化に使う。 */
  nowMs: number;
  /** 前tickのsetIntervalコールバックからの実測経過(ms)。取り戻しの入力そのもの。 */
  sinceLastTickMs: number;
  /** このtickで実際に進めたフレーム数(取り戻しが効いているかの直接の証拠)。 */
  ranFrames: number;
  /** computeFrameBudget()が返す上限(runTickの内部と同じ入力で別途計算。参考値)。 */
  budgetHint: number;
  accumulatorBeforeMs: number;
  accumulatorAfterMs: number;
  /** runFrameOnce()(retro_run+readDiskAccess)にこのtickで費やした合計時間(ms)。 */
  runTotalMs: number;
  /** getImageData()によるRGBA読み出し時間(ms)。フレームを送らなかったtickはnull。 */
  convertMs: number | null;
  /** postMessage(transfer込み)の所要時間(ms)。フレームを送らなかったtickはnull。 */
  postMs: number | null;
  /** busyWaitFaultEnabled時、このtickに注入した固定busy waitの長さ(ms)。0は未注入。 */
  busyWaitInjectedMs: number;
}

/**
 * 「空白」(tick呼び出し間隔がrun+convert+postの合計を大きく超える区間)の間に
 * commandメッセージ処理が起きていたかを突き合わせるための記録(docs/STORAGE-SCSI.md参照)。
 * ctx.onmessage の command 分岐だけを対象にする(__devTickProbe制御メッセージ自体・
 * RETURN_FRAME_BUFFER_KINDは対象外)。
 */
export interface WorkerCommandEvent {
  op: string;
  startAtMs: number;
  endAtMs: number;
}

class WorkerTickProbe {
  enabled = false;
  /** 30tickごとに30msのbusy waitを注入する(測定系の検証専用。故障注入)。 */
  busyWaitFaultEnabled = false;
  tickIndex = 0;
  events: WorkerTickEvent[] = [];
  commandEvents: WorkerCommandEvent[] = [];
  reset(): void {
    this.tickIndex = 0;
    this.events = [];
    this.commandEvents = [];
  }
}

const workerTickProbe = new WorkerTickProbe();

/**
 * DEVかつ有効時のみ、command処理の開始/終了時刻を記録する(空白と重なるかの突き合わせ用)。
 * 無効時・prodビルドではこの関数自体を分岐の外側に置き、呼び出し元でガードする
 * (frameProbe/storageProbeと同じ作法)。同期・非同期どちらの handle* からも呼べるよう、
 * 戻り値が Promise なら resolve を待ってから終了時刻を記録する。
 */
function recordCommandTiming(op: string, startAtMs: number, result: void | Promise<void>): void {
  if (!(import.meta.env.DEV && workerTickProbe.enabled)) return;
  if (result instanceof Promise) {
    void result.finally(() => {
      workerTickProbe.commandEvents.push({ op, startAtMs, endAtMs: ctx.performance.now() });
    });
  } else {
    workerTickProbe.commandEvents.push({ op, startAtMs, endAtMs: ctx.performance.now() });
  }
}

interface DevTickProbeControlMessage {
  kind: '__devTickProbe';
  action: 'enable' | 'disable' | 'reset' | 'read' | 'setBusyWaitFault';
  value?: boolean;
}

function isDevTickProbeControlMessage(data: unknown): data is DevTickProbeControlMessage {
  return (
    typeof data === 'object' && data !== null && (data as { kind?: unknown }).kind === '__devTickProbe'
  );
}

// --- DEV専用: KeyBufプローブのWorker対応 (docs/STORAGE-SCSI.md「KeyBufプローブの
// Worker対応」参照) ---------------------------------------------------------------
//
// workerTickProbeと同じ作法: 既定 enabled=false で、`if (keyBufProbeEnabled)` の外側では
// 毎フレームの host.readKeyBufWindow(0, 128) 呼び出しそのものを行わない
// (常時コストを持ち込まない)。main側の結線は src/main.ts の keybufProbeEnable/keybuf
// フック、src/core-protocol.ts の FrameSnapshot.keyBufProbe / KeyBufFrameProbe 参照。
let keyBufProbeEnabled = false;
// 帰属計測用(2026-08-31訂正、「注入の遅れ」「観測の遅れ」の切り分け): writePointerが
// 前回のsendFrame()から動いたかどうかを比較するための直近値と、動いた時点のframeNo。
// enableのたびにリセットする(前回起動・前回の有効化区間の値を持ち越さない)。
// 実体(trackKeyBufWrite)はsrc/keybuf-attribution.tsへ切り出し、既定経路(libretro-host.ts)と
// 同じ定義・同じ数え方を共有する(定義がずれると比較の意味が消えるため。
// docs/STORAGE-SCSI.md「帰属の定義」参照)。
let keyBufWriteTracker: KeyBufWriteTrackerState = initialTrackerState();
// 帰属計測用(2026-08-31再訂正、「帰属の定義の誤りと訂正」参照): applyInputUpdate()が
// 実際に走った時点でWorker自身が読んだframeNo。mainのworkerLastFrameNo(直近に受け取った
// frame eventのframeNo)は構造的に古くなりうるため、「真の注入」の起点にはこの値
// (Worker自身の単一クロック上の生きた値)を使う。keyBufWriteTrackerと同じくsticky
// (適用が無いフレームでは直前の値を保持)。enableのたびにリセットする。
let lastInputApplyFrameNo: number | null = null;

interface DevKeyBufProbeControlMessage {
  kind: '__devKeyBufProbe';
  action: 'enable' | 'disable';
}

function isDevKeyBufProbeControlMessage(data: unknown): data is DevKeyBufProbeControlMessage {
  return (
    typeof data === 'object' && data !== null && (data as { kind?: unknown }).kind === '__devKeyBufProbe'
  );
}

/**
 * DOM lib と webworker lib は同一 tsconfig 内で共存できない(グローバル `self` の型が
 * 競合する)ため、tsconfig.json の lib はプロジェクト共通の ["ES2020","DOM","DOM.Iterable"]
 * のまま変更しない。Worker専用のグローバル(importScripts、postMessageの正確な引数形)だけを
 * ここで最小限に自前宣言し、`self` をそれらに絞ったshapeへキャストして使う。
 */
interface WorkerGlobalLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<CoreCommand | { kind: string; buffer?: ArrayBuffer }>) => void) | null;
  setInterval(handler: () => void, timeoutMs: number): ReturnType<typeof setInterval>;
  clearInterval(id: ReturnType<typeof setInterval>): void;
  performance: { now(): number };
}

const ctx = self as unknown as WorkerGlobalLike;

/** メインの LocalCoreProxy を、initialize 完了後はこの Worker 内の実体として使う。 */
let proxy: LocalCoreProxy | null = null;
/** readDiskAccess/avInfo等の同期的な読み出しに使う実体。initialize完了後にのみ非null。 */
let host: LibretroHost | null = null;
let coreModuleLoaded = false;
/** 現在の generation。initialize command から受け取ったものをそのまま event に載せ続ける。 */
let currentGeneration: Generation = 0;

/** 誰も画面として読まない scratch 描画先(コメント冒頭参照)。ここへ描かれた内容だけを
 * 毎フレーム getImageData() で吸い出し、main へ転送する。 */
let scratchCanvas: OffscreenCanvas | null = null;
let scratchCtx: OffscreenCanvasRenderingContext2D | null = null;

function post(message: WorkerToMain): void {
  ctx.postMessage(message, collectTransferables(message));
}

function toCoreError(err: unknown, operation: string): CoreError {
  if (err instanceof CoreProxyError) return err.coreError;
  const message = err instanceof Error ? err.message : String(err);
  return createCoreError('CORE_FAILURE', message, { operation });
}

/** px68k-libretro (emscripten) の wasm glue を一度だけ読み込む。index.html の
 * `<script src="/core/px68k_libretro.js">` と同じ絶対パスを使う(base設定に依存しない)。
 * モジュールworker内では importScripts() が使えないため、fetch でソースを取得し
 * 間接eval(`(0, eval)(src)`)でワーカーのグローバルスコープで評価する。このglueは
 * クラシックスクリプトとして自身を `self.PX68K` に代入する形式(import()でモジュール
 * として読み込むとモジュールスコープに閉じてしまい失敗する)。 */
async function ensureCoreModuleLoaded(): Promise<void> {
  if (coreModuleLoaded) return;
  const res = await fetch('/core/px68k_libretro.js');
  if (!res.ok) {
    throw new Error(`px68k_libretro.js の取得に失敗しました (status=${res.status})`);
  }
  const src = await res.text();
  // 間接eval: グローバル(self)スコープで評価させ、この関数のローカルスコープを汚染しない。
  (0, eval)(src);
  coreModuleLoaded = true;
}

// --- バッファプール (映像frame eventの transfer 用) --------------------------
//
// 純粋ロジック(取り戻し計算・byteLengthキーのプール)は src/worker-drive-loop.ts に切り出し、
// 単体テスト(test/worker-drive-loop.test.ts)の対象にしてある。ここでは実 Worker
// グローバル(self.setInterval/performance.now、LibretroHost、scratch canvas)への結線だけを持つ。
const framePool = new FrameBufferPool();

function releaseBuffer(buffer: ArrayBuffer): void {
  framePool.release(buffer);
}

// --- 入力 (手順6) ------------------------------------------------------------
//
// main 側が frame event を契機に正規化・合成した InputUpdate を、片道メッセージ
// (INPUT_UPDATE_KIND)で受け取り、そのままコアの入力状態(host)へ適用するだけの薄い層。
// Worker はここで「受信済みスナップショットを見る」役に徹し、DOM/Gamepad の正規化は
// 一切行わない(docs/STORAGE-SCSI.md「段階移行の順序」6項)。
//
// 世代付きclearと差分適用の実体(純粋ロジック)は src/worker-input.ts の WorkerInputState に
// 切り出してあり、単体テスト(test/worker-input.test.ts)の対象にしてある
// (前例: src/worker-drive-loop.ts と同じ作法)。ここでは実 host(LibretroHost)への
// 結線だけを持つ。
const workerInputState = new WorkerInputState();

// --- FDD/MEMFSの不可分操作とオートセーブ (手順8) ------------------------------
//
// 「dirtyか読む→イメージを読み出す→dirtyを落とす」「Eject→旧内容回収→write→insert」の
// 不可分性そのものは src/worker-dirty-capture.ts の WorkerMediaState に切り出してあり、
// 単体テスト(test/worker-dirty-capture.test.ts)の対象にしてある(前例: 上記と同じ作法)。
// ここでは実 host(LibretroHost)への結線と、initialize時のマウントパス登録だけを持つ。
const mediaState = new WorkerMediaState();

function slotForDrive(drive: 0 | 1): DiskSlotId {
  return drive === 0 ? 'fdd0' : 'fdd1';
}

// --- マウス閉ループ追従 (手順6後半) -------------------------------------------
//
// 決定(docs/STORAGE-SCSI.md「ワーカー移行 手順6後半」): 閉ループ(cursor読み取り→差分計算→
// addMouseDelta)そのものをここで回す。main は目標比率(ratioX/Y)と有効/無効(enabled)だけを
// 低頻度(mousemove/pointerlockchange契機)の片道メッセージ(MOUSE_TRACK_UPDATE_KIND)で送る。
// 実体(純粋クラス)は src/mouse-track.ts の MouseTracker で、既定経路(src/main.ts)と
// 完全に同じ計算をする別インスタンス。
const mouseTracker = new MouseTracker();
/** 直近に main から受け取った「追従モードが今アクティブか」。tick() 契機の毎フレーム計算では
 * なく、mousemove/pointerlockchange契機でしか更新されない値なので、mouseTracker.step() には
 * 常にこの変数をそのまま渡す。 */
let mouseTrackEnabled = false;

function applyMouseTrackUpdate(update: { enabled: boolean; ratioX: number; ratioY: number }): void {
  mouseTrackEnabled = update.enabled;
  mouseTracker.setDesiredRatio(update.ratioX, update.ratioY);
}

function applyMouseTrackResync(): void {
  if (!host) return;
  const avInfo = host.avInfo;
  const w = avInfo?.baseWidth || 0;
  const h = avInfo?.baseHeight || 0;
  mouseTracker.resync(host, { width: w, height: h });
}

function applyInputUpdate(update: InputUpdate): void {
  if (!host) return; // initialize前に届いた更新は捨てる(送信元は起動後にしか送らない想定)。
  const changed = workerInputState.apply(update, host);
  // 帰属計測(2026-08-31三訂正、「break側の帰属が壊れている」の修正、
  // docs/STORAGE-SCSI.md参照): 実際に何か状態が変わったapply()呼び出しのときだけ、
  // 適用した瞬間のframeNoをWorker自身の単一クロックで記録する。DEVかつプローブ有効時のみ
  // (既存フックと同じ作法。ファイル冒頭コメント参照)。changedを見ずに毎回上書きすると、
  // frame event契機で内容不変のまま毎フレーム届く連続送信(ゲームパッド未接続時のjoyState等)
  // によって、この値が実質「現在のframeNo」を追い続けるだけになり、検出が遅れがちな
  // break側で書き込みフレームより後に見える(writeFrameNo<applyFrameNoという定義上
  // ありえない負値になる)欠陥があった。
  if (import.meta.env.DEV && keyBufProbeEnabled && changed) lastInputApplyFrameNo = frameNo;
}

// --- 駆動ループ (手順7) ------------------------------------------------------
//
// setInterval + accumulator。setTimeoutの固定delayは系統的にドリフトし、素の
// setIntervalは遅れた回を取り戻さないため、両方の弱点を避けるために既存メインループ
// (src/main.ts の loop())と同じ考え方(runTick()=computeFrameBudget()による取り戻し)を
// 持ち込む。メインループと違い音声キューが無いため、frameIntervalの±2%補正(音声キュー深さ
// 由来)は入れない(runTick()内でqueued=0, speedMultiplier=1固定でcomputeFrameBudget()を呼ぶ)。
const TICK_MS = 16;
let running = false;
let driveIntervalId: ReturnType<typeof setInterval> | undefined;
let lastTickAtMs = 0;
let accumulator = 0;
/** 起動後に完了した retro_run() の累積数。境界上の唯一の時系列識別子(docs参照)。 */
let frameNo = 0;

function stopDriveLoop(): void {
  if (driveIntervalId !== undefined) {
    ctx.clearInterval(driveIntervalId);
    driveIntervalId = undefined;
  }
  lastTickAtMs = 0;
  accumulator = 0;
}

function startDriveLoop(): void {
  if (driveIntervalId !== undefined) return;
  lastTickAtMs = 0;
  accumulator = 0;
  driveIntervalId = ctx.setInterval(tick, TICK_MS);
}

function tick(): void {
  if (!running || !host) return;
  const now = ctx.performance.now();
  const sinceLastTickMs = lastTickAtMs === 0 ? 0 : now - lastTickAtMs;
  if (lastTickAtMs === 0) lastTickAtMs = now;
  const dt = (now - lastTickAtMs) / 1000;
  lastTickAtMs = now;

  // DEVかつ有効時のみ計測コストを払う(import.meta.env.DEVはビルド時定数なのでprodでは
  // この分岐ごと消える。frameProbe/storageProbeと同じ作法。ファイル冒頭のコメント参照)。
  const probing = import.meta.env.DEV && workerTickProbe.enabled;
  const accumulatorBeforeMs = accumulator * 1000;
  let busyWaitInjectedMs = 0;
  if (probing && workerTickProbe.busyWaitFaultEnabled && workerTickProbe.tickIndex % 30 === 0) {
    // 測定系の検証専用の故障注入: 内訳のどこに現れるかを見るため、tickの冒頭に固定30msの
    // busy waitを足す(docs/STORAGE-SCSI.md参照。本番挙動には影響しない: busyWaitFaultEnabled
    // は既定false・DEVのみ到達)。
    const busyStart = ctx.performance.now();
    while (ctx.performance.now() - busyStart < 30) {
      /* busy wait */
    }
    busyWaitInjectedMs = 30;
  }

  const fps = host.avInfo?.fps ?? 60;
  const currentHost = host;
  let runTotalMs = 0;
  const result = runTick(dt, fps, accumulator, () => {
    const runStart = probing ? ctx.performance.now() : 0;
    currentHost.runFrame();
    if (probing) runTotalMs += ctx.performance.now() - runStart;
    frameNo++;
    // runFrame() 直後でないとコア側がクリアしてしまう(LibretroHost#readDiskAccessのコメント参照)。
    return currentHost.readDiskAccess();
  });
  accumulator = result.accumulator;

  // マウス閉ループ追従(手順6後半)。既定経路(src/main.ts の loop())が「実際にコアを1フレーム
  // 以上進めた回だけ stepMouseTracking() を呼ぶ」のと同じ条件(ran > 0)で呼ぶ。
  if (result.ranFrames > 0 && host) {
    const trackResult = mouseTracker.step(host, mouseTrackEnabled);
    if (trackResult === 'disabled') {
      post({ kind: 'event', generation: currentGeneration, event: 'mouseTrackDisabled' });
    }
  }

  let convertMs: number | null = null;
  let postMs: number | null = null;
  if (result.ranFrames > 0) {
    sendFrame(
      result.access,
      probing
        ? (c, p) => {
            convertMs = c;
            postMs = p;
          }
        : undefined,
    );
  }

  if (probing) {
    const frameInterval = 1 / fps;
    const budgetHint = computeFrameBudget(dt, frameInterval, 0, 1);
    workerTickProbe.events.push({
      tickIndex: workerTickProbe.tickIndex++,
      nowMs: now,
      sinceLastTickMs,
      ranFrames: result.ranFrames,
      budgetHint,
      accumulatorBeforeMs,
      accumulatorAfterMs: result.accumulator * 1000,
      runTotalMs,
      convertMs,
      postMs,
      busyWaitInjectedMs,
    });
  }
}

function sendFrame(
  access: { fddReading: boolean; fddDrive: number; hddAccessing: boolean },
  onProbe?: (convertMs: number, postMs: number) => void,
): void {
  if (!host || !scratchCanvas || !scratchCtx) return;
  const width = scratchCanvas.width;
  const height = scratchCanvas.height;
  if (width === 0 || height === 0) return; // まだ1度も解像度が確定していない(dupeフレームのみ)。

  const convertStart = onProbe ? ctx.performance.now() : 0;
  const imageData = scratchCtx.getImageData(0, 0, width, height);
  const buffer = framePool.acquire(imageData.data.byteLength);
  new Uint8ClampedArray(buffer).set(imageData.data);
  const convertEnd = onProbe ? ctx.performance.now() : 0;

  const avInfo = host.avInfo;
  const snapshot: FrameSnapshot = {
    frameNo,
    av: {
      fps: avInfo?.fps ?? 60,
      sampleRate: avInfo?.sampleRate ?? 44100,
      width,
      height,
    },
    video: { kind: 'rgba', bytes: buffer, width, height },
    // 音声は今回のスコープ外(未移行)。空で送る。
    audio: { chunks: [], sampleFrames: 0 },
    disk: {
      access,
      // 手順8: コア本体のダーティフラグ(host.readDirtyState())とJS側の影のフラグ
      // (WorkerMediaState、永続化失敗時の再dirty化用)を合成して送る。main側はこれを
      // 既定経路の host.readDirtyState() ポーリングと同じ扱いでオートセーブ判定に使う
      // (src/main.ts の workerLastDirty 参照)。
      dirty: mediaState.dirtyState(host.readDirtyState()),
    },
    poolMisses: framePool.misses,
  };
  // DEV専用・既定off(ファイル冒頭コメント参照)。有効化時のみ host.readKeyBufWindow(0, 128)
  // を毎フレーム呼ぶ(受動読み取りのみで、コアの駆動そのものには関与しない)。
  if (import.meta.env.DEV && keyBufProbeEnabled) {
    const keyBufProbe = host.readKeyBufWindow(0, 128);
    if (keyBufProbe) {
      snapshot.keyBufProbe = keyBufProbe;
      // 帰属計測: writePointerが前回のsendFrame()時点から動いていれば、このtickの
      // frameNo(=このtickで最後に実行されたフレーム)を「書かれたフレーム」として覚える。
      // 動いていなければ直前の値をそのまま保持する(sticky。src/keybuf-attribution.ts参照)。
      keyBufWriteTracker = trackKeyBufWrite(keyBufWriteTracker, keyBufProbe.writePointer, frameNo);
      if (keyBufWriteTracker.writeFrameNo !== null) snapshot.keyBufWriteFrameNo = keyBufWriteTracker.writeFrameNo;
    }
    // 帰属計測(2026-08-31再訂正): applyInputUpdate()が記録した「実際に適用した瞬間の
    // frameNo」をframe eventに相乗りさせる(keyBufWriteFrameNoと同じくsticky。まだ一度も
    // 適用が無ければ載せない)。
    if (lastInputApplyFrameNo !== null) snapshot.inputApplyFrameNo = lastInputApplyFrameNo;
    // マウス閉ループ追従のデバッグスナップショット(手順6後半)。`__webx68kDebug.mouse()`
    // (src/main.ts)をWorker経路でも同期のまま返すための相乗り(keyBufProbeと同じ有効化
    // フラグを共用。core-protocol.ts の FrameSnapshot.mouseTrackProbe コメント参照)。
    snapshot.mouseTrackProbe = {
      pending: host.hasPendingMouseDelta(),
      cursor: host.readGuestCursor(),
      core: host.readMouseState(),
    };
  }
  const postStart = onProbe ? ctx.performance.now() : 0;
  post({ kind: 'event', generation: currentGeneration, event: 'frame', snapshot });
  const postEnd = onProbe ? ctx.performance.now() : 0;
  if (onProbe) onProbe(convertEnd - convertStart, postEnd - postStart);
}

async function handleInitialize(
  cmd: Extract<CoreCommand, { op: 'initialize' }>,
): Promise<void> {
  const { generation, requestId, payload } = cmd;
  currentGeneration = generation;
  try {
    await ensureCoreModuleLoaded();
    // scratch canvas: ファイル冒頭のコメント参照。
    scratchCanvas = new OffscreenCanvas(1, 1);
    scratchCtx = scratchCanvas.getContext('2d');
    const newHost = new LibretroHost(scratchCanvas as unknown as HTMLCanvasElement, () => {
      // 音声経路は今回のスコープ外。生成されたサンプルは捨てるだけ。
    });
    await newHost.init(
      new Uint8Array(payload.biosIpl),
      new Uint8Array(payload.biosCg),
      payload.sram ? new Uint8Array(payload.sram) : undefined,
    );
    if (payload.options) {
      for (const [key, value] of Object.entries(payload.options)) {
        newHost.setCoreOption(key, value);
      }
    }
    // 初期ディスクのマウント(src/main.ts の bootCore() 末尾と同じ手順を Worker 内へ移した版)。
    // FDDホットマウント(実行中の差し替え。手順8でhandleHotSwapFddとして実装)とは違い、
    // こちらは起動前の1回きりの書き込みなのでここで完結させる(InitPayload.initialDisks の
    // コメント参照)。
    const disksBySlot = new Map(
      (payload.initialDisks ?? []).map((d) => [d.slot, d] as const),
    );
    const fdd0 = disksBySlot.get('fdd0');
    const fdd1 = disksBySlot.get('fdd1');
    const hdd = disksBySlot.get('hdd');
    const fdd0Path = fdd0 ? newHost.writeDiskImage(`fdd0_${fdd0.name}`, new Uint8Array(fdd0.bytes)) : '';
    const fdd1Path = fdd1 ? newHost.writeDiskImage(`fdd1_${fdd1.name}`, new Uint8Array(fdd1.bytes)) : '';
    let hddPath = '';
    if (hdd) {
      hddPath = newHost.writeDiskImage(`hdd_${hdd.name}`, new Uint8Array(hdd.bytes));
      const iniText = `[WinX68k]\r\nHDD0=${hddPath}\r\n`;
      newHost.writeFile('/system/keropi/config', new TextEncoder().encode(iniText));
    }
    // px68k-libretro の "px68k <fd0> <fd1>" 形式(bootCore()と同じ)。空スロットは空文字列。
    const cmdText = `px68k "${fdd0Path}" "${fdd1Path}"\n`;
    newHost.writeFile('/game/boot.cmd', new TextEncoder().encode(cmdText));

    // 手順8: 不可分キャプチャ/ホットマウント(WorkerMediaState)へ、起動時にマウントした
    // 各スロットのFS上のパスを登録する(空スロットはnull)。
    mediaState.setMountedPath('fdd0', fdd0 ? fdd0Path : null);
    mediaState.setMountedPath('fdd1', fdd1 ? fdd1Path : null);
    mediaState.setMountedPath('hdd', hdd ? hddPath : null);

    host = newHost;
    proxy = new LocalCoreProxy(newHost, { initialized: true });
    const avInfo = newHost.fetchAvInfo();
    post({ kind: 'response', generation, requestId, ok: true, completedFrameNo: 0, result: undefined });
    post({ kind: 'event', generation, event: 'ready', avInfo });
  } catch (err) {
    post({
      kind: 'response',
      generation,
      requestId,
      ok: false,
      error: toCoreError(err, 'initialize'),
    });
  }
}

async function handleLoadGame(cmd: Extract<CoreCommand, { op: 'loadGame' }>): Promise<void> {
  const { generation, requestId, payload } = cmd;
  if (!proxy) {
    post({
      kind: 'response',
      generation,
      requestId,
      ok: false,
      error: createCoreError('INVALID_STATE', 'initialize が完了していません', { operation: 'loadGame' }),
    });
    return;
  }
  try {
    const result = await proxy.loadGame(payload.path ?? '');
    post({ kind: 'response', generation, requestId, ok: true, completedFrameNo: frameNo, result });
  } catch (err) {
    post({ kind: 'response', generation, requestId, ok: false, error: toCoreError(err, 'loadGame') });
  }
}

async function handleFetchAvInfo(
  cmd: Extract<CoreCommand, { op: 'fetchAvInfo' }>,
): Promise<void> {
  const { generation, requestId } = cmd;
  if (!proxy) {
    post({
      kind: 'response',
      generation,
      requestId,
      ok: false,
      error: createCoreError('INVALID_STATE', 'initialize が完了していません', { operation: 'fetchAvInfo' }),
    });
    return;
  }
  try {
    const result = await proxy.fetchAvInfo();
    post({ kind: 'response', generation, requestId, ok: true, completedFrameNo: frameNo, result });
  } catch (err) {
    post({ kind: 'response', generation, requestId, ok: false, error: toCoreError(err, 'fetchAvInfo') });
  }
}

async function handleReadTextScreen(
  cmd: Extract<CoreCommand, { op: 'serialize' | 'readTextScreen' | 'screenshot' }>,
): Promise<void> {
  const { generation, requestId, op } = cmd;
  if (op !== 'readTextScreen') {
    post({
      kind: 'response',
      generation,
      requestId,
      ok: false,
      error: createCoreError('UNSUPPORTED', `${op} はWorker経路でまだ実装していません`, { operation: op }),
    });
    return;
  }
  if (!proxy) {
    post({
      kind: 'response',
      generation,
      requestId,
      ok: false,
      error: createCoreError('INVALID_STATE', 'initialize が完了していません', { operation: op }),
    });
    return;
  }
  try {
    const result = await proxy.readTextScreen();
    post({ kind: 'response', generation, requestId, ok: true, completedFrameNo: frameNo, result });
  } catch (err) {
    post({ kind: 'response', generation, requestId, ok: false, error: toCoreError(err, op) });
  }
}

function handleSetRunning(cmd: Extract<CoreCommand, { op: 'setRunning' }>): void {
  const { generation, requestId, payload } = cmd;
  if (!proxy) {
    post({
      kind: 'response',
      generation,
      requestId,
      ok: false,
      error: createCoreError('INVALID_STATE', 'initialize が完了していません', { operation: 'setRunning' }),
    });
    return;
  }
  running = payload.running;
  if (running) startDriveLoop();
  else stopDriveLoop();
  post({ kind: 'response', generation, requestId, ok: true, completedFrameNo: frameNo, result: undefined });
}

/**
 * 手順8: FDDホットマウント。WorkerMediaState#hotSwapFdd() 1回の同期呼び出しで
 * Eject→旧内容回収→(新イメージがあれば)write→insert を完結させる(ファイル冒頭の
 * mediaState コメント、src/worker-dirty-capture.ts 参照)。この関数自体はasyncだが、
 * mediaState.hotSwapFdd() の呼び出し自体はawaitを挟まない同期呼び出しであり、
 * その内部でretro_run()等が割り込む余地は無い(不可分性はここで保たれる)。
 */
function handleHotSwapFdd(cmd: Extract<CoreCommand, { op: 'hotSwapFdd' }>): void {
  const { generation, requestId, payload } = cmd;
  if (!host) {
    post({
      kind: 'response',
      generation,
      requestId,
      ok: false,
      error: createCoreError('INVALID_STATE', 'initialize が完了していません', { operation: 'hotSwapFdd' }),
    });
    return;
  }
  const slot = slotForDrive(payload.drive);
  const image = payload.image ? { name: payload.image.name, bytes: new Uint8Array(payload.image.bytes) } : null;
  const outcome = mediaState.hotSwapFdd(slot, payload.drive, image, host);
  post({
    kind: 'response',
    generation,
    requestId,
    ok: true,
    completedFrameNo: frameNo,
    result: {
      previousImage: outcome.previousImage ? toOwnedArrayBuffer(outcome.previousImage) : null,
      mountedPath: outcome.mountedPath,
    },
  });
}

/**
 * 手順8: 不可分ダーティキャプチャ。main が指定したスロットについて、
 * 「イメージを読み出す」と「dirty(コア本体+影)を落とす」を1回の同期呼び出し内で
 * 完結させる(WorkerMediaState#captureSlots()。ファイル冒頭コメント参照)。
 */
function handleCaptureDirtyMedia(cmd: Extract<CoreCommand, { op: 'captureDirtyMedia' }>): void {
  const { generation, requestId, payload } = cmd;
  if (!host) {
    post({
      kind: 'response',
      generation,
      requestId,
      ok: false,
      error: createCoreError('INVALID_STATE', 'initialize が完了していません', { operation: 'captureDirtyMedia' }),
    });
    return;
  }
  const captured = mediaState.captureSlots(payload.slots, host).map((entry) => ({
    slot: entry.slot,
    bytes: entry.bytes ? toOwnedArrayBuffer(entry.bytes) : null,
  }));
  post({ kind: 'response', generation, requestId, ok: true, completedFrameNo: frameNo, result: { captured } });
}

/**
 * 手順8: 永続化(IndexedDBへの保存)が失敗したときの再dirty化。px68k本体にはフラグを外から
 * 立てるAPIが無いため、WorkerMediaStateの影のフラグを立てるだけ(冪等。docs参照)。
 */
function handleMarkDirty(cmd: Extract<CoreCommand, { op: 'markDirty' }>): void {
  const { generation, requestId, payload } = cmd;
  mediaState.markDirty(payload.slots);
  post({ kind: 'response', generation, requestId, ok: true, completedFrameNo: frameNo, result: undefined });
}

async function handleDispose(cmd: Extract<CoreCommand, { op: 'dispose' }>): Promise<void> {
  const { generation, requestId } = cmd;
  try {
    running = false;
    stopDriveLoop();
    // 決定(前回合意): _retro_deinit() は呼ばない。Worker ごと terminate するため
    // (手順9で改めて判断)。LocalCoreProxy#dispose() は元々 _retro_deinit を呼ばず
    // SRAM自動保存の停止とコールバック関数テーブルの解放のみを行う(src/libretro-host.ts
    // の LibretroHost#dispose() 参照)ので、ここではそれをそのまま使うだけでよい。
    if (proxy) {
      await proxy.dispose();
      proxy = null;
      host = null;
    }
    post({ kind: 'response', generation, requestId, ok: true, completedFrameNo: frameNo, result: undefined });
  } catch (err) {
    post({ kind: 'response', generation, requestId, ok: false, error: toCoreError(err, 'dispose') });
  }
}

ctx.onmessage = (ev) => {
  const data = ev.data as CoreCommand | { kind: string; buffer?: ArrayBuffer };
  // DEV専用の計測プローブ制御(ファイル冒頭コメント参照)。CoreCommandのunionを汚さない
  // 生メッセージなので、他のどの分岐よりも先に見て早期returnする。
  if (import.meta.env.DEV && isDevTickProbeControlMessage(data)) {
    switch (data.action) {
      case 'enable':
        workerTickProbe.enabled = true;
        break;
      case 'disable':
        workerTickProbe.enabled = false;
        break;
      case 'reset':
        workerTickProbe.reset();
        break;
      case 'setBusyWaitFault':
        workerTickProbe.busyWaitFaultEnabled = data.value === true;
        break;
      case 'read':
        ctx.postMessage({
          kind: '__devTickProbeData',
          events: workerTickProbe.events,
          commandEvents: workerTickProbe.commandEvents,
        });
        break;
    }
    return;
  }
  // DEV専用のKeyBufプローブ制御(ファイル冒頭コメント参照)。同じく生メッセージなので
  // 他のどの分岐よりも先に見て早期returnする。
  if (import.meta.env.DEV && isDevKeyBufProbeControlMessage(data)) {
    keyBufProbeEnabled = data.action === 'enable';
    if (data.action === 'enable') {
      // 前回の有効化区間の値を持ち越さない(帰属計測をこの有効化からの新規区間として扱う)。
      keyBufWriteTracker = initialTrackerState();
      lastInputApplyFrameNo = null;
    }
    return;
  }
  // バッファ返却は generation/requestId を持たない専用メッセージ(core-protocol.ts参照)。
  // 通常のcommand分岐より先に見る。
  if (isReturnFrameBufferMessage(data)) {
    releaseBuffer(data.buffer);
    return;
  }
  // 入力更新も同様に generation/requestId を持たない専用メッセージ(手順6・決定7)。
  // 毎フレーム届く高頻度メッセージなので、通常のcommand分岐より先に見る。
  if (isInputUpdateMessage(data)) {
    applyInputUpdate(data.update);
    return;
  }
  // マウス閉ループ追従(手順6後半)の目標更新・再同期コマンド。同じく低頻度の専用メッセージ。
  if (isMouseTrackUpdateMessage(data)) {
    applyMouseTrackUpdate(data.update);
    return;
  }
  if (isMouseTrackResyncMessage(data)) {
    applyMouseTrackResync();
    return;
  }
  const cmd = data as CoreCommand;
  // DEVかつプローブ有効時のみ、command処理の開始/終了時刻を記録する(空白との突き合わせ用。
  // recordCommandTiming内部で import.meta.env.DEV && workerTickProbe.enabled を見て
  // 無効時は何もしない。performance.now()呼び出し自体は軽量なため無効時も許容する)。
  const commandStartAtMs = ctx.performance.now();
  switch (cmd.op) {
    case 'initialize':
      recordCommandTiming(cmd.op, commandStartAtMs, handleInitialize(cmd));
      return;
    case 'loadGame':
      recordCommandTiming(cmd.op, commandStartAtMs, handleLoadGame(cmd));
      return;
    case 'fetchAvInfo':
      recordCommandTiming(cmd.op, commandStartAtMs, handleFetchAvInfo(cmd));
      return;
    case 'setRunning':
      handleSetRunning(cmd);
      recordCommandTiming(cmd.op, commandStartAtMs, undefined);
      return;
    case 'serialize':
    case 'readTextScreen':
    case 'screenshot':
      recordCommandTiming(cmd.op, commandStartAtMs, handleReadTextScreen(cmd));
      return;
    case 'dispose':
      recordCommandTiming(cmd.op, commandStartAtMs, handleDispose(cmd));
      return;
    // 手順8(FDD/MEMFSの不可分操作とオートセーブ、docs/STORAGE-SCSI.md参照)。
    case 'hotSwapFdd':
      handleHotSwapFdd(cmd);
      recordCommandTiming(cmd.op, commandStartAtMs, undefined);
      return;
    case 'captureDirtyMedia':
      handleCaptureDirtyMedia(cmd);
      recordCommandTiming(cmd.op, commandStartAtMs, undefined);
      return;
    case 'markDirty':
      handleMarkDirty(cmd);
      recordCommandTiming(cmd.op, commandStartAtMs, undefined);
      return;
    // 以下は今回もスコープ外(音声・SRAM・ステート保存/復元)。UNSUPPORTED を返す。
    // main.ts 側で「?worker=1 では未対応」と利用者に見える形にする(無言のno-opにしない。
    // docs/STORAGE-SCSI.md参照)。入力(手順6)は INPUT_UPDATE_KIND の専用メッセージへ
    // 移したため、この switch には含まれない(ctx.onmessage 冒頭の isInputUpdateMessage
    // 分岐を参照)。
    case 'readMemory': {
      post({
        kind: 'response',
        generation: cmd.generation,
        requestId: cmd.requestId,
        ok: false,
        error: createCoreError(
          'UNSUPPORTED',
          `${cmd.op} はWorker経路でまだ実装していません(段階移行の対象外。docs参照)`,
          { operation: cmd.op },
        ),
      });
      return;
    }
    default: {
      const _exhaustive: never = cmd;
      void _exhaustive;
    }
  }
};

// 起動ハンドシェイク(実測により追加): `ctx.onmessage` を登録した直後のこの時点で、
// Worker側は main からの command を受け取れる状態になっている。しかし実測では、
// main が `new Worker(...)` 直後に送った最初の command(initialize)がここまで一度も
// 届かず、応答timeoutでしか失敗が検知できないことがあった(module worker は import
// グラフの解決・フェッチに実時間がかかり、その間 main から届いたメッセージを取りこぼす
// ため。`self.onmessage` が実際にセットされた後の話ではなく、それより前に送られた
// メッセージがロストする)。そのため、起動が完了したこの時点で明示的に合図
// (WORKER_BOOT_ACK_KIND)を送り返し、main 側(src/core-proxy.ts の WorkerCoreProxy)は
// これを受け取るまで実際の postMessage を保留する形にした。
ctx.postMessage({ kind: WORKER_BOOT_ACK_KIND });
