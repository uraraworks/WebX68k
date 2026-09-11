// HostFS (feature/hostfs) 用: _NAMESTS (88バイト、Human68kの正規化パス形式) のデコード。
//
// 実測で確定している形(親からの指示書のとおり):
//   +0      : '?' の数
//   +1      : ドライブ番号
//   +2..+66 : パス(65バイト)。区切りの '\' は $09、NUL終端
//   +67..+74: 名前 8バイト
//   +75..+77: 拡張子 3バイト
//   +78..+87: 名前の残り 10バイト

export interface Namests {
  questionMarks: number;
  drive: number;
  /** 区切り $09 を '\' に戻し、NUL終端までを文字列化したパス。 */
  path: string;
  name: string;
  ext: string;
  nameRest: string;
}

const PATH_OFFSET = 2;
const PATH_LEN = 65; // +2..+66
const NAME_OFFSET = 67;
const NAME_LEN = 8;
const EXT_OFFSET = 75;
const EXT_LEN = 3;
const NAME_REST_OFFSET = 78;
const NAME_REST_LEN = 10;

export const NAMESTS_SIZE = 88;

function bytesToAscii(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

export function decodeNamests(buf: Uint8Array): Namests {
  if (buf.length < NAMESTS_SIZE) {
    throw new Error(`_NAMESTS の長さが不足: ${buf.length} < ${NAMESTS_SIZE}`);
  }
  const questionMarks = buf[0];
  const drive = buf[1];

  let pathEnd = PATH_OFFSET;
  const pathLimit = PATH_OFFSET + PATH_LEN;
  while (pathEnd < pathLimit && buf[pathEnd] !== 0) pathEnd++;
  let path = '';
  for (let i = PATH_OFFSET; i < pathEnd; i++) {
    const c = buf[i];
    path += c === 0x09 ? '\\' : String.fromCharCode(c);
  }

  const name = bytesToAscii(buf.subarray(NAME_OFFSET, NAME_OFFSET + NAME_LEN)).trimEnd();
  const ext = bytesToAscii(buf.subarray(EXT_OFFSET, EXT_OFFSET + EXT_LEN)).trimEnd();
  const nameRest = bytesToAscii(buf.subarray(NAME_REST_OFFSET, NAME_REST_OFFSET + NAME_REST_LEN)).trimEnd();

  return { questionMarks, drive, path, name, ext, nameRest };
}

/**
 * $41(cd)専用: +14が指す先は、実測(親からの指示書、+デバッグ実測で裏取り)では
 * _NAMESTSと同じ先頭2バイト('?'の数+ドライブ番号)付きの構造で、パス本体は
 * +2から始まる(decodeNamestsのPATH_OFFSETと同じ)。
 *   cd c:\sub の実測バイト列: 00 02 09 73 75 62 09 00
 *     +0=00('?'の数) +1=02(ドライブ、C:) +2..= 09 73 75 62 09 00 (= "\sub\" + NUL)
 * 親からの指示書にあった「09 73 75 62 09 00」はこの+2以降の部分だけを指していた
 * (実機実測で先頭2バイトの存在を確認・2026-09-12)。decodeNamestsのPATH部分と
 * 同じ規約(区切り$09→'\'、NUL終端)を、オフセット2から適用する。
 */
export function decodeCdPath(buf: Uint8Array, maxLen = 65): string {
  const start = PATH_OFFSET;
  let end = start;
  const limit = Math.min(buf.length, start + maxLen);
  while (end < limit && buf[end] !== 0) end++;
  let path = '';
  for (let i = start; i < end; i++) {
    const c = buf[i];
    path += c === 0x09 ? '\\' : String.fromCharCode(c);
  }
  return path;
}
