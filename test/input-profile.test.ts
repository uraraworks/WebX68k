import { describe, expect, it } from 'vitest';
import {
  activeProfile,
  BUILTIN_CURSOR_SPACE_ID,
  BUILTIN_HOSTKEY_ARROWS_JOY_ID,
  BUILTIN_HOSTKEY_ARROWS_JOY6_ID,
  BUILTIN_HOSTKEY_TENKEY_ID,
  BUILTIN_JOY_2BUTTON_ID,
  BUILTIN_JOY_6BUTTON_ID,
  BUILTIN_TENKEY_ID,
  builtinCursorSpaceProfile,
  builtinHostKeyArrowsJoy6Profile,
  builtinHostKeyArrowsJoyProfile,
  builtinHostKeyTenkeyProfile,
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
  joyBitsForPressedCodes,
  loadInputProfileStore,
  renameProfile,
  resolveHostKeyBinding,
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
  type Binding,
  type InputBindings,
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

  // 2026-08-09: ホストキー機能(物理キー→ジョイ/別キー再割り当て)の実装に伴い、
  // 「器のみ(組み込み無し)」だった従来の既定値を「組み込み3種を持ち、既定でOFF」へ変更した。
  // この変更は今回のタスク仕様が明示的に指示するものであり、以下のアサーションは
  // その新しい既定契約を検証する(旧アサーションを緩めたのではなく、契約そのものが変わった)。
  it('既定のホストキーストアは組み込み3種を持ち、矢印+ジョイ2ボタンがアクティブで、機能はOFF', () => {
    const store = emptyHostKeyStore();
    expect(store.profiles).toHaveLength(3);
    expect(store.profiles.map((p) => p.id)).toEqual([
      BUILTIN_HOSTKEY_ARROWS_JOY_ID,
      BUILTIN_HOSTKEY_ARROWS_JOY6_ID,
      BUILTIN_HOSTKEY_TENKEY_ID,
    ]);
    expect(store.profiles.every((p) => p.builtin)).toBe(true);
    expect(store.activeId).toBe(BUILTIN_HOSTKEY_ARROWS_JOY_ID);
    expect(store.enabled).toBe(false);
  });

  it('hk-arrows-joy: 矢印はjoy(UP/DOWN/LEFT/RIGHT)、KeyZ=TRG1、KeyX=TRG2', () => {
    const p = builtinHostKeyArrowsJoyProfile();
    expect(p.bindings.ArrowUp).toEqual({ kind: 'joy', target: 'UP' });
    expect(p.bindings.ArrowDown).toEqual({ kind: 'joy', target: 'DOWN' });
    expect(p.bindings.ArrowLeft).toEqual({ kind: 'joy', target: 'LEFT' });
    expect(p.bindings.ArrowRight).toEqual({ kind: 'joy', target: 'RIGHT' });
    expect(p.bindings.KeyZ).toEqual({ kind: 'joy', target: 'TRG1' });
    expect(p.bindings.KeyX).toEqual({ kind: 'joy', target: 'TRG2' });
  });

  it('hk-arrows-joy6: hk-arrows-joyに加えKeyA=TRG3、KeyS=TRG4、KeyD=TRG5、KeyC=TRG8(CPSF-MD用)', () => {
    const p = builtinHostKeyArrowsJoy6Profile();
    expect(p.bindings.ArrowUp).toEqual({ kind: 'joy', target: 'UP' });
    expect(p.bindings.KeyZ).toEqual({ kind: 'joy', target: 'TRG1' });
    expect(p.bindings.KeyX).toEqual({ kind: 'joy', target: 'TRG2' });
    expect(p.bindings.KeyA).toEqual({ kind: 'joy', target: 'TRG3' });
    expect(p.bindings.KeyS).toEqual({ kind: 'joy', target: 'TRG4' });
    expect(p.bindings.KeyD).toEqual({ kind: 'joy', target: 'TRG5' });
    expect(p.bindings.KeyC).toEqual({ kind: 'joy', target: 'TRG8' });
  });

  it('hk-tenkey: 矢印はkey(テンキー数字)への再割当のみ(キー→キーの例)', () => {
    const p = builtinHostKeyTenkeyProfile();
    expect(p.bindings.ArrowUp).toEqual({ kind: 'key', retrok: RETROK.KP8 });
    expect(p.bindings.ArrowDown).toEqual({ kind: 'key', retrok: RETROK.KP2 });
    expect(p.bindings.ArrowLeft).toEqual({ kind: 'key', retrok: RETROK.KP4 });
    expect(p.bindings.ArrowRight).toEqual({ kind: 'key', retrok: RETROK.KP6 });
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
  // 2026-08-09: ホストキー用ストアも組み込み3種を持つようになったため、vpad用ストアと同じく
  // normalizeStore() が保存データから欠けた組み込みを補う対象になった(上のemptyHostKeyStoreの
  // テスト変更と対になる契約変更)。
  it('ホストキー用ストアも保存データから組み込みが欠けていれば補われる', () => {
    const storage = makeStorage();
    storage.setItem(HOSTKEY_STORAGE_KEY, JSON.stringify({ version: 1, profiles: [], activeId: null, enabled: false } satisfies InputProfileStore));
    const loaded = loadInputProfileStore(HOSTKEY_STORAGE_KEY, storage);
    expect(loaded.profiles.map((p) => p.id)).toEqual([
      BUILTIN_HOSTKEY_ARROWS_JOY_ID,
      BUILTIN_HOSTKEY_ARROWS_JOY6_ID,
      BUILTIN_HOSTKEY_TENKEY_ID,
    ]);
  });

  it('ホストキー用ストアの組み込みも読み取り専用(改ざんされても正規の内容へ強制される)', () => {
    const storage = makeStorage();
    storage.setItem(
      HOSTKEY_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        profiles: [{ id: BUILTIN_HOSTKEY_ARROWS_JOY_ID, label: 'tampered', builtin: false, bindings: {} }],
        activeId: null,
        enabled: false,
      } satisfies InputProfileStore),
    );
    const loaded = loadInputProfileStore(HOSTKEY_STORAGE_KEY, storage);
    const builtin = findProfile(loaded, BUILTIN_HOSTKEY_ARROWS_JOY_ID);
    expect(builtin?.builtin).toBe(true);
    expect(builtin?.bindings).toEqual(builtinHostKeyArrowsJoyProfile().bindings);
  });
});

describe('resolveHostKeyBinding(物理キーの関所の判定)', () => {
  it('enabled:false のときは常にnull(素通り)', () => {
    const store = { ...emptyHostKeyStore(), enabled: false };
    expect(resolveHostKeyBinding(store, 'ArrowUp')).toBeNull();
  });

  it('enabled:true でも有効プロファイルが無ければnull', () => {
    const store: InputProfileStore = { version: 1, profiles: [], activeId: null, enabled: true };
    expect(resolveHostKeyBinding(store, 'ArrowUp')).toBeNull();
  });

  it('enabled:true・有効プロファイル有りで、割当の無いcodeはnull', () => {
    const store = { ...emptyHostKeyStore(), enabled: true };
    expect(resolveHostKeyBinding(store, 'KeyQ')).toBeNull();
  });

  it('enabled:true・有効プロファイル有りで、割当の有るcodeはそのBindingを返す', () => {
    const store = { ...emptyHostKeyStore(), enabled: true };
    expect(resolveHostKeyBinding(store, 'ArrowUp')).toEqual({ kind: 'joy', target: 'UP' });
    expect(resolveHostKeyBinding(store, 'KeyZ')).toEqual({ kind: 'joy', target: 'TRG1' });
  });
});

describe('joyBitsForPressedCodes(キーボード由来のjoyビット計算)', () => {
  const bindings: InputBindings = {
    ArrowUp: { kind: 'joy', target: 'UP' },
    KeyZ: { kind: 'joy', target: 'TRG1' },
    KeyReturn: { kind: 'key', retrok: RETROK.RETURN },
  };
  const resolve = (code: string): Binding | undefined => bindings[code];

  it('padTypeでTRGnのビット位置が変わる(default→id0、cpsf-md→id8)', () => {
    const bitsDefault = joyBitsForPressedCodes(['KeyZ'], resolve, 'default');
    const bitsMd = joyBitsForPressedCodes(['KeyZ'], resolve, 'cpsf-md');
    expect(bitsDefault).toBe(1 << 0);
    expect(bitsMd).toBe(1 << 8);
    expect(bitsDefault).not.toBe(bitsMd);
  });

  it('割当の無いcodeは無視される', () => {
    const bits = joyBitsForPressedCodes(['ArrowUp', 'KeyQ'], resolve, 'default');
    expect(bits).toBe(1 << 4); // UP の RetroPad ID(default)
  });

  it('kind:keyの割当は合算されない(joy側のビットには乗らない)', () => {
    const bits = joyBitsForPressedCodes(['KeyReturn'], resolve, 'default');
    expect(bits).toBe(0);
  });

  it('複数code同時押下はORで合成される', () => {
    const bits = joyBitsForPressedCodes(['ArrowUp', 'KeyZ'], resolve, 'default');
    expect(bits).toBe((1 << 4) | (1 << 0));
  });
});

describe('物理キーの押下記録(main.tsの関所と同じ設計)による固着防止', () => {
  it('press時点の割当をMapに記録し、途中でプロファイルが切り替わってもreleaseは記録済みの割当を使う', () => {
    const storeA = { ...emptyHostKeyStore(), enabled: true }; // active: hk-arrows-joy(ArrowUp→joy UP)
    const storeB = setActiveProfile({ ...emptyHostKeyStore(), enabled: true }, BUILTIN_HOSTKEY_TENKEY_ID); // ArrowUp→key KP8

    // main.ts の keydown 相当: press時点のstore(storeA)で解決し、Mapへ記録する。
    const pressed = new Map<string, Binding>();
    const pressBinding = resolveHostKeyBinding(storeA, 'ArrowUp');
    expect(pressBinding).not.toBeNull();
    pressed.set('ArrowUp', pressBinding!);

    // 押している最中にプロファイルが切り替わる(storeB)。
    // もし release 側が「今のstore」で再解決してしまうと、pressBindingとは別物(kind:'key')になり、
    // sharedKeyInput.press/releaseの対称性が壊れてretrokが噛み合わなくなる(固着の原因)。
    const liveResolved = resolveHostKeyBinding(storeB, 'ArrowUp');
    expect(liveResolved).not.toEqual(pressBinding); // 再解決すると別の割当になってしまうことの確認。

    // main.ts の keyup 相当: Mapに記録済みの割当(press時点のもの)をそのまま使ってreleaseする。
    const releaseBinding = pressed.get('ArrowUp');
    pressed.delete('ArrowUp');
    expect(releaseBinding).toEqual(pressBinding); // press したときの割当と同じものが release される。
    expect(pressed.has('ArrowUp')).toBe(false); // 固着していない(Mapから消えている)。

    // release後はjoyビットも0に戻る(Mapが空なので joyBitsForPressedCodes も0を返す)。
    const bitsAfterRelease = joyBitsForPressedCodes(pressed.keys(), (c) => pressed.get(c), 'default');
    expect(bitsAfterRelease).toBe(0);
  });
});
