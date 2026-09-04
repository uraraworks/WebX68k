// URLパラメータのパース関数群(main.ts から純粋関数として切り出し、単体テスト可能にする)。

import type { AspectMode } from './aspect';

/**
 * `?ram=` の値を px68k_ramsize コアオプション形式(例: '12MB')にパースする。
 * 受理形式: '12' / '12MB' / '12mb' / 前後空白あり(trim + 大小文字無視)。
 * 有効範囲は 1〜12 の整数のみ。範囲外・非数値・小数などは無効値として null を返す。
 */
export function parseRamSizeParam(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const match = /^(\d+)\s*mb$/i.exec(trimmed) ?? /^(\d+)$/.exec(trimmed);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n < 1 || n > 12) return null;
  return `${n}MB`;
}

/**
 * index.html の #cfg-cpuspeed が並べる option 値(∞MHz の 'auto' を除く)。
 * px68k-libretro の libretro_core_options.h の表記と完全一致させる必要があるため、
 * この配列を書き換える場合は index.html とコア側の選択肢も合わせて直すこと。
 * パースはこの配列に限定しない(コアは選択肢外の値も受け付ける)が、
 * ここに並ぶ値は必ず正規化結果と一致すること(test/url-params.test.ts で検査)。
 */
export const CPU_SPEED_OPTIONS = [
  '10Mhz',
  '16Mhz',
  '25Mhz',
  '33Mhz (OC)',
  '66Mhz (OC)',
  '100Mhz (OC)',
  '200Mhz (OC)',
  '400Mhz (OC)',
  '800Mhz (OC)',
] as const;

/**
 * CPUクロックを「ホストが追いつく範囲で自動調整する」モードを表す番兵値。
 * これはコアオプションの値ではないので、コアへ渡す前に必ず具体的な MHz へ解決すること。
 */
export const AUTO_CPU_SPEED = 'auto';

/**
 * ∞MHz の「描画を捨てて最速」版を表す番兵値。
 * 制御ループは AUTO_CPU_SPEED と同じだが、画面提示を約30fpsへ間引き、コア実行に許す
 * メインスレッド占有の上限も引き上げる。画面の滑らかさと引き換えにクロックを稼ぐモード。
 */
export const AUTO_CPU_SPEED_TURBO = 'auto-max';

/**
 * 受理する CPU クロック(MHz)の範囲。px68k-libretro 側の
 * PX68K_CLOCK_MHZ_MIN / PX68K_CLOCK_MHZ_MAX と揃えること。
 * コアは選択肢に無い値でも先頭の10進数を MHz として読むので、選択肢の外の値も渡せる。
 */
export const CPU_MHZ_MIN = 10;
export const CPU_MHZ_MAX = 1000;

/**
 * 数値の MHz を px68k_cpuspeed のコアオプション文字列へ正規化する。
 * 実機に存在する 10/16/25MHz は '(OC)' を付けず、それより上は '(OC)' 付きにする
 * (既存の選択肢6段の表記をそのまま踏襲した規則)。
 */
export function cpuSpeedOptionForMhz(mhz: number): string {
  const n = Math.max(CPU_MHZ_MIN, Math.min(CPU_MHZ_MAX, Math.round(mhz)));
  return n > 25 ? `${n}Mhz (OC)` : `${n}Mhz`;
}

/**
 * `?cpu=` の値を px68k_cpuspeed コアオプション形式(例: '16Mhz', '33Mhz (OC)')にパースする。
 * 受理形式: '16' / '16Mhz' / '16MHz' / 前後空白あり(trim + 大小文字無視)。
 * '(OC)' の有無は問わず、CPU_MHZ_MIN〜CPU_MHZ_MAX の整数ならそのまま正規化して返す
 * (コアが選択肢外の値も受け付けるため、選択肢の6段+3段に限定していない)。
 * 'auto' / 'max' / 'inf' / '∞' は AUTO_CPU_SPEED(ホスト次第の自動調整)を、
 * 'auto-max' / 'automax' は AUTO_CPU_SPEED_TURBO(描画を捨てて最速)を返す。
 * 範囲外・非数値・小数などは無効値として null を返す。
 */
export function parseCpuSpeedParam(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const lower = trimmed.toLowerCase();
  if (lower === 'auto-max' || lower === 'automax' || lower === 'auto_max')
    return AUTO_CPU_SPEED_TURBO;
  if (lower === 'auto' || lower === 'max' || lower === 'inf' || trimmed === '∞')
    return AUTO_CPU_SPEED;
  const match = /^(\d+)\s*mhz(?:\s*\(oc\))?$/i.exec(trimmed) ?? /^(\d+)$/.exec(trimmed);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n < CPU_MHZ_MIN || n > CPU_MHZ_MAX) return null;
  return cpuSpeedOptionForMhz(n);
}

/**
 * `?aspect=` の値を AspectMode('4:3' | 'native')にパースする。
 * 受理形式(trim + 大小文字無視): '4:3' / '43' / '4-3' / '4/3' → '4:3'、
 * 'native' / '1:1' / '11' → 'native'。それ以外・空文字・null は無効値として null を返す。
 */
export function parseAspectModeParam(raw: string | null): AspectMode | null {
  if (raw === null) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '') return null;
  if (trimmed === '4:3' || trimmed === '43' || trimmed === '4-3' || trimmed === '4/3') return '4:3';
  if (trimmed === 'native' || trimmed === '1:1' || trimmed === '11') return 'native';
  return null;
}
