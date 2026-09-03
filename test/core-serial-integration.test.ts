import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { runInThisContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY = 9;
const RETRO_ENVIRONMENT_SET_PIXEL_FORMAT = 10;
const RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME = 18;
const RETRO_ENVIRONMENT_GET_LOG_INTERFACE = 27;
const RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY = 31;
const RETRO_PIXEL_FORMAT_RGB565 = 2;
const SCC_B_COMMAND = 0xe98001;
const SCC_B_DATA = 0xe98003;
const SCC_A_COMMAND = 0xe98005;
const SCC_A_DATA = 0xe98007;
const SCC_FIFO_SIZE = 4096;
/* WR0のコマンドビット[5:3]=5 = Reset Tx Int Pending(レジスタポインタは0)。 */
const SCC_WR0_RESET_TX_INT_PENDING = 0x28;
const TEST_CORE_JS = process.env.WEBX68K_TEST_CORE_JS ?? '';
const HAS_TEST_CORE = TEST_CORE_JS.length > 0 && existsSync(TEST_CORE_JS);
if (process.env.npm_lifecycle_event === 'test:core' && !HAS_TEST_CORE) {
  throw new Error('WEBX68K_TEST_CORE_JS にテスト export 付きコアを指定してください');
}
if (!HAS_TEST_CORE) {
  // npm test を含むどの実行経路でも「実コア結合テストを1件も動かしていない」ことが
  // 緑のサマリーに埋もれないよう、理由と再現手順を必ず標準出力へ出す。
  process.stdout.write(
    [
      '',
      '[SKIP] test/core-serial-integration.test.ts: 実コア結合テストを実行していません。',
      TEST_CORE_JS.length === 0
        ? '       理由: 環境変数 WEBX68K_TEST_CORE_JS が未設定です。'
        : `       理由: WEBX68K_TEST_CORE_JS のパスが存在しません (${TEST_CORE_JS})。`,
      '       このファイルのテストはSCC診断用exportを含むコアを必要とします。再現手順:',
      '         CORE_TEST_EXPORTS=1 OUT_DIR=/path/to/temporary/core ./scripts/build-core.sh',
      '         WEBX68K_TEST_CORE_JS=/path/to/temporary/core/px68k_libretro.js npm run test:core',
      '       npm run test:core は未指定のまま実行すると失敗します(スキップしません)。',
      '',
    ].join('\n'),
  );
}

interface CoreModule {
  FS: { mkdir(path: string): void; writeFile(path: string, data: Uint8Array): void };
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  addFunction(fn: (...args: number[]) => number | void, signature: string): number;
  _malloc(size: number): number;
  _free(pointer: number): void;
  stringToUTF8(value: string, pointer: number, maxBytes: number): number;
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
  _retro_serialize_size(): number;
  _retro_serialize(pointer: number, size: number): number;
  _retro_unserialize(pointer: number, size: number): number;
  _get_retro_log_shim(): number;
  _webx68k_serial_rx?(data: number, length: number): number;
  _webx68k_serial_tx_available?(): number;
  _webx68k_serial_tx_drain?(data: number, length: number): number;
  _webx68k_serial_set_connected?(connected: number): void;
  _webx68k_scc_read?(address: number): number;
  _webx68k_scc_write?(address: number, value: number): void;
  _webx68k_scc_test_acknowledge_irq?(): number;
  _webx68k_scc_test_interrupt_cause?(): number;
  _webx68k_scc_test_irq_pending?(): number;
}

type CoreFactory = (options?: Record<string, unknown>) => Promise<CoreModule>;

function loadCoreFactory(): CoreFactory {
  const jsPath = TEST_CORE_JS;
  const source = readFileSync(jsPath, 'utf8');
  const commonJsModule: { exports: CoreFactory | { default: CoreFactory } | Record<string, never> } = { exports: {} };
  const wrapper = runInThisContext(
    `(function (module, exports, require, __filename, __dirname) { ${source}\n})`,
    { filename: jsPath },
  ) as (module: typeof commonJsModule, exports: typeof commonJsModule.exports,
    require: NodeRequire, filename: string, directory: string) => void;
  wrapper(commonJsModule, commonJsModule.exports, createRequire(jsPath), jsPath, dirname(jsPath));
  const exported = commonJsModule.exports;
  const factory = typeof exported === 'function' ? exported : exported.default;
  if (typeof factory !== 'function') throw new Error('PX68K factoryをNode上でロードできません');
  return factory;
}

function mallocString(mod: CoreModule, value: string): number {
  const length = mod.lengthBytesUTF8(value) + 1;
  const pointer = mod._malloc(length);
  mod.stringToUTF8(value, pointer, length);
  return pointer;
}

async function initializeCore(): Promise<CoreModule> {
  const mod = await loadCoreFactory()({});
  if (!mod._webx68k_serial_rx || !mod._webx68k_serial_tx_available ||
      !mod._webx68k_serial_tx_drain || !mod._webx68k_serial_set_connected ||
      !mod._webx68k_scc_read || !mod._webx68k_scc_write ||
      !mod._webx68k_scc_test_acknowledge_irq || !mod._webx68k_scc_test_interrupt_cause ||
      !mod._webx68k_scc_test_irq_pending) {
    throw new Error('SCC結合テスト用exportがありません。コアを再ビルドしてください');
  }
  for (const path of ['/system', '/system/keropi', '/save']) {
    try { mod.FS.mkdir(path); } catch { /* 既存ディレクトリは無視する。 */ }
  }
  mod.FS.writeFile('/system/keropi/iplrom.dat', new Uint8Array(0x20000));
  mod.FS.writeFile('/system/keropi/cgrom.dat', new Uint8Array(0xc0000));
  const systemDirectory = mallocString(mod, '/system');
  const saveDirectory = mallocString(mod, '/save');
  const environment = (command: number, data: number): number => {
    if (command === RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY) {
      mod.HEAP32[data >> 2] = systemDirectory;
      return 1;
    }
    if (command === RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY) {
      mod.HEAP32[data >> 2] = saveDirectory;
      return 1;
    }
    if (command === RETRO_ENVIRONMENT_SET_PIXEL_FORMAT) {
      return mod.HEAP32[data >> 2] === RETRO_PIXEL_FORMAT_RGB565 ? 1 : 0;
    }
    if (command === RETRO_ENVIRONMENT_GET_LOG_INTERFACE) {
      mod.HEAP32[data >> 2] = mod._get_retro_log_shim();
      return 1;
    }
    return command === RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME ? 1 : 0;
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

function writeRegister(mod: CoreModule, commandAddress: number, register: number, value: number): void {
  mod._webx68k_scc_write!(commandAddress, register);
  mod._webx68k_scc_write!(commandAddress, value);
}

function readRegister(mod: CoreModule, commandAddress: number, register: number): number {
  mod._webx68k_scc_write!(commandAddress, register);
  return mod._webx68k_scc_read!(commandAddress);
}

describe.skipIf(!HAS_TEST_CORE)('px68k-libretro SCCチャネルA結合', () => {
  it('ホスト接続、受信、送信を実コアFIFOへ反映する', async () => {
    const mod = await initializeCore();
    const pointer = mod._malloc(8);
    mod._webx68k_serial_set_connected!(1);
    mod.HEAPU8.set([0x41, 0x42], pointer);
    expect(mod._webx68k_serial_rx!(pointer, 2)).toBe(2);
    expect(readRegister(mod, SCC_A_COMMAND, 0) & 1).toBe(1);
    expect(mod._webx68k_scc_read!(SCC_A_DATA)).toBe(0x41);
    expect(mod._webx68k_scc_read!(SCC_A_DATA)).toBe(0x42);
    expect(readRegister(mod, SCC_A_COMMAND, 0) & 1).toBe(0);
    mod._webx68k_scc_write!(SCC_A_DATA, 0x5a);
    expect(mod._webx68k_serial_tx_available!()).toBe(1);
    expect(mod._webx68k_serial_tx_drain!(pointer, 8)).toBe(1);
    expect(mod.HEAPU8[pointer]).toBe(0x5a);
    mod._free(pointer);
  });

  it('FIFO fullからの空き、RR3 pending、チャネルAレジスタの状態保存を検証する', async () => {
    const mod = await initializeCore();
    const pointer = mod._malloc(8);
    mod._webx68k_serial_set_connected!(1);
    writeRegister(mod, SCC_B_COMMAND, 9, 0x09);
    writeRegister(mod, SCC_A_COMMAND, 1, 0x12);
    expect(readRegister(mod, SCC_A_COMMAND, 3) & 0x10).toBe(0x10);
    for (let index = 0; index < SCC_FIFO_SIZE; index++) {
      mod._webx68k_scc_write!(SCC_A_DATA, index);
    }
    expect(readRegister(mod, SCC_A_COMMAND, 0) & 4).toBe(0);
    expect(readRegister(mod, SCC_A_COMMAND, 3) & 0x10).toBe(0);
    expect(mod._webx68k_serial_tx_drain!(pointer, 1)).toBe(1);
    expect(readRegister(mod, SCC_A_COMMAND, 0) & 4).toBe(4);
    expect(readRegister(mod, SCC_A_COMMAND, 3) & 0x10).toBe(0x10);

    const stateSize = mod._retro_serialize_size();
    const statePointer = mod._malloc(stateSize);
    expect(mod._retro_serialize(statePointer, stateSize)).toBe(1);
    writeRegister(mod, SCC_A_COMMAND, 1, 0);
    expect(mod._retro_unserialize(statePointer, stateSize)).toBe(1);
    mod._webx68k_serial_set_connected!(0);
    mod._webx68k_serial_set_connected!(1);
    mod.HEAPU8[pointer] = 0x61;
    expect(mod._webx68k_serial_rx!(pointer, 1)).toBe(1);
    expect(readRegister(mod, SCC_A_COMMAND, 3) & 0x20).toBe(0x20);
    writeRegister(mod, SCC_A_COMMAND, 12, 0x34);
    writeRegister(mod, SCC_A_COMMAND, 13, 0x12);
    writeRegister(mod, SCC_A_COMMAND, 15, 0xaa);
    expect(readRegister(mod, SCC_A_COMMAND, 12)).toBe(0x34);
    expect(readRegister(mod, SCC_A_COMMAND, 13)).toBe(0x12);
    expect(readRegister(mod, SCC_A_COMMAND, 15)).toBe(0xaa);
    mod._free(statePointer);
    mod._free(pointer);
  });

  it('切断時RR0とTX割り込み、MIE解除、RR2 acknowledge、ラウンドロビン順を検証する', async () => {
    const mod = await initializeCore();
    const pointer = mod._malloc(1);

    const cleanStateSize = mod._retro_serialize_size();
    const cleanStatePointer = mod._malloc(cleanStateSize);
    expect(mod._retro_serialize(cleanStatePointer, cleanStateSize)).toBe(1);

    mod._webx68k_serial_set_connected!(0);
    const disconnectedRr0 = readRegister(mod, SCC_A_COMMAND, 0);
    expect(disconnectedRr0 & 0x04).toBe(0x04);
    expect(disconnectedRr0 & 0x28).toBe(0);

    writeRegister(mod, SCC_B_COMMAND, 9, 0x09);
    writeRegister(mod, SCC_A_COMMAND, 1, 0x02);
    expect(readRegister(mod, SCC_A_COMMAND, 3) & 0x10).toBe(0);
    expect(mod._webx68k_scc_test_irq_pending!()).toBe(0);
    mod._webx68k_scc_write!(SCC_A_DATA, 0x5a);
    expect(readRegister(mod, SCC_A_COMMAND, 3) & 0x10).toBe(0);
    expect(mod._webx68k_scc_test_irq_pending!()).toBe(0);

    mod._webx68k_serial_set_connected!(1);
    expect(readRegister(mod, SCC_A_COMMAND, 3) & 0x10).toBe(0x10);
    expect(mod._webx68k_scc_test_interrupt_cause!()).toBe(2);
    writeRegister(mod, SCC_A_COMMAND, 1, 0);
    writeRegister(mod, SCC_B_COMMAND, 9, 0x01);
    expect(readRegister(mod, SCC_A_COMMAND, 0) & 0x28).toBe(0x28);
    writeRegister(mod, SCC_B_COMMAND, 2, 0x40);
    writeRegister(mod, SCC_A_COMMAND, 1, 0x10);
    writeRegister(mod, SCC_B_COMMAND, 1, 0x10);
    writeRegister(mod, SCC_B_COMMAND, 3, 0x01);
    writeRegister(mod, SCC_B_COMMAND, 5, 0x02);
    mod.HEAPU8[pointer] = 0x41;
    expect(mod._webx68k_serial_rx!(pointer, 1)).toBe(1);
    writeRegister(mod, SCC_B_COMMAND, 9, 0x09);

    expect(mod._webx68k_scc_test_irq_pending!()).toBe(1);
    expect(mod._webx68k_scc_test_interrupt_cause!()).toBe(1);
    expect(mod._webx68k_scc_test_acknowledge_irq!()).toBe(0x4c);
    expect(readRegister(mod, SCC_B_COMMAND, 2)).toBe(0x4c);
    expect(mod._webx68k_scc_test_interrupt_cause!()).toBe(3);
    expect(readRegister(mod, SCC_B_COMMAND, 2)).toBe(0x44);
    expect(mod._webx68k_scc_test_acknowledge_irq!()).toBe(0x44);

    writeRegister(mod, SCC_B_COMMAND, 9, 0x01);
    expect(mod._webx68k_scc_test_irq_pending!()).toBe(0);

    writeRegister(mod, SCC_B_COMMAND, 2, 0x5a);
    expect(readRegister(mod, SCC_A_COMMAND, 2)).toBe(0x5a);
    writeRegister(mod, SCC_B_COMMAND, 9, 0x09);
    expect(mod._webx68k_scc_test_irq_pending!()).toBe(1);
    writeRegister(mod, SCC_B_COMMAND, 9, 0x40);
    expect(readRegister(mod, SCC_A_COMMAND, 2)).toBe(0x5a);
    writeRegister(mod, SCC_A_COMMAND, 9, 0x40);
    expect(readRegister(mod, SCC_A_COMMAND, 2)).toBe(0x5a);
    writeRegister(mod, SCC_A_COMMAND, 9, 0xc0);
    expect(readRegister(mod, SCC_A_COMMAND, 2)).toBe(0);
    expect(mod._webx68k_scc_test_irq_pending!()).toBe(0);

    writeRegister(mod, SCC_A_COMMAND, 1, 0x10);
    mod.HEAPU8[pointer] = 0x42;
    expect(mod._webx68k_serial_rx!(pointer, 1)).toBe(1);
    writeRegister(mod, SCC_B_COMMAND, 9, 0x09);
    expect(mod._webx68k_scc_test_irq_pending!()).toBe(1);
    expect(mod._retro_unserialize(cleanStatePointer, cleanStateSize)).toBe(1);
    expect(mod._webx68k_scc_test_irq_pending!()).toBe(0);
    expect(mod._webx68k_scc_test_interrupt_cause!()).toBe(0);

    mod._free(cleanStatePointer);
    mod._free(pointer);
  });

  it('切断時にシリアル割り込みだけを解除し、マウス割り込みを維持する', async () => {
    const mod = await initializeCore();

    mod._webx68k_serial_set_connected!(1);
    writeRegister(mod, SCC_B_COMMAND, 2, 0x40);
    writeRegister(mod, SCC_B_COMMAND, 1, 0x10);
    writeRegister(mod, SCC_B_COMMAND, 3, 0x01);
    writeRegister(mod, SCC_B_COMMAND, 5, 0x02);
    writeRegister(mod, SCC_A_COMMAND, 1, 0x02);
    writeRegister(mod, SCC_B_COMMAND, 9, 0x09);
    expect(mod._webx68k_scc_test_irq_pending!()).toBe(1);
    expect(mod._webx68k_scc_test_interrupt_cause!()).toBe(2);

    mod._webx68k_serial_set_connected!(0);
    expect(mod._webx68k_scc_test_irq_pending!()).toBe(1);
    expect(mod._webx68k_scc_test_interrupt_cause!()).toBe(3);
    expect(mod._webx68k_scc_test_acknowledge_irq!()).toBe(0x44);
  });

  it('pending要因が消えたらIRQ5をde-assertする(RX drain・TX pending消滅・mouse読了)', async () => {
    const mod = await initializeCore();
    const pointer = mod._malloc(1);

    mod._webx68k_serial_set_connected!(1);
    writeRegister(mod, SCC_B_COMMAND, 2, 0x40);
    writeRegister(mod, SCC_B_COMMAND, 9, 0x09);

    // RX: 受信でIRQ5が立ち、FIFOを読み切ったらacknowledgeを介さずに取り下がる。
    writeRegister(mod, SCC_A_COMMAND, 1, 0x10);
    mod.HEAPU8[pointer] = 0x41;
    expect(mod._webx68k_serial_rx!(pointer, 1)).toBe(1);
    expect(mod._webx68k_scc_test_irq_pending!()).toBe(1);
    expect(mod._webx68k_scc_test_interrupt_cause!()).toBe(1);
    expect(mod._webx68k_scc_read!(SCC_A_DATA)).toBe(0x41);
    expect(mod._webx68k_scc_test_irq_pending!()).toBe(0);
    expect(mod._webx68k_scc_test_interrupt_cause!()).toBe(0);

    // TX: 送信バッファ空き割り込みを有効化するとpendingし、WR0のReset Tx Int Pendingで消える。
    writeRegister(mod, SCC_A_COMMAND, 1, 0x02);
    expect(mod._webx68k_scc_test_irq_pending!()).toBe(1);
    expect(mod._webx68k_scc_test_interrupt_cause!()).toBe(2);
    mod._webx68k_scc_write!(SCC_A_COMMAND, SCC_WR0_RESET_TX_INT_PENDING);
    expect(mod._webx68k_scc_test_irq_pending!()).toBe(0);
    expect(mod._webx68k_scc_test_interrupt_cause!()).toBe(0);
    writeRegister(mod, SCC_A_COMMAND, 1, 0);

    // mouse: 3バイト読み切るまでpendingを維持し、読了時点でIRQ5を取り下げる。
    writeRegister(mod, SCC_B_COMMAND, 1, 0x10);
    writeRegister(mod, SCC_B_COMMAND, 3, 0x01);
    writeRegister(mod, SCC_B_COMMAND, 5, 0x02);
    // チャネルBの書き込み経路はIntCheckを呼ばないため、WR9再書き込みで割り込み評価を促す。
    writeRegister(mod, SCC_B_COMMAND, 9, 0x09);
    expect(mod._webx68k_scc_test_irq_pending!()).toBe(1);
    expect(mod._webx68k_scc_test_interrupt_cause!()).toBe(3);
    mod._webx68k_scc_read!(SCC_B_DATA);
    expect(mod._webx68k_scc_test_irq_pending!()).toBe(1);
    mod._webx68k_scc_read!(SCC_B_DATA);
    expect(mod._webx68k_scc_test_irq_pending!()).toBe(1);
    mod._webx68k_scc_read!(SCC_B_DATA);
    expect(mod._webx68k_scc_test_irq_pending!()).toBe(0);
    expect(mod._webx68k_scc_test_interrupt_cause!()).toBe(0);

    mod._free(pointer);
  });
});
