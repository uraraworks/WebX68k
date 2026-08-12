// 物理/仮想キーボードで共有するキーリピート機構。
//
// コア(px68k-libretro)側にはリピート機構が無く、LibretroHost.keyState は
// 1エミュレートフレームにつき1回(input_poll直後のinput_state読み出し)しか
// 読まれない。そのため release→press を同一フレーム内で済ませるとコアには
// breakが一切見えず、リピートが無言で消える(壁時計の短いギャップで戻す旧実装は
// これを踏んでいた)。
//
// retro_run() 内の順序は「onPoll(=input_poll) → input_state でkeyStateを読む」。
// releaseはこの外(setTimeoutによるJSイベントループの隙間)で起こるので、release後
// 最初に来るnotifyFramePolled()は「このフレームのinput_stateがこれから'離れた'を
// 読む」合図でしかない。そのフレームの読み出しが済むのはonPollが返った後、つまり
// 次のnotifyFramePolled()が来た時点なので、press し直してよいのは release 後
// **2回目** の notifyFramePolled()。1回目で press し直すと、そのフレームの
// input_state はまだ呼ばれておらず、結局一度も「離れた」状態を読まれないまま
// press に上書きされてしまい、breakが一切コアに見えなくなる。
// (2026-08-11レビュー: 実装が1回目でpressし直しており、結合テストもKeyRepeater
// →onPollの配線順を通していなかったため検出できていなかった)

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
  /** 経過時間の実測に使う時刻取得関数。既定は Date.now(vitestのfake timersがmockする)。 */
  now?: () => number;
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
// フレーム合図2回ぶん(60fpsで約33ms)より確実に長い値。フォールバックは純粋に
// 「コアが動いていない/止まっている(仮想キーボード単体・テスト環境など)ときの
// 固着防止」だけが役目で、通常運転ではフレーム合図の側が必ず先に来る。ここが
// フレーム間隔に近いと、フレーム落ちやタブスロットルのジッタで「2回目の合図が
// 来る前にフォールバックが先に発火」してbreakが読まれる前にpressし直してしまい、
// そのリピートが無言で落ちる事故になる。
export const DEFAULT_FALLBACK_GAP_MS = 250;

/**
 * release→press(パルス)にかかる所要時間の初期推定値。
 * release後、コアが実際にbreakを読み終えるのを待つため最低でも
 * notifyFramePolled()が2回(60fpsで約33ms)必要になる(ファイル冒頭のコメント参照)。
 * リピート開始直後はまだ実測値が無いため、この推定値を使って
 * 「1周期ぶん遅れて最初のリピートが出る」事故を防ぐ。実測が入り次第、
 * その実測値で上書きされる。
 */
export const INITIAL_PULSE_ESTIMATE_MS = (1000 / 60) * 2;

type EntryState = 'delay' | 'waitingFrame' | 'waitingInterval';

interface RepeatEntry {
  retrok: number;
  state: EntryState;
  timer: ReturnType<typeof setTimeout>;
  /** state==='waitingFrame'の間、release後にnotifyFramePolled()が呼ばれた回数。 */
  pollsSinceRelease: number;
  /** 直近のrelease時刻(nowFn基準)。pressし直した瞬間にパルス所要時間を実測するために使う。 */
  releasedAtMs: number;
  /** release→pressの所要時間の直近の実測値(まだ未実測ならINITIAL_PULSE_ESTIMATE_MS)。 */
  pulseEstimateMs: number;
}

export class KeyRepeater {
  private readonly entries = new Map<string, RepeatEntry>();
  private delayMs: number;
  private intervalMs: number;
  private readonly fallbackGapMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly now: () => number;

  constructor(
    private readonly sink: KeyRepeatSink,
    options: KeyRepeatOptions = {},
  ) {
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.fallbackGapMs = options.fallbackGapMs ?? DEFAULT_FALLBACK_GAP_MS;
    this.setTimeoutFn = options.setTimeoutFn ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeoutFn = options.clearTimeoutFn ?? globalThis.clearTimeout.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  /**
   * delay/intervalを差し替える(SWITCH.Xの設定をSRAM経由で読み直したときに使う)。
   * 進行中のリピート(既にスケジュール済みのタイマ)はそのまま走らせ、次に
   * スケジュールし直すタイミング(次のdoRelease/doPress)から新しい値を使う。
   */
  setTiming(delayMs: number, intervalMs: number): void {
    this.delayMs = delayMs;
    this.intervalMs = intervalMs;
  }

  /** 押下開始。同一sourceで多重に呼んでも既存のタイマを維持する(何もしない)。 */
  start(source: string, retrok: number): void {
    if (this.entries.has(source)) return;
    // 最初のリピート(press)が押下からdelayMs後に出るよう、releaseまでの待ちから
    // パルス所要時間の推定ぶんを差し引く。差し引かないと「delayMs待ち+パルス所要時間」
    // ぶん遅れて初回リピートが出てしまう。
    const firstReleaseWaitMs = Math.max(0, this.delayMs - INITIAL_PULSE_ESTIMATE_MS);
    const timer = this.setTimeoutFn(() => this.doRelease(source), firstReleaseWaitMs);
    this.entries.set(source, {
      retrok,
      state: 'delay',
      timer,
      pollsSinceRelease: 0,
      releasedAtMs: 0,
      pulseEstimateMs: INITIAL_PULSE_ESTIMATE_MS,
    });
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
      entry.pollsSinceRelease++;
      // 1回目はこのフレームのinput_stateがこれから'離れた'を読む合図でしかないので
      // まだpressし直さない。2回目(=次フレームの先頭)に達して初めて、直前のフレームの
      // input_stateがbreakを読み終えたと判断できる。
      if (entry.pollsSinceRelease >= 2) this.doPress(source, entry);
    }
  }

  private doRelease(source: string): void {
    const entry = this.entries.get(source);
    if (!entry) return;
    this.sink.release(source, entry.retrok);
    entry.state = 'waitingFrame';
    entry.pollsSinceRelease = 0;
    entry.releasedAtMs = this.now();
    // フォールバック: コアが止まっている/未起動(仮想キーボード単体・テスト環境など)だと
    // notifyFramePolledが来ず、releaseしたままキーが固着してしまう。壁時計で一定時間
    // 待っても合図が来なければpressし直して救済する。
    entry.timer = this.setTimeoutFn(() => this.doPress(source, entry), this.fallbackGapMs);
  }

  private doPress(source: string, entry: RepeatEntry): void {
    if (this.entries.get(source) !== entry) return;
    this.clearTimeoutFn(entry.timer);
    // release→pressに実際にかかった時間を実測し、次回以降の周期補正に使う推定値を更新する。
    // (frame合図経路・fallback経路のどちらを通っても、ここで実測できる)
    entry.pulseEstimateMs = Math.max(0, this.now() - entry.releasedAtMs);
    this.sink.press(source, entry.retrok);
    entry.state = 'waitingInterval';
    // press→pressの周期がintervalMsちょうどになるよう、次のreleaseまでの待ちから
    // 今回実測したパルス所要時間ぶんを差し引く。差し引かないと1周期が
    // intervalMs+パルス所要時間になり、指定値より遅くなってしまう。
    const nextReleaseWaitMs = Math.max(0, this.intervalMs - entry.pulseEstimateMs);
    entry.timer = this.setTimeoutFn(() => this.doRelease(source), nextReleaseWaitMs);
  }
}

/**
 * X68000 のキーリピート仕様(SWITCH.Xで設定するn=0..15の段階値)から、押下開始から
 * 最初のリピートが出るまでの遅延[ms]を求める。式は公開されているX68000のキーリピート
 * 仕様そのもの: 開始時間 = 200 + 100×n [ms]。
 * このnはSRAMオフセット $ED0059(webx68k_sram_read(0x59))に格納されている。
 * nが0..15の整数でなければ(未初期化・壊れたSRAM等)nullを返す。
 */
export function keyRepeatDelayMsFromSramValue(n: number): number | null {
  if (!Number.isInteger(n) || n < 0 || n > 15) return null;
  return 200 + 100 * n;
}

/**
 * X68000 のキーリピート仕様から、リピート間隔[ms]を求める。
 * 式: 間隔 = 30 + 5×n² [ms]。このnはSRAMオフセット $ED005A
 * (webx68k_sram_read(0x5a))に格納されている。
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
 * かな/ローマ字はX68000側でmake/breakのパルスをトグルとして扱うラッチキーのため、
 * リピートさせるとロック状態が意図せず反転を繰り返してしまう。
 */
export function isRepeatableKey(retrok: number): boolean {
  return !NON_REPEATABLE_KEYS.has(retrok);
}
