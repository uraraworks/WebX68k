export const SERIAL_BAUD_STORAGE_KEY = 'webx68k.serial.baudRate';
export const DEFAULT_SERIAL_BAUD_RATE = 38400;
export const SERIAL_BAUD_RATES = [2400, 4800, 9600, 19200, 38400, 57600, 115200] as const;

export type SerialConfig = {
  baudRate: number;
};

export type SerialConnectionState =
  | 'unsupported'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export interface SerialReaderLike {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
  cancel(): Promise<void>;
  releaseLock(): void;
}

export interface SerialWriterLike {
  write(data: Uint8Array): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

export interface SerialPortLike {
  readable: { getReader(): SerialReaderLike } | null;
  writable: { getWriter(): SerialWriterLike } | null;
  open(options: {
    baudRate: number;
    dataBits: 8;
    stopBits: 1;
    parity: 'none';
    flowControl: 'none';
  }): Promise<void>;
  close(): Promise<void>;
}

export interface SerialApiLike {
  requestPort(): Promise<SerialPortLike>;
  addEventListener?(
    type: 'disconnect',
    listener: (event: { port: SerialPortLike }) => void,
  ): void;
}

function browserSerial(): SerialApiLike | null {
  if (typeof navigator === 'undefined' || !('serial' in navigator)) return null;
  return (navigator as Navigator & { serial: SerialApiLike }).serial;
}

export function loadSerialBaudRate(storage?: Pick<Storage, 'getItem'>): number {
  try {
    const source = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    const value = Number(source?.getItem(SERIAL_BAUD_STORAGE_KEY));
    return SERIAL_BAUD_RATES.includes(value as (typeof SERIAL_BAUD_RATES)[number])
      ? value
      : DEFAULT_SERIAL_BAUD_RATE;
  } catch {
    return DEFAULT_SERIAL_BAUD_RATE;
  }
}

export function saveSerialBaudRate(
  baudRate: number,
  storage?: Pick<Storage, 'setItem'>,
): void {
  if (!SERIAL_BAUD_RATES.includes(baudRate as (typeof SERIAL_BAUD_RATES)[number])) return;
  try {
    const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    target?.setItem(SERIAL_BAUD_STORAGE_KEY, String(baudRate));
  } catch {
    // ブラウザストレージが利用できない環境では、保存せずメモリ上の設定だけを使用する。
  }
}

/**
 * Web Serialポートの所有者。
 *
 * ホスト側(main.ts)はこのクラスをモジュール単一インスタンスとして生成する前提で書かれている。
 * - `receiveWaiter` は1枠しか持たないため、readLoopが同時に2本走る構成では待機が取りこぼされる。
 * - コンストラクタで登録する `disconnect` リスナーは解除しないため、インスタンスを増やすと
 *   `navigator.serial` 上にリスナーが積み上がる。
 * 複数インスタンスが必要になった場合は、待機キューとリスナー解除を先に用意すること。
 */
export class WebSerialTransport {
  private readonly serial: SerialApiLike | null;
  private port: SerialPortLike | null = null;
  private reader: SerialReaderLike | null = null;
  private writer: SerialWriterLike | null = null;
  private readTask: Promise<void> | null = null;
  private writeTask: Promise<void> | null = null;
  private receiveWaiter: (() => void) | null = null;
  private receiveGeneration = 0;
  private connectionGeneration = 0;
  private disconnectTask: Promise<void> | null = null;
  private currentState: SerialConnectionState;

  onData?: (bytes: Uint8Array) => number;
  onStateChange?: (state: SerialConnectionState) => void;

  constructor(serial: SerialApiLike | null = browserSerial()) {
    this.serial = serial;
    this.currentState = serial ? 'disconnected' : 'unsupported';
    serial?.addEventListener?.('disconnect', (event) => {
      if (event.port === this.port) void this.disconnect();
    });
  }

  isSupported(): boolean {
    return this.serial !== null;
  }

  get state(): SerialConnectionState {
    return this.currentState;
  }

  get canWrite(): boolean {
    return this.currentState === 'connected' && this.port !== null && this.writeTask === null;
  }

  notifyReceiveCapacity(): void {
    const waiter = this.receiveWaiter;
    this.receiveWaiter = null;
    waiter?.();
  }

  discardPendingReceive(): void {
    this.receiveGeneration++;
    this.notifyReceiveCapacity();
  }

  async connect(config: SerialConfig): Promise<void> {
    if (!this.serial) {
      this.setState('unsupported');
      throw new Error('Web Serial API is not supported');
    }
    if (this.currentState === 'connected') return;
    if (this.currentState === 'connecting') throw new Error('Serial connection is already in progress');

    const generation = ++this.connectionGeneration;
    this.setState('connecting');
    let port: SerialPortLike | null = null;
    try {
      // 接続先を取り違えないよう、許可済みポートが1個でも毎回ユーザーに選択してもらう。
      port = await this.serial.requestPort();
      if (generation !== this.connectionGeneration) {
        await port.close().catch(() => undefined);
        return;
      }
      this.port = port;
      await port.open({
        baudRate: config.baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
      });
      if (generation !== this.connectionGeneration || this.port !== port) {
        if (this.port === port) this.port = null;
        await port.close().catch(() => undefined);
        return;
      }
      this.setState('connected');
      this.readTask = this.readLoop(port, generation);
    } catch (error) {
      if (this.port === port) this.port = null;
      if (port) await port.close().catch(() => undefined);
      if (generation !== this.connectionGeneration) return;
      if (this.isPortSelectionCanceled(error)) {
        this.setState('disconnected');
        return;
      }
      this.setState('error');
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.disconnectTask) return this.disconnectTask;
    const task = this.disconnectInternal();
    this.disconnectTask = task;
    try {
      await task;
    } finally {
      if (this.disconnectTask === task) this.disconnectTask = null;
    }
  }

  private async disconnectInternal(): Promise<void> {
    const wasConnecting = this.currentState === 'connecting';
    ++this.connectionGeneration;
    this.notifyReceiveCapacity();
    const port = this.port;
    this.port = null;
    if (!port) {
      if (this.currentState !== 'unsupported') this.setState('disconnected');
      return;
    }

    try {
      await Promise.resolve().then(() => this.reader?.cancel()).catch(() => undefined);
      await this.readTask?.catch(() => undefined);
      await Promise.resolve()
        .then(() => this.writer?.abort?.(new Error('Serial connection is disconnecting')))
        .catch(() => undefined);
      await this.writeTask?.catch(() => undefined);
      // connect() 中の切断では、その generation ガード側が open 完了後にポートを閉じる。
      if (!wasConnecting) await port.close().catch(() => undefined);
    } finally {
      this.reader = null;
      this.writer = null;
      this.readTask = null;
      this.setState('disconnected');
    }
  }

  write(bytes: Uint8Array): Promise<void> {
    const port = this.port;
    if (!port || this.currentState !== 'connected') {
      return Promise.reject(new Error('Serial port is not connected'));
    }
    if (this.writeTask) {
      return Promise.reject(new Error('A serial write is already in progress'));
    }
    // 呼び出し元が書き込み完了まで不変のバッファを渡す前提で、余分なコピーを避ける。
    const generation = this.connectionGeneration;
    const task = (async () => {
      let writer: SerialWriterLike | null = null;
      try {
        if (this.port !== port || !port.writable) throw new Error('Serial port is not writable');
        writer = port.writable.getWriter();
        this.writer = writer;
        try {
          await writer.write(bytes);
        } finally {
          // ポートを閉じる前にwriterのロックを必ず解放する。
          writer.releaseLock();
          if (this.writer === writer) this.writer = null;
          writer = null;
        }
      } catch (error) {
        // 容量待ちで止まっている readLoop を起こしてから待たないと、下の await が返らない。
        this.notifyReceiveCapacity();
        await this.failConnection(port, generation, 'write');
        throw error;
      }
    })();
    this.writeTask = task;
    void task
      .finally(() => {
        if (this.writeTask === task) this.writeTask = null;
      })
      .catch(() => undefined);
    return task;
  }

  private async readLoop(port: SerialPortLike, generation: number): Promise<void> {
    let failed = false;
    try {
      const readable = port.readable;
      if (!readable) return;
      const reader = readable.getReader();
      this.reader = reader;
      try {
        while (this.port === port) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length > 0) {
            const bytes = value.slice();
            let offset = 0;
            const receiveGeneration = this.receiveGeneration;
            while (offset < bytes.length && this.port === port && generation === this.connectionGeneration &&
                   receiveGeneration === this.receiveGeneration) {
              const remaining = bytes.length - offset;
              const accepted = Math.max(0, Math.min(remaining, this.onData?.(bytes.subarray(offset)) ?? remaining));
              offset += accepted;
              if (offset < bytes.length) await this.waitForReceiveCapacity(port, generation);
            }
          }
        }
      } finally {
        if (this.reader === reader) this.reader = null;
        reader.releaseLock();
      }
    } catch {
      failed = true;
    } finally {
      await this.failConnection(port, generation, 'read', failed ? 'error' : 'disconnected');
    }
  }

  private waitForReceiveCapacity(port: SerialPortLike, generation: number): Promise<void> {
    if (this.port !== port || generation !== this.connectionGeneration) return Promise.resolve();
    return new Promise((resolve) => {
      this.receiveWaiter = resolve;
    });
  }

  /**
   * 失敗した接続を後始末する。
   *
   * `origin` は「どちらのタスクから呼ばれたか」で、自分自身を await して止まらないために必要。
   * read側の失敗では送信中のwriterをabortして writeTask の決着まで待つ。writer/readerの
   * ロックが残ったままだと port.close() が拒否され、ポートが開いたまま回収できなくなる。
   */
  private async failConnection(
    port: SerialPortLike,
    generation: number,
    origin: 'read' | 'write',
    state: SerialConnectionState = 'error',
  ): Promise<void> {
    if (this.port !== port || this.connectionGeneration !== generation) return;

    const cleanupGeneration = ++this.connectionGeneration;
    this.port = null;
    await Promise.resolve().then(() => this.reader?.cancel()).catch(() => undefined);
    if (origin === 'write') {
      // 呼び出し元は writeTask 自身なので、待つのは readTask だけ。
      await this.readTask?.catch(() => undefined);
    } else {
      // 呼び出し元は readTask 自身なので、待つのは writeTask だけ。
      await Promise.resolve()
        .then(() => this.writer?.abort?.(new Error('Serial connection failed')))
        .catch(() => undefined);
      await this.writeTask?.catch(() => undefined);
    }
    // ここに来た時点で reader/writer のロックは解放済みなので close() が通る。
    await port.close().catch(() => undefined);
    if (this.connectionGeneration !== cleanupGeneration) return;

    this.reader = null;
    this.writer = null;
    this.readTask = null;
    this.setState(state);
  }

  private isPortSelectionCanceled(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const name = (error as { name?: unknown }).name;
    return name === 'NotFoundError' || name === 'AbortError';
  }

  private setState(state: SerialConnectionState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    this.onStateChange?.(state);
  }
}
