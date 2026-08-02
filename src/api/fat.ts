// FAT12/FAT16 リーダ・ライタ。
// 移植元: WebNP2 (../PC98/WebNP2/src/api/fat.ts)。PC-98 の FD (2HD/2DD) ベタイメージ向けに
// 書かれたものだが、bytesPerSector はブートセクタの BPB から動的に読み取る実装のため
// X68000 の2HD(1024バイト/セクタ)もそのまま解釈できる。実際に human302.xdf(2HD/1024B
// セクタ)で読み書きを検証済み。X68000向けの変更点は createFormattedFd() のジオメトリのみ
// (PC-98の2HD 1.2MB用パラメータ → X68000の2HD 1232KB用パラメータに変更)。
// HDD(.hdf)は Human68k 独自のパーティションテーブル形式(シグネチャ"X68K")を持ち、
// パーティション先頭のブートセクタも標準のMS-DOS BPBレイアウトと異なる(ブランチ命令が
// 2バイト、OEM名が16バイト等)ため、本モジュールでは非対応(READMEに詳細記載)。
// FAT12/16・セクタサイズ等を自動判別し、8.3形式ファイルの列挙・読み書き・削除を行う。
// LFN(VFAT)エントリは列挙時にスキップする(非対応)。

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

// --- ブートセクタ(BPB)解析 -------------------------------------------

/**
 * ディスクイメージのブートセクタからBPBを読み取り、FatVolumeを構築する。
 * offset はイメージ先頭からブートセクタまでのバイトオフセット(既定0)。
 */
export function openFat(image: Uint8Array, offset = 0): FatVolume {
  if (image.length < offset + 512) {
    throw new Error(`openFat: image too small (${image.length} bytes)`);
  }
  const b = image;
  const o = offset;

  const bytesPerSector = readU16(b, o + 11);
  const sectorsPerCluster = b[o + 13];
  const reservedSectors = readU16(b, o + 14);
  const numFats = b[o + 16];
  const rootEntries = readU16(b, o + 17);
  const totalSectors16 = readU16(b, o + 19);
  const sectorsPerFat = readU16(b, o + 22);
  const totalSectors32 = readU32(b, o + 32);
  const totalSectors = totalSectors16 !== 0 ? totalSectors16 : totalSectors32;

  if (!VALID_SECTOR_SIZES.includes(bytesPerSector)) {
    throw new Error(`openFat: invalid BPB (bytes/sector=${bytesPerSector})`);
  }
  if (sectorsPerCluster === 0) {
    throw new Error('openFat: invalid BPB (sectors/cluster=0)');
  }
  if (numFats === 0) {
    throw new Error('openFat: invalid BPB (FAT count=0)');
  }
  if (sectorsPerFat === 0) {
    throw new Error('openFat: invalid BPB (sectors/FAT=0)');
  }
  if (totalSectors === 0) {
    throw new Error('openFat: invalid BPB (total sectors=0)');
  }

  const rootDirSectors = Math.ceil((rootEntries * DIR_ENTRY_SIZE) / bytesPerSector);
  const fatStartSector = reservedSectors;
  const rootStartSector = fatStartSector + numFats * sectorsPerFat;
  const dataStartSector = rootStartSector + rootDirSectors;
  const dataSectors = totalSectors - dataStartSector;
  const totalClusters = Math.floor(dataSectors / sectorsPerCluster);
  const fatType: 'FAT12' | 'FAT16' = totalClusters < 4085 ? 'FAT12' : 'FAT16';

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
  };
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
  return readU16(vol.image, off);
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
      writeU16(vol.image, off, value & 0xffff);
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
    throw new Error(`invalid 8.3 filename: ${name}`);
  }
  const rawName = new Uint8Array(8).fill(0x20);
  const rawExt = new Uint8Array(3).fill(0x20);
  for (let i = 0; i < base.length; i++) rawName[i] = base.charCodeAt(i) & 0xff;
  for (let i = 0; i < ext.length; i++) rawExt[i] = ext.charCodeAt(i) & 0xff;
  const display = ext.length > 0 ? `${base}.${ext}` : base;
  return { rawName, rawExt, display };
}

function rawTo83Display(rawName: Uint8Array, rawExt: Uint8Array): string {
  let base = '';
  for (let i = 0; i < 8; i++) {
    if (rawName[i] === 0x20) break;
    base += String.fromCharCode(rawName[i]);
  }
  let ext = '';
  for (let i = 0; i < 3; i++) {
    if (rawExt[i] === 0x20) break;
    ext += String.fromCharCode(rawExt[i]);
  }
  return ext.length > 0 ? `${base}.${ext}` : base;
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

  const rawName = b.subarray(off, off + 8);
  const rawExt = b.subarray(off + 8, off + 11);
  const name = rawTo83Display(rawName, rawExt);
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
    const found = entries.find((e) => e.name === target);
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

/**
 * 拡張子に応じてディスクイメージを開く。
 * - .fdi: FDIヘッダ(offset+8=ヘッダサイズLE32, offset+12=FDDサイズLE32)を読み取り、
 *   妥当ならそのヘッダサイズをoffsetとしてopenFatを呼ぶ。不正なら既定4096固定にフォールバックする。
 * - .d88: 編集非対応としてErrorを投げる。
 * - それ以外(.xdf/.hdm/.dup/.fdd等): ベタイメージとしてoffset=0でopenFatを呼ぶ。
 */
export function openDiskImage(image: Uint8Array, fileName: string): FatVolume {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.d88')) {
    throw new Error('D88形式は編集非対応です');
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
  return openFat(image, 0);
}

// --- FAT12フォーマット済みブランクFD生成 ------------------------------------

/** X68000 2HD(1024B/sector × 8sector/track × 77cylinder × 2head = 1232KB/1,261,568byte)のジオメトリ定数。 */
const FD_2HD_BYTES_PER_SECTOR = 1024;
const FD_2HD_SECTORS_PER_TRACK = 8;
const FD_2HD_CYLINDERS = 77;
const FD_2HD_HEADS = 2;
const FD_2HD_TOTAL_BYTES =
  FD_2HD_BYTES_PER_SECTOR * FD_2HD_SECTORS_PER_TRACK * FD_2HD_CYLINDERS * FD_2HD_HEADS;

/**
 * X68000 2HD(1232KB)のFAT12フォーマット済みベタイメージを新規生成する。
 * Human68k側でのFORMATが不要な、そのままFATとして読み書きできるブランクFDを返す。
 */
export function createFormattedFd(): Uint8Array {
  const bytesPerSector = FD_2HD_BYTES_PER_SECTOR;
  const sectorsPerCluster = 1;
  const reservedSectors = 1;
  const numFats = 2;
  const rootEntries = 192;
  const totalSectors = 1232;
  const media = 0xfe;
  const sectorsPerFat = 2;

  const image = new Uint8Array(FD_2HD_TOTAL_BYTES);

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
  writeU16(image, 24, FD_2HD_SECTORS_PER_TRACK);
  writeU16(image, 26, FD_2HD_HEADS);
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
  const found = entries.find((e) => e.name === filename);
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
    const name = rawTo83Display(
      vol.image.subarray(slots[i].offset, slots[i].offset + 8),
      vol.image.subarray(slots[i].offset + 8, slots[i].offset + 11),
    );
    if (name === display) {
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
  vol.image[off + 12] = 0;
  writeU16(vol.image, off + 14, 0); // creation time (未使用)
  writeU16(vol.image, off + 16, 0); // creation date (未使用)
  writeU16(vol.image, off + 18, 0); // last access date (未使用)
  writeU16(vol.image, off + 20, 0); // FAT32 high word (未使用)
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
  vol.image[offset + 12] = 0;
  writeU16(vol.image, offset + 14, 0); // creation time (未使用)
  writeU16(vol.image, offset + 16, 0); // creation date (未使用)
  writeU16(vol.image, offset + 18, 0); // last access date (未使用)
  writeU16(vol.image, offset + 20, 0); // FAT32 high word (未使用)
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
  if (existingEntries.some((e) => e.name === display)) {
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
