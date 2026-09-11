// HostFS (feature/hostfs) 用: ファイルシステム抽象。
//
// 今回の段階ではブラウザのフォルダ選択UIも本物のフォルダ読み込みも作らない
// (次の段階)。ここでは非同期API(listDir/readFile)だけを定義し、検証用の
// FakeFsでHELLO.TXT / WORLD.DOCを固定で返す。

import type { FakeFsDate, FakeFsTime } from './filbuf';

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
}
