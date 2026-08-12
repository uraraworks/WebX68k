import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  keyRepeatDelayMsFromSramValue,
  keyRepeatIntervalMsFromSramValue,
} from '../src/key-repeat';

// SRAM永続化(src/sram-store.ts + LibretroHost.init()の第3引数/readSram())の設計は
// 「ファイルのバイト順 == _webx68k_sram_read() で読めるゲスト順」という前提に立っている。
// x68k/sram.c を読むと SRAM_Init() がファイル読み込み後に隣接バイトをswapし、SRAM_Read() が
// adr^=1 する。この2つは打ち消し合って file[adr] === SRAM_Read(adr) になる…はずだが、
// これは静的な読解による推論でしかない。本テストは実際のコア(px68k-libretro)に対して
// 「新しいコアインスタンスへ書き換え済みのsram.datを retro_load_game() 前に置いて起動し、
// 末端(_webx68k_sram_read)で書き換えた値が読めるか」を実測して裏取りする。
// コアのロード手順はtest/core-key-repeat-integration.test.tsのinitializeCoreWithRealRom()を
// そのまま流用している(SRAM読み出し経路の結合テストは実ROM起動が必須のため)。

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
  _webx68k_sram_read?(offset: number): number;
}

type CoreFactory = (options?: Record<string, unknown>) => Promise<CoreModule>;

// test/core-key-repeat-integration.test.tsと全く同じロード方式
// (glueとWebAssemblyを同一Realmで動かす必要がある。理由はそちらのコメント参照)。
function loadCoreFactory(): CoreFactory {
  const jsPath = fileURLToPath(new URL('../public/core/px68k_libretro.js', import.meta.url));
  const source = readFileSync(jsPath, 'utf8');
  const commonJsModule: { exports: CoreFactory | { default: CoreFactory } | Record<string, never> } = {
    exports: {},
  };
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
    // 既に存在する場合は無視
  }
}

function mallocString(mod: CoreModule, value: string): number {
  const length = mod.lengthBytesUTF8(value) + 1;
  const ptr = mod._malloc(length);
  mod.stringToUTF8(value, ptr, length);
  return ptr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 実ROM(public/system/iplrom.dat・cgrom.dat)でディスク無し起動する。
 * initialSramが渡されればFS書き込み(/system/keropi/sram.dat)をretro_load_game()より前に行う
 * — これがLibretroHost.init()の第3引数と同じタイミング。
 * SRAM読み出し経路の結合テストには実ROM起動が必須(ダミーROMではSRAMが未初期化のため)。
 * core-key-repeat-integration.test.tsのinitializeCoreWithRealRom()と同じ理由で、
 * WinX68k_Exec()の実行条件(壁時計ベースのTimer_GetCount())を満たすため実際にsleepしながら
 * retro_runを重ねる必要がある。
 */
async function initializeCoreWithRealRom(initialSram?: Uint8Array): Promise<CoreModule> {
  const mod = await loadCoreFactory()({});
  if (!mod._webx68k_sram_read) {
    throw new Error(
      'webx68k_sram_read export が wasm にありません。scripts/build-core.sh でコアを再ビルドしてください',
    );
  }

  mkdirSafe(mod, '/system');
  mkdirSafe(mod, '/system/keropi');
  mkdirSafe(mod, '/save');
  const iplrom = readFileSync(fileURLToPath(new URL('../public/system/iplrom.dat', import.meta.url)));
  const cgrom = readFileSync(fileURLToPath(new URL('../public/system/cgrom.dat', import.meta.url)));
  mod.FS.writeFile('/system/keropi/iplrom.dat', iplrom);
  mod.FS.writeFile('/system/keropi/cgrom.dat', cgrom);
  // SRAM_Init()(x68k/sram.c)はretro_load_game()の中(WinX68k_Init()経由)でsram.datを読むため、
  // ここ(_retro_load_game()より確実に前)で書く。これがLibretroHost.init()の第3引数と同じ順序。
  if (initialSram) {
    mod.FS.writeFile('/system/keropi/sram.dat', initialSram);
  }

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
  mod._retro_run(); // firstcall: ROM 読み込みとコア初期化

  // SRAMへのシグネチャ書き込み等、IPLの初期化処理が壁時計ベースで進むまで実際に待つ。
  for (let i = 0; i < 10; i++) {
    await sleep(20);
    mod._retro_run();
  }

  return mod;
}

// SRAM先頭8バイトの機種シグネチャ「Ｘ68000W」(libretro-host.tsのSRAM_SIGNATUREと同じ値)。
const SRAM_SIGNATURE = [0x82, 0x77, 0x36, 0x38, 0x30, 0x30, 0x30, 0x57];

describe('SRAM永続化の往復(sram.dat書き込み → _webx68k_sram_read読み出し)', () => {
  it(
    '1台目のコアで読んだSRAMのバイト列をoffset 0x3a/0x3bだけ書き換え、' +
      '2台目の新しいコアインスタンスへretro_load_game()前に置いて起動すると、' +
      '書き換えた値がそのまま読める(バイト順が file==ゲスト順であることの実測)',
    async () => {
      // 1台目: 素の起動で「正常なSRAM」のバイト列を作る(0x4000バイト、_webx68k_sram_read経由)。
      const first = await initializeCoreWithRealRom();
      const firstSramRead = first._webx68k_sram_read!;
      const baseline = new Uint8Array(0x4000);
      for (let i = 0; i < 0x4000; i++) baseline[i] = firstSramRead(i);

      // 前提: 1台目の時点でシグネチャと既定のキーリピート値が読めていること
      // (core-key-repeat-integration.test.tsで確認済みの値=開始n:3/間隔n:2と同じはず)。
      const baselineSignature = Array.from({ length: SRAM_SIGNATURE.length }, (_, i) => baseline[i]);
      expect(baselineSignature, '1台目: SRAM先頭8バイト(機種シグネチャ)').toEqual(SRAM_SIGNATURE);

      // offset 0x3a(開始段階値) を 5、0x3b(間隔段階値) を 4 へ書き換えたバイト列を作る。
      // このoffsetは「_webx68k_sram_read/readKeyRepeatConfig()が読む側のオフセット」であり、
      // ファイルのバイト順がそれと同じなのかどうかを本テストで実測する。
      // ここで既定値(3, 2)と必ず異なる値(5, 4)を選んでいるのは重要な設計判断:
      // 既定値のまま書き換えたことにすると、往復後に読めた値が「本当に復元できた」のか
      // 「単に何もしていなくても既定値のまま読めているだけ」なのかをこのテストだけでは
      // 区別できなくなってしまう。既定値と異なる値を使うことで初めて、往復の実装が
      // 実際に機能していることの証拠になる。
      const modified = baseline.slice();
      modified[0x3a] = 5;
      modified[0x3b] = 4;

      // 2台目: 新しいコアインスタンスへ、retro_load_game()より前にmodifiedをsram.datとして置く。
      const second = await initializeCoreWithRealRom(modified);
      const secondSramRead = second._webx68k_sram_read!;

      const restoredSignature = Array.from(
        { length: SRAM_SIGNATURE.length },
        (_, i) => secondSramRead(i),
      );
      expect(restoredSignature, '2台目: SRAM先頭8バイト(機種シグネチャ)が保たれていること').toEqual(
        SRAM_SIGNATURE,
      );

      const restoredDelayN = secondSramRead(0x3a);
      const restoredIntervalN = secondSramRead(0x3b);
      expect(restoredDelayN, '2台目: $ED003A(開始段階値)が書き換えた5のまま読めること').toBe(5);
      expect(restoredIntervalN, '2台目: $ED003B(間隔段階値)が書き換えた4のまま読めること').toBe(4);

      // readKeyRepeatConfig()相当: 開始 700ms(200+100*5) / 間隔 110ms(30+5*4^2)。
      const delayMs = keyRepeatDelayMsFromSramValue(restoredDelayN);
      const intervalMs = keyRepeatIntervalMsFromSramValue(restoredIntervalN);
      expect(delayMs, '開始時間[ms] = 200+100*5').toBe(700);
      expect(intervalMs, '間隔[ms] = 30+5*4^2').toBe(110);
    },
    60_000,
  );
});
