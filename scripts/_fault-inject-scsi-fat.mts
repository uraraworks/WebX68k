// SCSI起動 段階3(docs/STORAGE-SCSI.md)の調査用: _verify-scsi-fat.mts / _verify-scsi-fat-grow.mts
// の検出力(陽性対照)を確かめるための故障注入。読み返したイメージの指定ファイルの中身を
// 1バイト変え、検証が「不変のはず」の判定を正しく落とせるかを確認する。この故障注入自体は
// FAT経由で書くためサイズは変えず、クラスタ配置も変化しない(内容比較の検出力だけを確かめる)。
// 使い方: vite-node scripts/_fault-inject-scsi-fat.mts <入力hds> <出力hds> [対象ファイル(既定COMMAND.X)] [反転するオフセット(既定100)]
import { readFileSync, writeFileSync } from 'node:fs';
import { openDiskImage, fatReadFile, fatWriteFile } from '../src/api/fat.ts';

const [, , inPath, outPath, targetArg, offsetArg] = process.argv;
const target = targetArg ?? 'COMMAND.X';
const offset = offsetArg !== undefined ? Number(offsetArg) : 100;
const buf = new Uint8Array(readFileSync(inPath));
const vol = openDiskImage(buf, 'scsi0.hds');
const orig = fatReadFile(vol, target);
if (offset >= orig.length) throw new Error(`offset(${offset})がファイルサイズ(${orig.length})を超えています`);
const corrupted = new Uint8Array(orig);
corrupted[offset] ^= 0xff; // 中身のどこか1バイトを反転(サイズは変えない)
fatWriteFile(vol, target, corrupted);
writeFileSync(outPath, Buffer.from(vol.image));
console.log(`${target} offset${offset} を反転して書き出した:`, outPath);
