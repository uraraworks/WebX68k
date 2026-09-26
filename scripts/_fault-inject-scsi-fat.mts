// SCSI起動 段階3(docs/STORAGE-SCSI.md)の調査用: _verify-scsi-fat.mts の検出力(陽性対照)を
// 確かめるための故障注入。読み返したイメージのCOMMAND.Xの中身を1バイト変え、検証が
// 「不変のはず」の判定を正しく落とせるかを確認する。この故障注入自体はFAT経由で書くため
// サイズは変えず、クラスタ配置も変化しない(内容比較の検出力だけを確かめる)。
// 使い方: vite-node scripts/_fault-inject-scsi-fat.mts <入力hds> <出力hds>
import { readFileSync, writeFileSync } from 'node:fs';
import { openDiskImage, fatReadFile, fatWriteFile } from '../src/api/fat.ts';

const [, , inPath, outPath] = process.argv;
const buf = new Uint8Array(readFileSync(inPath));
const vol = openDiskImage(buf, 'scsi0.hds');
const orig = fatReadFile(vol, 'COMMAND.X');
const corrupted = new Uint8Array(orig);
corrupted[100] ^= 0xff; // 中身のどこか1バイトを反転(サイズは変えない)
fatWriteFile(vol, 'COMMAND.X', corrupted);
writeFileSync(outPath, Buffer.from(vol.image));
console.log('COMMAND.X offset100 を反転して書き出した:', outPath);
