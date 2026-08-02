// LZH/ZIPアーカイブ展開の公開API。
// 実際の解析・展開処理は lzh.ts / zip.ts に分割し、ここでは拡張子判定と振り分けのみ行う。

import type { ArchiveEntry } from './archive-util.ts';
import { extractLzh } from './lzh.ts';
import { extractZip } from './zip.ts';

export type { ArchiveEntry };

/** ファイル名の拡張子(大文字小文字無視)からLZH/ZIPアーカイブかどうかを判定する。 */
export function isArchive(fileName: string): boolean {
  return /\.(lzh|zip)$/i.test(fileName);
}

/** アーカイブ(LZHまたはZIP)を展開し、格納されている各エントリを返す。 */
export function extractArchive(fileName: string, bytes: Uint8Array): Promise<ArchiveEntry[]> {
  if (/\.lzh$/i.test(fileName)) {
    return Promise.resolve(extractLzh(bytes));
  }
  if (/\.zip$/i.test(fileName)) {
    return extractZip(bytes);
  }
  return Promise.reject(new Error(`未対応のアーカイブ形式です: ${fileName}`));
}
