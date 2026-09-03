// 複数パーティションのSCSI検体を作るツール（**テスト専用**）。
//
// 手順3(1本のイメージの中の複数パーティションを別ドライブとして出す)を検証したいが、
// 手元の基準器はパーティションが1本しかない。そこで:
//
//   - **パーティションの中身は Human68k の FORMAT.X が作った本物をそのまま複製する**
//     (ブートセクタ・FAT・ディレクトリはすべて実物)
//   - **自前で書くのはパーティション表と先頭ヘッダの数値だけ**(書式は実測済み)
//
// という形にして、「自作の構造を自作の実装で読む」範囲を最小にしている。
// 出来上がりは「同じ中身の区画が2つ並んだディスク」なので、区画の見分けは
// **片方へ書いてもう片方が変わらないこと**で行う(中身が同じなので目視では区別できない)。
//
// 使い方:
//   node scripts/make-scsi-multipart.mjs --src=<1本のイメージ> --out=<出力> [--parts=2]
//
// 実測した書式(docs/STORAGE-SCSI.md 参照):
//   LBA0        "X68SCSI1" + [+8..9]=1セクタのバイト数 + [+10..13]=総512ブロック数-1
//   LBA4($800)  "X68K" + [+4]=使用済み末尾 + [+8]/[+12]=総1KBブロック数-1
//               以降16バイトずつ: 名前8 + 開始4 + サイズ4 (すべてBE・単位1024バイト)

import { openSync, readSync, writeSync, closeSync, statSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`不明な引数です: ${a}`);
    return [m[1], m[2] ?? 'true'];
  }),
);
if (!args.src || !args.out) {
  console.error('使い方: node scripts/make-scsi-multipart.mjs --src=<入力> --out=<出力> [--parts=2]');
  process.exit(1);
}
const PARTS = Number(args.parts ?? 2);
const BLOCK = 1024;

const src = openSync(args.src, 'r');
const head = Buffer.alloc(0x820);
readSync(src, head, 0, head.length, 0);

if (head.subarray(0, 8).toString('latin1') !== 'X68SCSI1') throw new Error('先頭が X68SCSI1 でない');
if (head.subarray(0x800, 0x804).toString('latin1') !== 'X68K') throw new Error('$800 が X68K でない');
const sectorBytes = head.readUInt16BE(8);
if (sectorBytes !== 512) throw new Error(`1セクタ=${sectorBytes}バイトは想定外(512のみ対応)`);

const name = head.subarray(0x810, 0x818);
const start0 = head.readUInt32BE(0x818);
const size0 = head.readUInt32BE(0x81c);
console.error(`元: 名前="${name.toString('latin1')}" 開始=${start0} サイズ=${size0} (1KBブロック単位)`);

const totalBlocks = start0 + size0 * PARTS;
const out = openSync(args.out, 'w+');

const lead = Buffer.alloc(start0 * BLOCK);
readSync(src, lead, 0, lead.length, 0);
lead.writeUInt32BE(totalBlocks * 2 - 1, 10);
lead.writeUInt32BE(totalBlocks, 0x804);
lead.writeUInt32BE(totalBlocks - 1, 0x808);
lead.writeUInt32BE(totalBlocks - 1, 0x80c);
lead.fill(0, 0x810, 0x800 + BLOCK);
for (let i = 0; i < PARTS; i++) {
  const off = 0x810 + i * 16;
  name.copy(lead, off);
  lead.writeUInt32BE(start0 + size0 * i, off + 8);
  lead.writeUInt32BE(size0, off + 12);
}
writeSync(out, lead, 0, lead.length, 0);

const CHUNK = 8 * 1024 * 1024;
const buf = Buffer.alloc(CHUNK);
for (let i = 0; i < PARTS; i++) {
  const dstBase = (start0 + size0 * i) * BLOCK;
  let done = 0;
  const len = size0 * BLOCK;
  while (done < len) {
    const n = readSync(src, buf, 0, Math.min(CHUNK, len - done), start0 * BLOCK + done);
    if (n <= 0) throw new Error('元イメージが途中で尽きた');
    writeSync(out, buf, 0, n, dstBase + done);
    done += n;
  }
  console.error(`区画${i}: 開始=${start0 + size0 * i} サイズ=${size0} (1KBブロック単位) 書き込み完了`);
}
closeSync(src);
closeSync(out);
console.error(`出力: ${args.out} (${statSync(args.out).size} バイト / ${totalBlocks} ブロック / ${PARTS}区画)`);
