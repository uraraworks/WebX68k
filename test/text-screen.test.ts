import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  createAnk8x16ReverseTable,
  extractTextScreen,
  extractTextScreenFromCore,
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
