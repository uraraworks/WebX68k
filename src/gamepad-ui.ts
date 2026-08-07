// ジョイスティック設定ダイアログ(Phase 2: 「見える化」のみ)。
//
// 目的: ゲームパッド入力自体は Phase 1 (gamepad.ts の GamepadManager + main.ts の host.onPoll)で
// 既に配線済みだが、ユーザーが「繋がっているか」「どのボタンが何番か」「割当が効いているか」を
// 確認する手段が無かった。このダイアログはその確認だけを担当する。
// 割当の編集UI・localStorage永続化・キーボード割当は次フェーズで別途追加する(ここでは作らない)。
//
// 重要: ライブ表示は host.onPoll(retro_run 駆動)に相乗りしない。コアが動いていないと
// 呼ばれないため、起動前の確認ができなくなってしまう。ダイアログが開いている間だけ
// 独立した requestAnimationFrame ループで navigator.getGamepads() を読み、閉じたら必ず止める
// (リーク防止)。このループはコアへ入力を送らない(表示専用)。コアへ送るのは従来通り
// host.onPoll 経由の GamepadManager.poll() のみ。

import { DEFAULT_DEADZONE, TARGET_TO_RETRO_ID, type JoyTarget } from './gamepad';
import { t } from './strings';

/** X68000側(標準2ボタンパッド)として表示する対象と表示順。TRG3以降はPhase1では未使用のため出さない。 */
const DISPLAY_TARGETS: readonly JoyTarget[] = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'TRG1', 'TRG2'];

/**
 * main.ts側(割当ロジックの実体を持つ側)から渡してもらう情報。
 * gamepad-ui.ts はバインディングのロジックを持たず、表示に徹する。
 */
export interface GamepadDialogCallbacks {
  /** 接続中 Gamepad.index に対する現在のポート割当(0/1)。3台目以降など未割当ならnull。 */
  getPort(gamepadIndex: number): number | null;
  /**
   * その Gamepad の入力を、現在のプリセット(XINPUT_PRESET)で解決した RetroPad ID ビットマスクへ変換する。
   * main.ts 側の GamepadManager.poll() をそのまま使ってもらう想定(割当ロジックの二重実装を避ける)。
   */
  resolveBits(pad: Gamepad): number;
}

export interface GamepadDialog {
  open(): void;
  /** 言語切替時、ダイアログ内の静的文言を現在の言語で貼り直す。開いていればライブ表示も即再描画する。 */
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
  const liveContainerEl = el('div', { class: 'gp-live-container' });
  const closeBtn = el('button', { type: 'button', class: 'rom-close-btn' }, [t('gamepadDialogClose')]);
  const modal = el('div', { class: 'rom-modal gp-modal', role: 'dialog', 'aria-modal': 'true' }, [
    titleEl,
    descEl,
    listTitleEl,
    padListEl,
    liveContainerEl,
    el('div', { class: 'rom-modal-footer' }, [closeBtn]),
  ]);
  const backdrop = el('div', { class: 'rom-modal-backdrop gp-modal-backdrop hidden' }, [modal]);
  container.append(backdrop);

  let rafId: number | null = null;

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

  function render(): void {
    const pads = connectedPads();
    renderPadList(pads);
    renderLive(pads);
  }

  function tick(): void {
    render();
    rafId = requestAnimationFrame(tick);
  }

  function close(): void {
    backdrop.classList.add('hidden');
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
    if (e.key === 'Escape' && !backdrop.classList.contains('hidden')) close();
  });

  function open(): void {
    backdrop.classList.remove('hidden');
    render();
    if (rafId === null) rafId = requestAnimationFrame(tick);
  }

  return {
    open,
    applyStrings(): void {
      titleEl.textContent = t('gamepadDialogTitle');
      descEl.textContent = t('gamepadDialogDescription');
      listTitleEl.textContent = t('gamepadConnectedTitle');
      closeBtn.textContent = t('gamepadDialogClose');
      if (!backdrop.classList.contains('hidden')) render();
    },
  };
}
