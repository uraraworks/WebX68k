// AudioWorklet を使ったストリーミング再生。SharedArrayBuffer は使わず、
// メインスレッドから Float32 ステレオチャンクを postMessage でキューに積む方式。

// キューに溜めてよい上限(秒)。コアの出力レートとホストの再生レートは完全一致しないため、
// 無制限に積むと差分がそのまま遅延として際限なく蓄積する(数十秒遅れの原因)。
// 上限を超えたぶんは古い側から捨てて、常に TARGET_LATENCY_SEC 付近まで戻す。
const MAX_LATENCY_SEC = 0.25;
const TARGET_LATENCY_SEC = 0.08;

// dev限定のAudioWorklet内キュープローブ(計測計画「音声遅延」(1)、
// docs/STORAGE-SCSI.md「基準値：音声遅延」参照)。import.meta.env.DEVはここでは
// テンプレート文字列の外(このモジュールのトップレベル)で評価しているため、Viteが
// 本番ビルドでは静的に false へ置換する。結果、WORKLET_SOURCE内の
// `const AUDIO_QUEUE_PROBE = false;` は本番でも文字列として残るが、以降の
// `if (AUDIO_QUEUE_PROBE)` 分岐はブラウザ側のJITが定数畳み込みできる形であり、
// 新規のprocess()末端コスト(カウンタ加算)は計測目的でのみ有効化される
// (postMessageの頻度自体は変えていないため、既存のtickコストには影響しない)。
const AUDIO_QUEUE_PROBE = import.meta.env.DEV;

const WORKLET_SOURCE = `
const MAX_LATENCY_SEC = ${MAX_LATENCY_SEC};
const TARGET_LATENCY_SEC = ${TARGET_LATENCY_SEC};
const AUDIO_QUEUE_PROBE = ${AUDIO_QUEUE_PROBE};

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
    // 以下はdev限定のキュープローブ用カウンタ(累積、resetQueueProbeで0に戻す)。
    // underflow: キューが空で無音/フェードへ落ちたフレーム数(欠音に相当)。
    // trimEvents: _trim()が実際に間引きを行った回数(上限超過の発生回数)。
    // droppedSamples: _trim()で捨てられたサンプル数(1chフレーム換算)。
    // 計測用の故障注入(measure-audio.mjsからのみ到達)。
    //   fault-drop-chunk: 次のprocess()呼び出しでキュー先頭のチャンクを1つ丸ごと捨てる
    //     (実際に音を欠落させる本物の故障。欠音カウンタ検出用)。
    // 「測定経路への既知の200ms遅延」は、この _queuedSamples/tick報告(=main.tsの
    // フレームペース調整が実際に読む値)を触ると本物の再生挙動まで変えてしまうため、
    // ワーカー側ではなく AudioEngine 側(JS側ログへ積む直前)でだけオフセットを足す
    // (faultDelayReportSec 参照)。
    if (AUDIO_QUEUE_PROBE) {
      this._probeUnderflow = 0;
      this._probeTrimEvents = 0;
      this._probeDropped = 0;
      this._faultDropChunkPending = false;
    }
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
      if (AUDIO_QUEUE_PROBE && chunk && chunk.t === 'resetQueueProbe') {
        this._probeUnderflow = 0;
        this._probeTrimEvents = 0;
        this._probeDropped = 0;
        return;
      }
      if (AUDIO_QUEUE_PROBE && chunk && chunk.t === 'fault-drop-chunk') {
        this._faultDropChunkPending = true;
        return;
      }
      if (chunk && chunk.length) {
        if (AUDIO_QUEUE_PROBE && this._faultDropChunkPending) {
          // 実際に1チャンク分の音を欠落させる(欠音カウンタ検出用の実故障)。
          this._faultDropChunkPending = false;
          this._probeDropped += chunk.length / 2;
          return;
        }
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
    if (AUDIO_QUEUE_PROBE) this._probeTrimEvents++;
    const target = TARGET_LATENCY_SEC * sampleRate;
    while (this._queue.length > 1 && this._queuedSamples > target) {
      const head = this._queue[0];
      const remain = (head.length - this._readOffset) / 2;
      if (this._queuedSamples - remain < target) break;
      this._queue.shift();
      this._readOffset = 0;
      this._queuedSamples -= remain;
      if (AUDIO_QUEUE_PROBE) this._probeDropped += remain;
    }
  }

  process(_inputs, outputs) {
    // 4ブロック(約11.6ms)ごとにメインスレッドへ tick を送る。
    // タブ非表示で rAF/setTimeout がスロットルされてもオーディオスレッドは
    // 止まらないため、これがエミュレーション駆動のフォールバックになる。
    // 併せて現在のキュー滞留量(秒)を返し、メインスレッド側のフレーム供給ペース調整に使う。
    this._blockCount = (this._blockCount ?? 0) + 1;
    if (this._blockCount % 4 === 0) {
      const msg = { t: 'tick', q: this._queuedSamples / sampleRate };
      if (AUDIO_QUEUE_PROBE) {
        msg.u = this._probeUnderflow;
        msg.x = this._probeTrimEvents;
        msg.d = this._probeDropped;
      }
      this.port.postMessage(msg);
    }

    const output = outputs[0];
    const left = output[0];
    const right = output[1] ?? output[0];
    const frames = left.length;

    for (let i = 0; i < frames; i++) {
      if (this._queue.length === 0) {
        if (AUDIO_QUEUE_PROBE) this._probeUnderflow++;
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

/** AudioWorklet内キュープローブの1標本(dev限定、計測計画「音声遅延」(1)用)。 */
export interface AudioQueueProbeSample {
  /** ページ内 performance.now() (ms)。tickメッセージを受け取った時刻。 */
  tMs: number;
  /** AudioWorklet内の未再生キュー滞留量(秒)。fault-delay-report注入時はオフセット込み。 */
  qSec: number;
  /** resetQueueProbe以降の累積underflowフレーム数(キューが空だったフレーム)。 */
  underflow: number;
  /** resetQueueProbe以降の累積trim発生回数(上限超過で間引きが走った回数)。 */
  trimEvents: number;
  /** resetQueueProbe以降の累積破棄サンプル数(trimまたはfault-drop-chunkによる)。 */
  dropped: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private tickCb: (() => void) | null = null;
  private queuedSec = 0;
  // dev限定のキュープローブ。startQueueProbe()中だけ配列へ積む(通常運用時のメモリ増を防ぐ)。
  private queueProbeActive = false;
  private queueProbeLog: AudioQueueProbeSample[] = [];
  // dev限定・計測専用の故障注入(測定経路への既知の200ms遅延)。queuedSec(=main.tsの
  // フレームペース調整が読む実値)には一切足さず、ログへ積む値にだけ加算する。
  private faultDelayOffsetSec = 0;

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
        // 実際のペース調整(main.tsのloop()がqueuedSecondsを読む)に使う値は生のまま。
        // faultDelayOffsetSecはここでは足さない(足すと本物の再生挙動まで変わってしまう)。
        this.queuedSec = e.data.q ?? 0;
        if (import.meta.env.DEV && this.queueProbeActive) {
          this.queueProbeLog.push({
            tMs: performance.now(),
            // 計測経路の故障注入(faultDelayReportSec)はログへ積む値にだけ加算する。
            qSec: (e.data.q ?? 0) + this.faultDelayOffsetSec,
            underflow: e.data.u ?? 0,
            trimEvents: e.data.x ?? 0,
            dropped: e.data.d ?? 0,
          });
        }
        this.tickCb?.();
      }
    };
    node.connect(ctx.destination);
    this.ctx = ctx;
    this.node = node;
  }

  /**
   * dev限定。AudioWorklet内キュープローブ(計測計画「音声遅延」(1))の採取を開始する。
   * ワーカー側カウンタをresetQueueProbeでリセットし、以後のtickをJS側でも時系列として
   * 貯め始める。measure-audio.mjs がscreen越しに呼ぶ想定で、通常運用では呼ばれない
   * (呼ばれない限りqueueProbeLogへは積まないため、通常運用のメモリ増はない)。
   */
  startQueueProbe(): void {
    if (!import.meta.env.DEV) return;
    this.queueProbeLog = [];
    this.queueProbeActive = true;
    this.node?.port.postMessage({ t: 'resetQueueProbe' });
  }

  /** dev限定。採取を止め、これまでの時系列を返す(呼び出し後もログ配列は保持したまま)。 */
  stopQueueProbe(): AudioQueueProbeSample[] {
    this.queueProbeActive = false;
    return this.queueProbeLog;
  }

  /** dev限定。現在までの時系列を止めずに読む(BEEP区間の途中経過確認等に使う)。 */
  readQueueProbeLog(): AudioQueueProbeSample[] {
    return this.queueProbeLog;
  }

  /**
   * dev限定・計測専用の故障注入。次に到着する1チャンクをAudioWorklet側で丸ごと捨てる
   * (実際に音を欠落させ、droppedカウンタが検出できることを確認するための注入)。
   * measure-audio.mjs の --fault=drop-chunk からのみ呼ばれる想定。
   */
  faultDropNextChunk(): void {
    if (!import.meta.env.DEV) return;
    this.node?.port.postMessage({ t: 'fault-drop-chunk' });
  }

  /**
   * dev限定・計測専用の故障注入。以後startQueueProbeのログへ積むqSecへ固定オフセットを
   * 加算する。queuedSec(main.tsのフレームペース調整が実際に読む値)やAudioWorkletの
   * 実キュー・オーディオ経路には一切触れず、「測定経路」(ログの記録値)だけをずらす
   * (計測計画「音声遅延」の検証項目「測定経路へ既知の200ms遅延」に対応)。
   * 当初はワーカー側のtick報告そのものにオフセットを乗せていたが、その値はmain.tsの
   * 実ペース調整にも使われているため、本物の再生挙動まで変えてしまい200ms注入で
   * 実測129ms程度しか動かないという誤りが判明した(フィードバックで一部相殺されていた)。
   * ログ専用の値にだけ足す方式へ直した。
   * measure-audio.mjs の --fault=delay-200ms からのみ呼ばれる想定。0を渡すと解除する。
   */
  faultDelayReportSec(sec: number): void {
    if (!import.meta.env.DEV) return;
    this.faultDelayOffsetSec = sec;
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
