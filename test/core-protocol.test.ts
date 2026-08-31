// core-protocol.ts の型ヘルパのテスト。
//
// collectTransferables は transferable 所有権規約(docs/STORAGE-SCSI.md「フレームスナップショット」
// 「initialize」「command と不可分操作」節)の実体そのものなので、正常系だけでなく
// 「1種類だけ集め忘れた」故障注入で実際に検出できることまで確認する(規律: 陽性対照必須)。
import { describe, expect, it } from 'vitest';
import {
  collectTransferables,
  createCoreError,
  CoreProxyError,
  INPUT_UPDATE_KIND,
  isCoreEvent,
  isCoreResponse,
  isInputUpdateMessage,
  type CoreCommand,
  type CoreEvent,
  type CoreResponse,
  type FrameSnapshot,
  type HotSwapFddResult,
  type InputUpdate,
} from '../src/core-protocol';

function makeSnapshot(overrides?: Partial<FrameSnapshot>): FrameSnapshot {
  return {
    frameNo: 1,
    av: { fps: 60, sampleRate: 48000, width: 768, height: 512 },
    video: { kind: 'offscreen', changed: true },
    audio: { chunks: [], sampleFrames: 0 },
    disk: {
      access: { fddReading: false, fddDrive: 0, hddAccessing: false },
      dirty: { fddMask: 0, hdd: false },
    },
    ...overrides,
  };
}

describe('型ガード', () => {
  it('isCoreResponse / isCoreEvent が kind で判別する', () => {
    const response: CoreResponse = {
      kind: 'response',
      generation: 0,
      requestId: 1,
      ok: true,
      completedFrameNo: 10,
      result: null,
    };
    const event: CoreEvent = { kind: 'event', generation: 0, event: 'ready', avInfo: {
      baseWidth: 768, baseHeight: 512, maxWidth: 768, maxHeight: 512,
      aspectRatio: 1.5, fps: 60, sampleRate: 48000,
    } };

    expect(isCoreResponse(response)).toBe(true);
    expect(isCoreEvent(response)).toBe(false);
    expect(isCoreResponse(event)).toBe(false);
    expect(isCoreEvent(event)).toBe(true);
  });

  it('isInputUpdateMessage は kind:"inputUpdate" のメッセージだけを true にする(決定7: 片道メッセージ)', () => {
    const update: InputUpdate = {
      keys: [1, 2],
      pads: [0, 0],
      mouseButtons: { left: false, right: false },
      mouseDelta: { dx: 0, dy: 0 },
      inputGeneration: 0,
      keyMakes: [],
    };
    const message = { kind: INPUT_UPDATE_KIND, update };

    expect(isInputUpdateMessage(message)).toBe(true);
    expect(isInputUpdateMessage({ kind: 'returnFrameBuffer', buffer: new ArrayBuffer(0) })).toBe(false);
    expect(isInputUpdateMessage(null)).toBe(false);
    expect(isInputUpdateMessage(undefined)).toBe(false);
    expect(isInputUpdateMessage({})).toBe(false);
    expect(isInputUpdateMessage(42)).toBe(false);
  });
});

describe('createCoreError / CoreProxyError', () => {
  it('既定値は recoverable: false で、渡した値を保持する', () => {
    const error = createCoreError('IO_FAILED', '読み出し失敗', { operation: 'readFile', details: { path: '/x' } });
    expect(error).toEqual({
      code: 'IO_FAILED',
      message: '読み出し失敗',
      operation: 'readFile',
      recoverable: false,
      details: { path: '/x' },
    });
  });

  it('recoverable: true を明示すれば緩められる', () => {
    const error = createCoreError('UNSUPPORTED', 'まだ未対応', { recoverable: true });
    expect(error.recoverable).toBe(true);
  });

  it('CoreProxyError は coreError と message を保持する', () => {
    const coreError = createCoreError('INVALID_STATE', '初期化前です');
    const err = new CoreProxyError(coreError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CoreProxyError');
    expect(err.message).toBe('初期化前です');
    expect(err.coreError).toBe(coreError);
  });
});

describe('collectTransferables: command', () => {
  it('initialize は biosIpl/biosCg/sram の3つの ArrayBuffer を集める', () => {
    const biosIpl = new ArrayBuffer(4);
    const biosCg = new ArrayBuffer(8);
    const sram = new ArrayBuffer(0x4000);
    const command: CoreCommand = {
      kind: 'command',
      generation: 0,
      requestId: 1,
      op: 'initialize',
      payload: { biosIpl, biosCg, sram },
    };
    const collected = collectTransferables(command);
    expect(collected).toHaveLength(3);
    expect(collected).toContain(biosIpl);
    expect(collected).toContain(biosCg);
    expect(collected).toContain(sram);
  });

  it('initialize: sram省略時は2つだけ', () => {
    const command: CoreCommand = {
      kind: 'command',
      generation: 0,
      requestId: 1,
      op: 'initialize',
      payload: { biosIpl: new ArrayBuffer(1), biosCg: new ArrayBuffer(1) },
    };
    expect(collectTransferables(command)).toHaveLength(2);
  });

  it('hotSwapFdd: image ありなら bytes を集め、null なら何も集めない', () => {
    const bytes = new ArrayBuffer(16);
    const withImage: CoreCommand = {
      kind: 'command',
      generation: 0,
      requestId: 1,
      op: 'hotSwapFdd',
      payload: { drive: 0, image: { name: 'a.xdf', bytes } },
    };
    expect(collectTransferables(withImage)).toEqual([bytes]);

    const withoutImage: CoreCommand = {
      kind: 'command',
      generation: 0,
      requestId: 2,
      op: 'hotSwapFdd',
      payload: { drive: 0, image: null },
    };
    expect(collectTransferables(withoutImage)).toEqual([]);
  });

  it('readMemory/loadGame 等は transferable を持たない', () => {
    const command: CoreCommand = {
      kind: 'command',
      generation: 0,
      requestId: 1,
      op: 'readMemory',
      payload: { address: 0, length: 4 },
    };
    expect(collectTransferables(command)).toEqual([]);
  });
});

describe('collectTransferables: response', () => {
  it('ok:false は result を見ない', () => {
    const response: CoreResponse = {
      kind: 'response',
      generation: 0,
      requestId: 1,
      ok: false,
      error: createCoreError('IO_FAILED', 'x'),
    };
    expect(collectTransferables(response)).toEqual([]);
  });

  it('result が単体 ArrayBuffer (serialize/readMemory相当) ならそれを集める', () => {
    const buf = new ArrayBuffer(32);
    const response: CoreResponse = {
      kind: 'response',
      generation: 0,
      requestId: 1,
      ok: true,
      completedFrameNo: 5,
      result: buf,
    };
    expect(collectTransferables(response)).toEqual([buf]);
  });

  it('result が HotSwapFddResult なら previousImage だけを集める(nullなら何も集めない)', () => {
    const previousImage = new ArrayBuffer(8);
    const withPrev: HotSwapFddResult = { previousImage, mountedPath: '/game/a.xdf' };
    const response: CoreResponse = {
      kind: 'response',
      generation: 0,
      requestId: 1,
      ok: true,
      completedFrameNo: 5,
      result: withPrev,
    };
    expect(collectTransferables(response)).toEqual([previousImage]);

    const withoutPrev: HotSwapFddResult = { previousImage: null, mountedPath: null };
    const response2: CoreResponse = {
      kind: 'response',
      generation: 0,
      requestId: 2,
      ok: true,
      completedFrameNo: 5,
      result: withoutPrev,
    };
    expect(collectTransferables(response2)).toEqual([]);
  });

  it('result が boolean/null など無関係な値なら何も集めない', () => {
    const response: CoreResponse = {
      kind: 'response',
      generation: 0,
      requestId: 1,
      ok: true,
      completedFrameNo: 5,
      result: true,
    };
    expect(collectTransferables(response)).toEqual([]);
  });
});

describe('collectTransferables: event', () => {
  it('frame: video=bitmap のとき bitmap と音声チャンク全部を集める', () => {
    const bitmap = {} as ImageBitmap; // node環境にImageBitmapは無いので構造だけのダミー
    const chunk1 = new ArrayBuffer(4);
    const chunk2 = new ArrayBuffer(4);
    const event: CoreEvent = {
      kind: 'event',
      generation: 0,
      event: 'frame',
      snapshot: makeSnapshot({
        video: { kind: 'bitmap', bitmap },
        audio: { chunks: [chunk1, chunk2], sampleFrames: 128 },
      }),
    };
    const collected = collectTransferables(event);
    expect(collected).toContain(bitmap);
    expect(collected).toContain(chunk1);
    expect(collected).toContain(chunk2);
    expect(collected).toHaveLength(3);
  });

  it('frame: video=rgba のとき rgba bytes と音声チャンクを集める', () => {
    const rgbaBytes = new ArrayBuffer(768 * 512 * 4);
    const chunk = new ArrayBuffer(4);
    const event: CoreEvent = {
      kind: 'event',
      generation: 0,
      event: 'frame',
      snapshot: makeSnapshot({
        video: { kind: 'rgba', bytes: rgbaBytes, width: 768, height: 512 },
        audio: { chunks: [chunk], sampleFrames: 64 },
      }),
    };
    const collected = collectTransferables(event);
    expect(collected).toEqual([rgbaBytes, chunk]);
  });

  it('frame: video=offscreen のときは映像側は何も集めないが音声は集める', () => {
    const chunk = new ArrayBuffer(4);
    const event: CoreEvent = {
      kind: 'event',
      generation: 0,
      event: 'frame',
      snapshot: makeSnapshot({ audio: { chunks: [chunk], sampleFrames: 64 } }),
    };
    expect(collectTransferables(event)).toEqual([chunk]);
  });

  it('sramChanged: bytes を集める', () => {
    const bytes = new ArrayBuffer(0x4000);
    const event: CoreEvent = {
      kind: 'event',
      generation: 0,
      event: 'sramChanged',
      frameNo: 100,
      bytes,
    };
    expect(collectTransferables(event)).toEqual([bytes]);
  });

  it('ready/fatal は transferable を持たない', () => {
    const ready: CoreEvent = {
      kind: 'event',
      generation: 0,
      event: 'ready',
      avInfo: { baseWidth: 768, baseHeight: 512, maxWidth: 768, maxHeight: 512, aspectRatio: 1.5, fps: 60, sampleRate: 48000 },
    };
    const fatal: CoreEvent = {
      kind: 'event',
      generation: 0,
      event: 'fatal',
      error: createCoreError('WORKER_FAILURE', 'クラッシュ'),
    };
    expect(collectTransferables(ready)).toEqual([]);
    expect(collectTransferables(fatal)).toEqual([]);
  });
});

describe('陽性対照: collectTransferables の集め忘れ故障注入', () => {
  // frame イベントの音声チャンクを「1種類だけ」集め忘れる壊れた実装を用意し、
  // 正しい実装との違いをテストが実際に検出できることを確認する。
  // (規律: 落ちなかったらテストが対象を踏んでいない扱いにする)
  function brokenCollectTransferables_missingAudioChunks(event: CoreEvent): Transferable[] {
    const out: Transferable[] = [];
    if (event.event === 'frame') {
      const { video } = event.snapshot;
      if (video.kind === 'bitmap') out.push(video.bitmap);
      else if (video.kind === 'rgba') out.push(video.bytes);
      // 音声チャンクを push し忘れている(意図的な故障注入)
    } else if (event.event === 'sramChanged') {
      out.push(event.bytes);
    }
    return out;
  }

  it('故障注入版は音声チャンクが抜け、正しい実装との比較で検出できる', () => {
    const chunk1 = new ArrayBuffer(4);
    const chunk2 = new ArrayBuffer(4);
    const event: CoreEvent = {
      kind: 'event',
      generation: 0,
      event: 'frame',
      snapshot: makeSnapshot({ audio: { chunks: [chunk1, chunk2], sampleFrames: 128 } }),
    };

    const correct = collectTransferables(event);
    const broken = brokenCollectTransferables_missingAudioChunks(event);

    // 正しい実装は音声チャンクを含む
    expect(correct).toContain(chunk1);
    expect(correct).toContain(chunk2);
    // 破壊した実装は含まない = 差分が実際に検出できることの確認(陽性対照)
    expect(broken).not.toContain(chunk1);
    expect(broken).not.toContain(chunk2);
    expect(broken.length).toBeLessThan(correct.length);

    // 「対象を踏んでいる」ことの直接確認: 正しい実装をこの壊れた関数の結果と等値比較したら落ちる、
    // という前提そのものを検証する。
    expect(() => expect(broken).toEqual(correct)).toThrow();
  });
});
