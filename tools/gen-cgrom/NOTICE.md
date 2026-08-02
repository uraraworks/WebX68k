# CGROM.DAT 生成に使用したフォント素材

## 東雲フォント (Shinonome Font Family)

- 配布元: The Electronic Font Open Laboratory (efont プロジェクト)
  - トップページ: http://openlab.ring.gr.jp/efont/shinonome/
  - 配布アーカイブ: http://openlab.ring.gr.jp/efont/dist/shinonome/shinonome-0.9.11p1.tar.bz2
- ライセンス: Public Domain (同梱の `LICENSE` ファイルに「実質的に Public Domain」との明記あり。
  一部書体の意匠は XFree86 の `jiskanji16` を参考にしているとのコメントが `shnmk16.bdf` 内にあるが、
  同フォントも配布上は自由に再配布・改変可能なオープンなビットマップフォント)
- 原著作者: Yasuyuki Furukawa 氏による原案。efont プロジェクトが維持・配布。

このリポジトリでは、以下のファイルを `tools/gen-cgrom/generate.js` の入力として使用した
(いずれも `shinonome-0.9.11/bdf/` 配下、フォント原本(.bdf)自体はリポジトリにコミットしていない。
`node tools/gen-cgrom/fetch-fonts.js` で都度取得する):

| 用途 | ソースBDF | サイズ | 備考 |
|---|---|---|---|
| CGROM 漢字16x16 (0xF00000) | shnmk16.bdf | 16x16 | JISX0208.1983 ゴシック体、そのまま使用 |
| CGROM 漢字24x24 (0xF40000) | shnmk16.bdf | 16x16→24x24 | 不足サイズのため最近傍(nearest-neighbor)拡大 |
| CGROM ANK 8x8 (0xF3A000) | shnm8x16r.bdf | 8x16→8x8 | 不足サイズのため最近傍縮小 |
| CGROM ANK 8x16 (0xF3A800) | shnm8x16r.bdf | 8x16 | JISX0201.1976 ゴシック体、そのまま使用 |
| CGROM ANK 12x12 (0xF3B800) | shnm6x12r.bdf | 6x12→12x12 | 不足サイズのため横方向のみ最近傍2倍拡大 |
| CGROM ANK 12x24 (0xF3D000) | shnm8x16r.bdf | 8x16→12x24 | 不足サイズのため最近傍1.5倍拡大 |

## CGROM レイアウト仕様の出典

CGROM.DAT 内部のアドレスレイアウト(各文字サイズのオフセット、区点コードの並び順、
1文字あたりのビット配置)は、px68k-libretro のソース自体には記載がないため、
標準的なX68000エミュレータである XEiJ (X68000 Emulator in Java, 作者: Makoto Kamada /
Studio KAMADA, http://stdkmd.net/xeij/) の公開ソースコード `XEiJ.java` を一次情報として
裏取りした。

- `FNT_ADDRESS_KNJ16X16 = 0x00f00000`
- `FNT_ADDRESS_ANK8X8   = 0x00f3a000`
- `FNT_ADDRESS_ANK8X16  = 0x00f3a800`
- `FNT_ADDRESS_ANK12X12 = 0x00f3b800`
- `FNT_ADDRESS_ANK12X24 = 0x00f3d000`
- `FNT_ADDRESS_KNJ24X24 = 0x00f40000`
- 漢字ブロックは「1区〜8区(非漢字752字)→16区〜84区(第1・第2水準漢字6486字)」の順で
  区点コード順に連続配置(9〜15区はスキップ)。区点→アドレスの変換や、
  `romCreateFont()` 内のビット詰め処理(各行 MSBファースト・左詰め、
  `step = ceil(width/8)` バイト/行)から、CGROM内の1文字ごとのバイナリ表現を確定した。

XEiJ 本体および CGROM_XEiJ.DAT はこのリポジトリには含まれていない
(参照したのは公開されているソースコードのアドレス定数・アルゴリズムのみ)。
