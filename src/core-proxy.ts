// 「段階移行の順序」手順1: 非同期 proxy を導入する。
//
// 実体を Worker へ移す前に、呼び出し側を Promise ベースの interface へ揃えるための
// 同一スレッド adapter (LocalCoreProxy) を提供する。docs/STORAGE-SCSI.md の
// 「proxy の公開形状」を基準に、既存 LibretroHost の public メソッドから
// 非同期化が必要なものを足した LibretroHostProxy を定義する。
//
// runFrame() に相当する RPC はここに作らない。駆動ループは手順7で Worker が持つ
// (文書「段階移行の順序」参照)。

import {
  collectTransferables,
  CoreProxyError,
  createCoreError,
  FLUSH_SCSI_KIND,
  INPUT_UPDATE_KIND,
  isCoreResponse,
  isWorkerBootAck,
  MOUSE_TRACK_RESYNC_KIND,
  MOUSE_TRACK_UPDATE_KIND,
  RETURN_FRAME_BUFFER_KIND,
  SPEED_UPDATE_KIND,
  type CaptureDirtyMediaPayload,
  type CaptureDirtyMediaResult,
  type CoreCommand,
  type CoreErrorCode,
  type CoreEvent,
  type Generation,
  type HostGlobalValue,
  type HotSwapFddPayload,
  type HotSwapFddResult,
  type InputUpdate,
  type MarkDirtyPayload,
  type MouseTrackUpdate,
  type RequestId,
  type WorkerToMain,
} from './core-protocol';
import type { AvInfo, LibretroHost } from './libretro-host';
import type { TextScreenDump } from './text-screen';

/** WorkerCoreProxy#init() の追加引数(InitPayload.initialDisks参照)。main.ts側が
 * slots.fdd0/fdd1/hdd から組み立てて渡す。 */
export interface InitialDiskInput {
  slot: 'fdd0' | 'fdd1' | 'hdd';
  name: string;
  bytes: Uint8Array;
}

/**
 * proxy が公開する形状。docs の例に、既存 LibretroHost の public メソッドのうち
 * 非同期化が自然なものを足した。載せなかった既存メソッドと理由は core-proxy.ts の
 * コメント末尾、および作業報告を参照。
 */
export interface LibretroHostProxy {
  init(biosIpl: Uint8Array, biosCg: Uint8Array, sram?: Uint8Array): Promise<void>;
  setCoreOption(key: string, value: string): Promise<void>;
  loadGame(path: string): Promise<boolean>;
  reset(): Promise<void>;
  fetchAvInfo(): Promise<AvInfo>;
  serialize(): Promise<ArrayBuffer | null>;
  unserialize(bytes: ArrayBuffer): Promise<boolean>;
  readTextScreen(): Promise<TextScreenDump>;
  readMemory(address: number, length: number): Promise<ArrayBuffer>;
  hotSwapFdd(payload: HotSwapFddPayload): Promise<HotSwapFddResult>;
  writeFile(path: string, data: ArrayBuffer): Promise<void>;
  readFile(path: string): Promise<ArrayBuffer>;
  removeFile(path: string): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * LocalCoreProxy が LibretroHost に要求する構造型。
 * `_hostSurfaceCheck` で実体 LibretroHost と突き合わせ、シグネチャがずれたら
 * `npx tsc --noEmit` がここで落ちるようにする。
 */
export interface CoreHostSurface {
  init(biosIpl: Uint8Array, biosCg: Uint8Array, sram?: Uint8Array): Promise<void>;
  setCoreOption(key: string, value: string): void;
  loadGame(path: string): boolean;
  loadGameNone(): boolean;
  unloadGame(): void;
  reset(): void;
  fetchAvInfo(): AvInfo;
  serialize(): Uint8Array | null;
  unserialize(bytes: Uint8Array): boolean;
  readTextScreen(): TextScreenDump;
  peekByte(addr: number): number;
  setFddImage(drive: number, path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  removeFile(path: string): void;
  writeDiskImage(filename: string, data: Uint8Array): string;
  dispose(): void;
}

// 実体との結線検査。値は生成しない(実行時コストゼロ)。型が合わなくなった時点でコンパイルが落ちる。
const _hostSurfaceCheck: CoreHostSurface = null as unknown as LibretroHost;
void _hostSurfaceCheck;

/**
 * bytes がバッファ全体を覆っている(byteOffset===0 かつ byteLength===buffer.byteLength)ときは
 * コピーせず bytes.buffer をそのまま返す。より大きい ArrayBuffer の一部を指している(subarray)
 * ときだけ、独立した ArrayBuffer が必要なので slice() でコピーする。
 *
 * 戻り値は「以後 bytes 側を参照しない」前提で渡すための ArrayBuffer(=呼び出し側の所有権を
 * 手放す関数)。unserialize/writeFile のように渡した先で detach される(takeOwnership参照)
 * 引数を作るときに使う。呼び出し後も元の Uint8Array/バッファを参照し続けたい場合は
 * copyArrayBuffer() を使うこと。呼び出し側(main.ts)が IndexedDB 由来の Uint8Array を
 * proxy へ渡す際にも使うため export する。
 *
 * 2026-08-28 追記(レビュー指摘): 手順3で takeOwnership(structuredClone transfer)を入れたが、
 * 呼び出し側の main.ts は本関数の旧実装(常に slice() でコピー)を経由してから渡していたため、
 * detach されるのは呼び出しの場で作った使い捨てのコピーであり、main.ts 側が保持するバッファ
 * (stored.bytes 等)自体は無傷のままだった。つまり手順3の「同一スレッドのうちに使い回し
 * バグを検出できるようにする」という目的を果たしていなかった(detachテストが
 * proxy.unserialize(buf) に生バッファを直接渡す形で書かれていたため、この抜けを検出できて
 * いなかった)。ここでコピーを避けることで、本番の呼び出し経路でも実際に detach が効くように
 * 修正した(test/core-proxy.test.ts の「main.tsの呼び出し形」節、および
 * docs/STORAGE-SCSI.md 手順3の節を参照)。
 */
export function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * 常に独立したコピーを作る版。呼び出し後も元の Uint8Array/ArrayBuffer を呼び出し側が
 * 参照し続ける場合に使う。現状これを必要とする呼び出し元は無いが、
 * 「所有権を渡す(toOwnedArrayBuffer)」か「コピーを渡す(こちら)」かを名前で区別できるよう
 * 残す。
 */
export function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * 手順3の肝: 所有権が呼び出し側から proxy 側へ移る引数(unserialize の bytes、writeFile の
 * data)は、同一スレッド実装のままでも実際に detach させる。
 *
 * LocalCoreProxy は将来 Worker 実体に差し替わる前段の同一スレッド adapter であり、
 * 素朴に ArrayBuffer をそのまま保持・参照するだけだと「proxy に渡したあとも呼び出し元が
 * 同じバッファを書き換えて使い回す」というバグを黙って通してしまう。実 Worker 化(手順7以降)
 * で postMessage の transfer list に載せた瞬間にそれが表面化すると、原因調査が今回の変更から
 * 遠くなる。structuredClone(buf, { transfer: [buf] }) は同一スレッドでも元の buf を実際に
 * detach するため、契約違反をこの時点で検出可能にする。
 *
 * コスト実測(2026-08-28、Node): 15MB(1本のステートに相当する概算サイズ)で 0.01〜1.3ms
 * (5試行)、1.2MB(FDD相当)で0.03ms未満。put/get の gzip 圧縮(同モジュールの実測で約60ms)や
 * IndexedDBのラウンドトリップに比べて無視できる大きさのため、DEV限定にはせず常時適用する。
 */
function takeOwnership(buf: ArrayBuffer): ArrayBuffer {
  return structuredClone(buf, { transfer: [buf] });
}

/**
 * 既存 LibretroHost のインスタンスを Promise で包むだけの同一スレッド adapter。
 * 例外は CoreProxyError(CoreError入り) に変換する。
 */
export class LocalCoreProxy implements LibretroHostProxy {
  private readonly host: CoreHostSurface;
  private generation = 0;
  private disposed = false;
  private initialized = false;
  /** hotSwapFdd の eject→read→write→insert を成立させるための drive→path 記憶。
   * 既存 LibretroHost はマウント中パスを外部へ公開しないため、proxy 側で保持する。 */
  private readonly mountedPath = new Map<0 | 1, string>();

  /**
   * opts.initialized: 段階移行の途中で、host 側の init() 呼び出しは既存経路(main.ts の
   * bootCore()等)にそのまま残しつつ、proxy は observation 系メソッドだけを本番結線したい
   * 場合に使う。host.init() が proxy を経由せず既に完了した後で構築する呼び出し側だけが
   * 立てること(呼ぶ前に立てると assertInitialized の意味が壊れる)。
   */
  constructor(host: CoreHostSurface, opts?: { initialized?: boolean }) {
    this.host = host;
    this.initialized = opts?.initialized ?? false;
  }

  /** dispose() 後に生成し直す場合に使う世代番号。テスト・診断用。 */
  get currentGeneration(): number {
    return this.generation;
  }

  private assertUsable(operation: string): void {
    if (this.disposed) {
      throw new CoreProxyError(
        createCoreError('INVALID_STATE', `破棄済みの proxy に対する呼び出しです: ${operation}`, {
          operation,
        }),
      );
    }
  }

  private assertInitialized(operation: string): void {
    this.assertUsable(operation);
    if (!this.initialized) {
      throw new CoreProxyError(
        createCoreError('INVALID_STATE', `初期化前の呼び出しです: ${operation}`, { operation }),
      );
    }
  }

  /** 例外を CoreError 付きの CoreProxyError へ正規化する。CoreProxyError はそのまま透過する。 */
  private toProxyError(operation: string, err: unknown, code: CoreErrorCode = 'CORE_FAILURE'): CoreProxyError {
    if (err instanceof CoreProxyError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new CoreProxyError(
      createCoreError(code, message, { operation, details: err instanceof Error ? undefined : err }),
    );
  }

  private async run<T>(operation: string, fn: () => T): Promise<T> {
    try {
      return fn();
    } catch (err) {
      throw this.toProxyError(operation, err);
    }
  }

  async init(biosIpl: Uint8Array, biosCg: Uint8Array, sram?: Uint8Array): Promise<void> {
    this.assertUsable('init');
    if (this.initialized) {
      throw new CoreProxyError(
        createCoreError('INVALID_STATE', 'init() は既に完了しています', { operation: 'init' }),
      );
    }
    try {
      await this.host.init(biosIpl, biosCg, sram);
      this.initialized = true;
    } catch (err) {
      throw this.toProxyError('init', err, 'LOAD_FAILED');
    }
  }

  async setCoreOption(key: string, value: string): Promise<void> {
    // 実体 LibretroHost#setCoreOption は init() 前後どちらでも呼べる(コメント参照)ため、
    // 他のメソッドと違い initialized までは要求しない。
    this.assertUsable('setCoreOption');
    return this.run('setCoreOption', () => this.host.setCoreOption(key, value));
  }

  async loadGame(path: string): Promise<boolean> {
    this.assertInitialized('loadGame');
    if (!path) {
      throw new CoreProxyError(
        createCoreError('INVALID_ARGUMENT', 'path が空です', { operation: 'loadGame' }),
      );
    }
    return this.run('loadGame', () => this.host.loadGame(path));
  }

  async reset(): Promise<void> {
    this.assertInitialized('reset');
    return this.run('reset', () => this.host.reset());
  }

  async fetchAvInfo(): Promise<AvInfo> {
    this.assertInitialized('fetchAvInfo');
    return this.run('fetchAvInfo', () => this.host.fetchAvInfo());
  }

  async serialize(): Promise<ArrayBuffer | null> {
    this.assertInitialized('serialize');
    return this.run('serialize', () => {
      const bytes = this.host.serialize();
      return bytes ? toOwnedArrayBuffer(bytes) : null;
    });
  }

  async unserialize(bytesIn: ArrayBuffer): Promise<boolean> {
    this.assertInitialized('unserialize');
    // 所有権を proxy へ移す。呼び出し側が渡した bytesIn はここで detach され、以後
    // byteLength は 0 になる(takeOwnership のコメント参照)。
    const bytes = takeOwnership(bytesIn);
    if (bytes.byteLength === 0) {
      throw new CoreProxyError(
        createCoreError('INVALID_ARGUMENT', 'bytes が空です', { operation: 'unserialize' }),
      );
    }
    // unserialize 失敗時に以前のステートが壊れたまま走り続けないことは、実体 LibretroHost
    // (retro_unserialize)側の責務。ここでは host.unserialize() の戻り値(false)・例外の
    // どちらも握り潰さず、そのまま呼び出し側へ伝える(false はそのまま返り、例外は
    // run() が CoreProxyError へ変換する)。
    return this.run('unserialize', () => this.host.unserialize(new Uint8Array(bytes)));
  }

  async readTextScreen(): Promise<TextScreenDump> {
    this.assertInitialized('readTextScreen');
    return this.run('readTextScreen', () => this.host.readTextScreen());
  }

  async readMemory(address: number, length: number): Promise<ArrayBuffer> {
    this.assertInitialized('readMemory');
    if (address < 0 || length <= 0) {
      throw new CoreProxyError(
        createCoreError('INVALID_ARGUMENT', `不正な範囲です: address=${address}, length=${length}`, {
          operation: 'readMemory',
        }),
      );
    }
    return this.run('readMemory', () => {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = this.host.peekByte(address + i);
      return toOwnedArrayBuffer(bytes);
    });
  }

  async hotSwapFdd(payload: HotSwapFddPayload): Promise<HotSwapFddResult> {
    this.assertInitialized('hotSwapFdd');
    return this.run('hotSwapFdd', () => {
      const { drive, image } = payload;
      // eject→旧内容回収→write→insert の順を守る。px68k の Eject はメモリ上のイメージを
      // 無条件に元ファイルへ書き戻すため、先に write すると Eject がそれを上書きしてしまう
      // (feedback_px68k_fdd_eject_writeback.md 参照)。
      const previousPath = this.mountedPath.get(drive) ?? null;
      this.host.setFddImage(drive, '');

      let previousImage: ArrayBuffer | null = null;
      if (previousPath) {
        try {
          previousImage = toOwnedArrayBuffer(this.host.readFile(previousPath));
        } catch {
          previousImage = null;
        }
      }

      let mountedPath: string | null = null;
      if (image) {
        const path = this.host.writeDiskImage(image.name, new Uint8Array(image.bytes));
        this.host.setFddImage(drive, path);
        this.mountedPath.set(drive, path);
        mountedPath = path;
      } else {
        this.mountedPath.delete(drive);
      }

      return { previousImage, mountedPath };
    });
  }

  async writeFile(path: string, dataIn: ArrayBuffer): Promise<void> {
    this.assertInitialized('writeFile');
    // unserialize と同様、所有権を proxy へ移す(呼び出し側の dataIn はここで detach される)。
    const data = takeOwnership(dataIn);
    return this.run('writeFile', () => this.host.writeFile(path, new Uint8Array(data)));
  }

  async readFile(path: string): Promise<ArrayBuffer> {
    this.assertInitialized('readFile');
    return this.run('readFile', () => {
      try {
        return toOwnedArrayBuffer(this.host.readFile(path));
      } catch (err) {
        throw this.toProxyError('readFile', err, 'IO_FAILED');
      }
    });
  }

  async removeFile(path: string): Promise<void> {
    this.assertInitialized('removeFile');
    return this.run('removeFile', () => this.host.removeFile(path));
  }

  async dispose(): Promise<void> {
    this.assertUsable('dispose');
    try {
      this.host.dispose();
    } finally {
      this.disposed = true;
      this.initialized = false;
      this.generation += 1;
    }
  }
}

// --- proxy に載せなかった既存 LibretroHost の public メソッド ---------------
//
// 以下は docs/STORAGE-SCSI.md の「段階移行の順序」上、手順1(protocol/proxy導入)ではなく
// 別の手順に属するため、今回の LibretroHostProxy には含めていない:
//
// - setKey/sendKeyMake/addMouseDelta/setMouseButton/setJoyState:
//   手順6(2026-08-31実装)で INPUT_UPDATE_KIND の片道メッセージ(WorkerCoreProxy#sendInput())
//   に統合された(毎フレーム呼ぶ状態更新であり、1メソッド1RPCにする対象ではないため。
//   決定7参照。command/response の枠には乗せていない)。
// - hasPendingMouseDelta/readGuestCursor/clearMouseState:
//   マウス閉ループ追従専用の補助。手順6後半(2026-08-31実装)で閉ループそのものをWorker側
//   (src/core-worker.ts)へ移したため、proxy越しのRPCにはしていない(WorkerCoreProxy#
//   sendMouseTrack()/sendMouseTrackResync() という別の片道メッセージで目標だけを送る。
//   docs/STORAGE-SCSI.md「ワーカー移行 手順6後半」参照)。
// - readMouseState/readKeyBufWindow/readKeyRepeatConfig/readSram/startSramAutosave/
//   stopSramAutosave:
//   「アクセス・ダーティ」「SRAM・キーリピート」の節により、pull API は廃止し
//   frame イベント / sramChanged イベントへ統合する対象 (手順5・7)。
// - readDiskAccess/readDirtyState/clearDirty:
//   文書に明記 (「アクセス/dirty の pull API は廃止。clear と吸い出しは不可分にする」)。
//   手順8(2026-08-31実装)で captureDirtyMedia/markDirty に置き換わった(WorkerCoreProxy固有の
//   メソッドとして追加。LibretroHostProxyには含めていない。当初案のfinishDirtyCapture(token
//   方式)ではなく、slot指定・token無しのmarkDirtyという単純な形にした。理由は
//   src/core-protocol.ts の AtomicCommand コメント参照)。access(disk.access)は
//   手順5で既に frame event 側に統合済みで、dirty(disk.dirty)も手順8で同じ frame event に
//   相乗りさせた(src/core-worker.ts の sendFrame 参照。pull不要)。
// - runFrame: 文書に明記の通り、runFrame に相当する RPC はここに作らない(手順7で Worker 所有)。
// - resetAudioProbe/readAudioProbe: DEV限定の計測プローブであり、本番の proxy 境界の対象外。
// - writeDiskImage: hotSwapFdd 内部で使う実装詳細として扱い、proxy の公開メソッドにはしない
//   (公開すると「イメージを置いてから明示的に insert」という2段階の誤用ができてしまうため)。
// - loadGameNone/unloadGame (2026-08-28、決定): src/main.ts から呼ばれておらず(未使用)、
//   外部利用も確認できないため LibretroHostProxy から削除した(docs「未決事項」参照)。
//   CoreHostSurface(実体 LibretroHost との構造チェック)には残している。LibretroHost 自体は
//   引き続きこれらのメソッドを持つ(削除していない)。

// --- WorkerCoreProxy (段階移行 手順4のスケルトン) -----------------------------
//
// LocalCoreProxy と同じ LibretroHostProxy を実装する、実 Worker(src/core-worker.ts)への
// メッセージ委譲 proxy。呼び出し側(src/main.ts)が LibretroHostProxy 型でだけ扱っていれば
// LocalCoreProxy とこの WorkerCoreProxy を差し替え可能にすることが目的(docs
// 「ワーカー境界のAPI設計」冒頭「境界の原則」参照)。
//
// 今回実装しているのは initialize/loadGame/fetchAvInfo/dispose の4 op のみ。他の
// メソッド(setCoreOption/reset/serialize/unserialize/readTextScreen/readMemory/
// hotSwapFdd/writeFile/readFile/removeFile)は UNSUPPORTED の CoreProxyError を返す
// (手順5以降、Worker 側 core-worker.ts に実処理を足すのに合わせて実装する)。
// したがって WorkerCoreProxy を使っても loadGame 成功以降 retro_run() は呼ばれず、
// 画面・音・セーブステート・メモリ参照は一切機能しない。

/** postMessage/terminate/addEventListener だけを要求する最小の Worker 互換 interface。
 * テストでは本物の Worker の代わりにこれを満たす fake を渡せる。 */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (ev: unknown) => void): void;
  addEventListener(type: 'messageerror', listener: (ev: unknown) => void): void;
}

export interface WorkerCoreProxyOptions {
  /** テスト用: 実 Worker の代わりに渡す fake Worker の生成関数。省略時は本物の Worker を生成する。 */
  createWorker?: () => WorkerLike;
  /** 応答timeoutミリ秒(既定 DEFAULT_RESPONSE_TIMEOUT_MS)。テストで短縮するために公開する。 */
  responseTimeoutMs?: number;
  /** 起動中(最初のframe eventを受け取るまで)の応答timeoutミリ秒(既定
   * STARTUP_RESPONSE_TIMEOUT_MS)。テストで短縮するために公開する。 */
  startupResponseTimeoutMs?: number;
}

const DEFAULT_RESPONSE_TIMEOUT_MS = 10_000;
/** 起動中(最初のframe eventを受け取るまで)専用の応答timeout。startupSettledのコメント参照。 */
const STARTUP_RESPONSE_TIMEOUT_MS = 120_000;

function defaultCreateWorker(): WorkerLike {
  // 実測(docs/STORAGE-SCSI.md 手順4参照): vite dev server はクラシックworker指定でも
  // ESM importをそのまま含んだソースを返すため、type指定なし(クラシックworker)だと
  // 構文エラーで即死する(`?worker_file&type=classic` として配信されるが中身は import 文入り)。
  // モジュールworkerとして生成する。core-worker.ts 側は importScripts を使わない前提に変更済み。
  return new Worker(new URL('./core-worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  /** 起動中(startupSettled===false)はstartupResponseTimeoutMs、起動後(===true)は
   * responseTimeoutMsで張る。最初のframe eventを受け取った瞬間に、armPendingTimeouts()が
   * 起動中ぶんを全部通常timeoutへ張り直す(WorkerCoreProxyクラスのstartupSettledコメント
   * 参照)。 */
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export class WorkerCoreProxy implements LibretroHostProxy {
  private readonly worker: WorkerLike;
  private readonly responseTimeoutMs: number;
  private readonly startupResponseTimeoutMs: number;
  private readonly generation: Generation;
  private nextRequestId: RequestId = 1;
  private disposed = false;
  /** true になったら以後すべての呼び出しを即座に WORKER_FAILURE で reject する
   * (docs「エラー、異常終了、再生成」: messageerror/error/timeout/突然終了は WORKER_FAILURE)。
   * 手順9(再生成)は今回のスコープ外のため、失敗後の自動再生成は行わない。 */
  private failed = false;
  private readonly pending = new Map<RequestId, PendingRequest>();
  /** 手順9: error/messageerror/timeout/fatal のどれで壊れても呼び出し元へ即座に知らせるための
   * 単一の通知窓口。従来は「たまたま pending な command があれば、その reject 経由でしか
   * 呼び出し元に伝わらない」構造で、frame event 配信中(pendingが空)に Worker が死ぬと
   * 誰にも通知されないまま画面だけが無言で静止するという抜けがあった
   * (docs/STORAGE-SCSI.md「ワーカー移行 手順9：異常系の検証」参照)。 */
  private failureHandler: ((message: string) => void) | null = null;
  /** 実測(docs/STORAGE-SCSI.md 手順4参照): `new Worker(...)` 直後に送った最初の command は
   * module worker側の import グラフ解決中に取りこぼされることがある(`self.onmessage` が
   * 実際にセットされる前だけでなく、セットされた後でも起きた)。Worker側(core-worker.ts)は
   * 起動が完了した時点で WORKER_BOOT_ACK_KIND を1回送ってくるので、それを受け取るまでは
   * 実際の postMessage を保留してここに積む。 */
  private workerBooted = false;
  private readonly preBootQueue: Array<{
    command: CoreCommand;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }> = [];
  /** 実測(2026-09-04): まっさらなプロファイルではコアが最初のフレームを出すまで約22秒
   * かかる(workerStats().frameNoが+20sまで0のまま、+22sで初めて2になる)。固定10秒だと
   * その途中でコアを異常終了扱いにして復帰できなくなる。
   *
   * 当初(f0642f1)はinitializeコマンドの応答が返るまでを起動中とみなしていたが、
   * 実機で修正が効いていないことを実測した(probe-scsi-iocs.mjs、まっさらなプロファイル):
   * workerStats().frameNoが+28sまで0のままなのに「応答timeout(10000ms): readTextScreen」
   * が出た。つまりinitializeの応答はもっと早く返っており、重い処理はその後にある
   * (initialize自体は起動シーケンスの一部を投げているだけで、コアが実際に動き出して
   * 最初のフレームを描くところまでは面倒を見ていない)。initializeの応答を境界にしても
   * 効かなかったため、「動き始めた」と言える最初のframe eventを受け取った時点を境界にする。
   *
   * 境界を無タイマにはしない: 起動そのものが失敗して固まったWorkerを検出できなくなる
   * ため、起動中は短い方(DEFAULT_RESPONSE_TIMEOUT_MS)ではなく長い方
   * (STARTUP_RESPONSE_TIMEOUT_MS)のtimeoutを張る。起動後の挙動は一切変えない。 */
  private startupSettled = false;

  constructor(opts?: WorkerCoreProxyOptions) {
    this.responseTimeoutMs = opts?.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    this.startupResponseTimeoutMs = opts?.startupResponseTimeoutMs ?? STARTUP_RESPONSE_TIMEOUT_MS;
    // 手順9(再生成)はスコープ外なので、この proxy 1インスタンス = generation 0 固定。
    this.generation = 0;
    this.worker = (opts?.createWorker ?? defaultCreateWorker)();
    this.worker.addEventListener('message', (ev) => this.handleMessage(ev.data as WorkerToMain));
    this.worker.addEventListener('error', (ev) => this.handleWorkerFailure('Workerでエラーが発生しました', ev));
    this.worker.addEventListener('messageerror', (ev) =>
      this.handleWorkerFailure('Workerからのメッセージを復元できませんでした(messageerror)', ev),
    );
  }

  /** テスト・診断用。 */
  get currentGeneration(): Generation {
    return this.generation;
  }

  /** WORKER_FAILURE(error/messageerror/応答timeout/fatal event)が起きた瞬間に1回だけ
   * 呼ばれる通知。pending な command が無くても必ず呼ばれる(上のfailureHandlerコメント参照)。
   * 呼び出し元(main.ts)はここでトースト等、利用者に見える通知を出す。 */
  setFailureHandler(handler: ((message: string) => void) | null): void {
    this.failureHandler = handler;
  }

  private handleMessage(message: WorkerToMain): void {
    // DEV専用の計測プローブ応答(core-worker.ts の '__devTickProbeData')。generation を
    // 持たない生メッセージで、CoreCommand/WorkerToMainのunionには含めていないため、
    // 他のどの分岐よりも先に見て早期returnする(devPostRawMessage/setDevMessageHandler参照)。
    if (
      this.devMessageHandler &&
      typeof message === 'object' &&
      message !== null &&
      (message as unknown as { kind?: unknown }).kind === '__devTickProbeData'
    ) {
      this.devMessageHandler(message);
      return;
    }
    // 起動ハンドシェイク: generation を持たない専用メッセージなので他の分岐より先に見る。
    if (isWorkerBootAck(message)) {
      this.workerBooted = true;
      const queued = this.preBootQueue.splice(0);
      for (const item of queued) {
        this.dispatchCommand(item.command, item.resolve, item.reject);
      }
      return;
    }
    // docs「エラー、異常終了、再生成」: 現在世代と異なる response/event は無視する。
    if (message.generation !== this.generation) return;
    if (isCoreResponse(message)) {
      const req = this.pending.get(message.requestId);
      if (!req) return; // 既にtimeout等で片付いたrequestId。
      this.pending.delete(message.requestId);
      clearTimeout(req.timeoutHandle);
      if (message.ok) req.resolve(message.result);
      else req.reject(new CoreProxyError(message.error));
      return;
    }
    // event。'fatal' はその世代を継続不能として扱う(docs: handler内例外でコア状態の継続可否を
    // 保証できない場合、失敗responseに加えfatal eventを送り、以後commandを受け付けない)。
    if (message.event === 'fatal') {
      this.handleWorkerFailure(message.error.message, message.error, false);
      return;
    }
    // 起動完了の境界: 最初のframe eventを受け取った瞬間(startupSettledコメント参照)。
    // 'ready'はまだコアが1フレームも進んでいなくても届くため境界にはしない。
    if (!this.startupSettled && message.event === 'frame') {
      this.startupSettled = true;
      this.armPendingTimeouts();
    }
    // 'ready'/'frame'/'sramChanged': src/main.ts 側が setEventHandler() で登録した購読者へ
    // そのまま転送する(手順5・7: 映像・アクセスフラグをここで main へ橋渡しする)。
    this.eventHandler?.(message);
  }

  private eventHandler: ((event: CoreEvent) => void) | null = null;

  /** 'ready'/'frame'/'sramChanged' イベントの購読者を1つだけ登録する(main.ts側の呼び出し元は
   * 1つのproxyインスタンスにつき1つの購読者しか要らないため、複数登録には対応しない)。 */
  setEventHandler(handler: ((event: CoreEvent) => void) | null): void {
    this.eventHandler = handler;
  }

  private devMessageHandler: ((msg: unknown) => void) | null = null;

  /** DEV専用: '__devTickProbeData'(計測プローブの読み出し応答)を受け取るハンドラを登録する。
   * 段階移行の性能調査(docs/STORAGE-SCSI.md)専用で、本体の command/response/event プロトコル
   * には関与しない。既定では誰も呼ばない(main.ts の workerTickProbe* フック参照)。 */
  setDevMessageHandler(handler: ((msg: unknown) => void) | null): void {
    this.devMessageHandler = handler;
  }

  /** DEV専用: 計測プローブの enable/disable/reset/read/setBusyWaitFault を、CoreCommand の
   * unionを汚さない生メッセージとしてWorkerへ送る。本体経路(通常のcommand呼び出し)には
   * 一切関与しない。 */
  devPostRawMessage(message: unknown): void {
    this.worker.postMessage(message);
  }

  /** messageerror/Workerのerror/応答timeout/fatal event を束ねる WORKER_FAILURE 処理。
   * その世代の未完了 Promise をすべて reject する(docs 参照)。 */
  private handleWorkerFailure(message: string, details: unknown, terminateWorker = true): void {
    if (this.failed) return; // 二重処理防止(error/messageerrorが立て続けに来ても1回だけ処理する)。
    this.failed = true;
    const error = createCoreError('WORKER_FAILURE', message, { details: summarizeFailureDetails(details) });
    for (const req of this.pending.values()) {
      clearTimeout(req.timeoutHandle);
      req.reject(new CoreProxyError(error));
    }
    this.pending.clear();
    const queued = this.preBootQueue.splice(0);
    for (const item of queued) {
      item.reject(new CoreProxyError(error));
    }
    if (terminateWorker) {
      try {
        this.worker.terminate();
      } catch {
        // 既に終了している等は無視。
      }
    }
    // pendingの有無に関わらず必ず1回呼ぶ(このメソッド自体がfailedガードで二重発火しない)。
    this.failureHandler?.(message);
  }

  /** command を1件送り、対応する response を待つ Promise を返す。 */
  private sendCommand(command: CoreCommand): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(
        new CoreProxyError(
          createCoreError('INVALID_STATE', `破棄済みの proxy に対する呼び出しです: ${command.op}`, {
            operation: command.op,
          }),
        ),
      );
    }
    if (this.failed) {
      return Promise.reject(
        new CoreProxyError(
          createCoreError('WORKER_FAILURE', `Worker は既に異常終了しています: ${command.op}`, {
            operation: command.op,
          }),
        ),
      );
    }
    return new Promise((resolve, reject) => {
      // 起動ハンドシェイク未完了(WorkerCoreProxyクラス冒頭のコメント参照)の間は実際の
      // postMessageをせず、preBootQueueに積んで到着後にまとめて送る。
      if (!this.workerBooted) {
        this.preBootQueue.push({ command, resolve, reject });
        return;
      }
      this.dispatchCommand(command, resolve, reject);
    });
  }

  /** 実際に command を postMessage し、対応する response の待受(timeout込み)を登録する。
   * 起動ハンドシェイク完了直後の flush と、通常の即時送信の両方から呼ばれる。 */
  private dispatchCommand(
    command: CoreCommand,
    resolve: (value: unknown) => void,
    reject: (reason: unknown) => void,
  ): void {
    // startupSettled===false(起動中、最初のframe eventをまだ受け取っていない)の間は
    // 長い方のstartupResponseTimeoutMsで張る(無タイマにはしない。クラス冒頭の
    // startupSettledコメント参照)。initializeコマンド自身もこの分岐を通る。
    const timeoutMs = this.startupSettled ? this.responseTimeoutMs : this.startupResponseTimeoutMs;
    const timeoutHandle = setTimeout(() => {
      this.handleWorkerFailure(`応答timeout(${timeoutMs}ms): ${command.op}`, undefined);
    }, timeoutMs);
    this.pending.set(command.requestId, { resolve, reject, timeoutHandle });
    this.worker.postMessage(command, collectTransferables(command));
  }

  /** 起動完了(最初のframe eventを受け取った瞬間)に呼ぶ。それまでの間にdispatchCommand()
   * されてstartupResponseTimeoutMsの長いタイマが張られたまま取り残されているpendingを、
   * この時点を起点として通常のresponseTimeoutMsへ張り直す。これをしないと、起動中に
   * 投げられてまだ応答が返っていないコマンドが、起動後もずっと長いタイマのままになる。 */
  private armPendingTimeouts(): void {
    for (const [requestId, req] of this.pending.entries()) {
      clearTimeout(req.timeoutHandle);
      req.timeoutHandle = setTimeout(() => {
        this.handleWorkerFailure(`応答timeout(${this.responseTimeoutMs}ms): (起動完了後に計時開始)`, undefined);
      }, this.responseTimeoutMs);
      this.pending.set(requestId, req);
    }
  }

  private issue<T>(op: CoreCommand['op'], payload: unknown): Promise<T> {
    const command = {
      kind: 'command',
      generation: this.generation,
      requestId: this.nextRequestId++,
      op,
      payload,
    } as CoreCommand;
    return this.sendCommand(command) as Promise<T>;
  }

  private unsupported<T>(operation: string): Promise<T> {
    return Promise.reject(
      new CoreProxyError(
        createCoreError('UNSUPPORTED', `${operation} はWorker経路でまだ実装していません(段階移行 手順5以降)`, {
          operation,
        }),
      ),
    );
  }

  /**
   * initialDisks: WorkerCoreProxy 固有の追加引数(LibretroHostProxy.init のシグネチャには
   * 無い)。Worker はメインの MEMFS を共有していないため、初回マウントするディスクの実体を
   * ここで一緒に渡す必要がある(core-protocol.ts の InitPayload.initialDisks コメント参照)。
   * LocalCoreProxy は既存経路のとおり src/main.ts の bootCore() が host.writeDiskImage() を
   * 直接呼ぶため、この引数を持たない(オプション引数なのでインタフェースの構造的両立性は保たれる)。
   *
   * options: 手順9で追加。px68k_cpuspeed/px68k_ramsize等のコアオプション(既定経路が
   * bootCore()内でhost.setCoreOption()を直接呼んでいるのと同じもの)を渡す。
   * src/core-worker.ts の handleInitialize() は InitPayload.options を読んで
   * newHost.setCoreOption() を回す実装が(この引数を追加する前から)既に入っていたが、
   * 呼び出し元のここが options を一度も渡していなかったため、実際には常に未設定のまま
   * だった(=CPU速度/RAM構成/パッド種別/HDD永続化/マウス有効化/速度倍率の土台となる
   * no_wait_mode が、Worker経路では起動時から一度も設定されていなかった。
   * docs/STORAGE-SCSI.md「ワーカー移行 手順9」参照)。
   *
   * 2026-08-31追記(リセット復帰の欠陥修正、docs/STORAGE-SCSI.md「ワーカー移行 手順9：
   * 異常系の検証」参照): biosIpl/biosCg/sram/initialDisks[].bytes は
   * toOwnedArrayBuffer() ではなく copyArrayBuffer() で渡す。理由: 呼び出し元(main.ts)は
   * biosIplBytes/biosCgBytes/slots.fdd0等.data を module-level に持ち続け、リセットの
   * たびに「同じ Uint8Array インスタンス」をこの init() へ再度渡してくる(FDDを差し替えない
   * 限り、それが正しい呼び出し方であり、main.ts 側にコピーの責務を負わせると呼び出し元
   * ごとに同じ間違いが再発しうる)。toOwnedArrayBuffer() は「バッファ全体を覆っている
   * Uint8Array ならコピーせず buffer をそのまま返す」ため、initialize command の transfer
   * list に載って実際に detach されるのは main.ts が保持し続ける実体そのものだった。
   * 1回目の起動でそれが detach され、2回目(リセット)で同じ実体を再度 postMessage しようと
   * して `DataCloneError: ArrayBuffer at index 0 is already detached` になる(実測、
   * どのバッファかは`node -e`でstructuredClone(buf,{transfer:[buf]})を2回呼んで確認済み)。
   * copyArrayBuffer() は常に独立したコピーを作るため、渡した側の実体は無傷のまま保たれ、
   * 何度リセットしても同じ形で成立する。
   *
   * コピー量について: これは毎フレーム経路(sendInput/returnFrameBuffer等)ではなく、
   * 起動・リセット(ユーザー操作起点、低頻度)でしか呼ばれない initialize command でのみ
   * 発生する。BIOS/CGROM/SRAMは数百KB程度、initialDisksは最大で合計40MB程度になりうるが、
   * 1回のリセットあたり高々一度のメモリコピー(実測でミリ秒〜数十ミリ秒オーダー、
   * toOwnedArrayBuffer側のstructuredClone実測コメント参照)であり、Worker終了・再生成・
   * IndexedDBの書き戻し等リセット自体が持つ他のコストに比べて無視できる。sram は
   * main.ts側がIndexedDBから読むたびに新規Uint8Arrayを受け取るため理論上はコピー不要だが、
   * 「initialize の4引数はどれも呼び出し元の使い回しを想定してコピーする」という単純な
   * 規則に揃えるため、ここでは区別せず同じ扱いにする(区別すると将来の変更で再び穴が
   * 開く。9でもとの読み間違いだった。sram単体のコストはBIOS/CGROMよりさらに小さい)。
   */
  async init(
    biosIpl: Uint8Array,
    biosCg: Uint8Array,
    sram?: Uint8Array,
    initialDisks?: InitialDiskInput[],
    options?: Record<string, string>,
    // 2026-09-03追記(docs/STORAGE-SCSI.md参照): SCSI設定(__webx68kScsiUrl等)や計測用の
    // 監視範囲(__webx68kRamWatchLo等)はwasmからglobalThis経由で読まれるため、Worker経路
    // ではpage側のglobalThisが見えず丸ごと効かなかった(実測: SCSI-BPB読み出し失敗→
    // ゲストで「ドライブ名が無効です」)。initialize時に1回だけWorkerのglobalThisへ写す。
    hostGlobals?: Record<string, HostGlobalValue>,
  ): Promise<void> {
    // 起動完了(startupSettled)の判定はここでは行わない。initializeの応答が返っても
    // コアはまだ動き出していないため(startupSettledコメント参照、実測2026-09-04)、
    // 最初のframe eventを受け取るまでhandleMessage()側でstartupSettledはfalseのまま。
    await this.issue<unknown>('initialize', {
      biosIpl: copyArrayBuffer(biosIpl),
      biosCg: copyArrayBuffer(biosCg),
      sram: sram ? copyArrayBuffer(sram) : undefined,
      initialDisks: initialDisks?.map((d) => ({
        slot: d.slot,
        name: d.name,
        bytes: copyArrayBuffer(d.bytes),
      })),
      options,
      hostGlobals,
    });
  }

  async setCoreOption(_key: string, _value: string): Promise<void> {
    return this.unsupported('setCoreOption');
  }

  async loadGame(path: string): Promise<boolean> {
    return this.issue<boolean>('loadGame', { path });
  }

  async reset(): Promise<void> {
    return this.unsupported('reset');
  }

  async fetchAvInfo(): Promise<AvInfo> {
    return this.issue<AvInfo>('fetchAvInfo', {});
  }

  async serialize(): Promise<ArrayBuffer | null> {
    return this.unsupported('serialize');
  }

  async unserialize(_bytes: ArrayBuffer): Promise<boolean> {
    return this.unsupported('unserialize');
  }

  async readTextScreen(): Promise<TextScreenDump> {
    return this.issue<TextScreenDump>('readTextScreen', {});
  }

  /** 駆動ループ(手順7)の開始・停止。LibretroHostProxy には無い、Worker経路固有のメソッド
   * (LocalCoreProxy側は既存のsrc/main.tsのloop()が同じ役割を持つため不要)。 */
  async setRunning(running: boolean): Promise<void> {
    await this.issue<unknown>('setRunning', { running });
  }

  /** main が putImageData() し終えた frame event の ArrayBuffer を Worker のプールへ返す。
   * command/response(generation・requestId付き)の枠には乗せない一方向のfire-and-forget
   * (core-protocol.ts の RETURN_FRAME_BUFFER_KIND のコメント参照)。dispose済み・異常終了後は
   * 送っても意味が無いため黙って無視する(バッファは単に破棄される)。 */
  returnFrameBuffer(buffer: ArrayBuffer): void {
    if (this.disposed || this.failed) return;
    this.worker.postMessage({ kind: RETURN_FRAME_BUFFER_KIND, buffer }, [buffer]);
  }

  /** 入力更新(手順6)。command/response(generation・requestId付き)の枠には乗せない
   * 一方向のfire-and-forget(決定7。core-protocol.ts の INPUT_UPDATE_KIND のコメント参照)。
   * 毎フレーム呼ばれるため、returnFrameBuffer と同様に応答を待たない。dispose済み・
   * 異常終了後は送っても意味が無いため黙って無視する。 */
  sendInput(update: InputUpdate): void {
    if (this.disposed || this.failed) return;
    this.worker.postMessage({ kind: INPUT_UPDATE_KIND, update });
  }

  /** マウス閉ループ追従の目標更新(手順6後半)。command/response の枠には乗せない一方向の
   * fire-and-forget(sendInput と同じ扱い。core-protocol.ts の MOUSE_TRACK_UPDATE_KIND
   * コメント参照)。低頻度(mousemove/pointerlockchange契機)なので毎フレームは呼ばれない。 */
  sendMouseTrack(update: MouseTrackUpdate): void {
    if (this.disposed || this.failed) return;
    this.worker.postMessage({ kind: MOUSE_TRACK_UPDATE_KIND, update });
  }

  /** マウス閉ループ追従の強制再同期(ツールバーの「マウス再同期」)。ユーザー操作契機の
   * fire-and-forget。 */
  sendMouseTrackResync(): void {
    if (this.disposed || this.failed) return;
    this.worker.postMessage({ kind: MOUSE_TRACK_RESYNC_KIND });
  }

  /** 速度倍率の更新(手順9でWorker対応。docs/STORAGE-SCSI.md「ワーカー移行 手順9」参照)。
   * sendMouseTrack と同じ扱いのfire-and-forget。ユーザー操作契機(速度ボタン/設定モーダル)の
   * 低頻度メッセージ。 */
  setSpeedMultiplier(multiplier: number): void {
    if (this.disposed || this.failed) return;
    this.worker.postMessage({ kind: SPEED_UPDATE_KIND, multiplier });
  }

  /** SCSI(OPFS)の明示flush依頼(取りこぼしの窓の是正)。sendMouseTrackResyncと同じ扱いの
   * fire-and-forget。main.ts側のpagehide/visibilitychange(hidden)/freezeから送られる、
   * デバウンス(src/scsi-opfs.ts)の上積み(core-protocol.tsのFLUSH_SCSI_KINDコメント参照)。 */
  sendFlushScsi(): void {
    if (this.disposed || this.failed) return;
    this.worker.postMessage({ kind: FLUSH_SCSI_KIND });
  }

  async readMemory(_address: number, _length: number): Promise<ArrayBuffer> {
    return this.unsupported('readMemory');
  }

  /** 手順8: FDDホットマウント。Eject→旧内容回収→(新イメージがあれば)write→insert を
   * Worker内の1つのcommandハンドラで完結させる(不可分性。src/core-worker.ts の
   * handleHotSwapFdd、src/worker-dirty-capture.ts 参照)。 */
  async hotSwapFdd(payload: HotSwapFddPayload): Promise<HotSwapFddResult> {
    return this.issue<HotSwapFddResult>('hotSwapFdd', payload);
  }

  /** 手順8: 不可分ダーティキャプチャ。指定スロットの「読み出し」と「dirtyクリア」を
   * Worker側の1つの同期呼び出し内で完結させる(LibretroHostProxyには無い、Worker経路
   * 固有のメソッド。既定経路はmain.tsのpersistSlotToLibrary/flushAllSlotsが同じ役割を
   * 同一スレッド上で果たすため不要)。 */
  async captureDirtyMedia(payload: CaptureDirtyMediaPayload): Promise<CaptureDirtyMediaResult> {
    return this.issue<CaptureDirtyMediaResult>('captureDirtyMedia', payload);
  }

  /** 手順8: 永続化(IndexedDBへの保存)失敗時の再dirty化。応答を待つ必要は無いが、
   * main側が「送信できたか(Workerが生きているか)」を把握できるようPromiseは返す
   * (returnFrameBuffer/sendInputと違い、失敗頻度が低く追跡コストが問題にならないため)。 */
  async markDirty(payload: MarkDirtyPayload): Promise<void> {
    await this.issue<void>('markDirty', payload);
  }

  async writeFile(_path: string, _data: ArrayBuffer): Promise<void> {
    return this.unsupported('writeFile');
  }

  async readFile(_path: string): Promise<ArrayBuffer> {
    return this.unsupported('readFile');
  }

  async removeFile(_path: string): Promise<void> {
    return this.unsupported('removeFile');
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.failed) {
      // 既にWorkerが死んでいる場合、dispose commandは送れない。terminateだけ試みて終える。
      this.disposed = true;
      try {
        this.worker.terminate();
      } catch {
        /* 既に終了している等は無視 */
      }
      return;
    }
    try {
      await this.issue<void>('dispose', {});
    } finally {
      this.disposed = true;
      try {
        this.worker.terminate();
      } catch {
        /* 既に終了している等は無視 */
      }
    }
  }
}

/** WORKER_FAILURE の details は structured-clone 可能な診断情報だけに絞る
 * (docs「エラー、異常終了、再生成」の CoreError.details 規約)。Event/ErrorEvent はそのままだと
 * 循環参照を含みうるため、message だけを取り出す。 */
function summarizeFailureDetails(details: unknown): unknown {
  if (details && typeof details === 'object' && 'message' in details) {
    const message = (details as { message?: unknown }).message;
    if (typeof message === 'string') return { message };
  }
  return undefined;
}
