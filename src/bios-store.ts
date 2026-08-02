// BIOS ファイル(IPLROM.DAT / CGROM.DAT)を IndexedDB に永続化するための小さなヘルパー。

const DB_NAME = 'webx68k-bios';
const STORE_NAME = 'files';
const DB_VERSION = 1;

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
    req.onerror = () => reject(req.error);
  });
}

export async function saveBiosFile(key: 'ipl' | 'cg', data: Uint8Array): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(data, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadBiosFile(key: 'ipl' | 'cg'): Promise<Uint8Array | null> {
  const db = await openDb();
  const result = await new Promise<Uint8Array | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve((req.result as Uint8Array) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}
