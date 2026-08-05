// px68k-libretro (emscripten ビルド) コアの JS ホスト実装。
// libretro API の callback を wasm 関数テーブルへ登録し、コアを駆動する。

import {
  extractTextScreenFromCore,
  MINIMUM_ANK_CGROM_SIZE,
  type TextScreenDump,
  unavailableTextScreenDump,
} from './text-screen';

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
}

declare global {
  interface Window {
    PX68K: (moduleArg?: Record<string, unknown>) => Promise<PX68KModule>;
  }
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

  // マウスは X68000 実機同様「相対移動量」で渡す(SCC が -128..127 のデルタを送る方式)。
  // コアは retro_run() 中に X/Y を1回ずつ読むので、読まれた分だけ差し引いて次フレームへ繰り越す。
  // 端数を残すのは、感度を下げたときに微小移動が切り捨てで消えてしまうのを防ぐため。
  private mouseDx = 0;
  private mouseDy = 0;
  private mouseButtons = { left: false, right: false };

  private imageData: ImageData | null = null;
  private lastWidth = 0;
  private lastHeight = 0;

  private callbackPtrs: number[] = [];

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

  /** マウスの相対移動量を積む(ゲスト1ドット単位。呼び出し側で感度・表示倍率を換算済みの値を渡す) */
  addMouseDelta(dx: number, dy: number): void {
    this.mouseDx += dx;
    this.mouseDy += dy;
  }

  setMouseButton(button: 'left' | 'right', down: boolean): void {
    this.mouseButtons[button] = down;
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

  /** BIOS ファイルを書き込み、コアを初期化する */
  async init(biosIpl: Uint8Array, biosCg: Uint8Array): Promise<void> {
    const mod = await window.PX68K({});
    this.mod = mod;

    this.mkdirSafe('/system');
    this.mkdirSafe('/system/keropi');
    this.mkdirSafe('/save');
    this.mkdirSafe('/game');

    mod.FS.writeFile('/system/keropi/iplrom.dat', biosIpl);
    // 呼び出し元による後日の変更を遮断し、この同じ配列を FS 書き込みと逆引きの両方に使う。
    this.coreCgrom = biosCg.slice();
    mod.FS.writeFile('/system/keropi/cgrom.dat', this.coreCgrom);

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
      /* no-op: keyState は DOM イベントで直接更新される */
    };
    const inputStateCb = (_port: number, device: number, _index: number, id: number): number => {
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
      if (device === RETRO_DEVICE_JOYPAD) return 0;
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
    if (data === 0 || width === 0 || height === 0) return; // dupe frame

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

    this.ctx2d.putImageData(img, 0, 0);
  }

  private handleAudioBatch(data: number, frames: number): number {
    if (frames <= 0) return frames;
    const mod = this.mod;
    const base = data >> 1;
    const count = frames * 2;
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = mod.HEAP16[base + i] / 32768;
    }
    this.audioPush(out);
    return frames;
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
    this.writeFile(path, data);
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

  /** コールバック用関数テーブルエントリを解放する */
  dispose(): void {
    for (const ptr of this.callbackPtrs) {
      this.mod.removeFunction(ptr);
    }
    this.callbackPtrs = [];
  }
}
