// 物理/仮想キーボードで共有するキーリピート機構。
//
// コア(px68k-libretro)側にはリピート機構が無く、LibretroHost.keyState は
// 1エミュレートフレームにつき1回(input_poll直後のinput_state読み出し)しか
// 読まれない。そのため release→press を同一フレーム内で済ませるとコアには
// breakが一切見えず、リピートが無言で消える(壁時計の短いギャップで戻す旧実装は
// これを踏んでいた)。ここでは release 後、次にエミュレートフレームが1回
// ポーリングされたのを確認してから press し直すことで、breakがちょうど1フレーム
// 分コアに見えるようにする。

import { RETROK } from './keyboard';

export interface KeyRepeatSink {
  press(source: string, retrok: number): void;
  release(source: string, retrok: number): void;
}

export interface KeyRepeatOptions {
  delayMs?: number;
  intervalMs?: number;
  fallbackGapMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/** 仮想キーボード旧実装(startRepeat)が使っていた値を踏襲。 */
export const DEFAULT_DELAY_MS = 500;
export const DEFAULT_INTERVAL_MS = 50;
export const DEFAULT_FALLBACK_GAP_MS = 50;

type EntryState = 'delay' | 'waitingFrame' | 'waitingInterval';

interface RepeatEntry {
  retrok: number;
  state: EntryState;
  timer: ReturnType<typeof setTimeout>;
}

export class KeyRepeater {
  private readonly entries = new Map<string, RepeatEntry>();
  private readonly delayMs: number;
  private readonly intervalMs: number;
  private readonly fallbackGapMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  constructor(
    private readonly sink: KeyRepeatSink,
    options: KeyRepeatOptions = {},
  ) {
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.fallbackGapMs = options.fallbackGapMs ?? DEFAULT_FALLBACK_GAP_MS;
    this.setTimeoutFn = options.setTimeoutFn ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeoutFn = options.clearTimeoutFn ?? globalThis.clearTimeout.bind(globalThis);
  }

  /** 押下開始。同一sourceで多重に呼んでも既存のタイマを維持する(何もしない)。 */
  start(source: string, retrok: number): void {
    if (this.entries.has(source)) return;
    const timer = this.setTimeoutFn(() => this.doRelease(source), this.delayMs);
    this.entries.set(source, { retrok, state: 'delay', timer });
  }

  /**
   * タイマ/保留中の再pressを破棄する。キー自体のrelease(SharedKeyInput側)は
   * 呼び出し側の責務。すでにbreakを送ってpress待ちの状態でstopされた場合、
   * キーは離れたまま残るが、これは正しい挙動(呼び出し側は続けて
   * SharedKeyInput.release()を呼ぶが、多重releaseはSharedKeyInput側で無害に
   * 無視されるだけなので、離れっぱなしのまま辻褄が合う)。
   */
  stop(source: string): void {
    const entry = this.entries.get(source);
    if (!entry) return;
    this.clearTimeoutFn(entry.timer);
    this.entries.delete(source);
  }

  stopAll(): void {
    for (const source of [...this.entries.keys()]) this.stop(source);
  }

  /** エミュレート1フレームが実際にポーリングされた合図。host.onPollから毎フレーム呼ぶ。 */
  notifyFramePolled(): void {
    for (const [source, entry] of this.entries) {
      if (entry.state !== 'waitingFrame') continue;
      this.doPress(source, entry);
    }
  }

  private doRelease(source: string): void {
    const entry = this.entries.get(source);
    if (!entry) return;
    this.sink.release(source, entry.retrok);
    entry.state = 'waitingFrame';
    // フォールバック: コアが止まっている/未起動(仮想キーボード単体・テスト環境など)だと
    // notifyFramePolledが来ず、releaseしたままキーが固着してしまう。壁時計で一定時間
    // 待っても合図が来なければpressし直して救済する。
    entry.timer = this.setTimeoutFn(() => this.doPress(source, entry), this.fallbackGapMs);
  }

  private doPress(source: string, entry: RepeatEntry): void {
    if (this.entries.get(source) !== entry) return;
    this.clearTimeoutFn(entry.timer);
    this.sink.press(source, entry.retrok);
    entry.state = 'waitingInterval';
    entry.timer = this.setTimeoutFn(() => this.doRelease(source), this.intervalMs);
  }
}

/** リピート対象から除外するキー(retrok)の集合。 */
const NON_REPEATABLE_KEYS = new Set<number>([
  RETROK.LSHIFT,
  RETROK.RSHIFT,
  RETROK.LCTRL,
  RETROK.RCTRL,
  RETROK.LALT,
  RETROK.RALT,
  RETROK.LMETA,
  RETROK.RMETA,
  RETROK.LSUPER,
  RETROK.RSUPER,
  RETROK.CAPSLOCK,
  RETROK.NUMLOCK,
  RETROK.SCROLLOCK,
  RETROK.BROWSER_REFRESH, // かな(状態トグルのラッチキー。連打するとロックが反転を繰り返す)
  RETROK.BROWSER_STOP, // ローマ字(同上)
]);

/**
 * 修飾キー・ロック系・状態トグル系はオートリピートの対象外とする。
 * 修飾キーは押しっぱなしで意味を持つだけなので連打しても無意味であり、
 * かな/ローマ字はX68000側でmake/breakのパルスをトグルとして扱うラッチキーのため、
 * リピートさせるとロック状態が意図せず反転を繰り返してしまう。
 */
export function isRepeatableKey(retrok: number): boolean {
  return !NON_REPEATABLE_KEYS.has(retrok);
}
