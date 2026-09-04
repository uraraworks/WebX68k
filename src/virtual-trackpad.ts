/**
 * バーチャルトラックパッド(仮想キーボード/バーチャルパッドに次ぐ「入力パネル」の第3の種類)。
 *
 * PR #4 の初版は canvas を直接タッチの受け口にしていたが、canvas は「ゲーム画面そのもの」で
 * あり、操作面としては指の影に隠れる・誤タップでゲスト側の描画やクリックを誘発するといった
 * 難点がある。そこで仮想キーボード/バーチャルパッドと同じ「入力パネル」の1つとして、専用の
 * 矩形領域(このファイルが受け持つ)を用意し、そこで指の動きを解釈する。
 *
 * ジェスチャ解釈そのものは touch-mouse.ts の TouchMouse をそのまま再利用する(タップ/2本指
 * タップ/長押しドラッグの判定はこのパネル用でもcanvas直結時代でも変わらないため、二重実装
 * しない)。このファイルの責務は DOM のポインタイベントを TouchMouse へつなぐことと、
 * パネルの表示/非表示の管理だけ。CSSピクセル→ゲストのドット数への換算(加速テーブルの
 * 逆引き含む)はホスト固有のマウス管理の知識(main.ts の stepMouseTracking() と同じ領分)
 * なので、呼び出し側のコールバックに委ねる(virtual-pad.ts が joy/key の割当解決を
 * GamepadManager に委ねているのと同じ考え方)。
 *
 * 2本指ドラッグ(トラックパッドの慣例でホイール相当に使われる操作)は実装しない。X68000の
 * マウスは左右2ボタンのみでホイールという概念自体が無く、px68k側(libretro/mouse.c)も
 * left/rightしか読んでいないため、実装しても受け取り先が無い。
 */

import { TouchMouse, type TouchMouseButton } from './touch-mouse';

export interface VirtualTrackpadCallbacks {
  /** 指の相対移動(CSSピクセル)。ゲストのドット数への換算は呼び出し側の責務。 */
  moveBy(dx: number, dy: number): void;
  /** 長押しドラッグの押し込み/解放。 */
  buttonDown(button: TouchMouseButton): void;
  buttonUp(button: TouchMouseButton): void;
  /** クリック1回ぶんの要求。パルス化(押して離す)とタイミングは呼び出し側の責務。 */
  tap(button: TouchMouseButton): void;
  /**
   * ストローク終了(全指が離れた/キャンセルされた/パネルが閉じられた)の通知。
   * 呼び出し側が持つ「加速テーブル逆引きの繰り越し残差」のようなストローク単位の状態を
   * 次のストロークへ持ち越さないために使う(TouchMouse 自身はそうした状態を知らないため、
   * ここで通知する)。
   */
  strokeEnd(): void;
}

export interface VirtualTrackpad {
  setVisible(visible: boolean): void;
  isVisible(): boolean;
  releaseAll(): void;
  /** 長押し判定用。呼び出し側のフレームループから毎フレーム呼ぶ(touch-mouse.ts の update() 参照)。 */
  step(now: number): void;
}

export function createVirtualTrackpad(el: HTMLElement, callbacks: VirtualTrackpadCallbacks): VirtualTrackpad {
  el.classList.add('hidden');
  // 指のドラッグをブラウザのスクロール/ピンチへ渡さない。touch-action:none 自体はCSS側の
  // 責務だが、JSでも明示しておくとCSS未適用時の事故(スクロール発生等)を防げる
  // (virtual-pad.ts:506 と同じ理由)。
  el.style.touchAction = 'none';

  const touchMouse = new TouchMouse({
    moveBy: (dx, dy) => callbacks.moveBy(dx, dy),
    buttonDown: (b) => callbacks.buttonDown(b),
    buttonUp: (b) => callbacks.buttonUp(b),
    tap: (b) => callbacks.tap(b),
  });

  function point(e: PointerEvent): { x: number; y: number } {
    const rect = el.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  el.addEventListener('pointerdown', (e) => {
    // 互換マウスイベント(タップ後に合成される mousedown/click)を抑止する。
    e.preventDefault();
    // 既に離れた指(イベント処理の遅延)や合成イベントでは InvalidPointerId で失敗するが、
    // 捕捉できなくても要素外へ出た瞬間の追従が切れるだけなので握りつぶす(virtual-pad.ts の
    // handlePointerDown と同じ扱い)。
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
    const { x, y } = point(e);
    touchMouse.pointerDown(e.pointerId, x, y, performance.now());
  });
  el.addEventListener('pointermove', (e) => {
    const { x, y } = point(e);
    touchMouse.pointerMove(e.pointerId, x, y);
  });
  el.addEventListener('pointerup', (e) => {
    touchMouse.pointerUp(e.pointerId, performance.now());
    callbacks.strokeEnd();
  });
  el.addEventListener('pointercancel', () => {
    touchMouse.reset();
    callbacks.strokeEnd();
  });
  // 長押しは左ボタンの押し込み(ドラッグ)に割り当てているので、同じ操作でブラウザ側の
  // コンテキストメニュー(iOS の「全て選択」「コピー」等のコールアウト)が出ると操作が中断する。
  // CSS の user-select / -webkit-touch-callout だけでは環境によって出てしまうため、
  // イベントでも明示的に止める(WebPaint98 の wm.ts が同じ理由で入れている)。
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  // iOS Safari は viewport の user-scalable=no / maximum-scale を無視する(iOS 10以降)ため、
  // ダブルタップによる拡大が touch-action: none だけでは止まらず、実機では
  // 「ダブルタップ = ダブルクリック」のつもりの操作が画面拡大になってしまう。
  // タッチイベントを非パッシブで受けて既定動作を止める(WebPaint98 の touchInput.ts と同じ手)。
  // ジェスチャ判定自体は pointer イベント側で完結しているので、ここは抑止だけを行う。
  for (const type of ['touchstart', 'touchmove', 'touchend'] as const) {
    el.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }

  return {
    setVisible(visible: boolean): void {
      el.classList.toggle('hidden', !visible);
      if (!visible) {
        touchMouse.reset();
        callbacks.strokeEnd();
      }
    },
    isVisible(): boolean {
      return !el.classList.contains('hidden');
    },
    releaseAll(): void {
      touchMouse.reset();
      callbacks.strokeEnd();
    },
    step(now: number): void {
      touchMouse.update(now);
    },
  };
}
