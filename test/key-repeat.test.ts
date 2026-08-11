import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DELAY_MS, DEFAULT_FALLBACK_GAP_MS, DEFAULT_INTERVAL_MS, isRepeatableKey, KeyRepeater } from '../src/key-repeat';
import { RETROK } from '../src/keyboard';

function createSink() {
  const calls: Array<{ kind: 'press' | 'release'; source: string; retrok: number }> = [];
  return {
    calls,
    press: (source: string, retrok: number) => calls.push({ kind: 'press', source, retrok }),
    release: (source: string, retrok: number) => calls.push({ kind: 'release', source, retrok }),
  };
}

describe('KeyRepeater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delayMs経過前は何も起きない', () => {
    const sink = createSink();
    const repeater = new KeyRepeater(sink);
    repeater.start('src', RETROK.a);
    vi.advanceTimersByTime(DEFAULT_DELAY_MS - 1);
    expect(sink.calls).toEqual([]);
  });

  it('delayMs経過でreleaseが1回出て、まだpressし直していない', () => {
    const sink = createSink();
    const repeater = new KeyRepeater(sink);
    repeater.start('src', RETROK.a);
    vi.advanceTimersByTime(DEFAULT_DELAY_MS);
    expect(sink.calls).toEqual([{ kind: 'release', source: 'src', retrok: RETROK.a }]);
  });

  it('notifyFramePolled()を呼ぶとpressし直される', () => {
    const sink = createSink();
    const repeater = new KeyRepeater(sink);
    repeater.start('src', RETROK.a);
    vi.advanceTimersByTime(DEFAULT_DELAY_MS);
    repeater.notifyFramePolled();
    expect(sink.calls).toEqual([
      { kind: 'release', source: 'src', retrok: RETROK.a },
      { kind: 'press', source: 'src', retrok: RETROK.a },
    ]);
  });

  it('フレーム合図が来ないままfallbackGapMs経過するとpressし直される', () => {
    const sink = createSink();
    const repeater = new KeyRepeater(sink);
    repeater.start('src', RETROK.a);
    vi.advanceTimersByTime(DEFAULT_DELAY_MS);
    expect(sink.calls).toHaveLength(1);
    vi.advanceTimersByTime(DEFAULT_FALLBACK_GAP_MS);
    expect(sink.calls).toEqual([
      { kind: 'release', source: 'src', retrok: RETROK.a },
      { kind: 'press', source: 'src', retrok: RETROK.a },
    ]);
  });

  it('pressし直した後、intervalMs後に次のreleaseが出る', () => {
    const sink = createSink();
    const repeater = new KeyRepeater(sink);
    repeater.start('src', RETROK.a);
    vi.advanceTimersByTime(DEFAULT_DELAY_MS);
    repeater.notifyFramePolled();
    sink.calls.length = 0;
    vi.advanceTimersByTime(DEFAULT_INTERVAL_MS);
    expect(sink.calls).toEqual([{ kind: 'release', source: 'src', retrok: RETROK.a }]);
  });

  it('stop()後はタイマもフレーム合図も何も起こさない', () => {
    const sink = createSink();
    const repeater = new KeyRepeater(sink);
    repeater.start('src', RETROK.a);
    vi.advanceTimersByTime(DEFAULT_DELAY_MS);
    sink.calls.length = 0;
    repeater.stop('src');
    repeater.notifyFramePolled();
    vi.advanceTimersByTime(DEFAULT_FALLBACK_GAP_MS + DEFAULT_INTERVAL_MS + DEFAULT_DELAY_MS);
    expect(sink.calls).toEqual([]);
  });

  it('stopAll()も同様に全source分止まる', () => {
    const sink = createSink();
    const repeater = new KeyRepeater(sink);
    repeater.start('a', RETROK.a);
    repeater.start('b', RETROK.b);
    vi.advanceTimersByTime(DEFAULT_DELAY_MS);
    sink.calls.length = 0;
    repeater.stopAll();
    repeater.notifyFramePolled();
    vi.advanceTimersByTime(DEFAULT_FALLBACK_GAP_MS + DEFAULT_INTERVAL_MS + DEFAULT_DELAY_MS);
    expect(sink.calls).toEqual([]);
  });

  it('同一sourceでstart()を多重に呼んでも既存タイマを維持する', () => {
    const sink = createSink();
    const repeater = new KeyRepeater(sink);
    repeater.start('src', RETROK.a);
    vi.advanceTimersByTime(DEFAULT_DELAY_MS - 1);
    repeater.start('src', RETROK.a);
    vi.advanceTimersByTime(1);
    expect(sink.calls).toEqual([{ kind: 'release', source: 'src', retrok: RETROK.a }]);
  });

  it('修飾キーはisRepeatableKeyがfalseになる', () => {
    for (const retrok of [
      RETROK.LSHIFT, RETROK.RSHIFT, RETROK.LCTRL, RETROK.RCTRL,
      RETROK.LALT, RETROK.RALT, RETROK.LMETA, RETROK.RMETA,
      RETROK.LSUPER, RETROK.RSUPER, RETROK.CAPSLOCK, RETROK.NUMLOCK,
      RETROK.SCROLLOCK, RETROK.BROWSER_REFRESH, RETROK.BROWSER_STOP,
    ]) {
      expect(isRepeatableKey(retrok)).toBe(false);
    }
  });

  it('通常キーはisRepeatableKeyがtrueになる', () => {
    expect(isRepeatableKey(RETROK.a)).toBe(true);
    expect(isRepeatableKey(RETROK.LEFT)).toBe(true);
    expect(isRepeatableKey(RETROK.F1)).toBe(true);
  });
});
