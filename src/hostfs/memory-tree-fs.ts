// HostFS (feature/hostfs) W2a 用: テストで使う「メモリ上のツリー」バックエンド。
//
// HostFolderFs(本物のFileSystemDirectoryHandle)とは別に、CP932変換や8.3形式変換を
// 一切挟まない素のディレクトリツリーで、HostFileSystemインターフェイス(書き込み系含む)の
// 契約自体(エラーコード・読み取り専用モードの-19・close()まで反映されない、等)を
// 確かめるためのテスト専用実装。CP932変換の正しさはname-convert.ts/host-folder-fs.ts側の
// テストで別途見る。

import {
  type HostFileSystem,
  type HostFsFileEntry,
  type HostWriteHandle,
  FS_OK,
  FS_ERR_FILE_NOT_FOUND,
  FS_ERR_DIR_NOT_FOUND,
  FS_ERR_WRITE_PROTECTED,
  FS_ERR_DIR_EXISTS,
  FS_ERR_DIR_NOT_EMPTY,
  FS_ERR_RENAME_TARGET_EXISTS,
  FS_ERR_FILE_EXISTS,
} from './filesystem';
import { DIRECTORY_DATE, DIRECTORY_TIME } from './dos-datetime';

const ATTR_DIRECTORY = 0x10;
const ATTR_FILE = 0x20;

interface MemFileNode {
  kind: 'file';
  name: string;
  ext: string;
  content: Uint8Array;
  attr: number;
}

interface MemDirNode {
  kind: 'dir';
  name: string;
  children: Map<string, MemFileNode | MemDirNode>; // key: 大文字化した"NAME.EXT"またはディレクトリ名
}

type MemNode = MemFileNode | MemDirNode;

function fullName(name: string, ext: string): string {
  return ext.length > 0 ? `${name}.${ext}` : name;
}

/** 書き込み用に開いたファイル。close()まで実体(MemFileNode.content)へ反映しない。 */
class MemoryWriteHandle implements HostWriteHandle {
  private buf: Uint8Array;
  private dirty = false;

  constructor(private readonly node: MemFileNode) {
    this.buf = node.content.slice();
  }

  get size(): number {
    return this.buf.length;
  }

  write(pos: number, data: Uint8Array): void {
    const end = pos + data.length;
    if (end > this.buf.length) {
      const grown = new Uint8Array(end);
      grown.set(this.buf);
      this.buf = grown;
    }
    this.buf.set(data, pos);
    this.dirty = true;
  }

  async close(): Promise<void> {
    if (!this.dirty) return;
    this.node.content = this.buf;
    this.dirty = false;
  }
}

export class MemoryTreeFs implements HostFileSystem {
  private readonly root: MemDirNode = { kind: 'dir', name: '', children: new Map() };

  constructor(private readonly writableFlag: boolean) {}

  private resolveDir(path: string): MemDirNode | null {
    let cur = this.root;
    for (const seg of path.split('\\').filter((s) => s.length > 0)) {
      const child = cur.children.get(seg.toUpperCase());
      if (!child || child.kind !== 'dir') return null;
      cur = child;
    }
    return cur;
  }

  async listDir(path: string): Promise<HostFsFileEntry[]> {
    const dir = this.resolveDir(path);
    if (!dir) return [];
    const out: HostFsFileEntry[] = [];
    for (const child of dir.children.values()) {
      if (child.kind === 'dir') {
        out.push({ name: child.name, ext: '', size: 0, date: DIRECTORY_DATE, time: DIRECTORY_TIME, attr: ATTR_DIRECTORY });
      } else {
        out.push({
          name: child.name,
          ext: child.ext,
          size: child.content.length,
          date: DIRECTORY_DATE,
          time: DIRECTORY_TIME,
          attr: child.attr,
        });
      }
    }
    return out;
  }

  async readFile(path: string, name: string, ext: string): Promise<Uint8Array | null> {
    const dir = this.resolveDir(path);
    if (!dir) return null;
    const node = dir.children.get(fullName(name, ext).toUpperCase());
    if (!node || node.kind !== 'file') return null;
    return node.content;
  }

  async dirExists(path: string): Promise<boolean> {
    if (path === '' || path === '\\') return true;
    return this.resolveDir(path) !== null;
  }

  isWritable(): boolean {
    return this.writableFlag;
  }

  async createFile(path: string, name: string, ext: string, failIfExists: boolean): Promise<number> {
    if (!this.writableFlag) return FS_ERR_WRITE_PROTECTED;
    const dir = this.resolveDir(path);
    if (!dir) return FS_ERR_DIR_NOT_FOUND;
    const key = fullName(name, ext).toUpperCase();
    const existing = dir.children.get(key);
    if (existing) {
      if (existing.kind === 'dir') return FS_ERR_FILE_EXISTS;
      if (failIfExists) return FS_ERR_FILE_EXISTS;
      existing.content = new Uint8Array(0); // _CREATE相当: 上書きして空にする
      return FS_OK;
    }
    dir.children.set(key, { kind: 'file', name, ext, content: new Uint8Array(0), attr: ATTR_FILE });
    return FS_OK;
  }

  async openWrite(path: string, name: string, ext: string): Promise<HostWriteHandle | number> {
    if (!this.writableFlag) return FS_ERR_WRITE_PROTECTED;
    const dir = this.resolveDir(path);
    if (!dir) return FS_ERR_DIR_NOT_FOUND;
    const node = dir.children.get(fullName(name, ext).toUpperCase());
    if (!node || node.kind !== 'file') return FS_ERR_FILE_NOT_FOUND;
    return new MemoryWriteHandle(node);
  }

  async deleteFile(path: string, name: string, ext: string): Promise<number> {
    if (!this.writableFlag) return FS_ERR_WRITE_PROTECTED;
    const dir = this.resolveDir(path);
    if (!dir) return FS_ERR_DIR_NOT_FOUND;
    const key = fullName(name, ext).toUpperCase();
    const node = dir.children.get(key);
    if (!node || node.kind !== 'file') return FS_ERR_FILE_NOT_FOUND;
    dir.children.delete(key);
    return FS_OK;
  }

  async mkdir(path: string, name: string): Promise<number> {
    if (!this.writableFlag) return FS_ERR_WRITE_PROTECTED;
    const dir = this.resolveDir(path);
    if (!dir) return FS_ERR_DIR_NOT_FOUND;
    const key = name.toUpperCase();
    if (dir.children.has(key)) return FS_ERR_DIR_EXISTS;
    dir.children.set(key, { kind: 'dir', name, children: new Map() });
    return FS_OK;
  }

  async rmdir(path: string, name: string): Promise<number> {
    if (!this.writableFlag) return FS_ERR_WRITE_PROTECTED;
    const dir = this.resolveDir(path);
    if (!dir) return FS_ERR_DIR_NOT_FOUND;
    const key = name.toUpperCase();
    const node = dir.children.get(key);
    if (!node || node.kind !== 'dir') return FS_ERR_DIR_NOT_FOUND;
    if (node.children.size > 0) return FS_ERR_DIR_NOT_EMPTY;
    dir.children.delete(key);
    return FS_OK;
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
    const dir = this.resolveDir(path);
    if (!dir) return FS_ERR_DIR_NOT_FOUND;
    const oldKey = isDir ? oldName.toUpperCase() : fullName(oldName, oldExt).toUpperCase();
    const newKey = isDir ? newName.toUpperCase() : fullName(newName, newExt).toUpperCase();
    const node: MemNode | undefined = dir.children.get(oldKey);
    if (!node || (isDir ? node.kind !== 'dir' : node.kind !== 'file')) {
      return isDir ? FS_ERR_DIR_NOT_FOUND : FS_ERR_FILE_NOT_FOUND;
    }
    if (dir.children.has(newKey)) return FS_ERR_RENAME_TARGET_EXISTS;
    dir.children.delete(oldKey);
    if (node.kind === 'file') {
      node.name = newName;
      node.ext = newExt;
    } else {
      node.name = newName;
    }
    dir.children.set(newKey, node);
    return FS_OK;
  }

  async setFileDate(_path: string, _name: string, _ext: string): Promise<number> {
    return this.writableFlag ? FS_OK : FS_ERR_WRITE_PROTECTED;
  }

  async getAttr(path: string, name: string, ext: string): Promise<number> {
    const dir = this.resolveDir(path);
    if (!dir) return FS_ERR_DIR_NOT_FOUND;
    const node = dir.children.get(fullName(name, ext).toUpperCase());
    if (!node) return FS_ERR_FILE_NOT_FOUND;
    return node.kind === 'dir' ? ATTR_DIRECTORY : node.attr;
  }

  async setAttr(_path: string, _name: string, _ext: string, _attr: number): Promise<number> {
    return this.writableFlag ? FS_OK : FS_ERR_WRITE_PROTECTED;
  }
}
