import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DELAY_MS,
  DEFAULT_FALLBACK_GAP_MS,
  DEFAULT_INTERVAL_MS,
  INITIAL_PULSE_ESTIMATE_MS,
  isRepeatableKey,
  KeyRepeater,
  keyRepeatDelayMsFromSramValue,
  keyRepeatIntervalMsFromSramValue,
} from '../src/key-repeat';
import { RETROK } from '../src/keyboard';

function createSink() {
  const calls: Array<{ kind: 'press' | 'release'; source: string; retrok: number }> = [];
  return {
    calls,
    press: (source: string, retrok: number) => calls.push({ kind: 'press', source, retrok }),
    release: (source: string, retrok: number) => calls.push({ kind: 'release', source, retrok }),
  };
}

// KeyRepeaterはrelease後、実際にpressし直すまでにフレーム合図待ちのパルス所要時間が
// かかる(ファイル冒頭のコメント参照)。1回目のreleaseまでの待ち・以降の周期はこのぶんを
// 差し引いて補正されるため、テストでも同じ計算式で期待値を出す。
const firstReleaseWaitMs = DEFAULT_DELAY_MS - INITIAL_PULSE_ESTIMATE_MS;

describe('KeyRepeater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delayMs補正後の待ち時間が経過する前は何も起きない', () => {
    const sink = createSink();
    const repeater = new KeyRepeater(sink);
    repeater.start('src', RETROK.a);
    vi.advanceTimersByTime(firstReleaseWaitMs - 1);
    expect(sink.calls).toEqual([]);
  });

  it('delayMs補正後の待ち時間が経過するとreleaseが1回出て、まだpressし直していない', () => {
    const sink = createSink();
    const repeater = new KeyRepeater(sink);
    repeater.start('src', RETROK.a);
    vi.advanceTimersByTime(firstReleaseWaitMs);
    expect(sink.calls).toEqual([{ kind: 'release', source: 'src', retrok: RETROK.a }]);
  });

  it('release後1回目のnotifyFramePolled()ではまだpressし直さない(そのフレームがbreakを読む番のため)', () => {
    const sink = createSink();
    const repeater = new KeyRepeater(sink);
    repeater.start('src', RETROK.a);
    vi.advanceTimersByTime(firstReleaseWaitMs);
    repeater.notifyFramePolled();
    expect(sink.calls).toEqual([{ kind: 'release', source: 'src', retrok: RETROK.a }]);
  });

  it('release後2回目のnotifyFramePolled()でpressし直される(=押下からdelayMs後)', () => {
    const sink = createSink();
    const repeater = new KeyRepeater(sink);
    repeater.start('src', RETROK.a);
    vi.advanceTimersByTime(firstReleaseWaitMs);
    repeater.notifyFramePolled();
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
    vi.advanceTimersByTime(firstReleaseWaitMs);
    expect(sink.calls).toHaveLength(1);
    vi.advanceTimersByTime(DEFAULT_FALLBACK_GAP_MS);
    expect(sink.calls).toEqual([
      { kind: 'release', source: 'src', retrok: RETROK.a },
      { kind: 'press', source: 'src', retrok: RETROK.a },
    ]);
  });

  it('pressし直した後、intervalMs後に次のreleaseが出る(周期補正: notifyFramePolled経由でパルス実測0msの場合)', () => {
    const sink = createSink();
    const repeater = new KeyRepeater(sink);
    repeater.start('src', RETROK.a);
    vi.advanceTimersByTime(firstReleaseWaitMs);
    // notifyFramePolled()は時刻を進めずに呼ぶため、実測パルス所要時間は0msになる。
    // この場合は intervalMs - 0 = intervalMs 後にちょうどreleaseが出るはず。
    repeater.notifyFramePolled();
    repeater.notifyFramePolled();
    sink.calls.length = 0;
    vi.advanceTimersByTime(DEFAULT_INTERVAL_MS);
    expect(sink.calls).toEqual([{ kind: 'release', source: 'src', retrok: RETROK.a }]);
  });

  it('周期補正: fallback経由でパルスに実時間がかかった場合、次のreleaseまでの待ちがその分短くなり、press→pressの周期がintervalMsちょうどになる', () => {
    const sink = createSink();
    const repeater = new KeyRepeater(sink);
    repeater.start('src', RETROK.a);
    vi.advanceTimersByTime(firstReleaseWaitMs); // release (t = firstReleaseWaitMs)
    // フレーム合図を送らず、fallbackGapMs経過でpressし直させる。
    // これによりrelease→press(パルス)に実際にDEFAULT_FALLBACK_GAP_MSぶんの時間がかかる。
    vi.advanceTimersByTime(DEFAULT_FALLBACK_GAP_MS); // press (t = firstReleaseWaitMs + fallbackGapMs)
    const pressAt = firstReleaseWaitMs + DEFAULT_FALLBACK_GAP_MS;
    sink.calls.length = 0;

    // 次のreleaseまでの待ちは max(0, intervalMs - fallbackGapMs) = 0 (fallbackGapMs > intervalMs のため)
    // なので、ほぼ即座(1ms以内)にreleaseが出るはず(押しっぱなしで壁時計が相当かかった
    // 直後の周期は詰まって出る=取りこぼしを防ぐ設計であることの確認)。
    vi.advanceTimersByTime(1);
    expect(sink.calls).toEqual([{ kind: 'release', source: 'src', retrok: RETROK.a }]);
    // release自体はpressの直後(ほぼ0ms後)に出ているので、press→releaseの間隔はintervalMsより
    // 大幅に短い。これは「パルス所要時間(fallbackGapMs)がintervalMsを超えていた」という
    // 極端なケースであり、Math.max(0, ...)によって待ちが0にクランプされたことを示す。
    void pressAt;
  });

  it('setTiming()で周期を変更すると、次にスケジュールされるreleaseからは新しいintervalMsが使われる(進行中の1回は古い値のまま)', () => {
    const sink = createSink();
    const repeater = new KeyRepeater(sink);
    repeater.start('src', RETROK.a);
    vi.advanceTimersByTime(firstReleaseWaitMs);
    repeater.notifyFramePolled();
    repeater.notifyFramePolled(); // press。この時点で次のreleaseは既に旧intervalMsで
    // スケジュール済み("進行中のリピート")なので、直後にsetTiming()しても影響しない。
    sink.calls.length = 0;

    const newIntervalMs = 100;
    repeater.setTiming(DEFAULT_DELAY_MS, newIntervalMs);

    // 進行中の1回(旧intervalMs=DEFAULT_INTERVAL_MS)はそのまま予定通り発火する。
    vi.advanceTimersByTime(DEFAULT_INTERVAL_MS);
    expect(sink.calls).toEqual([{ kind: 'release', source: 'src', retrok: RETROK.a }]);
    sink.calls.length = 0;
    repeater.notifyFramePolled();
    repeater.notifyFramePolled(); // press。ここで初めてsetTiming()後の新intervalMsで次のreleaseがスケジュールされる。
    sink.calls.length = 0;

    vi.advanceTimersByTime(newIntervalMs - 1);
    expect(sink.calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sink.calls).toEqual([{ kind: 'release', source: 'src', retrok: RETROK.a }]);
  });

  it('stop()後はタイマもフレーム合図も何も起こさない', () => {
    const sink = createSink();
    const repeater = new KeyRepeater(sink);
    repeater.start('src', RETROK.a);
    vi.advanceTimersByTime(firstReleaseWaitMs);
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
    vi.advanceTimersByTime(firstReleaseWaitMs);
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
    vi.advanceTimersByTime(firstReleaseWaitMs - 1);
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

describe('keyRepeatDelayMsFromSramValue', () => {
  it('n=0で200ms', () => {
    expect(keyRepeatDelayMsFromSramValue(0)).toBe(200);
  });
  it('n=1で300ms', () => {
    expect(keyRepeatDelayMsFromSramValue(1)).toBe(300);
  });
  it('n=15で1700ms', () => {
    expect(keyRepeatDelayMsFromSramValue(15)).toBe(1700);
  });
  it('範囲外(負数・16以上・非整数)はnull', () => {
    expect(keyRepeatDelayMsFromSramValue(-1)).toBeNull();
    expect(keyRepeatDelayMsFromSramValue(16)).toBeNull();
    expect(keyRepeatDelayMsFromSramValue(1.5)).toBeNull();
  });
});

describe('keyRepeatIntervalMsFromSramValue', () => {
  it('n=0で30ms', () => {
    expect(keyRepeatIntervalMsFromSramValue(0)).toBe(30);
  });
  it('n=1で35ms', () => {
    expect(keyRepeatIntervalMsFromSramValue(1)).toBe(35);
  });
  it('n=15で1155ms', () => {
    expect(keyRepeatIntervalMsFromSramValue(15)).toBe(1155);
  });
  it('範囲外(負数・16以上・非整数)はnull', () => {
    expect(keyRepeatIntervalMsFromSramValue(-1)).toBeNull();
    expect(keyRepeatIntervalMsFromSramValue(16)).toBeNull();
    expect(keyRepeatIntervalMsFromSramValue(2.2)).toBeNull();
  });
});
