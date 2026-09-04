// LZH/ZIP 展開モジュール共通のバイト操作・CRC計算・日付/文字コード変換ユーティリティ。
// fat.ts と同様、サブ配列(subarray)に対しても安全に動くよう手動でLE演算する。

/** アーカイブから展開した1エントリ分の情報。 */
export interface ArchiveEntry {
  name: string; // アーカイブ内パス(区切りは '/' に正規化済み)
  data: Uint8Array; // 展開済みデータ
  mtime?: Date;
}

/**
 * OS付随のメタデータエントリ(実データではない)かどうかを判定する。
 * macOS標準の「圧縮」機能で作ったZIPには __MACOSX/._<元ファイル名> という
 * AppleDouble形式の付随ファイルが必ず入る。拡張子が元ファイルと同じ(例: FD1.XDF に対して
 * __MACOSX/._FD1.XDF)ため、ディスクイメージの拡張子でエントリを数える処理に混入すると
 * 「1枚のつもりのアーカイブが複数枚と誤判定される」バグを引き起こす
 * (2026-08-13、共有URL機能の実運用で実際に踏んだ)。
 * ZIP/LZHどちらの展開結果にも同じ基準で効くよう、両方から呼ばれる共通関数として定義する。
 */
export function isMetadataEntry(name: string): boolean {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('__MACOSX/') || normalized.includes('/__MACOSX/')) return true;
  const baseName = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (baseName.startsWith('._')) return true; // AppleDouble本体(ZIP以外の経路で単体で入ることもある)
  const lowerBase = baseName.toLowerCase();
  if (lowerBase === '.ds_store' || lowerBase === 'thumbs.db' || lowerBase === 'desktop.ini') return true;
  return false;
}

export function readU16(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8);
}

export function readU32(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

// --- CRC16 (LZHヘッダ内のデータCRC照合用。多項式0xA001、LSBファースト、初期値0) -----

export function crc16(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc ^= data[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

// --- CRC32 (ZIPのデータ検証用。標準のZIP/PNG多項式0xEDB88320) ------------------------

const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// --- MS-DOS形式の日付/時刻(FAT/ZIP/LZHレベル0・1共通)のデコード ----------------------

export function decodeDosDateTime(date: number, time: number): Date {
  const year = 1980 + ((date >> 9) & 0x7f);
  const month = (date >> 5) & 0x0f;
  const day = date & 0x1f;
  const hour = (time >> 11) & 0x1f;
  const min = (time >> 5) & 0x3f;
  const sec = (time & 0x1f) * 2;
  if (month === 0 || day === 0) return new Date(0);
  return new Date(year, month - 1, day, hour, min, sec);
}

// --- ファイル名の文字コード変換 -----------------------------------------------------

/**
 * Shift_JISバイト列をファイル名文字列にデコードする。ディレクトリ区切りの '\\' は '/' に正規化する。
 * 環境によっては 'shift_jis' ラベルが未対応な場合があるため 'cp932' へのフォールバックも試みる。
 */
export function decodeSjisName(bytes: Uint8Array): string {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder('shift_jis', { fatal: false });
  } catch {
    decoder = new TextDecoder('cp932', { fatal: false });
  }
  return decoder.decode(bytes).replace(/\\/g, '/');
}
