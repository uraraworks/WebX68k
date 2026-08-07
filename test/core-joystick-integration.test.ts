import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const RETRO_DEVICE_JOYPAD = 1;
const RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY = 9;
const RETRO_ENVIRONMENT_SET_PIXEL_FORMAT = 10;
const RETRO_ENVIRONMENT_GET_VARIABLE = 15;
const RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE = 17;
const RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME = 18;
const RETRO_ENVIRONMENT_GET_LOG_INTERFACE = 27;
const RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY = 31;
const RETRO_PIXEL_FORMAT_RGB565 = 2;

// retro_device_id_joypad (libretro.h)
const RETRO_DEVICE_ID_JOYPAD_B = 0;
const RETRO_DEVICE_ID_JOYPAD_UP = 4;

// x68k/libretro/joystick.h の負論理ビット。押下で 0。
const JOY_UP = 0x01;
const JOY_TRG1 = 0x40; // B ボタン(VbtnSwap=false) → Trigger1

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
  UTF8ToString(ptr: number): string;
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
  _webx68k_joystick_read?(port: number): number;
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

async function initializeCore(): Promise<{
  mod: CoreModule;
  setJoyBits(port: number, bits: number): void;
}> {
  const mod = await loadCoreFactory()({});
  if (!mod._webx68k_joystick_read) {
    throw new Error(
      'ジョイスティック観測用 export が wasm にありません。scripts/build-core.sh でコアを再ビルドしてください',
    );
  }

  mkdirSafe(mod, '/system');
  mkdirSafe(mod, '/system/keropi');
  mkdirSafe(mod, '/save');
  // ジョイスティック入力経路のみを駆動するため、最小のダミー ROM でディスク無し起動する。
  mod.FS.writeFile('/system/keropi/iplrom.dat', new Uint8Array(0x20000));
  mod.FS.writeFile('/system/keropi/cgrom.dat', new Uint8Array(0xc0000));

  const systemDirPtr = mallocString(mod, '/system');
  const saveDirPtr = mallocString(mod, '/save');
  // px68k-libretro の Joystick_Update() / WinX68k_Exec() は
  // libretro.c の retro_run() 内で Timer_GetCount() (実時間ベースの 55.6fps ペーシング)
  // が真を返したフレームでしか呼ばれない(libretro/timer.c)。Node でループ実行すると
  // ほぼ毎フレーム実時間が経過せず false のままになり、ジョイスティック状態がいつまでも
  // 更新されない(観測済み)。コアオプション px68k_no_wait_mode を "enabled" にして
  // Config.NoWaitMode を立て、このペーシングを無効化することで結合テストを決定的にする。
  const noWaitModeValuePtr = mallocString(mod, 'enabled');
  // libretro-host.ts の joyState と同じ流儀: port ごとのビットマスクを保持し、
  // input_state_cb では (bits >> id) & 1 を返す。
  const joyState: [number, number] = [0, 0];

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
      case RETRO_ENVIRONMENT_GET_VARIABLE: {
        const keyPtr = mod.HEAP32[data >> 2];
        if (!keyPtr) return 0;
        const key = mod.UTF8ToString(keyPtr);
        if (key === 'px68k_no_wait_mode') {
          mod.HEAP32[(data + 4) >> 2] = noWaitModeValuePtr;
          return 1;
        }
        return 0;
      }
      case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
        return 0;
      case RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME:
        return 1;
      default:
        return 0;
    }
  };
  const inputState = (port: number, device: number, _index: number, id: number): number => {
    if (device !== RETRO_DEVICE_JOYPAD) return 0;
    if (port !== 0 && port !== 1) return 0;
    return (joyState[port] >> id) & 1;
  };

  mod._retro_set_environment(mod.addFunction(environment, 'iii'));
  mod._retro_set_video_refresh(mod.addFunction(() => {}, 'viiii'));
  mod._retro_set_audio_sample(mod.addFunction(() => {}, 'vii'));
  mod._retro_set_audio_sample_batch(mod.addFunction((_data, frames) => frames, 'iii'));
  mod._retro_set_input_poll(mod.addFunction(() => {}, 'v'));
  mod._retro_set_input_state(mod.addFunction(inputState, 'iiiii'));
  mod._retro_init();

  expect(mod._retro_load_game(0)).toBe(1);
  mod._retro_run(); // firstcall: ROM 読み込みとコア初期化

  return {
    mod,
    setJoyBits: (port, bits) => {
      joyState[port] = bits;
    },
  };
}

describe('px68k-libretro ジョイスティック結合', () => {
  it('port0: UP+B(Trigger1)相当のビットが JoyState に負論理で現れる', async () => {
    const { mod, setJoyBits } = await initializeCore();
    const read = mod._webx68k_joystick_read!;

    // 押していない状態ではすべて未押下(全ビット1)
    for (let i = 0; i < 3; i++) mod._retro_run();
    expect(read(0) & JOY_UP, 'UP 未押下 (port0)').toBe(JOY_UP);
    expect(read(0) & JOY_TRG1, 'TRG1 未押下 (port0)').toBe(JOY_TRG1);

    setJoyBits(0, (1 << RETRO_DEVICE_ID_JOYPAD_UP) | (1 << RETRO_DEVICE_ID_JOYPAD_B));
    for (let i = 0; i < 3; i++) mod._retro_run();

    const value0 = read(0);
    expect(value0 & JOY_UP, 'UP 押下で bit0 が 0 になる (port0)').toBe(0);
    expect(value0 & JOY_TRG1, 'B(Trigger1) 押下で bit6 が 0 になる (port0)').toBe(0);
    // 押していない port1 は無関係のはず(独立配線の確認)
    expect(read(1) & JOY_UP, 'port0 を押しても port1 は無関係のはず').toBe(JOY_UP);
  });

  it('port1: UP+B(Trigger1)相当のビットが JoyState に負論理で現れる', async () => {
    const { mod, setJoyBits } = await initializeCore();
    const read = mod._webx68k_joystick_read!;

    for (let i = 0; i < 3; i++) mod._retro_run();
    expect(read(1) & JOY_UP, 'UP 未押下 (port1)').toBe(JOY_UP);
    expect(read(1) & JOY_TRG1, 'TRG1 未押下 (port1)').toBe(JOY_TRG1);

    setJoyBits(1, (1 << RETRO_DEVICE_ID_JOYPAD_UP) | (1 << RETRO_DEVICE_ID_JOYPAD_B));
    for (let i = 0; i < 3; i++) mod._retro_run();

    const value1 = read(1);
    expect(value1 & JOY_UP, 'UP 押下で bit0 が 0 になる (port1)').toBe(0);
    expect(value1 & JOY_TRG1, 'B(Trigger1) 押下で bit6 が 0 になる (port1)').toBe(0);
    // 押していない port0 は無関係のはず(独立配線の確認)
    expect(read(0) & JOY_UP, 'port1 を押しても port0 は無関係のはず').toBe(JOY_UP);
  });
});
