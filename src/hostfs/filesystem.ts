// HostFS (feature/hostfs) 用: ファイルシステム抽象。
//
// P2a #2までは非同期API(listDir/readFile/dirExists)だけを定義していた(読み取り専用)。
// ここから書き込み系API(W2a)を足す。ただし今回はコマンド番号に依存しない部分だけ
// (親からの指示書のとおり: dispatcherへの振り分けはまだ足さない。書き込み系コマンドの
// 番号は並行実験の結果待ちのため)。
//
// エラーコードはPRO-68Kマニュアル p.70-71 の一覧に合わせる。このモジュールで使うものだけ
// ここに列挙する(HostFsErrorCode参照)。

import type { FakeFsDate, FakeFsTime } from './filbuf';
import { packDateTime } from './dos-datetime';

/** 正常終了。 */
export const FS_OK = 0;
/** -2: ファイルが見つからない。 */
export const FS_ERR_FILE_NOT_FOUND = -2;
/** -3: ディレクトリが見つからない。 */
export const FS_ERR_DIR_NOT_FOUND = -3;
/** -19: 書き込みができない(読み取り専用モード、またはrename未対応の場合)。 */
export const FS_ERR_WRITE_PROTECTED = -19;
/** -20: ディレクトリが既にある(mkdir)。 */
export const FS_ERR_DIR_EXISTS = -20;
/** -21: ディレクトリの中にファイルがある(rmdir、空でない)。 */
export const FS_ERR_DIR_NOT_EMPTY = -21;
/** -22: リネーム先がすでにある。 */
export const FS_ERR_RENAME_TARGET_EXISTS = -22;
/** -23: ディスクが一杯(実書き込みが失敗した場合、例: QuotaExceededError)。 */
export const FS_ERR_DISK_FULL = -23;
/** -80: ファイルがすでに存在する(_NEWFILE相当、上書き不可の新規作成)。 */
export const FS_ERR_FILE_EXISTS = -80;

/**
 * つなぐときに選ぶ書き込みモード。'read'は読み取り専用(showDirectoryPickerに
 * { mode: 'read' }を渡す)、'readwrite'は書き込みも許可({ mode: 'readwrite' })。
 * handleと一緒にIndexedDBへ保存し、再接続でも同じモードでrequestPermissionする
 * (host-folder-store.ts参照)。
 */
export type HostFsConnectMode = 'read' | 'readwrite';

/**
 * 書き込み用に開いたファイル(W2a)。中身はメモリ上のバッファに持ち、write/seekは
 * すべてこのバッファに対して行う。ファイルサイズより先へ書いたら0で埋めて伸ばす。
 * close()で変更があれば初めて実体へ反映する(createWritable→write→close、
 * 親からの指示書どおり「閉じたときにまとめて反映」で原子的に差し替える)。
 */
export interface HostWriteHandle {
  /** 現在のファイルサイズ(バッファ長)。 */
  readonly size: number;
  /** posへdataを書く。size()を超える位置なら0埋めで伸ばす。 */
  write(pos: number, data: Uint8Array): void;
  /** 変更があれば実体へ反映して閉じる。変更が無ければ何もしない。 */
  close(): Promise<void>;
}

export interface HostFsFileEntry {
  /** 8.3形式の本体(拡張子を除く、大文字)。 */
  name: string;
  /** 拡張子(先頭ドット無し、大文字)。 */
  ext: string;
  size: number;
  date: FakeFsDate;
  time: FakeFsTime;
  /** FAT属性。通常ファイルは0x20(アーカイブ)。 */
  attr: number;
}

export interface HostFileSystem {
  /**
   * 指定パス(_NAMESTSから復元した '\' 区切りの文字列)のディレクトリ一覧を返す。
   * 非同期(Promise)であること自体が本機能の要件(dispatcher側で保留→ポーリングの
   * 経路を必ず通すため)。ワイルドカード('?')の照合はdispatcher側で行うため、
   * ここでは絞り込まず、そのディレクトリの全件を返してよい。
   */
  listDir(path: string): Promise<HostFsFileEntry[]>;

  /**
   * 指定パス・名前・拡張子(大文字、ワイルドカード無し)のファイル内容を返す。
   * 見つからなければnull。非同期であること自体が要件(open=$4aを保留→ポーリング
   * の経路に通すため)。
   */
  readFile(path: string, name: string, ext: string): Promise<Uint8Array | null>;

  /**
   * $41(cd)用: 指定パスのディレクトリが実在するか。ルート('')は常にtrue。
   * 非同期であること自体が要件(他のコマンドと同じく保留→ポーリングの経路を通す)。
   */
  dirExists(path: string): Promise<boolean>;

  // --- ここから書き込み系(W2a)。dispatcherへの配線はまだ無い(コマンド番号未確定のため)。
  // 読み取り専用モードで接続したバックエンドは、これらすべてでFS_ERR_WRITE_PROTECTED(-19)を
  // 返すこと(親からの指示書のとおり)。

  /** このバックエンドが書き込み可能モードで接続されているか。 */
  isWritable(): boolean;

  /**
   * 新しいファイルを作る(空)。すでに存在する場合の扱いはfailIfExistsで選ぶ:
   *   - false(_CREATE相当): 上書きして空にする。
   *   - true(_NEWFILE相当): FS_ERR_FILE_EXISTS(-80)。
   * 成功時はFS_OK(0)。
   */
  createFile(path: string, name: string, ext: string, failIfExists: boolean): Promise<number>;

  /**
   * 書き込み用に開く。既存ファイルなら中身を読み込んだHostWriteHandleを返す
   * (createFileで作った空ファイルを開く場合も同じ経路でよい)。見つからなければ
   * FS_ERR_FILE_NOT_FOUND(-2)を返す。
   */
  openWrite(path: string, name: string, ext: string): Promise<HostWriteHandle | number>;

  /** ファイルを削除する(removeEntry相当)。 */
  deleteFile(path: string, name: string, ext: string): Promise<number>;

  /** ディレクトリを作る。すでにあればFS_ERR_DIR_EXISTS(-20)。 */
  mkdir(path: string, name: string): Promise<number>;

  /** ディレクトリを消す。空でなければFS_ERR_DIR_NOT_EMPTY(-21)。無ければFS_ERR_DIR_NOT_FOUND(-3)。 */
  rmdir(path: string, name: string): Promise<number>;

  /**
   * ファイル/ディレクトリの名前を変える。移動先がすでにあればFS_ERR_RENAME_TARGET_EXISTS(-22)。
   * isDir=trueのとき、FileSystemFileHandle.move()相当が使えなければFS_ERR_WRITE_PROTECTED(-19)を
   * 返す(親からの指示書のとおり: ディレクトリのrenameはmoveが使えるときだけ行う)。
   */
  rename(path: string, oldName: string, oldExt: string, newName: string, newExt: string, isDir: boolean): Promise<number>;

  /**
   * _FILEDATE相当: 最終更新日時の設定。File System Access APIでは設定できないため、
   * 書き込み可能モードなら常に成功(何もしない)を返す。読み取り専用モードなら-19。
   */
  setFileDate(path: string, name: string, ext: string): Promise<number>;

  /**
   * _FILEDATE相当: 最終更新日時の取得。DATETIME形式(上位ワード=日付・下位ワード=時刻、
   * dos-datetime.tsのpackDateTime参照)のロングを返す。見つからなければ
   * FS_ERR_FILE_NOT_FOUND(-2)(ディレクトリならFS_ERR_DIR_NOT_FOUND(-3))。
   * 取得は読み取り操作のため、読み取り専用モードでも許す(getAttrと同じ扱い)。
   */
  getFileDate(path: string, name: string, ext: string): Promise<number>;

  /**
   * _CHMOD(取得)相当: 属性を返す。ディレクトリは0x10、ファイルは0x20。
   * 見つからなければFS_ERR_FILE_NOT_FOUND(-2)(ディレクトリならFS_ERR_DIR_NOT_FOUND(-3))。
   */
  getAttr(path: string, name: string, ext: string): Promise<number>;

  /**
   * _CHMOD(設定)相当: ホストに属性を保存できないため、書き込み可能モードなら常に成功
   * (何もしない)を返す。読み取り専用モードなら-19。
   */
  setAttr(path: string, name: string, ext: string, attr: number): Promise<number>;
}

const FAKE_ENTRIES: HostFsFileEntry[] = [
  {
    name: 'HELLO',
    ext: 'TXT',
    size: 1234,
    date: { year: 2026, month: 9, day: 11 },
    time: { hour: 12, minute: 34, second: 56 },
    attr: 0x20,
  },
  {
    name: 'WORLD',
    ext: 'DOC',
    size: 5678,
    date: { year: 2026, month: 1, day: 2 },
    time: { hour: 3, minute: 4, second: 6 },
    attr: 0x20,
  },
];

/** entryの宣言サイズちょうどになるよう、フレーズを繰り返して埋めた内容を作る。 */
function makeFakeContent(entry: HostFsFileEntry): Uint8Array {
  const phrase = `HostFS FakeFs: ${entry.name}.${entry.ext}\r\n`;
  const out = new Uint8Array(entry.size);
  let written = 0;
  const phraseBytes = new TextEncoder().encode(phrase);
  while (written < entry.size) {
    const n = Math.min(phraseBytes.length, entry.size - written);
    out.set(phraseBytes.subarray(0, n), written);
    written += n;
  }
  return out;
}

/**
 * 検証用の固定ファイルシステム。パスに関わらず常に同じ2件を返す。
 * setTimeout(0) で意図的にマクロタスク境界をまたぐことで、request() の
 * 呼び出し中には絶対に解決しない(=最低1回はpollで拾う)ことを保証する。
 */
/**
 * フォルダが未接続のときのバックエンド(P2a #2)。常に空/nullを返す。
 * dispatcher側はentries.length===0を-2(見つからない)、readFile null を-2として
 * 扱うため、これだけで「検索は-2、開くは-2」の要件を満たす。
 */
export class NotConnectedFs implements HostFileSystem {
  listDir(_path: string): Promise<HostFsFileEntry[]> {
    return Promise.resolve([]);
  }
  readFile(_path: string, _name: string, _ext: string): Promise<Uint8Array | null> {
    return Promise.resolve(null);
  }
  dirExists(_path: string): Promise<boolean> {
    // 未接続時はルートすら無い(検索/開くと同じく-2/-3で応答させるため常にfalse)。
    return Promise.resolve(false);
  }

  // 未接続時は書き込み系も既存の読み取り系と同じ流儀(-2/-3、見つからない扱い)で応答する。
  // 「読み取り専用モードだから-19」ではなく「そもそも何も無い」ため、isWritable()もfalse。
  isWritable(): boolean {
    return false;
  }
  createFile(): Promise<number> {
    return Promise.resolve(FS_ERR_DIR_NOT_FOUND);
  }
  openWrite(): Promise<number> {
    return Promise.resolve(FS_ERR_FILE_NOT_FOUND);
  }
  deleteFile(): Promise<number> {
    return Promise.resolve(FS_ERR_FILE_NOT_FOUND);
  }
  mkdir(): Promise<number> {
    return Promise.resolve(FS_ERR_DIR_NOT_FOUND);
  }
  rmdir(): Promise<number> {
    return Promise.resolve(FS_ERR_DIR_NOT_FOUND);
  }
  rename(): Promise<number> {
    return Promise.resolve(FS_ERR_FILE_NOT_FOUND);
  }
  setFileDate(): Promise<number> {
    return Promise.resolve(FS_ERR_FILE_NOT_FOUND);
  }
  getFileDate(): Promise<number> {
    return Promise.resolve(FS_ERR_FILE_NOT_FOUND);
  }
  getAttr(): Promise<number> {
    return Promise.resolve(FS_ERR_FILE_NOT_FOUND);
  }
  setAttr(): Promise<number> {
    return Promise.resolve(FS_ERR_FILE_NOT_FOUND);
  }
}

/**
 * 実行時に接続先を差し替えられるプロキシ(P2a #3: HOSTFS_ATTACH/DETACHで
 * バックエンドを生やし直すため)。HostFsDispatcherの生成は1回きりなので、
 * このオブジェクト自体をdispatcherへ渡し、current だけを差し替える。
 */
export class SwitchableFs implements HostFileSystem {
  current: HostFileSystem = new NotConnectedFs();

  listDir(path: string): Promise<HostFsFileEntry[]> {
    return this.current.listDir(path);
  }
  readFile(path: string, name: string, ext: string): Promise<Uint8Array | null> {
    return this.current.readFile(path, name, ext);
  }
  dirExists(path: string): Promise<boolean> {
    return this.current.dirExists(path);
  }

  isWritable(): boolean {
    return this.current.isWritable();
  }
  createFile(path: string, name: string, ext: string, failIfExists: boolean): Promise<number> {
    return this.current.createFile(path, name, ext, failIfExists);
  }
  openWrite(path: string, name: string, ext: string): Promise<HostWriteHandle | number> {
    return this.current.openWrite(path, name, ext);
  }
  deleteFile(path: string, name: string, ext: string): Promise<number> {
    return this.current.deleteFile(path, name, ext);
  }
  mkdir(path: string, name: string): Promise<number> {
    return this.current.mkdir(path, name);
  }
  rmdir(path: string, name: string): Promise<number> {
    return this.current.rmdir(path, name);
  }
  rename(path: string, oldName: string, oldExt: string, newName: string, newExt: string, isDir: boolean): Promise<number> {
    return this.current.rename(path, oldName, oldExt, newName, newExt, isDir);
  }
  setFileDate(path: string, name: string, ext: string): Promise<number> {
    return this.current.setFileDate(path, name, ext);
  }
  getFileDate(path: string, name: string, ext: string): Promise<number> {
    return this.current.getFileDate(path, name, ext);
  }
  getAttr(path: string, name: string, ext: string): Promise<number> {
    return this.current.getAttr(path, name, ext);
  }
  setAttr(path: string, name: string, ext: string, attr: number): Promise<number> {
    return this.current.setAttr(path, name, ext, attr);
  }
}

export class FakeFs implements HostFileSystem {
  listDir(_path: string): Promise<HostFsFileEntry[]> {
    return new Promise((resolve) => {
      setTimeout(() => resolve(FAKE_ENTRIES.slice()), 0);
    });
  }

  readFile(_path: string, name: string, ext: string): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      setTimeout(() => {
        const entry = FAKE_ENTRIES.find(
          (e) => e.name.toUpperCase() === name.toUpperCase() && e.ext.toUpperCase() === ext.toUpperCase(),
        );
        resolve(entry ? makeFakeContent(entry) : null);
      }, 0);
    });
  }

  /** FakeFsはフラット(サブディレクトリを持たない)なので、ルートだけ実在扱いにする。 */
  dirExists(path: string): Promise<boolean> {
    return new Promise((resolve) => {
      setTimeout(() => resolve(path === '' || path === '\\'), 0);
    });
  }

  // FakeFsは検証用の固定読み取り専用バックエンド。書き込み系はすべて-19。
  isWritable(): boolean {
    return false;
  }
  createFile(): Promise<number> {
    return Promise.resolve(FS_ERR_WRITE_PROTECTED);
  }
  openWrite(): Promise<number> {
    return Promise.resolve(FS_ERR_WRITE_PROTECTED);
  }
  deleteFile(): Promise<number> {
    return Promise.resolve(FS_ERR_WRITE_PROTECTED);
  }
  mkdir(): Promise<number> {
    return Promise.resolve(FS_ERR_WRITE_PROTECTED);
  }
  rmdir(): Promise<number> {
    return Promise.resolve(FS_ERR_WRITE_PROTECTED);
  }
  rename(): Promise<number> {
    return Promise.resolve(FS_ERR_WRITE_PROTECTED);
  }
  setFileDate(): Promise<number> {
    return Promise.resolve(FS_ERR_WRITE_PROTECTED);
  }
  getFileDate(_path: string, name: string, ext: string): Promise<number> {
    const entry = FAKE_ENTRIES.find(
      (e) => e.name.toUpperCase() === name.toUpperCase() && e.ext.toUpperCase() === ext.toUpperCase(),
    );
    return Promise.resolve(entry ? packDateTime(entry.date, entry.time) : FS_ERR_FILE_NOT_FOUND);
  }
  getAttr(_path: string, name: string, ext: string): Promise<number> {
    const entry = FAKE_ENTRIES.find(
      (e) => e.name.toUpperCase() === name.toUpperCase() && e.ext.toUpperCase() === ext.toUpperCase(),
    );
    return Promise.resolve(entry ? entry.attr : FS_ERR_FILE_NOT_FOUND);
  }
  setAttr(): Promise<number> {
    return Promise.resolve(FS_ERR_WRITE_PROTECTED);
  }
}
