// HostFS (feature/hostfs) P2a #2: FileSystemDirectoryHandle(File System Access API /
// OPFS、どちらも同じインターフェイス)を使う本物のバックエンド。
//
// パス解決: _NAMESTSのパス('\'区切り)を要素に分け、ホスト側の名前と大小無視で照合する
// (getDirectoryHandle/getFileHandleは大文字小文字を区別して完全一致するAPIのため、
// 自前でentries()を舐めて探す)。
//
// 名前変換・日時変換・「出さない」判定は name-convert.ts / dos-datetime.ts に委譲する。
// 出さなかった名前は件数だけconsole.warnへ出す(親からの指示書: 沈黙させない)。

import type { HostFileSystem, HostFsFileEntry, HostWriteHandle } from './filesystem';
import {
  FS_OK,
  FS_ERR_FILE_NOT_FOUND,
  FS_ERR_DIR_NOT_FOUND,
  FS_ERR_WRITE_PROTECTED,
  FS_ERR_DIR_EXISTS,
  FS_ERR_DIR_NOT_EMPTY,
  FS_ERR_RENAME_TARGET_EXISTS,
  FS_ERR_DISK_FULL,
  FS_ERR_FILE_EXISTS,
} from './filesystem';
import { convertHostNameToHuman68k, convertGuestNameToHostFileName } from './name-convert';
import { DIRECTORY_DATE, DIRECTORY_TIME, dateFromMillis, timeFromMillis, packDateTime } from './dos-datetime';

const ATTR_DIRECTORY = 0x10;
const ATTR_FILE = 0x20;

/**
 * W2a(書き込み): 書き込み用に開いたファイルの中身をメモリ上のバッファに持つ。
 * write/seekはこのバッファに対して行い、close()で変更があれば初めて
 * createWritable()→write→close()で実体へ反映する(親からの指示書どおり、
 * 「閉じたときにまとめて反映」で原子的に差し替える。ゴミ箱は作らない)。
 */
class HostFolderWriteHandle implements HostWriteHandle {
  private buf: Uint8Array;
  private dirty = false;

  constructor(
    private readonly fileHandle: FileSystemFileHandle,
    initial: Uint8Array,
  ) {
    this.buf = initial;
  }

  get size(): number {
    return this.buf.length;
  }

  write(pos: number, data: Uint8Array): void {
    const end = pos + data.length;
    if (end > this.buf.length) {
      const grown = new Uint8Array(end); // 0埋め(伸ばした分)
      grown.set(this.buf);
      this.buf = grown;
    }
    this.buf.set(data, pos);
    this.dirty = true;
  }

  async close(): Promise<void> {
    if (!this.dirty) return;
    const writable = await this.fileHandle.createWritable();
    await writable.write(this.buf as unknown as BufferSource);
    await writable.close();
    this.dirty = false;
  }
}

function splitPath(path: string): string[] {
  return path.split('\\').filter((seg) => seg.length > 0);
}

/** dirの直下から、名前を大文字小文字無視で探す(見つからなければnull)。 */
async function findChild(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle | FileSystemFileHandle | null> {
  const upper = name.toUpperCase();
  // TS標準libにasyncイテレータの型が無い環境向けに any 経由で回す。
  const it = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
  for await (const [childName, handle] of it) {
    if (childName.toUpperCase() === upper) return handle as FileSystemDirectoryHandle | FileSystemFileHandle;
  }
  return null;
}

/**
 * findChild()と同じ大文字小文字無視の検索だが、見つかったホスト側の実際の名前
 * (Unicodeそのまま)も一緒に返す。「表示していない名前」の通知(rejectedNamesByDir)は
 * Human68k側のパス(大文字化・8.3形式)ではなく、利用者がホスト側フォルダで実際に
 * 目にする名前でパスを組み立てたいため、resolveDirWithRealPath()専用に用意する
 * (findChild()の呼び出し元11箇所の戻り値型を変えて書き換えるよりも安全なため)。
 */
async function findChildEntry(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<{ name: string; handle: FileSystemDirectoryHandle | FileSystemFileHandle } | null> {
  const upper = name.toUpperCase();
  const it = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
  for await (const [childName, handle] of it) {
    if (childName.toUpperCase() === upper) {
      return { name: childName, handle: handle as FileSystemDirectoryHandle | FileSystemFileHandle };
    }
  }
  return null;
}

/**
 * dirの直下から、ゲストの名前+拡張子(CP932疑似文字列)と大文字小文字無視で一致する
 * エントリを探す(name-convert.tsのconvertHostNameToHuman68kと同じ「CP932疑似文字列
 * 空間」で比較する。readFileと同じ流儀)。W2a(書き込み)の各操作で共通に使う。
 */
async function findExistingByGuestName(
  dir: FileSystemDirectoryHandle,
  name: string,
  ext: string,
): Promise<{ hostName: string; handle: FileSystemDirectoryHandle | FileSystemFileHandle } | null> {
  const wantFull = (ext.length > 0 ? `${name}.${ext}` : name).toUpperCase();
  const it = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
  for await (const [childName, handle] of it) {
    const conv = convertHostNameToHuman68k(childName);
    if (!conv) continue;
    const full = (conv.ext.length > 0 ? `${conv.name}.${conv.ext}` : conv.name).toUpperCase();
    if (full === wantFull) {
      return { hostName: childName, handle: handle as FileSystemDirectoryHandle | FileSystemFileHandle };
    }
  }
  return null;
}

/** ディレクトリが空か(rmdir用)。 */
async function isDirEmpty(dir: FileSystemDirectoryHandle): Promise<boolean> {
  const it = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
  for await (const _entry of it) {
    return false;
  }
  return true;
}

/**
 * 書き込み操作で投げられた例外をエラーコードへ写す。QuotaExceededErrorだけ
 * FS_ERR_DISK_FULL(-23)にし、それ以外(想定外)は沈黙させずコンソールへ出したうえで
 * 安全側(見つからない扱い)にする。
 */
function mapWriteError(err: unknown): number {
  if (err instanceof DOMException && err.name === 'QuotaExceededError') return FS_ERR_DISK_FULL;
  console.warn('[HostFS] 書き込み操作で想定外のエラー', err);
  return FS_ERR_FILE_NOT_FOUND;
}

export class HostFolderFs implements HostFileSystem {
  private readonly root: FileSystemDirectoryHandle;
  /** つなぐときに選んだモード(readwriteならtrue)。書き込み系はこれがfalseなら全部-19。 */
  private readonly writableFlag: boolean;
  /**
   * これまでlistDir()した各ディレクトリごとに、Human68kで表せず出さなかった
   * ホスト側の実際の名前(Unicodeそのまま、REJECTED_PATHS_LIMIT件まで)を持つ
   * (利用者向け通知用、追加分。「version.jsonが出ない理由が分からない」を防ぐため、
   * UI側でツールチップに出す)。
   *
   * キーは接続したフォルダからの相対パスをホスト側の実名で'/'区切りにしたもの
   * (ルート直下は''。Human68k側のパス文字列ではない。8.3形式へ丸めてしまうと
   * 利用者がホスト側フォルダで実際に目にする綴りと一致しなくなるため)。
   * 同じディレクトリを再度listDir()したら、そのキーだけ丸ごと入れ替える
   * (ホスト側で名前を直せば一覧から消える、という利用者の直感に合わせるため)。
   *
   * フォルダを外す/つなぎ替えるとこのHostFolderFsインスタンスごと捨てられる
   * (src/hostfs/worker-bridge.tsのattach/detachは毎回new HostFolderFs()する)ので、
   * ここで明示的にclear()する必要はない。コアのリセットではインスタンスを
   * 作り直さないため、ここは自然に残る(ホスト側フォルダの実際の状態は
   * コアのリセットと無関係、という利用者からの指示書のとおり)。
   */
  private readonly rejectedNamesByDir = new Map<string, string[]>();
  /** 上記と対のディレクトリごとの実数(REJECTED_PATHS_LIMITで切り詰めても実数のまま持つ)。 */
  private readonly rejectedCountByDir = new Map<string, number>();
  /**
   * 1ディレクトリあたり保持する名前の上限、かつgetRejectedSummary()が返す
   * 全ディレクトリ合算の一覧の上限。後者はWorker→ページへ送るメッセージ
   * (frame eventへの相乗り)が際限なく肥大しないための保険で、ページ側の
   * ツールチップ表示自体はさらに手前の20行で切っている(main.ts)。
   * 200としたのは、通常この経路に来る名前(拡張子4文字以上など)は少数のはずで、
   * 極端に荒れたフォルダでもメッセージサイズが問題にならない範囲という目安。
   */
  static readonly REJECTED_PATHS_LIMIT = 200;

  constructor(root: FileSystemDirectoryHandle, writable: boolean) {
    this.root = root;
    this.writableFlag = writable;
  }

  private async resolveDir(path: string): Promise<FileSystemDirectoryHandle | null> {
    let cur: FileSystemDirectoryHandle = this.root;
    for (const seg of splitPath(path)) {
      const child = await findChild(cur, seg);
      if (!child || child.kind !== 'directory') return null;
      cur = child as FileSystemDirectoryHandle;
    }
    return cur;
  }

  /**
   * resolveDir()と同じ大文字小文字無視の解決だが、たどった各セグメントの
   * ホスト側の実際の名前(Unicode)も一緒に返す。listDir()専用
   * (rejectedNamesByDirのキー・表示パスをホスト側の実名で作るため)。
   * 走査コストはパスの深さぶんだけで軽いため、resolveDir()と処理が重複するのは
   * 許容し、既存11箇所のresolveDir()呼び出しの戻り値型は変えない。
   */
  private async resolveDirWithRealPath(
    path: string,
  ): Promise<{ dir: FileSystemDirectoryHandle; realSegments: string[] } | null> {
    let cur: FileSystemDirectoryHandle = this.root;
    const realSegments: string[] = [];
    for (const seg of splitPath(path)) {
      const found = await findChildEntry(cur, seg);
      if (!found || found.handle.kind !== 'directory') return null;
      cur = found.handle as FileSystemDirectoryHandle;
      realSegments.push(found.name);
    }
    return { dir: cur, realSegments };
  }

  async listDir(path: string): Promise<HostFsFileEntry[]> {
    const resolved = await this.resolveDirWithRealPath(path);
    if (!resolved) return [];
    const { dir, realSegments } = resolved;
    // ホスト側の実名を'/'区切りにしたキー(ルート直下は'')。getRejectedSummary()での
    // 表示パス組み立てにもこのまま使う。
    const dirKey = realSegments.join('/');

    const entries: HostFsFileEntry[] = [];
    // このディレクトリぶんだけをこの呼び出しでまとめ、最後に丸ごと入れ替える
    // (同じディレクトリを再度listDir()したら、そのキーの分だけ消える/更新される
    // ようにするため。累計しない)。
    const rejectedNames: string[] = [];
    let rejectedCount = 0;
    const it = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
    for await (const [childName, handle] of it) {
      const conv = convertHostNameToHuman68k(childName);
      if (!conv) {
        rejectedCount++;
        if (rejectedNames.length < HostFolderFs.REJECTED_PATHS_LIMIT) rejectedNames.push(childName);
        continue;
      }
      if (handle.kind === 'directory') {
        entries.push({
          name: conv.name,
          ext: conv.ext,
          size: 0,
          date: DIRECTORY_DATE,
          time: DIRECTORY_TIME,
          attr: ATTR_DIRECTORY,
        });
      } else {
        const fileHandle = handle as FileSystemFileHandle;
        const file = await fileHandle.getFile();
        entries.push({
          name: conv.name,
          ext: conv.ext,
          size: file.size,
          date: dateFromMillis(file.lastModified),
          time: timeFromMillis(file.lastModified),
          attr: ATTR_FILE,
        });
      }
    }
    if (rejectedCount > 0) {
      this.rejectedNamesByDir.set(dirKey, rejectedNames);
      this.rejectedCountByDir.set(dirKey, rejectedCount);
      console.warn(`[HostFS] 8.3形式へ変換できず出さなかった名前: ${rejectedCount}件 (/${dirKey})`);
    } else {
      // 0件になった(=ホスト側で直された)ら、そのディレクトリ分はMapから消す
      // (Mapが際限なく肥大するのを防ぐ)。
      this.rejectedNamesByDir.delete(dirKey);
      this.rejectedCountByDir.delete(dirKey);
    }
    return entries;
  }

  /**
   * これまでlistDir()した全ディレクトリぶんをまとめた「表示していない名前」の一覧を返す
   * (Worker→ページの通知、src/hostfs/worker-bridge.tsのgetStatus()から使う)。
   * パスは接続したフォルダからの相対パス('/'区切り、ルート直下は'/名前')で、
   * ホスト側の実際の名前(Unicode)をそのまま使う。並びはパス文字列順
   * (利用者からの指示書のとおり)。
   *
   * totalCountは全ディレクトリの実数の合計(pathsを切り詰めても正しい値のまま)。
   * pathsはREJECTED_PATHS_LIMIT件までに切り詰める(コメント参照)。
   */
  getRejectedSummary(): { totalCount: number; paths: string[] } {
    const all: string[] = [];
    let totalCount = 0;
    for (const [dirKey, names] of this.rejectedNamesByDir) {
      totalCount += this.rejectedCountByDir.get(dirKey) ?? names.length;
      for (const name of names) {
        all.push(dirKey === '' ? `/${name}` : `/${dirKey}/${name}`);
      }
    }
    all.sort();
    return { totalCount, paths: all.slice(0, HostFolderFs.REJECTED_PATHS_LIMIT) };
  }

  /** $41(cd)用: パスが実在するディレクトリか。ルート('')は常にtrue。 */
  async dirExists(path: string): Promise<boolean> {
    if (path === '' || path === '\\') return true;
    return (await this.resolveDir(path)) !== null;
  }

  async readFile(path: string, name: string, ext: string): Promise<Uint8Array | null> {
    const dir = await this.resolveDir(path);
    if (!dir) return null;

    const wantFull = ext.length > 0 ? `${name}.${ext}`.toUpperCase() : name.toUpperCase();
    const it = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
    for await (const [childName, handle] of it) {
      if (handle.kind !== 'file') continue;
      const conv = convertHostNameToHuman68k(childName);
      if (!conv) continue;
      const full = conv.ext.length > 0 ? `${conv.name}.${conv.ext}` : conv.name;
      if (full.toUpperCase() !== wantFull) continue;
      const fileHandle = handle as FileSystemFileHandle;
      const file = await fileHandle.getFile();
      const buf = await file.arrayBuffer();
      return new Uint8Array(buf);
    }
    return null;
  }

  // --- ここから書き込み系(W2a)。dispatcherへの配線はまだ無い(コマンド番号未確定)。 ---

  isWritable(): boolean {
    return this.writableFlag;
  }

  async createFile(path: string, name: string, ext: string, failIfExists: boolean): Promise<number> {
    if (!this.writableFlag) return FS_ERR_WRITE_PROTECTED;
    const dir = await this.resolveDir(path);
    if (!dir) return FS_ERR_DIR_NOT_FOUND;

    const existing = await findExistingByGuestName(dir, name, ext);
    if (existing) {
      if (existing.handle.kind === 'directory') return FS_ERR_FILE_EXISTS; // 名前がディレクトリと衝突
      if (failIfExists) return FS_ERR_FILE_EXISTS; // _NEWFILE相当
      try {
        // _CREATE相当: 上書きして空にする(createWritableの既定=keepExistingData:falseで
        // 書かずにcloseすれば0バイトへ切り詰まる)。
        const writable = await (existing.handle as FileSystemFileHandle).createWritable();
        await writable.close();
        return FS_OK;
      } catch (err) {
        return mapWriteError(err);
      }
    }

    const hostName = convertGuestNameToHostFileName(name, ext);
    try {
      await dir.getFileHandle(hostName, { create: true });
      return FS_OK;
    } catch (err) {
      return mapWriteError(err);
    }
  }

  async openWrite(path: string, name: string, ext: string): Promise<HostWriteHandle | number> {
    if (!this.writableFlag) return FS_ERR_WRITE_PROTECTED;
    const dir = await this.resolveDir(path);
    if (!dir) return FS_ERR_DIR_NOT_FOUND;

    const existing = await findExistingByGuestName(dir, name, ext);
    if (!existing || existing.handle.kind !== 'file') return FS_ERR_FILE_NOT_FOUND;
    const fileHandle = existing.handle as FileSystemFileHandle;
    const file = await fileHandle.getFile();
    const content = new Uint8Array(await file.arrayBuffer());
    return new HostFolderWriteHandle(fileHandle, content);
  }

  async deleteFile(path: string, name: string, ext: string): Promise<number> {
    if (!this.writableFlag) return FS_ERR_WRITE_PROTECTED;
    const dir = await this.resolveDir(path);
    if (!dir) return FS_ERR_DIR_NOT_FOUND;

    const existing = await findExistingByGuestName(dir, name, ext);
    if (!existing || existing.handle.kind !== 'file') return FS_ERR_FILE_NOT_FOUND;
    try {
      await (dir as unknown as { removeEntry(name: string): Promise<void> }).removeEntry(existing.hostName);
      return FS_OK;
    } catch (err) {
      return mapWriteError(err);
    }
  }

  async mkdir(path: string, name: string): Promise<number> {
    if (!this.writableFlag) return FS_ERR_WRITE_PROTECTED;
    const dir = await this.resolveDir(path);
    if (!dir) return FS_ERR_DIR_NOT_FOUND;

    const existing = await findExistingByGuestName(dir, name, '');
    if (existing) return FS_ERR_DIR_EXISTS;

    const hostName = convertGuestNameToHostFileName(name, '');
    try {
      await dir.getDirectoryHandle(hostName, { create: true });
      return FS_OK;
    } catch (err) {
      return mapWriteError(err);
    }
  }

  async rmdir(path: string, name: string): Promise<number> {
    if (!this.writableFlag) return FS_ERR_WRITE_PROTECTED;
    const dir = await this.resolveDir(path);
    if (!dir) return FS_ERR_DIR_NOT_FOUND;

    const existing = await findExistingByGuestName(dir, name, '');
    if (!existing || existing.handle.kind !== 'directory') return FS_ERR_DIR_NOT_FOUND;

    const empty = await isDirEmpty(existing.handle as FileSystemDirectoryHandle);
    if (!empty) return FS_ERR_DIR_NOT_EMPTY;

    try {
      await (dir as unknown as { removeEntry(name: string): Promise<void> }).removeEntry(existing.hostName);
      return FS_OK;
    } catch (err) {
      return mapWriteError(err);
    }
  }

  async rename(
    path: string,
    oldName: string,
    oldExt: string,
    newName: string,
    newExt: string,
    isDir: boolean,
  ): Promise<number> {
    if (!this.writableFlag) return FS_ERR_WRITE_PROTECTED;
    const dir = await this.resolveDir(path);
    if (!dir) return FS_ERR_DIR_NOT_FOUND;

    const existing = await findExistingByGuestName(dir, oldName, oldExt);
    if (!existing) return isDir ? FS_ERR_DIR_NOT_FOUND : FS_ERR_FILE_NOT_FOUND;

    const targetExisting = await findExistingByGuestName(dir, newName, newExt);
    if (targetExisting) return FS_ERR_RENAME_TARGET_EXISTS;

    const newHostName = convertGuestNameToHostFileName(newName, newExt);

    if (!isDir) {
      const fileHandle = existing.handle as FileSystemFileHandle & {
        move?: (name: string) => Promise<void>;
      };
      if (typeof fileHandle.move === 'function') {
        try {
          await fileHandle.move(newHostName);
          return FS_OK;
        } catch (err) {
          return mapWriteError(err);
        }
      }
      // move()が無い環境: コピーしてから元を消す(親からの指示書のとおり)。
      try {
        const file = await fileHandle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        const newHandle = await dir.getFileHandle(newHostName, { create: true });
        const writable = await newHandle.createWritable();
        await writable.write(bytes as unknown as BufferSource);
        await writable.close();
        await (dir as unknown as { removeEntry(name: string): Promise<void> }).removeEntry(existing.hostName);
        return FS_OK;
      } catch (err) {
        return mapWriteError(err);
      }
    }

    // ディレクトリのrenameはmove()が使えるときだけ(親からの指示書のとおり)。
    const dirHandle = existing.handle as FileSystemDirectoryHandle & {
      move?: (name: string) => Promise<void>;
    };
    if (typeof dirHandle.move !== 'function') return FS_ERR_WRITE_PROTECTED;
    try {
      await dirHandle.move(newHostName);
      return FS_OK;
    } catch (err) {
      return mapWriteError(err);
    }
  }

  /**
   * _FILEDATE相当。File System Access APIには最終更新日時を設定する手段が無いため、
   * 書き込み可能モードなら何もせず成功を返す(親からの指示書のとおり)。
   */
  async setFileDate(_path: string, _name: string, _ext: string): Promise<number> {
    return this.writableFlag ? FS_OK : FS_ERR_WRITE_PROTECTED;
  }

  /**
   * $4f(_FILEDATE、取得)相当。読み取り操作なので書き込み可否は問わない
   * (getAttrと同じ扱い)。ディレクトリはlastModifiedが無いためDIRECTORY_DATE/TIME
   * (1980-01-01 00:00)を返す(listDirと同じ扱い)。
   */
  async getFileDate(path: string, name: string, ext: string): Promise<number> {
    const dir = await this.resolveDir(path);
    if (!dir) return FS_ERR_DIR_NOT_FOUND;
    const existing = await findExistingByGuestName(dir, name, ext);
    if (!existing) return FS_ERR_FILE_NOT_FOUND;
    if (existing.handle.kind === 'directory') {
      return packDateTime(DIRECTORY_DATE, DIRECTORY_TIME);
    }
    const file = await (existing.handle as FileSystemFileHandle).getFile();
    return packDateTime(dateFromMillis(file.lastModified), timeFromMillis(file.lastModified));
  }

  async getAttr(path: string, name: string, ext: string): Promise<number> {
    const dir = await this.resolveDir(path);
    if (!dir) return FS_ERR_DIR_NOT_FOUND;
    const existing = await findExistingByGuestName(dir, name, ext);
    if (!existing) return FS_ERR_FILE_NOT_FOUND;
    return existing.handle.kind === 'directory' ? ATTR_DIRECTORY : ATTR_FILE;
  }

  /**
   * _CHMOD(設定)相当。ホストに属性を保存する手段が無いため、書き込み可能モードなら
   * 何もせず成功を返す(親からの指示書のとおり)。
   */
  async setAttr(_path: string, _name: string, _ext: string, _attr: number): Promise<number> {
    return this.writableFlag ? FS_OK : FS_ERR_WRITE_PROTECTED;
  }
}
