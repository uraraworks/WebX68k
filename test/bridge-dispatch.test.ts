// Bridge.dispatch() が非同期 BridgeHost を正しく await して結果を返すことのテスト。
//
// docs/STORAGE-SCSI.md「段階移行の順序」手順2: screenshot/screenText/screenHash/reset/
// readMemory/listDisks/status を Promise<T> に揃えた。dispatch 自体は元々 Promise を扱えたが
// (docs 8節)、host 側が同期のうちは await しても実害が無かっただけで、host が真に非同期に
// なったときに「await し忘れて Promise を JSON化してしまう」退行が起きないことを確認する。
import { describe, expect, it, vi } from 'vitest';
import { Bridge, type BridgeHost } from '../src/bridge';

const EMPTY_TEXT_SCREEN = {
  available: false,
  lines: [],
  diagnostics: {
    columns: 0,
    rows: 0,
    nonEmptyCells: 0,
    matchedCells: 0,
    unknownCells: 0,
    coverage: 0,
    nonEmptyPlaneCells: [0, 0, 0, 0] as [number, number, number, number],
    kanjiFontAvailable: false,
  },
};

/** 実体(main.ts の bridgeHost/LocalCoreProxy)を模した、意図的に遅延させる非同期モック。 */
function createAsyncMockHost(): BridgeHost {
  const delay = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 5));
  return {
    screenshot: () => delay('data:image/png;base64,xxx'),
    screenText: () => delay(EMPTY_TEXT_SCREEN),
    screenHash: () => delay(12345),
    reset: () => delay(undefined),
    setKey: vi.fn(),
    typeText: () => delay({ typed: 0, skipped: [] }),
    mouseMove: vi.fn(),
    mouseButton: vi.fn(),
    saveState: () => delay(undefined),
    loadState: () => delay(undefined),
    listDisks: () => delay([{ slot: 'fdd0', name: 'a.xdf' }]),
    insertDisk: () => delay(undefined),
    ejectDisk: vi.fn(),
    diskListFiles: () => delay([]),
    diskReadFile: () => delay(new Uint8Array([1, 2, 3])),
    diskWriteFile: () => delay(undefined),
    readMemory: () => delay([0xaa, 0xbb, 0xcc]),
    status: () => delay({ running: true }),
  };
}

describe('Bridge.dispatch: 非同期 BridgeHost を await して解決済みの値を返す', () => {
  it('screenshot は dataUrl の文字列そのものを返す(Promiseのまま返さない)', async () => {
    const bridge = new Bridge(createAsyncMockHost());
    const result = await bridge.exec('screenshot');
    expect(result).toEqual({ dataUrl: 'data:image/png;base64,xxx' });
  });

  it('screen_text は解決済みの TextScreenDump を返す', async () => {
    const bridge = new Bridge(createAsyncMockHost());
    const result = await bridge.exec('screen_text');
    expect(result).toEqual(EMPTY_TEXT_SCREEN);
  });

  it('reset は host.reset() の完了を待ってから done を返す', async () => {
    const host = createAsyncMockHost();
    const resetSpy = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
    host.reset = resetSpy;
    const bridge = new Bridge(host);
    const result = await bridge.exec('reset');
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ done: true });
  });

  it('list_disks は解決済みの配列を返す', async () => {
    const bridge = new Bridge(createAsyncMockHost());
    const result = await bridge.exec('list_disks');
    expect(result).toEqual({ slots: [{ slot: 'fdd0', name: 'a.xdf' }] });
  });

  it('status は解決済みのオブジェクトを返す', async () => {
    const bridge = new Bridge(createAsyncMockHost());
    const result = await bridge.exec('status');
    expect(result).toEqual({ running: true });
  });

  it('read_memory は解決済みの number[] を bytes として返す', async () => {
    const bridge = new Bridge(createAsyncMockHost());
    const result = await bridge.exec('read_memory', { addr: 0x1000, length: 3 });
    expect(result).toEqual({ bytes: [0xaa, 0xbb, 0xcc] });
  });

  it('wait_screen_change は非同期 screenHash() を毎回 await して比較する', async () => {
    // 故障注入で実際に検出力を確認済み: src/bridge.ts の wait_screen_change 内
    // `let last = await h.screenHash()` / `const now = await h.screenHash()` から await を
    // 外すと、Promise オブジェクトどうしの比較になり毎回 changed=true のまま安定判定に
    // 到達できず、このテストは { changed: true, settled: false } を受け取って failする
    // ことを確認した(作業報告参照)。復元後は下記の通り settled: true で通る。
    const host = createAsyncMockHost();
    let call = 0;
    const values = [1, 1, 2, 2, 2]; // 2回目→3回目で変化、以後2回連続で安定
    host.screenHash = () => new Promise((resolve) => setTimeout(() => resolve(values[Math.min(call++, values.length - 1)]), 5));
    const bridge = new Bridge(host);
    const result = await bridge.exec('wait_screen_change', { stable_ms: 1, timeout_ms: 3000 });
    expect(result).toMatchObject({ changed: true, settled: true });
  });
});
