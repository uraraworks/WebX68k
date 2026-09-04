// 使い捨ての生成スクリプト(調査用)。createFormattedScsi(N)のブランクに、ホスト側で
// あらかじめ1ファイルを書き込んでおく。新規確保 vs 既存チェーン上書き の切り分けで、
// 「上書き」側を作るために使う(実行するたびに作り直すこと。使い回すと条件が変わる)。
//
// 使い方:
//   ./node_modules/.bin/vite-node scripts/_gen-scsi-with-file.mts <出力先.hds> <サイズMiB> <ファイル名> <ファイルサイズbytes> [シードファイル]
//
// シードファイルを指定すると、その先頭 <ファイルサイズbytes> バイトを内容として使う
// (指定なしなら 0..255 の繰り返しパターンで埋める)。
import { readFileSync, writeFileSync } from 'node:fs';
import { createFormattedScsi, openDiskImage, fatWriteFile, fatList } from '../src/api/fat.ts';

const [, , out, sizeMiBStr, fileName, fileSizeStr, seedPath] = process.argv;
if (!out || !sizeMiBStr || !fileName || !fileSizeStr) {
  console.error(
    '使い方: vite-node scripts/_gen-scsi-with-file.mts <出力先.hds> <サイズMiB> <ファイル名> <ファイルサイズbytes> [シードファイル]',
  );
  process.exit(1);
}
const sizeMiB = Number(sizeMiBStr);
const fileSize = Number(fileSizeStr);

const image = createFormattedScsi(sizeMiB);

let data: Uint8Array;
if (seedPath) {
  const seed = readFileSync(seedPath);
  if (seed.length < fileSize) {
    console.error(`シードファイルが短すぎる: ${seed.length} < ${fileSize}`);
    process.exit(1);
  }
  data = new Uint8Array(seed.subarray(0, fileSize));
} else {
  data = new Uint8Array(fileSize);
  for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
}

const vol = openDiskImage(image, out);
fatWriteFile(vol, fileName, data);

// 直後に開き直して、確保されたクラスタ数(=チェーンが複数クラスタか)を確認しログへ残す。
const reopened = openDiskImage(image, out);
const entry = fatList(reopened, '\\').find((e) => e.name.toUpperCase() === fileName.toUpperCase());
if (!entry) {
  console.error(`[gen] 書き込み直後の再読み出しでファイルが見つからない: ${fileName}`);
  process.exit(1);
}
console.error(
  `[gen] ${out} (${image.length} バイト, ${sizeMiB}MiB) に ${fileName} (${entry.size} バイト) を書き込んだ`,
);

writeFileSync(out, image);
