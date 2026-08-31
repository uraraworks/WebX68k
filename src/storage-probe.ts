import { initialTrackerState, type KeyBufWriteTrackerState } from './keybuf-attribution';

// 目的B(未決事項を決めるための材料)専用の計測フック。
// docs/STORAGE-SCSI.md「目的B」表の「IndexedDBへのディスク全量書出し」「起動時のRAM展開」を
// 実測するためだけに存在する。import.meta.env.DEV の内側でのみ window へ公開され、
// `enabled` は既定 false。音声振幅プローブ(libretro-host.ts audioProbeEnabled)と同じ作法で、
// 無効時は各呼び出し元の `if (storageProbe.enabled)` 分岐でコストそのものを避ける
// (常時コストが乗る形にしない。乗せる箇所があれば個別に計測して報告する)。
//
// scripts/measure-disk-save.mjs / scripts/measure-ram-expansion.mjs から
// window.__webx68kStorageProbe 経由で読み書きする。

export interface DiskSaveProbeEvent {
  slot: string;
  sourceKey: string;
  byteLength: number;
  /** put() 開始時点でキーが存在しなかった(初回追加)か、既存キーへの上書きか。 */
  isNewKey: boolean;
  /** MEMFSから吸い出し、slice()でコピーし終えた(=bytes確定)時刻。 */
  bytesReadyAtMs: number;
  /** IndexedDB put() 呼び出し直前の時刻。 */
  putStartAtMs: number;
  /** transaction の complete (成功時)。abort/errorなら null。 */
  putCompleteAtMs: number | null;
  aborted: boolean;
  error: string | null;
}

export interface ByteVerifyResult {
  ok: boolean;
  sizeMatch: boolean;
  tailMatch: boolean;
  checksumMatch: boolean;
  expectedByteLength: number;
  actualByteLength: number | null;
  expectedChecksum: number;
  actualChecksum: number | null;
}

export type RamExpansionKind = 'rom-ipl' | 'rom-cg' | 'fdd0' | 'fdd1' | 'hdd';
export type RamExpansionFault = 'skip-write' | 'truncate-tail' | 'corrupt-checksum' | null;

export interface RamExpansionProbeEvent {
  kind: RamExpansionKind;
  fault: RamExpansionFault;
  byteLength: number;
  /** MEMFS writeFile() 呼び出し直前・直後(戻り)の時刻。 */
  memfsWriteStartAtMs: number;
  memfsWriteEndAtMs: number;
  verify: ByteVerifyResult;
}

// FNV-1a 32bit。暗号強度は不要で、末尾1byte変化・切り詰めを確実に検出できれば十分。
export function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const TAIL_LEN = 64;

function tailBytes(bytes: Uint8Array): Uint8Array {
  return bytes.length <= TAIL_LEN ? bytes : bytes.subarray(bytes.length - TAIL_LEN);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** expected(元データ)と actual(読み戻したデータ)を size/末尾/checksumの3系統で検査する。 */
export function verifyBytes(expected: Uint8Array, actual: Uint8Array | null): ByteVerifyResult {
  if (actual === null) {
    return {
      ok: false,
      sizeMatch: false,
      tailMatch: false,
      checksumMatch: false,
      expectedByteLength: expected.byteLength,
      actualByteLength: null,
      expectedChecksum: fnv1a(expected),
      actualChecksum: null,
    };
  }
  const sizeMatch = expected.byteLength === actual.byteLength;
  const tailMatch = sizeMatch && bytesEqual(tailBytes(expected), tailBytes(actual));
  const expectedChecksum = fnv1a(expected);
  const actualChecksum = fnv1a(actual);
  const checksumMatch = expectedChecksum === actualChecksum;
  return {
    ok: sizeMatch && tailMatch && checksumMatch,
    sizeMatch,
    tailMatch,
    checksumMatch,
    expectedByteLength: expected.byteLength,
    actualByteLength: actual.byteLength,
    expectedChecksum,
    actualChecksum,
  };
}

export interface LibraryLoadProbeEvent {
  sourceKey: string;
  slot: string;
  byteLength: number;
  /** getDisk() 呼び出し直前・結果bytesを受け取った直後の時刻(IndexedDB get要求から全bytes取得まで)。 */
  idbGetStartAtMs: number;
  idbGetEndAtMs: number;
}

class StorageProbe {
  enabled = false;
  /** putDisk() 内で次回1回だけ、tx.oncomplete前にtx.abort()する(陽性対照込みの故障注入用)。 */
  abortNextPut = false;
  diskSaves: DiskSaveProbeEvent[] = [];
  ramExpansions: RamExpansionProbeEvent[] = [];
  libraryLoads: LibraryLoadProbeEvent[] = [];
  /** 次回1回だけの起動時RAM展開の故障注入(測定専用。libretro-host.tsのprobedMemfsWriteが消費)。 */
  nextRamFault: RamExpansionFault = null;

  reset(): void {
    this.diskSaves = [];
    this.ramExpansions = [];
    this.libraryLoads = [];
    this.abortNextPut = false;
    this.nextRamFault = null;
  }
}

export const storageProbe = new StorageProbe();

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __webx68kStorageProbe?: StorageProbe }).__webx68kStorageProbe = storageProbe;
}

// 目的B(docs/STORAGE-SCSI.md「目的B」表「フレーム時間の分布」)専用の計測フック。
// storageProbeと同じ作法: import.meta.env.DEV の内側でのみ有効化でき、既定 enabled=false。
// 無効時は呼び出し元(libretro-host.ts runFrame()/handleVideoRefresh()、main.ts loop())が
// `if (frameProbe.enabled)` で分岐し、計測コード自体を実行しない(常時コストを持ち込まない)。
// scripts/measure-frame-timing.mjs から window.__webx68kDebug 経由で読み書きする。

export interface FrameRunEvent {
  frameIndex: number;
  /** retro_run() 呼び出し直前・直後(戻り)の時刻。video callbackはこの区間内で同期的に発生する。 */
  runStartAtMs: number;
  runEndAtMs: number;
  /** このフレームで測定系検証用の50ms busy waitを注入したか。 */
  busyWaitInjectedMs: number;
}

export interface FrameVideoEvent {
  frameIndex: number;
  /** RETRO_ENVIRONMENT側がdata===0を渡した(=dupe frame。実際の再変換・putImageDataは発生しない)。 */
  dupe: boolean;
  width: number;
  height: number;
  fps: number | null;
  /** RGB565→RGBA変換の開始・終了。dupeの場合はconvertStartAtMsのみ(コールバック到達時刻)。 */
  convertStartAtMs: number;
  convertEndAtMs: number | null;
  /** putImageData() 呼び出し直前・復帰直後。canvas更新処理の復帰点(物理表示時刻ではない)。 */
  putStartAtMs: number | null;
  putEndAtMs: number | null;
}

export interface LongTaskSample {
  startAtMs: number;
  durationMs: number;
}

class FrameProbe {
  enabled = false;
  /** 60フレームごとに50msのbusy waitを注入する(測定系の検証専用。故障注入)。 */
  busyWaitFaultEnabled = false;
  /** runFrame()が呼ばれるたびに進める通しカウンタ。videoEventsとの対応付けに使う。 */
  frameCounter = 0;
  runEvents: FrameRunEvent[] = [];
  videoEvents: FrameVideoEvent[] = [];
  /** 前面タブのrAF観測間隔用。メインの駆動ループ(rAF/setTimeoutの競争)とは別に、
   * 観測専用の独立したrequestAnimationFrameチェーンがperformance.now()を積む。 */
  rafSamples: number[] = [];
  longTasks: LongTaskSample[] = [];

  reset(): void {
    this.frameCounter = 0;
    this.runEvents = [];
    this.videoEvents = [];
    this.rafSamples = [];
    this.longTasks = [];
  }
}

export const frameProbe = new FrameProbe();

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __webx68kFrameProbe?: FrameProbe }).__webx68kFrameProbe = frameProbe;
}

// 既定経路(urlWorkerMode===false)の帰属計測(「注入の遅れ」「観測の遅れ」の切り分け)専用
// プローブ。frameProbe/storageProbeと同じ作法: 既定 enabled=false で、無効時は呼び出し元
// (libretro-host.ts runFrame()、main.ts applyKey/applyKeyMake)が `if (keybufAttributionProbe.
// enabled)` で分岐し、計測コード自体を実行しない(常時コストを持ち込まない。特に
// frameProbe.frameCounterとは意図的に別カウンタにしてある。frameProbe.enabledはvideoEvents等
// 込みで重く、キー入力レイテンシの計測対象そのものを汚染しかねないため、このプローブは
// frameProbeの状態に依存しない専用の軽量カウンタ(frameNo)を持つ)。
//
// Worker経路の帰属計測(src/core-worker.tsのkeyBufWriteTracker、main.tsの
// workerLastKeyBufWriteFrameNo/workerLastInputSendFrameNo)と同じ定義・同じ数え方を、
// src/keybuf-attribution.tsの共有ロジック(trackKeyBufWrite/frameDelta)で揃えている
// (docs/STORAGE-SCSI.md「帰属の定義」参照)。
export class KeybufAttributionProbe {
  enabled = false;
  /** このプローブが有効な間だけ進む、コアが完了したretro_run()の累積数。単一のクロック
   * (docs参照)。Worker経路のframeNoと同じ役割。frameProbe.frameCounterとは独立。 */
  frameNo = 0;
  tracker: KeyBufWriteTrackerState = initialTrackerState();
  /** 直近の applyKey/applyKeyMake 呼び出し(host.setKey/sendKeyMakeへ渡す直前)の時点で
   * このプローブが知っていたframeNo。「注入の遅れ」の起点。 */
  inputSendFrameNo: number | null = null;
  /** 2026-08-31再訂正(「帰属の定義の誤りと訂正」参照): 実際に入力が適用された瞬間の
   * frameNo。既定経路は送信と適用が同一呼び出しの中で起きるため、常に inputSendFrameNo と
   * 同値になる(Worker経路との式(trueInjectionFrames = writeFrameNo - applyFrameNo)を
   * 揃えるためだけに持つフィールドで、既定経路単独では意味のある差を生まない)。 */
  applyFrameNo: number | null = null;

  reset(): void {
    this.frameNo = 0;
    this.tracker = initialTrackerState();
    this.inputSendFrameNo = null;
    this.applyFrameNo = null;
  }
}

export const keybufAttributionProbe = new KeybufAttributionProbe();

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __webx68kKeybufAttributionProbe?: KeybufAttributionProbe }).__webx68kKeybufAttributionProbe =
    keybufAttributionProbe;
}
