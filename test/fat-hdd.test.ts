import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createFormattedHdd,
  fatFreeSpace,
  fatList,
  fatMakeDir,
  fatReadFile,
  fatWriteFile,
  openDiskImage,
} from '../src/api/fat.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('createFormattedHdd', () => {
  it('openDiskImageで開ける(Human68kパーティションテーブル + FAT16)', () => {
    const image = createFormattedHdd();
    const vol = openDiskImage(image, 'blank.hdf');
    expect(vol.fatType).toBe('FAT16');
    expect(vol.bytesPerSector).toBe(1024);
  });

  // Human68k はパーティション名 "Human68k" を探してドライブレターを割り当てる。
  // ここが別名(以前は "Human0" だった)だとゲストから一切見えず、実機で
  // 「ドライブ名が無効です」になる。自作リーダとの往復だけでは検出できないので
  // バイト列そのものを固定する。
  it('パーティションテーブルが実機と同じ "X68K" + "Human68k" になっている', () => {
    const image = createFormattedHdd();
    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...image.subarray(offset, offset + length));
    expect(ascii(0x400, 4)).toBe('X68K');
    expect(ascii(0x410, 8)).toBe('Human68k');
  });

  // Human68k は BPB の sectorsPerCluster / sectorsPerFat を鵜呑みにせず、
  // spc=1・spf=ceil((totalSectors+2)*2/bytesPerSector) 前提でルートディレクトリ位置を計算する。
  // ここがズレると「ホスト側で書いたファイルがゲストから見えない(逆も同様)」という
  // 沈黙する不整合になるので、実機フォーマット済みイメージと同じ値をバイト列で固定する。
  it('BPBが実機と同じ spc=1 / spf=81 / メディアバイト0xF8 で、ルート位置がHuman68kの計算と一致する', () => {
    const image = createFormattedHdd();
    const partitionStart = 8 * 256;
    const bytesPerSector = (image[partitionStart + 0x12] << 8) | image[partitionStart + 0x13];
    const sectorsPerCluster = image[partitionStart + 0x14];
    const numFats = image[partitionStart + 0x15];
    const reserved = (image[partitionStart + 0x16] << 8) | image[partitionStart + 0x17];
    const totalSectors = (image[partitionStart + 0x1a] << 8) | image[partitionStart + 0x1b];
    const mediaByte = image[partitionStart + 0x1c];
    const sectorsPerFat = image[partitionStart + 0x1d];

    expect(bytesPerSector).toBe(1024);
    expect(sectorsPerCluster).toBe(1);
    expect(mediaByte).toBe(0xf8);
    expect(sectorsPerFat).toBe(Math.ceil(((totalSectors + 2) * 2) / bytesPerSector));

    // Human68k がルートディレクトリを探しに行く位置と一致すること。
    const rootDirOffset = partitionStart + (reserved + numFats * sectorsPerFat) * bytesPerSector;
    expect(rootDirOffset).toBe(0x29400);
  });

  it('生成直後のルートディレクトリは空', () => {
    const image = createFormattedHdd();
    const vol = openDiskImage(image, 'blank.hdf');
    expect(fatList(vol, '')).toEqual([]);
    const { free, total } = fatFreeSpace(vol);
    expect(free).toBe(total);
    // 40MB相当のパーティションなので、FAT/ルート領域を差し引いても十分な空き容量がある。
    expect(total).toBeGreaterThan(38 * 1024 * 1024);
  });

  it('ファイル書き込み→読み出しでバイト完全一致', () => {
    const image = createFormattedHdd();
    const vol = openDiskImage(image, 'blank.hdf');
    const data = new Uint8Array(4096);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    fatWriteFile(vol, 'HELLO.TXT', data);

    const reopened = openDiskImage(image, 'blank.hdf');
    expect(fatList(reopened, '').map((e) => e.name)).toContain('HELLO.TXT');
    expect(Array.from(fatReadFile(reopened, 'HELLO.TXT'))).toEqual(Array.from(data));
  });

  it('サブディレクトリ作成とその中へのファイル書き込みができる', () => {
    const image = createFormattedHdd();
    const vol = openDiskImage(image, 'blank.hdf');
    fatMakeDir(vol, 'GAMES');
    fatWriteFile(vol, 'GAMES/README.TXT', new Uint8Array([1, 2, 3]));

    const reopened = openDiskImage(image, 'blank.hdf');
    expect(fatList(reopened, '').map((e) => e.name)).toEqual(['GAMES']);
    expect(fatList(reopened, 'GAMES').map((e) => e.name)).toContain('README.TXT');
    expect(Array.from(fatReadFile(reopened, 'GAMES/README.TXT'))).toEqual([1, 2, 3]);
  });

  it('FATが全クラスタを表現できるサイズになっている(FAT16の下限4085クラスタを超える)', () => {
    const image = createFormattedHdd();
    const vol = openDiskImage(image, 'blank.hdf');
    const fatBytesNeeded = (vol.totalClusters + 2) * 2;
    expect(vol.sectorsPerFat * vol.bytesPerSector).toBeGreaterThanOrEqual(fatBytesNeeded);
    expect(vol.totalClusters).toBeGreaterThan(4085);
  });

  // createFormattedScsi()にあった欠陥(区画サイズによらず常にFAT16のブランクを作るため
  // 小さい区画でFAT12判定と食い違う)がcreateFormattedHdd()(SASI)にも波及していないかを
  // 確認する。createFormattedHdd()は40MB固定でtotalClusters>4085(上のテストで確認済み)
  // なので常にFAT16域に収まり、型のずれが起きる余地がそもそも無い。実際にクラスタ2が
  // 空きとして読めることを直接確認しておく(SASI側は健全と判断できる)。
  it('健全性確認: 生成直後は全クラスタが空きとして読める(クラスタ2を含む)', () => {
    const image = createFormattedHdd();
    const vol = openDiskImage(image, 'blank.hdf');
    const { free, total } = fatFreeSpace(vol);
    expect(free).toBe(total);
  });

  it('健全性確認: 1クラスタに収まるファイルと2クラスタ以上必要なファイルの両方が往復一致する', () => {
    const image = createFormattedHdd();
    const vol = openDiskImage(image, 'blank.hdf');
    const bytesPerCluster = vol.bytesPerCluster;

    const small = new Uint8Array(Math.max(1, Math.floor(bytesPerCluster / 4)));
    for (let i = 0; i < small.length; i++) small[i] = i & 0xff;
    const big = new Uint8Array(bytesPerCluster * 2 + 123);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;

    fatWriteFile(vol, 'SMALL.BIN', small);
    fatWriteFile(vol, 'BIG.BIN', big);

    const reopened = openDiskImage(image, 'blank.hdf');
    expect(Array.from(fatReadFile(reopened, 'SMALL.BIN'))).toEqual(Array.from(small));
    expect(Array.from(fatReadFile(reopened, 'BIG.BIN'))).toEqual(Array.from(big));
  });
});

describe('openDiskImage: 既存FDイメージのリグレッション確認', () => {
  it('human302.xdf(2HD/1024Bセクタ)が開けてHUMAN.SYS等が列挙できる', () => {
    const path = join(__dirname, '..', 'public', 'system', 'human302.xdf');
    const buf = readFileSync(path);
    const image = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const vol = openDiskImage(image, 'human302.xdf');
    const names = fatList(vol, '').map((e) => e.name);
    expect(names).toContain('HUMAN.SYS');
  });
});
