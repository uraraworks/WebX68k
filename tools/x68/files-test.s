* ---------------------------------------------------------------------------
* WebX68k remote-probe C7 補助テスト (FILESTST.X) - 修正版
*
* dir(COMMAND.X)がファイル行を出さない原因が、DOS層(_FILES/_NFILES)まで
* HELLO.TXT/WORLD.DOCが届いていないからなのか、それとも届いた上でdir側が
* 表示しないだけなのかを切り分けるための最小プログラム。
*
* 呼び出し規約(PRO-68Kマニュアル p.183/p.185、事実として使ってよいと
* 指示された内容):
*   _FILES  ($FF4E): MOVE.W ATR,-(SP) / PEA NAMEPTR / PEA FILBUF /
*                     DC.W $FF4E / LEA 10(SP),SP
*   _NFILES ($FF4F): PEA FILBUF / DC.W $FF4F / ADDQ.L #4,SP
*     (前版は_NFILESを引数無しで呼んでいた誤りがあり、これが原因で
*      2回目以降が届かずアドレスエラーになった。今版で修正)
* 戻り値はどちらもD0.L(負ならDOSエラー。-2=ファイル無し、-18=もう無い)。
*
* 検索属性を2フェーズで振る: フェーズ0=$20(ボリューム属性を含めない、
* 素のファイル検索)、フェーズ1=$35(dirの実測と同じ値)。各フェーズ
* 5ラウンド(1回目=_FILES、2〜5回目=_NFILES)実行し、各回D0.Lと
* FILBUF+30(名前23バイト)を1行表示する。D0が負になったら次のフェーズへ。
*
* D0はFFxxコール直後、他の命令を挟まずただちにd6へ退避してから表示処理へ
* 渡す(表示ルーチン内でD0(またはd6)を書き換えていないことをここで保証)。
* ---------------------------------------------------------------------------

        section text

start:
        moveq   #0,d5                   * フェーズ番号(0=attr$20, 1=attr$35)

phaseloop:
        moveq   #$20,d4
        tst.l   d5
        beq.s   attrset
        moveq   #$35,d4
attrset:
        moveq   #0,d7                    * ラウンド番号(0始まり)

roundloop:
        tst.l   d7
        bne.s   do_nfiles

* --- ラウンド0: _FILES(attr=d4, "C:\*.*", filbuf) ---
        move.w  d4,-(sp)                 * 属性
        pea     pattern(pc)              * ファイル名パターンへのポインタ
        lea     filbuf(pc),a0
        move.l  a0,-(sp)                 * FILBUFへのポインタ
        dc.w    $ff4e                    * DOS _FILES
        lea     10(sp),sp                * 2L+1W=10バイト分戻す
        move.l  d0,d6                    * ← 他命令を挟まず直後に退避
        bra.s   after_call

do_nfiles:
        lea     filbuf(pc),a0
        pea     (a0)                     * FILBUFへのポインタ
        dc.w    $ff4f                    * DOS _NFILES
        addq.l  #4,sp
        move.l  d0,d6                    * ← 他命令を挟まず直後に退避

after_call:
* --- 表示行を組み立てる: "P<n> R<n> ATTR=xx D0=xxxxxxxx NAME=<23バイト>" ---
        lea     lineP(pc),a0
        move.b  d5,d1
        addi.b  #'0',d1
        move.b  d1,(a0)

        lea     lineR(pc),a0
        move.b  d7,d1
        addi.b  #'0',d1
        move.b  d1,(a0)

        lea     lineAttr(pc),a0
        move.b  d4,d1
        bsr     puthex2

        move.l  d6,d1
        lea     lineD0(pc),a0
        bsr     puthex8

        lea     filbuf(pc),a1
        lea     30(a1),a1                * FILBUF+30 = 名前23バイト
        lea     lineName(pc),a0
        moveq   #23-1,d2
copyname:
        move.b  (a1)+,(a0)+
        dbra    d2,copyname
* lineNameの直後には固定で13,10,0を置いてあるので、ここでは0終端を書かない
* (書くとCRを潰して行が繋がってしまう)。

        pea     lineBuf(pc)
        dc.w    $ff09                    * DOS _PRINT
        addq.l  #4,sp

        addq.l  #1,d7
        cmp.l   #5,d7
        bge.s   phase_done
        tst.l   d6
        bmi.s   phase_done
        bra.w   roundloop

phase_done:
        addq.l  #1,d5
        cmp.l   #2,d5
        blt.w   phaseloop

        pea     donemsg(pc)
        dc.w    $ff09                    * DOS _PRINT
        addq.l  #4,sp

waitkey:
        dc.w    $ff0b                    * DOS _KEYSNS (0=入力なし)
        tst.l   d0
        beq     waitkey

        dc.w    $ff00                    * DOS _EXIT

* ---------------------------------------------------------------------------
* d1.l を8桁の16進文字列にして (a0) へ書く。破壊: d1-d3, a0, a1
* ---------------------------------------------------------------------------
puthex8:
        moveq   #7,d2
        bra.s   puthexn
* d1.b を2桁の16進文字列にして (a0) へ書く。破壊: d1-d3, a0, a1
puthex2:
        and.l   #$000000ff,d1
        moveq   #1,d2
puthexn:
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

pattern:
        dc.b    "C:\*.*",0

donemsg:
        dc.b    "done. Press any key to quit.",13,10,0

        even
* --- 1行分の表示バッファ("Pn Rn ATTR=xx D0=xxxxxxxx NAME=<23>" + CRLF + 0) ---
lineBuf:
lineP:  dc.b    "0"," R"
lineR:  dc.b    "0"," ATTR="
lineAttr:
        dc.b    "00"," D0="
lineD0: dc.b    "00000000"," NAME="
lineName:
        dcb.b   23,0
        dc.b    13,10,0

        even
* --- FILBUF実体(53バイト、_FILES/_NFILESが書き込む) ---
filbuf:
        ds.b    53

        even
