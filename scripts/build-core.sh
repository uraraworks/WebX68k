#!/bin/bash
# px68k-libretro コアを emscripten でビルドし、public/core/ に配置するスクリプト
set -e

EMSDK_DIR="/Users/haruurara/MyProject/_emulator/PC98/emsdk"
CORE_SRC_DIR="/Users/haruurara/MyProject/_emulator/X68K/px68k-libretro"
# 出力先はこのスクリプトが属する作業ツリーの public/core を既定とする。
# (worktree が複数あるため、絶対パス固定だと別ツリーへ書いてしまう)
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_DIR/public/core}"
WORK_A="/tmp/px68k_core.a"

echo "== emsdk 環境読み込み =="
source "$EMSDK_DIR/emsdk_env.sh"

echo "== px68k-libretro コアビルド (emscripten) =="
cd "$CORE_SRC_DIR"
# C68K=0 で Musashi CPU コアを使う (c68k は wasm で C68k_Exec が無限ループする)
emmake make -f Makefile.libretro platform=emscripten C68K=0 -j8

CORE_BC="$CORE_SRC_DIR/px68k_libretro_emscripten.bc"
if [ ! -f "$CORE_BC" ]; then
  echo "エラー: $CORE_BC が見つかりません。Makefile.libretro の TARGET 名を確認してください。" >&2
  exit 1
fi

# .bc のままだと emcc がビットコード形式と誤認するため .a にリネームしてから渡す
cp "$CORE_BC" "$WORK_A"

echo "== emcc でリンクし wasm/js を生成 =="
mkdir -p "$OUT_DIR"
SHIM_C="$REPO_DIR/src/core-shim.c"
emcc "$WORK_A" "$SHIM_C" -O2 -o "$OUT_DIR/px68k_libretro.js" \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=PX68K \
  -sALLOW_MEMORY_GROWTH=1 \
  -sALLOW_TABLE_GROWTH=1 \
  -sEXPORTED_FUNCTIONS=_retro_set_environment,_retro_set_video_refresh,_retro_set_audio_sample,_retro_set_audio_sample_batch,_retro_set_input_poll,_retro_set_input_state,_retro_init,_retro_deinit,_retro_api_version,_retro_get_system_av_info,_retro_reset,_retro_run,_retro_load_game,_retro_unload_game,_retro_serialize_size,_retro_serialize,_retro_unserialize,_get_retro_log_shim,_get_fdd_is_reading,_get_fdd_access_drive,_get_sasi_is_accessing,_get_fdd_dirty_mask,_clear_fdd_dirty,_get_sasi_dirty,_clear_sasi_dirty,_webx68k_fdd_insert,_webx68k_fdd_eject,_get_mouse_dx,_get_mouse_dy,_get_mouse_stat,_get_mouse_enabled,_get_mouse_scc_x,_get_mouse_scc_y,_get_mouse_scc_stat,_webx68k_peek16,_webx68k_peek8,_webx68k_keybuf_peek,_webx68k_keybuf_write_pointer,_webx68k_tvram_data,_webx68k_text_dot_x,_webx68k_text_dot_y,_webx68k_text_scroll_x,_webx68k_text_scroll_y,_webx68k_joystick_read,_webx68k_configured_ram_size,_webx68k_sram_read,_webx68k_send_key_make,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=cwrap,ccall,addFunction,removeFunction,FS,HEAPU8,HEAPU16,HEAP16,HEAP32,HEAPF32,HEAPF64,UTF8ToString,stringToUTF8,lengthBytesUTF8

echo "== 完了 =="
ls -la "$OUT_DIR"
