import { describe, expect, it, vi } from 'vitest';
import { type PX68KModule, unserializeCoreState } from '../src/libretro-host';

function makeModule(unserializeResults: number[], serializeResult = 1): {
  mod: PX68KModule;
  restored: number[][];
  free: ReturnType<typeof vi.fn>;
} {
  const heap = new Uint8Array(256);
  const restored: number[][] = [];
  const free = vi.fn();
  let nextPointer = 16;
  const mod = {
    HEAPU8: heap,
    _malloc: (size: number) => {
      const pointer = nextPointer;
      nextPointer += size;
      return pointer;
    },
    _free: free,
    _retro_serialize_size: () => 3,
    _retro_serialize: (pointer: number) => {
      heap.set([9, 8, 7], pointer);
      return serializeResult;
    },
    _retro_unserialize: (pointer: number, size: number) => {
      restored.push(Array.from(heap.subarray(pointer, pointer + size)));
      return unserializeResults.shift() ?? 0;
    },
  } as unknown as PX68KModule;
  return { mod, restored, free };
}

describe('LibretroHost unserialize rollback', () => {
  it('loads a valid state without rollback and frees both allocations', () => {
    const { mod, restored, free } = makeModule([1]);
    expect(unserializeCoreState(mod, Uint8Array.of(1, 2, 3, 4))).toBe(true);
    expect(restored).toEqual([[1, 2, 3, 4]]);
    expect(free).toHaveBeenCalledTimes(2);
  });

  it('restores the pre-load snapshot when loading a state fails', () => {
    const { mod, restored, free } = makeModule([0, 1]);
    expect(unserializeCoreState(mod, Uint8Array.of(1, 2, 3, 4))).toBe(false);
    expect(restored).toEqual([[1, 2, 3, 4], [9, 8, 7]]);
    expect(free).toHaveBeenCalledTimes(3);
  });

  it('warns when both the requested load and rollback fail', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { mod } = makeModule([0, 0]);
    expect(unserializeCoreState(mod, Uint8Array.of(1))).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      '[WebX68k] ステートロード失敗後のロールバックにも失敗しました。',
    );
    warn.mockRestore();
  });

  it('does not start loading when a rollback snapshot cannot be created', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { mod, restored, free } = makeModule([1], 0);
    expect(unserializeCoreState(mod, Uint8Array.of(1, 2, 3))).toBe(false);
    expect(restored).toEqual([]);
    expect(free).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[WebX68k] ロールバック用スナップショットを作成できなかったため、ステートロードを中止しました。',
    );
    warn.mockRestore();
  });
});
