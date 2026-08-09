/**
 * ホストキー(物理キーボード再割り当て)ダイアログ。
 *
 * 目的: ジョイスティックを持っていないユーザーが、ジョイスティック専用ソフトを物理キーボードで
 * 遊べるようにする(併せてテンキー専用ソフト対策のキー→キー変換も手に入る)。バインディングの
 * 実体・永続化・実際の入力への反映は main.ts 側(input-profile.ts の InputProfileStore)が持ち、
 * このファイルは callbacks 経由で読み書きするだけ(input-profile-ui.ts / gamepad-ui.ts と同じ
 * 分担)。
 *
 * 今回は「有効化 + 組み込みプロファイル選択 + 割当内容の読み取り専用表示」のみを提供する。
 * 自分で割り当てを作る編集機能は入れない(別タスク)。見た目は既存の gp-modal/rom-modal を
 * そのまま使う。
 */

import type { Binding } from './gamepad';
import { activeProfile, type InputProfile, type InputProfileStore, setActiveProfile, setEnabled } from './input-profile';
import { labelForRetrok } from './input-profile-ui';
import { t } from './strings';

export interface HostKeyDialogCallbacks {
  /** 現在のストアを返す(常に最新)。 */
  getStore(): InputProfileStore;
  /** ストアを永続化し、有効なら実際の入力へ即座に反映する。 */
  applyStore(store: InputProfileStore): void;
  /** プロファイルの表示ラベル(組み込みはstrings.ts経由の翻訳済み文言)。 */
  labelFor(profile: InputProfile): string;
}

export interface HostKeyDialog {
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

/** 割当の表示テキスト。joy→ターゲット名(例 'TRG1')、key→キーラベル。 */
function bindingDisplayText(binding: Binding): string {
  if (binding.kind === 'joy') return binding.target;
  return labelForRetrok(binding.retrok);
}

export function buildHostKeyDialog(container: HTMLElement, callbacks: HostKeyDialogCallbacks): HostKeyDialog {
  const titleEl = el('h2', { class: 'gp-title' }, [t('hostKeyDialogTitle')]);
  const descEl = el('p', { class: 'gp-desc' }, [t('hostKeyDialogDescription')]);

  const enableCheckbox = el('input', { type: 'checkbox', id: 'hk-enable' }) as HTMLInputElement;
  const enableLabel = el('label', { for: 'hk-enable' }, [t('hostKeyEnableLabel')]);
  const enableRow = el('div', { class: 'gp-generic-row' }, [enableCheckbox, enableLabel]);

  const profileSelect = el('select', { class: 'gp-edit-pad-input', id: 'hk-profile-select' });
  const profileLabel = el('label', { for: 'hk-profile-select' }, [t('hostKeyProfileSelectLabel')]);
  const profileRow = el('div', { class: 'gp-edit-pad-row' }, [profileLabel, profileSelect]);

  const bindingsTitleEl = el('h3', { class: 'rom-modal-section-title' }, [t('hostKeyBindingsTitle')]);
  const bindTableEl = el('div', { class: 'gp-bind-table' });

  const noteEl = el('div', { class: 'gp-hint' }, [t('hostKeyDisableTypingNote')]);

  const closeBtn = el('button', { type: 'button', class: 'rom-close-btn' }, [t('gamepadDialogClose')]);
  const modal = el('div', { class: 'rom-modal gp-modal', role: 'dialog', 'aria-modal': 'true' }, [
    titleEl,
    descEl,
    enableRow,
    profileRow,
    bindingsTitleEl,
    bindTableEl,
    noteEl,
    el('div', { class: 'rom-modal-footer' }, [closeBtn]),
  ]);
  const backdrop = el('div', { class: 'rom-modal-backdrop gp-modal-backdrop hidden' }, [modal]);
  container.append(backdrop);

  function currentStore(): InputProfileStore {
    return callbacks.getStore();
  }

  function renderEnable(): void {
    enableCheckbox.checked = currentStore().enabled;
  }

  function renderProfileSelect(): void {
    const store = currentStore();
    profileSelect.textContent = '';
    for (const profile of store.profiles) {
      profileSelect.append(new Option(callbacks.labelFor(profile), profile.id));
    }
    if (store.activeId !== null) profileSelect.value = store.activeId;
  }

  function renderBindTable(): void {
    bindTableEl.textContent = '';
    const store = currentStore();
    const profile = activeProfile(store);
    for (const [code, binding] of Object.entries(profile?.bindings ?? {})) {
      const row = el('div', { class: 'gp-bind-row' }, [
        el('div', { class: 'gp-bind-row-main' }, [
          el('span', { class: 'gp-bind-row-label' }, [code]),
          el('span', { class: 'gp-bind-arrow' }, ['→']),
          el('span', { class: 'gp-bind-key' }, [bindingDisplayText(binding)]),
        ]),
      ]);
      bindTableEl.append(row);
    }
  }

  function renderAll(): void {
    renderEnable();
    renderProfileSelect();
    renderBindTable();
  }

  enableCheckbox.addEventListener('change', () => {
    callbacks.applyStore(setEnabled(currentStore(), enableCheckbox.checked));
    renderAll();
  });

  profileSelect.addEventListener('change', () => {
    callbacks.applyStore(setActiveProfile(currentStore(), profileSelect.value || null));
    renderAll();
  });

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
    renderAll();
  }

  return {
    open,
    applyStrings(): void {
      titleEl.textContent = t('hostKeyDialogTitle');
      descEl.textContent = t('hostKeyDialogDescription');
      enableLabel.textContent = t('hostKeyEnableLabel');
      profileLabel.textContent = t('hostKeyProfileSelectLabel');
      bindingsTitleEl.textContent = t('hostKeyBindingsTitle');
      noteEl.textContent = t('hostKeyDisableTypingNote');
      closeBtn.textContent = t('gamepadDialogClose');
      if (!backdrop.classList.contains('hidden')) renderAll();
    },
  };
}
