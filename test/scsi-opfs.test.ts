import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installScsiHooks } from '../src/scsi-opfs';

/** FileSystemSyncAccessHandle のフェイク。write()/flush()の回数だけ数える最小実装
 * (実ファイルI/Oは行わない。docs/STORAGE-SCSI.mdのデバウンスflush検証用)。 */
function makeFakeHandle(sizeBytes = 512 * 4): {
  handle: FileSystemSyncAccessHandle;
  flushCount: () => number;
  setFlushShouldThrow: (v: boolean) => void;
} {
  let flushCount = 0;
  let flushShouldThrow = false;
  const handle: FileSystemSyncAccessHandle = {
    read: (buffer: Uint8Array) => buffer.length,
    write: (buffer: Uint8Array) => buffer.length,
    truncate: () => {},
    getSize: () => sizeBytes,
    flush: () => {
      if (flushShouldThrow) throw new Error('fake flush failure');
      flushCount += 1;
    },
    close: () => {},
  };
  return {
    handle,
    flushCount: () => flushCount,
    setFlushShouldThrow: (v) => {
      flushShouldThrow = v;
    },
  };
}

const SECTOR_SIZE = 512;

describe('installScsiHooks: デバウンスflush', () => {
  const g = globalThis as Record<string, unknown>;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete g.__webx68kScsiRead;
    delete g.__webx68kScsiWrite;
    delete g.__webx68kScsiSize;
    delete g.__webx68kScsiFlushNow;
    delete g.__webx68kScsiFlushDebounceMs;
  });

  it('書き込み後、デバウンス時間(既定250ms)が経つとflush()が呼ばれる', () => {
    const fake = makeFakeHandle();
    installScsiHooks(fake.handle, false);
    const write = g.__webx68kScsiWrite as (lba: number, heap: Uint8Array, ptr: number) => number;
    const heap = new Uint8Array(SECTOR_SIZE);

    expect(write(0, heap, 0)).toBe(0);
    expect(fake.flushCount()).toBe(0);

    vi.advanceTimersByTime(249);
    expect(fake.flushCount()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(fake.flushCount()).toBe(1);
  });

  it('連続書き込み中はデバウンスが張り直され、最後の書き込みから既定時間後に1回だけflushされる', () => {
    const fake = makeFakeHandle();
    installScsiHooks(fake.handle, false);
    const write = g.__webx68kScsiWrite as (lba: number, heap: Uint8Array, ptr: number) => number;
    const heap = new Uint8Array(SECTOR_SIZE);

    write(0, heap, 0);
    vi.advanceTimersByTime(200);
    write(1, heap, 0); // ここでタイマが張り直される
    vi.advanceTimersByTime(200);
    expect(fake.flushCount()).toBe(0); // 初回書き込みから400ms経ったが、張り直し後まだ200ms
    write(2, heap, 0); // さらに張り直す
    vi.advanceTimersByTime(200);
    expect(fake.flushCount()).toBe(0);

    vi.advanceTimersByTime(50); // write(2)から250ms経過
    expect(fake.flushCount()).toBe(1);
  });

  it('__webx68kScsiFlushDebounceMs = 0 のときはデバウンスでflushされない(故障注入)', () => {
    g.__webx68kScsiFlushDebounceMs = 0;
    const fake = makeFakeHandle();
    installScsiHooks(fake.handle, false);
    const write = g.__webx68kScsiWrite as (lba: number, heap: Uint8Array, ptr: number) => number;
    const heap = new Uint8Array(SECTOR_SIZE);

    write(0, heap, 0);
    // デバウンス側は無効化されているため、既定のデバウンス時間(250ms)を過ぎても
    // 保険の定期flush(2000ms)より前ならまだ1回もflushされない。
    vi.advanceTimersByTime(1999);
    expect(fake.flushCount()).toBe(0);

    // 保険の定期flush(2000ms)側は生きているはずなので、そちらでは拾われる。
    vi.advanceTimersByTime(1);
    expect(fake.flushCount()).toBe(1);
  });

  it('保険の定期flush(2000ms)は残っている(デバウンスのタイマが張られなくても拾う)', () => {
    const fake = makeFakeHandle();
    installScsiHooks(fake.handle, false);
    const write = g.__webx68kScsiWrite as (lba: number, heap: Uint8Array, ptr: number) => number;
    const heap = new Uint8Array(SECTOR_SIZE);

    write(0, heap, 0);
    // デバウンス(250ms)で先に1回flushされ、dirtyはfalseに戻る。
    vi.advanceTimersByTime(250);
    expect(fake.flushCount()).toBe(1);
    // 以降 dirty が立たない限り、保険のintervalが回ってもflush()は増えない。
    vi.advanceTimersByTime(2000);
    expect(fake.flushCount()).toBe(1);
  });
});

describe('installScsiHooks: __webx68kScsiFlushNow', () => {
  const g = globalThis as Record<string, unknown>;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete g.__webx68kScsiRead;
    delete g.__webx68kScsiWrite;
    delete g.__webx68kScsiSize;
    delete g.__webx68kScsiFlushNow;
    delete g.__webx68kScsiFlushDebounceMs;
  });

  it('dirtyでないときは何もせず false を返す', () => {
    const fake = makeFakeHandle();
    installScsiHooks(fake.handle, false);
    const flushNow = g.__webx68kScsiFlushNow as () => boolean;

    expect(flushNow()).toBe(false);
    expect(fake.flushCount()).toBe(0);
  });

  it('dirtyのときは同期的にflushし、true を返す', () => {
    const fake = makeFakeHandle();
    installScsiHooks(fake.handle, false);
    const write = g.__webx68kScsiWrite as (lba: number, heap: Uint8Array, ptr: number) => number;
    const flushNow = g.__webx68kScsiFlushNow as () => boolean;
    const heap = new Uint8Array(SECTOR_SIZE);

    write(0, heap, 0);
    expect(flushNow()).toBe(true);
    expect(fake.flushCount()).toBe(1);
    // 直後は既にdirtyが落ちているため、再度呼んでもflushされない。
    expect(flushNow()).toBe(false);
    expect(fake.flushCount()).toBe(1);

    // デバウンスのタイマは張られたままだが、既にflush済みなのでdirtyでなければ何もしない。
    vi.advanceTimersByTime(250);
    expect(fake.flushCount()).toBe(1);
  });

  it('flush()が失敗したときはdirtyを保持し、falseを返す', () => {
    const fake = makeFakeHandle();
    fake.setFlushShouldThrow(true);
    installScsiHooks(fake.handle, false);
    const write = g.__webx68kScsiWrite as (lba: number, heap: Uint8Array, ptr: number) => number;
    const flushNow = g.__webx68kScsiFlushNow as () => boolean;
    const heap = new Uint8Array(SECTOR_SIZE);

    write(0, heap, 0);
    expect(flushNow()).toBe(false);
    expect(fake.flushCount()).toBe(0);

    // 次の機会(ここでは再度flushNowを呼ぶ)にdirtyが残っていて再試行できる。
    fake.setFlushShouldThrow(false);
    expect(flushNow()).toBe(true);
    expect(fake.flushCount()).toBe(1);
  });
});
