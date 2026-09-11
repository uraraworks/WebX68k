* ---------------------------------------------------------------------------
* remote-probe.s -- Human68k デバイスドライバの挙動観測用の最小デバイスドライバ
* (RPROBE.SYS)。build-remote-probe.sh が vasm の -D オプションで以下の3条件を
* 切り替えて複数条件をアセンブルする(既定値はどれもC0/C1/C2相当=無指定時と同じ):
*
*   CMD_INIT     初期化とみなすコマンドコード。既定 $00。C3a/C3b は $40。
*   UNKNOWN_OK   未対応コマンドへの応答。既定 0 = エラー$1003を返す。
*                1にすると応答欄(+3〜)に触れず状態$0000(成功)だけ返す(C3b)。
*   CMD5_SPECIAL 既定 0(無効)。1にすると、コマンド5(ドライブコントロール&セン
*                ス)だけ特別扱いし、+13に$42を書いて状態$0000(成功)を返す(C1b)。
*                UNKNOWN_OKと同時に1にはしない(cmd5判定がunknown分岐より先に
*                評価されるため、UNKNOWN_OK側は素通りする)。
*
* 属性ワード(+4)はこのソース内では常に$0000のまま書き出す。C1/C2/C3系の$0000
* /$2000の切り替えは、build-remote-probe.sh がアセンブル後のバイナリを直接
* パッチする(vasmの再アセンブルを伴わない)。
*
* 目的はただ一つ: 属性ワードやコマンドコードを変えたとき、Human68kがブロック
* デバイスの通常コマンド(0〜12)とは違う要求をどう送ってくるかを観測すること。
* 実装ではなく観測が目的なので、初期化以外は基本的に全部エラーで断る。
*
* 実装の裏付け(PRO-68K ver2.0 プログラマーズマニュアル 第6章、資料から得た事実):
*   - ドライバヘッダ: +0 次ヘッダへのリンク(L, 最後は$FFFFFFFF) / +4 属性(W) /
*     +6 ストラテジ入口(L) / +10 割り込みルーチン入口(L) / +14 名前(8B)。
*     ブロックデバイスは名前の先頭1バイトが$20以下のコード、残り7バイトは任意。
*   - ストラテジはA5でリクエストヘッダのポインタを受け取り、保存してrts。
*     実処理は割り込みルーチン側で行う。
*   - リクエストヘッダ: +0 長さ(26) / +1 ユニット番号 / +2 コマンドコード /
*     +3 エラーlow / +4 エラーhigh / +5〜12 未使用 / +13〜 コマンドごと。
*   - 初期化(コマンド0)の応答: +13 ユニット数(O) / +14 ドライバの終わりアドレス
*     (L,O) / +18 出力はBPBテーブルのポインタ(L) / +22 割り当てられたドライブ番号
*     (I, 0=A:, 読むだけで書かない)。
*   - BPBテーブル = ユニット数ぶんのBPBアドレス(L)の並び。BPB 12バイト。
*   - エラー: D0.Wにセットし、リクエストヘッダ内(+3=low, +4=high)にもセットする。
*
* 位置独立に書いてあり、ヘッダの2ロング(+6 ストラテジ入口 / +10 割り込み入口)
* だけ絶対番地が要る。ここは vasm の -Fxfile 出力(再配置テーブル付き)に任せず、
* hu_pack.py --reloc=6,10 で自前の再配置テーブルを付ける(reloc-test.s参照)。
* それ以外(BPBテーブルへのポインタ・保存領域への書き込み等)はすべて lea xxx(pc)
* で作った番地を使い、追加の再配置エントリを増やさない。
* ---------------------------------------------------------------------------

        ifnd CMD_INIT
CMD_INIT set $00
        endc
        ifnd UNKNOWN_OK
UNKNOWN_OK set 0
        endc
        ifnd CMD5_SPECIAL
CMD5_SPECIAL set 0
        endc
        ifnd REC_MODE
REC_MODE set 0
        endc
        ifnd REC_E
REC_E set 1
        endc
        ifnd C6_MODE
C6_MODE set 1                   * 1=A群(ボリューム検索への返し方を試す) 2=B群($48の挙動を試す)
        endc
        ifnd C6_SUB
C6_SUB set 1                    * A群: 1=V1(ヘッダのみ) 2=V2(D0のみ)
* B群: 1=F1(ヘッダのみ) 2=F2(D0のみ) 3=F3(両方)
        endc

        ifnd REC_MAX
REC_MAX set 20
        endc
EXTRA_SIZE set 142
ENTRY_SIZE set 170

        section text

* --- デバイスドライバヘッダ (先頭26バイト。Human68kがロード直後にそのまま読む) ---
drv_header:
        dc.l    $ffffffff       * +0  次ヘッダへのリンク(最後)
        dc.w    $0000           * +4  属性ワード(ビルド後にパッチする。既定=ブロックデバイス)
        dc.l    strategy        * +6  ストラテジ入口(要再配置)
        dc.l    interrupt       * +10 割り込みルーチン入口(要再配置)
        dc.b    $01             * +14 名前: ブロックデバイスなので先頭1バイトは$20以下
* +15 名前の残り7バイト(RAM走査で見つけるための固有文字列)
        dc.b    'RPROBE1'

* --- ストラテジ入口: リクエストヘッダへのポインタ(A5)を保存するだけ ---
strategy:
        lea     req_ptr(pc),a0
        move.l  a5,(a0)
        rts

* --- 割り込みルーチン入口: 実処理。初期化コマンドだけ応答し、他は基本エラー ---
interrupt:
        ifne REC_MODE
* d0は各分岐が書いた戻り値をHuman68kへ渡す必要があるため、退避/復元の対象
* から外す(実測: 復元対象に含めていたときはE1(D0.Lのみ)が効かず、E1/E2/E3が
* すべて同じ結果になった)。
        movem.l d1-d3/a0-a4,-(sp)
        else
        movem.l d0-d2/a0-a2,-(sp)
        endc

        lea     req_ptr(pc),a0
        move.l  (a0),a0                 * a0 = リクエストヘッダへのポインタ

        moveq   #0,d0
        move.b  2(a0),d0                * コマンドコード(+2, 1バイト)

        ifne REC_MODE
        bsr.w   record_request          * 応答を書く前に、まず記録領域へ追記する
        endc

        cmp.b   #CMD_INIT,d0
        beq.s   cmd_init

        ifne REC_MODE
* ハンドラ本体はdone:より後ろ(record_requestの近く)に置くので、遠くへ
* 届くよう.w(ワード変位)で分岐する。
        cmp.b   #$57,d0
        beq.w   cmd57_ok
        cmp.b   #$47,d0
        beq.w   cmd47_ok
        cmp.b   #$48,d0
        beq.w   cmd48_ok
        cmp.b   #$56,d0
        beq.w   cmd56_ok
        endc

        ifne CMD5_SPECIAL
* --- コマンド5: ドライブコントロール&センス。+13に$42を書いて成功を返す(C1b) ---
        cmp.b   #5,d0
        beq.s   cmd5_ok
        endc

        ifeq UNKNOWN_OK
* --- 未対応コマンド: エラー $1003 (中止のみ・コマンドコード不正) ---
        move.b  #$03,3(a0)              * +3 エラーlow
        move.b  #$10,4(a0)              * +4 エラーhigh
        move.w  #$1003,d0
        bra.s   done
        else
* --- 未対応コマンド: 応答欄(+13以降)には触れず、状態$0000(成功)だけ返す(C3b) ---
        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        moveq   #0,d0
        bra.s   done
        endc

        ifne CMD5_SPECIAL
cmd5_ok:
        move.b  #$42,13(a0)             * +13 = $42
        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        moveq   #0,d0
        bra.s   done
        endc

* --- 初期化コマンド(既定はコマンド0。CMD_INITで切り替え) ---
cmd_init:
        move.b  #1,13(a0)               * +13 ユニット数 = 1

        lea     drv_end(pc),a1          * +14 ドライバの終わりアドレス
        move.l  a1,14(a0)

        lea     bpb(pc),a1              * bpb構造体の実番地(PC相対で解決)
        lea     bpb_table(pc),a2        * bpb_table[0] へ書く(自前領域、絶対アドレッシング無し)
        move.l  a1,(a2)

        move.l  a2,18(a0)               * +18 出力: BPBテーブルへのポインタ

        move.b  #$00,3(a0)              * +3 エラーlow = 0 (正常)
        move.b  #$00,4(a0)              * +4 エラーhigh = 0
        moveq   #0,d0

done:
        ifne REC_MODE
* 入口の退避がd1-d3/a0-a4(d0を含めない)なので、ここもそれに合わせる。
* 実測: ここをd0-d3/a0-a4のままにしていたら、pushした本数よりpopが4バイト
* 多くなりスタックが狂って、戻り先が無関係なコード($70DE)へ化けてHuman68k
* 自体がアドレスエラーで落ちた。
        movem.l (sp)+,d1-d3/a0-a4
        else
        movem.l (sp)+,d0-d2/a0-a2
        endc
        rts

        ifne REC_MODE
* --- $57: 成功を返すだけ ---
cmd57_ok:
        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        moveq   #0,d0
        bra.w   done

* --- $56: 記録するだけ。応答欄には触れず、成功(D0=0)だけ返す ---
cmd56_ok:
        moveq   #0,d0
        bra.w   done

* --- $47: 検索。ヘッダ+13(検索属性)のbit3が立っていたら(ボリューム検索、
* 推測)C6_MODE/C6_SUBに応じて返す。それ以外(本体検索)はFILBUFの+10〜+20・
* +21以降だけ書いてHELLO.TXTを成功で返す(共通、+0〜+9は触らない)。 ---
cmd47_ok:
        moveq   #0,d1
        move.b  13(a0),d1               * ヘッダ+13 = 検索属性
        btst    #3,d1                   * bit3 = ボリューム検索(推測)
        bne.s   cmd47_vol

        move.l  18(a0),a2               * a2 = FILBUFへの出力先(far pointer)
        lea     10(a2),a2               * +10から先だけ書く
        lea     fake_file(pc),a1
        moveq   #43-1,d2
cmd47_copy:
        move.b  (a1)+,(a2)+
        dbra    d2,cmd47_copy
        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        moveq   #0,d0
        bra.w   done

cmd47_vol:
        ifeq C6_MODE-1
* A群: FILBUFには何も書かず、エラーの伝え方だけをC6_SUBで振る
          ifeq C6_SUB-1
* C6-V1: ヘッダ+3/+4だけに-2(D0は0のまま)
        move.b  #$fe,3(a0)
        move.b  #$ff,4(a0)
        moveq   #0,d0
        bra.w   done
          endc
          ifeq C6_SUB-2
* C6-V2: D0.Lだけに-2(ヘッダは0のまま)
        moveq   #-2,d0
        bra.w   done
          endc
        endc
        ifeq C6_MODE-2
* B群: ボリュームラベル"WEBX68K"を成功で返す
        move.l  18(a0),a2
        lea     10(a2),a2
        lea     fake_label(pc),a1
        moveq   #43-1,d2
cmd47_vol_copy:
        move.b  (a1)+,(a2)+
        dbra    d2,cmd47_vol_copy
        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        moveq   #0,d0
        bra.w   done
        endc

* --- $48: 次を検索。A群は使わない想定なので単純に「もう無い」(両方)を返す。
* B群は呼び出し回数で振る: 1回目=WORLD.DOC、2〜5回目=C6_SUBのF1/F2/F3で
* 「もう無い」、6回目以降は安全弁として強制的に両方-18を返し、印を残す。 ---
cmd48_ok:
        ifeq C6_MODE-1
        move.b  #$ee,3(a0)
        move.b  #$ff,4(a0)
        moveq   #-18,d0
        bra.w   done
        endc
        ifeq C6_MODE-2
        lea     cmd48_count(pc),a1
        move.w  (a1),d1
        addq.w  #1,d1
        move.w  d1,(a1)                 * d1 = 今回で何回目のD8呼び出しか(1始まり)

        cmp.w   #6,d1
        blt.s   cmd48_notsafe
* 安全弁: 6回目以降は常に両方-18を返し、印(safety_hit)を立てる
        lea     safety_hit(pc),a2
        move.b  #1,(a2)
        move.b  #$ee,3(a0)
        move.b  #$ff,4(a0)
        moveq   #-18,d0
        bra.w   done

cmd48_notsafe:
        cmp.w   #1,d1
        bne.s   cmd48_notfirst
* 1回目: WORLD.DOCを成功で返す
        move.l  18(a0),a2
        lea     10(a2),a2
        lea     fake_file2(pc),a1
        moveq   #43-1,d2
cmd48_b_copy:
        move.b  (a1)+,(a2)+
        dbra    d2,cmd48_b_copy
        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        moveq   #0,d0
        bra.w   done

cmd48_notfirst:
* 2〜5回目: 「もう無い」をC6_SUB(F1/F2/F3)で振る
          ifeq C6_SUB-1
        move.b  #$ee,3(a0)              * F1: ヘッダのみ
        move.b  #$ff,4(a0)
        moveq   #0,d0
        bra.w   done
          endc
          ifeq C6_SUB-2
        moveq   #-18,d0                 * F2: D0のみ
        bra.w   done
          endc
          ifeq C6_SUB-3
        move.b  #$ee,3(a0)              * F3: 両方
        move.b  #$ff,4(a0)
        moveq   #-18,d0
        bra.w   done
          endc
        endc
        endc

        ifne REC_MODE
* -----------------------------------------------------------------------
* record_request -- 要求が来るたびに記録領域へ追記するサブルーチン。
* 呼び出し前提: a0 = リクエストヘッダへのポインタ(26バイト)。全レジスタを
* 保存・復元するので、呼び出し側のd0(コマンドコード)・a0は変化しない。
* 記録領域があふれたら(件数がREC_MAXに達したら)何もせず戻る。
* -----------------------------------------------------------------------
record_request:
        movem.l d0-d3/a0-a4,-(sp)

        lea     rec_count(pc),a1
        move.w  (a1),d1
        cmp.w   #REC_MAX,d1
        bge.s   rec_ret                 * あふれた: 記録せず戻る

        move.w  d1,d3
        mulu    #ENTRY_SIZE,d3
        lea     rec_entries(pc),a2
        add.l   d3,a2                   * a2 = 今回のエントリの先頭

        move.l  a2,a3
        move.w  #ENTRY_SIZE-1,d3
rec_zero:
        move.b  #0,(a3)+
        dbra    d3,rec_zero             * エントリ全体を0クリア(未使用部を0にする)

        move.b  2(a0),(a2)              * entry+0 = コマンドコード
        lea     2(a2),a3                * entry+2から先にヘッダをコピー
        move.l  a0,a4
        moveq   #26-1,d3
rec_hdr:
        move.b  (a4)+,(a3)+
        dbra    d3,rec_hdr              * ここでa3はentry+28(拡張領域の先頭)になる

        moveq   #0,d3
        move.b  2(a0),d3
        cmp.b   #$47,d3
        beq.s   rec_c47
        cmp.b   #$48,d3
        beq.s   rec_c48
        bra.s   rec_bump

rec_c47:
        move.l  14(a0),a4               * +14の先(_NAMESTS形式?) 88バイト
        moveq   #88-1,d3
rec_c47_ns:
        move.b  (a4)+,(a3)+
        dbra    d3,rec_c47_ns
        move.l  18(a0),a4               * +18の先(FILBUF?) 53バイト
        moveq   #53-1,d3
rec_c47_fb:
        move.b  (a4)+,(a3)+
        dbra    d3,rec_c47_fb
        bra.s   rec_bump

rec_c48:
        move.l  18(a0),a4               * +18の先 53バイト
        moveq   #53-1,d3
rec_c48_fb:
        move.b  (a4)+,(a3)+
        dbra    d3,rec_c48_fb

rec_bump:
        lea     rec_count(pc),a1
        move.w  (a1),d1
        addq.w  #1,d1
        move.w  d1,(a1)

rec_ret:
        movem.l (sp)+,d0-d3/a0-a4
        rts
        endc

* --- 作業領域(位置独立: すべてPC相対でアクセスする) ---
req_ptr:
        dc.l    0
bpb_table:
        dc.l    0                       * ユニット数1ぶん(BPBアドレス1個の配列)

* もっともらしいBPB(12バイト)。初期化以外はほぼ応答しないため中身の正しさは
* 問わない(1024B/セクタ・2HD相当の値を仮に置いてあるだけ)。
bpb:
        dc.w    1024                    * 1セクタのバイト数
        dc.b    1                       * 1クラスタのセクタ数
        dc.b    2                       * FAT数
        dc.w    1                       * 予約セクタ数
        dc.w    16                      * ルートエントリ数
        dc.w    1232                    * 全セクタ数(2HD相当)
        dc.b    $f9                     * メディアバイト
        dc.b    2                       * 1FATのセクタ数

        ifne REC_MODE
* --- 偽のFILBUFの+10から先(43バイト)。+0〜+9はHuman68k内部用なので
* 生成せず、cmd47_ok/cmd48_okがFILBUF+10へ書き込む(実測: +0〜+9を
* 上書きするとnfilesが壊れた) ---
* HELLO.TXT / 1234バイト / 2026-09-11 12:34:56 / 属性$20
fake_file:
        dc.b    'HELLO',32,32,32        * +10 ファイル名8(空白パディング)
* +18 拡張子3
        dc.b    'TXT'
        dc.b    $20                     * +21 属性の一致
        dc.w    $645c                   * +22 最終変更時刻 12:34:56
        dc.w    $5d2b                   * +24 最終変更日 2026-09-11
        dc.l    1234                    * +26 ファイルサイズ
* +30 ファイル名23バイトの先頭9バイト、続く14バイトは0パディング(23バイト分)
        dc.b    'HELLO.TXT'
        dcb.b   14,0
fake_file_end:

* WORLD.DOC / 5678バイト / 2026-01-02 03:04:06 / 属性$20 (C5-Nの2件目)
fake_file2:
        dc.b    'WORLD',32,32,32        * +10 ファイル名8
* +18 拡張子3
        dc.b    'DOC'
        dc.b    $20                     * +21 属性の一致
        dc.w    $1883                   * +22 最終変更時刻 03:04:06
        dc.w    $5c22                   * +24 最終変更日 2026-01-02
        dc.l    5678                    * +26 ファイルサイズ
        dc.b    'WORLD.DOC'
        dcb.b   14,0
fake_file2_end:

* ボリュームラベル"WEBX68K"(B群の$47ボリューム検索応答)。時刻・日付・
* サイズは無指定なので0にしておく。
fake_label:
        dc.b    'WEBX68K',32     * +10 名前8(7文字+空白1)
* +18 拡張子3(空白)
        dc.b    32,32,32
        dc.b    $08              * +21 属性の一致(ボリュームラベル)
        dc.w    0                * +22 時刻(無指定=0)
        dc.w    0                * +24 日付(無指定=0)
        dc.l    0                * +26 サイズ(無指定=0)
        dc.b    'WEBX68K'
        dcb.b   16,0
fake_label_end:

* fake_file/fake_file2/fake_label(いずれも43バイト、奇数)の直後なので、
* ここで偶数番地に揃えないと後続のワード(cmd48_count等)が奇数番地に来て
* アドレスエラーになる(実測: PC=header+$CEが「move.w (a1),d1」でアドレス
* エラー、犯人はこの奇数ずれだった)。
        even

cmd48_count:
        dc.w    0                * B群: $48が呼ばれた回数(1始まりで数える)
safety_hit:
        dc.b    0                * B群: 安全弁(6回目以降)が作動したら1

        even

* --- 記録領域(4KB弱)。rec_marker(8バイトの目印)をローカルのRAWビルドから
* 検索してヘッダ先頭からのオフセットを求め、実行時のヘッダ番地(--scanで得る)
* へそのオフセットを足して--peekのアドレスを計算する(build-remote-probe.sh
* が算出してログへ出す) ---
rec_marker:
* 8バイト、目印(ローカルのbinから検索する用)
        dc.b    'RECBUF01'
rec_count:
        dc.w    0                       * 記録済み件数
rec_entries:
        ds.b    REC_MAX*ENTRY_SIZE      * エントリ本体(1件170バイト×20件)
        endc

drv_end:
        dc.w    0                       * ドライバの終わり(パディング)
