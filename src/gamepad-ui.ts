// ジョイスティック設定ダイアログ(見える化 + 割当編集)。
//
// 目的: ゲームパッド入力自体は gamepad.ts の GamepadManager + main.ts の host.onPoll で配線済み。
// このダイアログは「繋がっているか」「どのボタンが何番か」「割当が効いているか」の確認に加えて、
// 割当そのものの編集(検出/コンボ選択/デッドゾーン/ポート選択/XInput標準へのリセット)を担当する。
// バインディングの実体(GamepadManager・永続化)は持たず、すべて main.ts から渡された callbacks
// 経由で読み書きする(gamepad-ui.ts はロジックの二重実装をしない)。
//
// 重要: ライブ表示・検出モードの押下判定は host.onPoll(retro_run 駆動)に相乗りしない。コアが
// 動いていないと呼ばれないため、起動前の確認・設定ができなくなってしまう。ダイアログが開いている
// 間だけ独立した requestAnimationFrame ループで navigator.getGamepads() を読み、閉じたら必ず止める
// (リーク防止)。このループはコアへ入力を送らない(表示専用)。コアへ送るのは従来通り
// host.onPoll 経由の GamepadManager.poll() のみ。
//
// 編集UIの再描画方針: ライブ表示(物理入力/X68000側入力のON/OFF)は状態がフレームごとに変わるため
// 毎フレーム再構築して問題ない。一方、編集用の <select>/<input type=range> はユーザー操作中に
// DOMノードを丸ごと差し替えるとネイティブのドロップダウン選択やドラッグ操作が中断してしまう。
// そのため編集エリア(renderEditor)は「接続中パッドの集合が変わった時」「バインディングを
// 実際に追加/削除/リセットした時」など状態が変わった契機でのみ再構築し、毎フレームは回さない。
// 検出モードの押下判定自体は毎フレーム行う必要があるため、そちらは既存のON/OFFテキストを
// その場で書き換えるだけ(DOM再構築なし)にして両立させる。

import {
  type Binding,
  DEFAULT_DEADZONE,
  detectNewlyActiveSource,
  type JoyTarget,
  type PadSnapshot,
  snapshotPad,
  type Source,
  TARGET_TO_RETRO_ID,
} from './gamepad';
import { t } from './strings';

/** X68000側(標準2ボタンパッド)として表示する対象と表示順。TRG3以降は現状未使用のため出さない。 */
const DISPLAY_TARGETS: readonly JoyTarget[] = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'TRG1', 'TRG2'];

/**
 * Gamepad API の standard mapping における物理ボタン名(RetroPad/SNES系の命名に合わせる。
 * gamepad.ts の TARGET_TO_RETRO_ID コメントにある RetroPad B/A/Y/X/L/R/L2/R2 と揃えてある)。
 * 言語非依存の技術名として扱い、TRG1/TRG2表記と同様に ja/en どちらでも同じ文字列を出す。
 */
const STANDARD_BUTTON_NAMES: readonly string[] = [
  'B', // 0: 下ボタン
  'A', // 1: 右ボタン
  'Y', // 2: 左ボタン
  'X', // 3: 上ボタン
  'L',
  'R',
  'L2',
  'R2',
  'Select',
  'Start',
  'L3',
  'R3',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
];

/**
 * 「その他の割当(キーボード)」セクションで選べる代表的なキー。実際の出力配線は次担当が行う
 * (今回はUIの型・選択肢を用意するところまで)。値は keyboard.ts の RETROK.* と同じ数値
 * (libretro RETROK_* 準拠)を直接埋め込む(このファイルは表示専用でRETROKロジックに依存しないため、
 * import はせず必要な値だけリテラルで持つ)。
 */
const KEYBOARD_OPTIONS: ReadonlyArray<{ retrok: number; label: string }> = [
  { retrok: 27, label: 'ESC' }, // RETROK.ESCAPE
  { retrok: 32, label: 'Space' }, // RETROK.SPACE
  { retrok: 13, label: 'Enter' }, // RETROK.RETURN
  { retrok: 122, label: 'Z' }, // RETROK.z
  { retrok: 120, label: 'X' }, // RETROK.x
  { retrok: 273, label: 'Up' }, // RETROK.UP
  { retrok: 274, label: 'Down' }, // RETROK.DOWN
  { retrok: 276, label: 'Left' }, // RETROK.LEFT
  { retrok: 275, label: 'Right' }, // RETROK.RIGHT
];

/**
 * main.ts側(割当ロジック・永続化の実体を持つ側)から渡してもらう情報。
 * gamepad-ui.ts はバインディングのロジック・保存を持たず、表示と編集操作の仲介に徹する。
 */
export interface GamepadDialogCallbacks {
  /** 接続中 Gamepad.index に対する現在のポート割当(0/1)。3台目以降など未割当ならnull。 */
  getPort(gamepadIndex: number): number | null;
  /**
   * その Gamepad の入力を、現在の割当で解決した RetroPad ID ビットマスクへ変換する。
   * main.ts 側の GamepadManager.bitsForPad() をそのまま使ってもらう想定(割当ロジックの二重実装を避ける)。
   */
  resolveBits(pad: Gamepad): number;
  /** 指定パッドの現在のデッドゾーン。 */
  getDeadzone(pad: Gamepad): number;
  setDeadzone(pad: Gamepad, value: number): void;
  /** 指定パッドについて、指定 JoyTarget に割り当たっている Source 一覧(チップ表示用)。 */
  getBindingsForTarget(pad: Gamepad, target: JoyTarget): Source[];
  /** 指定パッドの kind:'key' バインディング一覧(「その他の割当」セクションのチップ表示用)。 */
  getKeyBindings(pad: Gamepad): Array<{ source: Source; retrok: number }>;
  addBinding(pad: Gamepad, source: Source, binding: Binding): void;
  removeBinding(pad: Gamepad, source: Source, binding: Binding): void;
  /** そのパッドの割当を XINPUT_PRESET へ丸ごとリセットする([XInput標準に戻す])。 */
  resetToPreset(pad: Gamepad): void;
  /** ポート0/1に手動固定中の Gamepad.id(未固定はnull)。 */
  getPortSelection(): readonly [string | null, string | null];
  setPortSelection(port: 0 | 1, padId: string | null): void;
}

export interface GamepadDialog {
  open(): void;
  /** 言語切替時、ダイアログ内の静的文言を現在の言語で貼り直す。開いていればライブ表示・編集エリアも再描画する。 */
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

function targetLabel(target: JoyTarget): string {
  switch (target) {
    case 'UP':
      return t('gamepadTargetUp');
    case 'DOWN':
      return t('gamepadTargetDown');
    case 'LEFT':
      return t('gamepadTargetLeft');
    case 'RIGHT':
      return t('gamepadTargetRight');
    default:
      // TRG1/TRG2 はそのままの表記(ja/enどちらでも同じ)。
      return target;
  }
}

/** ボタン/軸の物理入力を人間可読なラベルへ。standard mapping ならRetroPad系の名前、それ以外はindex表記。 */
function sourceLabel(source: Source, pad: Gamepad): string {
  if (source.kind === 'button') {
    const named = pad.mapping === 'standard' ? STANDARD_BUTTON_NAMES[source.index] : undefined;
    return named ?? t('gamepadButtonLabel', { index: source.index });
  }
  return t('gamepadAxisLabel', { index: source.index, dir: source.dir > 0 ? '+' : '-' });
}

/** そのパッドで選択可能な物理Source一覧(コンボボックスの選択肢生成用)。 */
function sourceOptionsFor(pad: Gamepad): Array<{ source: Source; label: string }> {
  const out: Array<{ source: Source; label: string }> = [];
  const buttonCount = pad.buttons?.length ?? 0;
  for (let i = 0; i < buttonCount; i++) {
    out.push({ source: { kind: 'button', index: i }, label: sourceLabel({ kind: 'button', index: i }, pad) });
  }
  const axesCount = pad.axes?.length ?? 0;
  for (let i = 0; i < axesCount; i++) {
    out.push({ source: { kind: 'axis', index: i, dir: 1 }, label: sourceLabel({ kind: 'axis', index: i, dir: 1 }, pad) });
    out.push({
      source: { kind: 'axis', index: i, dir: -1 },
      label: sourceLabel({ kind: 'axis', index: i, dir: -1 }, pad),
    });
  }
  return out;
}

/**
 * ジョイスティック設定ダイアログを構築して container へ追加する。
 * main.ts からはボタン1つ分の配線(open()呼び出しとapplyStrings()連携)だけ行えばよい
 * (filemanager.ts の buildFileManagerDialog と同じ流儀)。
 */
export function buildGamepadDialog(container: HTMLElement, callbacks: GamepadDialogCallbacks): GamepadDialog {
  const titleEl = el('h2', { class: 'gp-title' }, [t('gamepadDialogTitle')]);
  const descEl = el('p', { class: 'gp-desc' }, [t('gamepadDialogDescription')]);
  const listTitleEl = el('h3', { class: 'rom-modal-section-title' }, [t('gamepadConnectedTitle')]);
  const padListEl = el('div', { class: 'gp-pad-list' });
  const portSelectEl = el('div', { class: 'gp-port-select' });
  const liveContainerEl = el('div', { class: 'gp-live-container' });
  const editorTitleEl = el('h3', { class: 'rom-modal-section-title' }, [t('gamepadBindingsTitle')]);
  const editorPadSelectEl = el('div', { class: 'gp-edit-pad-select' });
  const editorEl = el('div', { class: 'gp-editor' });
  const closeBtn = el('button', { type: 'button', class: 'rom-close-btn' }, [t('gamepadDialogClose')]);
  const modal = el('div', { class: 'rom-modal gp-modal', role: 'dialog', 'aria-modal': 'true' }, [
    titleEl,
    descEl,
    listTitleEl,
    padListEl,
    portSelectEl,
    liveContainerEl,
    editorTitleEl,
    editorPadSelectEl,
    editorEl,
    el('div', { class: 'rom-modal-footer' }, [closeBtn]),
  ]);
  const backdrop = el('div', { class: 'rom-modal-backdrop gp-modal-backdrop hidden' }, [modal]);
  container.append(backdrop);

  let rafId: number | null = null;
  // 編集対象パッド(ダイアログ内で選んだ Gamepad.id)。接続が切れたら次のtickで再選出する。
  let editingPadId: string | null = null;
  // 直前に編集エリアを構築したときの接続パッド構成(id列)。変化した時だけ編集エリアを再構築する
  // (ユーザーがselect/rangeを操作中にDOMを丸ごと差し替えて操作を中断させないため)。
  let lastEditorKey = '';

  type DetectState =
    | { kind: 'row'; padId: string; target: JoyTarget; baseline: PadSnapshot }
    | { kind: 'generic'; padId: string; baseline: PadSnapshot };
  let detect: DetectState | null = null;
  // detect成功後、キーボード宛か確定するまで保持する一時状態(「その他の割当」フロー用)。
  let pendingGeneric: { padId: string; source: Source } | null = null;

  // renderEditor()で作った行ごとのDOM参照。detect中の案内文をフレームごとに書き換えるためだけに使う
  // (行そのものの再構築はrenderEditor()が呼ばれた時だけ)。
  const rowStatusEls = new Map<JoyTarget, HTMLElement>();
  const rowDetectBtns = new Map<JoyTarget, HTMLButtonElement>();
  let genericStatusEl: HTMLElement | null = null;
  let genericDetectBtn: HTMLButtonElement | null = null;

  /** navigator.getGamepads() は疎な配列(切断済みindexがnullのまま残る)なので、非nullだけ拾う。 */
  function connectedPads(): Gamepad[] {
    const all = navigator.getGamepads();
    const out: Gamepad[] = [];
    for (const pad of all) {
      if (pad) out.push(pad);
    }
    return out;
  }

  function renderPadList(pads: Gamepad[]): void {
    padListEl.textContent = '';
    if (pads.length === 0) {
      padListEl.append(el('div', { class: 'gp-hint' }, [t('gamepadNoPads')]));
      return;
    }
    for (const pad of pads) {
      const port = callbacks.getPort(pad.index);
      const portLabel = port === null ? t('gamepadPortUnassigned') : t('gamepadPortAssigned', { port: port + 1 });
      padListEl.append(
        el('div', { class: 'gp-pad-row' }, [
          el('span', { class: 'gp-pad-index' }, [`#${pad.index}`]),
          el('span', { class: 'gp-pad-id' }, [pad.id]),
          el('span', { class: 'gp-pad-mapping' }, [pad.mapping || '(no mapping)']),
          el('span', { class: 'gp-pad-port' }, [portLabel]),
        ]),
      );
    }
  }

  /** ポート0/1へ手動固定するパッドを選ぶセレクト(既定は自動割当のまま)。 */
  function renderPortSelect(pads: Gamepad[]): void {
    portSelectEl.textContent = '';
    const selection = callbacks.getPortSelection();
    for (const port of [0, 1] as const) {
      const label = el('label', { class: 'gp-port-select-row' }, [t('gamepadPortDeviceLabel', { port: port + 1 })]);
      const select = el('select', { class: 'gp-port-select-input' });
      select.append(new Option(t('gamepadPortAutoOption'), ''));
      for (const pad of pads) {
        select.append(new Option(`${pad.id} (#${pad.index})`, pad.id));
      }
      select.value = selection[port] ?? '';
      select.addEventListener('change', () => {
        callbacks.setPortSelection(port, select.value === '' ? null : select.value);
        renderPadList(connectedPads());
      });
      label.append(select);
      portSelectEl.append(label);
    }
  }

  /** buttons配列の長さ・要素は環境やモックによってまちまちなので、欠けや長さ違いを前提に組み立てる。 */
  function renderButtons(pad: Gamepad): HTMLElement {
    const wrap = el('div', { class: 'gp-btns' });
    const buttons = pad.buttons ?? [];
    for (let i = 0; i < buttons.length; i++) {
      const pressed = buttons[i]?.pressed === true;
      wrap.append(el('span', { class: pressed ? 'gp-btn active' : 'gp-btn' }, [String(i)]));
    }
    return wrap;
  }

  /** axes配列も同様に長さ・値が不定な前提(異常値はデッドゾーン判定で自然に無視される)。 */
  function renderAxes(pad: Gamepad): HTMLElement {
    const wrap = el('div', { class: 'gp-axes' });
    const axes = pad.axes ?? [];
    for (let i = 0; i < axes.length; i++) {
      const raw = axes[i];
      const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
      const active = Math.abs(value) > DEFAULT_DEADZONE;
      wrap.append(el('span', { class: active ? 'gp-axis active' : 'gp-axis' }, [`A${i}: ${value.toFixed(2)}`]));
    }
    return wrap;
  }

  function renderTargets(bits: number): HTMLElement {
    const wrap = el('div', { class: 'gp-targets' });
    for (const target of DISPLAY_TARGETS) {
      const active = (bits & (1 << TARGET_TO_RETRO_ID[target])) !== 0;
      wrap.append(el('span', { class: active ? 'gp-target active' : 'gp-target' }, [targetLabel(target)]));
    }
    return wrap;
  }

  function renderLive(pads: Gamepad[]): void {
    liveContainerEl.textContent = '';
    for (const pad of pads) {
      let bits = 0;
      try {
        bits = callbacks.resolveBits(pad);
      } catch {
        // 偽パッド(テスト/ヘッドレス検証用)がbuttons/axesの形を崩していても表示だけは壊さない。
        bits = 0;
      }
      const header = el('h4', { class: 'gp-live-title' }, [`${pad.id} (#${pad.index})`]);
      const physical = el('div', { class: 'gp-live-col' }, [
        el('div', { class: 'gp-live-col-title' }, [t('gamepadPhysicalTitle')]),
        renderButtons(pad),
        renderAxes(pad),
      ]);
      const x68k = el('div', { class: 'gp-live-col' }, [
        el('div', { class: 'gp-live-col-title' }, [t('gamepadX68kTitle')]),
        renderTargets(bits),
      ]);
      liveContainerEl.append(
        el('div', { class: 'gp-live-block' }, [header, el('div', { class: 'gp-live-row' }, [physical, x68k])]),
      );
    }
  }

  /** 編集対象パッドが未接続/未選択なら、接続中パッドの先頭を自動選出する。 */
  function ensureEditingPad(pads: Gamepad[]): Gamepad | null {
    let pad = pads.find((p) => p.id === editingPadId) ?? null;
    if (!pad) {
      pad = pads[0] ?? null;
      editingPadId = pad?.id ?? null;
    }
    return pad;
  }

  function startRowDetect(pad: Gamepad, target: JoyTarget): void {
    detect = { kind: 'row', padId: pad.id, target, baseline: snapshotPad(pad) };
    renderEditor(connectedPads());
  }

  function startGenericDetect(pad: Gamepad): void {
    pendingGeneric = null;
    detect = { kind: 'generic', padId: pad.id, baseline: snapshotPad(pad) };
    renderEditor(connectedPads());
  }

  function cancelDetect(): void {
    if (detect === null) return;
    detect = null;
    renderEditor(connectedPads());
  }

  /** 割当編集エリア(パッド選択・6行のバインディング表・デッドゾーン・キーボード枠)を丸ごと再構築する。 */
  function renderEditor(pads: Gamepad[]): void {
    rowStatusEls.clear();
    rowDetectBtns.clear();
    genericStatusEl = null;
    genericDetectBtn = null;

    editorPadSelectEl.textContent = '';
    editorEl.textContent = '';

    if (pads.length === 0) {
      editorEl.append(el('div', { class: 'gp-hint' }, [t('gamepadNoPads')]));
      return;
    }
    const pad = ensureEditingPad(pads);
    if (!pad) return;

    // 編集対象パッド選択。
    const padSelectLabel = el('label', { class: 'gp-edit-pad-row' }, [t('gamepadEditingPadLabel')]);
    const padSelect = el('select', { class: 'gp-edit-pad-input' });
    for (const p of pads) padSelect.append(new Option(`${p.id} (#${p.index})`, p.id));
    padSelect.value = pad.id;
    padSelect.addEventListener('change', () => {
      editingPadId = padSelect.value;
      detect = null;
      pendingGeneric = null;
      renderEditor(connectedPads());
    });
    padSelectLabel.append(padSelect);
    editorPadSelectEl.append(padSelectLabel);

    // デッドゾーン。
    const deadzone = callbacks.getDeadzone(pad);
    const deadzoneRow = el('div', { class: 'gp-deadzone-row' });
    const deadzoneLabel = el('span', { class: 'gp-deadzone-label' }, [t('gamepadDeadzoneLabel')]);
    const deadzoneInput = el('input', {
      type: 'range',
      min: '0.1',
      max: '0.9',
      step: '0.05',
      value: String(deadzone),
      class: 'gp-deadzone-input',
    }) as HTMLInputElement;
    const deadzoneValue = el('span', { class: 'gp-deadzone-value' }, [deadzone.toFixed(2)]);
    deadzoneInput.addEventListener('input', () => {
      const value = Number(deadzoneInput.value);
      callbacks.setDeadzone(pad, value);
      deadzoneValue.textContent = value.toFixed(2);
    });
    deadzoneRow.append(deadzoneLabel, deadzoneInput, deadzoneValue);

    // XInput標準へリセット。
    const resetBtn = el('button', { type: 'button', class: 'gp-reset-btn' }, [t('gamepadResetPresetBtn')]);
    resetBtn.addEventListener('click', () => {
      callbacks.resetToPreset(pad);
      detect = null;
      renderEditor(connectedPads());
    });

    editorEl.append(deadzoneRow, resetBtn);

    // 6行のバインディング表。
    const table = el('div', { class: 'gp-bind-table' });
    for (const target of DISPLAY_TARGETS) {
      table.append(renderBindingRow(pad, target));
    }
    editorEl.append(table);

    // その他の割当(キーボード枠)。今回は選べるだけで出力配線は次担当が行う。
    editorEl.append(renderGenericSection(pad));
  }

  function renderBindingRow(pad: Gamepad, target: JoyTarget): HTMLElement {
    const sources = callbacks.getBindingsForTarget(pad, target);
    const chipsEl = el('div', { class: 'gp-chip-list' });
    for (const source of sources) {
      const removeBtn = el('button', { type: 'button', class: 'gp-chip-remove', 'aria-label': t('gamepadRemoveBindingLabel') }, ['×']);
      removeBtn.addEventListener('click', () => {
        callbacks.removeBinding(pad, source, { kind: 'joy', target });
        renderEditor(connectedPads());
      });
      chipsEl.append(el('span', { class: 'gp-chip' }, [sourceLabel(source, pad), removeBtn]));
    }
    if (sources.length === 0) {
      chipsEl.append(el('span', { class: 'gp-chip-empty' }, ['—']));
    }

    const statusEl = el('span', { class: 'gp-detect-status' });
    rowStatusEls.set(target, statusEl);

    const detectBtn = el('button', { type: 'button', class: 'gp-detect-btn' }, [t('gamepadDetectBtn')]);
    detectBtn.addEventListener('click', () => {
      if (detect !== null && detect.kind === 'row' && detect.target === target) {
        cancelDetect();
      } else {
        startRowDetect(pad, target);
      }
    });
    rowDetectBtns.set(target, detectBtn);

    const combo = el('select', { class: 'gp-source-combo' });
    combo.append(new Option(t('gamepadComboPlaceholder'), ''));
    const optgroup = document.createElement('optgroup');
    optgroup.label = t('gamepadComboJoystickGroup');
    const options = sourceOptionsFor(pad);
    options.forEach((entry, idx) => optgroup.append(new Option(entry.label, String(idx))));
    combo.append(optgroup);
    combo.addEventListener('change', () => {
      if (combo.value === '') return;
      const entry = options[Number(combo.value)];
      if (entry) callbacks.addBinding(pad, entry.source, { kind: 'joy', target });
      renderEditor(connectedPads());
    });

    return el('div', { class: 'gp-bind-row' }, [
      el('span', { class: 'gp-bind-row-label' }, [targetLabel(target)]),
      chipsEl,
      detectBtn,
      combo,
      statusEl,
    ]);
  }

  /** 「その他の割当(キーボード)」セクション。検出→宛先(ジョイスティック/キーボード)選択→追加、の2段階フロー。 */
  function renderGenericSection(pad: Gamepad): HTMLElement {
    const title = el('h4', { class: 'gp-generic-title' }, [t('gamepadComboKeyboardGroup')]);

    const chipsEl = el('div', { class: 'gp-chip-list' });
    for (const { source, retrok } of callbacks.getKeyBindings(pad)) {
      const label = KEYBOARD_OPTIONS.find((k) => k.retrok === retrok)?.label ?? `0x${retrok.toString(16)}`;
      const removeBtn = el('button', { type: 'button', class: 'gp-chip-remove', 'aria-label': t('gamepadRemoveBindingLabel') }, ['×']);
      removeBtn.addEventListener('click', () => {
        callbacks.removeBinding(pad, source, { kind: 'key', retrok });
        renderEditor(connectedPads());
      });
      chipsEl.append(el('span', { class: 'gp-chip' }, [`${sourceLabel(source, pad)} → ${label}`, removeBtn]));
    }
    if (callbacks.getKeyBindings(pad).length === 0) {
      chipsEl.append(el('span', { class: 'gp-chip-empty' }, ['—']));
    }

    const statusEl = el('span', { class: 'gp-detect-status' });
    genericStatusEl = statusEl;

    const detectBtn = el('button', { type: 'button', class: 'gp-detect-btn' }, [t('gamepadDetectBtn')]);
    detectBtn.addEventListener('click', () => {
      if (detect !== null && detect.kind === 'generic') cancelDetect();
      else startGenericDetect(pad);
    });
    genericDetectBtn = detectBtn;

    const row = el('div', { class: 'gp-generic-row' }, [chipsEl, detectBtn, statusEl]);

    if (pendingGeneric && pendingGeneric.padId === pad.id) {
      const source = pendingGeneric.source;
      const destSelect = el('select', { class: 'gp-dest-combo' });
      destSelect.append(new Option(t('gamepadComboPlaceholder'), ''));
      const joyGroup = document.createElement('optgroup');
      joyGroup.label = t('gamepadComboJoystickGroup');
      DISPLAY_TARGETS.forEach((tgt) => joyGroup.append(new Option(targetLabel(tgt), `joy:${tgt}`)));
      const keyGroup = document.createElement('optgroup');
      keyGroup.label = t('gamepadComboKeyboardGroup');
      KEYBOARD_OPTIONS.forEach((k) => keyGroup.append(new Option(k.label, `key:${k.retrok}`)));
      destSelect.append(joyGroup, keyGroup);
      destSelect.addEventListener('change', () => {
        const value = destSelect.value;
        if (value === '') return;
        if (value.startsWith('joy:')) {
          callbacks.addBinding(pad, source, { kind: 'joy', target: value.slice(4) as JoyTarget });
        } else if (value.startsWith('key:')) {
          callbacks.addBinding(pad, source, { kind: 'key', retrok: Number(value.slice(4)) });
        }
        pendingGeneric = null;
        renderEditor(connectedPads());
      });
      row.append(
        el('span', { class: 'gp-pending-source' }, [sourceLabel(source, pad)]),
        el('span', {}, ['→']),
        destSelect,
      );
    }

    return el('div', { class: 'gp-generic-section' }, [title, row]);
  }

  /** 検出モードの押下判定(毎フレーム)。DOM再構築はせず、案内テキストと他ボタンのdisabledだけその場で更新する。 */
  function tickDetect(pads: Gamepad[]): void {
    for (const [target, statusEl] of rowStatusEls) {
      const active = detect !== null && detect.kind === 'row' && detect.target === target;
      statusEl.textContent = active ? t('gamepadDetectWaiting') : '';
      const btn = rowDetectBtns.get(target);
      if (btn) btn.disabled = detect !== null && !active;
    }
    if (genericStatusEl) {
      const active = detect !== null && detect.kind === 'generic';
      genericStatusEl.textContent = active ? t('gamepadDetectWaiting') : '';
    }
    if (genericDetectBtn) genericDetectBtn.disabled = detect !== null && detect.kind !== 'generic';

    if (detect === null) return;
    const pad = pads.find((p) => p.id === detect!.padId);
    if (!pad) return; // 検出中に抜かれた場合はそのまま待機(戻ってくれば再開できる)。
    const curr = snapshotPad(pad);
    const deadzone = callbacks.getDeadzone(pad);
    const found = detectNewlyActiveSource(detect.baseline, curr, deadzone);
    if (found) {
      if (detect.kind === 'row') {
        callbacks.addBinding(pad, found, { kind: 'joy', target: detect.target });
        detect = null;
        renderEditor(pads);
      } else {
        pendingGeneric = { padId: pad.id, source: found };
        detect = null;
        renderEditor(pads);
      }
      return;
    }
    // ローリング基準: 押しっぱなしのボタンを誤検出しないため、
    // 「直前フレームで既に押されていたか」を毎フレーム更新しながら「新規の押下」だけを拾う。
    detect = { ...detect, baseline: curr };
  }

  function render(): void {
    const pads = connectedPads();
    renderPadList(pads);
    renderLive(pads);
    tickDetect(pads);
    const key = pads.map((p) => p.id).join(',');
    if (key !== lastEditorKey) {
      lastEditorKey = key;
      renderPortSelect(pads);
      renderEditor(pads);
    }
  }

  function tick(): void {
    render();
    rafId = requestAnimationFrame(tick);
  }

  function close(): void {
    backdrop.classList.add('hidden');
    detect = null;
    pendingGeneric = null;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  closeBtn.addEventListener('click', () => close());
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || backdrop.classList.contains('hidden')) return;
    if (detect !== null) {
      cancelDetect();
      return;
    }
    close();
  });

  function open(): void {
    backdrop.classList.remove('hidden');
    lastEditorKey = '__force__'; // 開くたびにパッド選択・編集表を作り直す。
    render();
    if (rafId === null) rafId = requestAnimationFrame(tick);
  }

  return {
    open,
    applyStrings(): void {
      titleEl.textContent = t('gamepadDialogTitle');
      descEl.textContent = t('gamepadDialogDescription');
      listTitleEl.textContent = t('gamepadConnectedTitle');
      editorTitleEl.textContent = t('gamepadBindingsTitle');
      closeBtn.textContent = t('gamepadDialogClose');
      if (!backdrop.classList.contains('hidden')) {
        lastEditorKey = '__force__';
        render();
      }
    },
  };
}
