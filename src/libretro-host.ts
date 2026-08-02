// px68k-libretro (emscripten ビルド) コアの JS ホスト実装。
// libretro API の callback を wasm 関数テーブルへ登録し、コアを駆動する。

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
const RETRO_ENVIRONMENT_SET_CONTROLLER_INFO = 35;
const RETRO_ENVIRONMENT_SET_CORE_OPTIONS = 53;
const RETRO_ENVIRONMENT_SET_CORE_OPTIONS_INTL = 54;
const RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY = 55;
const RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2 = 67;
const RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2_INTL = 68;

const RETRO_DEVICE_JOYPAD = 1;
const RETRO_DEVICE_KEYBOARD = 3;

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
  _get_retro_log_shim(): number;
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

  private imageData: ImageData | null = null;
  private lastWidth = 0;
  private lastHeight = 0;

  private callbackPtrs: number[] = [];

  private _avInfo: AvInfo | null = null;

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

  setKey(retrok: number, down: boolean): void {
    if (down) this.keyState.add(retrok);
    else this.keyState.delete(retrok);
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
    mod.FS.writeFile('/system/keropi/cgrom.dat', biosCg);

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

  /** ディスクイメージのバイト列を FS の /game 配下へ書き込み、パスを返す */
  writeDiskImage(filename: string, data: Uint8Array): string {
    const path = `/game/${filename}`;
    try {
      this.mod.FS.unlink(path);
    } catch {
      // 存在しなければ無視
    }
    this.mod.FS.writeFile(path, data);
    return path;
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

  fetchAvInfo(): AvInfo {
    const mod = this.mod;
    const ptr = mod._malloc(40); // geometry(20+4pad) + timing(16) = 40byte
    mod._retro_get_system_av_info(ptr);
    const info: AvInfo = {
      baseWidth: mod.HEAP32[ptr >> 2],
      baseHeight: mod.HEAP32[(ptr + 4) >> 2],
      maxWidth: mod.HEAP32[(ptr + 8) >> 2],
      maxHeight: mod.HEAP32[(ptr + 12) >> 2],
      aspectRatio: mod.HEAPF32[(ptr + 16) >> 2],
      fps: mod.HEAPF64[(ptr + 24) >> 3],
      sampleRate: mod.HEAPF64[(ptr + 32) >> 3],
    };
    mod._free(ptr);
    this._avInfo = info;
    return info;
  }

  reset(): void {
    this.mod._retro_reset();
  }

  runFrame(): void {
    this.mod._retro_run();
  }

  /** コールバック用関数テーブルエントリを解放する */
  dispose(): void {
    for (const ptr of this.callbackPtrs) {
      this.mod.removeFunction(ptr);
    }
    this.callbackPtrs = [];
  }
}
