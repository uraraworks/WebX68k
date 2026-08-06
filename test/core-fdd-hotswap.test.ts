// FDD ホットマウント時のイメージ書き戻し順序を実測する結合テスト。
//
// px68k の XDF_Eject() は「メモリ上のイメージを無条件にファイルへ書き戻す」実装なので、
// ファイルマネージャで編集したバイト列を先に FS へ書いてから FDD_SetFD() を呼ぶと、
// SetFD 内部の Eject が古い内容で同じファイルを上書きしてしまい、転送結果が消える。
// ここでは「先に Eject → ファイル更新 → Insert」の順序でなければ反映されないことを、
// 実際の wasm コアを回して確認する。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createFormattedFd, fatList, fatMakeDir, fatWriteFile, openDiskImage } from '../src/api/fat';

const RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY = 9;
const RETRO_ENVIRONMENT_SET_PIXEL_FORMAT = 10;
const RETRO_ENVIRONMENT_GET_VARIABLE = 15;
const RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE = 17;
const RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME = 18;
const RETRO_ENVIRONMENT_GET_LOG_INTERFACE = 27;
const RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY = 31;
const RETRO_PIXEL_FORMAT_RGB565 = 2;

/** px68k の XDF ハンドラが読み書きする固定サイズ(2HD 1.23MB)。 */
const XDF_SIZE = 1261568;
const FDD_PATH = '/game/hotswap.xdf';

interface CoreModule {
  FS: {
    mkdir(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
  };
  HEAP32: Int32Array;
  addFunction(fn: (...args: number[]) => number | void, signature: string): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
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
  _webx68k_fdd_insert(drive: number, pathPtr: number): void;
  _webx68k_fdd_eject(drive: number): void;
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

function mallocString(mod: CoreModule, value: string): number {
  const length = mod.lengthBytesUTF8(value) + 1;
  const ptr = mod._malloc(length);
  mod.stringToUTF8(value, ptr, length);
  return ptr;
}

async function initializeCore(): Promise<CoreModule> {
  const mod = await loadCoreFactory()({});
  mkdirSafe(mod, '/system');
  mkdirSafe(mod, '/system/keropi');
  mkdirSafe(mod, '/save');
  mkdirSafe(mod, '/game');
  mod.FS.writeFile('/system/keropi/iplrom.dat', new Uint8Array(0x20000));
  mod.FS.writeFile('/system/keropi/cgrom.dat', new Uint8Array(0xc0000));

  const systemDirPtr = mallocString(mod, '/system');
  const saveDirPtr = mallocString(mod, '/save');
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
  mod._retro_set_environment(mod.addFunction(environment, 'iii'));
  mod._retro_set_video_refresh(mod.addFunction(() => {}, 'viiii'));
  mod._retro_set_audio_sample(mod.addFunction(() => {}, 'vii'));
  mod._retro_set_audio_sample_batch(mod.addFunction((_data, frames) => frames, 'iii'));
  mod._retro_set_input_poll(mod.addFunction(() => {}, 'v'));
  mod._retro_set_input_state(mod.addFunction(() => 0, 'iiiii'));
  mod._retro_init();
  expect(mod._retro_load_game(0)).toBe(1);
  mod._retro_run();
  return mod;
}

function makeImage(marker: string): Uint8Array {
  const image = new Uint8Array(XDF_SIZE);
  image.set(new TextEncoder().encode(marker), 0);
  return image;
}

function readMarker(mod: CoreModule, length: number): string {
  return new TextDecoder().decode(mod.FS.readFile(FDD_PATH).subarray(0, length));
}

function insert(mod: CoreModule, drive: number, path: string): void {
  const ptr = mallocString(mod, path);
  try {
    mod._webx68k_fdd_insert(drive, ptr);
  } finally {
    mod._free(ptr);
  }
}

describe('FDD ホットマウントとイメージ書き戻し', () => {
  it('Eject 前にファイルを書き換えると SetFD 内の書き戻しで消える(旧実装の再現)', async () => {
    const mod = await initializeCore();
    mod.FS.writeFile(FDD_PATH, makeImage('ORIGINAL'));
    insert(mod, 0, FDD_PATH);

    // ファイルマネージャの編集結果を先にファイルへ書いてから、同じパスで再マウントする。
    mod.FS.writeFile(FDD_PATH, makeImage('MODIFIED'));
    insert(mod, 0, FDD_PATH);

    // SetFD → EjectFD → XDF_Eject が「マウント時のメモリ内容」で上書きしてしまう。
    expect(readMarker(mod, 8)).toBe('ORIGINAL');
  });

  it('Eject してからファイルを書き換えて Insert すれば反映される(修正後の順序)', async () => {
    const mod = await initializeCore();
    mod.FS.writeFile(FDD_PATH, makeImage('ORIGINAL'));
    insert(mod, 0, FDD_PATH);

    mod._webx68k_fdd_eject(0);
    mod.FS.writeFile(FDD_PATH, makeImage('MODIFIED'));
    insert(mod, 0, FDD_PATH);

    expect(readMarker(mod, 8)).toBe('MODIFIED');
  });

  it('マウント中のFDへ mkdir/転送した内容が、コア側の書き戻し後も残る', async () => {
    const mod = await initializeCore();
    mod.FS.writeFile(FDD_PATH, createFormattedFd());
    insert(mod, 0, FDD_PATH);

    // main.ts の readLiveSlotImage(): 一度 Eject してコアのメモリ内容をファイルへ吐かせ、
    // 読み出したうえで同じファイルを入れ直す。
    mod._webx68k_fdd_eject(0);
    const image = mod.FS.readFile(FDD_PATH);
    insert(mod, 0, FDD_PATH);

    // ファイルマネージャの編集(mkdir + ファイル転送)。
    const vol = openDiskImage(image, 'transfer.xdf');
    fatMakeDir(vol, 'TOOLS');
    fatWriteFile(vol, 'TOOLS/HELLO.TXT', new TextEncoder().encode('HELLO X68000'));

    // main.ts の hotSwapFdd(): Eject → ファイル更新 → Insert。
    mod._webx68k_fdd_eject(0);
    mod.FS.writeFile(FDD_PATH, image);
    insert(mod, 0, FDD_PATH);

    // 次回のリスト表示と同じ手順で読み直すと、編集内容が残っている。
    mod._webx68k_fdd_eject(0);
    const reloaded = openDiskImage(mod.FS.readFile(FDD_PATH), 'transfer.xdf');
    insert(mod, 0, FDD_PATH);
    expect(fatList(reloaded, '').map((e) => e.name)).toContain('TOOLS');
    expect(fatList(reloaded, 'TOOLS').map((e) => e.name)).toContain('HELLO.TXT');
  });
});
