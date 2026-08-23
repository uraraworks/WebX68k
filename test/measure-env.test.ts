// scripts/measure-env.mjs の competitor 判定に関する回帰テスト。
//
// 背景: competitor条件(b)「vite抽出」は 'vite' の文字列を comm(実行ファイルパス)に
// 対して判定していたが、実プロセスでは `node .../node_modules/.bin/vite` のように
// commが`node`にしかならず、'vite'という文字列は`ps -o args`(コマンドライン全体)
// にしか現れない。そのため実プロセスでは条件(b)が絶対に成立しなかった。
// 2026-08-19の検証はcommに'vite'を含む合成オブジェクトを直接ルールへ通したため、
// この穴が見えないまま「検出できた」ことになっていた。2026-08-23の計測で
// 別セッション由来の残存vite2本を見逃して発覚した。
//
// このテストは (1) 実プロセスの形をした入力(comm:'node', argsにvite)で正しく
// competitorと判定されること、(2) 自分のdevサーバの子孫(selfDescendant)は
// competitorから除外されること、(3) 修正前の実装(comm基準)では検出できないこと
// (陽性対照)を確認する。

import { describe, expect, it } from 'vitest';
import { buildLoadReport, isCompetitor, isSystemBackground } from '../scripts/measure-env.mjs';

type Proc = {
  pid: number;
  ppid?: number;
  pcpu: number;
  etime?: string;
  etimeSeconds: number;
  comm: string;
  args?: string;
  selfDescendant?: boolean;
};

function proc(partial: Partial<Proc> & { pid: number; comm: string }): Proc {
  return {
    pcpu: 0,
    etimeSeconds: 0,
    ...partial,
  };
}

/**
 * 修正前の実装の再現: comm(実行ファイルパス)に対して 'vite' を判定する。
 * 実プロセスでは comm が 'node' にしかならないため、常に検出できないことを示す
 * 陽性対照として使う。
 */
function isCompetitorLegacyCommOnly(p: Proc): boolean {
  if (isSystemBackground(p)) return false;
  const heavyAndLongRunning = p.pcpu >= 10 && p.etimeSeconds >= 600;
  const heavyBurst = p.pcpu >= 80;
  const isVite = /vite/i.test(p.comm);
  return heavyAndLongRunning || heavyBurst || isVite;
}

describe('isCompetitor', () => {
  it('実プロセスの形(comm:node, argsにvite)をcompetitorと判定する', () => {
    const p = proc({
      pid: 61083,
      comm: 'node',
      args: '/Users/foo/project/node_modules/.bin/vite --port 5299 --strictPort --host 127.0.0.1',
      pcpu: 0.1,
      etimeSeconds: 5,
    });
    expect(isCompetitor(p)).toBe(true);
  });

  it('陽性対照: comm基準の旧実装は同じ入力でcompetitorを検出できない', () => {
    const p = proc({
      pid: 61083,
      comm: 'node',
      args: '/Users/foo/project/node_modules/.bin/vite --port 5299 --strictPort --host 127.0.0.1',
      pcpu: 0.1,
      etimeSeconds: 5,
    });
    // これが今回の不具合そのもの: 実プロセスの形では旧実装が絶対にtrueを返せない
    expect(isCompetitorLegacyCommOnly(p)).toBe(false);
    // 新実装は同じ入力でちゃんと検出できる(このテストが不具合を検出する根拠)
    expect(isCompetitor(p)).toBe(true);
  });

  it('WindowServer(comm末尾一致)はcompetitorではない', () => {
    const p = proc({
      pid: 100,
      comm: '/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer',
      args: '/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer',
      pcpu: 35,
      etimeSeconds: 9999999,
    });
    expect(isSystemBackground(p)).toBe(true);
    expect(isCompetitor(p)).toBe(false);
  });

  it('CPU31%・経過1日超のChromeレンダラはcompetitorのまま(既存の真犯人型の回帰)', () => {
    const p = proc({
      pid: 200,
      comm:
        '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)',
      args: '--type=renderer --some-flag',
      pcpu: 31,
      etimeSeconds: 60 * 60 * 30, // 1日6時間
    });
    expect(isCompetitor(p)).toBe(true);
  });
});

describe('buildLoadReport / selfDescendant', () => {
  const sampler = { samples: [0.1], intervalMs: 5000, cpuCount: 8 };

  it('selfDescendant:trueのviteはcompetitorではなくsystemBackgroundに入る', () => {
    const selfViteProc = proc({
      pid: 61083,
      ppid: 61080,
      comm: 'node',
      args: '/Users/foo/project/node_modules/.bin/vite --port 5299',
      pcpu: 0.1,
      etimeSeconds: 5,
      selfDescendant: true,
    });
    const report = buildLoadReport({
      sampler,
      processesBefore: [selfViteProc],
      processesAfter: [selfViteProc],
      selfPid: 99999,
    });
    expect(report.competitors.some((p: Proc) => p.pid === 61083)).toBe(false);
    expect(report.systemBackground.some((p: Proc) => p.pid === 61083)).toBe(true);
  });

  it('selfDescendantが付いていない同種プロセスはcompetitorに入る', () => {
    const strangerViteProc = proc({
      pid: 61084,
      ppid: 1,
      comm: 'node',
      args: '/Users/foo/other-project/node_modules/.bin/vite --port 5399',
      pcpu: 0.1,
      etimeSeconds: 5,
      selfDescendant: false,
    });
    const report = buildLoadReport({
      sampler,
      processesBefore: [strangerViteProc],
      processesAfter: [strangerViteProc],
      selfPid: 99999,
    });
    expect(report.competitors.some((p: Proc) => p.pid === 61084)).toBe(true);
    expect(report.systemBackground.some((p: Proc) => p.pid === 61084)).toBe(false);
  });
});
