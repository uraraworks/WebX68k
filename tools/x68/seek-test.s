* ---------------------------------------------------------------------------
* WebX68k remote-probe C10 補助テスト (SEEKTST.X)
*
* C:\HELLO.TXT(remote-probeの偽ドライバが応答する3000バイトの偽ファイル)を
* 実際のDOSコール経由(_OPEN/_SEEK/_READ/_CLOSE)で開き、シークが届く要求
* (コマンド番号・ヘッダの意味)をremote-probe側の記録で観測するための道具。
* files-test.sの流儀(dc.w $ffXXでDOSコールを直接叩く)にならう。
*
* 呼び出し規約(PRO-68Kプログラマーズマニュアル、事実として使ってよいと
* 指示された内容。PDFページ=本のページ+14で確認済み):
*   _OPEN  ($FF3D, p.157): MOVE.W MODE,-(SP) / PEA NAMEPTR / DC.W _OPEN /
*                          ADDQ.L #6,SP    → D0.L ハンドル(負ならエラー)
*   _CLOSE ($FF3E, p.159): MOVE.W FILENO,-(SP) / DC.W _CLOSE / ADDQ.L #2,SP
*                          → D0.L (負ならエラー)
*   _READ  ($FF3F, p.160): MOVE.L SIZE,-(SP) / PEA DATAPTR /
*                          MOVE.W FILENO,-(SP) / DC.W _READ / LEA 10(SP),SP
*                          → D0.L 実際に読んだバイト数(負ならエラー)
*   _SEEK  ($FF42, p.163): MOVE.W MODE,-(SP) / MOVE.L OFFSET,-(SP) /
*                          MOVE.W FILENO,-(SP) / DC.W _SEEK / ADDQ.L #8,SP
*                          → D0.L 先頭からの現在位置(負ならエラー)
*                          MODE: 0=先頭から 1=現在位置から 2=ファイル末尾から
*   openのMODE: ビット1-0=00(読み込みモード)、ビット6-4=000(互換モード)
*               なので $0000 を使う。
*
* 手順:
*   1. C:\HELLO.TXT を読み込みモードで開く
*   2. _SEEK(位置0, mode2=末尾基準) → D0を表示(ファイルサイズが返るはず)
*   3. _SEEK(位置100, mode0=先頭基準) → D0を表示
*   4. 16バイト読んで、中身とD0を表示
*   5. 閉じる
* 各ステップの結果は画面に1行ずつ出す。AUTOEXEC.BATから直接実行する想定。
* ---------------------------------------------------------------------------

        section text

start:
* --- 1. open ---
        move.w  #0,-(sp)                * MODE = 読み込み・互換モード
        pea     nameptr(pc)
        dc.w    $ff3d                   * _OPEN
        addq.l  #6,sp
        move.l  d0,d6                   * d6 = ファイルハンドル(以後保持)

        lea     lineOpen(pc),a0
        move.l  d0,d1
        bsr     puthex8
        pea     lineOpenBuf(pc)
        dc.w    $ff09                   * _PRINT
        addq.l  #4,sp

        tst.l   d6
        bmi.w   allfail                 * open失敗なら以降を全部やらずに終了

* --- 2. seek(handle, 0, 2=末尾) ---
        move.w  #2,-(sp)                * MODE
        move.l  #0,-(sp)                * OFFSET
        move.w  d6,-(sp)                * FILENO
        dc.w    $ff42                   * _SEEK
        addq.l  #8,sp

        lea     lineSeekEnd(pc),a0
        move.l  d0,d1
        bsr     puthex8
        pea     lineSeekEndBuf(pc)
        dc.w    $ff09
        addq.l  #4,sp

* --- 3. seek(handle, 100, 0=先頭) ---
        move.w  #0,-(sp)                * MODE
        move.l  #100,-(sp)              * OFFSET
        move.w  d6,-(sp)                * FILENO
        dc.w    $ff42                   * _SEEK
        addq.l  #8,sp

        lea     lineSeek100(pc),a0
        move.l  d0,d1
        bsr     puthex8
        pea     lineSeek100Buf(pc)
        dc.w    $ff09
        addq.l  #4,sp

* --- 4. read(handle, readbuf, 16) ---
        move.l  #16,-(sp)               * SIZE
        pea     readbuf(pc)              * DATAPTR
        move.w  d6,-(sp)                 * FILENO
        dc.w    $ff3f                    * _READ
        lea     10(sp),sp

        lea     lineReadD0(pc),a0
        move.l  d0,d1
        bsr     puthex8

* 読めたぶんだけ(D0<0またはD0>16なら0扱い)テキストとして表示行へコピー
        move.l  d0,d2
        bmi.s   read_nbytes_zero
        cmp.l   #16,d2
        bls.s   read_nbytes_ok
read_nbytes_zero:
        moveq   #0,d2
read_nbytes_ok:
        lea     readbuf(pc),a1
        lea     lineReadData(pc),a0
        move.l  d2,d3
        beq.s   read_copy_done
        subq.l  #1,d3
read_copy_loop:
        move.b  (a1)+,(a0)+
        dbra    d3,read_copy_loop
read_copy_done:

        pea     lineReadBuf(pc)
        dc.w    $ff09
        addq.l  #4,sp

* --- 5. close ---
        move.w  d6,-(sp)
        dc.w    $ff3e                   * _CLOSE
        addq.l  #2,sp

        lea     lineClose(pc),a0
        move.l  d0,d1
        bsr     puthex8
        pea     lineCloseBuf(pc)
        dc.w    $ff09
        addq.l  #4,sp

allfail:
        pea     donemsg(pc)
        dc.w    $ff09
        addq.l  #4,sp

waitkey:
        dc.w    $ff0b                   * _KEYSNS
        tst.l   d0
        beq     waitkey

        dc.w    $ff00                   * _EXIT

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

nameptr:
        dc.b    "C:\HELLO.TXT",0

donemsg:
        dc.b    "done. Press any key to quit.",13,10,0

        even
readbuf:
        ds.b    16

        even
lineOpenBuf:
        dc.b    "OPEN D0="
lineOpen:
        dc.b    "00000000",13,10,0

        even
lineSeekEndBuf:
        dc.b    "SEEK(0,END) D0="
lineSeekEnd:
        dc.b    "00000000",13,10,0

        even
lineSeek100Buf:
        dc.b    "SEEK(100,SET) D0="
lineSeek100:
        dc.b    "00000000",13,10,0

        even
lineReadBuf:
        dc.b    "READ D0="
lineReadD0:
        dc.b    "00000000"," DATA=["
lineReadData:
        dcb.b   16,' '
        dc.b    "]",13,10,0

        even
lineCloseBuf:
        dc.b    "CLOSE D0="
lineClose:
        dc.b    "00000000",13,10,0

        even
