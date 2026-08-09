import { describe, expect, it } from 'vitest';
import { GamepadManager, retroIdFor, type Source } from '../src/gamepad.ts';
import { builtinCursorSpaceProfile, builtinJoy2ButtonProfile } from '../src/input-profile.ts';
import { RETROK } from '../src/keyboard.ts';
import {
  hitTestVpad,
  layoutVpad,
  layoutVpadSides,
  stickDirsFromPoint,
  stickKnobOffset,
  STICK_DEADZONE_RATIO,
  STICK_MAX_RADIUS_RATIO,
  vpadWidgetsFor,
  VPAD_SLANT_PCT_OVERLAY,
  VPAD_SLANT_PCT_PANEL,
  type LaidOutWidget,
  type VpadSideBoxes,
  type VpadWidget,
} from '../src/virtual-pad.ts';

/** 2ボタン配置(dpad4方向、btn-a/btn-b、btn-opt1/opt2)の束縛ID集合。 */
const TWO_BUTTON_IDS = new Set(['dpad-up', 'dpad-down', 'dpad-left', 'dpad-right', 'btn-a', 'btn-b', 'btn-opt1', 'btn-opt2']);
/** 6ボタン配置(dpad4方向、btn-a〜btn-f、btn-opt1/opt2)の束縛ID集合。 */
const SIX_BUTTON_IDS = new Set(['dpad-up', 'dpad-down', 'dpad-left', 'dpad-right', 'btn-a', 'btn-b', 'btn-c', 'btn-d', 'btn-e', 'btn-f', 'btn-opt1', 'btn-opt2']);

const VPAD_WIDGETS = vpadWidgetsFor('overlay', SIX_BUTTON_IDS);
const VPAD_PANEL_WIDGETS = vpadWidgetsFor('panel', SIX_BUTTON_IDS);

const DPAD_WIDGET = VPAD_WIDGETS.find((w): w is Extract<VpadWidget, { kind: 'dpad' }> => w.kind === 'dpad')!;
const BTN_A_WIDGET = VPAD_WIDGETS.find((w): w is Extract<VpadWidget, { kind: 'button' }> => w.kind === 'button' && w.id === 'btn-a')!;

describe('layoutVpad', () => {
  it('stageサイズに比例した矩形を返す(scale省略時は等倍)', () => {
    const widgets: VpadWidget[] = [{ kind: 'button', id: 'x', label: 'X', xPct: 50, yPct: 50, sizePct: 20 }];
    const laidOut = layoutVpad(1000, 500, widgets);
    expect(laidOut).toHaveLength(1);
    const { rect } = laidOut[0];
    // shortSide=500, size=500*0.2=100, center=(500,250)
    expect(rect.w).toBe(100);
    expect(rect.h).toBe(100);
    expect(rect.x).toBe(450);
    expect(rect.y).toBe(200);
  });

  it('stageサイズを2倍にすると矩形も比例して2倍になる(中心座標基準)', () => {
    const widgets: VpadWidget[] = [{ kind: 'button', id: 'x', label: 'X', xPct: 50, yPct: 50, sizePct: 20 }];
    const small = layoutVpad(1000, 500, widgets).at(0)!.rect;
    const big = layoutVpad(2000, 1000, widgets).at(0)!.rect;
    expect(big.w).toBe(small.w * 2);
    expect(big.h).toBe(small.h * 2);
  });

  it('scale係数でサイズだけ縮小できる(中心は変わらない)', () => {
    const widgets: VpadWidget[] = [{ kind: 'button', id: 'x', label: 'X', xPct: 50, yPct: 50, sizePct: 20 }];
    const normal = layoutVpad(1000, 500, widgets, 1).at(0)!.rect;
    const half = layoutVpad(1000, 500, widgets, 0.5).at(0)!.rect;
    expect(half.w).toBe(normal.w / 2);
    expect(half.h).toBe(normal.h / 2);
    const normalCx = normal.x + normal.w / 2;
    const halfCx = half.x + half.w / 2;
    expect(halfCx).toBeCloseTo(normalCx, 6);
  });
});

describe('stickDirsFromPoint', () => {
  // 200x200の正方形矩形、中心(100,100)、直径200。デッドゾーン半径=200*0.18=36。
  const rect = { x: 0, y: 0, w: 200, h: 200 };
  const deadzone = rect.w * STICK_DEADZONE_RATIO;
  // デッドゾーン(36)より十分外側、かつ最大半径(100)より内側の距離を使い、8方向の判定だけを見る。
  const dist = 60;

  /** 中心(100,100)から角度deg(度、右=0・下=90・左=180・上=270)・距離distの点。 */
  function pointAtDeg(deg: number, d: number = dist): { px: number; py: number } {
    const rad = (deg * Math.PI) / 180;
    return { px: 100 + d * Math.cos(rad), py: 100 + d * Math.sin(rad) };
  }

  it('右(0°)', () => {
    const { px, py } = pointAtDeg(0);
    expect(stickDirsFromPoint(DPAD_WIDGET, rect, px, py)).toEqual(['dpad-right']);
  });
  it('右下(45°)', () => {
    const { px, py } = pointAtDeg(45);
    expect(stickDirsFromPoint(DPAD_WIDGET, rect, px, py).sort()).toEqual(['dpad-down', 'dpad-right'].sort());
  });
  it('下(90°)', () => {
    const { px, py } = pointAtDeg(90);
    expect(stickDirsFromPoint(DPAD_WIDGET, rect, px, py)).toEqual(['dpad-down']);
  });
  it('左下(135°)', () => {
    const { px, py } = pointAtDeg(135);
    expect(stickDirsFromPoint(DPAD_WIDGET, rect, px, py).sort()).toEqual(['dpad-down', 'dpad-left'].sort());
  });
  it('左(180°)', () => {
    const { px, py } = pointAtDeg(180);
    expect(stickDirsFromPoint(DPAD_WIDGET, rect, px, py)).toEqual(['dpad-left']);
  });
  it('左上(225°)', () => {
    const { px, py } = pointAtDeg(225);
    expect(stickDirsFromPoint(DPAD_WIDGET, rect, px, py).sort()).toEqual(['dpad-left', 'dpad-up'].sort());
  });
  it('上(270°)', () => {
    const { px, py } = pointAtDeg(270);
    expect(stickDirsFromPoint(DPAD_WIDGET, rect, px, py)).toEqual(['dpad-up']);
  });
  it('右上(315°)', () => {
    const { px, py } = pointAtDeg(315);
    expect(stickDirsFromPoint(DPAD_WIDGET, rect, px, py).sort()).toEqual(['dpad-right', 'dpad-up'].sort());
  });
  it('デッドゾーン内(不感帯半径未満)は無入力', () => {
    const { px, py } = pointAtDeg(0, deadzone * 0.5);
    expect(stickDirsFromPoint(DPAD_WIDGET, rect, px, py)).toEqual([]);
  });
  it('ベース円の外(中心から直径の2倍)でも方向が返る(束縛中の追従を支える)', () => {
    const { px, py } = pointAtDeg(0, rect.w * 2);
    expect(stickDirsFromPoint(DPAD_WIDGET, rect, px, py)).toEqual(['dpad-right']);
  });
});

describe('stickKnobOffset', () => {
  const rect = { x: 0, y: 0, w: 200, h: 200 };
  const maxR = rect.w * STICK_MAX_RADIUS_RATIO;

  it('最大半径より内側の点はオフセットがそのまま返る', () => {
    const { x, y } = stickKnobOffset(rect, 110, 100); // dx=10, dy=0, dist=10 < maxR(100)
    expect(x).toBeCloseTo(10, 9);
    expect(y).toBeCloseTo(0, 9);
  });

  it('遠い点は最大半径(直径*0.5)にクランプされる(距離で検証)', () => {
    const { x, y } = stickKnobOffset(rect, 500, 100); // dx=400, dy=0
    const dist = Math.hypot(x, y);
    expect(dist).toBeCloseTo(maxR, 9);
    // 方向自体は保たれる(dyは0のまま、xは正)
    expect(y).toBeCloseTo(0, 9);
    expect(x).toBeGreaterThan(0);
  });

  it('中心そのものはオフセット0を返す(0除算を起こさない)', () => {
    const { x, y } = stickKnobOffset(rect, 100, 100);
    expect(x).toBe(0);
    expect(y).toBe(0);
  });
});

describe('hitTestVpad', () => {
  const laidOut: LaidOutWidget[] = layoutVpad(1000, 1000, [BTN_A_WIDGET]);
  const rect = laidOut[0].rect;

  it('ボタンの円の中心では反応する', () => {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    expect(hitTestVpad(laidOut, cx, cy)).toEqual(['btn-a']);
  });

  it('矩形の角(内接円の外側)では反応しない', () => {
    // 正方形の角は中心から半径*sqrt(2)離れており、内接円(半径)の外側になる。
    expect(hitTestVpad(laidOut, rect.x, rect.y)).toEqual([]);
  });

  it('矩形そのものの外では反応しない', () => {
    expect(hitTestVpad(laidOut, rect.x - 100, rect.y - 100)).toEqual([]);
  });
});

/** プロファイルの bindings を GamepadManager 用の entries へ変換する(virtual-pad.ts の buildDom と同じ変換)。 */
function entriesFor(bindings: Record<string, { kind: 'joy'; target: import('../src/gamepad.ts').JoyTarget } | { kind: 'key'; retrok: number }>) {
  return Object.entries(bindings).map(([id, binding]) => ({ source: { kind: 'touch', id } as Source, binding }));
}

/**
 * レイアウト破綻(はみ出し・重なり)を「目で見るまで気づけない」状態を防ぐための検証。
 * 2026-08時点でパネルモードの座標を横長の帯前提で決め打ちしたところ、実機の縦持ち
 * 375x812 ではパネルが 367x260 とほぼ正方形になり、dpad がはみ出す・ボタンA/Bが
 * 重なる・ボタンAが右端からはみ出すという破綻が実機スクリーンショットでしか
 * 検出できなかった(docs/DESIGN.md 参照)。同じ破綻を数値で検出できるようにする。
 */
describe('レイアウトのはみ出し・重なり検証', () => {
  /** 全部品の矩形が [0,w] x [0,h] の内側に収まっているか。 */
  function expectAllWithinBounds(laidOut: readonly LaidOutWidget[], w: number, h: number): void {
    for (const { widget, rect } of laidOut) {
      const label = widget.kind === 'dpad' ? 'dpad' : widget.id;
      expect(rect.x, `${label}.x`).toBeGreaterThanOrEqual(-1e-9);
      expect(rect.y, `${label}.y`).toBeGreaterThanOrEqual(-1e-9);
      expect(rect.x + rect.w, `${label}.right`).toBeLessThanOrEqual(w + 1e-9);
      expect(rect.y + rect.h, `${label}.bottom`).toBeLessThanOrEqual(h + 1e-9);
    }
  }

  /** ボタン同士(dpadは対象外)の内接円が互いに重ならないか(中心間距離 >= 半径の和)。 */
  function expectNoButtonOverlap(laidOut: readonly LaidOutWidget[]): void {
    const buttons = laidOut.filter((l): l is LaidOutWidget & { widget: Extract<VpadWidget, { kind: 'button' }> } => l.widget.kind === 'button');
    for (let i = 0; i < buttons.length; i++) {
      for (let j = i + 1; j < buttons.length; j++) {
        const a = buttons[i].rect;
        const b = buttons[j].rect;
        const acx = a.x + a.w / 2;
        const acy = a.y + a.h / 2;
        const bcx = b.x + b.w / 2;
        const bcy = b.y + b.h / 2;
        const dist = Math.hypot(acx - bcx, acy - bcy);
        const radiusSum = Math.min(a.w, a.h) / 2 + Math.min(b.w, b.h) / 2;
        expect(dist, `${buttons[i].widget.id} vs ${buttons[j].widget.id}`).toBeGreaterThanOrEqual(radiusSum - 1e-9);
      }
    }
  }

  // 配置が動的(vpadWidgetsFor)になったため、2ボタン集合・6ボタン集合の両方で
  // はみ出し・重なりが起きないことを回す(どちらか一方だけ通っても意味がないため)。
  const buttonSets: Array<[string, ReadonlySet<string>]> = [
    ['2ボタン', TWO_BUTTON_IDS],
    ['6ボタン', SIX_BUTTON_IDS],
  ];

  for (const [label, ids] of buttonSets) {
    it(`VPAD_PANEL_WIDGETS(${label}): 実機縦持ちで実測したパネル実寸367x260で、全部品が内側に収まる`, () => {
      const laidOut = layoutVpad(367, 260, vpadWidgetsFor('panel', ids));
      expectAllWithinBounds(laidOut, 367, 260);
    });

    it(`VPAD_PANEL_WIDGETS(${label}): 367x260でボタン同士が重ならない`, () => {
      const laidOut = layoutVpad(367, 260, vpadWidgetsFor('panel', ids));
      expectNoButtonOverlap(laidOut);
    });

    const overlaySizes: Array<[number, number]> = [
      [367, 245],
      [780, 154],
      [240, 180],
    ];

    for (const [w, h] of overlaySizes) {
      it(`VPAD_WIDGETS(${label}): ${w}x${h}で全部品が内側に収まる`, () => {
        const laidOut = layoutVpad(w, h, vpadWidgetsFor('overlay', ids));
        expectAllWithinBounds(laidOut, w, h);
      });

      it(`VPAD_WIDGETS(${label}): ${w}x${h}でボタン同士が重ならない`, () => {
        const laidOut = layoutVpad(w, h, vpadWidgetsFor('overlay', ids));
        expectNoButtonOverlap(laidOut);
      });
    }
  }
});

/**
 * vpadWidgetsFor(): 「束縛されている部品IDの集合」から配置(部品ID・ラベル・座標の組)を
 * 返す関数であることの検証。実機のメガドライブ6ボタンパッド配置(下段A/B/C・上段X/Y/Z、
 * Aが左下)と、従来どおりの2ボタン配置(Aが右)を座標とラベルの両方で確認する。
 */
describe('vpadWidgetsFor', () => {
  function findButton(widgets: readonly VpadWidget[], id: string): Extract<VpadWidget, { kind: 'button' }> {
    const w = widgets.find((w): w is Extract<VpadWidget, { kind: 'button' }> => w.kind === 'button' && w.id === id);
    if (!w) throw new Error(`widget not found: ${id}`);
    return w;
  }

  for (const placement of ['overlay', 'panel'] as const) {
    it(`${placement}/2ボタン集合: btn-aが最も右(xPctが最大)`, () => {
      const widgets = vpadWidgetsFor(placement, TWO_BUTTON_IDS).filter(
        (w): w is Extract<VpadWidget, { kind: 'button' }> => w.kind === 'button' && (w.id === 'btn-a' || w.id === 'btn-b'),
      );
      const a = findButton(widgets, 'btn-a');
      for (const w of widgets) {
        if (w.id === 'btn-a') continue;
        expect(a.xPct, `btn-a.xPct vs ${w.id}.xPct`).toBeGreaterThan(w.xPct);
      }
      expect(widgets.map((w) => w.id).sort()).toEqual(['btn-a', 'btn-b'].sort());
    });

    it(`${placement}/6ボタン集合: btn-aが下段の最も左(x最小)に来る`, () => {
      const widgets = vpadWidgetsFor(placement, SIX_BUTTON_IDS);
      const a = findButton(widgets, 'btn-a');
      const b = findButton(widgets, 'btn-b');
      const c = findButton(widgets, 'btn-c');
      const d = findButton(widgets, 'btn-d');
      const e = findButton(widgets, 'btn-e');
      const f = findButton(widgets, 'btn-f');
      // 下段(A/B/C)が上段(D/E/F)より画面下(yPct大)にある(同じ列同士で比較)。
      expect(a.yPct).toBeGreaterThan(d.yPct);
      expect(b.yPct).toBeGreaterThan(e.yPct);
      expect(c.yPct).toBeGreaterThan(f.yPct);
      // x座標は左から順(A<B<C、D<E<F)。
      expect(a.xPct).toBeLessThan(b.xPct);
      expect(b.xPct).toBeLessThan(c.xPct);
      expect(d.xPct).toBeLessThan(e.xPct);
      expect(e.xPct).toBeLessThan(f.xPct);
    });

    /**
     * 6ボタン配置全体を「右上がり」に傾ける仕様(実機メガドライブ6ボタンパッド。参考:
     * flat gamepad overlay https://forums.libretro.com/t/flat-gamepad-overlays/3339/24)の検証。
     * 単に「右が上」なだけでなく、傾きが VPAD_SLANT_PCT_PANEL/OVERLAY という名前付き定数から
     * 計算されていること(ベタ書きの座標表に戻されていないこと)まで数値で確認する。
     */
    it(`${placement}/6ボタン集合: 下段A→B→C・上段X→Y→Zとも右へ行くほどyPctが単調に小さくなる(右上がり)`, () => {
      const widgets = vpadWidgetsFor(placement, SIX_BUTTON_IDS);
      const a = findButton(widgets, 'btn-a');
      const b = findButton(widgets, 'btn-b');
      const c = findButton(widgets, 'btn-c');
      const d = findButton(widgets, 'btn-d');
      const e = findButton(widgets, 'btn-e');
      const f = findButton(widgets, 'btn-f');
      expect(a.yPct).toBeGreaterThan(b.yPct);
      expect(b.yPct).toBeGreaterThan(c.yPct);
      expect(d.yPct).toBeGreaterThan(e.yPct);
      expect(e.yPct).toBeGreaterThan(f.yPct);
    });

    it(`${placement}/6ボタン集合: 上下段の縦間隔が3列とも等しい(傾けても平行四辺形を保つ)`, () => {
      const widgets = vpadWidgetsFor(placement, SIX_BUTTON_IDS);
      const a = findButton(widgets, 'btn-a');
      const b = findButton(widgets, 'btn-b');
      const c = findButton(widgets, 'btn-c');
      const d = findButton(widgets, 'btn-d');
      const e = findButton(widgets, 'btn-e');
      const f = findButton(widgets, 'btn-f');
      const gapLeft = a.yPct - d.yPct;
      const gapMid = b.yPct - e.yPct;
      const gapRight = c.yPct - f.yPct;
      expect(gapMid).toBeCloseTo(gapLeft, 9);
      expect(gapRight).toBeCloseTo(gapLeft, 9);
    });

    it(`${placement}/6ボタン集合: 列間のyPct差が傾き定数(VPAD_SLANT_PCT_PANEL/OVERLAY)ちょうどになる(座標が定数から計算されていることの確認)`, () => {
      const widgets = vpadWidgetsFor(placement, SIX_BUTTON_IDS);
      const slant = placement === 'panel' ? VPAD_SLANT_PCT_PANEL : VPAD_SLANT_PCT_OVERLAY;
      const a = findButton(widgets, 'btn-a');
      const b = findButton(widgets, 'btn-b');
      const c = findButton(widgets, 'btn-c');
      const d = findButton(widgets, 'btn-d');
      const e = findButton(widgets, 'btn-e');
      const f = findButton(widgets, 'btn-f');
      expect(a.yPct - b.yPct).toBeCloseTo(slant, 9);
      expect(b.yPct - c.yPct).toBeCloseTo(slant, 9);
      expect(d.yPct - e.yPct).toBeCloseTo(slant, 9);
      expect(e.yPct - f.yPct).toBeCloseTo(slant, 9);
    });

    it(`${placement}/6ボタン集合: ラベルは上段X,Y,Z/下段A,B,Cになる`, () => {
      const widgets = vpadWidgetsFor(placement, SIX_BUTTON_IDS);
      expect(findButton(widgets, 'btn-a').label).toBe('A');
      expect(findButton(widgets, 'btn-b').label).toBe('B');
      expect(findButton(widgets, 'btn-c').label).toBe('C');
      expect(findButton(widgets, 'btn-d').label).toBe('X');
      expect(findButton(widgets, 'btn-e').label).toBe('Y');
      expect(findButton(widgets, 'btn-f').label).toBe('Z');
    });

    it(`${placement}/2ボタン集合: 座標値は従来のVPAD_WIDGETS/VPAD_PANEL_WIDGETSのbtn-a/btn-bをそのまま使う(新しい数値を発明しない)`, () => {
      const widgets = vpadWidgetsFor(placement, TWO_BUTTON_IDS);
      const a = findButton(widgets, 'btn-a');
      const b = findButton(widgets, 'btn-b');
      if (placement === 'overlay') {
        expect(a.xPct).toBe(88);
        expect(b.xPct).toBe(74);
      } else {
        expect(a.xPct).toBe(90);
        expect(b.xPct).toBe(74);
      }
    });
  }
});

describe('組み込みプロファイルの割当解決(GamepadManager経由)', () => {
  it('builtin:joy-2button: dpad-up/btn-aを押すとjoyビットが立つ', () => {
    const profile = builtinJoy2ButtonProfile();
    const manager = new GamepadManager(entriesFor(profile.bindings));
    const sources: Source[] = [{ kind: 'touch', id: 'dpad-up' }, { kind: 'touch', id: 'btn-a' }];
    const bits = manager.bitsForSources(sources, 'default');
    expect(bits & (1 << retroIdFor('UP', 'default'))).not.toBe(0);
    expect(bits & (1 << retroIdFor('TRG1', 'default'))).not.toBe(0);
    expect(bits & (1 << retroIdFor('DOWN', 'default'))).toBe(0);
    expect(manager.keysForSources(sources).size).toBe(0);
  });

  it('builtin:cursor-space: dpad-up/btn-aを押すとRETROKが返る(joyビットは立たない)', () => {
    const profile = builtinCursorSpaceProfile();
    const manager = new GamepadManager(entriesFor(profile.bindings));
    const sources: Source[] = [{ kind: 'touch', id: 'dpad-up' }, { kind: 'touch', id: 'btn-a' }];
    const keys = manager.keysForSources(sources);
    expect(keys.has(RETROK.UP)).toBe(true);
    expect(keys.has(RETROK.SPACE)).toBe(true);
    expect(manager.bitsForSources(sources, 'default')).toBe(0);
  });
});

/**
 * layoutVpadSides(): sides配置(横持ちフルスクリーンで .console-card の左右に生じる
 * デッドスペースへスティック・ボタンを振り分ける)の検証。実測値は横持ちフルスクリーンの
 * ビューポート812x375で .console-card が left=194/right=618、.stage の高さ283
 * (docs/DESIGN.md「バーチャルパッド」節参照)。この実測から左右ボックスを組み立てる:
 * 左ボックス ≒ {x:0, y:(375-283)/2, w:194, h:283}、右ボックス ≒ {x:618, y:同上, w:194, h:283}。
 */
describe('layoutVpadSides', () => {
  const STAGE_TOP = (375 - 283) / 2;
  const REALISTIC_BOXES: VpadSideBoxes = {
    left: { x: 0, y: STAGE_TOP, w: 194, h: 283 },
    right: { x: 618, y: STAGE_TOP, w: 194, h: 283 },
  };
  const CARD_LEFT = 194;
  const CARD_RIGHT = 618;

  function findButton(laidOut: readonly LaidOutWidget[], id: string): LaidOutWidget {
    const w = laidOut.find((l) => l.widget.kind === 'button' && l.widget.id === id);
    if (!w) throw new Error(`widget not found: ${id}`);
    return w;
  }

  /** 各部品の矩形が、それぞれが属するはずのボックスの内側に収まっているか。 */
  function expectWithinBox(laidOut: readonly LaidOutWidget[], box: { x: number; y: number; w: number; h: number }): void {
    for (const { widget, rect } of laidOut) {
      const label = widget.kind === 'dpad' ? 'dpad' : widget.id;
      expect(rect.x, `${label}.x`).toBeGreaterThanOrEqual(box.x - 1e-9);
      expect(rect.y, `${label}.y`).toBeGreaterThanOrEqual(box.y - 1e-9);
      expect(rect.x + rect.w, `${label}.right`).toBeLessThanOrEqual(box.x + box.w + 1e-9);
      expect(rect.y + rect.h, `${label}.bottom`).toBeLessThanOrEqual(box.y + box.h + 1e-9);
    }
  }

  /** 部品同士(内接円)が互いに重ならないか(中心間距離 >= 半径の和)。dpad(スティック)も円として扱う。 */
  function expectNoOverlap(laidOut: readonly LaidOutWidget[]): void {
    for (let i = 0; i < laidOut.length; i++) {
      for (let j = i + 1; j < laidOut.length; j++) {
        const a = laidOut[i].rect;
        const b = laidOut[j].rect;
        const acx = a.x + a.w / 2;
        const acy = a.y + a.h / 2;
        const bcx = b.x + b.w / 2;
        const bcy = b.y + b.h / 2;
        const dist = Math.hypot(acx - bcx, acy - bcy);
        const radiusSum = Math.min(a.w, a.h) / 2 + Math.min(b.w, b.h) / 2;
        const labelA = laidOut[i].widget.kind === 'dpad' ? 'dpad' : laidOut[i].widget.id;
        const labelB = laidOut[j].widget.kind === 'dpad' ? 'dpad' : laidOut[j].widget.id;
        expect(dist, `${labelA} vs ${labelB}`).toBeGreaterThanOrEqual(radiusSum - 1e-9);
      }
    }
  }

  /** どの部品も .console-card の範囲(x が CARD_LEFT〜CARD_RIGHT)に侵入していないか(=画面に被らない)。 */
  function expectNoIntrusionIntoCard(laidOut: readonly LaidOutWidget[]): void {
    for (const { widget, rect } of laidOut) {
      const label = widget.kind === 'dpad' ? 'dpad' : widget.id;
      const intrudesLeft = rect.x + rect.w > CARD_LEFT && rect.x < CARD_LEFT;
      const withinCard = rect.x >= CARD_LEFT && rect.x + rect.w <= CARD_RIGHT;
      const intrudesRight = rect.x < CARD_RIGHT && rect.x + rect.w > CARD_RIGHT;
      expect(intrudesLeft || withinCard || intrudesRight, `${label} は x=[${rect.x},${rect.x + rect.w}]`).toBe(false);
    }
  }

  it('6ボタン集合: 全部品がそれぞれの余白ボックス(左右)の内側に収まる', () => {
    const laidOut = layoutVpadSides(REALISTIC_BOXES, SIX_BUTTON_IDS);
    const leftWidgets = laidOut.filter((l) => l.rect.x < CARD_LEFT);
    const rightWidgets = laidOut.filter((l) => l.rect.x >= CARD_LEFT);
    expect(leftWidgets.length).toBeGreaterThan(0);
    expect(rightWidgets.length).toBeGreaterThan(0);
    expectWithinBox(leftWidgets, REALISTIC_BOXES.left);
    expectWithinBox(rightWidgets, REALISTIC_BOXES.right);
  });

  it('6ボタン集合: ボタン同士が重ならない', () => {
    const laidOut = layoutVpadSides(REALISTIC_BOXES, SIX_BUTTON_IDS);
    expectNoOverlap(laidOut);
  });

  it('6ボタン集合: どの部品も.console-cardの範囲(x=194〜618)に侵入していない(画面に被らない)', () => {
    const laidOut = layoutVpadSides(REALISTIC_BOXES, SIX_BUTTON_IDS);
    expectNoIntrusionIntoCard(laidOut);
  });

  it('右ボックス: 下段A→B→C・上段X→Y→Zとも右へ行くほどyが小さい(右上がり)', () => {
    const laidOut = layoutVpadSides(REALISTIC_BOXES, SIX_BUTTON_IDS);
    const cy = (l: LaidOutWidget) => l.rect.y + l.rect.h / 2;
    const a = findButton(laidOut, 'btn-a');
    const b = findButton(laidOut, 'btn-b');
    const c = findButton(laidOut, 'btn-c');
    const d = findButton(laidOut, 'btn-d');
    const e = findButton(laidOut, 'btn-e');
    const f = findButton(laidOut, 'btn-f');
    expect(cy(a)).toBeGreaterThan(cy(b));
    expect(cy(b)).toBeGreaterThan(cy(c));
    expect(cy(d)).toBeGreaterThan(cy(e));
    expect(cy(e)).toBeGreaterThan(cy(f));
  });

  it('2ボタン集合: Aが右(xがBより大きい)', () => {
    const laidOut = layoutVpadSides(REALISTIC_BOXES, TWO_BUTTON_IDS);
    const a = findButton(laidOut, 'btn-a');
    const b = findButton(laidOut, 'btn-b');
    expect(a.rect.x + a.rect.w / 2).toBeGreaterThan(b.rect.x + b.rect.w / 2);
  });

  it('わざと狭いボックス(幅140px)でもはみ出し・重なりが起きない(縮小が効いている)', () => {
    const narrowBoxes: VpadSideBoxes = {
      left: { x: 0, y: STAGE_TOP, w: 140, h: 283 },
      right: { x: 140, y: STAGE_TOP, w: 140, h: 283 },
    };
    const laidOut = layoutVpadSides(narrowBoxes, SIX_BUTTON_IDS);
    const leftWidgets = laidOut.filter((l) => l.rect.x < 140);
    const rightWidgets = laidOut.filter((l) => l.rect.x >= 140);
    expectWithinBox(leftWidgets, narrowBoxes.left);
    expectWithinBox(rightWidgets, narrowBoxes.right);
    expectNoOverlap(laidOut);
  });
});
