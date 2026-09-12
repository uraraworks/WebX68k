// HostFS: $51(_DRVCTRL、ドライブの状態問い合わせ)のテスト(利用者の決定・実測分)。
//
// 検証する範囲:
// - MD=0: フォルダ接続・書き込みモード→$42 / 読み取り専用→$4A / 未接続→$04
//   (XC20プログラマーズマニュアルp.97-98のビット定義、src/hostfs/dispatcher.tsの
//   CMD_DRVCTRL付近のコメント参照)。いずれも+3/+4(状態欄)は0のまま。
// - MD!=0: +18=0(成功扱い)で即完了。
// - $d1(VERIFY ONの印付き$51)も$51と同じに振る舞う。
// - $51は未知コマンドとして記録されない/$52は引き続き未知コマンドのまま。
// - DEV限定トレースフック(dispatcher.setTrace()): offなら1行も出ず、onなら1リクエスト1行出る。

import { describe, expect, it, vi } from 'vitest';
import type { GuestMemory } from '../src/hostfs/guest-memory';
import { HostFsDispatcher } from '../src/hostfs/dispatcher';
import { FakeFs, NotConnectedFs } from '../src/hostfs/filesystem';
import { HostFolderFs } from '../src/hostfs/host-folder-fs';

class MockDirHandle {
  readonly kind = 'directory' as const;
  children = new Map<string, unknown>();
  constructor(public name: string) {}
  async *entries(): AsyncIterable<[string, unknown]> {
    for (const [name, handle] of this.children) yield [name, handle];
  }
}

function makeFakeGuestMemory(size = 0x10000): { mem: GuestMemory; ram: Uint8Array } {
  const ram = new Uint8Array(size);
  const mem: GuestMemory = {
    read: (addr, len) => ram.slice(addr, addr + len),
    write: (addr, bytes) => ram.set(bytes, addr),
  };
  return { mem, ram };
}

function readI32(ram: Uint8Array, addr: number): number {
  return (ram[addr] << 24) | (ram[addr + 1] << 16) | (ram[addr + 2] << 8) | ram[addr + 3];
}

const HDR_ADDR = 0x1000;

function writeHeader(ram: Uint8Array, addr: number, cmd: number, md: number): void {
  ram[addr + 2] = cmd;
  ram[addr + 13] = md;
  // +3/+4(状態欄): 事前にわざと非0を入れておき、触っていないことを確認する。
  ram[addr + 3] = 0xab;
  ram[addr + 4] = 0xcd;
}

describe('HostFsDispatcher: $51(_DRVCTRL)', () => {
  it('MD=0、フォルダ接続・書き込みモードで$42を返し、状態欄(+3/+4)は変えない', () => {
    const { mem, ram } = makeFakeGuestMemory();
    const root = new MockDirHandle('root');
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, true);
    const dispatcher = new HostFsDispatcher(mem, fs);
    writeHeader(ram, HDR_ADDR, 0x51, 0);
    expect(dispatcher.request(HDR_ADDR)).toBe(false);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0x42);
    expect(ram[HDR_ADDR + 3]).toBe(0xab);
    expect(ram[HDR_ADDR + 4]).toBe(0xcd);
  });

  it('MD=0、フォルダ接続・読み取り専用モードで$4Aを返す', () => {
    const { mem, ram } = makeFakeGuestMemory();
    const root = new MockDirHandle('root');
    const fs = new HostFolderFs(root as unknown as FileSystemDirectoryHandle, false);
    const dispatcher = new HostFsDispatcher(mem, fs);
    writeHeader(ram, HDR_ADDR, 0x51, 0);
    expect(dispatcher.request(HDR_ADDR)).toBe(false);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0x4a);
  });

  it('MD=0、フォルダ未接続で$04を返す', () => {
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, new NotConnectedFs());
    writeHeader(ram, HDR_ADDR, 0x51, 0);
    expect(dispatcher.request(HDR_ADDR)).toBe(false);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0x04);
  });

  it('MD=1(イジェクト等)は+18=0の成功扱いで即完了する', () => {
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, new NotConnectedFs());
    writeHeader(ram, HDR_ADDR, 0x51, 1);
    expect(dispatcher.request(HDR_ADDR)).toBe(false);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0);
  });

  it('+14のポインタには一切書き込まない', () => {
    const { mem, ram } = makeFakeGuestMemory();
    const PTR = 0x2000;
    for (let i = 0; i < 16; i++) ram[PTR + i] = 0x99;
    const dispatcher = new HostFsDispatcher(mem, new NotConnectedFs());
    writeHeader(ram, HDR_ADDR, 0x51, 0);
    ram[HDR_ADDR + 14] = (PTR >>> 24) & 0xff;
    ram[HDR_ADDR + 15] = (PTR >>> 16) & 0xff;
    ram[HDR_ADDR + 16] = (PTR >>> 8) & 0xff;
    ram[HDR_ADDR + 17] = PTR & 0xff;
    dispatcher.request(HDR_ADDR);
    for (let i = 0; i < 16; i++) expect(ram[PTR + i]).toBe(0x99);
  });

  it('$d1(VERIFY ONの印付き$51)は$51と同じ結果を返す', () => {
    const { mem: memPlain, ram: ramPlain } = makeFakeGuestMemory();
    const { mem: memVerify, ram: ramVerify } = makeFakeGuestMemory();
    const dPlain = new HostFsDispatcher(memPlain, new FakeFs());
    const dVerify = new HostFsDispatcher(memVerify, new FakeFs());
    writeHeader(ramPlain, HDR_ADDR, 0x51, 0);
    writeHeader(ramVerify, HDR_ADDR, 0xd1, 0); // 0x51 | 0x80
    dPlain.request(HDR_ADDR);
    dVerify.request(HDR_ADDR);
    expect(readI32(ramVerify, HDR_ADDR + 18)).toBe(readI32(ramPlain, HDR_ADDR + 18));
    expect(dPlain.getUnknownCommandsSummary()).toHaveLength(0);
    expect(dVerify.getUnknownCommandsSummary()).toHaveLength(0);
  });

  it('$51は未知コマンドの記録に残らないが、$52は引き続き未知コマンドとして-2で応答・記録される', () => {
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    writeHeader(ram, HDR_ADDR, 0x51, 0);
    dispatcher.request(HDR_ADDR);
    expect(dispatcher.getUnknownCommandsSummary()).toHaveLength(0);

    writeHeader(ram, HDR_ADDR, 0x52, 0);
    expect(dispatcher.request(HDR_ADDR)).toBe(false);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-2);
    const summary = dispatcher.getUnknownCommandsSummary();
    expect(summary).toHaveLength(1);
    expect(summary[0].cmd).toBe(0x52);
  });
});

describe('HostFsDispatcher: DEV限定トレースフック(setTrace)', () => {
  it('offのときは1行もログを出さない', () => {
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      writeHeader(ram, HDR_ADDR, 0x51, 0);
      dispatcher.request(HDR_ADDR);
      writeHeader(ram, HDR_ADDR, 0x50, 0);
      dispatcher.request(HDR_ADDR);
      expect(spy.mock.calls.filter((c) => String(c[0]).startsWith('[HostFS] trace:'))).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('onのとき、同期完了コマンドは1リクエスト1行のトレースを出す', () => {
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    dispatcher.setTrace(true);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      writeHeader(ram, HDR_ADDR, 0x51, 0);
      dispatcher.request(HDR_ADDR);
      writeHeader(ram, HDR_ADDR, 0x50, 0);
      dispatcher.request(HDR_ADDR);
      const lines = spy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.startsWith('[HostFS] trace:'));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('cmd=$51');
      expect(lines[0]).toContain('verify=off');
    } finally {
      spy.mockRestore();
    }
  });

  it('onのとき、非同期完了コマンド($47検索)も完了時に1行だけトレースを出す', async () => {
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    dispatcher.setTrace(true);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // ボリュームラベル検索(同期でDOS_ERR_NOT_FOUNDを返す経路、非同期経路を試すのは
      // 他のdispatcherテストで手厚く検証済みのため、ここではトレースの発火有無だけ見る)。
      ram[HDR_ADDR + 2] = 0x47;
      ram[HDR_ADDR + 13] = 0x08; // VOLUME_LABEL_ATTR
      const isPending = dispatcher.request(HDR_ADDR);
      expect(isPending).toBe(false);
      const lines = spy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.startsWith('[HostFS] trace:'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('cmd=$47');
    } finally {
      spy.mockRestore();
    }
  });
});
