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
  CoreProxyError,
  createCoreError,
  type CoreErrorCode,
  type HotSwapFddPayload,
  type HotSwapFddResult,
} from './core-protocol';
import type { AvInfo, LibretroHost } from './libretro-host';
import type { TextScreenDump } from './text-screen';

/**
 * proxy が公開する形状。docs の例に、既存 LibretroHost の public メソッドのうち
 * 非同期化が自然なものを足した。載せなかった既存メソッドと理由は core-proxy.ts の
 * コメント末尾、および作業報告を参照。
 */
export interface LibretroHostProxy {
  init(biosIpl: Uint8Array, biosCg: Uint8Array, sram?: Uint8Array): Promise<void>;
  setCoreOption(key: string, value: string): Promise<void>;
  loadGame(path: string): Promise<boolean>;
  loadGameNone(): Promise<boolean>;
  unloadGame(): Promise<void>;
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

  async loadGameNone(): Promise<boolean> {
    this.assertInitialized('loadGameNone');
    return this.run('loadGameNone', () => this.host.loadGameNone());
  }

  async unloadGame(): Promise<void> {
    this.assertInitialized('unloadGame');
    return this.run('unloadGame', () => this.host.unloadGame());
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
// - setKey/sendKeyMake/addMouseDelta/setMouseButton/setJoyState/hasPendingMouseDelta:
//   手順6「入力」で updateInput command に統合される (毎フレーム呼ぶ状態更新であり、
//   1メソッド1RPCにする対象ではない)。
// - readGuestCursor/clearMouseState/readMouseState/readKeyBufWindow/readKeyRepeatConfig/readSram/
//   startSramAutosave/stopSramAutosave:
//   「アクセス・ダーティ」「SRAM・キーリピート」の節により、pull API は廃止し
//   frame イベント / sramChanged イベントへ統合する対象 (手順5・7)。
// - readDiskAccess/readDirtyState/clearDirty:
//   文書に明記 (「アクセス/dirty の pull API は廃止。clear と吸い出しは不可分にする」)。
//   captureDirtyMedia/finishDirtyCapture (手順8) に置き換わる。
// - runFrame: 文書に明記の通り、runFrame に相当する RPC はここに作らない(手順7で Worker 所有)。
// - resetAudioProbe/readAudioProbe: DEV限定の計測プローブであり、本番の proxy 境界の対象外。
// - writeDiskImage: hotSwapFdd 内部で使う実装詳細として扱い、proxy の公開メソッドにはしない
//   (公開すると「イメージを置いてから明示的に insert」という2段階の誤用ができてしまうため)。
