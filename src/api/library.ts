// ディスクライブラリの一覧構築(グルーピング/並び替え)。
// WebNP2 (../PC98/WebNP2/src/api/library.ts) の移植。IndexedDBにフラットに並ぶレコードを、
// UIが表示するフォルダ付きツリーへ変換する。DOM非依存の純粋関数として切り出してあり、単体テスト可能。
//
// WebNP2 はROM/ステートも同じDBに混在するため EXCLUDED_KEY_PREFIXES で除外しているが、
// WebX68k はディスク専用DB(webx68k-disks)なのでその除外は不要。代わりに classify() が
// 拡張子から null を返すレコード(ディスクイメージ以外)を弾く。

import type { StoredDisk } from '../disk-store.ts';

/** ディスクライブラリ一覧(モーダル/スロットメニュー共通)に表示する1件。 */
export interface LibraryEntry {
  sourceKey: string;
  /** 元のファイル名(拡張子含む)。イメージ種別の判定に使うため、リネームしても変わらない。 */
  name: string;
  /** 一覧に出す表示名(リネーム済みならその名前、未設定なら name と同じ)。 */
  displayName: string;
  size: number;
  savedAt: number;
  kind: 'hdd' | 'fd';
  /** 所属グループID(アーカイブ由来の複数ディスク)。単体イメージでは未設定。 */
  group?: string;
  /** グループ内の並び順(アーカイブ内の出現順)。 */
  groupIndex?: number;
}

/** 同一アーカイブから展開された複数ディスクのまとまり(一覧ではフォルダとして表示する)。 */
export interface LibraryGroup {
  id: string;
  name: string;
  entries: LibraryEntry[];
}

/** ライブラリ一覧の行。フォルダ(group)か単体イメージ(item)のどちらか。 */
export type LibraryNode =
  | { kind: 'group'; savedAt: number; group: LibraryGroup }
  | { kind: 'item'; savedAt: number; entry: LibraryEntry };

/** 中間省略で末尾に残す文字数の目安(拡張子 + "(Disk n of m)" 相当が収まる程度)。 */
export const LIBRARY_NAME_TAIL_CHARS = 18;

/** {@link splitDisplayName} の戻り値。head/tail をそのまま連結すると元の名前に戻る。 */
export interface SplitDisplayName {
  /** 先頭側(長い場合はUI側で末尾を "…" 省略する対象)。 */
  head: string;
  /** 末尾側(常にそのまま表示する固定長)。空文字なら省略不要(名前がtailChars以下)。 */
  tail: string;
}

/**
 * 表示名の比較器。数字を数値として扱い(Disk 2 < Disk 10)、大文字小文字・全半角の差を無視する。
 * ライブラリ一覧・スロットメニュー・ファイルマネージャの一覧で同じ並び順にするため、ここに1つだけ置く。
 */
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * 表示名で比較する(自然順)。表示名が同一のときは sourceKey で決着させ、
 * 並びが実行のたびに揺れない(安定した)順序にする。
 */
export function compareLibraryName(
  a: { displayName: string; sourceKey?: string },
  b: { displayName: string; sourceKey?: string },
): number {
  const byName = nameCollator.compare(a.displayName, b.displayName);
  if (byName !== 0) return byName;
  return (a.sourceKey ?? '').localeCompare(b.sourceKey ?? '');
}

/**
 * 表示名を「先頭側」「末尾側」に分割する。X68000のディスクイメージは
 * 「共通の長いタイトル + 末尾に (Disk n of m)」という命名が多く、末尾切り捨て(通常のCSS ellipsis)だと
 * 同一アーカイブ内の複数枚が同じ表示になってしまう。末尾を固定長で必ず見せることで、
 * 先頭(作品名)と末尾(何枚目か)を両方視認できるようにする(中間が省略される)。
 * 呼び出し側(CSS)は head を通常のellipsis対象にし、tail はそのまま(white-space: nowrap; flex: 0 0 auto)で並べる。
 */
export function splitDisplayName(name: string, tailChars: number = LIBRARY_NAME_TAIL_CHARS): SplitDisplayName {
  if (name.length <= tailChars) return { head: name, tail: '' };
  return { head: name.slice(0, name.length - tailChars), tail: name.slice(name.length - tailChars) };
}

/**
 * 保存済みレコードをライブラリ一覧のツリーへ変換する。
 * group を持つレコードは1つのフォルダ(group ノード)にまとめ、それ以外は単体(item ノード)にする。
 * フォルダ内・トップレベルとも表示名の自然順(数字を数値として比較)で並べる。
 */
export function buildLibraryNodes(
  stored: StoredDisk[],
  classify: (name: string) => 'hdd' | 'fd' | null,
): LibraryNode[] {
  const groups = new Map<string, { name: string; entries: LibraryEntry[]; savedAt: number }>();
  const nodes: LibraryNode[] = [];

  for (const item of stored) {
    const kind = classify(item.name);
    if (!kind) continue;
    const entry: LibraryEntry = {
      sourceKey: item.sourceKey,
      name: item.name,
      displayName: item.displayName ?? item.name,
      size: item.bytes.byteLength,
      savedAt: item.savedAt,
      kind,
      group: item.group,
      groupIndex: item.groupIndex,
    };

    if (!item.group) {
      nodes.push({ kind: 'item', entry, savedAt: entry.savedAt });
      continue;
    }

    let group = groups.get(item.group);
    if (!group) {
      group = { name: item.groupName ?? item.group, entries: [], savedAt: 0 };
      groups.set(item.group, group);
    }
    // groupName はグループ内の全レコードが同じ値を持つ前提だが、
    // 一部だけ欠けていた場合に備えて非空の値を優先して採用する。
    if (item.groupName) group.name = item.groupName;
    group.entries.push(entry);
    // フォルダの並び順は「中で最後に保存されたディスク」を基準にする。
    group.savedAt = Math.max(group.savedAt, entry.savedAt);
  }

  for (const [id, group] of groups) {
    // アーカイブ内の出現順(groupIndex)はZIP/LZHのエントリ順そのままでディスク番号と一致しないことが多い。
    // 複数枚組を「1枚目→2枚目…」と読めるようにするため、表示名の自然順で並べる。
    group.entries.sort(compareLibraryName);
    nodes.push({ kind: 'group', savedAt: group.savedAt, group: { id, name: group.name, entries: group.entries } });
  }

  // トップレベルもフォルダ/単体を混ぜて表示名の自然順にする(保存時刻順だと取り込むたびに並びが変わるため)。
  nodes.sort((a, b) =>
    compareLibraryName(
      a.kind === 'group' ? { displayName: a.group.name, sourceKey: a.group.id } : a.entry,
      b.kind === 'group' ? { displayName: b.group.name, sourceKey: b.group.id } : b.entry,
    ),
  );
  return nodes;
}
