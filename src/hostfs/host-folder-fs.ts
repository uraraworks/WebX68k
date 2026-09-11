// HostFS (feature/hostfs) P2a #2: FileSystemDirectoryHandle(File System Access API /
// OPFS、どちらも同じインターフェイス)を使う本物のバックエンド。
//
// パス解決: _NAMESTSのパス('\'区切り)を要素に分け、ホスト側の名前と大小無視で照合する
// (getDirectoryHandle/getFileHandleは大文字小文字を区別して完全一致するAPIのため、
// 自前でentries()を舐めて探す)。
//
// 名前変換・日時変換・「出さない」判定は name-convert.ts / dos-datetime.ts に委譲する。
// 出さなかった名前は件数だけconsole.warnへ出す(親からの指示書: 沈黙させない)。

import type { HostFileSystem, HostFsFileEntry } from './filesystem';
import { convertHostNameToHuman68k } from './name-convert';
import { DIRECTORY_DATE, DIRECTORY_TIME, dateFromMillis, timeFromMillis } from './dos-datetime';

const ATTR_DIRECTORY = 0x10;
const ATTR_FILE = 0x20;

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

export class HostFolderFs implements HostFileSystem {
  private readonly root: FileSystemDirectoryHandle;
  /** 出さなかった名前の件数(ログ用、テストからも読めるようpublicにする)。 */
  rejectedCount = 0;

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root;
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
}
