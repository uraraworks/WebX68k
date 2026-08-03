import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractArchive } from '../src/api/archive.ts';
import {
  classifyDiskBytes,
  detectDiskContentKind,
  ensureDiskExtension,
  FD_SIZE_2DD_640,
  FD_SIZE_2DD_720,
  FD_SIZE_2HD_1232,
  FD_SIZE_2HD_1440,
} from '../src/disk-store.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** human302.xdf(生の2HD 1232KB)の先頭へ、px68kのDIM_HEADER形式に沿った256バイトヘッダを付ける。 */
function buildValidDimBytes(rawXdf: Uint8Array, type: number, trackLength: number): Uint8Array {
  const header = new Uint8Array(256);
  header[0] = type; // DIM_HEADER.type
  // trkflag[170] は実データを持つトラックのフラグ。実データ分のトラック数だけ立てる
  // (77シリンダ*2ヘッド=154トラックが2HDの標準)。それ以上を立てるとpx68k側が
  // 存在しないトラックまで読もうとしてエラーになる。
  const trackCount = rawXdf.length / trackLength;
  for (let i = 0; i < trackCount; i++) header[1 + i] = 1;
  const out = new Uint8Array(header.length + rawXdf.length);
  out.set(header, 0);
  out.set(rawXdf, header.length);
  return out;
}

describe('classifyDiskBytes (アーカイブ内エントリ専用の内容ベース判定)', () => {
  it('拡張子で判定できるならその結果を返す(挙動を変えない)', () => {
    expect(classifyDiskBytes('foo.xdf', new Uint8Array(10))).toBe('fd');
    expect(classifyDiskBytes('foo.hdf', new Uint8Array(10))).toBe('hdd');
    expect(classifyDiskBytes('foo.txt', new Uint8Array(10))).toBeNull();
  });

  it.each([FD_SIZE_2HD_1232, FD_SIZE_2HD_1440, FD_SIZE_2DD_640, FD_SIZE_2DD_720])(
    '拡張子なしでもX68000の既知フロッピーサイズ(%i バイト)なら fd と判定する',
    (size) => {
      expect(classifyDiskBytes('NODISK_EXT', new Uint8Array(size))).toBe('fd');
    },
  );

  it('オフセット0x400に"X68K"シグネチャがあれば拡張子なしでも hdd と判定する', () => {
    const bytes = new Uint8Array(0x500);
    bytes[0x400] = 0x58; // 'X'
    bytes[0x401] = 0x36; // '6'
    bytes[0x402] = 0x38; // '8'
    bytes[0x403] = 0x4b; // 'K'
    expect(classifyDiskBytes('NODISK_EXT', bytes)).toBe('hdd');
  });

  it('サイズもシグネチャも一致しなければ拡張子なしは除外される(null)', () => {
    expect(classifyDiskBytes('README', new Uint8Array(123))).toBeNull();
    expect(classifyDiskBytes('README', new Uint8Array(0x500))).toBeNull();
  });

  it('実物のLZH(bran3r_entry0.lzh)を展開しても拡張子なしエントリはfdと判定されない(除外される)', async () => {
    // このfixtureはWebNP2(PC-98エミュレータ)由来の素材で、X68000のDIM判定根拠にするのは不適切。
    // 実際に中身を調べると: DIMで使われる"DIFC HEADER"署名が無く0xAB以降は全ゼロ、
    // 先頭のtypeバイトは1(=DIM_2HS、1トラック1024*9=9216バイト)なのに
    // (生サイズ1,261,824 - 256) = 1,261,568 は9216で割り切れず px68k の disk_dim.c と
    // 整合しない(トラック数が整数にならない)。よって現行の厳密な判定では null になるのが正しい。
    const bytes = readFileSync(join(here, 'fixtures/bran3r_entry0.lzh'));
    const entries = await extractArchive('bran3r_entry0.lzh', new Uint8Array(bytes));
    expect(entries.length).toBe(1);
    const entry = entries[0];
    // 拡張子を持たない実ファイル名であることを確認しておく(回帰の目印)。
    expect(entry.name).not.toMatch(/\.[a-zA-Z0-9]+$/);
    expect(classifyDiskBytes(entry.name, entry.data)).toBeNull();
  });

  it('px68kのDIM実装と整合するDIMヘッダ(type=2HD)付きイメージはfdと判定され、拡張子補完は.dimになる', () => {
    // human302.xdf は生の2HD 1232KB(1,261,568バイト)。type=0(DIM_2HD)のSctLength=1024*8=8192で
    // 1,261,568 / 8192 = 154(整数)なので、正しい256バイトDIMヘッダを付けると有効なDIMとして扱われるはず。
    const rawXdf = readFileSync(join(here, '../public/system/human302.xdf'));
    const dimBytes = buildValidDimBytes(new Uint8Array(rawXdf), 0, 1024 * 8);
    expect(classifyDiskBytes('NODISK_EXT', dimBytes)).toBe('fd');
    expect(detectDiskContentKind('NODISK_EXT', dimBytes)).toBe('dimFd');
    expect(ensureDiskExtension('NODISK_EXT', 'fd', detectDiskContentKind('NODISK_EXT', dimBytes))).toBe(
      'NODISK_EXT.dim',
    );
  });

  it('生の既知フロッピーサイズと完全一致する場合の拡張子補完は.xdfのまま(現状維持)', () => {
    const bytes = new Uint8Array(FD_SIZE_2HD_1232);
    const contentKind = detectDiskContentKind('NODISK_EXT', bytes);
    expect(contentKind).toBe('rawFd');
    expect(ensureDiskExtension('NODISK_EXT', 'fd', contentKind)).toBe('NODISK_EXT.xdf');
  });
});
