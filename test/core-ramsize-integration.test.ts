// マシン構成の RAM 設定(px68k_ramsize コアオプション)が、実際にゲストのマシン構造まで
// 反映されることを実測する結合テスト。
//
// px68k-libretro の update_variables() はコアオプション px68k_ramsize から Config.ram_size を
// 決め、WinX68k_Exec()(retro_run から毎フレーム呼ばれる)が
//   if (!(cpu_readmem24_dword(0xed0008) == Config.ram_size))
//     cpu_writemem24_dword(0xed0008, Config.ram_size);
// という形で SRAM の 0xed0008 に書き込む。ここは X68000 の IPL/Human68k が搭載メモリ量を
// 読み取る場所そのもの。「設定値をホストがコアへ渡せたか」ではなく「値がマシンの構造
// (SRAM)まで届いたか」を検証するため、core-shim.c の webx68k_configured_ram_size() を
// 経由して、コアが書き込みに使ったのと同じ経路(cpu_readmem24_dword)で読み戻す。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY = 9;
const RETRO_ENVIRONMENT_SET_PIXEL_FORMAT = 10;
const RETRO_ENVIRONMENT_GET_VARIABLE = 15;
const RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE = 17;
const RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME = 18;
const RETRO_ENVIRONMENT_GET_LOG_INTERFACE = 27;
const RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY = 31;
const RETRO_PIXEL_FORMAT_RGB565 = 2;

interface CoreModule {
  FS: {
    mkdir(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
  };
  HEAP32: Int32Array;
  addFunction(fn: (...args: number[]) => number | void, signature: string): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
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
  _webx68k_configured_ram_size?(): number;
}

type CoreFactory = (options?: Record<string, unknown>) => Promise<CoreModule>;

function loadCoreFactory(): CoreFactory {
  const jsPath = fileURLToPath(new URL('../public/core/px68k_libretro.js', import.meta.url));
  const source = readFileSync(jsPath, 'utf8');
  const commonJsModule: { exports: CoreFactory | { default: CoreFactory } | Record<string, never> } = {
    exports: {},
  };
  // core-keyboard-integration.test.ts と同じ理由で、glue と wasm を同じ Realm に載せる。
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
  commonJsWrapper(commonJsModule, commonJsModule.exports, createRequire(jsPath), jsPath, dirname(jsPath));
  const exported = commonJsModule.exports;
  const factory = typeof exported === 'function' ? exported : exported.default;
  if (typeof factory !== 'function') throw new Error('PX68K factory を Node 上でロードできません');
  return factory;
}

function mkdirSafe(mod: CoreModule, path: string): void {
  try {
    mod.FS.mkdir(path);
  } catch {
    // 既存なら無視
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mallocString(mod: CoreModule, value: string): number {
  const length = mod.lengthBytesUTF8(value) + 1;
  const ptr = mod._malloc(length);
  mod.stringToUTF8(value, ptr, length);
  return ptr;
}

/**
 * ダミー ROM でディスク無し起動し、px68k_ramsize コアオプションに ramSizeLabel
 * (例: "2MB", "12MB")を固定で返す環境コールバックを実装したコアインスタンスを作る。
 * update_variables() は retro_load_game 直後の update_variables(0) で一度だけ
 * px68k_ramsize を読むため、GET_VARIABLE_UPDATE は常に「更新なし」を返す。
 */
async function initializeCoreWithRamSize(ramSizeLabel: string): Promise<CoreModule> {
  const mod = await loadCoreFactory()({});
  if (!mod._webx68k_configured_ram_size) {
    throw new Error(
      'webx68k_configured_ram_size export が wasm にありません。scripts/build-core.sh でコアを再ビルドしてください',
    );
  }

  mkdirSafe(mod, '/system');
  mkdirSafe(mod, '/system/keropi');
  mkdirSafe(mod, '/save');
  // RAM 設定の反映経路のみを駆動するため、最小のダミー ROM でディスク無し起動する。
  mod.FS.writeFile('/system/keropi/iplrom.dat', new Uint8Array(0x20000));
  mod.FS.writeFile('/system/keropi/cgrom.dat', new Uint8Array(0xc0000));

  const systemDirPtr = mallocString(mod, '/system');
  const saveDirPtr = mallocString(mod, '/save');
  const ramSizeValuePtr = mallocString(mod, ramSizeLabel);

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
        // struct retro_variable { const char *key; const char *value; } の先頭 4 バイトが key。
        const keyPtr = mod.HEAP32[data >> 2];
        const key = mod.UTF8ToString(keyPtr);
        if (key === 'px68k_ramsize') {
          mod.HEAP32[(data + 4) >> 2] = ramSizeValuePtr;
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

  mod._retro_set_environment(mod.addFunction(environment, 'iii'));
  mod._retro_set_video_refresh(mod.addFunction(() => {}, 'viiii'));
  mod._retro_set_audio_sample(mod.addFunction(() => {}, 'vii'));
  mod._retro_set_audio_sample_batch(mod.addFunction((_data, frames) => frames, 'iii'));
  mod._retro_set_input_poll(mod.addFunction(() => {}, 'v'));
  mod._retro_set_input_state(mod.addFunction(() => 0, 'iiiii'));
  mod._retro_init();

  expect(mod._retro_load_game(0)).toBe(1);
  mod._retro_run(); // firstcall: ROM 読み込みとコア初期化(ここで update_variables(0) が走る)

  // WinX68k_Exec() は「menu_out かつ AudioDesyncHack/NoWaitMode/Timer_GetCount() のいずれか」
  // が真のときだけ実行される。Timer_GetCount() は libretro/timer.c の実壁時計ベースの
  // フレームタイマーで、TIMEBASE(約16.7ms 相当)を超えて初めて 1 を返す。
  // SET_FRAME_TIME_CALLBACK は本テストの環境コールバックでは未実装(既定 0 扱い)なので
  // total_usec は使われず timeGetTime() の壁時計にフォールバックする。
  // retro_run を連続で叩くだけだと実行が速すぎて壁時計がほぼ進まず、閾値を超えないことが
  // あるため、実際に待って壁時計を進めてから改めて retro_run を呼ぶ。
  for (let i = 0; i < 5; i++) {
    await sleep(20);
    mod._retro_run();
  }

  return mod;
}

describe('マシン構成の RAM 設定とゲスト構造(SRAM)の一致', () => {
  it('px68k_ramsize=2MB を指定すると SRAM の 0xed0008 が 2MB になる', async () => {
    const mod = await initializeCoreWithRamSize('2MB');
    expect(mod._webx68k_configured_ram_size!()).toBe(2 * 1024 * 1024);
  });

  it('px68k_ramsize=12MB を指定すると SRAM の 0xed0008 が 12MB になる', async () => {
    const mod = await initializeCoreWithRamSize('12MB');
    expect(mod._webx68k_configured_ram_size!()).toBe(12 * 1024 * 1024);
  });

  it('再起動(コア作り直し)を模擬しても新しい設定が反映される', async () => {
    // main.ts の restartCore() は「コアインスタンスを作り直す」ことでマシン構成の
    // 変更を反映する。同一プロセス内で 2MB → 12MB と作り直したとき、古いインスタンスの
    // 値を引きずらず新しい設定が届くことをコアのレベルで裏取りする。
    const first = await initializeCoreWithRamSize('2MB');
    expect(first._webx68k_configured_ram_size!()).toBe(2 * 1024 * 1024);

    const second = await initializeCoreWithRamSize('12MB');
    expect(second._webx68k_configured_ram_size!()).toBe(12 * 1024 * 1024);
    // 古いインスタンス側は 2MB のまま(取り違えていないことの確認)。
    expect(first._webx68k_configured_ram_size!()).toBe(2 * 1024 * 1024);
  });
});
