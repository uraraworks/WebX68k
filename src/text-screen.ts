const TVRAM_PLANE_SIZE = 0x20000;
const TVRAM_SIZE = TVRAM_PLANE_SIZE * 4;
const TVRAM_WIDTH = 1024;
const TVRAM_HEIGHT = 1024;
const TVRAM_BYTES_PER_LINE = TVRAM_WIDTH / 8;
const ANK_8X16_OFFSET = 0x3a800;
const ANK_8X16_GLYPH_BYTES = 16;
const ANK_GLYPH_COUNT = 256;
export const MINIMUM_ANK_CGROM_SIZE = ANK_8X16_OFFSET + ANK_GLYPH_COUNT * ANK_8X16_GLYPH_BYTES;

export interface TextScreenDiagnostics {
  columns: number;
  rows: number;
  nonEmptyCells: number;
  matchedCells: number;
  unknownCells: number;
  coverage: number;
  nonEmptyPlaneCells: [number, number, number, number];
}

export interface TextScreenDump {
  available: boolean;
  unavailableReason?: string;
  lines: string[];
  diagnostics: TextScreenDiagnostics;
}

export interface TextScreenOptions {
  widthPixels: number;
  heightPixels: number;
  scrollX?: number;
  scrollY?: number;
}

export interface TextVramCoreModule {
  HEAPU8: Uint8Array;
  _webx68k_tvram_data?: () => number;
  _webx68k_text_dot_x?: () => number;
  _webx68k_text_dot_y?: () => number;
  _webx68k_text_scroll_x?: () => number;
  _webx68k_text_scroll_y?: () => number;
}

function glyphKey(rows: Uint8Array): string {
  let key = '';
  for (const row of rows) key += row.toString(16).padStart(2, '0');
  return key;
}

function isSupportedAnk(code: number): boolean {
  return (code >= 0x21 && code <= 0x7e) || (code >= 0xa1 && code <= 0xdf);
}

function decodeAnk(code: number): string {
  if (code <= 0x7e) return String.fromCharCode(code);
  return new TextDecoder('shift_jis').decode(Uint8Array.of(code));
}

/** CGROM.DAT の ANK 8x16 ブロックから、完全一致用の逆引き表を作る。 */
export function createAnk8x16ReverseTable(cgrom: Uint8Array): Map<string, string> {
  if (cgrom.byteLength < MINIMUM_ANK_CGROM_SIZE) {
    throw new Error(`CGROM が短すぎます: ${cgrom.byteLength} bytes (必要: ${MINIMUM_ANK_CGROM_SIZE})`);
  }

  const table = new Map<string, string>();
  for (let code = 0; code < ANK_GLYPH_COUNT; code++) {
    if (!isSupportedAnk(code)) continue;
    const start = ANK_8X16_OFFSET + code * ANK_8X16_GLYPH_BYTES;
    const key = glyphKey(cgrom.subarray(start, start + ANK_8X16_GLYPH_BYTES));
    // 同形グリフがあれば、先に現れたコードを採用して曖昧な上書きを避ける。
    if (!table.has(key)) table.set(key, decodeAnk(code));
  }
  return table;
}

function trimLineEnd(line: string): string {
  return line.replace(/ +$/u, '');
}

/** 4プレーンの TVRAM ビットマップを8x16セルごとにCGROMと完全一致させる。 */
export function extractTextScreen(
  tvram: Uint8Array,
  cgrom: Uint8Array,
  options: TextScreenOptions,
): TextScreenDump {
  if (tvram.byteLength < TVRAM_SIZE) {
    throw new Error(`TVRAM が短すぎます: ${tvram.byteLength} bytes (必要: ${TVRAM_SIZE})`);
  }

  const columns = Math.floor(options.widthPixels / 8);
  const rows = Math.floor(options.heightPixels / 16);
  const scrollX = (options.scrollX ?? 0) & (TVRAM_WIDTH - 1);
  const scrollY = (options.scrollY ?? 0) & (TVRAM_HEIGHT - 1);
  const reverse = createAnk8x16ReverseTable(cgrom);
  const lines: string[] = [];
  const nonEmptyPlaneCells: [number, number, number, number] = [0, 0, 0, 0];
  let nonEmptyCells = 0;
  let matchedCells = 0;
  let unknownCells = 0;

  for (let cellY = 0; cellY < rows; cellY++) {
    let line = '';
    for (let cellX = 0; cellX < columns; cellX++) {
      const glyph = new Uint8Array(ANK_8X16_GLYPH_BYTES);
      const planeUsed = [false, false, false, false];

      for (let glyphY = 0; glyphY < ANK_8X16_GLYPH_BYTES; glyphY++) {
        const pixelY = (scrollY + cellY * 16 + glyphY) & (TVRAM_HEIGHT - 1);
        for (let glyphX = 0; glyphX < 8; glyphX++) {
          const pixelX = (scrollX + cellX * 8 + glyphX) & (TVRAM_WIDTH - 1);
          const logicalAddress = pixelY * TVRAM_BYTES_PER_LINE + (pixelX >> 3);
          const storageAddress = logicalAddress ^ 1;
          const mask = 0x80 >> (pixelX & 7);
          let set = false;
          for (let plane = 0; plane < 4; plane++) {
            if ((tvram[storageAddress + plane * TVRAM_PLANE_SIZE] & mask) !== 0) {
              planeUsed[plane] = true;
              set = true;
            }
          }
          if (set) glyph[glyphY] |= 0x80 >> glyphX;
        }
      }

      const nonEmpty = glyph.some((value) => value !== 0);
      if (!nonEmpty) {
        line += ' ';
        continue;
      }

      nonEmptyCells++;
      for (let plane = 0; plane < 4; plane++) {
        if (planeUsed[plane]) nonEmptyPlaneCells[plane]++;
      }
      const matched = reverse.get(glyphKey(glyph));
      if (matched === undefined) {
        unknownCells++;
        line += '\ufffd';
      } else {
        matchedCells++;
        line += matched;
      }
    }
    lines.push(trimLineEnd(line));
  }

  return {
    available: true,
    lines,
    diagnostics: {
      columns,
      rows,
      nonEmptyCells,
      matchedCells,
      unknownCells,
      coverage: nonEmptyCells === 0 ? 0 : matchedCells / nonEmptyCells,
      nonEmptyPlaneCells,
    },
  };
}

/** 初期化前や CGROM 不足時に、呼び出し側を例外で止めず取得不可を伝える。 */
export function unavailableTextScreenDump(reason: string): TextScreenDump {
  return {
    available: false,
    unavailableReason: reason,
    lines: [],
    diagnostics: {
      columns: 0,
      rows: 0,
      nonEmptyCells: 0,
      matchedCells: 0,
      unknownCells: 0,
      coverage: 0,
      nonEmptyPlaneCells: [0, 0, 0, 0],
    },
  };
}

/** 再ビルド済み wasm の公開関数から現在の表示範囲をダンプする。 */
export function extractTextScreenFromCore(
  mod: TextVramCoreModule,
  cgrom: Uint8Array,
  overrides: Partial<TextScreenOptions> = {},
): TextScreenDump {
  const required = [
    mod._webx68k_tvram_data,
    mod._webx68k_text_dot_x,
    mod._webx68k_text_dot_y,
    mod._webx68k_text_scroll_x,
    mod._webx68k_text_scroll_y,
  ];
  if (required.some((fn) => typeof fn !== 'function')) {
    throw new Error('TVRAM 画面取得用 export がありません。scripts/build-core.sh でコアを再ビルドしてください');
  }

  const ptr = mod._webx68k_tvram_data!();
  if (ptr <= 0 || ptr + TVRAM_SIZE > mod.HEAPU8.byteLength) {
    throw new Error(`TVRAM ポインタが不正です: 0x${ptr.toString(16)}`);
  }
  const tvram = mod.HEAPU8.subarray(ptr, ptr + TVRAM_SIZE);
  return extractTextScreen(tvram, cgrom, {
    widthPixels: overrides.widthPixels ?? mod._webx68k_text_dot_x!(),
    heightPixels: overrides.heightPixels ?? mod._webx68k_text_dot_y!(),
    scrollX: overrides.scrollX ?? mod._webx68k_text_scroll_x!(),
    scrollY: overrides.scrollY ?? mod._webx68k_text_scroll_y!(),
  });
}
