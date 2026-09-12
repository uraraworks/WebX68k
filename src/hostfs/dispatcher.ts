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
import { decodeNamests, decodeCdPath } from './namests';
import { filbufPayload, FILBUF_WRITE_OFFSET, type FilbufEntry } from './filbuf';
import type { HostFileSystem, HostFsFileEntry } from './filesystem';
import { FS_OK } from './filesystem';

// $41 = cd(カレントディレクトリの変更、master側C11実験で解読・親からの指示書で確定)。
// +14 = パス(_NAMESTS全体ではなく、区切り$09・NUL終端のパス部分だけの生バッファ。
// namests.tsのdecodeCdPath参照)。相対パス・'..'はHuman68k側で絶対パスへ解決済みで
// 届くため、ドライバ(TS)側でカレントディレクトリを持つ必要は無い。
const CMD_CD = 0x41;
// --- W2b: 書き込み系(親からの指示書・master側remote-probe C12実験で確定) ---
const CMD_MKDIR = 0x42; // _MKDIR: +14=_NAMESTS
const CMD_RMDIR = 0x43; // _RMDIR: +14=_NAMESTS
const CMD_RENAME = 0x44; // _RENAME: +14=元の名前の_NAMESTS、+18=新しい名前の_NAMESTS
const CMD_DELETE = 0x45; // _DELETE: +14=_NAMESTS
const CMD_CHMOD = 0x46; // _CHMOD: +13=属性($FFなら取得)、+14=_NAMESTS
const CMD_CREATE = 0x49; // _CREATE/_NEWFILE共用: +13=属性、+14=_NAMESTS、+18=フラグ(入力)、+22=FCB
const CMD_WRITE = 0x4d; // _WRITE: +14=バッファ、+18=長さ(入力)/書けたバイト数(出力)、+22=FCB
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
/** 「書き込み禁止です」(PRO-68Kマニュアルp.71)。読み取り専用モードでの書き込み系コマンドに使う。 */
export const DOS_ERR_WRITE_PROTECTED = -19;
const DOS_ERR_DIR_NOT_FOUND = -3; // 「ディレクトリが見つかりません」(cd、親からの指示書のとおり)
const DOS_ERR_CANT_SEEK = -25; // 「指定の位置にはシークできません」(PRO-68Kマニュアルp.71)

const ATTR_DIRECTORY = 0x10; // _CHMOD取得・$44(rename)のisDir判定に使う(host-folder-fs.tsと同じ値)。
const CHMOD_GET_ATTR = 0xff; // $46: +13がこの値のときは取得(それ以外は設定)。

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

/**
 * W2b: $4a(開く)/$49(作る)いずれの経路で開いても、以後の$4c(読む)/$4d(書く)/$4e(シーク)は
 * 同じローカルバッファ(content)に対して行う。書き込みはこのバッファへ直接反映し、
 * $4b(閉じる)のときだけ dirty なら実体へ反映する(親からの指示書どおり「閉じたときに
 * まとめて反映」)。path/name/ext は close時にfs.openWrite()を呼び直すために持つ。
 */
interface FcbState {
  path: string;
  name: string;
  ext: string;
  content: Uint8Array;
  pos: number;
  dirty: boolean;
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
      path: string;
      name: string;
      ext: string;
      content?: Uint8Array | null;
    }
  | {
      kind: 'cd';
      addr: number;
      exists?: boolean;
    }
  | {
      // W2b: 書き込み系コマンド(mkdir/rmdir/rename/delete/chmod/create/close)共通の
      // 非同期完了待ち。finishは結果(戻り値、あるいはFS_OK/DOSエラー)を受け取り、
      // ヘッダへの書き込み・fcbStates更新など各コマンド固有の後処理を行う。
      kind: 'async';
      addr: number;
      finish: (result: number) => void;
      result?: number;
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
  private readonly fcbStates = new Map<number, FcbState>(); // key: FCBポインタ
  private readonly seenUnknownCommands = new Set<number>();
  private pending: PendingOperation | null = null;
  /**
   * 非同期処理(listDir/readFile)がPromise解決した"その場"で呼ばれる通知。
   * C側(wasm)へ「完了した」を伝え、状態ポートの読みがJSを一切呼ばずに
   * 完了フラグだけで答えられるようにするためのフック(P2a #1)。
   * poll()を外部(C)から呼び続けなくても完了できるのがポイント。
   */
  private notifyComplete: (() => void) | null = null;

  private stats: HostFsStats = {
    requestCount: 0,
    pendingReturnedCount: 0,
    pollCount: 0,
    pollCompletedCount: 0,
  };

  constructor(mem: GuestMemory, fs: HostFileSystem, notifyComplete?: () => void) {
    this.mem = mem;
    this.fs = fs;
    this.notifyComplete = notifyComplete ?? null;
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
    if (cmd === CMD_CD) {
      const isPending = this.handleCd(addr);
      if (isPending) this.stats.pendingReturnedCount++;
      return isPending;
    }
    if (cmd === CMD_CLOSE) {
      // W2b: dirty(書き込みあり)なら実体反映が非同期になるため、保留経路へ回す。
      const isPending = this.handleClose(addr);
      if (isPending) this.stats.pendingReturnedCount++;
      return isPending;
    }
    if (
      cmd === CMD_MKDIR ||
      cmd === CMD_RMDIR ||
      cmd === CMD_RENAME ||
      cmd === CMD_DELETE ||
      cmd === CMD_CHMOD ||
      cmd === CMD_CREATE
    ) {
      const isPending = this.handleWriteCommand(cmd, addr);
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
      case CMD_WRITE:
        this.handleWrite(addr);
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
        // P2a #2: 書き込み系コマンドの番号は未確定。既存の挙動(-2で完了扱い)は変えず、
        // 初めて見たコマンドだけログに出す(親からの指示書: 未知コマンドは今までどおり、
        // ただし記録は残す)。書き込み系と判明したコマンドを見つけたら、ここを
        // DOS_ERR_WRITE_PROTECTED(-19)を返す専用caseへ切り出すこと。
        if (!this.seenUnknownCommands.has(cmd)) {
          this.seenUnknownCommands.add(cmd);
          console.warn(`[HostFS] 未知のコマンド: $${cmd.toString(16)} (初回、-2で応答)`);
        }
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

    if (this.pending.kind === 'open') {
      if (this.pending.content === undefined) return true;
      const { addr, fcbPtr, path, name, ext, content } = this.pending;
      this.pending = null;
      this.stats.pollCompletedCount++;
      this.finishOpen(addr, fcbPtr, path, name, ext, content);
      return false;
    }

    if (this.pending.kind === 'async') {
      if (this.pending.result === undefined) return true;
      const { finish, result } = this.pending;
      this.pending = null;
      this.stats.pollCompletedCount++;
      finish(result);
      return false;
    }

    // kind === 'cd'
    if (this.pending.exists === undefined) return true;
    const { addr, exists } = this.pending;
    this.pending = null;
    this.stats.pollCompletedCount++;
    this.finishCd(addr, exists);
    return false;
  }

  /**
   * W2b: 書き込み系コマンド共通の非同期完了待ちを登録する。promiseが解決した"その場"で
   * 完了処理まで行う(既存のsearch/open/cdと同じ流儀。pollを外部から呼ばれるのを待たない)。
   * finishは、成功時の戻り値(FS_OK/エントリの属性など)とDOSエラー(負数)の両方を受け取り、
   * ヘッダ+18への書き込みや、必要ならfcbStatesの更新まで行う。
   */
  private beginAsync(addr: number, promise: Promise<number>, finish: (result: number) => void): boolean {
    const pending: PendingOperation = { kind: 'async', addr, finish };
    this.pending = pending;
    promise.then((result) => {
      // 別のrequest()が割り込んでいたら(通常は起きない想定)、古い結果は捨てる。
      if (this.pending !== pending) return;
      pending.result = result;
      this.pending = null;
      this.stats.pollCompletedCount++;
      finish(result);
      this.notifyComplete?.();
    });
    return true;
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
    // 解決した"その場"で完了処理まで行う(pollを外部から呼ばれるのを待たない)。
    this.fs.listDir(namests.path).then((entries) => {
      // 別の request() が割り込んでいたら(通常は起きない想定)、古い結果は捨てる。
      if (this.pending !== pending) return;
      pending.entries = entries;
      this.pending = null;
      this.stats.pollCompletedCount++;
      this.finishSearchFirst(addr, filbufPtr, queryName, queryExt, attr, entries);
      this.notifyComplete?.();
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

  /**
   * $50: 空き容量。
   *
   * 前回(2026-09-12早め)の実測では、+0/+2の8バイト構造(使用可能クラスタ/総クラスタ/
   * クラスタあたりセクタ/セクタあたりバイト、PRO-68K DOS呼び出しガイドp.150)だけを
   * 振って「使用可能」欄が常に0Kになると誤って結論していたが、原因は別にあった。
   * 当時は+18(ヘッダ+18、通常は戻り値を書く欄)を常に0のまま返していたため、
   * 「使用可能」が常に0として出ていただけだった。
   *
   * 根拠: master `tools/x68/remote-probe.s` のC8実験。
   *   - C8-a: +18に204800(バイト数)だけを書き、+14の先の8バイトは書かない
   *     → dir集計が「536870712K」等に壊れる。
   *   - C8-b: +18に204800を書いたうえで、+14の先へ使用可能クラスタ100・総クラスタ200・
   *     クラスタあたり2セクタ・セクタあたり1024バイトの8バイトを書く
   *     → dir集計が「200K Byte 使用中 / 200K Byte 使用可能」と正しく出た
   *     (`_local/remote-probe/c8b-dir-final.png`、master側)。
   *   C8-bの数字で検算すると、総バイト数=200×2×1024=409600B=400K、
   *   +18(使用可能バイト数)=204800B=200K、400K-200K=200K=表示された「使用中」と一致する。
   *
   * つまり実際の意味は:
   *   - +18 = 使用可能バイト数(_DSKFREがD0で返す値と同じ)。「使用可能」欄はここから来る。
   *   - 「使用中」欄 = (総クラスタ×クラスタあたりセクタ×セクタあたりバイト) − +18。
   *   - 8バイト構造の「使用可能クラスタ」欄(+0)自体は、この2つの表示には使われていない
   *     模様(C8-bでは+0=100だが、表示に使われたのは+18の204800の方)。
   *
   * この読み方に基づき、空き約1GBでどの欄もワード(0-65535)に収まる値を作る:
   *   使用可能クラスタ32000・総クラスタ65535・クラスタあたり64セクタ・
   *   セクタあたり512バイト(クラスタ=32768B)。
   *   総バイト数 = 65535×32768 = 2,147,450,880B
   *   使用可能バイト数(+18) = 32000×32768 = 1,048,576,000B(=1,024,000K、約1GB)
   *   表示される「使用中」= 2,147,450,880 − 1,048,576,000 = 1,098,874,880B(=1,073,120K)
   */
  private handleFreeSpace(addr: number): void {
    const outPtr = readU32BE(this.mem, addr + HDR_ARG_PTR_OFFSET);
    const AVAILABLE_CLUSTERS = 32000;
    const TOTAL_CLUSTERS = 65535;
    const SECTORS_PER_CLUSTER = 64;
    const BYTES_PER_SECTOR = 512;
    const availableBytes = AVAILABLE_CLUSTERS * SECTORS_PER_CLUSTER * BYTES_PER_SECTOR;
    writeU16BE(this.mem, outPtr + 0, AVAILABLE_CLUSTERS);
    writeU16BE(this.mem, outPtr + 2, TOTAL_CLUSTERS);
    writeU16BE(this.mem, outPtr + 4, SECTORS_PER_CLUSTER);
    writeU16BE(this.mem, outPtr + 6, BYTES_PER_SECTOR);
    // +18 = 使用可能バイト数(_DSKFREのD0相当)。dir集計行の「使用可能」はここから来る。
    writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, availableBytes);
  }

  /**
   * $4a: 開く。ワイルドカード無しの厳密一致。非同期(内容取得までpoll待ち)。
   * 実測どおりヘッダに読み書きのモードは載っていない(+13は0)ため、開いたファイルは
   * 常に読み書き両用として扱う(親からの指示書のとおり)。以後の$4c/$4d/$4eは、
   * ここで読み込んだ内容をそのままローカルバッファ(FcbState.content)として使い回す。
   */
  private handleOpen(addr: number): boolean {
    const namestsPtr = readU32BE(this.mem, addr + HDR_ARG_PTR_OFFSET);
    const fcbPtr = readU32BE(this.mem, addr + HDR_FCB_PTR_OFFSET);
    const namests = decodeNamests(this.mem.read(namestsPtr, 88));
    const path = namests.path;
    const name = namests.name.toUpperCase();
    const ext = namests.ext.toUpperCase();

    const pending: PendingOperation = { kind: 'open', addr, fcbPtr, path, name, ext };
    this.pending = pending;

    this.fs.readFile(path, name, ext).then((content) => {
      if (this.pending !== pending) return;
      pending.content = content;
      this.pending = null;
      this.stats.pollCompletedCount++;
      this.finishOpen(addr, fcbPtr, path, name, ext, content ?? null);
      this.notifyComplete?.();
    });

    return true;
  }

  private finishOpen(
    addr: number,
    fcbPtr: number,
    path: string,
    name: string,
    ext: string,
    content: Uint8Array | null,
  ): void {
    if (content === null) {
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, DOS_ERR_NOT_FOUND);
      return;
    }
    this.fcbStates.set(fcbPtr, { path, name, ext, content, pos: 0, dirty: false });
    writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, 0);
  }

  /**
   * $41: cd(カレントディレクトリの変更、master側C11実験で解読)。+14はパス部分だけの
   * 生バッファ(namests.tsのdecodeCdPath参照)。相対パス・'..'はHuman68k側で絶対パスへ
   * 解決済みで届くため、ここではパスの実在確認だけ行う。非同期(fs.dirExists待ち)。
   */
  private handleCd(addr: number): boolean {
    const pathPtr = readU32BE(this.mem, addr + HDR_ARG_PTR_OFFSET);
    // 先頭2バイト('?'の数+ドライブ番号) + パス本体(65バイト以内+NUL)。
    // namests.tsのdecodeCdPathのコメント参照(実機実測で先頭2バイトの存在を確認)。
    const path = decodeCdPath(this.mem.read(pathPtr, 67));

    const pending: PendingOperation = { kind: 'cd', addr };
    this.pending = pending;

    this.fs.dirExists(path).then((exists) => {
      if (this.pending !== pending) return;
      pending.exists = exists;
      this.pending = null;
      this.stats.pollCompletedCount++;
      this.finishCd(addr, exists);
      this.notifyComplete?.();
    });

    return true;
  }

  private finishCd(addr: number, exists: boolean): void {
    writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, exists ? 0 : DOS_ERR_DIR_NOT_FOUND);
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

  /**
   * $4d: 書く。同期(実I/Oは行わず、開いている(または$49で作った)ファイルのローカル
   * バッファへ反映するだけ。実体への反映は$4b(閉じる)でまとめて行う。親からの指示書の
   * とおり、読み取り専用モードならこのFCBが何であれ-19を返す)。
   * +14=バッファ、+18=長さ(入力)→書けたバイト数(出力)、+22=FCB。
   */
  private handleWrite(addr: number): void {
    const bufPtr = readU32BE(this.mem, addr + HDR_ARG_PTR_OFFSET);
    const reqLen = readU32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET);
    const fcbPtr = readU32BE(this.mem, addr + HDR_FCB_PTR_OFFSET);
    const state = this.fcbStates.get(fcbPtr);
    if (!state) {
      // 開いていないFCBへの書き込み: -2(ファイルが見つからない)で安全側に倒す。
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, DOS_ERR_NOT_FOUND);
      return;
    }
    if (!this.fs.isWritable()) {
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, DOS_ERR_WRITE_PROTECTED);
      return;
    }
    const data = this.mem.read(bufPtr, reqLen);
    const end = state.pos + reqLen;
    if (end > state.content.length) {
      const grown = new Uint8Array(end); // 0埋め(伸ばした分)
      grown.set(state.content);
      state.content = grown;
    }
    state.content.set(data, state.pos);
    state.pos += reqLen;
    state.dirty = true;
    writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, reqLen);
  }

  /**
   * $4b: 閉じる。書き込みが無ければ同期即完了。書き込みがあれば(dirty)、
   * fs.openWrite()→write()→close()で実体へ反映してから完了する(親からの指示書の
   * とおり「閉じたときにまとめて反映」)。反映は非同期なので、既存の保留→ポーリングの
   * 経路(beginAsync)をそのまま使う。
   */
  private handleClose(addr: number): boolean {
    const fcbPtr = readU32BE(this.mem, addr + HDR_FCB_PTR_OFFSET);
    const state = this.fcbStates.get(fcbPtr);
    this.fcbStates.delete(fcbPtr);
    if (state) {
      // 検証用(probe): シークせずに最後まで読み切った場合、この値が元ファイルの
      // サイズと一致するはず。type c:hello.txtが3000バイト全部出るかの裏取りに使う。
      console.log(`[HostFS] close: pos=${state.pos} content=${state.content.length}バイト dirty=${state.dirty}`);
    }
    if (!state || !state.dirty) {
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, 0);
      return false;
    }

    const flush = this.fs.openWrite(state.path, state.name, state.ext).then(async (handleOrErr) => {
      if (typeof handleOrErr === 'number') return handleOrErr; // エラー(読み取り専用化・削除済み等)
      handleOrErr.write(0, state.content);
      await handleOrErr.close();
      return FS_OK;
    });
    return this.beginAsync(addr, flush, (result) => {
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, result);
    });
  }

  /**
   * W2b: $42/$43/$44/$45/$46/$49共通の入口。読み取り専用モードでの書き込み系はすべて
   * ここで-19に倒す(親からの指示書のとおり)。ただし$46の「取得」($FF)だけは読み取り
   * 操作なので、writable判定より前に個別対応する(handleChmod内)。
   */
  private handleWriteCommand(cmd: number, addr: number): boolean {
    switch (cmd) {
      case CMD_MKDIR:
        return this.handleMkdir(addr);
      case CMD_RMDIR:
        return this.handleRmdir(addr);
      case CMD_RENAME:
        return this.handleRename(addr);
      case CMD_DELETE:
        return this.handleDelete(addr);
      case CMD_CHMOD:
        return this.handleChmod(addr);
      case CMD_CREATE:
        return this.handleCreate(addr);
      default:
        // ここには来ない想定(request()側で列挙済み)。安全側で-19即完了にする。
        writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, DOS_ERR_WRITE_PROTECTED);
        return false;
    }
  }

  private readNamestsAt(ptr: number): { path: string; name: string; ext: string } {
    const namests = decodeNamests(this.mem.read(ptr, 88));
    return { path: namests.path, name: namests.name.toUpperCase(), ext: namests.ext.toUpperCase() };
  }

  /** $42: _MKDIR。+14=_NAMESTS(親パス+新規ディレクトリ名)。 */
  private handleMkdir(addr: number): boolean {
    if (!this.fs.isWritable()) {
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, DOS_ERR_WRITE_PROTECTED);
      return false;
    }
    const { path, name } = this.readNamestsAt(readU32BE(this.mem, addr + HDR_ARG_PTR_OFFSET));
    return this.beginAsync(addr, this.fs.mkdir(path, name), (result) => {
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, result);
    });
  }

  /** $43: _RMDIR。+14=_NAMESTS(親パス+削除するディレクトリ名)。 */
  private handleRmdir(addr: number): boolean {
    if (!this.fs.isWritable()) {
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, DOS_ERR_WRITE_PROTECTED);
      return false;
    }
    const { path, name } = this.readNamestsAt(readU32BE(this.mem, addr + HDR_ARG_PTR_OFFSET));
    return this.beginAsync(addr, this.fs.rmdir(path, name), (result) => {
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, result);
    });
  }

  /** $45: _DELETE。+14=_NAMESTS。 */
  private handleDelete(addr: number): boolean {
    if (!this.fs.isWritable()) {
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, DOS_ERR_WRITE_PROTECTED);
      return false;
    }
    const { path, name, ext } = this.readNamestsAt(readU32BE(this.mem, addr + HDR_ARG_PTR_OFFSET));
    return this.beginAsync(addr, this.fs.deleteFile(path, name, ext), (result) => {
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, result);
    });
  }

  /**
   * $46: _CHMOD。+13=属性($FFなら取得、それ以外は設定)、+14=_NAMESTS。
   * 取得はwritable判定より前に行う(読み取り操作のため、読み取り専用モードでも許す)。
   */
  private handleChmod(addr: number): boolean {
    const attrField = readU8(this.mem, addr + HDR_ATTR_OFFSET);
    const { path, name, ext } = this.readNamestsAt(readU32BE(this.mem, addr + HDR_ARG_PTR_OFFSET));

    if (attrField === CHMOD_GET_ATTR) {
      return this.beginAsync(addr, this.fs.getAttr(path, name, ext), (result) => {
        writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, result);
      });
    }
    if (!this.fs.isWritable()) {
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, DOS_ERR_WRITE_PROTECTED);
      return false;
    }
    return this.beginAsync(addr, this.fs.setAttr(path, name, ext, attrField), (result) => {
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, result);
    });
  }

  /**
   * $44: _RENAME。+14=元の名前の_NAMESTS、+18=新しい名前の_NAMESTS(どちらもポインタ)。
   * ヘッダにisDir相当の情報が無いため、まずgetAttrで元エントリの属性を調べてから
   * fs.rename()を呼ぶ(ディレクトリのrenameはmove()が使える環境だけ、という判断は
   * host-folder-fs.ts側が持つ)。
   */
  private handleRename(addr: number): boolean {
    if (!this.fs.isWritable()) {
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, DOS_ERR_WRITE_PROTECTED);
      return false;
    }
    const oldPtr = readU32BE(this.mem, addr + HDR_ARG_PTR_OFFSET);
    const newPtr = readU32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET);
    const oldNs = this.readNamestsAt(oldPtr);
    const newNs = this.readNamestsAt(newPtr);

    const combined = this.fs.getAttr(oldNs.path, oldNs.name, oldNs.ext).then((attrOrErr) => {
      if (attrOrErr < 0) return attrOrErr;
      const isDir = attrOrErr === ATTR_DIRECTORY;
      return this.fs.rename(oldNs.path, oldNs.name, oldNs.ext, newNs.name, newNs.ext, isDir);
    });
    return this.beginAsync(addr, combined, (result) => {
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, result);
    });
  }

  /**
   * $49: _CREATE/_NEWFILE共用。+13=属性、+14=_NAMESTS、+18=フラグ(入力。実測: _CREATEは1、
   * _NEWFILEは0)、+22=FCB(出力)。成功すれば、以後この FCB を$4d/$4c/$4e/$4bで使う
   * 書き込み用ファイルとして登録する(ローカルバッファは空から始める。$49は常に
   * 新規=空ファイルを作る操作のため)。
   */
  private handleCreate(addr: number): boolean {
    if (!this.fs.isWritable()) {
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, DOS_ERR_WRITE_PROTECTED);
      return false;
    }
    const { path, name, ext } = this.readNamestsAt(readU32BE(this.mem, addr + HDR_ARG_PTR_OFFSET));
    const fcbPtr = readU32BE(this.mem, addr + HDR_FCB_PTR_OFFSET);
    const flagIn = readU32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET);
    const failIfExists = flagIn === 0; // 親の解釈(推測、実測で確認中): 1=_CREATE(上書き)、0=_NEWFILE(既存なら-80)

    return this.beginAsync(addr, this.fs.createFile(path, name, ext, failIfExists), (result) => {
      if (result === FS_OK) {
        this.fcbStates.set(fcbPtr, { path, name, ext, content: new Uint8Array(0), pos: 0, dirty: false });
      }
      writeI32BE(this.mem, addr + HDR_FILBUF_PTR_OFFSET, result);
    });
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
