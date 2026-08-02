// 最近傍(nearest-neighbor)スケーリング

/**
 * srcCell (srcH行 x srcW列, 0/1の2次元配列) を dstW x dstH に最近傍拡大/縮小する
 */
function nearestScale(srcCell, srcW, srcH, dstW, dstH) {
  const dst = Array.from({ length: dstH }, () => new Array(dstW).fill(0));
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor((y * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x * srcW) / dstW));
      dst[y][x] = srcCell[sy][sx];
    }
  }
  return dst;
}

module.exports = { nearestScale };
