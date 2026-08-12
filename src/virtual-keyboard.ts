import { RETROK } from './keyboard';
import type { VirtualKeyDef } from './kbd-layout';
import { KBD_ROWS, KEYPAD_ROWS } from './kbd-layout';
import { isRepeatableKey, KeyRepeater, type SendKeyMake } from './key-repeat';

export type { VirtualKeyDef } from './kbd-layout';
export { KBD_ROWS, KEYPAD_ROWS } from './kbd-layout';

/** 複数入力元が同じRETROKを押した場合、最後の入力元が離すまでコアへbreakを送らない。 */
export class SharedKeyInput {
  private readonly sources = new Map<string, Set<number>>();
  private readonly counts = new Map<number, number>();

  constructor(private readonly output: (retrok: number, down: boolean) => void) {}

  press(source: string, retrok: number): void {
    let keys = this.sources.get(source);
    if (!keys) {
      keys = new Set<number>();
      this.sources.set(source, keys);
    }
    if (keys.has(retrok)) return;
    keys.add(retrok);
    const count = this.counts.get(retrok) ?? 0;
    this.counts.set(retrok, count + 1);
    if (count === 0) this.output(retrok, true);
  }

  release(source: string, retrok: number): void {
    const keys = this.sources.get(source);
    if (!keys?.delete(retrok)) return;
    const count = this.counts.get(retrok) ?? 0;
    if (count <= 1) {
      this.counts.delete(retrok);
      this.output(retrok, false);
    } else {
      this.counts.set(retrok, count - 1);
    }
    if (keys.size === 0) this.sources.delete(source);
  }

  releaseSource(source: string): void {
    for (const retrok of [...(this.sources.get(source) ?? [])]) this.release(source, retrok);
  }

  releaseAll(): void {
    for (const source of [...this.sources.keys()]) this.releaseSource(source);
  }
}

interface PointerState {
  button: HTMLButtonElement;
  def: VirtualKeyDef;
  source: string;
  modifierWasActive?: boolean;
}

export interface VirtualKeyboard {
  toggle(): void;
  setVisible(visible: boolean): void;
  isVisible(): boolean;
  releaseAll(): void;
  refreshLayout(): void;
  togglePhysicalKanaLock(): void;
}

/** かなロック中のSHIFTラッチだけで副刻印へ切り替える。 */
export function selectKanaLabel(def: VirtualKeyDef, kanaLocked: boolean, shiftLatched: boolean): string | undefined {
  return kanaLocked && shiftLatched ? (def.kanaShift ?? def.kana) : def.kana;
}

export function createVirtualKeyboard(
  panel: HTMLElement,
  input: SharedKeyInput,
  onVisibilityChanged?: (visible: boolean) => void,
  keyRepeater?: KeyRepeater,
  sendKeyMake: SendKeyMake = () => {},
): VirtualKeyboard {
  // 呼び出し元(main.ts)が物理キーボードと同じインスタンスを渡してこない場合も、
  // 押下状態には触れず、渡されたmake注入コールバックだけを繰り返す。
  const repeater = keyRepeater ?? new KeyRepeater(sendKeyMake);
  const main = document.createElement('div');
  main.className = 'virtual-keyboard-main';
  const keypad = document.createElement('div');
  keypad.className = 'virtual-keypad hidden';
  keypad.setAttribute('aria-label', 'テンキー');
  panel.append(main, keypad);

  const pointers = new Map<number, PointerState>();
  const oneshot = new Map<number, HTMLButtonElement>();
  const locks = new Map<number, HTMLButtonElement>();
  const kanaButtons = new Map<HTMLButtonElement, VirtualKeyDef>();
  let pulseSerial = 0;

  const updateKanaDisplay = (): void => {
    const kanaLocked = locks.has(RETROK.BROWSER_REFRESH);
    const shiftLatched = oneshot.has(RETROK.LSHIFT) || oneshot.has(RETROK.RSHIFT);
    panel.classList.toggle('kana-locked', kanaLocked);
    panel.classList.toggle('kana-shifted', kanaLocked && shiftLatched);
    for (const [button, def] of kanaButtons) {
      const kana = button.querySelector<HTMLElement>('.virtual-key-kana');
      if (kana) kana.textContent = selectKanaLabel(def, kanaLocked, shiftLatched) ?? '';
    }
  };

  const setButtonActive = (def: VirtualKeyDef, button: HTMLButtonElement, active: boolean): void => {
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (def.retrok === undefined) return;
    const map = def.modifier === 'oneshot' ? oneshot : locks;
    if (active) map.set(def.retrok, button);
    else map.delete(def.retrok);
    updateKanaDisplay();
  };

  const pulseLock = (def: VirtualKeyDef): void => {
    if (def.retrok === undefined) return;
    const serial = pulseSerial++;
    const source = `vk:lock-pulse:${def.retrok}:${serial}`;
    input.press(source, def.retrok);
    window.setTimeout(() => input.release(source, def.retrok!), 50);
  };

  const clearOneshots = (): void => {
    for (const [retrok, button] of oneshot) {
      button.classList.remove('active');
      button.setAttribute('aria-pressed', 'false');
      input.releaseSource(`vk:oneshot:${retrok}`);
    }
    oneshot.clear();
    updateKanaDisplay();
  };

  const finishPointer = (pointerId: number, keepModifierToggle: boolean): void => {
    const state = pointers.get(pointerId);
    if (!state) return;
    pointers.delete(pointerId);
    repeater.stop(state.source);
    state.button.classList.remove('pressed');
    if (state.button.hasPointerCapture(pointerId)) state.button.releasePointerCapture(pointerId);

    if (state.def.modifier) {
      if (!keepModifierToggle) {
        const active = state.button.classList.contains('active');
        if (active !== state.modifierWasActive) toggleModifier(state.def, state.button);
      }
      return;
    }
    if (state.def.keypadToggle) return;
    if (state.def.retrok !== undefined) input.release(state.source, state.def.retrok);
    clearOneshots();
  };

  const toggleModifier = (def: VirtualKeyDef, button: HTMLButtonElement): void => {
    if (def.retrok === undefined || !def.modifier) return;
    const map = def.modifier === 'oneshot' ? oneshot : locks;
    const active = map.has(def.retrok);
    setButtonActive(def, button, !active);
    if (def.modifier === 'lock') {
      // 状態キーはmake/breakの短いパルスでゲストを切り替え、UI上のロック状態だけを維持する。
      pulseLock(def);
    } else if (active) {
      input.releaseSource(`vk:oneshot:${def.retrok}`);
    } else {
      input.press(`vk:oneshot:${def.retrok}`, def.retrok);
    }
  };

  const bindButton = (button: HTMLButtonElement, def: VirtualKeyDef): void => {
    if (def.width) button.style.flexGrow = String(def.width);
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      if (pointers.has(event.pointerId)) return;
      // キャプチャの取得は「失敗しても入力自体は成立させる」扱いにする(virtual-pad.ts の
      // handlePointerDown と同じ理由)。setPointerCapture() は指定 pointerId がアクティブでない
      // 場合に NotFoundError を投げる仕様で、未捕捉のままだと押下処理(pointers への登録・
      // input.press)が丸ごと飛ぶ。キャプチャは追従を良くするための最適化にすぎないので、
      // 失敗は握りつぶして押下処理を続行する。
      try {
        button.setPointerCapture(event.pointerId);
      } catch {
        /* キャプチャできなくても押下自体は成立させる(上のコメント参照)。 */
      }
      button.classList.add('pressed');
      const source = `vk:pointer:${event.pointerId}`;
      const state: PointerState = { button, def, source };
      pointers.set(event.pointerId, state);

      if (def.keypadToggle) {
        keypad.classList.toggle('hidden');
        button.classList.toggle('active', !keypad.classList.contains('hidden'));
        button.setAttribute('aria-pressed', keypad.classList.contains('hidden') ? 'false' : 'true');
        refreshLayout();
      } else if (def.modifier) {
        state.modifierWasActive = button.classList.contains('active');
        toggleModifier(def, button);
      } else if (def.retrok !== undefined) {
        input.press(source, def.retrok);
        if (isRepeatableKey(def.retrok)) repeater.start(source, def.retrok);
      }
    });
    button.addEventListener('pointerup', (event) => finishPointer(event.pointerId, true));
    button.addEventListener('pointercancel', (event) => finishPointer(event.pointerId, false));
    button.addEventListener('pointerleave', (event) => finishPointer(event.pointerId, false));
  };

  const buildRows = (parent: HTMLElement, rows: VirtualKeyDef[][]): void => {
    for (const row of rows) {
      const rowEl = document.createElement('div');
      rowEl.className = 'virtual-keyboard-row';
      for (const def of row) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'virtual-key';
        const primary = document.createElement('span');
        primary.className = 'virtual-key-primary';
        primary.textContent = def.label;
        button.append(primary);
        if (def.kana) {
          button.classList.add('has-kana');
          const kana = document.createElement('span');
          kana.className = 'virtual-key-kana';
          kana.textContent = def.kana;
          button.append(kana);
          kanaButtons.set(button, def);
        }
        button.setAttribute('aria-label', def.label.replace('\n', ' '));
        if (def.modifier || def.keypadToggle) button.setAttribute('aria-pressed', 'false');
        bindButton(button, def);
        rowEl.append(button);
      }
      parent.append(rowEl);
    }
  };

  buildRows(main, KBD_ROWS);
  buildRows(keypad, KEYPAD_ROWS);
  updateKanaDisplay();

  function refreshLayout(): void {
    // パネルの実測高が必要な側(main.ts の rescale())は onVisibilityChanged 経由で自分で
    // getBoundingClientRect() を呼んで実測するため、ここでは rAF でレイアウト確定を
    // 待ってから通知するだけでよい(以前はここで CSS 変数 --virtual-keyboard-height に
    // 高さを書き出していたが、リスケールが CSS の max-height 頼みではなくなったため撤去)。
    window.requestAnimationFrame(() => {
      onVisibilityChanged?.(!panel.classList.contains('hidden'));
    });
  }

  const releaseAll = (): void => {
    repeater.stopAll();
    for (const pointerId of [...pointers.keys()]) finishPointer(pointerId, false);
    clearOneshots();
    // 状態キーはゲスト側を既にトグル済みで、RETROK自体は保持していない。
    // blur後も表示上のロックを残し、ゲストの入力モードとの対応を保つ。
    input.releaseAll();
  };

  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAll();
  });
  window.addEventListener('resize', refreshLayout);

  return {
    toggle: () => {
      panel.classList.toggle('hidden');
      refreshLayout();
    },
    setVisible: (visible) => {
      panel.classList.toggle('hidden', !visible);
      refreshLayout();
    },
    isVisible: () => !panel.classList.contains('hidden'),
    releaseAll,
    refreshLayout,
    togglePhysicalKanaLock: () => {
      const button = locks.get(RETROK.BROWSER_REFRESH)
        ?? [...main.querySelectorAll<HTMLButtonElement>('.virtual-key')]
          .find((candidate) => candidate.getAttribute('aria-label') === 'かな');
      const def = KBD_ROWS.flat().find((candidate) => candidate.retrok === RETROK.BROWSER_REFRESH);
      if (button && def) setButtonActive(def, button, !locks.has(RETROK.BROWSER_REFRESH));
    },
  };
}
