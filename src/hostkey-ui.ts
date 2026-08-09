/**
 * ホストキー(物理キーボード再割り当て)ダイアログ。
 *
 * 目的: ジョイスティックを持っていないユーザーが、ジョイスティック専用ソフトを物理キーボードで
 * 遊べるようにする(併せてテンキー専用ソフト対策のキー→キー変換も手に入る)。バインディングの
 * 実体・永続化・実際の入力への反映は main.ts 側(input-profile.ts の InputProfileStore)が持ち、
 * このファイルは callbacks 経由で読み書きするだけ(input-profile-ui.ts / gamepad-ui.ts と同じ
 * 分担)。
 *
 * 割当の編集(プロファイルの複製/名前変更/削除、組み込み編集時の自動複製、割当一覧+ピッカー)は
 * input-profile-ui.ts の buildInputProfileEditorBody() をそのまま埋め込んで使う(バーチャルパッドの
 * 割当編集ダイアログと同じ実装。二重実装しない)。このファイル固有なのは:
 * - 有効/無効のチェックボックスと、有効化の副作用(通常の文字入力が効かなくなる)の注記
 * - 入力元一覧が「KeyboardEvent.code」で可変(ユーザーが「キーを追加」で増やす)である指定
 *   (sourcesFromBindingKeys を deriveSources として渡す、kind:'dynamic')
 */

import type { PadType } from './gamepad';
import { buildInputProfileEditorBody, sourcesFromBindingKeys, type InputProfileEditorBody } from './input-profile-ui';
import { type InputProfile, type InputProfileStore, setEnabled } from './input-profile';
import { t } from './strings';

export interface HostKeyDialogCallbacks {
  /** 現在のストアを返す(常に最新)。 */
  getStore(): InputProfileStore;
  /** ストアを永続化し、有効なら実際の入力へ即座に反映する。 */
  applyStore(store: InputProfileStore): void;
  /** プロファイルの表示ラベル(組み込みはstrings.ts経由の翻訳済み文言)。 */
  labelFor(profile: InputProfile): string;
  /** 割当先ポートの現在のパッド種別。TRG3..TRG8が効かない旨の注記の出し分けに使う(input-profile-ui.tsへ素通し)。 */
  getPadType(): PadType;
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

export function buildHostKeyDialog(
  container: HTMLElement,
  callbacks: HostKeyDialogCallbacks,
  showToast: (message: string) => void,
): HostKeyDialog {
  const titleEl = el('h2', { class: 'gp-title' }, [t('hostKeyDialogTitle')]);
  const descEl = el('p', { class: 'gp-desc' }, [t('hostKeyDialogDescription')]);

  const enableCheckbox = el('input', { type: 'checkbox', id: 'hk-enable' }) as HTMLInputElement;
  const enableLabel = el('label', { for: 'hk-enable' }, [t('hostKeyEnableLabel')]);
  const enableRow = el('div', { class: 'gp-generic-row' }, [enableCheckbox, enableLabel]);

  const noteEl = el('div', { class: 'gp-hint' }, [t('hostKeyDisableTypingNote')]);

  // 入力元(KeyboardEvent.code)は可変: 「キーを追加」で増える。プロファイル管理・割当一覧・
  // ピッカーの実体は input-profile-ui.ts 側の唯一の実装をそのまま使う。
  const body: InputProfileEditorBody = buildInputProfileEditorBody(
    { kind: 'dynamic', deriveSources: sourcesFromBindingKeys },
    {
      getStore: callbacks.getStore,
      applyStore: callbacks.applyStore,
      labelFor: callbacks.labelFor,
      getPadType: callbacks.getPadType,
    },
    showToast,
  );

  const closeBtn = el('button', { type: 'button', class: 'rom-close-btn' }, [t('gamepadDialogClose')]);
  const modal = el('div', { class: 'rom-modal gp-modal', role: 'dialog', 'aria-modal': 'true' }, [
    titleEl,
    descEl,
    enableRow,
    noteEl,
    body.root,
    el('div', { class: 'rom-modal-footer' }, [closeBtn]),
  ]);
  const backdrop = el('div', { class: 'rom-modal-backdrop gp-modal-backdrop hidden' }, [modal]);
  container.append(backdrop);

  function renderEnable(): void {
    enableCheckbox.checked = callbacks.getStore().enabled;
  }

  enableCheckbox.addEventListener('change', () => {
    callbacks.applyStore(setEnabled(callbacks.getStore(), enableCheckbox.checked));
    renderEnable();
  });

  function close(): void {
    backdrop.classList.add('hidden');
    body.cancelPending();
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
    renderEnable();
    body.reset();
  }

  return {
    open,
    applyStrings(): void {
      titleEl.textContent = t('hostKeyDialogTitle');
      descEl.textContent = t('hostKeyDialogDescription');
      enableLabel.textContent = t('hostKeyEnableLabel');
      noteEl.textContent = t('hostKeyDisableTypingNote');
      closeBtn.textContent = t('gamepadDialogClose');
      renderEnable();
      body.applyStrings();
    },
  };
}
