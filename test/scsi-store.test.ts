import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canDeleteScsiImage,
  deleteScsiImage,
  isScsiStorageAvailable,
  listScsiImages,
  sortScsiEntries,
  type ScsiEntry,
} from '../src/scsi-store.ts';

// scsi-store.ts のメインスレッド用OPFS API(navigator.storage.getDirectory() 経由)を
// テストで再現するための最小限の偽物。ファイル本体は Uint8Array で持ち、getFile() は
// File を作って返すだけ(内容の読み書きはこのテストの対象外、一覧・削除の挙動だけを見る)。
class FakeFileHandle {
  readonly kind = 'file' as const;
  constructor(
    public name: string,
    public data: Uint8Array,
  ) {}
  async getFile(): Promise<File> {
    return new File([this.data], this.name);
  }
}

class FakeDirHandle {
  readonly kind = 'directory' as const;
  files = new Map<string, FakeFileHandle>();

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    const existing = this.files.get(name);
    if (existing) return existing;
    if (!opts?.create) throw new DOMException('Not found', 'NotFoundError');
    const handle = new FakeFileHandle(name, new Uint8Array(0));
    this.files.set(name, handle);
    return handle;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name)) throw new DOMException('Not found', 'NotFoundError');
  }

  // FileSystemDirectoryHandle は for-await-of に対応(非同期イテレータ)。
  async *[Symbol.asyncIterator](): AsyncIterableIterator<[string, FakeFileHandle]> {
    for (const [name, handle] of this.files) yield [name, handle];
  }
}

class FakeRootHandle {
  scsiDir: FakeDirHandle | null = null;

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDirHandle> {
    expect(name).toBe('scsi');
    if (this.scsiDir) return this.scsiDir;
    if (!opts?.create) throw new DOMException('Not found', 'NotFoundError');
    this.scsiDir = new FakeDirHandle();
    return this.scsiDir;
  }
}

describe('sortScsiEntries (一覧の並び順)', () => {
  it('名前の昇順に揃える(ディレクトリ列挙順には依存しない)', () => {
    const entries: ScsiEntry[] = [
      { name: 'zeta.hds', bytes: 1 },
      { name: 'alpha.hds', bytes: 2 },
      { name: 'mid.hds', bytes: 3 },
    ];
    expect(sortScsiEntries(entries).map((e) => e.name)).toEqual(['alpha.hds', 'mid.hds', 'zeta.hds']);
  });

  it('元の配列を破壊しない', () => {
    const entries: ScsiEntry[] = [
      { name: 'b.hds', bytes: 1 },
      { name: 'a.hds', bytes: 2 },
    ];
    const sorted = sortScsiEntries(entries);
    expect(sorted).not.toBe(entries);
    expect(entries.map((e) => e.name)).toEqual(['b.hds', 'a.hds']);
  });
});

describe('canDeleteScsiImage (挿入中の削除ガード)', () => {
  it('現在挿入中の名前と一致すれば削除不可', () => {
    expect(canDeleteScsiImage('current.hds', 'current.hds')).toBe(false);
  });

  it('挿入中の名前と異なれば削除可', () => {
    expect(canDeleteScsiImage('other.hds', 'current.hds')).toBe(true);
  });

  it('何も挿入していない(null)ならどの名前でも削除可', () => {
    expect(canDeleteScsiImage('any.hds', null)).toBe(true);
  });
});

describe('listScsiImages / deleteScsiImage (OPFSを偽物に差し替えた結合)', () => {
  let root: FakeRootHandle;
  let originalStorage: unknown;

  beforeEach(() => {
    root = new FakeRootHandle();
    originalStorage = (navigator as unknown as { storage?: unknown }).storage;
    (navigator as unknown as { storage: unknown }).storage = {
      getDirectory: async () => root,
    };
  });

  afterEach(() => {
    (navigator as unknown as { storage: unknown }).storage = originalStorage;
  });

  it('scsi/ ディレクトリが無ければ空配列を返す(例外にしない)', async () => {
    expect(await listScsiImages()).toEqual([]);
  });

  it('列挙順が名前順でなくても、返る一覧は名前の昇順に揃う', async () => {
    const dir = await root.getDirectoryHandle('scsi', { create: true });
    // 意図的に降順で登録し、列挙順(Map挿入順)が結果の並びを決めていないことを確かめる。
    await dir.getFileHandle('zeta.hds', { create: true });
    await dir.getFileHandle('alpha.hds', { create: true });
    const list = await listScsiImages();
    expect(list.map((e) => e.name)).toEqual(['alpha.hds', 'zeta.hds']);
  });

  it('deleteScsiImage() で削除した項目は一覧から消える', async () => {
    const dir = await root.getDirectoryHandle('scsi', { create: true });
    await dir.getFileHandle('a.hds', { create: true });
    await dir.getFileHandle('b.hds', { create: true });
    await deleteScsiImage('a.hds');
    const list = await listScsiImages();
    expect(list.map((e) => e.name)).toEqual(['b.hds']);
  });

  it('deleteScsiImage() は元々無い名前を渡しても例外を投げない', async () => {
    await root.getDirectoryHandle('scsi', { create: true });
    await expect(deleteScsiImage('nope.hds')).resolves.toBeUndefined();
  });
});

describe('isScsiStorageAvailable', () => {
  let originalStorage: unknown;

  beforeEach(() => {
    originalStorage = (navigator as unknown as { storage?: unknown }).storage;
  });

  afterEach(() => {
    (navigator as unknown as { storage: unknown }).storage = originalStorage;
  });

  it('navigator.storage.getDirectory が使えれば true', async () => {
    (navigator as unknown as { storage: unknown }).storage = {
      getDirectory: async () => new FakeRootHandle(),
    };
    expect(await isScsiStorageAvailable()).toBe(true);
  });

  it('getDirectory が無ければ false', async () => {
    (navigator as unknown as { storage: unknown }).storage = {};
    expect(await isScsiStorageAvailable()).toBe(false);
  });

  it('getDirectory が例外を投げれば false', async () => {
    (navigator as unknown as { storage: unknown }).storage = {
      getDirectory: async () => {
        throw new Error('denied');
      },
    };
    expect(await isScsiStorageAvailable()).toBe(false);
  });
});
