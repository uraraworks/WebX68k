/**
 * 表示縦横比モードの判定と「目標サイズ」計算。DOM に一切触れない純関数として main.ts から切り出した。
 * 理由: Node環境(vitest)から import してロジック自体を検証できるようにするため。
 */
export type AspectMode = 'native' | '4:3';

/**
 * localStorage から読んだ生の値(未設定なら null)を、実際に使う AspectMode に解決する。
 * 既定は「4:3」(実機モニタ相当)。'native'(ドット等倍) はメニューから明示的に選ぶオプション。
 * 2026-08 時点では「既存ユーザーの見た目を変えない」ことを優先して native を既定にしていたが、
 * 実際の不利は4:3表示のぼやけだった。2026-09-12 (bc9498d) でシャープ・バイリニア
 * (src/sharp-view.ts) を導入してぼやけが解消したため、2026-09-13 に既定を 4:3 へ変更した。
 * 256x256/512x512 のようなゲーム画面は等倍だと横が実機より25%細く、768x512 のテキスト画面も
 * 縦が12.5%つぶれるため、4:3 のほうが実機モニタの見え方に近い。表示枠(.stage-frame)は元から
 * 4:3基準で確保しているので、既定を変えても表示サイズやツールバー位置は変わらない。
 * ただし既に明示的に 'native'/'4:3' を選んで保存済みの値があれば、それを尊重して上書きしない
 * (保存はボタン操作時のみ行われ、URL の ?aspect= による起動時の一時上書きは保存されない)。
 * DOM(localStorage自体)に触れず純粋に判定するため、main.ts から切り出してテスト可能にしてある。
 */
export function resolveAspectMode(savedValue: string | null): AspectMode {
  if (savedValue === '4:3' || savedValue === 'native') return savedValue;
  return '4:3';
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
