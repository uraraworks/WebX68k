// 最小限の BDF パーサ (STARTFONT 2.1 想定)
// 依存なし・Node組み込みのみで動く

/**
 * BDFテキストをパースして {fbb:{w,h,xoff,yoff}, glyphs:Map<number, Glyph>} を返す
 * Glyph = { w, h, xoff, yoff, rows: number[] } rows[i] は1行分のビット列(0/1の配列, 長さw, 左が上位ビット=左端ピクセル)
 */
function parseBdf(text) {
  const lines = text.split(/\r?\n/);
  let fbb = { w: 0, h: 0, xoff: 0, yoff: 0 };
  const glyphs = new Map();

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('FONTBOUNDINGBOX')) {
      const [, w, h, xoff, yoff] = line.trim().split(/\s+/).map((v, idx) => (idx === 0 ? v : Number(v)));
      fbb = { w, h, xoff, yoff };
    }
    if (line.startsWith('STARTCHAR')) {
      let encoding = null;
      let bbx = null;
      let bitmapRows = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('ENDCHAR')) {
        const l = lines[i];
        if (l.startsWith('ENCODING')) {
          encoding = parseInt(l.trim().split(/\s+/)[1], 10);
        } else if (l.startsWith('BBX')) {
          const parts = l.trim().split(/\s+/).slice(1).map(Number);
          bbx = { w: parts[0], h: parts[1], xoff: parts[2], yoff: parts[3] };
        } else if (l.startsWith('BITMAP')) {
          i++;
          while (i < lines.length && !lines[i].startsWith('ENDCHAR')) {
            bitmapRows.push(lines[i].trim());
            i++;
          }
          continue; // i は既に ENDCHAR 行を指しているので while の i++ に任せる
        }
        i++;
      }
      if (encoding !== null && encoding >= 0 && bbx) {
        const bytesPerRow = Math.ceil(bbx.w / 8);
        const rows = bitmapRows.slice(0, bbx.h).map((hex) => {
          const padded = hex.padEnd(bytesPerRow * 2, '0');
          const bits = [];
          for (let x = 0; x < bbx.w; x++) {
            const byteIdx = x >> 3;
            const bitIdx = 7 - (x & 7);
            const byteVal = parseInt(padded.substr(byteIdx * 2, 2), 16) || 0;
            bits.push((byteVal >> bitIdx) & 1);
          }
          return bits;
        });
        glyphs.set(encoding, { w: bbx.w, h: bbx.h, xoff: bbx.xoff, yoff: bbx.yoff, rows });
      }
    }
    i++;
  }
  return { fbb, glyphs };
}

/**
 * グリフを fbb (フォント全体のバウンディングボックス) サイズのセルに配置し、
 * 2次元ビット配列 (cellH行 x cellW列, 上から下, 左から右, 0/1) を返す。
 * 該当グリフが無ければ全0(空白)を返す。
 */
function glyphToCell(glyph, fbb) {
  const cell = Array.from({ length: fbb.h }, () => new Array(fbb.w).fill(0));
  if (!glyph) return cell;
  // BDFの座標系: yoffはベースラインからの下方向オフセット(負値が多い)。
  // セル上端からグリフ上端までの行数 = (fbb.h + fbb.yoff) - (glyph.yoff + glyph.h)
  const top = fbb.h + fbb.yoff - (glyph.yoff + glyph.h);
  const left = glyph.xoff - fbb.xoff;
  for (let y = 0; y < glyph.h; y++) {
    const cy = top + y;
    if (cy < 0 || cy >= fbb.h) continue;
    for (let x = 0; x < glyph.w; x++) {
      const cx = left + x;
      if (cx < 0 || cx >= fbb.w) continue;
      cell[cy][cx] = glyph.rows[y][x];
    }
  }
  return cell;
}

module.exports = { parseBdf, glyphToCell };
