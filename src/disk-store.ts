// ディスクイメージ(FD/HDD)を IndexedDB に永続化するための「ディスクライブラリ」ヘルパー。
// WebNP2 (../PC98/WebNP2/src/storage/db.ts + src/api/library.ts) のディスクライブラリに準拠する。

import { hasHuman68kPartitionSignature } from './api/fat';
import { storageProbe } from './storage-probe';

export interface StoredDisk {
  sourceKey: string;
  /** 元のファイル名(拡張子含む)。イメージ種別の判定に使うため、リネームしても変わらない。 */
  name: string;
  bytes: Uint8Array;
  savedAt: number;
  /** ライブラリ一覧での表示名。未設定なら name をそのまま表示する。 */
  displayName?: string;
  /** 同一アーカイブ(ZIP/LZH)から展開した複数ディスクをまとめるグループID。単体イメージでは未設定。 */
  group?: string;
  /** グループの表示名。同一グループの全レコードが同じ値を持つ(リネーム時は全件更新)。 */
  groupName?: string;
  /** グループ内の並び順(アーカイブ内の出現順)。 */
  groupIndex?: number;
}

const DB_NAME = 'webx68k-disks';
const STORE_NAME = 'disks';
// group/groupName/groupIndex はオブジェクトストアの値へ足したプレーンな追加フィールドであり、
// keyPathやインデックスなど openDb() が解釈するスキーマ自体は変わっていないため、
// DB_VERSION は上げていない(既存レコードはそのまま group 未設定の単体ディスクとして扱われる)。
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'sourceKey' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getDisk(sourceKey: string): Promise<StoredDisk | undefined> {
  const db = await openDb();
  const result = await new Promise<StoredDisk | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(sourceKey);
    req.onsuccess = () => resolve((req.result as StoredDisk | undefined) ?? undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

/**
 * probeContext を渡すと(DEVビルドかつ storageProbe.enabled のときだけ)、目的B「IndexedDBへの
 * ディスク全量書出し」の実測を storageProbe.diskSaves へ1件追記する。
 * 通常経路への影響を避けるため、追加の存在確認クエリと結果記録は enabled 時だけ行う。
 */
export async function putDisk(
  disk: StoredDisk,
  probeContext?: { slot: string; bytesReadyAtMs: number },
): Promise<void> {
  const db = await openDb();
  const probing = import.meta.env.DEV && storageProbe.enabled && probeContext !== undefined;

  let isNewKey: boolean | null = null;
  if (probing) {
    // 初回追加/上書きの区別のためだけの存在確認。計測時のみ発生する追加ラウンドトリップ。
    isNewKey = await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getKey(disk.sourceKey);
      req.onsuccess = () => resolve(req.result === undefined);
      req.onerror = () => reject(req.error);
    });
  }

  const putStartAtMs = probing ? performance.now() : 0;
  let aborted = false;
  let error: string | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const putReq = tx.objectStore(STORE_NAME).put(disk);
      // 終端は必ず oncomplete/onabort の2つだけで決める。onerror は abort前に先に
      // 発火することがあり、そこで reject すると tx.error がまだ null のまま
      // 「未完了なのに aborted=false」という誤った記録になる(実測で確認済み)。
      // request 側の error はここで拾って記録だけしておき、既定動作(自動abort)に任せる。
      putReq.onerror = () => {
        error = putReq.error ? putReq.error.message : String(putReq.error);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => {
        aborted = true;
        reject(tx.error ?? new Error('transaction aborted'));
      };
      if (probing && storageProbe.abortNextPut) {
        // 測定系の検証(故障注入): tx.oncompleteの前に意図的にabortする。
        // 「未完了を成功扱いしない」ことを確認するための専用経路で、通常の保存では通らない。
        storageProbe.abortNextPut = false;
        tx.abort();
      }
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    if (probing) {
      storageProbe.diskSaves.push({
        slot: probeContext!.slot,
        sourceKey: disk.sourceKey,
        byteLength: disk.bytes.byteLength,
        isNewKey: isNewKey ?? false,
        bytesReadyAtMs: probeContext!.bytesReadyAtMs,
        putStartAtMs,
        putCompleteAtMs: null,
        aborted,
        error,
      });
    }
    db.close();
    throw err;
  }

  if (probing) {
    storageProbe.diskSaves.push({
      slot: probeContext!.slot,
      sourceKey: disk.sourceKey,
      byteLength: disk.bytes.byteLength,
      isNewKey: isNewKey ?? false,
      bytesReadyAtMs: probeContext!.bytesReadyAtMs,
      putStartAtMs,
      putCompleteAtMs: performance.now(),
      aborted: false,
      error: null,
    });
  }
  db.close();
}

/**
 * ディスクイメージをライブラリへ登録(更新)する。表示名/グループ情報(WebNP2の putPreservingMeta 相当)は
 * 既存レコードに何か1つでも設定済みならそれを常に優先する。D&D/ファイル選択・アーカイブの再取り込みの
 * たびに呼ばれるため、同じファイルを再登録してもユーザーが付けた表示名やグループ分けが消えないようにする。
 */
export async function saveDisk(
  disk: Omit<StoredDisk, 'displayName'>,
  probeContext?: { slot: string; bytesReadyAtMs: number },
): Promise<void> {
  const existing = await getDisk(disk.sourceKey);
  const hasMeta =
    !!existing &&
    (existing.displayName !== undefined ||
      existing.group !== undefined ||
      existing.groupName !== undefined ||
      existing.groupIndex !== undefined);
  await putDisk(
    {
      ...disk,
      displayName: hasMeta ? existing!.displayName : undefined,
      group: hasMeta ? existing!.group : disk.group,
      groupName: hasMeta ? existing!.groupName : disk.groupName,
      groupIndex: hasMeta ? existing!.groupIndex : disk.groupIndex,
    },
    probeContext,
  );
}

/** ライブラリ内の全ディスクイメージを保存時刻の降順で返す。 */
export async function listDisks(): Promise<StoredDisk[]> {
  const db = await openDb();
  const result = await new Promise<StoredDisk[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve((req.result as StoredDisk[]) ?? []);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result.sort((a, b) => b.savedAt - a.savedAt);
}

/** measureDiskLibraryBytes() が返すレコード1件ぶんの内訳。 */
export interface DiskLibraryByteRecord {
  key: string;
  kind: 'Uint8Array' | 'ArrayBuffer' | 'Blob' | 'unknown';
  byteLength: number;
}

export interface DiskLibraryByteUsage {
  totalBytes: number;
  records: DiskLibraryByteRecord[];
}

function byteSizeOf(value: unknown): { kind: DiskLibraryByteRecord['kind']; byteLength: number } {
  if (value instanceof Uint8Array) return { kind: 'Uint8Array', byteLength: value.byteLength };
  if (value instanceof ArrayBuffer) return { kind: 'ArrayBuffer', byteLength: value.byteLength };
  if (typeof Blob !== 'undefined' && value instanceof Blob) return { kind: 'Blob', byteLength: value.size };
  return { kind: 'unknown', byteLength: 0 };
}

/**
 * 決定3(大容量イメージがIndexedDBに載らないことを経路の不在で保証する)の受け入れ条件を、
 * IndexedDBのレコードを実際に列挙して検証するための関数。
 *
 * `navigator.storage.estimate()` の `usageDetails` はChrome限定でiOS(Chrome for iOS・Safariとも)では
 * 常に `null` になる(2026-08-26実測)うえ、`usage` の値自体もブラウザ側の圧縮・1MiB単位の量子化を
 * 経ており生バイト数の根拠にならない(デスクトップChromeで16MiB書き込みの増分が853,362バイトに
 * 圧縮された一方、iOSでは同じ書き込みがほぼ生サイズの増分になった。圧縮率はデータ依存かつ環境依存)。
 *
 * この関数は `estimate()` を一切使わず、`disks` ストアの全レコードを `getAll()` で読み出して
 * 実体(`bytes: Uint8Array`。将来 `ArrayBuffer`/`Blob` を格納する場合も同じロジックで数える)の
 * `byteLength`/`size` をそのまま合計するため、ブラウザの圧縮・量子化の影響を受けない。
 * 合計だけでなくレコードごとの内訳も返す(「どのレコードが太ったか」を後から追えるように)。
 */
export async function measureDiskLibraryBytes(): Promise<DiskLibraryByteUsage> {
  const rows = await listDisks();
  const records: DiskLibraryByteRecord[] = rows.map((row) => {
    const size = byteSizeOf(row.bytes);
    return { key: row.sourceKey, kind: size.kind, byteLength: size.byteLength };
  });
  const totalBytes = records.reduce((sum, r) => sum + r.byteLength, 0);
  return { totalBytes, records };
}

export async function deleteDisk(sourceKey: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(sourceKey);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** ライブラリエントリの表示名を変更する。実ファイル名(拡張子)は変えないため種別判定は壊れない。 */
export async function renameDisk(sourceKey: string, displayName: string): Promise<void> {
  const existing = await getDisk(sourceKey);
  if (!existing) return;
  const trimmed = displayName.trim();
  // 空文字にされたら「表示名なし」に戻し、元のファイル名表示へフォールバックさせる。
  await putDisk({ ...existing, displayName: trimmed === '' ? undefined : trimmed });
}

/** グループ(アーカイブ由来フォルダ)の表示名を変更する。所属する全レコードの groupName を更新する。 */
export async function renameDiskGroup(groupId: string, groupName: string): Promise<void> {
  const trimmed = groupName.trim();
  if (trimmed === '') return;
  const stored = await listDisks();
  for (const item of stored) {
    if (item.group !== groupId) continue;
    await putDisk({ ...item, groupName: trimmed });
  }
}

/** グループを丸ごと削除する(所属する全ディスクイメージを削除)。 */
export async function deleteDiskGroup(groupId: string): Promise<void> {
  const stored = await listDisks();
  for (const item of stored) {
    if (item.group !== groupId) continue;
    await deleteDisk(item.sourceKey);
  }
}

/** D&D/ファイル選択で受け取った File から一意な sourceKey を作る(WebNP2の fileKeyFor に準拠)。 */
export function fileKeyFor(name: string, size: number): string {
  return `file:${name}:${size}`;
}

/** X68000用ディスクイメージとして受け付ける拡張子。 */
const HDD_EXTENSIONS = ['.hdf', '.dup'];
const FD_EXTENSIONS = ['.xdf', '.dim', '.d88', '.hdm', '.img', '.2hd'];
export const DISK_EXTENSIONS = [...FD_EXTENSIONS, ...HDD_EXTENSIONS];

/** ファイル名がディスクイメージの拡張子を持つか。 */
export function isDiskFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return DISK_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** 表示バッジ用の種別判定(HDD/FD)。挿入動作自体はどちらも同じ単一スロットへ行う。 */
export function classifyDiskKind(name: string): 'hdd' | 'fd' | null {
  const lower = name.toLowerCase();
  if (HDD_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'hdd';
  if (FD_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'fd';
  return null;
}

// --- アーカイブ展開エントリ専用: 拡張子なし/未知拡張子への内容ベースのフォールバック判定 ---
//
// X68000用ディスクイメージはLZH配布で中身のファイル名に拡張子が無いことが珍しくないため、
// 「アーカイブから取り出したエントリに限り」サイズ/シグネチャで種別を推定する。
// 単体ファイル(D&D/ファイル選択)には絶対に使わないこと(無関係ファイルの誤採用を防ぐため)。

/** X68000の既知フロッピーイメージサイズ(バイト)。src/main.ts の BLANK_FORMATS と定数を共有する。 */
export const FD_SIZE_2HD_1232 = 1261568; // 2HD 1232KB (XDF標準)
export const FD_SIZE_2HD_1440 = 1474560; // 2HD 1440KB
export const FD_SIZE_2DD_640 = 655360; // 2DD 640KB
export const FD_SIZE_2DD_720 = 737280; // 2DD 720KB
const RAW_FD_SIZES: readonly number[] = [FD_SIZE_2HD_1232, FD_SIZE_2HD_1440, FD_SIZE_2DD_640, FD_SIZE_2DD_720];

export const KNOWN_FD_SIZES: readonly number[] = RAW_FD_SIZES;

/**
 * ".dim" 形式(X68000のディスクダンプで広く使われる形式)のヘッダサイズ。
 * px68k-libretro の x68k/disk_dim.c (DIM_HEADER 構造体、DIM_SetFD の
 * `file_lread(fp, DIMImg[drv], sizeof(DIM_HEADER))`) に準拠。
 */
const DIM_HEADER_SIZE = 256;

/**
 * px68k の disk_dim.c にある有効な DIM タイプと、その1トラックあたりのバイト数(SctLength[])。
 * DIM_2HD=0(1024B/sct*8sct) / DIM_2HS=1(1024B/sct*9sct) / DIM_2HC=2(512B/sct*15sct) /
 * DIM_2HDE=3(1024B/sct*9sct) / DIM_2HQ=9(512B/sct*18sct)。3〜8のtype(4〜8)はpx68k側で
 * SctLength[]が0になっており無効(DIM_SetFDの `if (!len) goto dim_set_error`)。
 */
const DIM_TRACK_LENGTH: Readonly<Record<number, number>> = {
  0: 1024 * 8, // DIM_2HD
  1: 1024 * 9, // DIM_2HS
  2: 512 * 15, // DIM_2HC
  3: 1024 * 9, // DIM_2HDE
  9: 512 * 18, // DIM_2HQ
};

/**
 * 拡張子なし/未知拡張子のバイト列が px68k の DIM 実装と整合する DIM イメージかどうかを判定する。
 * 「生サイズ+256」という緩い判定はDIM_HEADERの内容を無視しており誤検出するため
 * (bran3r_entry0.lzh はPC-98由来でDIFC HEADER署名も無く、type=1(2HS)なのに
 * (サイズ-256)が2HSのトラック長9216で割り切れない)、
 * 1. 先頭バイト(type)が有効なDIMタイプであること
 * 2. (バイト長-256) がそのtypeのトラック長で割り切れる(トラック数が整数になる)こと
 * の両方を満たす場合だけ DIM と認める。
 */
function isValidDimImage(bytes: Uint8Array): boolean {
  if (bytes.length <= DIM_HEADER_SIZE) return false;
  const type = bytes[0];
  const trackLength = DIM_TRACK_LENGTH[type];
  if (!trackLength) return false;
  const dataLength = bytes.length - DIM_HEADER_SIZE;
  return dataLength > 0 && dataLength % trackLength === 0;
}

/**
 * アーカイブ内エントリ向けの内容ベースの種別判定。
 * 1. 拡張子で分かるなら classifyDiskKind と同じ結果を返す(挙動を変えない)
 * 2. オフセット0x400に"X68K"シグネチャがあれば 'hdd'(src/api/fat.ts の Human68k パーティション判定と同一ロジック)
 * 3. バイト長がX68000の既知の生フロッピーイメージサイズ(XDF)と完全一致すれば 'fd'
 * 4. px68kのDIM実装と整合するDIMヘッダ付きイメージなら 'fd'(拡張子補完は呼び出し側で .dim を出し分ける)
 * 5. どれにも当たらなければ null(従来どおり除外)
 */
export function classifyDiskBytes(name: string, bytes: Uint8Array): 'hdd' | 'fd' | null {
  const byExt = classifyDiskKind(name);
  if (byExt) return byExt;
  if (hasHuman68kPartitionSignature(bytes)) return 'hdd';
  if (KNOWN_FD_SIZES.includes(bytes.length)) return 'fd';
  if (isValidDimImage(bytes)) return 'fd';
  return null;
}

/**
 * 内容ベース判定でバイト列が実際に取った経路(生イメージ/DIM/HDD等)を表す種別。
 * ensureDiskExtension() が拡張子を出し分けるための入力。
 */
export type DiskContentKind = 'hdd' | 'rawFd' | 'dimFd';

/** バイト列がどの内容ベース判定経路に当たったかを返す。拡張子で判定できる場合は null。 */
export function detectDiskContentKind(name: string, bytes: Uint8Array): DiskContentKind | null {
  if (classifyDiskKind(name)) return null;
  if (hasHuman68kPartitionSignature(bytes)) return 'hdd';
  if (KNOWN_FD_SIZES.includes(bytes.length)) return 'rawFd';
  if (isValidDimImage(bytes)) return 'dimFd';
  return null;
}

/**
 * 拡張子なし(または未知の拡張子)を内容ベースで判定した場合に、保存名へ判定結果が分かる拡張子を補う。
 * classifyDiskKind(name) が既に判定できる名前ならそのまま返す(拡張子を重ねない)。
 * ライブラリ表示のバッジ判定(buildLibraryRow の classifyDiskKind(entry.name))が壊れないようにするため。
 *
 * px68k (px68k-libretro/x68k/fdd.c の GetDiskType()) はディスク形式を拡張子だけで判定し、
 * ".d88"/".88d" 以外・".dim" 以外はすべて XDF(生イメージ)として扱う。そのため
 * DIM(先頭256バイトのヘッダ付き)を ".xdf" として保存するとヘッダをディスクデータとして
 * 読んでしまい壊れるので、DIMと判定した場合は必ず ".dim" を補う(".xdf" にしない)。
 */
export function ensureDiskExtension(
  name: string,
  kind: 'hdd' | 'fd',
  contentKind?: DiskContentKind | null,
): string {
  if (classifyDiskKind(name)) return name;
  if (kind === 'hdd') return `${name}.hdf`;
  return `${name}${contentKind === 'dimFd' ? '.dim' : '.xdf'}`;
}
