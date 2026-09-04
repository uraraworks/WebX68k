/**
 * 表示縦横比モードの判定と「目標サイズ」計算。DOM に一切触れない純関数として main.ts から切り出した。
 * 理由: Node環境(vitest)から import してロジック自体を検証できるようにするため。
 */
export type AspectMode = 'native' | '4:3';

/**
 * localStorage から読んだ生の値(未設定なら null)を、実際に使う AspectMode に解決する。
 * 既定は「native」(ドット等倍)。4:3はメニューから明示的に選ぶオプションとする。
 * 理由: 既存ユーザーの見た目を変えないこと、および Web 系の軽量エミュレータでは等倍表示が
 * 一般的で、そちらを初期状態としたほうが素直なため。4:3 は「見つけた人が実機の見え方に
 * 切り替えられる」オプションという位置づけ。
 * 注記: RetroArch/MAME など据置きのエミュレータではアスペクト補正が既定である。
 * この事実を知った上で、あえて等倍を既定に選んでいる(2026-08 判断)。
 * ただし既に明示的に 'native'/'4:3' を選んで保存済みの値があれば、それを尊重して上書きしない。
 * DOM(localStorage自体)に触れず純粋に判定するため、main.ts から切り出してテスト可能にしてある。
 */
export function resolveAspectMode(savedValue: string | null): AspectMode {
  if (savedValue === '4:3' || savedValue === 'native') return savedValue;
  return 'native';
}

/*
 * ==== 4:3表示モード ====
 * 実機は解像度に関わらず4:3のモニタいっぱいに表示されるため、コアの実解像度をそのまま
 * ドット等倍(正方形ピクセル)で描くと実機と縦横比が違う。'4:3' モードでは実解像度を
 * 4:3に補正した「目標サイズ」を計算し、そこへフィットさせる(getTargetSize() 参照)。
 *
 * 補正は必ず「拡大方向」で行う。どちらの軸も縮小してはいけない
 * (どちらか一方でも実解像度を下回ってはいけない)。
 *   - アスペクト比 < 4/3 (512x512, 256x256 等) → 縦(高さ)を保ち、横を height*4/3 へ広げる
 *   - アスペクト比 > 4/3 (768x512, 1024x848 等) → 横(幅)を保ち、縦を width*3/4 へ伸ばす
 *   - ちょうど 4/3 (640x480 等) → 変化なし
 * 理由: canvas は style.css で image-rendering: pixelated(最近傍補間)にしている。
 * 縮小方向で4:3化すると、1ドット幅の縦線(テキスト画面の文字など)が間引かれて消え、
 * 実機で文字が潰れて読めなくなる不具合を実際に踏んだ(2026-08 報告)。
 * 非整数倍の拡大になる分、行や列が不均等に複製される粗さは残るが、
 * ドットが消えて読めなくなるよりはるかにマシなので、今後もこの縮小禁止方針を崩さないこと。
 */

/**
 * 指定した表示縦横比モードでの「目標サイズ」(この比率でウィンドウ/フルスクリーンに収める)。
 * '4:3' モードでは常に拡大方向で補正する(上のコメントブロック参照。縮小は不可)。
 */
export function getTargetSize(
  mode: AspectMode,
  nativeWidth: number,
  nativeHeight: number
): { width: number; height: number } {
  if (mode === '4:3') {
    if (nativeWidth * 3 < nativeHeight * 4) {
      // アスペクト比 < 4/3: 縦を保ち、横を広げる
      return { width: (nativeHeight * 4) / 3, height: nativeHeight };
    }
    if (nativeWidth * 3 > nativeHeight * 4) {
      // アスペクト比 > 4/3: 横を保ち、縦を伸ばす
      return { width: nativeWidth, height: (nativeWidth * 3) / 4 };
    }
    // ちょうど 4/3: 変化なし
    return { width: nativeWidth, height: nativeHeight };
  }
  return { width: nativeWidth, height: nativeHeight };
}

/**
 * 物理ピクセル整数倍へ切り下げるときに許容するロス率。これ以内なら切り下げて pixelated を保つ。
 */
export const DEVICE_SNAP_TOLERANCE = 0.08;

/**
 * 端数倍のスケールを、可能なら「物理ピクセルで整数倍」へ寄せる(WebNP2 の fitSubScale() 移植)。
 *
 * CSSピクセル基準の端数倍 × image-rendering:pixelated は、最近傍で「物理2pxになる列」と
 * 「1pxになる列」が周期的に混ざる。結果、1ドット市松や1ドット幅の縦線(テキスト画面の文字)が
 * モアレになって間引かれて見える(WebNP2 の iPhone 疑似フルスクリーンで実測)。
 * DPR を掛けた物理倍率が整数に近いなら、切り下げて乗せればドットが均等になる。
 *
 * ただし物理倍率の1段は目標サイズ1枚ぶんと大きく、常に切り下げると画面を大きく捨てる。
 * ロスが DEVICE_SNAP_TOLERANCE を超えるときは面積を優先して端数のまま使い、代わりに
 * 補間(smooth)へ切り替えてモアレを消す(縮小方向のディザは補間したほうが実機CRTの滲みに近い。
 * 4:3モードで既に採っている方針と同じ)。
 *
 * WebX68k では 1倍未満だけでなく没入モード(全画面)にも効かせる。没入モードは fit を
 * そのまま使う設計なので、1倍以上でも端数倍になるのが常態のため。
 */
export function fitDeviceScale(rawScale: number, dpr: number): { scale: number; smooth: boolean } {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const deviceScale = rawScale * ratio;
  const snapped = Math.floor(deviceScale + 1e-6);
  if (snapped >= 1 && (deviceScale - snapped) / deviceScale <= DEVICE_SNAP_TOLERANCE) {
    return { scale: snapped / ratio, smooth: false };
  }
  return { scale: rawScale, smooth: true };
}
