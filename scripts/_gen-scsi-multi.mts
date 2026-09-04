// 使い捨ての生成スクリプト(調査用)。createFormattedScsi(N)のブランクに、
// ホスト側で複数ファイルを一度に書き込む。実行のたびに作り直すこと。
//
// 使い方:
//   ./node_modules/.bin/vite-node scripts/_gen-scsi-multi.mts <出力先.hds> <サイズMiB> <name1>:<size1>:<fillbyte1> [<name2>:<size2>:<fillbyte2> ...]
//
// fillbyte は0-255の整数。省略時は名前ごとに0xA1から1ずつ増やす。
import { writeFileSync } from 'node:fs';
import { createFormattedScsi, openDiskImage, fatWriteFile, fatList } from '../src/api/fat.ts';

const [, , out, sizeMiBStr, ...specs] = process.argv;
if (!out || !sizeMiBStr || specs.length === 0) {
  console.error(
    '使い方: vite-node scripts/_gen-scsi-multi.mts <出力先.hds> <サイズMiB> <name>:<size>:<fillbyte> ...',
  );
  process.exit(1);
}
const sizeMiB = Number(sizeMiBStr);
const image = createFormattedScsi(sizeMiB);
const vol = openDiskImage(image, out);

let fill = 0xa1;
for (const spec of specs) {
  const [name, sizeStr, fillStr] = spec.split(':');
  const size = Number(sizeStr);
  const fillByte = fillStr !== undefined ? Number(fillStr) : fill++;
  const data = new Uint8Array(size);
  data.fill(fillByte & 0xff);
  fatWriteFile(vol, name, data);
  console.error(`[gen] ${name} (${size} バイト, fill=0x${(fillByte & 0xff).toString(16)}) を書き込んだ`);
}

// 直後に開き直して、置いた全ファイルが正しいサイズで見えるかを確認する。
const reopened = openDiskImage(image, out);
const listing = fatList(reopened, '\\');
for (const spec of specs) {
  const [name, sizeStr] = spec.split(':');
  const size = Number(sizeStr);
  const entry = listing.find((e) => e.name.toUpperCase() === name.toUpperCase());
  if (!entry) {
    console.error(`[gen] 書き込み直後の再読み出しでファイルが見つからない: ${name}`);
    process.exit(1);
  }
  if (entry.size !== size) {
    console.error(`[gen] サイズ不一致: ${name} 期待=${size} 実際=${entry.size}`);
    process.exit(1);
  }
}
console.error(`[gen] ${out} (${image.length} バイト, ${sizeMiB}MiB) に ${specs.length} ファイルを書き込んだ`);

writeFileSync(out, image);
