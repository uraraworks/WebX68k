import { describe, expect, it } from 'vitest';
import { buildRejectedTooltipLines } from '../src/hostfs/rejected-tooltip';

describe('buildRejectedTooltipLines', () => {
  it('20行以内ならそのまま全部返す(「ほかN件」は付かない)', () => {
    const paths = Array.from({ length: 20 }, (_, i) => `/name${i}`);
    const lines = buildRejectedTooltipLines(paths, 20, 20, (extra) => `ほか${extra}件`);
    expect(lines).toEqual(paths);
  });

  it('20行を超えたら先頭20行のあとに「ほかN件」を1行足す', () => {
    const paths = Array.from({ length: 25 }, (_, i) => `/name${i}`);
    const lines = buildRejectedTooltipLines(paths, 25, 20, (extra) => `ほか${extra}件`);
    expect(lines.length).toBe(21);
    expect(lines.slice(0, 20)).toEqual(paths.slice(0, 20));
    expect(lines[20]).toBe('ほか5件');
  });

  it('pathsがWorker→ページ送信の上限で切り詰められていても、「ほかN件」はtotalCountから正しい実数を出す', () => {
    // 例: 実際は210件あるが、送信は200件までに切り詰められている(HostFolderFs.REJECTED_PATHS_LIMIT)。
    const paths = Array.from({ length: 200 }, (_, i) => `/name${i}`);
    const lines = buildRejectedTooltipLines(paths, 210, 20, (extra) => `ほか${extra}件`);
    expect(lines.length).toBe(21);
    expect(lines[20]).toBe('ほか190件'); // 210 - 20行分表示 = 190
  });

  it('英語ラベルでも同じロジックで組み立てられる', () => {
    const paths = Array.from({ length: 22 }, (_, i) => `/name${i}`);
    const lines = buildRejectedTooltipLines(paths, 22, 20, (extra) => `${extra} more`);
    expect(lines[20]).toBe('2 more');
  });
});
