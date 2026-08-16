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
