import { beforeAll, describe, expect, it } from 'vitest';
import {
  BUILTIN_HOSTKEY_ARROWS_JOY_ID,
  BUILTIN_JOY_2BUTTON_ID,
  builtinHostKeyArrowsJoyProfile,
  builtinJoy2ButtonProfile,
  clearBinding,
  emptyHostKeyStore,
  emptyVpadStore,
  setActiveProfile,
  setBinding,
  VPAD_BTN_A,
  type InputProfileStore,
} from '../src/input-profile.ts';

// strings.ts はモジュール初期化時に resolveLang() → location.search を参照するため、
// Node環境(vitest environment: 'node')には無い location をここで用意してから
// dynamic import する(gamepad-ui.test.ts と同じ流儀)。input-profile-ui.ts は strings.ts を
// 静的importしているため、input-profile-ui.ts 自体も dynamic import にする必要がある。
let bindingDisplayText: (typeof import('../src/input-profile-ui.ts'))['bindingDisplayText'];
let labelForRetrok: (typeof import('../src/input-profile-ui.ts'))['labelForRetrok'];
let nextSourceId: (typeof import('../src/input-profile-ui.ts'))['nextSourceId'];
let ensureEditableProfile: (typeof import('../src/input-profile-ui.ts'))['ensureEditableProfile'];
let sourcesFromBindingKeys: (typeof import('../src/input-profile-ui.ts'))['sourcesFromBindingKeys'];
let mergeInputSources: (typeof import('../src/input-profile-ui.ts'))['mergeInputSources'];
let addKeySource: (typeof import('../src/input-profile-ui.ts'))['addKeySource'];
let removePendingSource: (typeof import('../src/input-profile-ui.ts'))['removePendingSource'];

beforeAll(async () => {
  if (typeof (globalThis as { location?: unknown }).location === 'undefined') {
    (globalThis as { location?: { search: string } }).location = { search: '' };
  }
  ({
    bindingDisplayText,
    labelForRetrok,
    nextSourceId,
    ensureEditableProfile,
    sourcesFromBindingKeys,
    mergeInputSources,
    addKeySource,
    removePendingSource,
  } = await import('../src/input-profile-ui.ts'));
  const { setLang } = await import('../src/strings.ts');
  setLang('ja');
});

describe('bindingDisplayText: 割当の表示テキスト', () => {
  it('joyバインディングはターゲット名をそのまま返す', () => {
    expect(bindingDisplayText({ kind: 'joy', target: 'TRG1' })).toBe('TRG1');
    expect(bindingDisplayText({ kind: 'joy', target: 'UP' })).toBe('UP');
  });

  it('keyバインディングはKBD_ROWS/KEYPAD_ROWSのlabelを引いて返す(数値のretrokをそのまま出さない)', async () => {
    const { RETROK } = await import('../src/keyboard.ts');
    expect(bindingDisplayText({ kind: 'key', retrok: RETROK.SPACE })).toBe('SPACE');
    expect(bindingDisplayText({ kind: 'key', retrok: RETROK.RETURN })).toBe('RETURN');
    // 改行を含むラベル(HOME\n(CLR))はスペースへ正規化される。
    expect(bindingDisplayText({ kind: 'key', retrok: RETROK.HOME })).toBe('HOME (CLR)');
  });

  it('未割当はローカライズされた「なし」を返す', () => {
    expect(bindingDisplayText(undefined)).toBe('なし');
  });

  it('labelForRetrokは未知のretrokを0x表記でフォールバックする', () => {
    expect(labelForRetrok(0xdeadbeef)).toBe(`0x${(0xdeadbeef).toString(16)}`);
  });
});

describe('nextSourceId: 次の行へ進む行送りロジック', () => {
  const ids = ['a', 'b', 'c'];

  it('中間の行なら次の行のIDを返す', () => {
    expect(nextSourceId(ids, 'a')).toBe('b');
    expect(nextSourceId(ids, 'b')).toBe('c');
  });

  it('最終行なら選択解除(null)になる', () => {
    expect(nextSourceId(ids, 'c')).toBeNull();
  });

  it('currentIdがnullならnullのまま', () => {
    expect(nextSourceId(ids, null)).toBeNull();
  });

  it('一覧に無いIDが渡されたらそのまま返す(型ガード漏れに対する保険)', () => {
    expect(nextSourceId(ids, 'zzz')).toBe('zzz');
  });
});

describe('ensureEditableProfile: 組み込みプロファイル選択中の自動複製', () => {
  it('builtinプロファイルを対象にすると複製を作りactiveIdをそちらへ移す。元の組み込みは変わらない', () => {
    const store = emptyVpadStore();
    const before = store.profiles.find((p) => p.id === BUILTIN_JOY_2BUTTON_ID)!;
    expect(before.bindings[VPAD_BTN_A]).toEqual({ kind: 'joy', target: 'TRG1' });

    const result = ensureEditableProfile(store, BUILTIN_JOY_2BUTTON_ID, 'ジョイスティック(2ボタン) のコピー');

    expect(result.duplicated).toBe(true);
    expect(result.targetId).not.toBe(BUILTIN_JOY_2BUTTON_ID);
    expect(result.store.activeId).toBe(result.targetId);

    // 元の組み込みプロファイルはストア内に残ったまま、内容(bindings)も一切変わっていない。
    const originalStill = result.store.profiles.find((p) => p.id === BUILTIN_JOY_2BUTTON_ID)!;
    expect(originalStill).toEqual(builtinJoy2ButtonProfile());

    // 複製されたプロファイルは元と同じ内容を持ち、builtinフラグは付かない(常に編集可能)。
    const duplicated = result.store.profiles.find((p) => p.id === result.targetId)!;
    expect(duplicated.builtin).toBeUndefined();
    expect(duplicated.bindings).toEqual(before.bindings);
    expect(duplicated.label).toBe('ジョイスティック(2ボタン) のコピー');

    // プロファイル数は1つだけ増える。
    expect(result.store.profiles.length).toBe(store.profiles.length + 1);
  });

  it('builtinでないプロファイルが対象なら何もしない(複製せずそのまま返す)', () => {
    const store = setActiveProfile(emptyVpadStore(), BUILTIN_JOY_2BUTTON_ID);
    // 非builtinの実在ID(組み込み4種以外)を使う代わりに、存在しないIDで「対象が見つからない」経路も検証する。
    const result = ensureEditableProfile(store, 'not-builtin-and-missing', 'x');
    expect(result).toEqual({ store, targetId: 'not-builtin-and-missing', duplicated: false });
  });

  it('複製後のstoreをさらにensureEditableProfileへ渡しても(既にbuiltinでないため)再複製しない', () => {
    const store = emptyVpadStore();
    const first = ensureEditableProfile(store, BUILTIN_JOY_2BUTTON_ID, 'copy1');
    const second = ensureEditableProfile(first.store, first.targetId, 'copy2');
    expect(second.duplicated).toBe(false);
    expect(second.targetId).toBe(first.targetId);
    expect(second.store).toBe(first.store);
  });
});

describe('input-profile-ui: 既存storeの不変条件を壊さない', () => {
  it('ensureEditableProfileはstoreを書き換えず新しいstoreを返す(純粋関数)', () => {
    const store = emptyVpadStore();
    const before: InputProfileStore = JSON.parse(JSON.stringify(store));
    ensureEditableProfile(store, BUILTIN_JOY_2BUTTON_ID, 'copy');
    expect(store).toEqual(before);
  });
});

describe('ensureEditableProfile: hostkeyストアでも同じく働く(二重実装していないことの確認)', () => {
  it('組み込みホストキープロファイルを対象にすると複製を作りactiveIdをそちらへ移す。元の組み込みは変わらない', () => {
    const store = emptyHostKeyStore();
    const before = store.profiles.find((p) => p.id === BUILTIN_HOSTKEY_ARROWS_JOY_ID)!;

    const result = ensureEditableProfile(store, BUILTIN_HOSTKEY_ARROWS_JOY_ID, '矢印+ジョイ2ボタン のコピー');

    expect(result.duplicated).toBe(true);
    expect(result.targetId).not.toBe(BUILTIN_HOSTKEY_ARROWS_JOY_ID);
    expect(result.store.activeId).toBe(result.targetId);

    const originalStill = result.store.profiles.find((p) => p.id === BUILTIN_HOSTKEY_ARROWS_JOY_ID)!;
    expect(originalStill).toEqual(builtinHostKeyArrowsJoyProfile());

    const duplicated = result.store.profiles.find((p) => p.id === result.targetId)!;
    expect(duplicated.builtin).toBeUndefined();
    expect(duplicated.bindings).toEqual(before.bindings);
  });
});

describe('sourcesFromBindingKeys: ホストキー用のderiveSources実装(id=label=code)', () => {
  it('bindingsのキーをそのままid/labelにする(Object.keysの挿入順を保つ)', () => {
    const sources = sourcesFromBindingKeys({
      ArrowUp: { kind: 'joy', target: 'UP' },
      KeyZ: { kind: 'joy', target: 'TRG1' },
    });
    expect(sources).toEqual([
      { id: 'ArrowUp', label: 'ArrowUp' },
      { id: 'KeyZ', label: 'KeyZ' },
    ]);
  });

  it('bindingsが空なら空配列', () => {
    expect(sourcesFromBindingKeys({})).toEqual([]);
  });
});

describe('mergeInputSources: 入力元一覧の並び順の安定性(追加・削除で既存行の順序が入れ替わらない)', () => {
  const base = [
    { id: 'ArrowUp', label: 'ArrowUp' },
    { id: 'ArrowDown', label: 'ArrowDown' },
  ];

  it('pendingのうちbaseに無いものだけを末尾に追加した順で足す', () => {
    expect(mergeInputSources(base, ['KeyZ', 'KeyX'])).toEqual([
      ...base,
      { id: 'KeyZ', label: 'KeyZ' },
      { id: 'KeyX', label: 'KeyX' },
    ]);
  });

  it('pendingがbaseに既にある(割当が付いた)場合は重複させない', () => {
    expect(mergeInputSources(base, ['ArrowUp', 'KeyZ'])).toEqual([...base, { id: 'KeyZ', label: 'KeyZ' }]);
  });

  it('baseの並び順はpendingの内容に関わらず変わらない', () => {
    const withPending = mergeInputSources(base, ['KeyZ']);
    expect(withPending.slice(0, 2)).toEqual(base);
  });

  it('baseからキーが1つ消えても、残った行の並び順は変わらない(削除で入れ替わらない)', () => {
    // ArrowDownが割当を失って base から消えたケースを模す。
    const shrunkBase = [base[0]];
    expect(mergeInputSources(shrunkBase, [])).toEqual([base[0]]);
  });
});

describe('addKeySource: 「キーを追加」のロジック', () => {
  it('未登録のcodeはpendingへ追加し、そのcodeを選択する', () => {
    const result = addKeySource(['ArrowUp'], [], 'KeyQ');
    expect(result).toEqual({ pendingIds: ['KeyQ'], selectedId: 'KeyQ' });
  });

  it('既に一覧にあるcode(bindings由来でもpending由来でも)は追加せず、選択するだけ', () => {
    const boundAlready = addKeySource(['ArrowUp', 'KeyZ'], ['KeyZ'], 'ArrowUp');
    expect(boundAlready).toEqual({ pendingIds: ['KeyZ'], selectedId: 'ArrowUp' });

    const pendingAlready = addKeySource(['ArrowUp', 'KeyZ'], ['KeyZ'], 'KeyZ');
    expect(pendingAlready).toEqual({ pendingIds: ['KeyZ'], selectedId: 'KeyZ' });
  });

  it('複数回追加しても既存のpendingを壊さず末尾に積む', () => {
    const first = addKeySource(['ArrowUp'], [], 'KeyQ');
    const second = addKeySource([...['ArrowUp'], ...first.pendingIds], first.pendingIds, 'KeyW');
    expect(second.pendingIds).toEqual(['KeyQ', 'KeyW']);
  });
});

describe('removePendingSource: 行の削除(pending側)', () => {
  it('指定したcodeだけを取り除く(他は巻き込まない)', () => {
    expect(removePendingSource(['KeyQ', 'KeyW', 'KeyE'], 'KeyW')).toEqual(['KeyQ', 'KeyE']);
  });

  it('存在しないcodeを指定しても変化しない', () => {
    expect(removePendingSource(['KeyQ'], 'KeyZ')).toEqual(['KeyQ']);
  });
});

describe('行の削除: clearBindingはその入力元の割当だけを消す(他を巻き込まない、UIのremoveSource()の土台)', () => {
  it('2つの割当を持つプロファイルから片方だけclearBindingしても、もう片方は残る', () => {
    const created = { store: emptyHostKeyStore(), id: 'p' };
    const store: InputProfileStore = { ...created.store, profiles: [...created.store.profiles, { id: 'p', label: 'x', bindings: {} }] };
    const withTwo = setBinding(setBinding(store, 'p', 'ArrowUp', { kind: 'joy', target: 'UP' }), 'p', 'KeyZ', {
      kind: 'joy',
      target: 'TRG1',
    });
    const cleared = clearBinding(withTwo, 'p', 'ArrowUp');
    const profile = cleared.profiles.find((p) => p.id === 'p')!;
    expect(profile.bindings.ArrowUp).toBeUndefined();
    expect(profile.bindings.KeyZ).toEqual({ kind: 'joy', target: 'TRG1' });
  });
});
