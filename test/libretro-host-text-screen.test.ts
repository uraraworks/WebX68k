import { describe, expect, it } from 'vitest';
import { LibretroHost, type PX68KModule } from '../src/libretro-host';
import { MINIMUM_ANK_CGROM_SIZE } from '../src/text-screen';

const TVRAM_POINTER = 0x100;
const CGROM_ANK8X16_OFFSET = 0x3a800;

function createHost(): LibretroHost {
  const canvas = {
    getContext: () => ({}),
  } as unknown as HTMLCanvasElement;
  return new LibretroHost(canvas, () => {});
}

function createCore(onWrite: (path: string, data: Uint8Array) => void): PX68KModule {
  const heap = new Uint8Array(TVRAM_POINTER + 0x80000 + 0x100);
  let nextPointer = 1;
  return {
    FS: {
      mkdir: () => {},
      writeFile: onWrite,
      readFile: () => new Uint8Array(),
      unlink: () => {},
      analyzePath: () => ({ exists: false }),
    },
    HEAPU8: heap,
    HEAPU16: new Uint16Array(heap.buffer),
    HEAP16: new Int16Array(heap.buffer),
    HEAP32: new Int32Array(heap.buffer),
    HEAPF32: new Float32Array(heap.buffer),
    HEAPF64: new Float64Array(heap.buffer),
    _malloc: () => 8,
    _free: () => {},
    addFunction: () => nextPointer++,
    removeFunction: () => {},
    UTF8ToString: () => '',
    stringToUTF8: () => 0,
    lengthBytesUTF8: (value) => value.length,
    _retro_set_environment: () => {},
    _retro_set_video_refresh: () => {},
    _retro_set_audio_sample: () => {},
    _retro_set_audio_sample_batch: () => {},
    _retro_set_input_poll: () => {},
    _retro_set_input_state: () => {},
    _retro_init: () => {},
    _retro_deinit: () => {},
    _retro_api_version: () => 1,
    _retro_get_system_av_info: () => {},
    _retro_reset: () => {},
    _retro_run: () => {},
    _retro_load_game: () => 1,
    _retro_unload_game: () => {},
    _retro_serialize_size: () => 0,
    _retro_serialize: () => 1,
    _retro_unserialize: () => 1,
    _get_retro_log_shim: () => 0,
    _get_fdd_is_reading: () => 0,
    _get_fdd_access_drive: () => 0,
    _get_sasi_is_accessing: () => 0,
    _get_mouse_dx: () => 0,
    _get_mouse_dy: () => 0,
    _get_mouse_stat: () => 0,
    _get_mouse_enabled: () => 0,
    _get_mouse_scc_x: () => 0,
    _get_mouse_scc_y: () => 0,
    _get_mouse_scc_stat: () => 0,
    _webx68k_peek16: () => 0,
    _webx68k_peek8: () => 0,
    _webx68k_keybuf_peek: () => 0,
    _webx68k_keybuf_write_pointer: () => 0,
    _webx68k_fdd_insert: () => {},
    _webx68k_fdd_eject: () => {},
    _webx68k_tvram_data: () => TVRAM_POINTER,
    _webx68k_text_dot_x: () => 8,
    _webx68k_text_dot_y: () => 16,
    _webx68k_text_scroll_x: () => 0,
    _webx68k_text_scroll_y: () => 0,
  };
}

async function initWithCore(host: LibretroHost, core: PX68KModule): Promise<void> {
  const oldWindow = globalThis.window;
  globalThis.window = { PX68K: async () => core } as unknown as Window & typeof globalThis;
  try {
    await host.init(new Uint8Array(1), new Uint8Array(0));
  } finally {
    globalThis.window = oldWindow;
  }
}

describe('LibretroHost TVRAM テキスト取得', () => {
  it('コアへ渡した CGROM の同じ保持配列を逆引きにも使う', async () => {
    let writtenCgrom: Uint8Array | undefined;
    const core = createCore((path, data) => {
      if (path.endsWith('/cgrom.dat')) writtenCgrom = data;
    });
    const cgrom = new Uint8Array(MINIMUM_ANK_CGROM_SIZE);
    const glyph = Uint8Array.from({ length: 16 }, (_, row) => row % 2 === 0 ? 0xaa : 0x55);
    cgrom.set(glyph, CGROM_ANK8X16_OFFSET + 'A'.charCodeAt(0) * 16);

    const host = createHost();
    const oldWindow = globalThis.window;
    globalThis.window = { PX68K: async () => core } as unknown as Window & typeof globalThis;
    try {
      await host.init(new Uint8Array(1), cgrom);
    } finally {
      globalThis.window = oldWindow;
    }
    expect(writtenCgrom).toBeDefined();
    expect(writtenCgrom).not.toBe(cgrom);
    expect(writtenCgrom).toEqual(cgrom);
    expect((host as unknown as { coreCgrom: Uint8Array }).coreCgrom).toBe(writtenCgrom);

    for (let row = 0; row < 16; row++) {
      core.HEAPU8[TVRAM_POINTER + ((row * 128) ^ 1)] = glyph[row];
    }
    cgrom.fill(0); // 呼び出し元の変更が、コア用の単一保持配列へ波及しないことも確認する。
    const dump = host.readTextScreen();
    expect(dump.available).toBe(true);
    expect(dump.lines).toEqual(['A']);
    expect(dump.diagnostics.coverage).toBe(1);
  });

  it('CGROM 未設定なら例外を投げず取得不可を返す', () => {
    const dump = createHost().readTextScreen();
    expect(dump).toMatchObject({ available: false, lines: [], diagnostics: { coverage: 0 } });
    expect(dump.unavailableReason).toContain('設定されていません');
  });

  it('CGROM が短すぎても例外を投げず取得不可を返す', async () => {
    const host = createHost();
    const core = createCore(() => {});
    await initWithCore(host, core);
    const dump = host.readTextScreen();
    expect(dump).toMatchObject({ available: false, lines: [], diagnostics: { coverage: 0 } });
    expect(dump.unavailableReason).toContain('短すぎます');
  });
});
