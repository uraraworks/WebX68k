import { expect, it, vi } from 'vitest';
import { AudioEngine } from '../src/audio';
import { LibretroHost } from '../src/libretro-host';
import { deliverWorkerAudio } from '../src/worker-audio';
import { createResampleState } from '../src/speed';

it('所有権を渡す場合だけ元の配列を転送する', () => {
  const engine = new AudioEngine();
  const received: Float32Array[] = [];
  (engine as any).node = { port: { postMessage: (value: Float32Array, transfer: ArrayBuffer[]) => received.push(structuredClone(value, { transfer })) } };
  const owned = new Float32Array([1, 2, 3, 4]).subarray(1, 3);
  engine.push(owned, true);
  expect(owned.buffer.byteLength).toBe(0);
  expect([...received[0]]).toEqual([2, 3]);
  const retained = new Float32Array([5, 6]);
  engine.push(retained);
  expect([...retained]).toEqual([5, 6]);
  expect([...received[1]]).toEqual([5, 6]);
});

it('無制限中は変換せず消費数を返し、解除後は新しいサンプルだけ渡す', () => {
  const output: number[][] = [];
  const host = new LibretroHost({ getContext: () => ({}) } as unknown as HTMLCanvasElement, (samples) => output.push([...samples]));
  const heap = new Int16Array([8192, -8192]);
  (host as any).mod = { HEAP16: heap };
  host.audioMuted = true;
  const original = globalThis.Float32Array;
  const allocation = vi.fn(function (this: unknown, ...args: any[]) { return new (original as any)(...args); });
  vi.stubGlobal('Float32Array', allocation);
  try {
    expect((host as any).handleAudioBatch(0, 1)).toBe(1);
    expect(allocation).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
  heap.set([16384, -16384]);
  host.audioMuted = false;
  expect((host as any).handleAudioBatch(0, 1)).toBe(1);
  expect(output).toEqual([[0.5, -0.5]]);
});

it('Worker の複数チャンクをサンプル順に Worklet へ届ける', () => {
  const engine = new AudioEngine();
  const samples: number[] = [];
  (engine as any).node = { port: { postMessage: (chunk: Float32Array, transfer: ArrayBuffer[]) => {
    samples.push(...structuredClone(chunk, { transfer }));
  } } };
  deliverWorkerAudio([new Float32Array([1, 2, 3, 4]).buffer, new Float32Array([5, 6]).buffer], 1, createResampleState(), engine);
  expect(samples).toEqual([1, 2, 3, 4, 5, 6]);
});
