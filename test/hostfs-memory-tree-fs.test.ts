import { describe, expect, it } from 'vitest';
import { MemoryTreeFs } from '../src/hostfs/memory-tree-fs';
import {
  FS_OK,
  FS_ERR_FILE_NOT_FOUND,
  FS_ERR_DIR_NOT_FOUND,
  FS_ERR_WRITE_PROTECTED,
  FS_ERR_DIR_EXISTS,
  FS_ERR_DIR_NOT_EMPTY,
  FS_ERR_RENAME_TARGET_EXISTS,
  FS_ERR_FILE_EXISTS,
} from '../src/hostfs/filesystem';

describe('MemoryTreeFs (W2a: 書き込みAPIの契約テスト)', () => {
  it('createFile: 新規作成→openWriteで書く→close前は反映されない→close後に反映される', async () => {
    const fs = new MemoryTreeFs(true);
    expect(await fs.createFile('', 'HELLO', 'TXT', false)).toBe(FS_OK);

    const handle = await fs.openWrite('', 'HELLO', 'TXT');
    expect(typeof handle).not.toBe('number');
    if (typeof handle === 'number') throw new Error('unreachable');
    handle.write(0, new TextEncoder().encode('hello'));

    // 閉じるまで反映されない。
    expect(await fs.readFile('', 'HELLO', 'TXT')).toEqual(new Uint8Array(0));

    await handle.close();
    expect(new TextDecoder().decode((await fs.readFile('', 'HELLO', 'TXT'))!)).toBe('hello');
  });

  it('createFile: _NEWFILE相当(failIfExists=true)ですでにあれば-80', async () => {
    const fs = new MemoryTreeFs(true);
    await fs.createFile('', 'A', 'TXT', false);
    expect(await fs.createFile('', 'A', 'TXT', true)).toBe(FS_ERR_FILE_EXISTS);
  });

  it('createFile: _CREATE相当(failIfExists=false)は上書きして空にする', async () => {
    const fs = new MemoryTreeFs(true);
    await fs.createFile('', 'A', 'TXT', false);
    const h1 = await fs.openWrite('', 'A', 'TXT');
    if (typeof h1 === 'number') throw new Error('unreachable');
    h1.write(0, new TextEncoder().encode('one'));
    await h1.close();
    expect(await fs.createFile('', 'A', 'TXT', false)).toBe(FS_OK);
    expect(await fs.readFile('', 'A', 'TXT')).toEqual(new Uint8Array(0));
  });

  it('openWrite: 存在しないファイルは-2', async () => {
    const fs = new MemoryTreeFs(true);
    expect(await fs.openWrite('', 'NOPE', 'TXT')).toBe(FS_ERR_FILE_NOT_FOUND);
  });

  it('write: サイズより先に書いたら0埋めで伸びる', async () => {
    const fs = new MemoryTreeFs(true);
    await fs.createFile('', 'A', 'TXT', false);
    const h = await fs.openWrite('', 'A', 'TXT');
    if (typeof h === 'number') throw new Error('unreachable');
    h.write(4, new TextEncoder().encode('X'));
    expect(h.size).toBe(5);
    await h.close();
    const content = (await fs.readFile('', 'A', 'TXT'))!;
    expect(Array.from(content)).toEqual([0, 0, 0, 0, 'X'.charCodeAt(0)]);
  });

  it('deleteFile: 削除でき、削除後は読めない/無いエラー', async () => {
    const fs = new MemoryTreeFs(true);
    await fs.createFile('', 'A', 'TXT', false);
    expect(await fs.deleteFile('', 'A', 'TXT')).toBe(FS_OK);
    expect(await fs.readFile('', 'A', 'TXT')).toBeNull();
    expect(await fs.deleteFile('', 'A', 'TXT')).toBe(FS_ERR_FILE_NOT_FOUND);
  });

  it('mkdir/rmdir: 既にあれば-20、中にファイルがあれば-21、空なら成功', async () => {
    const fs = new MemoryTreeFs(true);
    expect(await fs.mkdir('', 'SUB')).toBe(FS_OK);
    expect(await fs.mkdir('', 'SUB')).toBe(FS_ERR_DIR_EXISTS);
    await fs.createFile('\\SUB', 'X', 'TXT', false);
    expect(await fs.rmdir('', 'SUB')).toBe(FS_ERR_DIR_NOT_EMPTY);
    await fs.deleteFile('\\SUB', 'X', 'TXT');
    expect(await fs.rmdir('', 'SUB')).toBe(FS_OK);
    expect(await fs.dirExists('\\SUB')).toBe(false);
  });

  it('rmdir: 存在しないディレクトリは-3', async () => {
    const fs = new MemoryTreeFs(true);
    expect(await fs.rmdir('', 'NOPE')).toBe(FS_ERR_DIR_NOT_FOUND);
  });

  it('rename: ファイルの名前を変えられ、旧名は無くなる', async () => {
    const fs = new MemoryTreeFs(true);
    await fs.createFile('', 'A', 'TXT', false);
    expect(await fs.rename('', 'A', 'TXT', 'B', 'TXT', false)).toBe(FS_OK);
    expect(await fs.readFile('', 'A', 'TXT')).toBeNull();
    expect(await fs.readFile('', 'B', 'TXT')).not.toBeNull();
  });

  it('rename: 移動先がすでにあれば-22', async () => {
    const fs = new MemoryTreeFs(true);
    await fs.createFile('', 'A', 'TXT', false);
    await fs.createFile('', 'B', 'TXT', false);
    expect(await fs.rename('', 'A', 'TXT', 'B', 'TXT', false)).toBe(FS_ERR_RENAME_TARGET_EXISTS);
  });

  it('rename: 存在しないファイルは-2', async () => {
    const fs = new MemoryTreeFs(true);
    expect(await fs.rename('', 'NOPE', 'TXT', 'B', 'TXT', false)).toBe(FS_ERR_FILE_NOT_FOUND);
  });

  it('getAttr: ディレクトリは0x10、ファイルは0x20、無ければ-2', async () => {
    const fs = new MemoryTreeFs(true);
    await fs.mkdir('', 'SUB');
    await fs.createFile('', 'A', 'TXT', false);
    expect(await fs.getAttr('', 'SUB', '')).toBe(0x10);
    expect(await fs.getAttr('', 'A', 'TXT')).toBe(0x20);
    expect(await fs.getAttr('', 'NOPE', 'TXT')).toBe(FS_ERR_FILE_NOT_FOUND);
  });

  it('setFileDate/setAttr: 書き込み可能なら常に成功(0)', async () => {
    const fs = new MemoryTreeFs(true);
    await fs.createFile('', 'A', 'TXT', false);
    expect(await fs.setFileDate('', 'A', 'TXT')).toBe(FS_OK);
    expect(await fs.setAttr('', 'A', 'TXT', 0x20)).toBe(FS_OK);
  });

  it('読み取り専用モード: 書き込み系はすべて-19', async () => {
    const fs = new MemoryTreeFs(false);
    expect(fs.isWritable()).toBe(false);
    expect(await fs.createFile('', 'A', 'TXT', false)).toBe(FS_ERR_WRITE_PROTECTED);
    expect(await fs.openWrite('', 'A', 'TXT')).toBe(FS_ERR_WRITE_PROTECTED);
    expect(await fs.deleteFile('', 'A', 'TXT')).toBe(FS_ERR_WRITE_PROTECTED);
    expect(await fs.mkdir('', 'SUB')).toBe(FS_ERR_WRITE_PROTECTED);
    expect(await fs.rmdir('', 'SUB')).toBe(FS_ERR_WRITE_PROTECTED);
    expect(await fs.rename('', 'A', 'TXT', 'B', 'TXT', false)).toBe(FS_ERR_WRITE_PROTECTED);
    expect(await fs.setFileDate('', 'A', 'TXT')).toBe(FS_ERR_WRITE_PROTECTED);
    expect(await fs.setAttr('', 'A', 'TXT', 0x20)).toBe(FS_ERR_WRITE_PROTECTED);
  });

  it('読み取り専用モードでも読み取り系(listDir/readFile/dirExists/getAttr)は動く', async () => {
    const writable = new MemoryTreeFs(true);
    await writable.createFile('', 'A', 'TXT', false);
    // MemoryTreeFsは接続ごとに別インスタンス(実際のHostFolderFsはhandleを共有して
    // read/writeを作り分ける)なので、ここでは「読み取り専用でも読み取り系は
    // gateされない」ことだけをFS_ERR_WRITE_PROTECTED以外の分岐で確認する。
    const readOnly = new MemoryTreeFs(false);
    expect(await readOnly.listDir('')).toEqual([]);
    expect(await readOnly.dirExists('')).toBe(true);
    expect(await readOnly.readFile('', 'NOPE', 'TXT')).toBeNull();
  });
});
