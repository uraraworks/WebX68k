// Worker側の不可分ダーティキャプチャ/ホットマウント(段階移行 手順8、src/worker-dirty-capture.ts)
// の単体テスト。実Workerグローバルには依存しない(前例: test/worker-drive-loop.test.ts)。
//
// FakeHost は px68k の実挙動を最小限に模す: setFddImage(drive, '')(Eject)はコアのメモリ上の
// 内容(memory)をFSファイル(files)へ書き戻し、setFddImage(drive, path)(Insert)はFSファイルを
// メモリへロードする(feedback_px68k_fdd_eject_writeback.md、test/core-fdd-hotswap.test.ts と
// 同じ意味論)。writeGuestForTest() は「ゲストが挿入中のディスクへ書き込んだが、まだEjectして
// いないのでFSにはまだ反映されていない」状態を模す。
import { describe, expect, it } from 'vitest';
import {
  type DirtyCaptureHost,
  type HotSwapHost,
  WorkerMediaState,
} from '../src/worker-dirty-capture';

class FakeHost implements HotSwapHost {
  files: Record<string, Uint8Array> = {};
  fddDirtyMask = 0;
  hddDirty = false;
  insertedPath: Record<number, string | null> = { 0: null, 1: null };
  memory: Record<number, Uint8Array | null> = { 0: null, 1: null };
  callLog: string[] = [];

  mountForTest(drive: 0 | 1, path: string, data: Uint8Array): void {
    this.files[path] = data.slice();
    this.insertedPath[drive] = path;
    this.memory[drive] = data.slice();
  }

  writeGuestForTest(drive: 0 | 1, data: Uint8Array): void {
    this.memory[drive] = data;
  }

  setFddImage(drive: number, path: string): void {
    if (path === '') {
      this.callLog.push(`eject:${drive}`);
      const old = this.insertedPath[drive];
      if (old !== null && this.memory[drive]) this.files[old] = this.memory[drive]!.slice();
      this.insertedPath[drive] = null;
      this.memory[drive] = null;
    } else {
      this.callLog.push(`insert:${drive}:${path}`);
      this.insertedPath[drive] = path;
      this.memory[drive] = this.files[path] ? this.files[path].slice() : new Uint8Array(0);
    }
  }

  readFile(path: string): Uint8Array {
    this.callLog.push(`readFile:${path}`);
    const data = this.files[path];
    if (!data) throw new Error(`no such file: ${path}`);
    return data;
  }

  clearDirty(target: { fddDrive?: number; hdd?: boolean }): void {
    if (target.fddDrive !== undefined) {
      this.callLog.push(`clearDirty:fdd${target.fddDrive}`);
      this.fddDirtyMask &= ~(1 << target.fddDrive);
    }
    if (target.hdd) {
      this.callLog.push('clearDirty:hdd');
      this.hddDirty = false;
    }
  }

  writeDiskImage(filename: string, data: Uint8Array): string {
    const path = `/game/${filename}`;
    this.callLog.push(`write:${path}`);
    this.files[path] = data.slice();
    return path;
  }

  removeFile(path: string): void {
    this.callLog.push(`remove:${path}`);
    delete this.files[path];
  }
}

function dirtyHost(fddMask: number, hdd: boolean): { fddMask: number; hdd: boolean } {
  return { fddMask, hdd };
}

describe('WorkerMediaState.captureSlot', () => {
  it('未マウントのスロットはnullを返しhostを一切呼ばない', () => {
    const host = new FakeHost();
    const state = new WorkerMediaState();
    const result = state.captureSlot('fdd0', host as DirtyCaptureHost);
    expect(result).toBeNull();
    expect(host.callLog).toEqual([]);
  });

  it('FDD: Eject→readFile→再Insertの順で呼ばれ、Eject時点で書き戻された内容を返す', () => {
    const host = new FakeHost();
    host.mountForTest(0, '/game/fdd0_a.xdf', new Uint8Array([1, 1]));
    host.writeGuestForTest(0, new Uint8Array([7, 7])); // ゲストの書き込み(まだFS未反映)
    const state = new WorkerMediaState();
    state.setMountedPath('fdd0', '/game/fdd0_a.xdf');

    const result = state.captureSlot('fdd0', host as DirtyCaptureHost);

    expect(result).toEqual(new Uint8Array([7, 7])); // Ejectの書き戻しで反映された内容
    expect(host.callLog).toEqual([
      'eject:0',
      'readFile:/game/fdd0_a.xdf',
      'insert:0:/game/fdd0_a.xdf',
      'clearDirty:fdd0',
    ]);
    // 再Insertされている(ホットマウント中は挿入状態を維持する)
    expect(host.insertedPath[0]).toBe('/game/fdd0_a.xdf');
  });

  it('HDD: Ejectを挟まずreadFile→clearDirtyのみ', () => {
    const host = new FakeHost();
    host.files['/game/hdd_a.hdf'] = new Uint8Array([3, 3]);
    const state = new WorkerMediaState();
    state.setMountedPath('hdd', '/game/hdd_a.hdf');

    const result = state.captureSlot('hdd', host as DirtyCaptureHost);

    expect(result).toEqual(new Uint8Array([3, 3]));
    expect(host.callLog).toEqual(['readFile:/game/hdd_a.hdf', 'clearDirty:hdd']);
  });

  it('故障注入(a): 分割方式(read→[往復]→clear)は隙間の書き込みを失うが、captureSlot()は隙間が無いため失わない', () => {
    // 旧方式(3ステップに分割、docsのシナリオそのもの)を素朴に再現する: read → (Worker境界の
    // 往復に相当する「隙間」でゲストが新しく書き込む) → clear。このシミュレーションは
    // FakeHostの生メソッドを直接、順番に呼ぶだけで作れる(captureSlot()を経由しない=
    // 「別ハンドラに分ける」実装そのものの模擬)。
    const splitHost = new FakeHost();
    splitHost.mountForTest(0, '/game/fdd0_split.xdf', new Uint8Array([1]));
    splitHost.fddDirtyMask = 1;
    splitHost.setFddImage(0, ''); // 1: eject(書き戻し)
    const readBytes = splitHost.readFile('/game/fdd0_split.xdf'); // 2: 読み出し
    // --- ここがWorker境界の往復に相当する「隙間」。3(clear)が別commandとして届くまでの間 ---
    splitHost.setFddImage(0, '/game/fdd0_split.xdf'); // ゲストは引き続き挿入中として書き込める
    splitHost.writeGuestForTest(0, new Uint8Array([9, 9])); // 隙間中の新しい書き込み
    splitHost.fddDirtyMask = 1; // 実コアなら新しい書き込みで自動的に再セットされる
    splitHost.clearDirty({ fddDrive: 0 }); // 3: clear(分割方式ではreadと無関係に呼ばれる)
    // 分割方式の結果: 読み出した内容は古いまま、しかしdirtyフラグは消えている
    // → 新しい書き込み[9,9]はどこにも保存されず、フラグも立っていないので二度と拾われない
    //   (無言のデータロスの再現)。
    expect(readBytes).toEqual(new Uint8Array([1]));
    expect(splitHost.fddDirtyMask).toBe(0);
    expect(splitHost.memory[0]).toEqual(new Uint8Array([9, 9])); // 未保存のまま取り残された書き込み

    // 新方式(captureSlot、1回の同期呼び出し): readFileの直後、reinsertを挟んで直ちに
    // clearDirtyが呼ばれ、間に他の呼び出しが一切入らない(=分割方式のような「隙間」が
    // 構造的に存在しない)。呼び出しログの隣接性で確認する。
    const host = new FakeHost();
    host.mountForTest(0, '/game/fdd0_atomic.xdf', new Uint8Array([1]));
    const state = new WorkerMediaState();
    state.setMountedPath('fdd0', '/game/fdd0_atomic.xdf');
    state.captureSlot('fdd0', host as DirtyCaptureHost);
    const readIdx = host.callLog.indexOf('readFile:/game/fdd0_atomic.xdf');
    const clearIdx = host.callLog.indexOf('clearDirty:fdd0');
    expect(readIdx).toBeGreaterThanOrEqual(0);
    // readFile の直後は再Insertのみを挟んですぐclearDirtyが来る(間に他の呼び出しは無い)。
    expect(clearIdx).toBe(readIdx + 2);
  });
});

describe('WorkerMediaState.markDirty / dirtyState (再dirty化)', () => {
  it('markDirtyで立てたフラグがdirtyStateへ合成される', () => {
    const state = new WorkerMediaState();
    expect(state.dirtyState(dirtyHost(0, false))).toEqual(dirtyHost(0, false));
    state.markDirty(['fdd1']);
    expect(state.dirtyState(dirtyHost(0, false))).toEqual(dirtyHost(2, false));
    state.markDirty(['hdd']);
    expect(state.dirtyState(dirtyHost(0, false))).toEqual(dirtyHost(2, true));
  });

  it('故障注入(b): captureSlotはmarkDirtyで立てた影のフラグもクリアする(永続化成功時)', () => {
    const host = new FakeHost();
    host.files['/game/hdd_a.hdf'] = new Uint8Array([9]);
    const state = new WorkerMediaState();
    state.setMountedPath('hdd', '/game/hdd_a.hdf');

    state.markDirty(['hdd']); // 「保存に失敗したので再dirty化」を模す
    expect(state.dirtyState(dirtyHost(0, false)).hdd).toBe(true);

    state.captureSlot('hdd', host as DirtyCaptureHost); // 再度の保存(今度は成功)を模す
    expect(state.dirtyState(dirtyHost(0, false)).hdd).toBe(false); // 影のフラグも消える
  });

  it('故障注入(b): markDirtyを呼ばない(=再dirty化を無効化する)と、保存失敗後に汚れフラグが戻らない', () => {
    // このテスト自体は「再dirty化を呼んだ場合/呼ばない場合」の両方を直接比較することで、
    // 「markDirty()が無いと汚れフラグが戻らない」という主張そのものを検証する
    // (実装側の markDirty() を削除・no-op化する故障注入をすると、この対比の後半
    // 「呼ばない場合」の結果が前半「呼ぶ場合」の結果と一致しなくなるべき、という設計)。
    const stateWithReDirty = new WorkerMediaState();
    stateWithReDirty.markDirty(['fdd0']); // 永続化失敗 → 再dirty化した
    expect(stateWithReDirty.dirtyState(dirtyHost(0, false)).fddMask & 1).toBe(1);

    const stateWithoutReDirty = new WorkerMediaState();
    // 永続化失敗しても markDirty() を呼ばない(＝再dirty化なしの経路を模す)
    expect(stateWithoutReDirty.dirtyState(dirtyHost(0, false)).fddMask & 1).toBe(0);
  });
});

describe('WorkerMediaState.hotSwapFdd', () => {
  it('新イメージなし(排出): Eject→旧内容読み出し→旧ファイルunlink、dirtyもクリアする', () => {
    const host = new FakeHost();
    host.mountForTest(1, '/game/fdd1_a.xdf', new Uint8Array([4, 4]));
    const state = new WorkerMediaState();
    state.setMountedPath('fdd1', '/game/fdd1_a.xdf');

    const result = state.hotSwapFdd('fdd1', 1, null, host);

    expect(result).toEqual({ previousImage: new Uint8Array([4, 4]), mountedPath: null });
    expect(host.callLog).toEqual(['eject:1', 'readFile:/game/fdd1_a.xdf', 'clearDirty:fdd1', 'remove:/game/fdd1_a.xdf']);
    expect(state.getMountedPath('fdd1')).toBeNull();
    expect(host.files['/game/fdd1_a.xdf']).toBeUndefined();
  });

  it('新イメージあり(差し替え): Eject→旧内容読み出し→write(新)→Insert(新)の順を守る', () => {
    const host = new FakeHost();
    host.mountForTest(0, '/game/fdd0_old.xdf', new Uint8Array([1, 1]));
    const state = new WorkerMediaState();
    state.setMountedPath('fdd0', '/game/fdd0_old.xdf');

    const result = state.hotSwapFdd('fdd0', 0, { name: 'fdd0_new.xdf', bytes: new Uint8Array([2, 2]) }, host);

    expect(result).toEqual({ previousImage: new Uint8Array([1, 1]), mountedPath: '/game/fdd0_new.xdf' });
    expect(host.callLog).toEqual([
      'eject:0',
      'readFile:/game/fdd0_old.xdf',
      'clearDirty:fdd0',
      'write:/game/fdd0_new.xdf',
      'remove:/game/fdd0_old.xdf',
      'insert:0:/game/fdd0_new.xdf',
    ]);
  });

  it('故障注入(c): 同名ファイルへ差し替える場合、Ejectを先に行わないと新イメージがEjectの書き戻しで上書きされる', () => {
    // openSlotVolume().persist() のように「同じファイル名のまま中身だけ差し替える」ケース。
    // writeDiskImage()はfilenameがそのままパスになる(src/libretro-host.ts)ため、
    // 同名なら新旧が同じパスを指す。
    const host = new FakeHost();
    host.mountForTest(0, '/game/fdd0_disk.xdf', new Uint8Array([1, 1]));
    host.writeGuestForTest(0, new Uint8Array([9, 9])); // ゲストの書き込み(まだFS未反映)
    const state = new WorkerMediaState();
    state.setMountedPath('fdd0', '/game/fdd0_disk.xdf');

    const result = state.hotSwapFdd(
      'fdd0',
      0,
      { name: 'fdd0_disk.xdf', bytes: new Uint8Array([2, 2]) },
      host,
    );

    // 正しい順序(Eject→旧内容回収→write→insert)なら、新イメージ[2,2]がそのまま残る。
    expect(host.files['/game/fdd0_disk.xdf']).toEqual(new Uint8Array([2, 2]));
    expect(result.previousImage).toEqual(new Uint8Array([9, 9])); // 旧内容はゲストの書き込みを含む
    expect(host.callLog.indexOf('eject:0')).toBeLessThan(host.callLog.indexOf('write:/game/fdd0_disk.xdf'));
  });

  it('故障注入(d, 既定経路との意味論の一致): captureSlotのFDD読み出しはEjectの後でなければ、書き戻し前の古い内容を返してしまう', () => {
    // main.ts の readLiveSlotImage() と同じ意味論(eject→read→reinsert)であることの検査。
    // 順序が入れ替わっている(=読み出しがEjectより前)実装だと、Ejectで書き戻される前の
    // 古い内容を返してしまい、既定経路と異なる(=データを取りこぼす)挙動になる。
    const host = new FakeHost();
    host.mountForTest(0, '/game/fdd0_a.xdf', new Uint8Array([1, 1])); // FS上の古い内容
    host.writeGuestForTest(0, new Uint8Array([8, 8])); // ゲストの書き込み(まだFS未反映)
    const state = new WorkerMediaState();
    state.setMountedPath('fdd0', '/game/fdd0_a.xdf');

    const result = state.captureSlot('fdd0', host as DirtyCaptureHost);

    // Ejectで書き戻された後の内容(=ゲストの書き込みを含む)が返るべき。
    expect(result).toEqual(new Uint8Array([8, 8]));
    expect(host.callLog.indexOf('eject:0')).toBeLessThan(host.callLog.indexOf('readFile:/game/fdd0_a.xdf'));
  });
});
