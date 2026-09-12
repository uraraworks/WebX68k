* ---------------------------------------------------------------------------
* WebX68k remote-probe C12 補助テスト (WRITETST.X)
*
* remote-probe(RPROBE.SYS、C12条件)のC:ドライブに対して、書き込み系のDOS
* コールを実際に発行し、どのコマンド番号でドライバに届くかを観測するための
* 道具。files-test.s/seek-test.sの流儀(dc.w $ffXXでDOSコールを直接叩く)に
* ならう。
*
* 呼び出し規約(PRO-68Kプログラマーズマニュアル、事実として使ってよいと
* 指示された内容。PDFページ=本のページ+14で確認済み):
*   _MKDIR    ($FF39, p.153): PEA NAMEPTR / DC.W _MKDIR / ADDQ.L #4,SP
*                             → D0.L (負ならエラー)
*   _RMDIR    ($FF3A, p.154): PEA NAMEPTR / DC.W _RMDIR / ADDQ.L #4,SP
*                             → D0.L (負ならエラー)
*   _CREATE   ($FF3C, p.156): MOVE.W ATR,-(SP) / PEA NAMEPTR / DC.W _CREATE /
*                             ADDQ.L #6,SP    → D0.L ハンドル(負ならエラー)
*   _OPEN     ($FF3D, p.157): MOVE.W MODE,-(SP) / PEA NAMEPTR / DC.W _OPEN /
*                             ADDQ.L #6,SP    → D0.L ハンドル(負ならエラー)
*                             MODE=2: ビット1-0=10(読み書き)、他0(互換モード)
*   _CLOSE    ($FF3E, p.159): MOVE.W FILENO,-(SP) / DC.W _CLOSE / ADDQ.L #2,SP
*   _WRITE    ($FF40, p.161): MOVE.L SIZE,-(SP) / PEA DATAPTR /
*                             MOVE.W FILENO,-(SP) / DC.W _WRITE / LEA 10(SP),SP
*                             → D0.L 実際に書けたバイト数(負ならエラー)
*                             (注意: スタック10バイト使うのでADDQ.Lでは戻せ
*                             ない。LEAで戻すこと、とマニュアルに明記あり)
*   _DELETE   ($FF41, p.162): PEA NAMEPTR / DC.W _DELETE / ADDQ.L #4,SP
*   _SEEK     ($FF42, p.163): MOVE.W MODE,-(SP) / MOVE.L OFFSET,-(SP) /
*                             MOVE.W FILENO,-(SP) / DC.W _SEEK / ADDQ.L #8,SP
*                             MODE: 0=先頭 1=現在位置 2=末尾
*   _CHMOD    ($FF43, p.164): MOVE.W ATR,-(SP) / PEA NAMEPTR / DC.W _CHMOD /
*                             ADDQ.L #6,SP    ATR=-1で現在の属性をD0.Lへ取得
*   _RENAME   ($FF56, p.194): PEA NEW / PEA OLD / DC.W _RENAME / ADDQ.L #8,SP
*   _FILEDATE ($FF57, p.195): MOVE.L DATETIME,-(SP) / MOVE.W FILENO,-(SP) /
*                             DC.W _FILEDATE / ADDQ.L #6,SP
*                             DATETIME=0で現在の日時をD0.Lへ取得、それ以外は
*                             設定(上位ワード=年月日、下位ワード=時分秒/2)
*   _NEWFILE  ($FF5B, p.199): MOVE.W ATR,-(SP) / PEA NAMEPTR / DC.W _NEWFILE /
*                             ADDQ.L #6,SP    既存ファイルなら-80を返す
*
* 手順(各ステップの結果=D0を1行ずつ表示する。途中で失敗しても次へ進む):
*   1. CREATE(C:\NEW.TXT, $20)                 → ハンドルをd6へ保持
*   2. WRITE(d6, "hello write\r\n", 13)
*   3. CLOSE(d6)
*   4. OPEN(C:\NEW.TXT, mode=2)                → ハンドルをd6へ保持
*   5. SEEK(d6, 0, mode=2=末尾)
*   6. WRITE(d6, "more\r\n", 6)
*   7. CLOSE(d6)
*   8. FILEDATE(d6, 0=取得) / FILEDATE(d6, 固定値=設定)
*   9. CHMOD(C:\NEW.TXT, -1=取得) / CHMOD(C:\NEW.TXT, $21=設定)
*  10. RENAME(C:\NEW.TXT -> C:\RENAMED.TXT)
*  11. DELETE(C:\RENAMED.TXT)
*  12. MKDIR(C:\NEWDIR)
*  13. RMDIR(C:\NEWDIR)
*  14. NEWFILE(C:\HELLO.TXT, $20)              → 既存ファイルなので-80のはず
* AUTOEXEC.BATから直接実行する想定。
* ---------------------------------------------------------------------------

        section text

start:
* --- 1. _CREATE("C:\NEW.TXT", $20) ---
        move.w  #$0020,-(sp)
        pea     nameNew(pc)
        dc.w    $ff3c                   * _CREATE
        addq.l  #6,sp
        move.l  d0,d6                   * d6 = ファイルハンドル(以後使い回す)

        lea     lineCreate(pc),a0
        move.l  d0,d1
        lea     lineCreateBuf(pc),a2
        bsr.w   report

* --- 2. _WRITE(d6, "hello write\r\n", 13) ---
        move.l  #13,-(sp)
        pea     wbuf1(pc)
        move.w  d6,-(sp)
        dc.w    $ff40                   * _WRITE
        lea     10(sp),sp

        lea     lineWrite1(pc),a0
        move.l  d0,d1
        lea     lineWrite1Buf(pc),a2
        bsr.w   report

* --- 3. _CLOSE(d6) ---
        move.w  d6,-(sp)
        dc.w    $ff3e                   * _CLOSE
        addq.l  #2,sp

        lea     lineClose1(pc),a0
        move.l  d0,d1
        lea     lineClose1Buf(pc),a2
        bsr.w   report

* --- 4. _OPEN("C:\NEW.TXT", mode=2=読み書き) ---
        move.w  #2,-(sp)
        pea     nameNew(pc)
        dc.w    $ff3d                   * _OPEN
        addq.l  #6,sp
        move.l  d0,d6

        lea     lineOpen(pc),a0
        move.l  d0,d1
        lea     lineOpenBuf(pc),a2
        bsr.w   report

* --- 5. _SEEK(d6, 0, mode=2=末尾) ---
        move.w  #2,-(sp)
        move.l  #0,-(sp)
        move.w  d6,-(sp)
        dc.w    $ff42                   * _SEEK
        addq.l  #8,sp

        lea     lineSeek(pc),a0
        move.l  d0,d1
        lea     lineSeekBuf(pc),a2
        bsr.w   report

* --- 6. _WRITE(d6, "more\r\n", 6) ---
        move.l  #6,-(sp)
        pea     wbuf2(pc)
        move.w  d6,-(sp)
        dc.w    $ff40                   * _WRITE
        lea     10(sp),sp

        lea     lineWrite2(pc),a0
        move.l  d0,d1
        lea     lineWrite2Buf(pc),a2
        bsr.w   report

* --- 7. _CLOSE(d6) ---
        move.w  d6,-(sp)
        dc.w    $ff3e                   * _CLOSE
        addq.l  #2,sp

        lea     lineClose2(pc),a0
        move.l  d0,d1
        lea     lineClose2Buf(pc),a2
        bsr.w   report

* --- 8a. _FILEDATE(d6, 0) 取得 ---
        move.l  #0,-(sp)
        move.w  d6,-(sp)
        dc.w    $ff57                   * _FILEDATE
        addq.l  #6,sp

        lea     lineFiledateGet(pc),a0
        move.l  d0,d1
        lea     lineFiledateGetBuf(pc),a2
        bsr.w   report

* --- 8b. _FILEDATE(d6, 固定値) 設定(2026-09-11 12:34:56。fake_fileと同じ
* 値を流用。上位ワード=日付$5d2b、下位ワード=時刻$645c) ---
        move.l  #$5d2b645c,-(sp)
        move.w  d6,-(sp)
        dc.w    $ff57                   * _FILEDATE
        addq.l  #6,sp

        lea     lineFiledateSet(pc),a0
        move.l  d0,d1
        lea     lineFiledateSetBuf(pc),a2
        bsr.w   report

* --- 9a. _CHMOD("C:\NEW.TXT", -1) 取得 ---
        move.w  #-1,-(sp)
        pea     nameNew(pc)
        dc.w    $ff43                   * _CHMOD
        addq.l  #6,sp

        lea     lineChmodGet(pc),a0
        move.l  d0,d1
        lea     lineChmodGetBuf(pc),a2
        bsr.w   report

* --- 9b. _CHMOD("C:\NEW.TXT", $21) 設定 ---
        move.w  #$0021,-(sp)
        pea     nameNew(pc)
        dc.w    $ff43                   * _CHMOD
        addq.l  #6,sp

        lea     lineChmodSet(pc),a0
        move.l  d0,d1
        lea     lineChmodSetBuf(pc),a2
        bsr.w   report

* --- 10. _RENAME("C:\NEW.TXT" -> "C:\RENAMED.TXT") ---
        pea     nameRenamed(pc)
        pea     nameNew(pc)
        dc.w    $ff56                   * _RENAME
        addq.l  #8,sp

        lea     lineRename(pc),a0
        move.l  d0,d1
        lea     lineRenameBuf(pc),a2
        bsr.w   report

* --- 11. _DELETE("C:\RENAMED.TXT") ---
        pea     nameRenamed(pc)
        dc.w    $ff41                   * _DELETE
        addq.l  #4,sp

        lea     lineDelete(pc),a0
        move.l  d0,d1
        lea     lineDeleteBuf(pc),a2
        bsr.w   report

* --- 12. _MKDIR("C:\NEWDIR") ---
        pea     nameNewdir(pc)
        dc.w    $ff39                   * _MKDIR
        addq.l  #4,sp

        lea     lineMkdir(pc),a0
        move.l  d0,d1
        lea     lineMkdirBuf(pc),a2
        bsr.w   report

* --- 13. _RMDIR("C:\NEWDIR") ---
        pea     nameNewdir(pc)
        dc.w    $ff3a                   * _RMDIR
        addq.l  #4,sp

        lea     lineRmdir(pc),a0
        move.l  d0,d1
        lea     lineRmdirBuf(pc),a2
        bsr.w   report

* --- 14. _NEWFILE("C:\HELLO.TXT", $20) (既存ファイルなので-80のはず) ---
        move.w  #$0020,-(sp)
        pea     nameHello(pc)
        dc.w    $ff5b                   * _NEWFILE
        addq.l  #6,sp

        lea     lineNewfile(pc),a0
        move.l  d0,d1
        lea     lineNewfileBuf(pc),a2
        bsr.w   report

        pea     donemsg(pc)
        dc.w    $ff09
        addq.l  #4,sp

waitkey:
        dc.w    $ff0b                   * _KEYSNS
        tst.l   d0
        beq     waitkey

        dc.w    $ff00                   * _EXIT

* ---------------------------------------------------------------------------
* report -- 1行分の結果表示。呼び出し前提: a0=行内の8桁16進フィールドの
* 先頭、a2=_PRINTへ渡す行全体の先頭、d1=表示する値(D0をそのまま渡す)。
* 破壊: d1-d3, a0, a1
* ---------------------------------------------------------------------------
report:
        bsr.w   puthex8
        move.l  a2,-(sp)
        dc.w    $ff09                   * _PRINT
        addq.l  #4,sp
        rts

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

        even
nameNew:
        dc.b    "C:\NEW.TXT",0
        even
nameRenamed:
        dc.b    "C:\RENAMED.TXT",0
        even
nameNewdir:
        dc.b    "C:\NEWDIR",0
        even
nameHello:
        dc.b    "C:\HELLO.TXT",0

        even
wbuf1:
        dc.b    "hello write",13,10    * 13バイト
        even
wbuf2:
        dc.b    "more",13,10           * 6バイト

        even
donemsg:
        dc.b    "done. Press any key to quit.",13,10,0

        even
lineCreateBuf:
        dc.b    "01 CREATE       D0="
lineCreate:
        dc.b    "00000000",13,10,0

        even
lineWrite1Buf:
        dc.b    "02 WRITE#1      D0="
lineWrite1:
        dc.b    "00000000",13,10,0

        even
lineClose1Buf:
        dc.b    "03 CLOSE#1      D0="
lineClose1:
        dc.b    "00000000",13,10,0

        even
lineOpenBuf:
        dc.b    "04 OPEN         D0="
lineOpen:
        dc.b    "00000000",13,10,0

        even
lineSeekBuf:
        dc.b    "05 SEEK(END)    D0="
lineSeek:
        dc.b    "00000000",13,10,0

        even
lineWrite2Buf:
        dc.b    "06 WRITE#2      D0="
lineWrite2:
        dc.b    "00000000",13,10,0

        even
lineClose2Buf:
        dc.b    "07 CLOSE#2      D0="
lineClose2:
        dc.b    "00000000",13,10,0

        even
lineFiledateGetBuf:
        dc.b    "08 FILEDATE-GET D0="
lineFiledateGet:
        dc.b    "00000000",13,10,0

        even
lineFiledateSetBuf:
        dc.b    "08 FILEDATE-SET D0="
lineFiledateSet:
        dc.b    "00000000",13,10,0

        even
lineChmodGetBuf:
        dc.b    "09 CHMOD-GET    D0="
lineChmodGet:
        dc.b    "00000000",13,10,0

        even
lineChmodSetBuf:
        dc.b    "09 CHMOD-SET    D0="
lineChmodSet:
        dc.b    "00000000",13,10,0

        even
lineRenameBuf:
        dc.b    "10 RENAME       D0="
lineRename:
        dc.b    "00000000",13,10,0

        even
lineDeleteBuf:
        dc.b    "11 DELETE       D0="
lineDelete:
        dc.b    "00000000",13,10,0

        even
lineMkdirBuf:
        dc.b    "12 MKDIR        D0="
lineMkdir:
        dc.b    "00000000",13,10,0

        even
lineRmdirBuf:
        dc.b    "13 RMDIR        D0="
lineRmdir:
        dc.b    "00000000",13,10,0

        even
lineNewfileBuf:
        dc.b    "14 NEWFILE      D0="
lineNewfile:
        dc.b    "00000000",13,10,0

        even
