#!/bin/bash
# X68000 テストプログラムをアセンブルし、.X 化して検証用ディスクへ書き込む。
#
# 前提: vasm(m68k/mot syntax) を _local/tools/vasm へ用意してあること。
#   curl -sSLO http://sun.hasenbraten.de/vasm/release/vasm.tar.gz
#   tar xzf vasm.tar.gz && cd vasm && make CPU=m68k SYNTAX=mot
# 生成物(バイナリ・ディスク)はすべて _local/ 配下(.gitignore 対象)に置く。
set -e

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
VASM="$REPO_DIR/_local/tools/vasm/vasmm68k_mot"
BUILD_DIR="$REPO_DIR/_local/x68build"
SRC="$REPO_DIR/tools/x68/mouse-test.s"
SYSTEM_DISK="$REPO_DIR/public/system/human302.xdf"
OUT_DISK="$BUILD_DIR/mousetest.xdf"

if [ ! -x "$VASM" ]; then
  echo "エラー: $VASM が見つかりません。README の手順で vasm を用意してください。" >&2
  exit 1
fi

mkdir -p "$BUILD_DIR"

echo "== アセンブル =="
"$VASM" -Fbin -m68000 -no-opt -o "$BUILD_DIR/mouse-test.bin" "$SRC"

echo "== .X 形式へ変換 =="
python3 "$REPO_DIR/tools/x68/hu_pack.py" "$BUILD_DIR/mouse-test.bin" "$BUILD_DIR/MOUSETST.X"

echo "== 検証用ディスクを作成 =="
# 同梱のシステムディスクは無改変で保つ。書き込むのは _local 側のコピーだけ。
cp "$SYSTEM_DISK" "$OUT_DISK"
python3 "$REPO_DIR/tools/x68/fatput.py" "$OUT_DISK" "MOUSETST.X" "$BUILD_DIR/MOUSETST.X"

echo "== 完了 =="
echo "FDD0 に $OUT_DISK を入れて起動し、A> で MOUSETST と入力してください。"
