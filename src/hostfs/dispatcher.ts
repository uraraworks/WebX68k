// HostFS (feature/hostfs) 用: リクエストヘッダを読み、コマンドごとに振り分ける層。
//
// ヘッダ形式(実測: tools/x68/remote-probe.s、および親からの指示書):
//   +2      : コマンドコード(1バイト)
//   +3..+4  : 状態(常に0のまま。ここでは一切書かない)
//   +13     : $47のときは検索属性
//   +14     : $47/$4aのときは_NAMESTSへのポインタ / $50/$4cのときは出力先・
//             バッファへのポインタ
//   +18     : $47/$48のときはFILBUFへのポインタ(入力)/ $4cのときは要求長
//             (入力)/実際に読んだバイト数(出力) / それ以外は戻り値(出力、ロング)
//   +22     : $4a/$4c/$4bのときはFCBへのポインタ
// $40(初期化)はドライバ内で処理される想定でここには来ない。
//
// 実測で追加確定した読み取り系コマンド(親からの指示書、C9実験の裏取り済み):
//   $4a 開く  : +14=_NAMESTS, +22=FCBポインタ。成功なら+18=0。
//   $4c 読む  : +14=バッファポインタ, +18=要求長(入力)→読んだバイト数(出力,0=EOF), +22=FCB。
//   $4b 閉じる: +22=FCB。+18=0。
//
// $47(検索・初回)と$4a(開く)だけを非同期(Promise)にする。それ以外は同期で
// 即座に完了扱いにする。「保留→ポーリング→完了」の経路を必ず1回は通すのが
// 本機能のゴールのひとつ。
//
// 検索($47/$48)は _NAMESTS の名前8+拡張子3を '?' をワイルドカードとして照合し、
// 一致したものだけを返す(親からの指示書: 名前を無視すると同じファイルが
// 複数回開かれてしまう実測不具合があったため必須)。

import type { GuestMemory } from './guest-memory';
import { readU32BE, readI32BE, writeI32BE, writeU16BE, readU8 } from './guest-memory';
import { decodeNamests } from './namests';
import { filbufPayload, FILBUF_WRITE_OFFSET, type FilbufEntry } from './filbuf';
import type { HostFileSystem, HostFsFileEntry } from './filesystem';

const CMD_SEARCH_FIRST = 0x47;
const CMD_SEARCH_NEXT = 0x48;
const CMD_FREE_SPACE = 0x50;
const CMD_UNKNOWN_56 = 0x56;
const CMD_UNKNOWN_57 = 0x57;
const CMD_OPEN = 0x4a;
const CMD_READ = 0x4c;
const CMD_CLOSE = 0x4b;
const CMD_SEEK = 0x4e;

const HDR_CMD_OFFSET = 2;
const HDR_ATTR_OFFSET = 13;
const HDR_ARG_PTR_OFFSET = 14; // $47/$4a: NAMESTS or path / $50/$4c: 出力・バッファポインタ
const HDR_FILBUF_PTR_OFFSET = 18; // $47/$48: FILBUFポインタ(兼戻り値) / $4c: 要求長(兼読んだ長さ)
const HDR_FCB_PTR_OFFSET = 22; // $4a/$4c/$4b: FCBへのポインタ

const VOLUME_LABEL_ATTR = 0x08;

const DOS_ERR_NOT_FOUND = -2;
const DOS_ERR_NO_MORE_FILES = -18;
const DOS_ERR_CANT_SEEK = -25; // 「指定の位置にはシークできません」(PRO-68Kマニュアル p.71)

const SEEK_ORIGIN_START = 0;
const SEEK_ORIGIN_CURRENT = 1;
const SEEK_ORIGIN_END = 2;

function toFilbufEntry(e: HostFsFileEntry): FilbufEntry {
  return { name: e.name, ext: e.ext, attr: e.attr, date: e.date, time: e.time, size: e.size };
}

/**
 * _NAMESTS の名前8+拡張子3(空白埋め、'?'はワイルドカードで任意の1文字に一致)を
 * エントリの名前+拡張子と照合する。
 */
function matchWildcard(queryName: string, queryExt: string, entryName: string, entryExt: string): boolean {
  const q = (queryName.padEnd(8, ' ') + queryExt.padEnd(3, ' ')).toUpperCase();
  const e = (entryName.padEnd(8, ' ') + entryExt.padEnd(3, ' ')).toUpperCase();
  for (let i = 0; i < 11; i++) {
    if (q[i] === '?') continue;
    if (q[i] !== e[i]) return false;
  }
  return true;
}

/**
 * 検索属性とエントリの属性を照合する(マニュアルp.184の実測どおり:
 * 「2つ以上のビットを立てた場合は、そのどれかに当てはまればよい」)。
 * 一致条件は (エントリの属性 & 検索属性) != 0。
 * 普通のファイル($20)は、ディレクトリだけを探す検索($10)には一致しない。
 */
function matchAttr(entryAttr: number, queryAttr: number): boolean {
  return (entryAttr & queryAttr) !== 0;
}

interface DirSearchState {
  entries: HostFsFileEntry[];
  index: number;
}

interface FcbReadState {
  content: Uint8Array;
  pos: number;
}

type PendingOperation =
  | {
      kind: 'search';
      addr: number;
      filbufPtr: number;
      queryName: string;
      queryExt: string;
      queryAttr: number;
      entries?: HostFsFileEntry[];
    }
  | {
      kind: 'open';
      addr: number;
      fcbPtr: number;
      content?: Uint8Array | null;
    };

/** 観測用カウンタ。probeのjson(allLogs)へ載せる値の裏取り用に外から読める。 */
export interface HostFsStats {
  requestCount: number;
  pendingReturnedCount: number;
  pollCount: number;
  pollCompletedCount: number;
}

export class HostFsDispatcher {
  private readonly mem: GuestMemory;
  private readonly fs: HostFileSystem;
  private readonly dirStates = new Map<number, DirSearchState>(); // key: filbufPtr
  private readonly fcbStates = new Map<number, FcbReadState>(); // key: FCBポインタ
  private pending: PendingOperation | null = null;

  private stats: HostFsStats = {
    requestCount: 0,
    pendingReturnedCount: 0,
    pollCount: 0,
    pollCompletedCount: 0,
  };

  constructor(mem: GuestMemory, fs: HostFileSystem) {
    this.mem = mem;
    this.fs = fs;
  }

  getStats(): HostFsStats {
    return { ...this.stats };
  }

  /**
   * ポートのトリガ(+4書き込み)から呼ばれる。戻り値: true=保留(pollを待つ)、
   * false=このまま完了(ヘッダの+18に戻り値を書き終えている)。
   */
  request(addr: number): boolean {
    this.stats.requestCount++;
    const cmd = readU8(this.mem, addr + HDR_CMD_OFFSET);

    if (cmd === CMD_SEARCH_FIRST) {
      const isPending = this.handleSearchFirst(addr);
      if (isPending) this.stats.pendingReturnedCount++;
      return isPending;
    }
    if (cmd === CMD_OPEN) {
      const isPending = this.handleOpen(addr);
      if (isPending) this.stats.pendingReturnedCount++;
      return isPending;
    }

    switch (cmd) {
      case CMD_SEARCH_NEXT:
        this.handleSearchNext(addr);
        break;
      case CMD_FREE_SPACE:
        this.handleFreeSpace(addr);
        break;
      case CMD_READ:
        this.handleRead(addr);
        break;
      case CMD_CLOSE:
        this.handleClose(addr);
        break;
      case CMD_SEEK:
        this.handleSeek(addr);
        break;
      case CMD_UNKNOWN_56:
      case CMD_UNKNOWN_57:
        // 意味は未確定。+18=0を返せばdirは完走する(親からの指示書のとおり)。
        writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, 0);
        break;
      default:
        writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, DOS_ERR_NOT_FOUND);
        break;
    }
    return false;
  }

  /**
   * ポートのステータス読み出し(+5)から、保留中のときだけ呼ばれる。
   * 戻り値: true=まだ保留、false=完了(この呼び出しで+18まで書き終えた)。
   */
  poll(): boolean {
    if (!this.pending) return false; // 保留が無いのにpollされた: 安全側で完了扱い
    this.stats.pollCount++;

    if (this.pending.kind === 'search') {
      if (this.pending.entries === undefined) return true; // まだ解決していない
      const { addr, filbufPtr, queryName, queryExt, queryAttr, entries } = this.pending;
      this.pending = null;
      this.stats.pollCompletedCount++;
      this.finishSearchFirst(addr, filbufPtr, queryName, queryExt, queryAttr, entries);
      return false;
    }

    // kind === 'open'
    if (this.pending.content === undefined) return true;
    const { addr, fcbPtr, content } = this.pending;
    this.pending = null;
    this.stats.pollCompletedCount++;
    this.finishOpen(addr, fcbPtr, content);
    return false;
  }

  /** $47: 検索・初回。ボリュームラベル検索は同期でエラーを返す。 */
  private handleSearchFirst(addr: number): boolean {
    const attr = readU8(this.mem, addr + HDR_ATTR_OFFSET);
    if (attr === VOLUME_LABEL_ATTR) {
      // ボリュームラベル検索: このFakeFsはラベルを持たない
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, DOS_ERR_NOT_FOUND);
      return false;
    }

    const namestsPtr = readU32BE(this.mem, addr + HDR_ARG_PTR_OFFSET);
    const filbufPtr = readU32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET);
    const namestsBytes = this.mem.read(namestsPtr, 88);
    const namests = decodeNamests(namestsBytes);
    const queryName = namests.name.toUpperCase();
    const queryExt = namests.ext.toUpperCase();

    const pending: PendingOperation = { kind: 'search', addr, filbufPtr, queryName, queryExt, queryAttr: attr };
    this.pending = pending;

    // 非同期経路を必ず通す(FakeFs.listDir はマクロタスク境界をまたいでから解決する)。
    this.fs.listDir(namests.path).then((entries) => {
      // 別の request() が割り込んでいたら(通常は起きない想定)、古い結果は捨てる。
      if (this.pending === pending) pending.entries = entries;
    });

    return true;
  }

  private finishSearchFirst(
    addr: number,
    filbufPtr: number,
    queryName: string,
    queryExt: string,
    queryAttr: number,
    allEntries: HostFsFileEntry[],
  ): void {
    // 名前8+拡張子3を'?'ワイルドカードで照合し、かつ属性が一致したものだけを
    // 対象にする(一致しない全件を返すと、複数ファイルが同じ検索で見つかって
    // しまう。属性を無視して返すとcopyが失敗した実測不具合があったため必須)。
    const entries = allEntries.filter(
      (e) => matchWildcard(queryName, queryExt, e.name, e.ext) && matchAttr(e.attr, queryAttr),
    );
    if (entries.length === 0) {
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, DOS_ERR_NOT_FOUND);
      return;
    }
    this.dirStates.set(filbufPtr, { entries, index: 1 });
    this.writeFilbufAndReturn(addr, filbufPtr, entries[0], 0);
  }

  /** $48: 次を検索。同期(結果は既にメモリ上にある)。 */
  private handleSearchNext(addr: number): void {
    const filbufPtr = readU32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET);
    const state = this.dirStates.get(filbufPtr);
    if (!state || state.index >= state.entries.length) {
      this.dirStates.delete(filbufPtr);
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, DOS_ERR_NO_MORE_FILES);
      return;
    }
    const entry = state.entries[state.index];
    state.index++;
    this.writeFilbufAndReturn(addr, filbufPtr, entry, 0);
  }

  private writeFilbufAndReturn(addr: number, filbufPtr: number, entry: HostFsFileEntry, retval: number): void {
    // FILBUFへ書き終えてから、ヘッダ+18(=FILBUFポインタの入力欄と兼用)へ戻り値を書く
    // (+18はポインタの入力欄を兼ねている。親からの指示書のとおり)。
    const payload = filbufPayload(toFilbufEntry(entry));
    this.mem.write(filbufPtr + FILBUF_WRITE_OFFSET, payload);
    writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, retval);
  }

  /** $50: 空き容量。固定の作り物の値を返す(検証用途のため実容量は問わない)。 */
  private handleFreeSpace(addr: number): void {
    const outPtr = readU32BE(this.mem, addr + HDR_ARG_PTR_OFFSET);
    // 使用可能クラスタ / 総クラスタ / クラスタあたりセクタ / セクタあたりバイト
    writeU16BE(this.mem, outPtr + 0, 1000);
    writeU16BE(this.mem, outPtr + 2, 2000);
    writeU16BE(this.mem, outPtr + 4, 8);
    writeU16BE(this.mem, outPtr + 6, 512);
    writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, 0);
  }

  /** $4a: 開く。ワイルドカード無しの厳密一致。非同期(内容取得までpoll待ち)。 */
  private handleOpen(addr: number): boolean {
    const namestsPtr = readU32BE(this.mem, addr + HDR_ARG_PTR_OFFSET);
    const fcbPtr = readU32BE(this.mem, addr + HDR_FCB_PTR_OFFSET);
    const namests = decodeNamests(this.mem.read(namestsPtr, 88));

    const pending: PendingOperation = { kind: 'open', addr, fcbPtr };
    this.pending = pending;

    this.fs.readFile(namests.path, namests.name.toUpperCase(), namests.ext.toUpperCase()).then((content) => {
      if (this.pending === pending) pending.content = content;
    });

    return true;
  }

  private finishOpen(addr: number, fcbPtr: number, content: Uint8Array | null): void {
    if (content === null) {
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, DOS_ERR_NOT_FOUND);
      return;
    }
    this.fcbStates.set(fcbPtr, { content, pos: 0 });
    writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, 0);
  }

  /** $4c: 読む。同期(open済みの内容から切り出すだけ)。 */
  private handleRead(addr: number): void {
    const bufPtr = readU32BE(this.mem, addr + HDR_ARG_PTR_OFFSET);
    const reqLen = readU32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET);
    const fcbPtr = readU32BE(this.mem, addr + HDR_FCB_PTR_OFFSET);
    const state = this.fcbStates.get(fcbPtr);
    if (!state) {
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, 0); // 開いていない: 安全側で0バイト(EOF)
      return;
    }
    const remaining = state.content.length - state.pos;
    const n = Math.max(0, Math.min(reqLen, remaining));
    if (n > 0) {
      this.mem.write(bufPtr, state.content.subarray(state.pos, state.pos + n));
      state.pos += n;
    }
    writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, n);
  }

  /** $4b: 閉じる。同期。 */
  private handleClose(addr: number): void {
    const fcbPtr = readU32BE(this.mem, addr + HDR_FCB_PTR_OFFSET);
    this.fcbStates.delete(fcbPtr);
    writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, 0);
  }

  /**
   * $4e: シーク。同期。+13=起点(0=先頭/1=現在位置/2=末尾)、+18=移動量(符号付き)、
   * +22=FCB。新しい位置を+18に返す(_SEEKのD0は新しい位置。PRO-68Kマニュアル
   * p.163)。範囲外は-25(p.71)で、その場合は位置を変更しない。
   */
  private handleSeek(addr: number): void {
    const origin = readU8(this.mem, addr + HDR_ATTR_OFFSET);
    const delta = readI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET);
    const fcbPtr = readU32BE(this.mem, addr + HDR_FCB_PTR_OFFSET);
    const state = this.fcbStates.get(fcbPtr);
    if (!state) {
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, DOS_ERR_CANT_SEEK);
      return;
    }

    let base: number;
    switch (origin) {
      case SEEK_ORIGIN_START:
        base = 0;
        break;
      case SEEK_ORIGIN_CURRENT:
        base = state.pos;
        break;
      case SEEK_ORIGIN_END:
        base = state.content.length;
        break;
      default:
        writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, DOS_ERR_CANT_SEEK);
        return;
    }

    const newPos = base + delta;
    if (newPos < 0 || newPos > state.content.length) {
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, DOS_ERR_CANT_SEEK);
      return;
    }
    state.pos = newPos;
    writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, newPos);
  }
}
