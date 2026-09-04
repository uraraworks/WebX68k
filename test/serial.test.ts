import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SERIAL_BAUD_RATE,
  isSerialBaudRateMismatch,
  loadSerialBaudRate,
  normalizeGuestSerialBaudRate,
  saveSerialBaudRate,
  serialTransmissionDurationMs,
  serialTxPacingChunkSize,
  type SerialApiLike,
  type SerialPortLike,
  type SerialReaderLike,
  type SerialWriterLike,
  WebSerialTransport,
} from '../src/serial';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

class MockReader implements SerialReaderLike {
  private queued: Array<{ value?: Uint8Array; done: boolean }> = [];
  private pending:
    | {
        resolve: (result: { value?: Uint8Array; done: boolean }) => void;
        reject: (error: unknown) => void;
      }
    | undefined;
  cancelCount = 0;
  releaseCount = 0;

  read(): Promise<{ value?: Uint8Array; done: boolean }> {
    const next = this.queued.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  enqueue(value: Uint8Array): void {
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      pending.resolve({ value, done: false });
    } else {
      this.queued.push({ value, done: false });
    }
  }

  fail(error: unknown): void {
    this.pending?.reject(error);
    this.pending = undefined;
  }

  async cancel(): Promise<void> {
    this.cancelCount++;
    this.pending?.resolve({ done: true });
    this.pending = undefined;
  }

  releaseLock(): void {
    this.releaseCount++;
  }
}

function mockConnection(write: (data: Uint8Array) => Promise<void> = async () => undefined): {
  api: SerialApiLike;
  port: SerialPortLike;
  reader: MockReader;
  open: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  writerRelease: ReturnType<typeof vi.fn>;
} {
  const reader = new MockReader();
  const writerRelease = vi.fn();
  const writer: SerialWriterLike = { write, releaseLock: writerRelease };
  const open = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const port: SerialPortLike = {
    readable: { getReader: () => reader },
    writable: { getWriter: () => writer },
    open,
    close,
  };
  const api: SerialApiLike = { requestPort: vi.fn(async () => port) };
  return { api, port, reader, open, close, writerRelease };
}

describe('WebSerialTransport', () => {
  it('reports unsupported browsers without requesting a port', async () => {
    const transport = new WebSerialTransport(null);
    expect(transport.isSupported()).toBe(false);
    expect(transport.state).toBe('unsupported');
    await expect(transport.connect({ baudRate: 38400 })).rejects.toThrow('not supported');
  });

  it('opens a selected port with 8N1 and no flow control', async () => {
    const { api, open } = mockConnection();
    const transport = new WebSerialTransport(api);
    await transport.connect({ baudRate: 38400 });
    expect(transport.state).toBe('connected');
    expect(open).toHaveBeenCalledWith({
      baudRate: 38400,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
    });
    await transport.disconnect();
  });

  it('opens the port picker for every connection attempt', async () => {
    const connection = mockConnection();
    const requestPort = connection.api.requestPort as ReturnType<typeof vi.fn>;
    const transport = new WebSerialTransport(connection.api);
    await transport.connect({ baudRate: 38400 });
    expect(requestPort).toHaveBeenCalledTimes(1);
    expect(connection.open).toHaveBeenCalledTimes(1);
    await transport.disconnect();
  });

  it('delivers received chunks in order', async () => {
    const { api, reader } = mockConnection();
    const transport = new WebSerialTransport(api);
    const received: number[] = [];
    transport.onData = (bytes) => received.push(...bytes);
    await transport.connect({ baudRate: 9600 });
    reader.enqueue(Uint8Array.of(1, 2));
    await settle();
    reader.enqueue(Uint8Array.of(3));
    await settle();
    expect(received).toEqual([1, 2, 3]);
    await transport.disconnect();
  });

  it('holds an unread receive remainder until the core reports capacity', async () => {
    const { api, reader } = mockConnection();
    const transport = new WebSerialTransport(api);
    const received: number[] = [];
    let capacity = 1;
    transport.onData = (bytes) => {
      if (capacity === 0) return 0;
      received.push(bytes[0]);
      capacity--;
      return 1;
    };
    await transport.connect({ baudRate: 115200 });
    reader.enqueue(Uint8Array.of(1, 2, 3));
    await settle();
    expect(received).toEqual([1]);
    capacity = 1;
    transport.notifyReceiveCapacity();
    await settle();
    expect(received).toEqual([1, 2]);
    capacity = 1;
    transport.notifyReceiveCapacity();
    await settle();
    expect(received).toEqual([1, 2, 3]);
    await transport.disconnect();
  });

  it('discards an unread receive remainder when the emulated machine is reset', async () => {
    const { api, reader } = mockConnection();
    const transport = new WebSerialTransport(api);
    const received: number[] = [];
    let capacity = 1;
    transport.onData = (bytes) => {
      if (capacity === 0) return 0;
      received.push(bytes[0]);
      capacity--;
      return 1;
    };
    await transport.connect({ baudRate: 115200 });
    reader.enqueue(Uint8Array.of(1, 2, 3));
    await settle();
    expect(received).toEqual([1]);

    transport.discardPendingReceive();
    await settle();
    capacity = 1;
    reader.enqueue(Uint8Array.of(4));
    await settle();
    expect(received).toEqual([1, 4]);
    await transport.disconnect();
  });

  it('aborts an in-flight write before closing the port when the read loop fails', async () => {
    let rejectWrite: ((error: unknown) => void) | undefined;
    let writerLocked = false;
    let closedCleanly = false;
    const writerRelease = vi.fn(() => {
      writerLocked = false;
    });
    const abort = vi.fn(async (reason?: unknown) => {
      rejectWrite?.(reason ?? new Error('aborted'));
      rejectWrite = undefined;
    });
    const writer: SerialWriterLike = {
      write: () => new Promise<void>((_resolve, reject) => {
        rejectWrite = reject;
      }),
      abort,
      releaseLock: writerRelease,
    };
    const reader = new MockReader();
    // 実ブラウザーと同じく、writableがロックされたままのclose()は失敗させる。
    const close = vi.fn(async () => {
      if (writerLocked) throw new Error('The port is locked to a writer');
      closedCleanly = true;
    });
    const failing: SerialPortLike = {
      readable: { getReader: () => reader },
      writable: {
        getWriter: () => {
          writerLocked = true;
          return writer;
        },
      },
      open: vi.fn(async () => undefined),
      close,
    };
    const recovered = mockConnection();
    const requestPort = vi
      .fn<() => Promise<SerialPortLike>>()
      .mockResolvedValueOnce(failing)
      .mockResolvedValueOnce(recovered.port);
    const transport = new WebSerialTransport({ requestPort });

    await transport.connect({ baudRate: 38400 });
    const pending = transport.write(Uint8Array.of(1));
    const pendingSettled = expect(pending).rejects.toThrow();
    await settle();
    expect(transport.canWrite).toBe(false);

    reader.fail(new Error('read failed'));
    await settle();
    await pendingSettled;

    // abort→releaseLock→close の順序が崩れるとポートが開いたまま残る。
    expect(abort).toHaveBeenCalledTimes(1);
    expect(writerRelease).toHaveBeenCalledTimes(1);
    expect(reader.releaseCount).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(writerRelease.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
    expect(closedCleanly).toBe(true);
    expect(transport.state).toBe('error');

    // 解放しきれていれば同じtransportでそのまま再接続できる。
    await transport.connect({ baudRate: 38400 });
    expect(transport.state).toBe('connected');
    expect(transport.canWrite).toBe(true);
    await transport.write(Uint8Array.of(2));
    await transport.disconnect();
  });

  it('drops the parked receive remainder on machine reset and keeps the port usable', async () => {
    const { api, reader } = mockConnection();
    const transport = new WebSerialTransport(api);
    const received: number[] = [];
    let capacity = 1;
    transport.onData = (bytes) => {
      const accepted = Math.min(capacity, bytes.length);
      for (let i = 0; i < accepted; i++) received.push(bytes[i]);
      capacity -= accepted;
      return accepted;
    };
    await transport.connect({ baudRate: 38400 });
    reader.enqueue(Uint8Array.of(1, 2, 3));
    await settle();
    // 容量が尽きて残り2バイトを保持したまま待機している状態。
    expect(received).toEqual([1]);

    // main.ts のリセット経路(resetSerialBridge)が呼ぶ破棄。以降に容量が空いても
    // リセット前の残りは二度と渡さない。
    transport.discardPendingReceive();
    capacity = 8;
    await settle();
    expect(received).toEqual([1]);
    expect(transport.state).toBe('connected');

    // リセット後に届いたデータはそのまま流れる。
    reader.enqueue(Uint8Array.of(4, 5));
    await settle();
    expect(received).toEqual([1, 4, 5]);
    await transport.disconnect();
  });

  it('allows only one in-flight write and releases the writer lock', async () => {
    const written: number[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { api, writerRelease } = mockConnection(async (bytes) => {
      written.push(bytes[0]);
      if (bytes[0] === 1) await firstGate;
    });
    const transport = new WebSerialTransport(api);
    await transport.connect({ baudRate: 19200 });
    const first = transport.write(Uint8Array.of(1));
    await settle();
    expect(written).toEqual([1]);
    expect(transport.canWrite).toBe(false);
    await expect(transport.write(Uint8Array.of(2))).rejects.toThrow('already in progress');
    releaseFirst();
    await first;
    expect(transport.canWrite).toBe(true);
    expect(writerRelease).toHaveBeenCalledTimes(1);
    await transport.disconnect();
  });

  it('keeps TX unavailable until the selected 8N1 baud duration has elapsed', async () => {
    vi.useFakeTimers();
    try {
      const { api } = mockConnection();
      const transport = new WebSerialTransport(api);
      await transport.connect({ baudRate: 9600 });
      expect(transport.recommendedWriteSize()).toBe(240);

      const pending = transport.write(new Uint8Array(960));
      await vi.advanceTimersByTimeAsync(0);
      expect(transport.canWrite).toBe(false);
      await vi.advanceTimersByTimeAsync(900);
      expect(transport.canWrite).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await pending;
      expect(transport.canWrite).toBe(true);
      await transport.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a long low-baud pacing wait when the port is disconnected', async () => {
    vi.useFakeTimers();
    try {
      const { api } = mockConnection();
      const transport = new WebSerialTransport(api);
      await transport.connect({ baudRate: 300 });
      const pending = transport.write(new Uint8Array(7));
      await vi.advanceTimersByTimeAsync(0);
      expect(transport.canWrite).toBe(false);

      const disconnecting = transport.disconnect();
      await Promise.all([pending, disconnecting]);
      expect(transport.state).toBe('disconnected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up the reader and port when a write fails', async () => {
    const { api, reader, close, writerRelease } = mockConnection(async () => {
      throw new Error('write failed');
    });
    const transport = new WebSerialTransport(api);
    await transport.connect({ baudRate: 38400 });
    await expect(transport.write(Uint8Array.of(1))).rejects.toThrow('write failed');
    expect(reader.cancelCount).toBe(1);
    expect(reader.releaseCount).toBe(1);
    expect(writerRelease).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(writerRelease.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
    expect(transport.state).toBe('error');
  });

  it('cleans up when the writable stream disappears', async () => {
    const { api, port, reader, close } = mockConnection();
    const transport = new WebSerialTransport(api);
    await transport.connect({ baudRate: 38400 });
    port.writable = null;
    await expect(transport.write(Uint8Array.of(1))).rejects.toThrow('not writable');
    expect(reader.cancelCount).toBe(1);
    expect(reader.releaseCount).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(transport.state).toBe('error');
  });

  it('disconnects safely and repeated disconnect is a no-op', async () => {
    const { api, reader, close } = mockConnection();
    const transport = new WebSerialTransport(api);
    await transport.connect({ baudRate: 57600 });
    await transport.disconnect();
    await transport.disconnect();
    expect(reader.cancelCount).toBe(1);
    expect(reader.releaseCount).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(transport.state).toBe('disconnected');
  });

  it('moves to error when the read loop fails', async () => {
    const { api, reader, close } = mockConnection();
    const transport = new WebSerialTransport(api);
    await transport.connect({ baudRate: 115200 });
    reader.fail(new Error('read failed'));
    await settle();
    expect(transport.state).toBe('error');
    expect(reader.releaseCount).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps a canceled connection disconnected when requestPort completes later', async () => {
    let selectPort!: (port: SerialPortLike) => void;
    const requested = new Promise<SerialPortLike>((resolve) => {
      selectPort = resolve;
    });
    const { port, close, open } = mockConnection();
    const transport = new WebSerialTransport({ requestPort: () => requested });
    const connecting = transport.connect({ baudRate: 38400 });
    await transport.disconnect();
    selectPort(port);
    await connecting;
    expect(transport.state).toBe('disconnected');
    expect(open).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes a port when disconnect is requested while open is pending', async () => {
    let finishOpen!: () => void;
    const openGate = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });
    const connection = mockConnection();
    connection.port.open = vi.fn(() => openGate);
    const transport = new WebSerialTransport(connection.api);
    const connecting = transport.connect({ baudRate: 38400 });
    await settle();
    await transport.disconnect();
    finishOpen();
    await connecting;
    expect(transport.state).toBe('disconnected');
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('ignores disconnect events for another port and closes the active port', async () => {
    let listener: ((event: { port: SerialPortLike }) => void) | undefined;
    const connection = mockConnection();
    const other = mockConnection();
    const api: SerialApiLike = {
      requestPort: connection.api.requestPort,
      addEventListener: (_type, callback) => {
        listener = callback;
      },
    };
    const transport = new WebSerialTransport(api);
    await transport.connect({ baudRate: 38400 });
    listener?.({ port: other.port });
    await settle();
    expect(transport.state).toBe('connected');
    listener?.({ port: connection.port });
    await settle();
    expect(transport.state).toBe('disconnected');
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('treats a canceled port picker as disconnected', async () => {
    const canceled = Object.assign(new Error('canceled'), { name: 'NotFoundError' });
    const transport = new WebSerialTransport({
      requestPort: async () => Promise.reject(canceled),
    });
    await transport.connect({ baudRate: 38400 });
    expect(transport.state).toBe('disconnected');
  });

  it('allows retrying after port.open fails', async () => {
    const failed = mockConnection();
    failed.port.open = vi.fn(async () => Promise.reject(new Error('open failed')));
    const recovered = mockConnection();
    const requestPort = vi
      .fn<() => Promise<SerialPortLike>>()
      .mockResolvedValueOnce(failed.port)
      .mockResolvedValueOnce(recovered.port);
    const transport = new WebSerialTransport({ requestPort });
    await expect(transport.connect({ baudRate: 38400 })).rejects.toThrow('open failed');
    expect(transport.state).toBe('error');
    await transport.connect({ baudRate: 38400 });
    expect(transport.state).toBe('connected');
    await transport.disconnect();
  });

  it('rejects writes while disconnected', async () => {
    const { api } = mockConnection();
    const transport = new WebSerialTransport(api);
    await expect(transport.write(Uint8Array.of(1))).rejects.toThrow('not connected');
  });
});

describe('serial baud-rate persistence', () => {
  it('calculates 8N1 transmission time and a bounded 250 ms write chunk', () => {
    expect(serialTransmissionDurationMs(96, 9600)).toBe(100);
    expect(serialTransmissionDurationMs(0, 9600)).toBe(0);
    expect(serialTransmissionDurationMs(96, 0)).toBe(0);
    expect(serialTxPacingChunkSize(300)).toBe(7);
    expect(serialTxPacingChunkSize(9600)).toBe(240);
    expect(serialTxPacingChunkSize(115200)).toBe(2880);
    expect(serialTxPacingChunkSize(230400)).toBe(4096);
  });

  it('normalizes SCC BRG rates and detects only known mismatches', () => {
    expect(normalizeGuestSerialBaudRate(9766)).toBe(9600);
    expect(normalizeGuestSerialBaudRate(39063)).toBe(38400);
    expect(normalizeGuestSerialBaudRate(12345)).toBe(12345);
    expect(normalizeGuestSerialBaudRate(0)).toBeNull();
    expect(isSerialBaudRateMismatch(9600, 9766)).toBe(false);
    expect(isSerialBaudRateMismatch(38400, 9766)).toBe(true);
    expect(isSerialBaudRateMismatch(38400, 0)).toBe(false);
  });

  it('uses 38400 by default and only persists supported values', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(loadSerialBaudRate(storage)).toBe(DEFAULT_SERIAL_BAUD_RATE);
    saveSerialBaudRate(9600, storage);
    expect(loadSerialBaudRate(storage)).toBe(9600);
    saveSerialBaudRate(12345, storage);
    expect(loadSerialBaudRate(storage)).toBe(9600);
  });

  it('falls back safely when browser storage throws', () => {
    expect(loadSerialBaudRate({ getItem: () => { throw new Error('blocked'); } })).toBe(DEFAULT_SERIAL_BAUD_RATE);
    expect(() => saveSerialBaudRate(9600, { setItem: () => { throw new Error('blocked'); } })).not.toThrow();
  });
});
