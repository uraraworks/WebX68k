// HostFS (feature/hostfs) 用: FILBUF (53バイト、Human68kの検索結果バッファ) のエンコード。
//
// 実測で確定している形(親からの指示書のとおり):
//   +0..+9  : Human68kの内部欄。触らない(このファイルは一切書き込まない)。
//   +10     : 名前 8バイト(空白埋め)
//   +18     : 拡張子 3バイト
//   +21     : 属性
//   +22     : 時刻 W (時<<11|分<<5|秒/2)
//   +24     : 日付 W ((年-1980)<<9|月<<5|日)
//   +26     : サイズ L
//   +30     : "名前.拡張子\0" 23バイト
// **書く順序**: FILBUFへ書き終えてから+18(検索バッファ内の拡張子欄と同じ番地)は
// 呼び出し元(dispatcher)が別途、要求ヘッダの+18(戻り値欄)へ書く。ここでは
// FILBUF構造体そのものだけを組み立てる。

export const FILBUF_SIZE = 53;

const NAME_OFFSET = 10;
const NAME_LEN = 8;
const EXT_OFFSET = 18;
const EXT_LEN = 3;
const ATTR_OFFSET = 21;
const TIME_OFFSET = 22;
const DATE_OFFSET = 24;
const SIZE_OFFSET = 26;
const FULLNAME_OFFSET = 30;
const FULLNAME_LEN = 23;

export interface FakeFsDate {
  year: number; // 西暦(例: 2026)
  month: number; // 1-12
  day: number; // 1-31
}

export interface FakeFsTime {
  hour: number; // 0-23
  minute: number; // 0-59
  second: number; // 0-59(偶数へ丸めてエンコードされる)
}

export interface FilbufEntry {
  /** 8.3形式の本体(拡張子を除く、大文字)。8文字を超えないこと。 */
  name: string;
  /** 拡張子(先頭ドット無し、大文字)。3文字を超えないこと。 */
  ext: string;
  attr: number;
  date: FakeFsDate;
  time: FakeFsTime;
  size: number;
}

function padRight(s: string, len: number): Uint8Array {
  const out = new Uint8Array(len).fill(0x20); // 空白埋め
  for (let i = 0; i < Math.min(s.length, len); i++) out[i] = s.charCodeAt(i);
  return out;
}

function encodeDate(d: FakeFsDate): number {
  return (((d.year - 1980) & 0x7f) << 9) | ((d.month & 0x0f) << 5) | (d.day & 0x1f);
}

function encodeTime(t: FakeFsTime): number {
  return ((t.hour & 0x1f) << 11) | ((t.minute & 0x3f) << 5) | ((t.second >> 1) & 0x1f);
}

/**
 * FILBUF(53バイト)を新規に組み立てる。+0..+9(Human68k内部欄)は0で埋めておくが、
 * 呼び出し側(dispatcher)は実際のゲストメモリへ書く際にこの範囲を上書きしない
 * (このモジュールが返すバッファをそのまま丸ごと書いてよいのは新規領域のときだけ。
 * 既存のFILBUFへ重ねて書く場合は呼び出し側が+10以降だけを書き戻すこと)。
 */
export function encodeFilbuf(entry: FilbufEntry): Uint8Array {
  const buf = new Uint8Array(FILBUF_SIZE);
  buf.set(padRight(entry.name, NAME_LEN), NAME_OFFSET);
  buf.set(padRight(entry.ext, EXT_LEN), EXT_OFFSET);
  buf[ATTR_OFFSET] = entry.attr & 0xff;

  const time = encodeTime(entry.time);
  buf[TIME_OFFSET] = (time >> 8) & 0xff;
  buf[TIME_OFFSET + 1] = time & 0xff;

  const date = encodeDate(entry.date);
  buf[DATE_OFFSET] = (date >> 8) & 0xff;
  buf[DATE_OFFSET + 1] = date & 0xff;

  buf[SIZE_OFFSET] = (entry.size >>> 24) & 0xff;
  buf[SIZE_OFFSET + 1] = (entry.size >>> 16) & 0xff;
  buf[SIZE_OFFSET + 2] = (entry.size >>> 8) & 0xff;
  buf[SIZE_OFFSET + 3] = entry.size & 0xff;

  const fullName = entry.ext.length > 0 ? `${entry.name}.${entry.ext}` : entry.name;
  const fullNameBytes = new Uint8Array(FULLNAME_LEN); // 0埋め
  for (let i = 0; i < Math.min(fullName.length, FULLNAME_LEN - 1); i++) {
    fullNameBytes[i] = fullName.charCodeAt(i);
  }
  buf.set(fullNameBytes, FULLNAME_OFFSET);

  return buf;
}

/** ゲストへ書き込むのは +10 以降だけ(+0..+9のHuman68k内部欄には触れない)。 */
export const FILBUF_WRITE_OFFSET = NAME_OFFSET;
export function filbufPayload(entry: FilbufEntry): Uint8Array {
  return encodeFilbuf(entry).subarray(FILBUF_WRITE_OFFSET);
}
