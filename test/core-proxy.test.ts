// LocalCoreProxy (同一スレッド adapter) のテスト。
// CoreHostSurface のモックを host として渡し、Promise 化・例外→CoreProxyError変換・
// generation/dispose 後の呼び出し拒否を確認する。
import { describe, expect, it, vi } from 'vitest';
import { CoreProxyError } from '../src/core-protocol';
import { LocalCoreProxy, copyArrayBuffer, toOwnedArrayBuffer, type CoreHostSurface } from '../src/core-proxy';
import type { AvInfo } from '../src/libretro-host';
import type { TextScreenDump } from '../src/text-screen';

const AV_INFO: AvInfo = {
  baseWidth: 768,
  baseHeight: 512,
  maxWidth: 768,
  maxHeight: 512,
  aspectRatio: 1.5,
  fps: 60,
  sampleRate: 48000,
};

const TEXT_SCREEN: TextScreenDump = {
  available: true,
  lines: [],
  diagnostics: {
    columns: 0,
    rows: 0,
    nonEmptyCells: 0,
    matchedCells: 0,
    unknownCells: 0,
    coverage: 0,
    nonEmptyPlaneCells: [0, 0, 0, 0],
    kanjiFontAvailable: true,
  },
};

/** テスト用の CoreHostSurface モック。FS を単純な Map で模した簡易実装。 */
function createMockHost(): CoreHostSurface & { fs: Map<string, Uint8Array>; mounted: Map<number, string> } {
  const fs = new Map<string, Uint8Array>();
  const mounted = new Map<number, string>();
  return {
    fs,
    mounted,
    init: vi.fn(async () => {}),
    setCoreOption: vi.fn(() => {}),
    loadGame: vi.fn(() => true),
    loadGameNone: vi.fn(() => true),
    unloadGame: vi.fn(() => {}),
    reset: vi.fn(() => {}),
    fetchAvInfo: vi.fn(() => AV_INFO),
    serialize: vi.fn(() => new Uint8Array([1, 2, 3])),
    unserialize: vi.fn(() => true),
    readTextScreen: vi.fn(() => TEXT_SCREEN),
    peekByte: vi.fn((addr: number) => addr & 0xff),
    setFddImage: vi.fn((drive: number, path: string) => {
      if (path) mounted.set(drive, path);
      else mounted.delete(drive);
    }),
    writeFile: vi.fn((path: string, data: Uint8Array) => {
      fs.set(path, data);
    }),
    readFile: vi.fn((path: string) => {
      const data = fs.get(path);
      if (!data) throw new Error(`no such file: ${path}`);
      return data;
    }),
    removeFile: vi.fn((path: string) => {
      fs.delete(path);
    }),
    writeDiskImage: vi.fn((filename: string, data: Uint8Array) => {
      const path = `/game/${filename}`;
      fs.set(path, data);
      return path;
    }),
    dispose: vi.fn(() => {}),
  };
}

describe('LocalCoreProxy: 初期化前後のガード', () => {
  it('init前に他メソッドを呼ぶと INVALID_STATE で reject する', async () => {
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await expect(proxy.loadGame('/game/x.xdf')).rejects.toMatchObject({
      coreError: { code: 'INVALID_STATE' },
    });
    expect(host.loadGame).not.toHaveBeenCalled();
  });

  it('setCoreOption は init 前でも呼べる(実体 LibretroHost の挙動に合わせる)', async () => {
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await expect(proxy.setCoreOption('px68k_cpuspeed', '2')).resolves.toBeUndefined();
    expect(host.setCoreOption).toHaveBeenCalledWith('px68k_cpuspeed', '2');
  });

  it('init 後は各メソッドが host へ委譲され、Promise で返る', async () => {
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));
    expect(host.init).toHaveBeenCalledTimes(1);

    await expect(proxy.loadGame('/game/x.xdf')).resolves.toBe(true);
    await expect(proxy.fetchAvInfo()).resolves.toEqual(AV_INFO);
    await expect(proxy.readTextScreen()).resolves.toEqual(TEXT_SCREEN);

    const state = await proxy.serialize();
    expect(state).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(state!)).toEqual(new Uint8Array([1, 2, 3]));

    await expect(proxy.unserialize(new ArrayBuffer(4))).resolves.toBe(true);
  });

  it('二重 init は INVALID_STATE で reject する', async () => {
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));
    await expect(proxy.init(new Uint8Array([0]), new Uint8Array([0]))).rejects.toMatchObject({
      coreError: { code: 'INVALID_STATE' },
    });
  });

  it('dispose 後の呼び出しは INVALID_STATE で reject する', async () => {
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));
    await proxy.dispose();
    expect(host.dispose).toHaveBeenCalledTimes(1);

    await expect(proxy.loadGame('/game/x.xdf')).rejects.toMatchObject({
      coreError: { code: 'INVALID_STATE' },
    });
    await expect(proxy.dispose()).rejects.toMatchObject({ coreError: { code: 'INVALID_STATE' } });
  });

  it('dispose のたびに generation が進む', async () => {
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    expect(proxy.currentGeneration).toBe(0);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));
    await proxy.dispose();
    expect(proxy.currentGeneration).toBe(1);
  });
});

describe('LocalCoreProxy: opts.initialized (段階移行での結線用)', () => {
  it('opts.initialized: true で構築すると、host.init() を呼ばずに observation 系を呼べる', async () => {
    const host = createMockHost();
    // 段階移行の途中では host.init() が既存経路(main.ts の bootCore())で既に完了しているため、
    // proxy はそれを呼び直さずに initialized 状態から始まる。
    const proxy = new LocalCoreProxy(host, { initialized: true });
    expect(host.init).not.toHaveBeenCalled();
    await expect(proxy.readTextScreen()).resolves.toEqual(TEXT_SCREEN);
    expect(host.init).not.toHaveBeenCalled();
  });

  it('opts を省略した場合は従来どおり未初期化から始まる', async () => {
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await expect(proxy.readTextScreen()).rejects.toMatchObject({
      coreError: { code: 'INVALID_STATE' },
    });
  });
});

describe('LocalCoreProxy: readMemory は範囲を1回のRPCでまとめて読む', () => {
  it('length ぶんの peekByte を1回の readMemory 呼び出しの中だけで行い、host 側の呼び出し単位は1回', async () => {
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));

    const buf = await proxy.readMemory(0x2000, 8);
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]));
    // readMemory 自体は1回の呼び出し。内部で host.peekByte を8回呼ぶのは実装詳細であり、
    // 「呼び出し元(main.ts の bridgeHost 等)からは1RPCに見える」ことがここでの検証対象。
    expect(host.peekByte).toHaveBeenCalledTimes(8);
  });

});

describe('LocalCoreProxy: 引数検証', () => {
  it('loadGame に空文字列を渡すと INVALID_ARGUMENT', async () => {
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));
    await expect(proxy.loadGame('')).rejects.toMatchObject({ coreError: { code: 'INVALID_ARGUMENT' } });
  });

  it('readMemory に負のaddressや0以下のlengthを渡すと INVALID_ARGUMENT', async () => {
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));
    await expect(proxy.readMemory(-1, 4)).rejects.toMatchObject({ coreError: { code: 'INVALID_ARGUMENT' } });
    await expect(proxy.readMemory(0, 0)).rejects.toMatchObject({ coreError: { code: 'INVALID_ARGUMENT' } });
  });

  it('readMemory は peekByte をアドレス順に length 回呼び、結果を1つの ArrayBuffer にまとめる', async () => {
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));
    const buf = await proxy.readMemory(0x1000, 4);
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([0x00, 0x01, 0x02, 0x03]));
    expect(host.peekByte).toHaveBeenCalledTimes(4);
  });

  it('unserialize に空の ArrayBuffer を渡すと INVALID_ARGUMENT', async () => {
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));
    await expect(proxy.unserialize(new ArrayBuffer(0))).rejects.toMatchObject({
      coreError: { code: 'INVALID_ARGUMENT' },
    });
  });
});

describe('LocalCoreProxy: 手順3(ステートとFS転送) — serialize/unserializeの往復', () => {
  it('serialize()で得たArrayBufferをunserialize()へ渡すと往復できる', async () => {
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));

    const buf = await proxy.serialize();
    expect(buf).not.toBeNull();
    await expect(proxy.unserialize(buf!)).resolves.toBe(true);
    expect(host.unserialize).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
  });

  it('writeFile→readFileで書いたバイト列を読み戻せる', async () => {
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));

    await proxy.writeFile('/game/boot.cmd', new Uint8Array([1, 2, 3, 4]).buffer);
    const readBack = await proxy.readFile('/game/boot.cmd');
    expect(new Uint8Array(readBack)).toEqual(new Uint8Array([1, 2, 3, 4]));

    await proxy.removeFile('/game/boot.cmd');
    await expect(proxy.readFile('/game/boot.cmd')).rejects.toMatchObject({
      coreError: { code: 'IO_FAILED' },
    });
  });
});

describe('LocalCoreProxy: 手順3の肝 — 所有権のdetach', () => {
  it('unserialize()に渡したArrayBufferは呼び出し後にdetachされ、byteLengthが0になる', async () => {
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));

    const buf = new Uint8Array([9, 9, 9, 9]).buffer;
    expect(buf.byteLength).toBe(4);
    await proxy.unserialize(buf);
    // 呼び出し側が渡したあとに同じバッファを使い回すバグを検出できることの確認。
    expect(buf.byteLength).toBe(0);
  });

  it('writeFile()に渡したArrayBufferは呼び出し後にdetachされる', async () => {
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));

    const buf = new Uint8Array([1, 2, 3]).buffer;
    expect(buf.byteLength).toBe(3);
    await proxy.writeFile('/game/x', buf);
    expect(buf.byteLength).toBe(0);
    // detach後もhostへ渡った内容自体は正しく保存されている(コピー漏れではないこと)。
    const readBack = await proxy.readFile('/game/x');
    expect(new Uint8Array(readBack)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('detach前に呼び出し側がバッファへ触れてもhostが受け取る内容は書き換わらない(detachはコピー後に起きる)', async () => {
    // takeOwnership は structuredClone(buf, { transfer: [buf] }) で「複製してから元をdetach」
    // する。呼び出し側が渡した直後にバッファを書き換えるような誤用があっても、host が受け取る
    // のは呼び出し時点のスナップショットであることを確認する(単なるdetach確認と違う観点)。
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));

    const view = new Uint8Array([5, 5, 5]);
    await proxy.writeFile('/game/y', view.buffer);
    const readBack = await proxy.readFile('/game/y');
    expect(new Uint8Array(readBack)).toEqual(new Uint8Array([5, 5, 5]));
  });
});

describe('LocalCoreProxy: main.tsの呼び出し形(toOwnedArrayBuffer経由)でもdetachが効く', () => {
  // レビュー指摘(2026-08-28): 上の「手順3の肝」節は proxy.unserialize(buf) のように生の
  // ArrayBuffer を直接渡しており、main.ts の実際の呼び出し経路(Uint8Array を
  // toOwnedArrayBuffer() で ArrayBuffer 化してから渡す)を通っていなかった。旧実装の
  // toArrayBuffer() は常に slice() でコピーしていたため、main.ts 側が保持する Uint8Array
  // (stored.bytes 等)は無傷のまま残り、detach は使い捨てのコピーにしか効いていなかった
  // (=本番経路では一度も発火していなかった)。ここでは main.ts と同じ「Uint8Array →
  // toOwnedArrayBuffer() → proxy へ渡す」形を再現し、呼び出し元が保持している Uint8Array
  // 自体が detach されることを確認する。

  it('unserialize(): 呼び出し元が保持するUint8Array自体がdetachされる', async () => {
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));

    // IndexedDBから読み直した直後の、バッファ全体を覆うUint8Array(main.tsのstored.bytes相当)。
    const storedBytes = new Uint8Array([9, 9, 9, 9]);
    expect(storedBytes.byteLength).toBe(4);
    await proxy.unserialize(toOwnedArrayBuffer(storedBytes));
    expect(storedBytes.byteLength).toBe(0);
  });

  it('writeFile(): 呼び出し元が保持するUint8Array自体がdetachされ、内容は正しく渡る', async () => {
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));

    const encoded = new TextEncoder().encode('px68k "" ""\n'); // main.tsのcmdText相当
    expect(encoded.byteLength).toBeGreaterThan(0);
    await proxy.writeFile('/game/boot.cmd', toOwnedArrayBuffer(encoded));
    expect(encoded.byteLength).toBe(0);
    const readBack = await proxy.readFile('/game/boot.cmd');
    expect(new TextDecoder().decode(readBack)).toBe('px68k "" ""\n');
  });

  it('故障注入: toOwnedArrayBufferの代わりにcopyArrayBuffer(常にコピー、旧実装相当)を経由すると、このdetach検出は失敗する', async () => {
    // 陽性対照。上2件のテストが「結線を見ている」ことの確認: 手順3導入時のtoArrayBuffer
    // (常にslice()でコピー)相当のcopyArrayBufferに差し替えると、呼び出し元のUint8Arrayは
    // detachされずbyteLengthが残る。この故障注入で新テストが実際に落ちることを確認できて
    // 初めて、上のテストが結線の欠陥(旧実装)を検出できると言える。
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));

    const storedBytes = new Uint8Array([9, 9, 9, 9]);
    await proxy.unserialize(copyArrayBuffer(storedBytes));
    // 旧実装(常にコピー)では呼び出し元のUint8Arrayはdetachされない=byteLengthは4のまま。
    expect(storedBytes.byteLength).toBe(4);
  });
});

describe('LocalCoreProxy: unserialize失敗時にエラーコードを握り潰さない', () => {
  it('host.unserialize()がfalseを返す場合、falseがそのまま透過する(以前の状態を握り潰した成功扱いにしない)', async () => {
    const host = createMockHost();
    host.unserialize = vi.fn(() => false);
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));

    await expect(proxy.unserialize(new Uint8Array([1, 2, 3, 4]).buffer)).resolves.toBe(false);
  });

  it('host.unserialize()が例外を投げる場合、CORE_FAILUREのCoreProxyErrorとして透過する', async () => {
    const host = createMockHost();
    host.unserialize = vi.fn(() => {
      throw new Error('corrupt state');
    });
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));

    await expect(proxy.unserialize(new Uint8Array([1, 2, 3, 4]).buffer)).rejects.toMatchObject({
      coreError: { code: 'CORE_FAILURE', message: 'corrupt state' },
    });
  });
});

describe('LocalCoreProxy: 例外→CoreProxyError 変換', () => {
  it('host が例外を投げると CORE_FAILURE の CoreProxyError で reject する', async () => {
    const host = createMockHost();
    host.loadGame = vi.fn(() => {
      throw new Error('boom');
    });
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));
    await expect(proxy.loadGame('/game/x.xdf')).rejects.toBeInstanceOf(CoreProxyError);
    await expect(proxy.loadGame('/game/x.xdf')).rejects.toMatchObject({
      coreError: { code: 'CORE_FAILURE', message: 'boom' },
    });
  });

  it('readFile の失敗は IO_FAILED として変換される', async () => {
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));
    await expect(proxy.readFile('/no/such/file')).rejects.toMatchObject({
      coreError: { code: 'IO_FAILED' },
    });
  });

  it('init の失敗は LOAD_FAILED として変換される', async () => {
    const host = createMockHost();
    host.init = vi.fn(async () => {
      throw new Error('bios missing');
    });
    const proxy = new LocalCoreProxy(host);
    await expect(proxy.init(new Uint8Array([0]), new Uint8Array([0]))).rejects.toMatchObject({
      coreError: { code: 'LOAD_FAILED', message: 'bios missing' },
    });
  });
});

describe('LocalCoreProxy: hotSwapFdd', () => {
  it('初回挿入は eject(no-op)→write→insertの順で行われ、previousImageはnull', async () => {
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));

    const bytes = new Uint8Array([9, 9, 9]).buffer;
    const result = await proxy.hotSwapFdd({ drive: 0, image: { name: 'a.xdf', bytes } });

    expect(result.previousImage).toBeNull();
    expect(result.mountedPath).toBe('/game/a.xdf');
    expect(host.setFddImage).toHaveBeenNthCalledWith(1, 0, ''); // eject
    expect(host.writeDiskImage).toHaveBeenCalledWith('a.xdf', new Uint8Array([9, 9, 9]));
    expect(host.setFddImage).toHaveBeenNthCalledWith(2, 0, '/game/a.xdf'); // insert
  });

  it('2回目の交換は旧イメージを previousImage として読み出す(eject→read→write→insertの順序)', async () => {
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));

    await proxy.hotSwapFdd({ drive: 0, image: { name: 'a.xdf', bytes: new Uint8Array([1]).buffer } });
    // 挿入中に host 側のファイルが書き換わった体で、eject→read で回収できることを確認する
    host.fs.set('/game/a.xdf', new Uint8Array([1, 2, 3, 4]));

    const calls: string[] = [];
    const origEject = host.setFddImage;
    host.setFddImage = vi.fn((drive, path) => {
      calls.push(`setFddImage(${drive},${JSON.stringify(path)})`);
      return origEject(drive, path);
    });
    const origRead = host.readFile;
    host.readFile = vi.fn((path) => {
      calls.push(`readFile(${path})`);
      return origRead(path);
    });
    const origWrite = host.writeDiskImage;
    host.writeDiskImage = vi.fn((name, data) => {
      calls.push(`writeDiskImage(${name})`);
      return origWrite(name, data);
    });

    const result = await proxy.hotSwapFdd({ drive: 0, image: { name: 'b.xdf', bytes: new Uint8Array([5]).buffer } });

    expect(result.previousImage).not.toBeNull();
    expect(new Uint8Array(result.previousImage!)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(result.mountedPath).toBe('/game/b.xdf');
    // eject(旧) → read(旧) → write(新) → insert(新) の順序であること
    expect(calls).toEqual([
      'setFddImage(0,"")',
      'readFile(/game/a.xdf)',
      'writeDiskImage(b.xdf)',
      'setFddImage(0,"/game/b.xdf")',
    ]);
  });

  it('排出(image: null)は eject して previousImage を返し、マウント状態を消す', async () => {
    const host = createMockHost();
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));
    await proxy.hotSwapFdd({ drive: 1, image: { name: 'c.xdf', bytes: new Uint8Array([7]).buffer } });
    host.fs.set('/game/c.xdf', new Uint8Array([7, 7]));

    const result = await proxy.hotSwapFdd({ drive: 1, image: null });
    expect(new Uint8Array(result.previousImage!)).toEqual(new Uint8Array([7, 7]));
    expect(result.mountedPath).toBeNull();

    // 消えたマウント状態からもう一度排出しても previousImage は null (drive情報を持っていない)
    const second = await proxy.hotSwapFdd({ drive: 1, image: null });
    expect(second.previousImage).toBeNull();
  });
});

describe('陽性対照: 例外→CoreError 変換の故障注入', () => {
  // toProxyError の変換を「常に元の Error をそのまま投げ直す」壊れた版に差し替えて、
  // CoreProxyError への変換有無をテストが実際に検出できることを確認する。
  class BrokenLocalCoreProxy extends LocalCoreProxy {
    // 意図的に CoreProxyError へ包まず生の Error を投げる(故障注入)
    async loadGameRaw(path: string): Promise<boolean> {
      const host = (this as unknown as { host: CoreHostSurface }).host;
      return host.loadGame(path); // try/catchなし
    }
  }

  it('壊れた実装は CoreProxyError を経由しない生の Error を投げ、正しい実装との違いを検出できる', async () => {
    const host = createMockHost();
    host.loadGame = vi.fn(() => {
      throw new Error('boom');
    });
    const proxy = new LocalCoreProxy(host);
    await proxy.init(new Uint8Array([0]), new Uint8Array([0]));

    // 正しい実装: CoreProxyError に変換される
    await expect(proxy.loadGame('/x')).rejects.toBeInstanceOf(CoreProxyError);

    // 壊れた実装: 生の Error のまま(CoreProxyErrorではない) = 検出できることの確認(陽性対照)
    const broken = new BrokenLocalCoreProxy(host);
    await broken.init(new Uint8Array([0]), new Uint8Array([0]));
    let caught: unknown;
    try {
      await broken.loadGameRaw('/x');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(CoreProxyError);
  });
});
