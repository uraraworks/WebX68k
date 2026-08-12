import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { RETROK, RETROK_TO_SCANCODE } from '../src/keyboard';

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
  // 実際の入力経路を検証するため、アプリ本体と同じ実ROMでディスク無し起動する。
  const iplrom = readFileSync(fileURLToPath(new URL('../public/system/iplrom.dat', import.meta.url)));
  const cgrom = readFileSync(fileURLToPath(new URL('../public/system/cgrom.dat', import.meta.url)));
  mod.FS.writeFile('/system/keropi/iplrom.dat', iplrom);
  mod.FS.writeFile('/system/keropi/cgrom.dat', cgrom);

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
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    mod._retro_run();
  }

  return { mod, setPressedKey: (retrok) => { pressedKey = retrok; } };
}

describe('px68k-libretro キーボード結合', () => {
  it('RETROK_TO_SCANCODEの全エントリがコア自身の変換結果と一致する', async () => {
    const entries = Object.entries(RETROK_TO_SCANCODE);
    // 起動直後のゲストはKeyBufを消費しないため、全件を1台へ積むと128バイトのリングが
    // 飽和する。50キー(最大102バイト)ごとに実ROMコアを新規起動し、観測落ちを防ぐ。
    for (let chunkStart = 0; chunkStart < entries.length; chunkStart += 50) {
      const { mod, setPressedKey } = await initializeCore();
      const peek = mod._webx68k_keybuf_peek!;
      const writePointer = mod._webx68k_keybuf_write_pointer!;

      for (const [retrokText, scanCode] of entries.slice(chunkStart, chunkStart + 50)) {
        const retrok = Number(retrokText);
        const name = Object.entries(RETROK).find(([, value]) => value === retrok)?.[0] ?? retrokText;
        const start = writePointer();

        setPressedKey(retrok);
        mod._retro_run();
        expect(peek(start), `${name} make code`).toBe(scanCode);
        const expectedMakeWrites = retrok === RETROK[0] ? 2 : 1;
        expect(writePointer(), `${name} make 後の書き込みポインタ`).toBe(
          (start + expectedMakeWrites) & KEYBUF_MASK,
        );
        if (retrok === RETROK[0]) {
          // コアのKeyTableにはRETROK_0が0x0bと0x34で重複している。対応表は先頭の通常数字を採る。
          expect(peek(start + 1), `${name} 重複定義側のmake code`).toBe(0x34);
        }

        setPressedKey(null);
        mod._retro_run();
        expect(peek(start + expectedMakeWrites), `${name} break code`).toBe(scanCode | 0x80);
        expect(writePointer(), `${name} break 後の書き込みポインタ`).toBe(
          (start + expectedMakeWrites * 2) & KEYBUF_MASK,
        );
      }
    }
  }, 30_000);
});
