// SCSI起動 段階3(docs/STORAGE-SCSI.md)の調査用: _export-scsi-opfs.mjs で書き出した
// SCSIイメージをFATとして開き、SCSI起動での書き込み結果(既定では
// dst2.dat上書き・newdir\cc.dat新規・new1.dat削除の組を想定)を、書き込み前のコピー
// (元イメージ)と突き合わせてバイト単位で検証する。ファイル名は本スクリプト中に
// ハードコードしてあるため、別の検体で使う場合は書き換えること(使い捨て)。
// 使い方: vite-node scripts/_verify-scsi-fat.mts <読み返したhds> <元イメージのhds>
import { readFileSync } from 'node:fs';
import { openDiskImage, fatList, fatReadFile } from '../src/api/fat.ts';

const [, , readbackPath, origPath] = process.argv;
const readback = new Uint8Array(readFileSync(readbackPath));
const orig = new Uint8Array(readFileSync(origPath));

const volRb = openDiskImage(readback, 'scsi0.hds');
const volOrig = openDiskImage(orig, 'work1.hds');

function hex(b: Uint8Array, n = 16) {
  return Array.from(b.slice(0, n)).map((x) => x.toString(16).padStart(2, '0')).join(' ');
}

console.log('=== root dir (readback) ===');
for (const e of fatList(volRb, '/')) {
  console.log(e.isDir ? `<dir> ${e.name}` : `${e.name}  ${e.size}`);
}

console.log('\n=== newdir (readback) ===');
for (const e of fatList(volRb, 'newdir')) {
  console.log(e.isDir ? `<dir> ${e.name}` : `${e.name}  ${e.size}`);
}

// dst2.dat は copy autoexec.bat dst2.dat で最終上書きされたはず -> AUTOEXEC.BAT (元イメージ)と一致するはず
const dst2 = fatReadFile(volRb, 'dst2.dat');
const autoexecOrig = fatReadFile(volOrig, 'AUTOEXEC.BAT');
console.log('\ndst2.dat size=', dst2.length, ' AUTOEXEC.BAT(orig) size=', autoexecOrig.length);
console.log('dst2.dat 完全一致:', dst2.length === autoexecOrig.length && Buffer.from(dst2).equals(Buffer.from(autoexecOrig)));

// newdir\cc.dat は copy config.sys newdir\cc.dat -> CONFIG.SYS(元)と一致するはず
const ccdat = fatReadFile(volRb, 'newdir/cc.dat');
const configOrig = fatReadFile(volOrig, 'CONFIG.SYS');
console.log('\ncc.dat size=', ccdat.length, ' CONFIG.SYS(orig) size=', configOrig.length);
console.log('cc.dat 完全一致:', ccdat.length === configOrig.length && Buffer.from(ccdat).equals(Buffer.from(configOrig)));

// new1.dat は削除済みのはず -> ルートに存在しないこと
const rootNames = fatList(volRb, '/').map((e) => e.name.trim().toUpperCase());
console.log('\nnew1.datが残っていないか:', !rootNames.some((n) => n.replace(/\s+/g, '').startsWith('NEW1')));

// 他の既存ファイル(未変更のはず)がbyte-identicalか(退行が無いこと)
for (const name of ['COMMAND.X', 'KEY.SYS', 'USKCG.SYS', 'BEEP.SYS', 'STARTUP.ENV']) {
  const a = fatReadFile(volRb, name);
  const b = fatReadFile(volOrig, name);
  const same = a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
  console.log(`${name}: ${same ? '不変' : '変化あり!!'} (size ${a.length} vs ${b.length})`);
}
