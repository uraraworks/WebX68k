// px68k-libretro (emscripten ビルド) コアの JS ホスト実装。
// libretro API の callback を wasm 関数テーブルへ登録し、コアを駆動する。

import {
  keyRepeatDelayMsFromSramValue,
  keyRepeatIntervalMsFromSramValue,
} from './key-repeat';
import { RETROK_TO_SCANCODE } from './keyboard';
import {
  extractTextScreenFromCore,
  MINIMUM_ANK_CGROM_SIZE,
  type TextScreenDump,
  unavailableTextScreenDump,
} from './text-screen';
import { storageProbe, verifyBytes, type RamExpansionKind, frameProbe, keybufAttributionProbe } from './storage-probe';
import { trackKeyBufWrite } from './keybuf-attribution';

/**
 * 目的B「起動時のRAM展開」計測(docs/STORAGE-SCSI.md参照)。DEVかつ storageProbe.enabled の
 * ときだけ、MEMFS writeFile() の前後時刻とサイズ/末尾/checksum検証を記録する。
 * storageProbe.nextRamFault が立っていれば、測定専用の1回だけの故障注入(書込み省略/末尾切詰め/
 * 同サイズ破損)を行い、消費する。通常のビルド・通常の呼び出しではコストが乗らないよう、
 * import.meta.env.DEV の判定を最初に置く。
 */
function probedMemfsWrite(
  mod: PX68KModule,
  kind: RamExpansionKind,
  path: string,
  data: Uint8Array,
): void {
  if (!import.meta.env.DEV || !storageProbe.enabled) {
    mod.FS.writeFile(path, data);
    return;
  }
  const fault = storageProbe.nextRamFault;
  storageProbe.nextRamFault = null;
  const writeData =
    fault === 'truncate-tail'
      ? data.subarray(0, Math.max(0, data.byteLength - 1))
      : fault === 'corrupt-checksum'
        ? (() => {
            // 末尾64byte検査(verifyBytesのTAIL_LEN)を通り抜けさせ、checksum検査だけを
            // 単独で失敗させるため、末尾ではなく先頭(または中央)のbyteを1つ反転する。
            const copy = data.slice();
            const idx = Math.max(0, copy.length - 1 - 64);
            copy[idx] = (copy[idx] + 1) & 0xff;
            return copy;
          })()
        : data;
  const startAtMs = performance.now();
  if (fault !== 'skip-write') mod.FS.writeFile(path, writeData);
  const endAtMs = performance.now();
  let readBack: Uint8Array | null = null;
  try {
    readBack = mod.FS.readFile(path);
  } catch {
    readBack = null;
  }
  storageProbe.ramExpansions.push({
    kind,
    fault,
    byteLength: data.byteLength,
    memfsWriteStartAtMs: startAtMs,
    memfsWriteEndAtMs: endAtMs,
    verify: verifyBytes(data, readBack),
  });
}

// ---- RETRO_ENVIRONMENT_* (libretro.h より) ----
const RETRO_ENVIRONMENT_GET_CAN_DUPE = 3;
const RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY = 9;
const RETRO_ENVIRONMENT_SET_PIXEL_FORMAT = 10;
const RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS = 11;
const RETRO_ENVIRONMENT_SET_KEYBOARD_CALLBACK = 12;
const RETRO_ENVIRONMENT_SET_DISK_CONTROL_INTERFACE = 13;
const RETRO_ENVIRONMENT_GET_VARIABLE = 15;
const RETRO_ENVIRONMENT_GET_LOG_INTERFACE = 27;
const RETRO_ENVIRONMENT_SET_VARIABLES = 16;
const RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME = 18;
const RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY = 31;
const RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO = 32;
const RETRO_ENVIRONMENT_SET_CONTROLLER_INFO = 35;
const RETRO_ENVIRONMENT_SET_GEOMETRY = 37;
const RETRO_ENVIRONMENT_SET_CORE_OPTIONS = 53;
const RETRO_ENVIRONMENT_SET_CORE_OPTIONS_INTL = 54;
const RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY = 55;
const RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2 = 67;
const RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2_INTL = 68;

const RETRO_DEVICE_JOYPAD = 1;
const RETRO_DEVICE_MOUSE = 2;
const RETRO_DEVICE_KEYBOARD = 3;

// retro_device_id_mouse
const RETRO_DEVICE_ID_MOUSE_X = 0;
const RETRO_DEVICE_ID_MOUSE_Y = 1;
const RETRO_DEVICE_ID_MOUSE_LEFT = 2;
const RETRO_DEVICE_ID_MOUSE_RIGHT = 3;

const RETRO_PIXEL_FORMAT_RGB565 = 2;

// ---- Emscripten Module 型(最小限) ----
interface EmscriptenFS {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  unlink(path: string): void;
  analyzePath(path: string): { exists: boolean };
}

export interface PX68KModule {
  FS: EmscriptenFS;
  HEAPU8: Uint8Array;
  HEAPU16: Uint16Array;
  HEAP16: Int16Array;
  HEAP32: Int32Array;
  HEAPF32: Float32Array;
  HEAPF64: Float64Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  addFunction(fn: (...args: number[]) => number | void, sig: string): number;
  removeFunction(ptr: number): void;
  UTF8ToString(ptr: number): string;
  stringToUTF8(str: string, ptr: number, maxBytes: number): number;
  lengthBytesUTF8(str: string): number;
  _retro_set_environment(cb: number): void;
  _retro_set_video_refresh(cb: number): void;
  _retro_set_audio_sample(cb: number): void;
  _retro_set_audio_sample_batch(cb: number): void;
  _retro_set_input_poll(cb: number): void;
  _retro_set_input_state(cb: number): void;
  _retro_init(): void;
  _retro_deinit(): void;
  _retro_api_version(): number;
  _retro_get_system_av_info(infoPtr: number): void;
  _retro_reset(): void;
  _retro_run(): void;
  _retro_load_game(gameInfoPtr: number): number;
  _retro_unload_game(): void;
  _retro_serialize_size(): number;
  _retro_serialize(dataPtr: number, size: number): number;
  _retro_unserialize(dataPtr: number, size: number): number;
  _get_retro_log_shim(): number;
  // アクセスランプ用(px68k-libretro fork の x68k/fdd.c / x68k/sasi.c を core-shim.c 経由で公開)。
  // retro_run() の毎フレーム先頭で0クリアされるため、そのフレームでアクセスがあったかを示す。
  _get_fdd_is_reading(): number;
  _get_fdd_access_drive(): number;
  _get_sasi_is_accessing(): number;
  _get_fdd_dirty_mask(): number;
  _clear_fdd_dirty(drive: number): void;
  _get_sasi_dirty(): number;
  _clear_sasi_dirty(): void;
  // マウス配線の診断用(core-shim.c 経由で fork の libretro/mouse.c のアクセサを公開)
  _get_mouse_dx(): number;
  _get_mouse_dy(): number;
  _get_mouse_stat(): number;
  _get_mouse_enabled(): number;
  _get_mouse_scc_x(): number;
  _get_mouse_scc_y(): number;
  _get_mouse_scc_stat(): number;
  _webx68k_peek16(addr: number): number;
  _webx68k_peek8(addr: number): number;
  // RETROK → X68000 スキャンコード結合テスト用
  _webx68k_keybuf_peek(index: number): number;
  _webx68k_keybuf_write_pointer(): number;
  // FDD ホットマウント用(core-shim.c 経由で px68k の FDD_SetFD/FDD_EjectFD を公開)
  _webx68k_fdd_insert(drive: number, pathPtr: number): void;
  _webx68k_fdd_eject(drive: number): void;
  _webx68k_tvram_data?: () => number;
  _webx68k_text_dot_x?: () => number;
  _webx68k_text_dot_y?: () => number;
  _webx68k_text_scroll_x?: () => number;
  _webx68k_text_scroll_y?: () => number;
  // ジョイスティック配線の結合テスト用(core-shim.c 経由で libretro/joystick.c の Joystick_Read を公開)
  _webx68k_joystick_read(port: number): number;
  // SRAM($ED0000-$ED3FFF)読み出し用(core-shim.c 経由でx68k/sram.cのSRAM_Read()を公開)。
  // 古いwasm(再ビルド前)でも落ちないよう任意プロパティにしている。
  _webx68k_sram_read?(offset: number): number;
  // 実機と同じmakeのみのキーリピート注入用。古いwasmでも落ちないよう任意プロパティ。
  _webx68k_send_key_make?(scancode: number): void;
  // 調査用(2026-09-04、docs/STORAGE-SCSI.md参照): console/log_cbを一切経由しない
  // SCSI要求カウンタ。「ログが途絶えた=止まった」を独立に裏取りするためのもの。
  // 古いwasm(再ビルド前)でも落ちないよう任意プロパティにしている。
  _get_scsi_req_total?(): number;
  _get_scsi_unsupported_count?(): number;
  _get_scsi_read_count?(): number;
  _get_scsi_last_read_unit?(): number;
  _get_scsi_last_read_logsec?(): number;
  _get_scsi_write_count?(): number;
  _get_scsi_last_write_unit?(): number;
  _get_scsi_last_write_logsec?(): number;
  _get_scsi_strategy_call_count?(): number;
  _get_scsi_interrupt_call_count?(): number;
  // 調査用(2026-09-04、docs/STORAGE-SCSI.md参照): SASI(成功する側)の裏取り用カウンタ。
  // SCSI用と同じ趣旨(log_cbを経由しない)。古いwasm(再ビルド前)でも落ちないよう任意プロパティ。
  _get_sasi_req_total?(): number;
  _get_sasi_read_count?(): number;
  _get_sasi_last_read_lba?(): number;
  _get_sasi_write_count?(): number;
  _get_sasi_last_write_lba?(): number;
}

/**
 * SRAM先頭8バイトの機種シグネチャ「Ｘ68000W」(SJIS/Shift-JIS表現でのバイト列)。
 * webx68k_peek8()はmem_wrap.cの特殊ディスパッチによりSRAM領域($00ED0000-)を経由せず
 * 一律0xE5を返してしまい、過去に「読めているつもり」で不定値を掴んだ事故があった。
 * SRAM_Read()経由の_webx68k_sram_read()を使っていても、読み出し先が本物の初期化済み
 * SRAMかどうかは別問題(未初期化・オフセット間違い等でも値は返ってきてしまう)なので、
 * 読むたびにこのシグネチャで健全性を確認する。
 */
const SRAM_SIGNATURE = [0x82, 0x77, 0x36, 0x38, 0x30, 0x30, 0x30, 0x57];

declare global {
  interface Window {
    PX68K: (moduleArg?: Record<string, unknown>) => Promise<PX68KModule>;
  }
}

/** メインスレッド(window)・Worker(self)どちらのグローバルにも emscripten glue が
 * `PX68K` を代入する(index.htmlの<script>読み込み、またはcore-worker.tsのfetch+eval)。
 * `window` はWorker内では未定義になるが、`typeof window` はReferenceErrorを起こさず
 * 安全に判定できるのでこれで分岐する(実ブラウザのメインスレッドでは globalThis===window
 * なのでどちらから読んでも同じだが、テストがグローバルの `window` を個別オブジェクトとして
 * 差し替えるためここでは window を優先する)。Workerでは globalThis(===self)経由で読む。 */
function getPX68KFactory(): (moduleArg?: Record<string, unknown>) => Promise<PX68KModule> {
  if (typeof window !== 'undefined' && (window as unknown as Window).PX68K) {
    return (window as unknown as Window).PX68K;
  }
  return (globalThis as unknown as Window).PX68K;
}

export interface AvInfo {
  baseWidth: number;
  baseHeight: number;
  maxWidth: number;
  maxHeight: number;
  aspectRatio: number;
  fps: number;
  sampleRate: number;
}

export type AudioPushFn = (samples: Float32Array) => void;

// dev限定・受動的な音声振幅プローブ(予備確認: docs/STORAGE-SCSI.md「音声遅延」参照)が
// 「非無音」とみなす絶対振幅のしきい値。float32変換の丸め誤差(-32768/32768換算)より
// 十分大きく、通常の音声信号よりは十分小さい値として決め打ちした値であり、実測で
// 校正したものではない。
const AUDIO_PROBE_NON_SILENT_THRESHOLD = 1e-4;

/**
 * 1回のポーリングでコアへ渡せる移動量は -128..127（SCC が送れる範囲）。
 * これを超える分をそのまま渡すと Mouse_SetData() のクランプで切り捨てられて消えてしまうため、
 * 範囲内に丸めて残りは次回へ繰り越す。追従モードの大きなジャンプもこれで完走できる。
 */
function clampStep(value: number): number {
  return Math.max(-128, Math.min(127, Math.trunc(value)));
}

/** malloc した UTF-8 文字列へのポインタを返す（ホスト生存期間中は解放しない） */
function mallocString(mod: PX68KModule, str: string): number {
  const len = mod.lengthBytesUTF8(str) + 1;
  const ptr = mod._malloc(len);
  mod.stringToUTF8(str, ptr, len);
  return ptr;
}

export class LibretroHost {
  private mod!: PX68KModule;
  private canvas: HTMLCanvasElement;
  private ctx2d: CanvasRenderingContext2D;
  private audioPush: AudioPushFn;

  private systemDirPtr = 0;
  private saveDirPtr = 0;
  private coreOptions = new Map<string, string>();
  private coreOptionPtrs = new Map<string, number>();

  private keyState = new Set<number>();

  // dev限定・受動的な音声振幅プローブ(予備確認: docs/STORAGE-SCSI.md「音声遅延」参照)。
  // handleAudioBatch が既に全サンプルをFloat32へ変換するループを回しているため、その場で
  // 最大振幅と非無音サンプル数を積算するだけで済ませている。`import.meta.env.DEV` はViteの
  // 静的定数置換によりビルド時に確定するため、本番ビルドではこの分岐ごとデッドコード除去され
  // コストは残らない。一方dev環境では毎回のオーディオバッチ処理(概ね毎フレーム相当の頻度で
  // 呼ばれる)に比較1回ぶんのコストが常時乗る。呼ばれたときだけ読むKeyBufプローブと異なり、
  // 振幅は継続的な積算が要るため、この点はKeyBufプローブと性質が異なる(readMe参照)。
  private audioProbeMaxAbs = 0;
  private audioProbeSampleCount = 0;
  private audioProbeNonSilentCount = 0;
  // 既定オフ。計測スクリプト(scripts/measure-audio.mjs)が明示的にtrueへ設定したときだけ
  // handleAudioBatch内の積算コストが乗る(作業0: プローブ有無での起動時間比較の結果、
  // docs/STORAGE-SCSI.md「基準値：音声遅延」参照)。dev環境でも既定では通常のKeyBuf/起動/
  // 3ドライブ計測に無関係なコストを乗せないため、常時onから既定offへ変更した。
  audioProbeEnabled = false;

  // マウスは X68000 実機同様「相対移動量」で渡す(SCC が -128..127 のデルタを送る方式)。
  // コアは retro_run() 中に X/Y を1回ずつ読むので、読まれた分だけ差し引いて次フレームへ繰り越す。
  // 端数を残すのは、感度を下げたときに微小移動が切り捨てで消えてしまうのを防ぐため。
  private mouseDx = 0;
  private mouseDy = 0;
  private mouseButtons = { left: false, right: false };

  // RetroPad の押下状態をビットマスクで保持(bit = RETRO_DEVICE_ID_JOYPAD_*)。
  // ポート0/1の2系統ぶん。コアは retro_run() 中に inputStateCb を1IDずつ呼ぶので、
  // ここではポーリングされた瞬間の状態をそのまま返せればよい(マウスと違い積算しない)。
  private joyState: [number, number] = [0, 0];

  private imageData: ImageData | null = null;
  private lastWidth = 0;
  private lastHeight = 0;

  private callbackPtrs: number[] = [];

  // SRAM定期保存用。setInterval のIDと直近保存したバイト列(差分検出用)を持つ。
  private sramAutosaveTimer: ReturnType<typeof setInterval> | null = null;
  private lastSavedSram: Uint8Array | null = null;

  private _avInfo: AvInfo | null = null;
  // FS へ書いたものと逆引き用を必ず同じバイト列にするための唯一の CGROM 保持先。
  private coreCgrom: Uint8Array | null = null;

  /**
   * X68000 は画面モード変更で実行中に canvas.width/height(実解像度)が変わる。
   * ウィンドウ表示の等倍/整数倍リスケール(main.ts側)は canvas の実解像度を基準に
   * 計算しているため、解像度が変わった瞬間に再計算してもらう必要がある。
   * 毎フレーム呼ぶと無駄なので、handleVideoRefresh() 内で解像度が実際に変わった
   * ときだけ呼ぶ。呼び出し元(main.ts)が未配線でも動くよう任意プロパティにしている。
   */
  onResolutionChanged?: () => void;

  /**
   * retro_run() 冒頭、コアが Joystick_Update() 等で入力を読み出す前に呼ばれる input_poll コールバックのフック。
   * 結合テストで「このフレームでポーリングされたか」を検出する目的で任意プロパティにしている。
   */
  onPoll?: () => void;

  constructor(canvas: HTMLCanvasElement, audioPush: AudioPushFn) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D コンテキストの取得に失敗しました');
    this.ctx2d = ctx;
    this.audioPush = audioPush;
  }

  get avInfo(): AvInfo | null {
    return this._avInfo;
  }

  /** 現在の TVRAM 表示を ANK・16x16漢字文字列として読む。取得不能時も例外ではなく診断結果を返す。 */
  readTextScreen(): TextScreenDump {
    if (!this.coreCgrom) return unavailableTextScreenDump('CGROM が設定されていません');
    if (!this.mod) return unavailableTextScreenDump('コアが初期化されていません');
    if (this.coreCgrom.byteLength < MINIMUM_ANK_CGROM_SIZE) {
      return unavailableTextScreenDump(
        `CGROM が短すぎます: ${this.coreCgrom.byteLength} bytes (必要: ${MINIMUM_ANK_CGROM_SIZE})`,
      );
    }
    try {
      return extractTextScreenFromCore(this.mod, this.coreCgrom);
    } catch (err) {
      return unavailableTextScreenDump(err instanceof Error ? err.message : String(err));
    }
  }

  setKey(retrok: number, down: boolean): void {
    if (down) this.keyState.add(retrok);
    else this.keyState.delete(retrok);
  }

  /** 押下状態を変えず、RETROKに対応するmakeだけをコアへ追加する。 */
  sendKeyMake(retrok: number): void {
    const sendMake = this.mod?._webx68k_send_key_make;
    const scancode = RETROK_TO_SCANCODE[retrok];
    if (!sendMake || scancode === undefined) return;
    sendMake(scancode);
  }

  /** マウスの相対移動量を積む(ゲスト1ドット単位。呼び出し側で感度・表示倍率を換算済みの値を渡す) */
  addMouseDelta(dx: number, dy: number): void {
    this.mouseDx += dx;
    this.mouseDy += dy;
  }

  setMouseButton(button: 'left' | 'right', down: boolean): void {
    this.mouseButtons[button] = down;
  }

  /** ジョイパッドの押下状態を RetroPad ID ビットマスクで設定する(port: 0 or 1)。 */
  setJoyState(port: number, bits: number): void {
    this.joyState[port] = bits;
  }

  /**
   * まだコアへ渡しきれていない移動量が残っているか。
   * 1回のポーリングで送れるのは ±128 までなので、大きな移動(追従モードの基準合わせ等)は
   * 数フレームかけて消化される。その完了待ちに使う。
   */
  hasPendingMouseDelta(): boolean {
    return Math.abs(this.mouseDx) >= 1 || Math.abs(this.mouseDy) >= 1;
  }

  /**
   * ゲストのマウスカーソル状態を IOCS ワークエリアから読む。
   * ホスト側で位置を推定しなくて済むので、追従モードを閉ループにできる。
   *   $ACE/$AD0 = カーソル座標, $A9A..$AA0 = 可動範囲, $AA2 = 表示スイッチ
   * 座標は符号付きワードとして解釈する。
   */
  /** ゲストメモリを1バイト読む(MCP ブリッジの read_memory 用) */
  peekByte(addr: number): number {
    return this.mod._webx68k_peek8(addr);
  }

  /** ゲストメモリを1ワード(ビッグエンディアン)読む(デバッグ・IOCSワーク参照用) */
  peekWord(addr: number): number {
    return this.mod._webx68k_peek16(addr);
  }

  /**
   * 調査用(2026-09-04、docs/STORAGE-SCSI.md参照): console.log/log_cbを一切経由しない
   * SCSI要求カウンタをまとめて読む。「新規複数クラスタ割り当ての直後にSCSI要求が
   * 本当に来なくなっているか」を、Puppeteerのconsoleキャプチャや将来のログ上限とは
   * 無関係に確かめるためのもの。古いwasm(再ビルド前)では null を返す。
   */
  scsiDebugCounters(): {
    reqTotal: number;
    unsupported: number;
    readCount: number;
    lastReadUnit: number;
    lastReadLogsec: number;
    writeCount: number;
    lastWriteUnit: number;
    lastWriteLogsec: number;
    // 調査用(2026-09-04): d2テーブルのストラテジ(+$00)/インタラプト(+$0a)呼び出し
    // 回数(log_cbを経由しない独立カウンタ)。PCトレース上のrts件数(取りこぼしの
    // 有無)の裏取り用。古いwasm(再ビルド前)では-1のまま。
    strategyCallCount: number;
    interruptCallCount: number;
    // 調査用(2026-09-04、docs/STORAGE-SCSI.md参照): SASI(成功する側)の裏取り用カウンタ。
    // 古いwasm(再ビルド前)では-1のまま(SCSI側と同じ作法)。
    sasiReqTotal: number;
    sasiReadCount: number;
    sasiLastReadLba: number;
    sasiWriteCount: number;
    sasiLastWriteLba: number;
  } | null {
    if (!this.mod._get_scsi_req_total) return null;
    return {
      reqTotal: this.mod._get_scsi_req_total(),
      unsupported: this.mod._get_scsi_unsupported_count?.() ?? -1,
      readCount: this.mod._get_scsi_read_count?.() ?? -1,
      lastReadUnit: this.mod._get_scsi_last_read_unit?.() ?? -1,
      lastReadLogsec: this.mod._get_scsi_last_read_logsec?.() ?? -1,
      writeCount: this.mod._get_scsi_write_count?.() ?? -1,
      lastWriteUnit: this.mod._get_scsi_last_write_unit?.() ?? -1,
      lastWriteLogsec: this.mod._get_scsi_last_write_logsec?.() ?? -1,
      strategyCallCount: this.mod._get_scsi_strategy_call_count?.() ?? -1,
      interruptCallCount: this.mod._get_scsi_interrupt_call_count?.() ?? -1,
      sasiReqTotal: this.mod._get_sasi_req_total?.() ?? -1,
      sasiReadCount: this.mod._get_sasi_read_count?.() ?? -1,
      sasiLastReadLba: this.mod._get_sasi_last_read_lba?.() ?? -1,
      sasiWriteCount: this.mod._get_sasi_write_count?.() ?? -1,
      sasiLastWriteLba: this.mod._get_sasi_last_write_lba?.() ?? -1,
    };
  }

  /**
   * KeyBuf(128バイトのリングバッファ)の書き込みポインタと、start から count バイトぶんを
   * 読む。`test/core-keyboard-integration.test.ts` と同じ export
   * (`_webx68k_keybuf_peek` / `_webx68k_keybuf_write_pointer`) を経由する受動的な読み取りのみで、
   * 毎フレーム処理には一切関与しない。exportが無い古いwasmでは呼び出し側が判定できるよう null を返す。
   */
  readKeyBufWindow(start: number, count: number): { writePointer: number; bytes: number[] } | null {
    if (!this.mod._webx68k_keybuf_peek || !this.mod._webx68k_keybuf_write_pointer) return null;
    const bytes: number[] = [];
    for (let i = 0; i < count; i++) bytes.push(this.mod._webx68k_keybuf_peek(start + i));
    return { writePointer: this.mod._webx68k_keybuf_write_pointer(), bytes };
  }

  /**
   * SWITCH.Xで設定されたキーリピート設定をSRAMから読む。
   * SRAM $ED003A = 開始時間の段階値(n、FIRST_KEY)、$ED003B = 間隔の段階値(n、NEXT_KEY)で、
   * それぞれkeyRepeatDelayMsFromSramValue/keyRepeatIntervalMsFromSramValueのX68000の式でmsへ変換する。
   *
   * この番地は資料の記憶ではなく実測で確定させたもの。ゲスト上でSWITCH.Xを実際に起動し、
   * その表示(FIRST_KEY 3 → 500ms、NEXT_KEY 2 → 50ms、X68000の式 開始=200+100n /
   * 間隔=30+5n^2 に一致)と、起動直後のSRAMダンプの $ED003A=0x03 / $ED003B=0x02 が
   * 一致することを突き合わせて判明した。以前はここを $ED0059 / $ED005A だと誤って読んでいた。
   * この誤りはシグネチャ照合(先頭8バイト一致)や下のnullチェック(段階値0..15の範囲内か)を
   * どちらも素通りしてしまっていた。$ED0059=0 / $ED005A=1 がたまたま0..15に収まる値だった
   * ため、「読めてはいるが番地が違う」状態を検出できず、ゲスト自身の表示と突き合わせて
   * 初めて食い違いに気づけた。番地の正しさは範囲チェックでは保証できず、実測でしか確かめられない。
   * 次のいずれかに該当すればnullを返す(呼び出し側はKeyRepeaterの既定値のまま据え置くこと):
   *   - _webx68k_sram_read が無い(古いコア・再ビルド前のwasm)
   *   - SRAM先頭が機種シグネチャ「Ｘ68000W」と一致しない(SRAM未初期化・読み出し経路の異常)
   *   - 段階値(n)が0..15の整数範囲外
   */
  readKeyRepeatConfig(): { delayMs: number; intervalMs: number } | null {
    const mod = this.mod;
    const sramRead = mod._webx68k_sram_read;
    if (!sramRead) return null;
    for (let i = 0; i < SRAM_SIGNATURE.length; i++) {
      if (sramRead(i) !== SRAM_SIGNATURE[i]) return null;
    }
    const delayMs = keyRepeatDelayMsFromSramValue(sramRead(0x3a));
    const intervalMs = keyRepeatIntervalMsFromSramValue(sramRead(0x3b));
    if (delayMs === null || intervalMs === null) return null;
    return { delayMs, intervalMs };
  }

  /**
   * SRAM全体(0x4000バイト、$ED0000-$ED3FFFに対応)を読み出す。
   * 先頭8バイトが機種シグネチャ「Ｘ68000W」と一致しない場合はnullを返す
   * (readKeyRepeatConfig()と同じ健全性チェック)。ここでnullを弾かずに保存してしまうと、
   * 未初期化・読み出し経路異常のSRAMをそのまま永続化することになり、次回起動時に
   * その壊れたSRAMを読み込んで正常な状態へ戻れなくなってしまう。
   */
  readSram(): Uint8Array | null {
    const mod = this.mod;
    const sramRead = mod._webx68k_sram_read;
    if (!sramRead) return null;
    for (let i = 0; i < SRAM_SIGNATURE.length; i++) {
      if (sramRead(i) !== SRAM_SIGNATURE[i]) return null;
    }
    const bytes = new Uint8Array(0x4000);
    for (let i = 0; i < 0x4000; i++) bytes[i] = sramRead(i);
    return bytes;
  }

  /**
   * SRAMを定期的に読み、前回保存した内容から変化していれば save() を呼ぶ。
   * 離脱イベント(beforeunload/pagehide)に保存を託さない設計にしている
   * (非同期処理を完走できないことがあり、過去にそれで保存し損ねた実績があるため)。
   * 代わりに平常時、短い間隔(3秒)で読み直して差分があれば保存する。
   * SWITCH.Xの設定はユーザーが明示的に変更したときしか変わらないため、
   * 16KB全バイト比較をこの頻度で行っても無駄が大きくない(毎フレーム=60Hzで
   * やる必要はない)。同名タイマーが既にあれば張り替える。
   */
  startSramAutosave(save: (bytes: Uint8Array) => void): void {
    this.stopSramAutosave();
    this.sramAutosaveTimer = setInterval(() => {
      const bytes = this.readSram();
      if (!bytes) return; // シグネチャ不一致(未初期化等)は保存対象にしない
      if (this.lastSavedSram && bytesEqual(this.lastSavedSram, bytes)) return;
      this.lastSavedSram = bytes;
      save(bytes);
    }, 3000);
  }

  /** SRAM定期保存を止める(dispose時・テスト後始末用)。 */
  stopSramAutosave(): void {
    if (this.sramAutosaveTimer !== null) {
      clearInterval(this.sramAutosaveTimer);
      this.sramAutosaveTimer = null;
    }
  }

  readGuestCursor(): { x: number; y: number; minX: number; minY: number; maxX: number; maxY: number; visible: boolean } | null {
    const mod = this.mod;
    const word = (addr: number): number => {
      const v = mod._webx68k_peek16(addr);
      return v >= 0x8000 ? v - 0x10000 : v;
    };
    const x = word(0x0ace);
    const y = word(0x0ad0);
    const minX = word(0x0a9a);
    const minY = word(0x0a9c);
    const maxX = word(0x0a9e);
    const maxY = word(0x0aa0);
    // 可動範囲が未初期化(すべて0など)ならワークエリアを信用しない
    if (maxX <= minX || maxY <= minY) return null;
    return { x, y, minX, minY, maxX, maxY, visible: mod._webx68k_peek8(0x0aa2) !== 0 };
  }

  /** キャプチャ解除時などに、積み残しのデルタとボタン押下状態を捨てる */
  clearMouseState(): void {
    this.mouseDx = 0;
    this.mouseDy = 0;
    this.mouseButtons.left = false;
    this.mouseButtons.right = false;
  }

  /**
   * コア内部のマウス状態を覗く(配線確認用)。
   * dx/dy はコアが溜めている累積デルタで、ゲストが SCC 経由でポーリングしたときに 0 へ吸われる。
   * enabled は px68k の MouseSW で、コアオプション px68k_joy_mouse が "Mouse" のときに 1 になる。
   */
  readMouseState(): {
    dx: number;
    dy: number;
    stat: number;
    enabled: boolean;
    sccX: number;
    sccY: number;
    sccStat: number;
  } {
    const mod = this.mod;
    return {
      dx: mod._get_mouse_dx(),
      dy: mod._get_mouse_dy(),
      stat: mod._get_mouse_stat(),
      enabled: mod._get_mouse_enabled() !== 0,
      // ゲストがポーリングした時点で累積デルタがこちらへ移る(SCC へ渡る実値)
      sccX: mod._get_mouse_scc_x(),
      sccY: mod._get_mouse_scc_y(),
      sccStat: mod._get_mouse_scc_stat(),
    };
  }

  /**
   * コアオプション(px68k_cpuspeed 等)を設定する。init() 前後どちらでも呼べる。
   * 値変更時は該当キーの malloc 済み文字列キャッシュを破棄し、次回 GET_VARIABLE で再 malloc させる
   * (キャッシュを残すと古い文字列ポインタを返し続けてしまうため)。
   */
  setCoreOption(key: string, value: string): void {
    this.coreOptions.set(key, value);
    const oldPtr = this.coreOptionPtrs.get(key);
    if (oldPtr !== undefined) {
      this.coreOptionPtrs.delete(key);
      if (this.mod) this.mod._free(oldPtr);
    }
  }

  /**
   * BIOS ファイル(と、あれば SRAM)を書き込み、コアを初期化する。
   * SRAM_Init()(x68k/sram.c)は sram.dat を retro_load_game() の中(WinX68k_Init()経由)で
   * 読むため、ここ(retro_load_game() より確実に前)で書いておく必要がある。長さが
   * 0x4000(16KB)でないものは壊れたデータを渡さないよう無視する(未初期化 0xFF 埋めの
   * ままIPLに既定値を書かせたほうが安全なため)。
   */
  async init(biosIpl: Uint8Array, biosCg: Uint8Array, sram?: Uint8Array): Promise<void> {
    // locateFile: emscripten glue は既定で自身のスクリプトの所在(scriptDirectory、
    // メインスレッドでは document.currentScript.src、Workerでは self.location.href)から
    // wasm の相対パスを推測する。Worker内では core-worker.ts が glue を
    // `<script src="/core/px68k_libretro.js">` 経由ではなく fetch+eval で読み込むため、
    // scriptDirectory が worker自身のURL(/src/core-worker.ts?...)になってしまい、
    // wasm を誤って `/src/px68k_libretro.wasm` から取得しようとして失敗する(実測)。
    // メインスレッドの `<script>` タグと同じ絶対パス `/core/` を明示することで、
    // メインスレッド・Worker どちらでも scriptDirectory 推測に依存しないようにする。
    const mod = await getPX68KFactory()({ locateFile: (path: string) => `/core/${path}` });
    this.mod = mod;

    this.mkdirSafe('/system');
    this.mkdirSafe('/system/keropi');
    this.mkdirSafe('/save');
    this.mkdirSafe('/game');

    probedMemfsWrite(mod, 'rom-ipl', '/system/keropi/iplrom.dat', biosIpl);
    // 呼び出し元による後日の変更を遮断し、この同じ配列を FS 書き込みと逆引きの両方に使う。
    this.coreCgrom = biosCg.slice();
    probedMemfsWrite(mod, 'rom-cg', '/system/keropi/cgrom.dat', this.coreCgrom);

    if (sram) {
      if (sram.byteLength === 0x4000) {
        mod.FS.writeFile('/system/keropi/sram.dat', sram);
      } else {
        console.warn(
          `SRAMファイルのサイズが不正です(${sram.byteLength} bytes, 期待値 0x4000): 無視します`,
        );
      }
    }

    this.systemDirPtr = mallocString(mod, '/system');
    this.saveDirPtr = mallocString(mod, '/save');

    this.registerCallbacks();

    mod._retro_init();
  }

  private mkdirSafe(path: string): void {
    try {
      this.mod ? this.mod.FS.mkdir(path) : undefined;
    } catch {
      // 既に存在する場合は無視
    }
  }

  private registerCallbacks(): void {
    const mod = this.mod;

    const environmentCb = (cmd: number, data: number): number => this.handleEnvironment(cmd, data);
    const videoRefreshCb = (data: number, width: number, height: number, pitch: number): void =>
      this.handleVideoRefresh(data, width, height, pitch);
    const audioSampleCb = (left: number, right: number): void => {
      this.audioPush(new Float32Array([left / 32768, right / 32768]));
    };
    const audioSampleBatchCb = (data: number, frames: number): number => this.handleAudioBatch(data, frames);
    const inputPollCb = (): void => {
      /* keyState/mouse は DOM イベントで直接更新される。joyState 用のフックのみ呼ぶ */
      this.onPoll?.();
    };
    const inputStateCb = (port: number, device: number, _index: number, id: number): number => {
      if (device === RETRO_DEVICE_KEYBOARD) return this.keyState.has(id) ? 1 : 0;
      if (device === RETRO_DEVICE_MOUSE) {
        switch (id) {
          case RETRO_DEVICE_ID_MOUSE_X: {
            const step = clampStep(this.mouseDx);
            this.mouseDx -= step;
            return step;
          }
          case RETRO_DEVICE_ID_MOUSE_Y: {
            const step = clampStep(this.mouseDy);
            this.mouseDy -= step;
            return step;
          }
          case RETRO_DEVICE_ID_MOUSE_LEFT:
            return this.mouseButtons.left ? 1 : 0;
          case RETRO_DEVICE_ID_MOUSE_RIGHT:
            return this.mouseButtons.right ? 1 : 0;
          default:
            return 0;
        }
      }
      if (device === RETRO_DEVICE_JOYPAD) {
        if (port !== 0 && port !== 1) return 0;
        return (this.joyState[port] >> id) & 1;
      }
      return 0;
    };

    const environmentPtr = mod.addFunction(environmentCb, 'iii');
    const videoRefreshPtr = mod.addFunction(videoRefreshCb, 'viiii');
    const audioSamplePtr = mod.addFunction(audioSampleCb, 'vii');
    const audioSampleBatchPtr = mod.addFunction(audioSampleBatchCb, 'iii');
    const inputPollPtr = mod.addFunction(inputPollCb, 'v');
    const inputStatePtr = mod.addFunction(inputStateCb, 'iiiii');

    this.callbackPtrs = [
      environmentPtr,
      videoRefreshPtr,
      audioSamplePtr,
      audioSampleBatchPtr,
      inputPollPtr,
      inputStatePtr,
    ];

    mod._retro_set_environment(environmentPtr);
    mod._retro_set_video_refresh(videoRefreshPtr);
    mod._retro_set_audio_sample(audioSamplePtr);
    mod._retro_set_audio_sample_batch(audioSampleBatchPtr);
    mod._retro_set_input_poll(inputPollPtr);
    mod._retro_set_input_state(inputStatePtr);
  }

  private handleEnvironment(cmd: number, data: number): number {
    const mod = this.mod;
    switch (cmd) {
      case RETRO_ENVIRONMENT_GET_CAN_DUPE:
        mod.HEAPU8[data] = 1;
        return 1;

      case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
        mod.HEAP32[data >> 2] = this.systemDirPtr;
        return 1;

      case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
        mod.HEAP32[data >> 2] = this.saveDirPtr;
        return 1;

      case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: {
        const fmt = mod.HEAP32[data >> 2];
        return fmt === RETRO_PIXEL_FORMAT_RGB565 ? 1 : 0;
      }

      case RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME:
        return 1;

      // px68k は画面モード(15kHz/31kHz)が切り替わるたびに FRAMERATE を作り直して
      // SET_SYSTEM_AV_INFO を投げてくる(libretro.c の CHANGEAV_TIMING)。
      // ここを無視すると「コアの1フレームあたり音声サンプル数(44100/FRAMERATE)」と
      // 「ホストが回すフレームレート」がズレたままになり、その差の分だけ音声が
      // 際限なく遅延していく(61.46 と 55.46 で約10%ズレる)。必ず追随させること。
      case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO: {
        this._avInfo = this.parseAvInfo(data);
        return 1;
      }

      // SET_GEOMETRY は retro_game_geometry のみ(= av_info 先頭20バイトと同レイアウト)。
      // タイミング情報は据え置きで解像度だけ更新する。
      case RETRO_ENVIRONMENT_SET_GEOMETRY: {
        if (this._avInfo) {
          this._avInfo.baseWidth = mod.HEAP32[data >> 2];
          this._avInfo.baseHeight = mod.HEAP32[(data + 4) >> 2];
          this._avInfo.maxWidth = mod.HEAP32[(data + 8) >> 2];
          this._avInfo.maxHeight = mod.HEAP32[(data + 12) >> 2];
          this._avInfo.aspectRatio = mod.HEAPF32[(data + 16) >> 2];
        }
        return 1;
      }

      case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
        // struct retro_log_callback { retro_log_printf_t log; }
        // 可変長引数のため C シム(core-shim.c)の関数ポインタを渡す
        mod.HEAP32[data >> 2] = mod._get_retro_log_shim();
        return 1;

      case RETRO_ENVIRONMENT_GET_VARIABLE: {
        const keyPtr = mod.HEAP32[data >> 2];
        if (!keyPtr) return 0;
        const key = mod.UTF8ToString(keyPtr);
        const value = this.coreOptions.get(key);
        if (value === undefined) return 0;
        let valPtr = this.coreOptionPtrs.get(key);
        if (!valPtr) {
          valPtr = mallocString(mod, value);
          this.coreOptionPtrs.set(key, valPtr);
        }
        mod.HEAP32[(data + 4) >> 2] = valPtr;
        return 1;
      }

      case RETRO_ENVIRONMENT_SET_VARIABLES:
      case RETRO_ENVIRONMENT_SET_CORE_OPTIONS:
      case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_INTL:
      case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY:
      case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2:
      case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2_INTL:
      case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
      case RETRO_ENVIRONMENT_SET_KEYBOARD_CALLBACK:
      case RETRO_ENVIRONMENT_SET_DISK_CONTROL_INTERFACE:
      case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
        return 1;

      default:
        return 0;
    }
  }

  private handleVideoRefresh(data: number, width: number, height: number, pitch: number): void {
    const probing = import.meta.env.DEV && frameProbe.enabled;
    // frameCounterはrunFrame()側で既にインクリメント済みなので、対応する直近フレームは-1。
    const frameIndex = probing ? Math.max(0, frameProbe.frameCounter - 1) : 0;

    if (data === 0 || width === 0 || height === 0) {
      // dupe frame。実際の再変換・putImageDataは発生しないので、その旨だけ記録する。
      if (probing) {
        frameProbe.videoEvents.push({
          frameIndex,
          dupe: true,
          width,
          height,
          fps: this.avInfo?.fps ?? null,
          convertStartAtMs: performance.now(),
          convertEndAtMs: null,
          putStartAtMs: null,
          putEndAtMs: null,
        });
      }
      return;
    }

    if (width !== this.lastWidth || height !== this.lastHeight) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.imageData = this.ctx2d.createImageData(width, height);
      this.lastWidth = width;
      this.lastHeight = height;
      // 実解像度が変わった直後だけ通知する(このコールバックは毎フレーム発生するhandleVideoRefresh
      // 全体ではなく、このifブロックの内側=解像度変化があった時にしか呼ばれない)。
      this.onResolutionChanged?.();
    }

    const mod = this.mod;
    const img = this.imageData;
    if (!img) return;

    const convertStartAtMs = probing ? performance.now() : 0;

    const src16 = mod.HEAPU16;
    const strideSamples = pitch >> 1; // pitch はバイト単位、RGB565は1pixel=2byte
    const base = data >> 1;
    const out = img.data;

    for (let y = 0; y < height; y++) {
      let srcIdx = base + y * strideSamples;
      let dstIdx = y * width * 4;
      for (let x = 0; x < width; x++) {
        const px = src16[srcIdx];
        const r5 = (px >> 11) & 0x1f;
        const g6 = (px >> 5) & 0x3f;
        const b5 = px & 0x1f;
        out[dstIdx] = (r5 << 3) | (r5 >> 2);
        out[dstIdx + 1] = (g6 << 2) | (g6 >> 4);
        out[dstIdx + 2] = (b5 << 3) | (b5 >> 2);
        out[dstIdx + 3] = 255;
        srcIdx++;
        dstIdx += 4;
      }
    }

    if (!probing) {
      this.ctx2d.putImageData(img, 0, 0);
      return;
    }

    const convertEndAtMs = performance.now();
    const putStartAtMs = performance.now();
    this.ctx2d.putImageData(img, 0, 0);
    const putEndAtMs = performance.now();
    frameProbe.videoEvents.push({
      frameIndex,
      dupe: false,
      width,
      height,
      fps: this.avInfo?.fps ?? null,
      convertStartAtMs,
      convertEndAtMs,
      putStartAtMs,
      putEndAtMs,
    });
  }

  private handleAudioBatch(data: number, frames: number): number {
    if (frames <= 0) return frames;
    const mod = this.mod;
    const base = data >> 1;
    const count = frames * 2;
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const sample = mod.HEAP16[base + i] / 32768;
      out[i] = sample;
      // dev限定・受動的な振幅プローブ。import.meta.env.DEVは静的定数のため本番ビルドでは
      // この行ごとデッドコード除去される(上のフィールド宣言のコメント参照)。既定offの
      // audioProbeEnabledも併せて見ることで、dev環境でも計測時以外はコストを乗せない。
      if (import.meta.env.DEV && this.audioProbeEnabled) {
        const abs = sample < 0 ? -sample : sample;
        if (abs > this.audioProbeMaxAbs) this.audioProbeMaxAbs = abs;
        if (abs > AUDIO_PROBE_NON_SILENT_THRESHOLD) this.audioProbeNonSilentCount++;
        this.audioProbeSampleCount++;
      }
    }
    this.audioPush(out);
    return frames;
  }

  /**
   * 音声振幅プローブを初期化する。予備確認(音声遅延の陰性/陽性対照)で、操作前後の
   * 積算区間を切り分けるために使う。呼び出し自体はカウンタのリセットのみで、
   * オーディオコールバックの動作には関与しない。
   */
  resetAudioProbe(): void {
    this.audioProbeMaxAbs = 0;
    this.audioProbeSampleCount = 0;
    this.audioProbeNonSilentCount = 0;
  }

  /**
   * 直前の resetAudioProbe() 以降にコアが生成した音声サンプルの最大振幅(絶対値、0..1)、
   * サンプル総数、非無音サンプル数(しきい値 AUDIO_PROBE_NON_SILENT_THRESHOLD 超)を返す。
   * queuedSec(AudioWorkletの未再生キュー時間)と異なり、無音サンプルもキューには積まれる
   * ため区別できない問題を避けるための、コア出力そのものの受動的な読み取り。
   */
  readAudioProbe(): { maxAbs: number; sampleCount: number; nonSilentCount: number; threshold: number } {
    return {
      maxAbs: this.audioProbeMaxAbs,
      sampleCount: this.audioProbeSampleCount,
      nonSilentCount: this.audioProbeNonSilentCount,
      threshold: AUDIO_PROBE_NON_SILENT_THRESHOLD,
    };
  }

  /** 任意のバイト列を FS の指定パスへ書き込む(既存ファイルがあれば上書き) */
  writeFile(path: string, data: Uint8Array): void {
    try {
      this.mod.FS.unlink(path);
    } catch {
      // 存在しなければ無視
    }
    this.mod.FS.writeFile(path, data);
  }

  /** FS 上のファイルを削除する(存在しなければ何もしない) */
  removeFile(path: string): void {
    try {
      this.mod.FS.unlink(path);
    } catch {
      // 存在しなければ無視
    }
  }

  /** ディスクイメージのバイト列を FS の /game 配下へ書き込み、パスを返す */
  writeDiskImage(filename: string, data: Uint8Array): string {
    const path = `/game/${filename}`;
    // 目的B「起動時のRAM展開」の計測対象は fdd0_*/fdd1_*/hdd_* の命名(bootCore()参照)。
    // ホットスワップ等の他の呼び出しも同じ命名を通るため、区別せずそのまま記録される
    // (起動直後の1回目だけを見たい場合は測定スクリプト側で最初の1件を使う)。
    const kind: RamExpansionKind | null = filename.startsWith('fdd0_')
      ? 'fdd0'
      : filename.startsWith('fdd1_')
        ? 'fdd1'
        : filename.startsWith('hdd_')
          ? 'hdd'
          : null;
    if (kind && import.meta.env.DEV && storageProbe.enabled) {
      try {
        this.mod.FS.unlink(path);
      } catch {
        // 存在しなければ無視
      }
      probedMemfsWrite(this.mod, kind, path, data);
    } else {
      this.writeFile(path, data);
    }
    return path;
  }

  /**
   * FS 上の指定パスのファイルを読み出す(ダウンロード用)。
   * コアはディスクイメージを /game 配下のファイルへ直接書き換えるため、
   * ゲスト側で書き込んだ内容を含む最新バイト列を取得できる。
   */
  readFile(path: string): Uint8Array {
    return this.mod.FS.readFile(path);
  }

  /** ディスク未指定でコンテンツ無し起動 */
  loadGameNone(): boolean {
    return this.mod._retro_load_game(0) !== 0;
  }

  loadGame(path: string): boolean {
    const mod = this.mod;
    const pathPtr = mallocString(mod, path);
    const infoPtr = mod._malloc(16); // path,data,size,meta (各4byte, wasm32)
    mod.HEAP32[infoPtr >> 2] = pathPtr;
    mod.HEAP32[(infoPtr + 4) >> 2] = 0;
    mod.HEAP32[(infoPtr + 8) >> 2] = 0;
    mod.HEAP32[(infoPtr + 12) >> 2] = 0;
    const ok = mod._retro_load_game(infoPtr) !== 0;
    mod._free(infoPtr);
    mod._free(pathPtr);
    return ok;
  }

  unloadGame(): void {
    this.mod._retro_unload_game();
  }

  /** retro_system_av_info 構造体(geometry 20byte + 4byte pad + timing 16byte)を読み出す */
  private parseAvInfo(ptr: number): AvInfo {
    const mod = this.mod;
    return {
      baseWidth: mod.HEAP32[ptr >> 2],
      baseHeight: mod.HEAP32[(ptr + 4) >> 2],
      maxWidth: mod.HEAP32[(ptr + 8) >> 2],
      maxHeight: mod.HEAP32[(ptr + 12) >> 2],
      aspectRatio: mod.HEAPF32[(ptr + 16) >> 2],
      fps: mod.HEAPF64[(ptr + 24) >> 3],
      sampleRate: mod.HEAPF64[(ptr + 32) >> 3],
    };
  }

  fetchAvInfo(): AvInfo {
    const mod = this.mod;
    const ptr = mod._malloc(40); // geometry(20+4pad) + timing(16) = 40byte
    mod._retro_get_system_av_info(ptr);
    const info = this.parseAvInfo(ptr);
    mod._free(ptr);
    this._avInfo = info;
    return info;
  }

  /**
   * 実行中の FDD ディスク差し替え(ホットマウント)。
   * path が空文字列なら取り出し。コア再起動を伴わずに実機同様のメディア交換になる。
   */
  setFddImage(drive: number, path: string): void {
    const mod = this.mod;
    if (!path) {
      mod._webx68k_fdd_eject(drive);
      return;
    }
    const pathPtr = mallocString(mod, path);
    try {
      mod._webx68k_fdd_insert(drive, pathPtr);
    } finally {
      mod._free(pathPtr);
    }
  }

  reset(): void {
    this.mod._retro_reset();
  }

  /**
   * 現在の実行状態をシリアライズして返す(ステートセーブ)。
   * px68k-libretro 側は RAM/SRAM/CPU/VRAM/CRTC/DMAC/MFP/FDC/FDD/SASI/OPM/ADPCM 等を保存するが、
   * **ディスクイメージの中身とマウントパスは含まれない**。ロード時は同じディスクが
   * 挿さっている前提になるため、呼び出し側でスロット構成を別途記録して照合すること。
   */
  serialize(): Uint8Array | null {
    const mod = this.mod;
    const size = mod._retro_serialize_size();
    if (size <= 0) return null;
    const ptr = mod._malloc(size);
    try {
      if (mod._retro_serialize(ptr, size) === 0) return null;
      // HEAPU8 のビューをそのまま返すと後続の malloc/メモリ拡張で無効化されるため複製する
      return new Uint8Array(mod.HEAPU8.subarray(ptr, ptr + size));
    } finally {
      mod._free(ptr);
    }
  }

  /** シリアライズ済みの状態を復元する(ステートロード)。成功したら true。 */
  unserialize(bytes: Uint8Array): boolean {
    const mod = this.mod;
    const ptr = mod._malloc(bytes.length);
    try {
      mod.HEAPU8.set(bytes, ptr);
      return mod._retro_unserialize(ptr, bytes.length) !== 0;
    } finally {
      mod._free(ptr);
    }
  }

  runFrame(): void {
    // 目的B「フレーム時間の分布」計測(docs/STORAGE-SCSI.md参照)。DEVかつ frameProbe.enabled の
    // ときだけ計測コードを実行する。無効時はこの分岐自体を通らず、常時コストを持ち込まない。
    if (import.meta.env.DEV && frameProbe.enabled) {
      const frameIndex = frameProbe.frameCounter++;
      const runStartAtMs = performance.now();
      this.mod._retro_run();
      const runEndAtMs = performance.now();
      // 測定系の検証専用: 60フレームごとに50msのbusy waitを注入し、rAF間隔・canvas末端時間・
      // long task・予算超過率のすべてに裾が現れることを確認する(本番ビルドには含まれない)。
      let busyWaitInjectedMs = 0;
      if (frameProbe.busyWaitFaultEnabled && frameIndex % 60 === 0) {
        busyWaitInjectedMs = 50;
        const until = performance.now() + busyWaitInjectedMs;
        while (performance.now() < until) {
          /* 意図的な同期busy wait(測定専用の故障注入) */
        }
      }
      frameProbe.runEvents.push({ frameIndex, runStartAtMs, runEndAtMs, busyWaitInjectedMs });
      return;
    }
    // 既定経路の帰属計測(docs/STORAGE-SCSI.md「帰属の定義」参照)。frameProbe.enabledとは
    // 独立に、keybufAttributionProbe.enabledのときだけ動く軽量な専用カウンタを使う
    // (frameProbe側のperformance.now()×2回・配列pushを持ち込むと、計測対象そのものである
    // キー入力レイテンシを汚染しかねないため、あえて分けてある)。
    if (import.meta.env.DEV && keybufAttributionProbe.enabled) {
      this.mod._retro_run();
      keybufAttributionProbe.frameNo++;
      const writePointer = this.mod._webx68k_keybuf_write_pointer
        ? this.mod._webx68k_keybuf_write_pointer()
        : undefined;
      if (writePointer !== undefined) {
        keybufAttributionProbe.tracker = trackKeyBufWrite(
          keybufAttributionProbe.tracker,
          writePointer,
          keybufAttributionProbe.frameNo,
        );
      }
      return;
    }
    this.mod._retro_run();
  }

  /**
   * 直近の runFrame() でディスクアクセスがあったかを取得する(アクセスランプ用)。
   * fdd.c 側は FDD_IsReading/FDD_AccessDrive を retro_run() の毎フレーム先頭で0クリアするため、
   * runFrame() 呼び出し直後に読まないと取りこぼす。
   */
  readDiskAccess(): { fddReading: boolean; fddDrive: number; hddAccessing: boolean } {
    const mod = this.mod;
    return {
      fddReading: mod._get_fdd_is_reading() !== 0,
      fddDrive: mod._get_fdd_access_drive(),
      hddAccessing: mod._get_sasi_is_accessing() !== 0,
    };
  }

  /**
   * ゲストがディスクへ書き込んだか(オートセーブ用のダーティフラグ)。
   * アクセスランプ用のフラグと違い、コアは自動でクリアしないので、
   * ホストが保存を終えるまで立ち続ける。
   */
  readDirtyState(): { fddMask: number; hdd: boolean } {
    const mod = this.mod;
    return { fddMask: mod._get_fdd_dirty_mask(), hdd: mod._get_sasi_dirty() !== 0 };
  }

  /**
   * ダーティフラグを落とす。
   * 吸い出しの「直前」に呼ぶこと。吸い出した後にクリアすると、吸い出し中に
   * 発生した書き込みまで一緒に消してしまい、その分が保存されなくなる。
   */
  clearDirty(target: { fddDrive?: number; hdd?: boolean }): void {
    if (target.fddDrive !== undefined) this.mod._clear_fdd_dirty(target.fddDrive);
    if (target.hdd) this.mod._clear_sasi_dirty();
  }

  /** コールバック用関数テーブルエントリを解放する */
  dispose(): void {
    this.stopSramAutosave();
    for (const ptr of this.callbackPtrs) {
      this.mod.removeFunction(ptr);
    }
    this.callbackPtrs = [];
  }
}

/** 2つのUint8Arrayが同じ内容か(長さ違いも含めて)比較する素朴な全バイト比較。 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
