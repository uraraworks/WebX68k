// ディスクイメージ(FD/HDD)を IndexedDB に永続化するための「ディスクライブラリ」ヘルパー。
// WebNP2 (../PC98/WebNP2/src/storage/db.ts + src/api/library.ts) のディスクライブラリに準拠する。

export interface StoredDisk {
  sourceKey: string;
  /** 元のファイル名(拡張子含む)。イメージ種別の判定に使うため、リネームしても変わらない。 */
  name: string;
  bytes: Uint8Array;
  savedAt: number;
  /** ライブラリ一覧での表示名。未設定なら name をそのまま表示する。 */
  displayName?: string;
}

const DB_NAME = 'webx68k-disks';
const STORE_NAME = 'disks';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'sourceKey' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getDisk(sourceKey: string): Promise<StoredDisk | undefined> {
  const db = await openDb();
  const result = await new Promise<StoredDisk | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(sourceKey);
    req.onsuccess = () => resolve((req.result as StoredDisk | undefined) ?? undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

async function putDisk(disk: StoredDisk): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(disk);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/**
 * ディスクイメージをライブラリへ登録(更新)する。表示名(リネーム結果)は既存レコードのものを常に優先する。
 * D&D/ファイル選択のたびに呼ばれるため、同じファイルを再登録してもユーザーが付けた表示名が消えないようにする。
 */
export async function saveDisk(disk: Omit<StoredDisk, 'displayName'>): Promise<void> {
  const existing = await getDisk(disk.sourceKey);
  await putDisk({ ...disk, displayName: existing?.displayName });
}

/** ライブラリ内の全ディスクイメージを保存時刻の降順で返す。 */
export async function listDisks(): Promise<StoredDisk[]> {
  const db = await openDb();
  const result = await new Promise<StoredDisk[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve((req.result as StoredDisk[]) ?? []);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result.sort((a, b) => b.savedAt - a.savedAt);
}

export async function deleteDisk(sourceKey: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(sourceKey);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** ライブラリエントリの表示名を変更する。実ファイル名(拡張子)は変えないため種別判定は壊れない。 */
export async function renameDisk(sourceKey: string, displayName: string): Promise<void> {
  const existing = await getDisk(sourceKey);
  if (!existing) return;
  const trimmed = displayName.trim();
  // 空文字にされたら「表示名なし」に戻し、元のファイル名表示へフォールバックさせる。
  await putDisk({ ...existing, displayName: trimmed === '' ? undefined : trimmed });
}

/** D&D/ファイル選択で受け取った File から一意な sourceKey を作る(WebNP2の fileKeyFor に準拠)。 */
export function fileKeyFor(name: string, size: number): string {
  return `file:${name}:${size}`;
}

/** X68000用ディスクイメージとして受け付ける拡張子。 */
const HDD_EXTENSIONS = ['.hdf', '.dup'];
const FD_EXTENSIONS = ['.xdf', '.dim', '.d88', '.hdm', '.img', '.2hd'];
export const DISK_EXTENSIONS = [...FD_EXTENSIONS, ...HDD_EXTENSIONS];

/** ファイル名がディスクイメージの拡張子を持つか。 */
export function isDiskFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return DISK_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** 表示バッジ用の種別判定(HDD/FD)。挿入動作自体はどちらも同じ単一スロットへ行う。 */
export function classifyDiskKind(name: string): 'hdd' | 'fd' | null {
  const lower = name.toLowerCase();
  if (HDD_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'hdd';
  if (FD_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'fd';
  return null;
}
