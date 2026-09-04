// 使い捨ての生成スクリプト(調査用)。createFormattedHdd()のブランク(SASI)に、
// ホスト側で複数ファイルを一度に書き込む。実行のたびに作り直すこと。
//
// 使い方:
//   ./node_modules/.bin/vite-node scripts/_gen-sasi-multi.mts <出力先.hds> <name1>:<size1>:<fillbyte1> [<name2>:<size2>:<fillbyte2> ...]
//
// fillbyte は0-255の整数。省略時は名前ごとに0xA1から1ずつ増やす。
import { writeFileSync } from 'node:fs';
import { createFormattedHdd, openDiskImage, fatWriteFile, fatList } from '../src/api/fat.ts';

const [, , out, ...specs] = process.argv;
if (!out || specs.length === 0) {
  console.error(
    '使い方: vite-node scripts/_gen-sasi-multi.mts <出力先.hds> <name>:<size>:<fillbyte> ...',
  );
  process.exit(1);
}
const image = createFormattedHdd();
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
console.error(`[gen] ${out} (${image.length} バイト, SASI) に ${specs.length} ファイルを書き込んだ`);

writeFileSync(out, image);
