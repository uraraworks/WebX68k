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

## ワーカー境界のAPI設計

### 境界の原則

`LibretroHost` は Worker 内のコア実装と、メイン側の `Promise` ベースの proxy に分ける。Emscripten Module、HEAP、関数ポインタ、FS、`retro_run()` は Worker から公開しない。proxy は `loadGame()`、`fetchAvInfo()`、`serialize()`、`readTextScreen()` など現行 API に近い名前と引数を保ち、内部で下記メッセージへ変換する。これにより呼び出し側をカテゴリ単位で段階移行できる。

駆動ループ、フレーム予算計算、可変 fps の反映は Worker が所有する。メインの rAF や AudioWorklet tick はフレーム実行要求にせず、入力状態、速度設定、音声キューのサンプル数などの状態更新だけを送る。Worker は自分のスケジューラで複数フレームを進められ、タブ非表示時にも rAF に依存しない。Worker 内スケジューラの実装にタイマーを使うこと自体は避けられないが、境界上の時系列識別子は起動後の累積 `frameNo` だけとし、壁時計の timestamp や別系統の連番を観測イベントへ付けない。UI のアクセス残光、定期処理、実測速度も `frameNo` とそのフレームの fps から扱う。

各 `retro_run()` の直後、次のフレームを実行する前に、そのフレームの映像・音声と観測値を一度だけ採取し、同じ `frame` イベントへ束ねる。特にアクセスフラグは次の `retro_run()` 冒頭で消えるため、後から query する API は設けない。個別バッファへ frame 番号を付けて突き合わせる方式も採らない。

### メッセージの分類と型の骨格

メインから Worker へ送るものを command、command の成否を返すものを response、Worker が自発的に通知するものを event とする。command は同一 Worker 内で受信順に処理し、コアへ触る command はフレーム境界の safe point で実行する。`generation` は Worker 再生成ごとに増やし、`requestId` はその世代内の応答照合だけに使う。時系列の基準ではない。

```ts
type Generation = number;
type RequestId = number;
type FrameNo = number; // 起動後に完了した retro_run() の累積数。唯一の時刻基準

type MainToWorker = CoreCommand;
type WorkerToMain = CoreResponse | CoreEvent;

type CoreCommand =
  | { kind: 'command'; generation: Generation; requestId: RequestId;
      op: 'initialize'; payload: InitPayload }
  | { kind: 'command'; generation: Generation; requestId: RequestId;
      op: 'loadGame'; payload: { path?: string } }
  | { kind: 'command'; generation: Generation; requestId: RequestId;
      op: 'setRunning'; payload: { running: boolean } }
  | { kind: 'command'; generation: Generation; requestId: RequestId;
      op: 'updateInput'; payload: InputUpdate }
  | { kind: 'command'; generation: Generation; requestId: RequestId;
      op: 'hotSwapFdd'; payload: HotSwapFddPayload }
  | { kind: 'command'; generation: Generation; requestId: RequestId;
      op: 'serialize' | 'readTextScreen' | 'screenshot'; payload: {} }
  | { kind: 'command'; generation: Generation; requestId: RequestId;
      op: 'readMemory'; payload: { address: number; length: number } };

type CoreResponse =
  | { kind: 'response'; generation: Generation; requestId: RequestId;
      ok: true; completedFrameNo: FrameNo; result: unknown }
  | { kind: 'response'; generation: Generation; requestId: RequestId;
      ok: false; completedFrameNo?: FrameNo; error: CoreError };

type CoreEvent =
  | { kind: 'event'; generation: Generation; event: 'ready'; avInfo: AvInfo }
  | { kind: 'event'; generation: Generation; event: 'frame'; snapshot: FrameSnapshot }
  | { kind: 'event'; generation: Generation; event: 'sramChanged';
      frameNo: FrameNo; bytes: ArrayBuffer; keyRepeat?: KeyRepeatConfig }
  | { kind: 'event'; generation: Generation; event: 'fatal'; error: CoreError };

interface CoreError {
  code: 'INVALID_STATE' | 'INVALID_ARGUMENT' | 'LOAD_FAILED' |
        'IO_FAILED' | 'UNSUPPORTED' | 'CORE_FAILURE' | 'WORKER_FAILURE';
  message: string;
  operation?: string;
  recoverable: boolean;
  details?: unknown; // structured-clone 可能な診断情報だけ
}
```

`initialize` は BIOS、CGROM、SRAM、起動時オプション、初期ディスク参照と OffscreenCanvas（採用する場合）を受け取る。大きな `ArrayBuffer` と canvas は transfer list で渡す。`ready` は初期化とコールバック登録の完了を表し、`loadGame` の応答とは分ける。`dispose` は正常終了の応答を待つ command とするが、最終的な `Worker.terminate()` はメインが行う。

proxy の公開形状は、例えば次のように同期戻り値だけを `Promise` に置き換える。

```ts
interface LibretroHostProxy {
  init(payload: InitPayload): Promise<void>;
  setCoreOption(key: string, value: string): Promise<void>;
  loadGame(path: string): Promise<boolean>;
  fetchAvInfo(): Promise<AvInfo>;
  serialize(): Promise<ArrayBuffer | null>;
  unserialize(bytes: ArrayBuffer): Promise<boolean>;
  readTextScreen(): Promise<TextScreenDump>;
  readMemory(address: number, length: number): Promise<ArrayBuffer>;
  hotSwapFdd(payload: HotSwapFddPayload): Promise<HotSwapFddResult>;
  dispose(): Promise<void>;
}
```

### フレームスナップショット

```ts
interface FrameSnapshot {
  frameNo: FrameNo;
  av: {
    fps: number;
    sampleRate: number;
    width: number;
    height: number;
  };
  video:
    | { kind: 'offscreen'; changed: boolean }
    | { kind: 'bitmap'; bitmap: ImageBitmap }
    | { kind: 'rgba'; bytes: ArrayBuffer; width: number; height: number };
  audio: {
    chunks: ArrayBuffer[]; // Float32、stereo interleaved
    sampleFrames: number;
  };
  disk: {
    access: { fddReading: boolean; fddDrive: number; hddAccessing: boolean };
    dirty: { fddMask: number; hdd: boolean };
  };
}
```

`frameNo`、そのフレームで有効だった fps/sample rate/解像度、完成映像、生成音声、アクセス状態、フレーム完了時点のダーティ状態を同梱する。AV 値は変更時だけ別イベントにせず毎回含め、スナップショット単体でそのフレームを解釈できるようにする。解像度変更時の DOM/CSS `rescale()` もこのスナップショットを契機にする。SRAM 全量、TVRAM テキスト、任意メモリ、マウス診断はフレーム結果の常時表示に必要なくサイズまたは抽出コストもあるため含めない。SRAM は Worker 内で差分検出し、変更時だけ `sramChanged` を送る。閉ループのマウス追従は Worker 内で完結させ、診断値は明示 query にする。

OffscreenCanvas へ Worker が直接描画する構成では、`video.kind === 'offscreen'` がそのフレームの描画完了を表す。描画をメインへ渡す構成では `ImageBitmap` または RGBA の `ArrayBuffer` を同じイベントの transfer list に入れる。音声チャンクも同じ transfer list に入れ、メインは受け取った buffer をコピーせず AudioWorklet へ再 transfer する。音声だけを別 channel に分けるとフレーム結果との一体性が失われるため採用しない。セーブステート、ディスクイメージ、メモリ範囲、スクリーンショット Blob/bytes も同様に transferable とし、送信側が detach 後の配列を再利用しない所有権規約にする。

イベントがメインの処理速度を上回る場合でも、観測値だけを別送・間引きしてはならない。描画済みの古い `frame` イベント全体を捨てられるか、音声を失わずに背圧をかける方法は、映像経路と音声経路の選択に依存するため未決とする。

### command と不可分操作

通常 command はフレーム間で一件ずつ処理する。不可分操作は自由な primitive 配列を送る汎用 transaction にはせず、順序と失敗時の意味を固定した専用 command とする。handler の開始から終了までは駆動ループと他 command を進めない。

```ts
interface HotSwapFddPayload {
  drive: 0 | 1;
  image: null | { name: string; bytes: ArrayBuffer };
}

interface HotSwapFddResult {
  previousImage: ArrayBuffer | null;
  mountedPath: string | null;
}

// Worker 内の一つの handler で次を完了する。
// 交換: eject旧 → 旧イメージ読出し → 新イメージwrite → insert新
// 排出: eject旧 → 旧イメージ読出し → 不要ファイルunlink
type AtomicCommand =
  | { op: 'hotSwapFdd'; payload: HotSwapFddPayload }
  | { op: 'exportLiveMedia'; payload: { slot: 'fdd0' | 'fdd1' | 'hdd' } }
  | { op: 'captureDirtyMedia'; payload: { slots: Array<'fdd0' | 'fdd1' | 'hdd'> } }
  | { op: 'finishDirtyCapture'; payload: { token: string; persisted: boolean } }
  | { op: 'flushAndClose'; payload: {} };
```

`exportLiveMedia` の FDD 処理は eject→read→同じ path を再insert までを一つにする。`captureDirtyMedia` は対象の dirty clear を吸い出し直前に行い、FDD なら eject→read→reinsert まで進め、bytes と token を返す。メインが IndexedDB 保存に成功した後で `finishDirtyCapture(persisted: true)`、失敗時は `persisted: false` を返し、失敗時は Worker が対象を再度 dirty にする。capture 後に発生した新しい書き込みの dirty は消さない。これにより Worker 内の順序は不可分にしつつ、境界外の永続化失敗も次回保存対象として残せる。token の具体的な保持期間と、応答前に Worker が異常終了した場合の回収方法は未決である。

`flushAndClose` は駆動停止→全 dirty media の回収→SRAM 回収→FS/OPFS の flush/close を一つの終了シーケンスとして行い、回収データを transferable で返す。メイン側の永続化完了は Worker 内だけでは保証できないため、正常な再起動は回収データを保存し終えてから旧 Worker を終了する。

### メッセージ一覧と同期呼び出しの対応

| 「7.」の用途 | command / response / event | 境界での扱い |
|---|---|---|
| 初期化・コールバック | `initialize` → response、`ready` event、`dispose` → response | malloc、callback 登録、`retro_init` は Worker 内だけ。ready/disposed のみ公開する。 |
| コアオプション | `setCoreOption` → response、または `initialize.options` | Map と文字列 pointer は Worker 所有。再起動時反映の項目は proxy 側で区別する。 |
| ゲームロード・AV・実行 | `loadGame` / `loadGameNone` / `unloadGame` / `fetchAvInfo` → response、`setRunning` → response、`frame` event | `runFrame` RPC は作らず、Worker 内ループだけが `retro_run()` を呼ぶ。 |
| リセット・破棄 | `flushAndClose` / `dispose` → response、再生成後の `ready` event | 通常 UI reset はメイン側の再生成手順。コアだけの soft reset を残す場合は別 command とする。 |
| ステート | `serialize` / `unserialize` → response | bytes は transferable。unserialize 中は駆動を止め、成功応答後に音声 flush と基準状態を更新する。 |
| MEMFS | `writeFile` / `readFile` / `removeFile` → response | 互換用の限定 API。FDD 全量 bytes は transferable、HDD は OPFS ID/stream APIへ分離する。 |
| FDD ホットマウント | `hotSwapFdd` → response | eject→旧内容回収→write→insert を専用不可分 command にする。 |
| アクセス・ダーティ | `frame.snapshot.disk` event、`captureDirtyMedia` / `finishDirtyCapture` → response | アクセス/dirty の pull API は廃止。clear と吸い出しは不可分にする。 |
| キー・パッド・マウス入力 | `updateInput`、`sendKeyMake`、`clearInput` → response | Worker は受信済み状態を同期参照。key/button は状態、mouse delta は加算値と入力世代で表し、clear より古い更新を捨てる。 |
| ゲストカーソル・マウス診断 | `setMouseTrackingTarget` → response、`readMouseDiagnostics` → response | 閉ループ追従は Worker 内。診断 API は Promise とし、駆動には使わない。 |
| SRAM・キーリピート | `sramChanged` event、必要なら `readSram` → response | 差分検出は Worker 内。変更 bytes と repeat 設定を通知し、bytes は transferable。 |
| TVRAMテキスト | `readTextScreen` → response | 抽出も Worker 内。HEAP view/pointer は返さない。 |
| 任意メモリ参照 | `readMemory` → response | 1 byte RPC を繰り返さず、範囲を一括して transferable で返す。 |
| 描画・音声 callback | `frame.snapshot.video/audio` event、`screenshot` / `screenHash` → response | HEAP 読みと変換は Worker 内。完成データだけを渡す。 |

入力 command の `requestId` は ACK 用であり時刻には使わない。`InputUpdate` にはキー集合、2 port の解決済み pad bitmask、mouse button、加算 delta と `inputGeneration` を含める。blur/visibility の `clearInput` は `inputGeneration` を進め、Worker は古い世代の入力を無視する。同じ世代の mouse delta は受信順に加算し、押下状態は最新値で置換する。ゲームパッドを何を契機にメインで poll するかは後述の未決事項とする。

### エラー、異常終了、再生成

command の予期される失敗は `ok: false` response とし、proxy は `CoreError` を保持した例外へ変換する。command handler 内の例外でコア状態の継続可否を保証できない場合は、失敗 response に加えて `fatal` event を送り、その Worker は新しい command を受け付けない。`messageerror`、Worker の `error`、応答 timeout、突然の終了はメインが `WORKER_FAILURE` として扱い、その世代の未完了 Promise をすべて reject する。

メインは生成ごとに単調増加する `generation` を割り当て、現在世代と異なる response/event を無視する。正常な UI reset は次の順序に固定する。

1. 新規 UI 操作の受付を止め、旧 Worker に `setRunning(false)` を送る。
2. `flushAndClose` の回収データを受け取り、IndexedDB 等への保存完了を await する。
3. `dispose` の完了を待って旧 Worker を terminate する。
4. `generation` を増やして Worker を生成し、永続化済み BIOS/SRAM/ディスクと設定で初期化する。
5. `ready` と `loadGame` 成功後に入力をクリアし、UI 操作と駆動を再開する。

異常終了時は旧 Worker 内だけにあった未永続化データを回収できるとはみなさない。最後に永続化に成功した SRAM/ディスク、メインが保持する設定とマウントメタデータから新 Worker を作り直し、データ損失の可能性を UI へ通知する。自動再生成の回数制限と backoff、異常終了後に自動で実行再開するかは未決である。

### 段階移行の順序

1. **protocol と非同期 proxy の導入** — generation、request/response、エラー、transferable 所有権を先に固定する。既存 `LibretroHost` 実装を当面 proxy と同じ interface に合わせ、呼び出し側の Promise 化を始められるようにする。
2. **観測・診断系 query** — 任意メモリ、TVRAM、screen hash/screenshot、マウス診断を範囲 RPC/非同期 API にする。駆動や永続化を変えず、MCP dispatch が既に Promise を扱えるため境界の検証に向く。
3. **ステートと単純な FS 転送** — serialize/unserialize、互換用 read/write を transferable 化する。大容量データの所有権とエラー処理をここで確立する。
4. **初期化、オプション、load/AV** — Module、callback、HEAP、FS を Worker 内へ閉じ、ready/load 応答までを移す。以後のカテゴリは Worker 内コアを前提とする。
5. **描画・音声出力** — video/audio callback と変換を Worker へ移し、`frame` の完成データ経路を作る。OffscreenCanvas と音声転送の実機確認を行う。
6. **入力** — メインで DOM/Gamepad を正規化し、Worker の `input_state` が受信済みスナップショットだけを見るようにする。世代付き clear と加算 mouse delta を先に検証し、その後に閉ループ追従を Worker へ移す。
7. **Worker 駆動ループとフレームスナップショット** — `retro_run()`、予算計算、可変 fps、フレーム番号を Worker 所有にし、アクセス/dirty/AV/映像/音声を一イベントへ統合する。ここでメインの `runFrame()` と rAF 駆動を廃止する。
8. **FDD/MEMFS の不可分操作とオートセーブ** — hot swap、live export、dirty capture、終了 flush を専用 command に置き換える。永続化失敗時の再 dirty 化まで確認してから再起動経路を切り替える。
9. **再生成と異常系** — 正常 reset の保存→終了→ready、および crash、timeout、旧世代遅延応答を検証する。最後に同期 host と旧スケジューラを除去する。

順序上、Worker 内コアが必要な初期化より前に query の実処理を Worker へ移す必要はない。手順2・3では同じ非同期 proxy interface を同一スレッド adapter で先行導入し、呼び出し側を安全に変更してから実体を Worker に差し替える。

### 未決事項

- Worker の内部スケジューラを `setTimeout` のみで構成するか、音声キューの sample frame 数をどの頻度でフィードバックするかは、非表示タブ、iOS、ヘッドレスでの実測がないため未決。メインから一フレームずつ駆動しないことと、境界の時刻を `frameNo` に統一することは固定する。
- OffscreenCanvas へ直接描画するか、各フレームの `ImageBitmap`/RGBA を転送するかは未決。前者では screenshot、hash、Worker 再生成時の canvas 再移譲を対象ブラウザで検証する必要がある。後者では帯域と背圧を測る必要がある。
- `frame` event の安全な間引き・背圧方式は未決。アクセス値を失わず、音声の連続性を保ち、別バッファとの事後照合を導入しない方式を実測して決める必要がある。
- ゲームパッドを独立タイマーで poll するか、受信した `frame` event を契機に poll するかは未決。Worker 内の `input_poll` からメインへ同期問い合わせはしない。
- HDD の OPFS ID/stream API、既存 IndexedDB からの移行、FDD 全量イメージのメイン側保持方針はストレージ方式の決定に依存するため未決。
- `_retro_deinit` を正常終了で呼ぶべきか、現在未使用の `loadGameNone()` / `unloadGame()` とテスト用 export を本番 proxy に残すかは、現行の意図と外部利用が確認できないため未決。
- save state load 後に累積 `frameNo` を 0 へ戻すと世代内で番号が重複するため、本設計では単調増加を維持する。セーブデータ内のゲスト時刻と host の `frameNo` の関係を外部へ見せる必要があるかは未決。

## 移行前の基準値：計測計画

この節は計測の実施結果ではなく、Worker 移行前に何をどの条件で測り、移行後に何と比較するかを定める計画である。目的Aの回帰判定と目的Bの設計判断は、同じ採取データを参照する場合でも結果表と判定を分ける。

### 共通条件と記録形式

- 基準構成は CPU 16MHz、RAM 2MB、速度倍率100%、同梱 IPL-ROM/CGROM と `human302.xdf` を使う。FDD1 と HDD0 には後述の識別用ファイルを入れた固定イメージを用意し、全イメージ、ROM、wasm、JavaScript の SHA-256 を結果に記録する。HDD は現行上限の40MBとする。
- ブラウザ、OS、端末、CPU、メモリ、電源接続・省電力設定、表示リフレッシュレート、viewport、devicePixelRatio、音声出力機器、AudioContext の `sampleRate` を記録する。`baseLatency` / `outputLatency` は取得できたブラウザだけ記録し、取得不能を0として扱わない。
- 原則として拡張機能なしの専用プロファイル、タブ前面、ウィンドウ非遮蔽、表示倍率100%で行う。キャッシュ、IndexedDB、SRAM の状態は「初回（空プロファイル）」と「ウォーム（固定スナップショット復元）」を区別する。起動時間の主基準は空プロファイル、定常性能の主基準はウォーム状態とする。
- 画面モードは起動直後から Human68k のプロンプトまでの実際の width/height/fps 遷移を記録し、固定解像度だったと仮定しない。描画の比較用シナリオは、Human68k プロンプト、ディスク全量列挙、15kHz/31kHz 切替を含む固定操作列とする。切替用コマンドまたはディスクの準備可否は現時点で未確認である。
- 時間は同一 Realm の `performance.now()` で測り、壁時計を差分計算に使わない。生サンプルを JSON/CSV で保存し、時刻、構成、試行番号、成功/失敗理由を残す。起動・I/Oは各条件20回、キーと音声の刺激は各30回、定常フレームは各条件5分以上を目安とする。
- 時間値を単一の平均や閾値へ潰さず、少なくとも標本数、失敗数、最小、中央値、p90、p95、p99、最大、MADを持つ。帯域は bytes/frame と MiB/s、処理量は frames/s も持つ。まず移行前に日を分けたA/A計測を2組行い、その差の95%範囲を測定系の反復誤差とする。移行後は同じ生データを採り、機能失敗が0であり、中央値・p95・p99の差がA/A反復誤差内に収まり、新しい長い裾や外れ値群が現れていないことを「回帰なし」の形とする。差が実用上無視できる幅を別途定める場合も、A/A結果を見てから決め、先に恣意的な単一閾値を置かない。
- 各本計測の前に、表の「測定系の検証方法」を実行して異常を検出できることを確認する。故障注入はコピーした測定用イメージ、専用ブラウザプロファイル、または本番へ含めない測定ビルドだけで行う。故障注入で値が変わらない測定は採用しない。

### 目的A：回帰の基準値

| 項目 | 測るもの | 測る場所 | 手段と既存資産 | 合格判定 | 測定系の検証方法 |
| --- | --- | --- | --- | --- | --- |
| Human68k 起動 | 起動ボタンの実ユーザー活性化から、起動完了マーカーがTVRAMに連続3回現れるまでの時間(ms)。成功率、画面 width/height/fps の遷移も記録する。 | 始点はボタンの `click` handler 冒頭、終点はコア生成や非黒画素ではなく `readTextScreen()` が読むTVRAM。起動完了文字列は予備確認で固定する。過去に `B>` 等を取得した記録はあるが、現行ビルドで安定する文字列は未確認。 | `screen_text`、ページ内 `__webx68kBridge.exec()`、ヘッドフル Puppeteer の既存撮影スクリプトを流用できる。ただし現行スクリプトは20秒固定待ちと非黒画素判定だけなので、タイムスタンプ採取、プロンプト安定判定、反復、結果保存は新規測定コードが要る。 | 移行前後で起動成功20/20。完了時間の中央値・p95・p99と分布を共通基準で比較し、A/A反復誤差を越える悪化や新しいタイムアウト群がないこと。 | FDD0を空にした試行と、コピーしたシステムディスクの起動領域を壊した試行を1回ずつ行う。非黒画素は出ても完了マーカーが出ずタイムアウトになることを確認する。 |
| 3ドライブ認識 | Human68k 自身が FDD0、FDD1、HDD0 の各ボリュームを読めた試行数/総数と、各 `DIR` 入力から固有マーカーファイル名がTVRAMへ現れるまでの時間(ms)。 | `list_disks` のホスト側スロット表示ではなく、Human68k のコマンド実行結果が描かれたTVRAM。各媒体に `FDD0.OK`、`FDD1.OK`、`HDD0.OK` のような重複しないファイルを置く。実際のドライブレター割当は予備確認で記録し、未確認のままA/B/Cと断定しない。 | MCP の `type_text` / `screen_text` と FAT の既存読み書き機能は利用できる。3媒体を入れた実ブラウザの反復実行、マーカー入り固定fixture作成、画面出力の照合は新規測定スクリプトが要る。`fat-hdd` テストは構造検証、`core-fdd-hotswap` はコア内順序検証であり、ゲストの3台認識の代用にはならない。 | 全試行で3つの固有マーカーを正しい媒体から取得でき、誤認・欠落が0。応答時間はドライブ別の分布を移行前後で比較し、A/A反復誤差外の悪化がないこと。 | FDD1を排出した状態、HDDのコピーでパーティション名を変えた状態、FDD0/FDD1のマーカーを意図的に入れ替えた状態を実行する。欠落だけでなく取り違えも検出できることを確認する。 |
| キー入力の末端到達 | 押下/解放ごとの期待スキャンコード一致率、KeyBuf書込位置の増分、入力開始からKeyBuf到達およびTVRAMエコーバックまでの時間(ms)、欠落・重複・押しっぱなし件数。 | 自動のコア単体経路は wasm 内 `KeyBuf`。Worker境界を含むアプリ経路は Human68k が入力を消費した後のTVRAM。DOMや `SharedKeyInput`、`setKey()` の値だけでは合格にしない。 | `core-keyboard-integration` と `core-key-repeat-integration` は実ROM+KeyBuf末端まで既存のまま使えるが、Nodeから直接 `input_state` を与えるためブラウザ経路の証明ではない。MCP `type_text`/`key_sequence`→`screen_text` は既存資産でTVRAMまで通せる。ブラウザ経路からKeyBufを読むAPIは無く、新規測定コードが必要。物理キー→TVRAMは手動で行う。 | KeyBufの期待列とTVRAMの固定文字列が全試行で完全一致し、欠落・重複・残留押下が0。到達時間はMCP経路と物理経路を混ぜず、各々の中央値・p95・p99を移行前後で比較する。 | 測定専用ビルドで1キーのmakeを捨てる、別スキャンコードへ置換する、breakを1回捨てる、の3故障を注入し、それぞれ欠落、誤字、残留押下として検出する。KeyBufテストでは期待値を故意に1つ変えて失敗することも確認する。 |
| 音声遅延 | (1) AudioWorkletが報告する待ちキュー時間(ms)の時系列と分布、underflow/上限超過・破棄回数、(2) ゲスト側の音発生操作から物理音声出力までの端点間遅延(ms)と欠音回数。 | (1) は音声の送り側ではなくAudioWorklet内の未再生キュー末尾、(2) はスピーカー/ヘッドホン出力をオーディオインターフェースまたはマイクで録音した波形。`audioPush()` 呼出時刻だけでは測らない。 | 開発用 `__webx68kDebug.stat().queuedSec` は(1)に使えるが、時系列保存とunderflow/drop計数は新規測定コードが要る。(2)は、同一録音へキー操作の電気的/音響的基準音とゲスト音を入れるループバック測定を手動で行う。固定操作で確実に音を出すゲスト側fixtureの有無は未確認で、無ければ測定用ディスクが要る。 | 内部キューと物理出力を別結果として保持する。欠音0を必須とし、端点間遅延とqueuedSecそれぞれの中央値・p95・p99・最大・時系列ドリフトが移行後もA/A反復誤差内で、新しい周期的スパイクがないこと。 | 測定経路へ既知の200ms遅延を加えて分布が約200ms移動すること、1チャンクを捨てて欠音カウンタと録音波形の双方が検出すること、出力をミュートして物理測定が成功扱いにならないことを確認する。 |

キー入力は最低でも次の2本を別々に残す。MCP経路は自動化しやすいがDOM `KeyboardEvent.code` を通らないため、「MCPで通った」ことを物理キーボードの保証にしない。物理キーボードでは固定文字列を実際に打ち、TVRAMのエコー、Shift付き記号、押下/解放、長押し後の停止を人が確認する。

### 目的B：未決事項を決めるための材料

| 項目 | 測るもの | 測る場所 | 手段と既存資産 | 判断に使う形 | 測定系の検証方法 |
| --- | --- | --- | --- | --- | --- |
| フレーム時間の分布 | `retro_run()`完了間隔、video callbackのRGB565変換時間、`putImageData()`復帰までの時間、前面タブのrAF観測間隔(ms)、long task件数/秒。解像度・fps・dupe frame有無ごとに分ける。 | コア呼出開始だけでなく、現行経路の末端であるcanvas更新処理の復帰点と、メイン側が次に観測できるrAF。実表示時刻を取得できないブラウザでは「canvas更新完了まで」と明記し、物理表示済みと称さない。 | 現行APIに継続採取機能は無いため、`loop()` と `handleVideoRefresh()` に本番へ残さない計測点を置く新規測定コードが要る。ヘッドフル Puppeteer の操作骨格は流用可能。実表示の光学測定は必要時のみ人手。 | 解像度別の中央値・p95・p99・最大、フレーム予算超過率、GC/long taskとの相関を出す。Offscreen直描画と転送試作でも同じ指標を採り、平均だけでなく裾、CPU時間、主スレッド占有が小さい経路を選ぶ。 | 60フレームごとに50msのbusy waitを測定専用コードで入れ、rAF間隔、canvas末端時間、long task、予算超過率のすべてに裾が現れることを確認する。 |
| フレームバッファ帯域と転送コスト | 実フレームの width×height、RGB565入力bytes、RGBA転送bytes、ImageBitmap/RGBAの生成・`postMessage`・受信・canvas反映までの時間(ms)、MiB/s、転送後の割当量、GC回数。 | Worker候補の送信直前だけでなく、メインが受信しcanvasへ反映し終えた地点。Offscreen候補はWorker内描画完了と、解像度通知後にDOM側リスケールが終わった地点を取る。 | 現行 `FrameSnapshot` は設計だけで未実装のため、実寸の合成バッファを使うWorkerベンチと、後の最小描画スパイクが新規に必要。既存 `screenshot`/`screenHash` は結果の同一性確認に流用できる。対応ブラウザでの `ImageBitmap` transfer可否は未確認。 | 実シナリオの解像度分布から毎秒必要帯域を算出し、RGBA、ImageBitmap、Offscreenを同一端末で比較する。p95受信・描画時間、主スレッド占有、割当/GC、画素hash一致を表にし、フレーム予算内に安定して収まるかで描画経路を選ぶ。 | 解像度を縦横2倍にした合成入力でRGBA bytesが4倍になること、連番とCRCを1枚だけ壊して受信側が検出すること、transfer listを外した比較でコピーコスト増を観測できることを確認する。 |
| `frame` event の背圧 | 生成frameNoと消費完了frameNoの差、in-flight/queue深さ、event滞留時間(ms)、映像欠落数、音声sampleFrames欠落/重複、AudioWorkletのunderflow、FDD/HDDアクセスパルス欠落、メイン入力処理遅延(ms)。 | Workerの送信数だけでなく、メインのイベント処理完了、AudioWorklet消費、canvas反映、UIアクセス状態までの各末端。アクセス値・音声・映像は同じ試行のframeNoで検査する。 | 現行にはWorkerも`frame` eventも無いため、新規のproducer/consumer試験器と、ACK式1件、上限付きqueue、映像のみ安全に置換し観測値と音声を次イベントへ畳み込む案などの比較試作が要る。既存 `frameBudget` テストは予算計算だけで背圧の保証にはならない。 | 通常負荷に加え、16/50/100/500msのメインスレッド停止を注入した分布を出す。無制限queue、音声欠落、アクセスパルス欠落は不採用。回復時間、最大メモリ、入力p95を比較し、フレーム単位の整合性を壊さず有限時間で定常へ戻る方式を選ぶ。 | 特定frameだけアクセス=true、別frameだけ既知音声パターンにし、そのeventを故意に遅延・重複・欠落させる。連番、音声サンプル総数、末端アクセス履歴のいずれかが必ず異常を報告することを確認する。 |
| IndexedDBへのディスク全量書出し | 40MBイメージの吸出し開始からbytes確定まで、`put()`開始からtransaction `complete`まで、全体時間(ms)、実効MiB/s、同時期の最大rAF gap/long task。初回追加と同一key上書きを分ける。 | イメージ読出し呼出時ではなく、MEMFSから末尾まで取得・検査できた地点と、IndexedDB transactionの`complete`。UIへ保存要求を出した時点を完了にしない。 | `putDisk()`は既に`tx.oncomplete`をawaitするので終点として使えるが時刻・サイズ・フレーム影響を記録しない。`readLiveSlotImage()`からcommitまでを関連付ける新規測定コードが要る。Nodeの`disk-store`テストはfake IndexedDB相当ではなく、実ブラウザ性能の代用にならない。 | 初回/上書き別の中央値・p95・p99・最大、MiB/s、UI停止分布を得る。保存中にframe eventを止める必要がある長さ、Worker終了前flushのtimeout設計、全量保存を残せるかの材料にする。 | transactionを意図的に`abort()`する試行、quota不足の専用プロファイル、末尾1byteを変えたイメージを用意し、未完了を成功扱いせず、再読込checksum不一致と保存失敗を検出することを確認する。 |
| 起動時のRAM展開 | IndexedDB `get`要求から全bytes取得まで、`Uint8Array`準備からMEMFS `writeFile`完了・サイズ/末尾checksum確認まで、ROM/FDD/HDD別時間(ms)、総起動時間に占める割合、可能なブラウザではpeak JS/Wasm memory(MiB)。 | `getDisk()`のrequest発行側ではなく結果bytesの検査完了、さらにコアが使うMEMFSファイルをread/statして末尾まで一致した地点。`slots[].data`へ代入しただけでは終点にしない。 | 現行コードは全量経路を持つが区間計測を公開していないため、新規測定コードが要る。ブラウザの精密なヒープ計測APIの可否は未確認で、取れなければ時刻と既知バッファサイズだけを記録する。 | 1.23MB FDDと40MB HDDを分け、中央値・p95・p99、ms/MiB、同時存在する全量コピー数を出す。OPFS化で削減できる起動時間とRAM量、初期化protocolのtimeoutを決める材料にし、目的Aの起動完了時間とは混ぜない。 | 測定専用コードでMEMFS書込みを省略した試行、末尾を切った試行、同サイズだがchecksumが異なる試行を作り、サイズ/末尾/checksum検査がそれぞれ失敗することを確認する。 |
| 非表示・ヘッドレス・iOSでの駆動 | 完了frame数/秒、最長無進行時間(ms)、音声queue/underflow、復帰までの時間(ms)。前面、背景、画面ロック復帰、ヘッドレスを分ける。 | rAF発火数ではなく、`retro_run()`完了後の単調frame counterとAudioWorklet消費末端。 | 現行はframe counterを外へ出していないため新規測定コードが要る。ヘッドレスでrAFが抑制され黒画面になる既知事例がある。iOS WebKitは実機手動、MCPの公開https接続はSafariで使えないためlocalhostまたは画面記録を使う。 | Worker内部時計と音声queueフィードバック頻度を決める補助材料にする。各状態の分布と停止時間を並べ、前面結果と混ぜない。背景で動作継続を製品要件にするかは、この結果と消費電力を見て別途決める。 | 前面状態でrAF callbackを測定専用に無効化しtimer/音声tickだけの進行を検出できること、逆に全駆動源を止めたときframe counter停止を検出することを確認する。 |
| Offscreen固有機能の成立性 | screenshot/hashの成功率と時間(ms)、動的解像度通知からDOMリスケール完了まで(ms)、Worker再生成後の再表示成功率、画素hash一致率。 | Worker内`convertToBlob()`/hash完了、メイン側Blob受信・DOM寸法反映・再生成後canvas表示という各末端。 | 現行 `screenshot`/`screenHash` の期待結果は再利用できるが、Offscreen経路は未実装なので比較スパイクが必要。Chrome/Firefox/Safari/iOS実機の再移譲可否とサイズ属性反映は未確認。 | 性能が良くても対象ブラウザで screenshot、hash、解像度変更、再生成のいずれかが安定しなければ直描画案をそのまま採用しない。成功率と時間分布をブラウザ別に表にする。 | 解像度通知を1回捨てる、古いgenerationの通知を遅延到着させる、再生成時に旧canvas参照を使う故障を注入し、寸法不一致・世代不一致・hash不一致を検出することを確認する。 |

描画経路は「転送bytesの理論値」だけでは決めない。実解像度の出現割合、変換・転送・受信描画のp95/p99、GC、スクリーンショット等の成立性まで揃えて比較する。背圧方式もqueue長だけでは決めず、音声sampleFramesとアクセスパルスを失わず、入力応答を悪化させずに負荷停止後へ収束できることを条件にする。

### 自動化できない範囲

- ヘッドレス Chromium ではrAFが抑制され、既存撮影スクリプトでも画面が黒いままになることが確認されている。起動、描画、frame分布の基準はヘッドフルでタブを前面へ出して採る。ヘッドレスは別条件の耐性試験であり、通常基準の代用にしない。
- MCP/Bridgeのキー注入はDOM `KeyboardEvent.code` を通らない。合成イベントは`code`が空になる場合もあるため、物理キー、Shift付き記号、長押し、blur/visibility後の解放は実キーボードでHuman68kのTVRAMを見て確認する。自動結果と手動結果を別欄に署名・日時付きで残す。
- スピーカーまでの音声遅延、欠音、クリックノイズはWeb Audio内部値だけでは証明できない。固定した出力機器と音量でループバックまたはマイク録音し、人が波形と聴感を確認する。内部queuedSecは補助値であり代替ではない。
- iOSの画面ロック、バックグラウンド復帰、マナーモード、実スピーカー、OffscreenCanvas/OPFSは実機Safariで確認する。公開httpsページからlocalhost MCPへ接続できない制約があるため、ローカル配信、Safari Web Inspector、画面・音声録画を使う。自動化できなかった操作は手順、時刻、端末、観測結果をチェックシートへ残す。

### 実行順序と所要見込み

| 順序 | 作業 | 所要見込み |
| ---: | --- | ---: |
| 1 | 測定対象ビルド、ROM/ディスクfixture、ブラウザプロファイル、端末条件を固定し、hashとチェックシートを作る。Human68kの起動完了文字列、3ドライブの実際の割当、音を出す固定操作を予備確認する。 | 0.5〜1日 |
| 2 | 新規測定コードと結果保存形式を用意し、全項目の故障注入を先に通す。検出できない計測点は修正する。 | 2〜4日 |
| 3 | 目的Aの自動部分（起動、3ドライブ、MCP→TVRAM、内部音声queue）を基準端末で反復採取する。 | 0.5〜1日 |
| 4 | 物理キーボード、物理音声出力、iOS実機の手動計測を行う。 | 0.5〜1.5日 |
| 5 | 目的Bの現行フレーム、帯域、IndexedDB、RAM展開を採取する。 | 1〜2日 |
| 6 | 描画候補と背圧候補の最小スパイクを同じシナリオで比較し、背景・stall条件を加える。 | 2〜4日 |
| 7 | 別日にA/A再測定し、反復誤差、欠測、外れ値を確認して移行前基準を凍結する。 | 0.5〜1日 |

全体は測定用コードと比較スパイクの作成を含めて約1〜2週間を見込む。今回の作業範囲はこの計画の確定までであり、上記の計測、fixture作成、故障注入、比較スパイクの実装は行わない。

## 予備確認の結果（実測）

### 確認できた事実

確認には WebX68k dev server（Vite、port 5299）を Claude Code の Browser ペインで開き、「システムディスクで起動」ボタンを実クリックした。同梱の `public/system/human302.xdf` を FDD0 に挿入した既定構成で、FDD1 と HDD は未挿入とした。確認には `window.__webx68kDebug` を使用した。`__webx68kBridge` は存在せず、`hasBridge` は `false` だった。

1. Human68k version 3.02 の起動に成功し、TVRAM 最終行にプロンプトが表示された。
2. プロンプトは `A>` であり、FDD0 が A: ドライブ、起動ディスクが FDD0 であることを確認した。
3. TVRAM の該当行を180ms間隔で6回サンプリングした結果、内容は `41 3e`（`A>`）が5回、`41 3e fffd`（`A>` とデコード不能なカーソル文字1個）が1回だった。カーソルの点滅により行末の文字が付いたり消えたりするため、完全一致判定では約6回に1回取りこぼした。
4. AUTOEXEC 実行中には、起動完了より先に `A>ECHO OFF` という行が表示された。`A>` は起動完了時だけに出現する文字列ではない。
5. 2秒間に rAF コールバックを120回観測し、実測値は59.97Hzだった。一方、`window.__webx68kDebug.stat().fps` は全サンプルで55.5のまま変化しなかった。55.5は X68000 の公称垂直周波数であり、SET_SYSTEM_AV_INFO 由来の固定値と考えられる。この値はフレームレートの計測値として使用できない。
6. Browser ペインでは `document.hidden` が `true`、`visibilityState` が `hidden` だったが、rAF は59.97Hzで動作し、音声キューの `queuedSec` も約0.082秒で推移した。過去に記録された「自動ブラウザでは rAF が回らない」という制約は、この Browser ペインには当てはまらなかった。他の自動化環境での挙動は今回の確認対象に含まれない。
7. 起動時に `\SYS\OPMDRV3.X が登録できませんでした` という行が表示された。同梱システムディスクに FM 音源ドライバが入っていないか、登録に失敗している。ゲスト側で確実に音を出す fixture の用意に影響する事象である。
8. `screenText()` の出力では、行頭の `Human68k` 相当部分など一部が U+FFFD となった。全角記号や特定の文字コードを変換できていない箇所があり、原因と範囲は未調査である。

### 計測計画への反映

- 「Human68k 起動」の起動完了文字列は、今回の FDD0 起動構成では `A>` に確定する。ただし判定は `A>` の完全一致にも単純な前方一致にもせず、TVRAM 最終行が `A>` または `A>` に末尾1文字だけを伴う状態であることを条件とし、計画どおり連続3回の確認を行う。これにより点滅カーソルによる取りこぼしを避けつつ、先に現れる `A>ECHO OFF` を起動完了と誤判定しないようにする。
- 「フレーム時間の分布」では、`window.__webx68kDebug.stat().fps` を基準値および実測フレームレートとして使用しない。フレーム間隔とフレームレートは必ず rAF の実測時刻、または `handleVideoRefresh()`、canvas 更新など描画末端の時刻から算出する。画面 width/height/fps の遷移を記録する場合も、`stat().fps` を実測 fps として扱わない。
- 「非表示・ヘッドレス・iOSでの駆動」および「自動化できない範囲」にある rAF の制約は環境別に扱う。Browser ペインでは非表示状態でも rAF が動作したため、この環境を計測に使える。一方、この結果を Puppeteer など他の自動化環境へ一般化せず、使用環境ごとに rAF の進行を予備確認する。
- 「音声遅延」で必要とした、固定操作で確実に音を出すゲスト側 fixture は未確定のまま残す。`OPMDRV3.X` の登録失敗が表示されたため、同梱システムディスクをそのまま使えるかを確認し、測定用ディスクの要否を判断する必要がある。
- TVRAM のマーカーには、`screenText()` で U+FFFD に変換される可能性のある文字を選ばない。起動完了および3ドライブ認識のマーカー照合では、使用する文字列が実際の `screenText()` 出力で安定して読めることを事前に確認する。

### 未確認のまま残ったこと

- FDD1 と HDD のドライブレターは、両方とも未挿入だったため未確認である。A/B/C と推測で断定せず、イメージを用意して実測する。特に HDD から起動する構成では、ドライブレターの割当を改めて確認する。
- 起動完了までの所要時間は、今回タイムスタンプを採取していないため未確認である。

### 追加実測：ドライブレターと自動化の制約

確認環境は前回と同じ WebX68k dev server の Claude Code Browser ペインとした。起動前に UI の「ブランクHDDを作成(40MB・FAT16)」と「FDD1 ブランク作成」を実行し、FDD0 に同梱システムディスク `human302.xdf`、FDD1 に `blank_2hd1232.xdf`、HDD に `blank_hdd.hdf` を挿入した状態で「システムディスクで起動」した。

Human68k のプロンプトで `DIR <ドライブ>:` を実行し、TVRAM の出力を確認した結果、FDD0 の起動ディスクは A:、FDD1 は B:、HDD は C: に割り当てられた。B: では「ボリュームがありません B:\」、1221K Byte 使用可能、C: では「ボリュームがありません C:\」、40781K Byte 使用可能と表示された。D: では「ドライブ名が無効です」と表示され、これ以上のドライブはなかった。この A/B/C の割当は FDD から起動した構成での実測結果であり、HDD から起動する構成での割当は未確認である。UI で作成したブランクHDD（FAT16）は、Human68k から容量を含めて正常に見え、ボリュームラベルはなかった。

合成 `KeyboardEvent` は、`window.dispatchEvent(new KeyboardEvent('keydown'/'keyup', {code, key, bubbles: true, composed: true}))` によりゲストへ入力でき、Human68k がコマンドを受け付けた。アプリ側は `e.code` を参照するため、`code` の明示が必須であり、`code` が空の合成イベントは無視された。コロン `:` は `code: 'Quote'` で入力できた。MCP ブリッジ `__webx68kBridge` は URL パラメータを `resolveBridgeUrl(location.search)` で解決できない場合には生成されないが、ブリッジがない状態でもこの方法で入力を検証できた。

Browser ペインは hidden でも rAF が59.97Hzで動作した一方、`setTimeout` は絞られ、短い待機を多数並べたスクリプトは30秒の実行上限に達した。このときゲスト側では全コマンドが正常に完了しており、スクリプトのタイムアウトはゲスト側処理の失敗を意味しなかった。自動化では多数の短いスリープを避け、rAF ベースで待機するか、スリープ回数を減らす必要がある。

また、実行がタイムアウトすると `finally` の解除処理も実行されず、押下中のキーが解放されないまま残ることがある。キー入力の自動化では、押下前に全キーへ `keyup` を送る解除用スクリプトを用意し、タイムアウト後は最初にそれを実行する必要がある。

計測計画の「3ドライブ認識」でマーカーファイルを配置して照合する際は、FDD 起動構成では FDD0/FDD1/HDD が A:/B:/C: に割り当てられる実測結果を使用する。HDD 起動構成にはこの割当を適用せず、別途確認する。計測コードは、短いスリープの多用を避けること、およびタイムアウト時に残留した押下状態を最初に解除することを前提として作成する。

## 基準値：起動所要時間（実測）

### 計測方法

- 今回追加した `scripts/measure-boot.mjs` を使用し、Puppeteer で実ブラウザを headful 起動した。headless では rAF が絞られるため、計測には使用していない。
- 始点は「システムディスクで起動」ボタンを実クリックする直前に Node 側で取得した時刻とした。
- 終点の判定では、`window.__webx68kDebug.screenText()` の TVRAM を100ms間隔でポーリングした。`A>` で始まる行のうち最後のものについて、`A>` に続く残りが1文字以内である状態が連続3回続いた時点を終点とした。
- 構成は FDD0 の同梱システムディスク `human302.xdf` のみとした。反復ごとに新規 BrowserContext を作成し、状態を隔離した。
- 20回反復し、各試行のタイムアウトは90秒とした。

### 結果

20回すべて成功し、失敗は0回だった。

- 中央値: 25,832 ms
- p95: 27,079 ms
- p99: 29,212 ms
- 最小: 24,487 ms
- 最大: 29,745 ms
- 生サンプル（ms、順不同）: `24487 25086 25758 25525 26834 25179 25802 25139 25837 26938 26151 26281 26393 25484 26565 25828 26689 26089 25636 29745`

分布は締まっており、20件中19件が24.5〜26.9秒だった。外れ値は29.7秒の1件のみだった。

### この数字を読むときの注意

1. この値は **Vite の dev server 上での値**であり、本番ビルドの値ではない。dev server はモジュールを個別配信するため、本番ビルドとは条件が異なる。**移行前後の比較は必ず同じモードどうしで行うこと。** 本番ビルドでの値は未測定である。
2. この値は **wasm の取得とコンパイルを含む。** 反復ごとに新規 BrowserContext を使うためキャッシュが効かず、毎回コールドで読み込まれる。約25秒はその時間と Human68k の起動時間の合計であり、**内訳は分解していない。** 計測計画の「起動時のRAM展開」の項で分解する予定である。
3. 途中で「手動観測では6秒程度」と考えた場面があったが、**これは計測ではなかった。** hidden な Browser ペイン内で `setTimeout(6000)` を置いただけであり、絞られた環境では指定値と実時間が一致しない。実測値との食い違いは矛盾ではなく、測っていないものを観測として扱っていた誤りである。

### 測定系の検証

`--fault=wrong-marker` で完了マーカーを誤った文字列にする故障を注入し、陽性対照である故障なしの試行が25,563 msで成功した上で、故障が検出されることを確認した。

当初は故障注入が通る一方、本計測が20回中0回しか成功しなかった。判定対象を「非空行の最終行」としていたが、TVRAM の最終非空行は常にファンクションキーの案内バーであり、プロンプトはその上にあるため、条件が成立しなかったことが原因だった。故障注入が示すのは「失敗を報告できること」だけであり、常に失敗する検出器も通過する。このため陽性対照を追加し、正常な試行を成功として検出できることも確認するようにした。

### 起動時間の内訳（実測）

#### 計測方法

`scripts/measure-boot.mjs` を使用した。`src/` は一切変更せず、Resource Timing API と `window.__webx68kDebug` の50ms間隔のポーリングだけでマイルストーンを採取した。時刻はページ内の `performance.now()` に統一した。

マイルストーンは次のように定義した。

- クリック（始点）
- wasm取得完了: Resource Timing の `.wasm` エントリの `responseEnd`
- コア稼働: `__webx68kDebug.stat().fps` が有限数を返した最初の時点
- ゲスト初出力: TVRAM に最初の非空行が現れた時点
- プロンプト安定（終点）: 既存の判定

#### 結果

10回すべて成功し、失敗は0回だった。総時間は中央値25,067 ms、p95 26,066 ms、p99 26,296 ms、最小23,966 ms、最大26,354 msだった。

区間ごとの中央値は次のとおりである。括弧内は最小〜最大を示す。

- クリック→wasm取得完了: 1,134 ms（671〜1,250）
- wasm取得完了→コア稼働: 9,359 ms（7,375〜11,927）
- コア稼働→ゲスト初出力: 8,392 ms（6,076〜9,394）
- ゲスト初出力→プロンプト安定: 7,049 ms（4,779〜7,534）

#### この内訳から読み取れること

ホスト側（クリック→コア稼働）は約10.5秒、ゲスト側（コア稼働→プロンプト安定）は約15.4秒だった。総時間の約6割は、ゲストでX68000のIPLとHuman68kのFD起動が実際に動いている時間である。

したがって、ワーカー移行やOPFS化で短縮しうるのはホスト側の約10.5秒の側であり、総時間25秒がそのまま縮むわけではない。

最大の単一区間は「wasm取得完了→コア稼働」の9.4秒だった。ただし、この区間にはwasmのコンパイル、コア初期化、ゲームロード、AV情報取得が含まれている。さらに細かい分解はアプリ側に計測点を入れないとできず、今回は `src/` を変更しない方針のため未分解である。

#### 計測の妥当性

今回の10回計測の総時間中央値25,067 msは、計測点を追加する前の20回計測の中央値25,832 msと整合する。したがって、50msポーリングとResource Timing走査による計測自体の影響は、この粒度では確認されなかった。

ただし、途中で3回だけ走らせた際にp95が43,517 msまで跳ねたことがあり、これは一時的なマシン負荷と考えられる。少ない試行回数の値を基準に使わないこと。

#### マイルストーン定義の修正経緯

当初は「コア稼働」を `window.__webx68kDebug` が定義されたことで判定していた。しかし、この値はページのスクリプト読み込み時点で定義され、起動ボタンを押す前から存在する。その結果、「wasm取得完了→コア稼働」が−998 msと負になった。負の区間は順序の逆転であり、その指標が意図したものを測っていない合図である。

判定を `stat().fps` が有限数になる時点へ変更し、あわせて次の検査を追加した。

- 負の区間をinvalidとして統計から除外し、警告する。
- 起動ボタンを押す前の各判定条件の成立状況を `preClickState` として毎回記録し、「押す前から成立している条件」を後から確認できるようにする。

`preClickState` は、実測で4条件すべてfalseであることを確認済みである。

### 本番ビルドでの計測は現時点で成立しない（実測）

#### 計測方法と結果

`scripts/measure-boot.mjs` に `--mode=prod` を追加し、`npm run build` の成果物を `vite preview` で配信して10回計測した。判定条件、マイルストーン、ポーリング間隔はdev計測と同一とした。

結果は成功0/10で、全試行がタイムアウトした。取得できたのは「クリック→wasm取得完了」の区間のみで、中央値は610 msだった。dev計測の中央値は1,134 msである。コア稼働、ゲスト初出力、プロンプト安定の各マイルストーンは一つも取得できなかった。

#### 原因

判定に使用している `window.__webx68kDebug` は、`src/main.ts` で `import.meta.env.DEV` に囲まれているため、本番ビルドには存在しない。実測でも `preClickState` の `debugDefined` は `false` だった。TVRAMを読む手段がないため、現在の検出器では判定条件が原理的に成立しない。

#### アプリケーションの動作確認

成功0/10という結果は、本番ビルドが起動しないことを示すものではない。実際にブラウザで本番ビルドを開いて手動で起動したところ、Human68k version 3.02の起動メッセージが表示され、`A>ECHO OFF` を経てプロンプト `A>` まで正常に到達した。画面下部のファンクションキー案内バーも表示された。したがって、失敗しているのは検出器であり、アプリケーションではない。

検出器がないことによる失敗と、対象が壊れていることによる失敗は、記録上はいずれもタイムアウトとして同じ見え方をする。今回の切り分けには、対象を別の手段で観測する必要があった。

#### この結果から分かったこと

wasm取得はdevの1,134 msに対してprodでは610 msであり、約半分になった。バンドル配信の効果は出ているが、この区間は総時間の4%程度である。この結果だけでは、本番ビルド全体の起動時間について何も言えない。

#### 今後の選択肢

- **MCPブリッジ経由で測る。** `src/main.ts` のブリッジ生成は `import.meta.env.DEV` に囲まれておらず、URLパラメータで有効化される。同じ `screenText` を読むため、判定条件を変えずに済み、dev/prodの比較可能性を保てる。ただし、`mcp/server.mjs` を常駐させ、計測スクリプトから接続する実装が必要になる。
- **prod計測を見送る。** 移行前後の比較はdev同士で成立する。ただし、実ユーザーの起動時間については何も言えないままになる。

### 本番ビルドの起動時間（実測・ブリッジ経由）

直前の「本番ビルドでの計測は現時点で成立しない」で述べた検出器の問題は、MCPブリッジ経由でTVRAMを読む方式に変更したことで解消した。

#### 計測方法

`scripts/measure-boot.mjs` の `--mode=prod` を、MCPブリッジ経由でTVRAMを読む方式に変更した。ブリッジは `import.meta.env.DEV` に囲まれていないため、本番ビルドでも動作する。計測スクリプト内に最小限のWebSocketサーバを立て、`{id, cmd:"screen_text", args:{}}` に対して `{id, ok, result}` で応答するプロトコルだけを実装した。`mcp/server.mjs` 全体は不要なため使用していない。`src/` と `mcp/` は変更していない。

完了判定の条件はdevと完全に同一であり、`A>` で始まる最後の行について、残りが1文字以内である状態が連続3回続いた時点を終点とした。devとprodの違いはTVRAMの読み取り経路だけである。

devモードは変更していない。`--mode=dev` を再実行し、従来どおり2回中2回成功、中央値25,706 msであり、回帰していないことを確認した。

#### 結果

prodは10回すべて成功し、失敗は0回だった。devの前掲10回計測も10回すべて成功している。

- prod: 中央値24,053 ms、p95 24,714 ms、p99 24,744 ms
- dev: 中央値25,067 ms
- 差: 約1,000 ms（約4%）

dev server由来の水増しは約1秒だった。起動時間の大部分は配信方法ではなく、wasmのコンパイルとコア初期化、およびゲスト側でのX68000のIPLとHuman68kのFD起動が占めている。

#### 内訳のdev/prod比較は無効

区間の中央値を並べると、prodの「wasm取得完了→コア稼働」は13,559 msで、devの9,359 msより大きく、その後のゲスト側区間は短くなっていた。しかし、ページ内の `performance.now()` を基準にしたマイルストーンの絶対時刻の中央値を見ると、この内訳は成立しない。

| マイルストーン | dev | prod |
| --- | ---: | ---: |
| wasm取得完了 | 7,383 ms | 5,625 ms |
| コア稼働 | 16,853 ms | 19,444 ms |
| ゲスト初出力 | 25,255 ms | 23,924 ms |
| プロンプト安定 | 31,227 ms | 28,712 ms |

prodでは「コア稼働」だけが2.6秒遅く、その後続のマイルストーンはすべて早い。コア稼働は後続の原因であるため、この因果順序は成立しない。ブリッジ経由の `status` ポーリングがWebSocketの往復分だけ遅れて検出しているためと考えられ、「コア稼働」はdev/prod間で等価な指標ではない。

したがって、比較してよいのは合計時間だけである。コア稼働を含む区間のdev/prod比較は無効として破棄する。残るゲスト側区間の差は、dev自身の試行間のばらつきの範囲内に収まっている。「ゲスト初出力→プロンプト安定」はdev単独でも4,779〜7,534 msの幅があり、10回の計測では区別できない。

「後続が早いのに上流が遅い」という因果順序の破れは、指標が読み取り経路間で等価でないことを検出する健全性検査として使える。合計が一致していても、内訳の境界はずれうる。

#### 計測条件の差異

prod計測ではブリッジを有効化するURLパラメータを付けており、ブリッジが接続された状態で測定した。これは実際に配布される通常構成とは異なる。この差が起動時間に与える影響は未測定である。

## 基準値：3ドライブ認識（実測）

### 計測方法

今回追加した `scripts/measure-drives.mjs` を使用し、dev serverとPuppeteer（headful）で計測した。1試行の手順は次のとおりである。

1. 新規BrowserContextでページを開く。
2. UIの「FDD1 ブランク作成」「HDD ブランクHDDを作成(40MB・FAT16)」をクリックする。
3. 「システムディスクで起動」でHuman68kを起動し、プロンプトの安定を待つ。
4. A:、B:、C:、D:の順に `DIR <letter>:` を実行し、Enter送出から出力が現れるまでの時間を計測する。

### 同一性の判定方法とその限界

マーカーファイルを書き込む手段がないため、媒体が本来持つ識別情報で同一性を確認した。

- A: システムディスクのディレクトリ（SYS/HIS/BIN/BASIC2/ASK/ETC）が列挙されること。
- B: 「ボリュームがありません B:\」と表示され、使用可能容量が1221K Byte付近であること。
- C: 「ボリュームがありません C:\」と表示され、使用可能容量が40781K Byte付近であること。
- D: 「ドライブ名が無効です」と表示されること。

B:とC:は容量が2桁違うため、取り違えを検出できる。ただし、これはマーカーファイルの代用であり、同一容量の媒体どうしの取り違えは検出できない。この限界は残っている。

### 結果

5回すべて成功し、入力失敗は0件、判定不能は0件だった。Enter送出から出力が現れるまでの時間は次のとおりである。単位はmsである。

| ドライブ | 中央値 | p95 | 最小 | 最大 |
| --- | ---: | ---: | ---: | ---: |
| A:（FDD0 システムディスク） | 116.2 | 559.0 | 98.4 | 604.8 |
| B:（FDD1 ブランク2HD） | 128.4 | 135.9 | 110.5 | 137.4 |
| C:（HDD 40MB） | 789.5 | 949.8 | 595.2 | 989.7 |
| D:（未割り当て） | 81.2 | 88.2 | 77.7 | 89.2 |

- C:は他より約6倍遅い。40MBのFATを走査するためと考えられるが、内訳は未確認である。
- A:はばらつきが大きく、98〜605msだった。他のドライブは範囲が狭い。原因は未確認であり、5回では判断できない。
- D:が最も速いのは、実際のディスクI/Oが発生しないためと考えられる。

### 測定系の検証（陽性対照つき故障注入）

- `--fault=no-hdd`（HDDを作成せず起動）では、C:だけが失敗することを確認した。
- `--fault=no-fdd1`（FDD1を作成せず起動）では、B:だけが失敗することを確認した。ただし、C:とD:は判定不能（未実行）として報告された。

いずれも、故障注入の前に故障なしの試行が成功することを確認済みである。

### 実装で潰した2つの誤診

同じ罠を再訪しないため、計測実装で判明した誤診と対策を記録する。

#### 1. 入力の取りこぼしを「ドライブが認識されない」と誤診しかけた

初回の実測でA:/B:/D:が判定失敗したが、原因はドライブではなくキー入力だった。画面に残ったコマンド行は `A>dr:`（`dir a:` から `i`・`a`・空白が欠落）や `A>dr d:` であり、B:の試行では崩れたコマンドの結果としてA:の内容が表示されていた。

- 対策1: キーの保持時間とキー間隔をそれぞれ70msにした。ゲストはフレーム単位でキーを読むため、解放直後に次を押すと取りこぼす。最低2フレーム分が必要である。
- 対策2: Enterを押す前に画面のコマンド行を読み、意図した文字列と一致することを検証する。末尾のカーソル1文字は許容する。不一致ならBackspaceで消して最大3回まで打ち直し、それでも駄目なら「入力失敗」として記録する。
- 対策3: 「入力失敗」と「ドライブ判定失敗」を分けて集計する。入力失敗がある試行は、ドライブ判定の計測値として採用しない。

#### 2. 連鎖した未実行を「失敗」と数えて故障注入の判定を誤らせた

`no-fdd1` では `dir b:` が応答せずタイムアウトし、その後のC:とD:が実行されないまま「失敗」に数えられ、「故障対象だけが失敗」と言えなくなっていた。検出自体は正しく働いていたが、集計の分類が粗かった。

対策として、「判定不能（未実行）」を「失敗」から分離した。故障注入の合格条件は「故障対象が失敗し、他に失敗がないこと」とした。判定不能は許容するが、どのドライブが判定不能だったかを必ず出力し、黙って許容しない。

タイムアウトからの復帰（Enter→Ctrl+C、上限2回・各5秒）も実装したが、FDD1が空の場合の復帰には成功していない。この状況でHuman68kが画面に何を表示するかは未確認である。

## 基準値：キー入力の末端到達（実測）

計測計画の「目的A：回帰の基準値」表の「キー入力の末端到達」行の定義に従い、コア末端（wasm内 KeyBuf）とアプリ末端（Human68k が消費した後の TVRAM）を、同じ合成キー入力から同時に観測した。2経路の結果は別々の集計として記録する。

### (A) dev限定のKeyBufプローブ

`src/libretro-host.ts` の `LibretroHost` に `readKeyBufWindow(start, count)` を追加した。既存の `_webx68k_keybuf_peek` / `_webx68k_keybuf_write_pointer`（`test/core-keyboard-integration.test.ts` が実ROM結合テストで使っているものと同じ export）をそのまま呼ぶだけで、C側は変更していない。`src/main.ts` の `window.__webx68kDebug`（`import.meta.env.DEV` の内側、既存の1関数）に `keybuf(start, count)` を追加し、呼ばれたときだけHEAPを読む。毎フレーム処理には一切関与しないため、起動時間の基準値には影響しない（本節の計測方法自体もこのプローブを毎フレーム呼んでいない）。

### (B) 計測スクリプト `scripts/measure-key.mjs`

`scripts/measure-boot.mjs` / `scripts/measure-drives.mjs` と同じ様式（ヘッドフル Puppeteer、試行ごとに新規 BrowserContext、`--fault=` オプション、故障注入前の陽性対照、rAFベースの待機、キー保持/間隔70ms以上、実行前の全キー解除）で実装した。

- FDD0 の同梱システムディスクのみで起動し、Human68k のプロンプト安定を待つ（`measure-boot.mjs` と同一の判定条件）。
- 対象キーは `RETROK_TO_SCANCODE`（`src/keyboard.ts`）上で異なるスキャンコード領域に散らばる6キー（a/x/z/1/2/c、スキャンコード 0x1e/0x2b/0x2a/0x02/0x03/0x2c）を循環させる。RETROK[0]は make が2回書かれる特例（結合テストで既知）のため除外した。
- 1回の刺激ごとに、合成 `keydown`→保持70ms→`keyup`→間隔70ms を送り、その間 `__webx68kDebug.keybuf()` と `screenText()` のコマンド行をポーリングする。刺激後は Backspace でコマンド行を「A>」（+カーソル1文字まで）へ戻し、戻らなければ最大3回まで追加でクリアする。
- KeyBuf 経路: 刺激開始時の書き込みポインタ位置 `start` を記録し、「`start` の書き込みポインタが進んだ」ことを新規書き込みの根拠にする。**値が0以外になったことを根拠にしない** — KeyBufは128バイトのリングバッファで、`start` 位置には何周も前の古い値（実測でBackspaceのmakeコード0x0fが居残っていた例がある）が残っていることがあるため。break側も同様に、書き込みポインタの増分が2未満なら「まだ上書きされていない＝欠落」として扱う。
- TVRAM 経路: カーソルは点滅により行末へ1文字だけ付いたり消えたりし `U+FFFD` として観測される（前掲の予備確認結果）。末尾のU+FFFD1個を取り除いた「実内容」が刺激前と変わったときだけを「入力が反映された」とみなし、点滅だけの揺らぎを誤検出しないようにした。反映後の行は、期待する行（`A>`+対象文字）と完全一致、またはそれに末尾ちょうど1個のU+FFFD（カーソル）が付いた状態だけを一致とみなす。それ以外（同じ文字の重複を含む）は不一致として扱う。

### 結果

dev server（Vite）で2回計測した。各回、起動1回・刺激30回。

| 回 | 経路 | 標本数 | 失敗数 | 最小 | 中央値 | p90 | p95 | p99 | 最大 | MAD | 欠落 | 誤字 | 重複/残留 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1回目 | KeyBuf(make到達) | 30 | 0 | 3.94 | 11.06 | 31.94 | 32.90 | 74.44 | 91.29 | 7.05 | 0 | 0 | 0 |
| 1回目 | TVRAM(エコーバック) | 30 | 0 | 12.36 | 31.82 | 48.75 | 55.15 | 81.37 | 91.29 | 7.15 | 0 | 0 | 0 |
| 2回目 | KeyBuf(make到達) | 30 | 0 | 3.97 | 4.54 | 29.05 | 51.28 | 74.68 | 76.85 | 0.21 | 0 | 0 | 0 |
| 2回目 | TVRAM(エコーバック) | 30 | 0 | 11.82 | 32.80 | 43.07 | 58.88 | 74.68 | 76.85 | 5.69 | 0 | 0 | 0 |

単位はms。「到達」はいずれも合成keydown送出（ページ内 `performance.now()`）からの経過。欠落・誤字・重複/残留は、押下30回・解放30回すべてについて0件だった（KeyBufの make欠落/誤字/break欠落/重複、TVRAMのエコー欠落/誤字/重複をすべて含む）。

2回とも全試行成功だが、KeyBuf中央値は11.06msと4.54msでばらつきが大きく、p99はどちらも70ms台まで伸びている。ポーリング間隔16msの観測遅延（最大概ねその分）を差し引いても、ポーリングだけでは説明しきれない裾がある。原因は未調査であり、今回は「移行前の基準値」としてこのばらつきごと記録する。

生サンプルは `_local/measure/key-*.json`（gitignore対象）に保存した。

### 測定系の検証（陽性対照つき故障注入）

`docs/STORAGE-SCSI.md` の当該行が指定する3故障を、`scripts/measure-key.mjs --fault=` で実装した。**故障注入コードは全て計測スクリプト内にあり、`src/` には一切手を入れていない**（本番ビルドには含まれない）。各故障は実際の合成DOMイベント送出そのものを変える形で注入した（コアやアプリ内部を書き換えたわけではない）。

- `drop-make`（1キーのmakeを捨てる）: `keydown` を送らない。
- `wrong-code`（別スキャンコードへ置換する）: 期待キーと異なる `code`/`key` を持つ別キーを送る。
- `drop-break`（breakを1回捨てる）: 観測窓の間 `keyup` を送らず、窓が閉じた後に後始末として送る（次の刺激へ影響を残さないため）。

各故障の前に、故障なしの正常系（陽性対照、TEST_KEYSの6キー1周ぶん）が成功することを確認した上で、故障を注入した試行（同じく6キー1周ぶん）を実行した。

| 故障 | 陽性対照 | 故障注入時の観測 | 判定 |
| --- | --- | --- | --- |
| `drop-make` | 成功（keybuf ok 6/6, tvram ok 6/6） | keybuf: missingMake 6/6・他0件／tvram: missingEcho 6/6・他0件 | 期待どおり検出（欠落） |
| `wrong-code` | 成功（keybuf ok 6/6, tvram ok 6/6） | keybuf: wrongMake 6/6・missingMake 0件／tvram: wrongEcho 6/6・missingEcho 0件 | 期待どおり検出（誤字） |
| `drop-break` | 成功（keybuf ok 6/6, tvram ok 6/6） | keybuf: missingBreak 6/6・missingMake/wrongMake 0件（tvram側は残留の直接指標にしていないため6/6 ok） | 期待どおり検出（残留押下） |

3件とも、故障対象の異常だけが全試行で発生し、無関係な分類（欠落でないのに誤字も出る、等）が混在しないことを確認した。measure-boot.mjs で既に踏んだ「常に失敗する検出器も故障注入を通過する」問題を避けるため、陽性対照が全て成功していることも上表に含めている。

#### 実装で見つけて直した誤検出

- **KeyBufの「非0で判定」は誤検出だった**: 当初は `peek(start) !== 0` を make 到達の根拠にしていたが、リングバッファに残る何周も前の値（Backspaceのmakeコード `0x0f`）を新規の make と誤認し、実測30件中3件で `wrongMake` が発生した（`makeAtMs` が0.1ms前後という非現実的な速さで露見した）。書き込みポインタの前進を根拠にする方式へ直し、以後の複数回計測で再発していない。
- **カーソル点滅だけをTVRAMの「入力反映」と誤認していた**: `drop-make` の陽性対照で、キーを送っていないのに `wrongEcho` が出た。原因はカーソルの点滅（`U+FFFD` の出現/消失）を「行が変化した」と検出していたためで、末尾のカーソル1文字を取り除いた実内容で比較するよう直した。
- **起動直後の最初の刺激だけがまれに無反応**: プロンプト安定判定の直後に最初のキーを送ると、ごくまれに（実測で数回に1回）KeyBuf・TVRAMのどちらにも変化が現れないことがあった。プロンプト安定判定はポーリング間隔の粒度で「連続3回」を見ているだけで、ゲスト側の入力ポーリングが同じ瞬間に確実に回っている保証ではないと考えられる。最初の刺激の前だけ rAF 20フレーム分の余裕を入れて回避した（短いスリープの多用ではない）。原因の詳細は未調査。

### 合格判定

計測計画の合格条件「KeyBufの期待列とTVRAMの固定文字列が全試行で完全一致し、欠落・重複・残留押下が0」は、今回の2回×30刺激でいずれも満たした。ただし本計測は移行前の単発測定であり、「移行後の中央値・p95・p99がA/A反復誤差内に収まること」という回帰判定はまだ評価できない（比較対象がない）。今回の2回の測定自体が簡易的なA/A（同一構成・同日）に近く、KeyBuf中央値が11.06ms→4.54msへ変動した一方、失敗0件・欠落/誤字/重複0件は再現している。

### 未確認・限界

- **自動計測は合成KeyboardEvent経由のDOMイベント経路であり、物理キーボードの保証にはならない。** `code`/`key` を明示したDOM `dispatchEvent` を使っており、実キーボードのIME・OS配列・ブラウザのキーリピート挙動は経由していない。計測計画が要求する物理キーボードでの固定文字列・Shift付き記号・長押し・blur/visibility後の解放の確認は、本計測に含まれておらず未実施である。
- 対象キーは6キー（a/x/z/1/2/c）のみで、`RETROK_TO_SCANCODE` 全エントリを網羅していない。全キーの結合テストは `test/core-keyboard-integration.test.ts` が別途カバーしている（ただしNodeから直接 `input_state` を与える経路であり、ブラウザのDOMイベント経路ではない）。
- KeyBuf到達時間の裾（p99が中央値の6〜16倍）の原因は未調査。ポーリング間隔（16ms）由来の観測遅延だけでは説明しきれない。
- 起動直後の最初の刺激がまれに無反応になる現象の原因は未調査で、rAF 20フレーム分の待機という対症療法で回避しているのみである。
- 本計測は dev server 上のみで行った。prod（本番ビルド）での計測は、`window.__webx68kDebug` が `import.meta.env.DEV` の内側にあるため成立せず（起動時間計測での既知の制約と同じ）、今回は着手していない。ブリッジ経由での代替も未実装である。
- A/A反復誤差の確立に必要な「別日の再測定」は今回の作業範囲に含めていない（実行順序の手順7に対応する作業であり未着手）。

## 予備確認：音を出す固定操作の有無（実測）

計測計画の「目的A：回帰の基準値」表「音声遅延」行、および「予備確認の結果（実測）」で未確定のまま残していた「固定操作で確実に音を出すゲスト側 fixture」の有無を確認した。**音声遅延そのものの計測は行っていない。** ここでの結論は「同梱ディスクだけで音を出す操作が存在するか」だけである。

### 確認方法

WebX68k dev server（Vite）を Claude Code の Browser ペインで開き、FDD0 に同梱 `human302.xdf` のみを挿入した既定構成で「システムディスクで起動」した。作業途中、`.claude/launch.json` の `webx68k-dev` 設定が誤って隣接ワークツリー `/Users/haruurara/MyProject/_emulator/X68K/WebX68k`（別セッションが作業中のmasterブランチ）の `node_modules/vite` を指していたことに気付いた。誤設定のプロセスは強制終了しただけで、そのリポジトリのファイルは一切変更していない。本セッションのワークツリー自身の `npx vite --port 5301` を手動起動し、以降はそちらで確認した。`.claude/launch.json` の `--prefix` は本ワークツリーへ修正し、コミットに含めている。

Browser ペインは `document.hidden` が `true` で、このセッションでは `window.requestAnimationFrame` が8秒間で0回しか発火しなかった（過去の予備確認では59.97Hzで動いた記録があり、rAFの可否は環境依存で毎回実測が要ることを裏付けた）。一方 `src/main.ts` のコメントにあるとおり AudioWorklet の tick はタブ非表示でも止まらないため、ゲスト側の実行自体は継続していた。合成キー入力の押下/解放の待機は `requestAnimationFrame` ベースでは進行せず、`setTimeout` ベース（Chromeのバックグラウンド throttling で実測 500ms 指定 → 約930ms に伸びる）に変更してから安定して打鍵できた。既存スクリプト（`measure-boot.mjs`/`measure-drives.mjs`/`measure-key.mjs`）のPuppeteer実行はこの制約を踏んでいない可能性があり、次回このBrowserペインで手動確認する際は毎回rAFの実測を先に取ること。

### 1. `OPMDRV3.X` の登録失敗の実態

`DIR A:\SYS` を実行しファイル一覧（18ファイル）を確認したところ、`OPMDRV3.X` という名前のファイルは存在しなかった（`ASK68K.SYS` 以下、`SYS`/`X` 拡張子のドライバ18本の中に該当なし）。したがって「登録に失敗している」のではなく、**同梱システムディスクに FM 音源(OPM)ドライバのファイル自体が入っていない**ことを実測で確認した。同梱ディスクのままでは OPM 経由の音声再生は成立しない。

### 2. X-BASIC（`BASIC2`）が使えるか

`A:` 直下で `basic2` を実行すると「コマンドまたはファイル名が違います」となった。`DIR A:\BASIC2` を実行すると `BASIC.X`（本体）、`AUDIO.FNC`・`MUSIC.FNC`・`MUSIC3.FNC` 等の拡張機能ファイルが確認できた。`BASIC2\BASIC` を実行したところ「X BASIC for X68000 version 2.02」が起動し `Ok` プロンプトに到達した。続けて `BEEP` コマンドを実行し `Ok` へ戻ったことを画面で確認した。**X-BASICは起動でき、`BEEP` コマンドが実行できることを実測した。**

### 3. その他の音源（1・2で不足した場合の代替）

1・2で音を出す経路（X-BASICのBEEP）が確認できたため、`\BIN` 等の追加調査は行っていない。未確認のまま残す。

### 音が鳴ったことの判定方法

`src/libretro-host.ts` の `LibretroHost.handleAudioBatch()`（`retro_set_audio_sample_batch` のコールバック、HEAP16→Float32Array変換ループ）に、dev限定・受動的な振幅プローブを追加した（`resetAudioProbe()`/`readAudioProbe()`、直前コミット `e0723f3` のKeyBufプローブと同じ作法で `window.__webx68kDebug` に生やしている）。積算する値は次の3つで、`import.meta.env.DEV` がfalseの本番ビルドではこの分岐ごとViteの静的定数置換でデッドコード除去される。

- `maxAbs`: 直前の `resetAudioProbe()` 以降の最大振幅の絶対値（0..1）
- `sampleCount`: 積算したサンプル総数
- `nonSilentCount`: 振幅の絶対値が `1e-4`（実測校正はしていない決め打ちのしきい値）を超えたサンプル数

**この振幅積算は `handleAudioBatch()` が既に回している変換ループの中で行っており、呼ばれたときだけ読むKeyBufプローブとは性質が異なる。dev環境では音声バッチが呼ばれるたびに比較1回ぶんのコストが常時乗る。** 本番ビルドには残らないため起動時間等の基準値には影響しないが、dev環境での計測（起動時間・キー入力等、同じdevビルドを使う既存の基準値計測）に本プローブ由来の追加コストが乗る可能性がある点は、次回dev計測を行う際に留意すること（今回はこの影響を測定していない）。

### 陰性対照・陽性対照の結果

- **陰性対照**: Human68kのプロンプト（`A>`）を放置した状態で `resetAudioProbe()` してから5秒待ち `readAudioProbe()` を読んだ。結果は `maxAbs: 0`、`nonSilentCount: 0`、`sampleCount: 888810`。何もしていない状態を「鳴った」と誤検出しないことを確認した。
- **陽性対照**: X-BASICの `Ok` プロンプトで `resetAudioProbe()` した直後に `BEEP` を実行し、約2秒後に `readAudioProbe()` を読んだ。結果は `maxAbs: 0.816`（0..1スケール）、`nonSilentCount: 663350`、`sampleCount: 1933440`。陰性対照が正確に0だった同じ経路で、明確に非0の振幅と大量の非無音サンプルが観測された。

陰性対照が0を報告し、陽性対照が明確な非0を報告したことから、この判定方法が「無音を鳴ったと誤検出しない」「実際に鳴った操作を検出できる」の両方を満たしていることを確認した。ただしこの校正は今回の1回ずつのみであり、しきい値 `1e-4` 自体の妥当性や反復再現性は検証していない。

### 結論

**同梱システムディスク `human302.xdf` だけで、決まった操作（起動 → `BASIC2\BASIC` → `BEEP`）を打てば確実に音が鳴る経路がある。** 測定用ディスクを新規に用意する必要はない。ただし対象はPSG/BEEP相当の音声であり、`OPMDRV3.X` 欠落によりOPM(FM音源)経由の音声は同梱ディスクでは確認できていない。計測計画の「音声遅延」で対象範囲をOPM音源まで含めるかFM/PSGを区別するかは、この結果を踏まえて別途決める必要がある。

### 未確認のまま残ったこと

- `BEEP` 以外のX-BASICコマンド（`PLAY`、`MUSIC.FNC`経由のFM音源相当など）は試していない。`AUDIO.FNC`/`MUSIC.FNC`/`MUSIC3.FNC` の中身と、それらがOPMドライバ欠落の影響を受けるかは未調査。
- `\BIN` など同梱ディスクの他の場所に音を出せるファイルがあるかは調査していない（1・2で経路が見つかったため）。
- `BEEP` 実行から実際に振幅が立ち上がるまでの時間（音声遅延そのもの）は計測していない。今回はプローブの動作確認と有無の判定のみで、依頼どおり遅延計測スクリプトは作成していない。
- 振幅プローブがdev計測(起動時間・キー入力等)に与える性能影響は未測定。
- しきい値 `1e-4` の妥当性・反復再現性は1回の陰性・陽性対照でしか確認していない。
- 今回のBrowserペインではrAFが0回だった一方、過去の予備確認では59.97Hzだった。この違い自体の原因は未調査（環境依存の既知事象として記録するに留めた）。

## 作業0：音声振幅プローブのコスト影響（実測）

前回追加した振幅プローブ（`handleAudioBatch()` 内の積算、`import.meta.env.DEV` だけで常時on）は、dev環境の音声処理にコストが乗り続ける実装だった。「軽いはず」で済ませず、`scripts/measure-boot.mjs --mode=dev` の起動時間計測を使って実測した。

### 対処

計測に先立ち、`src/libretro-host.ts` の `LibretroHost` に `audioProbeEnabled`（既定 `false`）を追加し、`handleAudioBatch()` 内の積算を `import.meta.env.DEV && this.audioProbeEnabled` でガードした。`src/main.ts` に URL パラメータ `audioProbe=1` を追加し、指定したときだけ `host.audioProbeEnabled = true` にする。dev環境でも通常のdev計測（起動時間・キー入力等）では既定でコストが乗らない形にしてから比較した。

### 計測方法

同一の dev server（1台のみ起動し、他のViteインスタンスとポートを取り合わない状態を確認してから実行。最初の試行では手動起動したViteと `measure-boot.mjs` 自身が同時に同一ポートへ2重にサーバーを起動しており、その状態での結果（7/10成功、区間ごとの中央値が大きくばれる）は測定環境の異常として破棄した）で、`scripts/measure-boot.mjs --mode=dev --runs=10` を次の2条件で実行した。

- プローブ無効（既定、`http://localhost:5183`）
- プローブ有効（`?audioProbe=1`、`WEBX68K_URL` 経由でクエリ付きURLを指定）

### 結果

| 条件 | 標本数 | 失敗 | 中央値 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| プローブ無効 | 10 | 0 | 24613.48 ms | 26854.34 ms | 27525.92 ms |
| プローブ有効 | 10 | 0 | 23681.31 ms | 25817.34 ms | 26611.67 ms |

プローブ有効のほうが中央値で約932ms（約3.8%）**速い**という結果になった。両条件とも10/10成功。区間別の内訳（`コア稼働→ゲスト初出力`）を見ると、プローブ無効が中央値15639ms、プローブ有効が中央値11535msで約4000msの差があり、これは起動シーケンス全体の試行間ばらつき（キャッシュ、GC、他プロセスの負荷等）がプローブのコストよりずっと大きいことを示している。プローブに起因する有意な悪化は観測されなかった。

### 結論

今回の実測では、振幅プローブの常時onによる起動時間への有意な悪化は検出できなかった（符号が逆で、差は試行間ばらつきの範囲に収まる）。ただし、計測に使う値をそのまま信頼として残すのではなく、既定offのフラグ制御（`audioProbeEnabled` / `?audioProbe=1`）へ変更したうえでこの値を記録する。既定offにしたことで、今後の通常dev計測（起動時間・キー入力など）はプローブの影響を一切受けない。

生サンプルは `_local/measure/boot-probe-off.json` / `_local/measure/boot-probe-on.json`（gitignore対象）に保存した。

## 基準値：音声遅延（実測）

計測計画の「目的A：回帰の基準値」表「音声遅延」行のうち、(1)「AudioWorkletが報告する待ちキュー時間(ms)の時系列と分布、underflow/上限超過・破棄回数」を計測した。(2)「ゲスト側の音発生操作から物理音声出力までの端点間遅延」は自動化できないため今回は実施していない（後述の手順のみ書き残す）。

### 計測方法

- 測る場所は音声の送り側（`audioPush()` 呼出時刻）ではなく、AudioWorklet自身が報告する未再生キュー末尾。`src/audio.ts` の `WebX68kAudioProcessor`（4ブロック=約11.6msごとのtick）に、dev限定のキュープローブを追加した。累積カウンタとして次の3つをtickで返す。
  - `underflow`: キューが空でフェード/無音へ落ちたフレーム数（欠音に相当）
  - `trimEvents`: `_trim()` が実際に間引きを行った回数（上限 `MAX_LATENCY_SEC=0.25秒` 超過の発生回数）
  - `dropped`: 間引きまたは故障注入で破棄されたサンプル数
- `src/audio.ts` の `AudioEngine` に `startQueueProbe()`/`stopQueueProbe()`/`readQueueProbeLog()` を追加し、`resetQueueProbe`後のtickをJS側でも時系列（`{tMs, qSec, underflow, trimEvents, dropped}`の配列）として貯める。`src/main.ts` の `window.__webx68kDebug` に `startQueueProbe`/`stopQueueProbe`/`readQueueProbeLog`/`faultDropNextChunk`/`faultDelayReportSec` を追加した（いずれも `import.meta.env.DEV` 限定）。
- 計測スクリプト `scripts/measure-audio.mjs` を新規実装した。様式は `measure-boot.mjs`/`measure-key.mjs` に合わせた（ヘッドフルPuppeteer、試行ごとに新規BrowserContext、`--fault=`、故障前の陽性対照、rAFベースの起動完了待ち）。
- 音を出す固定操作は「予備確認：音を出す固定操作の有無」で確定済みの手順（起動 → `BASIC2\BASIC` → `BEEP`）をそのまま使う。「Ok」プロンプトの安定判定は起動完了判定（`A>`+カーソル1文字まで）と同じ形をプレフィックス違いで適用した。
- シナリオは2つ。(a) beep: `BEEP`を`beepIntervalMs`（3000ms）ごとに打鍵し続けながら採取。(b) idle: `A>`プロンプトのまま何もせず採取。両方とも起動から独立した新規BrowserContextで行う。

### 短縮の申告

計画の目安「定常フレームは各条件5分以上」に対し、本計測は **beep=60秒・idle=60秒へ短縮した**（作業全体の時間制約のため）。実際の採取時間はJS側の壁時計で `actualCapturedMs` として記録しており、beepは67030ms（打鍵ループの実処理時間ぶん要求値より伸びた）、idleは60083msだった。

### 結果

dev server（Vite、port 5183）、Chrome headful、1回ずつの計測。

| シナリオ | tick数(標本数) | 実採取時間 | 中央値 | p90 | p95 | p99 | 最大 | MAD | underflow | 上限超過(trim) | 破棄サンプル数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| beep（BEEP 3秒間隔） | 5770 | 67030 ms | 82.234 ms | 91.408 ms | 93.89 ms | 98.373 ms | 167.891 ms | 5.204 ms | 4082 | 1 | 7201 |
| idle（無音） | 5153 | 60083 ms | 88.299 ms | 121.306 ms | 162.195 ms | 201.026 ms | 223.424 ms | 7.029 ms | 0 | 0 | 0 |

両シナリオとも起動は成功（1回ずつ、20/20のような反復成功率ではなく単発）。beep区間ではunderflowが4082フレーム、上限超過(trim)が1回、破棄サンプルが7201件（約163ms相当）発生した。idle区間ではいずれも0件だった。

beep区間のunderflowは、`BEEP`実行の合間に打鍵（`typeLineAndEnter`のkeydown/keyup、各35ms間隔）を送り続けている影響が疑われるが、原因は未調査のまま記録する。idle区間はp99(201ms)がbeep区間のp99(98ms)よりかなり大きく裾が長い一方、underflow/trim/droppedはいずれも0で、キュー滞留量が変動するだけで欠落・破棄には至っていない。

生サンプルは `_local/measure/audio-main.json`（gitignore対象、`rawLog`に全tickの時系列を含む）に保存した。

### 測定系の検証（陽性対照つき故障注入）

`docs/STORAGE-SCSI.md` の当該行が指定する2故障を、`scripts/measure-audio.mjs --fault=` で実装した。故障注入コードは全て `import.meta.env.DEV` 限定のデバッグ経路（`src/audio.ts` の `AudioEngine.faultDropNextChunk()`/`faultDelayReportSec()`、AudioWorklet内の `fault-drop-chunk` メッセージハンドラ）にあり、本番ビルドには含まれない。

- **`delay-200ms`（測定経路へ既知の200ms遅延）**: 実装1回目は、tickメッセージの`q`（キュー滞留秒）そのものへオフセットを加算する形にした。ところが`q`はAudioEngineの`queuedSeconds`として`main.ts`の`loop()`のフレームペース調整（`err = queued - TARGET_LATENCY_SEC`で供給間隔を補正する箇所）にも使われており、そこにオフセットが漏れて実際の再生ペースまで変えてしまい、フィードバックで一部相殺された。実測で200ms注入時の分布移動幅が128.75msにしかならず、この誤りが発覚した。`faultDelayReportSec()`をAudioEngine側（JS側ログへ積む直前の値にだけ加算し、`queuedSec`自体は変えない）へ直したところ、移動幅は207.687msとなった。
- **`drop-chunk`（1チャンクを捨てて欠音カウンタが検出）**: `faultDropNextChunk()`でAudioWorkletへ次に到着する1チャンクを丸ごと捨てさせ、`dropped`カウンタが増えることを確認した。

各故障の前に、故障なしの正常系（陽性対照）が成功することを確認した上で故障を注入した。

| 故障 | 陽性対照 | 故障注入時の観測 | 判定 |
| --- | --- | --- | --- |
| `delay-200ms` | 成功（標本数685、中央値99.161ms） | 標本数691、中央値306.848ms、移動幅207.687ms（許容±40ms） | 期待どおり検出 |
| `drop-chunk` | 成功（標本数822、dropped=0） | dropped=8408（0から増加） | 期待どおり検出 |

「常に失敗する検出器も故障注入を通過する」問題を避けるため、両方とも陽性対照（故障なしで異常が出ない）が成功していることを確認した上で判定している。`delay-200ms`は当初の誤実装（測定経路のつもりが実際の再生ペースまで変えていた）を陽性対照だけでは検出できず、期待値（約200ms）との比較で初めて気づいた。これは「値が全く動かない」ではなく「動くが期待値からずれる」誤りであり、故障注入の効果量を具体的な期待値と突き合わせることの必要性を示す実例になった。

生サンプルは `_local/measure/audio-fault-delay200.json` / `_local/measure/audio-fault-dropchunk.json`（gitignore対象）に保存した。

### (2) 物理音声出力の端点間遅延：自動化できないため手順のみ

計測計画の「音声遅延」行(2)は自動化できない。実施する場合の手順を書き残す。

- **機材**: 固定した出力機器（スピーカーまたはヘッドホン出力）と、それを録音できるオーディオインターフェースまたはマイク。サンプルレートは既知のものを使い、録音側の遅延（バッファサイズ由来）を別途把握しておく。
- **手順**: (1) 録音を開始する。(2) 既知の基準音（例: クリック音、または本計測のBEEP自体を電気的/音響的な基準として使う）を鳴らすキー操作（`BASIC2\BASIC`→`BEEP`）を実行し、Node側の `performance.now()` 等でキー送出時刻を記録する。(3) 録音波形上でBEEP音の立ち上がりを人が確認し、その時刻とキー送出時刻の差を端点間遅延とする。(4) 複数回（計画に合わせて30回程度）繰り返し、分布を記録する。
- **判定基準**: 欠音（無音のはずの区間に音が無い/鳴るはずの区間に無音が続く）が0件であること。端点間遅延の中央値・p95・p99・最大・時系列ドリフトを、内部キュー(qSec)の値と別々の結果として保持し、混同しない。
- **測定系の検証**: 出力をミュートした状態で同じ手順を実行し、「録音に何も写らない＝失敗」を確実に検出できることを事前に確認する。ミュートしたまま成功扱いになる実装（例: 録音の無音区間を「基準音が小さかっただけ」と誤判定する）を作らないこと。

### 合格判定

計測計画の合格条件「欠音0を必須とし、端点間遅延とqueuedSecそれぞれの中央値・p95・p99・最大・時系列ドリフトが移行後もA/A反復誤差内で、新しい周期的スパイクがないこと」のうち、今回評価できたのは(1)のqueuedSecのみである。

- **欠音0**: idle区間はunderflow/trim/dropped全て0で満たした。**beep区間はunderflowが4082件・破棄が7201サンプル発生しており、「欠音0」を満たしていない。** これは移行前の実測値としてそのまま記録する（原因未調査、後述）。
- **A/A反復誤差との比較**: 今回は単発測定であり、比較対象となる別日のA/A再測定を行っていないため、回帰判定（「A/A反復誤差内に収まること」）はまだ評価できない。
- (2)端点間遅延は未実施のため評価対象外。

### 未確認・限界

- **(2)物理音声出力の端点間遅延は未計測**。上記手順に沿った人手測定が別途必要。
- beep区間で観測されたunderflow(4082件)・trim(1件)・破棄(7201サンプル)の原因は未調査。打鍵ループ自体の影響か、BEEP発音そのものの特性か、切り分けていない。
- 本計測はbeep/idleとも1回ずつの単発測定であり、A/A反復誤差はまだ確立していない（実行順序の手順7に対応する作業は未着手）。
- 定常区間は計画の目安5分に対し60秒へ短縮した（上記「短縮の申告」参照）。
- 本計測はdev serverのみで行った。prodでの計測は、既存の起動時間・キー入力計測と同じ理由（`window.__webx68kDebug`が`import.meta.env.DEV`限定）で成立せず、着手していない。
- BEEPの打鍵間隔（3000ms）・保持時間（35ms）は計測スクリプトが決め打ちした値であり、実際のゲーム/アプリの音声パターンを代表するものではない。
- 音声振幅プローブ（`readAudioProbe`）とキュープローブ（`startQueueProbe`等）は別々の受動的フックであり、本計測ではキュープローブのみ使用した。振幅プローブは「予備確認：音を出す固定操作の有無」でのみ使っている。

### 追記：beep区間underflow(4082件)の原因切り分け（実測）

上記「beep区間ではunderflowが4082フレーム…発生した（原因未調査）」を受けて、原因切り分けを行った。**この節で追加の修正は行っていない**（下記「結論」参照）。コミットは `9a3f97c`（本節を追記した時点）。

#### まず疑った点：カウンタの単位

報告時点で「キュー中央値82.2ms（常時80ms分溜まっている）」と「標本5770に対しunderflow 4082件（7割で枯渇）」が矛盾して見えたが、これは**単位の取り違え**だった。`underflow`は`src/audio.ts`の`WebX68kAudioProcessor.process()`内、`for (let i=0; i<frames; i++)`ループの**1オーディオサンプルフレームごと**に、`this._queue.length===0`のとき加算するカウンタである（1ティック=4ブロック=最大512フレームぶん増える余地がある）。一方「標本5770」は約11.6msごとに送られる**tick報告の回数**であり、単位が全く違う。実フレーム換算では、beep区間の4082フレーム/実採取時間67030ms(≒44100Hz×67.03s=2,955,033フレーム)は **0.14%（時間にして約92.6ms）** であり、「7割のティックで枯渇」ではない。カウンタの意味自体は実装どおりで、誤りではなかった（`--fault=drop-chunk`の陽性対照つき故障注入で検出動作も確認済み・既存節参照）。

#### underflowの時系列分布

診断用に`stopQueueProbe()`の生ログ（`{tMs, qSec, underflow, trimEvents, dropped}`の時系列、累積値）を保存し、tickごとの`underflow`差分を計算した（診断専用の使い捨てスクリプトで実施、リポジトリには残していない）。

- **起動直後に必ず1件、巨大な差分（55万〜61万フレーム、22100Hzでの標本換算では約12〜14秒相当）が出る。** これは`AudioEngine.startQueueProbe()`が`queueProbeActive=true`にした直後に`resetQueueProbe`をworkletへpostMessageする実装のため、**resetがworklet側に反映される直前の1件のtick報告（起動〜BASIC起動完了までの無音期間を含む、リセット前の累積値）がログに紛れ込む**ためと判明した（境界条件のレースであり、実装のバグ）。ただし直後のtickでは`underflow`の生値がこの巨大値から小さい値へ非単調に落ち込んでおり、resetは実際には数ティック以内に反映されている。`summarizeQueueLog()`が読むのは**最終tickの累積値**なので、この起動直後の1件だけが最終値を汚染することはない（=公式基準値4082はこの起動時レースの影響を受けていない）。ただし短い計測窓では最終値がこの巨大値のまま終わってしまうリスクがあり、`startQueueProbe()`自体のレースは実装上の欠陥として残る。
- **起動時の1件を除くと、underflowは全ティックに均等に分布せず、ごく少数（全体の0.1〜0.8%のティック）に集中して発生する。** 30秒の再現試行では、健全な区間が20秒以上続いた後、数百ms未満の短いバーストが1〜数回起きるだけだった。

#### 実験設計：A/B/C 3条件＋負荷変更条件

既存のbeep/idleには「BASICが動いているか」と「音を出しているか」の交絡があったため、以下で切り分けた（各30秒、dev server）。

| 条件 | ゲストの状態 | 打鍵ループ | underflow(実質、起動時レースの1件を除く) | trim | dropped |
| --- | --- | --- | ---: | ---: | ---: |
| A（既存idle、参考） | Human68kプロンプト放置 | なし | 0 | 0 | 0 |
| B（新規） | BASIC起動して放置 | なし | 0 | 1 | 7687 |
| C（新規、既存beepと同条件） | BASIC起動してBEEP、3秒間隔・打鍵35ms間隔 | あり | 537（33.5秒中、1回のバースト） | 0 | 0 |
| C'（新規、打鍵を0ms間隔に圧縮） | BASIC起動してBEEP、8秒間隔・打鍵0ms間隔 | あり（同一作業をより短時間に圧縮） | 10354（32.2秒中、1回の大きいバースト≒235ms） | 2 | 14613 |

**A/Bの差 = 0（BASICが動いているだけでは欠音しない）。B/Cの差 = 打鍵ループが動いているときだけ非0になる。** さらにC→C'（打鍵の総量は同じだが1回あたりの待ち時間を35ms→0msへ圧縮し、メインスレッドを譲る回数を減らした）で欠音が約19倍に悪化した。これは「打鍵の量」ではなく「打鍵をメインスレッドにどれだけ間断なく詰め込むか」がunderflowを左右することを示す介入結果であり、消去法ではなく実際に負荷パターンを変えて確認した。

#### 結論と根拠

1. **カウンタの誤りではない**：実装を確認した限り、underflowは定義どおり「無音で出力された実フレーム数」を数えており、故障注入でも正しく検出できている。「7割で枯渇」という当初の印象は、フレーム単位のカウンタをティック単位の標本数と直接比較した誤解によるもの。実際の欠音は67秒中約92.6ms（0.14%）で、規模はごく小さい。
2. **観測された欠音は実在する**（ゼロではない）。ただし規模は小さく、起動直後の1件（レースによる測定ノイズ、公式基準値には影響しない）を除けば、健全な区間が長く続く中に短いバーストが数回入るだけである。
3. **バーストの発生条件は、計測スクリプト自身が送り続けている合成キーストローク（`typeLineAndEnter`のkeydown/keyup dispatch）と強く相関する**（A/B=0件・C/C'>0件、かつ打鍵を圧縮するほど悪化）。エミュレーションコアの音声生成とDOMイベント処理が同一メインスレッド上で競合しているためと推測されるが、これは「合成入力だから起きる」のではなく「メインスレッドが一定時間内に間断なく処理要求を受けると音声供給が止まる」という**実装の一般的な性質**であり、実プレイヤーの高速連打や他の重い処理でも同種の事象が起き得る。

この2点（バーストは実在するが、この計測シナリオでの発生条件は計測スクリプトの打鍵パターンに強く依存する）は、上記の分類のうち**「2: 実際に欠音している」と「3: 計測行為が誘発している」の両方に部分的に該当し、どちらか一方には切り分けられなかった**。「打鍵ループを止めれば0になる」と断定するにはBEEP音そのもの（打鍵なしで発音させる別経路）を分離した対照が必要で、今回は用意できていない。したがって、依頼どおり**ここで機械的な修正（カウンタ変更・打鍵間隔の変更・基準値の書き換え）へは進まず、切り分け結果の報告に留める**。基準値4082件・7201サンプルは「原因未調査」から「原因の当たりは付いたが根治には追加切り分けが必要」へ更新した上で、既存の記載はそのまま凍結する。

#### 未確認・限界

- BEEP音の発生を打鍵ループなしで行う経路（例: `window.__webx68kDebug`に音を直接鳴らすフックを足す等）を用意しておらず、「打鍵ループ」と「BEEP発音そのもの」を完全には分離できていない。
- `AudioEngine.startQueueProbe()`の起動直後1ティックに旧値が紛れ込むレースは実装上の欠陥として存在を確認したが、今回は修正していない（公式基準値には影響しないため優先度は低いと判断したが、判断者の確認は要る）。
- 今回の切り分けは診断用の使い捨てスクリプトで行い、生ログは`_local/measure/`配下（gitignore対象）に残しているのみで、リポジトリにはコミットしていない。`scripts/measure-audio.mjs`本体・基準値・生成物は変更していない。
- A/B/C/C'は各1回・30秒ずつの単発計測であり、67秒の公式beep計測（4082件）と直接一致する数字ではない（試行間ばらつきの範囲か、時間が長いほどバースト回数が増えるだけかは未確認）。
- 主犯候補（メインスレッド競合）を裏付ける追加証拠（例: `performance.now()`ベースのメインスレッドブロッキング時間を直接計測する）は取得していない。バーストの複数tickが同一`tMs`で記録されている観測（メインスレッドが一定時間止まった後にまとめて処理された痕跡）を根拠にしているが、直接計測ではない。

## 移行前基準値の現状サマリ

目的A（起動、3ドライブ、キー入力、音声）の4項目について、現時点で取得済みのものと未取得のものを整理する。

| 項目 | 取得済み | 凍結可否 | 未取得・残課題 |
| --- | --- | --- | --- |
| Human68k起動 | dev、20/20成功、中央値25832ms（基準値節）。作業0でdev単独サーバ10/10×2条件（プローブ有無）も追加取得。 | 単発値としては記録済み。回帰判定の基準として凍結するには、別日のA/A再測定が必要（未実施）。 | prod計測はブリッジ経由で別途取得済み（「本番ビルドの起動時間」節）だが、dev値と単純比較しない前提が要る。別日のA/A再測定、iOS実機は未着手。 |
| 3ドライブ認識 | 全試行成功、応答時間分布を記録済み。故障注入（欠落・取り違え）も陽性対照つきで確認済み。 | 単発値としては記録済み。同上、別日A/A再測定が必要。 | HDD起動構成でのドライブレター割当は未確認（FDD起動構成のみ実測）。 |
| キー入力の末端到達 | dev、2回×30刺激、KeyBuf/TVRAM双方で欠落・誤字・重複0。故障注入3件を陽性対照つきで確認済み。 | 単発（2回）値としては記録済み。同上、別日A/A再測定が必要。 | 物理キーボードでの固定文字列・Shift付き記号・長押し・blur/visibility後の解放は未実施（自動計測は合成KeyboardEvent経由でDOM `code`を通るのみ）。全キー網羅もしていない（6キーのみ）。 |
| 音声遅延 | dev、内部キュー(queuedSec)の時系列・分布・underflow/trim/dropped件数をbeep/idle各1回（60秒ずつ、計画の5分から短縮）取得。故障注入2件を陽性対照つきで確認済み。 | (1)内部キューは単発値として記録済み。同上、別日A/A再測定が必要。beep区間で欠音0を満たしていない事実も含めて凍結する。 | (2)物理音声出力の端点間遅延は完全に未実施（手順のみ記録）。プローブのdev計測への影響は作業0で確認済み（有意な悪化なし）。 |

**凍結できるもの**: 4項目とも、dev環境・今回のfixture・今回のブラウザ/端末条件での単発の実測値と、それぞれの測定系検証（故障注入・陽性対照）は取得済みである。「移行後の回帰なし」判定に必要な「A/A反復誤差」はどの項目についてもまだ算出できていない。

**未取得のまま残るもの**（計画の実行順序4・7に相当）:
- 別日のA/A再測定（4項目共通）。反復誤差が無いと、移行後の値と比較しても「悪化した」のか「元々のばらつきの範囲」なのか判定できない。
- prod（本番ビルド）での計測。起動時間のみブリッジ経由で別途取得済みだが、3ドライブ・キー入力・音声はdev限定APIに依存しており未着手。
- 物理キーボードでの手動確認（キー入力）。
- 物理音声出力の端点間遅延（音声遅延の(2)）。
- iOS実機での確認（画面ロック、バックグラウンド復帰、実スピーカー等、目的Bの範囲だが目的Aの一般化可能性にも関わる）。

これらが揃うまでは、今回の4項目の実測値は「移行前の一時点のスナップショット」として扱い、移行後の値との単純比較による合否判定には使わないこととする。
