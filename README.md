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
- `src/main.ts` … UI 配線・メインループ

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
`px68k-libretro` 側のリポジトリは一切変更しません。

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

## 未検証・既知の注意点

- 実ブラウザでの動作確認は未実施です。まずは `npm run dev` でローカル起動し、BIOS を設定した上で
  動作確認してください。
- ジョイパッド入力は未実装です（`RETRO_DEVICE_JOYPAD` は常に 0 を返します）。
- ディスクの多面差し替え（`SET_DISK_CONTROL_INTERFACE`）はコア側からの要求を無視しており未対応です。
