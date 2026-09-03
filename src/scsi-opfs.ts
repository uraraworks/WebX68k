// SCSI HLE のセクタI/Oを OPFS の同期ハンドル経由にする(決定2、docs/STORAGE-SCSI.md参照)。
//
// このモジュールは Worker 内(src/core-worker.ts)からだけ呼ばれる想定。
// FileSystemSyncAccessHandle はワーカー専用のAPIであり、メインスレッドの globalThis には
// 存在しない(scripts/probe-opfs.html で実測確認済み)。
//
// 差し込み口は core-shim.c 側に既にある:
//   - globalThis.__webx68kScsiRead(lba, HEAPU8, ptr) -> 0成功 / -2「自分では扱わない」で
//     従来のXHR経路(js_scsi_read_sector内のtryブロック)へ委譲
//   - globalThis.__webx68kScsiWrite(lba, HEAPU8, ptr) -> 0成功 / 0以外失敗
//   - globalThis.__webx68kScsiSize -> js_scsi_get_size() がXHRより優先して読む値
//     (このセットアップが成功したときだけ置く。core-shim.c側のコメント参照)
//
// 有効化条件 __webx68kScsiOpfs / __webx68kScsiUrl は src/main.ts の collectHostGlobals() が
// ページ側の globalThis.__webx68k* (string/number/boolean のみ)をWorkerへ転写する仕組みに
// 乗る。ただし __webx68kScsiRead/__webx68kScsiWrite 自体は関数なので転写対象から自動的に
// 除外される(collectHostGlobals()のコメント参照)。よってこれらのフックはWorker自身の
// globalThisへここで直接生やす必要がある。

// lib.dom.d.ts (このプロジェクトのtsconfigは"DOM"のみで"WebWorker"は含めていない、
// core-worker.tsが実Worker専用グローバルにそのままasキャストで頼っているのと同じ理由)には
// FileSystemSyncAccessHandle自体が無いため、ここで最小限のambient宣言を足す。
declare global {
  interface FileSystemSyncAccessHandle {
    read(buffer: Uint8Array, options?: { at?: number }): number;
    write(buffer: Uint8Array, options?: { at?: number }): number;
    truncate(newSize: number): void;
    getSize(): number;
    flush(): void;
    close(): void;
  }
  interface FileSystemFileHandle {
    createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
  }
}

export interface ScsiOpfsResult {
  mode: 'opfs' | 'none';
  /** none のときだけ。理由を必ず入れる(沈黙させないため)。 */
  reason?: string;
  bytes?: number;
  imported?: boolean;
}

const SECTOR_SIZE = 512;
// 1セクタごとの flush() は遅いので、dirtyを立てて低頻度でまとめてflushする。
// 取りこぼしの窓が最大2秒ある。タブを閉じた瞬間の書き込みは失われうる。
const FLUSH_INTERVAL_MS = 2000;

/**
 * リモートのイメージサイズを取る。js_scsi_get_size() (core-shim.c) と同じやり方で、
 * Range: bytes=0-0 の応答が返す Content-Range ("bytes 0-0/104857600") の "/" 以降を読む。
 */
async function getRemoteSize(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    const cr = res.headers.get('Content-Range');
    // Range非対応(200で全量返す)サーバへの保険。本文は使わないので読み捨てる。
    if (!cr) {
      await res.arrayBuffer().catch(() => {});
      return null;
    }
    const slash = cr.lastIndexOf('/');
    if (slash < 0) return null;
    const n = Number(cr.substring(slash + 1));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * リモートのイメージ全体を同期ハンドルへ流し込む。fetchのレスポンスストリームを
 * チャンクのまま handle.write(chunk, {at: offset}) で順に書く。
 * 1MiB一括書きはセクタ単位より2桁速いと実測済み(呼び出し元コメント参照)なので、
 * チャンクサイズはfetchが返すままにし、ここでは分割・再結合しない。
 */
async function importImage(
  handle: FileSystemSyncAccessHandle,
  url: string,
  remoteSize: number,
): Promise<void> {
  handle.truncate(remoteSize);
  const res = await fetch(url);
  if (!res.body) throw new Error('取り込み用のfetchにボディが無い');
  const reader = res.body.getReader();
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) {
      handle.write(value, { at: offset });
      offset += value.length;
    }
  }
  handle.flush();
}

export async function setupScsiOpfs(): Promise<ScsiOpfsResult> {
  const g = globalThis as Record<string, unknown>;

  if (!g.__webx68kScsiOpfs) {
    return { mode: 'none', reason: '__webx68kScsiOpfs が未設定' };
  }
  const url = g.__webx68kScsiUrl;
  if (typeof url !== 'string' || url.length === 0) {
    return { mode: 'none', reason: 'イメージのURLが無い' };
  }
  // secure contextでない/OPFSが無い環境では navigator.storage.getDirectory 自体が
  // 消える(feedback_secure_context_hides_capability.md参照)。この分岐は必ず残すこと:
  // LANのhttpで踏むとOPFSごと静かに消え、原因不明の「none」に見えてしまうため、
  // ここで理由を確定させて即 none へ落とす。
  if (
    typeof isSecureContext !== 'undefined' && !isSecureContext ||
    typeof navigator === 'undefined' ||
    !navigator.storage ||
    typeof navigator.storage.getDirectory !== 'function'
  ) {
    return { mode: 'none', reason: 'secure context でない/OPFSが無い' };
  }

  let fileHandle: FileSystemFileHandle;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('scsi', { create: true });
    fileHandle = await dir.getFileHandle('scsi0.hds', { create: true });
  } catch (e) {
    return { mode: 'none', reason: `OPFSファイルの用意に失敗: ${String(e)}` };
  }

  let handle: FileSystemSyncAccessHandle;
  try {
    handle = await fileHandle.createSyncAccessHandle();
  } catch (e) {
    return { mode: 'none', reason: `同期ハンドルの取得に失敗: ${String(e)}` };
  }

  let imported = false;
  try {
    const existingSize = handle.getSize();
    const remoteSize = await getRemoteSize(url);
    if (remoteSize === null) {
      handle.close();
      return { mode: 'none', reason: 'イメージのサイズ取得(Range)に失敗' };
    }
    if (existingSize !== remoteSize) {
      // 既存ファイルが無い/サイズが違う(=別イメージ、または前回の取り込みが未完了)ときだけ
      // 取り込み直す。同じサイズならローカルの続きをそのまま使う。
      await importImage(handle, url, remoteSize);
      imported = true;
    }
  } catch (e) {
    try {
      handle.close();
    } catch {
      /* close失敗は無視(どうせ捨てるハンドル) */
    }
    return { mode: 'none', reason: `OPFSへの取り込みに失敗: ${String(e)}` };
  }

  const size = handle.getSize();
  let dirty = false;

  g.__webx68kScsiRead = (lba: number, heap: Uint8Array, ptr: number): number => {
    try {
      const n = handle.read(heap.subarray(ptr, ptr + SECTOR_SIZE), { at: lba * SECTOR_SIZE });
      // 範囲外は例外を投げず静かに0バイトが返る(FileSystemSyncAccessHandle.read()の仕様)。
      // 必ず戻り値(実際に読めたバイト数)を検査すること。
      return n === SECTOR_SIZE ? 0 : -1;
    } catch {
      return -1;
    }
  };
  g.__webx68kScsiWrite = (lba: number, heap: Uint8Array, ptr: number): number => {
    try {
      const n = handle.write(heap.subarray(ptr, ptr + SECTOR_SIZE), { at: lba * SECTOR_SIZE });
      if (n !== SECTOR_SIZE) return -1;
      dirty = true;
      return 0;
    } catch {
      return -1;
    }
  };
  // js_scsi_get_size() (core-shim.c) が優先して返す値。OPFS経路ではXHRでサイズを
  // 取り直さないため、ここで確定値を渡しておく。
  g.__webx68kScsiSize = size;

  setInterval(() => {
    if (!dirty) return;
    try {
      handle.flush();
      dirty = false;
    } catch {
      /* 失敗時はdirtyを保持し、次回のintervalで再試行する */
    }
  }, FLUSH_INTERVAL_MS);

  return { mode: 'opfs', bytes: size, imported };
}
