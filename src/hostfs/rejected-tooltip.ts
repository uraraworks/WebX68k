// HostFS: 「表示していない名前」通知のツールチップ本文を組み立てる純粋関数(追加分)。
//
// src/main.ts のupdateHostFsUi()から使う。main.tsはDOM要素をモジュール読み込み時に
// 取得するためnode環境のvitestから素直にimportできない。ツールチップの行組み立て
// (20行を超えた分を「ほかN件」にまとめる)自体はDOMに依存しない純粋なロジックなので、
// ここへ切り出してテストできるようにする。

/**
 * paths(HostFolderFs.getRejectedSummary()が返す、パス文字列順の相対パス一覧)から、
 * ツールチップ(title属性、改行区切り)に出す行を組み立てる。
 *
 * - 先頭lineLimit件はそのまま出す。
 * - totalCount(全ディレクトリ合算の実数)がlineLimitより多ければ、超えた分を
 *   moreLabel(extra)の1行にまとめて末尾へ足す。
 * - pathsがtotalCountより少ない(Worker→ページ送信の上限で切り詰められている)場合も、
 *   「ほかN件」のN(extra)はtotalCountから実際に表示した行数を引いた値になるので、
 *   常に正しい実数を示す。
 */
export function buildRejectedTooltipLines(
  paths: string[],
  totalCount: number,
  lineLimit: number,
  moreLabel: (extra: number) => string,
): string[] {
  const shown = paths.slice(0, lineLimit);
  const extra = totalCount - shown.length;
  return extra > 0 ? [...shown, moreLabel(extra)] : shown;
}
