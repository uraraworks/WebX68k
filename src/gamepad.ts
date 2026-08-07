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
 * TRG3..TRG8 は px68k-libretro が対応する多ボタンパッド(CPSF 等)向けの枠で、
 * Phase 1 では未使用(型だけ用意して後で埋める)。
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

/**
 * JoyTarget -> RetroPad ID(inputStateCb の id 引数、= libretro の RETRO_DEVICE_ID_JOYPAD_*)対応表。
 *
 * TRG1/TRG2 は px68k-libretro/libretro/joystick.c の Joystick_Update() に合わせてある
 * (Config.VbtnSwap 既定 false のとき、RetroPad B(id=0) -> JOY_TRG1, RetroPad A(id=8) -> JOY_TRG2)。
 * UP/DOWN/LEFT/RIGHT は同ファイルの D-Pad 判定(RETRO_DEVICE_ID_JOYPAD_UP=4 等)に合わせてある。
 * TRG3..TRG8 は現状 PAD_2BUTTON 固定では参照されない。将来 CPSF 等の多ボタン対応をする際に
 * 割り当て直す前提で、空いている RetroPad ボタン ID を仮に割り振ってあるだけの枠。
 */
export const TARGET_TO_RETRO_ID: Record<JoyTarget, number> = {
  UP: 4,
  DOWN: 5,
  LEFT: 6,
  RIGHT: 7,
  TRG1: 0, // RetroPad B
  TRG2: 8, // RetroPad A
  TRG3: 1, // RetroPad Y (未使用の枠)
  TRG4: 9, // RetroPad X (未使用の枠)
  TRG5: 10, // RetroPad L (未使用の枠)
  TRG6: 11, // RetroPad R (未使用の枠)
  TRG7: 12, // RetroPad L2 (未使用の枠)
  TRG8: 13, // RetroPad R2 (未使用の枠)
};

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

// --- 永続化(パッドごとのプロファイル) ---

/** 1つの Gamepad.id ぶんの設定。deadzone とバインディングの実体(配列表現)。 */
export interface GamepadProfile {
  deadzone: number;
  bindings: ReadonlyArray<{ source: Source; binding: Binding }>;
}

/** localStorage に保存する形。バージョンを持たせ、壊れた/未知バージョンのデータは既定へフォールバックする。 */
export interface GamepadStore {
  version: 1;
  /** Gamepad.id -> プロファイル。挿し替えても両方残るよう、キーはポート番号ではなくidにする。 */
  pads: Record<string, GamepadProfile>;
  /** ポート0/1に手動で固定したい Gamepad.id。null は「自動割当のまま」。 */
  portPads: [string | null, string | null];
}

const GAMEPAD_STORAGE_KEY = 'webx68k.gamepad';

function emptyStore(): GamepadStore {
  return { version: 1, pads: {}, portPads: [null, null] };
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
  if (o.kind === 'joy') return typeof o.target === 'string' && o.target in TARGET_TO_RETRO_ID;
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

/** 保存データの構造検証。1箇所でも型が崩れていれば false を返し、呼び出し側は既定へフォールバックする。 */
function isGamepadStore(v: unknown): v is GamepadStore {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.version !== 1) return false;
  if (typeof o.pads !== 'object' || o.pads === null) return false;
  for (const profile of Object.values(o.pads as Record<string, unknown>)) {
    if (!isGamepadProfile(profile)) return false;
  }
  if (!Array.isArray(o.portPads) || o.portPads.length !== 2) return false;
  for (const p of o.portPads) {
    if (p !== null && typeof p !== 'string') return false;
  }
  return true;
}

/**
 * localStorage から読み込む。存在しない/JSON破損/構造不正/未知バージョンのいずれでも
 * 例外を投げず既定値(空ストア)へフォールバックする。
 */
export function loadGamepadStore(storage: Pick<Storage, 'getItem'> = localStorage): GamepadStore {
  const raw = storage.getItem(GAMEPAD_STORAGE_KEY);
  if (!raw) return emptyStore();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isGamepadStore(parsed)) return emptyStore();
    return parsed;
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

/**
 * 保存済みプロファイルが無いパッドに対する既定値を決める、唯一の情報源。
 * mapping === 'standard' のときだけ XINPUT_PRESET を既定にし、そうでなければ全未割当で始める
 * (index の意味がパッドごとに違うため、推測で埋めない)。
 */
export function defaultProfileFor(pad: Pick<Gamepad, 'mapping'>): GamepadProfile {
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
  for (let i = 0; i < curr.axes.length; i++) {
    const prevValue = prev.axes[i] ?? 0;
    const currValue = curr.axes[i] ?? 0;
    const wasPos = prevValue >= deadzone;
    const wasNeg = prevValue <= -deadzone;
    if (!wasPos && currValue >= deadzone) return { kind: 'axis', index: i, dir: 1 };
    if (!wasNeg && currValue <= -deadzone) return { kind: 'axis', index: i, dir: -1 };
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

  /** 全バインディングを消してから XINPUT_PRESET を積み直す([XInput標準に戻す]ボタン用)。 */
  resetToPreset(): void {
    this.bindings.clear();
    this.sourcesByKey.clear();
    for (const { source, binding } of XINPUT_PRESET) this.addBinding(source, binding);
  }

  /** 単一の Gamepad についてビットマスクを計算する(パッドごとに GamepadManager を分けて持つ設計向け)。 */
  bitsForPad(pad: Gamepad): number {
    return this.computeBits(pad);
  }

  /**
   * 配列のインデックスがそのままポート番号として詰められた Gamepad 配列
   * (呼び出し側が既にポート割当を済ませたもの。要素数2、未接続ポートは null)から、
   * port 0/1 ぶんの RetroPad ID ビットマスクを計算して返す。
   */
  poll(gamepads: readonly (Gamepad | null)[]): [number, number] {
    const result: [number, number] = [0, 0];
    for (let port = 0; port < 2; port++) {
      const pad = gamepads[port];
      if (!pad) continue;
      result[port] = this.computeBits(pad);
    }
    return result;
  }

  /**
   * navigator.getGamepads() の戻り値そのまま(疎な配列、ポート未割当)を受け取り、
   * assignPorts() で port 0/1 を決めたうえでビットマスクを計算する。
   * 「割当をどう決めるか」の唯一の情報源は assignPorts() であることを保証するため、
   * 呼び出し側(main.ts の host.onPoll、gamepad-ui.ts のライブ表示)はこちらを使うこと。
   */
  pollByPort(gamepads: readonly (Gamepad | null)[]): [number, number] {
    const ports = assignPorts(gamepads);
    const byPort: [Gamepad | null, Gamepad | null] = [null, null];
    for (const pad of gamepads) {
      if (!pad) continue;
      const port = ports.get(pad.index);
      if (port === 0 || port === 1) byPort[port] = pad;
    }
    return this.poll(byPort);
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

  private computeBits(pad: Gamepad): number {
    let bits = 0;
    this.forEachActiveSource(pad, (source) => {
      bits |= this.bitsFor(source);
    });
    return bits;
  }

  /** 現在押されている(デッドゾーンを超えた)物理Sourceを列挙する(bitsFor/keysForPadの共通イテレータ)。 */
  private forEachActiveSource(pad: Gamepad, fn: (source: Source) => void): void {
    for (let index = 0; index < pad.buttons.length; index++) {
      if (!pad.buttons[index].pressed) continue;
      fn({ kind: 'button', index });
    }
    for (let index = 0; index < pad.axes.length; index++) {
      const value = pad.axes[index];
      if (value <= -this.deadzone) fn({ kind: 'axis', index, dir: -1 });
      if (value >= this.deadzone) fn({ kind: 'axis', index, dir: 1 });
    }
  }

  private bitsFor(source: Source): number {
    const list = this.bindings.get(sourceKey(source));
    if (!list) return 0;
    let bits = 0;
    for (const binding of list) {
      if (binding.kind === 'joy') bits |= 1 << TARGET_TO_RETRO_ID[binding.target];
    }
    return bits;
  }
}
