// AudioWorklet を使ったストリーミング再生。SharedArrayBuffer は使わず、
// メインスレッドから Float32 ステレオチャンクを postMessage でキューに積む方式。

const WORKLET_SOURCE = `
class WebX68kAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._queue = [];
    this._queuedSamples = 0;
    this._readOffset = 0;
    this.port.onmessage = (e) => {
      const chunk = e.data;
      if (chunk && chunk.length) {
        this._queue.push(chunk);
        this._queuedSamples += chunk.length / 2;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] ?? output[0];
    const frames = left.length;

    for (let i = 0; i < frames; i++) {
      if (this._queue.length === 0) {
        left[i] = 0;
        right[i] = 0;
        continue;
      }
      const chunk = this._queue[0];
      left[i] = chunk[this._readOffset];
      right[i] = chunk[this._readOffset + 1];
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

  get context(): AudioContext | null {
    return this.ctx;
  }

  get ready(): boolean {
    return this.node !== null;
  }

  async start(): Promise<void> {
    if (this.ctx) return;
    const ctx = new AudioContext({ sampleRate: 44100 });
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

  suspend(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    void this.ctx?.resume();
  }
}
