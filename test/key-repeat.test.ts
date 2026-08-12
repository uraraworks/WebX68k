import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DELAY_MS,
  DEFAULT_INTERVAL_MS,
  isRepeatableKey,
  KeyRepeater,
  keyRepeatDelayMsFromSramValue,
  keyRepeatIntervalMsFromSramValue,
} from '../src/key-repeat';
import { RETROK } from '../src/keyboard';

describe('KeyRepeater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delayMs後からintervalMsごとにmake注入だけを呼ぶ', () => {
    const calls: number[] = [];
    const repeater = new KeyRepeater((retrok) => calls.push(retrok));
    repeater.start('src', RETROK.a);

    vi.advanceTimersByTime(DEFAULT_DELAY_MS - 1);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([RETROK.a]);
    vi.advanceTimersByTime(DEFAULT_INTERVAL_MS * 3);
    expect(calls).toEqual([RETROK.a, RETROK.a, RETROK.a, RETROK.a]);
  });

  it('stop()で指定sourceのmake注入が止まる', () => {
    const calls: number[] = [];
    const repeater = new KeyRepeater((retrok) => calls.push(retrok));
    repeater.start('src', RETROK.a);
    vi.advanceTimersByTime(DEFAULT_DELAY_MS);
    repeater.stop('src');
    vi.advanceTimersByTime(DEFAULT_INTERVAL_MS * 3);
    expect(calls).toEqual([RETROK.a]);
  });

  it('stopAll()で全sourceのmake注入が止まる', () => {
    const calls: number[] = [];
    const repeater = new KeyRepeater((retrok) => calls.push(retrok));
    repeater.start('a', RETROK.a);
    repeater.start('b', RETROK.b);
    vi.advanceTimersByTime(DEFAULT_DELAY_MS);
    repeater.stopAll();
    vi.advanceTimersByTime(DEFAULT_INTERVAL_MS * 3);
    expect(calls).toEqual([RETROK.a, RETROK.b]);
  });

  it('setTiming()は進行中のタイマを保ち、次に張るタイマから新しい間隔を使う', () => {
    const calls: number[] = [];
    const repeater = new KeyRepeater((retrok) => calls.push(retrok));
    repeater.start('src', RETROK.a);
    repeater.setTiming(500, 100);

    // start時に張った初回タイマは既定のdelayMsのまま。
    vi.advanceTimersByTime(DEFAULT_DELAY_MS);
    expect(calls).toEqual([RETROK.a]);
    vi.advanceTimersByTime(99);
    expect(calls).toEqual([RETROK.a]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([RETROK.a, RETROK.a]);

    // 新しい押下では変更後のdelayMsを使う。
    repeater.start('other', RETROK.b);
    vi.advanceTimersByTime(499);
    expect(calls).toEqual([RETROK.a, RETROK.a, RETROK.a, RETROK.a, RETROK.a, RETROK.a]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([RETROK.a, RETROK.a, RETROK.a, RETROK.a, RETROK.a, RETROK.a, RETROK.b, RETROK.a]);
  });

  it('同一sourceでstart()を多重に呼んでも既存タイマを維持する', () => {
    const calls: number[] = [];
    const repeater = new KeyRepeater((retrok) => calls.push(retrok));
    repeater.start('src', RETROK.a);
    vi.advanceTimersByTime(DEFAULT_DELAY_MS - 1);
    repeater.start('src', RETROK.b);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([RETROK.a]);
  });

  it('修飾キー・ロックキー・状態トグルキーはリピート対象外になる', () => {
    for (const retrok of [
      RETROK.LSHIFT, RETROK.RSHIFT, RETROK.LCTRL, RETROK.RCTRL,
      RETROK.LALT, RETROK.RALT, RETROK.LMETA, RETROK.RMETA,
      RETROK.LSUPER, RETROK.RSUPER, RETROK.CAPSLOCK, RETROK.NUMLOCK,
      RETROK.SCROLLOCK, RETROK.BROWSER_REFRESH, RETROK.BROWSER_STOP,
    ]) {
      expect(isRepeatableKey(retrok)).toBe(false);
    }
  });

  it('通常キーはリピート対象になる', () => {
    expect(isRepeatableKey(RETROK.a)).toBe(true);
    expect(isRepeatableKey(RETROK.LEFT)).toBe(true);
    expect(isRepeatableKey(RETROK.F1)).toBe(true);
  });
});

describe('keyRepeatDelayMsFromSramValue', () => {
  it('n=0/1/15をX68000の式で変換する', () => {
    expect(keyRepeatDelayMsFromSramValue(0)).toBe(200);
    expect(keyRepeatDelayMsFromSramValue(1)).toBe(300);
    expect(keyRepeatDelayMsFromSramValue(15)).toBe(1700);
  });
  it('範囲外(負数・16以上・非整数)はnull', () => {
    expect(keyRepeatDelayMsFromSramValue(-1)).toBeNull();
    expect(keyRepeatDelayMsFromSramValue(16)).toBeNull();
    expect(keyRepeatDelayMsFromSramValue(1.5)).toBeNull();
  });
});

describe('keyRepeatIntervalMsFromSramValue', () => {
  it('n=0/1/15をX68000の式で変換する', () => {
    expect(keyRepeatIntervalMsFromSramValue(0)).toBe(30);
    expect(keyRepeatIntervalMsFromSramValue(1)).toBe(35);
    expect(keyRepeatIntervalMsFromSramValue(15)).toBe(1155);
  });
  it('範囲外(負数・16以上・非整数)はnull', () => {
    expect(keyRepeatIntervalMsFromSramValue(-1)).toBeNull();
    expect(keyRepeatIntervalMsFromSramValue(16)).toBeNull();
    expect(keyRepeatIntervalMsFromSramValue(2.2)).toBeNull();
  });
});
