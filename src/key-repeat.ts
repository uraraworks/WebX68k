// 物理/仮想キーボードで共有するキーリピート機構。
//
// 実機のX68000キーボードは、キーを押している間のリピートではmakeだけを繰り返し、
// breakは指を離したときに1回だけ送る。リピートのたびにbreakを送ると、IOCSのBITSNS
// などで押下状態を見ているゲームには「キーが離された」と見え、テンキー移動等が途中で
// 止まってしまう。そのため押下状態には触れず、追加のmakeだけをコアへ注入する。

import { RETROK } from './keyboard';

export type SendKeyMake = (retrok: number) => void;

export interface KeyRepeatOptions {
  delayMs?: number;
  intervalMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

// SRAMからキーリピート設定を読めない(古いコア・SRAM未初期化)ときのフォールバック値。
// X68000の式に載る値を選んである: 開始300ms = 200+100×1(n=1)、間隔35ms = 30+5×1²(n=1)。
// 同梱IPLで実測した実機の設定は開始n=0(200ms)/間隔n=1(35ms)だったが、SRAMが読めない
// 環境では設定を変える手段も無いため、開始だけは1段長い300msにして、通常のタイプで
// リピートが誤爆しにくい側へ寄せている。
// SRAMが読める通常運転では main.ts が host.readKeyRepeatConfig() の値で setTiming() を
// 呼び直すため、ここはあくまで初期表示・SRAM未対応環境向けの保険。
export const DEFAULT_DELAY_MS = 300;
export const DEFAULT_INTERVAL_MS = 35;

interface RepeatEntry {
  retrok: number;
  timer: ReturnType<typeof setTimeout>;
}

export class KeyRepeater {
  private readonly entries = new Map<string, RepeatEntry>();
  private delayMs: number;
  private intervalMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  constructor(
    private readonly sendMake: SendKeyMake,
    options: KeyRepeatOptions = {},
  ) {
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.setTimeoutFn = options.setTimeoutFn ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeoutFn = options.clearTimeoutFn ?? globalThis.clearTimeout.bind(globalThis);
  }

  /**
   * delay/intervalを差し替える(SWITCH.Xの設定をSRAM経由で読み直したときに使う)。
   * 進行中のリピート(既にスケジュール済みのタイマ)はそのまま走らせ、次に
   * スケジュールし直すタイミングから新しい値を使う。
   */
  setTiming(delayMs: number, intervalMs: number): void {
    this.delayMs = delayMs;
    this.intervalMs = intervalMs;
  }

  /** 押下開始。同一sourceで多重に呼んでも既存のタイマを維持する(何もしない)。 */
  start(source: string, retrok: number): void {
    if (this.entries.has(source)) return;
    let entry: RepeatEntry;
    entry = {
      retrok,
      timer: this.setTimeoutFn(() => this.repeat(source, entry), this.delayMs),
    };
    this.entries.set(source, entry);
  }

  /** タイマを破棄する。キー自体のreleaseは呼び出し側の責務。 */
  stop(source: string): void {
    const entry = this.entries.get(source);
    if (!entry) return;
    this.clearTimeoutFn(entry.timer);
    this.entries.delete(source);
  }

  stopAll(): void {
    for (const source of [...this.entries.keys()]) this.stop(source);
  }

  private repeat(source: string, entry: RepeatEntry): void {
    if (this.entries.get(source) !== entry) return;
    this.sendMake(entry.retrok);
    entry.timer = this.setTimeoutFn(() => this.repeat(source, entry), this.intervalMs);
  }
}

/**
 * X68000 のキーリピート仕様(SWITCH.Xで設定するn=0..15の段階値)から、押下開始から
 * 最初のリピートが出るまでの遅延[ms]を求める。式は公開されているX68000のキーリピート
 * 仕様そのもの: 開始時間 = 200 + 100×n [ms]。
 * このnはSRAMオフセット $ED003A(webx68k_sram_read(0x3a))に格納されている。
 * nが0..15の整数でなければ(未初期化・壊れたSRAM等)nullを返す。
 */
export function keyRepeatDelayMsFromSramValue(n: number): number | null {
  if (!Number.isInteger(n) || n < 0 || n > 15) return null;
  return 200 + 100 * n;
}

/**
 * X68000 のキーリピート仕様から、リピート間隔[ms]を求める。
 * 式: 間隔 = 30 + 5×n² [ms]。このnはSRAMオフセット $ED003B
 * (webx68k_sram_read(0x3b))に格納されている。
 * nが0..15の整数でなければnullを返す。
 */
export function keyRepeatIntervalMsFromSramValue(n: number): number | null {
  if (!Number.isInteger(n) || n < 0 || n > 15) return null;
  return 30 + 5 * n * n;
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
 * 状態キーは繰り返すとゲスト側のロック状態が反転し続けてしまう。
 */
export function isRepeatableKey(retrok: number): boolean {
  return !NON_REPEATABLE_KEYS.has(retrok);
}
