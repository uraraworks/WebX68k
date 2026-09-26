// SCSI起動 段階3(docs/STORAGE-SCSI.md)追加検証用: _export-scsi-opfs.mjs で書き出した
// SCSIイメージをFATとして開き、「大きくなる方向の上書き」(grow1.dat: 179B→8028Bへ
// AUTOEXEC.BAT→USKCG.SYSで上書き)と「複数クラスタにまたがる新規大容量ファイル」
// (big.dat: COMMAND.X 10本分+USKCG.SYS、約285KB)を、元イメージ(書き込み前のコピー)
// から計算した期待値とバイト単位で突き合わせる。ファイル名・構成は本スクリプト中に
// ハードコードしてあるため、別の検体で使う場合は書き換えること(使い捨て)。
// あわせてFAT16(このイメージはbig-endian)のクラスタ鎖を自前で辿り、
// クラスタ数が ceil(サイズ/クラスタサイズ) と一致するかも確認する
// (fat.tsのgetClusterChainは非公開のため、読み出しだけの最小実装をここに複製する)。
//
// 使い方: vite-node scripts/_verify-scsi-fat-grow.mts <読み返したhds> <元イメージのhds>
import { readFileSync } from 'node:fs';
import { openDiskImage, fatList, fatReadFile, type FatVolume } from '../src/api/fat.ts';

const [, , readbackPath, origPath] = process.argv;
const readback = new Uint8Array(readFileSync(readbackPath));
const orig = new Uint8Array(readFileSync(origPath));

const volRb = openDiskImage(readback, 'scsi0.hds') as any;
const volOrig = openDiskImage(orig, 'work1.hds');

function eq(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
}

console.log('=== root dir (readback) ===');
for (const e of fatList(volRb, '/')) {
  console.log(e.isDir ? `<dir> ${e.name}` : `${e.name}  ${e.size}`);
}

// --- 1. 大きくなる方向の上書き: grow1.dat は最終的に USKCG.SYS(元) と一致するはず ---
const grow1 = fatReadFile(volRb, 'grow1.dat');
const uskcgOrig = fatReadFile(volOrig, 'USKCG.SYS');
console.log('\ngrow1.dat size=', grow1.length, ' USKCG.SYS(orig) size=', uskcgOrig.length);
console.log('grow1.dat 完全一致(179B→8028Bへの拡大上書き):', eq(grow1, uskcgOrig));

// --- 2. 複数クラスタの新規大容量ファイル: big.dat は COMMAND.X(orig)×10 + USKCG.SYS(orig) と一致するはず ---
// (test3.dat = COMMAND.X×2 をゲスト上で5回連結 + USKCG.SYS を付加してビルドした経緯だが、
//  最終的な期待値は元イメージのCOMMAND.X/USKCG.SYSから直接計算する)
const commandOrig = fatReadFile(volOrig, 'COMMAND.X');
const expectedBig = new Uint8Array(commandOrig.length * 10 + uskcgOrig.length);
for (let i = 0; i < 10; i++) expectedBig.set(commandOrig, i * commandOrig.length);
expectedBig.set(uskcgOrig, commandOrig.length * 10);
const big = fatReadFile(volRb, 'big.dat');
console.log('\nbig.dat size=', big.length, ' 期待値(COMMAND.X×10+USKCG.SYS) size=', expectedBig.length);
console.log('big.dat 完全一致:', eq(big, expectedBig));

// --- 3. クラスタ鎖の長さがサイズどおりか(FAT16 big-endianを自前で辿る) ---
function findEntryCluster(vol: FatVolume, path: string): { cluster: number; size: number } {
  const segs = path.split('/');
  const entries = fatList(vol, segs.slice(0, -1).join('/'));
  const found = entries.find((e) => e.name.replace(/\s+/g, '').toUpperCase() === segs[segs.length - 1].toUpperCase().replace(/\s+/g, ''));
  if (!found) throw new Error(`not found: ${path}`);
  return { cluster: found.cluster, size: found.size };
}

function chainLength(vol: FatVolume, startCluster: number): number {
  const v = vol as any;
  let count = 0;
  let cluster = startCluster;
  const seen = new Set<number>();
  while (cluster >= 2 && cluster < 0xfff0) {
    if (seen.has(cluster)) throw new Error('クラスタ鎖がループしている');
    seen.add(cluster);
    count++;
    const off = v.fatStartByte + cluster * 2;
    cluster = v.fat16BigEndian
      ? (v.image[off] << 8) | v.image[off + 1]
      : v.image[off] | (v.image[off + 1] << 8);
  }
  return count;
}

const grow1Entry = findEntryCluster(volRb, 'grow1.dat');
const bigEntry = findEntryCluster(volRb, 'big.dat');
const grow1Chain = chainLength(volRb, grow1Entry.cluster);
const bigChain = chainLength(volRb, bigEntry.cluster);
const bpc = (volRb as any).bytesPerCluster as number;
console.log('\ngrow1.dat: クラスタ数=', grow1Chain, ' 期待=', Math.ceil(grow1Entry.size / bpc), grow1Chain === Math.ceil(grow1Entry.size / bpc) ? 'OK' : 'NG');
console.log('big.dat  : クラスタ数=', bigChain, ' 期待=', Math.ceil(bigEntry.size / bpc), bigChain === Math.ceil(bigEntry.size / bpc) ? 'OK' : 'NG');

// --- 4. 空き容量の変化の辻褄(dirで見た値との対比は文書側でも記録するが、ここでも
//     クラスタ数×クラスタサイズの合計を出しておく) ---
console.log('\n新規に確保されたバイト数(クラスタ単位、grow1+big):', (grow1Chain + bigChain) * bpc, 'B');
