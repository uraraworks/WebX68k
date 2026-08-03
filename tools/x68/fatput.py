#!/usr/bin/env python3
"""FD イメージ(FAT12)のルートディレクトリへファイルを1つ書き込む。

ブラウザ側にも同等の実装(src/api/fat.ts)があるが、ビルドのたびにブラウザを
開かずに済むよう、ホスト用の最小版を用意する。X68000 の 2HD は 1024バイト/セクタ
だが、ジオメトリは BPB から読むので PC-98 等の他フォーマットでも動く。

使い方:
    python3 fatput.py disk.xdf MOUSETST.X ./build/mouse-test.x
"""

import argparse
import struct
import sys
import time


class Fat12:
    def __init__(self, image: bytearray):
        self.img = image
        self.bps = struct.unpack_from("<H", image, 11)[0]
        self.spc = image[13]
        self.reserved = struct.unpack_from("<H", image, 14)[0]
        self.num_fats = image[16]
        self.root_entries = struct.unpack_from("<H", image, 17)[0]
        self.spf = struct.unpack_from("<H", image, 22)[0]
        if self.bps == 0 or self.spc == 0 or self.spf == 0:
            raise ValueError("BPB が壊れているか FAT イメージではありません")

        self.fat_start = self.reserved * self.bps
        self.root_start = self.fat_start + self.num_fats * self.spf * self.bps
        self.data_start = self.root_start + self.root_entries * 32
        self.cluster_bytes = self.spc * self.bps
        self.total_clusters = (len(image) - self.data_start) // self.cluster_bytes + 2

    # ---- FAT12 エントリ ----
    def get_fat(self, n: int) -> int:
        i = self.fat_start + n * 3 // 2
        v = self.img[i] | (self.img[i + 1] << 8)
        return (v >> 4) if (n & 1) else (v & 0xFFF)

    def set_fat(self, n: int, value: int) -> None:
        for fat in range(self.num_fats):
            base = self.fat_start + fat * self.spf * self.bps
            i = base + n * 3 // 2
            v = self.img[i] | (self.img[i + 1] << 8)
            v = ((v & 0x000F) | (value << 4)) if (n & 1) else ((v & 0xF000) | value)
            self.img[i] = v & 0xFF
            self.img[i + 1] = (v >> 8) & 0xFF

    def free_clusters(self, count: int) -> list[int]:
        found = []
        for c in range(2, self.total_clusters):
            if self.get_fat(c) == 0:
                found.append(c)
                if len(found) == count:
                    return found
        raise RuntimeError(f"空きクラスタが足りません(必要 {count})")

    def cluster_offset(self, c: int) -> int:
        return self.data_start + (c - 2) * self.cluster_bytes

    # ---- ルートディレクトリ ----
    def find_entry(self, name11: bytes) -> int | None:
        for i in range(self.root_entries):
            off = self.root_start + i * 32
            if self.img[off:off + 11] == name11:
                return off
        return None

    def free_entry(self) -> int:
        for i in range(self.root_entries):
            off = self.root_start + i * 32
            if self.img[off] in (0x00, 0xE5):
                return off
        raise RuntimeError("ルートディレクトリに空きがありません")

    def put_file(self, name: str, data: bytes) -> None:
        name11 = to_8_3(name)
        needed = max(1, -(-len(data) // self.cluster_bytes))

        # 同名ファイルがあれば、そのチェーンを解放してから書き直す
        existing = self.find_entry(name11)
        if existing is not None:
            c = struct.unpack_from("<H", self.img, existing + 26)[0]
            while 2 <= c < 0xFF8:
                nxt = self.get_fat(c)
                self.set_fat(c, 0)
                c = nxt
            entry_off = existing
        else:
            entry_off = self.free_entry()

        clusters = self.free_clusters(needed)
        for i, c in enumerate(clusters):
            chunk = data[i * self.cluster_bytes:(i + 1) * self.cluster_bytes]
            off = self.cluster_offset(c)
            self.img[off:off + self.cluster_bytes] = chunk.ljust(self.cluster_bytes, b"\x00")
            self.set_fat(c, clusters[i + 1] if i + 1 < len(clusters) else 0xFFF)

        now = time.localtime()
        dos_time = (now.tm_hour << 11) | (now.tm_min << 5) | (now.tm_sec // 2)
        dos_date = ((now.tm_year - 1980) << 9) | (now.tm_mon << 5) | now.tm_mday

        entry = bytearray(32)
        entry[0:11] = name11
        entry[11] = 0x20  # アーカイブ属性
        struct.pack_into("<H", entry, 22, dos_time)
        struct.pack_into("<H", entry, 24, dos_date)
        struct.pack_into("<H", entry, 26, clusters[0])
        struct.pack_into("<I", entry, 28, len(data))
        self.img[entry_off:entry_off + 32] = entry


def to_8_3(name: str) -> bytes:
    stem, _, ext = name.upper().partition(".")
    if len(stem) > 8 or len(ext) > 3:
        raise ValueError(f"8.3 形式に収まりません: {name}")
    return (stem.ljust(8) + ext.ljust(3)).encode("ascii")


def main() -> int:
    ap = argparse.ArgumentParser(description="FD イメージのルートへファイルを書き込む")
    ap.add_argument("image", help="書き込み先のディスクイメージ(直接書き換える)")
    ap.add_argument("name", help="ディスク上のファイル名(8.3形式)")
    ap.add_argument("source", help="書き込むファイル")
    args = ap.parse_args()

    with open(args.image, "rb") as f:
        img = bytearray(f.read())
    with open(args.source, "rb") as f:
        data = f.read()

    fs = Fat12(img)
    fs.put_file(args.name, data)

    with open(args.image, "wb") as f:
        f.write(img)

    print(f"{args.image}: {args.name} を書き込みました ({len(data)} bytes, "
          f"{fs.bps}B/sector)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
