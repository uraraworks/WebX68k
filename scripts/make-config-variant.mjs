// 同梱システムディスク (public/system/human302.xdf) の CONFIG.SYS に行を追加した
// 「変種イメージ」を作るツール。SCSI 挙動の実測 (probe-scsi-iocs.mjs --fd1=...) で
// CONFIG.SYS の設定を変えて起動したいときに使う。
//
// 元ファイルは絶対に書き換えず、コピー上で編集して別パスへ書き出す。
// BPB はハードコードせず、毎回ファイルから読み取って解釈する(想定と食い違えばエラー終了)。
// FAT12/2HD 前提の最小実装で、CONFIG.SYS が単一クラスタに収まっている場合のみ対応する
// (実測: human302.xdf は 開始クラスタ=60, サイズ=468, 1クラスタ=1024バイトで単一クラスタ)。
//
// 使い方:
//   node scripts/make-config-variant.mjs --out=<出力パス> --line="SCSIDEV   = ON" [--line=...]
//   node scripts/make-config-variant.mjs --src=<元イメージ> --out=<出力パス> --line=...
//
// 出力後、書き出したファイルを同じパーサで読み直して CONFIG.SYS の中身を検証する
// (指定した行が全て含まれていなければ終了コード1で落ちる)。

import { readFileSync, writeFileSync } from 'node:fs';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const DEFAULT_SRC = `${REPO_ROOT}public/system/human302.xdf`;

// --- 引数パース -----------------------------------------------------------

function parseArgs(argv) {
  const out = { lines: [] };
  for (const a of argv) {
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`不明な引数です: ${a}`);
    const [, key, value] = m;
    if (key === 'line') {
      out.lines.push(value ?? '');
    } else {
      out[key] = value ?? 'true';
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.out) {
  console.error('使い方: node scripts/make-config-variant.mjs --out=<出力パス> --line="..." [--line=...]');
  process.exit(1);
}
if (args.lines.length === 0) {
  console.error('少なくとも1つ --line= を指定してください。');
  process.exit(1);
}
const SRC_PATH = args.src ?? DEFAULT_SRC;
const OUT_PATH = args.out;

// --- BPB / FAT12 の最小実装(src/api/fat.ts の非Human68kブートセクタ経路に準拠) -----

const DIR_ENTRY_SIZE = 32;

function readU16(buf, off) {
  return buf[off] | (buf[off + 1] << 8);
}
function readU32(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

function fail(message) {
  console.error(`[make-config-variant] エラー: ${message}`);
  process.exit(1);
}

function parseBpb(image) {
  if (image.length < 512) fail(`イメージが小さすぎます (${image.length} バイト)`);
  const bytesPerSector = readU16(image, 11);
  const sectorsPerCluster = image[13];
  const reservedSectors = readU16(image, 14);
  const numFats = image[16];
  const rootEntries = readU16(image, 17);
  const totalSectors16 = readU16(image, 19);
  const sectorsPerFat = readU16(image, 22);
  const totalSectors32 = readU32(image, 32);
  const totalSectors = totalSectors16 !== 0 ? totalSectors16 : totalSectors32;

  if (![128, 256, 512, 1024, 2048].includes(bytesPerSector)) {
    fail(`BPB不正 (bytes/sector=${bytesPerSector})`);
  }
  if (sectorsPerCluster === 0) fail('BPB不正 (sectors/cluster=0)');
  if (numFats === 0) fail('BPB不正 (FAT数=0)');
  if (sectorsPerFat === 0) fail('BPB不正 (sectors/FAT=0)');
  if (totalSectors === 0) fail('BPB不正 (total sectors=0)');

  const rootDirSectors = Math.ceil((rootEntries * DIR_ENTRY_SIZE) / bytesPerSector);
  const fatStartSector = reservedSectors;
  const rootStartSector = fatStartSector + numFats * sectorsPerFat;
  const dataStartSector = rootStartSector + rootDirSectors;
  const dataSectors = totalSectors - dataStartSector;
  const totalClusters = Math.floor(dataSectors / sectorsPerCluster);
  const fatType = totalClusters < 4085 ? 'FAT12' : 'FAT16';

  if (fatType !== 'FAT12') {
    fail(`このツールはFAT12専用です (判定結果: ${fatType})`);
  }

  const volumeEnd = totalSectors * bytesPerSector;
  if (dataSectors < 0 || volumeEnd > image.length) {
    fail(`BPBのボリュームサイズがイメージを超えています (${volumeEnd} > ${image.length})`);
  }

  return {
    bytesPerSector,
    sectorsPerCluster,
    reservedSectors,
    numFats,
    rootEntries,
    sectorsPerFat,
    totalSectors,
    fatType,
    fatStartByte: fatStartSector * bytesPerSector,
    rootStartByte: rootStartSector * bytesPerSector,
    rootDirBytes: rootDirSectors * bytesPerSector,
    dataStartByte: dataStartSector * bytesPerSector,
    totalClusters,
    bytesPerCluster: sectorsPerCluster * bytesPerSector,
  };
}

function readFat12Entry(image, vol, cluster) {
  const off = vol.fatStartByte + Math.floor((cluster * 3) / 2);
  const lo = image[off];
  const hi = image[off + 1];
  if (cluster % 2 === 0) {
    return lo | ((hi & 0x0f) << 8);
  }
  return (lo >> 4) | (hi << 4);
}

function isEoc12(entry) {
  return entry >= 0xff7;
}

/** ルートディレクトリから "CONFIG  SYS" (8.3の生の11バイト表現) を探す。 */
function findConfigSysEntry(image, vol) {
  const target = 'CONFIG  SYS';
  for (let i = 0; i < vol.rootEntries; i++) {
    const off = vol.rootStartByte + i * DIR_ENTRY_SIZE;
    const first = image[off];
    if (first === 0x00) break; // 以降エントリなし
    if (first === 0xe5) continue; // 削除済み
    const attr = image[off + 11];
    if (attr & 0x08) continue; // ボリュームラベル/LFN等は除外(0x08ビット)
    if (attr & 0x10) continue; // ディレクトリは対象外
    const rawName = Buffer.from(image.subarray(off, off + 11)).toString('latin1');
    if (rawName === target) {
      const cluster = readU16(image, off + 26);
      const size = readU32(image, off + 28);
      return { dirEntryOffset: off, cluster, size };
    }
  }
  return null;
}

// --- メイン処理 ------------------------------------------------------------

function loadAndParse(path) {
  const image = readFileSync(path);
  const vol = parseBpb(image);
  const entry = findConfigSysEntry(image, vol);
  if (!entry) fail('CONFIG.SYS がルートディレクトリに見つかりません');
  return { image, vol, entry };
}

const { image: srcImage, vol, entry } = loadAndParse(SRC_PATH);

if (entry.cluster < 2) fail(`CONFIG.SYS のクラスタ番号が不正です (${entry.cluster})`);

const fatEntry = readFat12Entry(srcImage, vol, entry.cluster);
if (!isEoc12(fatEntry)) {
  fail(
    `CONFIG.SYS が単一クラスタに収まっていません (FAT[${entry.cluster}]=0x${fatEntry.toString(16)} はEOCではない)。` +
      'このツールは単一クラスタのCONFIG.SYSのみ対応しています。',
  );
}

const clusterOffset = vol.dataStartByte + (entry.cluster - 2) * vol.bytesPerCluster;
const oldContent = Buffer.from(
  srcImage.subarray(clusterOffset, clusterOffset + entry.size),
);

const eofIdx = oldContent.lastIndexOf(0x1a);
if (eofIdx === -1) fail('CONFIG.SYS の末尾に EOF (0x1A) が見つかりません');

const insertion = Buffer.from(args.lines.map((l) => `${l}\r\n`).join(''), 'latin1');
const newContent = Buffer.concat([
  oldContent.subarray(0, eofIdx),
  insertion,
  oldContent.subarray(eofIdx), // 0x1A 以降(EOFとそれ以降のパディング)をそのまま残す
]);

if (newContent.length > vol.bytesPerCluster) {
  fail(
    `新しいCONFIG.SYSがクラスタサイズを超えます (${newContent.length} > ${vol.bytesPerCluster} バイト)`,
  );
}

// --- 出力用イメージを作成(元ファイルはコピー元として読むのみで書き換えない) -----

const outImage = Buffer.from(srcImage); // 独立したコピー

newContent.copy(outImage, clusterOffset);
// クラスタ末尾からデータ末尾までの余白は既存のパディングのまま(newContentが短ければ古いゴミが
// 残るが、サイズはディレクトリエントリで管理されるため実害はない)。ここでは新サイズぶんだけ
// 上書きすればよい。

// ディレクトリエントリのサイズ欄(offset+28, u32 LE)を更新する。
outImage.writeUInt32LE(newContent.length, entry.dirEntryOffset + 28);

writeFileSync(OUT_PATH, outImage);
console.log(`[make-config-variant] 書き出し完了: ${OUT_PATH} (CONFIG.SYS サイズ ${oldContent.length} -> ${newContent.length} バイト)`);

// --- 検証: 書き出したファイルを同じパーサで読み直す ---------------------------

const { image: verifyImage, vol: verifyVol, entry: verifyEntry } = loadAndParse(OUT_PATH);
const verifyOffset = verifyVol.dataStartByte + (verifyEntry.cluster - 2) * verifyVol.bytesPerCluster;
const verifyContent = Buffer.from(
  verifyImage.subarray(verifyOffset, verifyOffset + verifyEntry.size),
).toString('latin1');

console.log('--- 読み戻したCONFIG.SYSの内容 ---');
console.log(verifyContent);
console.log('--- ここまで ---');

const missing = args.lines.filter((l) => !verifyContent.includes(l));
if (missing.length > 0) {
  fail(`読み戻し検証に失敗: 以下の行が見つかりません: ${JSON.stringify(missing)}`);
}

console.log('[make-config-variant] 検証OK: 指定した行はすべて含まれています。');
