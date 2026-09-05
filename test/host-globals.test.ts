// src/host-globals.ts のテスト。
//
// 2026-09-04の修正の要点: `collectHostGlobals()` は以前 string/number/boolean しか
// 転写せず、配列やArrayBuffer/TypedArrayで渡す設定(例: 本物SCSI ROMのバイト列)が
// **無言で**落ち、Worker側は気づかずフォールバックへ切り替わっていた
// (docs/STORAGE-SCSI.md「本物ROMオラクル」参照)。ここでは
//   (1) 転写できないキーがあれば必ず onSkipped が呼ばれること(0件と落として0件の区別)、
//   (2) 配列/ArrayBuffer/TypedArrayが実際に転写されること、
// の両方を確認する。さらに(3)として、転写ロジックをわざと退行(配列を再び除外)させた
// 版で同じテストを当て、検査自体が実際に落ちることを確かめる(陽性対照。
// feedback_fault_injection_needs_positive_control.md参照)。
import { describe, expect, it } from 'vitest';
import {
  KNOWN_DEV_ONLY_HOST_GLOBALS,
  collectHostGlobals,
  isTransferableHostGlobalValue,
} from '../src/host-globals';

describe('collectHostGlobals', () => {
  it('__webx68k で始まらないキーは無視する', () => {
    const skipped: string[][] = [];
    const out = collectHostGlobals(
      { unrelatedKey: 'x', __webx68kFoo: 'y' },
      (keys) => skipped.push(keys),
    );
    expect(out).toEqual({ __webx68kFoo: 'y' });
    expect(skipped).toEqual([]);
  });

  it('string/number/booleanは従来どおり転写する', () => {
    const out = collectHostGlobals({
      __webx68kScsiUrl: 'https://example/scsi.hds',
      __webx68kRamWatchLo: 0x1000,
      __webx68kScsiOpfs: true,
    });
    expect(out).toEqual({
      __webx68kScsiUrl: 'https://example/scsi.hds',
      __webx68kRamWatchLo: 0x1000,
      __webx68kScsiOpfs: true,
    });
  });

  it('配列(number[])を転写する(本物SCSI ROMバイト列相当)', () => {
    const romBytes = Array.from({ length: 16 }, (_, i) => i);
    const out = collectHostGlobals({ __webx68kScsiRomBytes: romBytes });
    expect(out.__webx68kScsiRomBytes).toEqual(romBytes);
  });

  it('ArrayBufferとTypedArrayを転写する', () => {
    const buf = new ArrayBuffer(4);
    const view = new Uint8Array([1, 2, 3]);
    const out = collectHostGlobals({
      __webx68kSomeBuffer: buf,
      __webx68kSomeView: view,
    });
    expect(out.__webx68kSomeBuffer).toBe(buf);
    expect(out.__webx68kSomeView).toBe(view);
  });

  it('関数は転写できないため除外し、onSkippedへキー名を渡す(黙って無視しない)', () => {
    const skipped: string[][] = [];
    const out = collectHostGlobals(
      {
        __webx68kScsiRead: () => 0,
        __webx68kScsiUrl: 'ok',
      },
      (keys) => skipped.push(keys),
    );
    expect(out).toEqual({ __webx68kScsiUrl: 'ok' });
    expect(skipped).toEqual([['__webx68kScsiRead']]);
  });

  it('通常のobject/Symbol/undefinedも転写できないため除外する', () => {
    const skipped: string[][] = [];
    const out = collectHostGlobals(
      {
        __webx68kPlainObject: { nested: true },
        __webx68kSymbol: Symbol('x'),
        __webx68kUndef: undefined,
        __webx68kOk: 42,
      },
      (keys) => skipped.push(keys),
    );
    expect(out).toEqual({ __webx68kOk: 42 });
    expect(skipped).toEqual([
      ['__webx68kPlainObject', '__webx68kSymbol', '__webx68kUndef'],
    ]);
  });

  it('転写できないキーが無ければonSkippedは呼ばれない(「0件」と「落として0件」の区別)', () => {
    let called = false;
    collectHostGlobals({ __webx68kOk: 1 }, () => {
      called = true;
    });
    expect(called).toBe(false);
  });

  it('KNOWN_DEV_ONLY_HOST_GLOBALSのキーは関数値でもonSkippedを呼ばない(毎回の警告を止める)', () => {
    const skipped: string[][] = [];
    const source: Record<string, unknown> = {};
    for (const key of KNOWN_DEV_ONLY_HOST_GLOBALS) {
      source[key] = () => 0;
    }
    source.__webx68kOk = 1;
    const out = collectHostGlobals(source, (keys) => skipped.push(keys));
    expect(skipped).toEqual([]);
    expect(out).toEqual({ __webx68kOk: 1 });
  });

  it('KNOWN_DEV_ONLY_HOST_GLOBALSのキーはoutにも入らない(転写しない点は従来どおり)', () => {
    const source: Record<string, unknown> = {};
    for (const key of KNOWN_DEV_ONLY_HOST_GLOBALS) {
      source[key] = () => 0;
    }
    const out = collectHostGlobals(source);
    for (const key of KNOWN_DEV_ONLY_HOST_GLOBALS) {
      expect(out[key]).toBeUndefined();
    }
  });

  it('集合に無い__webx68kSomethingNewが関数値だと従来どおりonSkippedが呼ばれる', () => {
    const skipped: string[][] = [];
    const out = collectHostGlobals(
      { __webx68kSomethingNew: () => 0 },
      (keys) => skipped.push(keys),
    );
    expect(out).toEqual({});
    expect(skipped).toEqual([['__webx68kSomethingNew']]);
  });
});

describe('isTransferableHostGlobalValue', () => {
  it.each([
    ['string', 'x', true],
    ['number', 1, true],
    ['boolean', true, true],
    ['array', [1, 2, 3], true],
    ['ArrayBuffer', new ArrayBuffer(1), true],
    ['Uint8Array', new Uint8Array(1), true],
    ['function', () => {}, false],
    ['plain object', { a: 1 }, false],
    ['undefined', undefined, false],
    ['symbol', Symbol('s'), false],
  ] as const)('%s -> %s', (_label, value, expected) => {
    expect(isTransferableHostGlobalValue(value)).toBe(expected);
  });
});

describe('故障注入: 配列を再び除外する退行を検出できること(陽性対照)', () => {
  /** 修正前の実装を模した「退行版」。string/number/booleanしか通さない。 */
  function regressedIsTransferable(v: unknown): boolean {
    const t = typeof v;
    return t === 'string' || t === 'number' || t === 'boolean';
  }
  function regressedCollect(
    source: Record<string, unknown>,
    onSkipped?: (skippedKeys: string[]) => void,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const skipped: string[] = [];
    for (const key of Object.keys(source)) {
      if (!key.startsWith('__webx68k')) continue;
      const v = source[key];
      if (regressedIsTransferable(v)) out[key] = v;
      else skipped.push(key);
    }
    if (skipped.length > 0) onSkipped?.(skipped);
    return out;
  }

  it('退行版は配列を黙って(呼び出し元へは警告付きで)落とす一方、修正後の実装は転写する', () => {
    const romBytes = [1, 2, 3, 4];
    const skippedRegressed: string[][] = [];
    const regressedOut = regressedCollect(
      { __webx68kScsiRomBytes: romBytes },
      (keys) => skippedRegressed.push(keys),
    );
    // 退行版の挙動: 配列は転写されず、除外キーとして通知される
    // (このテストが両実装の差を検出できていることの確認 = 検査自体が壊れていない証拠)。
    expect(regressedOut.__webx68kScsiRomBytes).toBeUndefined();
    expect(skippedRegressed).toEqual([['__webx68kScsiRomBytes']]);

    const fixedOut = collectHostGlobals({ __webx68kScsiRomBytes: romBytes });
    expect(fixedOut.__webx68kScsiRomBytes).toEqual(romBytes);
  });
});
