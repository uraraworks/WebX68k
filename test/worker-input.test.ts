// WorkerInputState (src/worker-input.ts) のテスト。
// 段階移行 手順6「入力」の核である、世代付きclearと差分適用の純粋ロジックを検証する。
//
// 陽性対照(規律: 故障注入で検査が効いていることを確認する)は本ファイルの末尾に記録する。
// 一時的に実装を壊し、対応するテストが実際に red になることを確認してから元に戻した
// (2026-08-31、実装時に確認済み)。
import { describe, expect, it } from 'vitest';
import type { InputUpdate } from '../src/core-protocol';
import { WorkerInputState, type InputHost } from '../src/worker-input';

/** InputHost を満たす fake。呼び出しをそのまま記録し、setKey の押下集合も再現する。 */
class FakeInputHost implements InputHost {
  calls: string[] = [];
  keyState = new Set<number>();
  pads: [number, number] = [0, 0];
  mouseButtons = { left: false, right: false };
  mouseDeltaCalls: Array<{ dx: number; dy: number }> = [];
  keyMakeCalls: number[] = [];
  clearMouseStateCalls = 0;

  setKey(retrok: number, down: boolean): void {
    this.calls.push(`setKey(${retrok},${down})`);
    if (down) this.keyState.add(retrok);
    else this.keyState.delete(retrok);
  }

  setJoyState(port: number, bits: number): void {
    this.calls.push(`setJoyState(${port},${bits})`);
    this.pads[port as 0 | 1] = bits;
  }

  setMouseButton(button: 'left' | 'right', down: boolean): void {
    this.calls.push(`setMouseButton(${button},${down})`);
    this.mouseButtons[button] = down;
  }

  addMouseDelta(dx: number, dy: number): void {
    this.calls.push(`addMouseDelta(${dx},${dy})`);
    this.mouseDeltaCalls.push({ dx, dy });
  }

  sendKeyMake(retrok: number): void {
    this.calls.push(`sendKeyMake(${retrok})`);
    this.keyMakeCalls.push(retrok);
  }

  clearMouseState(): void {
    this.calls.push('clearMouseState()');
    this.clearMouseStateCalls++;
    this.mouseButtons.left = false;
    this.mouseButtons.right = false;
  }
}

function makeUpdate(overrides?: Partial<InputUpdate>): InputUpdate {
  return {
    keys: [],
    pads: [0, 0],
    mouseButtons: { left: false, right: false },
    mouseDelta: { dx: 0, dy: 0 },
    inputGeneration: 0,
    keyMakes: [],
    ...overrides,
  };
}

describe('WorkerInputState.apply', () => {
  it('keys/pads/mouseButtonsを差分適用する(押されていないキーは押されない)', () => {
    const state = new WorkerInputState();
    const host = new FakeInputHost();

    state.apply(makeUpdate({ keys: [1, 2], pads: [3, 4] }), host);

    expect(host.keyState).toEqual(new Set([1, 2]));
    expect(host.pads).toEqual([3, 4]);
    expect(state.currentAppliedKeys).toEqual(new Set([1, 2]));
  });

  it('2回目の適用でkeysの差分だけが反映される(離されたキーはreleaseされる)', () => {
    const state = new WorkerInputState();
    const host = new FakeInputHost();

    state.apply(makeUpdate({ keys: [1, 2] }), host);
    host.calls = [];
    state.apply(makeUpdate({ keys: [2, 3] }), host);

    // 1(release)・3(press)だけ呼ばれ、2はどちらも呼ばれない(押しっぱなしを維持)。
    expect(host.calls).toContain('setKey(1,false)');
    expect(host.calls).toContain('setKey(3,true)');
    expect(host.calls).not.toContain('setKey(2,true)');
    expect(host.calls).not.toContain('setKey(2,false)');
    expect(host.keyState).toEqual(new Set([2, 3]));
  });

  it('mouseDeltaは加算値としてそのままaddMouseDeltaへ渡す(0/0は呼ばない)', () => {
    const state = new WorkerInputState();
    const host = new FakeInputHost();

    state.apply(makeUpdate({ mouseDelta: { dx: 5, dy: -3 } }), host);
    expect(host.mouseDeltaCalls).toEqual([{ dx: 5, dy: -3 }]);

    host.mouseDeltaCalls = [];
    state.apply(makeUpdate({ mouseDelta: { dx: 0, dy: 0 } }), host);
    expect(host.mouseDeltaCalls).toEqual([]);
  });

  it('keyMakesは押下状態を変えずsendKeyMakeだけを呼ぶ', () => {
    const state = new WorkerInputState();
    const host = new FakeInputHost();

    state.apply(makeUpdate({ keyMakes: [10, 11] }), host);

    expect(host.keyMakeCalls).toEqual([10, 11]);
    expect(host.keyState.size).toBe(0); // keysには入っていないので押下状態は変わらない
  });

  it('同じ世代の更新は古い世代扱いにならず、通常どおり適用される', () => {
    const state = new WorkerInputState();
    const host = new FakeInputHost();

    state.apply(makeUpdate({ keys: [1], inputGeneration: 0 }), host);
    state.apply(makeUpdate({ keys: [1, 2], inputGeneration: 0 }), host);

    expect(host.keyState).toEqual(new Set([1, 2]));
    expect(state.currentGeneration).toBe(0);
  });

  it('古い世代の更新は丸ごと無視される', () => {
    const state = new WorkerInputState();
    const host = new FakeInputHost();

    state.apply(makeUpdate({ keys: [1], inputGeneration: 5 }), host);
    host.calls = [];
    // 世代4(古い)の更新: 何も起きないはず
    state.apply(makeUpdate({ keys: [9, 9, 9].slice(0, 1), pads: [7, 7], inputGeneration: 4 }), host);

    expect(host.calls).toEqual([]);
    expect(host.keyState).toEqual(new Set([1]));
    expect(host.pads).toEqual([0, 0]); // 世代5の更新で立てたpadsのまま(未変更)
    expect(state.currentGeneration).toBe(5);
  });

  it('世代が上がる更新は、適用前にコア入力状態を完全クリアしてから適用する', () => {
    const state = new WorkerInputState();
    const host = new FakeInputHost();

    state.apply(makeUpdate({ keys: [1, 2], pads: [3, 3], mouseButtons: { left: true, right: false } }), host);
    host.calls = [];

    state.apply(makeUpdate({ keys: [9], pads: [0, 0], inputGeneration: 1 }), host);

    // クリア(1,2の release・setJoyState(0,0)/(1,0)・clearMouseState)が、
    // 新しい適用(9のpress)より先に呼ばれていること。
    const clearIdx1 = host.calls.indexOf('setKey(1,false)');
    const clearIdx2 = host.calls.indexOf('setKey(2,false)');
    const clearMouseIdx = host.calls.indexOf('clearMouseState()');
    const applyIdx = host.calls.indexOf('setKey(9,true)');
    expect(clearIdx1).toBeGreaterThanOrEqual(0);
    expect(clearIdx2).toBeGreaterThanOrEqual(0);
    expect(clearMouseIdx).toBeGreaterThanOrEqual(0);
    expect(applyIdx).toBeGreaterThan(clearIdx1);
    expect(applyIdx).toBeGreaterThan(clearIdx2);
    expect(applyIdx).toBeGreaterThan(clearMouseIdx);
    expect(host.clearMouseStateCalls).toBe(1);
    expect(host.keyState).toEqual(new Set([9]));
    expect(state.currentGeneration).toBe(1);
  });

  it('世代が上がる更新のクリアはjoyStateも0へ戻す', () => {
    const state = new WorkerInputState();
    const host = new FakeInputHost();

    state.apply(makeUpdate({ pads: [5, 6] }), host);
    expect(host.pads).toEqual([5, 6]);

    state.apply(makeUpdate({ pads: [0, 0], inputGeneration: 1 }), host);
    // クリアで一旦[0,0]になり、その後の適用でも[0,0]のまま。
    expect(host.pads).toEqual([0, 0]);
  });
});

// --- 陽性対照(故障注入)の記録 -------------------------------------------------
//
// 実施した2件(実装時に一時的に注入し、red になることを確認してから元に戻した):
//
// (a) Worker側の世代チェックを外す:
//     `if (update.inputGeneration < this.generation) return;` を削除すると、
//     「古い世代の更新は丸ごと無視される」テストが red になった
//     (host.calls が [] ではなくなり、host.pads が [7,7] に書き換わってしまう)。
//
// (b) 世代が上がる際のクリア呼び出し(this.clear(host))を削除すると、
//     「世代が上がる更新は、適用前にコア入力状態を完全クリアしてから適用する」テストが
//     red になった(setKey(1,false)/setKey(2,false)/clearMouseState()が一切呼ばれず、
//     indexOf が -1 を返しテストが失敗する)。
