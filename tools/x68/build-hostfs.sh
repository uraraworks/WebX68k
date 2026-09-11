#!/bin/bash
# HOSTFS.SYS(hostfs.s)をアセンブルし、human302.xdfのコピーへ配置してCONFIG.SYSに
# DEVICE行を足した検証用ディスクを作る(feature/hostfs)。
#
# human302.xdf(public/system/human302.xdf)は一切書き換えない(cpしたコピー上で
# のみ編集する)。生成物はすべて _local/hostfs/ 配下(.gitignore対象)。
set -e

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
VASM="$REPO_DIR/_local/tools/vasm/vasmm68k_mot"
SRC="$REPO_DIR/tools/x68/hostfs.s"
OUT_DIR="$REPO_DIR/_local/hostfs"
SYSTEM_DISK="$REPO_DIR/public/system/human302.xdf"

if [ ! -x "$VASM" ]; then
  echo "エラー: $VASM が見つかりません。" >&2
  exit 1
fi
if [ ! -f "$SYSTEM_DISK" ]; then
  echo "エラー: $SYSTEM_DISK が見つかりません。" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "== アセンブル =="
"$VASM" -Fbin -m68000 -no-opt -o "$OUT_DIR/HOSTFS_RAW.bin" "$SRC"

echo "== X形式化(再配置テーブル付き) =="
python3 "$REPO_DIR/tools/x68/hu_pack.py" "$OUT_DIR/HOSTFS_RAW.bin" "$OUT_DIR/HOSTFS.SYS" --reloc=6,10

echo "== 検証用ディスク作成 =="
cp "$SYSTEM_DISK" "$OUT_DIR/hostfs_pre.xdf"
python3 "$REPO_DIR/tools/x68/fatput.py" "$OUT_DIR/hostfs_pre.xdf" "HOSTFS.SYS" "$OUT_DIR/HOSTFS.SYS"

echo "== CONFIG.SYSにDEVICE行を追加 =="
node "$REPO_DIR/scripts/make-config-variant.mjs" \
  --src="$OUT_DIR/hostfs_pre.xdf" --out="$OUT_DIR/hostfs.xdf" --line='DEVICE = \HOSTFS.SYS'

echo "== 完了 =="
echo "$OUT_DIR/hostfs.xdf を作成しました。"
