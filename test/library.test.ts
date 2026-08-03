import { describe, expect, it } from 'vitest';
import { buildLibraryNodes, splitDisplayName } from '../src/api/library.ts';
import { classifyDiskKind } from '../src/disk-store.ts';
import type { StoredDisk } from '../src/disk-store.ts';

function disk(partial: Partial<StoredDisk> & { sourceKey: string; name: string }): StoredDisk {
  return {
    bytes: new Uint8Array(1024),
    savedAt: 1000,
    ...partial,
  };
}

describe('buildLibraryNodes', () => {
  it('グループ無しのレコードは単体ノードとして保存時刻の降順に並ぶ', () => {
    const nodes = buildLibraryNodes(
      [
        disk({ sourceKey: 'k1', name: 'old.d88', savedAt: 100 }),
        disk({ sourceKey: 'k2', name: 'new.hdf', savedAt: 300 }),
        disk({ sourceKey: 'k3', name: 'mid.xdf', savedAt: 200 }),
      ],
      classifyDiskKind,
    );
    expect(nodes.map((n) => (n.kind === 'item' ? n.entry.name : '?'))).toEqual([
      'new.hdf',
      'mid.xdf',
      'old.d88',
    ]);
    expect(nodes.every((n) => n.kind === 'item')).toBe(true);
    const first = nodes[0];
    expect(first.kind === 'item' && first.entry.kind).toBe('hdd');
  });

  it('同一グループのレコードを1つのフォルダにまとめ、groupIndex順に並べる', () => {
    const nodes = buildLibraryNodes(
      [
        disk({
          sourceKey: 'arc:g.zip:9/B.d88',
          name: 'B.d88',
          group: 'arc:g.zip:9',
          groupName: 'g.zip',
          groupIndex: 1,
          savedAt: 100,
        }),
        disk({
          sourceKey: 'arc:g.zip:9/A.d88',
          name: 'A.d88',
          group: 'arc:g.zip:9',
          groupName: 'g.zip',
          groupIndex: 0,
          savedAt: 150,
        }),
        disk({ sourceKey: 'solo', name: 'solo.d88', savedAt: 120 }),
      ],
      classifyDiskKind,
    );
    expect(nodes).toHaveLength(2);
    const [first, second] = nodes;
    // フォルダの並び順は中の最新保存時刻(150)なので単体(120)より前に来る。
    expect(first.kind).toBe('group');
    if (first.kind !== 'group') throw new Error('expected group');
    expect(first.group.id).toBe('arc:g.zip:9');
    expect(first.group.name).toBe('g.zip');
    expect(first.group.entries.map((e) => e.name)).toEqual(['A.d88', 'B.d88']);
    expect(second.kind).toBe('item');
  });

  it('displayName があれば表示名に使い、無ければ元のファイル名を使う', () => {
    const nodes = buildLibraryNodes(
      [
        disk({ sourceKey: 'k1', name: 'GAME_A.d88', displayName: 'ゲームA 1枚目', savedAt: 200 }),
        disk({ sourceKey: 'k2', name: 'GAME_B.d88', savedAt: 100 }),
      ],
      classifyDiskKind,
    );
    const names = nodes.map((n) => (n.kind === 'item' ? n.entry.displayName : '?'));
    expect(names).toEqual(['ゲームA 1枚目', 'GAME_B.d88']);
  });

  it('groupName が一部欠けていてもグループ名を復元する', () => {
    const nodes = buildLibraryNodes(
      [
        disk({ sourceKey: 'a', name: 'A.d88', group: 'g', groupIndex: 0, savedAt: 100 }),
        disk({ sourceKey: 'b', name: 'B.d88', group: 'g', groupName: 'game.lzh', groupIndex: 1, savedAt: 100 }),
      ],
      classifyDiskKind,
    );
    expect(nodes).toHaveLength(1);
    const node = nodes[0];
    if (node.kind !== 'group') throw new Error('expected group');
    expect(node.group.name).toBe('game.lzh');
  });

  it('ディスクイメージ以外の拡張子のレコードは無視する', () => {
    const nodes = buildLibraryNodes(
      [disk({ sourceKey: 'k1', name: 'readme.txt', savedAt: 100 })],
      classifyDiskKind,
    );
    expect(nodes).toEqual([]);
  });
});

describe('splitDisplayName', () => {
  it('tailChars以下の短い名前はheadにそのまま入り、tailは空', () => {
    expect(splitDisplayName('short.d88', 18)).toEqual({ head: 'short.d88', tail: '' });
  });

  it('境界値ちょうど(length === tailChars)でもheadにそのまま入る', () => {
    const name = 'a'.repeat(18);
    expect(splitDisplayName(name, 18)).toEqual({ head: name, tail: '' });
  });

  it('tailCharsを超える名前はhead/tailに分割され、連結すると元に戻る', () => {
    const name = 'Street Fighter II Champion Edition (1993)(SPS)(Disk 1 of 4)(System).dim';
    const { head, tail } = splitDisplayName(name, 18);
    expect(tail).toHaveLength(18);
    expect(head + tail).toBe(name);
    // 末尾には枚数情報が残っていること
    expect(tail).toBe('Disk 1 of 4)(System).dim'.slice(-18));
  });

  it('同一グループ内の4枚は、共通の先頭部分が同じでもtailで区別できる(実測に基づく命名)', () => {
    // 実際のアーカイブでよくある命名: 1枚目だけ(System)が付き、残りは付かない。
    const names = [
      'Street Fighter II Champion Edition (1993)(SPS)(Disk 1 of 4)(System).dim',
      'Street Fighter II Champion Edition (1993)(SPS)(Disk 2 of 4).dim',
      'Street Fighter II Champion Edition (1993)(SPS)(Disk 3 of 4).dim',
      'Street Fighter II Champion Edition (1993)(SPS)(Disk 4 of 4).dim',
    ];
    const tails = names.map((n) => splitDisplayName(n, 18).tail);
    expect(new Set(tails).size).toBe(4);
  });
});
