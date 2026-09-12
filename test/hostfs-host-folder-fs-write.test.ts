import { describe, expect, it } from 'vitest';
import { HostFolderFs } from '../src/hostfs/host-folder-fs';
import {
  FS_OK,
  FS_ERR_FILE_NOT_FOUND,
  FS_ERR_DIR_NOT_FOUND,
  FS_ERR_WRITE_PROTECTED,
  FS_ERR_DIR_EXISTS,
  FS_ERR_DIR_NOT_EMPTY,
  FS_ERR_RENAME_TARGET_EXISTS,
  FS_ERR_FILE_EXISTS,
} from '../src/hostfs/filesystem';

// W2a(書き込み)用のFileSystemDirectoryHandle/FileSystemFileHandleモック。
// test/hostfs-host-folder-fs.test.ts(読み取り専用)のモックに、書き込みで使う
// getFileHandle({create})/getDirectoryHandle({create})/removeEntry/createWritable/move を
// 足したもの。move()の有無を切り替えられるようにして、両方の経路(move直接/コピー+削除)を
// 確かめる。

class MockWritable {
  constructor(private file: MockFileHandle) {}
  private buf: Uint8Array = new Uint8Array(0);
  async write(data: BufferSource): Promise<void> {
    // 実際のcreateWritable().write()は「全体を丸ごとwrite」する使い方しかしない
    // (host-folder-fs.tsのHostFolderWriteHandle.close()参照)ため、書かれた内容を
    // そのままファイルの中身にする単純化で十分。
    this.buf = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
  }
  async close(): Promise<void> {
    this.file.content = new TextDecoder('latin1').decode(this.buf); // 疑似文字列表現に合わせる
    this.file.contentBytes = this.buf;
    this.file.lastModified = Date.now();
  }
}

class MockFileHandle {
  readonly kind = 'file' as const;
  contentBytes: Uint8Array;
  move?: (newName: string) => Promise<void>;
  constructor(
    public name: string,
    public content: string,
    public lastModified: number = new Date(2026, 8, 11, 12, 34, 56).getTime(),
    private parent?: MockDirHandle,
    supportsMove = false,
  ) {
    this.contentBytes = new TextEncoder().encode(content);
    if (supportsMove) {
      this.move = async (newName: string) => {
        if (!this.parent) throw new Error('no parent');
        this.parent.children.delete(this.name);
        this.name = newName;
        this.parent.children.set(newName, this);
      };
    }
  }
  async getFile(): Promise<{ size: number; lastModified: number; arrayBuffer(): Promise<ArrayBuffer> }> {
    const bytes = this.contentBytes;
    return {
      size: bytes.length,
      lastModified: this.lastModified,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    };
  }
  async createWritable(): Promise<MockWritable> {
    return new MockWritable(this);
  }
}

class MockDirHandle {
  readonly kind = 'directory' as const;
  children = new Map<string, MockFileHandle | MockDirHandle>();
  move?: (newName: string) => Promise<void>;
  constructor(
    public name: string,
    private parent?: MockDirHandle,
    supportsMove = false,
  ) {
    if (supportsMove) {
      this.move = async (newName: string) => {
        if (!this.parent) throw new Error('no parent');
        this.parent.children.delete(this.name);
        this.name = newName;
        this.parent.children.set(newName, this);
      };
    }
  }
  addFile(name: string, content: string, supportsMove = false): MockFileHandle {
    const h = new MockFileHandle(name, content, undefined, this, supportsMove);
    this.children.set(name, h);
    return h;
  }
  addDir(name: string, supportsMove = false): MockDirHandle {
    const h = new MockDirHandle(name, this, supportsMove);
    this.children.set(name, h);
    return h;
  }
  async *entries(): AsyncIterable<[string, MockFileHandle | MockDirHandle]> {
    for (const [name, handle] of this.children) yield [name, handle];
  }
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<MockFileHandle> {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'file') throw new DOMException('TypeMismatchError', 'TypeMismatchError');
      return existing;
    }
    if (!opts?.create) throw new DOMException('NotFoundError', 'NotFoundError');
    return this.addFile(name, '');
  }
  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<MockDirHandle> {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'directory') throw new DOMException('TypeMismatchError', 'TypeMismatchError');
      return existing;
    }
    if (!opts?.create) throw new DOMException('NotFoundError', 'NotFoundError');
    return this.addDir(name);
  }
  async removeEntry(name: string): Promise<void> {
    if (!this.children.has(name)) throw new DOMException('NotFoundError', 'NotFoundError');
    this.children.delete(name);
  }
}

function makeRoot(): MockDirHandle {
  return new MockDirHandle('root');
}

describe('HostFolderFs (W2a: 書き込みAPI)', () => {
  it('isWritable(): コンストラクタのwritableをそのまま返す', () => {
    const root = makeRoot();
    expect(new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true).isWritable()).toBe(true);
    expect(new HostFolderFs(root as unknown as FileSystemDirectoryHandle, false).isWritable()).toBe(false);
  });

  it('createFile: 新規作成→openWriteで書く→close前は未反映→close後に反映', async () => {
    const root = makeRoot();
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    expect(await fs.createFile('', 'HELLO', 'TXT', false)).toBe(FS_OK);

    const handle = await fs.openWrite('', 'HELLO', 'TXT');
    if (typeof handle === 'number') throw new Error('unreachable');
    handle.write(0, new TextEncoder().encode('hello world'));

    // close前はまだ空(createFileで作った空ファイルのまま)。
    expect(await fs.readFile('', 'HELLO', 'TXT')).toEqual(new Uint8Array(0));

    await handle.close();
    expect(new TextDecoder().decode((await fs.readFile('', 'HELLO', 'TXT'))!)).toBe('hello world');
  });

  it('createFile: _NEWFILE相当(failIfExists=true)は既存なら-80', async () => {
    const root = makeRoot();
    root.addFile('a.txt', 'existing');
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    expect(await fs.createFile('', 'A', 'TXT', true)).toBe(FS_ERR_FILE_EXISTS);
  });

  it('createFile: 大文字小文字を区別しない上書き(既存hello.txtへHELLO.TXTとして作成)', async () => {
    const root = makeRoot();
    root.addFile('hello.txt', 'old content');
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);

    expect(await fs.createFile('', 'HELLO', 'TXT', false)).toBe(FS_OK);
    // ホスト側の実体名は変わらず、既存の 'hello.txt' のまま(新規の別名では作られない)。
    expect(root.children.has('hello.txt')).toBe(true);
    expect(root.children.has('HELLO.TXT')).toBe(false);
    expect(await fs.readFile('', 'HELLO', 'TXT')).toEqual(new Uint8Array(0)); // 上書きで空になった
  });

  it('openWrite: 存在しないファイルは-2、読み取り専用モードは-19', async () => {
    const root = makeRoot();
    root.addFile('a.txt', 'x');
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    expect(await fs.openWrite('', 'NOPE', 'TXT')).toBe(FS_ERR_FILE_NOT_FOUND);

    const readonlyFs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, false);
    expect(await readonlyFs.openWrite('', 'A', 'TXT')).toBe(FS_ERR_WRITE_PROTECTED);
  });

  it('deleteFile: 削除でき、削除後は読めない', async () => {
    const root = makeRoot();
    root.addFile('a.txt', 'x');
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    expect(await fs.deleteFile('', 'A', 'TXT')).toBe(FS_OK);
    expect(await fs.readFile('', 'A', 'TXT')).toBeNull();
    expect(await fs.deleteFile('', 'A', 'TXT')).toBe(FS_ERR_FILE_NOT_FOUND);
  });

  it('mkdir/rmdir: 既にあれば-20、中にファイルがあれば-21、空なら成功', async () => {
    const root = makeRoot();
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    expect(await fs.mkdir('', 'SUB')).toBe(FS_OK);
    expect(await fs.mkdir('', 'SUB')).toBe(FS_ERR_DIR_EXISTS);
    await fs.createFile('\\SUB', 'X', 'TXT', false);
    expect(await fs.rmdir('', 'SUB')).toBe(FS_ERR_DIR_NOT_EMPTY);
    await fs.deleteFile('\\SUB', 'X', 'TXT');
    expect(await fs.rmdir('', 'SUB')).toBe(FS_OK);
    expect(await fs.dirExists('\\SUB')).toBe(false);
  });

  it('rmdir: 存在しなければ-3', async () => {
    const root = makeRoot();
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    expect(await fs.rmdir('', 'NOPE')).toBe(FS_ERR_DIR_NOT_FOUND);
  });

  it('rename(ファイル): move()が使える場合はmoveで改名し、中身とホスト名が変わる', async () => {
    const root = makeRoot();
    root.addFile('a.txt', 'hello', true);
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    expect(await fs.rename('', 'A', 'TXT', 'B', 'TXT', false)).toBe(FS_OK);
    expect(root.children.has('a.txt')).toBe(false);
    // 新規に付く名前はゲストが渡したとおりの大文字小文字になる('B.TXT'。
    // 「大文字小文字は、ゲストが渡したとおりにする」)。
    expect(root.children.has('B.TXT')).toBe(true);
    expect(new TextDecoder().decode((await fs.readFile('', 'B', 'TXT'))!)).toBe('hello');
  });

  it('rename(ファイル): move()が無い場合はコピー+削除で代替する', async () => {
    const root = makeRoot();
    root.addFile('a.txt', 'hello', false); // move無し
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    expect(await fs.rename('', 'A', 'TXT', 'B', 'TXT', false)).toBe(FS_OK);
    expect(root.children.has('a.txt')).toBe(false);
    expect(root.children.has('B.TXT')).toBe(true);
    expect(new TextDecoder().decode((await fs.readFile('', 'B', 'TXT'))!)).toBe('hello');
  });

  it('rename: 移動先がすでにあれば-22', async () => {
    const root = makeRoot();
    root.addFile('a.txt', 'x');
    root.addFile('b.txt', 'y');
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    expect(await fs.rename('', 'A', 'TXT', 'B', 'TXT', false)).toBe(FS_ERR_RENAME_TARGET_EXISTS);
  });

  it('rename(ディレクトリ): move()が使えるときだけ改名でき、無ければ-19', async () => {
    const root = makeRoot();
    root.addDir('SUBA', true); // move対応
    root.addDir('SUBB', false); // move非対応
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    expect(await fs.rename('', 'SUBA', '', 'SUBA2', '', true)).toBe(FS_OK);
    expect(root.children.has('SUBA2')).toBe(true);
    expect(await fs.rename('', 'SUBB', '', 'SUBB2', '', true)).toBe(FS_ERR_WRITE_PROTECTED);
    expect(root.children.has('SUBB')).toBe(true); // 変わっていない
  });

  it('getAttr: ディレクトリは0x10、ファイルは0x20', async () => {
    const root = makeRoot();
    root.addFile('a.txt', 'x');
    root.addDir('sub');
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    expect(await fs.getAttr('', 'A', 'TXT')).toBe(0x20);
    expect(await fs.getAttr('', 'SUB', '')).toBe(0x10);
  });

  it('setFileDate/setAttr: 書き込み可能モードなら成功(0)、読み取り専用なら-19', async () => {
    const root = makeRoot();
    root.addFile('a.txt', 'x');
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    expect(await fs.setFileDate('', 'A', 'TXT')).toBe(FS_OK);
    expect(await fs.setAttr('', 'A', 'TXT', 0x20)).toBe(FS_OK);

    const readonlyFs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, false);
    expect(await readonlyFs.setFileDate('', 'A', 'TXT')).toBe(FS_ERR_WRITE_PROTECTED);
    expect(await readonlyFs.setAttr('', 'A', 'TXT', 0x20)).toBe(FS_ERR_WRITE_PROTECTED);
  });

  it('getFileDate: lastModifiedをDOS形式(上位ワード=日付・下位ワード=時刻)へ詰めて返す。読み取り専用でも成功', async () => {
    const root = makeRoot();
    root.addFile('a.txt', 'x'); // 既定lastModified = 2026-09-11 12:34:56(MockFileHandleの既定値)
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, false); // 読み取り専用
    // (2026-1980)<<9 | 9<<5 | 11 = 23851 = 0x5d2b、12<<11 | 34<<5 | (56>>1) = 25692 = 0x645c。
    expect(await fs.getFileDate('', 'A', 'TXT')).toBe(0x5d2b645c);
  });

  it('getFileDate: 見つからなければFS_ERR_FILE_NOT_FOUND、ディレクトリが無ければFS_ERR_DIR_NOT_FOUND', async () => {
    const root = makeRoot();
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    expect(await fs.getFileDate('', 'NOSUCH', 'TXT')).toBe(FS_ERR_FILE_NOT_FOUND);
    expect(await fs.getFileDate('NOSUCHDIR', 'A', 'TXT')).toBe(FS_ERR_DIR_NOT_FOUND);
  });

  it('読み取り専用モード: 書き込み系はすべて-19', async () => {
    const root = makeRoot();
    root.addFile('a.txt', 'x');
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, false);
    expect(fs.isWritable()).toBe(false);
    expect(await fs.createFile('', 'B', 'TXT', false)).toBe(FS_ERR_WRITE_PROTECTED);
    expect(await fs.deleteFile('', 'A', 'TXT')).toBe(FS_ERR_WRITE_PROTECTED);
    expect(await fs.mkdir('', 'SUB')).toBe(FS_ERR_WRITE_PROTECTED);
    expect(await fs.rmdir('', 'SUB')).toBe(FS_ERR_WRITE_PROTECTED);
    expect(await fs.rename('', 'A', 'TXT', 'B', 'TXT', false)).toBe(FS_ERR_WRITE_PROTECTED);
  });
});
