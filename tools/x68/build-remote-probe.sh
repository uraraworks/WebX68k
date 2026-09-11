#!/bin/bash
# RPROBE.SYS(remote-probe.s)を条件ごとにアセンブルし、Human68kの挙動観測用
# ディスクイメージを作る。
#
# 条件の意味(すべてremote-probe.s 1本を -D と属性ワードのパッチで作り分ける):
#   C0  : 陰性対照 - RPROBE.SYSは置くがCONFIG.SYSにDEVICE行なし
#   C1  : 陽性対照 - 属性$0000(ブロックデバイス)でDEVICE登録。初期化=cmd0、
#         未対応コマンドは全部エラー$1003
#   C2  : 本命     - 属性$2000(bit13)でDEVICE登録。挙動はC1と同じ
#   C1b : 属性$0000。cmd0は通常どおり、cmd5だけ+13=$42で状態$0000(成功)、
#         他はエラー$1003(-DCMD5_SPECIAL=1)
#   C3a : 属性$2000。初期化コマンドを$40で受理、他は全部エラー$1003
#         (-DCMD_INIT=\$40)
#   C3b : 属性$2000。初期化は$40で受理、他は応答欄に触れず状態$0000(成功)
#         (-DCMD_INIT=\$40 -DUNKNOWN_OK=1)
#
# 使い方: 引数なしで実行すると6条件すべてのディスクを作る。
#   ./tools/x68/build-remote-probe.sh
#
# 生成物はすべて _local/remote-probe/ 配下(.gitignore対象)。
# 同梱の human302.xdf は一切書き換えない(cpしたコピー上でのみ編集する)。
set -e

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
VASM="$REPO_DIR/_local/tools/vasm/vasmm68k_mot"
SRC="$REPO_DIR/tools/x68/remote-probe.s"
OUT_DIR="$REPO_DIR/_local/remote-probe"
SYSTEM_DISK="$REPO_DIR/public/system/human302.xdf"

if [ ! -x "$VASM" ]; then
  echo "エラー: $VASM が見つかりません。" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# 属性ワード(+4, ファイル内オフセット0x44 = 64byte Xヘッダ + デバイスヘッダ+4)を
# パッチする。ソース上は常に$0000で書き出されるので、C2/C3系はここで$2000へ
# 書き換える(ビルドをやり直さず、生成済みバイナリのバイト2つを書き換えるだけ)。
patch_attr() {
  local src="$1" dst="$2" attr_hex="$3"
  python3 - "$src" "$dst" "$attr_hex" <<'PYEOF'
import sys
src, dst, attr_hex = sys.argv[1], sys.argv[2], sys.argv[3]
with open(src, "rb") as f:
    data = bytearray(f.read())
attr = int(attr_hex, 16)
off = 0x44  # 0x40(Xヘッダ64B) + 4(デバイスヘッダの属性ワード位置)
assert data[0:2] == b"HU", "HUマジックが無い: X形式ではない?"
data[off] = (attr >> 8) & 0xFF
data[off + 1] = attr & 0xFF
with open(dst, "wb") as f:
    f.write(data)
print(f"{dst}: attr=${attr:04x} をオフセット0x{off:x}へパッチ")
PYEOF
}

# name: 生成物の接頭辞 / attr_hex: 属性ワード / vasm_defs: vasmへの-D引数(配列)
build_one() {
  local name="$1" attr_hex="$2"
  shift 2
  local vasm_defs=("$@")

  echo "== ${name}: アセンブル(${vasm_defs[*]:-既定値}) =="
  "$VASM" -Fbin -m68000 -no-opt "${vasm_defs[@]}" -o "$OUT_DIR/${name}_RAW.bin" "$SRC"
  python3 "$REPO_DIR/tools/x68/hu_pack.py" "$OUT_DIR/${name}_RAW.bin" "$OUT_DIR/${name}_RAW.SYS" --reloc=6,10
  patch_attr "$OUT_DIR/${name}_RAW.SYS" "$OUT_DIR/${name}.SYS" "$attr_hex"

  echo "== ${name}: ディスク作成 =="
  cp "$SYSTEM_DISK" "$OUT_DIR/${name}_pre.xdf"
  python3 "$REPO_DIR/tools/x68/fatput.py" "$OUT_DIR/${name}_pre.xdf" "RPROBE.SYS" "$OUT_DIR/${name}.SYS"
}

# CONFIG.SYSにDEVICE行を追加したバージョンを別名で作る(C0は追加しない=陰性対照)
build_device_variant() {
  local name="$1"
  node "$REPO_DIR/scripts/make-config-variant.mjs" \
    --src="$OUT_DIR/${name}_pre.xdf" --out="$OUT_DIR/${name}.xdf" --line='DEVICE = \RPROBE.SYS'
}

echo "== C1相当の実体をビルド(C0/C1で共用) =="
build_one "c1" 0000
cp "$OUT_DIR/c1_RAW.SYS" "$OUT_DIR/c0_RAW.SYS"
cp "$OUT_DIR/c1.SYS" "$OUT_DIR/c0.SYS"
cp "$SYSTEM_DISK" "$OUT_DIR/c0_pre.xdf"
python3 "$REPO_DIR/tools/x68/fatput.py" "$OUT_DIR/c0_pre.xdf" "RPROBE.SYS" "$OUT_DIR/c0.SYS"

echo "== C0: 陰性対照(RPROBE.SYSは置くがDEVICE行なし) =="
cp "$OUT_DIR/c0_pre.xdf" "$OUT_DIR/c0.xdf"

echo "== C1: 陽性対照(属性\$0000, ブロックデバイスとして登録) =="
build_device_variant "c1"

echo "== C2: 本命(属性\$2000 = bit13) =="
build_one "c2" 2000
build_device_variant "c2"

echo "== C1b: 属性\$0000, cmd5だけ特別扱い =="
build_one "c1b" 0000 -DCMD5_SPECIAL=1
build_device_variant "c1b"

echo "== C3a: 属性\$2000, 初期化コマンド=\$40 =="
build_one "c3a" 2000 -DCMD_INIT=\$40
build_device_variant "c3a"

echo "== C3b: 属性\$2000, 初期化コマンド=\$40, 未対応コマンドは成功扱い =="
build_one "c3b" 2000 -DCMD_INIT=\$40 -DUNKNOWN_OK=1
build_device_variant "c3b"

echo "== 完了 =="
echo "$OUT_DIR/{c0,c1,c2,c1b,c3a,c3b}.xdf を作成しました。"
