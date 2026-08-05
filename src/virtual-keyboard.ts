import { RETROK } from './keyboard';

type ModifierKind = 'oneshot' | 'lock';

export interface VirtualKeyDef {
  label: string;
  kana?: string;
  kanaShift?: string;
  retrok?: number;
  width?: number;
  modifier?: ModifierKind;
  keypadToggle?: boolean;
}

// X68000 配列。ラベル・幅・修飾種別を同じ二次元配列に置き、DOM生成側を単純に保つ。
export const KBD_ROWS: VirtualKeyDef[][] = [
  [
    { label: 'ESC', retrok: RETROK.ESCAPE },
    { label: 'F1', retrok: RETROK.F1 }, { label: 'F2', retrok: RETROK.F2 },
    { label: 'F3', retrok: RETROK.F3 }, { label: 'F4', retrok: RETROK.F4 },
    { label: 'F5', retrok: RETROK.F5 }, { label: 'F6', retrok: RETROK.F6 },
    { label: 'F7', retrok: RETROK.F7 }, { label: 'F8', retrok: RETROK.F8 },
    { label: 'F9', retrok: RETROK.F9 }, { label: 'F10', retrok: RETROK.F10 },
    { label: 'BREAK', retrok: RETROK.BREAK, width: 1.35 },
  ],
  [
    { label: '1 !', kana: 'ぬ', retrok: RETROK[1] }, { label: '2 "', kana: 'ふ', retrok: RETROK[2] },
    { label: '3 #', kana: 'あ', kanaShift: 'ぁ', retrok: RETROK[3] },
    { label: '4 $', kana: 'う', kanaShift: 'ぅ', retrok: RETROK[4] },
    { label: '5 %', kana: 'え', kanaShift: 'ぇ', retrok: RETROK[5] },
    { label: '6 &', kana: 'お', kanaShift: 'ぉ', retrok: RETROK[6] },
    { label: "7 '", kana: 'や', kanaShift: 'ゃ', retrok: RETROK[7] },
    { label: '8 (', kana: 'ゆ', kanaShift: 'ゅ', retrok: RETROK[8] },
    { label: '9 )', kana: 'よ', kanaShift: 'ょ', retrok: RETROK[9] },
    { label: '0 _', kana: 'わ', kanaShift: 'を', retrok: RETROK[0] },
    { label: '- =', kana: 'ほ', retrok: RETROK.MINUS },
    { label: '^ ~', kana: 'へ', retrok: RETROK.EQUALS },
    { label: '¥ |', kana: 'ー', retrok: RETROK.BACKSLASH },
    { label: 'BS', retrok: RETROK.BACKSPACE, width: 1.4 },
  ],
  [
    { label: 'TAB', retrok: RETROK.TAB, width: 1.35 },
    { label: 'Q', kana: 'た', retrok: RETROK.q }, { label: 'W', kana: 'て', retrok: RETROK.w },
    { label: 'E', kana: 'い', kanaShift: 'ぃ', retrok: RETROK.e },
    { label: 'R', kana: 'す', retrok: RETROK.r }, { label: 'T', kana: 'か', retrok: RETROK.t },
    { label: 'Y', kana: 'ん', retrok: RETROK.y }, { label: 'U', kana: 'な', retrok: RETROK.u },
    { label: 'I', kana: 'に', retrok: RETROK.i }, { label: 'O', kana: 'ら', retrok: RETROK.o },
    { label: 'P', kana: 'せ', retrok: RETROK.p },
    { label: '@ `', kana: '゛', retrok: RETROK.BACKQUOTE },
    { label: '[ {', kana: '゜', kanaShift: '「', retrok: RETROK.LEFTBRACKET },
    { label: 'RETURN', retrok: RETROK.RETURN, width: 1.55 },
  ],
  [
    { label: 'CTRL', retrok: RETROK.LCTRL, width: 1.6, modifier: 'oneshot' },
    { label: 'A', kana: 'ち', retrok: RETROK.a }, { label: 'S', kana: 'と', retrok: RETROK.s },
    { label: 'D', kana: 'し', retrok: RETROK.d }, { label: 'F', kana: 'は', retrok: RETROK.f },
    { label: 'G', kana: 'き', retrok: RETROK.g }, { label: 'H', kana: 'く', retrok: RETROK.h },
    { label: 'J', kana: 'ま', retrok: RETROK.j }, { label: 'K', kana: 'の', retrok: RETROK.k },
    { label: 'L', kana: 'り', retrok: RETROK.l },
    { label: '; +', kana: 'れ', retrok: RETROK.SEMICOLON },
    { label: ': *', kana: 'け', retrok: RETROK.QUOTE },
    { label: '] }', kana: 'む', kanaShift: '」', retrok: RETROK.RIGHTBRACKET },
  ],
  [
    { label: 'SHIFT', retrok: RETROK.LSHIFT, width: 1.9, modifier: 'oneshot' },
    { label: 'Z', kana: 'つ', kanaShift: 'っ', retrok: RETROK.z },
    { label: 'X', kana: 'さ', retrok: RETROK.x }, { label: 'C', kana: 'そ', retrok: RETROK.c },
    { label: 'V', kana: 'ひ', retrok: RETROK.v }, { label: 'B', kana: 'こ', retrok: RETROK.b },
    { label: 'N', kana: 'み', retrok: RETROK.n }, { label: 'M', kana: 'も', retrok: RETROK.m },
    { label: ', <', kana: 'ね', kanaShift: '、', retrok: RETROK.COMMA },
    { label: '. >', kana: 'る', kanaShift: '。', retrok: RETROK.PERIOD },
    { label: '/ ?', kana: 'め', kanaShift: '・', retrok: RETROK.SLASH },
    { label: 'INS', retrok: RETROK.INSERT },
    { label: 'DEL', retrok: RETROK.DELETE },
  ],
  [
    { label: 'OPT.1', retrok: RETROK.LALT, modifier: 'oneshot', width: 1.25 },
    { label: 'OPT.2', retrok: RETROK.RALT, modifier: 'oneshot', width: 1.25 },
    { label: 'CAPS', retrok: RETROK.CAPSLOCK, modifier: 'lock' },
    { label: 'かな', retrok: RETROK.BROWSER_REFRESH, modifier: 'lock' },
    { label: 'ローマ字', retrok: RETROK.BROWSER_STOP, modifier: 'lock', width: 1.25 },
    { label: 'コード入力', retrok: RETROK.BROWSER_SEARCH, modifier: 'lock', width: 1.45 },
    { label: 'ひらがな', retrok: RETROK.BROWSER_FAVORITES, modifier: 'lock', width: 1.25 },
    { label: '全角', retrok: RETROK.BROWSER_HOME, modifier: 'lock' },
    { label: '記号入力', retrok: RETROK.PRINT, width: 1.3 },
    { label: '登録', retrok: RETROK.SCROLLOCK },
    { label: 'HELP', retrok: RETROK.F11 },
    { label: 'SPACE', retrok: RETROK.SPACE, width: 3.2 },
    { label: 'テンキー', keypadToggle: true, width: 1.4 },
  ],
  [
    { label: 'HOME\n(CLR)', retrok: RETROK.HOME, width: 1.35 },
    { label: 'ROLL UP', retrok: RETROK.PAGEDOWN, width: 1.25 },
    { label: 'ROLL DOWN', retrok: RETROK.PAGEUP, width: 1.4 },
    { label: 'UNDO', retrok: RETROK.END },
    { label: '←', retrok: RETROK.LEFT }, { label: '↑', retrok: RETROK.UP },
    { label: '↓', retrok: RETROK.DOWN }, { label: '→', retrok: RETROK.RIGHT },
    { label: 'COPY', retrok: RETROK.VOLUME_MUTE },
    { label: 'XF1', retrok: RETROK.EURO },
    { label: 'XF2', retrok: RETROK.UNDO },
    { label: 'XF3', retrok: RETROK.OEM_102 },
    { label: 'XF4', retrok: RETROK.BROWSER_BACK },
    { label: 'XF5', retrok: RETROK.BROWSER_FORWARD },
  ],
];

const KEYPAD_ROWS: VirtualKeyDef[][] = [
  [
    { label: 'CLR', retrok: RETROK.CLEAR }, { label: '/', retrok: RETROK.KP_DIVIDE },
    { label: '*', retrok: RETROK.KP_MULTIPLY }, { label: '-', retrok: RETROK.KP_MINUS },
  ],
  [
    { label: '7', retrok: RETROK.KP7 }, { label: '8', retrok: RETROK.KP8 },
    { label: '9', retrok: RETROK.KP9 }, { label: '+', retrok: RETROK.KP_PLUS },
  ],
  [
    { label: '4', retrok: RETROK.KP4 }, { label: '5', retrok: RETROK.KP5 },
    { label: '6', retrok: RETROK.KP6 }, { label: '=', retrok: RETROK.KP_EQUALS },
  ],
  [
    { label: '1', retrok: RETROK.KP1 }, { label: '2', retrok: RETROK.KP2 },
    { label: '3', retrok: RETROK.KP3 }, { label: 'ENTER', retrok: RETROK.KP_ENTER, width: 1.2 },
  ],
  [
    { label: '0', retrok: RETROK.KP0, width: 2 }, { label: '.', retrok: RETROK.KP_PERIOD },
  ],
];

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
  repeatDelay?: number;
  repeatInterval?: number;
  repressTimer?: number;
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
): VirtualKeyboard {
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

  const stopTimers = (state: PointerState): void => {
    if (state.repeatDelay !== undefined) window.clearTimeout(state.repeatDelay);
    if (state.repeatInterval !== undefined) window.clearInterval(state.repeatInterval);
    if (state.repressTimer !== undefined) window.clearTimeout(state.repressTimer);
  };

  const finishPointer = (pointerId: number, keepModifierToggle: boolean): void => {
    const state = pointers.get(pointerId);
    if (!state) return;
    pointers.delete(pointerId);
    stopTimers(state);
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

  const startRepeat = (state: PointerState): void => {
    if (state.def.retrok === undefined) return;
    state.repeatDelay = window.setTimeout(() => {
      const repeat = (): void => {
        input.release(state.source, state.def.retrok!);
        state.repressTimer = window.setTimeout(() => {
          if (pointers.has(Number(state.source.split(':').pop()))) input.press(state.source, state.def.retrok!);
        }, 20);
      };
      repeat();
      state.repeatInterval = window.setInterval(repeat, 50);
    }, 500);
  };

  const bindButton = (button: HTMLButtonElement, def: VirtualKeyDef): void => {
    if (def.width) button.style.flexGrow = String(def.width);
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      if (pointers.has(event.pointerId)) return;
      button.setPointerCapture(event.pointerId);
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
        startRepeat(state);
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
