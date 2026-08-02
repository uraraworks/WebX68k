// ビットセルをX68000 CGROM形式(MSBファースト・左詰め・行ごとにceil(width/8)バイト)にパックする

/**
 * cell (h行 x w列, 0/1の2次元配列) を Buffer にパックする。
 * 各行は ceil(w/8) バイト、MSBファースト・左詰め、余りビットは0。
 */
function packCell(cell, w, h) {
  const bytesPerRow = Math.ceil(w / 8);
  const buf = Buffer.alloc(bytesPerRow * h);
  for (let y = 0; y < h; y++) {
    for (let byteIdx = 0; byteIdx < bytesPerRow; byteIdx++) {
      let b = 0;
      for (let bit = 0; bit < 8; bit++) {
        const x = byteIdx * 8 + bit;
        const v = x < w ? cell[y][x] : 0;
        b = (b << 1) | (v & 1);
      }
      buf[y * bytesPerRow + byteIdx] = b;
    }
  }
  return buf;
}

module.exports = { packCell };
