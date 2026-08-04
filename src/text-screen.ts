const TVRAM_PLANE_SIZE = 0x20000;
const TVRAM_SIZE = TVRAM_PLANE_SIZE * 4;
const TVRAM_WIDTH = 1024;
const TVRAM_HEIGHT = 1024;
const TVRAM_BYTES_PER_LINE = TVRAM_WIDTH / 8;
const KANJI_16X16_OFFSET = 0x000000;
const KANJI_16X16_GLYPH_BYTES = 32;
const KANJI_TEN_PER_KU = 94;
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
  kanjiFontAvailable: boolean;
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

interface SampledCell {
  glyph: Uint8Array;
  key: string;
  nonEmpty: boolean;
  planeUsed: [boolean, boolean, boolean, boolean];
  ank?: string;
}

const shiftJisDecoder = new TextDecoder('shift_jis');
const reverseTablesCache = new WeakMap<Uint8Array, {
  ank: Map<string, string>;
  kanji: Map<string, string>;
}>();

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
  return shiftJisDecoder.decode(Uint8Array.of(code));
}

/**
 * 2バイトShift_JISをJISの区点へ変換し、XEiJ FNT_ADDRESS_KNJ16X16準拠の
 * 16x16漢字ブロック内オフセットを返す。CGROMは1～8区、16～84区だけを連続格納する。
 */
export function shiftJisToKanji16x16Offset(shiftJis: number): number | undefined {
  const lead = shiftJis >>> 8;
  const trail = shiftJis & 0xff;
  const validLead = (lead >= 0x81 && lead <= 0x9f) || (lead >= 0xe0 && lead <= 0xef);
  const validTrail = (trail >= 0x40 && trail <= 0x7e) || (trail >= 0x80 && trail <= 0xfc);
  if (!validLead || !validTrail) return undefined;

  let jisRow = ((lead <= 0x9f ? lead - 0x81 : lead - 0xc1) << 1) + 0x21;
  let jisCell: number;
  if (trail >= 0x9f) {
    jisRow++;
    jisCell = trail - 0x7e;
  } else {
    jisCell = trail - (trail <= 0x7e ? 0x1f : 0x20);
  }

  const ku = jisRow - 0x20;
  const ten = jisCell - 0x20;
  if (ten < 1 || ten > KANJI_TEN_PER_KU) return undefined;
  const kuIndex = ku >= 1 && ku <= 8 ? ku - 1 : ku >= 16 && ku <= 84 ? 8 + ku - 16 : -1;
  if (kuIndex < 0) return undefined;
  return KANJI_16X16_OFFSET + (kuIndex * KANJI_TEN_PER_KU + ten - 1) * KANJI_16X16_GLYPH_BYTES;
}

function jisToShiftJis(ku: number, ten: number): number {
  const jisRow = ku + 0x20;
  const jisCell = ten + 0x20;
  let lead = ((jisRow - 0x21) >> 1) + 0x81;
  if (lead > 0x9f) lead += 0x40;
  let trail: number;
  if ((jisRow & 1) !== 0) {
    trail = jisCell + 0x1f;
    if (trail >= 0x7f) trail++;
  } else {
    trail = jisCell + 0x7e;
  }
  return (lead << 8) | trail;
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
    const glyph = cgrom.subarray(start, start + ANK_8X16_GLYPH_BYTES);
    if (!glyph.some((value) => value !== 0)) continue;
    const key = glyphKey(glyph);
    // 同形グリフがあれば、先に現れたコードを採用して曖昧な上書きを避ける。
    if (!table.has(key)) table.set(key, decodeAnk(code));
  }
  return table;
}

/** CGROM.DAT の16x16漢字ブロックから、左右各8pxを連結した完全一致用の逆引き表を作る。 */
export function createKanji16x16ReverseTable(cgrom: Uint8Array): Map<string, string> {
  const table = new Map<string, string>();
  const kuList = [
    ...Array.from({ length: 8 }, (_, index) => index + 1),
    ...Array.from({ length: 69 }, (_, index) => index + 16),
  ];
  for (const ku of kuList) {
    for (let ten = 1; ten <= KANJI_TEN_PER_KU; ten++) {
      const shiftJis = jisToShiftJis(ku, ten);
      const start = shiftJisToKanji16x16Offset(shiftJis);
      if (start === undefined || start + KANJI_16X16_GLYPH_BYTES > cgrom.byteLength) continue;
      const glyph = cgrom.subarray(start, start + KANJI_16X16_GLYPH_BYTES);
      // 空スロットは空白セル対と衝突するため登録しない。不完全なROMもこの分岐で安全に扱える。
      if (!glyph.some((value) => value !== 0)) continue;
      const character = shiftJisDecoder.decode(Uint8Array.of(shiftJis >>> 8, shiftJis & 0xff));
      if (character.includes('\ufffd')) continue;
      const key = glyphKey(glyph);
      if (!table.has(key)) table.set(key, character);
    }
  }
  return table;
}

function getReverseTables(cgrom: Uint8Array): { ank: Map<string, string>; kanji: Map<string, string> } {
  const cached = reverseTablesCache.get(cgrom);
  if (cached) return cached;
  // LibretroHostが保持するCGROMはコアへの書き込み後に変更しないため、繰り返し取得時は安全に再利用できる。
  const created = {
    ank: createAnk8x16ReverseTable(cgrom),
    kanji: createKanji16x16ReverseTable(cgrom),
  };
  reverseTablesCache.set(cgrom, created);
  return created;
}

function trimLineEnd(line: string): string {
  return line.replace(/ +$/u, '');
}

function combineWideGlyph(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(KANJI_16X16_GLYPH_BYTES);
  for (let row = 0; row < 16; row++) {
    combined[row * 2] = left[row];
    combined[row * 2 + 1] = right[row];
  }
  return combined;
}

function sampleCell(
  tvram: Uint8Array,
  cellX: number,
  cellY: number,
  scrollX: number,
  scrollY: number,
): SampledCell {
  const glyph = new Uint8Array(ANK_8X16_GLYPH_BYTES);
  const planeUsed: [boolean, boolean, boolean, boolean] = [false, false, false, false];
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
  return { glyph, key: glyphKey(glyph), nonEmpty: glyph.some((value) => value !== 0), planeUsed };
}

/** 4プレーンの TVRAM ビットマップを8x16 ANKまたは16x16漢字としてCGROMと完全一致させる。 */
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
  const { ank: ankReverse, kanji: kanjiReverse } = getReverseTables(cgrom);
  const lines: string[] = [];
  const nonEmptyPlaneCells: [number, number, number, number] = [0, 0, 0, 0];
  let nonEmptyCells = 0;
  let matchedCells = 0;
  let unknownCells = 0;

  for (let cellY = 0; cellY < rows; cellY++) {
    const cells = Array.from({ length: columns }, (_, cellX) =>
      sampleCell(tvram, cellX, cellY, scrollX, scrollY));
    for (const cell of cells) {
      cell.ank = cell.nonEmpty ? ankReverse.get(cell.key) : undefined;
      if (!cell.nonEmpty) continue;
      nonEmptyCells++;
      for (let plane = 0; plane < 4; plane++) {
        if (cell.planeUsed[plane]) nonEmptyPlaneCells[plane]++;
      }
    }

    let line = '';
    for (let cellX = 0; cellX < columns;) {
      const left = cells[cellX];
      const right = cells[cellX + 1];
      let kanji: string | undefined;
      if (right) {
        /*
         * 16x16を先に試し、一致時は2セルを消費する。ただし左右がそれぞれ有効なANKなら
         * ANK 2文字を優先する。これにより、ANKの並びが偶然CGROM漢字と同形になる誤検出を
         * 防ぎつつ、少なくとも片側がANKでない通常の漢字は16x16として復元できる。
         */
        if (!(left.ank !== undefined && right.ank !== undefined)) {
          kanji = kanjiReverse.get(glyphKey(combineWideGlyph(left.glyph, right.glyph)));
        }
      }
      if (kanji !== undefined) {
        /*
         * 全角は2セル(16px)を占めるが、文字列には1文字として入れる。以前は直後に
         * U+200Bを置いて文字列インデックスと列位置を一致させていたが、MCPで受け取る側に
         * 不可視文字が混ざり比較・検索・コピーで実害が出るため廃止した。
         * 列位置が要る場合は全角を2として数える。
         */
        line += kanji;
        matchedCells += Number(left.nonEmpty) + Number(right.nonEmpty);
        cellX += 2;
        continue;
      }
      if (!left.nonEmpty) {
        line += ' ';
      } else if (left.ank === undefined) {
        line += '\ufffd';
        unknownCells++;
      } else {
        line += left.ank;
        matchedCells++;
      }
      cellX++;
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
      kanjiFontAvailable: kanjiReverse.size > 0,
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
      kanjiFontAvailable: false,
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
