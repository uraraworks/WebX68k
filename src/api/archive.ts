// LZH/ZIPアーカイブ展開の公開API。
// 実際の解析・展開処理は lzh.ts / zip.ts に分割し、ここでは拡張子判定と振り分けのみ行う。

import type { ArchiveEntry } from './archive-util.ts';
import { isMetadataEntry } from './archive-util.ts';
import { extractLzh } from './lzh.ts';
import { extractZip } from './zip.ts';

export type { ArchiveEntry };

/** ファイル名の拡張子(大文字小文字無視)からLZH/ZIPアーカイブかどうかを判定する。 */
export function isArchive(fileName: string): boolean {
  return /\.(lzh|zip)$/i.test(fileName);
}

/**
 * アーカイブ(LZHまたはZIP)を展開し、格納されている各エントリを返す。
 * OS付随のメタデータエントリ(__MACOSX/、._ファイル、.DS_Store等)はここで一括除外する。
 * ZIP/LZHいずれの展開結果も必ずこの関数を経由するため、両形式に等しく効く。
 */
export async function extractArchive(fileName: string, bytes: Uint8Array): Promise<ArchiveEntry[]> {
  let entries: ArchiveEntry[];
  if (/\.lzh$/i.test(fileName)) {
    entries = extractLzh(bytes);
  } else if (/\.zip$/i.test(fileName)) {
    entries = await extractZip(bytes);
  } else {
    throw new Error(`未対応のアーカイブ形式です: ${fileName}`);
  }
  return entries.filter((entry) => !isMetadataEntry(entry.name));
}

/**
 * ファイル名の拡張子に頼らず、バイト列の先頭シグネチャからZIP/LZHを見分ける。
 * URLパラメータ経由の配布URLは拡張子を持たないことがあるための保険。
 * ZIP: ローカルファイルヘッダ("PK\x03\x04")のほか空アーカイブ("PK\x05\x06")・分割("PK\x07\x08")も見る。
 * LZH: オフセット2〜6のメソッドID("-lh0-"〜"-lh7-"、"-lhd-"等、"-lz"始まりの旧形式も)。
 */
export function sniffArchiveExtension(bytes: Uint8Array): '.zip' | '.lzh' | null {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
  ) {
    return '.zip';
  }
  if (
    bytes.length >= 7 &&
    bytes[2] === 0x2d /* '-' */ &&
    (bytes[3] === 0x6c || bytes[3] === 0x6c) /* 'l' */ &&
    (bytes[4] === 0x68 || bytes[4] === 0x7a) /* 'h' or 'z' */ &&
    bytes[6] === 0x2d /* '-' */
  ) {
    return '.lzh';
  }
  return null;
}

/**
 * 拡張子で判定できないファイル名について、バイト列のシグネチャも見た上で
 * 「アーカイブとして扱える実効ファイル名」を返す(拡張子が無ければシグネチャ分の拡張子を補う)。
 * アーカイブと判定できない場合は null。
 */
export function resolveArchiveFileName(fileName: string, bytes: Uint8Array): string | null {
  if (isArchive(fileName)) return fileName;
  const ext = sniffArchiveExtension(bytes);
  return ext ? `${fileName}${ext}` : null;
}
