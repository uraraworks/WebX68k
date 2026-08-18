* ---------------------------------------------------------------------------
* WebX68k マウス動作確認プログラム (MOUSETST.X)
*
* ホスト(ブラウザ) → px68k コア → SCC → ゲスト というマウス入力の経路が
* 実際にゲストまで届いているかを確認するためのテストソフト。
*
* 経路の疎通(移動量とボタンが届くか)に加えて、タッチマウス(PR #4)の検証に必要な
* 「タップがクリックとして成立したか」を数える。押下エッジを数えるので、
* 10回タップして CLK が 10 増えるかどうかで取りこぼしが実測できる。
*
*   - IOCS _MS_INIT  ($70) / _MS_CURON ($71) … 初期化とカーソル表示
*   - IOCS _MS_GETDT ($74) … 移動量とボタン状態
*     d0 = bit31-24:X移動量 / 23-16:Y移動量 / 15-8:左ボタン / 7-0:右ボタン
*        (ボタンは 0=離している, -1(=$FF)=押している)
*   - IOCS _MS_CURGT ($75) … カーソルの絶対座標 (d0 = 上位ワード:X / 下位ワード:Y)
*   - IOCS _ONTIME   ($7F) … 1/100秒単位の時刻
*
* 表示(1行を CR で上書きし続ける。ANSI エスケープに依存しない):
*   X,Y  … カーソル絶対座標。タップが狙った位置に着地したか
*   L,R  … ボタンの現在値。長押しドラッグ中に 1 を保つか
*   CLK  … 左ボタンの押下エッジ回数。タップ回数と一致するか(取りこぼしの実測)
*   RCK  … 右ボタンの押下エッジ回数
*   DBL  … 直前の押下から DBL_TICKS 以内かつ近接位置での押下の回数
*           (ダブルクリックとして成立しうる操作の数)
*   GAP  … 直近の押下間隔(1/100秒)
*   HLD  … 直近の押下保持時間(1/100秒)
*   T    … _ONTIME の生値
*
* T は計測系そのものの陽性対照として出している。ここが滑らかに増えていなければ
* 時刻取得が効いていないということで、GAP/HLD/DBL は信用してはいけない。
* 逆に CLK と X,Y は時刻に依存しないので、T が死んでいても意味を持つ。
* X,Y の妥当性はホスト側の __webx68kDebug.mouse().cursor と突き合わせて確認する。
*
* 何かキーを押すと終了する。
*
* IOCS は d0.w に番号を入れて trap #15。
* DOS コールは $FFxx が命令そのもの(F ライン例外)なので dc.w で直接埋め込む。
* 位置独立に書いてあるので、再配置テーブル無しの .X として出力できる。
* ---------------------------------------------------------------------------

DBL_TICKS       equ     40              * ダブルクリックとみなす最大間隔(1/100秒 = 400ms)
DBL_SLOP        equ     8               * ダブルクリックとみなす最大座標差(ドット)

        section text

start:
        moveq   #$70,d0                 * _MS_INIT
        trap    #15
        moveq   #$71,d0                 * _MS_CURON
        trap    #15

* 起動時刻を「直前の押下時刻」の初期値にしておく。0 のままだと最初の1回が
* ダブルクリックとして数えられてしまう(起動直後は T がまだ小さいため)。
        moveq   #$7f,d0                 * _ONTIME
        trap    #15
        lea     lastPress(pc),a0
        move.l  d0,(a0)

        pea     title(pc)
        dc.w    $ff09                   * DOS _PRINT
        addq.l  #4,sp

* ---------------------------------------------------------------------------
mainloop:
* IOCS 呼び出しがレジスタを壊しても困らないよう、取得したら即メモリへ置く
        moveq   #$7f,d0                 * _ONTIME
        trap    #15
        lea     tickV(pc),a0
        move.l  d0,(a0)

        moveq   #$75,d0                 * _MS_CURGT
        trap    #15
        lea     curV(pc),a0
        move.l  d0,(a0)

        moveq   #$74,d0                 * _MS_GETDT
        trap    #15
        lea     dtV(pc),a0
        move.l  d0,(a0)


* --- 左ボタンのエッジ検出 ---------------------------------------------------
        lea     dtV(pc),a0
        move.l  (a0),d0
        move.l  d0,d4
        lsr.l   #8,d4
        and.w   #$00ff,d4               * d4 = 左ボタンの現在値
        and.w   #$00ff,d0
        move.w  d0,d5                   * d5 = 右ボタンの現在値

        lea     prevL(pc),a1
        tst.b   d4
        beq     leftReleased
        tst.b   (a1)
        bne     leftDone                * 押しっぱなし(エッジではない)
        bsr     onPress                 * 離→押: 押下エッジ
        bra     leftDone
leftReleased:
        tst.b   (a1)
        beq     leftDone                * 離しっぱなし
        bsr     onRelease               * 押→離: 保持時間を確定
leftDone:
* onPress/onRelease は a1 を壊すので、必ず取り直してから prevL を更新する
* (取り直しを忘れると別の番地へ書き込み、前回値が永久に更新されないため
*  毎周回がエッジ扱いになる。実際にそれで CLK が1回の押下で百単位に増えた)
        lea     prevL(pc),a1
        move.b  d4,(a1)                 * prevL = 現在値

* --- 右ボタンのエッジ検出(回数だけ数える) -----------------------------------
        lea     prevR(pc),a1
        tst.b   d5
        beq     rightDone2
        tst.b   (a1)
        bne     rightDone2
        lea     rckCnt(pc),a0
        addq.w  #1,(a0)
rightDone2:
        move.b  d5,(a1)

* --- 表示用の文字列を組み立てる ---------------------------------------------
        lea     curV(pc),a0
        move.l  (a0),d1
        swap    d1
        lea     bufX(pc),a0
        bsr     puthex4                 * X (上位ワード)

        lea     curV(pc),a0
        move.l  (a0),d1
        lea     bufY(pc),a0
        bsr     puthex4                 * Y (下位ワード)

        lea     bufL(pc),a0
        move.b  d4,d1
        bsr     putflag
        lea     bufR(pc),a0
        move.b  d5,d1
        bsr     putflag

        lea     clkCnt(pc),a0
        move.w  (a0),d1
        lea     bufCLK(pc),a0
        bsr     puthex4
        lea     rckCnt(pc),a0
        move.w  (a0),d1
        lea     bufRCK(pc),a0
        bsr     puthex4
        lea     dblCnt(pc),a0
        move.w  (a0),d1
        lea     bufDBL(pc),a0
        bsr     puthex4
        lea     gapVal(pc),a0
        move.w  (a0),d1
        lea     bufGAP(pc),a0
        bsr     puthex4
        lea     hldVal(pc),a0
        move.w  (a0),d1
        lea     bufHLD(pc),a0
        bsr     puthex4
        lea     tickV(pc),a0
        move.l  (a0),d1
        lea     bufT(pc),a0
        bsr     puthex8

* 先頭の CR で同じ行を上書きし続ける(スクロールさせない)
        pea     msg(pc)
        dc.w    $ff09                   * DOS _PRINT
        addq.l  #4,sp

        dc.w    $ff0b                   * DOS _KEYSNS (0=入力なし)
        tst.l   d0
        beq     mainloop

* CR だけで上書きし続けているので、終了前に改行してプロンプトと重ならないようにする
        pea     crlf(pc)
        dc.w    $ff09                   * DOS _PRINT
        addq.l  #4,sp

        dc.w    $ff00                   * DOS _EXIT

* ---------------------------------------------------------------------------
* 押下エッジ: 回数を数え、直前の押下との間隔と距離からダブルクリックを判定する。
* 破壊: d0-d3, a0, a1
* ---------------------------------------------------------------------------
onPress:
        lea     clkCnt(pc),a0
        addq.w  #1,(a0)

        lea     tickV(pc),a0
        move.l  (a0),d0
        lea     lastPress(pc),a1
        move.l  (a1),d1
        sub.l   d1,d0                   * d0 = 前回押下からの経過(1/100秒)
        lea     gapVal(pc),a0
        move.w  d0,(a0)

        cmp.l   #DBL_TICKS,d0
        bhi     onPressStore            * 間隔が開きすぎ

* 座標が近いか(前回の押下位置との差が DBL_SLOP 以内)
        lea     curV(pc),a0
        move.l  (a0),d2
        move.l  d2,d3
        swap    d3                      * d3.w = 現在X
        lea     lastX(pc),a0
        sub.w   (a0),d3
        bpl     dblAbsX
        neg.w   d3
dblAbsX:
        cmp.w   #DBL_SLOP,d3
        bhi     onPressStore
        lea     lastY(pc),a0
        move.w  d2,d3                   * d3.w = 現在Y
        sub.w   (a0),d3
        bpl     dblAbsY
        neg.w   d3
dblAbsY:
        cmp.w   #DBL_SLOP,d3
        bhi     onPressStore

        lea     dblCnt(pc),a0
        addq.w  #1,(a0)

onPressStore:
        lea     tickV(pc),a0
        move.l  (a0),d0
        lea     lastPress(pc),a1
        move.l  d0,(a1)
        lea     curV(pc),a0
        move.l  (a0),d2
        lea     lastY(pc),a1
        move.w  d2,(a1)
        swap    d2
        lea     lastX(pc),a1
        move.w  d2,(a1)
        rts

* ---------------------------------------------------------------------------
* 解放エッジ: 押していた時間を確定する。破壊: d0-d1, a0, a1
* ---------------------------------------------------------------------------
onRelease:
        lea     tickV(pc),a0
        move.l  (a0),d0
        lea     lastPress(pc),a1
        move.l  (a1),d1
        sub.l   d1,d0
        lea     hldVal(pc),a0
        move.w  d0,(a0)
        rts

* ---------------------------------------------------------------------------
* d1.b が 0 なら '0'、それ以外なら '1' を (a0) へ。破壊: d1
* ---------------------------------------------------------------------------
putflag:
        tst.b   d1
        beq     putflag0
        move.b  #'1',(a0)
        rts
putflag0:
        move.b  #'0',(a0)
        rts

* ---------------------------------------------------------------------------
* d1.w を4桁、d1.l を8桁の16進文字列にして (a0) へ書く。破壊: d1-d3, a0, a1
* rol.l で上位ニブルから取り出すので、4桁のときは値を上位ワードへ寄せておく。
* ---------------------------------------------------------------------------
puthex4:
        and.l   #$0000ffff,d1
        swap    d1
        moveq   #3,d2
        bra     puthexn
puthex8:
        moveq   #7,d2
puthexn:
        lea     hextab(pc),a1
puthexl:
        rol.l   #4,d1
        move.w  d1,d3
        and.w   #$000f,d3
        move.b  (a1,d3.w),(a0)+
        dbra    d2,puthexl
        rts

* ---------------------------------------------------------------------------
hextab:
        dc.b    "0123456789ABCDEF"

crlf:
        dc.b    13,10,0

title:
        dc.b    "WebX68k mouse test",13,10
        dc.b    "CLK/RCK=button press count, DBL=double-click candidates,",13,10
        dc.b    "GAP/HLD=last interval/hold (1/100s), T=timer (must count up)",13,10
        dc.b    "Press any key to quit.",13,10,0

* 1行に詰めて CR で上書きする。96桁に収まる長さにしてある。
msg:
        dc.b    13,"X="
bufX:   dc.b    "0000"," Y="
bufY:   dc.b    "0000"," L="
bufL:   dc.b    "0"," R="
bufR:   dc.b    "0"," CLK="
bufCLK: dc.b    "0000"," RCK="
bufRCK: dc.b    "0000"," DBL="
bufDBL: dc.b    "0000"," GAP="
bufGAP: dc.b    "0000"," HLD="
bufHLD: dc.b    "0000"," T="
bufT:   dc.b    "00000000",0

        even
* --- 作業領域(.X は RAM 上に読み込まれるので text 内でも書き換えられる) ------
prevL:  dc.b    0
prevR:  dc.b    0
        even
clkCnt: dc.w    0
rckCnt: dc.w    0
dblCnt: dc.w    0
gapVal: dc.w    0
hldVal: dc.w    0
lastX:  dc.w    0
lastY:  dc.w    0
tickV:  dc.l    0
curV:   dc.l    0
dtV:    dc.l    0
lastPress:
        dc.l    0

        even
