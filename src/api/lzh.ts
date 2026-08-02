// LZH(LHA)アーカイブ展開モジュール。
// 対応ヘッダレベル: 0/1/2。対応圧縮メソッド: -lh0-(無圧縮)、-lh5-/-lh6-/-lh7-(LZSS+静的ハフマン)。
// -lhd- はディレクトリエントリとして一覧から除外する。それ以外の未対応メソッドは例外を投げる。
//
// lh5/6/7 の展開アルゴリズムは、LHA (LZHUF方式) として広く知られる公開仕様
// (Haruyasu Yoshizaki 氏の LHarc 系実装や UNLHA32 等で解説されている符号化方式) に基づく。
// 3種はいずれも「LZSS + 2本の静的(ブロック単位で再構築される)ハフマン木」という同一アルゴリズムで、
// 窓サイズ(dicbit)とポジション符号のビット数(pbit)のみが異なる。

import { ArchiveEntry, crc16, decodeDosDateTime, decodeSjisName, readU16, readU32 } from './archive-util.ts';

// --- ビット入力(MSBファースト) -------------------------------------------------------

/** 圧縮データをMSBファーストでビット単位に読み出すリーダ。末尾を超えた読み出しは0を返す。 */
class BitReader {
  private buf: Uint8Array;
  private end: number;
  private pos: number;
  private bitBuf = 0; // 32bit windowの上位ビットから詰めていく
  private bitCount = 0;

  constructor(buf: Uint8Array, start: number, end: number) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }

  private fill(): void {
    while (this.bitCount <= 24) {
      const byte = this.pos < this.end ? this.buf[this.pos++] : 0;
      this.bitBuf = (this.bitBuf | (byte << (24 - this.bitCount))) >>> 0;
      this.bitCount += 8;
    }
  }

  /** 上位nビット(n<=16)を消費せず覗き見る。 */
  peekBits(n: number): number {
    if (n === 0) return 0;
    this.fill();
    return (this.bitBuf >>> (32 - n)) & ((1 << n) - 1);
  }

  /** nビット分読み進める(値は返さない)。 */
  skipBits(n: number): void {
    if (n === 0) return;
    this.bitBuf = (this.bitBuf << n) >>> 0;
    this.bitCount -= n;
  }

  /** nビット読み取って消費する。 */
  getBits(n: number): number {
    const v = this.peekBits(n);
    this.skipBits(n);
    return v;
  }
}

// --- 正準ハフマン木の構築とデコード ---------------------------------------------------

type HuffNode = { sym: number } | { left: HuffNode | null; right: HuffNode | null };

function isLeaf(n: HuffNode): n is { sym: number } {
  return 'sym' in n;
}

/** 符号長配列(DEFLATE等と同じ正準ハフマン割当規則)からデコード用の二分木を構築する。 */
function buildCanonicalTree(lengths: number[]): HuffNode {
  let maxBits = 0;
  for (const l of lengths) if (l > maxBits) maxBits = l;
  if (maxBits === 0) {
    throw new Error('LZH: ハフマン木を構築できません(有効な符号長がありません)');
  }
  const blCount = new Array<number>(maxBits + 1).fill(0);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Array<number>(maxBits + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxBits; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const root: { left: HuffNode | null; right: HuffNode | null } = { left: null, right: null };
  for (let sym = 0; sym < lengths.length; sym++) {
    const len = lengths[sym];
    if (len === 0) continue;
    const c = nextCode[len]++;
    let node = root;
    for (let b = len - 1; b >= 1; b--) {
      const bit = (c >> b) & 1;
      if (bit) {
        if (!node.right) node.right = { left: null, right: null };
        node = node.right as typeof root;
      } else {
        if (!node.left) node.left = { left: null, right: null };
        node = node.left as typeof root;
      }
    }
    if (c & 1) node.right = { sym };
    else node.left = { sym };
  }
  return root;
}

function decodeSymbol(reader: BitReader, tree: HuffNode): number {
  let node: HuffNode = tree;
  while (!isLeaf(node)) {
    const bit = reader.getBits(1);
    const next = bit ? node.right : node.left;
    if (!next) throw new Error('LZH: 不正なハフマン符号を検出しました(ビットストリームが壊れています)');
    node = next;
  }
  return node.sym;
}

// --- lh5/6/7 共通のブロック単位ハフマン符号読み取り -----------------------------------

const THRESHOLD = 3;
const NC = 510; // UCHAR_MAX(255) + MAXMATCH(256) + 2 - THRESHOLD(3)
const CBIT = 9;
const NT = 19; // CODE_BIT(16) + 3(特殊記号0,1,2)
const TBIT = 5;

/**
 * pt木(NT要素またはNP要素)を読み取る。各長さ値は3ビット基本+拡張(0b111が続く場合は
 * 後続の1ビットが立っている間だけ+1して延長し、0ビットに達したら停止)方式。
 * 延長時は、3ビット基本部に加えて延長判定で読んだビット(最後の停止ビット0を含む)も
 * まとめて消費する(消費ビット数 = 3 + extra + 1 = 4 + extra)。この停止ビットを
 * 消費し忘れると1ビットずつビット列がズレていき、後続のブロックで蓄積した末に
 * 不正なハフマン符号やCRC不一致として顕在化する(実データ検証で発覚)。
 * n===0 の場合は「単一シンボル」の特別扱いで、以後デコード時にビットを消費せず固定値を返す。
 * iSpecial 番目(NTの場合は3)を読んだ直後だけ、2ビットのゼラン数だけ0埋めする特殊ルールがある。
 */
function readPtLen(reader: BitReader, nn: number, nbit: number, iSpecial: number): HuffNode {
  const n = reader.getBits(nbit);
  if (n === 0) {
    const c = reader.getBits(nbit);
    return { sym: c };
  }
  const lengths = new Array<number>(nn).fill(0);
  let i = 0;
  while (i < n) {
    let c = reader.peekBits(3);
    if (c === 7) {
      let extra = 0;
      // '111' に続く1ビットが立っている間だけ延長する。停止ビット(0)を見つけたら延長終了。
      for (;;) {
        const bit = reader.peekBits(4 + extra) & 1;
        if (bit === 0) break;
        extra++;
        if (4 + extra > 16) break; // 安全弁(壊れたストリーム対策)
      }
      c = 7 + extra;
      // 3ビット基本部 + 延長ビット列(停止ビット0を含む) = 4 + extra ビットを消費する。
      reader.skipBits(4 + extra);
    } else {
      reader.skipBits(3);
    }
    lengths[i++] = c;
    if (i === iSpecial) {
      let rep = reader.getBits(2);
      while (rep-- > 0 && i < nn) lengths[i++] = 0;
    }
  }
  while (i < nn) lengths[i++] = 0;
  return buildCanonicalTree(lengths);
}

/** c木(文字/長さ木、NC要素)の符号長を、直前に読んだpt木経由で読み取る。 */
function readCLen(reader: BitReader, ptTree: HuffNode): HuffNode {
  const n = reader.getBits(CBIT);
  if (n === 0) {
    const c = reader.getBits(CBIT);
    return { sym: c };
  }
  const lengths = new Array<number>(NC).fill(0);
  let i = 0;
  while (i < n) {
    const c = decodeSymbol(reader, ptTree);
    if (c <= 2) {
      let rep: number;
      if (c === 0) rep = 1;
      else if (c === 1) rep = reader.getBits(4) + 3;
      else rep = reader.getBits(CBIT) + 20;
      while (rep-- > 0 && i < NC) lengths[i++] = 0;
    } else {
      lengths[i++] = c - 2;
    }
  }
  while (i < NC) lengths[i++] = 0;
  return buildCanonicalTree(lengths);
}

interface LzssState {
  reader: BitReader;
  blockRemaining: number;
  cTree: HuffNode | null;
  pTree: HuffNode | null;
  np: number;
  pBit: number;
}

function decodeChar(state: LzssState): number {
  if (state.blockRemaining === 0) {
    state.blockRemaining = state.reader.getBits(16);
    const ptTree = readPtLen(state.reader, NT, TBIT, 3);
    state.cTree = readCLen(state.reader, ptTree);
    state.pTree = readPtLen(state.reader, state.np, state.pBit, -1);
  }
  state.blockRemaining--;
  return decodeSymbol(state.reader, state.cTree as HuffNode);
}

function decodePosition(state: LzssState): number {
  let j = decodeSymbol(state.reader, state.pTree as HuffNode);
  if (j > 1) {
    j = (1 << (j - 1)) + state.reader.getBits(j - 1);
  }
  return j;
}

/** lh5/6/7 共通のLZSS+ハフマン展開。 */
function decodeLzss(compressed: Uint8Array, originalSize: number, dicBit: number, pBit: number): Uint8Array {
  const out = new Uint8Array(originalSize);
  if (originalSize === 0) return out;
  const state: LzssState = {
    reader: new BitReader(compressed, 0, compressed.length),
    blockRemaining: 0,
    cTree: null,
    pTree: null,
    np: dicBit + 1,
    pBit,
  };
  let outPos = 0;
  while (outPos < originalSize) {
    const c = decodeChar(state);
    if (c < 256) {
      out[outPos++] = c;
    } else {
      const len = c - 256 + THRESHOLD;
      const distance = decodePosition(state) + 1;
      if (distance > outPos) {
        throw new Error('LZH: 展開データが破損しています(参照距離が範囲外です)');
      }
      const copyLen = Math.min(len, originalSize - outPos);
      let srcPos = outPos - distance;
      for (let k = 0; k < copyLen; k++) {
        out[outPos++] = out[srcPos++];
      }
    }
  }
  return out;
}

const LZSS_PARAMS: Record<string, { dicBit: number; pBit: number }> = {
  '-lh5-': { dicBit: 13, pBit: 4 },
  '-lh6-': { dicBit: 15, pBit: 5 },
  '-lh7-': { dicBit: 16, pBit: 5 },
};

// --- ヘッダ解析 ----------------------------------------------------------------------

/**
 * レベル1/2の拡張ヘッダ列を読む。type=0x01(ファイル名)/0x02(ディレクトリ名)のみ解釈し、
 * それ以外は無視する。サイズ0のチャンクで終端。
 */
function parseExtendedHeaders(
  bytes: Uint8Array,
  start: number,
  baseName: string,
): { name: string; nextPos: number } {
  let pos = start;
  let name = baseName;
  let dirPrefix = '';
  while (pos + 2 <= bytes.length) {
    const size = readU16(bytes, pos);
    if (size === 0) {
      pos += 2;
      break;
    }
    const type = bytes[pos + 2];
    const data = bytes.subarray(pos + 3, pos + size);
    if (type === 0x01) {
      name = decodeSjisName(data);
    } else if (type === 0x02) {
      // ディレクトリ名。区切り文字は0xFFで表現される慣習があるため '/' に変換する。
      const converted = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) converted[i] = data[i] === 0xff ? 0x2f : data[i];
      dirPrefix = decodeSjisName(converted);
      if (dirPrefix.length > 0 && !dirPrefix.endsWith('/')) dirPrefix += '/';
    }
    pos += size;
  }
  return { name: dirPrefix ? dirPrefix + name : name, nextPos: pos };
}

/** LZH(LHA)アーカイブ全体を解析し、格納されている各エントリを展開して返す。 */
export function extractLzh(bytes: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    const headerSize = bytes[pos];
    if (headerSize === 0) break; // 終端マーカー(慣習)

    if (pos + 21 > bytes.length) {
      throw new Error('LZH: ヘッダが途中で切れています');
    }

    const methodId = String.fromCharCode(...bytes.subarray(pos + 2, pos + 7));
    const compressedSize = readU32(bytes, pos + 7);
    const originalSize = readU32(bytes, pos + 11);
    const rawTime = readU32(bytes, pos + 15);
    const level = bytes[pos + 20];
    // 先頭1バイトの「ヘッダサイズ」フィールドは、レベルによって指す範囲の慣習が異なり
    // (level0は checksum を含まない残りサイズ、level1/2は拡張ヘッダ列を含む/含まないなど
    // 実装依存の解釈違いが多く実データでもズレやすい)、次エントリの開始位置の算出に
    // 直接使うと誤読の原因になる。そのため終端マーカー判定にのみ使い、実際のデータ開始
    // 位置は各レベルの固定長フィールド構成から直接計算する(level1/2は拡張ヘッダ列を
    // サイズ0のチャンクに達するまで自前で辿って終端を確定させる)。

    let name = '';
    let crcField = 0;
    let mtime: Date;
    let dataStart: number;

    if (level === 0 || level === 1) {
      const nameLen = bytes[pos + 21];
      const nameBytes = bytes.subarray(pos + 22, pos + 22 + nameLen);
      name = decodeSjisName(nameBytes);
      crcField = readU16(bytes, pos + 22 + nameLen);
      mtime = decodeDosDateTime((rawTime >>> 16) & 0xffff, rawTime & 0xffff);
      if (level === 0) {
        // level0: 名前(nameLen バイト)の直後にCRC(2バイト)が続き、拡張ヘッダは無い。
        dataStart = pos + 22 + nameLen + 2;
      } else {
        // level1: 名前+CRC(2バイト)の後にOS ID(1バイト)があり、続けて拡張ヘッダ列
        // (ファイル名上書き/ディレクトリ名など)が続く。
        const extStart = pos + 22 + nameLen + 2 + 1;
        const ext = parseExtendedHeaders(bytes, extStart, name);
        name = ext.name;
        dataStart = ext.nextPos;
      }
    } else if (level === 2) {
      // level2: 固定部は attribute(1)+level(1)+CRC(2)+OS ID(1) の後に拡張ヘッダ列が続く。
      // ここでの pos+21 は CRC の開始位置(attribute/level の直後)。
      crcField = readU16(bytes, pos + 21);
      mtime = new Date(rawTime * 1000);
      const extStart = pos + 21 + 2 + 1;
      const ext = parseExtendedHeaders(bytes, extStart, '');
      name = ext.name;
      dataStart = ext.nextPos;
    } else {
      throw new Error(`LZH: 未対応のヘッダレベルです(level=${level})`);
    }

    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) {
      throw new Error(`LZH: 圧縮データがファイル末尾を超えています (${name})`);
    }
    const compressed = bytes.subarray(dataStart, dataEnd);

    if (methodId === '-lhd-') {
      pos = dataEnd; // ディレクトリエントリは一覧から除外する
      continue;
    }

    let data: Uint8Array;
    if (methodId === '-lh0-') {
      data = compressed.slice(0, originalSize);
    } else if (methodId in LZSS_PARAMS) {
      const params = LZSS_PARAMS[methodId];
      data = decodeLzss(compressed, originalSize, params.dicBit, params.pBit);
    } else {
      throw new Error(`LZH: 未対応の圧縮メソッドです: ${methodId} (${name})`);
    }

    const actualCrc = crc16(data);
    if (actualCrc !== crcField) {
      throw new Error(
        `LZH: CRC16が一致しません (${name}): 期待値=0x${crcField.toString(16)}, 実際=0x${actualCrc.toString(16)}`,
      );
    }

    entries.push({ name, data, mtime });
    pos = dataEnd;
  }
  return entries;
}
