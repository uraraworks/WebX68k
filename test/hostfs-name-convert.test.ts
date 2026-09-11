import { describe, expect, it } from 'vitest';
import { convertHostNameToHuman68k, convertGuestNameToHostFileName } from '../src/hostfs/name-convert';

describe('convertHostNameToHuman68k', () => {
  it('ASCIIの名前と拡張子はそのまま(小文字もそのまま)通す', () => {
    const conv = convertHostNameToHuman68k('hello.txt');
    expect(conv).not.toBeNull();
    expect(conv?.name).toBe('hello');
    expect(conv?.ext).toBe('txt');
  });

  it('拡張子の無い名前も通す', () => {
    const conv = convertHostNameToHuman68k('readme');
    expect(conv).not.toBeNull();
    expect(conv?.name).toBe('readme');
    expect(conv?.ext).toBe('');
  });

  it('日本語名はCP932(1文字2バイト)へ変換して通す', () => {
    const conv = convertHostNameToHuman68k('日本語.txt');
    expect(conv).not.toBeNull();
    expect(conv?.name.length).toBe(6); // 3文字 x 2バイト
    expect(conv?.ext).toBe('txt');
    // 「日」= CP932で 0x93 0xFA
    expect(conv?.name.charCodeAt(0)).toBe(0x93);
    expect(conv?.name.charCodeAt(1)).toBe(0xfa);
  });

  it('ドットが2つ以上ある名前は出さない', () => {
    expect(convertHostNameToHuman68k('a.b.c')).toBeNull();
  });

  it('本体が18文字を超える名前は出さない', () => {
    expect(convertHostNameToHuman68k('this_name_is_way_too_long_for_human68k.txt')).toBeNull();
  });

  it('拡張子が3文字を超える名前は出さない', () => {
    expect(convertHostNameToHuman68k('abc.longext')).toBeNull();
  });

  it('Human68kで使えない文字(制御文字・記号)を含む名前は出さない', () => {
    expect(convertHostNameToHuman68k('a*b.txt')).toBeNull();
    expect(convertHostNameToHuman68k('a<b>.txt')).toBeNull();
    expect(convertHostNameToHuman68k('a?.txt')).toBeNull();
  });

  it('CP932で表せない文字(絵文字等)を含む名前は出さない', () => {
    expect(convertHostNameToHuman68k('🎉party.txt')).toBeNull();
  });

  it('空の名前は出さない', () => {
    expect(convertHostNameToHuman68k('')).toBeNull();
  });
});

describe('convertGuestNameToHostFileName (W2a: ゲスト→ホストの逆変換)', () => {
  it('ASCIIはそのまま、大文字小文字はゲストが渡したとおりになる', () => {
    expect(convertGuestNameToHostFileName('HELLO', 'TXT')).toBe('HELLO.TXT');
    expect(convertGuestNameToHostFileName('hello', 'txt')).toBe('hello.txt');
  });

  it('拡張子が無ければドットを付けない', () => {
    expect(convertGuestNameToHostFileName('README', '')).toBe('README');
  });

  it('CP932疑似文字列(1文字=1バイト)をデコードして実際の文字へ戻す', () => {
    // convertHostNameToHuman68kが作る疑似文字列と往復できること
    // (「日」= CP932で 0x93 0xFA)。
    const conv = convertHostNameToHuman68k('日本語.txt')!;
    expect(convertGuestNameToHostFileName(conv.name, conv.ext)).toBe('日本語.txt');
  });
});
