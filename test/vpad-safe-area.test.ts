import { describe, expect, it } from 'vitest';
import {
  layoutVpadSides,
  resolveLandscapeInsets,
  vpadSideBoxesFor,
  NO_SAFE_AREA,
  type SafeAreaInsets,
} from '../src/virtual-pad';

/*
 * sides配置(横持ち全画面で .stage の左右に生じるデッドスペースへ部品を振り分ける)が
 * 切り欠き(ノッチ/パンチホール)に隠れない、という受け入れ条件の検証。
 *
 * index.html の viewport は viewport-fit=cover なので、ホーム画面から開いた
 * スタンドアロン表示や Android の全画面ではビューポートが切り欠きの下まで広がる。
 * 実測値は WebNP2 で同じ不具合を追ったときのもの(iPhone 横向きスタンドアロン、
 * 切り欠き側 59px / ホームインジケータ側 21px)。
 */
const VIEWPORT = { width: 874, height: 402 };
const STAGE = { x: 161, y: 0, w: 552, h: 345 };
const BOUND = new Set(['dpad-up', 'dpad-down', 'dpad-left', 'dpad-right', 'btn-a', 'btn-b']);

const notchLeft: SafeAreaInsets = { left: 59, right: 0, top: 0, bottom: 21 };
const notchRight: SafeAreaInsets = { left: 0, right: 59, top: 0, bottom: 21 };

describe('vpadSideBoxesFor', () => {
  it('インセット0なら従来式(x:0〜innerWidth)と一致する', () => {
    const boxes = vpadSideBoxesFor(STAGE, VIEWPORT, NO_SAFE_AREA);
    expect(boxes.left).toEqual({ x: 0, y: STAGE.y, w: STAGE.x, h: STAGE.h });
    expect(boxes.right).toEqual({
      x: STAGE.x + STAGE.w,
      y: STAGE.y,
      w: VIEWPORT.width - (STAGE.x + STAGE.w),
      h: STAGE.h,
    });
  });

  it('左の切り欠きぶんだけ左ボックスを内側へ寄せる', () => {
    const boxes = vpadSideBoxesFor(STAGE, VIEWPORT, notchLeft);
    expect(boxes.left.x).toBe(59);
    expect(boxes.left.w).toBe(STAGE.x - 59);
  });

  it('右の切り欠きぶんだけ右ボックスの右端を手前で止める', () => {
    const boxes = vpadSideBoxesFor(STAGE, VIEWPORT, notchRight);
    expect(boxes.right.x + boxes.right.w).toBe(VIEWPORT.width - 59);
  });

  it('ステージがビューポートを覆っても負の幅を作らない', () => {
    const boxes = vpadSideBoxesFor({ x: 0, y: 0, w: VIEWPORT.width, h: VIEWPORT.height }, VIEWPORT, notchLeft);
    expect(boxes.left.w).toBe(0);
    expect(boxes.right.w).toBe(0);
  });

  it('下端インセットぶんボックスの高さを詰める', () => {
    const tall = { x: 161, y: 0, w: 552, h: VIEWPORT.height };
    const boxes = vpadSideBoxesFor(tall, VIEWPORT, notchLeft);
    expect(boxes.left.h).toBe(VIEWPORT.height - 21);
    expect(boxes.right.h).toBe(VIEWPORT.height - 21);
  });
});

/**
 * 本来の受け入れ条件。ボックスではなく「実際に配置された部品」がセーフエリア内に
 * 収まることを見る。切り欠きは持ち方で左右どちらにも来るので両向きを回す。
 */
describe('配置された部品がセーフエリアに収まる', () => {
  for (const [label, insets] of [['左が切り欠き', notchLeft], ['右が切り欠き', notchRight]] as const) {
    it(`${label}: すべての部品がセーフエリアの内側にある`, () => {
      const boxes = vpadSideBoxesFor(STAGE, VIEWPORT, insets);
      const laidOut = layoutVpadSides(boxes, BOUND);
      expect(laidOut.length).toBeGreaterThan(0);
      for (const { widget, rect } of laidOut) {
        const name = widget.kind === 'dpad' ? 'stick' : widget.id;
        expect(rect.x, `${name} の左端`).toBeGreaterThanOrEqual(insets.left - 1e-6);
        expect(rect.x + rect.w, `${name} の右端`).toBeLessThanOrEqual(VIEWPORT.width - insets.right + 1e-6);
        expect(rect.y + rect.h, `${name} の下端`).toBeLessThanOrEqual(VIEWPORT.height - insets.bottom + 1e-6);
      }
    });
  }

  it('陰性対照: 従来式(セーフエリア無視)だとこの条件は満たされない', () => {
    const legacy = vpadSideBoxesFor(STAGE, VIEWPORT, NO_SAFE_AREA);
    const laidOut = layoutVpadSides(legacy, BOUND);
    const stick = laidOut.find((item) => item.widget.kind === 'dpad')!;
    expect(stick.rect.x).toBeLessThan(notchLeft.left);
    const a = laidOut.find((item) => item.widget.kind === 'button' && item.widget.id === 'btn-a')!;
    expect(a.rect.x + a.rect.w).toBeGreaterThan(VIEWPORT.width - notchRight.right);
  });
});

/**
 * iOS は横向きで左右対称にインセットを返すが、実際に塞がっているのは切り欠き側だけ
 * (WebNP2 でセーフエリアを塗って実機確認: inner 852x393 / angle 90 / inset 59,59,0,20 で、
 * 隠れていたのは左端の縦中央のみ。右端の帯は完全に見えていた)。
 */
describe('resolveLandscapeInsets', () => {
  const symmetric: SafeAreaInsets = { left: 59, right: 59, top: 0, bottom: 20 };

  it('angle 90 では切り欠きのない右側を解放する', () => {
    expect(resolveLandscapeInsets(symmetric, 90)).toEqual({ left: 59, right: 0, top: 0, bottom: 20 });
  });

  it('angle 270 では逆側を解放する', () => {
    expect(resolveLandscapeInsets(symmetric, 270)).toEqual({ left: 0, right: 59, top: 0, bottom: 20 });
  });

  it.each([[0], [180]])('縦向き(angle %i)では触らない', (angle) => {
    expect(resolveLandscapeInsets(symmetric, angle)).toEqual(symmetric);
  });

  it('角度が取れないときは両側を避ける従来動作へ倒す', () => {
    expect(resolveLandscapeInsets(symmetric, null)).toEqual(symmetric);
  });

  it('左右が同値でないなら値が正確なので触らない', () => {
    const asymmetric: SafeAreaInsets = { left: 59, right: 12, top: 0, bottom: 20 };
    expect(resolveLandscapeInsets(asymmetric, 90)).toEqual(asymmetric);
  });

  it('インセット0のとき(Chrome等)は何も起きない', () => {
    expect(resolveLandscapeInsets(NO_SAFE_AREA, 90)).toEqual(NO_SAFE_AREA);
  });

  it('解放した側のボタンが実際に大きくなる', () => {
    const viewport = { width: 852, height: 393 };
    const stage = { x: 127.5, y: 0, w: 597, h: 373 };
    const bound = new Set(['btn-a', 'btn-b']);
    const sizeOf = (insets: SafeAreaInsets): number => {
      const boxes = vpadSideBoxesFor(stage, viewport, insets);
      return layoutVpadSides(boxes, bound).find((item) => item.widget.kind === 'button')!.rect.w;
    };
    const both = sizeOf(symmetric);
    const resolved = sizeOf(resolveLandscapeInsets(symmetric, 90));
    expect(resolved).toBeGreaterThan(both * 1.5);
  });
});

/** 切り欠きの無い端末で余計なことをしないこと。 */
describe('切り欠き無しの端末', () => {
  const viewport = { width: 852, height: 393 };
  const stage = { x: 127.5, y: 0, w: 597, h: 373 };
  const bound = new Set(['dpad-up', 'dpad-down', 'dpad-left', 'dpad-right', 'btn-a', 'btn-b']);

  it.each([
    ['切り欠き無しiPhone/Android横向き', { left: 0, right: 0, top: 0, bottom: 0 }],
    ['iPad横向き(ホームインジケータのみ)', { left: 0, right: 0, top: 0, bottom: 20 }],
  ])('%s: 左右インセット0ならセーフエリア導入前と同じ配置になる', (_label, insets) => {
    const resolved = resolveLandscapeInsets(insets as SafeAreaInsets, 90);
    expect(layoutVpadSides(vpadSideBoxesFor(stage, viewport, resolved), bound)).toEqual(
      layoutVpadSides(vpadSideBoxesFor(stage, viewport, insets as SafeAreaInsets), bound),
    );
  });

  it('左右インセット0なら箱がビューポート端まで届く', () => {
    const boxes = vpadSideBoxesFor(stage, viewport, resolveLandscapeInsets({ left: 0, right: 0, top: 0, bottom: 20 }, 90));
    expect(boxes.left.x).toBe(0);
    expect(boxes.right.x + boxes.right.w).toBe(viewport.width);
  });

  it('左右非対称(Androidのパンチホール等)は値をそのまま尊重する', () => {
    const insets: SafeAreaInsets = { left: 34, right: 0, top: 0, bottom: 16 };
    const boxes = vpadSideBoxesFor(stage, viewport, resolveLandscapeInsets(insets, 90));
    expect(boxes.left.x).toBe(34);
    expect(boxes.right.x + boxes.right.w).toBe(viewport.width);
  });
});
