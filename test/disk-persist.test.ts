import { describe, expect, it } from 'vitest';
import { BUNDLED_DISK_SOURCE_KEY, createDiskPersistence, type DiskPersistenceDeps, type PendingDisk } from '../src/disk-persist';

// disk-persist.ts は src/main.ts の persistSlotToLibrary()/flushAllSlots()/restartCore() から
// 切り出したロジック本体(DOM/wasm非依存)。PR #5 で直した不具合(restartCore() が
// flushAllSlots() の直後に古いバイト列で再マウントしてセーブが巻き戻る)の回帰を防ぐための
// テスト。ここでは host/IndexedDB は一切使わず、依存はすべてフェイクで注入する。

type SlotId = 'fdd1';

interface Fake {
  slots: Record<SlotId, PendingDisk | null>;
  saveDiskCalls: Array<{ sourceKey: string; name: string; bytes: Uint8Array; savedAt: number }>;
  clearDirtyCalls: SlotId[];
  onSavedCalls: SlotId[];
  callOrder: string[];
  live: boolean;
  dirty: { fddMask: number; hdd: boolean };
  liveImage: Uint8Array | null;
  saveDiskResolves: boolean; // false: 永久に解決しないPromiseを返す(IndexedDBが遅い場合の再現)
}

function makeDeps(fake: Fake): DiskPersistenceDeps<SlotId> {
  return {
    getSlot: (slot) => fake.slots[slot],
    setSlot: (slot, entry) => {
      fake.callOrder.push(`setSlot:${slot}`);
      fake.slots[slot] = entry;
    },
    isLive: () => fake.live,
    clearDirty: (slot) => {
      fake.callOrder.push(`clearDirty:${slot}`);
      fake.clearDirtyCalls.push(slot);
    },
    readLiveImage: (slot) => {
      fake.callOrder.push(`readLiveImage:${slot}`);
      return fake.liveImage;
    },
    saveDisk: (args) => {
      fake.callOrder.push(`saveDisk:${args.sourceKey}`);
      fake.saveDiskCalls.push(args);
      if (!fake.saveDiskResolves) {
        // IndexedDB が遅い(あるいは書き込み中にページ遷移する)ケースの再現。
        // 永久に解決しない Promise を返す。
        return new Promise<void>(() => {});
      }
      return Promise.resolve();
    },
    readDirtyState: () => fake.dirty,
    fddDriveOf: () => 1,
    onSaved: (slot) => fake.onSavedCalls.push(slot),
    now: () => 12345,
  };
}

function makeFake(overrides: Partial<Fake> = {}): Fake {
  return {
    slots: { fdd1: { name: 'old.xdf', data: new Uint8Array([1, 2, 3]), sourceKey: 'lib:1' } },
    saveDiskCalls: [],
    clearDirtyCalls: [],
    onSavedCalls: [],
    callOrder: [],
    live: true,
    dirty: { fddMask: 0b10, hdd: false },
    liveImage: new Uint8Array([9, 9, 9]),
    saveDiskResolves: true,
    ...overrides,
  };
}

describe('ディスク吸い出しロジック(src/disk-persist.ts)', () => {
  it('【本命】restartWithFlush()は、saveDiskが遅くても再マウント時点で新しいバイト列を見せる', async () => {
    const newBytes = new Uint8Array([7, 7, 7, 7]);
    const fake = makeFake({ liveImage: newBytes, saveDiskResolves: false });
    const persistence = createDiskPersistence(makeDeps(fake), ['fdd1']);

    let captured: PendingDisk | null = null;
    await persistence.restartWithFlush(async () => {
      captured = fake.slots.fdd1;
    });

    expect(captured).not.toBeNull();
    expect(captured!.data).toEqual(newBytes);
  });

  it('吸い出しはclearDirty()の後に行われる', async () => {
    const fake = makeFake();
    const persistence = createDiskPersistence(makeDeps(fake), ['fdd1']);
    await persistence.persistSlot('fdd1');

    const clearIdx = fake.callOrder.indexOf('clearDirty:fdd1');
    const readIdx = fake.callOrder.indexOf('readLiveImage:fdd1');
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(readIdx).toBeGreaterThan(clearIdx);
  });

  it('sourceKey無しのディスクでもスロットへは反映されるが、saveDiskは呼ばれない', async () => {
    const newBytes = new Uint8Array([5, 5, 5]);
    const fake = makeFake({
      slots: { fdd1: { name: 'no-source.xdf', data: new Uint8Array([1]) } },
      liveImage: newBytes,
    });
    const persistence = createDiskPersistence(makeDeps(fake), ['fdd1']);
    const result = await persistence.persistSlot('fdd1');

    expect(result).toBe(false);
    expect(fake.slots.fdd1!.data).toEqual(newBytes);
    expect(fake.saveDiskCalls).toEqual([]);
  });

  it('同梱ディスクはclearDirtyもsaveDiskも呼ばれず、スロットも書き換わらない', async () => {
    const original = { name: 'human302.xdf', data: new Uint8Array([1, 2]), sourceKey: BUNDLED_DISK_SOURCE_KEY };
    const fake = makeFake({
      slots: { fdd1: original },
      liveImage: new Uint8Array([9, 9]),
    });
    const persistence = createDiskPersistence(makeDeps(fake), ['fdd1']);
    const result = await persistence.persistSlot('fdd1');

    expect(result).toBe(false);
    expect(fake.clearDirtyCalls).toEqual([]);
    expect(fake.saveDiskCalls).toEqual([]);
    expect(fake.slots.fdd1).toBe(original);
  });

  it('flushAll()はダーティなスロットだけを対象にする', () => {
    type Slot2 = 'fdd0' | 'fdd1';
    const slots: Record<Slot2, PendingDisk | null> = {
      fdd0: { name: 'a.xdf', data: new Uint8Array([1]), sourceKey: 'lib:a' },
      fdd1: { name: 'b.xdf', data: new Uint8Array([2]), sourceKey: 'lib:b' },
    };
    const persisted: Slot2[] = [];
    const deps: DiskPersistenceDeps<Slot2> = {
      getSlot: (slot) => slots[slot],
      setSlot: (slot, entry) => {
        slots[slot] = entry;
      },
      isLive: () => true,
      clearDirty: () => {},
      readLiveImage: (slot) => {
        persisted.push(slot);
        return new Uint8Array([99]);
      },
      saveDisk: () => Promise.resolve(),
      readDirtyState: () => ({ fddMask: 0b10, hdd: false }), // fdd1(drive1)だけダーティ
      fddDriveOf: (slot) => (slot === 'fdd0' ? 0 : 1),
      now: () => 0,
    };
    const persistence = createDiskPersistence(deps, ['fdd0', 'fdd1']);
    persistence.flushAll();

    expect(persisted).toEqual(['fdd1']);
  });
});
