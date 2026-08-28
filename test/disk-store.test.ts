import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractArchive } from '../src/api/archive.ts';
import {
  classifyDiskBytes,
  deleteDisk,
  detectDiskContentKind,
  ensureDiskExtension,
  FD_SIZE_2DD_640,
  FD_SIZE_2DD_720,
  FD_SIZE_2HD_1232,
  FD_SIZE_2HD_1440,
  measureDiskLibraryBytes,
  putDisk,
} from '../src/disk-store.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** human302.xdf(生の2HD 1232KB)の先頭へ、px68kのDIM_HEADER形式に沿った256バイトヘッダを付ける。 */
function buildValidDimBytes(rawXdf: Uint8Array, type: number, trackLength: number): Uint8Array {
  const header = new Uint8Array(256);
  header[0] = type; // DIM_HEADER.type
  // trkflag[170] は実データを持つトラックのフラグ。実データ分のトラック数だけ立てる
  // (77シリンダ*2ヘッド=154トラックが2HDの標準)。それ以上を立てるとpx68k側が
  // 存在しないトラックまで読もうとしてエラーになる。
  const trackCount = rawXdf.length / trackLength;
  for (let i = 0; i < trackCount; i++) header[1 + i] = 1;
  const out = new Uint8Array(header.length + rawXdf.length);
  out.set(header, 0);
  out.set(rawXdf, header.length);
  return out;
}

describe('classifyDiskBytes (アーカイブ内エントリ専用の内容ベース判定)', () => {
  it('拡張子で判定できるならその結果を返す(挙動を変えない)', () => {
    expect(classifyDiskBytes('foo.xdf', new Uint8Array(10))).toBe('fd');
    expect(classifyDiskBytes('foo.hdf', new Uint8Array(10))).toBe('hdd');
    expect(classifyDiskBytes('foo.txt', new Uint8Array(10))).toBeNull();
  });

  it.each([FD_SIZE_2HD_1232, FD_SIZE_2HD_1440, FD_SIZE_2DD_640, FD_SIZE_2DD_720])(
    '拡張子なしでもX68000の既知フロッピーサイズ(%i バイト)なら fd と判定する',
    (size) => {
      expect(classifyDiskBytes('NODISK_EXT', new Uint8Array(size))).toBe('fd');
    },
  );

  it('オフセット0x400に"X68K"シグネチャがあれば拡張子なしでも hdd と判定する', () => {
    const bytes = new Uint8Array(0x500);
    bytes[0x400] = 0x58; // 'X'
    bytes[0x401] = 0x36; // '6'
    bytes[0x402] = 0x38; // '8'
    bytes[0x403] = 0x4b; // 'K'
    expect(classifyDiskBytes('NODISK_EXT', bytes)).toBe('hdd');
  });

  it('サイズもシグネチャも一致しなければ拡張子なしは除外される(null)', () => {
    expect(classifyDiskBytes('README', new Uint8Array(123))).toBeNull();
    expect(classifyDiskBytes('README', new Uint8Array(0x500))).toBeNull();
  });

  it('実物のLZH(bran3r_entry0.lzh)を展開しても拡張子なしエントリはfdと判定されない(除外される)', async () => {
    // このfixtureはWebNP2(PC-98エミュレータ)由来の素材で、X68000のDIM判定根拠にするのは不適切。
    // 実際に中身を調べると: DIMで使われる"DIFC HEADER"署名が無く0xAB以降は全ゼロ、
    // 先頭のtypeバイトは1(=DIM_2HS、1トラック1024*9=9216バイト)なのに
    // (生サイズ1,261,824 - 256) = 1,261,568 は9216で割り切れず px68k の disk_dim.c と
    // 整合しない(トラック数が整数にならない)。よって現行の厳密な判定では null になるのが正しい。
    const bytes = readFileSync(join(here, 'fixtures/bran3r_entry0.lzh'));
    const entries = await extractArchive('bran3r_entry0.lzh', new Uint8Array(bytes));
    expect(entries.length).toBe(1);
    const entry = entries[0];
    // 拡張子を持たない実ファイル名であることを確認しておく(回帰の目印)。
    expect(entry.name).not.toMatch(/\.[a-zA-Z0-9]+$/);
    expect(classifyDiskBytes(entry.name, entry.data)).toBeNull();
  });

  it('px68kのDIM実装と整合するDIMヘッダ(type=2HD)付きイメージはfdと判定され、拡張子補完は.dimになる', () => {
    // human302.xdf は生の2HD 1232KB(1,261,568バイト)。type=0(DIM_2HD)のSctLength=1024*8=8192で
    // 1,261,568 / 8192 = 154(整数)なので、正しい256バイトDIMヘッダを付けると有効なDIMとして扱われるはず。
    const rawXdf = readFileSync(join(here, '../public/system/human302.xdf'));
    const dimBytes = buildValidDimBytes(new Uint8Array(rawXdf), 0, 1024 * 8);
    expect(classifyDiskBytes('NODISK_EXT', dimBytes)).toBe('fd');
    expect(detectDiskContentKind('NODISK_EXT', dimBytes)).toBe('dimFd');
    expect(ensureDiskExtension('NODISK_EXT', 'fd', detectDiskContentKind('NODISK_EXT', dimBytes))).toBe(
      'NODISK_EXT.dim',
    );
  });

  it('生の既知フロッピーサイズと完全一致する場合の拡張子補完は.xdfのまま(現状維持)', () => {
    const bytes = new Uint8Array(FD_SIZE_2HD_1232);
    const contentKind = detectDiskContentKind('NODISK_EXT', bytes);
    expect(contentKind).toBe('rawFd');
    expect(ensureDiskExtension('NODISK_EXT', 'fd', contentKind)).toBe('NODISK_EXT.xdf');
  });
});

// --- measureDiskLibraryBytes(): IndexedDBのレコード列挙によるサイズ合計の検証 ---
//
// vitest.config.ts は environment: 'node' なのでブラウザのIndexedDBは存在しない。
// test/sram-store.test.ts と同じ流儀で、disk-store.ts が実際に叩くAPI面
// (open/onupgradeneeded/transaction/objectStore/put/get/getAll/getKey/delete)だけを
// 再現した最小限の互換モックをここに用意する(keyPathでの格納が要るぶん、
// sram-store.test.ts のものより一回り広い)。

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
  constructor(
    private data: Map<string, unknown>,
    private keyPath: string,
    private tx?: FakeTransaction,
  ) {}

  put(value: Record<string, unknown>): FakeIDBRequestLike {
    const key = String(value[this.keyPath]);
    this.data.set(key, value);
    return makeRequest();
  }

  get(key: string): FakeIDBRequestLike {
    const req = makeRequest();
    queueMicrotask(() => {
      req.result = this.data.get(key);
      req.onsuccess?.();
    });
    return req;
  }

  getKey(key: string): FakeIDBRequestLike {
    const req = makeRequest();
    queueMicrotask(() => {
      req.result = this.data.has(key) ? key : undefined;
      req.onsuccess?.();
    });
    return req;
  }

  getAll(): FakeIDBRequestLike {
    const req = makeRequest();
    queueMicrotask(() => {
      req.result = Array.from(this.data.values());
      req.onsuccess?.();
    });
    return req;
  }

  /**
   * 実際の IDBObjectStore.openCursor() と同様に、1件進めるたびに onsuccess を呼び直す
   * (実装がリクエストを使い回すため、result への代入と onsuccess 呼び出しをそのつど行う)。
   * `cursor.continue()` が呼ばれるまでは進まないので、実装が全件を一括で配列化していないことを
   * このモック経由では検証できないが、少なくとも実装がこのAPI面を正しく叩いていることは検証できる。
   *
   * カーソルが末尾に達するまでトランザクションを完了させてはいけないため、tx に活動中を
   * 通知する(素朴に固定1マイクロタスク後に oncomplete するFakeTransactionのままだと、
   * 複数件のカーソル継続の途中でトランザクションが完了したことになり、末尾まで数え切る前に
   * Promiseがresolveしてしまう=一部レコードが欠落する)。
   */
  openCursor(): FakeIDBRequestLike {
    const req = makeRequest();
    const entries = Array.from(this.data.values());
    let index = 0;
    this.tx?.beginActivity();
    const step = (): void => {
      queueMicrotask(() => {
        if (index < entries.length) {
          const value = entries[index];
          index++;
          req.result = {
            value,
            continue: () => step(),
          };
        } else {
          req.result = null;
          this.tx?.endActivity();
        }
        req.onsuccess?.();
      });
    };
    step();
    return req;
  }

  delete(key: string): FakeIDBRequestLike {
    this.data.delete(key);
    return makeRequest();
  }
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error: unknown = null;
  private store: FakeObjectStore;
  private aborted = false;
  private completed = false;
  // openCursor()等、複数マイクロタスクにまたがる進行中の読み出し件数。0でない間は完了させない。
  private activityCount = 0;

  constructor(data: Map<string, unknown>, keyPath: string) {
    this.store = new FakeObjectStore(data, keyPath, this);
    // put()/delete()は同期的にMapへ反映済みなので、呼び出し元がoncomplete/onabortを
    // 代入し終えた後のマイクロタスクで完了通知すればよい(openCursor()があれば
    // beginActivity()が先に同期的に呼ばれているため、このチェックでは完了しない)。
    queueMicrotask(() => this.maybeComplete());
  }

  objectStore(_name: string): FakeObjectStore {
    return this.store;
  }

  beginActivity(): void {
    this.activityCount++;
  }

  endActivity(): void {
    this.activityCount--;
    queueMicrotask(() => this.maybeComplete());
  }

  private maybeComplete(): void {
    if (this.completed || this.aborted) return;
    if (this.activityCount > 0) return;
    this.completed = true;
    this.oncomplete?.();
  }

  abort(): void {
    this.aborted = true;
    this.error = new Error('transaction aborted (fake, unused in these tests)');
    queueMicrotask(() => this.onabort?.());
  }
}

class FakeDatabase {
  private stores = new Map<string, { data: Map<string, unknown>; keyPath: string }>();
  objectStoreNames = {
    contains: (name: string): boolean => this.stores.has(name),
  };
  createObjectStore(name: string, opts?: { keyPath?: string }): void {
    this.stores.set(name, { data: new Map(), keyPath: opts?.keyPath ?? '' });
  }
  transaction(name: string, _mode: string): FakeTransaction {
    const store = this.stores.get(name);
    if (!store) throw new Error(`FakeDatabase: no such store "${name}"`);
    return new FakeTransaction(store.data, store.keyPath);
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

function makeDisk(sourceKey: string, size: number, savedAt = Date.now()) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i & 0xff;
  return { sourceKey, name: `${sourceKey}.xdf`, bytes, savedAt };
}

describe('measureDiskLibraryBytes (決定3の受け入れ条件: IndexedDBレコード列挙による実サイズ合計)', () => {
  it('レコードが無ければ合計0・内訳0件', async () => {
    const usage = await measureDiskLibraryBytes();
    expect(usage.totalBytes).toBe(0);
    expect(usage.records).toEqual([]);
    expect(usage.unknownRecords).toEqual([]);
  });

  it('【陽性対照】レコードを1件追加すると合計がそのサイズぶん増える', async () => {
    const before = await measureDiskLibraryBytes();
    expect(before.totalBytes).toBe(0);

    await putDisk(makeDisk('file:a.xdf:1000', 1000));

    const after = await measureDiskLibraryBytes();
    expect(after.totalBytes).toBe(1000);
    expect(after.records).toEqual([{ key: 'file:a.xdf:1000', kind: 'Uint8Array', byteLength: 1000 }]);
  });

  it('複数レコードの合計と内訳(キー・種別・バイト数)を返す', async () => {
    await putDisk(makeDisk('file:a.xdf:1000', 1000));
    await putDisk(makeDisk('file:b.hdf:2000', 2000));

    const usage = await measureDiskLibraryBytes();
    expect(usage.totalBytes).toBe(3000);
    expect(usage.records.map((r) => r.key).sort()).toEqual(['file:a.xdf:1000', 'file:b.hdf:2000']);
    for (const r of usage.records) {
      expect(r.kind).toBe('Uint8Array');
      expect(r.byteLength).toBeGreaterThan(0);
    }
  });

  it('削除すると合計から減る', async () => {
    await putDisk(makeDisk('file:a.xdf:1000', 1000));
    await putDisk(makeDisk('file:b.hdf:2000', 2000));
    await deleteDisk('file:a.xdf:1000');

    const usage = await measureDiskLibraryBytes();
    expect(usage.totalBytes).toBe(2000);
    expect(usage.records).toEqual([{ key: 'file:b.hdf:2000', kind: 'Uint8Array', byteLength: 2000 }]);
  });

  it('上書き保存(同一sourceKey)では合計が二重計上されない', async () => {
    await putDisk(makeDisk('file:a.xdf:1000', 1000));
    await putDisk(makeDisk('file:a.xdf:1000', 1000, Date.now() + 1));

    const usage = await measureDiskLibraryBytes();
    expect(usage.totalBytes).toBe(1000);
    expect(usage.records.length).toBe(1);
  });

  // --- A-1: unknown型が黙って0を足すのを防ぐ ---
  // 「totalBytesが増えない」だけを受け入れ条件にすると、未知の型(bytesが壊れている/未対応の形)の
  // レコードが混入していても合格してしまう(合格条件を失敗状態のほうが強く満たす形)。
  // unknownRecordsで「未知型が0件であること」も別途確認できるようにする。
  it('【A-1】bytesが未知の型(文字列)のレコードは合計0のまま、unknownRecordsとして報告される', async () => {
    await putDisk(makeDisk('file:a.xdf:1000', 1000));
    // bytesが本来Uint8Arrayである契約を破り、意図的に未知の型を挿入する。
    await putDisk({
      sourceKey: 'file:broken',
      name: 'broken.xdf',
      bytes: 'not-actually-bytes' as unknown as Uint8Array,
      savedAt: Date.now(),
    });

    const usage = await measureDiskLibraryBytes();
    // 既知の1000バイトぶんだけが合計に乗り、未知型は無言で0として埋没していない。
    expect(usage.totalBytes).toBe(1000);
    expect(usage.unknownRecords).toEqual([{ key: 'file:broken', kind: 'unknown', byteLength: 0 }]);
    expect(usage.records.find((r) => r.key === 'file:broken')?.kind).toBe('unknown');
  });

  it('【A-1 陰性対照】未知型のレコードが無ければunknownRecordsは0件', async () => {
    await putDisk(makeDisk('file:a.xdf:1000', 1000));
    const usage = await measureDiskLibraryBytes();
    expect(usage.unknownRecords).toEqual([]);
  });

  // --- A-2: listDisks()(getAll()で全量読み)を再利用せず、カーソルで1件ずつ数える ---
  // カーソルで進んでいることを直接証明するのは難しいので、ここでは「従来のgetAll()経由と
  // 合計・内訳が変わらない」ことを担保する回帰テストとする(実装がカーソルAPI面を正しく
  // 使っていることは、この回帰が壊れずに通ること自体で裏付けられる)。
  it('【A-2】カーソル方式でも合計・内訳はgetAll()方式と同じ結果になる(回帰)', async () => {
    await putDisk(makeDisk('file:a.xdf:1000', 1000));
    await putDisk(makeDisk('file:b.hdf:2000', 2000));
    await putDisk(makeDisk('file:c.hdf:3000', 3000));

    const usage = await measureDiskLibraryBytes();
    expect(usage.totalBytes).toBe(6000);
    const byKey = Object.fromEntries(usage.records.map((r) => [r.key, r.byteLength]));
    expect(byKey).toEqual({
      'file:a.xdf:1000': 1000,
      'file:b.hdf:2000': 2000,
      'file:c.hdf:3000': 3000,
    });
  });
});
