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

// --- マウス閉ループ追従 (手順6後半: マウスの閉ループ追従、docs/STORAGE-SCSI.md
// 「ワーカー移行 手順6後半」参照) ------------------------------------------------
//
// 決定: ラウンドトリップ方式(main が cursor を運んでもらい main が計算して delta を送り返す)
// は採らない。閉ループが1フレーム以上の遅延を持つと ack 待ち・stall 判定の前提が壊れ、
// 収束しなくなるため。閉ループそのもの(cursor読み取り→差分計算→addMouseDelta)は Worker
// (src/core-worker.ts)内で完結させ、main→Worker は「目標比率と有効/無効」だけを送る
// 低頻度の片道メッセージにする(INPUT_UPDATE_KINDと同じ「requestIdを持たない専用メッセージ」)。
export const MOUSE_TRACK_UPDATE_KIND = 'mouseTrackUpdate' as const;

export interface MouseTrackUpdate {
  /** 追従モードが今アクティブか(ENABLE_MOUSE_TRACKING && running && !isMouseCaptured()、
   * main側で計算した値をそのまま渡す。pointer lock の状態はmainにしか分からないため)。 */
  enabled: boolean;
  /** ホスト側カーソルの canvas 内相対位置(0..1)。 */
  ratioX: number;
  ratioY: number;
}

export interface MouseTrackUpdateMessage {
  kind: typeof MOUSE_TRACK_UPDATE_KIND;
  update: MouseTrackUpdate;
}

export function isMouseTrackUpdateMessage(message: unknown): message is MouseTrackUpdateMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { kind?: unknown }).kind === MOUSE_TRACK_UPDATE_KIND
  );
}

/** ツールバーの「マウス再同期」。ユーザー操作契機の低頻度メッセージなので、これも
 * generation/requestId を持たない専用メッセージにする(応答を待つ必要が無いため)。 */
export const MOUSE_TRACK_RESYNC_KIND = 'mouseTrackResync' as const;

export interface MouseTrackResyncMessage {
  kind: typeof MOUSE_TRACK_RESYNC_KIND;
}

export function isMouseTrackResyncMessage(message: unknown): message is MouseTrackResyncMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { kind?: unknown }).kind === MOUSE_TRACK_RESYNC_KIND
  );
}

// --- 速度倍率(コーディネータ指摘への対応、2026-08-31: 「速度変更がWorker経路で
// 効かないのに効いたように見える」欠陥の是正) --------------------------------------
//
// 手順5・7時点では「速度ボタンは未移行」としてWorker側をspeedMultiplier=1固定にしていたが、
// UI側(src/main.tsのbtnSpeed/cfgSpeed)はurlWorkerModeを見ずに押し込み表示・バッジを
// 出していたため、実際には何も変わらないのに変わったかのような嘘をつく状態になっていた
// (docs/STORAGE-SCSI.md「ワーカー移行 手順9」内「Worker経路で効かないのに効いたように
// 見える機能の洗い出し」参照)。MOUSE_TRACK_UPDATE_KINDと同じ理由(低頻度・応答不要)で
// generation/requestIdを持たない専用メッセージにする。
export const SPEED_UPDATE_KIND = 'speedUpdate' as const;

export interface SpeedUpdateMessage {
  kind: typeof SPEED_UPDATE_KIND;
  /** 実効速度倍率。1が等倍(ボタンOFF相当)。0以下や非有限値は受信側で1に丸める。
   * unlimitedがtrueのときはWorker側では使わない(main側のUI表示計算にのみ使われる)。 */
  multiplier: number;
  /** 無制限速度モード(手順9追加分の是正、docs/STORAGE-SCSI.md参照)。trueのときWorker側は
   * multiplierを無視し、src/worker-drive-loop.tsのrunUnlimitedTick()経路を使う。
   * 未指定はfalse扱い(既存メッセージ・既存呼び出しとの後方互換)。 */
  unlimited?: boolean;
}

export function isSpeedUpdateMessage(message: unknown): message is SpeedUpdateMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { kind?: unknown }).kind === SPEED_UPDATE_KIND
  );
}

// --- SCSI(OPFS) 明示flush(取りこぼしの窓の是正、docs/STORAGE-SCSI.md参照) -----------
//
// 本命は src/scsi-opfs.ts 側のデバウンス(書き込みが止まったら短時間で自動flush)。
// これはその上積みで、ページ離脱イベント(pagehide/visibilitychange/freeze、src/main.ts)を
// 受けて「今すぐflushして」とWorkerへ伝える片道メッセージ。ページが破棄される瞬間の
// postMessageが届く保証は無いので、これで確実に間に合うわけではない
// (だからこそデバウンスが本命)。SPEED_UPDATE_KINDと同じ理由(低頻度・応答不要)で
// generation/requestIdを持たない専用メッセージにする。
export const FLUSH_SCSI_KIND = 'flushScsi' as const;

export interface FlushScsiMessage {
  kind: typeof FLUSH_SCSI_KIND;
}

export function isFlushScsiMessage(message: unknown): message is FlushScsiMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { kind?: unknown }).kind === FLUSH_SCSI_KIND
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
      // 手順8(FDD/MEMFSの不可分操作とオートセーブ、docs/STORAGE-SCSI.md参照): 「dirtyか読む→
      // イメージを読み出す→dirtyを落とす」を1つのcommandに折り畳んだもの。main側は
      // 対象スロットを指定するだけで、読み出しとdirtyクリアはWorker内の1つのハンドラで
      // 完結する(src/worker-dirty-capture.ts の WorkerMediaState#captureSlot 参照)。
      op: 'captureDirtyMedia';
      payload: CaptureDirtyMediaPayload;
    }
  | {
      kind: 'command';
      generation: Generation;
      requestId: RequestId;
      // 手順8: 永続化(IndexedDBへの保存)が失敗したとき、そのスロットのダーティフラグを
      // 立て直す(再dirty化)。px68k本体にはフラグを外から立てるAPIが無いため、Worker側の
      // 影のフラグ(WorkerMediaState#markDirty)を操作する(src/worker-dirty-capture.ts参照)。
      op: 'markDirty';
      payload: MarkDirtyPayload;
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
  | { kind: 'event'; generation: Generation; event: 'fatal'; error: CoreError }
  | { kind: 'event'; generation: Generation; event: 'mouseTrackDisabled' };

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
/**
 * `collectHostGlobals()`(main.ts)が Worker へ写せる値の型。structured clone で運べる型の
 * うち、実際に `__webx68k*` の設定として使われている範囲(プリミティブ・配列・バイト列)に
 * 限定して列挙する(汎用の deep clone 判定はしない。関数やSymbol等、写せない値は
 * ここに含めず、呼び出し側が警告を出したうえで除外する)。
 *
 * ArrayBuffer/ArrayBufferView/配列を含めたのは2026-09-04の修正(docs/STORAGE-SCSI.md参照):
 * 以前は string/number/boolean しか転写せず、配列等で渡す設定(例: ROM本体を渡す設定)が
 * 無言で落ち、Worker側は気づかずフォールバックに切り替わっていた。
 */
export type HostGlobalValue =
  | string
  | number
  | boolean
  | ArrayBuffer
  | ArrayBufferView
  | unknown[];

export interface InitPayload {
  biosIpl: ArrayBuffer;
  biosCg: ArrayBuffer;
  sram?: ArrayBuffer;
  options?: Record<string, string>;
  initialDisks?: Array<{ slot: 'fdd0' | 'fdd1' | 'hdd'; name: string; bytes: ArrayBuffer }>;
  offscreenCanvas?: OffscreenCanvas;
  /**
   * ページ(main)側の `globalThis.__webx68k*` のうち、structured clone で運べる値
   * (string/number/boolean/ArrayBuffer/ArrayBufferView/配列)をそのまま Worker の
   * globalThis へ写すための橋。SCSI の設定(__webx68kScsiUrl 等)や計測用の監視範囲
   * (__webx68kRamWatchLo 等)は wasm から globalThis 経由で読まれるため、
   * Worker 経路ではこれを渡さないと丸ごと効かない(2026-09-03 実測: SCSI-BPB読み出し失敗
   * → SCSIドライバとして名乗らない → ゲストで「ドライブ名が無効です」)。
   * **初期化時に1回だけ写す**。実行中に main 側で値を変えても Worker には反映されない。
   *
   * ここに含まれる ArrayBuffer/ArrayBufferView は `collectTransferables()` が
   * `initialize` の transfer list に加える対象として列挙していないため、postMessage の
   * 既定動作(structured clone によるコピー)で渡る。main.ts 側の実体は detach されず
   * 無傷のまま残る(biosIpl/biosCg等と違い、意図的にコピー渡しにしている)。
   */
  hostGlobals?: Record<string, HostGlobalValue>;
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
  /**
   * DEV専用・既定off(keyBufProbeと同じ有効化フラグに相乗り): KeyBufの writePointer が
   * 最後に動いた(=何か書かれた)ときの frameNo。「注入の遅れ」(keydown発生→updateInput
   * 送信→実際に適用されたフレーム)と「観測の遅れ」(書かれたフレーム→mainが知るフレーム)
   * を切り分けるための帰属計測専用フィールド(docs/STORAGE-SCSI.md「KeyBufプローブの
   * Worker対応」節、2026-08-31訂正の「帰属の切り分け」参照)。
   *
   * 時刻(performance.now())ではなくフレーム数で持つ理由: main と Worker は別スレッドで
   * timeOrigin が揃わないため、2つのログを1本の時計に載せられない(過去の教訓
   * 「2つのログには1本のクロックが要る」)。frameNo は境界上の唯一の時系列識別子
   * (このファイル冒頭のコメント参照)であり、スレッドをまたいでも比較可能。
   *
   * 1tickで複数フレーム進んだ場合(取り戻し発生時)、この値は「そのtickで最後に実行された
   * フレームのframeNo」になる(tick内のどの内部フレームで実際に書かれたかまでは区別
   * しない。sendFrame()は1tickにつき1回しか呼ばれないため)。書き込みが無いフレームでは
   * 直前の値を保持する(sticky)。有効化直後・書き込みがまだ一度も無い間は undefined。
   */
  keyBufWriteFrameNo?: FrameNo;
  /**
   * DEV専用・既定off(keyBufProbeと同じ有効化フラグに相乗り、2026-08-31追加)。
   * `INPUT_UPDATE_KIND` を Worker が実際に適用した(applyInputUpdate()を実行した)瞬間に
   * Worker自身が読んだ frameNo。「真の注入」(コア側の遅れ)と「伝送＋陳腐化」(mainがWorkerの
   * 時計をどれだけ古く見ているか)を分離するための帰属計測フィールド
   * (docs/STORAGE-SCSI.md「帰属の定義の誤りと訂正」参照)。
   *
   * 導入の経緯: 旧定義(`keyBufWriteFrameNo - inputSendFrameNo`)は`inputSendFrameNo`を
   * main側の`workerLastFrameNo`(直近に受け取ったframe eventのframeNo)から作っていたが、
   * これはWorkerが実際に入力を適用した時点では既に古くなっている値であり、既定経路の
   * `inputSendFrameNo`(同一スレッド上の生きた値で陳腐化しない)と同じ量を測っていなかった。
   * この`inputApplyFrameNo`はWorker自身が単一クロック(frameNo)上で記録するため、
   * `keyBufWriteFrameNo - inputApplyFrameNo`(=真の注入)は既定経路の
   * `writeFrameNo - inputSendFrameNo` と直接比較できる同じ量になる。
   *
   * keyBufWriteFrameNoと同じくsticky(適用が無いフレームでは直前の値を保持)。
   * 有効化直後・まだ一度も適用が無い間は undefined。
   */
  inputApplyFrameNo?: FrameNo;
  /**
   * DEV専用・既定off(2026-08-31、手順6後半「マウス閉ループ追従の移行」追加)。
   * `__webx68kDebug.mouse()`(src/main.ts)をWorker経路でも同期のまま返すための、
   * KeyBufプローブと同じ「frame event 相乗り＋main側は直近スナップショットを同期で返す」方式。
   * 有効化フラグは keyBufProbe と共用する(`__devKeyBufProbe`。専用の制御メッセージを別に
   * 増やすほどの理由が無いため。docs/STORAGE-SCSI.md参照)。無効時・prodビルドではこの
   * フィールド自体が存在しない(undefined)。main側は「未対応」(urlWorkerModeでない)と
   * 「無効」(プローブ未有効化)と「有効だがまだ1フレームも受信していない」を区別できる形
   * (workerProbeDisabled/workerProbePending)で返す(keybuf()フックと同じ作法)。
   */
  mouseTrackProbe?: MouseTrackFrameProbe;
  /**
   * 調査用(2026-09-04、docs/STORAGE-SCSI.md参照): console.log/log_cbを一切経由しない
   * SCSI要求カウンタ(host.scsiDebugCounters())をWorker経路でも読めるようにする、
   * mouseTrackProbeと同じ「keyBufProbeの有効化フラグに相乗り」方式。
   * 「SCSI要求が本当に来なくなったか」をログの取りこぼしや上限とは無関係に
   * 確かめるためのもの。無効時・古いwasmではこのフィールド自体が存在しない。
   */
  scsiDebugProbe?: ScsiDebugFrameProbe;
}

/** host.scsiDebugCounters()と同じ形。core-worker.ts/src/main.tsで共有する。 */
export interface ScsiDebugFrameProbe {
  reqTotal: number;
  unsupported: number;
  readCount: number;
  lastReadUnit: number;
  lastReadLogsec: number;
  writeCount: number;
  lastWriteUnit: number;
  lastWriteLogsec: number;
  strategyCallCount: number;
  interruptCallCount: number;
  // 調査用(2026-09-04、docs/STORAGE-SCSI.md参照): SASI(成功する側)の裏取り用カウンタ。
  sasiReqTotal: number;
  sasiReadCount: number;
  sasiLastReadLba: number;
  sasiWriteCount: number;
  sasiLastWriteLba: number;
}

export interface MouseTrackFrameProbe {
  /** host.hasPendingMouseDelta()。 */
  pending: boolean;
  /** host.readGuestCursor()。ワークエリア未初期化なら null。 */
  cursor: {
    x: number;
    y: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    visible: boolean;
  } | null;
  /** host.readMouseState()。 */
  core: {
    dx: number;
    dy: number;
    stat: number;
    enabled: boolean;
    sccX: number;
    sccY: number;
    sccStat: number;
  };
}

export interface KeyBufFrameProbe {
  writePointer: number;
  /** index 0..127(物理位置)。LibretroHost.readKeyBufWindow(0, 128) の bytes と同じ並び。 */
  bytes: number[];
}

// --- command と不可分操作 -----------------------------------------------

export type DiskSlotId = 'fdd0' | 'fdd1' | 'hdd';

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
 *
 * 手順8実装時の訂正(docs/STORAGE-SCSI.md「ワーカー移行 手順8」参照): 実際に CoreCommand へ
 * 足したのは `hotSwapFdd`(既存)と `captureDirtyMedia`/`markDirty` の3opのみ。
 * `exportLiveMedia`/`flushAndClose` はここでは実装しなかった(前者はファイルマネージャ用の
 * openSlotVolume()経由の吸い出しに相当し、今回の手順8のスコープ(hot swap/dirty
 * capture/オートセーブ/終了flush)には含めていない。後者は「終了flush」に相当するが、
 * 専用opは作らず既存の captureDirtyMedia を main側から呼ぶ形にした。理由は「離脱時
 * イベントに保存を託さず平常時に短間隔で保存する」設計方針により、終了flushはあくまで
 * 保険でしかないため、専用のcommandを増やすほどの理由がないと判断したため)。
 * `finishDirtyCapture` はtoken方式(captureが返すtokenをfinishへ渡して照合する設計)を
 * 想定していたが、実装では `markDirty(slots)` という slot 指定・token 無しの単純な形に
 * 変えた。永続化の成否に関わらず「再dirty化」は単に対象スロットの影のフラグを立てる
 * だけの操作であり(src/worker-dirty-capture.ts の WorkerMediaState 参照)、次に同じ
 * スロットが captureDirtyMedia されるまで何度立てても副作用が無い(冪等)ため、
 * 呼び出しの順序や重複を token で厳密に照合する必要が無いと判断した。
 */
export type AtomicCommand =
  | { op: 'hotSwapFdd'; payload: HotSwapFddPayload }
  | { op: 'exportLiveMedia'; payload: { slot: DiskSlotId } }
  | { op: 'captureDirtyMedia'; payload: { slots: DiskSlotId[] } }
  | { op: 'finishDirtyCapture'; payload: { token: string; persisted: boolean } }
  | { op: 'flushAndClose'; payload: Record<string, never> };

export interface CaptureDirtyMediaPayload {
  slots: DiskSlotId[];
}

export interface CapturedMediaEntry {
  slot: DiskSlotId;
  /** マウントされていないスロットが指定された場合は null。 */
  bytes: ArrayBuffer | null;
}

export interface CaptureDirtyMediaResult {
  captured: CapturedMediaEntry[];
}

export interface MarkDirtyPayload {
  slots: DiskSlotId[];
}

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
      // captureDirtyMedia/markDirty の payload はスロット名の配列だけで ArrayBuffer を
      // 含まない(結果側の captured[].bytes だけが transferable。下の
      // collectResultTransferables 参照)。
      case 'captureDirtyMedia':
      case 'markDirty':
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
    case 'mouseTrackDisabled':
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
 * 形は文書上限られている(ArrayBuffer 単体・ArrayBuffer|null・HotSwapFddResult・
 * CaptureDirtyMediaResult)ので、それらだけを構造で判定して拾う。未知の形は無視する
 * (=素の値のまま構造化複製される)。
 */
function collectResultTransferables(_requestId: RequestId, result: unknown, out: Transferable[]): void {
  if (result instanceof ArrayBuffer) {
    out.push(result);
    return;
  }
  if (result && typeof result === 'object') {
    const r = result as Partial<HotSwapFddResult> & Partial<CaptureDirtyMediaResult>;
    if ('previousImage' in r && (r.previousImage instanceof ArrayBuffer || r.previousImage === null)) {
      if (r.previousImage instanceof ArrayBuffer) out.push(r.previousImage);
    }
    if ('captured' in r && Array.isArray(r.captured)) {
      for (const entry of r.captured) {
        if (entry && entry.bytes instanceof ArrayBuffer) out.push(entry.bytes);
      }
    }
  }
}
