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

位置独立に書いたコードを前提とするため、再配置テーブルとシンボルは空にする。
"""

import argparse
import struct
import sys


def build_x(text: bytes, *, base: int = 0, exec_offset: int = 0, bss: int = 0) -> bytes:
    header = bytearray(64)
    header[0:2] = b"HU"
    struct.pack_into(">I", header, 0x04, base)
    struct.pack_into(">I", header, 0x08, exec_offset)
    struct.pack_into(">I", header, 0x0C, len(text))
    struct.pack_into(">I", header, 0x10, 0)  # data
    struct.pack_into(">I", header, 0x14, bss)
    struct.pack_into(">I", header, 0x18, 0)  # reloc（位置独立なので不要）
    struct.pack_into(">I", header, 0x1C, 0)  # symbol
    return bytes(header) + text


def main() -> int:
    ap = argparse.ArgumentParser(description="raw binary を Human68k の .X 形式へ包む")
    ap.add_argument("input", help="vasm -Fbin が出力した生バイナリ")
    ap.add_argument("output", help="出力する .X ファイル")
    ap.add_argument("--bss", type=lambda s: int(s, 0), default=0, help="bss サイズ")
    ap.add_argument("--exec", dest="exec_offset", type=lambda s: int(s, 0), default=0,
                    help="実行開始アドレス(text 先頭からのオフセット)")
    args = ap.parse_args()

    with open(args.input, "rb") as f:
        text = f.read()
    with open(args.output, "wb") as f:
        f.write(build_x(text, exec_offset=args.exec_offset, bss=args.bss))

    print(f"{args.output}: text={len(text)} bytes, total={len(text) + 64} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
