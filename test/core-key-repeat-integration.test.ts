import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRepeatableKey, KeyRepeater } from '../src/key-repeat';
import { RETROK } from '../src/keyboard';
import { SharedKeyInput } from '../src/virtual-keyboard';

// KeyRepeaterの設計(release後は「次のonPoll」を待ってからpressし直す = フレーム基準の
// break)が正しく、壁時計の短いギャップで戻す旧実装が誤りであることを、実際のコア
// (px68k-libretro)に対して末端(KeyBuf)で実測して証明する結合テスト。
// コアのロード手順・KeyBuf観測用exportの使い方はtest/core-keyboard-integration.test.tsを
// そのまま流用している。

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

async function initializeCore(): Promise<{ mod: CoreModule; pressedKeys: Set<number> }> {
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
  const inputState = (_port: number, device: number, _index: number, id: number): number =>
    device === RETRO_DEVICE_KEYBOARD && pressedKeys.has(id) ? 1 : 0;

  mod._retro_set_environment(mod.addFunction(environment, 'iii'));
  mod._retro_set_video_refresh(mod.addFunction(() => {}, 'viiii'));
  mod._retro_set_audio_sample(mod.addFunction(() => {}, 'vii'));
  mod._retro_set_audio_sample_batch(mod.addFunction((_data, frames) => frames, 'iii'));
  mod._retro_set_input_poll(mod.addFunction(() => {}, 'v'));
  mod._retro_set_input_state(mod.addFunction(inputState, 'iiiii'));
  mod._retro_init();

  expect(mod._retro_load_game(0)).toBe(1);
  mod._retro_run(); // firstcall: ROM 読み込みとコア初期化

  return { mod, pressedKeys };
}

function countMakeCodes(mod: CoreModule, from: number, to: number): number {
  let count = 0;
  for (let i = from; i !== to; i = (i + 1) & KEYBUF_MASK) {
    if (mod._webx68k_keybuf_peek!(i) === A_SCAN_CODE) count++;
  }
  return count;
}

describe('px68k-libretro キーリピート結合(フレーム基準のbreakが必須である根拠)', () => {
  it('押下→retro_run→1フレーム離す→retro_run→再押下→retro_runで、makeコードが2回積まれる', async () => {
    const { mod, pressedKeys } = await initializeCore();
    const writePointer = mod._webx68k_keybuf_write_pointer!;
    const start = writePointer();

    // フレーム1: 押下 → make
    pressedKeys.add(RETROK.a);
    mod._retro_run();

    // フレーム2: release だけ済ませ、丸ごと1フレームretro_runを回して
    // コアに「離された」状態を実際に読ませる(=1フレーム離す)。break が記録される。
    pressedKeys.delete(RETROK.a);
    mod._retro_run();

    // フレーム3: 再押下 → 2回目の make
    pressedKeys.add(RETROK.a);
    mod._retro_run();

    const end = writePointer();
    const makeCount = countMakeCodes(mod, start, end);
    expect(makeCount, 'フレームを跨いで release→press したときの make 回数').toBe(2);
  });

  it('同一フレーム内でrelease/pressを済ませた場合、makeコードは1回しか積まれない', async () => {
    const { mod, pressedKeys } = await initializeCore();
    const writePointer = mod._webx68k_keybuf_write_pointer!;
    const start = writePointer();

    // フレーム1: 押下 → make
    pressedKeys.add(RETROK.a);
    mod._retro_run();

    // フレーム2の retro_run を呼ぶ前に release→press を両方済ませてしまう
    // (壁時計の短いギャップ実装が踏んでいた壊れ方の再現)。
    // コアが読む状態は「変化なし(押されたまま)」のため、break/make とも記録されない。
    pressedKeys.delete(RETROK.a);
    pressedKeys.add(RETROK.a);
    mod._retro_run();

    const end = writePointer();
    const makeCount = countMakeCodes(mod, start, end);
    expect(makeCount, '同一フレーム内でrelease→pressしたときの make 回数').toBe(1);
  });
});

describe('KeyRepeater→SharedKeyInput→コアの配線結合(onPollの実際の呼び順を通す)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const FRAME_MS = 1000 / 60;

  /** LibretroHost.onPollと同じ「input_poll→input_state」の順を崩さないフレームループ。 */
  function makeRunFrame(mod: CoreModule, keyRepeater: KeyRepeater): () => void {
    return () => {
      vi.advanceTimersByTime(FRAME_MS);
      keyRepeater.notifyFramePolled();
      mod._retro_run();
    };
  }

  it('keydown相当の押しっぱなしで、KeyRepeater→SharedKeyInput→コアの配線を通してmakeコードが複数回積まれる', async () => {
    const { mod, pressedKeys } = await initializeCore();
    const writePointer = mod._webx68k_keybuf_write_pointer!;
    // main.tsの `new SharedKeyInput((retrok, down) => host?.setKey(retrok, down))` と
    // 同じ関係になるよう、sinkの出力をコアが読むpressedKeysへ直結する。
    const sharedKeyInput = new SharedKeyInput((retrok, down) => {
      if (down) pressedKeys.add(retrok);
      else pressedKeys.delete(retrok);
    });
    const keyRepeater = new KeyRepeater(sharedKeyInput);
    const runFrame = makeRunFrame(mod, keyRepeater);

    // main.tsのkeydownハンドラ相当: press してから isRepeatableKey ならリピート開始。
    const source = 'physical:KeyA';
    expect(isRepeatableKey(RETROK.a)).toBe(true);
    sharedKeyInput.press(source, RETROK.a);
    keyRepeater.start(source, RETROK.a);

    const start = writePointer();

    // delayMs(500ms)はフレーム間隔1000/60msのちょうど30フレームぶん。よってフレーム30の
    // notifyFramePolled()でrelease後1回目のポーリング(pollsSinceRelease=1、まだpressしない)、
    // フレーム31で2回目のポーリング(pollsSinceRelease=2)に達してpressし直し、make再発。
    // 以降はintervalMs(50ms)=ちょうど3フレームごとにrelease→次フレームでpressを繰り返す
    // ため、makeはフレーム31,35,39,43,47で立つ(初回のフレーム1とあわせて計6回)。
    // 51フレーム目で次の周期に入る前の49フレームで止め、6回ぴったりを確定させる。
    for (let frame = 0; frame < 49; frame++) runFrame();

    const end = writePointer();
    const makeCount = countMakeCodes(mod, start, end);
    expect(makeCount, 'KeyRepeater配線を通した49フレームぶんのmake回数').toBe(6);
  });

  it('isRepeatableKeyがfalseのキー(LSHIFT)は押しっぱなしでもリピートせず、KeyBuf書き込みは最初のmake1回だけ', async () => {
    const { mod, pressedKeys } = await initializeCore();
    const writePointer = mod._webx68k_keybuf_write_pointer!;
    const sharedKeyInput = new SharedKeyInput((retrok, down) => {
      if (down) pressedKeys.add(retrok);
      else pressedKeys.delete(retrok);
    });
    const keyRepeater = new KeyRepeater(sharedKeyInput);
    const runFrame = makeRunFrame(mod, keyRepeater);

    // main.tsのkeydownハンドラと同じく、isRepeatableKeyがfalseならkeyRepeater.start()を
    // そもそも呼ばない。
    const source = 'physical:ShiftLeft';
    expect(isRepeatableKey(RETROK.LSHIFT)).toBe(false);
    sharedKeyInput.press(source, RETROK.LSHIFT);

    const start = writePointer();
    for (let frame = 0; frame < 49; frame++) runFrame();
    const end = writePointer();

    // LSHIFTの状態は一度も変化しないので、KeyBufへの書き込みは最初のmake1回だけのはず。
    const writesCount = (end - start) & KEYBUF_MASK;
    expect(writesCount, 'LSHIFTを押しっぱなしにした49フレームぶんのKeyBuf書き込み回数').toBe(1);
  });
});
