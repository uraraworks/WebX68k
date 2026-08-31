// 入力(段階移行 手順6)の main 側/Worker 側それぞれの純粋ロジックの対。
//
// - MainInputSnapshot: main 側(src/main.ts)が保持する入力スナップショット。DOM/Gamepad の
//   実イベントにも host(LibretroHost)にも依存しない。applyKey等の中央関数(main.ts)から
//   呼ばれ、frame event契機で take() が呼ばれて送信用の InputUpdate を作る。
// - WorkerInputState: Worker側(src/core-worker.ts)が保持する「最後に適用したコア入力状態」。
//   受信した InputUpdate を host(LibretroHost)へ適用する。
//
// どちらも実Workerグローバル(self/OffscreenCanvas/fetch)やDOMに依存しないため、
// 前例(src/worker-drive-loop.ts、test/core-worker-build-format.test.ts参照)と同様、
// ロジックだけを切り出して実行可能なテスト対象にしてある。
//
// docs/STORAGE-SCSI.md「ワーカー移行 手順6」の決定:
// - 世代付きclear: 受信したinputGenerationが保持値より小さければ丸ごと無視する。大きければ、
//   適用前にコア入力状態を先に完全にクリアしてから適用する(押しっぱなし固着の予防)。main側も
//   blur/visibility(hidden)で同様に世代を進め、スナップショットを全クリアしてから送信する。
// - 加算mouseDelta: main側は前回送信からの累積を持ち、take()(=送信)のたびにゼロへ戻す。
//   Worker側はhost.addMouseDelta()にそのまま渡すだけでよい(端数繰り越しはhost側が持つ。
//   src/libretro-host.ts参照)。
// - keyMakes(決定8): 押下状態を変えず、KeyRepeaterのmakeだけを追加で注入する。main側は
//   take()のたびに空へ戻す(mouseDeltaと同じ「加算値・追加注入分であり状態ではない」扱い)。

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

/**
 * main 側が保持する「次に送る入力更新」のスナップショット。DOM/Gamepad の実イベントにも
 * host(LibretroHost、既定経路専用)にも依存しない純粋な状態機械で、src/main.ts の
 * applyKey/applyKeyMake/applyMouseDelta/applyMouseButton/applyJoyState(urlWorkerMode時)から
 * 呼ばれる。
 *
 * mouseDelta と keyMakes は「加算値・追加注入分」であり、状態そのものではない。
 * そのため take() は送信用の InputUpdate を作ると同時に、この2つだけをリセットする
 * (keys/pads/mouseButtons/generation は状態なので take() では変えない)。
 */
export class MainInputSnapshot {
  private keys = new Set<number>();
  private pads: [number, number] = [0, 0];
  private mouseButtonLeft = false;
  private mouseButtonRight = false;
  private mouseDeltaX = 0;
  private mouseDeltaY = 0;
  private keyMakes: number[] = [];
  /** blur/visibility(hidden)のたびに進める入力世代。Worker側は古い世代の更新を無視する
   * (決定「世代付き clear」)。 */
  private generation = 0;

  /** テスト・診断用。 */
  get currentGeneration(): number {
    return this.generation;
  }

  key(retrok: number, down: boolean): void {
    if (down) this.keys.add(retrok);
    else this.keys.delete(retrok);
  }

  /** KeyRepeaterからの、押下状態を変えないmake注入。 */
  keyMake(retrok: number): void {
    this.keyMakes.push(retrok);
  }

  mouseDelta(dx: number, dy: number): void {
    this.mouseDeltaX += dx;
    this.mouseDeltaY += dy;
  }

  mouseButton(button: 'left' | 'right', down: boolean): void {
    if (button === 'left') this.mouseButtonLeft = down;
    else this.mouseButtonRight = down;
  }

  joyState(port: 0 | 1, bits: number): void {
    this.pads[port] = bits;
  }

  /**
   * blur/visibility(hidden)専用: 入力世代を進め、押下状態・パッド・ボタン・加算値・
   * 追加注入分をすべて初期状態へ戻す(決定「世代付き clear」。Worker側は世代が上がった
   * 更新を適用する前にコア側の状態を先に完全クリアする。src/core-worker.ts参照)。
   */
  bumpGeneration(): void {
    this.generation++;
    this.keys.clear();
    this.pads[0] = 0;
    this.pads[1] = 0;
    this.mouseButtonLeft = false;
    this.mouseButtonRight = false;
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.keyMakes = [];
  }

  /**
   * 送信用の InputUpdate を作って返す。同時に、加算値(mouseDelta)と追加注入分(keyMakes)を
   * ゼロ/空へ戻す(main側の責務。決定「加算 mouseDelta」参照)。keys/pads/mouseButtons/
   * generationは状態であり、送信のたびに消えるものではないため変更しない。
   */
  take(): InputUpdate {
    const update: InputUpdate = {
      keys: Array.from(this.keys),
      pads: [this.pads[0], this.pads[1]],
      mouseButtons: { left: this.mouseButtonLeft, right: this.mouseButtonRight },
      mouseDelta: { dx: this.mouseDeltaX, dy: this.mouseDeltaY },
      inputGeneration: this.generation,
      keyMakes: this.keyMakes,
    };
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.keyMakes = [];
    return update;
  }
}

// --- 入力の入口ガード (2026-08-31、実ブラウザ確認で見つかった欠陥の修正) --------------
//
// docs/STORAGE-SCSI.md「ワーカー移行 手順6」の「実ブラウザ確認で見つかった欠陥」参照。
// 物理キーボードのkeydownハンドラ(src/main.ts)は、既定経路が生まれた当時からの
// `!host` ガード(コアが未起動なら捨てる)をそのまま残していた。適用先はapplyKey等の
// 中央関数へ集約したにもかかわらず、その手前の入口が`host`(Worker経路では常にnull)で
// 塞がれたままだったため、Worker経路では物理キーボード入力が一度もapplyKeyへ届いていなかった
// (単体テスト567件はこの故障を1件も検出できなかった。DOMイベントハンドラの結線自体を
// 踏む検査が無かったため)。
//
// 既定経路の判定条件(host の有無)は一切変えていない。urlWorkerMode(Worker経路)のときだけ
// runningフラグで判定するようにした。running は両経路で「コアが動いているか」を表す
// 唯一の共通フラグ(既定経路は host!==null と概ね同時期に true になるが、Worker経路には
// host という概念自体が無い)。
export function computeShouldAcceptGuestKeyInput(opts: {
  urlWorkerMode: boolean;
  running: boolean;
  hostPresent: boolean;
}): boolean {
  return opts.urlWorkerMode ? opts.running : opts.hostPresent;
}
