// __MACOSX/ 等のOS付随メタデータエントリがディスク枚数判定に混入するバグの回帰テスト。
//
// macOS標準の「圧縮」機能で作ったZIPには __MACOSX/._<元ファイル名> というAppleDouble形式の
// 付随ファイルが必ず入る。拡張子が元ファイルと同じ(例: FD1.XDF に対して __MACOSX/._FD1.XDF)
// ため、これを1エントリとして数えると「1枚のつもりのアーカイブが複数枚と誤判定される」。
// 2026-08-13、共有URL機能の実運用で実際に踏んだ。

import { describe, expect, it } from 'vitest';
import { extractArchive } from '../src/api/archive.ts';
import { crc32 } from '../src/api/archive-util.ts';

/** テスト用に stored(無圧縮)方式のZIPバイト列を組み立てる。 */
function buildStoredZip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name);
    const crc = crc32(file.data);

    const lfh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true); // LFH_SIG
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // gp flag
    lv.setUint16(8, 0, true); // method: stored
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0, true); // mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, file.data.length, true); // comp size
    lv.setUint32(22, file.data.length, true); // uncomp size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra len
    lfh.set(nameBytes, 30);

    const localOffset = offset;
    chunks.push(lfh, file.data);
    offset += lfh.length + file.data.length;

    const cdfh = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdfh.buffer);
    cv.setUint32(0, 0x02014b50, true); // CDFH_SIG
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // gp flag
    cv.setUint16(10, 0, true); // method: stored
    cv.setUint16(12, 0, true); // mod time
    cv.setUint16(14, 0, true); // mod date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, file.data.length, true); // comp size
    cv.setUint32(24, file.data.length, true); // uncomp size
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra len
    cv.setUint16(32, 0, true); // comment len
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, localOffset, true);
    cdfh.set(nameBytes, 46);
    centralChunks.push(cdfh);
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const c of centralChunks) cdSize += c.length;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // EOCD_SIG
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);
  ev.setUint16(20, 0, true); // comment len

  const all = [...chunks, ...centralChunks, eocd];
  let total = 0;
  for (const c of all) total += c.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

describe('extractArchive: OS付随メタデータエントリの除外', () => {
  it('__MACOSX/._FD1.XDF を含むZIPを展開すると、ディスクイメージは1枚(FD1.XDFのみ)と判定される', async () => {
    const zip = buildStoredZip([
      { name: 'FD1.XDF', data: new Uint8Array(1024).fill(0xaa) },
      { name: '__MACOSX/._FD1.XDF', data: new Uint8Array(212).fill(0x00) },
    ]);
    const entries = await extractArchive('FD1.XDF.zip', zip);
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe('FD1.XDF');
  });

  it('.DS_Store / Thumbs.db / desktop.ini が混じっても枚数に数えられない(大文字小文字無視)', async () => {
    const zip = buildStoredZip([
      { name: 'FD1.XDF', data: new Uint8Array(1024).fill(0xaa) },
      { name: '.DS_Store', data: new Uint8Array(8) },
      { name: 'sub/Thumbs.db', data: new Uint8Array(8) },
      { name: 'desktop.ini', data: new Uint8Array(8) },
      { name: 'DESKTOP.INI', data: new Uint8Array(8) },
    ]);
    const entries = await extractArchive('FD1.XDF.zip', zip);
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe('FD1.XDF');
  });

  it('通常の複数枚アーカイブ(A.XDF/B.XDF)は従来どおり2枚と判定される(除外規則の過剰適用がないこと)', async () => {
    const zip = buildStoredZip([
      { name: 'A.XDF', data: new Uint8Array(1024).fill(0x11) },
      { name: 'B.XDF', data: new Uint8Array(1024).fill(0x22) },
    ]);
    const entries = await extractArchive('multi.zip', zip);
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.name).sort()).toEqual(['A.XDF', 'B.XDF']);
  });
});
