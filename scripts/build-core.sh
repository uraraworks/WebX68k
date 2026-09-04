#!/bin/bash
# px68k-libretro コアを emscripten でビルドし、public/core/ に配置するスクリプト
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EMSDK_DIR="${EMSDK_DIR:-$HOME/emsdk}"
CORE_SRC_DIR="${CORE_SRC_DIR:-$PROJECT_DIR/../px68k-libretro}"
OUT_DIR_INPUT="${OUT_DIR:-}"
OUT_DIR="${OUT_DIR:-$PROJECT_DIR/public/core}"
REQUIRED_EMSDK_VERSION="${EMSDK_VERSION:-6.0.7}"
CORE_GIT_DIR="${CORE_GIT_DIR:-}"
GIT_CONTEXT=(-C "$CORE_SRC_DIR")
if [ -n "$CORE_GIT_DIR" ]; then
  GIT_CONTEXT=(--git-dir="$CORE_GIT_DIR" --work-tree="$CORE_SRC_DIR")
fi
CORE_GIT_VERSION_INPUT="${CORE_GIT_VERSION:-}"
CORE_GIT_DESCRIBE="$(git "${GIT_CONTEXT[@]}" describe --always --dirty 2>/dev/null || true)"
CORE_GIT_HEAD="$(git "${GIT_CONTEXT[@]}" rev-parse HEAD 2>/dev/null || true)"
CORE_GIT_VERSION="${CORE_GIT_VERSION_INPUT:-$CORE_GIT_DESCRIBE}"
JOBS="${JOBS:-8}"
CLEAN_BUILD="${CLEAN_BUILD:-1}"
ALLOW_DIRTY="${ALLOW_DIRTY:-0}"
CORE_TEST_EXPORTS="${CORE_TEST_EXPORTS:-0}"
if [ "$CORE_TEST_EXPORTS" = "1" ] && [ -z "$OUT_DIR_INPUT" ]; then
  echo "エラー: CORE_TEST_EXPORTS=1 はSCC診断用exportを含む結合テスト専用ビルドです。" >&2
  echo "       配布用の $OUT_DIR を上書きしないよう、OUT_DIR にリポジトリ外の一時ディレクトリを明示してください。" >&2
  echo "       例: CORE_TEST_EXPORTS=1 OUT_DIR=/tmp/px68k-test-core ./scripts/build-core.sh" >&2
  exit 1
fi
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/px68k_core.XXXXXX")"
WORK_A="$WORK_DIR/px68k_core.a"
trap 'rm -rf "$WORK_DIR"' EXIT

if [ -z "$CORE_GIT_DESCRIBE" ] || [ -z "$CORE_GIT_HEAD" ]; then
  echo "エラー: コアのGitリビジョンを取得できません。Git管理された作業ツリーとCORE_GIT_DIRを確認してください。" >&2
  exit 1
fi
if [[ "$CORE_GIT_DESCRIBE" == *-dirty && "$ALLOW_DIRTY" != "1" ]]; then
  echo "エラー: コアの作業ツリーに未コミットの変更があります。明示的に許可する場合は ALLOW_DIRTY=1 を指定してください。" >&2
  exit 1
fi
if [ -n "$CORE_GIT_VERSION_INPUT" ]; then
  CORE_EXPECTED_HEAD="$(git "${GIT_CONTEXT[@]}" rev-parse "${CORE_GIT_VERSION_INPUT}^{commit}" 2>/dev/null || true)"
  if [ -z "$CORE_EXPECTED_HEAD" ] || [ "$CORE_EXPECTED_HEAD" != "$CORE_GIT_HEAD" ]; then
    echo "エラー: CORE_GIT_VERSION がコア作業ツリーのHEADと一致しません。" >&2
    exit 1
  fi
fi

echo "== emsdk 環境読み込み =="
source "$EMSDK_DIR/emsdk_env.sh"
EMCC_VERSION="$(emcc --version | head -n 1 | grep -oE '[0-9]+(\.[0-9]+){2}' | head -n 1)"
if [ "$EMCC_VERSION" != "$REQUIRED_EMSDK_VERSION" ]; then
  echo "エラー: emcc $REQUIRED_EMSDK_VERSION が必要です。" >&2
  emcc --version >&2
  exit 1
fi

echo "== px68k-libretro コアビルド (emscripten) =="
cd "$CORE_SRC_DIR"
# C68K=0 で Musashi CPU コアを使う (c68k は wasm で C68k_Exec が無限ループする)
if [ "$CLEAN_BUILD" != "0" ]; then
  emmake make -f Makefile.libretro platform=emscripten C68K=0 \
    STATIC_LINKING=1 TARGET=px68k_libretro_emscripten.bc clean
fi
emmake make -f Makefile.libretro platform=emscripten C68K=0 \
  STATIC_LINKING=1 TARGET=px68k_libretro_emscripten.bc \
  GIT_VERSION="$CORE_GIT_VERSION" \
  WEBX68K_CORE_TEST_EXPORTS="$CORE_TEST_EXPORTS" -j"$JOBS"

CORE_BC="$CORE_SRC_DIR/px68k_libretro_emscripten.bc"
if [ ! -f "$CORE_BC" ]; then
  echo "エラー: $CORE_BC が見つかりません。Makefile.libretro の TARGET 名を確認してください。" >&2
  exit 1
fi

# .bc のままだと emcc がビットコード形式と誤認するため .a にリネームしてから渡す
cp "$CORE_BC" "$WORK_A"

echo "== emcc でリンクし wasm/js を生成 =="
mkdir -p "$OUT_DIR"
SHIM_C="$PROJECT_DIR/src/core-shim.c"
SHIM_DEFINES=()
EXPORTED_FUNCTIONS="_retro_set_environment,_retro_set_video_refresh,_retro_set_audio_sample,_retro_set_audio_sample_batch,_retro_set_input_poll,_retro_set_input_state,_retro_init,_retro_deinit,_retro_api_version,_retro_get_system_av_info,_retro_reset,_retro_run,_retro_load_game,_retro_unload_game,_retro_serialize_size,_retro_serialize,_retro_unserialize,_get_retro_log_shim,_get_fdd_is_reading,_get_fdd_access_drive,_get_sasi_is_accessing,_get_fdd_dirty_mask,_clear_fdd_dirty,_get_sasi_dirty,_clear_sasi_dirty,_webx68k_fdd_insert,_webx68k_fdd_eject,_get_mouse_dx,_get_mouse_dy,_get_mouse_stat,_get_mouse_enabled,_get_mouse_scc_x,_get_mouse_scc_y,_get_mouse_scc_stat,_webx68k_peek16,_webx68k_peek8,_webx68k_keybuf_peek,_webx68k_keybuf_write_pointer,_webx68k_tvram_data,_webx68k_text_dot_x,_webx68k_text_dot_y,_webx68k_text_scroll_x,_webx68k_text_scroll_y,_webx68k_joystick_read,_webx68k_configured_ram_size,_webx68k_sram_read,_webx68k_send_key_make,_webx68k_serial_rx,_webx68k_serial_tx_available,_webx68k_serial_tx_drain,_webx68k_serial_reset,_webx68k_serial_set_connected,_webx68k_serial_set_tx_writable,_webx68k_serial_guest_baud_rate,_get_scsi_req_total,_get_scsi_unsupported_count,_get_scsi_read_count,_get_scsi_last_read_unit,_get_scsi_last_read_logsec,_get_scsi_write_count,_get_scsi_last_write_unit,_get_scsi_last_write_logsec,_get_scsi_strategy_call_count,_get_scsi_interrupt_call_count,_get_sasi_req_total,_get_sasi_read_count,_get_sasi_last_read_lba,_get_sasi_write_count,_get_sasi_last_write_lba,_malloc,_free"
if [ "$CORE_TEST_EXPORTS" = "1" ]; then
  SHIM_DEFINES+=(-DWEBX68K_CORE_TEST_EXPORTS=1)
  EXPORTED_FUNCTIONS+=",_webx68k_scc_read,_webx68k_scc_write,_webx68k_scc_test_acknowledge_irq,_webx68k_scc_test_interrupt_cause,_webx68k_scc_test_irq_pending"
fi
# fmgenなどC++オブジェクトを含むため、最終リンクでlibc++を有効にする。
emcc "$SHIM_C" "$WORK_A" "${SHIM_DEFINES[@]}" \
  -I"$CORE_SRC_DIR" -I"$CORE_SRC_DIR/libretro" -I"$CORE_SRC_DIR/x68k" \
  -I"$CORE_SRC_DIR/libretro-common/include" \
  -O2 -o "$OUT_DIR/px68k_libretro.js" \
  -sDEFAULT_TO_CXX=1 \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=PX68K \
  -sALLOW_MEMORY_GROWTH=1 \
  -sALLOW_TABLE_GROWTH=1 \
  -sEXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS" \
  -sEXPORTED_RUNTIME_METHODS=cwrap,ccall,addFunction,removeFunction,FS,HEAPU8,HEAPU16,HEAP16,HEAP32,HEAPF32,HEAPF64,UTF8ToString,stringToUTF8,lengthBytesUTF8

CORE_DIRTY=false
if [[ "$CORE_GIT_DESCRIBE" == *-dirty ]]; then
  CORE_DIRTY=true
fi
CORE_TEST_EXPORTS_JSON=false
if [ "$CORE_TEST_EXPORTS" = "1" ]; then
  CORE_TEST_EXPORTS_JSON=true
fi
cat > "$OUT_DIR/px68k_libretro.build.json" <<EOF
{
  "coreRevision": "$CORE_GIT_HEAD",
  "coreDescribe": "$CORE_GIT_DESCRIBE",
  "dirty": $CORE_DIRTY,
  "emscriptenVersion": "$EMCC_VERSION",
  "testExports": $CORE_TEST_EXPORTS_JSON
}
EOF

echo "== 完了 =="
ls -la "$OUT_DIR"
