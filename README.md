# WebX68k

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
- `src/bios-store.ts` … BIOS ファイルを IndexedDB に永続化するヘルパー
- `src/disk-store.ts` … ディスクイメージ(FD/HDD)を IndexedDB に永続化する「ディスクライブラリ」ヘルパー
- `src/core-shim.c` … アクセスランプ取得等、libretro API に無い可変長引数/グローバル参照のための C シム
- `src/state-store.ts` … ステートセーブを IndexedDB に永続化するヘルパー(gzip 圧縮)
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
読むだけなので起動中でも可能。HDD を入れ替えたいときはコアをリセット(起動前の状態)してから操作する。

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

### 操作モード(ツールバーの2ボタン)

WebNP2 と同じアイコン・同じ並びで「マウスキャプチャ」「マウス再同期」を用意している。

- **キャプチャ**: Pointer Lock で掴んで `movementX/Y` をそのまま送る。**canvas 上の右ダブルクリック**
  またはツールバーのボタンで開始し、**解除は Esc かツールバーのボタン**。左クリックはゲストへ
  通す必要があるためキャプチャのトリガにしていない(WebNP2 と同じ流儀)
- **マウスボタンはキャプチャ中だけゲストへ渡す**。非キャプチャ時にも渡すと、キャプチャ開始の
  右ダブルクリックがそのままゲストに届き、X68000 側のソフトキーボード(ASK68K)が開いてしまう
- 同じ理由で、**キャプチャ中の右ダブルクリックは解除に使わない**。ゲスト側で右ダブルクリックを
  使う操作が勝手にキャプチャを外してしまうため
- **再同期**: 追従モード(キャプチャせずホストカーソルへゲストカーソルを追従させる)用。
  **追従モードは未完成のため既定で無効**にしてあり、このボタンもグレーアウトしている

#### 追従モードが未完成な理由

相対量しか送れないので、ゲストカーソルの現在位置が分からないと追従できない。IOCS はワークエリアに
実座標と可動範囲を持っているのでそこを読む閉ループにしたが(`readGuestCursor()`)、
**送った移動量に対してカーソルが大きく動きすぎ、画面端から端へ発振する**。IOCS 側の移動量倍率
(`_MS_SETADJ` 相当)が効いていると見られ、比例ゲインを 0.35 まで絞っても収束しなかった。
倍率を特定できるまでは `ENABLE_MOUSE_TRACKING = false` で無効にしてある。

なお **px68k はゲストメモリをバイトスワップして保持している**(`mem_wrap.c` の `rm_main()` が
`MEM[addr ^ 1]` で読む)。ワークエリアを覗くときは同じ `^1` が必要で、これを忘れると
上下バイトが入れ替わった値を読むことになる(`$AA0` が 511 と読めれば正しい)。

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

## 起動前の初期画面

WebNP2 に合わせ、起動前は canvas 上に「そのまま起動」/「システムディスクで起動」の2択
オーバーレイを表示する（`index.html` の `#boot-overlay`、`src/main.ts` の `startFromOverlay()`）。

- 「そのまま起動」… ディスク未挿入で IPL 起動（`loadGameNone` 相当、IPL ROM のメニューが出る）
- 「システムディスクで起動」… 同梱の `human302.xdf` を FDD0 へ挿入した状態で起動

音声再生の制約上クリック操作が必須なため、オーバーレイの空白部分をクリックしても
「そのまま起動」と同じ扱いになる。

## フロントエンドのビルド

```bash
npm install
npm run build   # dist/ に出力
npm run dev     # 開発サーバー
```

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

## 未検証・既知の注意点

- ジョイパッド入力は未実装です（`RETRO_DEVICE_JOYPAD` は常に 0 を返します）。
- ディスクの多面差し替え（`SET_DISK_CONTROL_INTERFACE`）はコア側からの要求を無視しており未対応です。
- HDD は `Config.HDImage[0]`（1台分）のみ UI から扱えます。px68k-libretro 自体は16台まで
  保持できますが、WebX68k の HDD スロットは1行のみです。
