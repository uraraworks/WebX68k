// P2b #3: 「このディスクにHostFSを組み込む」処理の中身。
// ルートへHOSTFS.SYSを書き、CONFIG.SYSにDEVICE行を足す(無ければ新規作成、既にあれば足さない)。
// FatVolumeへの実際の読み書きはsrc/api/fat.tsのfatReadFile/fatWriteFileに任せ、
// このファイルはCONFIG.SYSの文字列編集(改行コード・EOFマーカーの扱い・重複検出)だけを持つ
// ことで、DOM/UIを介さずにテストできるようにしている。

import type { FatVolume } from '../api/fat';
import { fatReadFile, fatWriteFile } from '../api/fat';

/** ルートに置くHOSTFS.SYSのパス(8.3形式)。 */
export const HOSTFS_SYS_PATH = '\\HOSTFS.SYS';

/** CONFIG.SYSへ足すDEVICE行(public/system/hostfs.sys.README.md、tools/x68/build-hostfs.shと同じ文言)。 */
export const HOSTFS_CONFIG_LINE = 'DEVICE = \\HOSTFS.SYS';

const CR = 0x0d;
const LF = 0x0a;
const EOF_MARK = 0x1a; // Human68k CONFIG.SYSの終端マーカー(実機/human302.xdfの慣習)。

/** バイト列を「1バイト=1文字」の疑似文字列にする(CONFIG.SYSはASCII前提なのでlatin1相当で十分)。 */
function bytesToLatin1(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** 疑似文字列(1文字=1バイト、charCodeAtが0-255に収まる前提)をバイト列に戻す。 */
function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** CONFIG.SYSの内容に、HostFSのDEVICE行が既にあるか(表記ゆれは気にせずHOSTFS.SYSという語の有無で見る)。 */
export function hasHostFsDeviceLine(configText: string): boolean {
  return configText.toUpperCase().includes('HOSTFS.SYS');
}

/**
 * CONFIG.SYSのバイト列(無ければnull)へHostFSのDEVICE行を足した新しいバイト列を返す。
 * 改行は既存行がCRLFならCRLF、無ければCRLF(Human68k標準)で挿入する。
 * 末尾に0x1A(EOF)があれば、その手前に挿入して0x1A以降(パディング含む)をそのまま残す。
 * 0x1Aが無ければファイル末尾にそのまま足す。
 * 既にHOSTFS.SYSの行があれば何もせず、元のバイト列をそのまま返す(added=falseで示す)。
 */
export function addHostFsDeviceLine(existing: Uint8Array | null): { bytes: Uint8Array; added: boolean } {
  if (existing === null) {
    // 新規作成: 1行だけのCONFIG.SYSを作る。
    return { bytes: latin1ToBytes(`${HOSTFS_CONFIG_LINE}\r\n`), added: true };
  }
  const text = bytesToLatin1(existing);
  if (hasHostFsDeviceLine(text)) {
    return { bytes: existing, added: false };
  }

  const eofIdx = existing.lastIndexOf(EOF_MARK);
  const insertion = `${HOSTFS_CONFIG_LINE}\r\n`;

  if (eofIdx === -1) {
    // EOFマーカーが無いCONFIG.SYS: 末尾にそのまま足す。既存末尾が改行で終わっていなければ
    // 改行を1つ補ってから足す(行が連結してしまわないように)。
    const needsNewline = existing.length > 0 && existing[existing.length - 1] !== LF && existing[existing.length - 1] !== CR;
    const prefix = needsNewline ? '\r\n' : '';
    const bytes = latin1ToBytes(text + prefix + insertion);
    return { bytes, added: true };
  }

  const before = existing.subarray(0, eofIdx);
  const after = existing.subarray(eofIdx); // 0x1A以降(パディング含む)をそのまま残す
  const bytes = new Uint8Array(before.length + insertion.length + after.length);
  bytes.set(before, 0);
  bytes.set(latin1ToBytes(insertion), before.length);
  bytes.set(after, before.length + insertion.length);
  return { bytes, added: true };
}

/**
 * FatVolumeへHOSTFS.SYSを書き、CONFIG.SYSにDEVICE行を足す。
 * 呼び出し側で「起動中のディスクには書かない」「同梱ディスクは対象外(コピーを使う)」を
 * 保証しておくこと(このファイルはFAT操作そのものだけを担当し、その判断は持たない)。
 */
export function installHostFsIntoVolume(vol: FatVolume, hostfsSysBytes: Uint8Array): { configLineAdded: boolean } {
  fatWriteFile(vol, HOSTFS_SYS_PATH, hostfsSysBytes);

  let existingConfig: Uint8Array | null = null;
  try {
    existingConfig = fatReadFile(vol, '\\CONFIG.SYS');
  } catch {
    existingConfig = null;
  }

  const { bytes, added } = addHostFsDeviceLine(existingConfig);
  if (added) {
    fatWriteFile(vol, '\\CONFIG.SYS', bytes);
  }
  return { configLineAdded: added };
}
