// Worker 境界のメッセージプロトコル (docs/STORAGE-SCSI.md「ワーカー境界のAPI設計」参照)。
//
// 「段階移行の順序」手順1: generation・request/response・エラー・transferable 所有権を
// 先に固定する。ここではメッセージの型とヘルパのみを定義し、実際に Worker へ送る配線は
// 手順4以降で行う。
//
// AvInfo / TextScreenDump は既存実装 (src/libretro-host.ts / src/text-screen.ts) の型を
// そのまま再輸出する。ここで重複定義はしない。

import type { AvInfo } from './libretro-host';
import type { TextScreenDump } from './text-screen';

export type { AvInfo, TextScreenDump };

// --- 時系列識別子 ------------------------------------------------------
//
// generation は Worker 再生成ごとに増える。requestId は同一 generation 内の応答照合専用で、
// 時系列の基準にはしない。時系列の唯一の基準は起動後に完了した retro_run() の累積数 frameNo。

export type Generation = number;
export type RequestId = number;
/** 起動後に完了した retro_run() の累積数。境界上の時系列識別子はこれだけを使う。 */
export type FrameNo = number;

// --- command / response / event の骨格 ---------------------------------

export type MainToWorker = CoreCommand;
export type WorkerToMain = CoreResponse | CoreEvent;

// --- Worker起動ハンドシェイク --------------------------------------------
//
// 実測(docs/STORAGE-SCSI.md 手順4参照): モジュールworkerは`new Worker(...)`直後に
// postMessageした最初のcommandを取りこぼすことがある(module worker はimportの解決・
// フェッチに実時間がかかり、その間に届いたメッセージが失われるため。`self.onmessage`が
// 実際にセットされた後もこの取りこぼしは起こる)。これは command/response/event の
// 通常プロトコル(generation付き)とは別物の、起動確認専用の1回きりの合図なので、
// generationを持たない専用の型として区別する。worker側は起動直後(onmessage登録直後)に
// これを1回だけ送り、main側はこれを受け取るまで実際のpostMessageを保留する。
export const WORKER_BOOT_ACK_KIND = 'workerBootAck' as const;

export interface WorkerBootAck {
  kind: typeof WORKER_BOOT_ACK_KIND;
}

export function isWorkerBootAck(message: unknown): message is WorkerBootAck {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { kind?: unknown }).kind === WORKER_BOOT_ACK_KIND
  );
}

// --- フレームバッファ返却 (手順5・7: 映像転送方式・バッファ返却) ------------------
//
// メインが putImageData() し終えた ArrayBuffer を Worker へ送り返し、Worker側のプールで
// 使い回すための専用メッセージ。command/response(generation・requestId付き)の枠には
// 乗せない: 応答を待つ必要が無い一方向のfire-and-forgetであり、Workerが1フレーム進める
// たびに送られる高頻度のメッセージなので、pending Map への登録・timeoutタイマーの生成といった
// 通常command一件ぶんのオーバーヘッドを毎フレーム払いたくない。WORKER_BOOT_ACK_KINDと同様、
// generationを持たない専用の型として区別する。
export const RETURN_FRAME_BUFFER_KIND = 'returnFrameBuffer' as const;

export interface ReturnFrameBufferMessage {
  kind: typeof RETURN_FRAME_BUFFER_KIND;
  buffer: ArrayBuffer;
}

export function isReturnFrameBufferMessage(message: unknown): message is ReturnFrameBufferMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { kind?: unknown }).kind === RETURN_FRAME_BUFFER_KIND
  );
}

// --- 入力更新 (手順6: 入力) ---------------------------------------------
//
// 決定7(2026-08-31、docs/STORAGE-SCSI.md「ワーカー移行 手順6」参照): 当初 updateInput は
// CoreCommand の一員(generation/requestId付きでresponseを期待する形)だったが、毎フレーム
// 送るには往復が無駄である。入力は「最新が勝つ」性質で個別の成否確認に意味がなく、
// inputGeneration による世代破棄の設計と整合するため、RETURN_FRAME_BUFFER_KIND と同様の
// 「requestId を持たない専用メッセージ」に変更した。postMessage は順序保証があるため、
// 加算 mouseDelta が片道でも取りこぼされない。
export const INPUT_UPDATE_KIND = 'inputUpdate' as const;

export interface InputUpdateMessage {
  kind: typeof INPUT_UPDATE_KIND;
  update: InputUpdate;
}

export function isInputUpdateMessage(message: unknown): message is InputUpdateMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { kind?: unknown }).kind === INPUT_UPDATE_KIND
  );
}

export type CoreCommand =
  | {
      kind: 'command';
      generation: Generation;
      requestId: RequestId;
      op: 'initialize';
      payload: InitPayload;
    }
  | {
      kind: 'command';
      generation: Generation;
      requestId: RequestId;
      op: 'loadGame';
      payload: { path?: string };
    }
  | {
      kind: 'command';
      generation: Generation;
      requestId: RequestId;
      op: 'setRunning';
      payload: { running: boolean };
    }
  | {
      kind: 'command';
      generation: Generation;
      requestId: RequestId;
      op: 'hotSwapFdd';
      payload: HotSwapFddPayload;
    }
  | {
      kind: 'command';
      generation: Generation;
      requestId: RequestId;
      op: 'serialize' | 'readTextScreen' | 'screenshot';
      payload: Record<string, never>;
    }
  | {
      kind: 'command';
      generation: Generation;
      requestId: RequestId;
      op: 'readMemory';
      payload: { address: number; length: number };
    }
  | {
      kind: 'command';
      generation: Generation;
      requestId: RequestId;
      // fetchAvInfo と dispose はそれぞれ独立した union member にする(他のopと同じ member に
      // 複数opを束ねると Extract<CoreCommand, { op: 'fetchAvInfo' }> 等が `never` になり、
      // op ごとに引数を絞った handler 関数(core-worker.ts参照)が書けなくなるため)。
      op: 'fetchAvInfo';
      payload: Record<string, never>;
    }
  | {
      kind: 'command';
      generation: Generation;
      requestId: RequestId;
      op: 'dispose';
      payload: Record<string, never>;
    };

export type CoreResponse =
  | {
      kind: 'response';
      generation: Generation;
      requestId: RequestId;
      ok: true;
      completedFrameNo: FrameNo;
      result: unknown;
    }
  | {
      kind: 'response';
      generation: Generation;
      requestId: RequestId;
      ok: false;
      completedFrameNo?: FrameNo;
      error: CoreError;
    };

export type CoreEvent =
  | { kind: 'event'; generation: Generation; event: 'ready'; avInfo: AvInfo }
  | { kind: 'event'; generation: Generation; event: 'frame'; snapshot: FrameSnapshot }
  | {
      kind: 'event';
      generation: Generation;
      event: 'sramChanged';
      frameNo: FrameNo;
      bytes: ArrayBuffer;
      keyRepeat?: KeyRepeatConfig;
    }
  | { kind: 'event'; generation: Generation; event: 'fatal'; error: CoreError };

export interface KeyRepeatConfig {
  delayMs: number;
  intervalMs: number;
}

/** 文書に列挙された6種 + Worker/messageerror/timeout/突然終了を束ねる WORKER_FAILURE。 */
export type CoreErrorCode =
  | 'INVALID_STATE'
  | 'INVALID_ARGUMENT'
  | 'LOAD_FAILED'
  | 'IO_FAILED'
  | 'UNSUPPORTED'
  | 'CORE_FAILURE'
  | 'WORKER_FAILURE';

export interface CoreError {
  code: CoreErrorCode;
  message: string;
  operation?: string;
  recoverable: boolean;
  /** structured-clone 可能な診断情報だけを入れる。関数・DOM要素・循環参照は入れない。 */
  details?: unknown;
}

// --- initialize ----------------------------------------------------------

/**
 * BIOS/CGROM/SRAM、起動時オプション、初期ディスク、OffscreenCanvas(採用する場合)を渡す。
 * 大きな ArrayBuffer と canvas は transfer list で渡す。
 *
 * 2026-08-28追記(手順4→7実装時の訂正): 当初は「メッセージ量を抑えるため path 参照のみ」の
 * 想定だった(下の旧コメント参照)が、Worker はメインの MEMFS を共有していないため、path 参照
 * だけでは Worker 側が中身を読めず起動できない。初回起動時のディスクマウントは(FDDホット
 * マウントと違い)実行中の差し替えではなく1回きりの書き込みなので、実体の bytes をここへ
 * 含める形に変更した(initialDisks の bytes は initialize の transfer list に載る)。
 *
 * 旧コメント(参考): 「設計文書は『初期ディスク参照』としか書いておらず、bytesを含めるか
 * path参照のみにするかは明記されていない。ここではメッセージ量を抑えるためpath参照のみとした」。
 */
export interface InitPayload {
  biosIpl: ArrayBuffer;
  biosCg: ArrayBuffer;
  sram?: ArrayBuffer;
  options?: Record<string, string>;
  initialDisks?: Array<{ slot: 'fdd0' | 'fdd1' | 'hdd'; name: string; bytes: ArrayBuffer }>;
  offscreenCanvas?: OffscreenCanvas;
}

// --- 入力 ------------------------------------------------------------------

export interface InputUpdate {
  /** 押下中の RETROK 値集合。 */
  keys: number[];
  /** 2 port ぶんの解決済み RetroPad ビットマスク。 */
  pads: [number, number];
  mouseButtons: { left: boolean; right: boolean };
  /** 前回送信からの加算 delta (ゲスト1ドット単位)。 */
  mouseDelta: { dx: number; dy: number };
  /** blur/visibility の clearInput で進める入力世代。古い世代の更新は Worker 側で無視する。 */
  inputGeneration: number;
  /**
   * 決定8(2026-08-31): KeyRepeater は押下状態を変えずに make だけを注入する
   * (host.sendKeyMake(retrok))。この経路が無いとキーリピートが Worker 経路で死ぬため、
   * 「この更新で追加注入する make の RETROK 配列」を持たせる。main 側は送信後にクリアする
   * (加算 mouseDelta と同じ扱い)。
   */
  keyMakes: number[];
}

// --- フレームスナップショット -----------------------------------------------

export interface FrameSnapshot {
  frameNo: FrameNo;
  av: {
    fps: number;
    sampleRate: number;
    width: number;
    height: number;
  };
  video:
    | { kind: 'offscreen'; changed: boolean }
    | { kind: 'bitmap'; bitmap: ImageBitmap }
    | { kind: 'rgba'; bytes: ArrayBuffer; width: number; height: number };
  audio: {
    /** Float32、stereo interleaved。 */
    chunks: ArrayBuffer[];
    sampleFrames: number;
  };
  disk: {
    access: { fddReading: boolean; fddDrive: number; hddAccessing: boolean };
    dirty: { fddMask: number; hdd: boolean };
  };
  /** プールが空で新規 ArrayBuffer を確保した累積回数(起動からの累計)。
   * バッファ返却(RETURN_FRAME_BUFFER_KIND)が効いていれば起動時の数件で頭打ちになるはず。
   * 返却が黙って失敗している(取りこぼし)ときに気づけるようにするための観測値
   * (docs/STORAGE-SCSI.md 参照。「効果があった」の確認ではなく、取りこぼしの検知が目的)。 */
  poolMisses: number;
  /**
   * DEV専用・既定off: KeyBuf(wasm内128バイトリングバッファ)全体のスナップショット
   * (docs/STORAGE-SCSI.md「KeyBufプローブのWorker対応」参照)。
   *
   * Worker経路(?worker=1)では host が main 側に無いため、既定経路の
   * host.readKeyBufWindow()(HEAPを直接読む同期呼び出し)が使えない。しかし
   * これをそのままasync化してWorkerへrequest/responseで問い合わせると、
   * postMessageの往復遅延が回帰検出の主指標(「キー KeyBuf 2回目」)にそのまま乗り、
   * 移行前基準(4.3〜4.9ms)と比較できなくなる(物差しが変わる)。
   *
   * そのため、Workerが毎フレームこのフィールドへ KeyBuf 全体
   * (LibretroHost.readKeyBufWindow(0, 128) と同じ、index 0..127 の物理位置)と
   * その時点の writePointer を frame event に相乗りさせ、main 側は直近受信分から
   * **同期のまま** 切り出して返す(src/keybuf-probe.ts の sliceKeyBufSnapshot、
   * src/main.ts の __webx68kDebug.keybuf())。frame event 単位でしか更新されないため、
   * 最大1フレーム(60fpsで約16.7ms)分の遅れを持ちうる。
   *
   * 128バイト/フレームを常時運ぶのは計測専用のコストなので、既存の workerTickProbe /
   * frameProbe / storageProbe と同じ作法で `import.meta.env.DEV` かつ既定offにし、
   * 有効化して初めて載る(src/core-worker.ts の '__devKeyBufProbe' 制御メッセージ参照)。
   * 無効時・prodビルドではこのフィールド自体が存在しない(undefined)。
   */
  keyBufProbe?: KeyBufFrameProbe;
}

export interface KeyBufFrameProbe {
  writePointer: number;
  /** index 0..127(物理位置)。LibretroHost.readKeyBufWindow(0, 128) の bytes と同じ並び。 */
  bytes: number[];
}

// --- command と不可分操作 -----------------------------------------------

export interface HotSwapFddPayload {
  drive: 0 | 1;
  image: null | { name: string; bytes: ArrayBuffer };
}

export interface HotSwapFddResult {
  previousImage: ArrayBuffer | null;
  mountedPath: string | null;
}

/**
 * Worker 内の一つの handler で完了させる不可分操作。
 * 交換: eject旧 → 旧イメージ読出し → 新イメージwrite → insert新
 * 排出: eject旧 → 旧イメージ読出し → 不要ファイルunlink
 */
export type AtomicCommand =
  | { op: 'hotSwapFdd'; payload: HotSwapFddPayload }
  | { op: 'exportLiveMedia'; payload: { slot: 'fdd0' | 'fdd1' | 'hdd' } }
  | { op: 'captureDirtyMedia'; payload: { slots: Array<'fdd0' | 'fdd1' | 'hdd'> } }
  | { op: 'finishDirtyCapture'; payload: { token: string; persisted: boolean } }
  | { op: 'flushAndClose'; payload: Record<string, never> };

// --- proxy の公開形状 --------------------------------------------------

/**
 * 例として文書に示された形。同期戻り値だけを Promise に置き換えたもの。
 * 実際の LibretroHostProxy インタフェース(既存メソッドとの突き合わせ込み)は core-proxy.ts。
 */
export interface LibretroHostProxyShape {
  init(payload: InitPayload): Promise<void>;
  setCoreOption(key: string, value: string): Promise<void>;
  loadGame(path: string): Promise<boolean>;
  fetchAvInfo(): Promise<AvInfo>;
  serialize(): Promise<ArrayBuffer | null>;
  unserialize(bytes: ArrayBuffer): Promise<boolean>;
  readTextScreen(): Promise<TextScreenDump>;
  readMemory(address: number, length: number): Promise<ArrayBuffer>;
  hotSwapFdd(payload: HotSwapFddPayload): Promise<HotSwapFddResult>;
  dispose(): Promise<void>;
}

// --- 型ガード ----------------------------------------------------------

export function isCoreResponse(message: WorkerToMain): message is CoreResponse {
  return message.kind === 'response';
}

export function isCoreEvent(message: WorkerToMain): message is CoreEvent {
  return message.kind === 'event';
}

// --- エラーファクトリ ----------------------------------------------------

export function createCoreError(
  code: CoreErrorCode,
  message: string,
  opts?: { operation?: string; recoverable?: boolean; details?: unknown },
): CoreError {
  return {
    code,
    message,
    operation: opts?.operation,
    // 既定は「回復不能」側に倒す。呼び出し側が明示的に recoverable: true を渡した場合のみ緩める。
    recoverable: opts?.recoverable ?? false,
    details: opts?.details,
  };
}

/** proxy が command の失敗を呼び出し側へ伝える例外。CoreError をそのまま保持する。 */
export class CoreProxyError extends Error {
  readonly coreError: CoreError;

  constructor(coreError: CoreError) {
    super(coreError.message);
    this.name = 'CoreProxyError';
    this.coreError = coreError;
  }
}

// --- transferable 収集 ----------------------------------------------------

/**
 * command/response/event から postMessage の transfer list に載せるべき
 * ArrayBuffer / ImageBitmap / OffscreenCanvas を集める。
 *
 * 文書の transferable 所有権規約: 音声チャンク・映像・ステート・ディスクイメージ・
 * メモリ範囲は transferable として渡し、送信側は detach 後の配列を再利用しない。
 * ここが規約の実体になるため、種別を1つずつ具体的にケースで拾う(汎用の deep walk はしない。
 * 意図しない ArrayBuffer まで transfer してしまう事故を避けるため)。
 */
export function collectTransferables(
  message: MainToWorker | WorkerToMain,
): Transferable[] {
  const out: Transferable[] = [];

  if (message.kind === 'command') {
    switch (message.op) {
      case 'initialize': {
        const p = message.payload;
        out.push(p.biosIpl, p.biosCg);
        if (p.sram) out.push(p.sram);
        if (p.initialDisks) for (const d of p.initialDisks) out.push(d.bytes);
        if (p.offscreenCanvas) out.push(p.offscreenCanvas);
        break;
      }
      case 'hotSwapFdd': {
        const image = message.payload.image;
        if (image) out.push(image.bytes);
        break;
      }
      case 'loadGame':
      case 'setRunning':
      case 'serialize':
      case 'readTextScreen':
      case 'screenshot':
      case 'fetchAvInfo':
      case 'dispose':
      case 'readMemory':
        break;
      default: {
        const _exhaustive: never = message;
        void _exhaustive;
      }
    }
    return out;
  }

  if (message.kind === 'response') {
    if (message.ok) {
      collectResultTransferables(message.requestId, message.result, out);
    }
    return out;
  }

  // event
  switch (message.event) {
    case 'frame': {
      const snapshot = message.snapshot;
      if (snapshot.video.kind === 'bitmap') out.push(snapshot.video.bitmap);
      else if (snapshot.video.kind === 'rgba') out.push(snapshot.video.bytes);
      for (const chunk of snapshot.audio.chunks) out.push(chunk);
      break;
    }
    case 'sramChanged':
      out.push(message.bytes);
      break;
    case 'ready':
    case 'fatal':
      break;
    default: {
      const _exhaustive: never = message;
      void _exhaustive;
    }
  }
  return out;
}

/**
 * response.result は unknown なので op ごとの形は分からない。ただし transferable になり得る
 * 形は文書上限られている(ArrayBuffer 単体・ArrayBuffer|null・HotSwapFddResult)ので、
 * それらだけを構造で判定して拾う。未知の形は無視する(=素の値のまま構造化複製される)。
 */
function collectResultTransferables(_requestId: RequestId, result: unknown, out: Transferable[]): void {
  if (result instanceof ArrayBuffer) {
    out.push(result);
    return;
  }
  if (result && typeof result === 'object') {
    const r = result as Partial<HotSwapFddResult>;
    if ('previousImage' in r && (r.previousImage instanceof ArrayBuffer || r.previousImage === null)) {
      if (r.previousImage instanceof ArrayBuffer) out.push(r.previousImage);
    }
  }
}
