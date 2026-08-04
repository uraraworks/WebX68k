import { describe, expect, it } from 'vitest';
import { RETROK } from '../src/keyboard';
import { KBD_ROWS, selectKanaLabel, SharedKeyInput } from '../src/virtual-keyboard';

describe('かなラベル', () => {
  const key = (label: string) => KBD_ROWS.flat().find((def) => def.label === label)!;

  it('X68000のJISかな刻印をキー位置ごとに定義する', () => {
    expect(key('Q').kana).toBe('た');
    expect(key('W').kana).toBe('て');
    expect(key('A').kana).toBe('ち');
    expect(key('S').kana).toBe('と');
    expect(key('F1').kana).toBeUndefined();
  });

  it('かなロック中のSHIFTラッチ時だけ小書きかな・記号を選ぶ', () => {
    expect(selectKanaLabel(key('3 #'), false, true)).toBe('あ');
    expect(selectKanaLabel(key('3 #'), true, false)).toBe('あ');
    expect(selectKanaLabel(key('3 #'), true, true)).toBe('ぁ');
    expect(selectKanaLabel(key('[ {'), true, true)).toBe('「');
    expect(selectKanaLabel(key('] }'), true, true)).toBe('」');
    expect(selectKanaLabel(key(', <'), true, true)).toBe('、');
    expect(selectKanaLabel(key('. >'), true, true)).toBe('。');
    expect(selectKanaLabel(key('/ ?'), true, true)).toBe('・');
    expect(selectKanaLabel(key('Q'), true, true)).toBe('た');
  });
});

describe('SharedKeyInput', () => {
  it('物理・仮想の同一キーは最後の入力元が離れた時だけ解放する', () => {
    const events: Array<[number, boolean]> = [];
    const input = new SharedKeyInput((retrok, down) => events.push([retrok, down]));

    input.press('physical:KeyA', 97);
    input.press('virtual:pointer:1', 97);
    input.release('physical:KeyA', 97);
    expect(events).toEqual([[97, true]]);

    input.release('virtual:pointer:1', 97);
    expect(events).toEqual([[97, true], [97, false]]);
  });

  it('同じ入力元のキーリピートkeydownは参照数を増やさない', () => {
    const events: Array<[number, boolean]> = [];
    const input = new SharedKeyInput((retrok, down) => events.push([retrok, down]));

    input.press('physical:ShiftLeft', 304);
    input.press('physical:ShiftLeft', 304);
    input.releaseSource('physical:ShiftLeft');

    expect(events).toEqual([[304, true], [304, false]]);
  });

  it('XFキーと通常Fキーを別RETROKとして同時押下できる', () => {
    const events: Array<[number, boolean]> = [];
    const input = new SharedKeyInput((retrok, down) => events.push([retrok, down]));
    const xf1 = KBD_ROWS.flat().find((def) => def.label === 'XF1');

    expect(xf1?.retrok).toBe(RETROK.EURO);
    expect(xf1?.retrok).not.toBe(RETROK.F1);

    input.press('virtual:pointer:1', xf1!.retrok!);
    input.press('physical:F1', RETROK.F1);
    input.releaseSource('virtual:pointer:1');
    input.releaseSource('physical:F1');

    expect(events).toEqual([
      [RETROK.EURO, true],
      [RETROK.F1, true],
      [RETROK.EURO, false],
      [RETROK.F1, false],
    ]);
  });
});
