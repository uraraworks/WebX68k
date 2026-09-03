// FAT12/FAT16 リーダ・ライタ。
// 移植元: WebNP2 (../PC98/WebNP2/src/api/fat.ts)。PC-98 の FD (2HD/2DD) ベタイメージ向けに
// 書かれたものだが、bytesPerSector はブートセクタの BPB から動的に読み取る実装のため
// X68000 の2HD(1024バイト/セクタ)もそのまま解釈できる。実際に human302.xdf(2HD/1024B
// セクタ)で読み書きを検証済み。createFormattedFd() はX68000の2HD 1232KBジオメトリを使う。
// HDD(.hdf)は Human68k 独自のパーティションテーブルとBEのBPB/FAT16を解析し、最初の
// Human68k形式パーティションを開く。ディレクトリエントリの数値フィールドはFDと同じLE。
// FAT12/16・セクタサイズ等を自動判別し、8.3形式ファイルの列挙・読み書き・削除を行う。
// LFN(VFAT)エントリは列挙時にスキップする(非対応)。
// ファイル名は Shift_JIS で、Human68k は MS-DOS の予約領域(12〜21)を名前の続きに使う。

import { decodeSjis } from './sjis';

/**
 * 利用者向けのディスク操作エラー。UIで言語別のメッセージへ差し替えられるよう
 * コードを持たせる(message自体は開発時/ブリッジ経由での確認用のフォールバック)。
 */
export type DiskErrorCode =
  | 'd88NotEditable'
  | 'hddInvalidHeader'
  | 'hddNoFatPartition'
  | 'invalidShortName'
  | 'notFormatted'
  | 'scsiSizeInvalid';

export class DiskError extends Error {
  constructor(
    readonly code: DiskErrorCode,
    message: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(message);
    this.name = 'DiskError';
  }
}

export interface FatEntry {
  name: string;
  size: number;
  isDir: boolean;
  cluster: number;
  mtime: number;
}

interface FatVolumeInternal {
  image: Uint8Array;
  imageOffset: number;
  bytesPerSector: number;
  sectorsPerCluster: number;
  reservedSectors: number;
  numFats: number;
  rootEntries: number;
  sectorsPerFat: number;
  totalSectors: number;
  fatType: 'FAT12' | 'FAT16';
  fatStartByte: number;
  rootStartByte: number;
  rootDirBytes: number;
  dataStartByte: number;
  totalClusters: number;
  bytesPerCluster: number;
  fat16BigEndian: boolean;
}

/** 内部用の不透明ハンドル。openFat() の戻り値をそのまま他の関数へ渡すこと。 */
export type FatVolume = FatVolumeInternal;

const VALID_SECTOR_SIZES = [128, 256, 512, 1024, 2048];
const DIR_ENTRY_SIZE = 32;
const ATTR_VOLUME_LABEL = 0x08;
const ATTR_DIRECTORY = 0x10;
const ATTR_LFN = 0x0f;
const DELETED_MARK = 0xe5;
const FREE_MARK = 0x00;

// --- 低レベルバイト操作(サブ配列でも安全に動くよう手動でLE演算する) -------

function readU16(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8);
}
function readU32(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}
function readU16BE(buf: Uint8Array, off: number): number {
  return (buf[off] << 8) | buf[off + 1];
}
function readU32BE(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}
function writeU16(buf: Uint8Array, off: number, val: number): void {
  buf[off] = val & 0xff;
  buf[off + 1] = (val >> 8) & 0xff;
}
function writeU32(buf: Uint8Array, off: number, val: number): void {
  buf[off] = val & 0xff;
  buf[off + 1] = (val >>> 8) & 0xff;
  buf[off + 2] = (val >>> 16) & 0xff;
  buf[off + 3] = (val >>> 24) & 0xff;
}
function writeU16BE(buf: Uint8Array, off: number, val: number): void {
  buf[off] = (val >> 8) & 0xff;
  buf[off + 1] = val & 0xff;
}
function writeU32BE(buf: Uint8Array, off: number, val: number): void {
  buf[off] = (val >>> 24) & 0xff;
  buf[off + 1] = (val >>> 16) & 0xff;
  buf[off + 2] = (val >>> 8) & 0xff;
  buf[off + 3] = val & 0xff;
}

// --- ブートセクタ(BPB)解析 -------------------------------------------

/**
 * ディスクイメージのブートセクタからBPBを読み取り、FatVolumeを構築する。
 * offset はイメージ先頭からブートセクタまでのバイトオフセット(既定0)。
 */
export function openFat(image: Uint8Array, offset = 0): FatVolume {
  if (image.length < offset + 512) {
    throw new DiskError('notFormatted', `openFat: image too small (${image.length} bytes)`);
  }
  const b = image;
  const o = offset;

  const human68k = isHuman68kBootSector(b, o);
  const bytesPerSector = human68k ? readU16BE(b, o + 0x12) : readU16(b, o + 11);
  const sectorsPerCluster = b[o + (human68k ? 0x14 : 13)];
  const reservedSectors = human68k ? readU16BE(b, o + 0x16) : readU16(b, o + 14);
  const numFats = b[o + (human68k ? 0x15 : 16)];
  const rootEntries = human68k ? readU16BE(b, o + 0x18) : readU16(b, o + 17);
  const totalSectors16 = human68k ? readU16BE(b, o + 0x1a) : readU16(b, o + 19);
  const sectorsPerFat = human68k ? b[o + 0x1d] : readU16(b, o + 22);
  // Human68k形式でも32bit総セクタ数(+0x1e、BE)を読む。createFormattedHdd()の40MBパーティション
  // (総セクタ40960)は16bit値に収まるため以前はここが常に0で問題にならなかったが、
  // createFormattedScsi()の大きいパーティションは16bit値(+0x1a)が0で32bit値だけが有効になる
  // (実測: twopart.HDS、docs/STORAGE-SCSI.md参照)。ここを直さないと大きいSCSIパーティションが
  // 「total sectors=0」で開けなくなる。
  const totalSectors32 = human68k ? readU32BE(b, o + 0x1e) : readU32(b, o + 32);
  const totalSectors = totalSectors16 !== 0 ? totalSectors16 : totalSectors32;

  if (!VALID_SECTOR_SIZES.includes(bytesPerSector)) {
    throw new DiskError('notFormatted', `openFat: invalid BPB (bytes/sector=${bytesPerSector})`);
  }
  if (sectorsPerCluster === 0) {
    throw new DiskError('notFormatted', 'openFat: invalid BPB (sectors/cluster=0)');
  }
  if (numFats === 0) {
    throw new DiskError('notFormatted', 'openFat: invalid BPB (FAT count=0)');
  }
  if (sectorsPerFat === 0) {
    throw new DiskError('notFormatted', 'openFat: invalid BPB (sectors/FAT=0)');
  }
  if (totalSectors === 0) {
    throw new DiskError('notFormatted', 'openFat: invalid BPB (total sectors=0)');
  }

  const rootDirSectors = Math.ceil((rootEntries * DIR_ENTRY_SIZE) / bytesPerSector);
  const fatStartSector = reservedSectors;
  const rootStartSector = fatStartSector + numFats * sectorsPerFat;
  const dataStartSector = rootStartSector + rootDirSectors;
  const dataSectors = totalSectors - dataStartSector;
  const totalClusters = Math.floor(dataSectors / sectorsPerCluster);
  const fatType: 'FAT12' | 'FAT16' = totalClusters < 4085 ? 'FAT12' : 'FAT16';

  const volumeEnd = o + totalSectors * bytesPerSector;
  if (dataSectors < 0 || volumeEnd > image.length) {
    throw new DiskError('notFormatted', `openFat: BPB volume exceeds image (${volumeEnd} > ${image.length})`);
  }

  return {
    image,
    imageOffset: offset,
    bytesPerSector,
    sectorsPerCluster,
    reservedSectors,
    numFats,
    rootEntries,
    sectorsPerFat,
    totalSectors,
    fatType,
    fatStartByte: o + fatStartSector * bytesPerSector,
    rootStartByte: o + rootStartSector * bytesPerSector,
    rootDirBytes: rootDirSectors * bytesPerSector,
    dataStartByte: o + dataStartSector * bytesPerSector,
    totalClusters,
    bytesPerCluster: sectorsPerCluster * bytesPerSector,
    fat16BigEndian: human68k,
  };
}

/** Human68k HDDのブートセクタ(2バイト分岐命令 + 印字可能な16バイトOEM名)か判定する。 */
function isHuman68kBootSector(image: Uint8Array, offset: number): boolean {
  if (offset < 0 || offset + 0x1e > image.length || image[offset] !== 0x60) return false;
  for (let i = 0; i < 16; i++) {
    const c = image[offset + 2 + i];
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

// --- FAT テーブル読み書き ------------------------------------------------

const EOC_MARK: Record<'FAT12' | 'FAT16', number> = { FAT12: 0xfff, FAT16: 0xffff };

function readFatEntry(vol: FatVolume, cluster: number): number {
  const base = vol.fatStartByte;
  if (vol.fatType === 'FAT12') {
    const off = base + Math.floor((cluster * 3) / 2);
    const lo = vol.image[off];
    const hi = vol.image[off + 1];
    if (cluster % 2 === 0) {
      return lo | ((hi & 0x0f) << 8);
    }
    return (lo >> 4) | (hi << 4);
  }
  const off = base + cluster * 2;
  return vol.fat16BigEndian ? readU16BE(vol.image, off) : readU16(vol.image, off);
}

/** FATエントリを更新する。仕様どおり全FATコピーに同じ内容を書く。 */
function writeFatEntry(vol: FatVolume, cluster: number, value: number): void {
  for (let f = 0; f < vol.numFats; f++) {
    const base = vol.fatStartByte + f * vol.sectorsPerFat * vol.bytesPerSector;
    if (vol.fatType === 'FAT12') {
      const off = base + Math.floor((cluster * 3) / 2);
      if (cluster % 2 === 0) {
        vol.image[off] = value & 0xff;
        vol.image[off + 1] = (vol.image[off + 1] & 0xf0) | ((value >> 8) & 0x0f);
      } else {
        vol.image[off] = (vol.image[off] & 0x0f) | ((value << 4) & 0xf0);
        vol.image[off + 1] = (value >> 4) & 0xff;
      }
    } else {
      const off = base + cluster * 2;
      if (vol.fat16BigEndian) writeU16BE(vol.image, off, value & 0xffff);
      else writeU16(vol.image, off, value & 0xffff);
    }
  }
}

function isEocOrBad(vol: FatVolume, entry: number): boolean {
  if (vol.fatType === 'FAT12') return entry >= 0xff7;
  return entry >= 0xfff7;
}

function isFree(entry: number): boolean {
  return entry === 0;
}

/** クラスタ番号からデータ領域内の絶対バイトオフセットを求める。 */
function clusterToByteOffset(vol: FatVolume, cluster: number): number {
  return vol.dataStartByte + (cluster - 2) * vol.bytesPerCluster;
}

/** クラスタチェーンを辿り、クラスタ番号の配列を返す。ループ検出のためvisitedで防御する。 */
function getClusterChain(vol: FatVolume, startCluster: number): number[] {
  const chain: number[] = [];
  const visited = new Set<number>();
  let cluster = startCluster;
  while (cluster >= 2 && !isEocOrBad(vol, cluster) && !isFree(cluster)) {
    if (visited.has(cluster)) break; // 壊れたチェーン(ループ)対策
    visited.add(cluster);
    chain.push(cluster);
    cluster = readFatEntry(vol, cluster);
  }
  return chain;
}

function findFreeClusters(vol: FatVolume, count: number): number[] {
  const free: number[] = [];
  for (let c = 2; c < vol.totalClusters + 2 && free.length < count; c++) {
    if (isFree(readFatEntry(vol, c))) free.push(c);
  }
  if (free.length < count) {
    throw new Error(
      `fatWriteFile: not enough free space (need ${count} cluster(s), found ${free.length})`,
    );
  }
  return free;
}

function freeChain(vol: FatVolume, startCluster: number): void {
  if (startCluster < 2) return;
  const chain = getClusterChain(vol, startCluster);
  for (const c of chain) {
    writeFatEntry(vol, c, 0);
  }
}

// --- 名前(8.3)処理 -------------------------------------------------------

/** "NAME.EXT" 形式の8.3名を rawName(8byte)/rawExt(3byte) に正規化する。 */
function to83Raw(name: string): { rawName: Uint8Array; rawExt: Uint8Array; display: string } {
  const upper = name.toUpperCase();
  const dot = upper.lastIndexOf('.');
  const base = dot >= 0 ? upper.slice(0, dot) : upper;
  const ext = dot >= 0 ? upper.slice(dot + 1) : '';
  if (base.length === 0 || base.length > 8 || ext.length > 3) {
    throw new DiskError('invalidShortName', `invalid 8.3 filename: ${name}`, { name });
  }
  const rawName = new Uint8Array(8).fill(0x20);
  const rawExt = new Uint8Array(3).fill(0x20);
  for (let i = 0; i < base.length; i++) rawName[i] = base.charCodeAt(i) & 0xff;
  for (let i = 0; i < ext.length; i++) rawExt[i] = ext.charCodeAt(i) & 0xff;
  const display = ext.length > 0 ? `${base}.${ext}` : base;
  return { rawName, rawExt, display };
}

/**
 * ディレクトリエントリの名前を文字列へ復元する。
 *
 * Human68k のファイル名は Shift_JIS で、しかも **MS-DOS が予約している 12〜21 バイト目を
 * 名前の続きとして使う**(8+10 バイト + 拡張子3バイト)。1バイトずつ char に変換すると
 * 日本語名が化けるうえ、8バイトで切れてしまう。
 *
 * 予約領域は VFAT では作成日時等が入るため、名前の続きとして扱うのは
 * 全バイトが 0x20 以上(印字可能/SJIS)のときだけにして、標準的な FAT イメージを壊さないようにする。
 */
function decodeEntryName(rawName: Uint8Array, rawNameExt: Uint8Array | null): string {
  const bytes = new Uint8Array(rawName.length + (rawNameExt ? rawNameExt.length : 0));
  bytes.set(rawName, 0);
  if (rawNameExt) bytes.set(rawNameExt, rawName.length);
  // 末尾のパディング(空白/NUL)を落としてから SJIS として解釈する。
  // 8バイト目と9バイト目にまたがる SJIS 文字があるため、連結してからデコードすること。
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0x00)) end--;
  return decodeSjis(bytes.subarray(0, end));
}

/**
 * 予約領域(12〜21)から Human68k のファイル名拡張部分を取り出す。使えなければ null。
 *
 * 余りのパディングは NUL のことも空白のこともあるので、**先頭から最初の NUL までを名前**とし、
 * 残りはパディングとして捨てる。全バイトが 0x20 以上であることを条件にすると、
 * 実機ディスクでよくある NUL 埋め(例: `8f 91 00 00 ...`)を取りこぼす。
 *
 * 標準的な FAT では 12バイト目は VFAT の NT フラグ(0x00/0x08/0x10/0x18)で必ず 0x20 未満なので、
 * ここが 0x20 以上であることを「Human68k の名前拡張である」判定に使える。
 */
function nameExtBytes(rawNameExt: Uint8Array): Uint8Array | null {
  if (rawNameExt.length === 0 || rawNameExt[0] < 0x20) return null;
  let end = 0;
  while (end < rawNameExt.length && rawNameExt[end] !== 0x00) end++;
  return end > 0 ? rawNameExt.subarray(0, end) : null;
}

/** 32バイトのディレクトリエントリ先頭オフセットから表示名を組み立てる。 */
function entryDisplayName(image: Uint8Array, off: number): string {
  const rawNameExt = image.subarray(off + 12, off + 22);
  const base = decodeEntryName(image.subarray(off, off + 8), nameExtBytes(rawNameExt));
  const ext = decodeEntryName(image.subarray(off + 8, off + 11), null);
  return ext.length > 0 ? `${base}.${ext}` : base;
}

function namesEqual(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

/** パスを '\\'/'/' 両対応で分割し、空要素を除いたセグメント配列を返す。 */
function splitPath(path: string): string[] {
  return path
    .split(/[\\/]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// --- ディレクトリ走査 -----------------------------------------------------

interface DirSlot {
  offset: number; // vol.image内の絶対バイトオフセット(32バイトエントリの先頭)
}

/** dirCluster が null ならルート、それ以外はクラスタチェーンからスロット一覧を作る。 */
function getDirectorySlots(vol: FatVolume, dirCluster: number | null): DirSlot[] {
  const slots: DirSlot[] = [];
  if (dirCluster === null) {
    for (let i = 0; i < vol.rootEntries; i++) {
      slots.push({ offset: vol.rootStartByte + i * DIR_ENTRY_SIZE });
    }
    return slots;
  }
  const chain = getClusterChain(vol, dirCluster);
  const entriesPerCluster = Math.floor(vol.bytesPerCluster / DIR_ENTRY_SIZE);
  for (const cluster of chain) {
    const base = clusterToByteOffset(vol, cluster);
    for (let i = 0; i < entriesPerCluster; i++) {
      slots.push({ offset: base + i * DIR_ENTRY_SIZE });
    }
  }
  return slots;
}

interface ParsedDirEntry {
  slotIndex: number;
  offset: number;
  attr: number;
  name: string; // "NAME.EXT" 表示形式
  cluster: number;
  size: number;
  mtime: number;
}

function decodeDosDateTime(image: Uint8Array, dateOff: number, timeOff: number): number {
  const date = readU16(image, dateOff);
  const time = readU16(image, timeOff);
  const year = 1980 + ((date >> 9) & 0x7f);
  const month = (date >> 5) & 0x0f;
  const day = date & 0x1f;
  const hour = (time >> 11) & 0x1f;
  const min = (time >> 5) & 0x3f;
  const sec = (time & 0x1f) * 2;
  if (month === 0 || day === 0) return 0;
  return new Date(year, month - 1, day, hour, min, sec).getTime();
}

function encodeDosDateTime(image: Uint8Array, dateOff: number, timeOff: number, when: Date): void {
  const date = (((when.getFullYear() - 1980) & 0x7f) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2);
  writeU16(image, dateOff, date);
  writeU16(image, timeOff, time);
}

/** 1件の生ディレクトリスロットをパースする。LFN/ボリュームラベル/削除済み/未使用はnull。 */
function parseSlot(vol: FatVolume, slot: DirSlot, slotIndex: number): ParsedDirEntry | null {
  const b = vol.image;
  const off = slot.offset;
  const first = b[off];
  if (first === FREE_MARK || first === DELETED_MARK) return null;
  const attr = b[off + 11];
  if (attr === ATTR_LFN) return null; // LFNエントリは非対応・スキップ
  if (attr & ATTR_VOLUME_LABEL) return null;

  const name = entryDisplayName(b, off);
  if (name === '.' || name === '..') return null;

  const cluster = readU16(b, off + 26);
  const size = readU32(b, off + 28);
  const mtime = decodeDosDateTime(b, off + 24, off + 22);

  return { slotIndex, offset: off, attr, name, cluster, size, mtime };
}

function listDirEntries(vol: FatVolume, dirCluster: number | null): ParsedDirEntry[] {
  const slots = getDirectorySlots(vol, dirCluster);
  const entries: ParsedDirEntry[] = [];
  for (let i = 0; i < slots.length; i++) {
    // 0x00 はそれ以降すべて未使用であることを示す(標準的なFAT仕様の慣習)。
    if (vol.image[slots[i].offset] === FREE_MARK) break;
    const parsed = parseSlot(vol, slots[i], i);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

/** ディレクトリを名前で辿り、全セグメントをディレクトリとして解決した dirCluster (nullならルート) を返す。 */
function resolveDirCluster(vol: FatVolume, segments: string[]): number | null {
  let dirCluster: number | null = null;
  for (let i = 0; i < segments.length; i++) {
    const target = to83Raw(segments[i]).display;
    const entries = listDirEntries(vol, dirCluster);
    const found = entries.find((e) => namesEqual(e.name, target));
    if (!found) throw new Error(`directory not found: ${segments.slice(0, i + 1).join('/')}`);
    if (!(found.attr & ATTR_DIRECTORY)) {
      throw new Error(`not a directory: ${segments.slice(0, i + 1).join('/')}`);
    }
    dirCluster = found.cluster;
  }
  return dirCluster;
}

/** ディレクトリを名前で辿り、最終セグメント(ファイル名)手前までの dirCluster (nullならルート) を返す。 */
function resolveParentDir(vol: FatVolume, segments: string[]): number | null {
  return resolveDirCluster(vol, segments.slice(0, -1));
}

// --- FDIヘッダ対応 ---------------------------------------------------------

const FDI_DEFAULT_HEADER_SIZE = 4096;
// SASI/.hdf形式: パーティションテーブルがオフセット0x400、単位256バイト。
const HUMAN68K_PARTITION_TABLE_OFFSET = 0x400;
const HUMAN68K_PARTITION_ENTRY_OFFSET = 0x410;
const HUMAN68K_PARTITION_ENTRY_SIZE = 16;
const HUMAN68K_BLOCK_SIZE = 256;
// SCSI(.hds)形式: LBA0に"X68SCSI1"ヘッダがあり、パーティションテーブルは
// オフセット0x800(=LBA4、物理512バイトセクタ単位)、テーブル内の単位は1024バイト
// (実測: twopart.HDS、docs/STORAGE-SCSI.md参照)。SASI形式とはテーブル位置・単位の
// 両方が異なるため、同じ走査ロジックにテーブルオフセット/ブロックサイズを渡して共用する。
const SCSI_HEADER_MAGIC = 'X68SCSI1';
const SCSI_PARTITION_TABLE_OFFSET = 0x800;
const SCSI_PARTITION_ENTRY_OFFSET = SCSI_PARTITION_TABLE_OFFSET + 0x10;
const SCSI_PARTITION_ENTRY_SIZE = 16;
const SCSI_TABLE_BLOCK_SIZE = 1024;

interface Human68kPartition {
  name: string;
  offset: number;
  size: number;
}

/** オフセット0x400にHuman68kのX68Kパーティションテーブルシグネチャがあるか(HDDの内容ベース判定に使う)。 */
export function hasHuman68kPartitionSignature(image: Uint8Array): boolean {
  return hasX68kTableSignatureAt(image, HUMAN68K_PARTITION_TABLE_OFFSET);
}

/** オフセット0に"X68SCSI1"シグネチャがあるか(SCSI(.hds)形式の内容ベース判定に使う)。 */
export function hasScsiHeaderSignature(image: Uint8Array): boolean {
  if (image.length < SCSI_HEADER_MAGIC.length) return false;
  for (let i = 0; i < SCSI_HEADER_MAGIC.length; i++) {
    if (image[i] !== SCSI_HEADER_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

function hasX68kTableSignatureAt(image: Uint8Array, table: number): boolean {
  return (
    image.length >= table + 4 &&
    image[table] === 0x58 &&
    image[table + 1] === 0x36 &&
    image[table + 2] === 0x38 &&
    image[table + 3] === 0x4b
  );
}

/**
 * X68Kパーティションテーブルを走査し、範囲内にあるエントリを順番どおり返す。
 * `table`/`entryOffset`/`blockSize` を渡すことでSASI(0x400・256B単位)と
 * SCSI(0x800・1024B単位)の両方に対応する。
 */
function parseHuman68kPartitionsAt(
  image: Uint8Array,
  table: number,
  entryOffset: number,
  entrySize: number,
  blockSize: number,
): Human68kPartition[] {
  if (image.length < entryOffset + entrySize || !hasX68kTableSignatureAt(image, table)) {
    return [];
  }

  const totalBytes = readU32BE(image, table + 4) * blockSize;
  if (totalBytes === 0 || totalBytes > image.length) {
    throw new DiskError('hddInvalidHeader', 'X68Kパーティションテーブルのサイズが不正です', {
      format: 'X68K',
    });
  }

  const partitions: Human68kPartition[] = [];
  for (let entry = entryOffset; entry + entrySize <= image.length; entry += entrySize) {
    if (image[entry] === 0) break;
    let name = '';
    for (let i = 0; i < 8 && image[entry + i] !== 0; i++) name += String.fromCharCode(image[entry + i]);
    const startBlock = ((image[entry + 9] << 16) | (image[entry + 10] << 8) | image[entry + 11]) >>> 0;
    const blockCount = readU32BE(image, entry + 12);
    const offset = startBlock * blockSize;
    const size = blockCount * blockSize;
    if (startBlock !== 0 && blockCount !== 0 && offset + size <= image.length) {
      partitions.push({ name: name.trimEnd(), offset, size });
    }
  }
  return partitions;
}

/** SASI(.hdf)形式のX68Kパーティションテーブル(オフセット0x400・256B単位)を走査する。 */
function parseHuman68kPartitions(image: Uint8Array): Human68kPartition[] {
  return parseHuman68kPartitionsAt(
    image,
    HUMAN68K_PARTITION_TABLE_OFFSET,
    HUMAN68K_PARTITION_ENTRY_OFFSET,
    HUMAN68K_PARTITION_ENTRY_SIZE,
    HUMAN68K_BLOCK_SIZE,
  );
}

/** SCSI(.hds)形式のX68Kパーティションテーブル(オフセット0x800・1024B単位)を走査する。 */
function parseScsiPartitions(image: Uint8Array): Human68kPartition[] {
  if (!hasScsiHeaderSignature(image)) return [];
  return parseHuman68kPartitionsAt(
    image,
    SCSI_PARTITION_TABLE_OFFSET,
    SCSI_PARTITION_ENTRY_OFFSET,
    SCSI_PARTITION_ENTRY_SIZE,
    SCSI_TABLE_BLOCK_SIZE,
  );
}

/**
 * 拡張子に応じてディスクイメージを開く。
 * - .fdi: FDIヘッダ(offset+8=ヘッダサイズLE32, offset+12=FDDサイズLE32)を読み取り、
 *   妥当ならそのヘッダサイズをoffsetとしてopenFatを呼ぶ。不正なら既定4096固定にフォールバックする。
 * - .d88: 編集非対応としてErrorを投げる。
 * - X68Kパーティションテーブル: 最初のHuman68kブートセクタを持つパーティションを開く。
 * - それ以外(.xdf/.hdm/.dup/.fdd等): ベタイメージとしてoffset=0でopenFatを呼ぶ。
 */
export function openDiskImage(image: Uint8Array, fileName: string): FatVolume {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.d88')) {
    throw new DiskError('d88NotEditable', 'D88形式は編集非対応です');
  }
  if (lower.endsWith('.fdi')) {
    let headerSize = FDI_DEFAULT_HEADER_SIZE;
    if (image.length >= 16) {
      const candidateHeaderSize = readU32(image, 8);
      const candidateFddSize = readU32(image, 12);
      const valid =
        candidateHeaderSize >= 16 &&
        candidateHeaderSize < image.length &&
        candidateFddSize > 0 &&
        candidateHeaderSize + candidateFddSize <= image.length;
      if (valid) {
        headerSize = candidateHeaderSize;
      }
    }
    return openFat(image, headerSize);
  }
  // SCSI(.hds、"X68SCSI1"ヘッダ付き)を先に試す。SASIのテーブル(0x400)と場所・単位が
  // 異なるため、どちらの形式かは"X68SCSI1"シグネチャの有無で切り分ける。
  const partitions = hasScsiHeaderSignature(image) ? parseScsiPartitions(image) : parseHuman68kPartitions(image);
  if (partitions.length > 0) {
    const partition = partitions.find((candidate) => isHuman68kBootSector(image, candidate.offset));
    if (!partition) {
      throw new DiskError('hddNoFatPartition', 'Human68k形式のパーティションが見つかりません');
    }
    const volume = openFat(image, partition.offset);
    if (volume.totalSectors * volume.bytesPerSector > partition.size) {
      throw new DiskError(
        'hddInvalidHeader',
        `Human68kパーティション「${partition.name}」のBPBサイズが範囲を超えています`,
        { name: partition.name },
      );
    }
    return volume;
  }
  return openFat(image, 0);
}

// --- FAT12フォーマット済みブランクFD生成 ------------------------------------

/** ブランクFD生成でサポートするX68000標準フォーマットの識別子。 */
export type BlankFdFormatId = '2hd1232' | '2hd1440' | '2dd640' | '2dd720';

interface FdGeometry {
  bytesPerSector: number;
  sectorsPerTrack: number;
  cylinders: number;
  heads: number;
  totalSectors: number;
  media: number;
  rootEntries: number;
  sectorsPerCluster: number;
  sectorsPerFat: number;
}

/** X68000標準フォーマットのジオメトリ定数(BPBにそのまま書き込む値)。 */
const FD_GEOMETRIES: Record<BlankFdFormatId, FdGeometry> = {
  // 1024B/sector × 8sector/track × 77cylinder × 2head = 1232KB/1,261,568byte(XDF標準)。
  '2hd1232': {
    bytesPerSector: 1024,
    sectorsPerTrack: 8,
    cylinders: 77,
    heads: 2,
    totalSectors: 1232,
    media: 0xfe,
    rootEntries: 192,
    sectorsPerCluster: 1,
    sectorsPerFat: 2,
  },
  '2hd1440': {
    bytesPerSector: 512,
    sectorsPerTrack: 18,
    cylinders: 80,
    heads: 2,
    totalSectors: 2880,
    media: 0xf0,
    rootEntries: 224,
    sectorsPerCluster: 1,
    sectorsPerFat: 9,
  },
  '2dd640': {
    bytesPerSector: 512,
    sectorsPerTrack: 8,
    cylinders: 80,
    heads: 2,
    totalSectors: 1280,
    media: 0xfb,
    rootEntries: 112,
    sectorsPerCluster: 2,
    sectorsPerFat: 2,
  },
  '2dd720': {
    bytesPerSector: 512,
    sectorsPerTrack: 9,
    cylinders: 80,
    heads: 2,
    totalSectors: 1440,
    media: 0xf9,
    rootEntries: 112,
    sectorsPerCluster: 2,
    sectorsPerFat: 3,
  },
};

/**
 * X68000標準フォーマット(既定は2HD 1232KB)のFAT12フォーマット済みベタイメージを新規生成する。
 * Human68k側でのFORMATが不要な、そのままFATとして読み書きできるブランクFDを返す。
 */
export function createFormattedFd(formatId: BlankFdFormatId = '2hd1232'): Uint8Array {
  const geometry = FD_GEOMETRIES[formatId];
  const {
    bytesPerSector,
    sectorsPerTrack,
    cylinders,
    heads,
    totalSectors,
    media,
    rootEntries,
    sectorsPerCluster,
    sectorsPerFat,
  } = geometry;
  const reservedSectors = 1;
  const numFats = 2;

  const totalBytes = bytesPerSector * sectorsPerTrack * cylinders * heads;
  const image = new Uint8Array(totalBytes);

  // ブートセクタ(BPB)
  image[0] = 0xeb; // ジャンプ命令(ダミー)
  image[1] = 0xfe;
  image[2] = 0x90;
  writeU16(image, 11, bytesPerSector);
  image[13] = sectorsPerCluster;
  writeU16(image, 14, reservedSectors);
  image[16] = numFats;
  writeU16(image, 17, rootEntries);
  writeU16(image, 19, totalSectors);
  image[21] = media;
  writeU16(image, 22, sectorsPerFat);
  writeU16(image, 24, sectorsPerTrack);
  writeU16(image, 26, heads);
  writeU32(image, 32, 0);
  // ブートシグネチャ
  image[510] = 0x55;
  image[511] = 0xaa;

  // FAT先頭: media byte + 0xFF*2 (クラスタ0/1の予約領域、FAT12は12bit単位で3バイト)。
  const fatStartByte = reservedSectors * bytesPerSector;
  for (let f = 0; f < numFats; f++) {
    const base = fatStartByte + f * sectorsPerFat * bytesPerSector;
    image[base] = media;
    image[base + 1] = 0xff;
    image[base + 2] = 0xff;
  }

  return image;
}

// --- Human68k HDD向けFAT16フォーマット済みブランクイメージ生成 --------------

/**
 * px68k-libretro の SASI 実装(x68k/sasi.c)はヘッダ無しのベタイメージを
 * 256バイト固定ブロックの通しLBAで読み書きし、シリンダ/ヘッド等のジオメトリは
 * 一切参照しない(SASI_Sectorは21bit値をそのまま`<<8`してseekするだけ)。
 * そのため実機的なCHS制約は無く、上限は 2^21 blocks × 256B ≒ 512MB。
 * ここでは実用的な容量として40MB(WebNP2のcreateFormattedHdd()が選んだ
 * SASI標準40MBと同じ考え方)を採用する。
 */
const HDD_BLOCK_SIZE = HUMAN68K_BLOCK_SIZE; // 256B。パーティションテーブルのオフセット単位と同じ。
/** パーティション本体開始位置。テーブル領域(0x400〜)の後ろに余裕を持たせて8ブロック目からにする。 */
const HDD_PARTITION_START_BLOCK = 8;
// パーティション名は必ず 'Human68k' にすること。Human68k はこの名前のパーティションを
// 探してドライブレターを割り当てるため、別名だとゲストから一切見えない
// (実機吸い出しイメージの 0x410 も "Human68k" になっている)。
const HDD_PARTITION_NAME = 'Human68k';

/** パーティション内BPB(Human68k形式・BE)のジオメトリ。 */
const HDD_BYTES_PER_SECTOR = 1024;
/**
 * **1 固定にすること**。Human68k は HDD パーティションを 1セクタ=1クラスタ前提で扱い、
 * BPB の sectorsPerCluster を尊重せずに自前で sectorsPerFat を算出する。8 等にすると
 * Human68k が計算するルートディレクトリ位置(reserved + numFats × sectorsPerFat)が
 * こちらの書き込み位置とズレ、「お互いのファイルが見えない」状態になる
 * (実測: spc=8 だと Human68k は spf=81 として root を 0x29400 に置き、こちらは
 * spf=10 で 0x5C00 に置いていた)。実機フォーマット済みイメージも spc=1 / spf=80。
 */
const HDD_SECTORS_PER_CLUSTER = 1;
const HDD_RESERVED_SECTORS = 1;
const HDD_NUM_FATS = 2;
const HDD_ROOT_ENTRIES = 512;
const HDD_TOTAL_SECTORS = 40960; // 1024B/sector × 40960 = 40MB。BE16のtotalSectors16に収まる(<65536)。
const HDD_MEDIA_BYTE = 0xf8; // 固定ディスク
const HDD_PARTITION_BYTES = HDD_TOTAL_SECTORS * HDD_BYTES_PER_SECTOR;

/**
 * sectorsPerFat を求める。
 *
 * **Human68k と同じ式にすること**。Human68k は BPB の sectorsPerFat をそのまま信じず、
 * 「総セクタ数ぶんのクラスタを表現できるFAT16サイズ」= ceil((totalSectors + 2) × 2 / bytesPerSector)
 * として自前で算出し、ルートディレクトリ位置(reserved + numFats × sectorsPerFat)を決める。
 * データクラスタ数から最小値を求める一般的なFAT実装の式だと1セクタ小さくなり、
 * ルート位置が numFats × 1 セクタぶんズレて「お互いのファイルが見えない」状態になる
 * (実測: こちらが spf=80 で root を 0x28C00 に、Human68k は spf=81 で 0x29400 に置いていた)。
 * 実機フォーマット済みイメージ(総セクタ40510)もこの式どおり spf=80 になっている。
 *
 * Human68k BPBの sectorsPerFat は1バイトのため255以下に収まっている必要がある。
 */
function computeHdd16SectorsPerFat(): number {
  return Math.ceil(((HDD_TOTAL_SECTORS + 2) * 2) / HDD_BYTES_PER_SECTOR);
}

/**
 * Human68k形式(パーティションテーブル + FAT16)でフォーマット済みのブランクHDDイメージを
 * 新規生成する。IPLの実体は持たないためHDD単体では起動できず、FDからHuman68kを
 * 起動したうえでデータドライブとして使う想定でよい。
 *
 * 既存の読み取り実装(parseHuman68kPartitions/openFat)が使う定数・オフセット・
 * エンディアンをそのまま流用し、その「逆」(生成)を行う:
 * - オフセット0x400から"X68K"シグネチャ + パーティションテーブル(256Bブロック単位)
 * - パーティション先頭にHuman68k形式BPB(オフセット0x12からBE)
 * - FAT16本体(BE)
 * - ルートディレクトリは全ゼロ(=空)のまま
 */
export function createFormattedHdd(): Uint8Array {
  const sectorsPerFat = computeHdd16SectorsPerFat();
  const partitionStartByte = HDD_PARTITION_START_BLOCK * HDD_BLOCK_SIZE;
  const totalBytes = partitionStartByte + HDD_PARTITION_BYTES;
  const image = new Uint8Array(totalBytes);

  // パーティションテーブルヘッダ("X68K"シグネチャ + ディスク全体のブロック数)。
  const table = HUMAN68K_PARTITION_TABLE_OFFSET;
  image[table] = 0x58; // 'X'
  image[table + 1] = 0x36; // '6'
  image[table + 2] = 0x38; // '8'
  image[table + 3] = 0x4b; // 'K'
  writeU32BE(image, table + 4, totalBytes / HDD_BLOCK_SIZE);

  // パーティションエントリ(1個のみ、ディスク全体を1パーティションとして使う)。
  const entry = HUMAN68K_PARTITION_ENTRY_OFFSET;
  for (let i = 0; i < 8; i++) {
    image[entry + i] = i < HDD_PARTITION_NAME.length ? HDD_PARTITION_NAME.charCodeAt(i) : 0;
  }
  const startBlock = partitionStartByte / HDD_BLOCK_SIZE;
  const blockCount = HDD_PARTITION_BYTES / HDD_BLOCK_SIZE;
  image[entry + 9] = (startBlock >> 16) & 0xff;
  image[entry + 10] = (startBlock >> 8) & 0xff;
  image[entry + 11] = startBlock & 0xff;
  writeU32BE(image, entry + 12, blockCount);

  // パーティション先頭のブートセクタ(Human68k形式BPB)。
  const p = partitionStartByte;
  image[p] = 0x60; // isHuman68kBootSector()が判定に使う分岐命令
  image[p + 1] = 0x00;
  const oem = 'Human68k HDD    '.slice(0, 16);
  for (let i = 0; i < 16; i++) image[p + 2 + i] = oem.charCodeAt(i);
  writeU16BE(image, p + 0x12, HDD_BYTES_PER_SECTOR);
  image[p + 0x14] = HDD_SECTORS_PER_CLUSTER;
  image[p + 0x15] = HDD_NUM_FATS;
  writeU16BE(image, p + 0x16, HDD_RESERVED_SECTORS);
  writeU16BE(image, p + 0x18, HDD_ROOT_ENTRIES);
  writeU16BE(image, p + 0x1a, HDD_TOTAL_SECTORS);
  image[p + 0x1c] = HDD_MEDIA_BYTE; // 実機フォーマット済みイメージと同じ 0xF8。書き忘れると 0x00 になる
  image[p + 0x1d] = sectorsPerFat;
  image[p + 510] = 0x55;
  image[p + 511] = 0xaa;

  // FAT先頭の予約エントリ(メディアバイト + EOC)。Human68kはFAT16もBEで格納する。
  const fatStartByte = p + HDD_RESERVED_SECTORS * HDD_BYTES_PER_SECTOR;
  for (let f = 0; f < HDD_NUM_FATS; f++) {
    const base = fatStartByte + f * sectorsPerFat * HDD_BYTES_PER_SECTOR;
    writeU16BE(image, base, 0xff00 | HDD_MEDIA_BYTE);
    writeU16BE(image, base + 2, 0xffff);
  }

  return image;
}

// --- Human68k SCSI(.hds)向けFAT16フォーマット済みブランクイメージ生成 -------
//
// createFormattedHdd()(SASI・256Bブロック単位・ヘッダ無し40MB固定)とは別形式。
// 実機のFORMAT.Xが作ったSCSIハードディスク(twopart.HDS)を実測して確定させた:
//   - LBA0(先頭512バイト)に"X68SCSI1"ヘッダ(物理セクタサイズ・総ブロック数・機種名)
//   - オフセット0x800(=LBA4)からX68Kパーティションテーブル(1024バイト単位・BE)
//   - パーティション先頭にHuman68k形式BPB(SASIと同じオフセット規約、値だけ異なる)
// SASIとはテーブル位置・単位・BPBの値(spc/媒体バイト/sectorsPerFatの式)が異なるため、
// 定数・関数とも完全に分離し、どちらかを直すときにもう片方を壊さないようにする。

/** SCSIブランク作成でサポートするサイズの下限(MiB)。小さすぎるとFAT16として意味を成さない。 */
export const SCSI_BLANK_MIN_MIB = 1;
/**
 * SCSIブランク作成でサポートするサイズの上限(MiB)。
 *
 * FAT16のクラスタ数上限(65524)やBPBのsectorsPerFat(1バイト、255以下)から来る制約では
 * ない(sectorsPerClusterを増やせば回避できるため、後述のcomputeScsiFatLayout()が
 * 自動的に大きいクラスタへ切り替える)。実際に効いているのはSCSI HLE側の制約で、
 * src/core-shim.c の js_scsi_get_size() がイメージサイズを符号付き32bit整数(int)で
 * 返しており、0x7fffffff(2147483647バイト)を超える値は同じ関数内でその値へ
 * クランプされる。作成時のサイズとコアが後で認識するサイズが食い違うと、
 * 末尾が切り詰められたのに気づかないまま静かに壊れることになるため、
 * MiB単位で切り下げた2047MiB(2146435072バイト、0x7fffffff未満)を上限にする。
 */
export const SCSI_BLANK_MAX_MIB = 2047;

const SCSI_HEADER_MODEL = 'WebX68k SCSI'; // 実機の機種名文字列は写さず、自前の識別子にする
const SCSI_PHYS_SECTOR_SIZE = 512; // LBA0ヘッダの単位(実測)
const SCSI_PARTITION_START_1K_BLOCK = 32; // 実測(twopart.HDS)と同じパーティション開始位置
const SCSI_BYTES_PER_SECTOR = 1024; // パーティション内BPBのセクタサイズ(実測)
const SCSI_NUM_FATS = 2;
const SCSI_RESERVED_SECTORS = 1;
const SCSI_ROOT_ENTRIES = 512;
const SCSI_MEDIA_BYTE = 0xf7; // 実測(twopart.HDS)。createFormattedHdd()の0xF8とは異なる値
const SCSI_PARTITION_NAME = 'Human68k'; // Human68kがドライブレターを割り当てる条件(HDDと同じ)
const FAT16_MAX_CLUSTERS = 65524; // FAT16として扱われる上限(これを超えるとFAT32扱いになる)
const SCSI_MAX_SECTORS_PER_CLUSTER = 128; // sectorsPerClusterは1バイトかつ通常2の冪(実用上の上限)

export type ScsiBlankSizeInvalidReason = 'notANumber' | 'notInteger' | 'tooSmall' | 'tooLarge';

export type ScsiBlankSizeValidation =
  | { ok: true; sizeMiB: number }
  | { ok: false; reason: ScsiBlankSizeInvalidReason };

/**
 * SCSIブランク作成のサイズ入力(MB単位、文字列)を検証する。UIの `prompt()` から渡された
 * 生の文字列をそのまま受け取り、非数値・小数・整数だが範囲外を理由付きで弾く。
 * DOM非依存の純粋関数として切り出してあり単体テスト可能。
 */
export function validateScsiBlankSizeMiB(input: string): ScsiBlankSizeValidation {
  const trimmed = input.trim();
  if (trimmed === '' || !/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return { ok: false, reason: 'notANumber' };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { ok: false, reason: 'notANumber' };
  if (!Number.isInteger(value)) return { ok: false, reason: 'notInteger' };
  if (value < SCSI_BLANK_MIN_MIB) return { ok: false, reason: 'tooSmall' };
  if (value > SCSI_BLANK_MAX_MIB) return { ok: false, reason: 'tooLarge' };
  return { ok: true, sizeMiB: value };
}

/**
 * sectorsPerCluster(spc)・sectorsPerFatを決める。
 *
 * Human68kはBPBのspcを尊重せず自前でsectorsPerFatを計算するが、createFormattedHdd()の
 * コメントにある式(総セクタ数から `ceil((totalSectors+2)*2/bytesPerSector)`)は
 * spc=1のときだけ成り立つ特殊解である。実測(twopart.HDS、spc=2・99MB区画=101376個の
 * 1KBセクタ)では sectorsPerFat=100 だった。ここで使われている「クラスタ数」は
 * reserved/FAT/root分を差し引いた実データ領域のクラスタ数ではなく、
 * `floor(総セクタ数 / spc)` (このケースでは 101376/2 = 50688) をそのまま使うと
 * `ceil((50688+2)*2/1024) = 100` に一致する。すなわちspc=1の特殊解
 * (`ceil((totalSectors+2)*2/bytesPerSector)`、spc=1なのでtotalSectors=クラスタ数)を
 * 一般のspcへそのまま拡張した式であり、実データ領域を差し引く二段階計算にすると
 * (小さいサイズで顕著に)1ずれる。sectorsPerCluster もこの同じ近似クラスタ数
 * (`floor(totalSectors/spc)`)がFAT16の上限(65524)に収まる最小の2の冪を選ぶ
 * (docs/STORAGE-SCSI.md「BPBを基準器イメージから写した」節参照)。
 */
function computeScsiFatLayout(totalSectors: number): {
  sectorsPerCluster: number;
  sectorsPerFat: number;
  totalClusters: number;
} {
  for (let sectorsPerCluster = 1; sectorsPerCluster <= SCSI_MAX_SECTORS_PER_CLUSTER; sectorsPerCluster *= 2) {
    const totalClusters = Math.floor(totalSectors / sectorsPerCluster);
    if (totalClusters > 0 && totalClusters <= FAT16_MAX_CLUSTERS) {
      const sectorsPerFat = Math.ceil(((totalClusters + 2) * 2) / SCSI_BYTES_PER_SECTOR);
      if (sectorsPerFat > 255) {
        // BPBのsectorsPerFatは1バイト。理論上ここに来る前にSCSI_BLANK_MAX_MIBで
        // 弾かれているはずだが、定数を変えたときの安全策として残す。
        throw new DiskError('scsiSizeInvalid', `sectorsPerFatが255を超えます(${sectorsPerFat})`);
      }
      return { sectorsPerCluster, sectorsPerFat, totalClusters };
    }
  }
  throw new DiskError('scsiSizeInvalid', `sectorsPerClusterの上限(${SCSI_MAX_SECTORS_PER_CLUSTER})でもFAT16のクラスタ数上限に収まりません`);
}

/**
 * Human68k形式(SCSI、"X68SCSI1"ヘッダ + X68Kパーティションテーブル + FAT16)で
 * フォーマット済みのブランクイメージを新規生成する。1パーティション固定(複数区画は非対応)。
 * IPLの実体は持たないため単体では起動できず、FDからHuman68kを起動したうえで
 * データドライブとして使う想定(createFormattedHdd()と同じ)。
 *
 * `sizeMiB` は事前に validateScsiBlankSizeMiB() で検証済みの整数(SCSI_BLANK_MIN_MIB〜
 * SCSI_BLANK_MAX_MIB)を渡すこと。範囲外はここでも DiskError('scsiSizeInvalid') を投げる。
 */
export function createFormattedScsi(sizeMiB: number): Uint8Array {
  if (
    !Number.isInteger(sizeMiB) ||
    sizeMiB < SCSI_BLANK_MIN_MIB ||
    sizeMiB > SCSI_BLANK_MAX_MIB
  ) {
    throw new DiskError('scsiSizeInvalid', `createFormattedScsi: sizeMiB out of range (${sizeMiB})`);
  }

  const partitionStartByte = SCSI_PARTITION_START_1K_BLOCK * SCSI_TABLE_BLOCK_SIZE;
  const partitionBytes = sizeMiB * 1024 * 1024;
  const totalBytes = partitionStartByte + partitionBytes;
  const image = new Uint8Array(totalBytes);

  // LBA0: "X68SCSI1"ヘッダ。
  for (let i = 0; i < SCSI_HEADER_MAGIC.length; i++) image[i] = SCSI_HEADER_MAGIC.charCodeAt(i);
  writeU16BE(image, 8, SCSI_PHYS_SECTOR_SIZE);
  writeU32BE(image, 10, totalBytes / SCSI_PHYS_SECTOR_SIZE - 1);
  for (let i = 0; i < SCSI_HEADER_MODEL.length; i++) image[16 + i] = SCSI_HEADER_MODEL.charCodeAt(i);

  // パーティションテーブル(オフセット0x800、1024バイト単位・BE)。
  const table = SCSI_PARTITION_TABLE_OFFSET;
  image[table] = 0x58; // 'X'
  image[table + 1] = 0x36; // '6'
  image[table + 2] = 0x38; // '8'
  image[table + 3] = 0x4b; // 'K'
  // +4(使用済み末尾ブロック)と+8/+12(総1KBブロック数-1)は別の値。実測(twopart.HDS)では
  // +4=203808(=総ブロック数そのもの)、+8=+12=203807(=総ブロック数-1)で、
  // 両者はちょうど1違う。ここを両方とも同じ値(total-1)にすると、Human68kの整合性検査に
  // 引っかかって「ディスクの管理領域が壊されています」を起こすことを実機(実ブラウザでの
  // Human68k起動)で確認した(docs/STORAGE-SCSI.md参照)。
  const total1kBlocks = totalBytes / SCSI_TABLE_BLOCK_SIZE;
  writeU32BE(image, table + 4, total1kBlocks);
  writeU32BE(image, table + 8, total1kBlocks - 1);
  writeU32BE(image, table + 12, total1kBlocks - 1);

  // パーティションエントリ(1個のみ、ディスク全体を1パーティションとして使う)。
  const entry = SCSI_PARTITION_ENTRY_OFFSET;
  for (let i = 0; i < 8; i++) {
    image[entry + i] = i < SCSI_PARTITION_NAME.length ? SCSI_PARTITION_NAME.charCodeAt(i) : 0;
  }
  writeU32BE(image, entry + 8, SCSI_PARTITION_START_1K_BLOCK);
  writeU32BE(image, entry + 12, partitionBytes / SCSI_TABLE_BLOCK_SIZE);

  // パーティション先頭のブートセクタ(Human68k形式BPB)。
  const totalSectors = partitionBytes / SCSI_BYTES_PER_SECTOR;
  const { sectorsPerCluster, sectorsPerFat } = computeScsiFatLayout(totalSectors);

  const p = partitionStartByte;
  image[p] = 0x60; // isHuman68kBootSector()が判定に使う分岐命令(ダミー)
  image[p + 1] = 0x00;
  const oem = 'WebX68k SCSI    '.slice(0, 16); // 実機のSHARP文字列は写さず、自前の識別子にする
  for (let i = 0; i < 16; i++) image[p + 2 + i] = oem.charCodeAt(i);
  writeU16BE(image, p + 0x12, SCSI_BYTES_PER_SECTOR);
  image[p + 0x14] = sectorsPerCluster;
  image[p + 0x15] = SCSI_NUM_FATS;
  writeU16BE(image, p + 0x16, SCSI_RESERVED_SECTORS);
  writeU16BE(image, p + 0x18, SCSI_ROOT_ENTRIES);
  writeU16BE(image, p + 0x1a, 0); // 16bit総セクタ数は使わない(実測どおり0)
  image[p + 0x1c] = SCSI_MEDIA_BYTE; // 実測 0xF7。createFormattedHdd()の0xF8とは異なる
  image[p + 0x1d] = sectorsPerFat;
  writeU32BE(image, p + 0x1e, totalSectors); // 32bit総セクタ数(実測どおりこちらが有効値)
  writeU32BE(image, p + 0x22, SCSI_PARTITION_START_1K_BLOCK); // 区画の開始ブロック(1KB単位)
  image[p + 510] = 0x55;
  image[p + 511] = 0xaa;

  // FAT先頭の予約エントリ(メディアバイト + EOC)。
  //
  // createFormattedHdd()(SASI)は「Human68kはFAT16もBEで格納する」という前提で
  // writeU16BE(base, 0xff00|media)(バイト列 [0xFF, media])を書いているが、
  // 実測(twopart.HDS)のSCSI区画の予約エントリは [media, 0xFF] という逆順だった
  // (chain本体(クラスタ2以降、entry+4以降)は 00 03/00 04/... と連番でBEそのものなので、
  // BE/LEの解釈自体が違うのではなく、予約エントリ0の値そのものが `0xFF00|media` ではなく
  // `(media<<8)|0xFF` になっている、という食い違い)。ここを直さずに実ブラウザでHuman68kへ
  // copyすると「ディスクの管理領域が壊されています」で拒否されることを実測で確認した。
  // 論理値の抽象化(writeU16BE)を介さず、実測したバイト列をそのまま書く。
  const fatStartByte = p + SCSI_RESERVED_SECTORS * SCSI_BYTES_PER_SECTOR;
  for (let f = 0; f < SCSI_NUM_FATS; f++) {
    const base = fatStartByte + f * sectorsPerFat * SCSI_BYTES_PER_SECTOR;
    image[base] = SCSI_MEDIA_BYTE;
    image[base + 1] = 0xff;
    image[base + 2] = 0xff;
    image[base + 3] = 0xff;
  }

  return image;
}

// --- 公開API ---------------------------------------------------------------

/** path='' または '/' でルート。指定ディレクトリ直下のエントリ一覧を返す。 */
export function fatList(vol: FatVolume, path: string): FatEntry[] {
  const segments = splitPath(path);
  const dirCluster = resolveDirCluster(vol, segments);
  const entries = listDirEntries(vol, dirCluster);
  return entries.map((e) => ({
    name: e.name,
    size: e.size,
    isDir: (e.attr & ATTR_DIRECTORY) !== 0,
    cluster: e.cluster,
    mtime: e.mtime,
  }));
}

function findFileEntry(vol: FatVolume, path: string): { dirCluster: number | null; entry: ParsedDirEntry } {
  const segments = splitPath(path);
  if (segments.length === 0) throw new Error('empty file path');
  const dirCluster = resolveParentDir(vol, segments);
  const filename = to83Raw(segments[segments.length - 1]).display;
  const entries = listDirEntries(vol, dirCluster);
  const found = entries.find((e) => namesEqual(e.name, filename));
  if (!found) throw new Error(`file not found: ${path}`);
  return { dirCluster, entry: found };
}

export function fatReadFile(vol: FatVolume, path: string): Uint8Array {
  const { entry } = findFileEntry(vol, path);
  if (entry.attr & ATTR_DIRECTORY) throw new Error(`is a directory: ${path}`);
  if (entry.size === 0 || entry.cluster === 0) return new Uint8Array(0);

  const chain = getClusterChain(vol, entry.cluster);
  const out = new Uint8Array(entry.size);
  let written = 0;
  for (const cluster of chain) {
    if (written >= entry.size) break;
    const base = clusterToByteOffset(vol, cluster);
    const take = Math.min(vol.bytesPerCluster, entry.size - written);
    out.set(vol.image.subarray(base, base + take), written);
    written += take;
  }
  if (written < entry.size) {
    throw new Error(`fatReadFile: cluster chain shorter than file size for ${path}`);
  }
  return out;
}

export function fatWriteFile(vol: FatVolume, path: string, data: Uint8Array): void {
  const segments = splitPath(path);
  if (segments.length === 0) throw new Error('empty file path');
  const dirCluster = resolveParentDir(vol, segments);
  const { display, rawName, rawExt } = to83Raw(segments[segments.length - 1]);

  const slots = getDirectorySlots(vol, dirCluster);
  let targetSlotIndex = -1;
  let existingCluster = 0;

  // 既存エントリを探す(0x00で終わりだが、削除済み0xE5は飛ばして継続走査)。
  for (let i = 0; i < slots.length; i++) {
    const b0 = vol.image[slots[i].offset];
    if (b0 === FREE_MARK) break;
    if (b0 === DELETED_MARK) continue;
    const attr = vol.image[slots[i].offset + 11];
    if (attr === ATTR_LFN || attr & ATTR_VOLUME_LABEL) continue;
    const name = entryDisplayName(vol.image, slots[i].offset);
    if (namesEqual(name, display)) {
      targetSlotIndex = i;
      existingCluster = readU16(vol.image, slots[i].offset + 26);
      break;
    }
  }

  // 見つからなければ空きスロット(0x00 or 0xE5)を探す。
  if (targetSlotIndex < 0) {
    for (let i = 0; i < slots.length; i++) {
      const b0 = vol.image[slots[i].offset];
      if (b0 === FREE_MARK || b0 === DELETED_MARK) {
        targetSlotIndex = i;
        break;
      }
    }
    if (targetSlotIndex < 0) {
      throw new Error(`fatWriteFile: directory is full, cannot create ${path}`);
    }
  }

  // 既存チェーンを解放する前に空き容量を計算(上書きの場合は解放後の空きで再計算)。
  if (existingCluster >= 2) {
    freeChain(vol, existingCluster);
  }

  const neededClusters = data.length === 0 ? 0 : Math.ceil(data.length / vol.bytesPerCluster);
  const clusters = neededClusters > 0 ? findFreeClusters(vol, neededClusters) : [];

  // クラスタチェーンを構築して書き込む。
  let written = 0;
  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    const isLast = i === clusters.length - 1;
    writeFatEntry(vol, cluster, isLast ? EOC_MARK[vol.fatType] : clusters[i + 1]);
    const base = clusterToByteOffset(vol, cluster);
    const take = Math.min(vol.bytesPerCluster, data.length - written);
    vol.image.set(data.subarray(written, written + take), base);
    if (take < vol.bytesPerCluster) {
      vol.image.fill(0, base + take, base + vol.bytesPerCluster);
    }
    written += take;
  }

  // ディレクトリエントリを書く。
  const off = slots[targetSlotIndex].offset;
  vol.image.set(rawName, off);
  vol.image.set(rawExt, off + 8);
  vol.image[off + 11] = 0x20; // archive attribute
  vol.image.fill(0, off + 12, off + 22); // Human68k拡張名/MS-DOS予約フィールドは未使用
  encodeDosDateTime(vol.image, off + 24, off + 22, new Date());
  writeU16(vol.image, off + 26, clusters.length > 0 ? clusters[0] : 0);
  writeU32(vol.image, off + 28, data.length);
}

/** ディレクトリエントリ1件を生の32バイトフォーマットで書き込む(共通処理)。 */
function writeRawDirEntry(
  vol: FatVolume,
  offset: number,
  rawName: Uint8Array,
  rawExt: Uint8Array,
  attr: number,
  cluster: number,
  size: number,
  when: Date,
): void {
  vol.image.set(rawName, offset);
  vol.image.set(rawExt, offset + 8);
  vol.image[offset + 11] = attr;
  vol.image.fill(0, offset + 12, offset + 22); // Human68k拡張名/MS-DOS予約フィールドは未使用
  encodeDosDateTime(vol.image, offset + 24, offset + 22, when);
  writeU16(vol.image, offset + 26, cluster);
  writeU32(vol.image, offset + 28, size);
}

/** "."/".." 用の rawName/rawExt (8.3形式外の特殊名なので to83Raw は使えない)。 */
function dotRawName(dots: 1 | 2): { rawName: Uint8Array; rawExt: Uint8Array } {
  const rawName = new Uint8Array(8).fill(0x20);
  for (let i = 0; i < dots; i++) rawName[i] = 0x2e; // '.'
  const rawExt = new Uint8Array(3).fill(0x20);
  return { rawName, rawExt };
}

/**
 * ディレクトリを新規作成する。クラスタを1つ確保して先頭に「.」「..」エントリを書き、
 * 親ディレクトリに ATTR_DIRECTORY 属性のエントリを追加する。
 * ルート直下に作成する場合、".." の startCluster は 0 (ルートを指す慣習) とする。
 */
export function fatMakeDir(vol: FatVolume, path: string): void {
  const segments = splitPath(path);
  if (segments.length === 0) throw new Error('empty directory path');
  const parentDirCluster = resolveParentDir(vol, segments);
  const { display, rawName, rawExt } = to83Raw(segments[segments.length - 1]);

  const existingEntries = listDirEntries(vol, parentDirCluster);
  if (existingEntries.some((e) => namesEqual(e.name, display))) {
    throw new Error(`fatMakeDir: already exists: ${path}`);
  }

  const [newCluster] = findFreeClusters(vol, 1);
  writeFatEntry(vol, newCluster, EOC_MARK[vol.fatType]);

  const base = clusterToByteOffset(vol, newCluster);
  vol.image.fill(0, base, base + vol.bytesPerCluster);

  const now = new Date();
  const dot = dotRawName(1);
  const dotdot = dotRawName(2);
  writeRawDirEntry(vol, base, dot.rawName, dot.rawExt, ATTR_DIRECTORY, newCluster, 0, now);
  writeRawDirEntry(
    vol,
    base + DIR_ENTRY_SIZE,
    dotdot.rawName,
    dotdot.rawExt,
    ATTR_DIRECTORY,
    parentDirCluster ?? 0,
    0,
    now,
  );

  // 親ディレクトリに空きスロット(0x00 or 0xE5)を探して新規エントリを追加する。
  const slots = getDirectorySlots(vol, parentDirCluster);
  let targetSlotIndex = -1;
  for (let i = 0; i < slots.length; i++) {
    const b0 = vol.image[slots[i].offset];
    if (b0 === FREE_MARK || b0 === DELETED_MARK) {
      targetSlotIndex = i;
      break;
    }
  }
  if (targetSlotIndex < 0) {
    throw new Error(`fatMakeDir: directory is full, cannot create ${path}`);
  }
  writeRawDirEntry(vol, slots[targetSlotIndex].offset, rawName, rawExt, ATTR_DIRECTORY, newCluster, 0, now);
}

export function fatDeleteFile(vol: FatVolume, path: string): void {
  const { entry } = findFileEntry(vol, path);
  if (entry.attr & ATTR_DIRECTORY) throw new Error(`is a directory: ${path}`);
  if (entry.cluster >= 2) {
    freeChain(vol, entry.cluster);
  }
  vol.image[entry.offset] = DELETED_MARK;
}

export function fatFreeSpace(vol: FatVolume): { total: number; free: number } {
  let free = 0;
  for (let c = 2; c < vol.totalClusters + 2; c++) {
    if (isFree(readFatEntry(vol, c))) free++;
  }
  return {
    total: vol.totalClusters * vol.bytesPerCluster,
    free: free * vol.bytesPerCluster,
  };
}
