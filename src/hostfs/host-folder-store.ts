// HostFS (feature/hostfs) P2a #3: 接続したフォルダのFileSystemDirectoryHandleを
// IndexedDB(webx68k-hostfs)へ永続化する。ページ再訪問時に自動で許可を求めることは
// せず(親からの指示書のとおり)、許可が既に'granted'のときだけ黙って再接続し、
// 'prompt'のときはUI側が「再接続」ボタンを出す(main.ts参照)。
//
// 命名規約(CLAUDE.md): IndexedDBは `webx68k-<名詞>`。

const DB_NAME = 'webx68k-hostfs';
const DB_VERSION = 1;
const STORE_NAME = 'handle';
const KEY = 'root';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open失敗'));
  });
}

export async function saveHostFolderHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(handle, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB書き込み失敗'));
    });
  } finally {
    db.close();
  }
}

export async function loadHostFolderHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDb();
  try {
    return await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(KEY);
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB読み取り失敗'));
    });
  } finally {
    db.close();
  }
}

export async function clearHostFolderHandle(): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB削除失敗'));
    });
  } finally {
    db.close();
  }
}

export type HostFolderPermissionState = 'granted' | 'prompt' | 'denied';

/** 既存の許可状態を"確認するだけ"(要求はしない)。 */
export async function queryHostFolderPermission(
  handle: FileSystemDirectoryHandle,
): Promise<HostFolderPermissionState> {
  const h = handle as FileSystemDirectoryHandle & {
    queryPermission?: (opts: { mode: 'read' }) => Promise<HostFolderPermissionState>;
  };
  if (!h.queryPermission) return 'prompt';
  return h.queryPermission({ mode: 'read' });
}

/** ユーザー操作(クリック)の中からだけ呼ぶこと。許可を要求する。 */
export async function requestHostFolderPermission(
  handle: FileSystemDirectoryHandle,
): Promise<HostFolderPermissionState> {
  const h = handle as FileSystemDirectoryHandle & {
    requestPermission?: (opts: { mode: 'read' }) => Promise<HostFolderPermissionState>;
  };
  if (!h.requestPermission) return 'granted'; // requestPermission非対応環境(OPFS等)は常に許可済み扱い
  return h.requestPermission({ mode: 'read' });
}

/** File System Access API (showDirectoryPicker) がこの環境で使えるか。 */
export function isDirectoryPickerSupported(): boolean {
  return typeof (globalThis as Record<string, unknown>).showDirectoryPicker === 'function';
}
