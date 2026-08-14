/**
 * タッチマウス(タッチ操作をX68000のマウス入力へ変換する)のジェスチャ認識。
 *
 * iOS Safari は Pointer Lock API に対応しておらず、キャプチャモードが成立しない。
 * 一方で追従モード(閉ループ絶対位置追従)は「目標位置(desiredRatio)」さえ与えれば
 * Pointer Lock なしで動くため、タッチ位置をそのまま目標位置として流し込めば
 * タッチデバイスでもマウス操作が成立する。このモジュールはその「タッチ列 → マウス操作」の
 * 解釈だけを受け持つ。
 *
 * DOM/BOM には一切触れない純ロジックとして main.ts から分離した(platform.ts と同じ流儀。
 * タッチ実機なしで vitest からジェスチャ判定を検証するため)。座標は canvas の CSS ピクセル、
 * 時刻は performance.now() 相当のミリ秒を呼び出し側から渡す。
 *
 * ジェスチャ割当(iOS の AssistiveTouch や RDP クライアント等の慣例に合わせた):
 * - 1本指の接地/移動 … カーソル移動(moveTo。追従モードの desiredRatio へ配線する)
 * - 1本指の短いタップ … 左クリック(tap('left'))
 * - 2本指の短いタップ … 右クリック(tap('right'))
 * - 長押し(動かさず LONG_PRESS_MS) … 左ボタンを押し込む(buttonDown)。そのまま指を動かすと
 *   ドラッグ、離すと解放(buttonUp)
 *
 * クリックを tap コールバックにしてボタン操作(buttonDown/Up)と分けているのは、追従モードの
 * カーソルが目標へ収束するまで数フレームかかるため。タップ位置に着地する前にボタンを押すと
 * 移動中の座標でクリックされてしまうので、パルスのタイミング制御(収束待ち)は呼び出し側の
 * 責務にしている(main.ts の stepMouseTracking() 参照)。
 */

export type TouchMouseButton = 'left' | 'right';

export interface TouchMouseCallbacks {
  /** カーソルの目標位置。canvas 左上基準の CSS ピクセル。 */
  moveTo(x: number, y: number): void;
  /** 長押しドラッグの押し込み/解放。 */
  buttonDown(button: TouchMouseButton): void;
  buttonUp(button: TouchMouseButton): void;
  /** クリック1回ぶんの要求。パルス化(押して離す)とタイミングは呼び出し側が行う。 */
  tap(button: TouchMouseButton): void;
}

/** タップと判定する最大接地時間(ms)。iOS 標準のタップ認識(~250ms)に合わせる。 */
export const TAP_MAX_MS = 250;
/**
 * 2本指タップの「2本目が触れてから全指が離れるまで」の猶予(ms)。2本の指は同時には
 * 接地しないため、1本目の接地を基準にすると僅かな時間差で不成立になる。2本目を基準に
 * TAP_MAX_MS より少し長めに取る。
 */
export const TWO_FINGER_TAP_MAX_MS = 300;
/** これ以上動いたらタップではなく移動とみなす距離(CSSピクセル)。指の震え(~10px)より広め。 */
export const TAP_SLOP_PX = 12;
/** 長押し判定(ms)。iOS の長押しメニュー(500ms)より少し早め(待たされ感を減らす)。 */
export const LONG_PRESS_MS = 400;

interface TrackedPointer {
  id: number;
  startX: number;
  startY: number;
  downAt: number;
  /** TAP_SLOP_PX を一度でも超えたか。超えた後に始点へ戻ってきてもタップにはしない。 */
  moved: boolean;
}

export class TouchMouse {
  private readonly callbacks: TouchMouseCallbacks;
  /** 現在接地中の指。1本目(カーソルを担う指)は primaryId で識別する。 */
  private pointers = new Map<number, TrackedPointer>();
  private primaryId: number | null = null;
  /** このストローク(最初の接地から全指が離れるまで)の間に2本以上が同時接地したか。 */
  private multi = false;
  /** ストローク中に(既に離れた指も含め)どれかが TAP_SLOP_PX を超えて動いたか。 */
  private strokeMoved = false;
  /** 最後の指が接地した時刻。2本指タップの判定基準(TWO_FINGER_TAP_MAX_MS)に使う。 */
  private lastDownAt = 0;
  /** 長押しで左ボタンを押し込んでいる(ドラッグ中)か。 */
  private dragging = false;

  constructor(callbacks: TouchMouseCallbacks) {
    this.callbacks = callbacks;
  }

  pointerDown(id: number, x: number, y: number, now: number): void {
    // ドラッグ中に追加の指が触れても解釈しない(掌の端が触れる事故の誤爆防止)
    if (this.dragging) return;
    if (this.primaryId === null) {
      this.primaryId = id;
      this.pointers.set(id, { id, startX: x, startY: y, downAt: now, moved: false });
      // 接地した瞬間にカーソルを目標へ向かわせる(タップ時に「移動してからクリック」の順序を作る)
      this.callbacks.moveTo(x, y);
      return;
    }
    if (!this.pointers.has(id)) {
      this.pointers.set(id, { id, startX: x, startY: y, downAt: now, moved: false });
      this.multi = true;
      this.lastDownAt = now;
    }
  }

  pointerMove(id: number, x: number, y: number): void {
    const p = this.pointers.get(id);
    if (!p) return;
    if (!p.moved && Math.hypot(x - p.startX, y - p.startY) > TAP_SLOP_PX) {
      p.moved = true;
      this.strokeMoved = true;
    }
    // カーソルを動かすのは1本目の指だけ。2本目はタップ判定(moved)のためだけに追う
    if (id === this.primaryId) this.callbacks.moveTo(x, y);
  }

  pointerUp(id: number, now: number): void {
    const p = this.pointers.get(id);
    if (!p) return;
    this.pointers.delete(id);
    if (p.moved) this.strokeMoved = true;
    if (this.pointers.size > 0) return; // 全指が離れた時点でストロークとして解釈する

    const wasPrimary = this.primaryId === id;
    const { multi, dragging, strokeMoved, lastDownAt } = this;
    this.primaryId = null;
    this.multi = false;
    this.dragging = false;
    this.strokeMoved = false;
    this.lastDownAt = 0;

    if (dragging) {
      this.callbacks.buttonUp('left');
      return;
    }
    if (multi) {
      // 2本指タップ: どの指も動かさず、2本目の接地から素早く全指を離した場合のみ
      if (!strokeMoved && now - lastDownAt <= TWO_FINGER_TAP_MAX_MS) {
        this.callbacks.tap('right');
      }
      return;
    }
    if (wasPrimary && !strokeMoved && now - p.downAt <= TAP_MAX_MS) {
      this.callbacks.tap('left');
    }
  }

  /**
   * 長押し判定。タイマーを内部に持つと純ロジックでなくなるため、呼び出し側の
   * フレームループから現在時刻を渡して毎フレーム呼んでもらう。
   */
  update(now: number): void {
    if (this.dragging || this.multi || this.primaryId === null) return;
    const p = this.pointers.get(this.primaryId);
    if (!p || p.moved) return;
    if (now - p.downAt >= LONG_PRESS_MS) {
      this.dragging = true;
      this.callbacks.buttonDown('left');
    }
  }

  /** pointercancel やモード切替時の後始末。押し込み中のボタンを必ず離す。 */
  reset(): void {
    if (this.dragging) this.callbacks.buttonUp('left');
    this.pointers.clear();
    this.primaryId = null;
    this.multi = false;
    this.dragging = false;
    this.strokeMoved = false;
    this.lastDownAt = 0;
  }
}
