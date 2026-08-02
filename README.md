# WebX68k

ブラウザ上で動作する X68000 エミュレータのフロントエンドです。エミュレーション本体には
[px68k-libretro](https://github.com/) の `emscripten` ブランチを WebAssembly にビルドしたものを利用します。
Vite + TypeScript（フレームワーク無し）の最小構成です。

## 構成

- `scripts/build-core.sh` … px68k-libretro コアを emscripten でビルドし、`public/core/` に配置する
- `public/core/` … ビルド済みの `px68k_libretro.js` / `px68k_libretro.wasm`（コミット対象）
- `public/bios/` … BIOS ファイル置き場（`.gitignore` 対象。中身は各自で用意）
- `src/libretro-host.ts` … libretro コールバックを wasm 関数テーブルに登録し、コアを駆動するホスト実装
- `src/audio.ts` … AudioWorklet によるストリーミング音声出力
- `src/keyboard.ts` … `KeyboardEvent.code` → `RETROK_*` のマッピング
- `src/bios-store.ts` … BIOS ファイルを IndexedDB に永続化するヘルパー
- `src/disk-store.ts` … ディスクイメージ(FD/HDD)を IndexedDB に永続化する「ディスクライブラリ」ヘルパー
- `src/core-shim.c` … アクセスランプ取得等、libretro API に無い可変長引数/グローバル参照のための C シム
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

## BIOS ファイルについて

本リポジトリに BIOS ファイル（`IPLROM.DAT` / `CGROM.DAT`）は含まれていません。著作権の関係上、
各自で実機からの吸い出し、または下記のような配布元から入手し、画面の「BIOS 設定」パネルから
読み込んでください（読み込んだファイルはブラウザの IndexedDB に保存され、次回以降は自動で読み込まれます）。

- http://retropc.net/x68000/software/sharp/x68bios/

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

px68k-libretroはFDD/HDDのホットマウント差し替えに対応していない(ディスク挿入UIも常にコア再起動
で反映している)。ファイルマネージャからの書き込みも同じ方針に倣い、実行中スロットへ書き込むと
その場でコアを再起動して反映する(`main.ts` の `openSlotVolume().persist()`)。また、実行中に
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
