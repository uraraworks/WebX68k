#!/usr/bin/env python3
"""生バイナリに Human68k 実行ファイル(.X)のヘッダを被せる。

ヘッダ(64バイト)の構造はディスク同梱の実物(FLOAT2.X / IOCS.X / CONFIGED.X)を
解析して確定させた。FLOAT2.X で
    64 + text(0x5174) + data(0x1c) + reloc(0x488) + symbol(0) = 22104
がディレクトリエントリのファイルサイズと完全一致することを確認済み。

    0x00  'HU' + 0x00 0x00
    0x04  ベースアドレス      (4B BE)
    0x08  実行開始アドレス    (4B BE)
    0x0C  text サイズ         (4B BE)
    0x10  data サイズ         (4B BE)
    0x14  bss サイズ          (4B BE)
    0x18  再配置テーブルサイズ(4B BE)
    0x1C  シンボルサイズ      (4B BE)
    0x20  予約(ゼロ埋め)

位置独立に書いたコードを前提とするため、既定では再配置テーブルとシンボルは空にする。

--- 再配置テーブルの形式(2026-09-11追記) ---

vasm 2.0f の `-Fxfile` 出力モジュールは、実際に Human68k のローダーに正しく
再配置してもらえないことを実測で確認した(reloc-test.s: `move.l #label,d0` を
実行した結果、D0 にファイル内オフセットの生値がそのまま入り、ロードベースが
加算されていなかった)。デバイスドライバ(remote-probe.s)のヘッダでこれを使うと
ストラテジ/インタラプト入口が不正な番地のままになり、Human68k 側で他のドライバの
登録まで巻き添えで壊れる実測もあった(OPMDRV3.Xの登録失敗・起動停止)。

そこで、再配置テーブルの実際の形式を、同梱の human302.xdf に入っている本物の
デバイスドライバ RSDRV.SYS(SYSフォルダ配下, AUX: シリアルドライバ)のヘッダと
再配置テーブルから構造だけ読み取って確定させた(コードの逆アセンブルはしていない。
ヘッダの整数フィールドと再配置テーブルの生バイト列を見ただけ)。

RSDRV.SYS の再配置テーブル(250バイト=125ワード)を16bitビッグエンディアンの
ワード列として読み、先頭から累積和を取ると
    0, 6, 10, 22, 28, 32, 48, 54, 58, 74, ...
となった。これはデバイスドライバヘッダの先頭3つの4バイトフィールド、
すなわち +0(次ヘッダへのリンク) / +6(ストラテジ入口) / +10(インタラプト入口)
の text 先頭からのバイトオフセットと完全に一致する(以降の値もその後の
コード中の絶対ロング参照と見られる)。よって形式は:

    再配置テーブル = 16bitワードの列(ビッグエンディアン)。各ワードは
    「直前の再配置対象からのバイト差分」で、1本目は0からの差分(=絶対オフセット)。
    累積和が、再配置対象の4バイト値が text 先頭から何バイト目にあるかを示す。
    テーブルの長さはヘッダの再配置テーブルサイズ欄(バイト数)で決まり、
    終端記号は無い(実測したRSDRV.SYSのテーブル長は125ワードちょうどで、
    末尾に0xFFFF等の番兵は見当たらなかった)。

remote-probe.s では link フィールド(+0)を $FFFFFFFF(最後)のまま再配置対象に
含めず、+6(ストラテジ)と+10(インタラプト)の2箇所だけを再配置対象にする
(--reloc=6,10)。
"""

import argparse
import struct
import sys


def build_reloc_table(offsets: list[int]) -> bytes:
    """text先頭からのバイトオフセットの列(昇順)を、累積差分ワード列へ変換する。"""
    words = bytearray()
    prev = 0
    for off in sorted(offsets):
        delta = off - prev
        if delta < 0 or delta > 0xFFFF:
            raise ValueError(f"再配置オフセットの差分が16bitに収まりません: {off}")
        words += struct.pack(">H", delta)
        prev = off
    return bytes(words)


def build_x(text: bytes, *, base: int = 0, exec_offset: int = 0, bss: int = 0,
            reloc_offsets: list[int] | None = None) -> bytes:
    reloc = build_reloc_table(reloc_offsets) if reloc_offsets else b""
    header = bytearray(64)
    header[0:2] = b"HU"
    struct.pack_into(">I", header, 0x04, base)
    struct.pack_into(">I", header, 0x08, exec_offset)
    struct.pack_into(">I", header, 0x0C, len(text))
    struct.pack_into(">I", header, 0x10, 0)  # data
    struct.pack_into(">I", header, 0x14, bss)
    struct.pack_into(">I", header, 0x18, len(reloc))
    struct.pack_into(">I", header, 0x1C, 0)  # symbol
    return bytes(header) + text + reloc


def main() -> int:
    ap = argparse.ArgumentParser(description="raw binary を Human68k の .X 形式へ包む")
    ap.add_argument("input", help="vasm -Fbin が出力した生バイナリ")
    ap.add_argument("output", help="出力する .X ファイル")
    ap.add_argument("--bss", type=lambda s: int(s, 0), default=0, help="bss サイズ")
    ap.add_argument("--exec", dest="exec_offset", type=lambda s: int(s, 0), default=0,
                    help="実行開始アドレス(text 先頭からのオフセット)")
    ap.add_argument("--reloc", default="",
                    help="再配置が要る4バイト値の、text先頭からのバイトオフセットをカンマ区切りで"
                         "(例: --reloc=6,10)。未指定なら再配置テーブル無し(位置独立コード用)。")
    args = ap.parse_args()

    reloc_offsets = [int(s, 0) for s in args.reloc.split(",") if s.strip() != ""]

    with open(args.input, "rb") as f:
        text = f.read()
    with open(args.output, "wb") as f:
        f.write(build_x(text, exec_offset=args.exec_offset, bss=args.bss, reloc_offsets=reloc_offsets))

    print(f"{args.output}: text={len(text)} bytes, reloc={len(reloc_offsets)}件, "
          f"total={len(text) + 64 + len(build_reloc_table(reloc_offsets))} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
