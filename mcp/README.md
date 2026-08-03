# webx68k-mcp — WebX68k を AI から操作する MCP サーバー

WebX68k (X68000 エミュレータ Web 版) をブラウザ越しに操作するための MCP サーバーです。
MCP サーバー本体 (stdio transport) と、ブラウザと通信するための WebSocket ブリッジサーバーを
同一の Node.js プロセス内で起動します。

エミュレータ本体はブラウザ内で動き、この MCP サーバーは常に**あなたのマシン上**で動きます。
ページの JavaScript が `ws://127.0.0.1:<ポート>` へ接続しに来る構成のため、ローカル開発サーバーで
開いても公開ページで開いても同じように使えます。ディスクイメージや画面の内容が外部サーバーへ
送られることはありません。

## セットアップ

前提: Node.js 18 以上。

1. 依存をインストールする:

   ```sh
   cd <クローン先>/WebX68k/mcp
   npm install
   ```

2. MCP サーバーとして登録する(`<絶対パス>` は実パスに置き換える):

   ```sh
   claude mcp add webx68k -- node <絶対パス>/WebX68k/mcp/server.mjs
   ```

   Claude Code 以外の MCP クライアントの場合は、stdio transport で
   `node <絶対パス>/WebX68k/mcp/server.mjs` を起動する設定を追加します。

3. ブラウザで WebX68k を `bridge=1` パラメータ付きで開く:

   - ローカル: `http://localhost:5299/?bridge=1`（リポジトリ直下で `npm install && npm run dev`）

   ページ側は切断されても3秒間隔で繋ぎ直しに行くので、MCP サーバーを後から起動しても構いません。

ブリッジのポートを変えたい場合は、サーバー側は環境変数 `WEBX68K_BRIDGE_PORT`、
ページ側は `?bridge=<ポート番号>` で指定します(既定 3099。WebNP2 の 3098 とは別ポート)。

## 提供するツール

| ツール | 内容 |
| --- | --- |
| `status` | 起動状態・画面サイズ・各ドライブの中身・マウスキャプチャの有無 |
| `screenshot` | 画面を PNG で取得 |
| `type_text` | ASCII 文字列をキー入力として送る(改行=Enter) |
| `key_sequence` | RETROK コード指定でキーを順番に押す(F1〜F10・矢印・ESC 等) |
| `mouse_move` / `mouse_click` | マウスの相対移動・クリック |
| `reset` | リセット |
| `wait_screen_change` | 画面が変化して落ち着くまで待つ |
| `save_state` / `load_state` | ステートの保存・復元 |
| `list_disks` / `insert_disk` / `eject_disk` | ドライブ操作(FDD はリセット無しで差し替え) |
| `disk_list_files` / `disk_read_file` / `disk_write_file` | ディスクイメージ内のファイル操作(FAT) |
| `read_memory` | ゲストのメインメモリを読む(IOCS ワークエリアの確認等) |

## X68000 固有の注意点

- **画面をテキストとして読む手段がありません**。X68000 のコンソールはグラフィック描画なので、
  PC-98 版(WebNP2)の `screen_text` に相当するものが作れません。画面の確認は `screenshot` で
  行い、処理の完了待ちは `wait_screen_change` を使ってください
- **マウスは相対移動のみ**。X68000 のマウスは SCC 経由で移動量だけを送る方式で、カーソル位置は
  ゲスト側が管理しています。そのため絶対座標を指定するツールはありません
- **`type_text` は ASCII のみ**。全角文字はゲスト側の FEP を通す必要があるため非対応です。
  記号は X68000 の JIS 配列に合わせて SHIFT 付きに分解して送ります
- **ブラウザのタブが非アクティブだと極端に遅くなります**。ブラウザはバックグラウンドタブの
  タイマーを強く抑制するため、`type_text` のようにキーを1文字ずつ間隔を空けて送るツールは
  タイムアウトすることがあります。操作中はタブを表示したままにしてください
