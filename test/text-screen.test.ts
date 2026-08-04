import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  createAnk8x16ReverseTable,
  createKanji16x16ReverseTable,
  extractTextScreen,
  extractTextScreenFromCore,
  MINIMUM_ANK_CGROM_SIZE,
  shiftJisToKanji16x16Offset,
  type TextVramCoreModule,
} from '../src/text-screen';

const TVRAM_PLANE_SIZE = 0x20000;
const CGROM_ANK8X16_OFFSET = 0x3a800;

function loadCgrom(): Uint8Array {
  return readFileSync(fileURLToPath(new URL('../public/system/cgrom.dat', import.meta.url)));
}

function writeGlyph(
  tvram: Uint8Array,
  cgrom: Uint8Array,
  code: number,
  column: number,
  row: number,
  plane: number,
): void {
  for (let glyphY = 0; glyphY < 16; glyphY++) {
    const logicalAddress = (row * 16 + glyphY) * 128 + column;
    tvram[(logicalAddress ^ 1) + plane * TVRAM_PLANE_SIZE] =
      cgrom[CGROM_ANK8X16_OFFSET + code * 16 + glyphY];
  }
}

function writeRawGlyph(
  tvram: Uint8Array,
  glyph: Uint8Array,
  column: number,
  row: number,
  plane = 0,
): void {
  for (let glyphY = 0; glyphY < 16; glyphY++) {
    const logicalAddress = (row * 16 + glyphY) * 128 + column;
    tvram[(logicalAddress ^ 1) + plane * TVRAM_PLANE_SIZE] = glyph[glyphY];
  }
}

const SYNTHETIC_A = Uint8Array.from({ length: 16 }, (_, row) => row % 2 === 0 ? 0xaa : 0x55);
const SYNTHETIC_B = Uint8Array.from({ length: 16 }, (_, row) => row % 2 === 0 ? 0xcc : 0x33);
const SYNTHETIC_KANJI = Uint8Array.from({ length: 32 }, (_, index) =>
  index % 2 === 0 ? 0xf0 ^ (index >> 1) : 0x0f ^ (index >> 1));

function createSyntheticCgrom(withKanji: boolean): Uint8Array {
  const cgrom = new Uint8Array(MINIMUM_ANK_CGROM_SIZE);
  cgrom.set(SYNTHETIC_A, CGROM_ANK8X16_OFFSET + 'A'.charCodeAt(0) * 16);
  cgrom.set(SYNTHETIC_B, CGROM_ANK8X16_OFFSET + 'B'.charCodeAt(0) * 16);
  if (withKanji) {
    const offset = shiftJisToKanji16x16Offset(0x889f); // 「亜」= JIS 16区1点
    if (offset === undefined) throw new Error('合成漢字のオフセットを計算できません');
    cgrom.set(SYNTHETIC_KANJI, offset);
  }
  return cgrom;
}

function writeSyntheticKanji(tvram: Uint8Array, column: number, row: number): void {
  const left = new Uint8Array(16);
  const right = new Uint8Array(16);
  for (let glyphY = 0; glyphY < 16; glyphY++) {
    left[glyphY] = SYNTHETIC_KANJI[glyphY * 2];
    right[glyphY] = SYNTHETIC_KANJI[glyphY * 2 + 1];
  }
  writeRawGlyph(tvram, left, column, row);
  writeRawGlyph(tvram, right, column + 1, row);
}

interface WasmCoreModule extends TextVramCoreModule {}
type CoreFactory = (options?: Record<string, unknown>) => Promise<WasmCoreModule>;

function loadCoreFactory(): CoreFactory {
  const jsPath = fileURLToPath(new URL('../public/core/px68k_libretro.js', import.meta.url));
  const source = readFileSync(jsPath, 'utf8');
  const commonJsModule: { exports: CoreFactory | { default: CoreFactory } | Record<string, never> } = {
    exports: {},
  };
  const wrapper = runInThisContext(
    `(function (module, exports, require, __filename, __dirname) { ${source}\n})`,
    { filename: jsPath },
  ) as (
    module: typeof commonJsModule,
    exports: typeof commonJsModule.exports,
    require: NodeRequire,
    filename: string,
    directory: string,
  ) => void;
  wrapper(commonJsModule, commonJsModule.exports, createRequire(jsPath), jsPath, dirname(jsPath));
  const exported = commonJsModule.exports;
  const factory = typeof exported === 'function' ? exported : exported.default;
  if (typeof factory !== 'function') throw new Error('PX68K factory を Node 上でロードできません');
  return factory;
}

describe('TVRAM テキスト抽出スパイク', () => {
  it('CGROM の ANK 8x16 グリフから逆引き表を作れる', () => {
    const reverse = createAnk8x16ReverseTable(loadCgrom());
    expect(reverse.size).toBeGreaterThanOrEqual(150);
  });

  it('Shift_JISをJIS区点経由で16x16漢字オフセットへ変換できる', () => {
    expect(shiftJisToKanji16x16Offset(0x8140)).toBe(0); // JIS 1区1点
    expect(shiftJisToKanji16x16Offset(0x889f)).toBe(8 * 94 * 32); // JIS 16区1点「亜」
    expect(shiftJisToKanji16x16Offset(0x8540)).toBeUndefined(); // 格納対象外の9区
  });

  it('合成16x16漢字を2セル消費する1文字として復元する', () => {
    const cgrom = createSyntheticCgrom(true);
    const tvram = new Uint8Array(0x80000);
    writeSyntheticKanji(tvram, 0, 0);

    const dump = extractTextScreen(tvram, cgrom, { widthPixels: 16, heightPixels: 16 });

    expect(createKanji16x16ReverseTable(cgrom).size).toBe(1);
    // 全角は2セル(16px)を占めるが、文字列には1文字として入る。
    expect(dump.lines).toEqual(['亜']);
    expect(dump.lines[0]).toHaveLength(1);
    expect(dump.diagnostics).toMatchObject({
      nonEmptyCells: 2,
      matchedCells: 2,
      unknownCells: 0,
      coverage: 1,
      kanjiFontAvailable: true,
    });
  });

  it('合成漢字とANKが混在する行をセル列どおり復元する', () => {
    const cgrom = createSyntheticCgrom(true);
    const tvram = new Uint8Array(0x80000);
    writeRawGlyph(tvram, SYNTHETIC_A, 0, 0);
    writeSyntheticKanji(tvram, 1, 0);
    writeRawGlyph(tvram, SYNTHETIC_B, 3, 0);

    const dump = extractTextScreen(tvram, cgrom, { widthPixels: 32, heightPixels: 16 });

    expect(dump.lines).toEqual(['A亜B']);
    expect(dump.lines[0][0]).toBe('A');
    expect(dump.lines[0][1]).toBe('亜');
    // 全角が2セルを占めるため、文字列インデックス2は3セル目のBになる。
    expect(dump.lines[0][2]).toBe('B');
    expect(dump.diagnostics.coverage).toBe(1);
  });

  it('全角を含む行に不可視文字を混ぜない', () => {
    // 以前は全角直後にU+200Bを置いて文字列インデックスと列位置を一致させていたが、
    // MCPで受け取る側の比較・検索・コピーで実害が出るため廃止した。再発防止。
    const cgrom = createSyntheticCgrom(true);
    const tvram = new Uint8Array(0x80000);
    writeRawGlyph(tvram, SYNTHETIC_A, 0, 0);
    writeSyntheticKanji(tvram, 1, 0);

    const dump = extractTextScreen(tvram, cgrom, { widthPixels: 24, heightPixels: 16 });

    expect(dump.lines).toEqual(['A亜']);
    for (const line of dump.lines) {
      expect(line).not.toMatch(/[\u200b-\u200f\ufeff]/u);
    }
  });

  it('漢字フォント欠落時も例外を投げずANKのみを復元する', () => {
    const cgrom = createSyntheticCgrom(false);
    const tvram = new Uint8Array(0x80000);
    writeRawGlyph(tvram, SYNTHETIC_A, 0, 0);

    const dump = extractTextScreen(tvram, cgrom, { widthPixels: 16, heightPixels: 16 });

    expect(dump.lines).toEqual(['A']);
    expect(dump.diagnostics).toMatchObject({
      matchedCells: 1,
      unknownCells: 0,
      kanjiFontAvailable: false,
    });
  });

  it('ANK 2文字の並びが漢字字形と同じ場合はANKを優先する', () => {
    const cgrom = createSyntheticCgrom(false);
    const offset = shiftJisToKanji16x16Offset(0x889f)!;
    const accidentalKanji = new Uint8Array(32);
    for (let row = 0; row < 16; row++) {
      accidentalKanji[row * 2] = SYNTHETIC_A[row];
      accidentalKanji[row * 2 + 1] = SYNTHETIC_B[row];
    }
    cgrom.set(accidentalKanji, offset);
    const tvram = new Uint8Array(0x80000);
    writeRawGlyph(tvram, SYNTHETIC_A, 0, 0);
    writeRawGlyph(tvram, SYNTHETIC_B, 1, 0);

    expect(extractTextScreen(tvram, cgrom, { widthPixels: 16, heightPixels: 16 }).lines).toEqual(['AB']);
  });

  it('4プレーンを合成し、列位置とスクロールを保って抽出できる', () => {
    const cgrom = loadCgrom();
    const tvram = new Uint8Array(0x80000);
    writeGlyph(tvram, cgrom, 'A'.charCodeAt(0), 2, 1, 0);
    writeGlyph(tvram, cgrom, '>'.charCodeAt(0), 5, 1, 2);

    const dump = extractTextScreen(tvram, cgrom, {
      widthPixels: 8 * 8,
      heightPixels: 16,
      scrollY: 16,
    });

    expect(dump.lines).toEqual(['  A  >']);
    expect(dump.diagnostics).toMatchObject({
      columns: 8,
      rows: 1,
      nonEmptyCells: 2,
      matchedCells: 2,
      unknownCells: 0,
      coverage: 1,
      nonEmptyPlaneCells: [1, 0, 1, 0],
    });
  });

  it('Node 上の wasm が公開する TVRAM を直接読める', async ({ skip }) => {
    const mod = await loadCoreFactory()({});
    if (!mod._webx68k_tvram_data) {
      skip('TVRAM export を含む wasm の再ビルド待ち');
      return;
    }

    const cgrom = loadCgrom();
    const ptr = mod._webx68k_tvram_data();
    const tvram = mod.HEAPU8.subarray(ptr, ptr + 0x80000);
    tvram.fill(0);
    writeGlyph(tvram, cgrom, 'O'.charCodeAt(0), 1, 0, 1);
    writeGlyph(tvram, cgrom, 'K'.charCodeAt(0), 2, 0, 3);

    const dump = extractTextScreenFromCore(mod, cgrom, {
      widthPixels: 8 * 4,
      heightPixels: 16,
      scrollX: 0,
      scrollY: 0,
    });
    expect(dump.lines).toEqual([' OK']);
    expect(dump.diagnostics.coverage).toBe(1);
  });
});
