* ---------------------------------------------------------------------------
* reloc-test.s -- vasm -Fxfile の再配置がHuman68kの.Xローダーで実際に効くかを
* 確かめるだけの最小プログラム。RPROBE.SYSの調査(remote-probe.s)の前段階の
* 切り分け用。
*
* label の絶対アドレスを即値としてD0へロードし(要再配置)、その値を
* result(PC相対の自前領域)へ書いてから無限ループで止まる。
* --dump/--peek で result を覗けば、再配置が効いたか(実行時アドレス)
* 効いていないか(ファイル内オフセットの生値)が分かる。
* ---------------------------------------------------------------------------
        section text

start:
        move.l  #label,d0       * 要再配置(絶対ロング)
        lea     result(pc),a0
        move.l  d0,(a0)
loop:
        bra.s   loop

result:
        dc.l    0
label:
        dc.l    $deadbeef
