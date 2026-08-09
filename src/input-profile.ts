/**
 * 入力元ID -> Binding の対応表を、名前付きプロファイルで持つ汎用の器。
 *
 * バーチャルパッド(入力元IDが画面部品ID、例: 'dpad-up')と、将来のホストキー再割り当て
 * (入力元IDが KeyboardEvent.code)の両方から共有する。値の型は WebNP2 のホストキー
 * (../PC98/WebNP2/src/api/hostkey.ts、スキャンコード=number)と異なり、gamepad.ts の
 * Binding(joy/keyの2種)になる点だけが差分。構造・命名・流儀は hostkey.ts をそのまま踏襲する。
 *
 * このファイルは UI/DOM に依存しない(テストしやすくするため)。
 */

import type { Binding, JoyTarget } from './gamepad.ts';
import { isBinding } from './gamepad.ts';
import { RETROK } from './keyboard.ts';

/** 入力元ID -> Binding。入力元IDの意味は用途による(画面部品ID / KeyboardEvent.code)。 */
export type InputBindings = Record<string, Binding>;

export interface InputProfile {
  id: string;
  label: string;
  /** true の場合は編集・削除不可(複製は可)。組み込みプロファイル用。 */
  builtin?: boolean;
  bindings: InputBindings;
}

export interface InputProfileStore {
  version: 1;
  profiles: InputProfile[];
  activeId: string | null;
  enabled: boolean;
}

/** バーチャルパッド用ストアの localStorage キー。 */
export const VPAD_STORAGE_KEY = 'webx68k.vpad';
/** ホストキー再割り当て用ストアの localStorage キー(器のみ。組み込みプロファイルは持たない)。 */
export const HOSTKEY_STORAGE_KEY = 'webx68k.hostkey';

// --- バーチャルパッドの画面部品ID ---

export const VPAD_DPAD_UP = 'dpad-up';
export const VPAD_DPAD_DOWN = 'dpad-down';
export const VPAD_DPAD_LEFT = 'dpad-left';
export const VPAD_DPAD_RIGHT = 'dpad-right';
export const VPAD_BTN_A = 'btn-a';
export const VPAD_BTN_B = 'btn-b';
export const VPAD_BTN_C = 'btn-c';
export const VPAD_BTN_D = 'btn-d';
export const VPAD_BTN_E = 'btn-e';
export const VPAD_BTN_F = 'btn-f';
export const VPAD_BTN_OPT1 = 'btn-opt1';
export const VPAD_BTN_OPT2 = 'btn-opt2';

// --- 組み込みプロファイルのid。読み取り専用判定・削除後のフォールバック選択に使う唯一の情報源。 ---

export const BUILTIN_JOY_2BUTTON_ID = 'builtin:joy-2button';
export const BUILTIN_CURSOR_SPACE_ID = 'builtin:cursor-space';
export const BUILTIN_TENKEY_ID = 'builtin:tenkey';
export const BUILTIN_JOY_6BUTTON_ID = 'builtin:joy-6button';

function joyBinding(target: JoyTarget): Binding {
  return { kind: 'joy', target };
}

function keyBinding(retrok: number): Binding {
  return { kind: 'key', retrok };
}

/**
 * 組み込みプロファイル「ジョイスティック2ボタン」の正規の内容。
 * label はここでは内部識別用の非表示文字列(UI層は builtin:true のプロファイルについて
 * strings.ts 経由の翻訳済みラベルへ差し替えて表示する。ここに翻訳を持ち込まないのは、
 * このファイルを UI/DOM 非依存に保つため)。
 */
export function builtinJoy2ButtonProfile(): InputProfile {
  return {
    id: BUILTIN_JOY_2BUTTON_ID,
    label: 'Joystick 2 Buttons (built-in)',
    builtin: true,
    bindings: {
      [VPAD_DPAD_UP]: joyBinding('UP'),
      [VPAD_DPAD_DOWN]: joyBinding('DOWN'),
      [VPAD_DPAD_LEFT]: joyBinding('LEFT'),
      [VPAD_DPAD_RIGHT]: joyBinding('RIGHT'),
      [VPAD_BTN_A]: joyBinding('TRG1'),
      [VPAD_BTN_B]: joyBinding('TRG2'),
    },
  };
}

/** 組み込みプロファイル「カーソルキー+スペース」の正規の内容。 */
export function builtinCursorSpaceProfile(): InputProfile {
  return {
    id: BUILTIN_CURSOR_SPACE_ID,
    label: 'Cursor + Space (built-in)',
    builtin: true,
    bindings: {
      [VPAD_DPAD_UP]: keyBinding(RETROK.UP),
      [VPAD_DPAD_DOWN]: keyBinding(RETROK.DOWN),
      [VPAD_DPAD_LEFT]: keyBinding(RETROK.LEFT),
      [VPAD_DPAD_RIGHT]: keyBinding(RETROK.RIGHT),
      [VPAD_BTN_A]: keyBinding(RETROK.SPACE),
      [VPAD_BTN_B]: keyBinding(RETROK.RETURN),
    },
  };
}

/** 組み込みプロファイル「テンキー」の正規の内容。 */
export function builtinTenkeyProfile(): InputProfile {
  return {
    id: BUILTIN_TENKEY_ID,
    label: 'Tenkey (built-in)',
    builtin: true,
    bindings: {
      [VPAD_DPAD_UP]: keyBinding(RETROK.KP8),
      [VPAD_DPAD_DOWN]: keyBinding(RETROK.KP2),
      [VPAD_DPAD_LEFT]: keyBinding(RETROK.KP4),
      [VPAD_DPAD_RIGHT]: keyBinding(RETROK.KP6),
      [VPAD_BTN_A]: keyBinding(RETROK.SPACE),
      [VPAD_BTN_B]: keyBinding(RETROK.RETURN),
    },
  };
}

/**
 * 組み込みプロファイル「ジョイスティック6ボタン」の正規の内容。
 *
 * TRGn の意味は px68k-libretro/libretro/joystick.c の PAD_CPSF_MD 節(296行目付近)の
 * コメントが出典(推測ではない):
 *   TRG1 = Low-Kick   TRG2 = Mid-Kick   TRG8 = High-Kick
 *   TRG4 = Low-Punch  TRG3 = Mid-Punch  TRG5 = High-Punch
 *   TRG6 = Start      TRG7 = Mode
 * メガドライブ6ボタンパッドの標準配置(下段 A/B/C=弱/中/強キック、上段 X/Y/Z=弱/中/強パンチ)
 * に対応させると、btn-c は TRG3 ではなく TRG8(強キック)、btn-f は TRG6 ではなく TRG5
 * (強パンチ)になる。btn-opt1/opt2 は Start/Mode で、これまでどの組み込みプロファイルにも
 * 割り当てが無かったため今回初めて画面に出る。
 */
export function builtinJoy6ButtonProfile(): InputProfile {
  return {
    id: BUILTIN_JOY_6BUTTON_ID,
    label: 'Joystick 6 Buttons (built-in)',
    builtin: true,
    bindings: {
      [VPAD_DPAD_UP]: joyBinding('UP'),
      [VPAD_DPAD_DOWN]: joyBinding('DOWN'),
      [VPAD_DPAD_LEFT]: joyBinding('LEFT'),
      [VPAD_DPAD_RIGHT]: joyBinding('RIGHT'),
      [VPAD_BTN_A]: joyBinding('TRG1'), // Low-Kick
      [VPAD_BTN_B]: joyBinding('TRG2'), // Mid-Kick
      [VPAD_BTN_C]: joyBinding('TRG8'), // High-Kick
      [VPAD_BTN_D]: joyBinding('TRG4'), // Low-Punch
      [VPAD_BTN_E]: joyBinding('TRG3'), // Mid-Punch
      [VPAD_BTN_F]: joyBinding('TRG5'), // High-Punch
      [VPAD_BTN_OPT1]: joyBinding('TRG6'), // Start
      [VPAD_BTN_OPT2]: joyBinding('TRG7'), // Mode
    },
  };
}

/** バーチャルパッド用の組み込みプロファイル一覧(表示順)。normalizeStore() が正規の内容へ揃える唯一の情報源。 */
function builtinVpadProfiles(): InputProfile[] {
  return [builtinJoy2ButtonProfile(), builtinCursorSpaceProfile(), builtinTenkeyProfile(), builtinJoy6ButtonProfile()];
}

/** 既定のバーチャルパッド用ストア: 組み込み4種のみ・joy-2buttonをアクティブに・機能自体はOFF。 */
export function emptyVpadStore(): InputProfileStore {
  const profiles = builtinVpadProfiles();
  return { version: 1, profiles, activeId: BUILTIN_JOY_2BUTTON_ID, enabled: false };
}

/** 既定のホストキー用ストア: 組み込みプロファイルなし(器のみ)・未選択・機能自体はOFF。 */
export function emptyHostKeyStore(): InputProfileStore {
  return { version: 1, profiles: [], activeId: null, enabled: false };
}

function isInputBindings(v: unknown): v is InputBindings {
  if (typeof v !== 'object' || v === null) return false;
  return Object.values(v as Record<string, unknown>).every(isBinding);
}

function isInputProfile(v: unknown): v is InputProfile {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id === '') return false;
  if (typeof o.label !== 'string') return false;
  if (o.builtin !== undefined && typeof o.builtin !== 'boolean') return false;
  return isInputBindings(o.bindings);
}

/** 保存データの構造検証。1箇所でも型が崩れていれば false を返す。 */
function isInputProfileStore(v: unknown): v is InputProfileStore {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.version !== 1) return false;
  if (!Array.isArray(o.profiles) || !o.profiles.every(isInputProfile)) return false;
  if (o.activeId !== null && typeof o.activeId !== 'string') return false;
  if (typeof o.enabled !== 'boolean') return false;
  return true;
}

/**
 * ストアの用途(vpad/hostkey)ごとに、既定値と組み込みプロファイル一覧を決める唯一の情報源。
 * localStorage のキー文字列で用途を判定する(呼び出し側が渡すキーは定数
 * VPAD_STORAGE_KEY/HOSTKEY_STORAGE_KEY のいずれかを使うこと)。
 */
function builtinsFor(key: string): InputProfile[] {
  return key === VPAD_STORAGE_KEY ? builtinVpadProfiles() : [];
}

function emptyStoreFor(key: string): InputProfileStore {
  return key === VPAD_STORAGE_KEY ? emptyVpadStore() : emptyHostKeyStore();
}

/**
 * 組み込みプロファイルの内容を常に正規の値へ揃える(localStorageの手動編集等で内容が
 * ズレても、読み取り専用という不変条件を壊させない)。存在しなければ先頭へ補う。
 * activeId が実在しないプロファイルを指していたら null へ落とす(壊れた参照を残さない)。
 */
export function normalizeStore(key: string, store: InputProfileStore): InputProfileStore {
  const builtins = builtinsFor(key);
  const builtinIds = new Set(builtins.map((p) => p.id));
  const rest = store.profiles.filter((p) => !builtinIds.has(p.id));
  const profiles = [...builtins, ...rest];
  const activeId = store.activeId !== null && profiles.some((p) => p.id === store.activeId) ? store.activeId : null;
  return { version: 1, profiles, activeId, enabled: store.enabled };
}

/**
 * localStorage から読み込む。存在しない/JSON破損/構造不正のいずれでも例外を投げず既定値
 * (空ストア)へフォールバックする(gamepad.ts の loadGamepadStore と同じ流儀)。
 */
export function loadInputProfileStore(key: string, storage: Pick<Storage, 'getItem'> = localStorage): InputProfileStore {
  const raw = storage.getItem(key);
  if (!raw) return emptyStoreFor(key);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isInputProfileStore(parsed)) return normalizeStore(key, parsed);
    return emptyStoreFor(key);
  } catch {
    return emptyStoreFor(key);
  }
}

export function saveInputProfileStore(key: string, store: InputProfileStore, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(key, JSON.stringify(store));
}

// --- CRUD(すべて純粋関数。store を書き換えず新しい store を返す) ---

export function setEnabled(store: InputProfileStore, enabled: boolean): InputProfileStore {
  return { ...store, enabled };
}

/** id が存在しないプロファイルを指していれば無視する(不正な参照を作らせない)。null は「未選択」として許可。 */
export function setActiveProfile(store: InputProfileStore, id: string | null): InputProfileStore {
  if (id !== null && !store.profiles.some((p) => p.id === id)) return store;
  return { ...store, activeId: id };
}

function generateProfileId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `profile-${Date.now().toString(36)}-${rand}`;
}

/** 空の割当で新規プロファイルを作る。 */
export function createProfile(store: InputProfileStore, label: string): { store: InputProfileStore; id: string } {
  const id = generateProfileId();
  const profile: InputProfile = { id, label, bindings: {} };
  return { store: { ...store, profiles: [...store.profiles, profile] }, id };
}

/**
 * 既存プロファイル(組み込みも可)の割当をコピーした新規プロファイルを作る。
 * 複製結果は builtin フラグを持たない(常に編集可能)。sourceId が存在しなければ null。
 */
export function duplicateProfile(
  store: InputProfileStore,
  sourceId: string,
  label: string,
): { store: InputProfileStore; id: string } | null {
  const source = store.profiles.find((p) => p.id === sourceId);
  if (!source) return null;
  const id = generateProfileId();
  const profile: InputProfile = { id, label, bindings: { ...source.bindings } };
  return { store: { ...store, profiles: [...store.profiles, profile] }, id };
}

/** builtin プロファイルは読み取り専用のためリネームできない(無変更で返す)。 */
export function renameProfile(store: InputProfileStore, id: string, label: string): InputProfileStore {
  return {
    ...store,
    profiles: store.profiles.map((p) => (p.id === id && !p.builtin ? { ...p, label } : p)),
  };
}

/** builtin プロファイルは削除できない(無変更で返す)。削除対象がアクティブだった場合は activeId を null に落とす。 */
export function deleteProfile(store: InputProfileStore, id: string): InputProfileStore {
  const target = store.profiles.find((p) => p.id === id);
  if (!target || target.builtin) return store;
  const profiles = store.profiles.filter((p) => p.id !== id);
  const activeId = store.activeId === id ? null : store.activeId;
  return { ...store, profiles, activeId };
}

/** builtin プロファイルへの割当編集は無視する(無変更で返す)。 */
export function setBinding(store: InputProfileStore, profileId: string, sourceId: string, binding: Binding): InputProfileStore {
  return {
    ...store,
    profiles: store.profiles.map((p) =>
      p.id === profileId && !p.builtin ? { ...p, bindings: { ...p.bindings, [sourceId]: binding } } : p,
    ),
  };
}

/** builtin プロファイルへの割当編集は無視する(無変更で返す)。 */
export function clearBinding(store: InputProfileStore, profileId: string, sourceId: string): InputProfileStore {
  return {
    ...store,
    profiles: store.profiles.map((p) => {
      if (p.id !== profileId || p.builtin) return p;
      const bindings = { ...p.bindings };
      delete bindings[sourceId];
      return { ...p, bindings };
    }),
  };
}

export function findProfile(store: InputProfileStore, id: string | null): InputProfile | null {
  if (id === null) return null;
  return store.profiles.find((p) => p.id === id) ?? null;
}

export function activeProfile(store: InputProfileStore): InputProfile | null {
  return findProfile(store, store.activeId);
}
