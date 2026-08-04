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
- `src/disk-store.ts` … ディスクイメージ(FD/HDD)を IndexedDB に永続化する「ディスクライブラリ」ヘルパー。
  拡張子なしイメージの内容ベース判定(`classifyDiskBytes()`/`detectDiskContentKind()`)もここにある(後述)
- `src/api/archive.ts` … LZH/ZIP アーカイブ展開の公開API。拡張子判定と `lzh.ts`/`zip.ts` への振り分けのみ行う
- `src/api/lzh.ts` … LZH 展開(ヘッダレベル0/1/2、メソッド lh0/lh5/lh6/lh7 対応)
- `src/api/zip.ts` … ZIP 展開(圧縮方式 stored/deflate のみ対応。deflate は `DecompressionStream('deflate-raw')`)
- `src/api/library.ts` … ディスクライブラリ一覧の構築(フラットな IndexedDB レコードを、アーカイブ由来の
  複数ディスクをフォルダとしてまとめたツリーへ変換する)。DOM非依存の純粋関数で単体テスト可能
- `src/core-shim.c` … アクセスランプ取得等、libretro API に無い可変長引数/グローバル参照のための C シム
- `src/text-screen.ts` … TVRAM の8x16セルをCGROMのANKグリフへ完全一致させるテキスト取得スパイク
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
読むだけなので起動中でも可能。ツールバーの「リセット」は `host.reset()` を呼ぶだけで `running` は
下ろさない(ロックは解けない)ため、**HDD を入れ替えたいときはページを再読み込みして起動前の状態に戻す**。

## ディスクイメージの形式判定(拡張子 vs 内容ベース)

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

## TVRAM テキスト取得

X68000 の TVRAM は文字コードではなく 1024x1024x4プレーンのビットマップである。
`src/text-screen.ts` は4プレーンを論理ORし、8x16セルを `cgrom.dat` の ANK 8x16ブロック
（オフセット `0x3a800`、1文字16バイト）から実行時に作る逆引き表へ完全一致させる。
`TextScrollX/Y` を加味して循環サンプリングするため、CRTCスクロール後も表示座標を基準にできる。
空セルは空白、未知グリフは `�` とし、行末だけをトリムする。戻り値には行配列に加えて、非空・一致・
未知セル数、一致率、プレーン別非空セル数を含め、TVRAM未使用画面と未対応グリフを区別可能にしている。

逆引きに使う CGROM は、`LibretroHost.init()` が受け取った `biosCg` を一度だけ複製した
`coreCgrom` を単一供給元とする。この同じ配列を `/system/keropi/cgrom.dat` へ書き込み、
`readTextScreen()` も参照する。コアと逆引きで字形が1バイトでも異なると完全一致が成立しないため、
設定済み CGROM を別経路で再取得してはならない。未初期化・CGROM未設定・ANK領域まで届かない
短いCGROM・コア参照失敗は例外にせず、`available: false` と理由、空の行・ゼロ診断を返す。

取得対象は現状 ANK のみで、漢字は未対応。TVRAM以外の GVRAM / BG / スプライトに描かれた文字、
および8x16セルに整列しない描画は取得できない。ゲームの多くはグラフィック側へ文字を描くため、
カバレッジが0に近い場合はスクリーンショットで確認する必要がある。

`core-shim.c` のTVRAMポインタと表示範囲getterを使う。`test/text-screen.test.ts` は合成TVRAMで
4プレーン・列位置・スクロールを常時検証し、Node上のwasm実メモリも検証する。実証時の
Human68k 3.02起動実測では非空768セル中426セルのANKが一致し、`Command version 3.00`、
`B>ECHO OFF`、`B>` を取得できた。未一致342セルは主に対象外の16x16漢字等である。

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
`setPointerCapture()` する。pointerup/cancel/leaveで必ず対応する入力元だけを解放し、500ms後・
50ms間隔の長押しリピートも入力元ごとに管理する。`blur` とhiddenへの
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
  カーソルを出し、`_MS_GETDT`($74) の戻り値を16進表示し続ける。何かキーを押すと終了
- `tools/x68/hu_pack.py` … 生バイナリに Human68k の実行ファイル(.X)ヘッダを被せる。
  ヘッダ構造はディスク同梱の実物(`FLOAT2.X` 等)を解析して確定させた（ヘッダの節を参照）
- `tools/x68/fatput.py` … FD イメージのルートへファイルを1つ書き込む(ホスト用の最小 FAT12
  実装。ジオメトリは BPB から読むので X68000 の 1024B/sector でもそのまま動く)
- `tools/x68/build.sh` … 上記を通しで実行し、`_local/x68build/mousetest.xdf` を作る。
  **同梱のシステムディスクは無改変のまま**で、書き込むのは `_local` 側のコピーだけ

`_MS_GETDT` の戻り値は `d0` の bit31-24 = X移動量 / 23-16 = Y移動量 / 15-8 = 左ボタン /
7-0 = 右ボタン（ボタンは 0=離, $FF(-1)=押）。**移動量は「前回呼び出しからの差分」**なので、
マウスを止めると 0 に戻るのが正常。

実測値（ホスト側から (6,-4) を注入しつつ左ボタン押下）: `MS_GETDT = 12F4FF00`
= X:+18 / Y:-12 / 左:押 / 右:離。右ボタン + (-5,+2) では `FB0200FF` となり、
ハードウェアマウスカーソルも同方向に移動することを確認済み。

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

音声再生の制約上クリック操作が必須なため、オーバーレイの空白部分をクリックしても
1つ目のボタンと同じ扱いになる。

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
  FDD1/FDD2/HDDという3スロット構成の表示名を一元管理するため)。
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
- 書き込み後の `human302.xdf` を実際にFDD1へ挿入して起動し、Human68kが正常にブートすること
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

## 未検証・既知の注意点

- ジョイパッド入力は未実装です（`RETRO_DEVICE_JOYPAD` は常に 0 を返します）。
- ディスクの多面差し替え（`SET_DISK_CONTROL_INTERFACE`）はコア側からの要求を無視しており未対応です。
- HDD は `Config.HDImage[0]`（1台分）のみ UI から扱えます。px68k-libretro 自体は16台まで
  保持できますが、WebX68k の HDD スロットは1行のみです。
