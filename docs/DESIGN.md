# WebX68k 設計メモ

利用者向けの説明は [README.md](../README.md) / [README.ja.md](../README.ja.md) を参照してください。

ブラウザ上で動作する X68000 エミュレータのフロントエンドです。エミュレーション本体には
[px68k-libretro](https://github.com/) の `emscripten` ブランチを WebAssembly にビルドしたものを利用します。
Vite + TypeScript（フレームワーク無し）の最小構成です。

## 構成

- `scripts/build-core.sh` … px68k-libretro コアを emscripten でビルドし、`public/core/` に配置する
- `public/core/` … ビルド済みの `px68k_libretro.js` / `px68k_libretro.wasm`（コミット対象）
- `_local/verify/` … 動作検証用の実機 ROM / HDD イメージ置き場（`.gitignore` 対象・非配布）。
  `public/` 配下に置くとビルド時に `dist/` へコピーされ配布物に混入するため、必ずここに置くこと
- `src/libretro-host.ts` … libretro コールバックを wasm 関数テーブルに登録し、コアを駆動するホスト実装
- `src/audio.ts` … AudioWorklet によるストリーミング音声出力
- `src/keyboard.ts` … `KeyboardEvent.code` → `RETROK_*` のマッピング
- `src/virtual-keyboard.ts` … X68000仮想キーボード、Pointer管理、物理入力との押下状態統合
- `src/bios-store.ts` … BIOS ファイルを IndexedDB に永続化するヘルパー
- `src/sram-store.ts` … SRAM(SWITCH.Xの設定)を IndexedDB に永続化するヘルパー(後述)
- `src/disk-store.ts` … ディスクイメージ(FD/HDD)を IndexedDB に永続化する「ディスクライブラリ」ヘルパー。
  拡張子なしイメージの内容ベース判定(`classifyDiskBytes()`/`detectDiskContentKind()`)もここにある(後述)
- `src/api/archive.ts` … LZH/ZIP アーカイブ展開の公開API。拡張子判定と `lzh.ts`/`zip.ts` への振り分けのみ行う
- `src/api/lzh.ts` … LZH 展開(ヘッダレベル0/1/2、メソッド lh0/lh5/lh6/lh7 対応)
- `src/api/zip.ts` … ZIP 展開(圧縮方式 stored/deflate のみ対応。deflate は `DecompressionStream('deflate-raw')`)
- `src/api/library.ts` … ディスクライブラリ一覧の構築(フラットな IndexedDB レコードを、アーカイブ由来の
  複数ディスクをフォルダとしてまとめたツリーへ変換する)。DOM非依存の純粋関数で単体テスト可能
- `src/core-shim.c` … アクセスランプ取得等、libretro API に無い可変長引数/グローバル参照のための C シム
- `src/text-screen.ts` … TVRAM の8x16 ANK／16x16漢字をCGROMグリフへ完全一致させるテキスト取得
- `src/state-store.ts` … ステートセーブを IndexedDB に永続化するヘルパー(gzip 圧縮)
- `src/bridge.ts` … MCP サーバーと繋ぐ WebSocket ブリッジ(`?bridge=1` で有効)
- `mcp/` … MCP サーバー(stdio) + WebSocket ブリッジ。詳細は [mcp/README.md](mcp/README.md)
- `src/main.ts` … UI 配線・メインループ（FDD0/FDD1/HDD の3スロット、アクセスランプ、起動前オーバーレイ等）

## コアのビルド手順

前提として以下がセットアップ済みであること:

- `px68k-libretro`（`emscripten` ブランチ）を `../px68k-libretro` に配置
- emsdk をセットアップ済み（`emsdk_env.sh` が存在すること）

パスは `scripts/build-core.sh` 内で固定指定しているため、環境が異なる場合はスクリプト先頭の
`EMSDK_DIR` / `CORE_SRC_DIR` を書き換えてください。

```bash
bash scripts/build-core.sh
```

成功すると `public/core/px68k_libretro.js` と `public/core/px68k_libretro.wasm` が生成されます。
`px68k-libretro` 側は WebX68k 用の fork（`emscripten` ブランチ）で、アクセスランプ対応のため
`x68k/fdd.c` / `x68k/sasi.c` / `libretro.c` に最小限のパッチを当てています（後述）。

## FDD0 / FDD1 / HDD 同時搭載の仕組み

px68k-libretro の `retro_load_game` は `.cmd` ファイルを渡すとコマンドライン展開する
（`libretro.c` の `pmain()`）。素の仕組みでは

- `px68k <fd0path> <fd1path>` → `Config.FDDImage[0]` / `[1]` を設定(FDD0+FDD1)
- `px68k -h <hdfpath>` → `Config.HDImage[0]` を設定。ただしこの形式は `argc==3` 限定で、
  HDD と FDD を cmd ファイル経由で同時指定することはできない

という制約がある。WebX68k はこれを回避するため、`px68k_save_hdd_path` という
（ドキュメント化されていない）libretro コアオプションを利用している。これを `enabled` にすると
`LoadConfig()`（`libretro/prop.c`）が起動時に `<system>/keropi/config` という INI ファイルから
`[WinX68k]` セクションの `HDD0=...` を読み込み、`Config.HDImage[0]` にセットする。この読み込みは
cmd ファイルによる FDD0/FDD1 設定と競合しないため、

- `.cmd` ファイル（`/game/boot.cmd`、内容は `px68k "<fdd0path>" "<fdd1path>"`）で FDD0/FDD1 を指定
- `/system/keropi/config` に `[WinX68k]\r\nHDD0=<hddpath>\r\n` を書き込んで HDD0 を指定

を両方行うことで、**FDD0 / FDD1 / HDD の3台を排他無しで同時搭載**できている
（`src/main.ts` の `bootCore()` 参照）。空きスロットは cmd ファイル側で空文字列を渡している
（`FDD_SetFD` は空パスだと安全にドライブ未挿入のままになる）。

## アクセスランプの実装

ドライブ行のランプは「ディスク挿入中」ではなく実機同様の**アクセスランプ**（既定は消灯、
実際に読み書きしたフレームだけ点灯）。px68k-libretro fork 側に以下の最小パッチを追加している。

- `x68k/fdd.c` / `x68k/fdd.h`: 既存の `FDD_IsReading`（読み込みフレームで1、`retro_run()` の
  毎フレーム先頭で0クリア）に加えて `FDD_AccessDrive`（直近アクセスしたドライブ番号）を追加。
  `FDD_Read()` に加え `FDD_Write()` でもこの2つをセットするようにし、書き込みアクセスでも
  ランプが点灯するようにした。ドライブ別（FDD0/FDD1）に点灯できる。
- `x68k/sasi.c` / `x68k/sasi.h`: HDD(SASI) 側には同種のフラグが無かったため `SASI_IsAccessing`
  を新設し、`SASI_Read()`/`SASI_Write()` のデータ転送タイミングでセット。`libretro.c` の
  `retro_run()` 冒頭（`FDD_IsReading = 0;` の直後）で毎フレームクリアしている。HDD は本UIでは
  1台のみ扱うためドライブ番号までは持たせていない。
- `src/core-shim.c`: 上記グローバルを `get_fdd_is_reading()` / `get_fdd_access_drive()` /
  `get_sasi_is_accessing()` として getter でラップし、`build-core.sh` の
  `EXPORTED_FUNCTIONS` に追加。`src/libretro-host.ts` の `readDiskAccess()` が
  `retro_run()` 直後にこれらを読み出し、`src/main.ts` 側で「直近アクセスから約120ms は
  点灯を保持する」残光処理をしてランプ表示に反映している。

## ディスクのホットマウント(FDD)

FDD0/FDD1 の挿入・取り出しは**コアを再起動せず**に行う。px68k 本体の `FDD_SetFD()` /
`FDD_EjectFD()` は実行中に呼んでも安全で、挿入時は `SetDelay` 経由、取り出し時は即座に FDC の
割り込みを上げるため、ゲスト(Human68k 等)にもメディア交換として正しく通知される。

- `src/core-shim.c` の `webx68k_fdd_insert()` / `webx68k_fdd_eject()` でこの2つを公開し、
  `build-core.sh` の `EXPORTED_FUNCTIONS` に追加している
- `src/libretro-host.ts` の `setFddImage(drive, path)`(空パスで取り出し)から呼ぶ
- `src/main.ts` の `hotSwapFdd()` が「新イメージをFSへ書き出す → `setFddImage()` → 旧FSファイル削除」
  の順で処理する。`FDD_SetFD()` は内部で先に旧ディスクを Eject する(= 旧イメージのファイルへ
  書き戻す)ため、この順序を守ること

一方 HDD(SASI)は実機でも活線挿抜する機器ではなく、差し替えるとゲスト側が握っているマウント情報・
キャッシュと実体がズレるため、**起動後は挿入も取り出しも禁止**している(`main.ts` の
`isSlotLocked()` / `updateSlotControls()`)。HDD行のボタンは起動と同時に無効化され、
ドラッグ&ドロップ等の経路も `insertDiskBytes()` / `ejectSlot()` の入口で弾く。ファイルマネージャからも
起動中の HDD は読み出し専用(`editable: false`、`persist()` は拒否)になる。ダウンロードは中身を
読むだけなので起動中でも可能。ツールバーの「リセット」は `restartCore()`(後述「リセットボタンの
ハードリセット化」参照)でコアを丸ごと作り直すが、この再起動は `running = false` にした直後に
`bootCore()` を自動で呼び直す一連の処理で、ユーザー操作の入る隙間なく `running` が再び真に戻る
(`updateSlotControls()` も再起動完了後にしか呼ばれないため、UI上もロック解除は一度も見えない)。
そのため**HDD を入れ替えたいときは今までどおりページを再読み込みして起動前の状態に戻す**。

### 書き戻しの反映は同期で行う(リセットでセーブが巻き戻る競合)

`persistSlotToLibrary()` の吸い出し(`readLiveSlotImage()`)は同期だが、以前は吸い出した
バイト列の `slots[].data` への反映を IndexedDB(`saveDisk()`)の完了後に回していた。
`restartCore()` は `flushAllSlots()` の直後に `bootCore()` が `slots[].data` からディスクを
書き直すため、この順序だと **IndexedDB の書き込みが終わる前に古いバイト列で再マウント**され、
「ゲーム中のセーブがリセットで巻き戻る」事故になる(IndexedDB の遅い iOS Safari で顕在化。
天下統一のディスク2セーブ消失として実機で発覚)。反映は吸い出しと同じ同期区間で行い、
IndexedDB への書き込みだけが非同期で後を追う形にしている。

### 実行中の排出には確認を挟む

排出はスロットを即座に空にするため、ディスクを読んでいるゲストはそのままフリーズする。
タッチ操作ではドライブ行の排出ボタンの誤タップが起きやすく(天下統一プレイ中に FDD1 が
突然空になりフリーズ、として実機で発覚)、実行中の排出には `confirm()` を挟む。
ディスク交換は排出を経ずに挿入(ホットスワップ)でできるため、実行中に排出ボタンが必要な
場面は稀。MCPブリッジ経由の `eject_disk` は明示的な操作なので確認なしで従来どおり排出する。
実行中のリセットボタンも同じ理由(誤タップで進行を失う)で `confirm()` を挟む。

**px68k はディスク形式を拡張子だけで判定する。** `px68k-libretro/x68k/fdd.c` の
`GetDiskType()` は `.D88`/`.88D` → D88、`.DIM` → DIM、それ以外はすべて XDF(生イメージ)として
扱う。したがって、アーカイブ内の拡張子なしイメージに拡張子を補完するとき **種別を間違えると
ディスクが壊れて見える**(DIMヘッダをディスクデータとして読んでしまう等)。

このためアーカイブ内のエントリに限り、`src/disk-store.ts` の `classifyDiskBytes()` /
`detectDiskContentKind()` が拡張子に頼らない内容ベースの判定を行う(単体ファイルのドロップ/
ファイル選択は従来どおり**拡張子判定のみ**で、無関係なファイルを受け入れないようにしている)。
判定順序は次のとおり:

1. 拡張子で判定できるならそれを使う(挙動を変えない)
2. オフセット `0x400` に `X68K` シグネチャがあれば `hdd`(`src/api/fat.ts` の
   `hasHuman68kPartitionSignature()`、Human68k パーティション判定と同一ロジック)
3. バイト長がX68000の既知の生フロッピーイメージサイズ(XDF)と完全一致すれば `fd`
4. px68k の DIM 実装と整合する DIM ヘッダ付きイメージなら `fd`(保存時に `.dim` を補う。
   下記参照)
5. どれにも当たらなければ `null`(ディスクイメージ以外として除外)

**DIM 判定は px68k の `disk_dim.c` と整合する条件でのみ認める。** 「生サイズ+256なら DIM」
という緩い判定は誤判定する。`isValidDimImage()` は以下の両方を満たす場合だけ DIM と認める:

1. 先頭バイト(type)が有効な DIM タイプ(`DIM_TRACK_LENGTH` に定義された 0/1/2/3/9)であること
2. `(バイト長 - 256)` がそのタイプの1トラックあたりのバイト数で割り切れること(トラック数が
   整数になること)

実物の X68000 の DIM(市販ソフト「ストリートファイターII CE」4枚組)で確認したところ、
`type=0x00`(2HD)・`DIFC HEADER` 署名あり・`(1261824-256)/8192 = 154.0` だった。逆に緩い判定で
誤検出する例として、PC-98由来で `DIFC HEADER` 署名を持たないアーカイブ内ファイルが
`type=1`(2HS)なのに `(サイズ-256)` が2HSのトラック長(9216)で割り切れないケースがある。

拡張子補完(`ensureDiskExtension()`)は、内容ベースで DIM と判定した場合は必ず `.dim` を補う
(`.xdf` にはしない)。ライブラリ表示のバッジ判定(`buildLibraryRow` の `classifyDiskKind()`)が
拡張子で行われるため、ここを誤ると表示上の種別も壊れる。

D&D の受け口は画面(`.stage`)・各ドライブ行・ディスクライブラリのダイアログ(`#library-backdrop
.rom-modal`)の3か所(`src/main.ts` の `resolveStageDropSlot()` / `handleDroppedFileForLibrary()`
付近)。複数枚入りアーカイブはどの受け口でもスロットへは自動装填せず、ライブラリへグループ登録して
ダイアログを開く(どこへ入れるかはユーザーに選ばせる)方針で統一している。

URL パラメータ `?lib=<url>`(`&lib=<url2>` で複数指定可、`src/main.ts` の
`resolveUrlToLibrary()` / `resolveUrlLibContent()`)は、この方針を共有リンク用途に適用したもの。
枚数によらず(1枚でも)スロットへは自動挿入せずライブラリへ登録してダイアログを開き、
`run=1` があっても自動起動しない。`fd1`/`fd2`/`hdd`(`resolveUrlSlotContent()`)と異なり
種別(FD/HDD)チェックも行わないため、混在アーカイブもそのまま登録できる。`fd1`/`fd2`/`hdd`
と併用した場合はスロット処理を先に行ってから `lib` を処理する。再訪時は `arcurl:<url>` を
キーに IndexedDB から復帰し、再ダウンロードしない。

URL パラメータ `?ram=<1〜12>`(`src/url-params.ts` の `parseRamSizeParam()`、呼び出しは
`src/main.ts` のマシン構成初期化箇所)は、共有URLで推奨RAM容量まで再現できるようにするための
起動時オーバーライド。`localStorage` には**意図的に保存しない**。`cpuSpeed`/`ramSize` の
既定値は「前回ユーザーが選んだ値」を保持する設計だが、共有リンクはクリックしただけで開かれる
ものであり、リンクを踏んだだけで利用者の既定設定が書き換わってしまうと、リンク経由の閲覧が
副作用として設定破壊を伴うことになる。そのため `?ram=` は該当セッションの `ramSize` 変数のみを
上書きし、設定UI(`cfgRamSize.value`)には実際に効いている値を表示しつつ、ユーザーが select を
自分で操作するまでは保存しない。不正値(範囲外・非数値など)は無視して `console.warn` するのみで、
既存の保存値/既定値へフォールバックする(`fd1`/`fd2`/`hdd` のようにエラー表示や起動停止はしない)。
`?cpu=<10|16|25|33|66|100>`(`parseCpuSpeedParam()`)も同じ扱いで、`cpuSpeed` 変数のみを
上書きし `localStorage` には保存しない。`?aspect=<4:3|native>`(`parseAspectModeParam()`)も
同様に `aspectMode` 変数のみを上書きし、`localStorage` には保存しない。

## TVRAM テキスト取得

X68000 の TVRAM は文字コードではなく 1024x1024x4プレーンのビットマップである。
`src/text-screen.ts` は4プレーンを論理ORし、8x16セルを `cgrom.dat` の ANK 8x16ブロック
（オフセット `0x3a800`、1文字16バイト）、隣接2セルを16x16漢字ブロックの逆引き表へ完全一致させる。
`TextScrollX/Y` を加味して循環サンプリングするため、CRTCスクロール後も表示座標を基準にできる。
空セルは空白、未知グリフは `�` とし、行末だけをトリムする。戻り値には行配列に加えて、非空・一致・
未知セル数、一致率、プレーン別非空セル数、`kanjiFontAvailable` を含め、TVRAM未使用画面と
未対応グリフ、漢字フォント欠落を区別可能にしている。

16x16漢字の配置は `tools/gen-cgrom/generate.js` が参照した XEiJ `FNT_ADDRESS_*` 定数と
`romCreateFont()` に基づく。先頭オフセットは `0x000000`、1字32バイト（各行を左、右の順）で、
JIS X 0208の1～8区（752字）に16～84区（6486字）が続く。Shift_JISを標準規則でJIS区点へ戻し、
`((区インデックス * 94) + 点 - 1) * 32` で位置を求める（区インデックスは1～8区が0～7、
16～84区が8～76）。同梱ROMの実測では全7238スロット中6878スロットが非空だった。

走査では16x16一致を先に試して一致時に2セルを消費する。ただし左右の8x16字形がどちらも有効な
ANKならANK 2文字を優先し、偶然16x16漢字と同形になる誤検出を避ける。

全角文字は画面上で2列(16px)を占めるが、**文字列には1文字として入れる**。したがって行内の
文字数と列数は一致しない。列位置が必要な場合は全角を2として数える。ANKのみの行では従来どおり
「文字列インデックス = 列位置」が成立する。以前は全角直後に不可視のU+200Bを継続セルとして
挿入して厳密に一致させていたが、MCPで受け取る側の比較・検索・コピーで実害が出るため廃止した
(実測で判断)。漢字領域が全ゼロ・一部欠落・短縮
されていても空字形を登録せず、利用可能な字形だけを使う。漢字が1字もなければ
`kanjiFontAvailable: false` としてANK抽出を継続する。

逆引きに使う CGROM は、`LibretroHost.init()` が受け取った `biosCg` を一度だけ複製した
`coreCgrom` を単一供給元とする。この同じ配列を `/system/keropi/cgrom.dat` へ書き込み、
`readTextScreen()` も参照する。コアと逆引きで字形が1バイトでも異なると完全一致が成立しないため、
設定済み CGROM を別経路で再取得してはならない。未初期化・CGROM未設定・ANK領域まで届かない
短いCGROM・コア参照失敗は例外にせず、`available: false` と理由、空の行・ゼロ診断を返す。

取得対象はTVRAMの8x16 ANKと16x16漢字である。TVRAM以外の GVRAM / BG / スプライトに描かれた文字、
および8x16セルに整列しない描画は取得できない。ゲームの多くはグラフィック側へ文字を描くため、
カバレッジが0に近い場合はスクリーンショットで確認する必要がある。

`core-shim.c` のTVRAMポインタと表示範囲getterを使う。`test/text-screen.test.ts` は合成TVRAMで
4プレーン・列位置・スクロールに加え、合成CGROMで漢字単独、ANK混在、漢字欠落、ANK優先を常時検証し、
Node上のwasm実メモリも検証する。旧ANK専用実装の実証時にはHuman68k 3.02起動で非空768セル中
426セルが一致し、`Command version 3.00`、`B>ECHO OFF`、`B>` を取得できた。残りは主に当時
対象外だった16x16漢字であり、漢字対応後の実画面結果はブラウザ上で改めて確認する。

## 仮想キーボード

キー配列は `virtual-keyboard.ts` の `KBD_ROWS` に二次元配列リテラルとして置き、各要素に
ラベル・RETROK・相対幅・修飾種別を同居させる。コアへ生のX68000スキャンコードは送らず、
`keyboard.ts` の `RETROK` を介して物理キーボードと同じ `setKey()` 経路へ流す。XF1〜XF5、
かな、ローマ字、コード入力、ひらがな、全角、COPYはfork側コアの `KeyTable` に追加した専用の
RETROKを直接送る。従来のCOMPOSE経路はコア側に後方互換として残すが、仮想キーボードでは使わない。

| X68000キー | RETROK | 値 |
| --- | --- | ---: |
| XF1 | `RETROK_EURO` | 321 |
| XF2 | `RETROK_UNDO` | 322 |
| XF3 | `RETROK_OEM_102` | 323 |
| XF4 | `RETROK_BROWSER_BACK` | 324 |
| XF5 | `RETROK_BROWSER_FORWARD` | 325 |
| かな | `RETROK_BROWSER_REFRESH` | 326 |
| ローマ字 | `RETROK_BROWSER_STOP` | 327 |
| コード入力 | `RETROK_BROWSER_SEARCH` | 328 |
| ひらがな | `RETROK_BROWSER_FAVORITES` | 329 |
| 全角 | `RETROK_BROWSER_HOME` | 330 |
| COPY | `RETROK_VOLUME_MUTE` | 331 |

`core-shim.c` の `webx68k_keybuf_peek()` / `webx68k_keybuf_write_pointer()` は、Node 上の
Vitest からコア内部の `KeyBuf` と書き込みポインタを観測し、仮想キーボードの
RETROK が実際に X68000 スキャンコードへ変換されたことを確認するためのデバッグ用
エクスポートである。リングバッファの内容を読むだけでゲスト状態は変更しないが、
入力履歴を観測できるため、配布サイズと情報露出を最小化したいリリースでは
`build-core.sh` の `EXPORTED_FUNCTIONS` とシム本体から外す判断余地がある。

SHIFT・CTRL・OPT.1・OPT.2は `Map` で複数同時に保持するワンショットとし、修飾キー自身の
再タップ、または通常キーのpointerup後に一括解除する。CAPS・かな・ローマ字・コード入力・
ひらがな・全角は再タップまで `.active` 表示を保つロックとする。状態キーはmake/breakパルスで
ゲスト側を切り替え、UIだけをロック表示する。

入力はPointer Eventsだけを使い、`pointerId` ごとの押下先を `Map` に記録して各ボタンで
`setPointerCapture()` する。pointerup/cancel/leaveで必ず対応する入力元だけを解放し、長押し
リピート(`KeyRepeater`。詳細は次節「キーリピート」)も入力元ごとに管理する。`blur` とhiddenへの
`visibilitychange` では全入力元を強制解放する。`SharedKeyInput` は物理・仮想・MCP入力を
入力元別に参照カウントし、同じRETROKを複数経路が押している間は片方のbreakで解除しない。

表示時はパネルの実測高をCSS変数へ反映し、従来のcanvas高上限`60vh`から差し引く。
canvas自体は引き続き`width/height:auto`なので固有の画素比を維持し、画面回転を含むresize時に
再計測する。テンキーは横幅を常時消費しない別クラスタで、既定では非表示にする。

かな副刻印はX68000のJISかな配列（Q=た、W=て、E=い、A=ち、S=と等）に準拠し、
`KBD_ROWS`の`kana` / `kanaShift`に定義する。640px以上は英数とかなを併記し、640px未満は
かなロックOFFで英数のみ、ONでかなのみに入れ替える。かなロック中にSHIFTがラッチされた間は
`kanaShift`を選び、SHIFT解除後は`kana`へ戻す。この状態はゲストではなくクライアント側のロック状態を正とし、
ゲスト側とずれた場合はかなキーの押し直しで合わせる。物理キーボードの`KanaMode`も共有入力に統合し、
リピートでない初回keydownで仮想キーボードの表示ロックを反転する。

## キーリピート

`key-repeat.ts` の `KeyRepeater` が物理・仮想キーボード共通のオートリピート機構を担う。
px68k-libretro コア自体にはリピート機構が無く、`LibretroHost.keyState` は
1エミュレートフレームにつき1回(`input_poll` 直後の `input_state` 読み出し)しか読まれない。

**実機のX68000キーボードは、リピート時にmakeだけを繰り返す。** 押下状態は指を離すまで
立ったままで、breakは解放時の1回だけである。以前の実装はホストの押下状態を
release→pressしてmake/breakパルスを作り、breakを1フレーム見せるため
`notifyFramePolled()`を2回待っていたが、この方式は実機と異なり誤りだった。IOCSのBITSNS等で
キーマトリクスの押下状態をポーリングするゲームには、リピートのたびにキーが離れたように見える。
実際にテンキーで移動するゲームで、押しっぱなしにすると数秒後に移動が止まる不具合が発生した。

現在は `SharedKeyInput` / `LibretroHost.keyState` の押下状態を一切変更せず、
`KeyRepeater` が `delayMs` 後から `intervalMs` ごとにmake注入コールバックだけを呼ぶ。
`LibretroHost.sendKeyMake()` は `keyboard.ts` の `RETROK_TO_SCANCODE` でX68000スキャンコードへ
変換し、core-shimの `webx68k_send_key_make()` を通してコアの `send_keycode(scancode, 2)` を
直接呼ぶ。これによりリピート中はmakeだけがKeyBufへ追加され、物理・仮想キーボードの解放時に
通常の押下状態エッジからbreakが1回だけ送られる。フレーム基準のbreak待ちとパルス時間の
周期補正は不要になり、初回は単純に`delayMs`後、以降は`intervalMs`間隔で送る。

**設定はSRAMから読み、X68000の式でmsへ変換する。** 実機のSWITCH.Xで設定するキーリピートの
開始時間・間隔は、SRAM(ゲスト側 `$ED0000`-`$ED3FFF`)の `$ED003A`(開始段階値n、FIRST_KEY)・
`$ED003B`(間隔段階値n、NEXT_KEY、n=0..15)に格納される。

この番地は当初 `$ED0059`/`$ED005A` だと誤って実装していた。資料の記憶を基に決め、
段階値が0..15の整数範囲内であることの健全性チェックだけを通していたためで、
たまたまその番地の値(0/1)も範囲内に収まってしまい、誤りに気づけないまま動いていた。
ゲスト上でSWITCH.Xを実際に起動し、その表示(FIRST_KEY 3=500ms・NEXT_KEY 2=50ms)と
SRAMダンプを突き合わせて初めて `$ED003A`/`$ED003B` が正しい番地だと判明した
(実機の既定値は開始500ms・間隔50ms)。番地の正しさは範囲チェックでは保証できず、
ゲスト自身の表示との突き合わせでしか確かめられない。公開されているX68000のキーリピート仕様は

```
開始時間[ms] = 200 + 100 × n
間隔[ms]     = 30 + 5 × n²
```

で、`key-repeat.ts` の `keyRepeatDelayMsFromSramValue()` / `keyRepeatIntervalMsFromSramValue()`
がこの式の純粋関数版(範囲外・非整数はnull)。`LibretroHost.readKeyRepeatConfig()` が
SRAM読み出し→変換までをまとめて行い、`main.ts` は `host.onPoll` 内で60フレームおきに
これを呼んで値が変わっていれば `keyRepeater.setTiming()` を呼び直す(SWITCH.Xでの設定変更を
実行中に追従させるため)。SRAM読み出し不能(古いwasm・未初期化)時は `KeyRepeater` の
既定値(`DEFAULT_DELAY_MS`=300ms・`DEFAULT_INTERVAL_MS`=35ms、実機の SWITCH.X の
既定に近い値)のまま据え置く。

**`_webx68k_peek8()` では SRAM を読めない。** `webx68k_peek8()` は `MEM[]` を素通しで読む
だけで、`x68k/mem_wrap.c` の `ReadMem` 関数テーブルが `0x00ED0000`-`0x00ED3FFF` を
`SRAM_Read`/`SRAM_Write` へ特殊ディスパッチしている実体(`x68k/sram.c` の別配列 `SRAM[]`)を
経由しない。そのため `webx68k_peek8()` でSRAM領域を読むと一律 `0xE5` が返り、
「読めているつもり」で不定値を掴む事故になる(実際に発生した)。SRAM読み出しは必ず
`core-shim.c` の `webx68k_sram_read()`(内部で `SRAM_Read()` を呼ぶ)経由にすること。
`LibretroHost.readKeyRepeatConfig()` はさらに、読み出し先が本物のSRAMであることの
健全性チェックとして、SRAM先頭8バイトが機種シグネチャ「Ｘ68000W」であることを毎回
確認してから値を使う。

## SRAM永続化(SWITCH.Xの設定をリロード後も残す)

`src/sram-store.ts`(IndexedDB永続化)と `LibretroHost.init()`の第3引数/`readSram()`/
`startSramAutosave()`(`src/libretro-host.ts`)で、SRAM(起動ドライブ・メモリ容量・
キーリピート等、実機の `SWITCH.X` で設定する項目が載る `$ED0000`-`$ED3FFF`)をページの
リロードをまたいで永続化している。

**`sram.dat` は `retro_load_game()` より前に置く必要がある。** `SRAM_Init()`
(`x68k/sram.c`)は `retro_load_game()` の中(`WinX68k_Init()` 経由)でシステムディレクトリの
`sram.dat` を読む。ファイルが無ければ SRAM を `0xFF` 埋めにし、IPL が既定値を書く
(初回起動相当)。BIOS(IPLROM/CGROM)と同じ `/system/keropi/` 配下に置くファイルなので、
`LibretroHost.init(biosIpl, biosCg, sram?)` の第3引数として渡し、`init()` 内で
`_retro_init()` より前(=呼び出し元が `retro_load_game()` を呼ぶより確実に前)に書き込む。
長さが `0x4000`(16KB)でないものは壊れたデータを渡さないよう無視して `console.warn` する。

**保存は `retro_deinit()` に頼れないので、ホスト側で行う。** 書き出し側の
`SRAM_Cleanup()` は `retro_deinit()` からしか呼ばれないが、WebX68k は
`_retro_deinit()` を呼んでいない(呼ぶとコアの内部状態が破棄されて以後動かせなくなる)。
そのため保存はコア側の仕組みに任せず、`LibretroHost.readSram()`
(`_webx68k_sram_read()` で0x4000バイトを読み出す)を使ってホストが能動的に読み、
別途 IndexedDB へ書く。

**離脱イベント(beforeunload/pagehide)に保存を託さない。** 過去にこの方式で
保存し損ねた実績がある(離脱イベントは非同期処理を完走できないことがあり、特に
モバイル Safari で顕著。`main.ts` の HDD/FDD ダーティ保存の項も参照)。代わりに
`LibretroHost.startSramAutosave(save)` が3秒ごとに `readSram()` を呼び、前回保存した
内容と1バイトでも変わっていれば `save()` を呼ぶ、という平常時の定期保存にしている。
16KBの全バイト比較を3秒に1回行う程度は軽く、SWITCH.Xの設定はユーザーが明示的に
変更したときしか変わらないため、この頻度で十分(毎フレーム=60Hzでやる必要はない)。

**シグネチャ不一致のときは保存しない。** `readSram()` は `readKeyRepeatConfig()` と同じ
健全性チェックとして、SRAM先頭8バイトが機種シグネチャ「Ｘ68000W」と一致しない場合は
`null` を返す。ここで弾かずに保存してしまうと、未初期化・読み出し経路異常のSRAMを
そのまま永続化することになり、次回起動時にその壊れたSRAMを読み込んで正常な状態へ
戻れなくなってしまう。

**ファイルのバイト順は「file[adr] === `_webx68k_sram_read(adr)`」であることを実測済み。**
`SRAM_Init()` はファイル読み込み後に隣接バイトをswapし(`#ifndef MSB_FIRST`)、
`SRAM_Read()` は常に `adr ^= 1` する。この2つを合成すると理論上は打ち消し合って
ファイルのバイト順とゲスト側の読み出し順が一致するはずだが、これは静的な読解による
推論でしかない。`test/core-sram-persistence-integration.test.ts` で実際のコアに対し、
1台目のコアで読んだSRAMのoffset `0x3a`/`0x3b`(キーリピート段階値)を、実機の既定値
(開始n:3・間隔n:2)とは異なる値(5・4)へ書き換えたバイト列を作り、2台目の新しい
コアインスタンスへ `retro_load_game()` 前に `sram.dat` として置いて起動、
`_webx68k_sram_read(0x3a)`/`(0x3b)` から書き換えた値がそのまま読めること・
機種シグネチャが保たれていること・`readKeyRepeatConfig()` 相当の変換結果
(開始700ms・間隔110ms)が正しいことを検証している。既定値と異なる値を選んでいるのは、
既定値のままだと「復元できた」のか「単に何もしなくても既定値のまま読めているだけ」なのか
このテストだけでは区別できないため。IPLが `$3A`/`$3B` を毎回既定値へ書き戻す、
といった懸念も無いことをこのテストで確認済み。

**SWITCH.Xの設定はSRAM全体を保存するが、効く範囲はキーリピートだけ。** ゲスト内で
完結する設定(IPL/IOCSがSRAMを読んで判断する項目)は実機同様そのまま効くが、
ホスト側が肩代わりしているのはキーリピートのみである。実機ではキーボード側のMCUが
リピートを生成しており、px68kはキーボードMCUをエミュレートしていないため、ホストが
`readKeyRepeatConfig()` で肩代わりする形になっている。

より正確には、ゲストがキーボードへ送るコマンドはMFPのUDR書き込みだが、`x68k/mfp.c` の
`MFP_Write` は `case MFP_UDR: break;` でこれを黙って捨てている。そのためキーボードMCU
宛のコマンドは総じて効かず、キークリック音やキーボードLEDの制御も未対応のまま
(この2点はSWITCH.Xの設定項目でもある)。

**保存はされてもコア側の設定が優先される項目がある。** 確認済みの例はメモリ容量で、
`libretro.c` の `WinX68k_Exec()` が毎フレーム SRAM の `$ED0008` を `Config.ram_size` と
比較し、食い違っていれば `Config.ram_size` の値で書き戻す。そのためSWITCH.Xでメモリ容量を
変更してSRAMへ書き込んでも、次のフレームでコアが上書きしてしまい、設定ダイアログ/
`?ram=` クエリ側の値が常に優先される。

## マウス入力

X68000 のマウスは **SCC 経由で相対移動量(-128〜127)を送る方式**で、カーソル位置はゲスト側が
自前で管理する（`libretro/mouse.c` の `Mouse_Event()` がデルタを累積し、`Mouse_SetData()` が
クランプして SCC へ渡す）。ブラウザのカーソル座標を絶対座標として渡すことは原理的にできないため、
**Pointer Lock でキャプチャして `movementX/Y` を積む**方式にしている（canvas クリックで開始、
Esc で解除）。

- **コアオプション `px68k_joy_mouse` を `"Mouse"` にすることが必須**。px68k は内部フラグ
  `MouseSW` が立っていないと `Mouse_Event()` を丸ごと無視するため、これが無いとデルタを
  返しても一切反応しない（`bootCore()` で設定）
- `movementX/Y` は CSS ピクセル単位なので、`canvas.width / canvas.clientWidth` を掛けて
  ゲスト1ドットに換算する。感度倍率は `localStorage` の `webx68k.mouseSensitivity`
- コアは `retro_run()` 中に X/Y を1回ずつ読むため、ホスト側は読まれた分だけ差し引いて
  次フレームへ繰り越す。端数を残すのは、感度を下げたときに微小移動が切り捨てで消えないようにするため
- キャプチャ解除時は積み残しのデルタと押しっぱなし判定を捨てる（ボタンを押したまま Esc された場合の保険）

### フルスクリーン中の Esc(実キーボードで確認済み、詳細は `src/main.ts` の該当コメント参照)

フルスクリーン + マウスキャプチャの両方が有効な状態で Esc を1回押すと、キャプチャと
フルスクリーンが**同時に**解除される（2段階にはならない）。Esc による解除は
`preventDefault` で止められず、解除直後にスクリプトから `requestFullscreen()` で復帰させる
こともできない（ユーザー操作起因を要求され、Esc 直後は特に拒否される）ため、こちら側では
手当てできない。`.console-card` ごと全画面にすればツールバーを残せて回避できるが、画面が
狭くなるため採用しなかった。

### 操作モード(ツールバーの2ボタン)

WebNP2 と同じアイコン・同じ並びで「マウスキャプチャ」「マウス再同期」を用意している。

- **キャプチャ**: Pointer Lock で掴んで `movementX/Y` をそのまま送る。**canvas 上の右ダブルクリック**
  またはツールバーのボタンで開始し、**解除は Esc かツールバーのボタン**。左クリックはゲストへ
  通す必要があるためキャプチャのトリガにしていない(WebNP2 と同じ流儀)
- **マウスボタンはキャプチャ中だけゲストへ渡す**。非キャプチャ時にも渡すと、キャプチャ開始の
  右ダブルクリックがそのままゲストに届き、X68000 側のソフトキーボード(ASK68K)が開いてしまう
- 同じ理由で、**キャプチャ中の右ダブルクリックは解除に使わない**。ゲスト側で右ダブルクリックを
  使う操作が勝手にキャプチャを外してしまうため
- **再同期**: 追従モードでカーソル位置がずれたときに基準を取り直す。閉ループなので通常はずれないが、
  IOCS ワークを使わず自前でカーソルを管理するソフト向けのフォールバックとして残してある

#### 追従モード(絶対位置追従)の仕組み

相対量しか送れないので、ゲストカーソルの現在位置が分からないと追従できない。IOCS はワークエリアに
実座標と可動範囲を持っている($ACE/$AD0、$A9A..$AA0)ので、そこを毎フレーム読んで
「目標との差分」を送る**閉ループ**にしている(`readGuestCursor()` / `stepMouseTracking()`)。

**ハマりどころは IOCS がマウス移動量に加速をかけること**。誤差をそのまま送ると最大7.5倍に
増幅されて行き過ぎ、画面端から端へ発振する。実測した加速テーブルは以下のとおりで、
**3以下は 1:1、16 を境に急に倍率が上がる**。

| 送信量 | 1 | 2 | 3 | 4 | 6 | 8 | 12 | 14 | 16 | 20 | 24 | 32 | 48 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 実際の移動 | 1 | 2 | 3 | 5 | 7 | 10 | 15 | 17 | **40** | 50 | 90 | 160 | 360 |

これを逆引きし、**予測移動量が誤差を超えない範囲で最大の送信量**を選ぶ(`sendAmountFor()`)。
必ず不足側に倒れるので行き過ぎが原理的に起きず、残りは次フレーム以降の閉ループが詰め、
最後は 1:1 の領域に入るのでぴたりと止まる。テーブルは「行き過ぎないための上限見積もり」
としてしか使わないため、IOCS の設定で加速が変わっても収束する。

もう一点、**送った直後はゲストがまだ反映していない**ので、カーソルが実際に動いたのを確認する前に
次を送ると同じ誤差に二重に送って行き過ぎる。送信後は座標の変化を待ってから次の補正を出すこと。

実測: 画面内の3箇所へホストカーソルを動かし、ゲストカーソルが**誤差0ドット**で着地することを確認
(目標(606,368)/(51,57)/(755,501) に対していずれも一致)。

### バーチャルトラックパッド(タッチデバイス向け)

iOS Safari は Pointer Lock API に対応しておらず、キャプチャモードが成立しない。この節の
初版(PR #4)は canvas 自体をタッチの受け口にする「タッチマウス」だったが、canvas は
「ゲスト画面そのもの」であり、操作面としては指の影に隠れる・誤タップでゲスト側の描画や
クリックを誘発するといった難点があった。そこで仮想キーボード/バーチャルパッドと同じ
**「入力パネル」の第3の種類**として、画面とツールバーの間の帯に専用の操作面
(`src/virtual-trackpad.ts`)を置く設計に変更した。ツールバーのボタンは増えず、入力パネルの
切り替えチップが ⌨/🎮/🖱 の3種になっている(`webx68k.inputPanel` に永続化)。

- **画面に重ねず帯に置くのは、操作中の指がゲスト画面を隠さないようにするため**。これは
  タッチマウス撤廃の直接の動機そのもので、trade-off ではなく設計目的
- ジェスチャの解釈(1本指=移動、タップ=左、2本指タップ=右、長押し(450ms)=左押し込み
  ドラッグ)は `src/touch-mouse.ts` の純ロジックがそのまま受け持つ(タッチマウス時代からの
  再利用。DOM に触れない形で切り出したのは platform.ts と同じ理由で、タッチ実機なしで
  vitest から検証するため。`test/touch-mouse.test.ts`)
- `virtual-trackpad.ts` の責務は DOM のポインタイベントを TouchMouse へつなぐことと
  パネルの表示/非表示の管理だけ。CSSピクセル→ゲストのドット数への換算(加速テーブルの
  逆引き含む)はホスト固有のマウス管理の知識なので、呼び出し側(main.ts)のコールバックに
  委ねている(virtual-pad.ts が joy/key の割当解決を GamepadManager に委ねているのと同じ
  考え方)
- **2本指ドラッグ(トラックパッドの慣例でホイール相当に使われる操作)は実装しない**。
  X68000のマウスは左右2ボタンのみでホイールという概念自体が無く、px68k側
  (`libretro/mouse.c`)も left/right しか読んでいないため、実装しても受け取り先が無い
- CSSピクセル→ゲストのドット数の換算は `TRACKPAD_SCALE`(= 1.5)の**固定倍率**。canvas の
  表示倍率(`canvas.width / canvas.clientWidth`)は使わない。モバイルでは canvas の表示倍率が
  2倍を超えることがあり、これをそのまま使うと1イベントぶんの移動量が IOCS の加速域
  (16以上で最大7.5倍、上記「追従モードの仕組み」参照)に入ってカーソルが飛ぶ。固定倍率に
  することでこの問題を構造的に避けている。キャプチャモードの mousemove と同じ考え方
  (感度倍率)で、**加速テーブルを逆引きして「意図した移動量を超えない送信量」へ変換してから**
  `addMouseDelta` へ送る(`sendAmountFor()`/`predictedMoveFor()`)。送信ぶんの予測移動量を
  引いた残差は次のイベントへ繰り越し、ストローク終了(全指離れた/キャンセル/パネルを閉じた)で
  捨てる。閉ループ(絶対位置追従)は使わない(`hasDesiredRatio` を落として綱引きを防ぐ)
- タップのクリックはカーソルが動いていないので収束待ちは不要(即パルス)。ボタンパルスは
  押下100ms・間隔60ms — コアは `retro_run()` 中に1回しかボタンを読まないため、1フレームより
  十分長く保持しないと取りこぼす。連続タップ(ダブルクリック)はキューで直列化する
  (`pumpTouchClickQueue()`)
- **iOS Safari は viewport の `user-scalable=no`/`maximum-scale` を無視する**(iOS 10以降)
  ため、ダブルタップによる拡大が `touch-action: none` だけでは止まらず、「ダブルタップ =
  ダブルクリック」のつもりの操作が画面拡大になってしまう。パネル要素で
  touchstart/touchmove/touchend を非パッシブで受けて `preventDefault` することで止めている
  (WebPaint98 の touchInput.ts と同じ手)。ジェスチャ判定自体は pointer イベント側で完結して
  いるので、ここは既定動作の抑止だけを行う
- 長押しは左ボタンの押し込み(ドラッグ)に割り当てているため、同じ操作でブラウザ側の
  コンテキストメニュー(iOS の「全て選択」「コピー」等のコールアウト)が出ると操作が中断する。
  CSS の `user-select`/`-webkit-touch-callout` だけでは環境によって出てしまうため、
  `contextmenu` イベントでも明示的に止めている(WebPaint98 の wm.ts と同じ理由)

### テストプログラム(MOUSETST.X)

`tools/x68/` に、マウスが**ゲストまで届いているか**を確認するための X68000 実機用テスト
プログラムを置いてある。市販ソフトを用意しなくても、経路全体を目視＋数値で確認できる。

```bash
# 事前に 68000 アセンブラ(vasm)を用意する。生成物は _local/(gitignore 対象)に置く
mkdir -p _local/tools && cd _local/tools
curl -sSLO http://sun.hasenbraten.de/vasm/release/vasm.tar.gz
tar xzf vasm.tar.gz && cd vasm && make CPU=m68k SYNTAX=mot

# アセンブル → .X 化 → 検証用ディスク作成
bash tools/x68/build.sh
```

- `tools/x68/mouse-test.s` … `_MS_INIT`($70) → `_MS_CURON`($71) でハードウェアマウス
  カーソルを出し、1行の連続表示(CR で上書き)を続ける。何かキーを押すと終了
- `tools/x68/hu_pack.py` … 生バイナリに Human68k の実行ファイル(.X)ヘッダを被せる。
  ヘッダ構造はディスク同梱の実物(`FLOAT2.X` 等)を解析して確定させた（ヘッダの節を参照）
- `tools/x68/fatput.py` … FD イメージのルートへファイルを1つ書き込む(ホスト用の最小 FAT12
  実装。ジオメトリは BPB から読むので X68000 の 1024B/sector でもそのまま動く)
- `tools/x68/build.sh` … 上記を通しで実行し、`_local/x68build/mousetest.xdf` を作る。
  **同梱のシステムディスクは無改変のまま**で、書き込むのは `_local` 側のコピーだけ。
  `AUTOEXEC.BAT` を MOUSETST 起動だけの内容に差し替えて書き込むので、起動すれば `A>` で
  何か入力しなくても自動的にテストが始まる(スマホでの確認は打鍵が煩雑なため)

表示は1行の連続表示になっている:

```
X=0002 Y=0002 L=0 R=0 CLK=0000 RCK=0000 DBL=0000 GAP=0000 HLD=0000 T=00000A4D
```

- `X,Y` … IOCS `_MS_CURGT`($75) が返すカーソル絶対座標。タップが狙った位置に着地したか
- `L,R` … `_MS_GETDT`(下記) のボタン現在値
- `CLK,RCK` … 左右ボタンの押下エッジ回数。タップ回数と一致するかで取りこぼしを実測できる
- `DBL` … ダブルクリックとして成立しうる押下(直近から一定時間内・近接位置)の候補数
- `GAP` … 直近の押下間隔(1/100秒)
- `HLD` … 直近の押下保持時間(1/100秒)
- `T` … IOCS `_ONTIME`($7F) の生値。計測系(時刻取得)そのものが生きているかの陽性対照。
  ここが滑らかに増えていなければ GAP/HLD/DBL は信用できない。CLK と X,Y は時刻に依存しない
  のでその場合でも意味を持つ

`_MS_GETDT`($74) の戻り値は `d0` の bit31-24 = X移動量 / 23-16 = Y移動量 / 15-8 = 左ボタン /
7-0 = 右ボタン（ボタンは 0=離, $FF(-1)=押）。**移動量は「前回呼び出しからの差分」**なので、
マウスを止めると 0 に戻るのが正常。

実測値（ホスト側から (6,-4) を注入しつつ左ボタン押下）: `MS_GETDT = 12F4FF00`
= X:+18 / Y:-12 / 左:押 / 右:離。右ボタン + (-5,+2) では `FB0200FF` となり、
ハードウェアマウスカーソルも同方向に移動することを確認済み。

`_MS_CURGT`($75) についても実測で裏を取った: 戻り値は上位ワード=X / 下位ワード=Y で、
ホスト側の `__webx68kDebug.mouse().cursor` と完全一致した。`_ONTIME`($7F) は1秒で約100
増える(1/100秒単位どおり)。なお IOCS $73 は押しても離しても常に $FFFF を返すだけで、
ボタン状態の取得には使えなかった($74 の GETDT を使う理由)。

### 配線確認の方法（マウス対応ソフトが無くても確認できる）

`x68k/scc.c` の `MouseX`/`MouseY` は**ゲストが SCC をポーリングしたときにしか更新されない**ため、
これだけ見ても配線の成否は分からない。そこで fork 側 `libretro/mouse.c` に累積デルタを覗く
アクセサ（`Mouse_PeekDX/DY`、`Mouse_PeekStat`、`Mouse_IsEnabled`）を追加し、`core-shim.c` の
getter 経由で `LibretroHost.readMouseState()` から読めるようにしている。

開発ビルドでは `window.__webx68kDebug.moveMouse(dx, dy)` / `.mouseButton('left', true)` で
Pointer Lock を経由せずに入力を注入できる（将来の MCP ブリッジの `mouse_move` 相当も
この経路を使う想定）。実測では、注入したデルタが `sccX`/`sccY` にそのまま現れることを確認済み。

**単発で注入して数百ms後に読むと 0 に見える**ので注意。Human68k は毎フレーム SCC を
ポーリングしており、累積デルタは即座に吸われて次のポーリングで 0 に上書きされる。
`requestAnimationFrame` ごとに読むこと。

## ゲームパッド入力

Gamepad API(`navigator.getGamepads()`)を px68k-libretro の RetroPad 入力(`RETRO_DEVICE_JOYPAD`)
経由でジョイスティックポート0/1へつなぎ込む。実体は `src/gamepad.ts`(配線ロジック・永続化)
と `src/gamepad-ui.ts`(設定ダイアログ、表示と編集操作の仲介のみ)に分離してある。

### コアは無改変で足りる

px68k-libretro 側は元から `RETRO_DEVICE_JOYPAD` を読める作りになっており、こちら側の C コード
(`libretro.c` / `libretro/joystick.c` / `core-shim.c`)には一切手を入れていない。理由は2つ:

- `libretro.c` の `retro_run()` は毎フレーム無条件に `Joystick_Update(0, -1, 0)` /
  `Joystick_Update(0, -1, 1)`(port0/1ぶん)を呼んでいる(2422〜2423行目)。呼び出しは
  `Config.joypad1`/`joypad2` フラグの値に関わらず行われる — このフラグは
  `RETRO_ENVIRONMENT_SET_CONTROLLER_INFO` で登録した入力descriptor(フロントエンドのマッピング
  UI向けの表示用メタデータ)の有無を示すだけで、`Joystick_Update()` が実際に入力を読むかどうかとは
  無関係。つまり `RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS`/`SET_CONTROLLER_INFO`
  を正しく実装していなくても(`libretro-host.ts` は両方とも「call自体は受け付けるが内容は無視」
  という最小実装のまま)、`inputStateCb` さえ正しい値を返せば入力は届く。
- `Joystick_Update()` はパッド種別(`Config.JOY_TYPE[port]`、px68k_joytype1/2 コアオプション)
  に応じて RetroPad ID を X68000 側の `JOY_TRGn` ビットへ変換するだけで、この変換テーブル自体は
  コア組み込み。ホスト側は「どの RetroPad ID を押下として返すか」だけを制御すればよい。

### RetroPad ID ↔ JoyTarget の対応はパッド種別で変わる

`src/gamepad.ts` の `JoyTarget`(`UP`/`DOWN`/`LEFT`/`RIGHT`/`TRG1`..`TRG8`)は X68000 側の入力先で、
`retroIdFor(target, padType)` で RetroPad ID(`inputStateCb` の `id` 引数)へ変換してから
`LibretroHost.setJoyState()` へ渡す。この対応表(`RETRO_ID_MAPS`)は px68k-libretro
`libretro/joystick.c` の `Joystick_Update()` の `PAD_2BUTTON`/`PAD_CPSF_MD`/`PAD_CPSF_SFC` 各分岐
から実装を読んで確定させたもので、**推測では書いていない**(例: CPSF-MD は RetroPad A(id=8)が
Low-Kick=`JOY_TRG1`、RetroPad Y(id=1)が Mid-Punch=`JOY_TRG3`、等)。UP/DOWN/LEFT/RIGHT はどの
padType でも共通(D-Pad判定はパッド種別分岐の外側にある)。

TRG3..TRG8 を使うには CPSF-MD/CPSF-SFC(8ボタン)への切り替えが必要で、`px68k_joytype1`/
`px68k_joytype2` コアオプション(設定ダイアログのパッド種別セレクタ、ポートごとに選択・
`gamepadStore.joyType` として localStorage永続化)で制御する。サイバースティック(アナログ)は
px68k-libretro 側がアナログスティック値を要求する別プロトコルで、Gamepad API のデジタル
ボタン/軸入力とは設計が噛み合わないため対象外にした。

### コアオプションの反映は起動時のみ(GET_VARIABLE_UPDATE 未実装)

`px68k_joytype1`/`2` は `update_variables()` から読まれるが、`libretro.c` の `retro_run()` は
firstcall(起動直後の1回だけ)に加えて、`environ_cb(RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE, &updated)`
が真を返したフレームでしか再読込しない。`libretro-host.ts` の `environCb` はこの環境コマンドを
実装しておらず(未対応コマンドは `0`=false を返す)、`updated` は常に偽のまま — つまり
**実行中に `setCoreOption()` を呼んでも次フレームには反映されない**。パッド種別の変更は
コアの再起動(`bootCore()` のやり直し)まで効かないため、設定ダイアログはコア実行中の変更時に
「次回起動時から反映されます」という案内(`gamepadPadTypeRestartHint`)を出すに留め、変更自体は
即座に自動再起動しない(ディスク挿入中のFDD/HDD状態を巻き込んで再起動するのは過剰な副作用に
なるため)。GET_VARIABLE_UPDATE を実装すれば実行中の即時反映も可能だが、コアオプション全般
(CPU速度・RAMサイズ等)がどれも同じ「次回起動まで反映されない」制約を共有しているため、
ジョイスティックだけ特別扱いはしていない。

### Node の結合テストでは `px68k_no_wait_mode` が必須

`test/core-joystick-integration.test.ts` はコンパイル済み wasm コア(`public/core/px68k_libretro.js`)
を Node 上で直接動かし、`Joystick_Read()` を core-shim 経由で呼んで実測する。px68k-libretro の
`Joystick_Update()` / `WinX68k_Exec()` は `libretro/timer.c` の `Timer_GetCount()`(実時間ベースの
55.6fps ペーシング)が真を返したフレームでしか呼ばれない。Node でループ実行するとほぼ毎フレーム
実時間が経過せず false のままになり、ジョイスティック状態がいつまでも更新されない(観測済み)。
コアオプション `px68k_no_wait_mode` を `"enabled"` にして `Config.NoWaitMode` を立て、この
ペーシングを無効化することで結合テストを決定的にしている。

### X68000のジョイポートは負論理

`JOY_UP`/`JOY_TRG1` 等のビットは押下で **0**、未押下で **1**。`Joystick_Read()` の戻り値をそのまま
テストでアサートする際はこの向きを間違えないこと(`test/core-joystick-integration.test.ts` は
「未押下時は該当ビットが立っている(1)」を先に確認してから押下時に0になることを見ている)。

### ポート割当は「ポーリング結果だけから決まる純粋関数」に一本化

`assignPorts()`(`gamepad.ts`)は `navigator.getGamepads()` の毎回の結果(と手動固定設定)だけから
port0/1を決める純粋関数で、`gamepadconnected`/`gamepaddisconnected` イベントの発火有無に依存しない。
設定ダイアログのライブ表示・コアへの入力送信(`main.ts` の `host.onPoll`)のどちらも必ずこの
関数を経由させている。以前は「表示側は独自にポートを推測し、コアへの送信は別ロジックで
ポートを決める」という二重化があり、**設定画面ではライブ表示のX68k側インジケータが正しく
光るのに、実際のゲストには入力が届かない**というバグを踏んだ(イベントを経ずに
`navigator.getGamepads()` へ現れたパッドを一方が拾い、他方が取りこぼすケースがあった)。
情報源を1つの純粋関数に統合したことで、この種の「表示は動くのに実体は動かない」を構造的に
再発させない。

### 表示は1始まり、内部は0始まり

Gamepad API の `buttons`/`axes` の index、ポート番号は内部的にはすべて0始まり(`Gamepad.index`、
`buttons[0]`、`assignPorts()` が返す `0|1` 等)。UI表示だけ `toDisplayIndex()`(`gamepad-ui.ts`)で
+1 し、Windows の「ゲームコントローラーの設定」の表記(ボタン1、ポート1 等)に合わせている。
localStorage の保存値・`window.__webx68kDebug.joy()` の生値は0始まりのまま扱うこと(表示専用の
変換をここでしか行わないのが唯一の情報源)。

## バーチャルパッド(オンスクリーンパッド)

スマホでゲームを遊ぶ用途向けの、画面に重ねるタッチ操作パッド。仮想キーボードでは方向操作が
実用にならないため用意する。

### 発想の出どころ: WebNP2 のホストキー再割り当て

WebNP2 の `src/api/hostkey.ts`（「ホストの物理キー → 任意の PC-98 キー」を名前付きプロファイルで
持つ機能。テンキーの無いノート PC で十字キーをテンキーとして使う等）と、このバーチャルパッドは
**同じ構造をしている**。違うのは入力元 ID の出どころだけ:

| | WebNP2 hostkey | WebX68k バーチャルパッド |
|---|---|---|
| 入力元 ID | `KeyboardEvent.code`(`"ArrowUp"`) | 画面部品 ID(`"dpad-up"`) |
| 出力 | PC-98 スキャンコード | `Binding`(`joy` / `key` の2種) |
| 保存 | `profiles[] + activeId + enabled` | 同じ |
| 組み込み | `builtin:true` は編集不可・複製可 | 同じ |
| 編集 UI | ソフトキーボードを割当ピッカーに流用 | 同じ |

そこで **「入力元 ID → `Binding` の対応表を、名前付きプロファイルで持つ」** 器を
`src/input-profile.ts` に1つ作り、入力元が画面部品ならバーチャルパッド、`e.code` ならホストキー
再割り当て、という同じモジュールの2インスタンスとして使う（ホストキー再割り当ては X68000 でも
同じ需要があるため、器を共有できるようにしておく）。

出力は既存の `Binding`（`gamepad.ts`）をそのまま使う。X68000 はジョイスティック対応ソフトと
キーボード操作ソフトの両方が多いため、**バーチャルパッドの1ボタンが joy にもキーにも割り当たる
ことが必須要件**であり、`Binding` の union はまさにそれを表している。

### 画面部品 ID

`bindings` に載っている ID だけを描画する（`btn-c`〜`btn-f` が無いプロファイルなら2ボタンで
描かれる）。位置はテンプレート表（`VPAD_LAYOUT`）で ID ごとに固定的に決め、ユーザーによる
ドラッグ移動は後続タスクとする。

- 方向: `dpad-up` / `dpad-down` / `dpad-left` / `dpad-right`
  （描画は固定ベース＋ノブのアナログスティック風の1部品。ベース中心からのノブのオフセットを
  8方向へスナップし、斜めは隣接2 ID の同時押しとして表現する。円の端をちょんと押すだけで
  方向が出る）
- ボタン: `btn-a` / `btn-b` / `btn-c` / `btn-d` / `btn-e` / `btn-f`
- 補助（画面上部の小ボタン）: `btn-opt1` / `btn-opt2`（ESC・F1 等の割当用）

### 組み込みプロファイル

`hostkey.ts` の `builtinTenkeyArrowsProfile()` と同じ流儀で、内容を関数で定義し
`normalizeStore()` が毎回正規の値へ揃える（localStorage を手で書き換えても読み取り専用という
不変条件が壊れない）。

| id | 内容 |
|---|---|
| `builtin:joy-2button` | 方向→joy UP/DOWN/LEFT/RIGHT、A→TRG1、B→TRG2 |
| `builtin:cursor-space` | 方向→key 矢印キー、A→SPACE、B→RETURN（キーボード操作ソフト用） |
| `builtin:tenkey` | 方向→key KP8/KP2/KP4/KP6、A→SPACE、B→RETURN |
| `builtin:joy-6button` | 方向→joy、A〜F→TRG1〜TRG6（CPSF-MD 用） |

### 仮想キーボードとの折り合い

**積み方が違うので排他にする必然性は無いが、既定では排他にする。**

- 仮想キーボード = stage の**下に積む**パネル（`rescale()` がその実測高を引いて画面を縮める）
- バーチャルパッド = 実測した余白に応じて3通り（`panel`/`sides`/`overlay`。後述の
  「表示位置」参照）。いずれも画面(stage)自体は縮めない

パッドを「下に積む」方式にするとゲーム中に表示が半分になって遊べないため、余白が無いときの
オーバーレイは必須。一方、スマホの縦画面で両方出しても実用にならないので、既定は片方だけ表示する。

入力の衝突は問題にならない。`SharedKeyInput` が RETROK を参照カウントで管理しており、複数の
入力元が同じキーを押しても最後の1つが離すまで break を送らない。source 名前空間を
`vk:*` / `vpad:*` で分けておけば、切り替え時に `releaseSource()` で片方だけ確実に解放できる
（**切り替え時の解放を忘れるとキーが固着する**。ここはテストを書く）。

ゲーム中に ESC や F1 が要る場合は `btn-opt1`/`btn-opt2` に割り当てて解決する。プロファイル機能が
あるので、そのために仮想キーボードへ戻る必要は無い。

### 切り替え UI（案A/B/C を比較した結果 C を採用）

- 案A: ツールバーの仮想キーボードボタンを3状態（OFF→キーボード→パッド→OFF）にする
  → ボタンは増えないが、**パッドを出すのに毎回キーボードを経由する**。ゲーム中に最悪。
- 案B: ツールバーにボタンを2つ置く
  → 直感的だが、常設4ボタンが5ボタンになり狭い画面のツールバーが破綻する。
- **案C（採用）**: ツールバーは1ボタンのまま「入力パネル」トグル。**どちらを出すかは
  ツールバーの中に置いた小さなチップ（⌨ / 🎮）で切り替える。**
  - ツールバーの常設ボタン数は増えず、ゲーム中は常に1タップでパッドが出る
    （最後に選んだ側を `localStorage['webx68k.inputPanel']` に保存し、トグルはそちらを出す）
  - 当初は stage の隅に浮かせる案だったが、`sides` 配置の追加で `#virtual-pad` が
    `position: fixed; inset: 0` になり stage の外まで広がったため、チップは stage との
    位置関係に依存しないツールバー側へ置くことにした（パッド（配置は`panel`/`sides`/
    `overlay`の3通り）とキーボード（積むパネル）で高さも位置も揃わないのは変わらないが、
    ツールバーなら両者から独立して常に同じ場所にある）

### joy 出力の合成

物理パッドとバーチャルパッドが同じポートに乗りうるので、**ポートのビットマスクは OR で合成する**。
現状の `resolveBits` はパッド単位なので、ポート単位に集約する箇所を1つだけ作り、そこへ
バーチャルパッドのビットを足す（バーチャルパッドの既定の送り先はポート0=表示上のポート1）。

`GamepadManager` で `Gamepad` に依存しているのは `forEachActiveSource()` だけなので、
`bitsForSources(activeSourceKeys, padType)` / `keysForSources()` を切り出し、`bitsForPad()` を
その薄いラッパにする。バーチャルパッド側は偽の `Gamepad` オブジェクトを合成しない
（合成すると `AxisCalibration` が無意味に走り、`assignPorts()` も汚れる）。

### ポインタ処理は仮想キーボードと別物

仮想キーボードは `setPointerCapture()` をボタン単位で取っているが、**バーチャルパッドで同じことを
してはいけない**。パッドは指を滑らせて斜めを出したり A から B へずらしたりする操作が前提なので、
オーバーレイのコンテナ1枚で `pointerdown`/`pointermove` を受け、部品の矩形に対するヒットテストで
「今その指が触れている部品の集合」を毎回作り直す方式にする。多指は
`Map<pointerId, Set<controlId>>` で管理する。

### その他の注意点

- 座標は stage に対する％で持つ。4:3補正・フルスクリーン・解像度変更（`onResolutionChanged`）で
  位置が飛ばないようにする。`rescale()` はオーバーレイの高さを引かないこと。
- `blur` / `visibilitychange` で `releaseAll()`（仮想キーボードと同じ。押しっぱなしの固着対策）。
- オーバーレイは `touch-action: none` とし、canvas 側のマウス経路（pointer lock）へ透過させない。
- iOS Safari のピンチ絡み（`visualViewport`）はパッド表示中に踏みやすいので回帰確認する。

### 実装順

完了:

1. ✅ `src/kbd-layout.ts` の切り出し（`KBD_ROWS`/`KEYPAD_ROWS`/`VirtualKeyDef` を
   `virtual-keyboard.ts` から分離。WebNP2 と同じく、ソフトキーボード本体と割当ピッカーで
   同じレイアウト定義を共有できるようにするため）
2. ✅ `src/input-profile.ts`（プロファイル基盤・組み込みプロファイル・永続化）
3. ✅ `gamepad.ts` の `bitsForSources()`/`keysForSources()` 抽出
4. ✅ `src/virtual-pad.ts`（描画・タッチ処理）＋ main.ts 配線＋切り替えチップ（当初は
   `overlay` 配置のみ。表示位置は後述の通り3種類へ拡張済み）
5. ✅ 割当編集 UI（`src/input-profile-ui.ts`。仮想キーボードのレイアウト定義をピッカーに流用。
   🎮 プロファイルメニュー末尾の「割当を編集…」から開く。組み込みプロファイルを編集すると
   自動で複製を作る）
6. ✅ （当初の計画には無かった追加）横持ちの左右余白へ配置する `sides` を追加し、表示位置を
   3種類（`panel`/`sides`/`overlay`）にした。合わせて `#virtual-pad` を body 直下の
   `position: fixed; inset: 0` へ移し、切り替えチップも stage の隅からツールバー内へ移設
7. ✅ （当初の計画には無かった追加）`src/input-profile.ts` の器をホストキー再割り当て
   （物理キー `KeyboardEvent.code` → `Binding`）にも流用し、`src/hostkey-ui.ts` として
   物理キーボード→ジョイスティック割当機能を追加（既定は無効。組み込み3種のみ、
   自作プロファイルの編集 UI はまだ無い）

未着手:

- 位置/サイズのドラッグ編集（現状はテンプレート表 `VPAD_LAYOUT` による固定配置のみ）
- 連射
- バイブレーション
- ホストキー再割り当て側の「組み込みから選ぶだけ」を卒業した、自作プロファイルの編集 UI
  （バーチャルパッド側の割当編集 UI は完了済みなので、同じ器を使い回せば実装コストは低いはず）

## ステートセーブ / ロード

ツールバーの2ボタン（保存/復元）で、実行中の状態をまるごと保存・復元できる（WebNP2 と同じ
UI 構成。スロットはクイックセーブの1枠のみ）。

- px68k-libretro は libretro のシリアライズ API（`retro_serialize_size` / `retro_serialize` /
  `retro_unserialize`）を実装済みで、RAM/SRAM/68000/GVRAM/TVRAM/CRTC/パレット/BG/DMAC/MFP/
  IRQH/SCC/FDC/FDD/SASI/RTC/PIA/IOC と音源(OPM/ADPCM/MIDI)まで保存される
- 保存先は IndexedDB（`webx68k-states`）。`src/state-store.ts` 参照
- **ステートは gzip 圧縮して保存する**。px68k は RAM 領域を構成に依らず 12MB 固定で
  シリアライズするため生サイズが約15MBあるが、大半がゼロ埋めなので実測 15.5MB → 約276KB
  （圧縮 約60ms）まで縮む。`CompressionStream` が無い環境では非圧縮で保存し、読み出しは
  レコードのフラグで判別する

### ディスク構成の照合

**ステートにディスクイメージの中身もマウントパスも含まれない**（`FDD_StateAction` はドライブの
メタ情報だけ、SASI 側もバッファとフェーズのみ）。つまり復元は「いま挿さっているディスク」の上に
行われるため、セーブ時と違うディスクだとゲストが暴走する。

これを防ぐため、ステートと一緒に**セーブ時のドライブ構成（各スロットのファイル名）**を記録し、
ロード時に現在の構成と照合する。食い違う場合は保存時/現在の構成を並べて確認ダイアログを出し、
ユーザーが承諾したときだけ復元する（`main.ts` の `currentDiskConfig()` / `sameDiskConfig()`）。

ロード直後は音声キューに旧状態の音が残るため `AudioEngine.flush()` で破棄し、フレーム供給の
蓄積（`accumulator`）もリセットしている。

## 音声遅延(サンプルレート・ドリフト)対策

X68000 は画面モード(15kHz/31kHz)を切り替えるたびにフレームレートが変わり、px68k-libretro は
その都度 `RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO` で新しい fps を通知してくる
(`libretro.c` の `CHANGEAV_TIMING`。61.46/55.46 もしくは 59.94/55.5)。コアが1フレームで出力する
音声サンプル数は `round(44100 / FRAMERATE)` なので、**この通知を無視してホスト側が古い fps で
フレームを回すと最大10%ぶん音声が過剰供給され、その差が遅延として無限に積み上がる**
(数十秒レベルの音声遅延の原因はこれ)。対策として以下3段構えにしている。

1. `src/libretro-host.ts` が `SET_SYSTEM_AV_INFO` / `SET_GEOMETRY` を処理して `avInfo` を更新し、
   `src/main.ts` のメインループは毎フレーム `avInfo.fps` を読み直す
2. `src/main.ts` が音声キューの滞留量(= 実際の遅延秒数)を見てフレーム間隔を最大±2%調整する
   (ドリフト補正)。一度膨らんだ遅延を目標値 80ms 付近へ戻す復元力になる
3. `src/audio.ts` の AudioWorklet 側で滞留量の上限(250ms)を設け、超過分は古い側から捨てる
   最終防波堤。滞留量は tick メッセージでメインスレッドへ返している

### 速度倍率ボタンには `px68k_no_wait_mode` が必須

`libretro.c` の `retro_run()` は `Config.NoWaitMode || Timer_GetCount()` を満たしたフレームでしか
`WinX68k_Exec()`(実際にゲストを1フレーム進める処理)を呼ばない。`Timer_GetCount()`
(`libretro/timer.c`)は実時間の経過を積算し、1フレームぶん溜まったときだけ真を返す。
このオプションを既定(disabled)のままにしておくと、ホスト側の `loop()` が `retro_run()` を
倍率ぶん多い頻度で呼んでも `WinX68k_Exec()` 自体は実時間どおりの回数しか走らず、余分な呼び出しは
入力ポーリングと `audio_batch_cb`/`video_cb` を素通りするだけで終わる — **速度ボタンを押しても
ゲストの体感速度が変わらない**。`bootCore()`(`src/main.ts`)で `px68k_no_wait_mode` を起動時に
`'enabled'` 固定にすることで `||` の短絡により `Timer_GetCount()` 自体を呼ばせず、`retro_run()`
1回につき必ず1フレーム進むようにしている。これにより「進行ペースを決める時計」がコア内部の
実時間から `loop()` 側(上記の音声キュー滞留量ベースのペーシング、実質 AudioContext の
44100Hz 基準)へ移る。前節「コアオプションの反映は起動時のみ」のとおり実行中の切り替えはできない
ため、速度ボタンのON/OFFとは連動させず常時有効にしている。`px68k_audio_desync_hack` は
超過した音声サンプルを間引いて捨てる別実装のオプションで、こちらの可変レートリサンプラ
(`resampleSpeed`)と機能が衝突するため有効化しないこと。

## MCP 対応(AI からの遠隔操作)

`?bridge=1` を付けて開くと、ページが `ws://127.0.0.1:3099` へ接続しに行き、MCP サーバー
(`mcp/server.mjs`)経由で画面取得・キー入力・マウス操作・ディスク操作ができる。
構成もプロトコルも姉妹アプリ WebNP2 に準拠している。セットアップと提供ツールの一覧は
[mcp/README.md](mcp/README.md) を参照。

`screen_text` はテキスト画面(TVRAM)の限定的な文字取得を行う。詳細は前述の節を参照。画面全体の
確認は `screenshot`、処理待ちは `wait_screen_change` で行う。マウスは相対移動のみで、絶対座標
指定のツールは用意していない。

## 起動前の初期画面

WebNP2 に合わせ、起動前は canvas 上に「ディスク無しで起動」/「システムディスクで起動」の2択
オーバーレイを表示する（`index.html` の `#boot-overlay`、`src/main.ts` の `startFromOverlay()`）。

- 「ディスク無しで起動」… ディスク未挿入で IPL 起動（`loadGameNone` 相当、IPL ROM のメニューが出る）。
  HDD がセット済みなら文言が「セットしたディスクで起動」に変わる(後述)
- 「システムディスクで起動」… 同梱の `human302.xdf` を FDD0 へ挿入した状態で起動

音声再生の制約上クリック操作が必須なため起動にはクリックが要るが、かつては空白部分の
クリックも1つ目のボタンと同じ扱いにしていた。ボタンを狙ったつもりで少し外れると意図せず
「そのまま起動」が走ってしまう誤爆が起きたため撤廃し、起動は `btn-boot-plain` /
`btn-boot-system` の2ボタンを押した場合のみに限定している(`src/main.ts` の
`startFromOverlay()` 呼び出し部のコメント参照)。

起動前に HDD をドロップ/挿入しても、この時点では起動せずスロットへ「セット」するだけに
とどめている(`slots.hdd` = `PendingDisk`、まだコアへは渡さない)。1つ目のオーバーレイボタンは
`updateOverlayBootLabel()` が `slots.hdd` の有無を見て文言を切り替える
(`overlayBootPlain`=「ディスク無しで起動」/`overlayBootPlainPending`=「セットしたディスクで起動」)。
セット中は `updateSlotControls()` がスロット名要素に `.pending` クラスを付け、CSS で斜体・
半透明表示にして「マウント済み」と区別する。

ファイルマネージャでの編集(`openSlotVolume(slot).persist()`)は `slots[slot]` を直接
書き換えるため、起動時に `bootCore()` が読む `slots.hdd.data`(→`host.writeDiskImage()`)には
編集後のバイト列がそのまま乗る。加えて `sourceKey` がライブラリ由来(同梱ディスク以外)なら
`persist()` の中で IndexedDB(`saveDisk()`)へも書き戻すので、ページ再読み込み後もライブラリ側に
編集内容が残る(これが無いと以前はメモリ上だけの変更としてページ再読み込みで消えていた)。

## フロントエンドのビルド

```bash
npm install
npm run build   # dist/ に出力
npm run dev     # 開発サーバー
npm run test    # ユニットテスト(vitest, test/*.test.ts)
```

`test/fat-hdd.test.ts` は `createFormattedHdd()`(後述)のFAT16構造とパーティション
テーブルのバイト列を固定するテスト。`public/help/*.png` (使い方ページの説明画像)を
UI変更後に撮り直す際は、開発サーバーを起動した状態で `npm run capture-help`
(`scripts/capture-help-shots.mjs`)を実行する。

## 同梱している ROM / ディスクイメージについて

`public/system/` に以下を同梱しており、何も用意しなくてもブラウザで開くだけで Human68k が
起動する。いずれも再配布可能なものだけを選んでいる。

| ファイル | 内容 | 出所・扱い |
| --- | --- | --- |
| `iplrom.dat` | X68000 IPL-ROM v1.0（初代〜EXPERT 系。内部に `ROM debugger Ver 1.0 / Copyright Hudson soft 1987`） | シャープ株式会社ほか権利各社が @nifty シャープ・プロダクツ・ユーザーズ・フォーラムで無償公開したもの。`許諾条件.txt` の条件下で無改変・無償で再頒布 |
| `human302.xdf` | Human68k version 3.02 システムディスク | 同上 |
| `許諾条件.txt` | 上記2点の使用許諾条件 | **再頒布時の添付が許諾条件で必須**。削除しないこと |
| `cgrom.dat` | フォント ROM (CGROM) | **実機の CGROM は無償公開の対象外なので同梱できない**。代替として東雲フォント(パブリックドメイン)から `tools/gen-cgrom/` で生成した自作品。字形は実機と異なる |

実機から吸い出した本物の CGROM / IPL-ROM を使いたい場合は、画面の「BIOS 設定」パネルから
読み込める（読み込んだファイルはブラウザの IndexedDB に保存され、次回以降は自動で読み込まれる。
同梱品より優先される）。配布元の例:

- http://retropc.net/x68000/software/sharp/x68bios/

なお検証用の実機 ROM / HDD イメージは `_local/verify/`（`.gitignore` 対象）へ置くこと。
`public/` 配下に置くとビルド時に `dist/` へコピーされ配布物に混入する。

## ライセンス

本リポジトリは **GPLv2**（[COPYING](COPYING)）。

- `public/core/px68k_libretro.js` / `.wasm` は GPLv2 の
  [px68k-libretro](https://github.com/libretro/px68k-libretro) を emscripten でビルドしたもの。
  ビルドに使ったソースは fork の [uraraworks/px68k-libretro](https://github.com/uraraworks/px68k-libretro)
  `emscripten` ブランチ（アクセスランプ用フックの最小パッチ入り）で、ビルド手順は
  [scripts/build-core.sh](scripts/build-core.sh) にそのまま置いてある
- フロントエンド（`src/` 以下）も上記コアと一体で動作するため GPLv2 に揃えている
- `tools/gen-cgrom/` が生成する `cgrom.dat` の字形はパブリックドメインの東雲フォント由来
  （[tools/gen-cgrom/NOTICE.md](tools/gen-cgrom/NOTICE.md) 参照）
- `public/system/` の ROM / ディスクイメージは GPLv2 ではなく、前節の許諾条件に従う

## ファイル転送(ファイルマネージャ)

ツールバーの「ファイル転送」(⇄アイコン)から、FTPクライアント風の2ペインUIでホスト(ブラウザ)⇔
ディスクイメージ間のファイル出し入れができる。移植元は姉妹アプリ WebNP2
(`../PC98/WebNP2/src/ui/filemanager.ts`)で、UI構成・ステージング管理・8.3名変換・アーカイブ
(ZIP/LZH)展開のロジックはほぼそのまま踏襲している。

- `src/api/fat.ts` / `sjis.ts` / `archive.ts` / `archive-util.ts` / `lzh.ts` / `zip.ts` … WebNP2の
  `src/api/` から移植。`fat.ts` はX68000の2HD(1232KB)向けジオメトリとHuman68k HDD形式に対応。
- `src/filemanager.ts` … WebNP2の `src/ui/filemanager.ts` を移植。FmTargetの表示ラベルを
  呼び出し側(main.ts)で組み立て済み文字列として受け取る形に簡略化(WebX68kの
  FDD0/FDD1/HDDという3スロット構成の表示名を一元管理するため)。
- `src/main.ts` の `fmListTargets`/`fmListDir`/`fmReadFile`/`fmWriteFile`/`fmDeleteFile`/
  `fmMakeDir`/`fmCreateTransferFd` … WebNP2の `np2.diskXxx`/`libraryXxx` 相当のコールバック実装。

### ファイル名の文字コード

Human68k のファイル名は **Shift_JIS** で、しかも **MS-DOS が予約しているディレクトリエントリの
12〜21 バイト目を「名前の続き」として使う**(8 + 10 バイト + 拡張子3バイト)。1バイトずつ
`String.fromCharCode()` で拾うと日本語名が化けるうえ、8バイトで切れてしまう
(`簡易説明書.DOC` が `È Õ à ¾.DOC` になる)。

`fat.ts` の `entryDisplayName()` で、名前フィールドと予約領域を**連結してから** SJIS デコードする
(8バイト目と9バイト目にまたがる SJIS 文字があるため、別々にデコードしてはいけない)。

予約領域の余りは **NUL 埋めのことも空白埋めのこともある**ので、`nameExtBytes()` は
「先頭から最初の NUL まで」を名前として取り出す。ここを「全バイトが 0x20 以上」という条件にすると、
実機ディスクでよくある NUL 埋め(`8f 91 00 00 ...`)を取りこぼして
`簡易説明書.DOC` が `簡易説明.DOC` と1文字欠ける。標準的な FAT では 12バイト目は VFAT の
NT フラグ(0x00/0x08/0x10/0x18)で必ず 0x20 未満なので、そこが 0x20 以上であることを
「Human68k の名前拡張である」判定に使っている。

なお**書き込み側は ASCII の 8.3 形式のみ**で、日本語名での新規作成には未対応。

### X68000向けに必要だった変更点

- **セクタサイズ**: WebNP2の `fat.ts` はブートセクタのBPBから `bytesPerSector` を動的に読み取る
  実装だったため、X68000の2HD(1024バイト/セクタ)もコード変更なしでそのまま解釈できた
  (`VALID_SECTOR_SIZES` に1024が含まれている)。実際に同梱の `human302.xdf` で検証済み。
  変更したのは `createFormattedFd()` のジオメトリ定数のみ(PC-98の2HD 1.2MB用パラメータ →
  X68000の2HD 1232KB用パラメータ)。
- **HDD(.hdf)対応**: Human68kのHDDイメージは先頭にHuman68k独自のパーティションテーブル
  (シグネチャ`"X68K"`、パーティションエントリはオフセット0x410から16バイト単位、
  値は256バイトブロック単位)を持つ。全エントリを順に走査し、2バイト分岐命令と16バイトOEM名を
  持つ最初のHuman68kブートセクタを選択する。Human68k HDDのBPBは標準MS-DOS形式と異なり
  オフセット0x12から始まるBEだが、ディレクトリエントリのクラスタ・サイズ・日時はLE、FAT16は
  BEである。この混在をボリュームごとに切り替えるため、標準BPB/FATを使うFDの動作には影響しない。
  ファイルマネージャではHDDスロットとライブラリ内HDDイメージを選択して8.3形式で読み書きできる。

### 実行中スロットへの書き込みの安全性

ファイルマネージャからの書き込みは通常のディスク挿入と同じ経路で反映する。すなわちFDDは
ホットマウントで入れ替え(リセットなし)、起動中のHDDは書き込み禁止(`main.ts` の
`openSlotVolume().persist()`)。また、実行中に
ゲスト側がFSへ書き込んでいる可能性があるため、書き込み前には常に `LibretroHost.readFile()` で
コアのFS上の最新バイト列を読み直してから編集する(ゲスト側の変更を破棄しないため)。

### エラー表示の多言語化

`api/fat.ts` の `DiskError` はコード(`d88NotEditable`/`hddInvalidHeader`/`hddNoFatPartition`/
`invalidShortName`)を持つ例外で、以前はファイルマネージャが `err.message` をそのまま表示して
いたため常に日本語文言になっていた(英語UIでも)。`strings.ts` の `describeError()` が
コードの有無をダックタイピングで判定して現在言語の文言(`errD88NotEditable`等)へ差し替え、
コードを持たない例外(内部エラー)はそのまま `err.message` を返す。`fat.ts` を import せず
ダックタイピングにしているのは、循環依存を避けるため。

### ファイルマネージャの細かい修正

フォルダ行をダブルクリックすると下の階層へ移動する(`filemanager.ts`)が、既定のままだと
ダブルクリックでフォルダ名がテキスト選択状態になり、ブラウザの選択範囲翻訳ポップアップ等が
出てしまっていた。`.fm-disk-item.dir` に `user-select: none` を付けて選択させないようにした
(ファイル行はファイル名をコピーできるよう選択可能のまま)。

### 実データ検証結果

- `human302.xdf`(同梱システムディスク)をファイルマネージャで開き、ルート直下の
  `HUMAN.SYS`(58,496B) / `COMMAND.X`(28,382B) / `CONFIG.SYS`(468B) 等が正しいファイル名・
  サイズで列挙されること、`SYS`/`BIN`/`ETC`等のサブディレクトリに降りられることを確認した。
- ホストへファイルを1つ取り出し(`BEEP.SYS`)、転送が成功することを確認した。
- ホストからファイルを書き込み(`/SYS/TESTUP.TXT`)、書き込み後に空き容量が減り一覧に反映される
  こと、読み出した内容がバイト完全一致することを確認した。
- 書き込み後の `human302.xdf` を実際にFDD0へ挿入して起動し、Human68kが正常にブートすること
  (HUMAN.SYS/CONFIG.SYS/ASK68K.SYS/FD driver extension 等の読み込みに成功すること)を確認した。
  ファイルマネージャでの書き込みがディスクを壊していないことの実証になっている。
- `hd0.hdf`(Human68k入りHDD)のルートと`SYS`/`BIN`/`GAME`を列挙し、ファイル名・サイズと
  サブディレクトリを確認した。HDDから読み出した`HUMAN.SYS`(58,496B)は`human302.xdf`内の
  同名ファイルとバイト完全一致した。
- `hd0.hdf`のコピーへ`VERIFY.TXT`を書き込み、保存後にイメージを開き直して、一覧のサイズと
  読み出した53バイトの内容が書き込み元と完全一致することを確認した。元イメージは変更していない。

### HDDイメージの起動前編集・ブランクHDD作成

WebNP2 と同様、コアが実行中のHDD挿抜に未対応なのは変わらないため、**編集できるのは
起動前だけ**というルールで整理した。

- HDD は起動前に「セット」した状態(`slots.hdd`)を経由し、実際にコアへ渡すのは起動時のみ。
  起動後は `isSlotLocked('hdd')` が true になり、スロットのボタンもファイルマネージャの
  対象一覧からも外れる(`main.ts` の `openSlotVolume().persist()` は起動後拒否)。
- ファイルマネージャからの書き込みは起動前の HDD イメージへ直接反映し、その場で
  IndexedDB(ディスクライブラリ)へ保存される。ページ再読み込みしても編集内容が残る。
- `src/api/fat.ts` の `createFormattedHdd()` が、Human68k形式(パーティションテーブル+FAT16)
  でフォーマット済みの空HDD(40MB)を生成する。IPLの実体(起動コード)は持たないため
  **HDD単体では起動できない**。FDDからHuman68kを起動し、データ用ドライブとして
  使う想定(`main.ts` の `handleCreateBlankHdd()` がHDDスロットの「ブランクHDDを作成」
  ボタンに配線し、生成後はライブラリへ保存してそのままHDDスロットへセットする)。

**ハマりどころ: パーティション名は必ず `"Human68k"` にすること。** Human68k は起動時に
パーティションテーブル(オフセット `0x400`=シグネチャ`"X68K"`, `0x410`から16バイト単位の
エントリ)の名前フィールドでこの文字列を探してドライブレターを割り当てる。最初の実装では
別名(`"Human0"`)にしていたところ、ゲスト側から一切ドライブとして見えず、Human68k上で
`ドライブ名が無効です` というエラーになった。実機吸い出しイメージの同オフセット(`0x410`)を
確認したところ`"Human68k"`固定だったため、`HDD_PARTITION_NAME`定数をこれに合わせて修正し、
実機で `C:` として認識され `DIR C:` が「40779K Byte 使用可能」を返すことを確認して解決した。
再発防止のため `test/fat-hdd.test.ts` で `image.subarray(0x410, 0x418)` が `"Human68k"` と
一致することをアサートしている。

**ハマりどころ2: BPB のジオメトリは Human68k の流儀に合わせること(`spc=1` / `spf` は総セクタ数から算出)。**
名前を直してドライブとしては認識されるようになった後も、**ホスト側で書いたファイルがゲストから
見えず、ゲストが書いたファイルがホストから見えない**という症状が残った。Human68k は BPB の
`sectorsPerCluster` / `sectorsPerFat` をそのまま信じず、次の前提でルートディレクトリ位置
(`reserved + numFats × sectorsPerFat`)を自分で計算するため、こちらの書き込み位置とズレていた。

- `sectorsPerCluster` は **1**(1セクタ=1クラスタ)。8 にしていたときは Human68k 側が
  `spf=81` として root を `0x29400` に置き、こちらは `spf=10` で `0x5C00` に置いていた
- `sectorsPerFat` は **総セクタ数**から `ceil((totalSectors + 2) × 2 / bytesPerSector)`。
  データクラスタ数から最小値を求める一般的な FAT の式だと 1 セクタ小さくなり
  (こちら `spf=80` → root `0x28C00` / Human68k `spf=81` → root `0x29400`)、
  `numFats × 1` セクタぶんズレる
- メディアバイト(`0x1c`)は `0xF8`。書き忘れて `0x00` になっていた

切り分けは、**ゲストの Human68k 自身に `COPY A:\COMMAND.X C:\` を実行させてから
イメージをダウンロードし、`COMMAND` と自作の `WORK` エントリのバイト位置を比較する**方法で行った
(`0x29400` と `0x28C00` で 2 セクタずれていることが判明)。実機吸い出しイメージ
(`_local/verify/hd0.hdf`、総セクタ40510)も同じ式で `spf=80` になっており裏が取れている。
修正後、起動前にファイルマネージャで作成したディレクトリが Human68k の `DIR C:` に
`WORK <dir>` として現れることを確認済み。`test/fat-hdd.test.ts` で BPB の各値と
ルートディレクトリの絶対オフセットを固定してある。

## リセットボタンのハードリセット化

ツールバーの「リセット」は、以前は `host.reset()` 経由でコアの `_retro_reset()` を呼ぶだけの
ソフトリセットだった。しかし「コアオプションの反映は起動時のみ」節で述べたとおり、CPU速度・
RAMサイズ・パッド種別といったコアオプションは `update_variables()` が `retro_run()` の
firstcall(起動直後の1回)でしか読まない。ソフトリセットは `retro_run()` を止めないため、
設定パネルでこれらを変更してもソフトリセットには反映されず、従来は反映させるためにページの
リロードが必要だった。

これを解消するため、リセットボタンの実装を既存の `restartCore()`(ディスク書き戻し →
`host.dispose()` → `bootCore()` の再実行)に繋ぎ替え、実質的にハードリセット(コアの再構築)に
した。`flushAllSlots()` を最初に呼ぶため、CPU速度を変えただけでセーブデータが消える、といった
事故は起きない。副作用として `restartCore()` は非同期であり、処理中に多重起動されるとコアが
不定な状態になるため、処理中は `btnReset` を `disabled` にして防いでいる(`src/main.ts` の
`btnReset.addEventListener()` 参照)。

**HDD ロックとの関係:** この変更でも HDD スロットのロック(`isSlotLocked()`)は解放されない。
`restartCore()` は `running = false` にした直後、ユーザー操作を挟まず自動で `bootCore()` を
呼び直して `running` を再び真に戻すためで、`updateSlotControls()` も再起動完了後にしか呼ばれず
UI上ロック解除が見える瞬間は無い。HDD を入れ替えたいときは今までどおりページの再読み込みが
必要(前述「ディスクのホットマウント(FDD)」参照)。

## 表示アスペクト比(4:3表示モード)

実機の X68000 は画面モード(256x256/512x512/768x512等)に関わらず、常に4:3のブラウン管
モニタいっぱいに表示される。一方 WebX68k は既定でコアの実解像度をそのままドット等倍
(正方形ピクセル)描画しており、実機とは見た目のアスペクト比が異なる。この差を埋めるオプション
として「4:3表示」モードを追加した。判定・目標サイズ計算は DOM に触れない純関数として
`src/aspect.ts` に切り出し、`src/main.ts` の `rescale()` から呼ぶ。

- **既定はドット等倍のまま。** RetroArch/MAME 等の据置きエミュレータではアスペクト補正が
  既定だが、Web系の軽量エミュレータでは等倍表示が一般的であり、既存ユーザーの見た目を
  変えないことを優先した。4:3 は「気づいた人が実機の見え方に切り替えられる」オプションと
  位置づけている(`resolveAspectMode()` のコメント参照)。選択は `localStorage` に保存する。
- **補正は必ず拡大方向。** `getTargetSize()` は縦横比が4/3未満(512x512系)なら高さを保って
  幅を`height*4/3`へ、4/3超(768x512系)なら幅を保って高さを`width*3/4`へ広げる。縮小方向で
  4:3化しないのは、canvas が `image-rendering: pixelated`(最近傍補間)のため、縮小すると
  テキスト画面のような1ドット幅の縦線が間引かれて消え、実機の文字が潰れて読めなくなる不具合を
  実際に踏んだため(2026-08)。非整数倍の拡大になる分、行や列が不均等に複製される粗さは残るが、
  ドットが消えて読めなくなるよりはるかにマシという判断で、この縮小禁止方針を崩さない。
- **補間は4:3表示中のみ有効。** ドット等倍表示は従来どおり `pixelated` のままくっきり保つ。
- **枠は常に4:3時のサイズを確保。** `.stage` を囲む `.stage-frame` ラッパへ `rescale()` が
  常に「4:3時のサイズ」をインラインで指定するため、モードを切り替えてもレイアウトが動かない。
- **フルスクリーンはCSSのみで4:3化する。** ネイティブフルスクリーンは JS を経由せず
  `.stage.aspect-4-3:fullscreen #screen` 系のCSSルール(`style.css`)だけで完結させるため、
  `aspectMode` を `stage` 要素のクラス(`aspect-4-3`)としても反映している。

## 未検証・既知の注意点

- ジョイパッド入力は対応済みです(詳細は「ゲームパッド入力」節)。サイバースティック
  (アナログモード)のみ非対応です。
- ディスクの多面差し替え（`SET_DISK_CONTROL_INTERFACE`）はコア側からの要求を無視しており未対応です。
- HDD は `Config.HDImage[0]`（1台分）のみ UI から扱えます。px68k-libretro 自体は16台まで
  保持できますが、WebX68k の HDD スロットは1行のみです。
