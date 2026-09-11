* ---------------------------------------------------------------------------
* WebX68k remote-probe C7 補助テスト (DSKFRETS.X)
*
* remote-probe.s の C7-D1/D2 で仮説「$56 = _DSKFRE ($FF36) の空き容量取得」を
* 検証するための最小プログラム。ドライブC:に対して _DSKFRE を呼び、D0.Lを
* 16進表示するだけ。RPROBE.SYS(REC_MODE=1)が記録する要求列を突き合わせて、
* dir c: が出さない $56 とは別に、_DSKFRE 自身がどのコマンドコードで
* ドライバへ届くかを確かめる。
*
* DOS _DSKFRE ($FF36): ドライブ番号(0=カレント,1=A:,2=B:,3=C:,...)をワードで
* スタックへ積んで呼ぶ(PRO-68Kマニュアルのドライブ番号の慣習に合わせた)。
* 資料(PRO-68K ver2.0 プログラマーズマニュアル p.150)によれば結果は8バイト
* (使用可能クラスタ数W/総クラスタ数W/1クラスタのセクタ数W/1セクタのバイト数W)
* で、D0.Lには使用可能バイト数が返る。ここではD0.Lだけを表示する
* (8バイト構造体の受け取り方は資料上不明瞭なため、まずD0だけ見る)。
*
* DOS コールは $FFxx が命令そのもの(Fライン例外)なので dc.w で直接埋め込む。
* mouse-test.s と同じ流儀(位置独立、hu_pack.pyで.X化)。
* ---------------------------------------------------------------------------

        section text

start:
        move.w  #3,-(sp)                * ドライブ3 = C:
        dc.w    $ff36                   * DOS _DSKFRE
        addq.l  #2,sp
        move.l  d0,d1                   * d1 = _DSKFRE の戻り値(D0.L)をそのまま表示用に退避

        lea     bufD0(pc),a0
        bsr     puthex8

        pea     msg(pc)
        dc.w    $ff09                   * DOS _PRINT
        addq.l  #4,sp

waitkey:
        dc.w    $ff0b                   * DOS _KEYSNS (0=入力なし)
        tst.l   d0
        beq     waitkey

        dc.w    $ff00                   * DOS _EXIT

* ---------------------------------------------------------------------------
* d1.l を8桁の16進文字列にして (a0) へ書く。破壊: d1-d3, a0, a1
* ---------------------------------------------------------------------------
puthex8:
        moveq   #7,d2
        lea     hextab(pc),a1
puthexl:
        rol.l   #4,d1
        move.w  d1,d3
        and.w   #$000f,d3
        move.b  (a1,d3.w),(a0)+
        dbra    d2,puthexl
        rts

hextab:
        dc.b    "0123456789ABCDEF"

msg:
        dc.b    13,"_DSKFRE(drive=3) D0.L="
bufD0:  dc.b    "00000000"
        dc.b    13,10
        dc.b    "Press any key to quit.",13,10,0

        even
