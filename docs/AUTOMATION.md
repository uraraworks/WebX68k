# WebX68k を自動操作する

自動操作の入口と、そこで踏んだ落とし穴を1箇所にまとめた資料です。
測定スクリプト・回帰テスト・AI エージェントからの操作のたびに手探りするのを避けるために書きます。

MCP サーバー経由で操作する場合は [`mcp/README.md`](../mcp/README.md) を参照してください。
この文書が扱うのは、その下にある **ページ内 JS の API** です。

## 入口

`window.__webx68kDebug` は **DEV ビルドでのみ**、無条件に公開されます（`?bridge=1` は不要）。
`npm run dev` で確認済みで、`npm run build` の本番ビルドには含まれません
（`src/main.ts` の `if (import.meta.env.DEV)` ブロック）。

```js
window.__webx68kDebug.stat()   // { queuedSec, fps }
```

`?bridge=1` を付けた場合はさらに `window.__webx68kDebug` とは別に WebSocket ブリッジ
（`src/bridge.ts`）が立ち上がり、MCP サーバーが同じコマンド名で叩けます。ページ内 JS から
ブリッジのコマンドを直接呼びたいときは Bridge インスタンスの `exec(cmd, args)` を使います
（実装のみで、`window` へは公開されていません）。

起動が完了していない間に呼ぶと、多くのメソッドが `undefined` や `null` を返すか例外になります
（`host` や `coreProxy` がまだ存在しないため）。起動待ちは下記の「起動を待つ」を参照してください。

## URL パラメータ

自動操作でよく使うものだけ抜粋します（全体は [README.md](../README.md) の表を参照）。

| パラメータ | 効果 |
|---|---|
| `system=1` | バンドル済みシステムディスク(`human302.xdf`)を FDD0 へ |
| `run=1` | 起動前オーバーレイを出さず自動起動 |
| `bridge=1` または `bridge=<port>` | MCP ブリッジを有効化(既定ポート3099) |
| `fd1` / `fd2` / `hdd` | 指定 URL のディスクイメージをそのスロットへセット(CORS 必須) |

`?system=1&run=1` で接続すると自動起動します。**起動完了(`A>` プロンプト到達)まで実測で
約25秒**かかりました(2026-08-28、dev サーバー)。固定 `setTimeout` で待たず、次項のポーリングで
待ってください。

## 起動を待つ

```js
async function waitBoot(timeoutMs = 40000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const dump = await window.__webx68kDebug.screenText();
    if (dump?.lines?.some((l) => l.includes('A>'))) return dump;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('boot timeout');
}
```

`screenText()` は **Promise を返します**。`await` を忘れると `[object Promise]` を渡した扱いに
なり無言で失敗します（2026-08-28、コミット `8371216` で同期実装から変更されたため、過去の記述を
信用しないこと）。

## 画面を読む

```js
const dump = await window.__webx68kDebug.screenText();
// dump.lines[]: 行配列。dump.diagnostics.coverage 等は src/text-screen.ts 参照
```

`screenText()` が読めるのは **TVRAM(テキスト画面)だけ**です。8x16 ANK と16x16漢字に対応します。
GVRAM / BG / スプライト上の文字（ゲームの多くはこちら）は取得できません。`coverage` が0に近い
場合は `bridge=1` 経由の `screenshot` コマンド、またはピクセルを直接読んでください。

## キー入力

**合成キーイベント（ブラウザ自動操作の `dispatchEvent`/`type` アクション）はゲストに届きません。**
2026-08-28 に実測: puppeteer 相当のブラウザ操作で7文字入力しても `screenText()` に現れませんでした。
既知の「自動ブラウザのキー入力は `code` が空になる」パターンに該当すると見られます(未確認: 本実装が
`e.code` を見ている箇所そのものは今回未特定)。

キー入力を伴う自動検証は次のどちらかにしてください。

- `scripts/measure-key.mjs` のように **puppeteer の keyboard API で `code` を明示**して送る
- 実キー（人手の操作）で行う

`window.__webx68kDebug` にはキー入力用のヘルパーは無く(KeyBuf を読む `keybuf()` のみ)、
キーを注入する経路は `?bridge=1` の `key` / `key_sequence` / `type_text` コマンド
（`src/bridge.ts` の `BridgeHost.setKey`/`typeText` 実装、RETROK コード指定）です。

```js
// KeyBuf(wasm内128バイトリングバッファ)の書き込みポインタと内容を読む(計測用、注入はしない)
window.__webx68kDebug.keybuf(0, 16);
```

## メモリ・音声・フレームの計測フック

`window.__webx68kDebug` には測定スクリプト専用のフックが多数あります。今日(2026-08-28)実地で
`stat`/`screenText`/`storageProbe*` 系の存在と呼び出し可否を確認しました。それ以外は
`src/main.ts` の定義を読んだだけで、実行結果までは確認していません。

| API | 何をするか |
|---|---|
| `stat()` | `{ queuedSec, fps }` |
| `peek(addr)` | ワード単位でメインメモリを読む |
| `moveMouse(dx, dy)` / `mouseButton(button, down)` | Pointer Lock を経由せず相対移動/ボタンを注入 |
| `joy(port)` | 解決済み RetroPad ビットマスクと生入力(物理/バーチャル/キーボード内訳つき) |
| `axes(port)` | ゲームパッドの軸較正状態 |
| `keybuf(start, count)` | KeyBuf の内容を読む(注入はしない) |
| `resetAudioProbe()` / `readAudioProbe()` | 音声振幅の積算区間の開始/読み出し |
| `startQueueProbe()` / `stopQueueProbe()` / `readQueueProbeLog()` | AudioWorklet 内キューの時系列ログ |
| `faultDropNextChunk()` / `faultDelayReportSec(sec)` | 音声計測の故障注入(DEV 限定) |
| `frameProbeEnable(on)` / `frameProbeReset()` / `frameProbeRead()` | フレーム時間分布(runEvents/videoEvents/rafSamples/longTasks) |
| `frameProbeSetBusyWaitFault(on)` | フレーム計測の故障注入 |
| `storageProbeEnable(on)` / `storageProbeReset()` / `storageProbeRead()` | IndexedDB 全量書出し・RAM 展開の計測(既定 off) |
| `storageProbeAbortNextPut()` | 次回の IndexedDB put を意図的に abort させる故障注入 |
| `storageProbeSetNextRamFault(kind)` | 起動時 RAM 展開への故障注入(`skip-write`/`truncate-tail`/`corrupt-checksum`) |
| `storageProbeSaveSlot(slot)` / `storageProbeLoadFromLibrary(key, slot)` / `storageProbeDeleteFromLibrary(key)` / `storageProbeEjectSlot(slot)` / `storageProbeListLibrary()` | ディスクライブラリ(IndexedDB)の直接操作(UI の確認ダイアログを経由しない) |

各フックの詳細な意図はコード中のコメントに書かれています(`src/main.ts` の
`__webx68kDebug` 定義ブロック、2026-08-28 時点で約3701行目〜)。

## ディスク・状態の保存(`?bridge=1` 経由)

`window.__webx68kDebug` にはディスク/ステート操作の API はありません。これらは MCP ブリッジ
(`src/bridge.ts`)側のコマンドとして実装されています。

```
ping status screenshot screen_text reset
type_text key key_sequence
mouse_move mouse_button mouse_click
save_state load_state
list_disks insert_disk eject_disk
disk_list_files disk_read_file disk_write_file
read_memory
wait_screen_change
```

- **HDD を触れるのは起動前だけ**です。`insert_disk`/`eject_disk`/`disk_write_file` で HDD を
  指定できるのは起動前に限られます(`mcp/README.md` 参照。px68k-libretro が実行中の HDD 挿抜に
  非対応のため)
- IndexedDB のデータベース名は `webx68k-bios` / `webx68k-sram` / `webx68k-states`。
  ステート1件で約276KB(gzip後、2026-08-28 実測)。保存できたかは `webx68k-states` に
  `savedAt` 付きレコードが増えることで確認できます

ツールバーの「ステート保存/復元」ボタンから叩く場合は次項の落とし穴1を参照してください。

## 落とし穴

1. **ツールバーの「その他」メニューが自動操作のクリックで開かない。** `btn-save-state` /
   `btn-load-state` は `toolbar-overflow-sources`(`index.html`、`hidden` 属性の待機置き場)に
   置かれ、メニューを開くと表示側の DOM へ移動する作りです(`src/main.ts` 2088行目付近)。
   自動操作ではメニューが開かず、ボタンが待機置き場から出ないため座標が 0x0 のままになります。
   回避策は `document.getElementById('btn-save-state').click()` で直接起動することです
   (本番のクリックハンドラはそのまま通ります)。**人手では開けることを確認済み
   (2026-08-28)。自動操作でのみ開けません。**
2. **合成キー入力はゲストに届きません。** 「キー入力」の項を参照。`scripts/measure-key.mjs` の
   方式(puppeteer keyboard API で `code` 明示)か、実キー(人手)で行ってください。
   **実キーの Enter がゲストに到達することは2026-08-28の人手確認で裏づけ済みです。**
3. **状態を変えたいときはリセットが使えます。** `btn-reset` を押すと画面が空になり、
   明確な陰性対照になります。復元の検証は「保存 → リセット → 復元 → 保存時と同じ画面に戻る」
   で組めます
4. **Claude Code の Browser ペインが非表示だと `requestAnimationFrame` が止まり、
   エミュレータが進まなくなります。** 別セッションを前面にしただけで発生します。自動操作からは
   「応答しない」ようにしか見えません
5. **`javascript_tool` 等、1回の呼び出しに実行時間の上限があるツールでは、起動待ち(約25秒)を
   1回に収めようとすると危険です。** 短く区切ってポーリングしてください
6. **計測スクリプト(`scripts/measure-*.mjs`)を並走させないでください。** 起動時間が基準の
   約1.9倍(45.6秒)に伸びた実績があります。委譲先に走らせた場合、その「完了」通知は
   プロセスの終了を意味しないため `ps` で実プロセスの有無を確認してください

## 計測スクリプト

`scripts/measure-*.mjs` は headful puppeteer で dev/prod サーバーを自前で起動し、故障注入
(`--fault=`)付きの反復計測(`--runs=`)を行います。共通して `--port=` でサーバーのポートを
指定できます。個別のオプションは各スクリプトの先頭コメント、または引数無しで実行したときの
ヘルプ出力を参照してください(例: `node scripts/measure-key.mjs --help` 相当。既定値・故障の
種類はスクリプトごとに異なるため、ここでは一覧化しません)。

---

**動作確認:** 2026-08-28 / WebX68k `feature/storage-opfs-scsi` ブランチ。
`?system=1&run=1` での自動起動、`screenText()` のポーリング待ち(約25秒)、
`window.__webx68kDebug` のキー一覧、`btn-save-state` の直接クリック、合成キー入力が
届かないことは実際に呼び出して確認済みです。表中の各フックの効果は `src/main.ts` /
`src/bridge.ts` のソース定義に基づく記載で、個別の呼び出し確認までは行っていません。
