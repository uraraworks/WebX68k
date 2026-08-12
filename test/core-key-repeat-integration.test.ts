import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KeyRepeater,
  keyRepeatDelayMsFromSramValue,
  keyRepeatIntervalMsFromSramValue,
} from '../src/key-repeat';
import { RETROK, RETROK_TO_SCANCODE } from '../src/keyboard';
import { SharedKeyInput } from '../src/virtual-keyboard';

// 実機と同じ「押下状態を保ったままmakeだけを繰り返し、解放時だけbreakを送る」経路を、
// 実ROMで起動したpx68k-libretroの末端(KeyBuf)まで通して実測する。

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
const A_SCAN_CODE = 0x1e;

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
  _webx68k_sram_read?(offset: number): number;
  _webx68k_send_key_make?(scancode: number): void;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 実ROM(public/system/iplrom.dat・cgrom.dat。git管理下の実機ROM)でディスク無し起動する。
 * core-ramsize-integration.test.tsと同様、WinX68k_Exec()の実行条件(壁時計ベースの
 * Timer_GetCount())を満たすため実際にsleepしながらretro_runを重ねる必要がある。
 */
async function initializeCoreWithRealRom(): Promise<{ mod: CoreModule; pressedKeys: Set<number> }> {
  const mod = await loadCoreFactory()({});
  if (
    !mod._webx68k_sram_read ||
    !mod._webx68k_keybuf_peek ||
    !mod._webx68k_keybuf_write_pointer ||
    !mod._webx68k_send_key_make
  ) {
    throw new Error(
      'キーリピート結合テスト用exportがwasmにありません。scripts/build-core.shでコアを再ビルドしてください',
    );
  }

  mkdirSafe(mod, '/system');
  mkdirSafe(mod, '/system/keropi');
  mkdirSafe(mod, '/save');
  const iplrom = readFileSync(fileURLToPath(new URL('../public/system/iplrom.dat', import.meta.url)));
  const cgrom = readFileSync(fileURLToPath(new URL('../public/system/cgrom.dat', import.meta.url)));
  mod.FS.writeFile('/system/keropi/iplrom.dat', iplrom);
  mod.FS.writeFile('/system/keropi/cgrom.dat', cgrom);

  const systemDirPtr = mallocString(mod, '/system');
  const saveDirPtr = mallocString(mod, '/save');
  const pressedKeys = new Set<number>();

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
  mod._retro_set_input_state(mod.addFunction(
    (_port, device, _index, id) => device === RETRO_DEVICE_KEYBOARD && pressedKeys.has(id) ? 1 : 0,
    'iiiii',
  ));
  mod._retro_init();

  expect(mod._retro_load_game(0)).toBe(1);
  mod._retro_run(); // firstcall: ROM 読み込みとコア初期化

  // SRAMへのシグネチャ書き込み等、IPLの初期化処理が壁時計ベースで進むまで実際に待つ
  // (core-ramsize-integration.test.tsと同じ理由。Timer_GetCount()が壁時計依存のため)。
  for (let i = 0; i < 10; i++) {
    await sleep(20);
    mod._retro_run();
  }

  return { mod, pressedKeys };
}

function readKeyBuffer(mod: CoreModule, from: number, to: number): number[] {
  const codes: number[] = [];
  for (let i = from; i !== to; i = (i + 1) & KEYBUF_MASK) {
    codes.push(mod._webx68k_keybuf_peek!(i));
  }
  return codes;
}

describe('実ROMでのmakeのみキーリピート結合', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('押しっぱなし中は300ms後から35ms間隔でmakeだけを5回追加し、解放時のbreakは1回だけ', async () => {
    const { mod, pressedKeys } = await initializeCoreWithRealRom();
    const writePointer = mod._webx68k_keybuf_write_pointer!;
    const sharedKeyInput = new SharedKeyInput((retrok, down) => {
      if (down) pressedKeys.add(retrok);
      else pressedKeys.delete(retrok);
    });
    vi.useFakeTimers();
    const repeater = new KeyRepeater(
      (retrok) => mod._webx68k_send_key_make!(RETROK_TO_SCANCODE[retrok]),
      { delayMs: 300, intervalMs: 35 },
    );
    const source = 'physical:KeyA';

    const start = writePointer();
    sharedKeyInput.press(source, RETROK.a);
    repeater.start(source, RETROK.a);
    mod._retro_run(); // 押下エッジによる最初のmake

    // t=300,335,370,405,440msの5回。t=475msの6回目より1ms手前で止める。
    vi.advanceTimersByTime(474);
    const heldEnd = writePointer();
    const heldCodes = readKeyBuffer(mod, start, heldEnd);
    expect(heldCodes.filter((code) => code === A_SCAN_CODE), '押しっぱなし中のmake回数').toHaveLength(6);
    expect(heldCodes.filter((code) => code === (A_SCAN_CODE | 0x80)), '押しっぱなし中のbreak回数').toHaveLength(0);
    expect(heldCodes, '押しっぱなし中に積まれたコード列').toEqual(Array(6).fill(A_SCAN_CODE));

    repeater.stop(source);
    sharedKeyInput.release(source, RETROK.a);
    mod._retro_run();
    const releasedCodes = readKeyBuffer(mod, heldEnd, writePointer());
    expect(releasedCodes.filter((code) => code === (A_SCAN_CODE | 0x80)), '解放時のbreak回数').toHaveLength(1);
    expect(releasedCodes, '解放時に積まれたコード列').toEqual([A_SCAN_CODE | 0x80]);
  }, 30_000);
});

// SRAM先頭8バイトの機種シグネチャ「Ｘ68000W」(libretro-host.tsのSRAM_SIGNATUREと同じ値)。
const SRAM_SIGNATURE = [0x82, 0x77, 0x36, 0x38, 0x30, 0x30, 0x30, 0x57];

describe('実ROM起動後のSRAM読み出し(webx68k_sram_read/キーリピート設定)', () => {
  it(
    '実ROM起動後、SRAM先頭が機種シグネチャ「Ｘ68000W」になり、$ED003A/$ED003Bからキーリピート設定(開始500ms/間隔50ms)を読める。' +
      '値はゲスト上でSWITCH.Xを実際に起動した表示(FIRST_KEY 3=500ms/NEXT_KEY 2=50ms)と一致することを確認済み。' +
      'あわせて$ED0059/$ED005A(以前誤って読んでいた番地)が0/1という別の値であることも固定しておく。' +
      'この2つはたまたま段階値の範囲(0..15)に収まる値だったため、シグネチャ照合・範囲チェックのどちらも' +
      '素通りしてしまい、番地の取り違えを検出できなかった経緯があるため',
    async () => {
      const { mod } = await initializeCoreWithRealRom();
      const sramRead = mod._webx68k_sram_read!;

      const signature = Array.from({ length: SRAM_SIGNATURE.length }, (_, i) => sramRead(i));
      expect(signature, 'SRAM先頭8バイト(機種シグネチャ)').toEqual(SRAM_SIGNATURE);

      const delayN = sramRead(0x3a);
      const intervalN = sramRead(0x3b);
      expect(delayN, 'SRAM $ED003A(キーリピート開始時間の段階値、FIRST_KEY)').toBe(3);
      expect(intervalN, 'SRAM $ED003B(キーリピート間隔の段階値、NEXT_KEY)').toBe(2);

      // readKeyRepeatConfig()相当: 段階値をX68000の式でmsへ変換する。
      // SWITCH.Xの表示(FIRST_KEY 3 → 500ms、NEXT_KEY 2 → 50ms)と一致することを確認済み。
      const delayMs = keyRepeatDelayMsFromSramValue(delayN);
      const intervalMs = keyRepeatIntervalMsFromSramValue(intervalN);
      expect(delayMs, 'キーリピート開始時間[ms]').toBe(500);
      expect(intervalMs, 'キーリピート間隔[ms]').toBe(50);

      // 以前誤って読んでいた $ED0059/$ED005A は、単なる別のSRAMバイトであり
      // 意味を持たない値(0/1)である。ここが「たまたま0..15の範囲に収まる別の値」
      // であることをテストとして固定しておくことで、「範囲チェックだけでは
      // 番地の正しさは保証できない」という事実を残す。
      const wrongOffsetDelayN = sramRead(0x59);
      const wrongOffsetIntervalN = sramRead(0x5a);
      expect(wrongOffsetDelayN, 'SRAM $ED0059(以前誤って読んでいた番地。値そのものに意味は無い)').toBe(0);
      expect(
        wrongOffsetIntervalN,
        'SRAM $ED005A(以前誤って読んでいた番地。値そのものに意味は無い)',
      ).toBe(1);
    },
    30_000,
  );
});
