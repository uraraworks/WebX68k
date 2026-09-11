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

# REC_MODE用: rec_marker/rec_count/rec_entriesの、ドライバヘッダ先頭からの
# オフセット(バイト)を、アセンブル直後のRAW.bin(Xヘッダを被せる前の生バイナリ)
# から直接検索して求める。RAW.binのファイル先頭=drv_header(text section先頭)
# なので、この検索結果のオフセットがそのまま実行時のメモリオフセットになる
# (hu_pack.pyが被せる64バイトのXヘッダはロード時にHuman68kが読み捨てるので、
# ロードされた本体の先頭はRAW.binの先頭と一致する)。
print_rec_offsets() {
  local name="$1"
  python3 - "$OUT_DIR/${name}_RAW.bin" <<'PYEOF'
import sys
data = open(sys.argv[1], "rb").read()
name_off = data.find(b"RPROBE1")
marker_off = data.find(b"RECBUF01")
if name_off < 0 or marker_off < 0:
    print("エラー: RPROBE1 または RECBUF01 が見つからない", file=sys.stderr)
    sys.exit(1)
header_off = name_off - 15  # 名前(+14)の直後(+15)が'RPROBE1'の先頭
rec_count_off = marker_off - header_off + 8
rec_entries_off = rec_count_off + 2
print(f"[{sys.argv[1]}] header基準: rec_marker=+{marker_off - header_off} "
      f"rec_count=+{rec_count_off} rec_entries=+{rec_entries_off} "
      f"(strategy=+22 interrupt=+30 も参考)")
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

echo "== C6-V1/V2(A群): 属性\$2000, 初期化=\$40。\$47のボリューム検索(+13 bit3)に"
echo "   -2をヘッダのみ/D0のみで返す(FILBUFには書かない)。既存条件・C5のバイナリは"
echo "   変えない(C6_MODE/C6_SUBの既定値が変わるだけ) =="
build_one "c6v1" 2000 -DCMD_INIT=\$40 -DREC_MODE=1 -DC6_MODE=1 -DC6_SUB=1
build_device_variant "c6v1"
print_rec_offsets "c6v1"

build_one "c6v2" 2000 -DCMD_INIT=\$40 -DREC_MODE=1 -DC6_MODE=1 -DC6_SUB=2
build_device_variant "c6v2"
print_rec_offsets "c6v2"

echo "== C6-F1/F2/F3(B群): ボリューム検索=WEBX68Kラベルを成功で返す。本体検索="
echo "   HELLO.TXT成功。1回目の\$48=WORLD.DOC成功、2〜5回目=「もう無い」をF1/F2/F3"
echo "   で振る。6回目以降は安全弁で両方-18+印 =="
build_one "c6f1" 2000 -DCMD_INIT=\$40 -DREC_MODE=1 -DC6_MODE=2 -DC6_SUB=1
build_device_variant "c6f1"
print_rec_offsets "c6f1"

build_one "c6f2" 2000 -DCMD_INIT=\$40 -DREC_MODE=1 -DC6_MODE=2 -DC6_SUB=2
build_device_variant "c6f2"
print_rec_offsets "c6f2"

build_one "c6f3" 2000 -DCMD_INIT=\$40 -DREC_MODE=1 -DC6_MODE=2 -DC6_SUB=3
build_device_variant "c6f3"
print_rec_offsets "c6f3"

echo "== C7-D0/D1/D2: 属性\$2000, 初期化=\$40。ラベル/HELLO.TXT/WORLD.DOC/\$48の"
echo "   返し方はC6-F3(C6_MODE=2,C6_SUB=3)と同じ。\$56(推定: _DSKFRE)の返し方だけ"
echo "   DSKFRE_MODEで振る。REC_MAXはソース既定の64(dir c:\\sub\\a*.txtまで収める) =="
build_one "c7d0" 2000 -DCMD_INIT=\$40 -DREC_MODE=1 -DC6_MODE=2 -DC6_SUB=3 -DDSKFRE_MODE=0
build_device_variant "c7d0"
print_rec_offsets "c7d0"

build_one "c7d1" 2000 -DCMD_INIT=\$40 -DREC_MODE=1 -DC6_MODE=2 -DC6_SUB=3 -DDSKFRE_MODE=1
build_device_variant "c7d1"
print_rec_offsets "c7d1"

build_one "c7d2" 2000 -DCMD_INIT=\$40 -DREC_MODE=1 -DC6_MODE=2 -DC6_SUB=3 -DDSKFRE_MODE=2
build_device_variant "c7d2"
print_rec_offsets "c7d2"

echo "== C8-a/C8-b: 属性\$2000, 初期化=\$40。親の仮説「戻り値は+18のロング」を試す。"
echo "   \$47/\$48/\$56/\$57は状態(+3/+4)を常に0にし、戻り値を+18へ書く。\$50も新規"
echo "   ハンドルする(C8-a: +18=204800のみ。C8-b: +14がポインタらしければ_DSKFREの"
echo "   8バイトもそこへ書く) =="
build_one "c8a" 2000 -DCMD_INIT=\$40 -DREC_MODE=1 -DC6_MODE=2 -DC6_SUB=3 -DC8_MODE=1
build_device_variant "c8a"
print_rec_offsets "c8a"

build_one "c8b" 2000 -DCMD_INIT=\$40 -DREC_MODE=1 -DC6_MODE=2 -DC6_SUB=3 -DC8_MODE=2
build_device_variant "c8b"
print_rec_offsets "c8b"

echo "== C9-r1: 属性\$2000, 初期化=\$40。C8-bを土台に、コマンド番号を問わず+14/+18の"
echo "   ポインタ先を64バイトずつ記録する。未対応コマンドは状態0・+18=-2。"
echo "   open/read/closeはCMD_OPEN/CMD_READ/CMD_CLOSEで個別指定(既定\$ffは無効=未設定)。"
echo "   最初のラウンドは何も指定せず、'開く'が何番で来るかを記録だけで観測する。"
echo "   REC_MAXは96(dir c:より少ない往復で済む想定だが念のため引き上げ) =="
build_one "c9r1" 2000 -DCMD_INIT=\$40 -DREC_MODE=1 -DC6_MODE=2 -DC6_SUB=3 -DC8_MODE=2 -DC9_MODE=1 -DREC_MAX=96
build_device_variant "c9r1"
print_rec_offsets "c9r1"

echo "== C9-r2: C9-r1の実測(type c:hello.txtでcmd\$4aが1回だけ来た。+14が"
echo "   _NAMESTS形式(drive=2=C:, path=\\のみ)を指していた)を受け、\$4aを'開く'とみなし"
echo "   常に成功(+18=0)を返すようにする。次に来るコマンドを見るための段 =="
build_one "c9r2" 2000 -DCMD_INIT=\$40 -DREC_MODE=1 -DC6_MODE=2 -DC6_SUB=3 -DC8_MODE=2 -DC9_MODE=1 -DREC_MAX=96 -DCMD_OPEN=\$4a
build_device_variant "c9r2"
print_rec_offsets "c9r2"

echo "== C9-r3: C9-r2の実測(cmd\$4a=開く成功後、cmd\$4c(+14=ポインタ,+18=長さ1024)"
echo "   →cmd\$4bの順で来た。\$4cを'読む'、\$4bを'閉じる'とみなし、バッファは+14"
echo "   (CMD_READ_BUF_OFF=14に変更)へ'Hello from host!\\r\\n'を書いて+18=18を返す =="
build_one "c9r3" 2000 -DCMD_INIT=\$40 -DREC_MODE=1 -DC6_MODE=2 -DC6_SUB=3 -DC8_MODE=2 -DC9_MODE=1 -DREC_MAX=96 -DCMD_OPEN=\$4a -DCMD_READ=\$4c -DCMD_CLOSE=\$4b -DCMD_READ_BUF_OFF=14
build_device_variant "c9r3"
print_rec_offsets "c9r3"

echo "== 完了 =="
echo "$OUT_DIR/{c0,c1,c2,c1b,c3a,c3b,c6v1,c6v2,c6f1,c6f2,c6f3,c7d0,c7d1,c7d2,c8a,c8b,c9r1,c9r2,c9r3}.xdf を作成しました。"
