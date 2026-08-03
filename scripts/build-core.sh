#!/bin/bash
# px68k-libretro コアを emscripten でビルドし、public/core/ に配置するスクリプト
set -e

EMSDK_DIR="/Users/haruurara/MyProject/_emulator/PC98/emsdk"
CORE_SRC_DIR="/Users/haruurara/MyProject/_emulator/X68K/px68k-libretro"
OUT_DIR="/Users/haruurara/MyProject/_emulator/X68K/WebX68k/public/core"
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
SHIM_C="/Users/haruurara/MyProject/_emulator/X68K/WebX68k/src/core-shim.c"
emcc "$WORK_A" "$SHIM_C" -O2 -o "$OUT_DIR/px68k_libretro.js" \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=PX68K \
  -sALLOW_MEMORY_GROWTH=1 \
  -sALLOW_TABLE_GROWTH=1 \
  -sEXPORTED_FUNCTIONS=_retro_set_environment,_retro_set_video_refresh,_retro_set_audio_sample,_retro_set_audio_sample_batch,_retro_set_input_poll,_retro_set_input_state,_retro_init,_retro_deinit,_retro_api_version,_retro_get_system_av_info,_retro_reset,_retro_run,_retro_load_game,_retro_unload_game,_retro_serialize_size,_retro_serialize,_retro_unserialize,_get_retro_log_shim,_get_fdd_is_reading,_get_fdd_access_drive,_get_sasi_is_accessing,_webx68k_fdd_insert,_webx68k_fdd_eject,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=cwrap,ccall,addFunction,removeFunction,FS,HEAPU8,HEAPU16,HEAP16,HEAP32,HEAPF32,HEAPF64,UTF8ToString,stringToUTF8,lengthBytesUTF8

echo "== 完了 =="
ls -la "$OUT_DIR"
