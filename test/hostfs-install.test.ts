import { describe, expect, it } from 'vitest';
import { createFormattedFd, fatReadFile, fatWriteFile, openDiskImage } from '../src/api/fat';
import { addHostFsDeviceLine, hasHostFsDeviceLine, HOSTFS_CONFIG_LINE, installHostFsIntoVolume } from '../src/hostfs/install-hostfs';

function bytesToLatin1(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

describe('addHostFsDeviceLine', () => {
  it('CONFIG.SYSが無い(null)場合は新規に1行だけの内容を作る', () => {
    const { bytes, added } = addHostFsDeviceLine(null);
    expect(added).toBe(true);
    expect(bytesToLatin1(bytes)).toBe(`${HOSTFS_CONFIG_LINE}\r\n`);
  });

  it('0x1A(EOF)がある既存CONFIG.SYSでは、その手前に挿入しEOF以降を保つ', () => {
    const original = 'LASTDRIVE = Z:\r\nDEVICE = \\SYS\\IOCS.X\r\n\x1a\x00\x00\x00';
    const bytes = new Uint8Array(original.length);
    for (let i = 0; i < original.length; i++) bytes[i] = original.charCodeAt(i);

    const { bytes: out, added } = addHostFsDeviceLine(bytes);
    expect(added).toBe(true);
    const text = bytesToLatin1(out);
    expect(text).toContain(HOSTFS_CONFIG_LINE);
    // 挿入した行はEOF(0x1A)より手前にある。
    const eofIdx = text.indexOf('\x1a');
    const lineIdx = text.indexOf(HOSTFS_CONFIG_LINE);
    expect(lineIdx).toBeGreaterThanOrEqual(0);
    expect(lineIdx).toBeLessThan(eofIdx);
    // EOF以降のパディングはそのまま残る。
    expect(text.endsWith('\x1a\x00\x00\x00')).toBe(true);
    // 改行はCRLF。
    expect(text).toContain(`${HOSTFS_CONFIG_LINE}\r\n`);
  });

  it('0x1Aが無い既存CONFIG.SYSでは末尾にCRLF付きで足す', () => {
    const original = 'LASTDRIVE = Z:\r\nBELL      = \\BEEP.SYS\r\n';
    const bytes = new Uint8Array(original.length);
    for (let i = 0; i < original.length; i++) bytes[i] = original.charCodeAt(i);

    const { bytes: out, added } = addHostFsDeviceLine(bytes);
    expect(added).toBe(true);
    expect(bytesToLatin1(out)).toBe(original + `${HOSTFS_CONFIG_LINE}\r\n`);
  });

  it('末尾に改行が無いCONFIG.SYSでは、まず改行を補ってから足す(行が連結しない)', () => {
    const original = 'LASTDRIVE = Z:';
    const bytes = new Uint8Array(original.length);
    for (let i = 0; i < original.length; i++) bytes[i] = original.charCodeAt(i);

    const { bytes: out } = addHostFsDeviceLine(bytes);
    const text = bytesToLatin1(out);
    expect(text).toBe(`${original}\r\n${HOSTFS_CONFIG_LINE}\r\n`);
  });

  it('既にHOSTFS.SYSの行がある場合は変更せず、added=falseを返す', () => {
    const original = `LASTDRIVE = Z:\r\n${HOSTFS_CONFIG_LINE}\r\n\x1a`;
    const bytes = new Uint8Array(original.length);
    for (let i = 0; i < original.length; i++) bytes[i] = original.charCodeAt(i);

    const { bytes: out, added } = addHostFsDeviceLine(bytes);
    expect(added).toBe(false);
    expect(out).toBe(bytes); // 同一参照(書き換えなし)
  });

  it('表記ゆれ(大文字小文字)のあるHOSTFS.SYS行も重複として検出する', () => {
    expect(hasHostFsDeviceLine('device = \\hostfs.sys\r\n')).toBe(true);
    expect(hasHostFsDeviceLine('DEVICE = \\SYS\\IOCS.X\r\n')).toBe(false);
  });
});

describe('installHostFsIntoVolume', () => {
  it('CONFIG.SYSが無いFD(空フォーマット直後)には、HOSTFS.SYSとCONFIG.SYSを新規に作る', () => {
    const image = createFormattedFd();
    const vol = openDiskImage(image, 'blank.xdf');
    const hostfsBytes = new Uint8Array([1, 2, 3, 4]);

    const result = installHostFsIntoVolume(vol, hostfsBytes);
    expect(result.configLineAdded).toBe(true);

    expect(fatReadFile(vol, '\\HOSTFS.SYS')).toEqual(hostfsBytes);
    const config = bytesToLatin1(fatReadFile(vol, '\\CONFIG.SYS'));
    expect(config).toBe(`${HOSTFS_CONFIG_LINE}\r\n`);
  });

  it('既にCONFIG.SYSがあるディスクでは、DEVICE行だけ追記しHOSTFS.SYSを書く', () => {
    const image = createFormattedFd();
    const vol = openDiskImage(image, 'blank.xdf');
    // 事前にCONFIG.SYSを用意しておく(fatWriteFile経由。installと同じAPIで用意する)。
    const preset = 'LASTDRIVE = Z:\r\n';
    const presetBytes = new Uint8Array(preset.length);
    for (let i = 0; i < preset.length; i++) presetBytes[i] = preset.charCodeAt(i);
    fatWriteFile(vol, '\\CONFIG.SYS', presetBytes);

    const hostfsBytes = new Uint8Array([9, 9, 9]);
    const result = installHostFsIntoVolume(vol, hostfsBytes);
    expect(result.configLineAdded).toBe(true);

    const config = bytesToLatin1(fatReadFile(vol, '\\CONFIG.SYS'));
    expect(config).toBe(preset + `${HOSTFS_CONFIG_LINE}\r\n`);
    expect(fatReadFile(vol, '\\HOSTFS.SYS')).toEqual(hostfsBytes);
  });

  it('既にDEVICE行があるディスクへ再度実行しても、二重に追加しない', () => {
    const image = createFormattedFd();
    const vol = openDiskImage(image, 'blank.xdf');
    const hostfsBytes = new Uint8Array([5]);

    installHostFsIntoVolume(vol, hostfsBytes);
    const configAfterFirst = bytesToLatin1(fatReadFile(vol, '\\CONFIG.SYS'));

    const result = installHostFsIntoVolume(vol, hostfsBytes);
    expect(result.configLineAdded).toBe(false);
    const configAfterSecond = bytesToLatin1(fatReadFile(vol, '\\CONFIG.SYS'));
    expect(configAfterSecond).toBe(configAfterFirst);
    // HOSTFS.SYSの行は1回しか出てこない。
    const occurrences = configAfterSecond.split('HOSTFS.SYS').length - 1;
    expect(occurrences).toBe(1);
  });
});
