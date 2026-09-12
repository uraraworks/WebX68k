import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearHostFolderHandle,
  loadHostFolderHandle,
  saveHostFolderHandle,
  updateHostFolderNote,
} from '../src/hostfs/host-folder-store.ts';

// vitest.config.ts は environment: 'node' のため、test/sram-store.test.ts と同じ流儀で
// openDb()が実際に叩くAPI面(open/onupgradeneeded/transaction/objectStore/put/get/delete)
// だけを再現した最小限のIndexedDB互換モックを使う(汎用実装ではない)。

interface FakeIDBRequestLike {
  result: unknown;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

function makeRequest(): FakeIDBRequestLike {
  return { result: undefined, error: null, onsuccess: null, onerror: null };
}

class FakeObjectStore {
  constructor(private data: Map<unknown, unknown>) {}
  put(value: unknown, key: unknown): FakeIDBRequestLike {
    this.data.set(key, value);
    return makeRequest();
  }
  get(key: unknown): FakeIDBRequestLike {
    const req = makeRequest();
    queueMicrotask(() => {
      req.result = this.data.get(key);
      req.onsuccess?.();
    });
    return req;
  }
  delete(key: unknown): FakeIDBRequestLike {
    this.data.delete(key);
    return makeRequest();
  }
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private store: FakeObjectStore;
  constructor(data: Map<unknown, unknown>) {
    this.store = new FakeObjectStore(data);
    queueMicrotask(() => this.oncomplete?.());
  }
  objectStore(_name: string): FakeObjectStore {
    return this.store;
  }
}

class FakeDatabase {
  private stores = new Map<string, Map<unknown, unknown>>();
  objectStoreNames = {
    contains: (name: string): boolean => this.stores.has(name),
  };
  createObjectStore(name: string): void {
    this.stores.set(name, new Map());
  }
  transaction(name: string, _mode: string): FakeTransaction {
    const data = this.stores.get(name);
    if (!data) throw new Error(`FakeDatabase: no such store "${name}"`);
    return new FakeTransaction(data);
  }
  close(): void {}
}

class FakeIndexedDB {
  private databases = new Map<string, FakeDatabase>();

  open(name: string, _version: number): FakeIDBRequestLike & { onupgradeneeded: (() => void) | null } {
    const req = makeRequest() as FakeIDBRequestLike & { onupgradeneeded: (() => void) | null };
    req.onupgradeneeded = null;
    queueMicrotask(() => {
      let db = this.databases.get(name);
      const isNew = !db;
      if (!db) {
        db = new FakeDatabase();
        this.databases.set(name, db);
      }
      req.result = db;
      if (isNew) req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req;
  }

  reset(): void {
    this.databases.clear();
  }
}

let fakeIndexedDB: FakeIndexedDB;

/** テスト用の最小限のFileSystemDirectoryHandle風オブジェクト(nameだけ持つ)。 */
function fakeHandle(name: string): FileSystemDirectoryHandle {
  return { name } as unknown as FileSystemDirectoryHandle;
}

beforeEach(() => {
  fakeIndexedDB = new FakeIndexedDB();
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = fakeIndexedDB;
});

afterEach(() => {
  fakeIndexedDB.reset();
});

describe('host-folder-store の覚え書き(note)永続化', () => {
  it('note無しで保存すると、読み出したレコードにnoteが無い', async () => {
    await saveHostFolderHandle(fakeHandle('MyFolder'), 'read');
    const loaded = await loadHostFolderHandle();
    expect(loaded?.note).toBeUndefined();
  });

  it('noteを付けて保存すると、そのまま読み出せる(往復)', async () => {
    await saveHostFolderHandle(fakeHandle('MyFolder'), 'readwrite', 'Desktop/仕事/共有フォルダ');
    const loaded = await loadHostFolderHandle();
    expect(loaded?.note).toBe('Desktop/仕事/共有フォルダ');
    expect(loaded?.mode).toBe('readwrite');
    expect(loaded?.handle.name).toBe('MyFolder');
  });

  it('updateHostFolderNote()はhandle/modeを変えずnoteだけ差し替える', async () => {
    await saveHostFolderHandle(fakeHandle('MyFolder'), 'readwrite', '旧メモ');
    await updateHostFolderNote('新メモ');
    const loaded = await loadHostFolderHandle();
    expect(loaded?.note).toBe('新メモ');
    expect(loaded?.mode).toBe('readwrite');
    expect(loaded?.handle.name).toBe('MyFolder');
  });

  it('保存済みレコードが無いままupdateHostFolderNote()を呼んでも何も起きない', async () => {
    await expect(updateHostFolderNote('メモ')).resolves.toBeUndefined();
    expect(await loadHostFolderHandle()).toBeNull();
  });

  it('clearHostFolderHandle()後はnoteごと消える', async () => {
    await saveHostFolderHandle(fakeHandle('MyFolder'), 'read', 'メモ');
    await clearHostFolderHandle();
    expect(await loadHostFolderHandle()).toBeNull();
  });
});
