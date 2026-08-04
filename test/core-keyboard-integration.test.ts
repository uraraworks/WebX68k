import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { RETROK } from '../src/keyboard';

const RETRO_DEVICE_KEYBOARD = 3;
const RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY = 9;
const RETRO_ENVIRONMENT_SET_PIXEL_FORMAT = 10;
const RETRO_ENVIRONMENT_GET_VARIABLE = 15;
const RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE = 17;
const RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME = 18;
const RETRO_ENVIRONMENT_GET_LOG_INTERFACE = 27;
const RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY = 31;
const RETRO_PIXEL_FORMAT_RGB565 = 2;
const KEYBUF_MASK = 127;

interface CoreModule {
  FS: {
    mkdir(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
  };
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  addFunction(fn: (...args: number[]) => number | void, signature: string): number;
  _malloc(size: number): number;
  stringToUTF8(value: string, ptr: number, maxBytes: number): number;
  lengthBytesUTF8(value: string): number;
  _retro_set_environment(callback: number): void;
  _retro_set_video_refresh(callback: number): void;
  _retro_set_audio_sample(callback: number): void;
  _retro_set_audio_sample_batch(callback: number): void;
  _retro_set_input_poll(callback: number): void;
  _retro_set_input_state(callback: number): void;
  _retro_init(): void;
  _retro_load_game(gameInfo: number): number;
  _retro_run(): void;
  _get_retro_log_shim(): number;
  _webx68k_keybuf_peek?(index: number): number;
  _webx68k_keybuf_write_pointer?(): number;
}

type CoreFactory = (options?: Record<string, unknown>) => Promise<CoreModule>;

interface KeyCase {
  name: string;
  retrok: number;
  scanCode: number;
}

const KEY_CASES: KeyCase[] = [
  { name: 'XF1', retrok: RETROK.EURO, scanCode: 0x55 },
  { name: 'XF2', retrok: RETROK.UNDO, scanCode: 0x56 },
  { name: 'XF3', retrok: RETROK.OEM_102, scanCode: 0x57 },
  { name: 'XF4', retrok: RETROK.BROWSER_BACK, scanCode: 0x58 },
  { name: 'XF5', retrok: RETROK.BROWSER_FORWARD, scanCode: 0x59 },
  { name: 'かな', retrok: RETROK.BROWSER_REFRESH, scanCode: 0x5a },
  { name: 'ローマ字', retrok: RETROK.BROWSER_STOP, scanCode: 0x5b },
  { name: 'コード入力', retrok: RETROK.BROWSER_SEARCH, scanCode: 0x5c },
  { name: 'ひらがな', retrok: RETROK.BROWSER_FAVORITES, scanCode: 0x5f },
  { name: '全角', retrok: RETROK.BROWSER_HOME, scanCode: 0x60 },
  { name: 'COPY', retrok: RETROK.VOLUME_MUTE, scanCode: 0x62 },
  { name: 'A', retrok: RETROK.a, scanCode: 0x1e },
  { name: 'F1', retrok: RETROK.F1, scanCode: 0x63 },
  { name: '左カーソル', retrok: RETROK.LEFT, scanCode: 0x3b },
];

function loadCoreFactory(): CoreFactory {
  const jsPath = fileURLToPath(new URL('../public/core/px68k_libretro.js', import.meta.url));
  const source = readFileSync(jsPath, 'utf8');
  const commonJsModule: { exports: CoreFactory | { default: CoreFactory } | Record<string, never> } = {
    exports: {},
  };
  // 本体と同様、Emscripten glue と WebAssembly を同じ Realm で動かす。
  // 別 Realm へ載せると Table.set() が外側 Realm の TypeError を投げるため、glue 内の
  // `err instanceof TypeError` が成立せず、addFunction の wasm 関数変換へ進めない。
  const commonJsWrapper = runInThisContext(
    `(function (module, exports, require, __filename, __dirname) { ${source}\n})`,
    { filename: jsPath },
  ) as (
    module: typeof commonJsModule,
    exports: typeof commonJsModule.exports,
    require: NodeRequire,
    filename: string,
    directory: string,
  ) => void;
  commonJsWrapper(
    commonJsModule,
    commonJsModule.exports,
    createRequire(jsPath),
    jsPath,
    dirname(jsPath),
  );

  const exported = commonJsModule.exports;
  const factory = typeof exported === 'function' ? exported : exported.default;
  if (typeof factory !== 'function') throw new Error('PX68K factory を Node 上でロードできません');
  return factory;
}

function mkdirSafe(mod: CoreModule, path: string): void {
  try {
    mod.FS.mkdir(path);
  } catch {
    // Emscripten FS 上に既に存在する場合は無視する。
  }
}

function mallocString(mod: CoreModule, value: string): number {
  const length = mod.lengthBytesUTF8(value) + 1;
  const ptr = mod._malloc(length);
  mod.stringToUTF8(value, ptr, length);
  return ptr;
}

async function initializeCore(): Promise<{ mod: CoreModule; setPressedKey(retrok: number | null): void }> {
  const mod = await loadCoreFactory()({});
  if (!mod._webx68k_keybuf_peek || !mod._webx68k_keybuf_write_pointer) {
    throw new Error(
      'KeyBuf 観測用 export が wasm にありません。scripts/build-core.sh でコアを再ビルドしてください',
    );
  }

  mkdirSafe(mod, '/system');
  mkdirSafe(mod, '/system/keropi');
  mkdirSafe(mod, '/save');
  // キー入力経路のみを駆動するため、最小のダミー ROM でディスク無し起動する。
  mod.FS.writeFile('/system/keropi/iplrom.dat', new Uint8Array(0x20000));
  mod.FS.writeFile('/system/keropi/cgrom.dat', new Uint8Array(0xc0000));

  const systemDirPtr = mallocString(mod, '/system');
  const saveDirPtr = mallocString(mod, '/save');
  let pressedKey: number | null = null;

  const environment = (command: number, data: number): number => {
    switch (command) {
      case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
        mod.HEAP32[data >> 2] = systemDirPtr;
        return 1;
      case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
        mod.HEAP32[data >> 2] = saveDirPtr;
        return 1;
      case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
        return mod.HEAP32[data >> 2] === RETRO_PIXEL_FORMAT_RGB565 ? 1 : 0;
      case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
        mod.HEAP32[data >> 2] = mod._get_retro_log_shim();
        return 1;
      case RETRO_ENVIRONMENT_GET_VARIABLE:
      case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
        return 0;
      case RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME:
        return 1;
      default:
        return 0;
    }
  };
  const inputState = (_port: number, device: number, _index: number, id: number): number =>
    device === RETRO_DEVICE_KEYBOARD && id === pressedKey ? 1 : 0;

  mod._retro_set_environment(mod.addFunction(environment, 'iii'));
  mod._retro_set_video_refresh(mod.addFunction(() => {}, 'viiii'));
  mod._retro_set_audio_sample(mod.addFunction(() => {}, 'vii'));
  mod._retro_set_audio_sample_batch(mod.addFunction((_data, frames) => frames, 'iii'));
  mod._retro_set_input_poll(mod.addFunction(() => {}, 'v'));
  mod._retro_set_input_state(mod.addFunction(inputState, 'iiiii'));
  mod._retro_init();

  expect(mod._retro_load_game(0)).toBe(1);
  mod._retro_run(); // firstcall: ROM 読み込みとコア初期化

  return { mod, setPressedKey: (retrok) => { pressedKey = retrok; } };
}

describe('px68k-libretro キーボード結合', () => {
  it('make/break を KeyBuf で実測できる', async () => {
    const { mod, setPressedKey } = await initializeCore();
    const peek = mod._webx68k_keybuf_peek!;
    const writePointer = mod._webx68k_keybuf_write_pointer!;

    for (const { name, retrok, scanCode } of KEY_CASES) {
      const start = writePointer();

      setPressedKey(retrok);
      mod._retro_run();
      expect(peek(start), `${name} make code`).toBe(scanCode);
      expect(writePointer(), `${name} make 後の書き込みポインタ`).toBe((start + 1) & KEYBUF_MASK);

      setPressedKey(null);
      mod._retro_run();
      expect(peek(start + 1), `${name} break code`).toBe(scanCode | 0x80);
      expect(writePointer(), `${name} break 後の書き込みポインタ`).toBe((start + 2) & KEYBUF_MASK);
    }
  });
});
