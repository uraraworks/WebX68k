import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { RETROK, RETROK_TO_SCANCODE, charToKey } from '../src/keyboard';
import { typeTextSequence } from '../src/type-text';
import { SharedKeyInput } from '../src/virtual-keyboard';

// type_text の化け(シフトの有無が入れ替わる)を、実ROMで起動したpx68k-libretroの
// KeyBufまで通して検証する。土台はtest/core-key-repeat-integration.test.tsと同じ
// (実ROM起動・retro_run駆動・KeyBuf直読み)。

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
const SHIFT_SCANCODE = 0x70;

interface CoreModule {
  FS: {
    mkdir(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
  };
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
  // core-key-repeat-integration.test.tsと同じ理由(Table.set()のReam跨ぎエラー回避)で
  // 同一Realm上でglueとwasmを動かす。
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

/** 実ROM(ディスク無し)でコアを起動する。KeyBufはこの時点から書き込まれる。 */
async function initializeCoreWithRealRom(): Promise<{ mod: CoreModule; pressedKeys: Set<number> }> {
  const mod = await loadCoreFactory()({});
  if (!mod._webx68k_keybuf_peek || !mod._webx68k_keybuf_write_pointer) {
    throw new Error(
      'type_text結合テスト用exportがwasmにありません。scripts/build-core.shでコアを再ビルドしてください',
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
  mod._retro_run();

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

/**
 * scancode -> { plain, shifted } の逆引き表。src/keyboard.tsのcharToKey/RETROK_TO_SCANCODEを
 * ASCII全域(0..127)について総当りすることで作る(手作業の対応表を別途持つと二重管理になり
 * ずれる恐れがあるため)。
 */
function buildScancodeToChar(): Map<number, { plain?: string; shifted?: string }> {
  const map = new Map<number, { plain?: string; shifted?: string }>();
  for (let code = 0; code < 128; code++) {
    const ch = String.fromCharCode(code);
    const key = charToKey(ch);
    if (!key) continue;
    const scancode = RETROK_TO_SCANCODE[key.code];
    if (scancode === undefined) continue;
    const entry = map.get(scancode) ?? {};
    if (key.shift) entry.shifted = ch;
    else entry.plain = ch;
    map.set(scancode, entry);
  }
  return map;
}

const SCANCODE_TO_CHAR = buildScancodeToChar();

/**
 * KeyBufに積まれたmake/breakのスキャンコード列を、IOCS相当のASCII解釈で文字列へ戻す。
 * shift状態はSHIFT(0x70)のmake/breakをバッファに現れた順に見ながら追跡するので、
 * 「SHIFTのbreakより先に次のキーのmakeが積まれてしまう」化けがあれば、そのまま
 * 誤ったshift状態で解釈され、期待した文字と食い違う形でここに現れる。
 */
function decodeKeyBufToText(codes: number[]): string {
  let shiftDown = false;
  let out = '';
  for (const code of codes) {
    const isBreak = (code & 0x80) !== 0;
    const scan = code & 0x7f;
    if (scan === SHIFT_SCANCODE) {
      shiftDown = !isBreak;
      continue;
    }
    if (isBreak) continue; // breakは文字を生まない
    const entry = SCANCODE_TO_CHAR.get(scan);
    if (!entry) continue;
    const ch = shiftDown ? (entry.shifted ?? entry.plain) : (entry.plain ?? entry.shifted);
    if (ch !== undefined) out += ch;
  }
  return out;
}

describe('type_text の化け対策(実ROM結合テスト)', () => {
  it(
    '直した後: typeTextSequence + waitPolls(retro_runをn回回す)で打つと、KeyBufから復元した文字列が入力と完全一致する',
    async () => {
      const { mod, pressedKeys } = await initializeCoreWithRealRom();
      const writePointer = mod._webx68k_keybuf_write_pointer!;
      const sharedKeyInput = new SharedKeyInput((retrok, down) => {
        if (down) pressedKeys.add(retrok);
        else pressedKeys.delete(retrok);
      });

      // waitPolls(n): retro_runをn回回す。1回のretro_runが「コアが1回ポーリングする」に
      // 対応する(host.onPollと同じ意味。main.tsのwaitCorePollsの既定経路と同一の考え方)。
      const deps = {
        press: (code: number) => sharedKeyInput.press('bridge:type', code),
        release: (code: number) => sharedKeyInput.release('bridge:type', code),
        waitPolls: async (n: number) => {
          for (let i = 0; i < n; i++) mod._retro_run();
        },
      };

      const samples = ['dir c:', 'COPY CONFIG.SYS G.SYS', 'A>B*C'];
      for (const text of samples) {
        const start = writePointer();
        const result = await typeTextSequence(text, deps);
        expect(result, `typeTextSequence("${text}")の結果`).toEqual({ typed: text.length, skipped: [] });
        const codes = readKeyBuffer(mod, start, writePointer());
        const decoded = decodeKeyBufToText(codes);
        expect(decoded, `"${text}" を打鍵した結果、KeyBufから復元した文字列`).toBe(text);
      }
    },
    30_000,
  );

  it(
    '対照(直す前の打ち方): shift+キー同時press・キー+shift同時release・次の文字のpressまで同じポーリングという打ち方だと、化けが実際に起きる',
    async () => {
      const { mod, pressedKeys } = await initializeCoreWithRealRom();
      const writePointer = mod._webx68k_keybuf_write_pointer!;

      // 旧main.tsの実装をそのまま模す: shift+キーを同時にpress、キー+shiftを同時にrelease、
      // 次の文字のpressまで同じポーリング内(=間にretro_runを挟まない)。
      // 「直前にシフトありの文字」の直後に「シフト無しの文字」を置くと、シフトのbreakと
      // 次キーのmakeが同じretro_run呼び出し内に混在し、化けが再現するはず。
      const text = 'dir C:'; // 大文字Cのシフト解除とコロンの押下が同じポーリングに乗る
      const start = writePointer();

      const keys = [...text].map((ch) => {
        const key = charToKey(ch);
        if (!key) throw new Error(`unsupported char in control text: ${ch}`);
        return key;
      });

      // 最初の文字はshift+key同時押下から始め、まず1回retro_runして押下を確定させる
      // (「押した」こと自体は正しく記録させ、問題を「releaseと次のpressの合流」だけに絞る)。
      const first = keys[0];
      if (first.shift) pressedKeys.add(RETROK.LSHIFT);
      pressedKeys.add(first.code);
      mod._retro_run();

      for (let i = 1; i < keys.length; i++) {
        const prev = keys[i - 1];
        const cur = keys[i];
        // 前の文字を離す
        pressedKeys.delete(prev.code);
        if (prev.shift) pressedKeys.delete(RETROK.LSHIFT);
        // retro_runを挟まないまま、次の文字を押す(=同じポーリングに release と press が乗る)
        if (cur.shift) pressedKeys.add(RETROK.LSHIFT);
        pressedKeys.add(cur.code);
        mod._retro_run();
      }
      // 最後の文字を離して締める
      const last = keys[keys.length - 1];
      pressedKeys.delete(last.code);
      if (last.shift) pressedKeys.delete(RETROK.LSHIFT);
      mod._retro_run();

      const codes = readKeyBuffer(mod, start, writePointer());
      const decoded = decodeKeyBufToText(codes);
      expect(decoded, '見立てどおりなら、この打ち方では入力どおりに戻らないはず').not.toBe(text);
    },
    30_000,
  );
});
