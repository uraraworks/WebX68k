* ---------------------------------------------------------------------------
* WebX68k マウス動作確認プログラム (MOUSETST.X)
*
* ホスト(ブラウザ) → px68k コア → SCC → ゲスト というマウス入力の経路が
* 実際にゲストまで届いているかを確認するためのテストソフト。
*
*   - IOCS _MS_INIT  ($70) でマウスを初期化
*   - IOCS _MS_CURON ($71) でハードウェアマウスカーソルを表示
*     → これが動けば、経路が通っていることが目視で分かる
*   - IOCS _MS_GETDT ($74) で移動量とボタン状態を取得し、16進で表示
*     → d0 = bit31-24:X移動量 / 23-16:Y移動量 / 15-8:左ボタン / 7-0:右ボタン
*        (ボタンは 0=離している, -1(=$FF)=押している)
*
* 何かキーを押すと終了する。
*
* IOCS は d0.w に番号を入れて trap #15。
* DOS コールは $FFxx が命令そのもの(F ライン例外)なので dc.w で直接埋め込む。
* 位置独立に書いてあるので、再配置テーブル無しの .X として出力できる。
* ---------------------------------------------------------------------------

        section text

start:
        moveq   #$70,d0                 * _MS_INIT
        trap    #15
        moveq   #$71,d0                 * _MS_CURON
        trap    #15

        pea     title(pc)
        dc.w    $ff09                   * DOS _PRINT
        addq.l  #4,sp

mainloop:
        moveq   #$74,d0                 * _MS_GETDT
        trap    #15
        move.l  d0,d1

* d1 を 8 桁の16進文字列にして hexbuf へ書く(上位ニブルから)
        lea     hexbuf(pc),a0
        moveq   #7,d2
tohex:
        rol.l   #4,d1
        move.w  d1,d3
        and.w   #$000f,d3
        lea     hextab(pc),a1
        move.b  (a1,d3.w),(a0)+
        dbra    d2,tohex

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

hextab:
        dc.b    "0123456789ABCDEF"

crlf:
        dc.b    13,10,0

title:
        dc.b    "WebX68k mouse test - move the mouse, press any key to quit",13,10,0

msg:
        dc.b    13,"MS_GETDT(XX YY LL RR) = "
hexbuf:
        dc.b    "00000000",0

        even
