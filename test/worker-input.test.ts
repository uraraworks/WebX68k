// WorkerInputState / MainInputSnapshot (src/worker-input.ts) のテスト。
// 段階移行 手順6「入力」の核である、Worker側の世代付きclearと差分適用、および main側の
// 入力スナップショット(加算値mouseDelta・追加注入分keyMakesのtake()後クリアを含む)の
// 純粋ロジックを検証する。
//
// 陽性対照(規律: 故障注入で検査が効いていることを確認する)は本ファイルの末尾に記録する。
// 一時的に実装を壊し、対応するテストが実際に red になることを確認してから元に戻した
// (2026-08-31、実装時に確認済み)。
//
// 訂正(2026-08-31、コーディネータ指摘): 当初「main 側の mouseDelta ゼロクリアを外す」
// 故障注入を実施したつもりで別物(Worker側WorkerInputStateの世代クリア削除)を注入していた。
// MainInputSnapshotをmain.ts(src/worker-input.ts参照)へ切り出した今回、指示どおりの
// 故障注入(b1)(b2)をこのファイル末尾に追加し直した。
import { describe, expect, it } from 'vitest';
import type { InputUpdate } from '../src/core-protocol';
import { computeShouldAcceptGuestKeyInput, MainInputSnapshot, WorkerInputState, type InputHost } from '../src/worker-input';

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

  it('2回目の適用でkeysの差分だけが反映される(観測後に離されたキーはreleaseされる)', () => {
    const state = new WorkerInputState();
    const host = new FakeInputHost();

    state.apply(makeUpdate({ keys: [1, 2] }), host);
    // 実運用ではこの間にtick()が少なくとも1回retro_run()を回してから次のInputUpdateが
    // 届く(confirmObservedFrame()参照)。ここでも同じ順序を再現する。
    state.confirmObservedFrame(host);
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

// apply()の戻り値(changed): 2026-08-31三訂正(「break側の帰属が壊れている」の修正、
// docs/STORAGE-SCSI.md参照)。src/core-worker.tsはこの戻り値を使って、帰属計測用の
// 「実際に適用された瞬間のframeNo」を、内容の変わらない連続送信では上書きしないように
// している。frame event契機の毎フレーム送信(ゲームパッド未接続・マウス未操作なら内容不変)が
// 継続する中でも、実際に意味のある変化(keydown/keyup/keyMake/pads/mouseButtons/mouseDelta)
// があった呼び出しだけがtrueを返すことを検証する。
describe('WorkerInputState.apply の戻り値(changed)', () => {
  it('keyの押下/解放を伴う適用はtrueを返す', () => {
    const state = new WorkerInputState();
    const host = new FakeInputHost();
    expect(state.apply(makeUpdate({ keys: [1] }), host)).toBe(true);
    // makeがretro_run()に観測されるまでreleaseは遅延される(「make/breakの潰れ」対策)ので、
    // 実運用と同じくconfirmObservedFrame()を挟んでから release する。
    state.confirmObservedFrame(host);
    expect(state.apply(makeUpdate({ keys: [] }), host)).toBe(true); // 1のrelease
  });

  it('前回と全く同じ内容(keys/pads/mouseButtons/mouseDelta=0/0/keyMakes=空)の適用はfalseを返す(sticky維持の土台)', () => {
    const state = new WorkerInputState();
    const host = new FakeInputHost();
    // 1回目: keyの押下を含むので当然true。
    expect(state.apply(makeUpdate({ keys: [1], pads: [3, 4] }), host)).toBe(true);
    // 2回目以降: frame event契機の毎フレーム送信を模して、内容が完全に同じupdateを
    // 繰り返し適用しても、何も変わっていないのでfalseになる
    // (これがcore-worker.tsのlastInputApplyFrameNoを上書きしない根拠になる)。
    expect(state.apply(makeUpdate({ keys: [1], pads: [3, 4] }), host)).toBe(false);
    expect(state.apply(makeUpdate({ keys: [1], pads: [3, 4] }), host)).toBe(false);
    expect(state.apply(makeUpdate({ keys: [1], pads: [3, 4] }), host)).toBe(false);
  });

  it('padsの値が変化した適用はtrueを返す', () => {
    const state = new WorkerInputState();
    const host = new FakeInputHost();
    expect(state.apply(makeUpdate({ pads: [0, 0] }), host)).toBe(false); // 初期値と同じ(0,0)
    expect(state.apply(makeUpdate({ pads: [1, 0] }), host)).toBe(true);
    expect(state.apply(makeUpdate({ pads: [1, 0] }), host)).toBe(false); // 変化なし
  });

  it('mouseButtonsの値が変化した適用はtrueを返す', () => {
    const state = new WorkerInputState();
    const host = new FakeInputHost();
    expect(state.apply(makeUpdate({ mouseButtons: { left: false, right: false } }), host)).toBe(false);
    expect(state.apply(makeUpdate({ mouseButtons: { left: true, right: false } }), host)).toBe(true);
    expect(state.apply(makeUpdate({ mouseButtons: { left: true, right: false } }), host)).toBe(false);
  });

  it('mouseDeltaが非ゼロの適用はtrueを返す(0/0はfalse)', () => {
    const state = new WorkerInputState();
    const host = new FakeInputHost();
    expect(state.apply(makeUpdate({ mouseDelta: { dx: 0, dy: 0 } }), host)).toBe(false);
    expect(state.apply(makeUpdate({ mouseDelta: { dx: 1, dy: 0 } }), host)).toBe(true);
  });

  it('keyMakesを含む適用はtrueを返す(押下状態自体は変わらなくても)', () => {
    const state = new WorkerInputState();
    const host = new FakeInputHost();
    expect(state.apply(makeUpdate({ keyMakes: [10] }), host)).toBe(true);
  });

  it('世代が上がる更新(クリアを伴う)はtrueを返す。古い世代は無視されfalseを返す', () => {
    const state = new WorkerInputState();
    const host = new FakeInputHost();
    expect(state.apply(makeUpdate({ keys: [1], inputGeneration: 1 }), host)).toBe(true);
    expect(state.apply(makeUpdate({ keys: [1], inputGeneration: 0 }), host)).toBe(false); // 古い世代
  });

  it('本題の再現: makeで一度trueを返した後、内容不変の連続送信を挟んでbreak(release)が来ても、真ん中の連続送信はfalseのまま(coreworkerのstickyを壊さない)', () => {
    // 実際の欠陥は、frame event契機の毎フレーム送信(内容不変)が「適用された」と
    // 誤カウントされ続け、帰属計測の基準時刻(applyFrameNo)がbreakの書き込み検出より
    // 先に進んでしまうことだった。この再現テストは、make→(不変送信×N)→breakという
    // 実際の時系列で、不変送信の区間だけがfalseになる(=core-worker.tsがsticky値を
    // 保ったままになる)ことを保証する。
    const state = new WorkerInputState();
    const host = new FakeInputHost();

    // make: keydown相当
    expect(state.apply(makeUpdate({ keys: [1] }), host)).toBe(true);

    // 保持中: frame event契機の毎フレーム送信(内容は直前と完全に同じ)が何度も挟まる。
    for (let i = 0; i < 5; i++) {
      expect(state.apply(makeUpdate({ keys: [1] }), host)).toBe(false);
    }
    // 保持している間にretro_run()が実際に走っている(実運用ではtick()のたびに起きる)。
    state.confirmObservedFrame(host);

    // break: keyup相当
    expect(state.apply(makeUpdate({ keys: [] }), host)).toBe(true);

    // break後もさらに不変送信が続く。
    for (let i = 0; i < 3; i++) {
      expect(state.apply(makeUpdate({ keys: [] }), host)).toBe(false);
    }
  });
});

// make/breakの潰れ対策(2026-09-01実測、_local/measure/wm-20260901-drives-worker*.json)。
// 決定9(離散イベントの即時送信)により、main→Workerはkeydown/keyup発生時点でそれぞれ
// 別々のInputUpdateメッセージとして即座に送られる。Worker側の駆動ループ(setInterval)は
// これと非同期に走るため、make・breakの両方が「実際にretro_run()がコアの入力状態を
// ポーリングする前」に届いて適用されてしまうと、コアは一度もそのキーの押下を観測できず、
// 打鍵1文字が丸ごと消える(実機で`dir a:`が`dr a:`等になる不具合の再現)。
// 対策: confirmObservedFrame()(実際にretro_run()が走った直後にだけ呼ばれる)より前に
// 来たreleaseは、host.setKey(false)を遅延し、押されたままの状態をhostに維持する。
describe('WorkerInputState: make/breakの潰れ対策(confirmObservedFrame)', () => {
  it('makeの直後にconfirmObservedFrame前でbreakが来ても、hostはtrueのまま維持される(押下が消えない)', () => {
    const state = new WorkerInputState();
    const host = new FakeInputHost();

    // keydown
    state.apply(makeUpdate({ keys: [1] }), host);
    expect(host.keyState).toEqual(new Set([1]));

    // retro_run()が1回も走らないうちにkeyup(実機で観測された競合の再現)。
    const changed = state.apply(makeUpdate({ keys: [] }), host);
    // hostへのrelease適用そのものは保留されるので、この時点ではまだtrueのまま。
    expect(host.keyState).toEqual(new Set([1]));
    expect(changed).toBe(false); // host状態は変わっていない(release自体は保留中)。

    // confirmObservedFrame前: readyだったcurrentAppliedKeysはtrueを維持している。
    expect(state.currentAppliedKeys).toEqual(new Set([1]));
  });

  it('confirmObservedFrame()の呼び出しで、保留中のreleaseが初めて実際に適用される', () => {
    const state = new WorkerInputState();
    const host = new FakeInputHost();

    state.apply(makeUpdate({ keys: [1] }), host);
    state.apply(makeUpdate({ keys: [] }), host); // 保留
    expect(host.keyState).toEqual(new Set([1]));

    const changed = state.confirmObservedFrame(host);

    expect(changed).toBe(true);
    expect(host.keyState).toEqual(new Set());
    expect(host.calls).toContain('setKey(1,false)');
    expect(state.currentAppliedKeys).toEqual(new Set());
  });

  it('confirmObservedFrame前にmake→break→make(再押下)が来ても二重にpressされない', () => {
    const state = new WorkerInputState();
    const host = new FakeInputHost();

    state.apply(makeUpdate({ keys: [1] }), host); // make
    host.calls = [];
    state.apply(makeUpdate({ keys: [] }), host); // release保留
    state.apply(makeUpdate({ keys: [1] }), host); // 保留中に再度make

    // setKey(1,true)は最初の1回だけで、この間に追加のsetKey呼び出しは発生しない
    // (release保留の撤回・再pressともsetKeyを一切叩かない。setJoyState/setMouseButtonは
    // apply()が値の変化に関わらず毎回呼ぶ既存仕様なので対象外)。
    expect(host.calls.filter((c) => c.startsWith('setKey'))).toEqual([]);
    expect(host.keyState).toEqual(new Set([1]));

    // confirmObservedFrame()が来ても、release要求は撤回済みなので何も起きない。
    const changed = state.confirmObservedFrame(host);
    expect(changed).toBe(false);
    expect(host.keyState).toEqual(new Set([1]));
  });

  it('観測済み(confirmObservedFrame後)のキーは、従来どおり即座にreleaseされる(退行検知)', () => {
    const state = new WorkerInputState();
    const host = new FakeInputHost();

    state.apply(makeUpdate({ keys: [1] }), host);
    state.confirmObservedFrame(host); // 観測済みにする
    host.calls = [];

    const changed = state.apply(makeUpdate({ keys: [] }), host);

    expect(changed).toBe(true);
    expect(host.calls.filter((c) => c.startsWith('setKey'))).toEqual(['setKey(1,false)']);
    expect(host.keyState).toEqual(new Set());
  });

  it('世代が上がるクリアは、保留中のreleaseがあっても確実にreleaseする', () => {
    const state = new WorkerInputState();
    const host = new FakeInputHost();

    state.apply(makeUpdate({ keys: [1] }), host);
    state.apply(makeUpdate({ keys: [] }), host); // release保留のまま
    host.calls = [];

    state.apply(makeUpdate({ keys: [], inputGeneration: 1 }), host); // blur等の世代クリア

    expect(host.calls).toContain('setKey(1,false)');
    expect(host.keyState).toEqual(new Set());
    // クリア後にconfirmObservedFrame()を呼んでも何も起きない(保留は残っていない)。
    expect(state.confirmObservedFrame(host)).toBe(false);
  });

  // 陽性対照(故障注入): apply()の release 遅延(unobservedDownKeys判定)を外すと、
  // 1番目のテストが red になることを実装時に確認した(2026-09-01)。
  // 具体的には、apply()内の `if (this.unobservedDownKeys.has(retrok)) { ... continue; }`
  // ブロックを削除し常に host.setKey(retrok, false) を呼ぶように戻すと、
  // 「makeの直後にconfirmObservedFrame前でbreakが来ても、hostはtrueのまま維持される」が
  // `expect(host.keyState).toEqual(new Set([1]))` で失敗し(実際は空集合になる)、
  // 症状(make/breakの潰れ)そのものを検出できることを確認済み。確認後は元に戻し、
  // git diff が空であることも確認した。
});

describe('MainInputSnapshot', () => {
  it('take()の戻り値に、その時点のkeys/pads/mouseButtons/mouseDelta/keyMakes/generationが載る', () => {
    const snap = new MainInputSnapshot();
    snap.key(1, true);
    snap.key(2, true);
    snap.joyState(0, 5);
    snap.joyState(1, 6);
    snap.mouseButton('left', true);
    snap.mouseDelta(3, -4);
    snap.keyMake(9);

    const update = snap.take();
    expect(update).toEqual({
      keys: [1, 2],
      pads: [5, 6],
      mouseButtons: { left: true, right: false },
      mouseDelta: { dx: 3, dy: -4 },
      inputGeneration: 0,
      keyMakes: [9],
    });
  });

  it('take()後、mouseDeltaは0/0に戻る(コーディネータ指摘: 加算値のゼロクリアの検査)', () => {
    const snap = new MainInputSnapshot();
    snap.mouseDelta(10, 20);
    snap.take();

    const second = snap.take();
    expect(second.mouseDelta).toEqual({ dx: 0, dy: 0 });
  });

  it('take()後、keyMakesは空になる', () => {
    const snap = new MainInputSnapshot();
    snap.keyMake(1);
    snap.keyMake(2);
    snap.take();

    const second = snap.take();
    expect(second.keyMakes).toEqual([]);
  });

  it('take()はkeys/pads/mouseButtons/generationを変化させない(状態であって加算値ではないため)', () => {
    const snap = new MainInputSnapshot();
    snap.key(1, true);
    snap.joyState(0, 7);
    snap.mouseButton('right', true);

    const first = snap.take();
    const second = snap.take();

    expect(second.keys).toEqual(first.keys);
    expect(second.pads).toEqual(first.pads);
    expect(second.mouseButtons).toEqual(first.mouseButtons);
    expect(second.inputGeneration).toBe(first.inputGeneration);
    expect(second.keys).toEqual([1]);
    expect(second.pads).toEqual([7, 0]);
    expect(second.mouseButtons).toEqual({ left: false, right: true });
  });

  it('mouseDelta()を複数回呼ぶとtake()までは加算される', () => {
    const snap = new MainInputSnapshot();
    snap.mouseDelta(1, 2);
    snap.mouseDelta(3, 4);
    snap.mouseDelta(-1, 0);

    const update = snap.take();
    expect(update.mouseDelta).toEqual({ dx: 3, dy: 6 });
  });

  it('bumpGeneration()でgenerationが+1され、keys/pads/buttons/delta/keyMakesがすべて初期状態に戻る', () => {
    const snap = new MainInputSnapshot();
    snap.key(1, true);
    snap.joyState(0, 5);
    snap.joyState(1, 6);
    snap.mouseButton('left', true);
    snap.mouseButton('right', true);
    snap.mouseDelta(9, 9);
    snap.keyMake(3);
    expect(snap.currentGeneration).toBe(0);

    snap.bumpGeneration();

    expect(snap.currentGeneration).toBe(1);
    const update = snap.take();
    expect(update).toEqual({
      keys: [],
      pads: [0, 0],
      mouseButtons: { left: false, right: false },
      mouseDelta: { dx: 0, dy: 0 },
      inputGeneration: 1,
      keyMakes: [],
    });
  });
});

describe('computeShouldAcceptGuestKeyInput', () => {
  // 実ブラウザ確認(2026-08-31、コーディネータ実測)で見つかった欠陥の回帰検査。
  // src/main.ts の物理キーボードkeydownハンドラは、既定経路が生まれた当時からの
  // `!host` ガードをそのまま残していたため、Worker経路(host は常にnull)では
  // 物理キーボード入力が一度もapplyKeyへ届いていなかった(単体テスト567件はこの故障を
  // 1件も検出できなかった)。docs/STORAGE-SCSI.md「ワーカー移行 手順6」の
  // 「実ブラウザ確認で見つかった欠陥」参照。

  it('既定経路(urlWorkerMode=false)はhostPresentだけで判定する(既存の判定条件を維持)', () => {
    expect(
      computeShouldAcceptGuestKeyInput({ urlWorkerMode: false, running: false, hostPresent: true }),
    ).toBe(true);
    expect(
      computeShouldAcceptGuestKeyInput({ urlWorkerMode: false, running: true, hostPresent: false }),
    ).toBe(false);
  });

  it('Worker経路(urlWorkerMode=true)はrunningだけで判定する(host===nullでもtrueになる)', () => {
    expect(
      computeShouldAcceptGuestKeyInput({ urlWorkerMode: true, running: true, hostPresent: false }),
    ).toBe(true);
    expect(
      computeShouldAcceptGuestKeyInput({ urlWorkerMode: true, running: false, hostPresent: false }),
    ).toBe(false);
  });
});

// --- 陽性対照(故障注入)の記録 -------------------------------------------------
//
// 実施した4件(実装時に一時的に注入し、red になることを確認してから元に戻した):
//
// (a) Worker側(WorkerInputState)の世代チェックを外す:
//     `if (update.inputGeneration < this.generation) return;` を削除すると、
//     「古い世代の更新は丸ごと無視される」テストが red になった
//     (host.calls が [] ではなくなり、host.pads が [7,7] に書き換わってしまう)。
//
// (b') Worker側(WorkerInputState)の世代が上がる際のクリア呼び出し(this.clear(host))を
//     外す: 「世代が上がる更新は、適用前にコア入力状態を完全クリアしてから適用する」
//     テストが red になった(setKey(1,false)/setKey(2,false)/clearMouseState()が
//     一切呼ばれず、indexOf が -1 を返しテストが失敗する)。
//     訂正: この(b')は当初「指示された(b)」として報告したが、実際に指示されていたのは
//     下の(b1)であり別物だった(コーディネータ指摘、2026-08-31)。(b')自体は
//     WorkerInputStateの正当な検査として有効なので残すが、(b)の番号は使わない。
//
// (b1) main側(MainInputSnapshot)のtake()内、mouseDeltaのゼロクリア
//     (`this.mouseDeltaX = 0; this.mouseDeltaY = 0;`)を削除すると、
//     「take()後、mouseDeltaは0/0に戻る」テストが red になった
//     (2回目のtake()が{dx:10,dy:20}を返し、期待値{dx:0,dy:0}と食い違った)。
//
// (b2) main側(MainInputSnapshot)のtake()内、keyMakesのクリア(`this.keyMakes = [];`)を
//     削除すると、「take()後、keyMakesは空になる」テストが red になった
//     (2回目のtake()が[1,2]を返し、期待値[]と食い違った)。

//
// (c) `computeShouldAcceptGuestKeyInput()`を、実ブラウザで見つかった欠陥の再現として
//     `return opts.hostPresent;`(urlWorkerModeを無視し、常にhost基準で判定する旧実装)へ
//     一時的に書き換えると、「Worker経路(urlWorkerMode=true)はrunningだけで判定する」
//     テストが red になった(urlWorkerMode:true, running:true, hostPresent:false の
//     組み合わせで期待値trueに対しfalseが返り、この故障を検出できることを確認した)。
