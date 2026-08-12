# ストレージ拡張検討ノート（SCSI / OPFS）

このドキュメントは `docs/DESIGN.md` のような確定仕様ではない。**未決事項を抱えたままの検討ノート**であり、結論を断定せず「決まっていること」「決まっていないこと」「測って決めること」を区別して書く。今後の調査・実測で内容が更新される前提。

## 背景：現状の容量上限

- SASI HDDイメージの実用上限は **40MB**。これは SASI バス規格由来ではなく、X68000 側（IOCS / Human68k の SASI ドライバ・`format.x`）の制約。
- px68k のエミュレータ側にはサイズ制限が無い。`px68k-libretro/x68k/sasi.c:261` では LBA を21ビット（`((Cmd[1]&0x1f)<<16)|(Cmd[2]<<8)|Cmd[3]`）で組み立てており、256バイト/セクタなので理論上512MBまでアドレス可能。イメージサイズのチェックも存在しない。
- px68k は内部的に `Config.HDImage[16]`（デバイス8 × ユニット2、`HDImage[SASI_Device*2+SASI_Unit]` で参照）を持つが、UI で選べるのは HDD0/HDD1 の2台まで（`libretro/winui.c:454` の `WinUI_get_drv_num`）。
- WebX68k は現状 HDD0 の1台のみ使用（`src/main.ts:2302` で `HDD0=` のみ ini に書き込み）。よって実効上限は **40MB × 1**。

## 選択肢A：HDD1 を有効化（40MB × 2 = 80MB）

- 低コストで実装できるが、天井の性質は変わらない。壁が2倍先に来るだけで、根本解決にはならない。

## 選択肢B：SCSI 対応（本命）

- px68k の `x68k/scsi.c` は SPC（MB89352）を実装していない。ダミーROMが SCSI IOCS 呼び出し時に IOCS番号を `$e9f800` に書き出す（`scsi.c:33`）だけで、**受け側のハンドラは存在しない**。`$e9f800` を grep してもヒットするのは `scsi.c` 内のコメントとROMバイト列のみで、`SCSI_Write()` は空関数。

### 実装方針は2案

- **HLE（IOCS乗っ取り）** — `$e9f800` の受け側で SCSI IOCS（`_S_READ` / `_S_WRITE` / `_S_INQUIRY` 等）を512バイト/セクタでイメージファイルに読み書きする。構造は `sasi.c` とほぼ同じで、SPC のレジスタもフェーズ遷移も不要。数百行のオーダーと見込む。**本命**。
- **SPC実装** — バスフェーズ・DMA・割り込みまで実装する。SxSI 等 IOCS を経由せず SPC を直接叩くソフトへの対応が必要な場合のみ必要。容量拡張が目的なら不要と考えている。

### Human68k 側の容量上限

- 純正SCSIボードのブートプログラムは1GB超のドライブから起動できない（いわゆる「1GBの壁」）。
- `FORMAT.X` のドライバは LBA が24ビット。`GOverHD.X` 等の回避策込みで OS 上限は16GBと言われている（伝聞情報。一次資料での裏取りは未実施）。

### 未解決の設計判断

- `scsi.c` のコメントに "Booting from a SCSI device is not possible" と明記されており、ダミーIPLは IOCS ベクタを張るだけで起動処理を持たない。
- **「SASIから起動して SCSI はデータ用とする」か「SCSIからの起動まで実装する」かが未決。** 前者なら既存の Human68k 環境をそのまま活かせるため、初手としては安全と考えている。

## 選択肢C：I/O を OPFS へ（実ストレージ直接読み書き）

- 現状 px68k の SASI はセクタごとに `file_open` → `seek` → `read/write` を**同期**で呼ぶ。emscripten ではこれを満たすため MEMFS（ヒープ上）にイメージ全体が載っている。
- 永続化も `SASI_Dirty` が立つとイメージ**全体**を吸い出して IndexedDB へ書く（`src/libretro-host.ts:743` の `_get_sasi_dirty`、`src/main.ts:3439`）。40MBなら保存のたびに40MB書き出す構造になっている。
- 同期I/Oのまま実ストレージへ書く手段として **OPFS の `FileSystemSyncAccessHandle`**（ワーカー内でのみ同期read/write可）がある。emscripten の WasmFS には OPFS バックエンドが存在する。もう一案の Asyncify はコア全体が重くなるため割に合わないと判断している。

### 前提条件（重い）

- `FileSystemSyncAccessHandle` はワーカー専用。現状 WebX68k はコアをメインスレッドで実行しており、`new Worker` は無い（ワーカーは AudioWorklet のみ）。よって**コアのワーカー移行が必須**。
- 付随作業として以下が発生する見込み：
  - OffscreenCanvas への描画付け替え
  - キーボード/マウス/パッド入力のメイン→ワーカー転送
  - 音声のワーカー→AudioWorklet 経路の組み直し
- ワーカー移行自体は容量拡張と無関係にも価値がある。メインスレッドのレイアウト/GCによるフレーム供給の揺れの解消、`document.hidden` で rAF が止まる問題（`feedback_headless_raf_never_runs.md` 参照）の切り離しにつながる。
- **COOP/COEP は不要**。SharedArrayBuffer と異なり `crossOriginIsolated` を要求しない。

### 期待される効果（OPFS化）

- 保存時の全体書き出しが消える（書いたセクタだけ落ちる）。
- 起動時に IndexedDB からイメージ全体を RAM 展開する処理が不要になり、起動が速くなる見込み。
- 書き込みが即座に永続化されるため、「平常時に短間隔で保存する」という現行設計自体が不要になる可能性がある。
- URL由来イメージを fetch のレスポンスストリームのまま OPFS へ流し込めるため、大容量でも一度 RAM に載せずに済む見込み。

### リスク・要検証

- **入力レイテンシ** — メイン→ワーカーの postMessage が1ホップ増える。理屈上1フレーム未満のはずだが、実測（KeyBuf 末端までの結合テスト）で確認しないと保証できない。`feedback_input_path_needs_end_to_end_measurement.md` の教訓のとおり、定数の一致は経路の証明にならない。
- **iOS** — OPFS の同期ハンドルは Safari 15.2〜、OffscreenCanvas は Safari 16.4〜。バージョン上は足りているはずだが実機検証が必要。iOS の Chrome は中身が WebKit（App Store規約により WKWebView 必須）なので「Chrome前提」では回避できない。裏を返せば検証対象は iOS の WebKit 1つで済む。
- **OPFS の eviction** — オリジン単位のストレージで、容量逼迫時に evict されうる。大容量を置くなら `navigator.storage.persist()` での永続化要求と `estimate()` での残量監視が必要になる見込み。

## URL指定HDDの扱い（要設計判断）

- 現状：URL由来イメージは取得後にディスクライブラリ（IndexedDB）へ登録される（`src/main.ts:896`）。同一URL再訪時は保存済みを再利用するトーストが既にある（`src/strings.ts:183`）。
- OPFS化後も構図は同じで、保存先が替わるだけ（URL → fetch → OPFS へ書き出し → マウント）と見込んでいる。
- **未決** — HDD はゲストが書き換えるため、同一URL再訪時に「ローカルの続きを使う」か「URLの原本に戻す」かの判断が要る。現行の再利用挙動を延長すれば前者だが、**原本へ戻すリセット導線**が無いと詰む。sourceKey に ETag / 更新日時を持たせて「配布元が更新されています」と通知する案がある（未実装・未設計）。
- ユーザーから見えない場所にデータが育っていくため、**取り出す道（エクスポート）と捨てる道（削除UI・容量表示）**がセットで必要になる。

## 実施順序の案

1. **コアのワーカー移行** — 既存の40MB SASI構成のまま、Human68k 起動まで回帰が取れることを確認する。
2. **I/O を OPFS へ差し替え** — まず SASI で。動いている経路で置き換えれば、壊れたときの原因を1つに絞れる。
3. **SCSI HLE** — `$e9f800` の受け側を実装、512バイト/セクタ。

2と3を同時にやると、Human68k がドライブを認識しなかったときに「I/Oが悪いのか IOCS 実装が悪いのか」で切り分け不能になるため、あえて分ける。

## 着手前に取っておく基準値

移行後は「移行前の状態」と比較できなくなるため、着手前に現行構成で計測しておく：

- Human68k の起動
- 3ドライブの認識
- キー入力の末端到達（KeyBuf/TVRAM 実測。`feedback_input_path_needs_end_to_end_measurement.md` 参照）
- 音の遅延

## 未調査の項目

- `FORMAT.X` の24ビットLBA上限・`GOverHD.X` の16GB上限は伝聞情報であり、一次資料（マニュアル・実バイナリ解析）での裏取りは未実施。
- SPC実装が必要になる具体的なソフトウェア（SxSI IOCS を経由しないもの）の洗い出しは未実施。
- OPFS の実際の書き込みスループット・レイテンシは未計測。
- iOS WebKit での OPFS 同期ハンドル・OffscreenCanvas の実機動作は未検証。

## ワーカー移行の影響範囲

以下は現行 `src/` を読んだ時点の影響範囲。ワーカーのプロトコル、フレームの主時計、描画をワーカー内で完結させるかどうかは未決であり、ここでは実装方式を確定しない。

### 移行の難所トップ3

1. **同期コールバックを含む入力・コア状態参照の分離** — `retro_run()` 中の `input_poll` が、メインスレッド専用の Gamepad API と SRAM 読み出しを同じ呼び出しスタックで実行している（`src/libretro-host.ts:511`、`src/main.ts:2424`）。マウス追従もゲストメモリを読んで直ちに次の入力を決める閉ループである（`src/main.ts:2893`）。単純に各メソッドを非同期 RPC に置き換えるだけでは現在の順序を保てない。
2. **ディスクデータの所有権と永続化方式の組み替え** — UI、MEMFS、`slots[].data`、IndexedDB がそれぞれイメージ全体を `Uint8Array` で持つ前提である（`src/main.ts:1239`、`src/main.ts:1296`、`src/disk-store.ts:6`）。HDD を OPFS 直接 I/O にしても、この上位経路を残すと起動・保存・ダウンロード・ファイルマネージャで全量 RAM 化が残る。
3. **フレーム駆動・音声フィードバック・動的解像度の再結線** — 現在は rAF、タイマー、AudioWorklet の tick、音声キュー量、コアが通知する可変 fps が1つのメインスレッドループに集約されている（`src/main.ts:3491`、`src/main.ts:3723`、`src/audio.ts:61`）。さらに映像コールバックが canvas の実サイズを同期変更する（`src/libretro-host.ts:652`）。Worker 化では時計と状態通知の所有者を先に決める必要がある。

### 1. コアホストとワーカー境界（最初に決める依存関係）

**現状** — `LibretroHost` が Emscripten Module、wasm ヒープ、MEMFS、入力状態、canvas、音声コールバックをすべて同じオブジェクトに保持する（`src/libretro-host.ts:175`）。コア glue は `index.html` の通常 script として読み込まれ（`index.html:320`）、`init()` は `window.PX68K` を直接呼ぶ（`src/libretro-host.ts:461`）。Emscripten の libretro コールバック登録と wasm 関数テーブル操作もここで行う（`src/libretro-host.ts:501`）。

**ワーカー化での問題** — Worker には `window` と `HTMLCanvasElement` がなく、現在の `LibretroHost` をそのまま移せない。Module とその HEAP の参照をメインへ渡すこともできないため、`main.ts` が同期値を返す前提の全メソッドはメッセージ境界を越えられない。現在の glue は `scripts/build-core.sh:30` の `MODULARIZE` ビルドであり、Worker 内での実際のロード方法と OPFS/WasmFS 用リンクオプションは未確認。

**取りうる対応** — `LibretroHost` を「Worker 内のコア実装」と「メイン側の非同期 proxy」に分け、コア生成、コールバック、HEAP/MEMFS/OPFS、フレーム実行を Worker 側へ閉じ込める。Worker entry から glue を import できる形へビルドまたはロード方法を変更し、初期化・コマンド応答・イベント通知（解像度、fps、アクセスランプ、ダーティ状態、SRAM 等）のプロトコルを定義する必要がある。コマンドには世代番号を持たせ、`restartCore()` 後に旧 Worker の応答が新コアへ混ざらないようにする案が考えられる。

### 2. コア駆動ループと音声を主時計にした補正

**現状** — `scheduleNext()` は rAF と32msの `setTimeout` を競争させ、先に発火した側で `loop()` を実行する（`src/main.ts:3496`）。AudioWorklet も約11.6msごとに tick とキュー秒数を送り（`src/audio.ts:61`）、メイン側がそれを `enterLoop()` へ接続する（`src/main.ts:3836`）。`loop()` は `performance.now()` の差分、コアの可変 `avInfo.fps`、音声キュー量、速度倍率からフレーム間隔と実行予算を計算し、1回以上進んだ後にアクセス監視、オートセーブ、マウス追従を同期実行する（`src/main.ts:3723`）。`RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO` による15kHz/31kHz切替時の fps 更新もホスト内で同期反映される（`src/libretro-host.ts:591`）。

**ワーカー化での問題** — `host.runFrame()` はメインから同期実行できず（`src/main.ts:3753`）、現在の while ループをメインに残してフレームごとに RPC すると待ち時間とメッセージ数が増える。逆に Worker へ移すと、AudioWorklet がメインへ返すキュー量と tick、UI の実測速度表示、アクセスランプ更新が別スレッドになる。複数の起動源が同時に Worker へ tick を積むと、現在の `cancelScheduled()` による重複排除も失われる。

**取りうる対応** — フレーム予算計算と `retro_run()` の while ループを Worker に移し、メインからは AudioWorklet の `q` と速度設定を低頻度の状態更新として送る構成が候補。別案としてメインが時刻を送る構成もあるが、1フレーム1メッセージにはしないほうがよい。Worker からは実行フレーム数、fps、アクセス状態など UI に必要な集約結果だけを通知する。Worker の主時計を `setTimeout` にするか、メイン rAF/AudioWorklet tick を併用するか、および非表示タブ・iOS・ヘッドレスでの挙動は未決・未実測。

### 3. 描画、動的解像度、スクリーンショット

**現状** — video callback は wasm の RGB565 を HEAP から読み、`ImageData` の RGBA へ毎画素変換して `putImageData()` する（`src/libretro-host.ts:652`）。width/height が変わると `canvas.width/height`、`ImageData` を同期更新し、`onResolutionChanged` からメインの `rescale()` を呼ぶ（`src/libretro-host.ts:655`、`src/main.ts:2373`）。`rescale()` は canvas の実解像度と DOM の実測寸法を使う（`src/main.ts:3284`）。メイン側は同じ canvas から PNG、MCP 用 data URL、画素ハッシュを同期取得する（`src/main.ts:3914`、`src/main.ts:4316`、`src/main.ts:4328`）。

**ワーカー化での問題** — `transferControlToOffscreen()` 後はメイン側で同じ canvas の2D contextを取得・描画・読み戻しできない。`LibretroHost` の型と constructor（`src/libretro-host.ts:177`、`src/libretro-host.ts:229`）の変更だけでなく、スクリーンショットと `screenHash` も壊れる。256/512/768幅や480/512ライン等の切替で Worker 側 OffscreenCanvas のサイズだけを変えても、`rescale()` をいつ呼ぶかという DOM 側の同期契機は別途必要になる。

**取りうる対応** — HTML canvas を起動前に一度だけ OffscreenCanvas へ移譲し、video callback、RGB565変換、`putImageData()` を Worker 内へ移す。解像度変更時は `{width,height}` をメインへ明示通知し、DOM/CSS の `rescale()` はメインで実行する。PNG は Worker の `convertToBlob()` 等で生成して転送し、画素ハッシュも Worker 内で計算して返す構成が候補。その場合 `BridgeHost.screenshot(): string` と `screenHash(): number` の同期 interface（`src/bridge.ts:11`）を Promise 化する必要がある。OffscreenCanvas のサイズ変更が転送元 HTML canvas の `width/height` 属性へどのブラウザでどう反映されるかは未確認であり、明示通知を前提にしたほうが安全と考えられる。

### 4. 入力（キーボード、マウス、ゲームパッド）

**現状** — 物理キーボードは window の `keydown`/`keyup` を canvas focus 中だけ捕捉し（`src/main.ts:2727`）、物理・仮想・ブリッジ入力を `SharedKeyInput` で合成して `host.setKey()` へ渡す（`src/main.ts:610`）。make-only のキーリピートは `_webx68k_send_key_make` を同期呼び出しする（`src/libretro-host.ts:262`）。マウスの DOM/Pointer Lock イベントはメインで取得し（`src/main.ts:2877`、`src/main.ts:2980`、`src/main.ts:3011`）、相対量とボタンを host 内へ蓄積する。libretro の `input_state` は `retro_run()` 中にその集合を同期参照し、マウス delta を読み取った分だけ減らす（`src/libretro-host.ts:515`）。ゲームパッドは `input_poll` の瞬間に `navigator.getGamepads()` を読み、マッピング、仮想パッド、ホストキーを合成して同じフレームの `input_state` へ渡す（`src/main.ts:2424`）。設定ダイアログの表示用ポーリングはこれとは別の rAF である（`src/gamepad-ui.ts:9`）。

**ワーカー化での問題** — DOM/Pointer Lock と `navigator.getGamepads()` は現在の Worker 側処理から同じ形では利用できない。特に `onPoll` は wasm→JS callback の途中なので、そこでメインへ問い合わせて同期応答を待つことは SharedArrayBuffer なしではできない。blur/visibility 時の同期クリア（`src/main.ts:596`）もメッセージ到着順を考慮する必要がある。マウス追従は毎フレーム `readGuestCursor()` と `hasPendingMouseDelta()` を読み、その結果で直ちに delta を積む（`src/main.ts:2893`）ため、メインに残したまま非同期 RPC 化すると ACK 状態機械とフレームの対応が変わる。SRAM のキーリピート設定も `onPoll` 内で60フレームごとに同期取得している（`src/main.ts:2418`）。

**取りうる対応** — DOM イベントはメインで正規化し、キー集合、マウス delta/ボタン、ゲームパッドの解決済み2ポート bitmask を Worker へ送る。Worker は最後に受信したスナップショットを `input_state` から同期参照する。ゲームパッドはメイン側に独立ポーリングを設けるか、Worker のフレーム通知を契機にポーリングする必要がある。マウス delta はイベント列の取りこぼし・並べ替えを避けるため加算コマンドまたは通し番号を使い、blur/visibility は全入力クリアの世代を進める案がある。閉ループ追従はゲスト座標読み出しと delta 消費状態を Worker に移し、メインは目標比率だけ送る構成が自然に見えるが未決。SRAM から得たリピート時間は Worker から変更時だけメインの `KeyRepeater` へ通知できる。

### 5. 音声経路

**現状** — wasm の sample/batch callback は HEAP16 を Float32Array に変換し、`LibretroHost` の `audioPush` を同期呼び出す（`src/libretro-host.ts:507`、`src/libretro-host.ts:695`）。`bootCore()` 側で速度倍率に応じたリサンプルを行い（`src/main.ts:2366`）、`AudioEngine.push()` がさらにコピーして transferable として AudioWorkletNode の port へ積む（`src/audio.ts:182`）。逆方向には Worklet からキュー量と tick がメインへ来る。

**ワーカー化での問題** — Worker はメインが所有する `AudioWorkletNode.port` を現在の形で直接呼べず、素朴には Worker→メイン→AudioWorklet の2ホップになる。現行の `audioPush` callback、速度リサンプラの状態、キュー量フィードバックが別スレッドに分裂し、各段で配列をコピーすると音声帯域分の余計な確保が続く。

**取りうる対応** — 最小変更は、Worker が変換・速度リサンプル済み Float32Array を transferable でメインへ送り、メインが Worklet へ再転送する方式。コピーを減らすなら専用 `MessageChannel` の port を Worker と AudioWorkletProcessor の双方へ渡し、音声チャンクとキュー量を直接往復させる構成も候補だが、Worklet 実装変更とブラウザ実機検証が必要。AudioContext の作成、resume/suspend、自動再生解除はユーザー操作と DOM visibility に結び付いているためメインに残す（`src/audio.ts:134`、`src/main.ts:3653`）。

### 6. ファイル、FDD/HDD、IndexedDB、ダーティ監視

**現状** — 起動時は BIOS/SRAM/全ディスクを `Uint8Array` で MEMFS に書き、config/cmd を作って同期 `retro_load_game()` する（`src/libretro-host.ts:461`、`src/main.ts:2453`）。実行中 FDD の吸い出しは eject→MEMFS read→再insertの同期シーケンスであり（`src/main.ts:1230`）、ホットスワップも eject、write、insert の厳密な順序に依存する（`src/main.ts:1257`）。HDD は MEMFS ファイルを直接全量 read する。毎フレーム後にアクセスフラグを読み（`src/main.ts:3526`）、1秒ごとにダーティフラグを同期確認し、クリア後に全量を IndexedDB へ保存する（`src/main.ts:3568`、`src/main.ts:3616`、`src/disk-store.ts:55`）。URL取得も最終的に `arrayBuffer()`/連結済み `Uint8Array` を作る（`src/main.ts:906`、`src/main.ts:925`）。ファイルマネージャはイメージ全体を FAT ボリュームとしてメインメモリで開く（`src/main.ts:4079`）。

**ワーカー化での問題** — MEMFS 操作と FDD export は Worker 所有になるため、ダウンロード、排出、ホットスワップ、再起動前 flush はすべて非同期コマンドへ変わる。特に `flushAllSlots()` は「関数を抜ける前に同期吸い出し済み」という前提（`src/main.ts:3601`）が崩れ、`restartCore()` の `flushAllSlots(); dispose()`（`src/main.ts:2491`）では保存前に Worker を止める危険がある。transferable でディスクを Worker へ渡すと `slots[].data` が detach され、その後のダウンロード・再起動フォールバック・ファイルマネージャが使えない。一方コピーすれば目的である HDD 全量 RAM 排除に反する。OPFS 化後はセクタ書き込み自体が永続化されるため、現行 HDD ダーティ監視と IndexedDB 全量保存をそのまま残す意味も薄れる。

**取りうる対応** — FDD は当面従来の全量イメージ方式を Worker 内に残し、HDD だけを OPFS ハンドル/識別子でマウントする段階移行が考えられる。メインの `slots` は HDD bytes ではなくメタデータと OPFS entry ID を持つ形へ変え、起動、URL import、ライブラリ登録、ダウンロードをストリーム/OPFS コピー中心に組み直す。再起動・排出は `await worker.flush/close` 完了後に terminate する。アクセスランプはフレーム単位イベントまたは集約通知へ変更する。HDD のダーティフラグを廃止できるか、FDD/IndexedDB ライブラリとの互換をどう保つか、既存 IndexedDB レコードを OPFS へ移行する時期と失敗時の扱いは未決。FAT API は現在全量 `Uint8Array` 前提なので、大容量 HDD をファイルマネージャから扱う場合は別途ランダムアクセス抽象化が必要になる。

### 7. UI から同期的にコアを叩く箇所（網羅一覧）

直接の `mod._xxx()` は `src/libretro-host.ts` と `src/text-screen.ts` に集約されているが、`main.ts` はその同期ラッパーを多数利用している。Worker proxy 化で変更対象になる呼び出しを用途別に列挙する。

| 用途 | 現状の同期呼び出し | 問題と取りうる対応 |
|---|---|---|
| 初期化・コールバック | `_malloc/_free`、`addFunction/removeFunction`、`_retro_set_*`、`_retro_init`（`src/libretro-host.ts:167`、`src/libretro-host.ts:488`、`src/libretro-host.ts:544`、`src/libretro-host.ts:882`） | すべて Worker 内に閉じる。メインには ready/disposed の非同期応答だけを返す。なお `_retro_deinit` は型定義されているが現行 `dispose()` から呼ばれていない（`src/libretro-host.ts:80`、`src/libretro-host.ts:883`）。意図は未確認。 |
| コアオプション | 文字列ポインタの解放と `GET_VARIABLE` 時の HEAP 書換え（`src/libretro-host.ts:445`、`src/libretro-host.ts:620`）、起動時の `host.setCoreOption()` 群（`src/main.ts:2376`） | オプション Map と文字列ポインタは Worker 所有にする。UI変更は設定メッセージにし、現状どおり再起動まで反映しない項目を区別する。 |
| ゲームロード・AV・実行 | `_retro_load_game`、`_retro_get_system_av_info`、`_retro_run`（`src/libretro-host.ts:743`、`src/libretro-host.ts:780`、`src/libretro-host.ts:844`）と `main.ts` の `loadGame/fetchAvInfo/runFrame`（`src/main.ts:2475`、`src/main.ts:2477`、`src/main.ts:3753`） | load/fetch は request/response、run は Worker 内ループにする。`loadGameNone()` と `unloadGame()`（`src/libretro-host.ts:743`、`src/libretro-host.ts:762`）は現行 `main.ts` から未使用だが proxy API を残すなら非同期化対象。 |
| リセット・破棄 | `_retro_reset`（`src/libretro-host.ts:808`）、`dispose()`（`src/libretro-host.ts:883`）、MCP reset（`src/main.ts:4337`） | reset 完了応答を Promise 化する。現行 UI の通常リセットは Worker 再生成を伴う `restartCore()` なので、保存完了→旧 Worker 終了→新 Worker ready の順序を保証する。 |
| ステート | `_retro_serialize_size/_retro_serialize/_retro_unserialize` と HEAP copy（`src/libretro-host.ts:818`、`src/libretro-host.ts:833`）、UI 呼び出し（`src/main.ts:3996`、`src/main.ts:4013`） | Worker が bytes を transferable で返す/受け取る非同期 RPC にする。ロード完了後の audio flush とフレーム積算リセット（`src/main.ts:4043`）は応答後に行う。 |
| MEMFS | `FS.writeFile/readFile/unlink`（`src/libretro-host.ts:708`）と起動、ダウンロード、FDD交換（`src/main.ts:1239`、`src/main.ts:2453`） | FS は Worker 所有。全量 bytes の request/response はFDD互換用に限定し、HDDは OPFS ID/ストリーム APIへ分ける。 |
| FDD ホットマウント | `_webx68k_fdd_insert/_eject`（`src/libretro-host.ts:790`）、`readLiveSlotImage/hotSwapFdd`（`src/main.ts:1239`、`src/main.ts:1257`） | eject→read/write→insert を1つの Worker コマンドとして直列化し、途中に別の run/交換コマンドを割り込ませない。 |
| アクセス・ダーティ | `_get_fdd_is_reading/_get_fdd_access_drive/_get_sasi_is_accessing`、`_get_fdd_dirty_mask/_get_sasi_dirty/_clear_*`（`src/libretro-host.ts:848`、`src/libretro-host.ts:862`）、UI監視（`src/main.ts:3526`、`src/main.ts:3568`、`src/main.ts:3606`） | `runFrame()` 直後でなければ失われるアクセス値は Worker で採取してイベント化する。dirty の clear→吸い出し順も Worker 側の不可分コマンドにする。 |
| キー・パッド・マウス入力 | host 内 Set/累積値（`src/libretro-host.ts:257`、`src/libretro-host.ts:270`、`src/libretro-host.ts:280`）、`_webx68k_send_key_make`（`src/libretro-host.ts:262`）、DOM/仮想/MCP 呼び出し（`src/main.ts:612`、`src/main.ts:3011`、`src/main.ts:4361`） | メインは入力メッセージを送る。Worker の同期 `input_state` は受信済み状態だけを見る。make-only、全解放、mouse delta の順序保証が必要。 |
| ゲストカーソル・マウス診断 | `_webx68k_peek8/16` と `_get_mouse_*`（`src/libretro-host.ts:388`、`src/libretro-host.ts:418`）、追従/デバッグ（`src/main.ts:2893`、`src/main.ts:3666`） | 追従ロジックは Worker へ寄せるか非同期状態機械に改造する。開発用 debug API も Promise 戻り値へ変える。 |
| SRAM・キーリピート | `_webx68k_sram_read` を8/16KB単位で同期反復（`src/libretro-host.ts:328`、`src/libretro-host.ts:348`）、3秒 autosave（`src/libretro-host.ts:369`）、フレーム内設定監視（`src/main.ts:2424`） | SRAM差分検出を Worker 内で行い、変更 bytes/リピート設定だけメインへ通知して IndexedDB 保存へ渡す。 |
| TVRAMテキスト | TVRAM pointer と表示パラメータ export、HEAPU8 直接参照（`src/text-screen.ts:326`）、`host.readTextScreen()`（`src/libretro-host.ts:241`）、debug/MCP（`src/main.ts:3701`、`src/main.ts:4318`） | 抽出処理を Worker に移し、`TextScreenDump` を非同期に返す。HEAP view や pointer はメインへ公開しない。 |
| 任意メモリ参照 | `_webx68k_peek8/16`（`src/libretro-host.ts:300`）、debug peek と MCP `read_memory`（`src/main.ts:3669`、`src/main.ts:4379`） | 単発/範囲 read RPC にする。現行 MCP は1バイトごと同期 call するため、Worker 側で範囲を一括読みして返す。 |
| 描画・音声 callback | HEAPU16→ImageData（`src/libretro-host.ts:652`）、HEAP16→Float32Array（`src/libretro-host.ts:695`） | callback と HEAP 読みは Worker 内に残し、完成した描画/音声だけを各出力先へ渡す。 |

`_retro_api_version`、`_webx68k_keybuf_peek/_write_pointer`、`_webx68k_joystick_read` は `PX68KModule` に定義されている（`src/libretro-host.ts:81`、`src/libretro-host.ts:110`、`src/libretro-host.ts:121`）が、`src/` の実行時コードからの呼び出しは確認できない。後者2組はコメント上も結合テスト用 export である。Worker proxy の本番 API に露出させる必要があるかは未決。

### 8. その他の阻害要素、テスト、MCP ブリッジ

**現状** — MCP ブリッジの dispatch 自体は Promise を扱える（`src/bridge.ts:124`）が、`BridgeHost` の screenshot、screenText、screenHash、reset、readMemory は同期型である（`src/bridge.ts:11`）。実装も canvas、host、HEAP を同期参照する（`src/main.ts:4316`）。結合テストは Emscripten glue と wasm を同一 Realm へ直接ロードし、Module/FS/export を同期操作する（例: `test/core-keyboard-integration.test.ts:47`）。`LibretroHost` 単体テストは `window.PX68K` と HTMLCanvasElement を差し替える（`test/libretro-host-text-screen.test.ts:8`）。純粋関数テスト（gamepad、FAT、frameBudget 等）はコアスレッドに依存しない。

**ワーカー化での問題** — MCP の同期 host interface と debug console API は非同期化が必要で、既存の外部クライアントが応答を待てるか回帰確認が要る。Worker 内の実コアを対象にするテストは、現在の同一 Realm 前提とは別に worker 起動、ready、メッセージ、OffscreenCanvas、終了処理を扱う必要がある。Vitest の Node worker だけではブラウザの OffscreenCanvas/OPFS 同期ハンドルを十分再現できるか未確認。

**取りうる対応** — `BridgeHost` を全面的に `value | Promise<value>` または Promise に揃え、dispatch で全コマンドを await する。`read_memory` は範囲一括 RPC、screenshot/hash/text は Worker 内生成にする。テストは protocol の単体テスト、fake Worker を使うメイン proxy テスト、実ブラウザでの Worker+OffscreenCanvas+入力結合、実ブラウザでの OPFS 永続化/再起動/異常終了を分ける。既存の実 wasm 結合テストはコア単体回帰として残せるが、Worker 境界の回帰保証にはならない。COOP/COEP を追加する必要は、この調査範囲では見当たらなかった。
