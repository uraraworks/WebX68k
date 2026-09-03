// RGB565 → ImageData(RGBA) の変換表(LUT)を作る。
//
// なぜ表にするのか: handleVideoRefresh() のピクセルごと4バイト書き変換を実測したところ、
// 768x512(約39万ピクセル)を毎フレーム変換するのに1回あたり約2.9msかかっており、
// 無制限速度モードの上限だけでなく通常モードの負荷にもなっていた。
// RGB565 は取りうる値が65536通りしかないため、あらかじめ全パターンを1回だけ計算して
// Uint32Array の表にしておけば、変換は「表を引いて1ピクセル1回書き」で済む。

/**
 * RGB565 の1ピクセルを ImageData(RGBA) の32bit値へ変換する表を作る。
 *
 * 各要素は、ImageData のバイト列が [R, G, B, A] の順になるように、
 * Uint32Array 経由でまとめ書きしたときのバイト詰め方をエンディアンに応じて変える。
 */
export function buildRgb565Lut(littleEndian: boolean): Uint32Array {
  const lut = new Uint32Array(65536);
  for (let px = 0; px < 65536; px++) {
    const r5 = (px >> 11) & 0x1f;
    const g6 = (px >> 5) & 0x3f;
    const b5 = px & 0x1f;
    const r = (r5 << 3) | (r5 >> 2);
    const g = (g6 << 2) | (g6 >> 4);
    const b = (b5 << 3) | (b5 >> 2);
    lut[px] = littleEndian
      ? ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0
      : ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
  }
  return lut;
}
