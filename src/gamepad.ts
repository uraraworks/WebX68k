/**
 * ゲームパッド(Gamepad API)入力を X68000 の 2 ボタンジョイスティック入力へ変換する。
 *
 * Phase 1 では既定マッピング(XINPUT_PRESET)固定で実際に遊べる状態を作るところまでが目標。
 * ただし後続フェーズ(ユーザーが割当を編集して永続化する)で型を作り直さずに済むよう、
 * 最初からマッピングをデータ(Source -> Binding の対応表)として表現しておく。
 * 編集UI・永続化(localStorage 保存等)は Phase 3/4 で追加する。
 */

/**
 * X68000 側の入力先。
 * UP/DOWN/LEFT/RIGHT は方向、TRG1/TRG2 が標準 2 ボタンパッドのボタン。
 * TRG3..TRG8 は px68k-libretro が対応する CPSF-MD/CPSF-SFC(8ボタン)パッド向け。
 * どの RetroPad ID がどの TRGn になるかは padType(px68k_joytype1/2 コアオプション)によって
 * 変わるため、対応表は retroIdFor()/RETRO_ID_MAPS を参照すること(このコメントでは決め打ちしない)。
 */
export type JoyTarget =
  | 'UP'
  | 'DOWN'
  | 'LEFT'
  | 'RIGHT'
  | 'TRG1'
  | 'TRG2'
  | 'TRG3'
  | 'TRG4'
  | 'TRG5'
  | 'TRG6'
  | 'TRG7'
  | 'TRG8';

/** isBinding() の検証用に全 JoyTarget を列挙したもの(値そのものには意味を持たせない)。 */
const ALL_JOY_TARGETS: readonly JoyTarget[] = [
  'UP',
  'DOWN',
  'LEFT',
  'RIGHT',
  'TRG1',
  'TRG2',
  'TRG3',
  'TRG4',
  'TRG5',
  'TRG6',
  'TRG7',
  'TRG8',
];

/**
 * px68k-libretro のパッド種別(px68k_joytype1/2 コアオプション)。
 * サイバースティックは対象外(アナログモード非対応・ポート2に選択肢自体が無い)。
 * 値は libretro_core_options.h の選択肢文字列と1:1(PAD_TYPE_CORE_OPTION_VALUE で変換する)。
 */
export type PadType = 'default' | 'cpsf-md' | 'cpsf-sfc';

export const PAD_TYPES: readonly PadType[] = ['default', 'cpsf-md', 'cpsf-sfc'];

/**
 * PadType -> px68k_joytype1/2 コアオプションの値文字列。
 * px68k-libretro/libretro_core_options.h の px68k_joytype1/2 の選択肢表記と完全一致させること
 * (update_variables() が strcmp で照合しており、1文字でもずれると PAD_2BUTTON にフォールバックする)。
 */
export const PAD_TYPE_CORE_OPTION_VALUE: Record<PadType, string> = {
  default: 'Default (2 Buttons)',
  'cpsf-md': 'CPSF-MD (8 Buttons)',
  'cpsf-sfc': 'CPSF-SFC (8 Buttons)',
};

/** その padType で編集/表示すべき JoyTarget 一覧(表示順)。2ボタンは TRG1/TRG2 のみ、8ボタンは TRG1..TRG8。 */
export function joyTargetsForPadType(padType: PadType): readonly JoyTarget[] {
  const base: JoyTarget[] = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'TRG1', 'TRG2'];
  if (padType === 'default') return base;
  return [...base, 'TRG3', 'TRG4', 'TRG5', 'TRG6', 'TRG7', 'TRG8'];
}

// UP/DOWN/LEFT/RIGHT は px68k-libretro/libretro/joystick.c の D-Pad 判定(RETRO_DEVICE_ID_JOYPAD_UP=4 等、
// Joystick_Update() 235行目付近)に合わせてある。padType に関わらず共通。
const DIRECTION_RETRO_IDS = { UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7 } as const;

/**
 * JoyTarget -> RetroPad ID(inputStateCb の id 引数、= libretro の RETRO_DEVICE_ID_JOYPAD_*)対応表。
 * padType ごとに異なる(px68k-libretro/libretro/joystick.c の Joystick_Update() が padType(=
 * Config.JOY_TYPE[port])に応じて別の分岐でボタンを解釈するため)。値は同ファイルの実装から
 * 確定させたもので、推測は含まない。
 *
 * - default(PAD_2BUTTON, 250行目付近): Config.VbtnSwap 既定 false のとき、
 *   RetroPad B(id=0) -> JOY_TRG1, RetroPad A(id=8) -> JOY_TRG2。
 * - cpsf-md(PAD_CPSF_MD, 279〜312行目): A(id=8)->TRG1(Low-Kick), B(id=0)->TRG2(Mid-Kick),
 *   Y(id=1)->TRG3(Mid-Punch), X(id=9)->TRG4(Low-Punch), L(id=10)->TRG5(High-Punch),
 *   Start(id=3)->TRG6, Select(id=2)->TRG7, R(id=11)->TRG8(High-Kick)。
 * - cpsf-sfc(PAD_CPSF_SFC, 314〜342行目): B(id=0)->TRG1, A(id=8)->TRG2, X(id=9)->TRG3,
 *   Y(id=1)->TRG4, R(id=11)->TRG5, Start(id=3)->TRG6, Select(id=2)->TRG7, L(id=10)->TRG8。
 */
const RETRO_ID_MAPS: Record<PadType, Record<JoyTarget, number>> = {
  default: {
    ...DIRECTION_RETRO_IDS,
    TRG1: 0, // RetroPad B
    TRG2: 8, // RetroPad A
    // TRG3..TRG8 は default(2ボタン)では参照されない。default の入れ物として cpsf-md と同じ値を
    // 置いているだけで、実際に使われるのは padType が cpsf-md/cpsf-sfc のときだけ。
    TRG3: 1,
    TRG4: 9,
    TRG5: 10,
    TRG6: 3,
    TRG7: 2,
    TRG8: 11,
  },
  'cpsf-md': {
    ...DIRECTION_RETRO_IDS,
    TRG1: 8, // RetroPad A (Low-Kick)
    TRG2: 0, // RetroPad B (Mid-Kick)
    TRG3: 1, // RetroPad Y (Mid-Punch)
    TRG4: 9, // RetroPad X (Low-Punch)
    TRG5: 10, // RetroPad L (High-Punch)
    TRG6: 3, // RetroPad Start
    TRG7: 2, // RetroPad Select (Mode)
    TRG8: 11, // RetroPad R (High-Kick)
  },
  'cpsf-sfc': {
    ...DIRECTION_RETRO_IDS,
    TRG1: 0, // RetroPad B
    TRG2: 8, // RetroPad A
    TRG3: 9, // RetroPad X
    TRG4: 1, // RetroPad Y
    TRG5: 11, // RetroPad R
    TRG6: 3, // RetroPad Start
    TRG7: 2, // RetroPad Select
    TRG8: 10, // RetroPad L
  },
};

/** JoyTarget -> RetroPad ID を padType に応じて引く。padType省略時は default(2ボタン)。 */
export function retroIdFor(target: JoyTarget, padType: PadType = 'default'): number {
  return RETRO_ID_MAPS[padType][target];
}

/** 後方互換のため残す default(2ボタン)固定の対応表。isBinding() の検証にのみ使う。 */
export const TARGET_TO_RETRO_ID: Record<JoyTarget, number> = RETRO_ID_MAPS.default;

/**
 * 1つの物理入力(Source)に対する割当先。
 * `key` は Phase 4(物理キーボードのキーを直接叩く割当)で使う型。Phase 1 では作らない。
 */
export type Binding = { kind: 'joy'; target: JoyTarget } | { kind: 'key'; retrok: number };

/** 物理入力側。軸はデッドゾーンを超えた方向(dir)ごとに別の Source として扱う。 */
export type Source = { kind: 'button'; index: number } | { kind: 'axis'; index: number; dir: 1 | -1 };

function sourceKey(source: Source): string {
  return source.kind === 'button' ? `b${source.index}` : `a${source.index}${source.dir > 0 ? '+' : '-'}`;
}

/**
 * Gamepad API の standard mapping を前提にした既定割当。
 * buttons[0](下ボタン、standard mapping では B 相当)-> TRG1、buttons[1](右ボタン、A 相当)-> TRG2。
 * buttons[12..15] が D-Pad 上下左右。axes[0]/[1] は左スティックで左右/上下へ量子化する
 * (X68000 標準パッドはデジタルなので、アナログ量ではなく閾値越えの有無だけを見る)。
 */
export const XINPUT_PRESET: ReadonlyArray<{ source: Source; binding: Binding }> = [
  { source: { kind: 'button', index: 0 }, binding: { kind: 'joy', target: 'TRG1' } },
  { source: { kind: 'button', index: 1 }, binding: { kind: 'joy', target: 'TRG2' } },
  { source: { kind: 'button', index: 12 }, binding: { kind: 'joy', target: 'UP' } },
  { source: { kind: 'button', index: 13 }, binding: { kind: 'joy', target: 'DOWN' } },
  { source: { kind: 'button', index: 14 }, binding: { kind: 'joy', target: 'LEFT' } },
  { source: { kind: 'button', index: 15 }, binding: { kind: 'joy', target: 'RIGHT' } },
  { source: { kind: 'axis', index: 0, dir: -1 }, binding: { kind: 'joy', target: 'LEFT' } },
  { source: { kind: 'axis', index: 0, dir: 1 }, binding: { kind: 'joy', target: 'RIGHT' } },
  { source: { kind: 'axis', index: 1, dir: -1 }, binding: { kind: 'joy', target: 'UP' } },
  { source: { kind: 'axis', index: 1, dir: 1 }, binding: { kind: 'joy', target: 'DOWN' } },
];

/** 軸の既定デッドゾーン。この値を超えた(等しいだけでは超えない)ときにその方向を「入力あり」とみなす。 */
export const DEFAULT_DEADZONE = 0.5;

// --- 軸判定(静止値からの偏差・範囲外軸の除外) ---
//
// 実機(8BitDo M30/Micro、D-inputモード)で判明した事実(2026-08-08):
// - 十字キーは axes[0]/axes[1] の軸で来る(ボタンではない)。
// - axes[3]/axes[4] は未押下のアナログトリガの値で、常に -1.0 を返す(0が静止値ではない)。
// - axes[9] は常に [-1,1] の範囲外の値(M30=3.29 / Micro=1.29)を返す。十字キーのハット軸が
//   数値化されたものと見られ、実質「無効な軸」として扱うしかない。
// 「軸の値0が静止」という暗黙の前提でデッドゾーン判定すると、未押下のトリガ軸が永久に
// 入力ありと誤判定される(ライブ表示が光りっぱなしになり、割り当てれば固着する)ため、
// 「軸ごとの静止値(rest)からの偏差」で判定する必要がある。以下は純粋関数として切り出し、
// GamepadManager(継続的なビット計算)・gamepad-ui.ts(ライブ表示・検出モード)の両方から
// 同じ判定ロジックを共有する。

/**
 * 軸の値が有効(Gamepad API の仕様上ありうる [-1, 1] の範囲内の有限値)かどうか。
 * 範囲外はハット軸などが数値化されて紛れ込んだものとみなし、無効な軸として扱う
 * (bitsFor/ライブ表示/検出モード/割当選択肢のいずれからも除外する)。
 */
export function isAxisValueValid(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -1 && value <= 1;
}

/**
 * 軸の現在値(value)が静止値(rest)からデッドゾーンを超えて偏差しているか、その方向を返す純粋関数。
 * value/rest のいずれかが無効な軸の値(isAxisValueValid が false)なら常に null(無効な軸として扱う)。
 * 静止値そのものからの偏差で見るため、rest が 0 でない軸(例: 未押下トリガの -1.0)でも
 * 「動いていなければ null」になる。
 */
export function axisDeviationDir(value: number, rest: number, deadzone: number): 1 | -1 | null {
  if (!isAxisValueValid(value) || !isAxisValueValid(rest)) return null;
  const delta = value - rest;
  if (delta <= -deadzone) return -1;
  if (delta >= deadzone) return 1;
  return null;
}

// --- 永続化(パッドごとのプロファイル) ---

/** 1つの Gamepad.id ぶんの設定。deadzone とバインディングの実体(配列表現)。 */
export interface GamepadProfile {
  deadzone: number;
  bindings: ReadonlyArray<{ source: Source; binding: Binding }>;
}

/**
 * localStorage に保存する形。バージョンを持たせ、壊れた/未知バージョンのデータは既定へフォールバックする。
 *
 * v2 で joyType(ポートごとのパッド種別)を追加した。v1 のデータ(joyType を持たない)は
 * isGamepadStoreV1() + migrateV1ToV2() で「既存の pads/portPads は活かしたまま joyType だけ
 * 既定値で補う」形にマイグレーションする。v1 保存データを isGamepadStoreV2 でそのまま弾いて
 * 空ストアへ全消しすると、割当編集(pads)やポート固定(portPads)を保存済みのユーザーの設定が
 * 一括で消えてしまうため、必ずこの経路を通すこと。
 */
export interface GamepadStore {
  version: 2;
  /** Gamepad.id -> プロファイル。挿し替えても両方残るよう、キーはポート番号ではなくidにする。 */
  pads: Record<string, GamepadProfile>;
  /** ポート0/1に手動で固定したい Gamepad.id。null は「自動割当のまま」。 */
  portPads: [string | null, string | null];
  /** ポート0/1(表示上はポート1/2)のパッド種別(px68k_joytype1/2 コアオプションに対応)。 */
  joyType: [PadType, PadType];
}

/** v1(joyType 追加前)のストア形。マイグレーション専用で外へは出さない。 */
interface GamepadStoreV1 {
  version: 1;
  pads: Record<string, GamepadProfile>;
  portPads: [string | null, string | null];
}

const GAMEPAD_STORAGE_KEY = 'webx68k.gamepad';

function emptyStore(): GamepadStore {
  return { version: 2, pads: {}, portPads: [null, null], joyType: ['default', 'default'] };
}

function isSource(v: unknown): v is Source {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.kind === 'button') return typeof o.index === 'number';
  if (o.kind === 'axis') return typeof o.index === 'number' && (o.dir === 1 || o.dir === -1);
  return false;
}

function isBinding(v: unknown): v is Binding {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.kind === 'joy') return typeof o.target === 'string' && (ALL_JOY_TARGETS as readonly string[]).includes(o.target);
  if (o.kind === 'key') return typeof o.retrok === 'number';
  return false;
}

function isGamepadProfile(v: unknown): v is GamepadProfile {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.deadzone !== 'number' || !Number.isFinite(o.deadzone)) return false;
  if (!Array.isArray(o.bindings)) return false;
  return o.bindings.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      isSource((entry as Record<string, unknown>).source) &&
      isBinding((entry as Record<string, unknown>).binding),
  );
}

function isPadsRecord(v: unknown): v is Record<string, GamepadProfile> {
  if (typeof v !== 'object' || v === null) return false;
  return Object.values(v as Record<string, unknown>).every(isGamepadProfile);
}

function isPortPads(v: unknown): v is [string | null, string | null] {
  if (!Array.isArray(v) || v.length !== 2) return false;
  return v.every((p) => p === null || typeof p === 'string');
}

function isPadType(v: unknown): v is PadType {
  return v === 'default' || v === 'cpsf-md' || v === 'cpsf-sfc';
}

/** 保存データ(v2)の構造検証。1箇所でも型が崩れていれば false を返す。 */
function isGamepadStoreV2(v: unknown): v is GamepadStore {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.version !== 2) return false;
  if (!isPadsRecord(o.pads)) return false;
  if (!isPortPads(o.portPads)) return false;
  if (!Array.isArray(o.joyType) || o.joyType.length !== 2) return false;
  return o.joyType.every(isPadType);
}

/** 保存データ(v1、joyType 無し)の構造検証。マイグレーション対象か判定するために使う。 */
function isGamepadStoreV1(v: unknown): v is GamepadStoreV1 {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.version !== 1) return false;
  if (!isPadsRecord(o.pads)) return false;
  return isPortPads(o.portPads);
}

function migrateV1ToV2(v1: GamepadStoreV1): GamepadStore {
  return { version: 2, pads: v1.pads, portPads: v1.portPads, joyType: ['default', 'default'] };
}

/**
 * localStorage から読み込む。存在しない/JSON破損/構造不正のいずれでも例外を投げず既定値
 * (空ストア)へフォールバックする。v1 データは pads/portPads を保ったまま v2 へ移行する。
 */
export function loadGamepadStore(storage: Pick<Storage, 'getItem'> = localStorage): GamepadStore {
  const raw = storage.getItem(GAMEPAD_STORAGE_KEY);
  if (!raw) return emptyStore();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isGamepadStoreV2(parsed)) return parsed;
    if (isGamepadStoreV1(parsed)) return migrateV1ToV2(parsed);
    return emptyStore();
  } catch {
    return emptyStore();
  }
}

export function saveGamepadStore(store: GamepadStore, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(GAMEPAD_STORAGE_KEY, JSON.stringify(store));
}

/** XINPUT_PRESET をそのまま GamepadProfile の形に変換する(standard mapping の既定値用)。 */
export function presetProfile(deadzone: number = DEFAULT_DEADZONE): GamepadProfile {
  return { deadzone, bindings: XINPUT_PRESET.map((e) => ({ source: e.source, binding: e.binding })) };
}

/** バインディングの無いプロファイル(non-standard パッドの初回既定=全未割当)。 */
export function blankProfile(deadzone: number = DEFAULT_DEADZONE): GamepadProfile {
  return { deadzone, bindings: [] };
}

// --- 8BitDo M30 / Micro 用の既知プリセット ---
//
// 実機(D-inputモード)で判明したボタン/軸の対応(内部index、0始まり)。表示は1始まりだが、
// ここでの値は内部indexそのもの。gamepad.id に 'M30'/'Micro' を含むかどうか(大文字小文字無視)で
// 判定する。standard 申告でない可能性が高いパッドのため、mapping==='standard' かどうかに関わらず
// このプリセットを優先して適用する(knownPadPresetFor が null を返す場合だけ、従来の
// mapping==='standard' ? XINPUT_PRESET : 全未割当、へフォールバックする)。

/** 十字キーは両パッド共通で axes[0]/axes[1] の軸で来る(ボタンではない)。padType に依存しない。 */
const DPAD_AXIS_BINDINGS: ReadonlyArray<{ source: Source; binding: Binding }> = [
  { source: { kind: 'axis', index: 0, dir: -1 }, binding: { kind: 'joy', target: 'LEFT' } },
  { source: { kind: 'axis', index: 0, dir: 1 }, binding: { kind: 'joy', target: 'RIGHT' } },
  { source: { kind: 'axis', index: 1, dir: -1 }, binding: { kind: 'joy', target: 'UP' } },
  { source: { kind: 'axis', index: 1, dir: 1 }, binding: { kind: 'joy', target: 'DOWN' } },
];

function joyBtn(index: number, target: JoyTarget): { source: Source; binding: Binding } {
  return { source: { kind: 'button', index }, binding: { kind: 'joy', target } };
}

/** 8BitDo M30 のボタン index(内部0始まり)。index 2/5 は空き。 */
const M30_BTN = { A: 0, B: 1, X: 3, Y: 4, Z: 6, C: 7, L: 8, R: 9, MINUS: 10, PLUS: 11 } as const;
/** 8BitDo Micro のボタン index(内部0始まり)。 */
const MICRO_BTN = { A: 0, B: 1, X: 3, Y: 4, L: 6, R: 7, L2: 8, R2: 9, MINUS: 10, PLUS: 11 } as const;

/** M30・標準(2ボタン): A→TRG1, B→TRG2。 */
export const M30_STANDARD_PRESET: ReadonlyArray<{ source: Source; binding: Binding }> = [
  ...DPAD_AXIS_BINDINGS,
  joyBtn(M30_BTN.A, 'TRG1'),
  joyBtn(M30_BTN.B, 'TRG2'),
];

/**
 * M30・CPSF-MD(8ボタン)。px68k-libretro の PAD_CPSF_MD では RetroPad L/R が MDパッドの Z/C の
 * 代役になっているため、パンチ3種(X/Y/Z)・キック3種(A/B/C)がこの対応で揃う。
 */
export const M30_CPSF_MD_PRESET: ReadonlyArray<{ source: Source; binding: Binding }> = [
  ...DPAD_AXIS_BINDINGS,
  joyBtn(M30_BTN.A, 'TRG1'),
  joyBtn(M30_BTN.B, 'TRG2'),
  joyBtn(M30_BTN.Y, 'TRG3'),
  joyBtn(M30_BTN.X, 'TRG4'),
  joyBtn(M30_BTN.Z, 'TRG5'),
  joyBtn(M30_BTN.PLUS, 'TRG6'),
  joyBtn(M30_BTN.MINUS, 'TRG7'),
  joyBtn(M30_BTN.C, 'TRG8'),
];

/** Micro・標準(2ボタン): A→TRG1, B→TRG2。 */
export const MICRO_STANDARD_PRESET: ReadonlyArray<{ source: Source; binding: Binding }> = [
  ...DPAD_AXIS_BINDINGS,
  joyBtn(MICRO_BTN.A, 'TRG1'),
  joyBtn(MICRO_BTN.B, 'TRG2'),
];

/** Micro・CPSF-SFC(8ボタン)。SFCパッドのラベルと同名のボタンに対応させてある。 */
export const MICRO_CPSF_SFC_PRESET: ReadonlyArray<{ source: Source; binding: Binding }> = [
  ...DPAD_AXIS_BINDINGS,
  joyBtn(MICRO_BTN.B, 'TRG1'),
  joyBtn(MICRO_BTN.A, 'TRG2'),
  joyBtn(MICRO_BTN.X, 'TRG3'),
  joyBtn(MICRO_BTN.Y, 'TRG4'),
  joyBtn(MICRO_BTN.R, 'TRG5'),
  joyBtn(MICRO_BTN.PLUS, 'TRG6'),
  joyBtn(MICRO_BTN.MINUS, 'TRG7'),
  joyBtn(MICRO_BTN.L, 'TRG8'),
];

/**
 * gamepad.id から USB Vendor/Product ID を抽出する純粋関数。
 *
 * Chrome 等は標準マッピングでないパッドの id に `(Vendor: 2dc8 Product: 0651)` の形で
 * ベンダー/プロダクトIDを埋め込む(表記の大文字小文字・桁数はブラウザ実装依存)。
 * ここから `vendor:product`(共に小文字16進、桁は詰めない)の文字列を取り出す。
 * 一致しない/取り出せない場合は null(呼び出し側は id 文字列によるフォールバックに委ねること)。
 */
export function extractVendorProduct(padId: string): string | null {
  const m = /vendor:\s*([0-9a-f]+)\s+product:\s*([0-9a-f]+)/i.exec(padId);
  if (!m) return null;
  return `${m[1].toLowerCase()}:${m[2].toLowerCase()}`;
}

/**
 * Vendor:Product(小文字16進) -> 既知パッド種別。
 * 実機(ゲームパッドチェックサイトで実測、2026-08-08)で確定させた値:
 * - 8BitDo M30 gamepad: Vendor 2dc8 / Product 0651
 * - 8BitDo Micro gamepad: Vendor 2dc8 / Product 9020
 */
const VENDOR_PRODUCT_TO_KNOWN_PAD: Record<string, 'm30' | 'micro'> = {
  '2dc8:0651': 'm30',
  '2dc8:9020': 'micro',
};

/**
 * gamepad.id から既知パッド種別('m30'/'micro')を判定する、唯一の情報源。
 * knownPadPresetFor()(プリセット選択)・knownAxisRestFor()(静止値の固定)の両方がこれを使う
 * (判定ロジックの二重実装を避けるため)。一致しなければ null。
 *
 * 判定は Vendor/Product ID(extractVendorProduct())を最優先する。'Micro' の部分一致で
 * 判定すると 'Microsoft X-Box ...' のような無関係な id まで誤爆する
 * (2026-08-08 発覚。'Micro' は 'Microsoft' の部分文字列)ため、文字列パターンマッチは
 * 誤爆しない 'm30' のみをフォールバックとして残し、'micro' 系は vendor/product が
 * 取れた場合に限定する。
 */
function knownPadKindFor(padId: string): 'm30' | 'micro' | null {
  const vendorProduct = extractVendorProduct(padId);
  const known = vendorProduct ? VENDOR_PRODUCT_TO_KNOWN_PAD[vendorProduct] : undefined;
  if (known !== undefined) return known ?? null; // vendor/productは取れたが未知のペア: 誤爆を避けるため文字列フォールバックに落とさない。

  // vendor/product が取れない(ブラウザ実装差で id に埋め込まれていない)場合のみ、id文字列で
  // フォールバックする。'm30' は他の実在パッド名との衝突が知られていないため許容するが、
  // 'micro' は 'Microsoft' 等を誤爆するため vendor/product 経由でしか判定しない。
  const id = padId.toLowerCase();
  if (id.includes('m30')) return 'm30';
  return null;
}

/**
 * gamepad.id から既知パッド用の既定プリセットを1つ選ぶ、唯一の情報源。一致するパッドが
 * 無ければ null(呼び出し側は従来どおり mapping==='standard' か否かでフォールバックすること)。
 *
 * padType が「そのパッドの8ボタン仕様」と一致しない場合(例: M30 で CPSF-SFC を選んでいる等)は、
 * 8ボタン側のバインディング(パッド固有のTRG3..TRG8割当)は該当しないため、2ボタン側の
 * プリセットにフォールバックする(方向 + TRG1/TRG2 は両パターンとも壊さない)。
 */
export function knownPadPresetFor(padId: string, padType: PadType): ReadonlyArray<{ source: Source; binding: Binding }> | null {
  const kind = knownPadKindFor(padId);
  if (kind === 'm30') return padType === 'cpsf-md' ? M30_CPSF_MD_PRESET : M30_STANDARD_PRESET;
  if (kind === 'micro') return padType === 'cpsf-sfc' ? MICRO_CPSF_SFC_PRESET : MICRO_STANDARD_PRESET;
  return null;
}

/**
 * 既知パッド(M30/Micro)の既知軸(axes[3]/axes[4]、未押下のアナログトリガ)の静止値を固定で返す。
 * 一致しなければ null(呼び出し側は従来どおり「初回観測値を静止値として採用」にフォールバックする)。
 *
 * 根本原因(2026-08-08 実機M30で確認): GamepadManager.getAxisRest() は「その軸を最初に観測した
 * 値」をそのまま静止値として採用し、以後更新しない設計。ところがM30/Microの axes[3]/[4] は、
 * L/R(肩ボタン)を一度も操作していない間はOS/ブラウザがそのアナログチャンネルの実測値を
 * まだ報告し切っておらず(未較正のプレースホルダとして0を返す実装がある)、L/Rを初めて
 * 操作した瞬間にようやく本来の静止値(-1.0)が報告され始める。「最初の観測値=0」を静止値として
 * 固定してしまうと、その後ずっと0でない真の静止値(-1.0)との偏差(delta=-1.0)がデッドゾーンを
 * 超え続け、L/Rを離しても軸が「ON」に固着したまま戻らない(実機8BitDo M30で再現・確認済み)。
 *
 * axes[3]/[4] の真の静止値は実機測定で -1.0 と判明済み(gamepad.test.ts に既存の回帰テストあり)
 * のため、動的観測に頼らずこの固定値を使うことで、初回観測タイミングの汚染を構造的に避ける。
 */
export function knownAxisRestFor(padId: string, axisIndex: number): number | null {
  if (axisIndex !== 3 && axisIndex !== 4) return null;
  const kind = knownPadKindFor(padId);
  return kind === 'm30' || kind === 'micro' ? -1.0 : null;
}

/**
 * 保存済みプロファイルが無いパッドに対する既定値を決める、唯一の情報源。
 * 1. gamepad.id が既知パッド(M30/Micro)にマッチすれば、mapping の申告に関わらずそのプリセットを使う
 *    (これらは standard 申告でない可能性が高く、mapping 頼みだと全未割当のまま始まってしまうため)。
 * 2. マッチしなければ従来どおり: mapping === 'standard' のときだけ XINPUT_PRESET、
 *    そうでなければ全未割当で始める(index の意味がパッドごとに違うため、推測で埋めない)。
 *
 * padType省略時は 'default'(2ボタン)。id を渡さない呼び出し(既存テスト等)は常に2を通る。
 */
export function defaultProfileFor(pad: Pick<Gamepad, 'mapping'> & { id?: string }, padType: PadType = 'default'): GamepadProfile {
  const known = pad.id ? knownPadPresetFor(pad.id, padType) : null;
  if (known) return { deadzone: DEFAULT_DEADZONE, bindings: known.map((e) => ({ source: e.source, binding: e.binding })) };
  return pad.mapping === 'standard' ? presetProfile() : blankProfile();
}

// --- 検出(押して割り当て)用の純粋関数 ---

/** ある瞬間の物理入力のスナップショット(検出モードの「押されていない状態」の基準に使う)。 */
export interface PadSnapshot {
  buttons: readonly boolean[];
  axes: readonly number[];
}

export function snapshotPad(pad: Gamepad): PadSnapshot {
  return {
    buttons: Array.from(pad.buttons ?? [], (b) => b?.pressed === true),
    axes: Array.from(pad.axes ?? [], (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)),
  };
}

/**
 * prev(検出開始時のスナップショット)から curr(現在)への遷移を見て、
 * 「押されていなかったものが押された」Source を1つ返す(無ければ null)。
 * 押しっぱなしのボタン/既に閾値を超えていた軸は無視する(prevで既に真だったものは対象外)。
 * ボタンを軸より先に見る(同一フレームで両方遷移した場合はボタン優先、決定的な順序にするため)。
 */
export function detectNewlyActiveSource(prev: PadSnapshot, curr: PadSnapshot, deadzone: number): Source | null {
  for (let i = 0; i < curr.buttons.length; i++) {
    const wasPressed = prev.buttons[i] === true;
    if (!wasPressed && curr.buttons[i]) return { kind: 'button', index: i };
  }
  // 軸は「静止 → 動いた」の変化を要求する: prev(検出開始時点、または直前フレーム)を
  // その軸の静止値(rest)とみなし、そこからの偏差がデッドゾーンを超えたときだけ拾う。
  // 0を静止値とみなす旧実装だと、未押下で-1.0を返すトリガ軸(8BitDo M30/Micro実機で確認)が
  // 検出開始時点で既に「デッドゾーンを超えている」ため誤検出しかねない。
  // isAxisValueValid で範囲外の軸([-1,1]の外。ハット軸が紛れ込んだもの)も除外する。
  for (let i = 0; i < curr.axes.length; i++) {
    const prevValue = prev.axes[i] ?? 0;
    const currValue = curr.axes[i] ?? 0;
    const dir = axisDeviationDir(currValue, prevValue, deadzone);
    if (dir !== null) return { kind: 'axis', index: i, dir };
  }
  return null;
}

function bindingsEqual(a: Binding, b: Binding): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'joy' && b.kind === 'joy') return a.target === b.target;
  if (a.kind === 'key' && b.kind === 'key') return a.retrok === b.retrok;
  return false;
}

/** 2つの Source が同じ物理入力を指すか(編集UIでコンボ選択の現在値をハイライトする等に使う)。 */
export function sourcesEqual(a: Source, b: Source): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'button' && b.kind === 'button') return a.index === b.index;
  if (a.kind === 'axis' && b.kind === 'axis') return a.index === b.index && a.dir === b.dir;
  return false;
}

/**
 * 「どの Gamepad.index をどのポート(0/1)に割り当てるか」を決める、唯一の情報源。
 *
 * navigator.getGamepads() が返す配列(疎な配列。切断済みindexはnullのまま残る)から
 * 非nullのものだけを Gamepad.index の昇順に並べ、先頭からポート0/1へ割り当てる。
 * gamepadconnected/gamepaddisconnected イベントの発火有無には一切依存しない
 * (イベントを経ずに navigator.getGamepads() へ現れたパッドも正しく拾うため)。
 * 3台目以降は割当なし(呼び出し側は Map に index が無ければ未割当として扱う)。
 *
 * `manualPadIds` は「このポートはこの Gamepad.id を優先的に使う」という手動指定(既定は両方 null =
 * 完全自動)。指定されたidのパッドが接続中ならそのポートへ優先的に割り当て、残りのポートは
 * 従来通り接続順で埋める。手動指定されたパッドが接続されていなければ無視され、自動割当に委ねる。
 *
 * 戻り値は Gamepad.index -> port(0|1) の Map。
 */
export function assignPorts(
  gamepads: readonly (Gamepad | null)[],
  manualPadIds: readonly [string | null, string | null] = [null, null],
): ReadonlyMap<number, number> {
  const present = gamepads.filter((pad): pad is Gamepad => pad != null).sort((a, b) => a.index - b.index);
  const map = new Map<number, number>();
  const usedIndexes = new Set<number>();

  // 1st pass: 手動指定を優先して埋める。
  for (let port = 0; port < 2; port++) {
    const wantedId = manualPadIds[port];
    if (!wantedId) continue;
    const pad = present.find((p) => p.id === wantedId && !usedIndexes.has(p.index));
    if (!pad) continue;
    map.set(pad.index, port);
    usedIndexes.add(pad.index);
  }

  // 2nd pass: 残りのポートを、まだ使われていないパッドで接続順(index昇順)に埋める。
  let cursor = 0;
  for (let port = 0; port < 2; port++) {
    const alreadyAssigned = [...map.values()].includes(port);
    if (alreadyAssigned) continue;
    while (cursor < present.length && usedIndexes.has(present[cursor].index)) cursor++;
    if (cursor >= present.length) continue;
    map.set(present[cursor].index, port);
    usedIndexes.add(present[cursor].index);
    cursor++;
  }
  return map;
}

/**
 * Gamepad -> RetroPad ID ビットマスクへの変換器。
 *
 * ブラウザ無しでユニットテストできるよう、`navigator.getGamepads()` への依存は持たない。
 * 呼び出し側(main.ts)が毎フレーム取得した配列をそのまま `poll()` へ渡す形にしてある。
 */
export class GamepadManager {
  private deadzone: number;
  // Source -> Binding[] の逆引き。1つの物理入力に複数割当が乗るケース(編集UIで
  // 同じボタンに複数機能を足す等)を素直に扱うため、値は配列で持つ。
  // source自体もキーとは別に保持しておく(逆引きテーブルからUI表示用に「行から見た一覧」を
  // 引き直すため。sourceKey()は不可逆な文字列化なので、元のSourceを別途持つ必要がある)。
  private readonly bindings = new Map<string, Binding[]>();
  private readonly sourcesByKey = new Map<string, Source>();
  // 軸ごとの静止値(rest)。「そのパッドを最初に観測したときの値」を記録し、以後は更新しない
  // (継続的なポーリングのたびに更新すると、方向を入力し続けている最中に静止値が追いついてしまい、
  // 押しっぱなしのつもりが1フレームでOFFに戻ってしまう)。
  private readonly axisRest = new Map<number, number>();

  constructor(
    preset: ReadonlyArray<{ source: Source; binding: Binding }> = XINPUT_PRESET,
    deadzone: number = DEFAULT_DEADZONE,
  ) {
    this.deadzone = deadzone;
    for (const { source, binding } of preset) this.addBinding(source, binding);
  }

  /** 保存済み/既定のプロファイルから GamepadManager を作る。 */
  static fromProfile(profile: GamepadProfile): GamepadManager {
    return new GamepadManager(profile.bindings, profile.deadzone);
  }

  /** 現在の状態をそのまま永続化できる GamepadProfile へ書き出す。 */
  toProfile(): GamepadProfile {
    return { deadzone: this.deadzone, bindings: this.getAllBindings() };
  }

  getDeadzone(): number {
    return this.deadzone;
  }

  setDeadzone(deadzone: number): void {
    this.deadzone = deadzone;
  }

  /** Source に Binding を追加する(編集UIの[検出]/コンボ選択から呼ぶ)。 */
  addBinding(source: Source, binding: Binding): void {
    const key = sourceKey(source);
    this.sourcesByKey.set(key, source);
    const list = this.bindings.get(key);
    if (list) list.push(binding);
    else this.bindings.set(key, [binding]);
  }

  /**
   * 指定 JoyTarget の kind:'joy' バインディングを、渡された1つの Source だけに置き換える
   * (編集UIの行の[検出]用。「最後に検出した1つだけになる」という置き換え動作)。
   * 対象は target の一致だけで選ぶ(source は問わない)ため、その行が複数Sourceの割当を
   * 持っていても全部消してから1つだけ積み直す。
   *
   * さらに、検出で拾った source が「別の target」に持っている kind:'joy' の割当も外す
   * (「このボタンは○○です」という宣言として扱うため。外さないと、例えばボタン3を
   * DOWN に割り当てた状態で UP の行で検出してボタン3を押すと、ボタン3が UP と DOWN の
   * 両方を押す状態になってしまう)。
   * ただし同じ source に乗っている kind:'key' の割当には触れない(joy とキーは別レイヤー。
   * 意図的に1ボタンへ複数機能を乗せたい場合は、従来どおりコンボボックス
   * 「追加する入力を選択…」から addBinding() で足せる)。
   */
  replaceTargetBinding(source: Source, target: JoyTarget): void {
    for (const { source: existingSource, binding } of this.getAllBindings()) {
      if (binding.kind !== 'joy') continue;
      const sameTarget = binding.target === target;
      const sameSource = sourcesEqual(existingSource, source);
      if (sameTarget || sameSource) {
        this.removeBinding(existingSource, binding);
      }
    }
    this.addBinding(source, { kind: 'joy', target });
  }

  /** 特定の Source から特定の Binding を1つ取り除く(チップの[削除])。一致が無ければ何もしない。 */
  removeBinding(source: Source, binding: Binding): void {
    const key = sourceKey(source);
    const list = this.bindings.get(key);
    if (!list) return;
    const next = list.filter((b) => !bindingsEqual(b, binding));
    if (next.length > 0) this.bindings.set(key, next);
    else {
      this.bindings.delete(key);
      this.sourcesByKey.delete(key);
    }
  }

  /** 保持している全 Source->Binding の対を平らな配列で返す(永続化・編集UIの一覧表示用)。 */
  getAllBindings(): Array<{ source: Source; binding: Binding }> {
    const out: Array<{ source: Source; binding: Binding }> = [];
    for (const [key, list] of this.bindings) {
      const source = this.sourcesByKey.get(key);
      if (!source) continue;
      for (const binding of list) out.push({ source, binding });
    }
    return out;
  }

  /** 指定 JoyTarget に割り当たっている Source 一覧(編集UIの行のチップ表示用)。 */
  bindingsForTarget(target: JoyTarget): Source[] {
    const out: Source[] = [];
    for (const { source, binding } of this.getAllBindings()) {
      if (binding.kind === 'joy' && binding.target === target) out.push(source);
    }
    return out;
  }

  /**
   * 全バインディングを消してから指定プリセットを積み直す([既定に戻す]ボタン用)。
   * 引数省略時は従来どおり XINPUT_PRESET(standard mapping 向け)。呼び出し側(main.ts)は
   * 接続中パッドの id/padType から knownPadPresetFor() で選んだプリセットを渡すこと
   * (8BitDo M30/Micro 等、パッドごとに既定が異なるため)。
   */
  resetToPreset(preset: ReadonlyArray<{ source: Source; binding: Binding }> = XINPUT_PRESET): void {
    this.bindings.clear();
    this.sourcesByKey.clear();
    for (const { source, binding } of preset) this.addBinding(source, binding);
  }

  /**
   * 単一の Gamepad についてビットマスクを計算する(パッドごとに GamepadManager を分けて持つ設計向け)。
   * padType は「このパッドが今送り先にしているポートの px68k_joytype」を渡すこと(省略時は default =
   * 2ボタン。TRG3..TRG8 のバインディングがあっても default では退避先が無いのでビットは立たない)。
   */
  bitsForPad(pad: Gamepad, padType: PadType = 'default'): number {
    return this.computeBits(pad, padType);
  }

  /**
   * 配列のインデックスがそのままポート番号として詰められた Gamepad 配列
   * (呼び出し側が既にポート割当を済ませたもの。要素数2、未接続ポートは null)から、
   * port 0/1 ぶんの RetroPad ID ビットマスクを計算して返す。
   * padTypes はポート0/1それぞれの px68k_joytype(省略時は両方 default)。
   */
  poll(gamepads: readonly (Gamepad | null)[], padTypes: readonly [PadType, PadType] = ['default', 'default']): [number, number] {
    const result: [number, number] = [0, 0];
    for (let port = 0; port < 2; port++) {
      const pad = gamepads[port];
      if (!pad) continue;
      result[port] = this.computeBits(pad, padTypes[port]);
    }
    return result;
  }

  /**
   * navigator.getGamepads() の戻り値そのまま(疎な配列、ポート未割当)を受け取り、
   * assignPorts() で port 0/1 を決めたうえでビットマスクを計算する。
   * 「割当をどう決めるか」の唯一の情報源は assignPorts() であることを保証するため、
   * 呼び出し側(main.ts の host.onPoll、gamepad-ui.ts のライブ表示)はこちらを使うこと。
   */
  pollByPort(
    gamepads: readonly (Gamepad | null)[],
    padTypes: readonly [PadType, PadType] = ['default', 'default'],
  ): [number, number] {
    const ports = assignPorts(gamepads);
    const byPort: [Gamepad | null, Gamepad | null] = [null, null];
    for (const pad of gamepads) {
      if (!pad) continue;
      const port = ports.get(pad.index);
      if (port === 0 || port === 1) byPort[port] = pad;
    }
    return this.poll(byPort, padTypes);
  }

  /**
   * 現在押されている物理Sourceのうち kind:'key' で割り当てられている retrok の集合を返す。
   * bitsForPad()(joy側)とは別の返り値にしてあるのは、呼び出し側(main.ts)が
   * SharedKeyInput へ渡す差分計算をjoy側のビットマスク処理と独立に行えるようにするため。
   * オートリピートはしない(呼び出し側が前フレームとの差分を見て press/release するだけの
   * 「今フレーム押されている集合」を返すのがこのメソッドの責務。押しっぱなしはpressを
   * 連打しない=呼び出し側で同じ retrok が続けて入っていれば無視される前提)。
   */
  keysForPad(pad: Gamepad): Set<number> {
    const keys = new Set<number>();
    this.forEachActiveSource(pad, (source) => {
      const list = this.bindings.get(sourceKey(source));
      if (!list) return;
      for (const binding of list) {
        if (binding.kind === 'key') keys.add(binding.retrok);
      }
    });
    return keys;
  }

  private computeBits(pad: Gamepad, padType: PadType): number {
    let bits = 0;
    this.forEachActiveSource(pad, (source) => {
      bits |= this.bitsFor(source, padType);
    });
    return bits;
  }

  /** 現在押されている(静止値からの偏差がデッドゾーンを超えた)物理Sourceを列挙する(bitsFor/keysForPadの共通イテレータ)。 */
  private forEachActiveSource(pad: Gamepad, fn: (source: Source) => void): void {
    for (let index = 0; index < pad.buttons.length; index++) {
      if (!pad.buttons[index].pressed) continue;
      fn({ kind: 'button', index });
    }
    for (let index = 0; index < pad.axes.length; index++) {
      const value = pad.axes[index];
      if (!isAxisValueValid(value)) continue; // 範囲外(ハット軸等)は無効な軸として無視。
      const rest = this.getAxisRest(pad, index, value);
      const dir = axisDeviationDir(value, rest, this.deadzone);
      if (dir !== null) fn({ kind: 'axis', index, dir });
    }
  }

  /**
   * 指定軸の静止値。既知パッド(M30/Micro)の既知軸(axes[3]/[4])は実機で確定済みの固定値
   * (-1.0)を使う(knownAxisRestFor 側のコメント参照。初回観測値が真の静止値とは限らないため、
   * 動的観測に頼ると固着する)。それ以外は従来どおり、未記録ならこの呼び出し時点の値を
   * そのまま静止値として記録する(初回観測時採用)。
   */
  private getAxisRest(pad: Gamepad, index: number, currentValue: number): number {
    const known = knownAxisRestFor(pad.id, index);
    if (known !== null) return known;
    const existing = this.axisRest.get(index);
    if (existing !== undefined) return existing;
    this.axisRest.set(index, currentValue);
    return currentValue;
  }

  /**
   * 指定軸の有効性・現在の偏差方向を返す(gamepad-ui.ts のライブ表示・割当選択肢の判定用)。
   * bitsFor 計算と同じ静止値(axisRest)を共有するため、ライブ表示とコアへの実際の入力は常に一致する。
   * 範囲外の軸(無効)は valid:false, active:null を返す。
   */
  axisState(pad: Gamepad, index: number): { valid: boolean; active: 1 | -1 | null } {
    const value = pad.axes?.[index];
    if (!isAxisValueValid(value)) return { valid: false, active: null };
    const rest = this.getAxisRest(pad, index, value);
    return { valid: true, active: axisDeviationDir(value, rest, this.deadzone) };
  }

  private bitsFor(source: Source, padType: PadType): number {
    const list = this.bindings.get(sourceKey(source));
    if (!list) return 0;
    let bits = 0;
    for (const binding of list) {
      if (binding.kind === 'joy') bits |= 1 << retroIdFor(binding.target, padType);
    }
    return bits;
  }
}
