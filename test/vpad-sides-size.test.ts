import { describe, expect, it } from 'vitest';
import { layoutVpadSides, vpadSideBoxesFor, type SafeAreaInsets } from '../src/virtual-pad';

/*
 * sides配置(横持ち全画面)の部品サイズ。縦向き(panel配置)より必ず小さくなるので、
 * 「はみ出さない・重ならない」を保ったまま箱に入る範囲まで詰まっていることを見る。
 * ビューポート/ステージは切り欠きのある端末を横向きにしたときの実測相当。
 */
const VIEWPORT = { width: 874, height: 402 };
const STAGE = { x: 161, y: 0, w: 552, h: 345 };
const NOTCH: SafeAreaInsets = { left: 59, right: 59, top: 0, bottom: 21 };
const NO_NOTCH: SafeAreaInsets = { left: 0, right: 0, top: 0, bottom: 0 };
// 2ボタン構成(X68000 の標準的なジョイスティック)。左にオプション1/2とスティック、右にA/B。
const BOUND = new Set(['dpad-up', 'dpad-down', 'dpad-left', 'dpad-right', 'btn-a', 'btn-b', 'btn-opt1', 'btn-opt2']);

const layout = (insets: SafeAreaInsets) => {
  const boxes = vpadSideBoxesFor(STAGE, VIEWPORT, insets);
  return { boxes, items: layoutVpadSides(boxes, BOUND) };
};
const sizeOf = (insets: SafeAreaInsets, id: string): number => {
  const { items } = layout(insets);
  const hit = items.find((item) => (item.widget.kind === 'dpad' ? 'stick' : item.widget.id) === id);
  if (!hit) throw new Error(`${id} が配置されていない`);
  return hit.rect.w;
};

describe('sides配置の部品サイズ', () => {
  // 下限は詰めた後の実測値。下回ったら詰めが緩んだということ。
  it.each([
    ['stick', 90],
    ['btn-opt1', 42],
    ['btn-a', 45],
  ])('切り欠きありでも %s は %i px 以上ある', (id, floor) => {
    expect(sizeOf(NOTCH, id)).toBeGreaterThanOrEqual(floor);
  });

  it('2ボタン構成では横幅を3分割せず2分割する', () => {
    // 旧実装は常に right.w/3 で割り、使いもしない1列ぶんを捨てていた。
    const { boxes } = layout(NOTCH);
    const legacyDiameter = Math.min(boxes.right.w / 3, boxes.right.h / 2) * 0.8;
    expect(sizeOf(NOTCH, 'btn-a')).toBeGreaterThan(legacyDiameter * 1.5);
  });

  it('箱が横広でもオプションボタンが潰れない', () => {
    // 左ボックス 225x260。スティックを先に最大化して「余った隙間」からオプションを取る
    // 旧実装では、この形状でオプションだけ 28.8px まで潰れていた(WebNP2 で実測)。
    const boxes = { left: { x: 0, y: 0, w: 225, h: 260 }, right: { x: 649, y: 0, w: 225, h: 260 } };
    const items = layoutVpadSides(boxes, BOUND);
    const opt = items.find((item) => item.widget.kind === 'button' && item.widget.id === 'btn-opt1')!;
    expect(opt.rect.w).toBeGreaterThan(50);
    // 帯を先取りしてもスティックは旧係数(0.7掛け)より大きいままであること。
    const stick = items.find((item) => item.widget.kind === 'dpad')!;
    expect(stick.rect.w).toBeGreaterThan(Math.min(225, 260) * 0.7);
    // 帯とスティックが重なっていないこと。
    expect(stick.rect.y).toBeGreaterThanOrEqual(opt.rect.y + opt.rect.h - 1e-6);
  });

  it('陰性対照: 旧係数のままなら上の下限を満たさない', () => {
    const { boxes } = layout(NOTCH);
    expect(Math.min(boxes.left.w, boxes.left.h) * 0.7).toBeLessThan(90);
    expect(Math.min(boxes.left.w * 0.36, boxes.left.h) * 0.85).toBeLessThan(42);
    expect(Math.min(boxes.right.w / 3, boxes.right.h / 2) * 0.8).toBeLessThan(45);
  });
});

describe('大きくしても崩れない', () => {
  for (const [label, insets] of [['切り欠き無し', NO_NOTCH], ['切り欠きあり', NOTCH]] as const) {
    it(`${label}: 部品どうしが重ならない`, () => {
      const { items } = layout(insets);
      expect(items.length).toBe(5);
      for (let i = 0; i < items.length; i += 1) {
        for (let j = i + 1; j < items.length; j += 1) {
          const a = items[i].rect;
          const b = items[j].rect;
          const dx = a.x + a.w / 2 - (b.x + b.w / 2);
          const dy = a.y + a.h / 2 - (b.y + b.h / 2);
          const need = (Math.min(a.w, a.h) + Math.min(b.w, b.h)) / 2;
          expect(Math.hypot(dx, dy), `${i}と${j}の中心間距離`).toBeGreaterThanOrEqual(need - 1e-6);
        }
      }
    });

    it(`${label}: 部品がセーフエリアからはみ出さない`, () => {
      const { items } = layout(insets);
      for (const { rect } of items) {
        expect(rect.x).toBeGreaterThanOrEqual(insets.left - 1e-6);
        expect(rect.x + rect.w).toBeLessThanOrEqual(VIEWPORT.width - insets.right + 1e-6);
        expect(rect.y).toBeGreaterThanOrEqual(insets.top - 1e-6);
        expect(rect.y + rect.h).toBeLessThanOrEqual(VIEWPORT.height - insets.bottom + 1e-6);
      }
    });
  }
});
