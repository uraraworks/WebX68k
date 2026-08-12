import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSramFile, saveSramFile } from '../src/sram-store.ts';

// vitest.config.ts は environment: 'node' なので、ブラウザの IndexedDB は存在しない。
// disk-store.ts/bios-store.ts と同じ `indexedDB.open()` ベースの実装を結合的に検証するため、
// このテストファイル専用の最小限の IndexedDB 互換モックを用意する
// (test/disk-store.test.ts はピュア関数のみを対象にしておりIndexedDB部分は未検証だったため、
// ここが初出。openDb()が実際に叩くAPI面(open/onupgradeneeded/transaction/objectStore/put/get)
// だけを再現していて、汎用のIndexedDB実装ではない)。

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
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private store: FakeObjectStore;
  constructor(data: Map<unknown, unknown>) {
    this.store = new FakeObjectStore(data);
    // put()は同期的にMapへ反映済みなので、呼び出し元がoncompleteを代入し終えた後の
    // マイクロタスクで完了通知すればよい(disk-store.ts等と同じ「put→oncomplete代入」の順)。
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

/** name単位でFakeDatabaseを永続させる(saveとloadが別々にopenDb()するため)。 */
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

  /** テスト間の汚染を防ぐため呼ぶ */
  reset(): void {
    this.databases.clear();
  }
}

let fakeIndexedDB: FakeIndexedDB;

beforeEach(() => {
  fakeIndexedDB = new FakeIndexedDB();
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = fakeIndexedDB;
});

afterEach(() => {
  fakeIndexedDB.reset();
});

describe('sram-store (SRAMのIndexedDB永続化)', () => {
  it('保存前は null が返る', async () => {
    expect(await loadSramFile()).toBeNull();
  });

  it('保存したバイト列をそのまま復元できる(往復)', async () => {
    const bytes = new Uint8Array(0x4000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    await saveSramFile(bytes);

    const loaded = await loadSramFile();
    expect(loaded).not.toBeNull();
    expect(loaded).toEqual(bytes);
  });

  it('再保存すると内容が上書きされる', async () => {
    const first = new Uint8Array(0x4000).fill(0x11);
    const second = new Uint8Array(0x4000).fill(0x22);
    await saveSramFile(first);
    await saveSramFile(second);

    const loaded = await loadSramFile();
    expect(loaded).toEqual(second);
  });
});
