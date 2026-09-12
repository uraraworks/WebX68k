import { describe, expect, it } from 'vitest';
import type { GuestMemory } from '../src/hostfs/guest-memory';
import { decodeNamests, NAMESTS_SIZE } from '../src/hostfs/namests';
import { encodeFilbuf, FILBUF_SIZE } from '../src/hostfs/filbuf';
import { HostFsDispatcher } from '../src/hostfs/dispatcher';
import { FakeFs } from '../src/hostfs/filesystem';
import type { HostFileSystem, HostFsFileEntry } from '../src/hostfs/filesystem';

/**
 * ゲストRAMのフェイク(1MB分のUint8Array)。src/hostfs/*はGuestMemoryインターフェイス
 * だけに依存しているので、実wasmコアなしで検証できる。
 */
function makeFakeGuestMemory(size = 0x10000): { mem: GuestMemory; ram: Uint8Array } {
  const ram = new Uint8Array(size);
  const mem: GuestMemory = {
    read: (addr, len) => ram.slice(addr, addr + len),
    write: (addr, bytes) => ram.set(bytes, addr),
  };
  return { mem, ram };
}

describe('decodeNamests', () => {
  it('パス・名前・拡張子を実測の形どおりにデコードする', () => {
    const buf = new Uint8Array(NAMESTS_SIZE);
    buf[0] = 0; // '?'の数
    buf[1] = 2; // ドライブ番号(2 = C:)
    // パス: "\" 区切り(=$09) で "SUB\DIR"
    const pathBytes = [0x09, 0x53, 0x55, 0x42, 0x09, 0x44, 0x49, 0x52, 0x00]; // \SUB\DIR\0
    buf.set(pathBytes, 2);
    // 名前 "HELLO   " (8バイト、空白埋め)
    buf.set(Buffer.from('HELLO   ', 'ascii'), 67);
    // 拡張子 "TXT"
    buf.set(Buffer.from('TXT', 'ascii'), 75);

    const ns = decodeNamests(buf);
    expect(ns.drive).toBe(2);
    expect(ns.questionMarks).toBe(0);
    expect(ns.path).toBe('\\SUB\\DIR');
    expect(ns.name).toBe('HELLO');
    expect(ns.ext).toBe('TXT');
  });

  it('長さ不足なら例外を投げる', () => {
    expect(() => decodeNamests(new Uint8Array(10))).toThrow();
  });
});

describe('encodeFilbuf', () => {
  it('名前・拡張子・属性・日付・時刻・サイズを実測の形どおりにエンコードする', () => {
    const buf = encodeFilbuf({
      name: 'HELLO',
      ext: 'TXT',
      attr: 0x20,
      date: { year: 2026, month: 9, day: 11 },
      time: { hour: 12, minute: 34, second: 56 },
      size: 1234,
    });
    expect(buf.length).toBe(FILBUF_SIZE);
    // +10 名前(8バイト、空白埋め)
    expect(Buffer.from(buf.subarray(10, 18)).toString('ascii')).toBe('HELLO   ');
    // +18 拡張子(3バイト)
    expect(Buffer.from(buf.subarray(18, 21)).toString('ascii')).toBe('TXT');
    // +21 属性
    expect(buf[21]).toBe(0x20);
    // +22 時刻 W: 12<<11 | 34<<5 | 56/2(=28) = 0x6000 + 0x0440 + 0x001c
    const time = (buf[22] << 8) | buf[23];
    expect(time).toBe((12 << 11) | (34 << 5) | (56 >> 1));
    // +24 日付 W: (2026-1980)<<9 | 9<<5 | 11
    const date = (buf[24] << 8) | buf[25];
    expect(date).toBe(((2026 - 1980) << 9) | (9 << 5) | 11);
    // +26 サイズ L
    const size = (buf[26] << 24) | (buf[27] << 16) | (buf[28] << 8) | buf[29];
    expect(size >>> 0).toBe(1234);
    // +30 "HELLO.TXT\0"
    const fullName = Buffer.from(buf.subarray(30, 30 + 10)).toString('ascii');
    expect(fullName.startsWith('HELLO.TXT\0')).toBe(true);
  });
});

/** テスト用の要求ヘッダ組み立て。実機のリクエストヘッダ形式(+2=コマンド、
 * +13=検索属性、+14=引数ポインタ、+18=FILBUFポインタ兼戻り値)に合わせる。 */
function writeRequestHeader(
  ram: Uint8Array,
  addr: number,
  fields: { cmd: number; attr?: number; argPtr?: number; filbufPtr?: number },
): void {
  ram[addr + 2] = fields.cmd;
  if (fields.attr !== undefined) ram[addr + 13] = fields.attr;
  const writeU32 = (off: number, v: number) => {
    ram[addr + off] = (v >>> 24) & 0xff;
    ram[addr + off + 1] = (v >>> 16) & 0xff;
    ram[addr + off + 2] = (v >>> 8) & 0xff;
    ram[addr + off + 3] = v & 0xff;
  };
  if (fields.argPtr !== undefined) writeU32(14, fields.argPtr);
  if (fields.filbufPtr !== undefined) writeU32(18, fields.filbufPtr);
}

function readI32(ram: Uint8Array, addr: number): number {
  return (ram[addr] << 24) | (ram[addr + 1] << 16) | (ram[addr + 2] << 8) | ram[addr + 3];
}

function readU16(ram: Uint8Array, addr: number): number {
  return (ram[addr] << 8) | ram[addr + 1];
}

describe('HostFsDispatcher: $47 -> $48 -> 終わり の一連の流れ', () => {
  const HDR_ADDR = 0x1000;
  const NAMESTS_ADDR = 0x2000;
  const FILBUF_ADDR = 0x3000;

  function makeNamests(ram: Uint8Array, addr: number): void {
    const buf = new Uint8Array(NAMESTS_SIZE);
    buf[1] = 2; // C:
    buf[2] = 0; // ルート(パス無し、NUL即終端)
    // "*.*" 相当: 名前8+拡張子3をすべて'?'(ワイルドカード)で埋める。
    buf.fill(0x3f, 67, 67 + 8); // 名前
    buf.fill(0x3f, 75, 75 + 3); // 拡張子
    ram.set(buf, addr);
  }

  it('$47(検索・初回)は非同期(保留)を返し、pollで完了しFILBUFへHELLO.TXTが書かれる', async () => {
    const { mem, ram } = makeFakeGuestMemory();
    makeNamests(ram, NAMESTS_ADDR);
    writeRequestHeader(ram, HDR_ADDR, { cmd: 0x47, attr: 0x20, argPtr: NAMESTS_ADDR, filbufPtr: FILBUF_ADDR });

    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    const pending = dispatcher.request(HDR_ADDR);
    expect(pending).toBe(true); // 非同期経路を必ず通す

    // 完了するまでpollし続ける(FakeFsはsetTimeout(0)でマクロタスク境界をまたぐ)。
    let stillPending = true;
    for (let i = 0; i < 20 && stillPending; i++) {
      stillPending = dispatcher.poll();
      if (stillPending) await new Promise((r) => setTimeout(r, 5));
    }
    expect(stillPending).toBe(false);

    // 戻り値(+18)は成功=0
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0);
    // FILBUF+10(名前)以降にHELLO.TXTが書かれている
    const name = Buffer.from(ram.subarray(FILBUF_ADDR + 10, FILBUF_ADDR + 18)).toString('ascii');
    expect(name).toBe('HELLO   ');
    const ext = Buffer.from(ram.subarray(FILBUF_ADDR + 18, FILBUF_ADDR + 21)).toString('ascii');
    expect(ext).toBe('TXT');

    const stats = dispatcher.getStats();
    expect(stats.pendingReturnedCount).toBeGreaterThanOrEqual(1);
    expect(stats.pollCompletedCount).toBeGreaterThanOrEqual(1);

    // --- $48(次を検索): 同期でWORLD.DOCが返る ---
    writeRequestHeader(ram, HDR_ADDR, { cmd: 0x48, filbufPtr: FILBUF_ADDR });
    const pending2 = dispatcher.request(HDR_ADDR);
    expect(pending2).toBe(false); // $48は同期
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0);
    const name2 = Buffer.from(ram.subarray(FILBUF_ADDR + 10, FILBUF_ADDR + 18)).toString('ascii');
    expect(name2).toBe('WORLD   ');

    // --- もう一度$48: 「もう無い」(-18) ---
    writeRequestHeader(ram, HDR_ADDR, { cmd: 0x48, filbufPtr: FILBUF_ADDR });
    const pending3 = dispatcher.request(HDR_ADDR);
    expect(pending3).toBe(false);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-18);
  });

  it('$47のボリュームラベル検索(属性$08ちょうど)は同期で-2を返す', () => {
    const { mem, ram } = makeFakeGuestMemory();
    makeNamests(ram, NAMESTS_ADDR);
    writeRequestHeader(ram, HDR_ADDR, { cmd: 0x47, attr: 0x08, argPtr: NAMESTS_ADDR, filbufPtr: FILBUF_ADDR });

    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    const pending = dispatcher.request(HDR_ADDR);
    expect(pending).toBe(false);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-2);
  });

  it('$50(空き容量)は同期で完了し、+18に使用可能バイト数(使用可能クラスタ×セクタ×バイト)を返す', () => {
    const { mem, ram } = makeFakeGuestMemory();
    const outPtr = 0x4000;
    writeRequestHeader(ram, HDR_ADDR, { cmd: 0x50, argPtr: outPtr });
    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    const pending = dispatcher.request(HDR_ADDR);
    expect(pending).toBe(false);

    // 8バイト構造: 使用可能クラスタ/総クラスタ/クラスタあたりセクタ/セクタあたりバイト。
    const availableClusters = readU16(ram, outPtr + 0);
    const totalClusters = readU16(ram, outPtr + 2);
    const sectorsPerCluster = readU16(ram, outPtr + 4);
    const bytesPerSector = readU16(ram, outPtr + 6);
    expect(availableClusters).toBeGreaterThan(0);
    expect(totalClusters).toBeGreaterThanOrEqual(availableClusters);
    expect(sectorsPerCluster).toBeGreaterThan(0);
    expect(bytesPerSector).toBeGreaterThan(0);

    // +18(戻り値欄)は、master tools/x68/remote-probe.sのC8-b実験で確定したとおり
    // 「使用可能バイト数」(_DSKFREのD0相当)を書く。dir集計行の「使用可能」欄はここから
    // 来る(8バイト構造の使用可能クラスタ欄そのものではない)。
    const availableBytes = readI32(ram, HDR_ADDR + 18);
    expect(availableBytes).toBe(availableClusters * sectorsPerCluster * bytesPerSector);
  });

  it('$56/$57は同期で+18=0を返す', () => {
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    for (const cmd of [0x56, 0x57]) {
      writeRequestHeader(ram, HDR_ADDR, { cmd });
      const pending = dispatcher.request(HDR_ADDR);
      expect(pending).toBe(false);
      expect(readI32(ram, HDR_ADDR + 18)).toBe(0);
    }
  });

  it('未知のコマンドは同期で+18=-2を返す', () => {
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    writeRequestHeader(ram, HDR_ADDR, { cmd: 0x99 });
    const pending = dispatcher.request(HDR_ADDR);
    expect(pending).toBe(false);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-2);
  });

  it('検索はワイルドカードで絞り込み、一致した1件だけを返す(HELLO.TXTのみ)', async () => {
    const { mem, ram } = makeFakeGuestMemory();
    // _NAMESTS: 名前="HELLO   ", 拡張子="TXT" (ワイルドカード無し、厳密一致)
    const namests = new Uint8Array(NAMESTS_SIZE);
    namests[1] = 2;
    namests.set(Buffer.from('HELLO   ', 'ascii'), 67);
    namests.set(Buffer.from('TXT', 'ascii'), 75);
    ram.set(namests, NAMESTS_ADDR);
    writeRequestHeader(ram, HDR_ADDR, { cmd: 0x47, attr: 0x20, argPtr: NAMESTS_ADDR, filbufPtr: FILBUF_ADDR });

    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    dispatcher.request(HDR_ADDR);
    let stillPending = true;
    for (let i = 0; i < 20 && stillPending; i++) {
      stillPending = dispatcher.poll();
      if (stillPending) await new Promise((r) => setTimeout(r, 5));
    }
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0);
    const name = Buffer.from(ram.subarray(FILBUF_ADDR + 10, FILBUF_ADDR + 18)).toString('ascii');
    expect(name).toBe('HELLO   ');

    // 次を検索: HELLO.TXTしか一致していないので、もう無い(-18)のはず(WORLD.DOCは出ない)。
    writeRequestHeader(ram, HDR_ADDR, { cmd: 0x48, filbufPtr: FILBUF_ADDR });
    dispatcher.request(HDR_ADDR);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-18);
  });
});

describe('HostFsDispatcher: $4a(開く) -> $4c(読む) -> $4b(閉じる)', () => {
  const HDR_ADDR = 0x1000;
  const NAMESTS_ADDR = 0x2000;
  const FCB_ADDR = 0x5000;
  const BUF_ADDR = 0x6000;

  function makeOpenNamests(ram: Uint8Array, addr: number, name: string, ext: string): void {
    const buf = new Uint8Array(NAMESTS_SIZE);
    buf[1] = 2;
    buf.set(Buffer.from(name.padEnd(8, ' '), 'ascii'), 67);
    buf.set(Buffer.from(ext.padEnd(3, ' '), 'ascii'), 75);
    ram.set(buf, addr);
  }

  it('$4aは非同期(保留)を返し、pollで完了する。以後$4cで中身が読め、$4bで閉じられる', async () => {
    const { mem, ram } = makeFakeGuestMemory(0x20000);
    makeOpenNamests(ram, NAMESTS_ADDR, 'HELLO', 'TXT');
    writeRequestHeader(ram, HDR_ADDR, { cmd: 0x4a, argPtr: NAMESTS_ADDR });
    ram[HDR_ADDR + 22] = (FCB_ADDR >>> 24) & 0xff;
    ram[HDR_ADDR + 23] = (FCB_ADDR >>> 16) & 0xff;
    ram[HDR_ADDR + 24] = (FCB_ADDR >>> 8) & 0xff;
    ram[HDR_ADDR + 25] = FCB_ADDR & 0xff;

    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    const pending = dispatcher.request(HDR_ADDR);
    expect(pending).toBe(true); // 非同期経路を必ず通す

    let stillPending = true;
    for (let i = 0; i < 20 && stillPending; i++) {
      stillPending = dispatcher.poll();
      if (stillPending) await new Promise((r) => setTimeout(r, 5));
    }
    expect(stillPending).toBe(false);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0);

    // --- $4c: 読む(100バイト要求) ---
    writeRequestHeader(ram, HDR_ADDR, { cmd: 0x4c, argPtr: BUF_ADDR, filbufPtr: 100 });
    ram[HDR_ADDR + 22] = (FCB_ADDR >>> 24) & 0xff;
    ram[HDR_ADDR + 23] = (FCB_ADDR >>> 16) & 0xff;
    ram[HDR_ADDR + 24] = (FCB_ADDR >>> 8) & 0xff;
    ram[HDR_ADDR + 25] = FCB_ADDR & 0xff;
    const pendingRead = dispatcher.request(HDR_ADDR);
    expect(pendingRead).toBe(false); // $4cは同期
    const readLen = readI32(ram, HDR_ADDR + 18);
    expect(readLen).toBe(100);
    // 読めた内容にファイル名が含まれる(FakeFs.readFileの生成内容)
    const text = Buffer.from(ram.subarray(BUF_ADDR, BUF_ADDR + readLen)).toString('ascii');
    expect(text).toContain('HELLO.TXT');

    // --- $4b: 閉じる ---
    writeRequestHeader(ram, HDR_ADDR, { cmd: 0x4b });
    ram[HDR_ADDR + 22] = (FCB_ADDR >>> 24) & 0xff;
    ram[HDR_ADDR + 23] = (FCB_ADDR >>> 16) & 0xff;
    ram[HDR_ADDR + 24] = (FCB_ADDR >>> 8) & 0xff;
    ram[HDR_ADDR + 25] = FCB_ADDR & 0xff;
    const pendingClose = dispatcher.request(HDR_ADDR);
    expect(pendingClose).toBe(false);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0);
  });

  it('存在しないファイルを$4aで開くと、非同期完了後に+18=-2になる', async () => {
    const { mem, ram } = makeFakeGuestMemory();
    makeOpenNamests(ram, NAMESTS_ADDR, 'NOTHERE', 'ZZZ');
    writeRequestHeader(ram, HDR_ADDR, { cmd: 0x4a, argPtr: NAMESTS_ADDR });
    ram[HDR_ADDR + 22] = (FCB_ADDR >>> 24) & 0xff;
    ram[HDR_ADDR + 23] = (FCB_ADDR >>> 16) & 0xff;
    ram[HDR_ADDR + 24] = (FCB_ADDR >>> 8) & 0xff;
    ram[HDR_ADDR + 25] = FCB_ADDR & 0xff;

    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    const pending = dispatcher.request(HDR_ADDR);
    expect(pending).toBe(true);
    let stillPending = true;
    for (let i = 0; i < 20 && stillPending; i++) {
      stillPending = dispatcher.poll();
      if (stillPending) await new Promise((r) => setTimeout(r, 5));
    }
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-2);
  });
});

/** 属性の絞り込み検証用: 通常ファイル($20)とディレクトリ($10)を1件ずつ持つfs。 */
class MixedAttrFs implements HostFileSystem {
  private readonly entries: HostFsFileEntry[] = [
    {
      name: 'NORMAL',
      ext: 'TXT',
      size: 10,
      date: { year: 2026, month: 1, day: 1 },
      time: { hour: 0, minute: 0, second: 0 },
      attr: 0x20, // 通常のファイル(アーカイブ)
    },
    {
      name: 'SUBDIR',
      ext: '',
      size: 0,
      date: { year: 2026, month: 1, day: 1 },
      time: { hour: 0, minute: 0, second: 0 },
      attr: 0x10, // ディレクトリ
    },
  ];

  listDir(_path: string): Promise<HostFsFileEntry[]> {
    return Promise.resolve(this.entries.slice());
  }

  readFile(_path: string, _name: string, _ext: string): Promise<Uint8Array | null> {
    return Promise.resolve(null);
  }

  dirExists(path: string): Promise<boolean> {
    return Promise.resolve(path === '' || path === '\\');
  }
}

describe('HostFsDispatcher: $47の属性絞り込み((エントリの属性 & 検索属性) != 0)', () => {
  const HDR_ADDR = 0x1000;
  const NAMESTS_ADDR = 0x2000;
  const FILBUF_ADDR = 0x3000;

  function makeWildcardNamests(ram: Uint8Array, addr: number): void {
    const buf = new Uint8Array(NAMESTS_SIZE);
    buf[1] = 2; // C:
    buf.fill(0x3f, 67, 67 + 8); // 名前 '*' 相当(すべて'?')
    buf.fill(0x3f, 75, 75 + 3); // 拡張子 '*' 相当
    ram.set(buf, addr);
  }

  async function search(attr: number): Promise<{ ram: Uint8Array; retval: number; nameAt: (off: number) => string }> {
    const { mem, ram } = makeFakeGuestMemory();
    makeWildcardNamests(ram, NAMESTS_ADDR);
    writeRequestHeader(ram, HDR_ADDR, { cmd: 0x47, attr, argPtr: NAMESTS_ADDR, filbufPtr: FILBUF_ADDR });

    const dispatcher = new HostFsDispatcher(mem, new MixedAttrFs());
    dispatcher.request(HDR_ADDR);
    let stillPending = true;
    for (let i = 0; i < 20 && stillPending; i++) {
      stillPending = dispatcher.poll();
      if (stillPending) await new Promise((r) => setTimeout(r, 5));
    }
    return {
      ram,
      retval: readI32(ram, HDR_ADDR + 18),
      nameAt: (off) => Buffer.from(ram.subarray(FILBUF_ADDR + off, FILBUF_ADDR + off + 8)).toString('ascii'),
    };
  }

  it('検索属性$10(ディレクトリのみ)は通常ファイル($20)に一致せず、SUBDIRだけ見つかる', async () => {
    const { retval, nameAt } = await search(0x10);
    expect(retval).toBe(0);
    expect(nameAt(10)).toBe('SUBDIR  ');
  });

  it('検索属性$35(0x20|0x10|0x04|0x01)はどちらのビットにも当てはまるので両方見つかる', async () => {
    const { mem, ram } = makeFakeGuestMemory();
    makeWildcardNamests(ram, NAMESTS_ADDR);
    writeRequestHeader(ram, HDR_ADDR, { cmd: 0x47, attr: 0x35, argPtr: NAMESTS_ADDR, filbufPtr: FILBUF_ADDR });
    const dispatcher = new HostFsDispatcher(mem, new MixedAttrFs());
    dispatcher.request(HDR_ADDR);
    let stillPending = true;
    for (let i = 0; i < 20 && stillPending; i++) {
      stillPending = dispatcher.poll();
      if (stillPending) await new Promise((r) => setTimeout(r, 5));
    }
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0);
    const first = Buffer.from(ram.subarray(FILBUF_ADDR + 10, FILBUF_ADDR + 18)).toString('ascii');
    expect(first).toBe('NORMAL  ');

    // $48で次へ: SUBDIRも見つかる(両方一致しているはず)
    writeRequestHeader(ram, HDR_ADDR, { cmd: 0x48, filbufPtr: FILBUF_ADDR });
    dispatcher.request(HDR_ADDR);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0);
    const second = Buffer.from(ram.subarray(FILBUF_ADDR + 10, FILBUF_ADDR + 18)).toString('ascii');
    expect(second).toBe('SUBDIR  ');
  });

  it('検索属性$20(通常ファイルのみ)は通常ファイルにだけ一致し、SUBDIRは出ない', async () => {
    const { retval, nameAt } = await search(0x20);
    expect(retval).toBe(0);
    expect(nameAt(10)).toBe('NORMAL  ');
  });

  it('名前のワイルドカード("NO??????"相当)と属性を同時に絞り込める', async () => {
    const { mem, ram } = makeFakeGuestMemory();
    const buf = new Uint8Array(NAMESTS_SIZE);
    buf[1] = 2;
    // "NO??????" + "???" : 先頭2文字だけ固定、残りはワイルドカード
    buf.set(Buffer.from('NO', 'ascii'), 67);
    buf.fill(0x3f, 69, 67 + 8);
    buf.fill(0x3f, 75, 75 + 3);
    ram.set(buf, NAMESTS_ADDR);
    writeRequestHeader(ram, HDR_ADDR, { cmd: 0x47, attr: 0x3f, argPtr: NAMESTS_ADDR, filbufPtr: FILBUF_ADDR });

    const dispatcher = new HostFsDispatcher(mem, new MixedAttrFs());
    dispatcher.request(HDR_ADDR);
    let stillPending = true;
    for (let i = 0; i < 20 && stillPending; i++) {
      stillPending = dispatcher.poll();
      if (stillPending) await new Promise((r) => setTimeout(r, 5));
    }
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0);
    const name = Buffer.from(ram.subarray(FILBUF_ADDR + 10, FILBUF_ADDR + 18)).toString('ascii');
    expect(name).toBe('NORMAL  '); // "SUBDIR"は"NO"始まりでないので一致しない

    writeRequestHeader(ram, HDR_ADDR, { cmd: 0x48, filbufPtr: FILBUF_ADDR });
    dispatcher.request(HDR_ADDR);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-18); // もう無い
  });
});

describe('HostFsDispatcher: $4e(シーク)', () => {
  const HDR_ADDR = 0x1000;
  const NAMESTS_ADDR = 0x2000;
  const FCB_ADDR = 0x5000;

  function writeFcbPtr(ram: Uint8Array, addr: number, fcbPtr: number): void {
    ram[addr + 22] = (fcbPtr >>> 24) & 0xff;
    ram[addr + 23] = (fcbPtr >>> 16) & 0xff;
    ram[addr + 24] = (fcbPtr >>> 8) & 0xff;
    ram[addr + 25] = fcbPtr & 0xff;
  }

  function writeSeekRequest(ram: Uint8Array, addr: number, origin: number, delta: number, fcbPtr: number): void {
    writeRequestHeader(ram, addr, { cmd: 0x4e, attr: origin, filbufPtr: delta >>> 0 });
    writeFcbPtr(ram, addr, fcbPtr);
  }

  async function openHello(): Promise<{ mem: GuestMemory; ram: Uint8Array; dispatcher: HostFsDispatcher }> {
    const { mem, ram } = makeFakeGuestMemory(0x20000);
    const buf = new Uint8Array(NAMESTS_SIZE);
    buf[1] = 2;
    buf.set(Buffer.from('HELLO   ', 'ascii'), 67);
    buf.set(Buffer.from('TXT', 'ascii'), 75);
    ram.set(buf, NAMESTS_ADDR);
    writeRequestHeader(ram, HDR_ADDR, { cmd: 0x4a, argPtr: NAMESTS_ADDR });
    writeFcbPtr(ram, HDR_ADDR, FCB_ADDR);

    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    dispatcher.request(HDR_ADDR);
    let stillPending = true;
    for (let i = 0; i < 20 && stillPending; i++) {
      stillPending = dispatcher.poll();
      if (stillPending) await new Promise((r) => setTimeout(r, 5));
    }
    return { mem, ram, dispatcher };
  }

  it('起点0(先頭)+移動量100で、+18に100が返る', async () => {
    const { ram, dispatcher } = await openHello();
    writeSeekRequest(ram, HDR_ADDR, 0, 100, FCB_ADDR);
    const pending = dispatcher.request(HDR_ADDR);
    expect(pending).toBe(false); // 同期
    expect(readI32(ram, HDR_ADDR + 18)).toBe(100);
  });

  it('起点2(末尾)+移動量0で、+18にファイルサイズ(1234)が返る', async () => {
    const { ram, dispatcher } = await openHello();
    writeSeekRequest(ram, HDR_ADDR, 2, 0, FCB_ADDR);
    dispatcher.request(HDR_ADDR);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(1234); // FakeFsのHELLO.TXTはsize=1234
  });

  it('起点1(現在位置)からの相対移動が積み上がる', async () => {
    const { ram, dispatcher } = await openHello();
    writeSeekRequest(ram, HDR_ADDR, 0, 100, FCB_ADDR);
    dispatcher.request(HDR_ADDR);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(100);

    writeSeekRequest(ram, HDR_ADDR, 1, 50, FCB_ADDR);
    dispatcher.request(HDR_ADDR);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(150);
  });

  it('範囲外(ファイルサイズを超える)は-25を返し、位置は変わらない', async () => {
    const { ram, dispatcher } = await openHello();
    writeSeekRequest(ram, HDR_ADDR, 0, 100, FCB_ADDR);
    dispatcher.request(HDR_ADDR);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(100);

    // ファイルサイズ1234を超える移動: 末尾から+1
    writeSeekRequest(ram, HDR_ADDR, 2, 1, FCB_ADDR);
    dispatcher.request(HDR_ADDR);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-25);

    // 位置が変わっていないことを、現在位置からの相対移動で確認(100のまま)
    writeSeekRequest(ram, HDR_ADDR, 1, 0, FCB_ADDR);
    dispatcher.request(HDR_ADDR);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(100);
  });

  it('範囲外(負の位置)は-25を返す', async () => {
    const { ram, dispatcher } = await openHello();
    writeSeekRequest(ram, HDR_ADDR, 0, -1, FCB_ADDR);
    dispatcher.request(HDR_ADDR);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-25);
  });

  it('開いていないFCBへのシークは-25を返す', () => {
    const { mem, ram } = makeFakeGuestMemory();
    writeSeekRequest(ram, HDR_ADDR, 0, 0, 0x9999);
    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    dispatcher.request(HDR_ADDR);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-25);
  });
});

describe('HostFsDispatcher: $41(cd)', () => {
  const HDR_ADDR = 0x1000;
  const PATH_ADDR = 0x2000;

  /**
   * namests.tsのdecodeCdPathと同じ規約で書く: 先頭2バイト('?'の数+ドライブ番号、
   * ここでは値は使わないのでどちらも0)+ 区切り$09・NUL終端のパス本体
   * (実機実測: "cd c:\sub" は 00 02 09 73 75 62 09 00)。
   */
  function writeCdPath(ram: Uint8Array, addr: number, segments: string[]): void {
    ram[addr] = 0; // '?'の数(未使用)
    ram[addr + 1] = 0; // ドライブ番号(未使用)
    let p = addr + 2;
    for (const seg of segments) {
      ram[p++] = 0x09;
      for (let i = 0; i < seg.length; i++) ram[p++] = seg.charCodeAt(i);
    }
    ram[p] = 0; // NUL終端
  }

  async function pollUntilDone(dispatcher: HostFsDispatcher): Promise<void> {
    let stillPending = true;
    for (let i = 0; i < 20 && stillPending; i++) {
      stillPending = dispatcher.poll();
      if (stillPending) await new Promise((r) => setTimeout(r, 5));
    }
    expect(stillPending).toBe(false);
  }

  it('ルート(\\)へのcdは実在するので+18=0', async () => {
    const { mem, ram } = makeFakeGuestMemory();
    writeCdPath(ram, PATH_ADDR, []); // "\x00" だけ(ルート)
    writeRequestHeader(ram, HDR_ADDR, { cmd: 0x41, argPtr: PATH_ADDR });
    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    const pending = dispatcher.request(HDR_ADDR);
    expect(pending).toBe(true); // 非同期経路を必ず通す
    await pollUntilDone(dispatcher);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(0);
  });

  it('存在しないパスへのcdは-3(ディレクトリが見つかりません)', async () => {
    const { mem, ram } = makeFakeGuestMemory();
    writeCdPath(ram, PATH_ADDR, ['SUB']); // FakeFsはフラットなのでSUBは無い
    writeRequestHeader(ram, HDR_ADDR, { cmd: 0x41, argPtr: PATH_ADDR });
    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    dispatcher.request(HDR_ADDR);
    await pollUntilDone(dispatcher);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-3);
  });
});

describe('HostFsDispatcher: $40(初期化)は通知だけで、ヘッダに触れない', () => {
  const HDR_ADDR = 0x1000;

  /** ヘッダを既知の値(全バイト0xAAで埋める)で用意し、$40後に変化していないことを見る。 */
  function makeInitHeader(ram: Uint8Array, addr: number, driveNumber: number): void {
    ram.fill(0xaa, addr, addr + 26);
    ram[addr + 2] = 0x40; // コマンドコード
    ram[addr + 22] = driveNumber; // 割り当てられたドライブ番号(0=A:)
  }

  it('$40はヘッダ(+3/+4/+13/+14/+18)を一切書き換えず、すぐ完了(保留にしない)で返る', () => {
    const { mem, ram } = makeFakeGuestMemory();
    makeInitHeader(ram, HDR_ADDR, 2); // C:

    const before = ram.slice(HDR_ADDR, HDR_ADDR + 26);
    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    const pending = dispatcher.request(HDR_ADDR);

    expect(pending).toBe(false);
    const after = ram.slice(HDR_ADDR, HDR_ADDR + 26);
    expect(after).toEqual(before); // ヘッダはドライバ自身が書くので、ここでは1バイトも変えない
  });

  it('$40を受けるとドライバ検出フラグと、+22のドライブ番号が記録される', () => {
    const { mem, ram } = makeFakeGuestMemory();
    makeInitHeader(ram, HDR_ADDR, 2); // C: (0=A:, 1=B:, 2=C:)

    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    expect(dispatcher.getDriverStatus()).toEqual({ detected: false, driveNumber: null });

    dispatcher.request(HDR_ADDR);
    expect(dispatcher.getDriverStatus()).toEqual({ detected: true, driveNumber: 2 });
  });

  it('記録は新しいHostFsDispatcherインスタンス(=再起動でのコア丸ごと作り直し相当)では引き継がれない', () => {
    const { mem, ram } = makeFakeGuestMemory();
    makeInitHeader(ram, HDR_ADDR, 3); // D:

    const first = new HostFsDispatcher(mem, new FakeFs());
    first.request(HDR_ADDR);
    expect(first.getDriverStatus()).toEqual({ detected: true, driveNumber: 3 });

    // 再起動(restartCore())はHostFsDispatcherをinstallHostFsBridge経由で新規に作り直す
    // (worker-bridge.ts参照)。新しいインスタンスは前回の記録を持たない。
    const second = new HostFsDispatcher(mem, new FakeFs());
    expect(second.getDriverStatus()).toEqual({ detected: false, driveNumber: null });
  });
});
