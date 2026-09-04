// 使い捨ての生成スクリプト(調査用)。SASI(成功する側)とSCSI(失敗する側)へ
// 「同一内容・同一サイズ」の試験片を1組作る。
//
// 目的: 従来はSASI実行とSCSI実行を別プロセスで走らせて比べており、条件が
// 揃っていなかった(この文書に、条件の欠落で計測を2回まるごと無効にした
// 記録がある)。両方を同時にマウントして「同じ起動・同じHuman68k・同じ
// バッファ」の中で C: と D: へ同じ操作を行うため、対になる2枚を作る。
//
// 使い方:
//   ./node_modules/.bin/vite-node scripts/_gen-pair-fixtures.mts <出力先の接頭辞>
// 出力: <接頭辞>-sasi.hds / <接頭辞>-scsi.hds
//
// 中身はどちらも SRC2.DAT(1500B) と DST2.DAT(1500B)。DST2 を SRC2 で上書き
// コピーすると、端数セクタの書き戻しが出るかどうかが1行で読める試験片になる。
import { writeFileSync } from 'node:fs';
import { createFormattedHdd, createFormattedScsi, openDiskImage, fatWriteFile, fatList } from '../src/api/fat.ts';

const prefix = process.argv[2];
if (!prefix) {
  console.error('使い方: vite-node scripts/_gen-pair-fixtures.mts <出力先の接頭辞>');
  process.exit(1);
}

const SIZE = 1500;
const src = new Uint8Array(SIZE);
for (let i = 0; i < SIZE; i++) src[i] = (i * 7 + 1) & 0xff;
// DST2 は SRC2 と別の中身にしておく(上書きが本当に起きたかを中身で見分けるため)
const dst = new Uint8Array(SIZE);
for (let i = 0; i < SIZE; i++) dst[i] = (i * 13 + 200) & 0xff;

function build(image: Uint8Array, out: string, label: string) {
  const vol = openDiskImage(image, out);
  fatWriteFile(vol, 'SRC2.DAT', src);
  fatWriteFile(vol, 'DST2.DAT', dst);
  const listed = fatList(openDiskImage(image, out), '\\');
  const names = listed.map((e) => `${e.name}(${e.size})`).join(' ');
  writeFileSync(out, image);
  console.error(`[gen] ${label}: ${out} (${image.length} バイト) 収録=${names}`);
}

build(createFormattedHdd(), `${prefix}-sasi.hds`, 'SASI(40MB)');
build(createFormattedScsi(8), `${prefix}-scsi.hds`, 'SCSI(8MiB)');
