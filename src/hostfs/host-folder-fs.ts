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
   * 直近のlistDir()呼び出し1回ぶんで出さなかった名前の件数(ログ用、テストからも
   * 読めるようpublicにする)。累計にすると2→4→…と際限なく伸びてdirのたびに
   * 増えているように見えてしまうため、呼び出しごとに0へ戻す。
   */
  rejectedCount = 0;

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

  async listDir(path: string): Promise<HostFsFileEntry[]> {
    const dir = await this.resolveDir(path);
    if (!dir) return [];

    // dirのたびに件数を初期化する(累計だと2→4→…と際限なく伸びて紛らわしいうえ、
    // 「今回の一覧で何件出さなかったか」という肝心の情報を隠してしまうため。
    // rejectedCountは「直近のlistDir呼び出し1回ぶんの件数」という意味に変える)。
    this.rejectedCount = 0;
    const entries: HostFsFileEntry[] = [];
    const it = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
    for await (const [childName, handle] of it) {
      const conv = convertHostNameToHuman68k(childName);
      if (!conv) {
        this.rejectedCount++;
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
    if (this.rejectedCount > 0) {
      console.warn(`[HostFS] 8.3形式へ変換できず出さなかった名前: ${this.rejectedCount}件`);
    }
    return entries;
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
