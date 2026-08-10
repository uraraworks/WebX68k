// URLパラメータのパース関数群(main.ts から純粋関数として切り出し、単体テスト可能にする)。

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

// index.html の #cfg-cpuspeed の option 値。px68k-libretro の libretro_core_options.h と
// 完全一致させる必要があるため、この配列を書き換える場合は index.html 側も合わせて直すこと。
const CPU_SPEEDS = ['10Mhz', '16Mhz', '25Mhz', '33Mhz (OC)', '66Mhz (OC)', '100Mhz (OC)'] as const;
// OC帯(オーバークロック)の周波数。'(OC)' の有無を問わず受理して正規化する対象。
const OC_MHZ = new Set([33, 66, 100]);

/**
 * `?cpu=` の値を px68k_cpuspeed コアオプション形式(例: '16Mhz', '33Mhz (OC)')にパースする。
 * 受理形式: '16' / '16Mhz' / '16MHz' / 前後空白あり(trim + 大小文字無視)。
 * 33/66/100 の OC帯は '(OC)' の有無を問わず受理し、'33Mhz (OC)' 形式に正規化する。
 * 指定可能な数値は 10/16/25/33/66/100 のみ。それ以外・非数値・小数などは無効値として null を返す。
 */
export function parseCpuSpeedParam(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const match = /^(\d+)\s*mhz(?:\s*\(oc\))?$/i.exec(trimmed) ?? /^(\d+)$/.exec(trimmed);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isInteger(n)) return null;
  const normalized = OC_MHZ.has(n) ? `${n}Mhz (OC)` : `${n}Mhz`;
  return (CPU_SPEEDS as readonly string[]).includes(normalized) ? normalized : null;
}
