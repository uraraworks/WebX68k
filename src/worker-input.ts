// Worker側入力適用の純粋ロジック(段階移行 手順6「入力」)。
//
// core-worker.ts 自体は実Workerグローバル(self/OffscreenCanvas/fetch)に依存するため、
// 前例(src/worker-drive-loop.ts、test/core-worker-build-format.test.ts参照)と同様、
// ここではグローバルに依存しない「受信したInputUpdateをコア入力状態へ適用する」部分だけを
// 切り出し、実行可能なテスト対象にする。
//
// docs/STORAGE-SCSI.md「ワーカー移行 手順6」の決定:
// - 世代付きclear: 受信したinputGenerationが保持値より小さければ丸ごと無視する。大きければ、
//   適用前にコア入力状態を先に完全にクリアしてから適用する(押しっぱなし固着の予防)。
// - 加算mouseDelta: host.addMouseDelta()自体が端数繰り越しを持つ(src/libretro-host.ts)ため、
//   ここでは受け取った値をそのまま渡すだけでよい。
// - keyMakes(決定8): 押下状態を変えず、KeyRepeaterのmakeだけを追加で注入する。

import type { InputUpdate } from './core-protocol';

/** LibretroHost が実装する、入力適用に必要な最小の構造型。実 Worker では
 * src/libretro-host.ts の LibretroHost インスタンスをそのまま渡す。 */
export interface InputHost {
  setKey(retrok: number, down: boolean): void;
  setJoyState(port: number, bits: number): void;
  setMouseButton(button: 'left' | 'right', down: boolean): void;
  addMouseDelta(dx: number, dy: number): void;
  sendKeyMake(retrok: number): void;
  /** 積み残しdeltaと両ボタンの押下状態をまとめて捨てる(src/libretro-host.ts参照)。 */
  clearMouseState(): void;
}

/**
 * Worker 側が保持する「最後に適用したコア入力状態」。押下集合(keys)は
 * host.setKey が個別の press/release でしか変更できないため、前回適用した集合との
 * 差分をここで計算して反映する。
 */
export class WorkerInputState {
  private generation = 0;
  private appliedKeys = new Set<number>();

  /** テスト・診断用。 */
  get currentGeneration(): number {
    return this.generation;
  }

  /** テスト・診断用。 */
  get currentAppliedKeys(): ReadonlySet<number> {
    return this.appliedKeys;
  }

  apply(update: InputUpdate, host: InputHost): void {
    if (update.inputGeneration < this.generation) return; // 古い世代は丸ごと無視する。
    if (update.inputGeneration > this.generation) {
      // 世代が上がる更新を適用する前に、コア側の状態を先に完全クリアする(決定「世代付き clear」)。
      this.clear(host);
      this.generation = update.inputGeneration;
    }

    const nextKeys = new Set(update.keys);
    for (const retrok of this.appliedKeys) {
      if (!nextKeys.has(retrok)) host.setKey(retrok, false);
    }
    for (const retrok of nextKeys) {
      if (!this.appliedKeys.has(retrok)) host.setKey(retrok, true);
    }
    this.appliedKeys = nextKeys;

    host.setJoyState(0, update.pads[0]);
    host.setJoyState(1, update.pads[1]);
    host.setMouseButton('left', update.mouseButtons.left);
    host.setMouseButton('right', update.mouseButtons.right);
    // 加算 delta: 同じ世代の mouse delta は受信順に加算する(docs参照)。0/0は呼ばなくてよい。
    if (update.mouseDelta.dx !== 0 || update.mouseDelta.dy !== 0) {
      host.addMouseDelta(update.mouseDelta.dx, update.mouseDelta.dy);
    }
    // KeyRepeaterのmake注入(決定8)。押下状態は変えず、makeだけを追加で送る。
    for (const retrok of update.keyMakes) host.sendKeyMake(retrok);
  }

  private clear(host: InputHost): void {
    for (const retrok of this.appliedKeys) host.setKey(retrok, false);
    this.appliedKeys = new Set();
    host.setJoyState(0, 0);
    host.setJoyState(1, 0);
    host.clearMouseState();
  }
}
