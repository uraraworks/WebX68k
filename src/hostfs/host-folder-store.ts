// HostFS (feature/hostfs) P2a #3: 接続したフォルダのFileSystemDirectoryHandleを
// IndexedDB(webx68k-hostfs)へ永続化する。ページ再訪問時に自動で許可を求めることは
// せず(親からの指示書のとおり)、許可が既に'granted'のときだけ黙って再接続し、
// 'prompt'のときはUI側が「再接続」ボタンを出す(main.ts参照)。
//
// W2a(書き込み): つなぐときに選んだモード(read/readwrite)もhandleと一緒に保存し、
// 再接続では同じモードでrequestPermissionする(親からの指示書のとおり)。
//
// 覚え書き(メモ、追加分): File System Access API はフォルダの「名前」しか渡さず、
// ホスト側のフルパスが分からない。利用者がフルパスなどをメモできるよう、任意の
// 覚え書き(60文字まで)をhandleと同じレコードに保存し、再接続後もそのまま出す。
//
// 命名規約(CLAUDE.md): IndexedDBは `webx68k-<名詞>`。

import type { HostFsConnectMode } from './filesystem';

const DB_NAME = 'webx68k-hostfs';
const DB_VERSION = 1;
const STORE_NAME = 'handle';
const KEY = 'root';

/** 覚え書きの最大文字数(利用者が決めたこと)。 */
export const HOSTFS_NOTE_MAX_LENGTH = 60;

export interface StoredHostFolder {
  handle: FileSystemDirectoryHandle;
  mode: HostFsConnectMode;
  /** 覚え書き(任意)。未設定/空文字は「無し」として扱う(main.ts側)。 */
  note?: string;
}

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

export async function saveHostFolderHandle(
  handle: FileSystemDirectoryHandle,
  mode: HostFsConnectMode,
  note?: string,
): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const record: StoredHostFolder = note ? { handle, mode, note } : { handle, mode };
      tx.objectStore(STORE_NAME).put(record, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB書き込み失敗'));
    });
  } finally {
    db.close();
  }
}

/**
 * 保存済みレコードのhandle/modeはそのままに、覚え書きだけ差し替える(「覚え書きを編集」用)。
 * 保存済みレコードが無ければ何もしない(つないでいない状態で呼ばれることは想定していない)。
 */
export async function updateHostFolderNote(note: string): Promise<void> {
  const existing = await loadHostFolderHandle();
  if (!existing) return;
  await saveHostFolderHandle(existing.handle, existing.mode, note);
}

/**
 * 保存済みのフォルダを読み出す。旧形式(W2a以前、handleを直接保存していたもの)が
 * 残っていた場合は読み取り専用モードとして扱う(安全側。書き込み許可を黙って
 * 復元しない)。
 */
export async function loadHostFolderHandle(): Promise<StoredHostFolder | null> {
  const db = await openDb();
  try {
    return await new Promise<StoredHostFolder | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(KEY);
      req.onsuccess = () => {
        const result = req.result as StoredHostFolder | FileSystemDirectoryHandle | undefined;
        if (!result) {
          resolve(null);
        } else if ('handle' in result && 'mode' in result) {
          resolve(result as StoredHostFolder);
        } else {
          // 旧形式: handleそのものが保存されている。読み取り専用として扱う。
          resolve({ handle: result as FileSystemDirectoryHandle, mode: 'read' });
        }
      };
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

/** 既存の許可状態を"確認するだけ"(要求はしない)。保存済みモードと同じmodeで確認する。 */
export async function queryHostFolderPermission(
  handle: FileSystemDirectoryHandle,
  mode: HostFsConnectMode,
): Promise<HostFolderPermissionState> {
  const h = handle as FileSystemDirectoryHandle & {
    queryPermission?: (opts: { mode: HostFsConnectMode }) => Promise<HostFolderPermissionState>;
  };
  if (!h.queryPermission) return 'prompt';
  return h.queryPermission({ mode });
}

/** ユーザー操作(クリック)の中からだけ呼ぶこと。保存済みモードと同じmodeで許可を要求する。 */
export async function requestHostFolderPermission(
  handle: FileSystemDirectoryHandle,
  mode: HostFsConnectMode,
): Promise<HostFolderPermissionState> {
  const h = handle as FileSystemDirectoryHandle & {
    requestPermission?: (opts: { mode: HostFsConnectMode }) => Promise<HostFolderPermissionState>;
  };
  if (!h.requestPermission) return 'granted'; // requestPermission非対応環境(OPFS等)は常に許可済み扱い
  return h.requestPermission({ mode });
}

/** File System Access API (showDirectoryPicker) がこの環境で使えるか。 */
export function isDirectoryPickerSupported(): boolean {
  return typeof (globalThis as Record<string, unknown>).showDirectoryPicker === 'function';
}
