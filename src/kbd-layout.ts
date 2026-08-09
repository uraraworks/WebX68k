// ソフトキーボード本体と、後続タスクで作るバーチャルパッドの割当ピッカーの両方から参照する
// 共通モジュールとして切り出したもの。(参考: ../PC98/WebNP2/src/ui/kbd-layout.ts)
import { RETROK } from './keyboard';

export type ModifierKind = 'oneshot' | 'lock';

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

export const KEYPAD_ROWS: VirtualKeyDef[][] = [
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
