// HostFS (feature/hostfs) P2a #2 用: ホストのファイル名をHuman68kの8.3形式へ変換する。
//
// 親からの指示書のとおり:
//   - ASCIIはそのまま(小文字もそのまま)。日本語などはCP932で符号化する。
//   - 名前は18文字(8+10)まで、拡張子は3文字まで。
//   - ドットが2つ以上ある名前、Human68kで使えない文字を含む名前は出さない。
//   - CP932で表せない文字を含む名前も出さない。
//
// CP932への符号化は既存の src/api/sjis.ts (encodeSjisUnits、TextDecoder('shift_jis')の
// リバースマップ方式)を再利用する。HostFsFileEntry.name/ext は「1文字=1バイト」の
// 疑似文字列(filbuf.ts が charCodeAt でそのまま書き出す前提)なので、CP932のバイト列を
// String.fromCharCode で1バイトずつ文字に変換して積む。

import { encodeSjisUnits, decodeSjis } from '../api/sjis';

const MAX_NAME_LEN = 18; // FILBUF +10(8) + +78相当の続き(10)
const MAX_EXT_LEN = 3;

// Human68kで使えない/紛らわしい文字(制御文字 + DOS的な予約記号)。'.'は拡張子区切りとして
// 別途扱うためここには含めない。
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS = /[\x00-\x1f"*+,/:;<=>?[\]|]/;

export interface HostNameConversion {
  /** 8.3形式の本体(拡張子を除く)。CP932バイト列を1バイト=1文字として積んだ疑似文字列。 */
  name: string;
  /** 拡張子(先頭ドット無し)。同上。 */
  ext: string;
}

function bytesToByteString(bytes: number[]): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** 1要素をCP932バイト列(疑似文字列)へ変換する。表現できない文字があればnull。 */
function toCp932ByteString(s: string): string | null {
  if (s.length === 0) return '';
  const { units, skipped } = encodeSjisUnits(s);
  if (skipped.length > 0) return null;
  return bytesToByteString(units.flat());
}

/**
 * ホストのファイル/フォルダ名(Unicode文字列)をHuman68kの8.3形式へ変換する。
 * 出せない理由がある場合はnullを返す(呼び出し側は件数だけログに出す想定)。
 */
export function convertHostNameToHuman68k(hostName: string): HostNameConversion | null {
  if (hostName.length === 0) return null;
  if (ILLEGAL_CHARS.test(hostName)) return null;

  const dotCount = (hostName.match(/\./g) ?? []).length;
  if (dotCount > 1) return null;

  let base = hostName;
  let ext = '';
  const dotIndex = hostName.indexOf('.');
  if (dotIndex >= 0) {
    base = hostName.slice(0, dotIndex);
    ext = hostName.slice(dotIndex + 1);
  }

  if (base.length === 0) return null; // ".gitignore" 相当は今回は対象外(拡張子だけの名前)
  // 文字数の上限はUnicode文字単位でまず粗く弾く(CP932変換後にバイト長が伸びる場合が
  // あるため、変換後にもう一度バイト長で確認する)。
  if (base.length > MAX_NAME_LEN || ext.length > MAX_EXT_LEN) return null;

  const nameBytes = toCp932ByteString(base);
  if (nameBytes === null || nameBytes.length > MAX_NAME_LEN) return null;
  const extBytes = toCp932ByteString(ext);
  if (extBytes === null || extBytes.length > MAX_EXT_LEN) return null;

  return { name: nameBytes, ext: extBytes };
}

/** 疑似文字列(1文字=1バイト、CP932のバイト列)を実際のバイト列へ戻す。 */
function byteStringToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/**
 * W2a(書き込み): ゲスト側の名前・拡張子(_NAMESTSから復元した、1文字=1バイトの
 * CP932疑似文字列。大文字小文字はゲストが渡したとおり)を、新規に作るホスト側の
 * ファイル名(Unicode)へ変換する。既存ファイルとの照合はここでは行わない
 * (呼び出し側=host-folder-fs.tsが大文字小文字無視で別途探す)。
 */
export function convertGuestNameToHostFileName(guestName: string, guestExt: string): string {
  const name = decodeSjis(byteStringToBytes(guestName));
  const ext = decodeSjis(byteStringToBytes(guestExt));
  return ext.length > 0 ? `${name}.${ext}` : name;
}
