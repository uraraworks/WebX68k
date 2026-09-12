/**
 * 「シャープ・バイリニア」表示: #screen(実解像度canvas)の上に重ねる表示専用canvas。
 *
 * なぜ別canvasを重ねるか:
 * #screen は実解像度(コアのネイティブ解像度)のピクセルバッファを持つcanvasで、
 * マウス座標換算(canvas.width/clientWidth比)・スクリーンショット(toDataURL)・
 * 画面ハッシュ(getImageData)・MCP Bridge 等、多数の利用者が「#screenのバッファ=
 * 実解像度そのもの」という前提でアクセスしている。4:3表示やDPRの高い環境では
 * #screenをCSSで数倍に引き伸ばすため、#screen自体に中間バッファの仕組みを持ち込むと
 * これらの前提が壊れる。そこで表示専用のcanvas(#screen-sharp)を#screenの真上に
 * position:absoluteで重ね、実際に見える絵はそちらに描く。#screenのバッファサイズや
 * 描画処理(putImageData等)は一切変更しない。
 *
 * なぜ「floorの整数倍→残りは補間」の2段階にするか:
 * 表示先のCSSサイズ(物理ピクセル換算)をそのままバイリニア補間で引き伸ばすと、
 * 表示倍率が2倍3倍と大きいほど画面全体がぼやける(1ドットの境界が何物理pxにも
 * わたって滲む)。先に最近傍(image-rendering非依存、drawImageのimageSmoothingEnabled=false)
 * で物理ピクセル単位の整数倍(kx, ky)まで引き伸ばした中間バッファを作っておき、
 * それを最後にCSSの表示サイズへ auto(補間あり)で当てはめれば、補間がかかるのは
 * 「整数倍で割り切れない端数ぶん」だけになる。滲みはドット境界の1物理px程度に収まり、
 * 4:3の非整数倍拡大でも縦横比の配分自体は保ったまま、ドットの輪郭は最近傍時よりずっと
 * シャープに見える。
 */

/** 中間バッファが大きくなりすぎないための上限(1辺のpx数、および総画素数)。 */
const MAX_PRESCALE_DIMENSION = 8192;
const MAX_PRESCALE_PIXELS = 16_777_216;

/**
 * 実解像度(nativeW x nativeH)を表示先のCSSサイズ(cssW x cssH、DPR適用前)へ
 * 引き伸ばす際に、まず最近傍で拡大しておくべき整数倍率(kx, ky)を求める。
 *
 * kx = floor(物理表示幅 / 実解像度幅)、ky も同様(物理表示幅 = cssW * dpr)。
 * 最小1(縮小方向や等倍以下では最近傍の1倍のまま、残りの端数だけCSS側の補間に任せる)。
 * 中間バッファが1辺8192pxまたは総画素16,777,216pxを超える場合は、kx, kyのうち大きい方から
 * 1ずつ減らして上限内に収める(縦横比が崩れてもよい。上限超過を防ぐことを優先する)。
 */
export function computePrescale(
  nativeW: number,
  nativeH: number,
  cssW: number,
  cssH: number,
  dpr: number,
): { kx: number; ky: number } {
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const physW = cssW * safeDpr;
  const physH = cssH * safeDpr;
  let kx = Math.max(1, Math.floor(physW / nativeW + 1e-6));
  let ky = Math.max(1, Math.floor(physH / nativeH + 1e-6));

  while (
    (nativeW * kx > MAX_PRESCALE_DIMENSION ||
      nativeH * ky > MAX_PRESCALE_DIMENSION ||
      nativeW * kx * nativeH * ky > MAX_PRESCALE_PIXELS) &&
    (kx > 1 || ky > 1)
  ) {
    if (kx >= ky) kx = Math.max(1, kx - 1);
    else ky = Math.max(1, ky - 1);
  }

  return { kx, ky };
}

/**
 * #screen の上に重ねる表示専用canvasを管理するクラス。
 * update() でサイズ・表示状態を決め、present() で実際の描画(drawImage)を行う。
 */
export class SharpView {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly source: HTMLCanvasElement;

  constructor(stageEl: HTMLElement, source: HTMLCanvasElement) {
    this.source = source;
    const canvas = document.createElement('canvas');
    canvas.id = 'screen-sharp';
    // スクリーンリーダー等には#screen側だけが実体として見えればよいので隠す。
    canvas.setAttribute('aria-hidden', 'true');
    canvas.hidden = true;
    stageEl.appendChild(canvas);
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D コンテキストの取得に失敗しました(#screen-sharp)');
    this.ctx = ctx;
  }

  /**
   * 表示状態を更新する。active=false(4:3でもDPRスムーズ対象でもない、通常のドット等倍表示)
   * なら非表示にして#screen自体をそのまま見せる。true ならcomputePrescale()で中間サイズを
   * 決め、CSS表示サイズ(cssW x cssH)へ重ねる。
   *
   * 中間サイズが変わったときだけ canvas.width/height を代入する(width/height への代入は
   * 実装上キャンバスの中身を破棄してしまうため、変化がないのに毎回代入すると不要に
   * 中身が消えてちらつく)。
   *
   * 一時停止中(コアが回っていない)はhandleVideoRefresh等の新フレームが来ないため、
   * ここでpresent()を呼んで描き直しておかないと、リサイズやDPR変更のたびに
   * #screen-sharpが黒画面のまま(または古い中間サイズのまま)固まってしまう。
   */
  update(active: boolean, cssW: number, cssH: number, dpr: number): void {
    if (!active) {
      this.canvas.hidden = true;
      return;
    }

    const nativeW = this.source.width || 1;
    const nativeH = this.source.height || 1;
    const { kx, ky } = computePrescale(nativeW, nativeH, cssW, cssH, dpr);
    const bufW = nativeW * kx;
    const bufH = nativeH * ky;

    if (this.canvas.width !== bufW || this.canvas.height !== bufH) {
      this.canvas.width = bufW;
      this.canvas.height = bufH;
    }
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.hidden = false;
    this.present();
  }

  /**
   * source(#screen)の現在の中身を、最近傍で中間バッファへ描き直す。
   * source.width/height が0(コア未起動など)のときは何もしない。
   * 中間バッファのサイズ計算に使ったnativeサイズとsourceの現在サイズが解像度変化直後で
   * 食い違っていても、drawImageはsourceの全域を中間バッファ全面へ描くだけなのでそのまま
   * 使ってよい(直後にrescale()経由でupdate()が呼ばれ、正しいサイズへ再計算される)。
   */
  present(): void {
    if (this.canvas.hidden) return;
    if (this.source.width === 0 || this.source.height === 0) return;
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(
      this.source,
      0,
      0,
      this.source.width,
      this.source.height,
      0,
      0,
      this.canvas.width,
      this.canvas.height,
    );
  }
}
