import { describe, expect, it } from 'vitest';
import { HostFolderFs } from '../src/hostfs/host-folder-fs';

// FileSystemDirectoryHandle/FileSystemFileHandle のモック。
// 実ブラウザ環境(File System Access API / OPFS)が無いvitest(node環境)向けに、
// host-folder-fs.ts が使う最小限(kind, name, entries(), getFile())だけを実装する。

class MockFileHandle {
  readonly kind = 'file' as const;
  constructor(
    public name: string,
    private content: string,
    public lastModified: number = new Date(2026, 8, 11, 12, 34, 56).getTime(),
  ) {}
  async getFile(): Promise<{ size: number; lastModified: number; arrayBuffer(): Promise<ArrayBuffer> }> {
    const bytes = new TextEncoder().encode(this.content);
    return {
      size: bytes.length,
      lastModified: this.lastModified,
      arrayBuffer: async () => bytes.buffer,
    };
  }
}

class MockDirHandle {
  readonly kind = 'directory' as const;
  private children = new Map<string, MockFileHandle | MockDirHandle>();
  constructor(public name: string) {}

  addFile(name: string, content: string): MockFileHandle {
    const h = new MockFileHandle(name, content);
    this.children.set(name, h);
    return h;
  }
  addDir(name: string): MockDirHandle {
    const h = new MockDirHandle(name);
    this.children.set(name, h);
    return h;
  }
  async *entries(): AsyncIterable<[string, MockFileHandle | MockDirHandle]> {
    for (const [name, handle] of this.children) yield [name, handle];
  }
}

function makeRoot(): MockDirHandle {
  const root = new MockDirHandle('root');
  root.addFile('hello.txt', 'hello world');
  root.addFile('readme.doc', 'readme');
  root.addFile('日本語.txt', 'nihongo');
  root.addFile('this_name_is_way_too_long_for_human68k.txt', 'too long');
  root.addFile('a.b.c', 'two dots');
  const sub = root.addDir('sub');
  sub.addFile('abc.txt', 'sub file');
  return root;
}

describe('HostFolderFs', () => {
  it('listDir: 出るべき名前が出て、出ないはずのもの(長すぎる名前・ドット2つ)は出ない', async () => {
    const fs = new HostFolderFs(makeRoot() as unknown as FileSystemDirectoryHandle);
    const entries = await fs.listDir('');
    const names = entries.map((e) => (e.ext ? `${e.name}.${e.ext}` : e.name));
    expect(names).toContain('hello.txt');
    expect(names).toContain('readme.doc');
    expect(names).toContain('sub');
    expect(names.some((n) => n.startsWith('this_name_is_way_too_long'))).toBe(false);
    expect(names).not.toContain('a.b.c');
    expect(fs.rejectedCount).toBe(2); // 長すぎる名前 + ドット2つ
  });

  it('rejectedCountは累計ではなく直近のlistDir()呼び出し1回ぶん(dirのたびに際限なく伸びない)', async () => {
    const fs = new HostFolderFs(makeRoot() as unknown as FileSystemDirectoryHandle);
    await fs.listDir(''); // 1回目: 出せない名前が2件
    expect(fs.rejectedCount).toBe(2);
    await fs.listDir(''); // 2回目: 同じ内容なので、累計なら4になってしまうところ
    expect(fs.rejectedCount).toBe(2);
  });

  it('listDir: ディレクトリの属性は0x10、ファイルは0x20', async () => {
    const fs = new HostFolderFs(makeRoot() as unknown as FileSystemDirectoryHandle);
    const entries = await fs.listDir('');
    const sub = entries.find((e) => e.name.toUpperCase() === 'SUB');
    const hello = entries.find((e) => e.name.toUpperCase() === 'HELLO');
    expect(sub?.attr).toBe(0x10);
    expect(hello?.attr).toBe(0x20);
  });

  it('listDir: ディレクトリの日時は1980-01-01 00:00固定', async () => {
    const fs = new HostFolderFs(makeRoot() as unknown as FileSystemDirectoryHandle);
    const entries = await fs.listDir('');
    const sub = entries.find((e) => e.name.toUpperCase() === 'SUB');
    expect(sub?.date).toEqual({ year: 1980, month: 1, day: 1 });
    expect(sub?.time).toEqual({ hour: 0, minute: 0, second: 0 });
  });

  it('listDir: サブディレクトリ(\\SUB)を解決する', async () => {
    const fs = new HostFolderFs(makeRoot() as unknown as FileSystemDirectoryHandle);
    const entries = await fs.listDir('\\SUB');
    expect(entries.some((e) => e.name.toUpperCase() === 'ABC' && e.ext.toUpperCase() === 'TXT')).toBe(true);
  });

  it('listDir: 存在しないパスは空配列(検索が-2になる)', async () => {
    const fs = new HostFolderFs(makeRoot() as unknown as FileSystemDirectoryHandle);
    const entries = await fs.listDir('\\NOPE');
    expect(entries).toEqual([]);
  });

  it('readFile: 大文字小文字を無視して中身を返す', async () => {
    const fs = new HostFolderFs(makeRoot() as unknown as FileSystemDirectoryHandle);
    const content = await fs.readFile('', 'HELLO', 'TXT');
    expect(content).not.toBeNull();
    expect(new TextDecoder().decode(content!)).toBe('hello world');
  });

  it('readFile: サブディレクトリ配下も読める', async () => {
    const fs = new HostFolderFs(makeRoot() as unknown as FileSystemDirectoryHandle);
    const content = await fs.readFile('\\SUB', 'ABC', 'TXT');
    expect(content).not.toBeNull();
    expect(new TextDecoder().decode(content!)).toBe('sub file');
  });

  it('readFile: 見つからなければnull', async () => {
    const fs = new HostFolderFs(makeRoot() as unknown as FileSystemDirectoryHandle);
    expect(await fs.readFile('', 'NOPE', 'TXT')).toBeNull();
  });

  it('dirExists: ルートと実在するサブディレクトリはtrue、無いパスはfalse($41 cd用)', async () => {
    const fs = new HostFolderFs(makeRoot() as unknown as FileSystemDirectoryHandle);
    expect(await fs.dirExists('')).toBe(true);
    expect(await fs.dirExists('\\SUB')).toBe(true);
    expect(await fs.dirExists('\\NOPE')).toBe(false);
  });
});
