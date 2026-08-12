// AudioWorklet を使ったストリーミング再生。SharedArrayBuffer は使わず、
// メインスレッドから Float32 ステレオチャンクを postMessage でキューに積む方式。

// キューに溜めてよい上限(秒)。コアの出力レートとホストの再生レートは完全一致しないため、
// 無制限に積むと差分がそのまま遅延として際限なく蓄積する(数十秒遅れの原因)。
// 上限を超えたぶんは古い側から捨てて、常に TARGET_LATENCY_SEC 付近まで戻す。
const MAX_LATENCY_SEC = 0.25;
const TARGET_LATENCY_SEC = 0.08;

const WORKLET_SOURCE = `
const MAX_LATENCY_SEC = ${MAX_LATENCY_SEC};
const TARGET_LATENCY_SEC = ${TARGET_LATENCY_SEC};

class WebX68kAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._queue = [];
    this._queuedSamples = 0;
    this._readOffset = 0;
    // アンダーラン時にゼロへ即落ちさせず、直近サンプルからフェードアウト/インさせて
    // 波形の不連続によるプツ/ブブブ音を避けるための状態。約3ms相当。
    this._fadeSamples = Math.max(1, Math.round(sampleRate * 0.003));
    this._lastL = 0;
    this._lastR = 0;
    this._fade = 1;
    this.port.onmessage = (e) => {
      const chunk = e.data;
      // ステートロード直後など、溜まっている旧状態の音を捨てるための指示
      if (chunk && chunk.t === 'flush') {
        this._queue = [];
        this._queuedSamples = 0;
        this._readOffset = 0;
        this._lastL = 0;
        this._lastR = 0;
        this._fade = 0;
        return;
      }
      if (chunk && chunk.length) {
        this._queue.push(chunk);
        this._queuedSamples += chunk.length / 2;
        this._trim();
      }
    };
  }

  /** 溜まりすぎたら古いチャンクを捨てて遅延を上限内に抑える */
  _trim() {
    const max = MAX_LATENCY_SEC * sampleRate;
    if (this._queuedSamples <= max) return;
    const target = TARGET_LATENCY_SEC * sampleRate;
    while (this._queue.length > 1 && this._queuedSamples > target) {
      const head = this._queue[0];
      const remain = (head.length - this._readOffset) / 2;
      if (this._queuedSamples - remain < target) break;
      this._queue.shift();
      this._readOffset = 0;
      this._queuedSamples -= remain;
    }
  }

  process(_inputs, outputs) {
    // 4ブロック(約11.6ms)ごとにメインスレッドへ tick を送る。
    // タブ非表示で rAF/setTimeout がスロットルされてもオーディオスレッドは
    // 止まらないため、これがエミュレーション駆動のフォールバックになる。
    // 併せて現在のキュー滞留量(秒)を返し、メインスレッド側のフレーム供給ペース調整に使う。
    this._blockCount = (this._blockCount ?? 0) + 1;
    if (this._blockCount % 4 === 0) {
      this.port.postMessage({ t: 'tick', q: this._queuedSamples / sampleRate });
    }

    const output = outputs[0];
    const left = output[0];
    const right = output[1] ?? output[0];
    const frames = left.length;

    for (let i = 0; i < frames; i++) {
      if (this._queue.length === 0) {
        this._fade = Math.max(0, this._fade - 1 / this._fadeSamples);
        left[i] = this._lastL * this._fade;
        right[i] = this._lastR * this._fade;
        continue;
      }
      const chunk = this._queue[0];
      const rawL = chunk[this._readOffset];
      const rawR = chunk[this._readOffset + 1];
      if (this._fade < 1) {
        this._fade = Math.min(1, this._fade + 1 / this._fadeSamples);
      }
      left[i] = rawL * this._fade;
      right[i] = rawR * this._fade;
      this._lastL = rawL;
      this._lastR = rawR;
      this._readOffset += 2;
      this._queuedSamples -= 1;
      if (this._readOffset >= chunk.length) {
        this._queue.shift();
        this._readOffset = 0;
      }
    }
    return true;
  }
}
registerProcessor('webx68k-audio-processor', WebX68kAudioProcessor);
`;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private tickCb: (() => void) | null = null;
  private queuedSec = 0;

  /** 上限/目標の滞留量(秒)。メインループのペース調整で参照する */
  static readonly MAX_LATENCY_SEC = MAX_LATENCY_SEC;
  static readonly TARGET_LATENCY_SEC = TARGET_LATENCY_SEC;

  /** 再生待ちで滞留している音声の長さ(秒)。実質的な音声遅延そのもの */
  get queuedSeconds(): number {
    return this.queuedSec;
  }

  /** AudioWorklet からの周期 tick (約11.6ms) を受け取るコールバックを設定 */
  setTickHandler(cb: (() => void) | null): void {
    this.tickCb = cb;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  get ready(): boolean {
    return this.node !== null;
  }

  async start(): Promise<void> {
    if (this.ctx) return;

    // iOS では既定でマナーモード(消音スイッチ)が有効だと WebAudio が鳴らない。
    // navigator.audioSession(iOS 16.4+、型定義が無いため any 経由)で再生用途を
    // 明示すると消音スイッチの影響を受けなくなる。未対応環境では何もしない。
    try {
      const audioSession = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
      if (audioSession) audioSession.type = 'playback';
    } catch {
      // 失敗しても起動は続行する
    }

    const ctx = new AudioContext({ sampleRate: 44100 });
    // ユーザー操作を起点に start() が呼ばれた場合はここで即 running になる。
    // ここは await しない: Safari では自動再生が許可されない状況で resume() の
    // Promise が解決しないまま放置されることがあり、await するとエミュレータの
    // 起動そのものが止まってしまう(start() は main.ts の startFromOverlay() で
    // bootCore() より前に await されているため)。resume の成否は上位の
    // maybeShowAudioMutedBanner() が statechange で拾うので、ここで待つ必要はない。
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {
        /* 失敗しても起動は止めない */
      });
    }
    const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(ctx, 'webx68k-audio-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = (e) => {
      if (e.data && e.data.t === 'tick') {
        this.queuedSec = e.data.q ?? 0;
        this.tickCb?.();
      }
    };
    node.connect(ctx.destination);
    this.ctx = ctx;
    this.node = node;
  }

  /** Float32 ステレオ interleaved サンプルを再生キューへ送る */
  push(samples: Float32Array): void {
    if (!this.node) return;
    // 転送用にコピー(postMessage は Transferable を使うと元配列が空になるため複製して渡す)
    const copy = new Float32Array(samples);
    this.node.port.postMessage(copy, [copy.buffer]);
  }

  /** 再生待ちのキューを破棄する(ステートロード直後に旧状態の音が残るのを防ぐ) */
  flush(): void {
    this.queuedSec = 0;
    this.node?.port.postMessage({ t: 'flush' });
  }

  suspend(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    void this.ctx?.resume();
  }
}
