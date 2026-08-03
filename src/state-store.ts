// ステートセーブ(retro_serialize の結果)を IndexedDB に永続化するヘルパー。
// ディスクライブラリ(disk-store.ts)とは別DBにして、ライブラリ一覧にステートが混ざらないようにする。

/** セーブ時のドライブ構成。ロード時に「同じディスクが入っているか」を照合するために持つ。 */
export interface StateDiskConfig {
  fdd0: string | null;
  fdd1: string | null;
  hdd: string | null;
}

export interface StoredState {
  /** スロットキー。現状はクイックセーブの1枠のみなので 'quick' 固定。 */
  slot: string;
  /** retro_serialize() の生バイト列(このモジュールの外では常に非圧縮で扱う)。 */
  bytes: Uint8Array;
  savedAt: number;
  disks: StateDiskConfig;
}

/** IndexedDB 上のレコード。bytes は compressed フラグが立っていれば gzip 圧縮済み。 */
interface StateRecord extends Omit<StoredState, 'bytes'> {
  bytes: Uint8Array;
  compressed?: boolean;
}

/**
 * ステートは 1 本あたり約15MB(px68k は RAM 領域を構成に依らず 12MB 固定でシリアライズする)。
 * 大半がゼロ埋めなので gzip がよく効き、実測で 15.5MB → 約276KB(約60ms)まで縮む。
 * CompressionStream が無い環境では非圧縮のまま保存する(読み出し側はフラグで判別する)。
 */
async function gzip(bytes: Uint8Array): Promise<{ bytes: Uint8Array; compressed: boolean }> {
  if (typeof CompressionStream === 'undefined') return { bytes, compressed: false };
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return { bytes: new Uint8Array(buf), compressed: true };
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

const DB_NAME = 'webx68k-states';
const STORE_NAME = 'states';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'slot' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getState(slot: string): Promise<StoredState | undefined> {
  const db = await openDb();
  const record = await new Promise<StateRecord | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(slot);
    req.onsuccess = () => resolve((req.result as StateRecord | undefined) ?? undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  if (!record) return undefined;
  const bytes = record.compressed ? await gunzip(record.bytes) : record.bytes;
  return { slot: record.slot, bytes, savedAt: record.savedAt, disks: record.disks };
}

export async function saveState(state: StoredState): Promise<void> {
  const packed = await gzip(state.bytes);
  const record: StateRecord = {
    slot: state.slot,
    bytes: packed.bytes,
    compressed: packed.compressed,
    savedAt: state.savedAt,
    disks: state.disks,
  };
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
