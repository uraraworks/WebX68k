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
  // 2026-09-01: 「make/breakの潰れ」対策(「フレーム基準の隙間はポーリング2回ぶん」の教訓)。
  // Worker経路は決定9により、keydown/keyupの発生時点でそれぞれ即座に個別のInputUpdate
  // メッセージを送る。main→Worker間はpostMessage(非同期)であり、Worker側の駆動ループ
  // (src/core-worker.tsのtick())はsetIntervalで独立に走るため、makeのメッセージとbreakの
  // メッセージが「実際にretro_run()がコアの入力状態をポーリングする前」に両方とも
  // 届いて適用されてしまうことがある。appliedKeysは単なる状態(bool)であり、
  // trueにしてすぐfalseに戻すと、コアは一度もそのキーが押されたことを観測できない
  // (「フレーム基準の隙間はポーリング2回ぶん」と同型の欠陥。過去のmakeでも同じ欠陥を
  // 抱えていたが、旧keyMakes専用の対策(決定8)はKeyRepeaterのmake専用でこの経路を
  // カバーしていなかった)。
  //
  // 対策: 新しくtrueにしたキー(まだ一度もretro_run()に見せていないキー)は
  // unobservedDownKeysに記録する。そのキーに対するreleaseがunobservedDownKeysが
  // 消える前に来たら、即座にhost.setKey(false)せず、pendingBreakKeysへ退避して
  // hostへは「押されたまま」を維持する。confirmObservedFrame()
  // (src/core-worker.tsのtick()から、そのtickで実際にretro_run()が1回以上走った
  // 直後にだけ呼ばれる)が呼ばれた時点で初めて、(1)unobservedDownKeysをクリアし
  // (直前のretro_run()呼び出し群で確実にポーリングされたとみなせるため)、
  // (2)保留中のreleaseを実際にhost.setKey(false)する。
  //
  // 既定経路(host = メインスレッドのLibretroHost)はこのクラス自体を使わないため、
  // この変更で既定経路の挙動は一切変わらない。
  private unobservedDownKeys = new Set<number>();
  private pendingBreakKeys = new Set<number>();
  // 2026-08-31三訂正(「break側の帰属が壊れている」の修正、docs/STORAGE-SCSI.md参照):
  // 帰属計測(inputApplyFrameNo)は「実際に何か状態が変わったapply()呼び出し」だけを
  // 記録したい。sendWorkerInputUpdate()はframe event契機で(ゲームパッド未接続・
  // マウス未操作でも)毎フレーム無条件に呼ばれる片道メッセージで、内容が前回と同じ
  // ことが大半のため、host.setJoyState()/setMouseButton()自体は従来どおり毎回
  // 呼ぶが(既存の副作用タイミングは変えない)、「本当に変わったか」を判定するために
  // 直近に適用したpads/mouseButtonsをここに保持しておく。
  private appliedPads: [number, number] = [0, 0];
  private appliedMouseLeft = false;
  private appliedMouseRight = false;

  /** テスト・診断用。 */
  get currentGeneration(): number {
    return this.generation;
  }

  /** テスト・診断用。 */
  get currentAppliedKeys(): ReadonlySet<number> {
    return this.appliedKeys;
  }

  /**
   * @returns この呼び出しで実際にコア入力状態が変化したか(世代の切り替わり、keyの
   *   押下/解放、pads/mouseButtonsの値変化、mouseDeltaの非ゼロ、keyMakesの送出の
   *   いずれか)。呼び出し側(src/core-worker.ts)はこれを使って、帰属計測用の
   *   「実際に適用された瞬間のframeNo」を、内容の変わらない連続送信では上書きしない
   *   ようにする(2026-08-31三訂正: 旧実装はこの戻り値が無く、無条件に「適用した」と
   *   みなしていたため、frame event契機の毎フレーム送信(内容不変がほとんど)のたびに
   *   帰属計測の基準時刻が上書きされ続け、検出が遅れがちなbreak側で
   *   `writeFrameNo < applyFrameNo`という定義上ありえない負値を生んでいた。
   *   makeは検出が速いため実害が出にくかっただけで、同じ欠陥を抱えていた)。
   */
  apply(update: InputUpdate, host: InputHost): boolean {
    let changed = false;
    if (update.inputGeneration < this.generation) return false; // 古い世代は丸ごと無視する。
    if (update.inputGeneration > this.generation) {
      // 世代が上がる更新を適用する前に、コア側の状態を先に完全クリアする(決定「世代付き clear」)。
      this.clear(host);
      this.generation = update.inputGeneration;
      changed = true; // 世代の切り替わり(clear)自体を状態変化として数える。
    }

    const nextKeys = new Set(update.keys);
    for (const retrok of this.appliedKeys) {
      if (nextKeys.has(retrok)) {
        // 引き続き押されている(または再度押された)。以前のreleaseが保留中だったら
        // 撤回する(release前に再度make/holdが来たので、releaseはまだ起きていない)。
        this.pendingBreakKeys.delete(retrok);
        continue;
      }
      if (this.unobservedDownKeys.has(retrok)) {
        // まだ一度もretro_run()に見せていないmake。ここでreleaseすると「押されたことが
        // 一度もコアに見えないまま消える」ため、confirmObservedFrame()まで遅延する。
        // hostへは「押されたまま」を維持する(=appliedKeysには残す。下のstillApplied参照)。
        this.pendingBreakKeys.add(retrok);
        continue;
      }
      host.setKey(retrok, false);
      changed = true;
    }
    const stillApplied = new Set<number>();
    for (const retrok of this.appliedKeys) {
      if (nextKeys.has(retrok) || this.pendingBreakKeys.has(retrok)) stillApplied.add(retrok);
    }
    for (const retrok of nextKeys) {
      if (!stillApplied.has(retrok)) {
        host.setKey(retrok, true);
        stillApplied.add(retrok);
        this.unobservedDownKeys.add(retrok);
        changed = true;
      }
    }
    this.appliedKeys = stillApplied;

    if (this.appliedPads[0] !== update.pads[0] || this.appliedPads[1] !== update.pads[1]) changed = true;
    this.appliedPads = [update.pads[0], update.pads[1]];
    host.setJoyState(0, update.pads[0]);
    host.setJoyState(1, update.pads[1]);

    if (
      this.appliedMouseLeft !== update.mouseButtons.left ||
      this.appliedMouseRight !== update.mouseButtons.right
    ) {
      changed = true;
    }
    this.appliedMouseLeft = update.mouseButtons.left;
    this.appliedMouseRight = update.mouseButtons.right;
    host.setMouseButton('left', update.mouseButtons.left);
    host.setMouseButton('right', update.mouseButtons.right);

    // 加算 delta: 同じ世代の mouse delta は受信順に加算する(docs参照)。0/0は呼ばなくてよい。
    if (update.mouseDelta.dx !== 0 || update.mouseDelta.dy !== 0) {
      host.addMouseDelta(update.mouseDelta.dx, update.mouseDelta.dy);
      changed = true;
    }
    // KeyRepeaterのmake注入(決定8)。押下状態は変えず、makeだけを追加で送る。
    for (const retrok of update.keyMakes) host.sendKeyMake(retrok);
    if (update.keyMakes.length > 0) changed = true;

    return changed;
  }

  /**
   * src/core-worker.ts の tick() から、そのtickで実際にretro_run()が1回以上走った直後
   * (result.ranFrames > 0)にだけ呼ぶ。ranFrames === 0 のtick(このtickでは1フレームも
   * 進まなかった=ポーリングも発生していない)では呼んではいけない。
   *
   * @returns 保留中のreleaseを実際に適用してhost状態が変わったか。
   */
  confirmObservedFrame(host: InputHost): boolean {
    this.unobservedDownKeys.clear();
    if (this.pendingBreakKeys.size === 0) return false;
    for (const retrok of this.pendingBreakKeys) {
      host.setKey(retrok, false);
      this.appliedKeys.delete(retrok);
    }
    this.pendingBreakKeys.clear();
    return true;
  }

  private clear(host: InputHost): void {
    for (const retrok of this.appliedKeys) host.setKey(retrok, false);
    this.appliedKeys = new Set();
    this.unobservedDownKeys = new Set();
    this.pendingBreakKeys = new Set();
    this.appliedPads = [0, 0];
    this.appliedMouseLeft = false;
    this.appliedMouseRight = false;
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
