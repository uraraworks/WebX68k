# webx68k-mcp — WebX68k を AI から操作する MCP サーバー

WebX68k (X68000 エミュレータ Web 版) をブラウザ越しに操作するための MCP サーバーです。
MCP サーバー本体 (stdio transport) と、ブラウザと通信するための WebSocket ブリッジサーバーを
同一の Node.js プロセス内で起動します。

エミュレータ本体はブラウザ内で動き、この MCP サーバーは常に**あなたのマシン上**で動きます。
ページの JavaScript が `ws://127.0.0.1:<ポート>` へ接続しに来る構成のため、ローカル開発サーバーで
開いても公開ページで開いても同じように使えます。ディスクイメージや画面の内容が外部サーバーへ
送られることはありません。

## セットアップ

前提: Node.js 18 以上。git も npm も不要です。

1. 依存を埋め込んだ単一ファイルを Release から取得する(好きな場所でよい):

   ```sh
   curl -fLO https://github.com/uraraworks/WebX68k/releases/latest/download/webx68k-mcp.mjs
   ```

2. MCP サーバーとして登録する(`<絶対パス>` は 1. で置いた場所に置き換える):

   ```sh
   claude mcp add webx68k -- node <絶対パス>/webx68k-mcp.mjs
   ```

   Claude Code 以外の MCP クライアントの場合は、stdio transport で
   `node <絶対パス>/webx68k-mcp.mjs` を起動する設定を追加します。

3. ブラウザで WebX68k を `bridge=1` パラメータ付きで開く(どちらでもよい):

   - 公開ページ: `https://uraraworks.github.io/WebX68k/?bridge=1`
   - ローカル: `http://localhost:5299/?bridge=1`（リポジトリ直下で `npm install && npm run dev`）

   ページ側は切断されても3秒間隔で繋ぎ直しに行くので、MCP サーバーを後から起動しても構いません。

更新するときは 1. の `curl` をもう一度実行してファイルを差し替えるだけでよく、
`claude mcp add` のやり直しは不要です。

**Safari 非対応(公開ページ利用時)**: https ページから `ws://127.0.0.1` への接続は
Chrome / Edge / Firefox ではローカルホスト例外で許可されますが、Safari はブロックします。
公開ページ + MCP の組み合わせは Chrome 系か Firefox を使ってください。
ローカル (http://localhost) で開く場合はどのブラウザでも動きます。

ブリッジのポートを変えたい場合は、サーバー側は環境変数 `WEBX68K_BRIDGE_PORT`、
ページ側は `?bridge=<ポート番号>` で指定します(既定 3099。WebNP2 の 3098 とは別ポート)。

### リポジトリから直接動かす場合(開発者向け)

`server.mjs` をそのまま使う方法です。リポジトリを触っている人向けで、
上の単一ファイル版と機能は同じです。

```sh
git clone https://github.com/uraraworks/WebX68k.git
cd WebX68k/mcp
npm install
claude mcp add webx68k -- node "$PWD/server.mjs"
```

## 提供するツール

| ツール | 内容 |
| --- | --- |
| `status` | 起動状態・画面サイズ・各ドライブの中身・マウスキャプチャの有無 |
| `screenshot` | 画面を PNG で取得 |
| `screen_text` | TVRAM の8x16 ANK・16x16漢字を行配列とカバレッジ等の診断情報付きで取得 |
| `type_text` | ASCII 文字列をキー入力として送る(改行=Enter) |
| `key_sequence` | RETROK コード指定でキーを順番に押す(F1〜F10・矢印・ESC 等) |
| `mouse_move` / `mouse_click` | マウスの相対移動・クリック |
| `reset` | リセット |
| `wait_screen_change` | 画面が変化して落ち着くまで待つ |
| `save_state` / `load_state` | ステートの保存・復元 |
| `list_disks` / `insert_disk` / `eject_disk` | ドライブ操作(FDD はリセット無しで差し替え。HDD は起動前のみ) |
| `disk_list_files` / `disk_read_file` / `disk_write_file` | ディスクイメージ内のファイル操作(FAT)。HDD への書き込みは起動前のみ |
| `read_memory` | ゲストのメインメモリを読む(IOCS ワークエリアの確認等) |

## X68000 固有の注意点

- **`screen_text` が読めるのはテキスト画面(TVRAM)だけ**です。8x16 ANKと16x16漢字に対応します。
  全角文字は画面上2列を占めますが、文字列には1文字として入ります（行内の文字数と列数は一致しません。
  列位置が必要な場合は全角を2として数えてください）。GVRAM / BG / スプライト上の文字
  （ゲームの多くはこちら）や、8x16 セルに
  整列しない文字は取得できません。`diagnostics.coverage` が 0 に近い場合は `screenshot` で
  画面を確認してください
- **マウスは相対移動のみ**。X68000 のマウスは SCC 経由で移動量だけを送る方式で、カーソル位置は
  ゲスト側が管理しています。そのため絶対座標を指定するツールはありません
- **HDD を触れるのは起動前だけ**。px68k-libretro は実行中の HDD 挿抜に対応していないため、
  `insert_disk` / `eject_disk` / `disk_write_file` で HDD を指定できるのは起動前に限られます。
  起動前の HDD はスロットに「セット」されるだけで起動はせず、その状態なら中身を直接編集できます。
  起動後の HDD は読み出し専用です(コアが掴んでいる間にホストが書き換えるとゲスト側のキャッシュと
  食い違うため)
- **`type_text` は ASCII のみ**。全角文字はゲスト側の FEP を通す必要があるため非対応です。
  記号は X68000 の JIS 配列に合わせて SHIFT 付きに分解して送ります
- **ブラウザのタブが非アクティブだと極端に遅くなります**。ブラウザはバックグラウンドタブの
  タイマーを強く抑制するため、`type_text` のようにキーを1文字ずつ間隔を空けて送るツールは
  タイムアウトすることがあります。操作中はタブを表示したままにしてください

## リリース手順(メンテナ向け)

配布物は `server.mjs` に依存を埋め込んだ単一ファイル `webx68k-mcp.mjs` です。
`mcp-` で始まるタグを push すると
[.github/workflows/release-mcp.yml](../.github/workflows/release-mcp.yml) が
ビルド・スモークテスト・Release 作成まで自動で行います。

```sh
git tag mcp-2026-08-06
git push origin mcp-2026-08-06
```

タグ名は日付形式にしています。npm と違って同じ内容を再配布する制約が無いため、
semver で厳密に刻む必要はなく、更新順が分かれば十分という判断です。
利用者に案内する URL は `releases/latest/download/webx68k-mcp.mjs` で固定できるので、
タグを増やしても手順書の書き換えは発生しません。

手元で確認する場合:

```sh
npm install
npm run bundle
node ../scripts/smoke-test-mcp-bundle.mjs dist/webx68k-mcp.mjs
```

スモークテストは実際にバンドルを起動し、`initialize` → `tools/list` が通ること、
主要ツールが揃っていること、WebSocket ブリッジが立ち上がることを確認します。
esbuild のバンドルは依存パッケージ内の動的 `require` で壊れることがあり
(`ws` が該当するため `--banner` で `createRequire` を注入しています)、
この種の事故は起動してみないと検出できないため Release 前に必ず通します。
