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
REC_MAX set 64                  * dir c:\sub\a*.txt まで収めるため20から引き上げ(C7)
        endc
        ifnd DSKFRE_MODE
DSKFRE_MODE set 0               * C7: $56の返し方。0=ヘッダのみ成功(D0)、既定=旧C6-F3と同じ
* 1=ヘッダ+14〜+21に空き容量8バイトを書いて成功(D1) 2=1に加えD0.Lにも使用可能バイト数(D2)
        endc
        ifnd C8_MODE
C8_MODE set 0                   * C8: 親の仮説「戻り値は+18のロング」を試す。0=無効(C6/C7と同じ)
* 1=C8-a 2=C8-b。有効時は $47/$48/$56/$57 のD0.L/ヘッダ状態(+3/+4)を常に0にし、
* 戻り値を+18へロングで書く(+18は入力=パラメータポインタと兼用なので、
* 入力として使い終えてから書き換える)。さらに$50を新規ハンドルする
* (C8-a: +18=204800のみ。C8-b: それに加え+14がポインタらしければ8バイトの
* _DSKFRE構造体をそこへ書く)。C8_MODE=0のときは1バイトも命令が増えない
* (既存条件のバイナリに影響しない)。
        endc

        ifnd C9_MODE
C9_MODE set 0                   * C9: 0=無効(既存条件と同じ)。1=有効。
* 有効時、record_requestはコマンド番号を問わず「+14/+18がゲストRAMを指す
* ポインタらしい値(0<val<$C00000かつ偶数)」ならその先64バイトずつ記録する
* (旧来の$47/$48専用88+53バイト記録の代わり)。さらに、未対応コマンドの
* 応答は「状態0・+18=-2(ファイルが見つからない)」に変える(C3b等の
* $1003/成功スタブより優先)。加えて open/read/close らしきコマンドを
* CMD_OPEN/CMD_READ/CMD_CLOSEで指定でき、指定したコードにだけ個別応答する
* (未指定=$FFのままなら該当コードは無く、全部C9の既定フォールバックに落ちる)。
        endc
        ifnd CMD_OPEN
CMD_OPEN set $ff                * C9: 「開く」とみなすコマンドコード。$ffは無効(一致しない)
        endc
        ifnd CMD_READ
CMD_READ set $ff                * C9: 「読む」とみなすコマンドコード
        endc
        ifnd CMD_CLOSE
CMD_CLOSE set $ff               * C9: 「閉じる」とみなすコマンドコード
        endc
        ifnd CMD_READ_BUF_OFF
CMD_READ_BUF_OFF set 18         * C9: 読み込みバッファへの far pointer がヘッダのどのオフセットか
        endc
        ifnd CMD_CD
CMD_CD set $ff                  * C11: 「cd」とみなすコマンドコード。$ffは無効(一致しない)
        endc

        ifnd C10_MODE
C10_MODE set 0                  * C10: 0=無効。1にするとC9の上に以下を足す(C9_MODE=1と併用が前提):
* ・$47/$48が_NAMESTSの名前8+拡張子3を'?'をワイルドカードとしてfake_file/
*   fake_file2と照合し、一致したものだけを返す(一致なしは$47=-2/$48=-18)。
* ・HELLO.TXT(fake_file)の中身を3000バイトの実データにし、$4c(読む)は
*   c10_read_pos(開いたときに0、読むたびに進める、1ファイルぶんのみ)を
*   使って要求長ぶんを返す。
* ・record_requestで+22(a0)もポインタらしければ、その先96バイト(FCB候補)
*   をentry+156へ記録する(ENTRY_SIZEを252へ拡張)。
        endc

        ifnd C11_MODE
C11_MODE set 0                  * C11: 0=無効。1にするとC10の上に以下を足す(C10_MODE=1
* かつC9_MODE=1が前提。ENTRY_SIZE/REC_MAXはC10のまま変えない):
* ・ルート直下にSUB(属性$10、ディレクトリ)を追加。\SUB\配下にABC.TXT
*   (内容'abc in sub\r\n'、12バイト)を追加。
* ・$47/$48は、_NAMESTSのパス欄(+14の先+2以降)を見てルート/\SUB\/その他
*   のどのツリーを検索しているか判定してから、名前パターンで照合する。
* ・$4a(CMD_OPENで指定)も同じ判定でHELLO.TXT(ルート)/ABC.TXT(\SUB\)を
*   選び、$4c(CMD_READ)はそのファイルの内容と長さぶんだけ返す。
* ・未対応コマンドの応答を「状態0・+18=-2」から「状態0・+18=-3(ディレク
*   トリが見つからない)」に変える(cd等、未知のコマンドの解読用)。
* ・CMD_CDで指定したコマンドコードだけ、_NAMESTSのパス欄を見て0(成功)/
*   -3(ディレクトリが見つからない)を返す(未指定=$ffのままなら無効で、
*   該当コードは他の未対応コマンドと同じくフォールバックの-3に落ちる)。
        endc

EXTRA_SIZE set 142
        ifne C10_MODE
ENTRY_SIZE set 252              * C10: 2(cmd)+26(hdr)+64(+14先)+64(+18先)+96(+22先=FCB候補)
        else
          ifne C9_MODE
ENTRY_SIZE set 156              * C9: 2(cmd)+26(hdr)+64(+14先)+64(+18先)
          else
ENTRY_SIZE set 170
          endc
        endc

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
        ifne C8_MODE
        cmp.b   #$50,d0
        beq.w   cmd50_ok
        endc
        ifne C9_MODE
        cmp.b   #CMD_OPEN,d0
        beq.w   cmd_open_ok
        cmp.b   #CMD_READ,d0
        beq.w   cmd_read_ok
        cmp.b   #CMD_CLOSE,d0
        beq.w   cmd_close_ok
        ifne C11_MODE
        cmp.b   #CMD_CD,d0
        beq.w   cmd_cd_ok
        endc
        endc
        endc

        ifne CMD5_SPECIAL
* --- コマンド5: ドライブコントロール&センス。+13に$42を書いて成功を返す(C1b) ---
        cmp.b   #5,d0
        beq.s   cmd5_ok
        endc

        ifne C9_MODE
* --- C9: 未対応コマンドは状態0・+18=-2(ファイルが見つからない)を返す。
* C11は-3(ディレクトリが見つからない)に変える(cd等の未知コマンドの解読用)。 ---
        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        ifne C11_MODE
        move.l  #-3,18(a0)
        else
        move.l  #-2,18(a0)
        endc
        moveq   #0,d0
        bra.w   done
        else
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
        ifne C8_MODE
        move.l  #0,18(a0)               * C8: 戻り値は+18のロング
        endc
        moveq   #0,d0
        bra.w   done

* --- $56: DSKFRE_MODEに応じて返す(C7)。既定(0)は記録するだけで応答欄には
* 触れず成功(D0=0)。1/2は_DSKFRE(PRO-68Kマニュアル)と同じ並びで、ヘッダ
* +14〜+21へ空き容量8バイト(使用可能クラスタW/総クラスタW/1クラスタの
* セクタ数W/1セクタのバイト数W)を書く。2はさらにD0.Lへ使用可能バイト数も
* 入れる(D0が本当に無視されるかの再確認)。 ---
cmd56_ok:
        ifne C8_MODE
* C8: 状態は常に0、戻り値+18=0
        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        move.l  #0,18(a0)
        moveq   #0,d0
        bra.w   done
        endc
        ifeq DSKFRE_MODE-1
        lea     14(a0),a1
        move.w  #100,(a1)               * 使用可能クラスタ数
        move.w  #200,2(a1)              * 総クラスタ数
        move.w  #2,4(a1)                * 1クラスタのセクタ数
        move.w  #1024,6(a1)             * 1セクタのバイト数
        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        moveq   #0,d0
        bra.w   done
        endc
        ifeq DSKFRE_MODE-2
        lea     14(a0),a1
        move.w  #100,(a1)
        move.w  #200,2(a1)
        move.w  #2,4(a1)
        move.w  #1024,6(a1)
        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        move.l  #204800,d0              * 使用可能バイト数(100クラスタ*2セクタ*1024バイト)
        bra.w   done
        endc
        moveq   #0,d0
        bra.w   done

* --- $47: 検索。ヘッダ+13(検索属性)が$08ちょうどならボリューム検索
* (dirの実測: ラベル検索=$08, 本体検索=$35。bit3判定だと$3F(_FILESの
* attr=$3Fで実測)も誤ってボリューム扱いになったため、完全一致に直した)。
* C6_MODE/C6_SUBに応じて返す。それ以外(本体検索)はFILBUFの+10〜+20・
* +21以降だけ書いてHELLO.TXTを成功で返す(共通、+0〜+9は触らない)。 ---
cmd47_ok:
        moveq   #0,d1
        move.b  13(a0),d1               * ヘッダ+13 = 検索属性
        cmp.b   #$08,d1                 * $08ちょうどのときだけボリューム検索
        ifne C10_MODE
        beq.w   cmd47_vol               * C10はcmd47_okの本体が大きく.sでは届かない
        else
        beq.s   cmd47_vol
        endc

        ifne C10_MODE
* C10: _NAMESTS(+14が指す)の名前8+拡張子3(+67〜+77)を、次の$48でも使える
* よう c10_pat_name/extへ保存し、探索位置c10_search_idxを0に戻してから
* 共通の照合ルーチンcmd10_scanへ渡す。
        move.l  14(a0),a1               * a1 = _NAMESTSへのポインタ(推測)
        ifne C11_MODE
        movea.l a1,a3                   * a3 = NAMESTS先頭を退避(パス判定用)
        endc
        lea     67(a1),a1               * +67名前8, 続けて+75拡張子3(連続11B)
        lea     c10_pat_name(pc),a2
        moveq   #11-1,d2
cmd47_pat_copy:
        move.b  (a1)+,(a2)+
        dbra    d2,cmd47_pat_copy

        ifne C11_MODE
* C11: NAMESTSのパス欄(+2以降)を見てルート/\SUB\/その他を判定し、
* c11_treeへ残しておく(cmd10_scanの中で再利用する)。
        lea     2(a3),a1
        bsr.w   cmd11_check_path
        lea     c11_tree(pc),a2
        move.w  d0,(a2)
        endc

        lea     c10_search_idx(pc),a2
        move.w  #0,(a2)
        bra.w   cmd10_scan
        else
        move.l  18(a0),a2               * a2 = FILBUFへの出力先(far pointer)
        lea     10(a2),a2               * +10から先だけ書く
        lea     fake_file(pc),a1
        moveq   #43-1,d2
cmd47_copy:
        move.b  (a1)+,(a2)+
        dbra    d2,cmd47_copy
        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        ifne C8_MODE
        move.l  #0,18(a0)               * C8: FILBUFへ書き終えてから戻り値を上書き
        endc
        moveq   #0,d0
        bra.w   done
        endc

cmd47_vol:
        ifne C8_MODE
* C8: ラベル検索はFILBUFに書かず、+18=-2だけを返す
        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        move.l  #-2,18(a0)
        moveq   #0,d0
        bra.w   done
        endc
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
        ifne C10_MODE
* C10: c10_search_idx(前回の$47/$48が残した続き位置)からそのまま照合を
* 続ける(パターンは再送されない前提。$47のときに保存したc10_pat_name/ext
* をここでも使う)。
        bra.w   cmd10_scan
        endc
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
* 安全弁: 6回目以降は常に「もう無い」を返し、印(safety_hit)を立てる
        lea     safety_hit(pc),a2
        move.b  #1,(a2)
        ifne C8_MODE
        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        move.l  #-18,18(a0)
        moveq   #0,d0
        bra.w   done
        endc
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
        ifne C8_MODE
        move.l  #0,18(a0)               * C8: FILBUFへ書き終えてから戻り値を上書き
        endc
        moveq   #0,d0
        bra.w   done

cmd48_notfirst:
        ifne C8_MODE
* C8: 2回目以降は常に+18=-18(状態は0)
        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        move.l  #-18,18(a0)
        moveq   #0,d0
        bra.w   done
        endc
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

        ifne C8_MODE
* --- $50: C8のみで有効(既定はREC_MODE内の「その他」扱いで$1003のまま)。
* 親の仮説「_DSKFREはここに来る」を受けて、+18へ空き容量バイト数を書く。
* C8-a: +18=204800のみ。C8-b: それに加え、+14が実測(c7r-dskfree-final.json
* の$50ヘッダ)で$00000007という小さな値だった(番地とは考えにくい)ことを
* 踏まえ、+14が$00010000以上のときだけポインタとみなして_DSKFREの8バイト
* (使用可能クラスタ100/総クラスタ200/1クラスタ2セクタ/1セクタ1024バイト)
* をその先へ書く(閾値の根拠: 実測で見えた番地はどれも$016000台以上)。 ---
cmd50_ok:
        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        move.l  #204800,18(a0)          * 使用可能バイト数(100クラスタ*2セクタ*1024バイト)
          ifeq C8_MODE-2
        movea.l 14(a0),a2               * a2 = +14の値(ポインタかもしれない入力)
        cmpa.l  #$00010000,a2
        blo.s   cmd50_noptr
        move.w  #100,(a2)
        move.w  #200,2(a2)
        move.w  #2,4(a2)
        move.w  #1024,6(a2)
cmd50_noptr:
          endc
        moveq   #0,d0
        bra.w   done
        endc

        ifne C10_MODE
* -----------------------------------------------------------------------
* cmd10_scan -- $47(パターン設定直後)・$48(続き)共通の照合ルーチン。
* 前提: a0=リクエストヘッダ。c10_pat_name/ext(11B)に探すパターン、
* c10_search_idx(word)に次に調べる候補番号(0=fake_file,1=fake_file2,
* 2=使い切り)が入っている。'?'はワイルドカード(any)として扱う。
* 一致したら、その候補をFILBUF(+18(a0)の far pointer)+10へ43バイト
* コピーし、状態0・+18(a0)=0で返す。全候補を使い切ったら状態0のまま、
* 呼び出し元の元コマンド(header+2)に応じて $47=+18=-2 / $48=+18=-18 を返す。
* -----------------------------------------------------------------------
cmd10_scan:
        ifne C11_MODE
        bra.w   cmd11_scan                * C11: ツリー対応版へ委譲(以下はC11_MODE=0のときだけ使う)
        endc
        lea     c10_search_idx(pc),a3
        move.w  (a3),d3                  * d3 = 現在の探索位置

cmd10_scan_loop:
        cmp.w   #2,d3
        bge.w   cmd10_scan_none           * 候補を使い切った

        lea     fake_file(pc),a1
        tst.w   d3
        beq.s   cmd10_scan_cand
        lea     fake_file2(pc),a1
cmd10_scan_cand:
        lea     c10_pat_name(pc),a2       * a2 = パターン(11B: 名前8+拡張子3)
        moveq   #11-1,d2
cmd10_scan_cmp:
        move.b  (a2)+,d1
        cmp.b   #'?',d1
        beq.s   cmd10_scan_cmp_next
        cmp.b   (a1),d1
        bne.s   cmd10_scan_nomatch
cmd10_scan_cmp_next:
        addq.l  #1,a1
        dbra    d2,cmd10_scan_cmp

* 一致: この候補(d3)をFILBUFへコピーしてから、探索位置をd3+1へ進める。
        move.l  18(a0),a2                * a2 = FILBUFへの出力先(far pointer)
        lea     10(a2),a2
        lea     fake_file(pc),a1
        tst.w   d3
        beq.s   cmd10_scan_srccopy
        lea     fake_file2(pc),a1
cmd10_scan_srccopy:
        moveq   #43-1,d2
cmd10_scan_copy:
        move.b  (a1)+,(a2)+
        dbra    d2,cmd10_scan_copy

        addq.w  #1,d3
        move.w  d3,(a3)

        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        move.l  #0,18(a0)
        moveq   #0,d0
        bra.w   done

cmd10_scan_nomatch:
        addq.w  #1,d3
        bra.w   cmd10_scan_loop

cmd10_scan_none:
        move.w  d3,(a3)                   * 探索位置を2(使い切り)に固定
        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        cmp.b   #$47,2(a0)
        beq.s   cmd10_scan_none_47
        move.l  #-18,18(a0)               * $48: もう無い
        moveq   #0,d0
        bra.w   done
cmd10_scan_none_47:
        move.l  #-2,18(a0)                * $47: 見つからない
        moveq   #0,d0
        bra.w   done

        ifne C11_MODE
* -----------------------------------------------------------------------
* cmd11_scan -- C11: c11_tree(0=ルート/1=\SUB\/2=その他)に応じた候補集合で
* 照合する(cmd10_scanのツリー対応版)。ルートはfake_file(HELLO.TXT)/
* fake_file2(WORLD.DOC)/fake_dir_sub(SUB)の3件、\SUB\はfake_file_abc
* (ABC.TXT)の1件、その他は0件(即「見つからない」= cmd10_scan_noneへ)。
* 一致・使い切りの返し方はcmd10_scanと同じくcmd10_scan_noneを共用する。
* -----------------------------------------------------------------------
cmd11_scan:
        lea     c10_search_idx(pc),a3
        move.w  (a3),d3                  * d3 = 現在の探索位置(ツリー内の番号)

        move.w  c11_tree(pc),d4
        cmp.w   #0,d4
        beq.s   cmd11_scan_root
        cmp.w   #1,d4
        beq.s   cmd11_scan_sub
        bra.w   cmd10_scan_none           * その他のツリー: 即座に0件扱い

cmd11_scan_root:
        cmp.w   #3,d3
        bge.w   cmd10_scan_none
        bsr.w   cmd11_root_addr           * d3→a1
        bra.w   cmd11_scan_cmp

cmd11_scan_sub:
        cmp.w   #1,d3
        bge.w   cmd10_scan_none
        lea     fake_file_abc(pc),a1
        bra.w   cmd11_scan_cmp

cmd11_scan_cmp:
        lea     c10_pat_name(pc),a2        * a2 = パターン(11B: 名前8+拡張子3)
        moveq   #11-1,d2
cmd11_scan_cmp_loop:
        move.b  (a2)+,d1
        cmp.b   #'?',d1
        beq.s   cmd11_scan_cmp_next
        cmp.b   (a1),d1
        bne.s   cmd11_scan_nomatch
cmd11_scan_cmp_next:
        addq.l  #1,a1
        dbra    d2,cmd11_scan_cmp_loop

* 一致: この候補(d3, c11_tree)をFILBUFへコピーしてから、探索位置をd3+1へ
* 進める。
        move.l  18(a0),a2                  * a2 = FILBUFへの出力先(far pointer)
        lea     10(a2),a2
        cmp.w   #0,d4
        beq.s   cmd11_scan_copy_root
        lea     fake_file_abc(pc),a1
        bra.w   cmd11_scan_copy_body
cmd11_scan_copy_root:
        bsr.w   cmd11_root_addr
cmd11_scan_copy_body:
        moveq   #43-1,d2
cmd11_scan_copy_loop:
        move.b  (a1)+,(a2)+
        dbra    d2,cmd11_scan_copy_loop

        addq.w  #1,d3
        move.w  d3,(a3)

        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        move.l  #0,18(a0)
        moveq   #0,d0
        bra.w   done

cmd11_scan_nomatch:
        addq.w  #1,d3
        move.w  d3,(a3)                    * 次のcmd11_scan呼び出しのためd3を保存
        bra.w   cmd11_scan

* --- 入力: d3(0/1/2、ルートツリー内の候補番号) 出力: a1=候補のアドレス。
* d3以外のレジスタは破壊しない ---
cmd11_root_addr:
        cmp.w   #0,d3
        beq.s   cmd11_ra_0
        cmp.w   #1,d3
        beq.s   cmd11_ra_1
        lea     fake_dir_sub(pc),a1
        rts
cmd11_ra_0:
        lea     fake_file(pc),a1
        rts
cmd11_ra_1:
        lea     fake_file2(pc),a1
        rts

* -----------------------------------------------------------------------
* cmd11_check_path -- _NAMESTSのパス欄(a1=+2以降の先頭、$09開始・$00終端)
* を見て、ルート("\"のみ=$09 $00)/\SUB\(大小文字を区別しない)/その他を
* 判定する。出力: d0 = 0(ルート) / 1(\SUB\) / 2(その他)。d1とa1(消費して
* 進める)を破壊する。
* -----------------------------------------------------------------------
cmd11_check_path:
        move.b  (a1)+,d1
        cmp.b   #$09,d1
        bne.s   cmd11_cp_other
        move.b  (a1),d1
        tst.b   d1
        beq.s   cmd11_cp_root
        and.b   #$df,d1                    * 'a'-'z' → 'A'-'Z'(この用途に限り安全)
        cmp.b   #'S',d1
        bne.s   cmd11_cp_other
        move.b  1(a1),d1
        and.b   #$df,d1
        cmp.b   #'U',d1
        bne.s   cmd11_cp_other
        move.b  2(a1),d1
        and.b   #$df,d1
        cmp.b   #'B',d1
        bne.s   cmd11_cp_other
        cmp.b   #$09,3(a1)
        bne.s   cmd11_cp_other
        tst.b   4(a1)
        bne.s   cmd11_cp_other
        moveq   #1,d0
        rts
cmd11_cp_root:
        moveq   #0,d0
        rts
cmd11_cp_other:
        moveq   #2,d0
        rts
        endc
        endc

        ifne C9_MODE
* --- C9: 「開く」らしいコマンド(CMD_OPENで指定)。常に成功(+18=0)を返す。
* readの呼び出し回数カウンタをここで0へ戻す(1ファイルぶんの読み出し状態
* を素朴に1個のグローバルカウンタで代用する。推測: openのたびにリセット
* すれば足りるはず) ---
cmd_open_ok:
        ifne C10_MODE
        lea     c10_read_pos(pc),a1
        move.l  #0,(a1)                 * C10: 読み位置を0に戻す(1ファイルぶんのみ保持)
        ifne C11_MODE
* C11: _NAMESTS(+14が指す、$47と共通と仮定)のパス欄を見て、開くファイルを
* ルート=HELLO.TXT(3000B)/\SUB\=ABC.TXT(12B)から選び、c11_cur_file/
* c11_cur_lenへ残す(cmd_read_okが使う)。
        move.l  14(a0),a1
        lea     2(a1),a1
        bsr.w   cmd11_check_path
        lea     c11_cur_file(pc),a2
        move.w  d0,(a2)
        lea     c11_cur_len(pc),a2
        cmp.w   #1,d0
        bne.s   cmd11_open_len_hello
        move.l  #12,(a2)
        bra.s   cmd11_open_len_done
cmd11_open_len_hello:
        move.l  #3000,(a2)
cmd11_open_len_done:
        endc
        else
        lea     c9_read_count(pc),a1
        move.w  #0,(a1)
        endc
        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        move.l  #0,18(a0)
        moveq   #0,d0
        bra.w   done

* --- C9: 「読む」らしいコマンド(CMD_READで指定)。1回目はCMD_READ_BUF_OFF
* (既定+18)が指すバッファへ'Hello from host!\r\n'(18バイト、推測: 改行は
* CRLF)を書き、+18へ読んだバイト数(18)を返す。2回目以降は+18=0(EOF)。
* バッファ先頭アドレスは読み終えてから+18を上書きする(CMD_READ_BUF_OFF=18
* のとき入力/出力が同じ欄を兼ねるため) ---
cmd_read_ok:
        ifne C10_MODE
        ifne C11_MODE
* C11: c10_read_pos(0..c11_cur_len)から、要求長(18(a0)、推測)と残り
* バイト数の小さいほうだけ、開いているファイル(c11_cur_file: 0=hello3000
* /1=abc_content)からコピーし、読み位置を進めて返す(C10のhello3000固定
* 版と同じ組み立て、長さと参照元だけをc11_cur_len/c11_cur_fileで振る)。
        lea     c10_read_pos(pc),a1
        move.l  (a1),d1                   * d1 = 現在の読み位置
        move.l  c11_cur_len(pc),d4         * d4 = 開いているファイルの長さ
        cmp.l   d4,d1
        bge.w   cmd_read_eof

        move.l  18(a0),d2                  * d2 = 要求長(推測)
        move.l  d4,d3
        sub.l   d1,d3                       * d3 = 残りバイト数
        cmp.l   d3,d2
        bls.s   cmd11_read_uselen
        move.l  d3,d2
cmd11_read_uselen:
        movea.l CMD_READ_BUF_OFF(a0),a2
        move.w  c11_cur_file(pc),d5
        cmp.w   #1,d5
        beq.s   cmd11_read_src_abc
        lea     hello3000(pc),a3
        bra.s   cmd11_read_src_done
cmd11_read_src_abc:
        lea     abc_content(pc),a3
cmd11_read_src_done:
        adda.l  d1,a3                       * a3 = 先頭 + 現在位置
        move.l  d2,d3
        beq.s   cmd11_read_zero
        subq.l  #1,d3
cmd11_read_copy:
        move.b  (a3)+,(a2)+
        dbra    d3,cmd11_read_copy
cmd11_read_zero:
        add.l   d2,d1
        move.l  d1,(a1)                     * 読み位置を進める

        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        move.l  d2,18(a0)
        moveq   #0,d0
        bra.w   done
        else
* C10: c10_read_pos(0..3000)から、要求長(18(a0)、推測)と残りバイト数の
* 小さいほうだけhello3000からコピーし、読み位置を進めて返す。
        lea     c10_read_pos(pc),a1
        move.l  (a1),d1                 * d1 = 現在の読み位置
        cmp.l   #3000,d1
        bge.w   cmd_read_eof

        move.l  18(a0),d2                * d2 = 要求長(推測)
        move.l  #3000,d3
        sub.l   d1,d3                     * d3 = 残りバイト数
        cmp.l   d3,d2
        bls.s   cmd10_read_uselen         * 要求長<=残り: 要求長ぶん返す
        move.l  d3,d2                     * 残りぶんだけ返す
cmd10_read_uselen:
        movea.l CMD_READ_BUF_OFF(a0),a2   * a2 = バッファ(推測: +14)
        lea     hello3000(pc),a3
        adda.l  d1,a3                     * a3 = hello3000 + 現在位置
        move.l  d2,d3
        beq.s   cmd10_read_zero
        subq.l  #1,d3
cmd10_read_copy:
        move.b  (a3)+,(a2)+
        dbra    d3,cmd10_read_copy
cmd10_read_zero:
        add.l   d2,d1
        move.l  d1,(a1)                   * 読み位置を進める

        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        move.l  d2,18(a0)
        moveq   #0,d0
        bra.w   done
        endc
        else
        lea     c9_read_count(pc),a1
        move.w  (a1),d1
        bne.s   cmd_read_eof

        movea.l CMD_READ_BUF_OFF(a0),a2 * a2 = バッファへのfar pointer(推測)
        lea     c9_hello(pc),a3
        moveq   #18-1,d2
cmd_read_copy:
        move.b  (a3)+,(a2)+
        dbra    d2,cmd_read_copy

        move.w  #1,(a1)                 * 次回からEOFにする
        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        move.l  #18,18(a0)
        moveq   #0,d0
        bra.w   done
        endc

cmd_read_eof:
        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        move.l  #0,18(a0)
        moveq   #0,d0
        bra.w   done

* --- C9: 「閉じる」らしいコマンド(CMD_CLOSEで指定)。常に成功を返す ---
cmd_close_ok:
        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        move.l  #0,18(a0)
        moveq   #0,d0
        bra.w   done

        ifne C11_MODE
* --- C11: 「cd」らしいコマンド(CMD_CDで指定)。+14の先(_NAMESTSと仮定、
* $47/$4aと共通)のパス欄を見て、ルートか\SUB\なら成功(+18=0)、それ以外は
* -3(ディレクトリが見つからない)を返す。 ---
cmd_cd_ok:
        move.l  14(a0),a1
        lea     2(a1),a1
        bsr.w   cmd11_check_path
        move.b  #$00,3(a0)
        move.b  #$00,4(a0)
        cmp.w   #2,d0
        beq.s   cmd11_cd_bad
        move.l  #0,18(a0)
        moveq   #0,d0
        bra.w   done
cmd11_cd_bad:
        move.l  #-3,18(a0)
        moveq   #0,d0
        bra.w   done
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
        ifne C9_MODE
        bge.w   rec_ret                 * あふれた: 記録せず戻る(C9は新規コードが挟まり.sでは届かない)
        else
        bge.s   rec_ret                 * あふれた: 記録せず戻る
        endc

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

        ifne C9_MODE
* C9/C10: コマンド番号を問わず、+14/+18(C10はさらに+22)が「ゲストRAMを
* 指すポインタらしい値」(0<val<$C00000 かつ偶数)ならその先を記録する
* (+14→entry+28に64B、+18→entry+92に64B、C10のみ+22→entry+156に96B=
* FCB候補)。a2=entry先頭(固定)を使って各フィールドを独立に書くので、
* 途中を飛ばしても後続の位置がずれない。
        move.l  14(a0),d1
        beq.s   rec_c9_p14_skip          * 0はポインタとみなさない
        cmp.l   #$00c00000,d1
        blo.s   rec_c9_p14_lo
        bra.s   rec_c9_p14_skip
rec_c9_p14_lo:
        move.l  d1,d2
        and.l   #1,d2
        bne.s   rec_c9_p14_skip          * 奇数番地はポインタとみなさない
        movea.l d1,a4
        lea     28(a2),a3
        moveq   #64-1,d3
rec_c9_p14_copy:
        move.b  (a4)+,(a3)+
        dbra    d3,rec_c9_p14_copy
rec_c9_p14_skip:

        move.l  18(a0),d1
        beq.s   rec_c9_p18_skip
        cmp.l   #$00c00000,d1
        blo.s   rec_c9_p18_lo
        bra.s   rec_c9_p18_skip
rec_c9_p18_lo:
        move.l  d1,d2
        and.l   #1,d2
        bne.s   rec_c9_p18_skip
        movea.l d1,a4
        lea     92(a2),a3
        moveq   #64-1,d3
rec_c9_p18_copy:
        move.b  (a4)+,(a3)+
        dbra    d3,rec_c9_p18_copy
rec_c9_p18_skip:

        ifne C10_MODE
        move.l  22(a0),d1
        beq.s   rec_c10_p22_skip
        cmp.l   #$00c00000,d1
        blo.s   rec_c10_p22_lo
        bra.s   rec_c10_p22_skip
rec_c10_p22_lo:
        move.l  d1,d2
        and.l   #1,d2
        bne.s   rec_c10_p22_skip
        movea.l d1,a4
        lea     156(a2),a3
        moveq   #96-1,d3
rec_c10_p22_copy:
        move.b  (a4)+,(a3)+
        dbra    d3,rec_c10_p22_copy
rec_c10_p22_skip:
        endc

        bra.w   rec_bump
        else
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
        endc

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
        ifne C10_MODE
        dc.l    3000                    * +26 ファイルサイズ(C10: hello3000と一致させる)
        else
        dc.l    1234                    * +26 ファイルサイズ
        endc
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

        ifne C9_MODE
* safety_hitが1バイトで奇数番地になりうるため、dc.wの前でevenを打つ
* (実測: 打たないとc9_read_countが奇数番地に来てmove.w #0,(a1)でアドレス
* エラーになった。PC=header+$25a)。
        even
c9_read_count:
        dc.w    0                * C9: 「読む」が何回呼ばれたか(open成功で0に戻す)
c9_hello:
        dc.b    'Hello from host!',$0d,$0a  * C9: 「読む」1回目で返す18バイト(推測: 改行はCRLF)
        even

        ifne C10_MODE
* --- C10: $47/$48のワイルドカード照合で使う状態 ---
c10_pat_name:
        ds.b    8                * 検索パターンの名前8(前回の$47から保存、'?'=ワイルドカード)
c10_pat_ext:
        ds.b    3                * 検索パターンの拡張子3
        even
c10_search_idx:
        dc.w    0                * 次に調べる候補番号(0=fake_file,1=fake_file2,2=使い切り)
c10_read_pos:
        dc.l    0                * HELLO.TXTの読み位置(0..3000、openで0に戻す)

* --- C10: HELLO.TXTの中身(3000バイト=60バイト×50行)。実データを使うのは
* $4c(読む)がファイルサイズ・シーク位置と整合する結果を返せるようにする
* ため(推測に頼らず本物の長さのデータで動作を確かめる)。---
hello3000:
        include "hello3000.inc.s"
hello3000_end:

        ifne C11_MODE
* --- C11: SUBディレクトリ(ルート直下、属性$10)のエントリ ---
fake_dir_sub:
        dc.b    'SUB',32,32,32,32,32    * +10 名前8
        dc.b    32,32,32                * +18 拡張子3(ディレクトリなので空白)
        dc.b    $10                     * +21 属性=ディレクトリ
        dc.w    0                       * +22 時刻(無指定=0)
        dc.w    0                       * +24 日付(無指定=0)
        dc.l    0                       * +26 サイズ(ディレクトリなので0)
        dc.b    'SUB'
        dcb.b   20,0
fake_dir_sub_end:

* \SUB\ABC.TXT / 12バイト('abc in sub\r\n') / 属性$20
fake_file_abc:
        dc.b    'ABC',32,32,32,32,32    * +10 名前8
* +18 拡張子3
        dc.b    'TXT'
        dc.b    $20                     * +21 属性
        dc.w    $645c                   * +22 最終変更時刻(HELLO.TXTと同じ値を仮に流用)
        dc.w    $5d2b                   * +24 最終変更日
        dc.l    12                      * +26 ファイルサイズ
        dc.b    'ABC.TXT'
        dcb.b   16,0
fake_file_abc_end:

* fake_dir_sub/fake_file_abc(いずれも43バイト、奇数)の直後なので、ワード/
* ロング変数の前にevenを打つ(fake_file等と同じ理由。実測はC10側のコメント
* 参照)。
        even
c11_tree:
        dc.w    2                * $47直後に設定: 0=ルート 1=\SUB\ 2=その他(該当ツリー無し)
c11_cur_file:
        dc.w    0                * $4a(開く)で設定: 0=HELLO.TXT(root) 1=ABC.TXT(\SUB\)
c11_cur_len:
        dc.l    0                * 開いたファイルの長さ($4c読み終わり判定用。open時に3000/12を設定)

* abc_content: \SUB\ABC.TXTの中身(12バイト、fake_file_abcの+26サイズと一致)
abc_content:
        dc.b    'abc in sub',$0d,$0a
abc_content_end:
        endc
        endc
        endc

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
