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
