import { describe, expect, it } from 'vitest';
import type { GuestMemory } from '../src/hostfs/guest-memory';
import { NAMESTS_SIZE } from '../src/hostfs/namests';
import { HostFsDispatcher } from '../src/hostfs/dispatcher';
import { HostFolderFs } from '../src/hostfs/host-folder-fs';

// W2b: dispatcherの書き込み系コマンド($42/$43/$44/$45/$46/$49/$4d、および$4a/$4b/$4cの
// 書き込み対応)を、本物のHostFolderFs(W2aの実装そのもの)へつないだ状態でテストする。
// FileSystemDirectoryHandle/FileSystemFileHandleのモックは
// test/hostfs-host-folder-fs-write.test.ts と同じ流儀の簡略版。

class MockWritable {
  constructor(private file: MockFileHandle) {}
  private buf: Uint8Array = new Uint8Array(0);
  async write(data: BufferSource): Promise<void> {
    this.buf = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
  }
  async close(): Promise<void> {
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
    content: string,
    public lastModified: number = Date.now(),
  ) {
    this.contentBytes = new TextEncoder().encode(content);
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

function makeFakeGuestMemory(size = 0x20000): { mem: GuestMemory; ram: Uint8Array } {
  const ram = new Uint8Array(size);
  const mem: GuestMemory = {
    read: (addr, len) => ram.slice(addr, addr + len),
    write: (addr, bytes) => ram.set(bytes, addr),
  };
  return { mem, ram };
}

function writeU32(ram: Uint8Array, addr: number, v: number): void {
  ram[addr] = (v >>> 24) & 0xff;
  ram[addr + 1] = (v >>> 16) & 0xff;
  ram[addr + 2] = (v >>> 8) & 0xff;
  ram[addr + 3] = v & 0xff;
}

function readI32(ram: Uint8Array, addr: number): number {
  return (ram[addr] << 24) | (ram[addr + 1] << 16) | (ram[addr + 2] << 8) | ram[addr + 3];
}

function writeHeader(
  ram: Uint8Array,
  addr: number,
  fields: { cmd: number; attr?: number; argPtr?: number; filbufPtr?: number; fcbPtr?: number },
): void {
  ram[addr + 2] = fields.cmd;
  if (fields.attr !== undefined) ram[addr + 13] = fields.attr;
  if (fields.argPtr !== undefined) writeU32(ram, addr + 14, fields.argPtr);
  if (fields.filbufPtr !== undefined) writeU32(ram, addr + 18, fields.filbufPtr);
  if (fields.fcbPtr !== undefined) writeU32(ram, addr + 22, fields.fcbPtr);
}

/** _NAMESTSを書く。パスは'\\'区切り(区切りは$09に変換)。 */
function writeNamests(ram: Uint8Array, addr: number, path: string, name: string, ext: string): void {
  const buf = new Uint8Array(NAMESTS_SIZE);
  buf[1] = 2; // C:
  let p = 2;
  for (const ch of path) {
    buf[p++] = ch === '\\' ? 0x09 : ch.charCodeAt(0);
  }
  buf[p] = 0;
  buf.set(Buffer.from(name.padEnd(8, ' '), 'ascii'), 67);
  buf.set(Buffer.from(ext.padEnd(3, ' '), 'ascii'), 75);
  ram.set(buf, addr);
}

async function pollUntilDone(dispatcher: HostFsDispatcher): Promise<void> {
  let stillPending = true;
  for (let i = 0; i < 40 && stillPending; i++) {
    stillPending = dispatcher.poll();
    if (stillPending) await new Promise((r) => setTimeout(r, 5));
  }
  expect(stillPending).toBe(false);
}

const HDR_ADDR = 0x1000;
const NAMESTS_ADDR = 0x2000;
const NAMESTS2_ADDR = 0x2100;
const BUF_ADDR = 0x6000;
const FCB_ADDR = 0x5000;

describe('HostFsDispatcher: W2b書き込み系(読み取り専用モード)', () => {
  it('$42/$43/$44/$45/$46(設定)/$49/$4dはすべて-19を返す', async () => {
    const root = new MockDirHandle('root');
    root.addFile('A.TXT', 'hello');
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, false);
    const { mem, ram } = makeFakeGuestMemory();

    // $42 mkdir
    writeNamests(ram, NAMESTS_ADDR, '', 'SUB', '');
    writeHeader(ram, HDR_ADDR, { cmd: 0x42, argPtr: NAMESTS_ADDR });
    let dispatcher = new HostFsDispatcher(mem, fs);
    expect(dispatcher.request(HDR_ADDR)).toBe(false);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-19);

    // $43 rmdir
    writeHeader(ram, HDR_ADDR, { cmd: 0x43, argPtr: NAMESTS_ADDR });
    expect(dispatcher.request(HDR_ADDR)).toBe(false);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-19);

    // $44 rename
    writeNamests(ram, NAMESTS_ADDR, '', 'A', 'TXT');
    writeNamests(ram, NAMESTS2_ADDR, '', 'B', 'TXT');
    writeHeader(ram, HDR_ADDR, { cmd: 0x44, argPtr: NAMESTS_ADDR, filbufPtr: NAMESTS2_ADDR });
    expect(dispatcher.request(HDR_ADDR)).toBe(false);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-19);

    // $45 delete
    writeHeader(ram, HDR_ADDR, { cmd: 0x45, argPtr: NAMESTS_ADDR });
    expect(dispatcher.request(HDR_ADDR)).toBe(false);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-19);

    // $46 設定(属性$21) -19(読み取り専用は即座に同期で完了)、ただし取得($FF)は許される
    writeHeader(ram, HDR_ADDR, { cmd: 0x46, attr: 0x21, argPtr: NAMESTS_ADDR });
    expect(dispatcher.request(HDR_ADDR)).toBe(false);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-19);

    writeHeader(ram, HDR_ADDR, { cmd: 0x46, attr: 0xff, argPtr: NAMESTS_ADDR });
    dispatcher = new HostFsDispatcher(mem, fs);
    expect(dispatcher.request(HDR_ADDR)).toBe(true);
    await pollUntilDone(dispatcher);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0x20); // 取得は読み取り専用でも成功する

    // $49 create
    writeHeader(ram, HDR_ADDR, { cmd: 0x49, attr: 0x20, argPtr: NAMESTS_ADDR, filbufPtr: 1, fcbPtr: FCB_ADDR });
    expect(dispatcher.request(HDR_ADDR)).toBe(false);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-19);

    // $4d write(開いていないFCBなので-2になる。読み取り専用モードで$49が失敗しFCBが無いため)
    writeHeader(ram, HDR_ADDR, { cmd: 0x4d, argPtr: BUF_ADDR, filbufPtr: 5, fcbPtr: FCB_ADDR });
    expect(dispatcher.request(HDR_ADDR)).toBe(false);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-2);
  });
});

describe('HostFsDispatcher: $49(create) -> $4d(write) -> $4b(close)、閉じるまで反映されない', () => {
  it('flag=1(_CREATE相当)で新規作成し、書いた内容はcloseするまで実体に出ない', async () => {
    const root = new MockDirHandle('root');
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, fs);

    writeNamests(ram, NAMESTS_ADDR, '', 'NEW', 'TXT');
    writeHeader(ram, HDR_ADDR, { cmd: 0x49, attr: 0x20, argPtr: NAMESTS_ADDR, filbufPtr: 1, fcbPtr: FCB_ADDR });
    expect(dispatcher.request(HDR_ADDR)).toBe(true);
    await pollUntilDone(dispatcher);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0);
    expect(root.children.has('NEW.TXT')).toBe(true);

    // $4d write: "hello write\r\n" (13バイト)
    const payload = Buffer.from('hello write\r\n', 'ascii');
    ram.set(payload, BUF_ADDR);
    writeHeader(ram, HDR_ADDR, { cmd: 0x4d, argPtr: BUF_ADDR, filbufPtr: payload.length, fcbPtr: FCB_ADDR });
    expect(dispatcher.request(HDR_ADDR)).toBe(false); // $4dは同期
    expect(readI32(ram, HDR_ADDR + 18)).toBe(payload.length); // 1回目から正しく書けたバイト数が返る

    // close前: 実体(MockFileHandle)はまだ空のまま。
    expect((root.children.get('NEW.TXT') as MockFileHandle).contentBytes.length).toBe(0);

    // $4b close: 非同期(dirtyなのでbeginAsync経由)。
    writeHeader(ram, HDR_ADDR, { cmd: 0x4b, fcbPtr: FCB_ADDR });
    expect(dispatcher.request(HDR_ADDR)).toBe(true);
    await pollUntilDone(dispatcher);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0);

    // close後: 実体に反映されている。
    const content = new TextDecoder().decode((root.children.get('NEW.TXT') as MockFileHandle).contentBytes);
    expect(content).toBe('hello write\r\n');
  });

  it('flag=0(_NEWFILE相当)で既存ファイルへは-80を返す', async () => {
    const root = new MockDirHandle('root');
    root.addFile('HELLO.TXT', 'existing');
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, fs);

    writeNamests(ram, NAMESTS_ADDR, '', 'HELLO', 'TXT');
    writeHeader(ram, HDR_ADDR, { cmd: 0x49, attr: 0x20, argPtr: NAMESTS_ADDR, filbufPtr: 0, fcbPtr: FCB_ADDR });
    expect(dispatcher.request(HDR_ADDR)).toBe(true);
    await pollUntilDone(dispatcher);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-80);
  });

  it('flag=1(_CREATE相当)は既存ファイルを上書きして空にする', async () => {
    const root = new MockDirHandle('root');
    root.addFile('HELLO.TXT', 'existing content');
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, fs);

    writeNamests(ram, NAMESTS_ADDR, '', 'HELLO', 'TXT');
    writeHeader(ram, HDR_ADDR, { cmd: 0x49, attr: 0x20, argPtr: NAMESTS_ADDR, filbufPtr: 1, fcbPtr: FCB_ADDR });
    expect(dispatcher.request(HDR_ADDR)).toBe(true);
    await pollUntilDone(dispatcher);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0);
    expect((root.children.get('HELLO.TXT') as MockFileHandle).contentBytes.length).toBe(0);
  });
});

describe('HostFsDispatcher: $4a(open) -> $4d(write) -> $4b(close)、開いたファイルは読み書き両用', () => {
  it('既存ファイルを開いてから書き込むと、closeで実体に反映される', async () => {
    const root = new MockDirHandle('root');
    root.addFile('A.TXT', '0123456789');
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, fs);

    writeNamests(ram, NAMESTS_ADDR, '', 'A', 'TXT');
    writeHeader(ram, HDR_ADDR, { cmd: 0x4a, argPtr: NAMESTS_ADDR, fcbPtr: FCB_ADDR });
    expect(dispatcher.request(HDR_ADDR)).toBe(true);
    await pollUntilDone(dispatcher);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0);

    // 先頭5バイトを "ABCDE" へ書き換える
    ram.set(Buffer.from('ABCDE', 'ascii'), BUF_ADDR);
    writeHeader(ram, HDR_ADDR, { cmd: 0x4d, argPtr: BUF_ADDR, filbufPtr: 5, fcbPtr: FCB_ADDR });
    expect(dispatcher.request(HDR_ADDR)).toBe(false);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(5);

    writeHeader(ram, HDR_ADDR, { cmd: 0x4b, fcbPtr: FCB_ADDR });
    expect(dispatcher.request(HDR_ADDR)).toBe(true);
    await pollUntilDone(dispatcher);

    const content = new TextDecoder().decode((root.children.get('A.TXT') as MockFileHandle).contentBytes);
    expect(content).toBe('ABCDE56789');
  });

  it('読むだけ(書き込み無し)で閉じた場合はcloseが同期(dirtyでないため)', async () => {
    const root = new MockDirHandle('root');
    root.addFile('A.TXT', 'hello');
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, fs);

    writeNamests(ram, NAMESTS_ADDR, '', 'A', 'TXT');
    writeHeader(ram, HDR_ADDR, { cmd: 0x4a, argPtr: NAMESTS_ADDR, fcbPtr: FCB_ADDR });
    dispatcher.request(HDR_ADDR);
    await pollUntilDone(dispatcher);

    writeHeader(ram, HDR_ADDR, { cmd: 0x4b, fcbPtr: FCB_ADDR });
    expect(dispatcher.request(HDR_ADDR)).toBe(false); // 保留を経由しない
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0);
  });
});

describe('HostFsDispatcher: $42(mkdir)/$43(rmdir)/$45(delete)', () => {
  it('mkdirで作り、rmdirで消せる', async () => {
    const root = new MockDirHandle('root');
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, fs);

    writeNamests(ram, NAMESTS_ADDR, '', 'NEWDIR', '');
    writeHeader(ram, HDR_ADDR, { cmd: 0x42, argPtr: NAMESTS_ADDR });
    dispatcher.request(HDR_ADDR);
    await pollUntilDone(dispatcher);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0);
    expect(root.children.has('NEWDIR')).toBe(true);

    writeHeader(ram, HDR_ADDR, { cmd: 0x43, argPtr: NAMESTS_ADDR });
    dispatcher.request(HDR_ADDR);
    await pollUntilDone(dispatcher);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0);
    expect(root.children.has('NEWDIR')).toBe(false);
  });

  it('deleteで消せ、消した後は-2', async () => {
    const root = new MockDirHandle('root');
    root.addFile('A.TXT', 'x');
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, fs);

    writeNamests(ram, NAMESTS_ADDR, '', 'A', 'TXT');
    writeHeader(ram, HDR_ADDR, { cmd: 0x45, argPtr: NAMESTS_ADDR });
    dispatcher.request(HDR_ADDR);
    await pollUntilDone(dispatcher);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0);
    expect(root.children.has('A.TXT')).toBe(false);

    dispatcher.request(HDR_ADDR);
    await pollUntilDone(dispatcher);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-2);
  });
});

describe('HostFsDispatcher: $44(rename)、中身のあるファイルをrenameしても中身が保たれる', () => {
  it('作成→書き込み→close→renameを一連で行い、renamed後も中身が読める', async () => {
    const root = new MockDirHandle('root');
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, fs);

    // 1. $49 create
    writeNamests(ram, NAMESTS_ADDR, '', 'NEW', 'TXT');
    writeHeader(ram, HDR_ADDR, { cmd: 0x49, attr: 0x20, argPtr: NAMESTS_ADDR, filbufPtr: 1, fcbPtr: FCB_ADDR });
    dispatcher.request(HDR_ADDR);
    await pollUntilDone(dispatcher);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0);

    // 2. $4d write: 中身のあるデータを書く(W2aの実地確認は0バイトファイルだけだったため、
    //    ここでは必ず中身を入れてrenameの結果を確かめる)。
    const payload = Buffer.from('content that must survive rename\r\n', 'ascii');
    ram.set(payload, BUF_ADDR);
    writeHeader(ram, HDR_ADDR, { cmd: 0x4d, argPtr: BUF_ADDR, filbufPtr: payload.length, fcbPtr: FCB_ADDR });
    dispatcher.request(HDR_ADDR);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(payload.length);

    // 3. $4b close: 実体へ反映
    writeHeader(ram, HDR_ADDR, { cmd: 0x4b, fcbPtr: FCB_ADDR });
    dispatcher.request(HDR_ADDR);
    await pollUntilDone(dispatcher);
    expect(
      new TextDecoder().decode((root.children.get('NEW.TXT') as MockFileHandle).contentBytes),
    ).toBe(payload.toString('ascii'));

    // 4. $44 rename: NEW.TXT -> RENAMED.TXT
    writeNamests(ram, NAMESTS_ADDR, '', 'NEW', 'TXT');
    writeNamests(ram, NAMESTS2_ADDR, '', 'RENAMED', 'TXT');
    writeHeader(ram, HDR_ADDR, { cmd: 0x44, argPtr: NAMESTS_ADDR, filbufPtr: NAMESTS2_ADDR });
    dispatcher.request(HDR_ADDR);
    await pollUntilDone(dispatcher);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0);
    expect(root.children.has('NEW.TXT')).toBe(false);
    expect(root.children.has('RENAMED.TXT')).toBe(true);

    // 5. rename後、中身が保たれている(0バイトではなく、書いた内容そのまま)ことを
    //    $4a(開く)->$4c(読む)で確かめる(dispatcher越しの読み取りで裏取り)。
    writeNamests(ram, NAMESTS_ADDR, '', 'RENAMED', 'TXT');
    writeHeader(ram, HDR_ADDR, { cmd: 0x4a, argPtr: NAMESTS_ADDR, fcbPtr: FCB_ADDR });
    dispatcher.request(HDR_ADDR);
    await pollUntilDone(dispatcher);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0);

    writeHeader(ram, HDR_ADDR, { cmd: 0x4c, argPtr: BUF_ADDR, filbufPtr: 1000, fcbPtr: FCB_ADDR });
    dispatcher.request(HDR_ADDR);
    const readLen = readI32(ram, HDR_ADDR + 18);
    expect(readLen).toBe(payload.length);
    expect(Buffer.from(ram.subarray(BUF_ADDR, BUF_ADDR + readLen)).toString('ascii')).toBe(payload.toString('ascii'));
  });

  it('移動先がすでにあれば-22', async () => {
    const root = new MockDirHandle('root');
    root.addFile('A.TXT', 'x');
    root.addFile('B.TXT', 'y');
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, fs);

    writeNamests(ram, NAMESTS_ADDR, '', 'A', 'TXT');
    writeNamests(ram, NAMESTS2_ADDR, '', 'B', 'TXT');
    writeHeader(ram, HDR_ADDR, { cmd: 0x44, argPtr: NAMESTS_ADDR, filbufPtr: NAMESTS2_ADDR });
    dispatcher.request(HDR_ADDR);
    await pollUntilDone(dispatcher);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-22);
  });

  it('ディレクトリのrename: move()が無いモック環境では-19', async () => {
    const root = new MockDirHandle('root');
    root.addDir('SUBDIR');
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, fs);

    writeNamests(ram, NAMESTS_ADDR, '', 'SUBDIR', '');
    writeNamests(ram, NAMESTS2_ADDR, '', 'RENAMED2', '');
    writeHeader(ram, HDR_ADDR, { cmd: 0x44, argPtr: NAMESTS_ADDR, filbufPtr: NAMESTS2_ADDR });
    dispatcher.request(HDR_ADDR);
    await pollUntilDone(dispatcher);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-19);
    expect(root.children.has('SUBDIR')).toBe(true); // 変わっていない
  });
});

describe('HostFsDispatcher: $46(chmod)', () => {
  it('取得($FF)は属性を返し、設定は書き込み可能モードで成功(0)を返す', async () => {
    const root = new MockDirHandle('root');
    root.addFile('A.TXT', 'x');
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, fs);

    writeNamests(ram, NAMESTS_ADDR, '', 'A', 'TXT');
    writeHeader(ram, HDR_ADDR, { cmd: 0x46, attr: 0xff, argPtr: NAMESTS_ADDR });
    dispatcher.request(HDR_ADDR);
    await pollUntilDone(dispatcher);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0x20);

    writeHeader(ram, HDR_ADDR, { cmd: 0x46, attr: 0x21, argPtr: NAMESTS_ADDR });
    dispatcher.request(HDR_ADDR);
    await pollUntilDone(dispatcher);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0);
  });
});
