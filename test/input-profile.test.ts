import { describe, expect, it } from 'vitest';
import {
  activeProfile,
  BUILTIN_CURSOR_SPACE_ID,
  BUILTIN_JOY_2BUTTON_ID,
  BUILTIN_JOY_6BUTTON_ID,
  BUILTIN_TENKEY_ID,
  builtinCursorSpaceProfile,
  builtinJoy2ButtonProfile,
  builtinJoy6ButtonProfile,
  builtinTenkeyProfile,
  clearBinding,
  createProfile,
  deleteProfile,
  duplicateProfile,
  emptyHostKeyStore,
  emptyVpadStore,
  findProfile,
  HOSTKEY_STORAGE_KEY,
  loadInputProfileStore,
  renameProfile,
  saveInputProfileStore,
  setActiveProfile,
  setBinding,
  setEnabled,
  VPAD_BTN_A,
  VPAD_BTN_B,
  VPAD_BTN_C,
  VPAD_BTN_D,
  VPAD_BTN_E,
  VPAD_BTN_F,
  VPAD_BTN_OPT1,
  VPAD_BTN_OPT2,
  VPAD_DPAD_DOWN,
  VPAD_DPAD_LEFT,
  VPAD_DPAD_RIGHT,
  VPAD_DPAD_UP,
  VPAD_STORAGE_KEY,
  type InputProfileStore,
} from '../src/input-profile';
import { RETROK } from '../src/keyboard';

/** テスト用の最小 localStorage モック(gamepad.test.ts と同じ流儀)。 */
function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

describe('emptyVpadStore/組み込みプロファイル', () => {
  it('既定のバーチャルパッドストアは組み込み4種を持ち、joy-2buttonがアクティブで、機能はOFF', () => {
    const store = emptyVpadStore();
    expect(store.profiles).toHaveLength(4);
    expect(store.profiles.map((p) => p.id)).toEqual([
      BUILTIN_JOY_2BUTTON_ID,
      BUILTIN_CURSOR_SPACE_ID,
      BUILTIN_TENKEY_ID,
      BUILTIN_JOY_6BUTTON_ID,
    ]);
    expect(store.profiles.every((p) => p.builtin)).toBe(true);
    expect(store.activeId).toBe(BUILTIN_JOY_2BUTTON_ID);
    expect(store.enabled).toBe(false);
  });

  it('既定のホストキーストアは組み込みプロファイル無しの器のみ', () => {
    const store = emptyHostKeyStore();
    expect(store.profiles).toEqual([]);
    expect(store.activeId).toBeNull();
    expect(store.enabled).toBe(false);
  });

  it('joy-2button: 方向はjoy、btn-a/btn-bはTRG1/TRG2', () => {
    const p = builtinJoy2ButtonProfile();
    expect(p.bindings[VPAD_DPAD_UP]).toEqual({ kind: 'joy', target: 'UP' });
    expect(p.bindings[VPAD_DPAD_DOWN]).toEqual({ kind: 'joy', target: 'DOWN' });
    expect(p.bindings[VPAD_DPAD_LEFT]).toEqual({ kind: 'joy', target: 'LEFT' });
    expect(p.bindings[VPAD_DPAD_RIGHT]).toEqual({ kind: 'joy', target: 'RIGHT' });
    expect(p.bindings[VPAD_BTN_A]).toEqual({ kind: 'joy', target: 'TRG1' });
    expect(p.bindings[VPAD_BTN_B]).toEqual({ kind: 'joy', target: 'TRG2' });
  });

  it('cursor-space: 方向はkey(矢印)、btn-a=SPACE、btn-b=RETURN', () => {
    const p = builtinCursorSpaceProfile();
    expect(p.bindings[VPAD_DPAD_UP]).toEqual({ kind: 'key', retrok: RETROK.UP });
    expect(p.bindings[VPAD_DPAD_DOWN]).toEqual({ kind: 'key', retrok: RETROK.DOWN });
    expect(p.bindings[VPAD_DPAD_LEFT]).toEqual({ kind: 'key', retrok: RETROK.LEFT });
    expect(p.bindings[VPAD_DPAD_RIGHT]).toEqual({ kind: 'key', retrok: RETROK.RIGHT });
    expect(p.bindings[VPAD_BTN_A]).toEqual({ kind: 'key', retrok: RETROK.SPACE });
    expect(p.bindings[VPAD_BTN_B]).toEqual({ kind: 'key', retrok: RETROK.RETURN });
  });

  it('tenkey: 方向はkey(テンキー)、btn-a=SPACE、btn-b=RETURN', () => {
    const p = builtinTenkeyProfile();
    expect(p.bindings[VPAD_DPAD_UP]).toEqual({ kind: 'key', retrok: RETROK.KP8 });
    expect(p.bindings[VPAD_DPAD_DOWN]).toEqual({ kind: 'key', retrok: RETROK.KP2 });
    expect(p.bindings[VPAD_DPAD_LEFT]).toEqual({ kind: 'key', retrok: RETROK.KP4 });
    expect(p.bindings[VPAD_DPAD_RIGHT]).toEqual({ kind: 'key', retrok: RETROK.KP6 });
    expect(p.bindings[VPAD_BTN_A]).toEqual({ kind: 'key', retrok: RETROK.SPACE });
    expect(p.bindings[VPAD_BTN_B]).toEqual({ kind: 'key', retrok: RETROK.RETURN });
  });

  it('joy-6button: MD6ボタン配置(px68k-libretro/libretro/joystick.cのPAD_CPSF_MDコメントが出典)どおりの割当', () => {
    const p = builtinJoy6ButtonProfile();
    expect(p.bindings[VPAD_DPAD_UP]).toEqual({ kind: 'joy', target: 'UP' });
    expect(p.bindings[VPAD_DPAD_DOWN]).toEqual({ kind: 'joy', target: 'DOWN' });
    expect(p.bindings[VPAD_DPAD_LEFT]).toEqual({ kind: 'joy', target: 'LEFT' });
    expect(p.bindings[VPAD_DPAD_RIGHT]).toEqual({ kind: 'joy', target: 'RIGHT' });
    // 下段 A/B/C = 弱/中/強キック
    expect(p.bindings[VPAD_BTN_A]).toEqual({ kind: 'joy', target: 'TRG1' }); // Low-Kick
    expect(p.bindings[VPAD_BTN_B]).toEqual({ kind: 'joy', target: 'TRG2' }); // Mid-Kick
    expect(p.bindings[VPAD_BTN_C]).toEqual({ kind: 'joy', target: 'TRG8' }); // High-Kick
    // 上段 X/Y/Z = 弱/中/強パンチ
    expect(p.bindings[VPAD_BTN_D]).toEqual({ kind: 'joy', target: 'TRG4' }); // Low-Punch
    expect(p.bindings[VPAD_BTN_E]).toEqual({ kind: 'joy', target: 'TRG3' }); // Mid-Punch
    expect(p.bindings[VPAD_BTN_F]).toEqual({ kind: 'joy', target: 'TRG5' }); // High-Punch
    expect(p.bindings[VPAD_BTN_OPT1]).toEqual({ kind: 'joy', target: 'TRG6' }); // Start
    expect(p.bindings[VPAD_BTN_OPT2]).toEqual({ kind: 'joy', target: 'TRG7' }); // Mode
  });
});

describe('永続化: load/save', () => {
  it('データが無ければ既定値(空ストア)を返す', () => {
    const storage = makeStorage();
    expect(loadInputProfileStore(VPAD_STORAGE_KEY, storage)).toEqual(emptyVpadStore());
    expect(loadInputProfileStore(HOSTKEY_STORAGE_KEY, storage)).toEqual(emptyHostKeyStore());
  });

  it('JSON破損データは既定値へフォールバックする', () => {
    const storage = makeStorage();
    storage.setItem(VPAD_STORAGE_KEY, '{not valid json');
    expect(loadInputProfileStore(VPAD_STORAGE_KEY, storage)).toEqual(emptyVpadStore());
  });

  it('構造不正(version違い)は既定値へフォールバックする', () => {
    const storage = makeStorage();
    storage.setItem(VPAD_STORAGE_KEY, JSON.stringify({ version: 2, profiles: [], activeId: null, enabled: false }));
    expect(loadInputProfileStore(VPAD_STORAGE_KEY, storage)).toEqual(emptyVpadStore());
  });

  it('構造不正(bindingsの値がBindingでない)は既定値へフォールバックする', () => {
    const storage = makeStorage();
    storage.setItem(
      VPAD_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        profiles: [{ id: 'p1', label: 'x', bindings: { [VPAD_DPAD_UP]: { kind: 'joy', target: 'NOT_A_TARGET' } } }],
        activeId: null,
        enabled: false,
      }),
    );
    expect(loadInputProfileStore(VPAD_STORAGE_KEY, storage)).toEqual(emptyVpadStore());
  });

  it('存在しないキー(未存在)は例外を投げず既定へフォールバックする', () => {
    const storage = makeStorage();
    expect(() => loadInputProfileStore('webx68k.nonexistent', storage)).not.toThrow();
  });

  it('保存して読み直すと同じ内容が復元できる', () => {
    const storage = makeStorage();
    const { store: created, id } = createProfile(emptyVpadStore(), 'My Profile');
    const withBinding = setBinding(created, id, 'KeyZ', { kind: 'key', retrok: RETROK.SPACE });
    const withActive = setActiveProfile(withBinding, id);
    saveInputProfileStore(VPAD_STORAGE_KEY, withActive, storage);
    const loaded = loadInputProfileStore(VPAD_STORAGE_KEY, storage);
    expect(loaded.activeId).toBe(id);
    expect(findProfile(loaded, id)?.bindings.KeyZ).toEqual({ kind: 'key', retrok: RETROK.SPACE });
  });

  it('activeIdが実在しないプロファイルを指す壊れたデータはnullへ落とす(normalizeStore)', () => {
    const storage = makeStorage();
    storage.setItem(
      VPAD_STORAGE_KEY,
      JSON.stringify({ version: 1, profiles: [builtinJoy2ButtonProfile()], activeId: 'ghost', enabled: false }),
    );
    const loaded = loadInputProfileStore(VPAD_STORAGE_KEY, storage);
    expect(loaded.activeId).toBeNull();
  });

  it('組み込みプロファイルが保存データから欠けていても読み込み時に補われる', () => {
    const storage = makeStorage();
    storage.setItem(VPAD_STORAGE_KEY, JSON.stringify({ version: 1, profiles: [], activeId: null, enabled: false }));
    const loaded = loadInputProfileStore(VPAD_STORAGE_KEY, storage);
    expect(loaded.profiles.some((p) => p.id === BUILTIN_JOY_2BUTTON_ID)).toBe(true);
    expect(loaded.profiles.some((p) => p.id === BUILTIN_JOY_6BUTTON_ID)).toBe(true);
  });

  it('localStorage上で組み込みプロファイルの中身が改ざんされても正規の内容へ強制される(読み取り専用の不変条件)', () => {
    const storage = makeStorage();
    storage.setItem(
      VPAD_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        profiles: [{ id: BUILTIN_JOY_2BUTTON_ID, label: 'tampered', builtin: false, bindings: { [VPAD_BTN_A]: { kind: 'joy', target: 'TRG8' } } }],
        activeId: null,
        enabled: false,
      }),
    );
    const loaded = loadInputProfileStore(VPAD_STORAGE_KEY, storage);
    const builtin = findProfile(loaded, BUILTIN_JOY_2BUTTON_ID);
    expect(builtin?.builtin).toBe(true);
    expect(builtin?.bindings).toEqual(builtinJoy2ButtonProfile().bindings);
  });
});

describe('CRUD', () => {
  it('createProfile: 空の割当で新規プロファイルを追加する', () => {
    const { store, id } = createProfile(emptyVpadStore(), 'New');
    const profile = findProfile(store, id);
    expect(profile?.label).toBe('New');
    expect(profile?.bindings).toEqual({});
    expect(profile?.builtin).toBeUndefined();
  });

  it('duplicateProfile: 組み込みプロファイルも複製でき、複製結果はbuiltinでない(編集可能)', () => {
    const result = duplicateProfile(emptyVpadStore(), BUILTIN_JOY_2BUTTON_ID, 'Copy of builtin');
    expect(result).not.toBeNull();
    const profile = findProfile(result!.store, result!.id);
    expect(profile?.builtin).toBeUndefined();
    expect(profile?.bindings).toEqual(builtinJoy2ButtonProfile().bindings);
  });

  it('duplicateProfile: 存在しないsourceIdはnullを返す', () => {
    expect(duplicateProfile(emptyVpadStore(), 'ghost', 'x')).toBeNull();
  });

  it('renameProfile: 通常プロファイルはリネームできる', () => {
    const { store, id } = createProfile(emptyVpadStore(), 'Old');
    const renamed = renameProfile(store, id, 'Renamed');
    expect(findProfile(renamed, id)?.label).toBe('Renamed');
  });

  it('renameProfile: 組み込みプロファイルはリネームできない(無変更で返る)', () => {
    const store = emptyVpadStore();
    const attempted = renameProfile(store, BUILTIN_JOY_2BUTTON_ID, 'Hacked');
    expect(findProfile(attempted, BUILTIN_JOY_2BUTTON_ID)?.label).toBe(builtinJoy2ButtonProfile().label);
  });

  it('deleteProfile: 通常プロファイルは削除でき、それがアクティブだった場合activeIdはnullになる', () => {
    const { store, id } = createProfile(emptyVpadStore(), 'ToDelete');
    const activated = setActiveProfile(store, id);
    const deleted = deleteProfile(activated, id);
    expect(findProfile(deleted, id)).toBeNull();
    expect(deleted.activeId).toBeNull();
  });

  it('deleteProfile: 組み込みプロファイルは削除できない(無変更で返る)', () => {
    const store = emptyVpadStore();
    const attempted = deleteProfile(store, BUILTIN_JOY_2BUTTON_ID);
    expect(findProfile(attempted, BUILTIN_JOY_2BUTTON_ID)).not.toBeNull();
    expect(attempted.profiles).toHaveLength(4);
  });

  it('setBinding/clearBinding: 通常プロファイルは編集できる', () => {
    const { store, id } = createProfile(emptyVpadStore(), 'P');
    const withBinding = setBinding(store, id, VPAD_BTN_A, { kind: 'joy', target: 'TRG1' });
    expect(findProfile(withBinding, id)?.bindings[VPAD_BTN_A]).toEqual({ kind: 'joy', target: 'TRG1' });
    const cleared = clearBinding(withBinding, id, VPAD_BTN_A);
    expect(findProfile(cleared, id)?.bindings[VPAD_BTN_A]).toBeUndefined();
  });

  it('setBinding/clearBinding: 組み込みプロファイルへの編集は無視される(読み取り専用)', () => {
    const store = emptyVpadStore();
    const attempted = setBinding(store, BUILTIN_JOY_2BUTTON_ID, VPAD_BTN_C, { kind: 'joy', target: 'TRG3' });
    expect(findProfile(attempted, BUILTIN_JOY_2BUTTON_ID)?.bindings[VPAD_BTN_C]).toBeUndefined();
    const attemptedClear = clearBinding(store, BUILTIN_JOY_2BUTTON_ID, VPAD_DPAD_UP);
    expect(findProfile(attemptedClear, BUILTIN_JOY_2BUTTON_ID)?.bindings[VPAD_DPAD_UP]).toEqual({ kind: 'joy', target: 'UP' });
  });

  it('setActiveProfile: 存在しないidは無視される(無変更で返る)', () => {
    const store = emptyVpadStore();
    const attempted = setActiveProfile(store, 'ghost');
    expect(attempted.activeId).toBe(store.activeId);
  });

  it('setActiveProfile: nullは常に許可される(未選択状態)', () => {
    const store = emptyVpadStore();
    expect(setActiveProfile(store, null).activeId).toBeNull();
  });

  it('setEnabled: enabledフラグを切り替える', () => {
    const store = emptyVpadStore();
    expect(setEnabled(store, true).enabled).toBe(true);
    expect(setEnabled(store, true).enabled).not.toBe(store.enabled);
  });

  it('activeProfile: activeIdの実体を返す', () => {
    const store = emptyVpadStore();
    expect(activeProfile(store)?.id).toBe(BUILTIN_JOY_2BUTTON_ID);
  });
});

describe('normalizeStore(用途ごとの器の独立性)', () => {
  it('ホストキー用ストアには組み込みプロファイルを補わない(器のみの仕様)', () => {
    const storage = makeStorage();
    storage.setItem(HOSTKEY_STORAGE_KEY, JSON.stringify({ version: 1, profiles: [], activeId: null, enabled: false } satisfies InputProfileStore));
    const loaded = loadInputProfileStore(HOSTKEY_STORAGE_KEY, storage);
    expect(loaded.profiles).toEqual([]);
  });
});
