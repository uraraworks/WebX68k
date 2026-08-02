#!/usr/bin/env node
// フリーフォント(東雲フォント/Shinonome, Public Domain)から X68000 CGROM.DAT 互換データを生成する。
//
// レイアウトは XEiJ (X68000用Javaエミュレータ) の公式ソース XEiJ.java の
// FNT_ADDRESS_* 定数群および romCreateFont() の実装から確定した仕様に基づく
// (px68k-libretro はCGROM.DATをそのままCPUアドレス0xF00000にマップするだけで、
//  内部レイアウトの解釈は行わないため、実機/XEiJ側の仕様が正となる)。
//
// 出力: public/system/cgrom.dat (786432 バイト = 0xC0000)

const fs = require('fs');
const path = require('path');
const { parseBdf, glyphToCell } = require('./bdf');
const { nearestScale } = require('./scale');
const { packCell } = require('./pack');

const FONT_DIR = path.join(__dirname, 'fonts', 'shinonome-0.9.11', 'bdf');
const OUT_PATH = path.join(__dirname, '..', '..', 'public', 'system', 'cgrom.dat');

const CGROM_SIZE = 0xc0000; // 786432

// ブロック先頭オフセット (ファイル先頭 = CPUアドレス0xF00000起点)
const ADDR_KNJ16X16 = 0x000000;
const ADDR_ANK8X8 = 0x03a000;
const ADDR_ANK8X16 = 0x03a800;
const ADDR_ANK12X12 = 0x03b800;
const ADDR_ANK12X24 = 0x03d000;
const ADDR_KNJ24X24 = 0x040000;

// 漢字ブロックの区の並び: 1区～8区(非漢字752字) → 16区～84区(第1・第2水準漢字6486字)
const KU_LIST = [];
for (let ku = 1; ku <= 8; ku++) KU_LIST.push(ku);
for (let ku = 16; ku <= 84; ku++) KU_LIST.push(ku);
const TEN_PER_KU = 94;

function loadBdf(filename) {
  const text = fs.readFileSync(path.join(FONT_DIR, filename), 'latin1');
  return parseBdf(text);
}

function jisCode(ku, ten) {
  return ((ku + 0x20) << 8) | (ten + 0x20);
}

function writeKanjiBlock(buf, baseAddr, bdf, cellW, cellH, srcW, srcH) {
  const bytesPerChar = Math.ceil(cellW / 8) * cellH;
  let idx = 0;
  for (const ku of KU_LIST) {
    for (let ten = 1; ten <= TEN_PER_KU; ten++) {
      const code = jisCode(ku, ten);
      const glyph = bdf.glyphs.get(code) || null;
      let cell = glyphToCell(glyph, bdf.fbb);
      if (srcW !== cellW || srcH !== cellH) {
        cell = nearestScale(cell, srcW, srcH, cellW, cellH);
      }
      const packed = packCell(cell, cellW, cellH);
      packed.copy(buf, baseAddr + idx * bytesPerChar);
      idx++;
    }
  }
  return idx * bytesPerChar;
}

function writeAnkBlock(buf, baseAddr, bdf, cellW, cellH, srcW, srcH) {
  const bytesPerChar = Math.ceil(cellW / 8) * cellH;
  for (let code = 0; code <= 0xff; code++) {
    const glyph = bdf.glyphs.get(code) || null;
    let cell = glyphToCell(glyph, bdf.fbb);
    if (srcW !== cellW || srcH !== cellH) {
      cell = nearestScale(cell, srcW, srcH, cellW, cellH);
    }
    const packed = packCell(cell, cellW, cellH);
    packed.copy(buf, baseAddr + code * bytesPerChar);
  }
  return 256 * bytesPerChar;
}

function main() {
  console.log('CGROM生成開始...');

  const knj16 = loadBdf('shnmk16.bdf'); // 漢字16x16 (JISX0208, ゴシック)
  const ank8x16 = loadBdf('shnm8x16r.bdf'); // ANK 8x16 (JISX0201, ゴシック regular)
  const ank6x12 = loadBdf('shnm6x12r.bdf'); // ANK 6x12 (JISX0201, ゴシック regular)

  const buf = Buffer.alloc(CGROM_SIZE, 0);

  // 1. 漢字16x16 (0xF00000起点、ソースそのまま16x16)
  const knj16Bytes = writeKanjiBlock(buf, ADDR_KNJ16X16, knj16, 16, 16, 16, 16);
  console.log(`  漢字16x16: ${knj16Bytes} バイト書き込み (先頭 0x${ADDR_KNJ16X16.toString(16)})`);

  // 2. ANK8x8 (0xF3A000起点、8x16を縦方向に最近傍縮小)
  const ank8x8Bytes = writeAnkBlock(buf, ADDR_ANK8X8, ank8x16, 8, 8, 8, 16);
  console.log(`  ANK8x8: ${ank8x8Bytes} バイト書き込み (先頭 0x${ADDR_ANK8X8.toString(16)})`);

  // 3. ANK8x16 (0xF3A800起点、ソースそのまま)
  const ank8x16Bytes = writeAnkBlock(buf, ADDR_ANK8X16, ank8x16, 8, 16, 8, 16);
  console.log(`  ANK8x16: ${ank8x16Bytes} バイト書き込み (先頭 0x${ADDR_ANK8X16.toString(16)})`);

  // 4. ANK12x12 (0xF3B800起点、6x12を横方向に最近傍2倍拡大)
  const ank12x12Bytes = writeAnkBlock(buf, ADDR_ANK12X12, ank6x12, 12, 12, 6, 12);
  console.log(`  ANK12x12: ${ank12x12Bytes} バイト書き込み (先頭 0x${ADDR_ANK12X12.toString(16)})`);

  // 5. ANK12x24 (0xF3D000起点、8x16を1.5倍最近傍拡大)
  const ank12x24Bytes = writeAnkBlock(buf, ADDR_ANK12X24, ank8x16, 12, 24, 8, 16);
  console.log(`  ANK12x24: ${ank12x24Bytes} バイト書き込み (先頭 0x${ADDR_ANK12X24.toString(16)})`);

  // 6. 漢字24x24 (0xF40000起点、16x16を1.5倍最近傍拡大)
  const knj24Bytes = writeKanjiBlock(buf, ADDR_KNJ24X24, knj16, 24, 24, 16, 16);
  console.log(`  漢字24x24: ${knj24Bytes} バイト書き込み (先頭 0x${ADDR_KNJ24X24.toString(16)})`);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, buf);
  console.log(`完了: ${OUT_PATH} (${buf.length} バイト)`);

  if (buf.length !== CGROM_SIZE) {
    console.error(`サイズ不一致! 期待値=${CGROM_SIZE} 実際=${buf.length}`);
    process.exit(1);
  }
}

main();
