/**
 * 入力プロファイルの割当編集ダイアログ。
 *
 * 今回はバーチャルパッド(入力元ID=画面部品ID)から呼ばれるが、将来ホストキー
 * (KeyboardEvent.code)再割り当てにも使い回す前提で、「編集対象の入力元一覧」は
 * 呼び出し側(InputSourceDef[])から渡してもらう形にしてある。過度な抽象化はせず、
 * それ以外(ストアの型・CRUD)は input-profile.ts の実装をそのまま使う。
 *
 * 体験は ../PC98/WebNP2/src/ui/gamepad-ui.ts の割当編集(上段一覧+下段キーボードピッカー、
 * 選ぶと次の行へ自動で進む)を踏襲する。バインディングの実体・永続化・画面への反映は持たず
 * (呼び出し側のコールバック経由)、このファイルはDOMと操作の仲介に徹する(gamepad-ui.ts と
 * 同じ分担)。
 */

import { type Binding, type PadType, joyTargetsForPadType } from './gamepad';
import {
  clearBinding,
  duplicateProfile,
  findProfile,
  renameProfile as renameProfileOf,
  deleteProfile as deleteProfileOf,
  setActiveProfile,
  setBinding,
  type InputProfile,
  type InputProfileStore,
} from './input-profile';
import { KBD_ROWS, KEYPAD_ROWS, type VirtualKeyDef } from './kbd-layout';
import { t } from './strings';

/** 編集対象の入力元1つ分(バーチャルパッドの場合は画面部品ID)。 */
export interface InputSourceDef {
  id: string;
  label: string;
}

/**
 * すべての物理キー定義(KBD_ROWS+KEYPAD_ROWS平坦化、retrok重複除去)。
 * ラベル解決の唯一の情報源(重複ハードコードしない。gamepad-ui.ts の KEYBOARD_OPTIONS と同じ方針)。
 */
const ALL_KEY_DEFS: readonly VirtualKeyDef[] = (() => {
  const seen = new Set<number>();
  const out: VirtualKeyDef[] = [];
  for (const row of [...KBD_ROWS, ...KEYPAD_ROWS]) {
    for (const def of row) {
      if (def.retrok === undefined || seen.has(def.retrok)) continue;
      seen.add(def.retrok);
      out.push(def);
    }
  }
  return out;
})();

/** retrok からキーラベルを引く。未知の値(通常発生しない)は 0x〜 表記でフォールバックする。 */
export function labelForRetrok(retrok: number): string {
  const def = ALL_KEY_DEFS.find((d) => d.retrok === retrok);
  return def ? def.label.replace('\n', ' ') : `0x${retrok.toString(16)}`;
}

/** 割当の表示テキスト。joy→ターゲット名(例 'TRG1')、key→キーラベル、未割当→「なし」。 */
export function bindingDisplayText(binding: Binding | undefined): string {
  if (!binding) return t('inputProfileUnassigned');
  if (binding.kind === 'joy') return binding.target;
  return labelForRetrok(binding.retrok);
}

/**
 * 「次の行へ進む」の行送り。currentId の次の入力元IDへ進み、最終行なら選択解除(null)。
 * currentId が null、または sourceIds に存在しない場合はそのまま返す(呼び出し側の型ガード漏れに対する保険。
 * WebNP2 の onPickerKey() と同じ「割り当てたら次の行へ自動で進む」体験)。
 */
export function nextSourceId(sourceIds: readonly string[], currentId: string | null): string | null {
  if (currentId === null) return null;
  const idx = sourceIds.indexOf(currentId);
  if (idx < 0) return currentId;
  return sourceIds[idx + 1] ?? null;
}

export interface EnsureEditableResult {
  store: InputProfileStore;
  /** 実際に割当を書き込むべきプロファイルID(複製が起きればその新規ID、そうでなければ元のprofileIdのまま)。 */
  targetId: string;
  duplicated: boolean;
}

/**
 * 組み込みプロファイル(builtin:true)を選択中に割当を変更しようとしたときの自動複製。
 * 「〜のコピー」という名前の複製を作り、複製先を有効プロファイルへ切り替える(ブロックするより
 * 親切なので、この挙動にする)。builtin でなければ何もしない。profileId が存在しない、または
 * 複製に失敗した(sourceIdが見つからない等、通常起きない)場合もそのまま返す。
 */
export function ensureEditableProfile(store: InputProfileStore, profileId: string, duplicateLabel: string): EnsureEditableResult {
  const profile = findProfile(store, profileId);
  if (!profile || !profile.builtin) return { store, targetId: profileId, duplicated: false };
  const result = duplicateProfile(store, profileId, duplicateLabel);
  if (!result) return { store, targetId: profileId, duplicated: false };
  const nextStore = setActiveProfile(result.store, result.id);
  return { store: nextStore, targetId: result.id, duplicated: true };
}

/**
 * main.ts側(ストアの実体・永続化を持つ側)から渡してもらう情報。
 * input-profile-ui.ts はロジックの二重実装をしない(gamepad-ui.ts と同じ分担)。
 */
export interface InputProfileEditorCallbacks {
  /** 現在のストアを返す(常に最新)。 */
  getStore(): InputProfileStore;
  /** ストアを永続化し、有効プロファイルなら画面へ即座に反映する。 */
  applyStore(store: InputProfileStore): void;
  /** プロファイルの表示ラベル(組み込みはstrings.ts経由の翻訳済み文言、それ以外はprofile.labelそのまま)。 */
  labelFor(profile: InputProfile): string;
  /** 割当先ポートの現在のパッド種別。TRG3..TRG8が効かない旨の注記の出し分けに使う。 */
  getPadType(): PadType;
}

export interface InputProfileEditorDialog {
  open(): void;
  /** 言語切替時、ダイアログ内の静的文言を現在の言語で貼り直す。開いていれば中身も再描画する。 */
  applyStrings(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

/**
 * 入力プロファイル編集ダイアログを構築して container へ追加する。
 * main.ts からはボタン1つ分の配線(open()呼び出しとapplyStrings()連携)だけ行えばよい
 * (gamepad-ui.ts の buildGamepadDialog と同じ流儀)。
 */
export function buildInputProfileEditor(
  container: HTMLElement,
  sources: readonly InputSourceDef[],
  callbacks: InputProfileEditorCallbacks,
  showToast: (message: string) => void,
): InputProfileEditorDialog {
  const sourceIds = sources.map((s) => s.id);

  const titleEl = el('h2', { class: 'gp-title' }, [t('inputProfileEditorTitle')]);
  const descEl = el('p', { class: 'gp-desc' }, [t('inputProfileEditorDescription')]);

  // --- 上段: プロファイル管理 ---
  const profileRow = el('div', { class: 'gp-edit-pad-row' });
  const profileSelect = el('select', { class: 'gp-edit-pad-input', id: 'ipe-profile-select' });
  const profileLabel = el('label', { for: 'ipe-profile-select' }, [t('inputProfileSelectLabel')]);
  profileRow.append(profileLabel, profileSelect);

  const dupBtn = el('button', { type: 'button', class: 'gp-preset-btn' }, [t('inputProfileDuplicateBtn')]);
  const renameBtn = el('button', { type: 'button', class: 'gp-preset-btn' }, [t('inputProfileRenameBtn')]);
  const deleteBtn = el('button', { type: 'button', class: 'gp-clear-btn' }, [t('inputProfileDeleteBtn')]);
  const profileActionsRow = el('div', { class: 'gp-preset-row' }, [dupBtn, renameBtn, deleteBtn]);
  const readonlyNoteEl = el('div', { class: 'gp-hint hidden' }, [t('inputProfileBuiltinReadonlyNote')]);

  // --- 中段: 割当の一覧 ---
  const listTitleEl = el('h3', { class: 'rom-modal-section-title' }, [t('inputProfileBindingsTitle')]);
  const bindTableEl = el('div', { class: 'gp-bind-table' });
  const clearSelectedBtn = el('button', { type: 'button', class: 'gp-clear-btn' }, [t('inputProfileClearBindingBtn')]);
  const selectedHintEl = el('div', { class: 'gp-pending-hint hidden' }, [t('inputProfileRowSelectedHint')]);

  // --- 下段: ピッカー ---
  const pickerTitleEl = el('h3', { class: 'rom-modal-section-title gp-picker-title' }, [t('inputProfilePickerTitle')]);
  const tabKeyboardBtn = el('button', { type: 'button', class: 'gp-tab active' }, [t('inputProfileTabKeyboard')]);
  const tabJoystickBtn = el('button', { type: 'button', class: 'gp-tab' }, [t('inputProfileTabJoystick')]);
  const tabsRow = el('div', { class: 'gp-tabs' }, [tabKeyboardBtn, tabJoystickBtn]);

  const keyboardPanelEl = el('div', { class: 'ipe-kbd-panel' });
  const joystickPanelEl = el('div', { class: 'ipe-joy-panel hidden' });
  const joyNoteEl = el('div', { class: 'gp-hint hidden' }, [t('inputProfileTrg3PlusNote')]);
  joystickPanelEl.append(joyNoteEl);

  const closeBtn = el('button', { type: 'button', class: 'rom-close-btn' }, [t('gamepadDialogClose')]);
  const modal = el('div', { class: 'rom-modal gp-modal', role: 'dialog', 'aria-modal': 'true' }, [
    titleEl,
    descEl,
    profileRow,
    profileActionsRow,
    readonlyNoteEl,
    listTitleEl,
    bindTableEl,
    el('div', { class: 'gp-generic-row' }, [clearSelectedBtn]),
    selectedHintEl,
    pickerTitleEl,
    tabsRow,
    keyboardPanelEl,
    joystickPanelEl,
    el('div', { class: 'rom-modal-footer' }, [closeBtn]),
  ]);
  const backdrop = el('div', { class: 'rom-modal-backdrop gp-modal-backdrop hidden' }, [modal]);
  container.append(backdrop);

  let activeTab: 'keyboard' | 'joystick' = 'keyboard';
  let selectedSourceId: string | null = null;

  function currentStore(): InputProfileStore {
    return callbacks.getStore();
  }

  function currentProfile(): InputProfile | null {
    const store = currentStore();
    return findProfile(store, store.activeId);
  }

  function duplicateLabelFor(profile: InputProfile): string {
    return t('inputProfileDuplicateLabel', { name: callbacks.labelFor(profile) });
  }

  /** builtin編集時の自動複製をまとめて処理する。複製が起きればトーストで知らせる。 */
  function withEditableProfile<T>(fn: (store: InputProfileStore, targetId: string) => T): T | undefined {
    const store = currentStore();
    const profile = currentProfile();
    if (!profile) return undefined;
    const result = ensureEditableProfile(store, profile.id, duplicateLabelFor(profile));
    if (result.duplicated) {
      showToast(t('inputProfileAutoDuplicatedToast', { name: callbacks.labelFor(profile) }));
    }
    return fn(result.store, result.targetId);
  }

  function assignBinding(binding: Binding): void {
    if (selectedSourceId === null) return;
    const targetSourceId = selectedSourceId;
    withEditableProfile((store, targetId) => {
      const next = setBinding(store, targetId, targetSourceId, binding);
      callbacks.applyStore(next);
    });
    selectedSourceId = nextSourceId(sourceIds, selectedSourceId);
    renderAll();
  }

  function clearSelectedBinding(): void {
    if (selectedSourceId === null) return;
    const targetSourceId = selectedSourceId;
    withEditableProfile((store, targetId) => {
      const next = clearBinding(store, targetId, targetSourceId);
      callbacks.applyStore(next);
    });
    renderAll();
  }

  function switchTab(tab: 'keyboard' | 'joystick'): void {
    if (activeTab === tab) return;
    activeTab = tab;
    tabKeyboardBtn.classList.toggle('active', tab === 'keyboard');
    tabJoystickBtn.classList.toggle('active', tab === 'joystick');
    keyboardPanelEl.classList.toggle('hidden', tab !== 'keyboard');
    joystickPanelEl.classList.toggle('hidden', tab !== 'joystick');
  }

  // --- キーボードピッカー(仮想キーボード本体のDOM生成は流用しない。押下でゲストへ入力させないため)。
  function buildKeyboardPicker(): void {
    keyboardPanelEl.textContent = '';
    for (const rows of [KBD_ROWS, KEYPAD_ROWS]) {
      for (const row of rows) {
        const rowEl = el('div', { class: 'virtual-keyboard-row' });
        for (const def of row) {
          const button = el('button', { type: 'button', class: 'virtual-key' }, [def.label.replace('\n', ' ')]);
          if (def.width) button.style.flexGrow = String(def.width);
          if (def.retrok === undefined) {
            button.disabled = true;
          } else {
            const retrok = def.retrok;
            button.addEventListener('click', () => assignBinding({ kind: 'key', retrok }));
          }
          rowEl.append(button);
        }
        keyboardPanelEl.append(rowEl);
      }
    }
  }
  buildKeyboardPicker();

  // --- ジョイスティックピッカー ---
  function buildJoystickPicker(): void {
    // 先頭(joyNoteEl)以外を作り直す。
    while (joystickPanelEl.lastChild && joystickPanelEl.lastChild !== joyNoteEl) {
      joystickPanelEl.removeChild(joystickPanelEl.lastChild);
    }
    const grid = el('div', { class: 'ipe-joy-grid' });
    // TRG3..TRG8 の有無に関わらず全ターゲットを常に表示する(2ボタン時に効かない旨は注記で案内)。
    for (const target of joyTargetsForPadType('cpsf-md')) {
      const btn = el('button', { type: 'button', class: 'gp-preset-btn' }, [target]);
      btn.addEventListener('click', () => assignBinding({ kind: 'joy', target }));
      grid.append(btn);
    }
    joystickPanelEl.append(grid);
  }
  buildJoystickPicker();

  function renderProfileSelect(): void {
    const store = currentStore();
    profileSelect.textContent = '';
    for (const profile of store.profiles) {
      profileSelect.append(new Option(callbacks.labelFor(profile), profile.id));
    }
    if (store.activeId !== null) profileSelect.value = store.activeId;

    const active = findProfile(store, store.activeId);
    const isBuiltin = active?.builtin === true;
    dupBtn.disabled = active === null;
    renameBtn.disabled = active === null || isBuiltin;
    deleteBtn.disabled = active === null || isBuiltin;
    readonlyNoteEl.classList.toggle('hidden', !isBuiltin);
  }

  function renderBindTable(): void {
    bindTableEl.textContent = '';
    const profile = currentProfile();
    for (const source of sources) {
      const binding = profile?.bindings[source.id];
      const isSelected = selectedSourceId === source.id;
      const row = el('div', { class: isSelected ? 'gp-bind-row selected' : 'gp-bind-row' });
      const mainArea = el('div', { class: 'gp-bind-row-main' }, [
        el('span', { class: 'gp-bind-row-label' }, [source.label]),
        el('span', { class: 'gp-bind-arrow' }, ['→']),
        el('span', { class: 'gp-bind-key' }, [bindingDisplayText(binding)]),
      ]);
      mainArea.addEventListener('click', () => {
        selectedSourceId = selectedSourceId === source.id ? null : source.id;
        renderAll();
      });
      row.append(mainArea);
      bindTableEl.append(row);
    }
    selectedHintEl.classList.toggle('hidden', selectedSourceId === null);
    clearSelectedBtn.disabled = selectedSourceId === null;
  }

  function renderJoyNote(): void {
    joyNoteEl.classList.toggle('hidden', callbacks.getPadType() !== 'default');
  }

  function renderAll(): void {
    renderProfileSelect();
    renderBindTable();
    renderJoyNote();
  }

  profileSelect.addEventListener('change', () => {
    const store = currentStore();
    const next = setActiveProfile(store, profileSelect.value || null);
    callbacks.applyStore(next);
    selectedSourceId = null;
    renderAll();
  });

  dupBtn.addEventListener('click', () => {
    const store = currentStore();
    const active = findProfile(store, store.activeId);
    if (!active) return;
    const suggested = duplicateLabelFor(active);
    const label = prompt(t('inputProfileDuplicatePrompt', { name: callbacks.labelFor(active) }), suggested);
    if (!label) return;
    const result = duplicateProfile(store, active.id, label);
    if (!result) return;
    callbacks.applyStore(setActiveProfile(result.store, result.id));
    selectedSourceId = null;
    renderAll();
  });

  renameBtn.addEventListener('click', () => {
    const store = currentStore();
    const active = findProfile(store, store.activeId);
    if (!active || active.builtin) return;
    const label = prompt(t('inputProfileRenamePrompt'), active.label);
    if (!label) return;
    callbacks.applyStore(renameProfileOf(store, active.id, label));
    renderAll();
  });

  deleteBtn.addEventListener('click', () => {
    const store = currentStore();
    const active = findProfile(store, store.activeId);
    if (!active || active.builtin) return;
    if (!confirm(t('inputProfileDeleteConfirm', { name: callbacks.labelFor(active) }))) return;
    let next = deleteProfileOf(store, active.id);
    if (next.activeId === null) next = setActiveProfile(next, next.profiles[0]?.id ?? null);
    callbacks.applyStore(next);
    selectedSourceId = null;
    renderAll();
  });

  clearSelectedBtn.addEventListener('click', () => clearSelectedBinding());
  tabKeyboardBtn.addEventListener('click', () => switchTab('keyboard'));
  tabJoystickBtn.addEventListener('click', () => switchTab('joystick'));

  function close(): void {
    backdrop.classList.add('hidden');
  }

  closeBtn.addEventListener('click', () => close());
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || backdrop.classList.contains('hidden')) return;
    close();
  });

  function open(): void {
    backdrop.classList.remove('hidden');
    selectedSourceId = null;
    activeTab = 'keyboard';
    switchTab('keyboard');
    tabKeyboardBtn.classList.add('active');
    tabJoystickBtn.classList.remove('active');
    renderAll();
  }

  return {
    open,
    applyStrings(): void {
      titleEl.textContent = t('inputProfileEditorTitle');
      descEl.textContent = t('inputProfileEditorDescription');
      profileLabel.textContent = t('inputProfileSelectLabel');
      dupBtn.textContent = t('inputProfileDuplicateBtn');
      renameBtn.textContent = t('inputProfileRenameBtn');
      deleteBtn.textContent = t('inputProfileDeleteBtn');
      readonlyNoteEl.textContent = t('inputProfileBuiltinReadonlyNote');
      listTitleEl.textContent = t('inputProfileBindingsTitle');
      clearSelectedBtn.textContent = t('inputProfileClearBindingBtn');
      selectedHintEl.textContent = t('inputProfileRowSelectedHint');
      pickerTitleEl.textContent = t('inputProfilePickerTitle');
      tabKeyboardBtn.textContent = t('inputProfileTabKeyboard');
      tabJoystickBtn.textContent = t('inputProfileTabJoystick');
      joyNoteEl.textContent = t('inputProfileTrg3PlusNote');
      closeBtn.textContent = t('gamepadDialogClose');
      if (!backdrop.classList.contains('hidden')) renderAll();
    },
  };
}
