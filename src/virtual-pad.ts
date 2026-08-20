/**
 * バーチャルパッド(オンスクリーンパッド)。stage に重ねるオーバーレイ1枚として、
 * 方向入力(見た目はアナログスティック。円のベース+中央のノブ)・ボタンA〜F・
 * 補助ボタン opt1/opt2 をタッチで操作できるようにする。
 *
 * 割当の解決(画面部品ID -> joy/key)は自前で書き直さず、必ず GamepadManager の
 * bitsForSources()/keysForSources() を経由する(gamepad.ts のコメント「軸判定」節や
 * padType 別のビット割当ロジックの二重実装を避けるため。詳細は docs/DESIGN.md
 * 「バーチャルパッド」節を参照)。
 *
 * このファイルは UI 配線(main.ts への組み込み)を含まない。DOM 生成とポインタ処理までが責務。
 */

import { GamepadManager, type PadType, type Source } from './gamepad.ts';
import type { InputProfile } from './input-profile.ts';
import type { SharedKeyInput } from './virtual-keyboard.ts';

/** バーチャルパッド入力元は 'vpad' 固定(SharedKeyInput の参照カウントで仮想キーボードと衝突しない)。 */
const VPAD_SOURCE = 'vpad';

// --- レイアウト定義 ---

export type VpadWidget =
  | { kind: 'dpad'; ids: { up: string; down: string; left: string; right: string }; xPct: number; yPct: number; sizePct: number }
  | { kind: 'button'; id: string; label: string; xPct: number; yPct: number; sizePct: number };

/**
 * パネルモード(横長の帯。console-card内に置く)/オーバーレイモード(stageに重ねる)/
 * サイドモード(横持ちフルスクリーンで .console-card の左右に生じるデッドスペースへ
 * スティック・ボタンを振り分け、画面には重ねない)の3種類。判定順・reparent先の
 * 詳細は main.ts の rescale()/applyVpadPlacement() を参照。
 */
export type VpadPlacement = 'panel' | 'overlay' | 'sides';

/** dpad部品(方向入力4id共通)。placementで座標だけ変わる。 */
const DPAD_IDS = { up: 'dpad-up', down: 'dpad-down', left: 'dpad-left', right: 'dpad-right' } as const;

/**
 * オーバーレイ用dpad座標。xPct/yPct は stage に対する中心座標(%)、sizePct は
 * min(stageW, stageH) に対する一辺(%)。数値は docs/DESIGN.md の実装順4節にある座標を
 * そのまま定数化したもの(推測を含まない)。
 */
const OVERLAY_DPAD: Extract<VpadWidget, { kind: 'dpad' }> = { kind: 'dpad', ids: DPAD_IDS, xPct: 18, yPct: 76, sizePct: 38 };

/**
 * パネル用dpad座標(実機の縦持ちで実測した帯: 375x812 の画面幅で 367x260、ほぼ正方形)。
 * sizePct はオーバーレイ版と同じく min(stageW, stageH) を基準にする(layoutVpad の
 * basis='min' 引数参照)。帯が正方形に近いため、高さ基準にすると部品が巨大化して
 * はみ出す・重なるという破綻が過去に起きた(実機スクリーンショットで検出)。
 */
const PANEL_DPAD: Extract<VpadWidget, { kind: 'dpad' }> = { kind: 'dpad', ids: DPAD_IDS, xPct: 24, yPct: 55, sizePct: 62 };

/** ボタンの座標だけを持つ枠(3列×2段の格子1マス分)。ラベル・部品IDは vpadWidgetsFor() 側で決める。 */
interface ButtonSlot {
  xPct: number;
  yPct: number;
  sizePct: number;
}

/**
 * 6ボタン格子の「右上がり」の傾き量(1列あたり何%上げるか)。実機のメガドライブ6ボタンパッド
 * (参考: https://forums.libretro.com/t/flat-gamepad-overlays/3339/24 の flat gamepad overlay)は
 * 2段3列のボタン群全体が右へ行くほど高くなるよう緩く傾いている。実機で触って微調整する値なので
 * 名前付き定数として export し、ここを書き換えるだけで6箇所の座標全部が追従するようにする
 * (ベタ書きの表を9個並べない)。
 */
export const VPAD_SLANT_PCT_PANEL = 5;
export const VPAD_SLANT_PCT_OVERLAY = 4;

/**
 * 列のx座標(左/中/右)と、左列を基準にした下段・上段のベースyから、右の列ほど
 * slantPct ずつ y を引いて(=上げて)3列×2段のボタン格子を組み立てる。
 * 段の間隔(下段yPct-上段yPct)は列によらず一定に保たれる(平行四辺形になる)。
 */
function slantedButtonSlots(
  xs: readonly [number, number, number],
  lowerBaseYPct: number,
  upperBaseYPct: number,
  slantPct: number,
  sizePct: number,
): {
  lowerLeft: ButtonSlot;
  lowerMid: ButtonSlot;
  lowerRight: ButtonSlot;
  upperLeft: ButtonSlot;
  upperMid: ButtonSlot;
  upperRight: ButtonSlot;
} {
  const [xLeft, xMid, xRight] = xs;
  return {
    lowerLeft: { xPct: xLeft, yPct: lowerBaseYPct, sizePct },
    lowerMid: { xPct: xMid, yPct: lowerBaseYPct - slantPct, sizePct },
    lowerRight: { xPct: xRight, yPct: lowerBaseYPct - slantPct * 2, sizePct },
    upperLeft: { xPct: xLeft, yPct: upperBaseYPct, sizePct },
    upperMid: { xPct: xMid, yPct: upperBaseYPct - slantPct, sizePct },
    upperRight: { xPct: xRight, yPct: upperBaseYPct - slantPct * 2, sizePct },
  };
}

/**
 * オーバーレイ用ボタン格子(3列×2段)。列のx座標(60/74/88)・左列基準のy座標(下段82/上段60)は
 * 従来の VPAD_WIDGETS の座標(=傾き0のときの値)をそのまま踏襲する(はみ出し・重なりのテストが
 * 通っている値のため、新しい数値は発明しない)。そこへ VPAD_SLANT_PCT_OVERLAY ぶんの
 * 右上がりの傾きを加える。
 */
const OVERLAY_BUTTON_SLOTS = slantedButtonSlots([60, 74, 88], 82, 60, VPAD_SLANT_PCT_OVERLAY, 18);

/**
 * パネル用ボタン格子。列のx座標(58/74/90)・左列基準のy座標(下段72/上段30)は従来の
 * VPAD_PANEL_WIDGETS(=傾き0のときの値)を踏襲し、VPAD_SLANT_PCT_PANEL ぶんの傾きを加える。
 */
const PANEL_BUTTON_SLOTS = slantedButtonSlots([58, 74, 90], 72, 30, VPAD_SLANT_PCT_PANEL, 22);

/**
 * 補助ボタン(1/2)。2ボタン/6ボタンで配置は変わらない。
 * **並びは placement によらず「左から 1、2」に揃える。** 以前は overlay だけ opt1 が右で、
 * panel は opt1 が左と食い違っていた(実機のスクリーンショットで発覚)。ラベルが数字である以上、
 * 読み順どおりに並んでいないと押し間違える。
 */
const OVERLAY_OPT_SLOTS = {
  opt1: { xPct: 78, yPct: 8, sizePct: 10 } satisfies ButtonSlot,
  opt2: { xPct: 90, yPct: 8, sizePct: 10 } satisfies ButtonSlot,
};
const PANEL_OPT_SLOTS = {
  opt1: { xPct: 34, yPct: 12, sizePct: 14 } satisfies ButtonSlot,
  opt2: { xPct: 47, yPct: 12, sizePct: 14 } satisfies ButtonSlot,
};

function button(id: string, label: string, slot: ButtonSlot): Extract<VpadWidget, { kind: 'button' }> {
  return { kind: 'button', id, label, xPct: slot.xPct, yPct: slot.yPct, sizePct: slot.sizePct };
}

/**
 * この中のいずれかが束縛されていれば「6ボタン配置」とみなす(仕様どおりの単純な判定)。
 * 2ボタン配置との切り替えはこの集合の有無だけで行う。
 */
const SIX_BUTTON_MARKER_IDS: readonly string[] = ['btn-c', 'btn-d', 'btn-e', 'btn-f'];

/**
 * 束縛されている部品ID集合から、実際に描画すべき配置(部品ID・ラベル・座標の組)を返す。
 * 静的な1枚の表(旧 VPAD_WIDGETS/VPAD_PANEL_WIDGETS)ではなく関数にしたのは、ボタンの
 * 個数(2ボタン/6ボタン)で「同じ画面部品ID」に割り当てるラベル・座標が変わるため
 * (メガドライブ6ボタンパッド実機に合わせる。docs/DESIGN.md参照)。
 *
 * - 2ボタン配置: btn-a が右端(従来どおり)、btn-b がその左。
 * - 6ボタン配置: 下段(左→右) btn-a(A)/btn-b(B)/btn-c(C)、上段(左→右) btn-d(X)/btn-e(Y)/btn-f(Z)。
 *   btn-a が下段の左端になる点が2ボタン配置と逆になる。
 *
 * 部品ID(btn-a〜btn-f 等)自体は変えない(InputProfile.bindings のキーとして保存されるため)。
 * 変わるのはラベルと座標の対応だけ。座標値そのものは OVERLAY_BUTTON_SLOTS/PANEL_BUTTON_SLOTS
 * (=旧 VPAD_WIDGETS/VPAD_PANEL_WIDGETS の値)をそのまま使い、新しい数値は発明しない。
 */
export function vpadWidgetsFor(placement: VpadPlacement, boundIds: ReadonlySet<string>): VpadWidget[] {
  const dpad = placement === 'panel' ? PANEL_DPAD : OVERLAY_DPAD;
  const slots = placement === 'panel' ? PANEL_BUTTON_SLOTS : OVERLAY_BUTTON_SLOTS;
  const optSlots = placement === 'panel' ? PANEL_OPT_SLOTS : OVERLAY_OPT_SLOTS;
  const isSixButton = SIX_BUTTON_MARKER_IDS.some((id) => boundIds.has(id));

  const buttonWidgets: Array<Extract<VpadWidget, { kind: 'button' }>> = isSixButton
    ? [
        button('btn-a', 'A', slots.lowerLeft),
        button('btn-b', 'B', slots.lowerMid),
        button('btn-c', 'C', slots.lowerRight),
        button('btn-d', 'X', slots.upperLeft),
        button('btn-e', 'Y', slots.upperMid),
        button('btn-f', 'Z', slots.upperRight),
      ]
    : [
        button('btn-b', 'B', slots.lowerMid),
        button('btn-a', 'A', slots.lowerRight),
      ];

  const optWidgets: Array<Extract<VpadWidget, { kind: 'button' }>> = [
    button('btn-opt1', '1', optSlots.opt1),
    button('btn-opt2', '2', optSlots.opt2),
  ];

  const out: VpadWidget[] = [];
  const dpadBound = boundIds.has(dpad.ids.up) || boundIds.has(dpad.ids.down) || boundIds.has(dpad.ids.left) || boundIds.has(dpad.ids.right);
  if (dpadBound) out.push(dpad);
  for (const w of buttonWidgets) if (boundIds.has(w.id)) out.push(w);
  for (const w of optWidgets) if (boundIds.has(w.id)) out.push(w);
  return out;
}

// --- 純粋関数(DOM非依存) ---

/** px, stage左上原点の矩形。 */
export interface VpadRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LaidOutWidget {
  widget: VpadWidget;
  rect: VpadRect;
}

/**
 * 矩形を [0,maxW] x [0,maxH] の内側へ収まるよう、サイズは変えずに位置だけ押し戻す。
 * 押しやすさ(タップ判定の大きさ)が変わらないよう clamp はサイズ不変が前提で、
 * 部品が親より大きい(通常あり得ない)場合だけ位置を0に寄せる。
 */
function clampRectToBounds(rect: VpadRect, maxW: number, maxH: number): VpadRect {
  let x = rect.x;
  let y = rect.y;
  if (rect.w >= maxW) {
    x = 0;
  } else {
    if (x < 0) x = 0;
    if (x + rect.w > maxW) x = maxW - rect.w;
  }
  if (rect.h >= maxH) {
    y = 0;
  } else {
    if (y < 0) y = 0;
    if (y + rect.h > maxH) y = maxH - rect.h;
  }
  return { x, y, w: rect.w, h: rect.h };
}

/**
 * stage のピクセルサイズと拡大率から各部品の矩形を求める。
 * scale は widgets 全体を一律に縮小する係数(既定1=等倍)。sizePct は
 * min(stageW, stageH) に対する一辺の比率で決める(横長/縦長どちらでも部品が
 * stage からはみ出しにくいよう、短辺基準にしてある)。
 * 算出後、各矩形は clampRectToBounds() で [0,stageW]x[0,stageH] の内側へ
 * 押し戻す(サイズは変えず位置だけ動かす。オーバーレイ/パネル両モード共通)。
 */
export function layoutVpad(
  stageW: number,
  stageH: number,
  widgets: readonly VpadWidget[],
  scale: number = 1,
  basis: 'min' | 'height' = 'min',
): LaidOutWidget[] {
  const base = basis === 'height' ? stageH : Math.min(stageW, stageH);
  return widgets.map((widget) => {
    const size = (base * widget.sizePct) / 100 * scale;
    const cx = (stageW * widget.xPct) / 100;
    const cy = (stageH * widget.yPct) / 100;
    const rect = clampRectToBounds({ x: cx - size / 2, y: cy - size / 2, w: size, h: size }, stageW, stageH);
    return { widget, rect };
  });
}

/**
 * rect を、原点が (0,0) でない矩形 box の内側([box.x, box.x+box.w] x [box.y, box.y+box.h])へ
 * 収める版の clampRectToBounds()。box のローカル座標系へ平行移動してから既存の
 * clampRectToBounds() へ委譲し、結果を box の座標系へ戻す(サイズ不変で位置だけ動かす
 * という契約はそのまま流用する)。
 */
function clampRectToBox(rect: VpadRect, box: VpadRect): VpadRect {
  const local = clampRectToBounds({ x: rect.x - box.x, y: rect.y - box.y, w: rect.w, h: rect.h }, box.w, box.h);
  return { x: local.x + box.x, y: local.y + box.y, w: local.w, h: local.h };
}

/** 左右の余白ボックス(px, ビューポート原点)。main.ts の rescale() が .console-card と .stage の実測から作る。 */
export interface VpadSideBoxes {
  left: VpadRect;
  right: VpadRect;
}

export interface SafeAreaInsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** セーフエリアが無い(切り欠きの無い端末・ブラウザ表示)ときの値。 */
export const NO_SAFE_AREA: SafeAreaInsets = { left: 0, right: 0, top: 0, bottom: 0 };

/**
 * sides配置の左右ボックスを、ステージ(.stage)の矩形・ビューポート・セーフエリアから決める。
 *
 * index.html の viewport は viewport-fit=cover なので、ホーム画面から開いた
 * スタンドアロン表示や Android の全画面では、ビューポートが切り欠きの下まで広がる。
 * ボックスを x:0〜innerWidth のまま取ると、外縁へ寄る部品(左のスティック/右端のボタン)が
 * 切り欠きに隠れる(WebNP2 で実機実測、2026-08-20)。
 * 切り欠きは端末の持ち方で左右どちらにも来るので、必ず両側を引く
 * (どちら側が実際に塞がっているかは resolveLandscapeInsets() が別途扱う)。
 * 上下も同様に詰める。負の幅・高さは作らない。
 */
export function vpadSideBoxesFor(
  stage: VpadRect,
  viewport: { width: number; height: number },
  insets: SafeAreaInsets,
): VpadSideBoxes {
  const top = Math.max(stage.y, insets.top);
  const bottom = Math.min(stage.y + stage.h, viewport.height - insets.bottom);
  const h = Math.max(0, bottom - top);
  const rightX = stage.x + stage.w;
  return {
    left: { x: insets.left, y: top, w: Math.max(0, stage.x - insets.left), h },
    right: { x: rightX, y: top, w: Math.max(0, viewport.width - insets.right - rightX), h },
  };
}

/**
 * 左右対称に返ってきたインセットから、実際に塞がっている側だけを残す。
 *
 * iOS は横向きのとき左右へ同じ値を返す(WebNP2 での実機実測: iPhone / inner 852x393 /
 * angle 90 / inset left 59・right 59)。だが実際に隠れるのは切り欠き側だけで、
 * 反対側は完全に見えている。両方避けると片側ぶん(59px)を無駄に捨て、
 * ボタンが1個ぶん小さくなる。
 *
 * angle 90 で切り欠きが左・270 で右(どちらも WebNP2 で実機確認済み)。
 * 触らない条件を広く取ってあるので、切り欠きの無い端末は素通りする:
 *   - 左右が 0 (切り欠き無し端末・iPad・Chrome等のブラウザ表示) → そのまま
 *   - 左右が同値でない (Android のパンチホール等、値が正確に返る場合) → そのまま
 *   - 縦向き(angle 0/180)・角度が取れない・想定外の角度 → そのまま(安全側)
 * 残る危険は「左右とも本当に塞がっている端末」で左右同値が返る場合だけで、これは未検証。
 */
export function resolveLandscapeInsets(insets: SafeAreaInsets, angle: number | null): SafeAreaInsets {
  if (insets.left <= 0 || insets.left !== insets.right) return insets;
  if (angle === 90) return { ...insets, right: 0 };
  if (angle === 270) return { ...insets, left: 0 };
  return insets;
}

/** 画面の回転角。取れない環境では null。 */
export function screenAngle(): number | null {
  if (typeof screen === 'undefined') return null;
  const angle = screen.orientation?.angle;
  return typeof angle === 'number' ? angle : null;
}

/**
 * env(safe-area-inset-*) の実効値を px で読む。
 * カスタムプロパティ経由だと getComputedStyle が env() を解決しない環境があるため、
 * 実プロパティ(padding)へ入れた不可視の測定用要素から読む(style.css の .safe-area-probe)。
 * 要素は使い回す。
 */
let safeAreaProbe: HTMLElement | null = null;
export function readSafeAreaInsets(): SafeAreaInsets {
  if (typeof document === 'undefined') return NO_SAFE_AREA;
  if (!safeAreaProbe || !safeAreaProbe.isConnected) {
    safeAreaProbe = document.createElement('div');
    safeAreaProbe.className = 'safe-area-probe';
    document.body.append(safeAreaProbe);
  }
  const style = getComputedStyle(safeAreaProbe);
  const px = (value: string): number => {
    const n = parseFloat(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return {
    left: px(style.paddingLeft),
    right: px(style.paddingRight),
    top: px(style.paddingTop),
    bottom: px(style.paddingBottom),
  };
}

/*
 * sides配置の充填率。左右のボックスは縦長で細いため、部品の大きさはほぼ「箱の幅」で決まり、
 * 縦向き(panel配置)より小さくなる。はみ出さず互いに重ならない範囲まで詰めて取る
 * (WebNP2 で実機を見ながら決めた値をそのまま使う。2026-08-20)。
 */
/** スティック直径 / min(左ボックス幅, スティック領域高)。 */
const STICK_FILL = 0.9;
/** opt1/opt2 の中心間距離(左ボックス幅に対する比)。直径はこれを超えられない(重なるため)。 */
const OPT_PITCH_RATIO = 0.46;
/** 直径をピッチ/帯の高さぴったりにせず余裕を持たせる比率。 */
const OPT_MARGIN = 0.92;
/** オプション用に先取りする帯の高さの上限(左ボックス高に対する比)。 */
const OPT_BAND_MAX = 0.25;
/** ボタン直径 / min(列ピッチ, 行ピッチ)。 */
const GRID_MARGIN = 0.9;
/** オプションボタンのID(帯を取るかどうかの判定に使う)。 */
const OPT_SLOT_IDS = ['btn-opt1', 'btn-opt2'] as const;

/**
 * sides 配置(横持ちフルスクリーンで .console-card の左右に生じるデッドスペースへ
 * スティック・ボタンを振り分ける置き場所)の部品矩形を、左右の余白ボックスから直接計算する。
 *
 * layoutVpad() のような静的な xPct/yPct テーブルは使わない。余白の幅はビューポートの
 * サイズ次第で大きく変わり(横持ちの実測で左右194px、縦横比によってはもっと狭くなりうる)、
 * 固定の%テーブルでは「ボックスが狭いと部品同士が重なる/はみ出す」破綻を避けられないため。
 * 代わりに部品の直径をボックス自身の寸法(列ピッチ・行ピッチ・min(w,h)等)から比例計算し、
 * 位置の押し戻し(clampRectToBox、layoutVpad の clampRectToBounds と同じ考え方)だけでなく
 * サイズそのものをボックスに応じて縮めることで、どんなに狭いボックスでも
 * 「はみ出さない・重ならない」を数式的に保証する(反復的な当たり判定→縮小の試行錯誤はしない)。
 *
 * 配置方針(docs/DESIGN.md「バーチャルパッド」節参照):
 * - 補助ボタン(opt1/opt2): 左ボックスの上部に帯を先取りして横並び。直径は帯の高さと
 *   横方向のピッチ(重ならない量)の小さい方から決める。スティックを先に最大化して
 *   「余った隙間」を回す方式だと、箱が横広のときオプションだけ極端に潰れるため先に取る。
 * - スティック: 帯の下の残り領域の中央。直径は min(左ボックス幅, 残り高) * STICK_FILL。
 * - ボタン: 右ボックスに3列×2段。下段(y大きい方) 左→右 A/B/C、上段 左→右 X/Y/Z、
 *   右へ行くほど上がる(既存の VPAD_SLANT_PCT_OVERLAY と同じ「右上がり」の考え方だが、
 *   sides はボックス自体の寸法が可変なので、傾き量もボックス高さに対する比率で決める)。
 *   2ボタンのときは下段の中央・右(mid/right)スロットだけを使う(Aが右、Bがその左)。
 *   列ピッチ・行ピッチは「実際に使うスロットの数」で割る(常に3列で割ると、2ボタン構成で
 *   使いもしない1列ぶん横幅を捨ててボタンが小さくなる)。
 *   列ピッチ・行ピッチの小さい方より必ず小さい直径にすることで、格子内のどの2部品も
 *   (同じ行・同じ列・斜めのいずれでも)中心間距離が直径を下回らないことを保証する。
 */
export function layoutVpadSides(boxes: VpadSideBoxes, boundIds: ReadonlySet<string>): LaidOutWidget[] {
  const { left, right } = boxes;
  const out: LaidOutWidget[] = [];

  // --- 左ボックス: スティック + 補助ボタン ---
  const dpadBound =
    boundIds.has(DPAD_IDS.up) || boundIds.has(DPAD_IDS.down) || boundIds.has(DPAD_IDS.left) || boundIds.has(DPAD_IDS.right);

  // オプション(1/2)の帯を先に取り、残りをスティックへ割り当てる。スティックを先に
  // 最大化して「余った隙間」をオプションに回すと、箱が横広のときオプションだけ極端に
  // 潰れる(WebNP2 の実測で 28.8px)。取り分は先に決める。
  const hasOptions = OPT_SLOT_IDS.some((id) => boundIds.has(id));
  const optBand = hasOptions ? Math.min(left.w * OPT_PITCH_RATIO, left.h * OPT_BAND_MAX) : 0;
  const stickAreaY = left.y + optBand;
  const stickAreaH = Math.max(0, left.h - optBand);
  const stickDiameter = Math.min(left.w, stickAreaH) * STICK_FILL;
  const stickCx = left.x + left.w / 2;
  const stickCy = stickAreaY + stickAreaH / 2;
  if (dpadBound) {
    const rect = clampRectToBox(
      { x: stickCx - stickDiameter / 2, y: stickCy - stickDiameter / 2, w: stickDiameter, h: stickDiameter },
      left,
    );
    out.push({ widget: { kind: 'dpad', ids: DPAD_IDS, xPct: 0, yPct: 0, sizePct: 0 }, rect });
  }

  // 先に取り分けた帯へ補助ボタンを横並びに置く(帯が無ければ直径0=非表示相当)。
  const optDiameter = Math.max(0, optBand * OPT_MARGIN);
  const optCy = left.y + optBand / 2;
  // 並びは OVERLAY_OPT_SLOTS/PANEL_OPT_SLOTS と揃えて「左から 1、2」。
  // 中心間の距離はちょうど OPT_PITCH_RATIO(直径の根拠にした量)になるようにする。
  const optSlots: ReadonlyArray<{ id: string; label: string; cxRatio: number }> = [
    { id: 'btn-opt1', label: '1', cxRatio: 0.5 - OPT_PITCH_RATIO / 2 },
    { id: 'btn-opt2', label: '2', cxRatio: 0.5 + OPT_PITCH_RATIO / 2 },
  ];
  for (const slot of optSlots) {
    if (!boundIds.has(slot.id)) continue;
    const cx = left.x + left.w * slot.cxRatio;
    const rect = clampRectToBox({ x: cx - optDiameter / 2, y: optCy - optDiameter / 2, w: optDiameter, h: optDiameter }, left);
    out.push({ widget: { kind: 'button', id: slot.id, label: slot.label, xPct: 0, yPct: 0, sizePct: 0 }, rect });
  }

  // --- 右ボックス: 3列×2段のボタン格子 ---
  const isSixButton = SIX_BUTTON_MARKER_IDS.some((id) => boundIds.has(id));
  type GridSlot = { row: 0 | 1; col: 0 | 1 | 2; id: string; label: string };
  // row: 1=下段(y大きい方)、0=上段。col: 0=左/1=中/2=右。
  const gridSlots: readonly GridSlot[] = isSixButton
    ? [
        { row: 1, col: 0, id: 'btn-a', label: 'A' },
        { row: 1, col: 1, id: 'btn-b', label: 'B' },
        { row: 1, col: 2, id: 'btn-c', label: 'C' },
        { row: 0, col: 0, id: 'btn-d', label: 'X' },
        { row: 0, col: 1, id: 'btn-e', label: 'Y' },
        { row: 0, col: 2, id: 'btn-f', label: 'Z' },
      ]
    : [
        { row: 1, col: 1, id: 'btn-b', label: 'B' },
        { row: 1, col: 2, id: 'btn-a', label: 'A' },
      ];

  // 段/列は「実際に使う数」で割る。2ボタン構成は col 1,2 の2列しか使わないので、
  // 常に3で割っていると横幅を1列ぶん捨てたままボタンが小さくなる。
  const usedSlots = gridSlots.filter((slot) => boundIds.has(slot.id));
  const usedCols = usedSlots.map((slot) => slot.col);
  const usedRows = usedSlots.map((slot) => slot.row);
  const minCol = usedCols.length > 0 ? Math.min(...usedCols) : 0;
  const colCount = usedCols.length > 0 ? Math.max(...usedCols) - minCol + 1 : 1;
  const rowCount = usedRows.length > 0 ? Math.max(...usedRows) - Math.min(...usedRows) + 1 : 1;
  const colPitchX = right.w / colCount;
  const rowPitchY = right.h / rowCount;
  // GRID_MARGIN: 列/行ピッチの小さい方に対する直径の比率。1未満にすることで、同列・同行は
  // もちろん斜め(ピッチのベクトル和で常に単独ピッチ以上離れる)でも重ならない。
  const gridDiameter = Math.min(colPitchX, rowPitchY) * GRID_MARGIN;
  // 右へ行くほど上がる傾き。VPAD_SLANT_PCT_OVERLAY と同じ「列ごとに一定量上げる」考え方を
  // ボックス高さに対する比率(定数)で表す(sides はボックスの実寸が可変なため、既存の
  // %テーブルではなくここだけの専用比率を使う)。
  const SLANT_RATIO = 0.045;
  const slantPx = right.h * SLANT_RATIO;
  const lowerBaseY = right.y + right.h * 0.68;
  const upperBaseY = right.y + right.h * 0.3;

  for (const slot of gridSlots) {
    if (!boundIds.has(slot.id)) continue;
    const cx = right.x + colPitchX * (slot.col - minCol + 0.5);
    const baseY = slot.row === 1 ? lowerBaseY : upperBaseY;
    const cy = baseY - slantPx * slot.col;
    const rect = clampRectToBox(
      { x: cx - gridDiameter / 2, y: cy - gridDiameter / 2, w: gridDiameter, h: gridDiameter },
      right,
    );
    out.push({ widget: { kind: 'button', id: slot.id, label: slot.label, xPct: 0, yPct: 0, sizePct: 0 }, rect });
  }

  return out;
}

/**
 * アナログスティック風UIの不感帯半径・ノブ最大変位半径。いずれもベース円の"直径"に対する比
 * (SBOP2 の手本 updateStick() と同じ基準。半径ではなく直径を基準にしているのは手本の実装に
 * 合わせるため。rect.w===rect.h の正方形前提)。
 */
export const STICK_DEADZONE_RATIO = 0.18;
export const STICK_MAX_RADIUS_RATIO = 0.5;

/**
 * ベース円の中心からのオフセットを8方向へスナップし、押されている方向ID(0〜2個)を返す。
 * 円の外の点でも計算できる(ベース円の外へ指が出てもスティック操作を継続する仕様のため。
 * 手本の updateStick() は touchmove を identifier で追跡し続け、円の内外を問わない)。
 *
 * SBOP2 手本の dirsFromOffset() と同じ方式: atan2(dy,dx) を45度セクタ8分割にする
 * (0=右,1=右下,2=下,3=左下,4=左,5=左上,6=上,7=右上)。斜めは隣接2方向の同時押しになる。
 * 旧 hitTestDpad() の「x/y成分を独立に閾値判定」方式は廃止した(スティック表現では
 * 手本の角度スナップのほうが「円周上のどこを押しても対応する方向が出る」自然な挙動になる)。
 */
export function stickDirsFromPoint(
  w: Extract<VpadWidget, { kind: 'dpad' }>,
  rect: VpadRect,
  px: number,
  py: number,
): string[] {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const diameter = Math.min(rect.w, rect.h);
  const dx = px - cx;
  const dy = py - cy;
  const deadzone = diameter * STICK_DEADZONE_RATIO;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < deadzone) return [];
  // 画面座標は下方向が+y。atan2(dy,dx): 右=0, 下=90, 左=180, 上=270(度)
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  const sector = Math.round(deg / 45) % 8;
  switch (sector) {
    case 0: return [w.ids.right];
    case 1: return [w.ids.right, w.ids.down];
    case 2: return [w.ids.down];
    case 3: return [w.ids.down, w.ids.left];
    case 4: return [w.ids.left];
    case 5: return [w.ids.left, w.ids.up];
    case 6: return [w.ids.up];
    default: return [w.ids.up, w.ids.right]; // case 7
  }
}

/**
 * ノブの表示オフセット(px, ベース中心からの相対座標)。最大半径(直径*STICK_MAX_RADIUS_RATIO)で
 * クランプする(手本の updateStick() の maxR と同じ)。translate() にそのまま渡せる値を返す。
 */
export function stickKnobOffset(rect: VpadRect, px: number, py: number): { x: number; y: number } {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const diameter = Math.min(rect.w, rect.h);
  const maxR = diameter * STICK_MAX_RADIUS_RATIO;
  const dx = px - cx;
  const dy = py - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > maxR && dist > 0) {
    return { x: (dx / dist) * maxR, y: (dy / dist) * maxR };
  }
  return { x: dx, y: dy };
}

/** ボタンを円形(矩形の内接円)として判定する。角をタップしても反応しないほうが誤爆が少ない。 */
function hitTestButton(rect: VpadRect, px: number, py: number): boolean {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const radius = Math.min(rect.w, rect.h) / 2;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * 一点が触れている部品IDの集合(dpad=スティックは方向IDに展開済み)。
 * 「押し始め」の判定に使う関数で、スティックのベース円内かどうかは円で判定する
 * (以前は矩形判定だったが、スティックは丸いUIなので角を押しても無反応になるべき)。
 * ベース円の外は完全に無反応 — 円の外へ出ても操作を継続する仕様は、ここではなく
 * pointerdown 時にスティックへ束縛されたポインタの pointermove 側(virtual-pad.ts の
 * ポインタ管理)が stickDirsFromPoint() を直接呼ぶことで実現する。
 */
export function hitTestVpad(laidOut: readonly LaidOutWidget[], px: number, py: number): string[] {
  const out: string[] = [];
  for (const { widget, rect } of laidOut) {
    if (widget.kind === 'dpad') {
      if (!hitTestButton(rect, px, py)) continue;
      out.push(...stickDirsFromPoint(widget, rect, px, py));
    } else {
      if (hitTestButton(rect, px, py)) out.push(widget.id);
    }
  }
  return out;
}

// --- 本体 ---

export interface VirtualPad {
  setVisible(visible: boolean): void;
  isVisible(): boolean;
  /** 有効プロファイルを差し替える(DOMを作り直す)。 */
  setProfile(profile: InputProfile): void;
  /** joy 出力先ポートのパッド種別(TRG3..TRG8 のビット位置が変わる)。 */
  setPadType(padType: PadType): void;
  /** 今フレームの RetroPad ID ビットマスク。main.ts の onPoll から呼ぶ。 */
  getJoyBits(): number;
  releaseAll(): void;
  /** stage のサイズが変わったときに呼ぶ(再レイアウト)。 */
  refreshLayout(): void;
  /**
   * パネルモード(console-card内の帯)/オーバーレイモード(stageに重ねる)/
   * サイドモード(左右のデッドスペース)を切り替える。DOM の親要素を付け替えるのは
   * 呼び出し側(main.ts の rescale()/applyVpadPlacement())の責務で、ここでは
   * 座標計算方式の切替のみ行う(panel/overlay は layoutVpad()、sides は
   * layoutVpadSides() を doRefreshLayout() 内で使い分ける)。
   * sidesBoxes は placement==='sides' のときの左右ボックス(px, ビューポート原点)。
   * placement が変わらなくてもボックスは毎回更新する(ビューポートサイズ変化に追従するため)。
   */
  setPlacement(placement: VpadPlacement, sidesBoxes?: VpadSideBoxes): void;
}

/** touch Source を作る(id は画面部品ID、bindings のキーと1:1)。 */
function touchSource(id: string): Source {
  return { kind: 'touch', id };
}

export function createVirtualPad(overlay: HTMLElement, input: SharedKeyInput): VirtualPad {
  overlay.classList.add('virtual-pad', 'vpad-overlay', 'hidden');
  // canvas側のポインタロック/マウス経路へ触れさせない。touch-action:none自体はCSS側の責務だが、
  // JSでも明示しておくとCSS未適用時の事故(スクロール発生等)を防げる。
  overlay.style.touchAction = 'none';

  let widgets: readonly VpadWidget[] = [];
  let manager = new GamepadManager([]);
  let padType: PadType = 'default';
  let laidOut: LaidOutWidget[] = [];
  const elementsById = new Map<string, HTMLElement>();
  // スティックのノブ要素。buildDom() の都度作り直す(overlay.replaceChildren()で古い要素は消える)。
  let stickKnobEl: HTMLElement | null = null;
  // 現在有効なプロファイルの割当先ID集合(setPlacement() 時に widgets を作り直すために保持する。
  // DOM 要素の集合はこの ID 集合だけで決まり、置き場所(placement)には依存しないので、
  // placement を切り替えても buildDom() を呼び直す必要はない)。
  let bindingIds = new Set<string>();
  let placement: VpadPlacement = 'overlay';
  // sides 配置での左右ボックス。main.ts が setPlacement() のたびに渡す(ビューポートが
  // 変わるたびに main.ts の rescale() 経由で更新される想定)。未設定/sides以外では未使用。
  let sidesBoxes: VpadSideBoxes | null = null;

  /** 現在の placement とプロファイルの束縛ID集合から、実際に描画する部品配置を決める。 */
  function widgetsForPlacement(pl: VpadPlacement): VpadWidget[] {
    return vpadWidgetsFor(pl, bindingIds);
  }

  /**
   * 指ごとの状態。'parts' は従来どおり「触れている部品ID集合」(ボタンを滑らせる操作用)。
   * 'stick' は「この指はスティックのベース円に束縛されている」ことを表し、円の外へ出ても
   * 追跡を続ける(手本の stickTouchId と同じ役割)。dirs は最新の stickDirsFromPoint() の結果を
   * 保持し、unionActiveIds() で他の指の押下と合成する。
   */
  type PointerState = { kind: 'stick'; dirs: string[] } | { kind: 'parts'; ids: string[] };
  const perPointer = new Map<number, PointerState>();
  let activeIds = new Set<string>();

  function unionActiveIds(): Set<string> {
    const out = new Set<string>();
    for (const state of perPointer.values()) {
      const ids = state.kind === 'stick' ? state.dirs : state.ids;
      for (const id of ids) out.add(id);
    }
    return out;
  }

  /** 現在の laidOut からスティック(dpad)部品を探す。無ければ undefined(bindings未設定など)。 */
  function findStick(): (LaidOutWidget & { widget: Extract<VpadWidget, { kind: 'dpad' }> }) | undefined {
    return laidOut.find((l): l is LaidOutWidget & { widget: Extract<VpadWidget, { kind: 'dpad' }> } => l.widget.kind === 'dpad');
  }

  /** 押されている部品集合が変わったときだけ見た目(activeクラス)とキー入力を更新する。 */
  function applyActiveIds(next: Set<string>): void {
    for (const id of next) {
      if (!activeIds.has(id)) elementsById.get(id)?.classList.add('active');
    }
    for (const id of activeIds) {
      if (!next.has(id)) elementsById.get(id)?.classList.remove('active');
    }
    activeIds = next;

    const sources: Source[] = [...activeIds].map(touchSource);
    const keys = manager.keysForSources(sources);
    // SharedKeyInput は source文字列単位で参照カウントするため、'vpad' という1つの
    // source名で「今押されているキー集合」をそのまま突き合わせれば差分だけ press/release される
    // (押しっぱなしのキーへ再度pressしても参照カウントは増えず二重解放も起きない実装、
    // virtual-keyboard.ts の SharedKeyInput 参照)。ただし press/release は集合の差分でだけ
    // 呼ぶ必要があるため、現在保持しているキー集合を自前でも追跡する。
    const prevKeys = pressedKeys;
    for (const retrok of keys) if (!prevKeys.has(retrok)) input.press(VPAD_SOURCE, retrok);
    for (const retrok of prevKeys) if (!keys.has(retrok)) input.release(VPAD_SOURCE, retrok);
    pressedKeys = keys;
  }

  let pressedKeys = new Set<number>();

  /** DOM から部品要素を作る。bindings に載っている ID の部品だけを描画する(仕様どおり)。 */
  function buildDom(profile: InputProfile | null): void {
    overlay.replaceChildren();
    elementsById.clear();
    perPointer.clear();
    activeIds = new Set();
    pressedKeys = new Set();
    stickKnobEl = null;

    if (!profile) {
      widgets = [];
      laidOut = [];
      return;
    }

    bindingIds = new Set(Object.keys(profile.bindings));
    widgets = widgetsForPlacement(placement);

    const entries = Object.entries(profile.bindings).map(([id, binding]) => ({ source: touchSource(id), binding }));
    manager = new GamepadManager(entries);

    for (const widget of widgets) {
      if (widget.kind === 'dpad') {
        // 見せ方はアナログスティック(円のベース+中央のノブ)だが、widget.kind は 'dpad' のまま
        // (画面部品ID dpad-up/down/left/right・InputProfile.bindings のキーが localStorage に
        // 保存済みのため、意味=「方向入力部品」は変えず見た目だけ差し替える)。
        const stickEl = document.createElement('div');
        stickEl.className = 'vpad-stick';
        stickEl.setAttribute('role', 'group');
        stickEl.setAttribute('aria-label', '方向キー');
        const knobEl = document.createElement('div');
        knobEl.className = 'vpad-stick-knob';
        stickEl.append(knobEl);
        overlay.append(stickEl);
        stickKnobEl = knobEl;
      } else {
        const btnEl = document.createElement('div');
        btnEl.className = 'vpad-button';
        btnEl.dataset.id = widget.id;
        btnEl.setAttribute('role', 'button');
        btnEl.setAttribute('aria-label', widget.label);
        const label = document.createElement('span');
        label.textContent = widget.label;
        btnEl.append(label);
        overlay.append(btnEl);
        elementsById.set(widget.id, btnEl);
      }
    }

    doRefreshLayout();
  }

  function placeRect(el: HTMLElement, r: VpadRect): void {
    el.style.left = `${r.x}px`;
    el.style.top = `${r.y}px`;
    el.style.width = `${r.w}px`;
    el.style.height = `${r.h}px`;
  }

  function doRefreshLayout(): void {
    if (placement === 'sides') {
      // sides は overlay(#virtual-pad)自体が document.body 直下で position:fixed;inset:0
      // になっており、overlay のローカル座標=ビューポート座標なので、layoutVpadSides() が
      // 返す矩形(ビューポート原点)をそのまま left/top へ使える(layoutVpad のように
      // overlay.getBoundingClientRect() 基準へ変換し直す必要が無い)。
      laidOut = sidesBoxes ? layoutVpadSides(sidesBoxes, bindingIds) : [];
    } else {
      const rect = overlay.getBoundingClientRect();
      // パネル/オーバーレイどちらも 'min'(短辺基準)に統一する。パネルは実測で正方形に近く、
      // 'height' 基準だと部品が巨大化してはみ出す・重なる破綻が起きた(実機検証済み)。
      laidOut = layoutVpad(rect.width, rect.height, widgets, 1, 'min');
    }
    for (const { widget, rect: r } of laidOut) {
      if (widget.kind === 'dpad') {
        // スティックのベース円(.vpad-stick)を配置する。ノブはベース内の相対配置(CSSのleft/top:50%)
        // + transform(translate) で動かすので、ここではベース自体の矩形だけ決めればよい。
        const stickEl = overlay.querySelector<HTMLElement>('.vpad-stick');
        if (stickEl) placeRect(stickEl, r);
        continue;
      }
      const el = elementsById.get(widget.id);
      if (el) placeRect(el, r);
    }
  }

  /**
   * ノブの表示位置を更新する(overlay座標系の px, py から stickKnobOffset() を経由)。
   * dirs(そのpx,pyで実際に方向入力が出ているか)に応じて 'active' クラスも切り替え、
   * デッドゾーン内(無入力)とそれ以外を見た目でも区別する(押下中は少し明るくする要望)。
   */
  function updateKnobVisual(stickRect: VpadRect, px: number, py: number, dirs: readonly string[]): void {
    if (!stickKnobEl) return;
    const { x, y } = stickKnobOffset(stickRect, px, py);
    stickKnobEl.style.transform = `translate(${x}px, ${y}px)`;
    stickKnobEl.classList.toggle('active', dirs.length > 0);
  }

  /** ノブを中央へ戻す(スティックを操作していた指が離れたとき)。 */
  function resetKnobVisual(): void {
    if (!stickKnobEl) return;
    stickKnobEl.style.transform = 'translate(0px, 0px)';
    stickKnobEl.classList.remove('active');
  }

  function releaseAllInternal(): void {
    perPointer.clear();
    applyActiveIds(new Set());
    resetKnobVisual();
    input.releaseSource(VPAD_SOURCE);
  }

  // ポインタ処理はオーバーレイのコンテナ1枚で受ける(ボタン単位で setPointerCapture を取らない)。
  // 理由: バーチャルパッドは指を滑らせて斜め入力を作ったり(dpad内で隣接方向へ移動)、
  // ボタンAを押したまま指をボタンBへずらす操作が前提になる。setPointerCapture をボタン要素単位で
  // 取ってしまうと、キャプチャした要素が pointermove イベントを独占してしまい、指が別の部品の
  // 矩形に入ってもその部品ではイベントを受け取れず「ずらし操作」が機能しなくなる
  // (仮想キーボードは1ボタン=1キーの単純な押下だけで足りるため、ボタン単位キャプチャで問題ない。
  // バーチャルパッドはそれと要求が異なるため方式を変える)。
  // コンテナ(overlay)単位で setPointerCapture を取るのは可: この場合はキャプチャ先が
  // コンテナ自身なので、コンテナ内のどこに指が動いてもイベントはコンテナへ届き続け、
  // 毎回 hitTestVpad() で「今どの部品の上にいるか」を判定し直せる。
  /**
   * スティックに束縛された指は、ベース円の外へ出ても stickDirsFromPoint() で方向を出し続ける
   * (手本の touchmove 追跡と同じ)。それ以外の指は従来どおり hitTestVpad() で「今どの部品の
   * 上にいるか」を毎回判定し直す(ボタンを滑らせる操作のため)。
   */
  function handlePointerMove(event: PointerEvent): void {
    const state = perPointer.get(event.pointerId);
    if (!state) return;
    const rect = overlay.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    if (state.kind === 'stick') {
      const stick = findStick();
      if (!stick) return;
      const dirs = stickDirsFromPoint(stick.widget, stick.rect, px, py);
      perPointer.set(event.pointerId, { kind: 'stick', dirs });
      updateKnobVisual(stick.rect, px, py, dirs);
    } else {
      perPointer.set(event.pointerId, { kind: 'parts', ids: hitTestVpad(laidOut, px, py) });
    }
    applyActiveIds(unionActiveIds());
  }

  function handlePointerDown(event: PointerEvent): void {
    // キャプチャの取得は「失敗しても入力自体は成立させる」扱いにする。
    // setPointerCapture() は指定 pointerId がアクティブでない場合に NotFoundError を投げる仕様で、
    // ここが未捕捉のまま先頭に居ると、投げた瞬間に押下処理そのもの(perPointer への登録・
    // SharedKeyInput への press)が丸ごと飛ぶ。キャプチャはオーバーレイ外へ指がはみ出した時の
    // 追従を良くするための最適化にすぎないので、失敗は握りつぶして押下処理を続行する。
    try {
      overlay.setPointerCapture(event.pointerId);
    } catch {
      /* キャプチャできなくても押下自体は成立させる(上のコメント参照)。 */
    }
    const rect = overlay.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    // スティックのベース円内かどうかを円で判定する(手本のtouchstartと同じ)。円内であれば
    // その指をスティックへ束縛し、以後は円の外に出ても追従し続ける(handlePointerMove参照)。
    const stick = findStick();
    if (stick && hitTestButton(stick.rect, px, py)) {
      const dirs = stickDirsFromPoint(stick.widget, stick.rect, px, py);
      perPointer.set(event.pointerId, { kind: 'stick', dirs });
      updateKnobVisual(stick.rect, px, py, dirs);
    } else {
      perPointer.set(event.pointerId, { kind: 'parts', ids: hitTestVpad(laidOut, px, py) });
    }
    applyActiveIds(unionActiveIds());
  }

  function handlePointerEnd(event: PointerEvent): void {
    const state = perPointer.get(event.pointerId);
    if (!state) return;
    perPointer.delete(event.pointerId);
    if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
    if (state.kind === 'stick') {
      // 他の指がまだスティックを掴んでいなければノブを中央へ戻す(手本の releaseStick())。
      const stillHeld = [...perPointer.values()].some((s) => s.kind === 'stick');
      if (!stillHeld) resetKnobVisual();
    }
    applyActiveIds(unionActiveIds());
  }

  overlay.addEventListener('pointerdown', handlePointerDown);
  overlay.addEventListener('pointermove', handlePointerMove);
  overlay.addEventListener('pointerup', handlePointerEnd);
  overlay.addEventListener('pointercancel', handlePointerEnd);

  // 押しっぱなしの固着対策(仮想キーボードと同じ流儀。virtual-keyboard.ts の releaseAll 参照)。
  window.addEventListener('blur', releaseAllInternal);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAllInternal();
  });
  window.addEventListener('resize', doRefreshLayout);
  window.addEventListener('orientationchange', doRefreshLayout);

  return {
    setVisible(visible: boolean): void {
      overlay.classList.toggle('hidden', !visible);
      if (visible) doRefreshLayout();
      else releaseAllInternal();
    },
    isVisible(): boolean {
      return !overlay.classList.contains('hidden');
    },
    setProfile(profile: InputProfile): void {
      releaseAllInternal();
      buildDom(profile);
    },
    setPadType(next: PadType): void {
      padType = next;
    },
    getJoyBits(): number {
      const sources: Source[] = [...activeIds].map(touchSource);
      return manager.bitsForSources(sources, padType);
    },
    releaseAll: releaseAllInternal,
    refreshLayout: doRefreshLayout,
    setPlacement(next: VpadPlacement, nextSidesBoxes?: VpadSideBoxes): void {
      // sides のボックスは placement が変わらない呼び出しでも常に更新する
      // (ビューポートサイズが変わるたびに main.ts の rescale() が新しいボックスを渡すため)。
      if (nextSidesBoxes) sidesBoxes = nextSidesBoxes;
      if (placement === next) {
        if (next === 'sides') doRefreshLayout();
        return;
      }
      placement = next;
      overlay.classList.toggle('vpad-panel', next === 'panel');
      overlay.classList.toggle('vpad-overlay', next === 'overlay');
      overlay.classList.toggle('vpad-sides', next === 'sides');
      widgets = widgetsForPlacement(placement);
      doRefreshLayout();
    },
  };
}
