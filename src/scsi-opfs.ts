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
// 有効化条件 __webx68kScsiOpfs / __webx68kScsiUrl は src/host-globals.ts の
// collectHostGlobals() が、ページ側の globalThis.__webx68k*
// (string/number/boolean/ArrayBuffer/ArrayBufferView/配列。2026-09-04以降)をWorkerへ
// 転写する仕組みに乗る。ただし __webx68kScsiRead/__webx68kScsiWrite 自体は関数なので
// 転写対象から自動的に除外される(collectHostGlobals()は転写できない値を警告のうえ
// 除外する。src/host-globals.tsのコメント参照)。よってこれらのフックはWorker自身の
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
// 定期flush(FLUSH_INTERVAL_MS)だけだと最大2秒の取りこぼしの窓が残るため、
// 「書き込みが止まったら短時間で追いかけてflushする」デバウンス(FLUSH_DEBOUNCE_MS)を
// 主役に据える(docs/STORAGE-SCSI.md「取りこぼしの窓」の是正)。
const FLUSH_INTERVAL_MS = 2000;
// デバウンスの既定値。書き込みのたびにこの時間だけタイマを張り直し、書き込みが止まって
// この時間が経ったら flush() する。__webx68kScsiFlushDebounceMs が数値ならそちらを使う
// (0以下ならデバウンス自体を無効化する)。A/B比較・故障注入用の抜け道でもある
// (feedback_fault_injection_needs_positive_control.md参照。「常に無効」側を作れないと
// 陽性対照が取れない)。
const FLUSH_DEBOUNCE_MS = 250;

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

  // __webx68kScsiOpfsPath(「もうOPFSにある物を開くだけ」の経路)を優先する。
  // __webx68kScsiUrl(プローブが使う、リモートから取り込む経路)はそのまま残す。
  const opfsPath = g.__webx68kScsiOpfsPath;
  if (typeof opfsPath === 'string' && opfsPath.length > 0) {
    // secure contextでない/OPFSが無い環境では navigator.storage.getDirectory 自体が
    // 消える(feedback_secure_context_hides_capability.md参照)。この分岐は必ず残すこと。
    if (
      (typeof isSecureContext !== 'undefined' && !isSecureContext) ||
      typeof navigator === 'undefined' ||
      !navigator.storage ||
      typeof navigator.storage.getDirectory !== 'function'
    ) {
      return { mode: 'none', reason: 'secure context でない/OPFSが無い' };
    }
    return setupScsiOpfsFromExisting(opfsPath);
  }

  if (!g.__webx68kScsiOpfs) {
    return { mode: 'none', reason: '__webx68kScsiOpfsPath も __webx68kScsiOpfs も未設定' };
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

  return installScsiHooks(handle, imported);
}

/**
 * 「もうOPFSにある物を開くだけ」の経路(__webx68kScsiOpfsPath)。
 * URLからの取り込みは一切行わず、指定パスのファイルをそのまま開いて使う。
 * パスが無い/サイズ0なら none(理由付き)を返す。
 */
async function setupScsiOpfsFromExisting(path: string): Promise<ScsiOpfsResult> {
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) {
    return { mode: 'none', reason: `__webx68kScsiOpfsPath が不正: ${JSON.stringify(path)}` };
  }
  const fileName = segments[segments.length - 1];
  const dirSegments = segments.slice(0, -1);

  let fileHandle: FileSystemFileHandle;
  try {
    let dir = await navigator.storage.getDirectory();
    for (const seg of dirSegments) {
      dir = await dir.getDirectoryHandle(seg, { create: false });
    }
    fileHandle = await dir.getFileHandle(fileName, { create: false });
  } catch (e) {
    return { mode: 'none', reason: `OPFS上に ${path} が無い: ${String(e)}` };
  }

  let handle: FileSystemSyncAccessHandle;
  try {
    handle = await fileHandle.createSyncAccessHandle();
  } catch (e) {
    return { mode: 'none', reason: `同期ハンドルの取得に失敗: ${String(e)}` };
  }

  const size = handle.getSize();
  if (size === 0) {
    try {
      handle.close();
    } catch {
      /* close失敗は無視(どうせ捨てるハンドル) */
    }
    return { mode: 'none', reason: `${path} のサイズが0` };
  }

  return installScsiHooks(handle, false);
}

/**
 * __webx68kScsiRead/__webx68kScsiWrite/__webx68kScsiSize/__webx68kScsiFlushNow のフックを
 * Workerのglobalthisへ生やし、デバウンスflush・保険の定期flushを開始する
 * (2つの経路(URL取り込み/OPFS直接オープン)で共通の後処理)。
 * テスト(test/scsi-opfs.test.ts)から直接呼べるようexportする。
 */
export function installScsiHooks(handle: FileSystemSyncAccessHandle, imported: boolean): ScsiOpfsResult {
  const g = globalThis as Record<string, unknown>;
  const size = handle.getSize();
  let dirty = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // dirtyなら同期的にflushし、実際にflushしたら true を返す(何もしなかった/失敗したら false)。
  // デバウンスタイマ・保険のsetInterval・明示flush(__webx68kScsiFlushNow)の3箇所から
  // 共通で使う。
  const flushIfDirty = (): boolean => {
    if (!dirty) return false;
    try {
      handle.flush();
      dirty = false;
      return true;
    } catch {
      // 失敗時はdirtyを保持し、次回の機会(次のデバウンス/保険interval/次の明示flush)で
      // 再試行する。
      return false;
    }
  };

  const scheduleDebounceFlush = (): void => {
    const raw = g.__webx68kScsiFlushDebounceMs;
    const debounceMs = typeof raw === 'number' && Number.isFinite(raw) ? raw : FLUSH_DEBOUNCE_MS;
    if (debounceMs <= 0) return; // 0以下はデバウンス無効(故障注入)
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      flushIfDirty();
    }, debounceMs);
  };

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
      scheduleDebounceFlush();
      return 0;
    } catch {
      return -1;
    }
  };
  // js_scsi_get_size() (core-shim.c) が優先して返す値。OPFS経路ではXHRでサイズを
  // 取り直さないため、ここで確定値を渡しておく。
  g.__webx68kScsiSize = size;

  // 保険として残す: デバウンスのタイマが何かの理由(タイマ精度・例外・将来の変更等)で
  // 発火しなかったときの取りこぼし防止。主役はあくまでデバウンス側。
  setInterval(() => {
    flushIfDirty();
  }, FLUSH_INTERVAL_MS);

  // main → Worker への「今すぐflushして」の明示口(src/core-worker.tsのflushScsiコマンド
  // ハンドラから呼ばれる。docs/STORAGE-SCSI.md参照)。OPFSを使っていない経路(mode: 'none')
  // では installScsiHooks 自体が呼ばれないため、この関数も生えない
  // (呼び出し側は存在チェックすること)。
  g.__webx68kScsiFlushNow = (): boolean => flushIfDirty();

  return { mode: 'opfs', bytes: size, imported };
}
