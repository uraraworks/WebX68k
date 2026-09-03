// メインスレッド(ページ側)用の、OPFS上のSCSIイメージを扱う小さなモジュール。
//
// src/scsi-opfs.ts はWorker内(src/core-worker.ts)からだけ呼ばれ、
// FileSystemSyncAccessHandle(ワーカー専用API)でセクタI/Oを行う。
// こちらはメインスレッド用なので同期ハンドルは使えず(feedback_secure_context_hides_capability.md
// 系の制約と同じ理由でメインスレッドのglobalThisには存在しない)、代わりに
// createWritable() / getFile() の非同期APIだけを使う。
//
// 置き場は OPFS の `scsi/` ディレクトリ。ファイル名はそのまま(同名は上書き)。

const SCSI_DIR = 'scsi';

export interface ScsiEntry {
  name: string;
  bytes: number;
}

/** この環境でSCSIのOPFS保存が使えるか(secure context かつ OPFS が使える)。 */
export async function isScsiStorageAvailable(): Promise<boolean> {
  if (typeof isSecureContext !== 'undefined' && !isSecureContext) return false;
  if (typeof navigator === 'undefined' || !navigator.storage) return false;
  if (typeof navigator.storage.getDirectory !== 'function') return false;
  try {
    await navigator.storage.getDirectory();
    return true;
  } catch {
    return false;
  }
}

async function getScsiDir(create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(SCSI_DIR, { create });
}

/**
 * 一覧の並び順(名前の昇順、localeCompareで日本語ファイル名も自然な順になる)。
 * ディレクトリの列挙順(挿入順)は環境依存で不安定なため、表示前に必ずこれを通す。
 * DOM非依存の純粋関数として切り出してあり単体テスト可能。
 */
export function sortScsiEntries(entries: ScsiEntry[]): ScsiEntry[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 指定ファイルを削除してよいか(=現在SCSIスロットに挿入中でないか)。
 * `mountedName` は呼び出し側が持つ現在の挿入名(localStorage `webx68k.scsi` の値)。
 * DOM非依存の純粋関数として切り出してあり単体テスト可能。
 */
export function canDeleteScsiImage(name: string, mountedName: string | null): boolean {
  return name !== mountedName;
}

/** `scsi/` ディレクトリ内のファイル一覧を、名前の昇順に揃えて返す(無ければ空配列)。 */
export async function listScsiImages(): Promise<ScsiEntry[]> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await getScsiDir(false);
  } catch {
    return [];
  }
  const out: ScsiEntry[] = [];
  // FileSystemDirectoryHandle は for-await-of に対応(非同期イテレータ)。
  for await (const [name, handle] of dir as unknown as AsyncIterable<
    [string, FileSystemHandle]
  >) {
    if (handle.kind !== 'file') continue;
    const file = await (handle as FileSystemFileHandle).getFile();
    out.push({ name, bytes: file.size });
  }
  return sortScsiEntries(out);
}

/**
 * 指定ファイルを `scsi/` ディレクトリへ書き込む(同名は上書き)。
 * file.stream() を読みながら createWritable() へ順に書き込み、8MiBごとに
 * onProgress(done, total) を呼ぶ(100MB級のコピーで進捗表示が要るため)。
 * 例外は握りつぶさずそのまま投げる。
 */
export async function putScsiImage(
  file: File,
  onProgress?: (done: number, total: number) => void,
): Promise<ScsiEntry> {
  const dir = await getScsiDir(true);
  const handle = await dir.getFileHandle(file.name, { create: true });
  const writable = await handle.createWritable();
  const total = file.size;
  const PROGRESS_STEP = 8 * 1024 * 1024;
  let done = 0;
  let sinceLastProgress = 0;
  try {
    const reader = file.stream().getReader();
    for (;;) {
      const { done: readDone, value } = await reader.read();
      if (readDone) break;
      if (value && value.length > 0) {
        await writable.write(value);
        done += value.length;
        sinceLastProgress += value.length;
        if (sinceLastProgress >= PROGRESS_STEP) {
          sinceLastProgress = 0;
          onProgress?.(done, total);
        }
      }
    }
  } catch (e) {
    await writable.abort().catch(() => {
      /* abort失敗は無視(どうせ例外を投げ直す) */
    });
    throw e;
  }
  await writable.close();
  onProgress?.(total, total);
  return { name: file.name, bytes: total };
}

/** `scsi/` ディレクトリから指定ファイルを削除する。無ければ何もしない。 */
export async function deleteScsiImage(name: string): Promise<void> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await getScsiDir(false);
  } catch {
    return;
  }
  try {
    await dir.removeEntry(name);
  } catch {
    /* 元々無いなら削除済みとみなす */
  }
}

/** ダウンロード用に、指定ファイルを File として読み出す。無ければ例外を投げる。 */
export async function readScsiImage(name: string): Promise<File> {
  const dir = await getScsiDir(false);
  const handle = await dir.getFileHandle(name, { create: false });
  return handle.getFile();
}
