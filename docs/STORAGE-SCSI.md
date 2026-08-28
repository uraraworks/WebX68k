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

**移行戦略(2026-08-28、ユーザーと合意)**: 手順4以降は新しい Worker 経路を `?worker=1` の裏に作り、**既定は現行のメインスレッド経路のまま**にする。両方を同居させ、実ハーネス(起動・3ドライブ・キー入力)で移行前基準を満たしたら既定を入れ替える。上の手順9が「最後に同期 host と旧スケジューラを除去する」と書いているとおり、最後まで同居する前提の設計である。手順4のスケルトン実装(`src/core-worker.ts`、`WorkerCoreProxy`)はこの方針で導入し、`?worker=1` を指定しない既定の挙動には一切影響させていない。

### 未決事項

- **A. 映像経路(OffscreenCanvas直描画 vs 転送)**: **2026-08-28、転送方式(メイン側 canvas を維持)＋バッファ返却を採用と決定した。** 理由は速度ではなく**可否**である。OffscreenCanvas方式は (1) `getImageData()` によるscreenHash相当の直接読み取りがmain側で恒久的に不可能になり`toDataURL()`経由への設計変更が要る、(2) Worker再生成のたびに新しいcanvas要素への差し替えが必須になる、という2点が、アスペクト補正・`rescale()`・フルスクリーン・仮想パッドのオーバーレイ・スクリーンショットが全て現在のcanvas要素を参照している現状の実装へ手順9(再生成と異常系)まで波及するため、採らないことにした。速度は両方式で優劣が付かなかった(「Aの追測」節: `setInterval`下でも3条件とも55.5Hz達成率95〜100%で明確な差が無く、転送方式のmain側コストはフレーム予算の3%程度で軽微)。**バッファ返却は採用するが、期待した効果は確認できなかったことをここに正直に記録する。** 87MB/秒の`ArrayBuffer`確保が消えること自体は事実だが、GC由来と見られる散発的なmaxスパイクは減らず、返却ありの試行でむしろ最大値(194.2ms)が出た(「Aの追測」節参照)。`poolMisses`による検査は正しく機能している(返却を意図的に止めた故障注入で`88=88`の完全一致を検出済み)ため、これは「検査が効いたうえで効果が無かった」という否定である。
- **B. `frame` event の間引き・背圧**: **2026-08-28、当面は設けずに始めると決定した。** デューティ比22%の負荷(main40msビジーループ・周期180ms)で取りこぼし0・遅延p95約33msに収まっており、間引き・背圧の仕組みが無くても即座には破綻しない。**破綻閾値(どこまで負荷を上げると破綻するか)は未測定のまま宿題として残る。**
- **C. Worker のスケジューラ**: **2026-08-28、`setInterval` ＋ 取り戻し(accumulator + budget)を採用すると決定した。** 今回の測定で分かった最も実装に効く事実は、**素のタイマーはどちらも不十分**ということである。`setTimeout`の固定delayは系統的にドリフトし(5秒で+800ms超)、`setInterval`はドリフトしない(5秒でほぼ0)一方、**遅れた回を取り戻さない**(`setInterval`に切り替えた後の追測でも、発火した回の間隔はmean 18.06〜19.10ms(目標18.018msに近い)と正確なのに、333フレーム中の提示フレーム総数は94.6〜100%にとどまり、散発的なmax(37.7〜191.4ms)が数フレーム分の欠落を生んでいるとみられる)。現行のメインループは `computeFrameBudget()`(src/frameBudget.ts)で遅れを検出し1ティックで複数フレームぶん走らせて取り戻しており、実アプリが55.5fpsを維持できているのはこの「取り戻し」があるためである。**したがって Worker のループにも同種の取り戻しの仕組みを持ち込む必要がある。** 残差(達成率95〜99%にとどまる分の原因)は特定できていない。**プローブでの追跡はここで打ち切り、実装後に実ハーネス(起動・3ドライブ・キー入力)で判定する方針とする**(プローブは合成負荷であり、実コアの負荷特性とは異なるため)。
- ゲームパッドを独立タイマーで poll するか、受信した `frame` event を契機に poll するかは未決。Worker 内の `input_poll` からメインへ同期問い合わせはしない。
- HDD の OPFS ID/stream API、既存 IndexedDB からの移行、FDD 全量イメージのメイン側保持方針はストレージ方式の決定に依存するため未決。
- `_retro_deinit` を正常終了で呼ぶべきかは、**2026-08-28、呼ばないと決定した**(Worker ごと terminate するため。手順9で改めて判断する)。現在未使用の `loadGameNone()` / `unloadGame()` は、**2026-08-28、`LibretroHostProxy` から削除すると決定した**(`src/main.ts` から未使用であり外部利用も確認できないため)。`CoreHostSurface`(実体 `LibretroHost` との構造チェック)と `LibretroHost` 自体には引き続き残す。テスト用 export を本番 proxy に残すかは未決のまま。
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

生サンプルは `_local/measure/audio-main.json`（gitignore対象）に保存した。**当初「`rawLog`に全tickの時系列を含む」と記載していたが、これは事実と異なる。** `scripts/measure-audio.mjs` は `stripRawLog()` で時系列を取り除いた結果だけを書き出しており、生ログは保存されていない（「A/A再測定：別日の2組目」節を参照）。

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

### 追記2：打鍵ゼロの対照（条件D）による切り分け決着、およびstartQueueProbeレースの修正（実測）

上記「未確認・限界」の1点目（打鍵ループなしでBEEPを鳴らす経路が無い）を解消し、計測窓中の打鍵をゼロにした対照（条件D）で切り分けを決着させた。あわせて2点目のレース（`AudioEngine.startQueueProbe()`起動直後の巨大差分）を修正した。コミットは本節を追記した時点のもの。

#### 作業1：打鍵なしでBEEPが鳴り続けるfixture

X-BASICで次の1行を投入し `RUN` するだけで、以後は打鍵なしに音が鳴り続けることを確認した。

```
10 BEEP:GOTO 10
```

- 最初に `FOR N=1 TO 200:NEXT N` のようなウェイトを挟む案を試したが、この用途では不要と判明した。`BEEP`は前の発音の減衰を待たずに次の`BEEP`が再トリガするため、`10 BEEP:GOTO 10`だけで実質的に鳴りっぱなしの連続音になる（後述の振幅プローブで確認）。
- 副産物として、X-BASICの`NEXT`に変数名を付ける（`NEXT I`はもちろん`NEXT N`でも）と「文末の記述が誤っています」の構文エラーになる現象を確認した（`NEXT`単体＝変数名なしなら通る）。`I`が複素数の虚数単位として予約されている可能性を疑ったが、`N`でも同じ結果だったため未解明のまま記録する。今回採用した1行構成はこの構文の癖を踏まないため実害はない。
- 打ち込み自体は打鍵を伴うため、**プログラム投入とRUNの打鍵をすべて終えてから計測窓を開く**。投入直後は音の立ち上がりが不安定な可能性を考慮し、RUN実行後に3000msのsettleを設けてから計測窓を開始する（settle長の根拠: 予備確認スクリプト（`_local/smoke.mjs`、使い捨てのため未コミット）で、RUN実行から約5秒後の時点までを1秒間隔×6回サンプリングし、いずれも振幅プローブが非無音を報告し続けていることを確認できたため、余裕を見て3000msとした）。
- **音が実際に鳴っていることを振幅プローブ（`?audioProbe=1`、`resetAudioProbe()`/`readAudioProbe()`）で確認した。** RUN実行から約5〜10秒後の区間を1秒間隔で6回サンプリングした結果、いずれも`maxAbs`が0.6〜0.82、`nonSilentCount`が`sampleCount`の99.99%以上（例: `sampleCount: 89040, nonSilentCount: 89032`）であり、区間を通してほぼ連続的に非無音であることを実測で確認した。「RUNしたから鳴っているはず」という推測ではなく、実測値として記録する。
- 無限ループを止める手段も確認した。DOM `code: 'Pause'`（`src/keyboard.ts`で`RETROK.PAUSE`→X68kスキャンコード`0x61`=BREAK）のkeydown/keyupを送ると、画面に「breakしました...10行」と表示されて`Ok`プロンプトへ戻ることを実測で確認した。各試行は新規BrowserContextのため機能的には必須ではないが、`scripts/measure-audio.mjs`の`collectLoopBeepProbe()`は計測窓を閉じた後（`stopQueueProbe()`の後、underflow等の計測結果には影響しない位置）でBREAKを送ってから後始末する。
- このfixtureは`scripts/measure-audio.mjs`に`--scenario=d`として実装し、コミットに含めた（`LOOP_BEEP_PROGRAM_LINE`/`LOOP_BEEP_SETTLE_MS`/`startLoopBeepProgram()`/`collectLoopBeepProbe()`/`breakLoopBeepProgram()`）。計測窓（`startQueueProbe()`〜`stopQueueProbe()`の間）では`sleep()`のみを行い、打鍵は一切行わない。

#### 作業2：`startQueueProbe()`のreset競合の修正

`AudioEngine.startQueueProbe()`が`queueProbeActive=true`にした直後に`resetQueueProbe`をworkletへpostMessageする実装だったため、リセットがworklet側に反映される前のtick（起動〜計測開始までの無音期間を含む累積値）が1件ログに紛れ込むレースが存在した（前節「追記」参照）。`src/audio.ts`を次のように修正した。

- worklet側は`resetQueueProbe`メッセージを処理した直後（カウンタを0にした直後）に`resetQueueProbeAck`を返すようにした。
- `AudioEngine.startQueueProbe()`は`resetQueueProbe`を送った後、`resetQueueProbeAck`を受け取るまで`queueProbeActive`を`false`のままにして待ち、ackを受け取ってから`true`にするよう`async`化した。同一方向（worklet→main）のpostMessageは送出順に配送されるため、ackより後に届く`tick`は必ずリセット後の値になる。

**修正が効いていることを実測で確認した。** 診断用の使い捨てスクリプト（`_local/probe-race-check.mjs`、未コミット）で、起動後5秒間無音のまま待ってから`startQueueProbe()`→2秒間採取→`stopQueueProbe()`を行い、先頭5件の`underflow`を比較した。

| 状態 | 先頭5件のunderflow |
| --- | --- |
| 修正前（`git stash`で`src/audio.ts`を一時的に戻して再現） | `[704789, 0, 0, 0, 0]`（起動直後の無音期間ぶんの巨大値が1件目に紛れ込む） |
| 修正後（現状のコード） | `[0, 0, 0, 0, 0]`（巨大差分が出ない） |

修正前は既存の記述どおり「起動直後に必ず1件、巨大な差分が出る」ことを再現でき、修正後は同じ手順で0件になることを確認した。`git stash pop`で修正を戻し、`scripts/measure-audio.mjs`のTypeScript型チェック（`npx tsc --noEmit`）も通ることを確認済み。

#### 作業3：条件Dの計測結果と結論

`scripts/measure-audio.mjs --scenario=d --loopbeep-duration=60000`で60秒間（実採取60358ms）採取した。

| 条件 | 内容 | 実採取時間 | underflow | 実フレーム換算 |
| --- | --- | ---: | ---: | ---: |
| D（打鍵ゼロ、`10 BEEP:GOTO 10`常時発音） | 計測窓中の打鍵0 | 60358 ms | **8788** | 約199.3ms（0.330%） |
| C（既存、打鍵ありBEEP、参考。前節「基準値：音声遅延」の値をそのまま引用） | `BEEP`を3秒間隔で打鍵しながら採取 | 67030 ms | 4082 | 約92.6ms（0.138%） |

**Dはunderflowが0ではなかった。むしろ実フレーム換算の発生率はCよりも高い（0.330% > 0.138%、約2.4倍）。** これは「打鍵が原因」という仮説（前節の結論の一部）を積極的に否定する結果である。

##### 結論と根拠

1. **音を出すこと自体で欠音が起きている（結論2）。** 計測窓中に一切の打鍵を行わない条件Dでも、underflowが実測で発生した（8788フレーム、0.330%）。これは前節「未確認・限界」で「打鍵ループを止めれば0になるかは要検証」としていた点への直接的な回答であり、答えは「0にならない」だった。
2. Dのunderflow率がCより高いのは、条件Dの`10 BEEP:GOTO 10`が前の発音の減衰を待たずに次のBEEPを即再トリガする（振幅プローブで確認した「ほぼ常時非無音」）連続発音パターンであり、Cの「3秒間隔で単発BEEP」より音声生成の密度が高いためと推測される。ただしこれは推測であり、直接の追加検証（例: Dのbeep間隔を段階的に広げてunderflow率の変化を見る）はしていない。
3. 前節（追記）で見た「打鍵と相関する」という観測（A/B=0件、C/C'>0件）自体は事実として残るが、それは「打鍵が原因」を意味せず、「打鍵を伴う計測条件がたまたま音声生成の負荷も高かった」という交絡だった可能性が高い。条件Dは打鍵なしで音声生成の負荷（連続発音）だけを再現しており、それだけでunderflowが発生することを示した。

**依頼どおり、この結果を受けて修正へは進まず、事実の確定と原因の当たり（上記2点目の推測）までで報告し、ここで止める。** 基準値の取り直し（beep/idleのfixtureをDへ差し替える等）も、依頼の分岐（「D で underflow が0なら」）に該当しないため行っていない。既存の基準値（beep 4082件・67030ms、idle 0件・60083ms）は前節の記載のまま凍結し、変更していない。

##### 未確認・限界

- Dのunderflow率がCより高い理由（連続発音の密度差）は推測であり、beep間隔を変化させた追加実験はしていない。
- 条件Dは単発（1回・60秒）の計測であり、A/A反復誤差は未確立（他の基準値項目と同じ制約）。
- BEEP以外の音源（OPM等、同梱ディスクでは未確認）でも同様の欠音が起きるかは未確認。
- `startQueueProbe()`のレース修正はキュープローブという計測経路自体のバグ修正であり、AudioEngineの実際の再生経路（`push()`/`flush()`等）には触れていない。修正の影響範囲はdev限定の計測フックのみ。
- 診断用スクリプト（`_local/smoke.mjs`、`_local/probe-race-check.mjs`）は使い捨てのためリポジトリにコミットしていない（`_local/`はgitignore対象）。再現可能な形で残したのは`scripts/measure-audio.mjs --scenario=d`本体のみ。

## 移行前基準値の現状サマリ

目的A（起動、3ドライブ、キー入力、音声）の4項目について、現時点で取得済みのものと未取得のものを整理する。

| 項目 | 取得済み | 凍結可否 | 未取得・残課題 |
| --- | --- | --- | --- |
| Human68k起動 | dev、20/20成功、中央値25832ms（基準値節）。作業0でdev単独サーバ10/10×2条件（プローブ有無）も追加取得。 | 単発値としては記録済み。回帰判定の基準として凍結するには、別日のA/A再測定が必要（未実施）。 | prod計測はブリッジ経由で別途取得済み（「本番ビルドの起動時間」節）だが、dev値と単純比較しない前提が要る。別日のA/A再測定、iOS実機は未着手。 |
| 3ドライブ認識 | 全試行成功、応答時間分布を記録済み。故障注入（欠落・取り違え）も陽性対照つきで確認済み。 | 単発値としては記録済み。同上、別日A/A再測定が必要。 | HDD起動構成でのドライブレター割当は未確認（FDD起動構成のみ実測）。 |
| キー入力の末端到達 | dev、2回×30刺激、KeyBuf/TVRAM双方で欠落・誤字・重複0。故障注入3件を陽性対照つきで確認済み。 | 単発（2回）値としては記録済み。同上、別日A/A再測定が必要。 | 物理キーボードでの固定文字列・Shift付き記号・長押し・blur/visibility後の解放は未実施（自動計測は合成KeyboardEvent経由でDOM `code`を通るのみ）。全キー網羅もしていない（6キーのみ）。 |
| 音声遅延 | dev、内部キュー(queuedSec)の時系列・分布・underflow/trim/dropped件数をbeep/idle各1回（60秒ずつ、計画の5分から短縮）取得。故障注入2件を陽性対照つきで確認済み。打鍵ゼロの対照（条件D、`10 BEEP:GOTO 10`常時発音）も追加取得し、underflowはむしろbeep（打鍵あり）より高い率（0.330% vs 0.138%）で発生することを確認した（「追記2」参照）。 | (1)内部キューは単発値として記録済み。同上、別日A/A再測定が必要。beep区間・条件Dとも欠音0を満たしていない事実を含めて凍結する。「打鍵が原因」の仮説は条件Dの結果により否定され、「音を出すこと自体が原因」に切り分けが進んだため、beep/idleの基準値は取り直さず既存値のまま凍結する（依頼の分岐条件「Dで0なら取り直す」に該当しなかったため）。`AudioEngine.startQueueProbe()`の起動直後レース（巨大な決め打ち差分が紛れ込む実装バグ）は修正済み（修正前後の差を実測比較済み）。 | (2)物理音声出力の端点間遅延は完全に未実施（手順のみ記録）。プローブのdev計測への影響は作業0で確認済み（有意な悪化なし）。条件Dのunderflow率がbeepより高い理由（連続発音の密度差と推測）の直接検証は未実施。 |

**凍結できるもの**: 4項目とも、dev環境・今回のfixture・今回のブラウザ/端末条件での単発の実測値と、それぞれの測定系検証（故障注入・陽性対照）は取得済みである。「移行後の回帰なし」判定に必要な「A/A反復誤差」はどの項目についてもまだ算出できていない。

**未取得のまま残るもの**（計画の実行順序4・7に相当）:
- 別日のA/A再測定（4項目共通）。2026-08-17に取り直しの1組目を凍結ビルド `cbb19b8` で取得した（「移行前基準：1組目」節）。2組目は別日に同一ビルドで取る必要があり、それまで反復誤差は確定しない。計測系の欠陥3件は同日に対処済み（「計測系の修正」節）。
- prod（本番ビルド）での計測。起動時間のみブリッジ経由で別途取得済みだが、3ドライブ・キー入力・音声はdev限定APIに依存しており未着手。
- 物理キーボードでの手動確認（キー入力）。
- 物理音声出力の端点間遅延（音声遅延の(2)）。
- iOS実機での確認（画面ロック、バックグラウンド復帰、実スピーカー等、目的Bの範囲だが目的Aの一般化可能性にも関わる）。

これらが揃うまでは、今回の4項目の実測値は「移行前の一時点のスナップショット」として扱い、移行後の値との単純比較による合否判定には使わないこととする。

## 目的B実測：IndexedDBへのディスク全量書出し（実測）

目的Aの4項目とは別に、「移行前の基準値：計測計画」目的B表の「IndexedDBへのディスク全量書出し」を実測した。この節は比較用の試作を必要としないため、現行構成をそのまま測った。

### 計測点の追加

現行コードには区間計測が無いため、`src/storage-probe.ts` を新規追加し、`src/disk-store.ts`（`putDisk()`/`saveDisk()`）と `src/main.ts`（`persistSlotToLibrary()`）に計測点を足した。

- 始点は `persistSlotToLibrary()` が `readLiveSlotImage()` でMEMFSから吸い出し、`slice()` でコピーし終えた時刻（`bytesReadyAtMs`）。イメージ読出し呼出時でもUIへの保存要求時でもない。
- 終点は `putDisk()` 内の IndexedDB transaction の `oncomplete`（`putCompleteAtMs`）。
- `putDisk()` は計測時のみ `getKey()` で既存有無を確認し、初回追加(`isNewKey=true`)と同一key上書き(`isNewKey=false`)を分けて記録する。
- すべて `import.meta.env.DEV && storageProbe.enabled` の内側でのみ動作し、既定は `enabled=false`。`storageProbe.enabled` を立てない限り、通常の保存経路（`saveDisk()`)への追加コストは無い（後述の「常時コストの有無」参照）。

### 計測方法

- `scripts/measure-disk-save.mjs`（新規、コミット対象）。dev server（Vite、`--port=5193`。既存の他セッションが使う5183とは別ポート）をヘッドフル Puppeteer で操作した。
- UIの「ブランクHDDを作成(40MB・FAT16)」→「システムディスクで起動」で40MBのHDDをマウントし、`window.__webx68kDebug.storageProbeSaveSlot('hdd')` で `persistSlotToLibrary('hdd')` を直接叩いて反復した。
- 初回追加は毎試行前に `storageProbeDeleteFromLibrary()` でキーを削除してから1回保存、直後にもう1回保存して上書きを取る、を20回繰り返した（同一ブラウザセッション内、`storageProbe.enabled=true`）。
- rAF gap・long task は `PerformanceObserver({type:'longtask'})` と `requestAnimationFrame` ループをページ内で継続観測し、各試行の `[bytesReadyAtMs, putCompleteAtMs]` 区間に重なる分を切り出した。

### 結果（40MB HDD、dev、Chrome、20試行）

| | 初回追加 | 同一key上書き |
| --- | ---: | ---: |
| 成功 | 20/20 | 20/20 |
| 全体時間 中央値 | 201.3 ms | 311.8 ms |
| p95 | 348.7 ms | 460.5 ms |
| p99 | 362.8 ms | 693.6 ms |
| 最大 | 366.3 ms | 751.9 ms |
| 実効 MiB/s 中央値 | 198.8 | 128.3 |
| 同時期の最大rAF gap 中央値 | 66.0 ms | 83.3 ms |
| 同時期の最大rAF gap p99 | 143.8 ms | 190.6 ms |
| 同時期のlong task件数 中央値 | 1 | 1 |
| 同時期のlong task件数 最大 | 2 | 6 |

上書きが初回追加よりおよそ1.5倍遅い。`saveDisk()` は上書き時に既存メタデータ確認のため `getDisk()` を1回余分に呼んでおり（`src/disk-store.ts` 既存実装）、この差はその分と考えられるが、両者を分離した実測はしていない。

### 測定系の検証

- **陽性対照**: 故障を注入しない状態で `storageProbeSaveSlot('hdd')` を実行し、初回追加が37.4ms→37397ms台の実時間で成功、上書きも成功することを確認した（`_local/measure/disk-save-fault-abort.json` の `positiveControl`）。
- **transactionのabort**: `storageProbe.abortNextPut=true` を立てて `tx.abort()` を意図的に呼ぶ故障を5回注入した。5/5とも `putCompleteAtMs=null`、`aborted=true`、`storageProbeSaveSlot()` の戻り値も `false` となり、「未完了を成功扱いしない」ことを確認した。
  - 実装時に1点バグを見つけて修正した。当初 `tx.onerror` で `reject(tx.error)` していたが、`tx.abort()` 直後は `tx.error` がまだ `null` のことがあり、`aborted=false` のまま誤って「エラーなく終わった」ように記録されていた（`error: "null"` という文字列が出て気づいた）。終端判定を `oncomplete`/`onabort` の2つだけに絞り、`onerror` は記録専用にしたことで解消した。修正前後の差はコミット差分で確認できる。
- **末尾1byte破損の検出**: `putDisk()` 自体は正常完了させ、別途IndexedDBへ書いた1024byteのテストレコードの末尾1byteだけを変えたコピーを作り、FNV-1a checksumで比較した。オリジナル `2214824389` に対し破損後 `4110695336` となり、不一致を検出した（`_local/measure/disk-save-fault-corrupt.json`）。
- **quota不足の専用プロファイルによる故障注入は実施していない**。通常のブラウザプロファイルでquotaを再現よく枯渇させる手段がなく、専用プロファイル構築コストが計測本体に見合わないため省略した。

### 常時コストの有無

- `storageProbe.enabled=false`（既定）のとき、`putDisk()`/`persistSlotToLibrary()` の追加分岐はすべて `if` で素通りし、`getKey()` 呼び出しも発生しない。通常のディスク保存（オートセーブ含む）へのコスト追加は無い。
- `enabled=true`（計測時のみ）のときは、上書き判定用の `getKey()` が1回余計なIndexedDBラウンドトリップとして乗る。この計測自体は数十msのオーダーで、40MB本体の書き込み(数百ms)に対して支配的ではない。

## 目的B実測：起動時のRAM展開（実測）

### 計測点の追加

`src/storage-probe.ts` の `verifyBytes()`/`fnv1a()` と、`src/libretro-host.ts` に追加した `probedMemfsWrite()` で計測する。

- 対象は ROM(IPLROM/CGROM、`host.init()` 内)と FDD1/HDD(`host.writeDiskImage()`、ファイル名 `fdd1_*`/`hdd_*` で判別)。
- 始点は MEMFS `writeFile()` 呼び出し直前(`memfsWriteStartAtMs`)、終点はその戻り(`memfsWriteEndAtMs`)。加えて直後に `mod.FS.readFile()` で読み戻し、サイズ・末尾64byte・FNV-1a checksumの3系統で検査する(`verify`)。
- FDD1/HDDについては、ライブラリ(IndexedDB)からのロード(`insertFromLibrary()`)側にも計測点を足し、`getDisk()` 呼出直前から結果bytesを受け取るまでを `idbGetStartAtMs`/`idbGetEndAtMs` として記録する。
- すべて `import.meta.env.DEV && storageProbe.enabled` の内側。既定コストは無い（disk-save側と同じ作法）。

### 計測方法

- `scripts/measure-ram-expansion.mjs`（新規、コミット対象）。dev server `--port=5193` を使用。
- 毎試行、新規 BrowserContext で FDD1(1.23MB)・HDD(40MB)のブランクを作成してライブラリへ保存し、`storageProbeEjectSlot()` でスロットから追い出してから `storageProbeLoadFromLibrary()` で改めてライブラリ経由(=`getDisk()`経由)でロードし、「システムディスクで起動」した。
- **ツールのフォアグラウンド実行時間制約（Bashツールの上限10分）に収まるよう、反復回数を計画値の20回から8回に縮小した。** dev構成の1試行が新規BrowserContextでのcold起動(約24〜33秒、wasm取得・コンパイルとHuman68k起動を含む)を伴うため。

### 結果（dev、Chrome、8試行）

| 対象 | サイズ | MEMFS書込 中央値 | ms/MiB 中央値 | IndexedDB get 中央値 | 検証OK |
| --- | ---: | ---: | ---: | ---: | ---: |
| ROM(IPLROM) | 128 KiB | 36.2 ms | 289.9 | 対象外(下記注) | 8/8 |
| ROM(CGROM) | 768 KiB | 43.4 ms | 57.9 | 対象外(下記注) | 8/8 |
| FDD1 | 1232 KiB | 2.1 ms | 1.7 | 15.7 ms | 8/8 |
| HDD | 40 MiB | 49.2 ms | 1.2 | 231.9 ms | 8/8 |

起動時間(クリック〜プロンプト安定)の中央値は 25,951.5 ms（p95 31,181 ms）。ROM/FDD1/HDDのMEMFS書込・IndexedDB get合計の中央値はおよそ **378 ms**で、起動時間中央値に占める割合はFDD1で0.07%、HDDで1.08%だった（合算すると約1.5%）。

peak heap(`performance.memory.usedJSHeapSize`、Chrome限定の非標準API)は起動前後で中央値約49.6MiB増加した。ROM/FDD/HDD個別の寄与には分解していない。

ROM(IPLROM)がFDD1やHDDよりms/MiBで大きい(289.9 vs 1.2〜1.7)のは、MEMFS初回書き込み(mod初期化直後、最初のFS操作)固有のウォームアップコストと考えられる。他の可能性を排除できておらず推測にとどまる。

**ROMのIndexedDB get区間は測定していない。** 既定構成では同梱ROMをnetwork fetchするため、この経路を通らない。ユーザーが独自ROMをアップロード済みの場合の経路は未検証。

### 測定系の検証

各故障はROM(IPLROM)書込みを対象に、故障なしの最小起動(FDD1/HDD無し)を陽性対照として先に確認してから注入した。

- **陽性対照**: `sizeMatch=true, tailMatch=true, checksumMatch=true`(`verify.ok=true`)を3回とも(各故障注入の直前に1回ずつ)確認した。
- **MEMFS書込み省略(`skip-write`)**: 書込みをスキップして `readFile()` を試みると、ファイル自体が存在せず `verify.ok=false`(`actualByteLength=null`)を検出した。
- **末尾切り詰め(`truncate-tail`)**: 最終1byteを切ったデータを書き込むと `sizeMatch=false, tailMatch=false`(checksumも不一致)を検出した。
- **同サイズ別checksum(`corrupt-checksum`)**: 末尾64byte領域を避けて先頭寄りの1byteだけ反転させたデータを書き込むと、`sizeMatch=true, tailMatch=true` を保ったまま `checksumMatch=false` だけが単独で失敗し、checksum検査がサイズ・末尾検査と独立に機能することを確認した。
- **共通の副次的発見**: 3種類の故障ともROM破損後は `waitForBootPrompt()` がタイムアウトし(20秒キャップ)、Human68kのプロンプトへ到達しなかった。検証・記録自体は `host.init()` 内の同期区間で書込み直後に完了しているため、プロンプト到達を待たずにログを読むことで検出できた。副次的に、ROM破損はコアの起動処理自体を止めうることが分かった。これは計測点を「起動完了」ではなく「MEMFS書込み・検査完了」の地点に置くべきというドキュメントの定義が実務的にも正しいことの裏付けになった。

### 常時コストの有無

`storageProbe.enabled=false`(既定)のとき、`probedMemfsWrite()` は分岐の先頭で `mod.FS.writeFile(path, data); return;` のみを実行し、通常の起動経路(`host.init()`・`writeDiskImage()`)へ追加コストは無い。

### 未確認・限界

- **反復回数は計画の20回でなく8回**。フォアグラウンド実行時間の制約による。20回への拡張は同スクリプトの `--runs=20` で可能だが、8試行の分布(p95/p99と中央値の乖離)を見る限り大きな裾は見えていない。
- 起動時間中央値25.9秒は**dev serverでの値かつwasm取得・コンパイルを含む**。「基準値：起動所要時間」節と同じ制約であり、本番ビルドでの割合は別途測る必要がある。
- peak heapはROM/FDD/HDD別に分解できていない。Wasmヒープ専用の値でもない(Chrome限定の`performance.memory`はJSヒープ全体)。
- msPerMiBの試行間ばらつき(特にROM)の原因は推測のみで、直接検証(例: 2回目以降の書込みだけを測る等)は行っていない。

## 目的B実測：フレーム時間の分布（実測）

計測計画「目的B」表「フレーム時間の分布」行の定義に従い、解像度・fps・dupe frame有無ごとの `retro_run()` 完了間隔、video callbackのRGB565→RGBA変換時間、`putImageData()` 復帰までの時間、前面タブのrAF観測間隔、long task件数/秒を採取した。**この項目は毎フレームに計測点が乗るため、計測点自体のコストを先に実測してから、故障注入で測定系を検証し、最後に本計測を行った。**

### 予備確認：解像度切替コマンドの有無

`docs` の「共通条件と記録形式」で「切替用コマンドまたはディスクの準備可否は現時点で未確認」としていた点を確認した。Human68kのプロンプトから `BASIC2\BASIC` でX-BASIC(`BASIC.X` ver2.02、`Ok`プロンプト相当のロゴ画面)を起動できることは既知(「予備確認：音を出す固定操作の有無」節)だったため、続けて `SCREEN 0,0,0,1` / `SCREEN 1,0,0,1` / `SCREEN ,,,,1024` / `CONSOLE 0,0,1,0` の4コマンドを試した。いずれも実行後の `canvas.width/height` は768x512のまま変化せず、`frameProbe` の `videoEvents` にも新しい解像度は現れなかった。**このセッションからは解像度を明示的に切り替える手段を確認できなかった。** BASICロゴ画面表示中にコマンドが正しく`Ok`プロンプトへ届いていたかの切り分け(キー入力の末端到達を別途検証していない)を含め、これ以上の深掘りは行っていない。そのため、指示どおり無理に解像度条件を作らず、**起動シーケンス中に実際に発生する解像度遷移の範囲でのみ計測し、複数解像度の比較は取れなかった**。

### 計測点の追加

- `src/storage-probe.ts` に `frameProbe`(`FrameProbe`)を追加。`enabled`(既定false)、`busyWaitFaultEnabled`(既定false、測定系検証用)、`runEvents`(`retro_run()`区間)、`videoEvents`(video callback区間、dupe frameは`dupe:true`のみ記録)、`rafSamples`(観測専用rAFチェーンの発火時刻)、`longTasks`(`PerformanceObserver('longtask')`)を持つ。
- `src/libretro-host.ts` の `runFrame()` に `frameProbe.enabled` 時だけ `retro_run()` 直前・直後の時刻を記録する分岐を追加。同じ分岐内で、`busyWaitFaultEnabled` かつ60フレームごとに同期busy wait(50ms)を注入する(測定系検証専用、無効時はこの分岐自体を通らない)。
- 同ファイルの `handleVideoRefresh()` に、RGB565→RGBA変換ループの前後、`putImageData()` 呼び出しの前後の時刻を記録する分岐を追加。dupe frame(`data===0`)は変換・putImageDataが発生しないため、その旨だけ記録する。
- `src/main.ts` に、駆動ループ(`scheduleNext`/`enterLoop`、rAFとsetTimeoutの競争)とは別の、観測専用の独立した `requestAnimationFrame` チェーンを追加(`frameProbeRafTick()`)。駆動用タイマーの発火順に影響されず「前面タブが実際にrAFを発火できた間隔」だけを見るためにあえて分離した。`frameProbeEnable(true)` で同時に `PerformanceObserver({entryTypes:['longtask']})` も起動する。
- すべて `import.meta.env.DEV` の内側、既定 `enabled=false` で分岐冒頭に置き、無効時は本番経路へ計測コードを混ぜない(storageProbeと同じ作法)。

### 計測方法

- `scripts/measure-frame-timing.mjs`(新規、コミット対象)。`--mode=main|cost|fault` の3モードを持つ。3モードとも、アプリ内蔵の `frameProbe` とは別に、Puppeteerの `evaluateOnNewDocument()` で常時有効な外部オラクル(独立rAFチェーンと `longtask` observer)をページ読込み直後から注入し、`frameProbe` のon/offに影響されない値も同時に採る。
- 起動完了(Human68kプロンプト到達)前後で `performance.now()` の境界(`promptAtMs`)を取り、「起動シーケンス中(ROM/フォント読込み等の重い同期処理を含む)」と「起動完了後の定常状態(観測窓 `--duration-ms`、既定12000ms)」を分けて集計する。起動中の重い処理が定常状態の分布へ混入しないようにするため。
- `--mode=cost`: `frameProbe` 無効/有効それぞれで起動し、定常窓での外部オラクルのrAF間隔・long task数を比較する。
- `--mode=fault`: `busyWaitFaultEnabled=false` の陽性対照を先に採り、その後 `true` にした故障注入試行を採る。両者とも定常窓のみで比較し、rAF間隔(外部)・canvas末端時間(`putImageData()`復帰の間隔)・long task数・予算超過率(1フレーム目標時間=`1000/fps`を超えた割合)の4指標に裾が現れるかを判定する。
- ツールのフォアグラウンド実行時間制約に収まるよう、各モード1試行(観測窓8000ms)のみ実行した。反復による分布の安定性は未確認(下記「未確認・限界」)。

### 結果（dev、Chrome、各モード1試行、観測窓8000ms、解像度768x512@55.5のみ）

起動中に `768x512@61.46fps`(IPL/初期画面、5フレームのみ)→`768x512@55.5fps`(Human68kプロンプト以降)の1回だけ遷移が観測された。それ以外の解像度遷移は無く、dupe frameは0件だった。**解像度別の比較は「取れなかった」**(上記予備確認のとおり)。以下は起動完了後の定常状態(768x512@55.5fps、目標フレーム間隔=budget=18.018ms)の値。

| 指標 | 中央値 | p95 | p99 | 最大 | サンプル数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| retro_run()完了間隔 | 18.09ms | 26.3ms | 28.09ms | 32.73ms | 439 |
| RGB565→RGBA変換 | 1.62ms | 1.71ms | 1.76ms | 2.98ms | 440 |
| putImageData()復帰 | 0.07ms | 0.105ms | 0.125ms | 0.30ms | 440 |
| rAF観測間隔(内蔵) | 16.67ms | 20.34ms | 21.54ms | 33.97ms | 479 |
| rAF観測間隔(外部オラクル) | 16.67ms | 20.22ms | 21.72ms | 56.27ms | 481 |

フレーム予算(18.018ms)超過率は **50.1%**。long taskは定常状態8秒間で0件(起動シーケンス中には8秒観測窓の別試行で62件発生しており、long taskは起動フェーズに集中し定常状態にはほぼ現れなかった)。起動時間はこの試行で28,594ms(dev、wasm取得・コンパイル込み。「基準値：起動所要時間」節と同じ制約)。

変換・putImageDataの所要時間はどちらも極めて小さい(中央値1.62ms/0.07ms)一方、retro_run()完了間隔の中央値(18.09ms)はコアの目標フレーム間隔(18.018ms)とほぼ一致しつつ、約半数のフレームがこれを超過している。これはコアの55.5fps(1フレーム18.018ms)と、ブラウザのrAF/表示周期(観測間隔中央値16.67ms、≒60Hz相当)が非整数比であることによる構造的なズレと整合する(詳細は後述の「結果から言えることと、まだ言えないこと」)。

### 計測点のコスト（実測）

`--mode=cost` で、`frameProbe` 無効時と有効時それぞれの定常窓(8000ms)における外部オラクルのrAF間隔を比較した。

| 状態 | 中央値 | p95 | p99 | 最大 | long task数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| frameProbe無効 | 16.67ms | 20.23ms | 21.68ms | 49.66ms | 0 |
| frameProbe有効 | 16.67ms | 20.21ms | 22.85ms | 101.70ms | 1 |

中央値差は0%、p95差は-0.1%で、大勢としては「軽い」という結果になった。ただし有効時のみ最大値(101.7ms)とlong task(1件)が観測されており、**1試行だけでは常時無視できると断定しない**。既定off・分岐冒頭ガードという設計上、無効時に常時コストが乗らないことは実装(コードパス)としては保証できるが、有効時のコスト自体が試行間でどれだけ安定するかは1回の比較では確認できていない。

### 測定系の検証（陽性対照つき故障注入、実測）

`--mode=fault` で、陽性対照(busy wait注入なし)を先に確認してから、60フレームごと50msのbusy wait注入試行を行った(いずれも定常窓のみで比較)。

- **陽性対照**: `busyWaitInjectedCount=0`(注入が発生していないことを確認)。rAF間隔・canvas末端時間とも通常の分布(rAF外部p99 38.99ms、canvas末端p99 29.04ms)で、極端な値は無かった。
- **故障注入**: 8秒間で7回の注入(`busyWaitInjectedCount=7`、55.5fpsで約60フレームごとなら妥当な回数)。
  - rAF観測間隔(外部): p99が38.99ms→68.47ms、最大が136.66ms→333.45ms に伸び、**裾が現れた**。
  - canvas末端時間(putImageData復帰間隔): p99が29.04ms→55.03ms に伸び、**裾が現れた**(最大値は167.91ms→138.16msで逆に縮んでおり、p99での検出に依存している)。
  - long task件数: 1件→10件に増加し、**裾(発生数)が現れた**。
  - フレーム予算超過率: 49.09%→47.56%で、**裾が現れなかった**。busy wait注入試行のほうがむしろ低い。

**4指標のうち「フレーム予算超過率」は故障注入に反応しなかった。** 上記「結果」で述べたとおり、この構成では故障を入れない定常状態でも超過率が約49〜50%と高く、既に上限付近で飽和気味になっている(rAF周期16.67msとコア目標間隔18.018msの構造的なズレが支配的)。50ms busy waitで影響を受けるフレームは8秒431サンプル中7フレーム程度に過ぎず、この指標(単一解像度の超過率という粗い集計)では埋もれてしまうと考えられる。**この指標はこの故障の検出には向いていない**、というのがそのままの結論であり、閾値や集計方法を緩めて「検出できた」ことにはしていない。

### 未確認・限界

- **各モード1試行のみ**。フォアグラウンド実行時間の制約により反復していない。分布の試行間ばらつき、A/A反復誤差は未確認。
- **解像度別の比較は取れなかった**。予備確認したX-BASICの`SCREEN`/`CONSOLE`系コマンドでは解像度が変わらず、起動シーケンス中に実際に発生した1回の遷移(61.46fps→55.5fps、同一768x512)以外の解像度データが無い。
- フレーム予算超過率は、故障注入試行での検出に失敗した(上記のとおり)。この指標を「解像度別の比較」や「Worker移行後の回帰判定」に使う場合は、集計方法(単一解像度の二値超過率でなく、超過量の分布を見る等)の見直しが要る。
- long task件数は、`frameProbe`内蔵observerと外部オラクルのobserverで別集計であり、両者を合算・突き合わせていない(重複計上ではないが、同じlong taskを2箇所で見ている可能性がある)。
- `putImageData()`復帰までを「canvas更新完了」として扱っており、物理的な表示時刻(モニタへの実際の描画)は計測していない。
- 計測点のコストは1回の比較のみで、中央値・p95では差が見えなかったが、最大値とlong task 1件の差は解釈材料が乏しい。反復による安定性確認は今後の課題として残す。
- 本結果はdev serverでの値であり、本番ビルドでの計測は行っていない(「本番ビルドでの計測は現時点で成立しない」節と同じ制約が当てはまるかは未確認)。

## 結果から言えることと、まだ言えないこと

- **OPFS化で削減できる起動時間の見積り**: 今回の構成(ROM/FDD1/HDD合計)では、MEMFS書込み+IndexedDB get区間の中央値合計は約378msで、起動時間中央値(25,951.5ms)の約1.5%にとどまる。**現状のRAM展開そのものは起動時間のボトルネックではない**。ただしこの起動時間はdevモードのネットワーク取得・wasmコンパイルに支配されており、本番ビルドでの割合(相対的に短くなる起動時間に対する同じ絶対値の比率)は別途測る必要がある。OPFS化による起動短縮効果は、本項目からは「大きくは見込めない」以上のことは言えない。
- **保存中にframe eventを止める必要がある長さ**: IndexedDB全量書出し(HDD 40MB)は中央値200〜310ms、p99で690msに達し、同時期に最大190ms超のrAF gapとlong taskが観測された。これは体感できる一時停止の水準であり、Worker移行後も同等以上の一時停止(あるいはWorker内での長時間ブロック)が起きうる。OPFS化(セクタ単位の書込みへの置換)は、この40MB一括保存そのものをなくす効果が見込める。
- **全量保存を残せるかの判断材料**: 上書き保存は初回追加よりp99で約1.9倍遅く(694ms vs 363ms)、この差は現行`saveDisk()`の追加`getDisk()`呼出によるものと考えられる(未分離)。全量保存を当面残す場合、この追加ラウンドトリップの要否は見直しの余地がある。
- **測っていないことは断定しない**: 本番ビルドでの割合、iOS実機、A/A反復誤差、ROM独自アップロード時のIndexedDB get経路、20回規模での分布の裾は、いずれも今回のデータからは判断できない。
- **現行のフレーム供給がどこで詰まっているか**: RGB565→RGBA変換(中央値1.62ms)・`putImageData()`復帰(中央値0.07ms)のどちらも定常状態では極めて軽く、これらの処理自体は現行経路のボトルネックではない。詰まって見えるのは`retro_run()`完了間隔(=canvas末端時間)のほうで、中央値18.09msはコアの目標フレーム間隔18.018msとほぼ一致しているにもかかわらず、約半数のフレームが予算を超過している。これはrAF/表示周期(観測間隔中央値16.67ms、≒60Hz)とコアの55.5fps(18.018ms)が非整数比であることによる構造的なズレと整合しており、**計算コストではなく、rAFと可変fpsコアの駆動タイミングの噛み合わせが主要因である可能性が高い**。ただし他の要因(GC、ブラウザのスケジューリング等)を排除できておらず、これは相関からの推測にとどまる。
- **ワーカー移行で改善が見込める部分**: 上記が正しければ、Worker側で`retro_run()`のwhileループとフレーム間隔計算を持ち、メインのrAFやAudioWorklet tickに1対1で従属させない構成(ワーカー移行の影響範囲「2. コア駆動ループ」節で候補として挙げた案)は、rAFと可変fpsの噛み合わせのズレそのものを解消しうる。一方、RGB565変換や`putImageData()`は既に軽量なため、**描画経路(Offscreen直描画か転送か)の選択によってこの2区間が大きく改善する見込みは、本項目のデータからは支持されない**(描画経路の比較は別途「フレームバッファ帯域と転送コスト」「Offscreen固有機能の成立性」の比較スパイクが必要で、今回は実施していない)。
- **測定点のコストと測定系の限界**: `frameProbe`自体のコストは1回の比較で中央値・p95に有意差が見えなかったが、反復未確認。故障注入では4指標中3つ(rAF間隔、canvas末端時間、long task数)に裾が現れたが、フレーム予算超過率は定常状態でも約半数が超過している(上記の構造的ズレによる飽和)ため50ms busy waitの影響を検出できなかった。この指標をWorker移行後の回帰判定に使うなら、集計方法の見直しが要る。

## A/A再測定：別日の2組目（実測）

計画の実行順序7「別日にA/A再測定し、反復誤差、欠測、外れ値を確認して移行前基準を凍結する」を実施した。**結論を先に書くと、反復誤差は確定できず、移行前基準の凍結には至らなかった。** 理由は後述の3件の計測系の欠陥である。

### 実施内容

2026-08-17に、目的Aの4項目を既存スクリプトの同一オプションで再取得した。A側（1組目）は起動・3ドライブが2026-08-13、キー入力・音声が2026-08-16の実測値である。

| 項目 | 実行コマンド | B側の出力 |
| --- | --- | --- |
| 起動 | `node scripts/measure-boot.mjs --mode=dev --runs=20` | `_local/measure/aa-20260817-boot.json` |
| 3ドライブ | `node scripts/measure-drives.mjs --runs=5` | `_local/measure/aa-20260817-drives.json` |
| キー入力 | `node scripts/measure-key.mjs --runs=30`（2回） | `_local/measure/aa-20260817-key-1.json`、`-2.json` |
| 音声 | `node scripts/measure-audio.mjs` | `_local/measure/aa-20260817-audio.json` |
| 音声（追加） | `node scripts/measure-audio.mjs --beep-duration=1000 --idle-duration=60000`（2回） | `_local/measure/aa-20260817-audio-idle2.json`、`-idle3.json` |

音声の追加2回は、初回のidle結果がA側と桁で食い違ったため、日内ばらつきか日差かを切り分ける目的で追加した（beep区間は1000msへ短縮し、独立したBrowserContextで走るidle区間だけを見ている）。

### 結果：起動

| 組 | 実測日 | 成功 | 中央値 | p95 | p99 | 最小 | 最大 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 08-13 | 20/20 | 25832.30 | 27078.52 | 29211.51 | 24486.57 | 29744.76 |
| B | 08-17 | 20/20 | 23971.04 | 25727.05 | 26090.54 | 22528.93 | 26181.42 |
| 差 | | 0 | **-1861.26** | -1351.47 | -3120.97 | -1957.65 | -3563.34 |

単位はms。機能失敗は両組とも0。中央値で-7.2%、p99で-10.7%動いた。B側のほうが速い。

B側の内訳（中央値）は クリック→wasm取得完了 706.11ms、wasm取得完了→コア稼働 1419.84ms、コア稼働→ゲスト初出力 15551.83ms、ゲスト初出力→プロンプト安定 6878.97ms。`wasm取得完了→コア稼働` は中央値1419.84msに対しp95 7720.27ms・最大7962.71msで、20回中の数試行だけ約6.5秒長い群がある。**A側にはこの内訳が存在しない**（区間計測は`fe09bd7`で後から追加されたため）。したがって内訳の日差は比較できない。

### 結果：3ドライブ認識

| ドライブ | A側 成功 | B側 成功 | A側 中央値 | B側 中央値 | A側 p95 | B側 p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A: | 5/5 | 5/5 | 116.20 | 102.66 | 559.02 | 107.76 |
| B: | 5/5 | 5/5 | 128.45 | 125.51 | 135.87 | 298.32 |
| C: | 5/5 | 5/5 | 789.45 | 718.63 | 949.80 | 3267.83 |
| D: | 5/5 | **4/5** | 81.22 | 82.53 | 88.24 | 86.91 |

単位はms。**移行前の時点で、B側のD:に1件の失敗が出た。**

#### D:失敗の内訳（誤診を避けるための記録）

失敗はtrial 1のD:で、`driveJudgementFailed`として計上された。しかし生データを見ると、これは「ドライブが認識されない」ではなく**Enterが消費されなかった**ことによる可能性が高い。

- コマンド行`A>dir d:`の入力照合は`matched: true`で通っており、入力そのものは届いている。
- Enter送出（`enterAt: 48530.28`）の後、コマンドタイムアウト20秒のあいだ`responseAt`が`null`のままで、TVRAMの観測行にもD:の出力（「ドライブ名が無効です」）が現れていない。
- 復帰処理でEnterを1回再送しただけで、186.04msでプロンプト（`A>`）へ戻った。
- 同じtrial 1のC:の応答が3900.74ms（他4試行は541.85〜736.23ms）と突出しており、この時間帯にゲスト側が詰まっていた形跡がある。

つまり「ゲストが詰まっている最中に送ったEnterが消費されなかった」という像である。ただし**1サンプルのみであり、原因は未確定**である。「入力の取りこぼしをドライブ認識の失敗と誤診しかけた」件（前述の「実装で潰した2つの誤診」）と同じ構造がEnterキーの経路に残っている疑いがあるが、現状の分類ロジックはこれを`inputFailed`ではなく`driveJudgementFailed`へ入れている。

**この1件が示す重要な事実は、移行前の時点で5回中1回の失敗が出るということである。** 移行後に4/5が出たとき「回帰」と判定できる根拠は、現時点で存在しない。

### 結果：キー入力の末端到達

| 組 | 実測日 | 経路 | 標本 | 失敗 | 中央値 | p95 | p99 | MAD | 欠落 | 誤字 | 重複/残留 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A-1 | 08-16 | KeyBuf | 30 | 0 | 11.058 | 32.903 | 74.438 | 7.045 | 0 | 0 | 0 |
| A-2 | 08-16 | KeyBuf | 30 | 0 | 4.538 | 51.280 | 74.677 | 0.207 | 0 | 0 | 0 |
| B-1 | 08-17 | KeyBuf | 30 | 0 | 4.730 | 45.882 | 94.166 | 0.868 | 0 | 0 | 0 |
| B-2 | 08-17 | KeyBuf | 30 | 0 | 4.383 | 46.369 | 92.662 | 0.593 | 0 | 0 | 0 |
| A-1 | 08-16 | TVRAM | 30 | 0 | 31.815 | 55.154 | 81.371 | 7.150 | 0 | 0 | 0 |
| A-2 | 08-16 | TVRAM | 30 | 0 | 32.795 | 58.878 | 74.677 | 5.690 | 0 | 0 | 0 |
| B-1 | 08-17 | TVRAM | 30 | 0 | 30.545 | 54.383 | 94.166 | 5.340 | 0 | 0 | 0 |
| B-2 | 08-17 | TVRAM | 30 | 0 | 31.947 | 63.767 | 95.288 | 6.540 | 0 | 0 | 0 |

単位はms。4回すべてで欠落・誤字・重複・残留押下が0だった。4項目の中でもっとも安定している。

KeyBufの中央値は4回中3回が4.38〜4.73msに収まり、**A-1の11.058msだけが浮いている**。日をまたいだ差ではなくA-1が外れ値だったと読むほうが素直で、既存の基準値節が「11.06msと4.54msでばらつきが大きい」と書いた解釈は、B側2回を加えると別の見え方になる。ただしMADはA-1が7.045msでB側の0.868/0.593msより大きく、A-1は分布そのものが広い。原因は未調査。

### 結果：音声遅延（内部キュー）

| 組 | 実測日 | シナリオ | tick数 | 中央値 | p95 | p99 | 最大 | underflow | trim | dropped |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 08-16 | beep | 5770 | 82.234 | 93.890 | 98.373 | 167.891 | 4082 | 1 | 7201 |
| B | 08-17 | beep | 5775 | 82.494 | 150.950 | 195.723 | 231.451 | 17999 | 3 | 22587 |
| A | 08-16 | idle | 5153 | 88.299 | 162.195 | 201.026 | 223.424 | **0** | **0** | **0** |
| B-1 | 08-17 | idle | 5165 | 90.023 | 181.937 | 214.892 | 242.018 | 9919 | 1 | 7454 |
| B-2 | 08-17 | idle | 5129 | 90.204 | 182.753 | 213.818 | 238.980 | **0** | 1 | 7439 |
| B-3 | 08-17 | idle | 5153 | 87.778 | 150.381 | 180.209 | 198.367 | 8368 | 1 | 7669 |

単位はms（underflow/trim/droppedは件数）。

**queuedSecの中央値は4組とも82〜90msで安定している**（A-idle 88.299、B-idle 90.023 / 90.204 / 87.778）。動いているのは裾とカウンタのほうである。

underflowは、同一日・同一ビルドのidle3回で 9919 / **0** / 8368 と二値的に振れた。9919フレームは48kHz換算で約207ms、8368フレームは約174msに相当し、「約200msの停止が1回起きたかどうか」で0か約9000かに分かれていると読める（時系列で確認しようとしたが、後述のとおり生ログが保存されていないため検証できていない）。**したがってA側idleの`underflow: 0`は、二値分布から引いた1回の目であって、安定した基準値ではない。**

一方 `dropped` は、B側idleの3回が7454 / 7439 / 7669 とよく揃っているのに対し、A側idleは0である。`trim`も B側3/3が1件、A側は0件。こちらは日内で安定して発生しており、A側との差は「ばらつき」では説明しにくい。ただし原因の帰属は次節の理由でできない。

### この再測定でA/A反復誤差を確定できない3つの理由

計画の共通条件は「全イメージ、ROM、wasm、JavaScriptのSHA-256を結果に記録する」「AudioContextの`sampleRate`を記録する」「生サンプルをJSON/CSVで保存する」と定めている。**これらが実装されていないため、日差とそれ以外の差を分離できない。**

#### 1. A側とB側でビルドが違う（同一ビルドの日差を測れていない）

A側の実測後に`src/`が変更されている。

- 音声A側（08-16 11:55）の後、`068d15f`（08-16 16:22）が`src/audio.ts`を変更（startQueueProbeのレース修正、+27行）。さらに`1d53345`・`b91b832`が`src/main.ts`・`src/libretro-host.ts`・`src/storage-probe.ts`を変更。
- 起動A側（08-13）の後は、上記に加えて音声振幅プローブの追加（`213c16f`）と既定off化（`9a3f97c`）、区間計測の追加（`fe09bd7`）が入っている。

なお、`068d15f`が音声のunderflow集計を動かす経路は確認した範囲では見つからなかった。集計は`measure-audio.mjs:431`の`underflowFrames: lastEntry?.underflow ?? 0`、すなわちリセット後の累積値の**最終tick**であり、レースが汚すのは先頭tickだけなので最終値には効かない。また`b91b832`が追加した`frameProbe`と`1d53345`の`storageProbe`はいずれも既定`enabled = false`（`src/storage-probe.ts:114`、`src/storage-probe.ts:174`）で、計測中は動いていない。**したがって「ビルドが違うこと」は音声の差の説明として確認できてはいないが、否定もできていない。**

ビルド同一性が結果に記録されないため、この食い違いは**結果ファイルを見ても気づけない**。今回はコミット時刻と結果ファイルのmtimeを突き合わせて初めて分かった。

#### 2. 環境が記録されていない

4スクリプトいずれも、結果の`config`にはポート・パス・Chromeの実行パス・タイムアウトしか入らない。計画が要求する ブラウザ／OS／端末／CPU／メモリ／電源／リフレッシュレート／viewport／devicePixelRatio／音声出力機器／`sampleRate`／`baseLatency`／`outputLatency` はどれも残っていない。音声の差が出力デバイスや`sampleRate`の違いによるものかを、事後に確認する手段がない。

#### 3. 音声の生ログ（時系列）が保存されていない

`scripts/measure-audio.mjs:606` に「生ログ(rawLog)は別ファイルへ保存する(結果本体を軽くするため)」とコメントがあるが、**そのような処理は存在しない**。`writeFile`はスクリプト中で1回（607行）だけ呼ばれ、書き出す`result`は`stripRawLog()`済みである（593行・618行）。時系列は毎回破棄されている。

`docs/STORAGE-SCSI.md`の既存記述「生サンプルは `_local/measure/audio-main.json`（gitignore対象、`rawLog`に全tickの時系列を含む）に保存した」も、同じ理由で事実と異なる。**この記述はコードを確認せずに書かれたものであり、訂正する。**

この欠落により、underflowが「1回の約200msの停止」なのか「多数の小さな欠落の積み上げ」なのかを、既存の結果ファイルから判定できない。他の3項目（起動・3ドライブ・キー）は生サンプルを保存しているため、この問題はない。

### 現時点で言えること

- **機能失敗**: 起動は2組とも20/20。キー入力は4回とも欠落・誤字・重複0。3ドライブはA側5/5に対しB側4/5で、移行前の時点で失敗が発生しうることが分かった。
- **時間の指標**: 起動の中央値は2組で1861msの差がある。キー入力のTVRAMエコー中央値は4回で30.5〜32.8msに収まる。音声のqueuedSec中央値は4組で82〜90msに収まる。これらは「1回の差」であり、反復誤差としてはまだ扱えない。
- **カウンタの指標**: 音声のunderflowは二値的に振れる。件数を基準値として凍結し、移行後の値と大小比較する使い方は成立しない。集計方法（発生の有無、または停止イベントの長さの分布）の見直しが要る。
- **凍結の可否**: 目的Aの4項目とも、**移行前基準として凍結できない**。1組目と2組目でビルドが違い、環境が記録されておらず、音声は時系列が残っていない。

### 次にやること（順序）

1. 計測スクリプト4本に、結果への環境記録を追加する。最低限、ビルドの同一性（wasm/JSのSHA-256またはHEADのコミットハッシュと作業ツリーのdirty有無）、`sampleRate`、出力デバイス、viewport、devicePixelRatio。
2. `measure-audio.mjs`の生ログ保存を実装する（コメントと実装の食い違いを解消する）。既存ドキュメントの当該記述も訂正済みとする。
3. 上記を入れた同一ビルドで、日を分けて2組取り直す。今回のB側は「ビルドが違う組」なので1組目として使えない。
4. 3ドライブのD:失敗について、`inputFailed`と`driveJudgementFailed`の分類がEnter送出の経路でも正しく分かれるかを確認する。Enterを故意に1回捨てる故障注入を追加し、それが`driveJudgementFailed`ではなく入力失敗として分類されることを陽性対照つきで確認する。
5. 音声underflowの集計方法を決め直す。

**追記（2026-08-17）**: 上記のうち1・2・4・5は実施した（「計測系の修正」節）。3は1組目のみ取得済みで、2組目は別日に同一ビルドで取る必要がある（「移行前基準：1組目」節）。

**この5件が済むまでは、移行前基準の凍結（実行順序7）は完了していない。** 今回の作業で分かったのは基準値そのものではなく、基準値を取る仕組みに3つの穴があることである。

## 計測系の修正：A/A再測定で見つかった3つの穴への対処（実測）

前節「A/A再測定：別日の2組目」で、反復誤差を確定できない理由として計測系の欠陥3件を挙げた。それを塞ぎ、あわせてA/Aで見つかった2つの問題（3ドライブのD:失敗、音声underflowの二値的な振れ）に対処した。以下は2026-08-17に実施した内容である。

### 1. 結果へ環境記録を追加（`5e4fe88`）

`scripts/measure-env.mjs` を新設し、4つの計測スクリプト（boot/drives/key/audio）の結果JSONへトップレベルの `environment` を追加した。記録する内容は次のとおり。

| 区分 | 内容 |
| --- | --- |
| `build` | HEADのコミットハッシュ、ブランチ、作業ツリーのdirty有無とdirtyなファイル一覧、同梱アセット5件（`px68k_libretro.wasm`/`.js`、`iplrom.dat`、`cgrom.dat`、`human302.xdf`）のSHA-256 |
| `host` | OS種別・バージョン・アーキテクチャ、CPUモデル、コア数、搭載メモリ、Nodeバージョン、電源接続 |
| `browser` | Chromeのバージョン、User-Agent |
| `page` | viewport、devicePixelRatio、画面解像度、`hardwareConcurrency`、`deviceMemory`、**実測したリフレッシュレート**とそのrAF標本数 |
| `audio` | `sampleRate`、`baseLatency`、`outputLatency`、AudioContextの`state` |

計画の共通条件が要求する「取得不能を0として扱わない」に従い、取得できなかった値はすべて `null` にする。`outputLatency` を持たないブラウザで0を入れない。

リフレッシュレートはページ内でrAFを1000ms集めて算出するが、**このリポジトリではrAFが1回も発火しない環境が実測されている**（「予備確認：音を出す固定操作の有無」節）ため、1200msのタイムアウトを置き、発火0回なら `refreshRateHz: null` / `rafSampleCount: 0` として記録する。ハングさせない。

収集は**計測窓の外**（最初の試行の計測が終わった後、そのページを閉じる前）で全体を通して1回だけ行う。rAFを1秒回すため、計測中に走らせると測っている値そのものが動く。

#### 測定系の検証（陽性対照つき）

| 検証 | 方法 | 結果 |
| --- | --- | --- |
| dirty検出 | クリーンな状態 → 追跡下のファイルを改変 → 復元 | `false` → `true`（`dirtyFiles: [' M README.md']`）→ `false` |
| ハッシュの感度 | 対象アセットのコピーを1バイト変えてsha256を比較 | `3fe2b910…` → `b0ae8e59…`（別値） |
| null維持 | `collectEnvironment(null)` を呼ぶ | 例外なく `browser`/`page`/`audio` が `null` |

実走（`measure-boot.mjs --runs=1`）で `environment` が結果に入ることを確認した。この作業中に、`git status --porcelain` の出力全体に `.trim()` をかけていたため**先頭行だけ状態列（index側の空白）が壊れる**不具合が見つかり、専用パーサへ分離して修正した。

### 2. 音声の生ログ保存を実装（`7445b3e`）

`scripts/measure-audio.mjs` には「生ログ(rawLog)は別ファイルへ保存する」というコメントがあったが、**その処理は存在しなかった**。`writeFile` は1回だけで、書き出す `result` は `stripRawLog()` 済みだった。

結果ファイルと同じディレクトリへ `<ベース名>-rawlog-<kind>.json` として、`{schemaVersion, measuredAt, kind, sampleCount, resultPath, samples}` の形で保存するようにした。`samples` は丸めも間引きもしない。結果JSON側の各シナリオには `rawLogPath` を追加した。試行が失敗して0件のときもファイルを作り、「保存しなかった」と「0件だった」を区別できるようにしている。

書き出し直後にファイルを読み戻し、`samples.length` が `rawLogSampleCount` と一致しなければ `process.exitCode = 1` にして明示する自己検査を入れた。**この検査が実際に働くことも確認した**（読み戻し直後に1件削る改変を注入 → 不一致が表示され `exitCode=1` で終了 → 改変を撤去）。

実走での確認: beep 309件・idle 273件、いずれも結果JSONの件数と生ログの実件数が一致。ファイルサイズはbeep 44699 bytes、idle 39474 bytes。

### 3. Enter取りこぼしをドライブ判定の失敗から分離（`89e5213`）

A/AのB側で出たD:の失敗（trial 1）を追ったところ、**誤分類の構造がコード上で確定した**。

- コマンド行の照合（`commandLineMatches`、`executeDir` 内）は **Enter送出前**のプロンプト行だけを検証して `input.passed` を決める。
- Enter送出後にタイムアウトした場合、`raw.input.passed` は既に `true` なので `judgeIdentity()` が呼ばれる。応答証跡が無ければ媒体識別条件を満たさず `identity.passed = false` になる。
- `measureOnce` 内の `driveJudgementFailedDrives = input.passed === true && !identity.passed` に落ち、**入力が届かなかった事象がドライブ判定の失敗として計上される**。

原因（入力経路の欠落）も対処（Enterの再送）も媒体識別の失敗とは異なるため、分類を分離した。`isEnterLostCandidate()` が「入力照合は通った／タイムアウトした／応答証跡が無い／復帰の1手目がEnterで成功した」の4条件を満たす場合に `enterLost` として集計し、`driveJudgementFailedDrives` から外す。既存の judgement（`passed`/`failed`/`indeterminate`）、タイムアウト、ポーリング間隔は変更していない。

あわせて故障注入 `--fault=drop-enter` を追加した。対象ドライブのEnterの合成キーイベントを1回だけ送らない（コマンド行の文字入力は正常に送る）。故障注入コードは計測スクリプト内だけにあり、`src/` には無い。

#### 測定系の検証

- 実走（`--fault=drop-enter --runs=3`）: 陽性対照が成功し、3試行とも **D:のみ** が `enterLost`、`driveJudgementFailedDrives` は空。A:/B:/C: に無関係な失敗は出ておらず、注入範囲の漏れがないことを確認した。
- **2026-08-17に実際に出た失敗データ**（`_local/measure/aa-20260817-drives.json` の trial 1）に対して4条件を当てると、すべて成立する。注入した故障だけでなく、**本物の1件も新しい分類で `enterLost` に載る**ことを確認した。

### 4. 欠音を累積フレーム数でなくイベント単位で集計（`cbb19b8`）

生ログを保存できるようになったので、underflowの時系列を初めて確認した。idle 60秒の3回で、underflowの**増加イベントはそれぞれ3件・3件・4件しかなく、しかも同一時刻に固まっていた**。実際のtick列は次のとおり。

    q=39.6ms uf=0 / q=28.0ms uf=0 / q=16.3ms uf=0 / q=4.7ms uf=0 / q=0.0ms uf=303 / q=0.0ms uf=815 / q=30.2ms uf=1071 / q=54.7ms uf=1071 …

キューが枯れて欠音し、すぐ詰め直されている。増分は512（ワークレットの処理単位）の倍数。**underflowは60秒に散らばった連続量ではなく、1回の停止イベントの長さである。**

#### ワークレット自身の時計を追加

このとき、`src/audio.ts` の `tMs: performance.now()` が**メインスレッドがtickメッセージを受け取った時刻**であることも分かった。メインが止まっている間に生成されたtickは復帰後に一斉に届くため、上記のバーストは10件以上が同一の `tMs` を持つ。**停止がいつ始まり何ms続いたかを、この時刻からは復元できない。**

そこでプローブ有効時のみ、tickメッセージにワークレット自身の時計（`AudioWorkletGlobalScope.currentFrame`、サンプル単位）を載せ、ログ標本へ `workletFrame` として記録するようにした。既存の `tMs` はメイン受信時刻としての意味（メイン停止そのものの検出に使える）があるため残している。通常運用のメッセージは太らせていない。

#### 集計の追加

`summarizeQueueLog()` に `underflowEvents` を追加した。underflowの累積値が増加している連続tickの並びを1イベントとし、各イベントについて 開始時のメイン受信時刻・開始時のワークレット時刻・失われたフレーム数・失われた時間(ms)・直前のキュー滞留量 を持つ。サマリは 件数・欠損時間の合計/最大/中央値 とイベント配列。

**既存の `underflowFrames`・`trimEvents`・`droppedSamples` はそのまま残している。** 過去の計測値との比較可能性を壊さないため、置き換えではなく追加である。

#### 測定系の検証（陽性対照つき）

- 故障注入 `--fault=stall-main` を追加した。idle採取中にメインスレッドを既知の300msだけ1回ブロックする。実走の結果、陽性対照が成功（標本683）し、故障試行で**イベント1件・欠損211.406ms**を検出した。
- 300msの停止に対し欠損が211msなのは、`TARGET_LATENCY_SEC`（80ms）ぶんのキューが先に消費されるためで、両者は整合する。**メインスレッドの停止時間から手持ちのバッファを引いた残りが、そのまま音の欠落になる**関係が実測で確認できた。
- 保存済みの旧形式の生ログ（`workletFrame` が無い、`uf-1`〜`uf-3`）に対しても、クラッシュせず処理できることを確認した。結果は 1件24.286ms / 1件25.601ms / 1件37.506ms で、旧指標の累積1071 / 1129 / 1654フレームと `フレーム数 ÷ sampleRate` の関係で一致する。

#### この指標の意味

欠音はメインスレッド停止の痕跡であり、**Worker移行がまさに解消しようとしている事象そのもの**である。移行によってメインの停止が音へ届かなくなれば、この指標は0へ寄るはずで、移行の効果を直接測れる。件数の累積フレーム数ではなく「停止が何回、何msずつ」で見ることで、二値的な振れに惑わされずに比較できる。

## 移行前基準：1組目（凍結ビルド `cbb19b8`、実測）

上記の修正をすべて入れたビルドで、目的Aの4項目を取り直した。**これが移行前基準の1組目**である。前節のA/A（8/13・8/16・8/17）は、いずれもビルドが異なるため1組目として使えない。

### 共通条件（結果ファイルの `environment` より）

- コミット `cbb19b8`、ブランチ `feature/storage-opfs-scsi`、作業ツリーはクリーン（`dirty: false`）
- macOS 24.6.0、Apple M2、8コア、16GiB、AC電源
- Chrome 151.0.7922.138、viewport 900x700、devicePixelRatio 2、画面 3840x2160
- AudioContext: `sampleRate` 44100、`baseLatency` 0.005351秒、`outputLatency` 0.168秒
- 5つの結果ファイル（boot/drives/key×2/audio）すべてで `environment` が一致しており、1組目の内部では条件が揃っている。

**環境記録が初回から仕事をした**: 同日21:51に取った検証用の計測では `outputLatency` が 0.016秒 だったのに対し、1組目（22:40頃）では 0.168秒 と10倍になっている。音声出力の構成がセッション中に変わったことを意味する。従来はこの値が記録されていなかったため、**同じことが8/16と8/17の間に起きていても気づけなかった**。前節で音声の差を帰属できなかった原因の候補として、この線が残る。

### 結果

| 項目 | 結果 |
| --- | --- |
| 起動 | 20/20成功。中央値 24393.29ms、p95 26858.20ms、p99 44417.21ms、最小 22385ms、最大 48806.97ms |
| 3ドライブ | A:/B:/C:/D: すべて 5/5成功。`enterLost` 0件。中央値は A: 94.67ms、B: 116.25ms、C: 674.87ms、D: 79.83ms |
| キー入力 1回目 | 30刺激成功。KeyBuf中央値 4.645ms（p95 39.716ms）、TVRAM中央値 29.443ms。欠落・誤字・重複0 |
| キー入力 2回目 | 30刺激成功。KeyBuf中央値 5.880ms（p95 51.460ms）、TVRAM中央値 32.340ms。欠落・誤字・重複0 |
| 音声 beep | queuedSec中央値 83.515ms、p99 132.495ms。累積underflow 12184フレーム。**欠音イベント5件**（9.274 / 10.998 / 3.197 / 16.190 / 236.621 ms） |
| 音声 idle | queuedSec中央値 87.698ms、p99 151.966ms。累積underflow 5969フレーム。**欠音イベント2件**（51.043 / 84.308 ms、合計135.351ms） |

### 分布の裾について（外れ値の記録）

起動20試行の実測値は昇順で 22385, 23140, 23480, 23507, 23711, 23791, 23872, 24138, 24151, 24387, 24399, 24431, 24454, 24515, 24836, 24946, 25107, 25337, 25703, **48807**（ms）である。**19試行が22.4〜25.7秒に収まり、1試行だけ48.8秒**と倍近い。

このため p99（44417ms）は、この1点がほぼそのまま出た値である。**標本20でp99を計算しても、実質的に最大値の言い換えにしかならない。** 回帰判定にp99を使う場合は、標本数を増やすか、中央値・p95と「外れ値が何件出たか」を分けて見る形にしないと、1回の停止の有無で合否が決まってしまう。

音声の欠音イベントにも同じ構造がある。beepの累積underflow 12184フレームのうち、大半は5件中1件（236.621ms）が作っている。**累積値を単一の数字として比較すると、この構造が見えない。**

### 2組目を取るための条件

1組目とビルドが同一でなければ、日差を測ったことにならない。**2組目を取るまで `src/` と `scripts/` を変更しないこと。** 結果ファイルの `environment.build.commit` が `cbb19b8`、`dirty` が `false` であることを、2組目の計測後に照合する。一致しなければ、その差を日差として解釈しない。

音声については、`environment.audio.outputLatency` も突き合わせること。1組目は0.168秒である。ここが違っていた場合、音声の差は出力構成の差である可能性を排除できない。

※ 2026-08-19 追記：ビルド同一性の照合はコミットハッシュではなく同梱アセットの SHA-256 で行うのが正しい。docsのみのコミットが乗るとハッシュは一致しなくなる。この節の後日談は末尾の節を参照。

## 移行前基準：2組目の取得と、その無効判定（実測、2026-08-19）

8/19 15:22〜15:48、凍結ビルドと同一のまま4本を実走し、`set2-20260819-{boot,drives,key-1,key-2,audio}.json` を得た（`_local/measure/`、gitignore）。

### ビルド同一性の照合

同梱アセット5件のSHA-256は1組目と**完全一致**した。ただし `environment.build.commit` は `cbb19b8` ではなく `393339e` である。これは1組目取得後に docs のみの追記コミットが乗ったためで、`cbb19b8..393339e` の差分は `docs/STORAGE-SCSI.md` の1ファイルのみだった。**ビルドの同一性はコミットハッシュではなくアセットのハッシュで照合するのが正しい**。

### 結果の対比（1組目 → 2組目）

| 項目 | 1組目(8/17) | 2組目(8/19) |
| --- | --- | --- |
| 起動 中央値 | 24,393ms | 30,635ms |
| 起動 分布(昇順) | 19試行が22.4〜25.7秒＋外れ値48.8秒1点 | 24.3〜37.7秒に連続的に分布 |
| DIR C: 中央値 | 674.87ms | 2,291.48ms |
| DIR A: / B: / D: 中央値 | 94.67 / 116.25 / 79.83ms | 144.49 / 311.68 / 87.61ms |
| キー KeyBuf 中央値(1回目/2回目) | 4.645 / 5.880ms | 25.218 / 9.063ms |
| キー TVRAM 中央値(1回目/2回目) | 29.443 / 32.340ms | 37.120 / 36.058ms |
| 音声 beep 欠音イベント | 5件(最大236.621ms) | 1件(104.172ms) |
| 機能失敗 | 0 | 0 |

機能面は2組とも無傷である。起動20/20成功、3ドライブはA:/B:/C:/D:すべて5/5、`enterLost` 0件、キー入力は各30刺激で欠落・誤字・重複0だった。

起動20試行を**試行順**に並べると、2組目は走らせている間に単調に悪化している。

    25940, 25309, 24267, 24809, 27636, 25225, 30882, 30387, 37098, 26392, 28050, 32617, 36269, 36713, 34939, 29572, 33914, 37705, 36026, 31396（ms）

1組目は最後まで平らで、外れ値1点だけだった（前節に記録済み）。

環境記録の照合では、`host`（機種・コア数・メモリ・AC電源）とChromeバージョン、viewport、devicePixelRatio、`sampleRate` は2組で一致した。**`outputLatency` だけが1組目0.168秒／2組目0.016秒と10倍違う。**音声の比較はこの時点で交絡している。

## 原因の特定：介入実験（実測）

ホストのプロセスを調べたところ、(a) CPU 31%・経過時間1日6時間3分のChromeレンダラが1本、(b) 別セッション由来の残存 `vite preview --port 4321`（`WebX68k` worktree）が動いていた。ロードアベレージは8コアに対し5.6〜6.0。`pmset -g therm` は「No thermal warning level has been recorded」で、**熱ではなくCPUの取り合いだった**。

冷却を待つだけでは戻らないことを確認した。計測終了から数分後に起動6試行を測ると 33592, 37593, 38745, 39349, 35723, 31816ms（中央値36,658ms）で、24秒台に戻らなかった。一過性のドリフトではなく、継続している状態変化である。

介入として(a)(b)を終了させ、同じ起動6試行を測り直すと 23778, 25359, 24459, 24529, 23477, 23841ms（**中央値24,150ms**）。ロードアベレージは2.75〜3.18に低下した。

**1組目の中央値24,393msとほぼ一致した。**したがって8/17→8/19の日差は実質ゼロで、2組目に出た+26%は丸ごとホスト側のCPU競合である。該当のChromeレンダラは経過時間から起動が8/18午前ごろと推定され、**1組目（8/17 22:40頃）には存在せず、2組目の全区間で動いていた**。

## 判定：2組目は無効。1組目も凍結できない

2組目は「日差」ではなく「負荷差」を測っており、移行前基準の2組目としては使えない。

同時に、**1組目も凍結できない**。結果ファイルに負荷の記録がなく、「あのとき静かだった」ことを後から示せないためである。今回の実測は、負荷の違いが起動中央値で+26%、DIR C:で3.4倍という**回帰判定より大きい差**を作ることを示した。この大きさの交絡を記録しないまま基準値にはできない。

残る限界として、`outputLatency` が2組で10倍違う件は未解決で、音声の比較にはこれとは別の統制が要る。

## 計測系の修正：負荷の記録を追加（実測）

`scripts/measure-env.mjs` に追加し4本へ配線した（コミット `5a0e946`、修正 `4cf35cd`）。内容は以下の通り。

- `environment.load.samples`：計測の全区間で `os.loadavg()[0]` を5秒間隔でサンプリングしたmin/median/maxとサンプル数、およびcpuCountで正規化した値。**サブプロセスを起動しない**（計測窓の中で走るため）。
- `environment.load.processesBefore` / `processesAfter`：計測窓の**外**で `ps` を1回ずつ取り、CPU上位10件を記録。
- `environment.load.competitors`：止められる余計なプロセスの抽出（CPU10%以上かつ経過10分以上、CPU80%以上、`vite` を含むもの）。
- `environment.load.systemBackground`：`WindowServer` などのmacOS常駐プロセスとClaudeデスクトップアプリ。**competitorからは外すが記録は残す**。
- `environment.load.verdict`：`quiet` / `contended` / `unknown` の3値と、判定根拠の文字列。

正規化loadavgの閾値0.5の根拠は、本日の実測2条件（良: 0.34〜0.40で起動24,150ms、悪: 0.54〜0.76で起動36,658ms）の間に置いたことである。結果ファイルの `verdictReason` にもこの根拠を書き出している。

**最初の実装には欠陥があり、差し戻して直した**（`4cf35cd`）。competitor条件が `WindowServer`（CPU 42.6%、経過107日）に恒久的に該当し、`verdict` が永久に `contended` を返していた。良い条件と悪い条件が同じラベルになるため、区別すべき2条件を区別できない。**常に同じ答えを返す検出器は故障注入を必ず通過する**という、このリポジトリで既に踏んだ型と同じである。

### 測定系の検証（実走）

| 検証 | 条件 | 結果 |
| --- | --- | --- |
| 陰性対照 | 余計なものを止めた状態で1試行 | `verdict: quiet`、正規化median 0.35、competitors 0件 |
| 陽性対照 | `vite preview` 1本 + CPUを食うnode 3本を並走 | `verdict: contended`、正規化median 0.70、competitors 4件 |
| 分類の確認 | 実条件の型を合成入力で通す | 真犯人型(Chromeレンダラ 31%/1日6時間)→competitor、通常のタブ(2.7%)→非該当、WindowServer(42.6%/107日)→systemBackground、残存vite(CPU 0.1%)→competitor |

`npm test` 434件通過（26ファイル）。

## 移行前基準：新ハーネスでの1組目（実測、2026-08-23）

負荷記録つきハーネスで4本を取り直した。**これが移行前基準の新1組目**である（旧ハーネスの set1・set2 は記録として残すが基準値には使わない）。出力は `_local/measure/newset1-20260823-{boot,drives,key-1,key-2,audio}.json`（gitignore）。

### 事前の静穏確認と、その場での介入

計測前にホストを確認したところ、正規化 loadavg1 の中央値は 0.28 と閾値0.5を下回っていたが、**competitor が1件検出され `verdict: contended` だった**。内訳は Google Chrome（CPU 10%、経過2日1時間）で、8/19に2組目を無効にした真犯人と同じ型（放置された長時間Chrome）である。残存 `vite preview` は無かった。

Chrome を終了して取り直すと、正規化 loadavg1 中央値 0.19・competitors 0件・`verdict: quiet` となった。**ハーネスに入れた負荷判定が、計測を始める前に1件止めた**ことになる。8/19の時点ではこの検出が無く、同じ状態のまま4本走らせて丸ごと無効にしていた。

### 条件の照合

5つの結果ファイルすべてで以下が一致した。

- `environment.load.verdict` が **`quiet`**（正規化 loadavg1 の中央値 0.33〜0.38、最大 0.69）、`competitors` は全ファイル0件
- コミット `844a1f1`、ブランチ `feature/storage-opfs-scsi`、`dirty: false`
- 同梱アセット5件の SHA-256 が、**旧 set1（8/17）・set2（8/19）とも完全一致**
- `AudioContext.outputLatency` は 0.016秒（1組目0.168秒／2組目0.016秒のうち後者側）

さらに `git diff cbb19b8..844a1f1` の差分は `docs/` と `scripts/` のみで、**`src/` は1行も変わっていない**。つまり被測定物（アプリ本体＋コア＋ROM＋ディスク）は旧 set1 と同一で、変わったのは計測ハーネスだけである。旧 set1 との対比は、この条件のもとで読める。

### 結果

| 項目 | 結果 |
| --- | --- |
| 起動 | 20/20成功。中央値 23,601.03ms、p95 24,304.70ms、p99 24,441.52ms、最小 22,934.64ms、最大 24,475.73ms |
| 3ドライブ | A:/B:/C:/D: すべて 5/5成功。入力失敗・`enterLost`・ドライブ判定失敗すべて0件。中央値は A: 105.39ms、B: 119.18ms、C: 662.40ms、D: 80.16ms |
| キー入力 1回目 | 30刺激成功。KeyBuf中央値 12.19ms（p95 42.84ms）、TVRAM中央値 31.32ms。欠落・誤字・重複0 |
| キー入力 2回目 | 30刺激成功。KeyBuf中央値 4.86ms（p95 43.86ms）、TVRAM中央値 30.49ms。欠落・誤字・重複0 |
| 音声 beep | queuedSec中央値 83.20ms、p99 190.33ms。累積underflow 3,652フレーム。欠音イベント6件（合計82.81ms、最大48.41ms） |
| 音声 idle | queuedSec中央値 89.89ms、p99 217.60ms。累積underflow 2,753フレーム。欠音イベント1件（62.43ms） |

機能面は全項目無傷（起動20/20、3ドライブ各5/5、キー入力60刺激で欠落・誤字・重複0）。

### 分布：外れ値が消えた

起動20試行を昇順に並べると 22935, 23107, 23130, 23200, 23240, 23286, 23442, 23473, 23498, 23592, 23610, 23630, 23648, 24022, 24111, 24159, 24179, 24254, 24296, 24476（ms）。**全20試行が22.9〜24.5秒の1.5秒幅に収まり、旧 set1 にあった48.8秒の外れ値のような点は出ていない。**試行順に並べても単調な悪化は無い（2組目に出た増加傾向は再現していない）。

このため p99（24,441ms）は最大値（24,476ms）とほぼ同じだが、旧 set1 のように「1点の停止がそのまま p99 になる」構造ではない。**とはいえ標本20でのp99が実質最大値であることは変わらない**ので、回帰判定は中央値・p95と「外れ値の件数」を分けて見る方針を維持する。

### 旧 set1（8/17、旧ハーネス）との対比

被測定物は同一で、差はハーネスと日付とホスト状態だけである。

| 項目 | 旧set1(8/17) | 新1組目(8/23) |
| --- | --- | --- |
| 起動 中央値 | 24,393ms | 23,601ms |
| 起動 分布 | 22.4〜25.7秒＋外れ値48.8秒1点 | 22.9〜24.5秒（外れ値なし） |
| DIR A: / B: / C: / D: 中央値 | 94.67 / 116.25 / 674.87 / 79.83ms | 105.39 / 119.18 / 662.40 / 80.16ms |
| キー KeyBuf 中央値(1回目/2回目) | 4.645 / 5.880ms | 12.19 / 4.86ms |
| キー TVRAM 中央値(1回目/2回目) | 29.443 / 32.340ms | 31.32 / 30.49ms |
| 音声 beep 累積underflow | 12,184フレーム | 3,652フレーム |
| 音声 beep 欠音イベント | 5件(最大236.62ms) | 6件(最大48.41ms) |
| `outputLatency` | 0.168秒 | 0.016秒 |
| 機能失敗 | 0 | 0 |

時間指標は起動 -3.2%、DIR は ±11% 以内に収まっており、8/19に見た +26%／3.4倍のような差は出ていない。**キー入力1回目の KeyBuf 中央値だけが 4.6→12.2ms と2.6倍**だが、2回目は 5.9→4.9ms とむしろ速く、1回目・2回目の差（12.19 vs 4.86）は同一条件内の差である。起動直後の暖まりの影響が1回目に乗る構造と読めるが、**現時点では2本の観測しかなく、確定はしていない**。

音声については **`outputLatency` が旧set1と10倍違うため、underflow の減少（12,184→3,652フレーム）を日差やハーネス差に帰属できない**。この値が揃っていない限り音声の比較は成立しない、という8/19の判断はそのまま残る。

## 計測系の欠陥：残存viteの検出が一度も成立していなかった（2026-08-23）

上の1組目を取った直後、ホストを確認したところ**別セッション由来の残存 vite が2本動いていた**（`Sprout68k` の dev サーバ port 5180、もう1本 port 5299）。経過時間から**1組目の全区間で動いていた**にもかかわらず、5ファイルすべてで `competitors` は0件だった。

### 原因

competitor 条件(b)「comm に 'vite' を含む」は、**実プロセスでは絶対に成立しない**。`ps -o comm` が返すのは実行ファイルのパスであり、`node .../bin/vite` で起動された vite の comm は `node` でしかない。'vite' の文字列は `ps -o args`（コマンドライン全体）にしか現れない。

    $ ps -o pid=,comm= -p 61083
    61083 node
    $ ps -Ao pid=,args= | grep vite
    61083 node /Users/haruurara/.../node_modules/.bin/vite --port 5299 --strictPort --host 127.0.0.1

2026-08-19の「分類の確認」で「残存vite(CPU 0.1%)→competitor」を確認したことになっていたが、あれは **comm に 'vite' を含む合成オブジェクト**をルールへ直接通したものだった。現実には存在しない形のデータで、自作のルールを自作の入力で検証していた。**ルールは正しく、その手前の入力が現実と違っていた。**

上位10件からの取りこぼしを防ぐ専用ロジック（CPU使用率に関わらず vite を必ず含める）も書かれていたが、同じ理由で一度も発火していない。

### 修正（コミット `673f577`）

- `ps -Ao pid,ppid,pcpu,etime,comm -r` に **ppid** を追加。別途 `ps -Ao pid=,args=` を1回実行し、pid で突き合わせて `args` を付ける。comm と args はどちらも空白を含みうるため、1回の ps で両方を取ると解析できない。**2回の ps を pid で結合する**設計にした。args は記録時に300文字で切り詰めるが、**判定は切り詰める前の文字列に対して行う**。
- vite の判定を **args** に対して行うよう変更。SYSTEM_BACKGROUND_ALLOWLIST は従来どおり comm に対して判定する（args に対して判定すると `/WindowServer$/` のような末尾アンカーが壊れる）。
- 検出が効くようになると、**計測スクリプト自身が spawn した dev サーバ（`npm run dev` → vite）が competitor に該当し、全計測が `contended` になる**。これを避けるため、ppid から親子関係を組み立て、`process.pid` を先祖に持つプロセスに `selfDescendant: true` を付け、buildLoadReport 側で systemBackground へ退避する（記録は残す。除外≠不可視化）。

### 検証

| 検証 | 条件 | 結果 |
| --- | --- | --- |
| 陽性対照（実プロセス） | port 5399 に vite を1本起動（計測スクリプトの子孫ではない） | competitors に出現（vite本体と npm exec の2件） |
| 陰性対照 | その vite を停止 | 該当2件が competitors から消える |
| 自分の dev サーバ | `measure-boot.mjs --mode=dev` を実走 | `selfDescendant: true` で **competitors に入らず、systemBackground には記録が残る** |
| ユニットテスト | `test/measure-env.test.ts` 新規6件 | `npm test` 440件全通過 |

ユニットテストには**陽性対照**として「修正前の comm だけを見る実装では、同じ入力（comm: 'node' かつ args に vite）を competitor と判定できない」ことを明示するケースを含めた。これにより、このテストが今回の不具合を実際に検出することが担保される。

## 移行前基準：1組目の取り直し（実測、2026-08-23）

上の修正を入れたビルドで、残存 vite 2本を停止したうえで4本を取り直した。**これを移行前基準の1組目とする。**同日午前に取った `newset1-20260823-*` は、壊れた検出器が `competitors: 0件` と記録していたため基準値には採らない（記録としては残す）。数字自体が悪かったわけではなく、**記録が事実と違っていたことが理由**である。

出力は `_local/measure/newset1r-20260823-{boot,drives,key-1,key-2,audio}.json`（gitignore）。

### 条件の照合

- 5ファイルすべてで `environment.load.verdict` が **`quiet`**（正規化 loadavg1 の中央値 0.29〜0.36、最大 0.44）、`competitors` 0件。**この0件は修正後の検出器が出した0件である。**
- 計測が自ら起動した vite は `selfDescendant: true` で systemBackground 側に記録されている（除外が効いていることの証拠）。
- コミット `673f577`、`dirty: false`。同梱アセット5件の SHA-256 は**同日午前の組とも、旧 set1（8/17）とも完全一致**。
- `AudioContext.outputLatency` は5ファイルとも 0.016秒。

`git diff cc3d13e..673f577` の差分は `scripts/` と `test/` のみで、**`src/` は1行も変わっていない**。被測定物は旧 set1 と同一である。

### 結果

| 項目 | 結果 |
| --- | --- |
| 起動 | 20/20成功。中央値 23,533.59ms、p95 24,565.31ms、p99 24,582.94ms、最小 23,052.66ms、最大 24,587.35ms |
| 3ドライブ | A:/B:/C:/D: すべて 5/5成功。入力失敗・`enterLost`・ドライブ判定失敗すべて0件。中央値は A: 91.60ms、B: 112.90ms、C: 733.93ms、D: 80.18ms |
| キー入力 1回目 | 30刺激成功。KeyBuf中央値 12.548ms（p95 47.411ms）、TVRAM中央値 33.788ms。欠落・誤字・重複0 |
| キー入力 2回目 | 30刺激成功。KeyBuf中央値 4.328ms（p95 60.953ms）、TVRAM中央値 31.808ms。欠落・誤字・重複0 |
| 音声 beep | queuedSec中央値 82.472ms、p99 109.487ms。累積underflow 7,706フレーム。欠音イベント5件（合計174.739ms、最大149.637ms） |
| 音声 idle | queuedSec中央値 88.946ms、p99 156.759ms。累積underflow 11,300フレーム。欠音イベント4件（合計256.235ms、最大111.224ms） |

起動20試行を昇順に並べると 23053, 23195, 23217, 23226, 23308, 23327, 23432, 23468, 23512, 23531, 23536, 23601, 23945, 24063, 24081, 24152, 24299, 24408, 24564, 24587（ms）。**全試行が23.1〜24.6秒の1.5秒幅に収まり、外れ値は無い。**試行順に並べても単調な悪化は見られない。

### 同日午前の組との一致

| 項目 | 午前(11:41-11:59) | 取り直し(12:36-12:55) |
| --- | --- | --- |
| 起動 中央値 | 23,601ms | 23,534ms |
| DIR A: / B: / C: / D: | 105.4 / 119.2 / 662.4 / 80.2ms | 91.6 / 112.9 / 733.9 / 80.2ms |
| キー KeyBuf(1回目/2回目) | 12.19 / 4.86ms | 12.55 / 4.33ms |
| 音声 beep 欠音 | 6件・合計82.8ms | 5件・合計174.7ms |
| 機能失敗 | 0 | 0 |

**残存 vite 2本（いずれも CPU 0.0%）は、実際には測定を汚していなかった**ことがこの一致から言える。取り直しの目的は数字の改善ではなく記録の正しさだったが、結果として「CPU 0%の残存プロセスは実害が無い」という副次的な知見も得られた。ただし**これは1回の対比であり、一般化はしない**。competitor の判定を CPU 使用率で緩める根拠には使わない（残存プロセスはいつ動き出すか分からないため）。

### キー入力1回目の遅さが2組で再現した

| | 午前 | 取り直し |
| --- | --- | --- |
| KeyBuf 1回目 中央値 | 12.19ms | 12.55ms |
| KeyBuf 2回目 中央値 | 4.86ms | 4.33ms |

**独立した2組で「1回目だけ2.5〜2.9倍遅い」が再現した。**旧 set1（8/17）では 4.645 / 5.880ms とこの差が無かったため当初は日差を疑ったが、同日内の2組で揃ったことから**構造的なもの**と判断する。起動直後の暖機の影響が1回目に乗ると読める。回帰判定では**1回目と2回目を別の系列として扱う**（合算した中央値で比較しない）。

音声の欠音は 82.8ms → 174.7ms と倍増しているが、`outputLatency` は両組とも0.016秒で揃っており、旧 set1 では単発236msの例もあった。**音声は元々分散が大きく、2点では日差と分散を分離できない**。

## 決定事項（2026-08-23）

ここまでの検討で未決だった項目に結論を出す。以降の設計はこれを前提とする。

### 決定1：SASI は現状維持。新経路は SCSI のみ

- SASI は今までどおり MEMFS（イメージ全体がRAM）＋ IndexedDB 保存のまま**変更しない**。実用上限40MBもそのまま。
- したがって「まず SASI の I/O を OPFS へ差し替える」という当初の実施順序は**採らない**。
- 副次的な利点として、**SASI が対照群として常に動いたまま残る**。SCSI 側で問題が出たとき「SASI は正常か」を毎回確認でき、切り分けが容易になる。既存ユーザーの IndexedDB 資産を移行する作業も不要になる。

### 決定2：SCSI の I/O は emscripten のファイルシステムを経由しない

SCSI HLE は自分たちで書くコードであるため、I/O 経路も自前にできる。MEMFS を通さず、HLE の中から `webx68k_scsi_read(lba, buf, count)` のようなフックを呼び、その実体を JS 側で `FileSystemSyncAccessHandle` に繋ぐ。

    SASI : 既存のまま → MEMFS（イメージ全体がRAM）── 触らない
    SCSI : 新規のHLE  → 自前フック → OPFSの同期ハンドル（512バイト/セクタ）

- **wasmヒープに置くのは1セクタぶん（512バイト）のみ。**イメージサイズに比例しない。500MBのイメージでもRAM使用量は変わらない。
- 上限は RAM ではなく OPFS の割り当て容量になる。
- WasmFS の OPFS バックエンド（`-sWASMFS`）はファイルシステム層を丸ごと差し替えるため、SASI/FDD へ影響が及ぶ。**この案を採ればその切り替えは不要**になる。

### 決定3：大容量イメージが IndexedDB に載らないことを、経路の不在で保証する

現行の取り込み経路は6箇所あり、**すべてが `bytes: Uint8Array` を全量生成してから `saveDisk()` を呼んでいる**（URL読み込み・ファイル選択・アーカイブ展開・ブランク作成）。つまり IndexedDB に載る前に必ず RAM に載っている。書き込みの窓口自体は `putDisk()` の1本に集約済みである。

SCSI の取り込みは `Uint8Array` を作らず `putDisk()` を呼ばないため、**IndexedDB に到達する経路がそもそも存在しない**形にする。サイズで分岐して弾くのではなく、道を作らない。

- 大容量経路の関数は `Uint8Array` を受け取らず `File` / `ReadableStream` のみを受け取る。**型が違えば、うっかり流し込むことが構文的にできない。**
- 取り込みは `file.stream()` をチャンクのまま OPFS へ書く。
- ライブラリのメタデータ（表示名・グループ・保存時刻）は IndexedDB のままとし、実体の置き場だけを分ける。レコードに `backend: 'idb' | 'opfs'` を持たせれば一覧・リネーム・削除のUIは現行のまま動く。

### 決定4：実ファイルへの書き戻し（案②）は採用しない（2026-08-28 改訂）

XM6 との資産のやりとりについて、当初は3案を比較していた。

| 案 | やり方 | COOP/COEP | XM6との行き来 |
| --- | --- | --- | --- |
| ① OPFSのみ | 取り込み後はブラウザ内で完結 | 不要 | 都度エクスポート |
| ② OPFS＋ファイルハンドル記憶 | 選んだ実ファイルのハンドルを IndexedDB に保存し、保存時に非同期で元のファイルへ書き戻す | 不要 | 同じファイルに書き戻せる |
| ③ 実ファイル直接同期I/O | `SharedArrayBuffer` ＋ `Atomics.wait` で同期化 | 必要 | 常時共有 |

③は不採用のまま変更しない。COOP/COEP はページ単位のHTTPヘッダであり「デスクトップのみ有効」にはできないため、③を採る場合はスマートフォンを含む全アクセスに影響する。この判断は変わらない。

**②（`FileSystemFileHandle` を IndexedDB に保存し、元のファイルへ書き戻す）も採用しない。**

- 理由：`showOpenFilePicker`/`FileSystemFileHandle` はデスクトップ専用の機能であり、②はその上に立つ**本質的にデスクトップ限定の追加層**である。
- かつ、②は**OPFSの作業実体（①）の設計に一切影響しない後付けの層**でもある。ハンドルをIndexedDBに保存して書き戻す処理は、OPFSへの取り込み・保存・ダウンロードのどの経路にも変更を要求しない。後から独立して足せるので、いま作らないことの構造的コストはゼロ。
- **決定5（対象外はデバイス種別ではなく容量で切る＝プラットフォームで機能を出し分けない）とは衝突しない。** 決定5が禁じているのは「同じ能力を、プラットフォームによって出し分けて実装が2系統になること」。②は行き先（実ファイルへの書き戻し）そのものがモバイルに存在しないケースであり、出し分けではなく機能の不在にすぎない。

**採用する構成は①（OPFSのみ）。** 対応形式・ダウンロード・往復確認の扱いは以下の通り。

#### 対応形式は構造で記述する

対応形式は「`.hds` = 512バイト/セクタの生イメージ」と**構造**で記述する。変換・インポート処理は無い。

- 実測の根拠：サイズが 512 × 204,800 ちょうどで余りが無く、オフセット0がいきなりセクタ0（署名 `X68SCSI1`）。ヘッダも識別子も無い（「XM6での SASI→SCSI 移行が成立した」節、2026-08-23実測を参照）。
- つまり取り込みはバイト列をそのままOPFSへ書くだけ、書き出しはそのままダウンロードするだけ。専用の変換・インポート処理は不要かつ存在しない。
- **セクタ0の署名 `X68SCSI1` は `FORMAT.X`（Human68k側）が書いたものであり、形式を決めているのはHuman68kであってエミュレータ製品ではない。** 対応表記に製品名を出す必要はなく、出す場合は帰属を誤る（後述「公開文言の方針」）。

#### ダウンロードは連携機能ではなく eviction 対策の安全策

案②をやめたことで、**OPFSが唯一の正本になる。** `persist()` は測った3環境（デスクトップChrome・iOSのChrome for iOS・iOSのSafari）すべてで `false`（「OPFS前提条件の実機確認」各節を参照）であり、容量逼迫時にブラウザがOPFSのデータを消せる状態のまま運用することになる。
そのため、ダウンロード（エクスポート）導線は「あれば便利な連携機能」ではなく、**唯一の正本を失わないための安全策として最初から用意する。**

#### 往復確認は内部の答え合わせ専用（公開文言にはしない）

往復確認（WebX68kが書いたイメージを他の実装（XM6）に読ませ、変更が見えることを確認する）は、**内部の検証手段としては残すが、公開文言（互換アナウンス）にはしない。**

- 理由：`.hds` を書く実装も読む実装も自前になると、仕様の誤解が書き手・読み手の両側に同時に入り、検証をすり抜ける（過去のfeedback「自作実装を自作の相手役でテストすると通ってしまう」と同じ形）。手元にある独立した実装（XM6）が唯一の非自作オラクルであり、内部検証にはこれを使う。
- **受け入れ条件**：WebX68kで書き込んだ後にダウンロードしたイメージを独立した実装（XM6）が開き、その変更が見えること。**陰性対照**：書き込み前のイメージでは変更が見えないこと。
- 公開文言でこの往復確認を謳わない理由は次節「公開文言の方針」を参照。

#### 公開文言の方針

- **公開文言に他エミュレータの製品名を出さない。**「〜のイメージがそのまま使えます」的な互換アナウンスはしない。
- 対応表記は構造で書く。例：
  > SCSI ハードディスクイメージ（`.hds`、512バイト/セクタの生イメージ）に対応しています。
- 制限事項も製品名を出さずに書く。例：
  > 読み込んだ元のファイルへ直接書き戻すことはできません。更新したイメージはダウンロードして差し替えてください。
- 理由は2つ：
  1. 形式の出どころはHuman68k（`FORMAT.X`）であり、製品名を出すと帰属を誤る。
  2. 特定の第三者製品との互換を公に約束すると、その保証と検証を維持する義務を負う。往復確認は内部の答え合わせ専用（前節）であり、公開の互換保証ではない。
- **これは公開文言の方針であって、開発記録から特定の第三者アプリへの言及を消すという意味ではない。** 「XM6のHDS資産の移行（流れ）」「XM6での SASI→SCSI 移行が成立した（実測、2026-08-23）」「基準器の扱い」「権利上の扱い」の各節は、道具として使った実測記録であり出自の説明に必要なため、一切変更しない。
- **注意**：この方針は README.md / README.ja.md / help ページ等の公開文書そのものへの反映は含まない。SCSI機能はまだ実装されていないため、公開文言を実際に書くのは実装後。今回はdocsに方針を記録するのみ。

### 決定5：対象外はデバイス種別ではなく容量で切る

大容量HDDをスマートフォン対象外とする場合も、**機能フラグでプラットフォームを分けない**。経路は1本のまま「このイメージは大きすぎて開けません」と容量で断る。実装が2系統になって両方を検証し続ける事態を避け、端末性能の向上に自然に追随できる。

## RAMに載っていないことの検証方法（決定2の受け入れ条件）

コードを読んで納得するだけでは足りないため、末端で測る。

- **合格条件**：500MB級のSCSIイメージをマウントしても **wasmヒープの実サイズ（`memory.buffer.byteLength`）が増えない**こと（512バイト単位の誤差のみ）。
- **陽性対照**：同じサイズのイメージを現行のSASI経路に通すと**ヒープがイメージサイズぶん増える**こと。これが取れなければ、検査自体が動いていない。

### 決定3の受け入れ条件（IndexedDBのレコード列挙、2026-08-28 書き直し）

当初は `navigator.storage.estimate()` の `usageDetails`（OPFS/IndexedDB の内訳）で検証する案だったが、**iOS（Chrome for iOS・Safari とも）では `usageDetails` が常に `null` で使えない**（2026-08-26 実測、後述）ため、Chrome限定の検証手段のまま実装を進めると受け入れ条件がクロスブラウザで満たせない。そこで **IndexedDB のレコードを列挙して実サイズを合計する**方式に置き換えた。

- 実装：`src/disk-store.ts` の `measureDiskLibraryBytes()`。`disks` ストアを `openCursor()` で1件ずつ進めながら、各レコードの実体（`Uint8Array`/`ArrayBuffer`/`Blob`）の `byteLength`/`size` だけを取り出して合計する（`listDisks()`/`getAll()` は再利用しない）。`estimate()` は一切使わない。合計・レコードごとの内訳（key・種別・バイト数）に加えて、`kind: 'unknown'` と判定されたレコードだけを抜き出した `unknownRecords` も返す。
  - **カーソルにした理由**：陽性対照は500MB級のイメージをSCSI経路に通して測る。`getAll()` は全レコードの実体を配列として同時にRAMへ展開してしまうため、「RAMに載っていないことを確認する」測定自体が対象と同じことをしてしまう。カーソルなら任意の時点でRAMにあるのは1レコードぶんだけで済む。
- **合格条件**：SCSIイメージをマウントしても、`measureDiskLibraryBytes()` の合計（`totalBytes`）が増えないこと（メタデータぶんの数百バイトを除く）、**かつ `unknownRecords.length === 0` であること**。
  - **後者が要る理由**：未知の型（`Uint8Array`/`ArrayBuffer`/`Blob` のいずれでもない実体）のレコードは `byteLength` が常に0として数えられる。そのため実際にはデータが載っていても `totalBytes` は増えず、「合計が増えないこと」という合格条件を失敗状態のほうが完璧に満たしてしまう。`unknownRecords` の件数も確認することで、この見落としを塞ぐ。
- **陽性対照**：同サイズを現行の SASI 経路（`saveDisk()`/`putDisk()`）に通すと、`totalBytes` がイメージサイズぶん増えること。`test/disk-store.test.ts` にこの陽性対照（1件追加で合計がそのサイズぶん増える）と、故障注入（`byteLength` を無視して件数だけ数える壊れた実装に書き換えると失敗することを確認してから復元）を実装済み。
- **この方式は全ブラウザで成立する。** `estimate()`/`usageDetails` に依存せず IndexedDB API（`openCursor()`）を直接叩くだけなので、iOS でも Chrome と同じ値・同じロジックで検証できる。
- 副産物として分かっていた `usage` の値の性質（この方式が必要な理由の背景）：
  - **IndexedDBの`usage`は生バイト数ではない**：デスクトップChromeで16MiB書き込みの増分が853,362バイト（約20分の1）に圧縮された（2026-08-24実測）。
  - **iOSの`estimate()`は総量としても信用できない**：削除しても`usage`が減らず、さらに1MiB単位に量子化されている（2026-08-26実測）。
  - **圧縮率はデータ依存かつ環境依存**：同じ16MiB書き込みでもiOSではほぼ生サイズの増分になり、デスクトップChromeの圧縮は環境固有の観測だった。
  - これらはいずれも`estimate()`側の癖であり、`measureDiskLibraryBytes()`はストレージの内部実装を経由せずレコード実体を直接数えるため、この影響を受けない。

## XM6のHDS資産の移行（流れ）

1. **HDSのバイト構造を確定する（実測）** — ヘッダの有無・サイズ、セクタサイズ、先頭にHuman68kのパーティションセクタが来るか。資料ではなく実物を `hexdump` して確認する。**SCSIの実装を待たずに今日でもできる調査**であり、後段の不確実性を先に消せる。参考として現行SASIは256バイト/セクタ・ヘッダ無しの生イメージ（`sasi.c` の `SASI_Buf[256]`）、SCSIは512バイト/セクタ。
2. **読めるようにする** — 生イメージならHLEが512バイト/セクタで読み書きするだけでマウントできる見込み。ヘッダ付きならオフセットを飛ばすか取り込み時に剥がすかを決める。
3. **ゲスト側が認識するか** — イメージが読めることとHuman68kがドライブとして見えることは別。XM6で作られたHDSは何らかのドライバの流儀でパーティションが切られており、こちらのIOCS実装と噛み合うかは実物を通さないと分からない。
4. **持ち込む導線** — 数百MB級が普通であるため、決定3の経路（ストリームでOPFSへ）に載せる。

## XM6での SASI→SCSI 移行が成立した（実測、2026-08-23）

SCSI対応の目的は容量拡張だが、**既存環境を移行できなければ移行先にならない**。手持ちのSASI環境をSCSIへ移せるかを、XM6を道具として使って実際に確かめた。結果は成立で、これによりHLEの必要実装範囲が狭まった。

なお、XM6は**道具として使うだけ**であり、そのソースコードは参照しない（後述の「権利上の扱い」）。

### 検体1：空のSCSIイメージ（100MiB）

XM6用に作成した未使用のHDSを測った。

- サイズ 104,857,600バイト = ちょうど100MiB。**512で割り切れる**（204,800セクタ）
- **全域がゼロ**（非ゼロバイト0、署名なし）

サイズがちょうど100MiBであることから、**`.HDS` にヘッダは付かず、512バイト/セクタの生イメージである**と判断できる（固定長ヘッダがあればサイズが半端になる）。ただし検体1本の根拠である。

**全域ゼロであることが後で効いた。**フォーマット後との差分を取れば、Human68kが書いたセクタだけが正確に浮かび上がる。

### 検体2：移行元のSASIイメージ（40MB相当）

WebX68kから吸い出したSASIイメージ（41,496,576バイト = 162,096セクタ × 256バイト）を測った。

- 0x000: IPL。`X68000 HARD DISK IPL MENU` の文字列を含む
- 0x400: パーティションテーブル `X68K` 署名。総セクタ数 `0x27930` = 162,096 で**ファイルサイズと完全一致**
- 0x410: パーティション1 `Human68k`、開始セクタ33、サイズ162,040セクタ

イメージとして破損は無い。ディレクトリエントリを走査したところ、`HUMAN.SYS`（属性0x24）は存在するが **`COMMAND.X` が存在しない**ことが分かった。`CONFIG.SYS` は `SHELL=Command.X -P -E:30` を要求しており、また `DEVICE=\Sys\FLOAT2P.X` も実在しない（実在するのは名前の異なる別ファイル）。**このディスクは単独では起動できない構成だった。**

### 移行の手順（実際に通った手順）

1. XM6でSASIとSCSIの両方を認識させる
2. Human68kのシステムFDから起動する（**移行元から起動する必要はない**）
3. SCSI側を `FORMAT.X` で領域確保・フォーマット
4. システムFDに入っている `COPYALL.X` でディレクトリごとコピー
5. 不足していた `COMMAND.X` をシステムFDから補う

移行元ディスクにはコピー用ツールが入っていなかったが、**Human68kのシステムFDに `COPYALL.X`・`SYS.X`・`ATTRIB.X`・`CHKDSK.X`・`FC.X`・`TREE.X` が揃っている**。手持ちのディスクに何が入っているかは、イメージのディレクトリエントリを走査すれば事前に分かる。

### 結果の検証

コピー後のイメージをディレクトリエントリ単位で移行元と突き合わせた。

- **ファイル数は完全一致、欠落0件**
- `HUMAN.SYS`（属性0x24＝システム属性付き）も運ばれている。`COPYALL.X` は隠し・システム属性を落とさない
- **SCSIから起動できることを実機同等の環境（XM6）で確認**

### 移行後イメージの構造（基準器としての値）

| 項目 | 値 |
| --- | --- |
| サイズ | 104,857,600バイト（512 × 204,800セクタ） |
| 非ゼロデータ | 14,442,849バイト |
| 使用セクタ | 34,871 / 204,800（データはセクタ38,359で終端、以降は未使用） |

先頭64セクタの非ゼロマップ（`#`=データあり、`.`=全ゼロ）:

    sec  0- 15: #.###.########..
    sec 16- 31: ....############
    sec 32- 63: ................

- **セクタ0** … `X68SCSI1` 署名＋`Human68K SCSI-DISK by Keisoku Giken`（`FORMAT.X` が書くSCSIディスクID）
- **セクタ4**（オフセット0x800） … `X68K` パーティションテーブル
- セクタ2-3・6-13・20-31 … IPLと管理領域
- セクタ32以降は空き

元が全域ゼロだったため、**この地図は「Human68kが書いた場所」そのものである。**通常は既存データに埋もれて分離できない情報が、空の検体から始めたことで正確に取れた。

## 決定6：SCSI HLE の必要範囲は「読み書き＋認識」まで

整形も引っ越しもXM6側で完結できることが実測で示されたため、WebX68k側のHLEに必要なのは

1. セクタの読み書きが通ること
2. Human68kにドライブとして認識されること

の2点である。**`FORMAT.X` を満足させるための問い合わせ系（容量申告など）の実装は、クリティカルパスから外す。**ゲスト内でのフォーマット機能は、後から足す利便機能に降格する。

これは 2026-08-23 前半に書いた「(a) ゲスト内でFORMAT.Xを通す／(b) ホスト側で整形済みイメージを用意」の二択に対する結論でもある。**(b)を採るが、整形を自前で構築するのではなくXM6に任せる**ため、(b)の弱点だった「自作の構造を自作の実装で読む」形にはならない。フォーマットの正しさはHuman68k自身が保証している。

## 基準器の扱い

移行後のイメージを、実装時の答え合わせ用の基準器として保管する。

- 保管場所は**リポジトリの作業ツリーの外**。参照は環境変数 `WEBX68K_SCSI_FIXTURE` 経由とし、**個人のパスをリポジトリに焼き込まない**
- 理由(1)：`WebX68k` と `WebX68k-storage` は**同一リポジトリの2つのworktree**であり、片方の `_local/` に置いても他方からは見えない。worktreeが増えるたびに追随できなくなる
- 理由(2)：`git clean -fdx` は `.gitignore` された `_local/` ごと消す
- 理由(3)：**このイメージには第三者のソフトウェアが含まれる**。リポジトリにも公開成果物にも同梱しない

自動テスト用に検体が必要になった場合は、**中身が自作物だけのイメージを別途作る**。手元の基準器は開発時の照合専用とする。

### 権利上の扱い

XM6は**道具として使うだけ**で、そのソースコードや第三者による解析記事は参照しない。理由は2つ。

- コアの px68k-libretro は **GPLv2** であり、別ライセンスのコードを取り込めない。仮に参照元が改変・再利用を許していても、GPLv2側へは持ち込めない
- 今回参照したくなる箇所がまさにSCSI実装そのものであり、**「参考にした結果、構造が似た」が最も起きやすい**。後から「読んでいない」と言えなくなる

代わりの経路は、**自分の手元のイメージを測ること**（本節はすべてその産物）、公開マニュアル類、px68k自身のコードである。判定基準は既存の方針どおり「**測定で裏が取れる種類の情報か**」。今回必要だった情報は全てこの基準を満たした。

## 実施順序（更新）

1. **ワーカー移行** — SASI・MEMFSのまま。移行前基準（`newset1r-20260823-*`）と突き合わせて回帰が無いことを確認する。
2. **SCSI HLE** — 基準器のイメージをマウントし、Human68kがドライブとして認識するところまで。読み出しが正しければ上記の構造どおりのバイトが返るため、答え合わせができる。
3. **I/Oの実体をOPFSへ差し替え** — 決定2のフックを差し替えるだけなので、壊れたら原因はそこに限定される。
4. **取り込み導線** — ストリームでOPFSへ流し込む（決定3）。ユーザーが持つイメージをそのまま開けるようにする。
## OPFS前提条件の実機確認（実測、2026-08-24）

移行前基準の2組目を取りに行ったが、**ホストが静穏でなかったため取得を見送った**（後述）。代わりに、計測に依存しない「未調査の項目」のうちブラウザ側の前提3件を実機で確認した。ここが崩れると決定2・決定3の土台ごと作り直しになるため、ワーカー移行に着手する前に潰しておく。

再現手順は `scripts/probe-opfs.mjs`（配信＋実行を自己完結）。`--serve` を付けると配信だけ行うので、普段使いのプロファイルのブラウザやiOS実機からも同じページを開ける。

### 測定環境の注意：Electron製ブラウザで測ると桁が変わる

同じページを2つの環境で走らせた。能力の有無（A〜E）はすべて一致したが、**スループット（F）だけは30倍違った**。

| | 512B順次書き | 512Bランダム読み |
| --- | --- | --- |
| Chrome 151（計測ハーネスと同じ） | 6.3〜8.2 µs/セクタ | 6.1〜12.3 µs/セクタ |
| Claude の Browser ペイン（Electron 42 / Chromium 148） | 197.2 µs/セクタ | 138.5 µs/セクタ |

`quota` も 10.7GB と 3.37GB で違う。**OPFSの性能値をElectron系のブラウザで測ってはいけない。**以下の数値はすべて Chrome 151 のもの。

### 結果

| 項目 | 結果 | 判定 |
| --- | --- | --- |
| ワーカー内の `createSyncAccessHandle` | 成功。512バイト×64セクタを書き、**書いた順とは違う順**（63,0,17,62,1,40）で読み戻して全バイト一致 | 決定2は成立する |
| メインスレッドの `createSyncAccessHandle` | `TypeError: not a function`（メソッド自体が存在しない） | 対照。ワーカー必須であることの確認 |
| ファイル末尾を越えた読み | 0バイト（例外ではない） | 範囲外は静かに0が返る。**呼び出し側で戻り値を検査しないと、読めていないことに気づけない** |
| `navigator.storage.estimate()` の `usageDetails` | **利用可能**。キーは `fileSystem` と `indexedDB` | 決定3の検証手段が成立する |
| 512MiB の確保 | `truncate` で確保でき、末尾セクタ（オフセット536,870,400）へ書いて読み戻した内容が一致 | 大容量は扱える |
| `navigator.storage.persist()` | **`false`**（`persisted()` は前後とも `false`） | **未解決。下記** |
| 512Bセクタ単位の同期I/O | 順次書き 6.3〜8.2µs／ランダム読み 6.1〜12.3µs（4096セクタ） | 1フレーム16.7msに対し1セクタ約10µs。**ボトルネックにならない** |
| 1MiB 一括書き | 3.7〜4.0ms | セクタ単位より2桁効率が良い。取り込み（決定3）はチャンクで流す前提でよい |

### `truncate` は疎ファイルにならない

512MiB を `truncate` しただけで `usageDetails.fileSystem` が 553,681,600 バイトになった。**確保した時点で実サイズぶんの割り当てを消費する。**「イメージは500MBだが実際に使っているのは14MBだけ」という節約は効かない。ディスクライブラリの容量表示は確保サイズで出すのが正しい。

削除後は `fileSystem` のキーごと消え、`usage` が 2,390 バイトまで戻った。後片付けも効いている。

### 副産物：IndexedDB の `usage` は生バイト数ではない

陽性対照として IndexedDB に 16MiB（`(i*13)&0xff` の周期パターン）を書いたところ、`usageDetails.indexedDB` の増分は **853,362 バイト**しかなかった。約20分の1に圧縮されている。OPFS 側は 16,777,394 バイトとほぼ生サイズだった。**この圧縮はデスクトップ Chrome 固有の観測だった**（2026-08-26 の iOS 実測では同じ16MiB書き込みで増分が生サイズとほぼ同じになっており、後述）。

決定3の受け入れ条件で「IndexedDB に載っていないこと」を `estimate()` の数字で確かめる場合、**圧縮率がデータ依存かつ環境依存であるため増分の絶対値は根拠にならない**。既に書いていた「IndexedDB のレコードを列挙してサイズを合計するほうが確実」という方針を、この測定は裏づけている。

### 未解決：`persist()` が `false` を返す

`navigator.storage.persist()` が `false` で、プロンプトも出ない。**永続化が取れないなら、ユーザーの数百MBのイメージが容量逼迫時に消えうる。**決定3で「IndexedDBに載せない」と決めた以上、退避先も無い。

ただし今回の測定は **puppeteer が起動した使い捨てプロファイルの初回訪問**であり、この条件で拒否されること自体は不自然ではない。判定材料が足りない。切り分けるべきは以下。

- 普段使いのプロファイルで、実際に使っている本番URLを訪問した状態ではどうか（`--serve` で同じページを開けば確認できる）
- 拒否されたまま運用する場合に、いつ・どういう条件で evict されるのか
- iOS WebKit ではどうか

**「取れないかもしれない」ことを前提に、取り出す道（エクスポート）を先に用意する**ほうが安全という読みは変わらない。

### 今回わかっていないこと

- **iOS WebKit は未確認。**同じページを実機で開く必要がある（`--serve` の LAN URL 経由。ただしFW許可は実体パスで判定される点に注意）。→ **2026-08-26 に確認済み。後述の「OPFS前提条件の実機確認（iOS、実測、2026-08-26）」を参照。**
- eviction の実挙動は未確認。容量を逼迫させる実験をしていない。
- ワーカー内でコアを回しながら同期I/Oを行ったときの干渉は未確認。今回はワーカーがI/Oしかしていない。

## OPFS前提条件の実機確認（iOS、実測、2026-08-26）

8/24にデスクトップ Chrome で確認した OPFS 前提条件のうち、**未確認のまま残っていた iOS WebKit** を実機（iPhone / iOS 26.6）で確認した。同じ `scripts/probe-opfs.mjs --serve` のページを **Chrome for iOS**（`CriOS/151.0.7922.112`）と **Safari**（`Version/26.6`）の2ブラウザで実行し、両者の結果ファイルを突き合わせた。iOS 上のブラウザはどれも WebKit 実装を共有するため、2ブラウザの一致はエンジン単位の裏取りとして意味を持つ。

### secure context の罠：測定方法そのものが崩れかけていた

`navigator.storage`（StorageManager、`estimate()` や `persist()` の入口）は **secure context 専用**であり、そうでない文脈では未定義になる。デスクトップでの計測は `http://127.0.0.1` を使っていたため気づかなかったが、`127.0.0.1` は例外的に secure context 扱いされるだけで、**`http://<LAN IP>` で iPhone から開くと secure context にならない**。

これに気づかず iPhone で開いていたら、A〜F すべてが「非対応」として返り、**「iOS は OPFS に対応していない」という誤った結論**を導いていたはずだった。能力が無いのではなく、**配信方法（平文HTTP）が能力そのものを隠す**という形の失敗であり、他の実機計測でも踏みうる罠として単独の小見出しにしておく。

対処として `scripts/probe-opfs.mjs --serve` を HTTPS 化した（コミット `15025a5`）。自己署名証明書は `_local/probe-cert/`（gitignore済み、リポジトリには含まれない）。**iOS Safari は自己署名証明書の警告をバイパスしたページでも `isSecureContext: true` を返すことを実測で確認した**（事前には成立するかどうか確証が無かった）。また `--serve` は証明書が見つからない場合に http へフォールバックせずエラー終了する。secure context でないページを配ると測定そのものが黙って無意味になるため、フォールバックさせない設計にしている。

実際、今回の2本の結果ファイルはいずれも `isSecureContext: true` で取れている。

### 「2回の実行が本当に別実行だった」ことの確認

Chrome for iOS と Safari の結果は、`usage`／`quota` 系の数値が **バイト単位まで完全に一致**した（後述の表）。これだけを見ると「同じファイルの使い回しではないか」と観測系の故障を疑う場面である。

一致は 1MiB 量子化（後述）で説明がつく一方、**F. スループットのランダム読みだけは Chrome 版 1.71µs／Safari 版 5.86µs と値が割れた**（結果ファイルの `f.randReadUsPerSector`）。これが「2回は別々に実行された」ことの直接証拠になる。

教訓として、**完全一致しうる指標だけで結果を揃えると、再送・キャッシュ・取り違えを検出できない**。実行ごとに必ず違う値を取りうる指標（今回ならスループットのような外乱を受けやすい値）を、同じ結果ファイルに最低1つ含めておく必要がある。

### 結果

A〜E は Chrome for iOS と Safari で完全に一致した（`_local/opfs-probe/ios-20260826-160103.json` と `ios-20260826-160319.json`、gitignore済み）。

| 項目 | iOS の結果 | 8/24 の Chrome 151（デスクトップ）との対比 |
| --- | --- | --- |
| `isSecureContext` | true | true |
| A. メインスレッド同期ハンドル | `createSyncAccessHandle` が undefined（想定どおり失敗） | 同じく失敗（対照） |
| B. ワーカー内同期ハンドル | 成功。`size`/`expectedSize` とも32768、`mismatch: null`、`readBeyondEnd: 0` | 成功 |
| C. `usageDetails` | **`null`**（内訳が取れない） | 利用可（キーは `fileSystem`／`indexedDB`） |
| D. `persist()` | `false`（`persisted()` は前後とも `false`） | `false` |
| E. 512MiB確保 | 成功。`sizeAfterTruncate` 536,870,912、末尾536,870,400へ書いて512バイト読み戻し一致。`quota` **41,231,686,042** | 成功。`quota` 10.7GB |
| F. スループット（参考値） | 順次書き 2.2µs/セクタ。ランダム読み Chrome版1.71µs／Safari版5.86µs。`bulkWrite1MiBMs: 0` | 順次書き6.3〜8.2µs／ランダム読み6.1〜12.3µs |

`estimate()` の推移（両ブラウザで数値まで完全一致）:

| 時点 | `usage` |
| --- | --- |
| 初期 | 1,048,576 |
| OPFS +16MiB 後 | 17,825,792 |
| IndexedDB +16MiB 後 | 34,603,073 |
| 512MiB確保後 | 705,691,713 |
| 後片付け（全ファイル削除）後 | **839,909,441** |

### 決定2は成立する

B（ワーカー内同期ハンドル）が成功した。「SCSIのI/Oはワーカー内でOPFSの同期ハンドルに繋ぐ」という決定2の土台はiOSでも揺るがず、**ワーカー移行の対象範囲を変更する必要は無い**。

### 決定3の検証手段は iOS では成立しない

C の `usageDetails` が **常に `null`** で返る。デスクトップChromeでは `fileSystem`／`indexedDB` の内訳が取れたが、iOSではOPFSとIndexedDBを `estimate()` で分離する方法が無い。上の「RAMに載っていないことの検証方法（決定2の受け入れ条件）」の節をこの実測にあわせて更新した。**Chromeでは内訳が使えるが、iOSでは使えないため、IndexedDBのレコード列挙を検証手段の正とする**。（2026-08-28: 実装済み。上の節の「決定3の受け入れ条件（IndexedDBのレコード列挙、2026-08-28 書き直し）」を参照。）

### iOS の `estimate()` は総量としても信用できない

理由は2つ。

1. **削除が反映されない。**後片付けで作成した全ファイルを削除したにもかかわらず、`usage` は 705,691,713 → **839,909,441 バイトへ増えた**。デスクトップChromeでは削除後に `usage` が2,390バイトまで戻っており、対照的な挙動になっている。削除がまったく反映されないか、反映が計測時間内には収まらないほど遅延していると考えられる。
2. **1MiB単位に量子化されている。**初期値の1,048,576はちょうど1MiB、OPFS+16MiB後の17,825,792はちょうど17MiBで、実データ量（+16,777,216のはず）とずれる。量子化があるため、細かい増減を `usage` の絶対値で追う検証は成立しない。

### 「IndexedDBは圧縮される」はデスクトップChrome固有の観測だった

8/24の測定では「16MiB書き込みで増分853,362バイト（約20分の1に圧縮）」と記録したが、これはあくまで**その時点・その環境での観測**であり、iOSでは条件が変わる。iOSの `c.e2` と `c.e1` の差分（IndexedDB +16MiB時の `usageDetails` は `null` のため直接の内訳は無いが、`usage` 全体の増分から見る）は Δ16,777,281バイトとほぼ生サイズであり、デスクトップChromeで見られた圧縮はここでは起きていない。**圧縮率はデータ依存であるだけでなく、環境（ブラウザ・OS）依存でもある**。8/24の記述を否定するものではなく、条件付きの観測だったと理解し直す。

### E が通ったことで、iOS固有のサイズ上限は不要と判断する

事前には「iOSはOPFSのクォータが厳しく、大容量イメージの確保で落ちるのではないか」という懸念があった。実測では512MiBの確保・末尾セクタの読み書きが問題なく成立し、`quota` は **41,231,686,042バイト（約38.4GiB）**とデスクトップの10.7GBを上回った。**この想定は外れた。**iOS向けに個別のサイズ上限を設ける必要は無い。予想が外れたこと自体を記録として残す。

### D（`persist()`）は3環境目もfalse

使い捨てプロファイルのデスクトップChrome・iOSのChrome for iOS・iOSのSafariの3環境すべてで `persist()` はfalseだった。「永続化は取れない前提で、取り出す道（エクスポート）を先に用意する」という8/24の読みが一段強まった。ただし**普段使いのChromeプロファイルでの確認はまだ済んでいない**（「次にやること」参照）ため、「取れない」と断定はしない。

### 結果の回収経路

実機の結果は手で転記せず、ページから `POST /result` でMac側へ自動回収して `_local/opfs-probe/` に保存する経路を先に用意した（コミット `11c8c46`）。スクリーンショットからの数値転記による事故を避ける狙いで、今回の2本のJSONもこの経路で取得している。

### 今回わかっていないこと

- **iPadは未確認。**iPhoneのみで確認した。
- eviction の実挙動は依然未確認（`persist()` がfalseのまま運用したときに、いつ・どういう条件で消えるのか）。容量を逼迫させる実験をしていない。
- ワーカー内でコアを回しながら同期I/Oを行ったときの干渉は依然未確認。今回もワーカーはI/Oしかしていない。

## OPFS前提条件の実機確認：負荷併走・バックグラウンド復帰・排他（iOS、実測、2026-08-26）

同日、上の節で残っていた3つの未確認事項（負荷併走時の干渉、バックグラウンド復帰、ファイル排他）を2本目のプローブ（`scripts/probe-opfs-load.*`、コミット `2ebdf12`）で確認した。環境は同じく iPhone / iOS 26.6 / Safari（`Version/26.6 Mobile/15E148 Safari/604.1`）、`isSecureContext: true`。結果ファイルは `_local/opfs-probe-load/ios-20260826-162531.json`（gitignore済み）。

### 項目1：コア相当の負荷と併走させたときの同期I/O干渉

負荷ループを1フレーム16.7msぶんに較正し、そのフレーム内でNセクタ（512B/セクタ）の同期read/writeを行う。300フレーム×5水準。`timerResolutionMs` 実測1.0ms、`blockSize` 2、`reps` 9,923,230。

| N | 中央値 | 最大 | 目標超過フレーム |
| --- | --- | --- | --- |
| 0（対照）| 16.5ms | 17ms | 102/300 |
| 1 | 16.5ms | 18ms | 110/300 |
| 8 | 16.5ms | 18ms | 124/300 |
| 64 | 17ms | 17ms | 214/300 |
| 256 | 17.5ms | 18.5ms | 300/300 |

比較として8/24〜25に取得したMac Chrome（同じプローブ、同日別環境）:

| N | 中央値 | 最大 |
| --- | --- | --- |
| 0（対照）| 1.6ms | 24.7ms |
| 1 | 2.1ms | 18.2ms |
| 8 | 2.1ms | 24.6ms |
| 64 | 2.4ms | 41.7ms |
| 256 | 2.3ms | **249.2ms**（16.7ms超え2フレーム） |

**256セクタ（128KB）/フレームで中央値が+1.0ms（16.5→17.5ms、約6%）。**1セクタあたり約3.9µsで、8/26の単体スループット測定（順次書き2.2µs／ランダム読み1.71〜5.86µs）と整合する値であり、**同期I/Oがフレーム予算を食い潰すような規模の干渉ではない。決定2は性能面でも成立する**。

**ただしiOSではテール遅延を観測できていない。**`performance.now()` が1ms刻みにクランプされている（`timerResolutionMs: 1.0` は推測ではなく実測値そのもの）ため、ブロック化しても粒度0.5msしか出ない。Mac Chromeで観測された249.2msのような大きな外れ値が起きていれば1ms分解能でも見えるはずなので「その規模のテールは起きなかった」とは言えるが、**数ms規模のテールは原理的に見えない**。「iOSは最大18.5msに収まった＝デスクトップより安定している」と読んではいけない。

**なお性能値は環境間で直接比較しない**（`Electron系ブラウザは性能値を30倍歪める` の教訓のとおり）。ここで採るのはMac Chromeとの数値の大小比較ではなく、「デスクトップでは大きなテールが観測できた（＝この計測手法はテールを検出しうる）」という定性的な事実だけである。

**`framesOverTargetMs` はこの設計では判定に使えない。**負荷ループを16.7msちょうどに較正しているため、**I/Oが無いN=0の対照群の時点で既に102/300フレームが目標を超えている**。I/Oを足せば必ず増える構造の指標であり、102→300という増加そのものは干渉の大きさを表さない。これは指標の設計ミスであり、「合格条件が失敗状態のほうを強く満たす」系の失敗の一種として扱う。記録には残すが、判定には使わない。

### 項目2：バックグラウンド復帰

```
{"backgrounded": true, "elapsedHiddenToVisibleMs": 14880, "workerAlive": true, "handleUsable": true, "ioResult": {"ok": true, "got": 512}}
```

14.9秒バックグラウンドにした後、ワーカーは生存し、同期アクセスハンドルは使用可能で、512バイトの読み出しにも成功した。**復帰時の特別な救済処理は不要。**

ただし**試したのは14.9秒だけ**。数分〜数十分の凍結、メモリ逼迫下、他アプリ起動を挟んだ場合は未確認であり、この限界を超えて一般化しない。

### 項目3：ファイル排他 — 例外名がブラウザで違う

同一ファイルへの同期アクセスハンドルの多重取得を試した。

- 1つ目の取得：成功
- 1つ目を保持したまま2つ目を取得：**失敗**
- 1つ目を `close()` した後に2つ目を取得：成功

排他自体はiOSでも効く。ただし**同じ失敗が返す例外名がブラウザで違う**。

| 環境 | 例外 |
| --- | --- |
| Mac Chrome | `NoModificationAllowedError` |
| iOS Safari | `InvalidStateError: The object is in an invalid state.` |

同じ「既に開かれているので取得できない」という失敗が、ブラウザによって別の例外名で返ってくる。**例外名で分岐する実装は、想定していなかった側のブラウザで無言で外れる**。もし2タブ目に「別タブで使用中です」の案内UIを出す実装を、キャッチした例外の `name` で判別する形にしていたら、iOSでは `NoModificationAllowedError` を待ち構えて外れ、無関係なエラー扱いになっていたはずである。

設計方針として、**取得の成否は例外名では判別せず、「失敗したこと自体」で扱う**（try/catchで失敗を一括して「使用中」とみなし、例外の種類は分岐条件に使わない）。

なお2タブでの手動相互確認は任意扱いにしており、**未実施**（`manualCrossTab: {"tested": false}`）。排他が効くこと自体は上記の単一タブ内の多重取得で確認できているが、実際に2枚のタブ・2つのプロセス間で起きるかの実地確認はまだ済んでいない。

### 今回わかっていないこと

- iOSのテール遅延（`performance.now()` の1ms分解能により、数ms規模のテールは原理的に観測できない）
- 長時間のバックグラウンド化（14.9秒しか試していない。数分〜数十分の凍結やメモリ逼迫下は未確認）
- 2タブでの排他の実地確認（排他が効くことは単一タブ内の多重取得で確認済みだが、案内UIの出し方は未定でありUIを含めた実地確認は未実施）
- **合成負荷であること。**項目1の負荷はコア相当を模したループであり、実際のエミュレータコアのメモリアクセスパターンやGCの発生とは異なる。合成負荷での結果を本物のコア負荷にそのまま外挿しない

## 移行前基準の2組目：2026-08-24は取得を見送った

条件のうち (a)(b) は満たしていた。

- 同梱アセット5件の SHA-256 は `newset1r-20260823-*` と**全件一致**
- `git diff cc3d13e..HEAD -- src` は空。**被測定物は1バイトも変わっていない**

満たせなかったのは静穏条件である。計測前に本番の判定器（`buildLoadReport`）へ現状を通したところ、competitor が4件検出された。

| プロセス | CPU | 経過 |
| --- | --- | --- |
| Google Chrome Helper (Renderer) | 60.5% | 2時間57分 |
| Google Chrome Helper (GPU) | 47.2% | 23時間 |
| Parallels VM (Windows 11) | 29.3% | 22時間40分 |
| 別プロジェクト(WebNP2)の残存 vite | 0.0% | 12時間 |

load average は 4.07（正規化 0.51）。1組目は正規化 中央値 0.29〜0.36・最大 0.44・competitors 0件で取っている。この状態で走らせても全ファイルが `contended` になり、2組目としては採れない。いずれも並行する別セッションが使用中で停止できないため、取得を見送った。

**計測前にこの確認を入れる運用は今回が初めてであり、実際に機能した。**8/23の1組目では計測後にホストを確認して残存 vite に気づき、取り直しになっている。順序を前に倒したことで、20分ぶんの空振りを回避できた。
## 移行前基準：2組目（実測、2026-08-25）

8/24は静穏条件を満たせず見送ったが、翌8/25に条件が揃ったため取得した。**これを移行前基準の2組目とする。**
出力は `_local/measure/newset2-20260825-{boot,drives,key-1,key-2,audio}.json`（gitignore）。

### 条件の照合

- 5ファイルすべてで `environment.load.verdict` が **`quiet`**、`competitors` **0件**
- 同梱アセット5件の SHA-256 は `newset1r-20260823-*` と**全件一致**
- コミット `dbf8299`、`dirty: false`。`git diff cc3d13e..HEAD -- src` は空で、**被測定物は1組目と同一**
- 正規化 loadavg1 の中央値は 0.31〜0.45。**1組目（0.29〜0.36）より静かな側に振れているファイルと、やや高いファイルがある**（`key-2` のみ中央値0.45・最大0.56で、最大値は閾値0.5を超えている。判定は中央値で行うため `quiet`）

計測前に `buildLoadReport` を直接呼んで静穏を確認する運用を今回も実施した。1回目の確認では Parallels VM と別プロジェクトの vite 2本が検出されて `contended` だったため、停止後に再確認して `quiet`（正規化中央値 0.15、competitors 0件）を得てから開始している。

### 取得中に起きたこと：起動計測のみ Chrome の起動段階で落ちた

4本を順に流したところ、**起動計測だけが37秒で失敗**した。

    TimeoutError: Timed out after 30000 ms while waiting for the WS endpoint URL to appear in stdout!
        at ChromeLauncher.launch (...)

puppeteer が Chrome を起動して WebSocket エンドポイントを待つ段階での失敗であり、**計測ロジックには到達していない**。他3本は同じ Chrome を同じ方法で起動して完走している。単発の事象と見て起動計測のみ取り直した（09:24〜09:34）。他3本は 09:14〜09:23 の取得である。

再現していないため原因は特定できていない。**再発したら記録する**。なお、実行スクリプト側で `|| echo BOOT_FAILED` を付けていたため、全体としては終了コード0で終わっているにもかかわらず失敗に気づけた。付けていなければ「4本完走」と誤認していた。

### 結果

| 項目 | 結果 |
| --- | --- |
| 起動 | 20/20成功。中央値 24,332.17ms、p95 25,393.79ms、p99 25,625.87ms、最小 23,815.51ms、最大 25,683.89ms |
| 3ドライブ | A:/B:/C:/D: すべて 5/5成功。入力失敗・`enterLost`・ドライブ判定失敗すべて0件。中央値は A: 114.46ms、B: 109.73ms、C: 771.81ms、D: 81.01ms |
| キー入力 1回目 | 30刺激成功。KeyBuf中央値 8.858ms（p95 36.409ms）、TVRAM中央値 31.275ms。欠落・誤字・重複0 |
| キー入力 2回目 | 30刺激成功。KeyBuf中央値 4.505ms（p95 48.876ms）、TVRAM中央値 34.130ms。欠落・誤字・重複0 |
| 音声 beep | queuedSec中央値 82.585ms、p99 105.298ms。累積underflow 4,769フレーム。欠音イベント2件（合計108.141ms、最大103.878ms） |
| 音声 idle | queuedSec中央値 86.939ms、p99 144.293ms。累積underflow 3,198フレーム。欠音イベント1件（合計72.517ms、最大72.517ms） |
| 機能失敗 | **0** |

### 1組目との対比

| 項目 | 1組目(8/23) | 2組目(8/25) | 差 |
| --- | --- | --- | --- |
| 起動 中央値 | 23,533.59ms | 24,332.17ms | +3.4% |
| 起動 分布幅 | 23.05〜24.59秒（1.53秒） | 23.82〜25.68秒（1.87秒） | 外れ値なし（両組とも） |
| DIR A: | 91.60ms | 114.46ms | +25.0% |
| DIR B: | 112.90ms | 109.73ms | -2.8% |
| DIR C: | 733.93ms | 771.81ms | +5.2% |
| DIR D: | 80.18ms | 81.01ms | +1.0% |
| キー KeyBuf 1回目 | 12.548ms | 8.858ms | -29.4% |
| キー KeyBuf 2回目 | 4.328ms | 4.505ms | +4.1% |
| キー TVRAM 1回目 | 33.788ms | 31.275ms | -7.4% |
| キー TVRAM 2回目 | 31.808ms | 34.130ms | +7.3% |
| 機能失敗 | 0 | 0 | — |

**DIR A: の +25% だけが目立つが、これは1ドライブあたり5試行しかない指標である。**2組目の A: は p95 264.73ms・最大 301.77ms と裾が長く、中央値の差はこの裾に引きずられた可能性がある。**ドライブ計測の試行数5は、25%規模の差を日差と区別するには足りない。**回帰判定に使うなら試行数を増やすか、この指標では±30%程度を許容幅として扱う必要がある。

起動の +3.4%、DIR B:/C:/D: の ±5%以内は、8/19に見た +26%／3.4倍のような差ではない。**2組の間で被測定物は1バイトも変わっていないため、これらの差はすべて日差と分散である。**ワーカー移行後の回帰判定は、この幅を「変化なし」とみなす基準として使う。

### キー入力1回目の遅さ：3組そろって再現した

| | 8/23 午前 | 8/23 取り直し | 8/25 |
| --- | --- | --- | --- |
| KeyBuf 1回目 中央値 | 12.19ms | 12.55ms | 8.86ms |
| KeyBuf 2回目 中央値 | 4.86ms | 4.33ms | 4.51ms |
| 比 | 2.5倍 | 2.9倍 | 2.0倍 |

**独立した3組すべてで「1回目のほうが遅い」が成立した。**倍率には幅があるが向きは一度も反転していない。予告どおり、これを**構造的なもの（起動直後の暖機）として確定させる**。

したがって**回帰判定では1回目と2回目を別の系列として扱い、合算した中央値では比較しない**。1回目の系列は 8.9〜12.5ms、2回目の系列は 4.3〜4.9ms を移行前の基準幅とする。

なお2回目の系列は3組で 4.86 / 4.33 / 4.51ms と**0.5ms幅に収まっており、指標として非常に安定している**。暖機の影響を受けない2回目のほうが、回帰の検出には向く。

### 音声：3組目にして `outputLatency` が3つ目の値になった

| | 旧set1(8/17) | 1組目(8/23) | 2組目(8/25) |
| --- | --- | --- | --- |
| `AudioContext.outputLatency` | 0.168秒 | 0.016秒 | **0.032秒** |

**同一マシン・同一ビルド・同一スクリプトで3回測って、3回とも違う値が出た。**この値が揃わない限り音声の比較は成立しない、という8/19以来の判断は変わらない。

参考として数字だけ並べる（比較には使わない）。

| | 1組目(8/23) | 2組目(8/25) |
| --- | --- | --- |
| beep 累積underflow | 7,706フレーム | 4,769フレーム |
| beep 欠音 | 5件・合計174.739ms・最大149.637ms | 2件・合計108.141ms・最大103.878ms |
| idle 累積underflow | 11,300フレーム | 3,198フレーム |
| idle 欠音 | 4件・合計256.235ms・最大111.224ms | 1件・合計72.517ms・最大72.517ms |

`outputLatency` が何によって決まるのかを先に切り分けないと、音声はワーカー移行の回帰判定に使えない。**移行後に音声が悪化しても良化しても、この指標では判定できない**ことを明示しておく。

### 起動の区間内訳は、隣り合う2区間が入れ替わる

| 区間（中央値） | 1組目 | 2組目 |
| --- | --- | --- |
| クリック→wasm取得完了 | 625.0ms | 663.3ms |
| wasm取得完了→コア稼働 | 1,489.2ms | **4,116.4ms** |
| コア稼働→ゲスト初出力 | 14,611.1ms | **11,816.9ms** |
| ゲスト初出力→プロンプト安定 | 6,951.7ms | 6,977.5ms |

中間2区間が 1,489→4,116（2.8倍）と 14,611→11,817（-19%）へ大きく動いているが、**その和は 16,100ms → 15,933ms でほぼ変わらない**（-1.0%）。両端の2区間はどちらも±6%以内である。

つまり「コア稼働」のマイルストーン判定位置が組によってずれており、**この2区間を個別に比較すると存在しない変化を読んでしまう**。回帰判定では**この2つを合算した1つの区間として扱う**。個別の値は記録として残すが、単独では根拠にしない。

## 移行前基準の確定

1組目（8/23取り直し）と2組目（8/25）の2組をもって、移行前基準とする。ワーカー移行後の回帰判定は次の基準で行う。

| 指標 | 基準幅 | 判定 |
| --- | --- | --- |
| 起動 中央値 | 23.5〜24.3秒 | この幅の外へ出たら要調査 |
| 起動 区間 | クリック→wasm取得完了、および「wasm取得完了→ゲスト初出力」の**合算** | 個別の中間2区間では判定しない |
| DIR B:/C:/D: 中央値 | 各±5%程度 | — |
| DIR A: 中央値 | ±30%程度（試行5では分離できない） | 厳密に見るなら試行数を増やす |
| キー KeyBuf 1回目 | 8.9〜12.5ms | 2回目と合算しない |
| キー KeyBuf 2回目 | 4.3〜4.9ms | **最も安定。回帰検出の主指標にする** |
| 機能失敗（起動・ドライブ認識・キー欠落/誤字/重複） | **0件** | 1件でも出たら不合格 |
| 音声 `queuedSec` 中央値 | beep 82.5〜85.8ms / idle 86.9〜90.0ms | **出力デバイスを内蔵スピーカーに固定**したうえで比較する |
| 音声 underflow・欠音 | **判定に使わない** | 条件を揃えても4.6倍ばらつく。記録としてのみ残す |

## `outputLatency` の切り分け：正体は音声出力デバイスだった（実測、2026-08-25）

`AudioContext.outputLatency` が同一マシン・同一ビルドで 0.168 / 0.016 / 0.032 秒の3値を取り、
8/19以来「この値が揃わない限り音声の比較は成立しない」として音声を判定から外していた。切り分けた結果、
**値を決めているのは既定の音声出力デバイスだけ**だった。

再現手順は `scripts/probe-audio-latency.mjs`。1回の Chrome 起動の中で、読み取る時刻・`latencyHint`・
`sampleRate` 強制の有無の3軸を振り、macOS 側の既定出力デバイスを実行の前後で記録する。

### 結論

| 出力デバイス | 経路 | `outputLatency` | 試行 |
| --- | --- | --- | --- |
| Beyond TV | HDMI | **0.016秒** | 14/14 |
| MacBook Airのスピーカー | 内蔵 | **0.032秒** | 4/4 |
| AirPods Pro | Bluetooth | **0.168秒** | 4/4 |

観測されていた3値がすべて説明できた。**`baseLatency` はどのデバイスでも 0.005351 秒で変わらない。**
動くのは `outputLatency` だけである。

### 潰した仮説

順に潰した。**先に手持ちのデータで潰せるものから潰した**ため、ユーザーに物理的な操作を頼んだのは最後の2回だけで済んだ。

| 仮説 | 潰し方 | 結果 |
| --- | --- | --- |
| Chromeのバージョン差 | 既存の記録を集計 | **否定。**同一バージョン `151.0.7922.138` が 0.016 と 0.168 の両方を出していた |
| 起動ごとのランダム | 同一条件で10回 | **否定。**アプリと同じ生成方法で 10/10 が 0.016 |
| アプリの経路（AudioWorklet等）が原因 | 同じ瞬間にプローブと実アプリの両方で読む | **否定。**両方とも 0.016 |
| 他アプリが音声デバイスを開いている | `afplay` を走らせた状態で3回 | **否定。**3/3 で 0.016 |
| 電源（AC / バッテリー） | **介入**：アダプタを抜いて4回 | **否定。**バッテリー駆動でも 4/4 で 0.016 |
| 出力デバイス | **介入**：デバイスを切り替えて各4回 | **これが原因**（上表） |

**電源仮説は既存データ上は完全一致していた。**0.032 の記録5件はすべて `Battery Power`、かつ `Battery Power` の
記録はその5件しかなかった。介入していなければ「電源が原因」と結論していた。**観測窓が1つしかない完全一致は、
一致していることの証拠にならない。**

### 読み取り時刻の罠：音が流れるまで `outputLatency` は 0

| 読み取る時点 | `outputLatency` |
| --- | --- |
| `new AudioContext()` 直後 | **0** |
| `resume()` 直後 | **0** |
| 実際に発音してから0.5秒後以降 | 0.016（デバイスなりの値） |

`state` は生成直後から `running` であり、**`state` を見ても「まだ値が入っていない」ことは分からない**。
現行ハーネスは最初の試行が終わったあと（＝ゲストが起動して音が流れたあと）に読んでいるため実害は無かったが、
読み取り位置を前に動かすと**全ファイルが静かに 0 になる**。`collectAudio` を動かすときはここを踏む。

### `latencyHint` でも動くが、既定と `interactive` は安定している

内蔵スピーカーでの値。参考。

| `latencyHint` | `baseLatency` | `outputLatency` |
| --- | --- | --- |
| 既定 | 0.005351 | 0.032 |
| `interactive` | 0.005351 | 0.032 |
| `balanced` | 0.010000 | 0.040 |
| `playback` | 0.023220 | 0.056 |

HDMIデバイスでの10回では、既定と `interactive` は 10/10 が同じ値だった一方、**`balanced` は 0.024×8／0.032×2、
数値指定 `0.05` は 0.064×5／0.072×5 とばらついた**。アプリは既定（`{ sampleRate: 44100 }` のみ指定）を使っており、
この揺れの影響は受けない。

### ハーネスの修正：既定出力デバイスを記録するようにした

原因はデバイスだったが、**そのデバイスを記録していなかったこと**が、この差を4か月ぶんの計測にわたって
「日差」と読ませていた。`environment.host.audioOutputDevice` に名前・経路・サンプルレートを記録する。

- `scripts/measure-env.mjs` に `collectAudioOutputDevice()` を追加（`system_profiler SPAudioDataType -json`）
- 解析部は純関数 `parseAudioOutputDevice()` として切り出し、`test/measure-audio-device.test.ts` に6件のテストを追加
- **陽性対照**：出力デバイスのキーを入力デバイスのキーに取り違える故障を注入すると 6件中4件が落ち、復元すると6件とも通る。「入力デバイスを出力と取り違えない」ケースを明示的に持たせている
- 結線は実走で確認（`collectEnvironment(null)` が実際に `{name: 'MacBook Airのスピーカー', transport: 'coreaudio_device_type_builtin', sampleRate: 48000}` を返す）。テストは解析規則しか見ていないため、実走とテストの両方が要る
- `npm test` は 446件全通過（新規6件ぶん増）

### 計測条件の追加：出力デバイスを内蔵スピーカーに固定する

音声を回帰判定に使うため、**計測時の既定出力デバイスを「MacBook Airのスピーカー」に固定する**条件を加える。

- 内蔵スピーカーを選ぶ理由は再現性。HDMIは外部ディスプレイの接続状態に依存し、Bluetoothは接続とバッテリーに依存する。**内蔵スピーカーは常に存在する。**
- 既存の基準は、1組目(8/23)がHDMI（0.016）、**2組目(8/25)が内蔵スピーカー（0.032）**だった。2組目は偶然この条件を満たしている。
- 8/25 の計測で `screenWidth` が 1470×956（内蔵ディスプレイ）だったことが手がかりになった。外部ディスプレイが繋がっていない＝HDMI音声デバイスが存在しない、という筋である。ただし**画面サイズは代理指標にすぎない**（0.168 の8件は外部ディスプレイ 3840×2160 のまま Bluetooth 接続だった）。記録すべきはデバイスそのものである。

### デバイスを固定しても underflow は使えない。使えるのは `queuedSec` 中央値

出力デバイスを内蔵スピーカーに固定して3観測を揃えた（2組目の音声＋この日に追加で2本）。
3本とも `verdict: quiet`、`outputLatency` 0.032秒、被測定物は同一である。

| | beep underflow | beep 欠音 | beep `queuedSec`中央値 | idle underflow | idle `queuedSec`中央値 |
| --- | --- | --- | --- | --- | --- |
| 2組目 09:23 | 4,769 | 2件/108.1ms | 82.6ms | 3,198 | 86.9ms |
| builtin-1 10:44 | 22,114 | 5件/501.5ms | 85.8ms | 0 | 89.4ms |
| builtin-2 10:47 | 13,123 | 1件/297.6ms | 82.5ms | 5,886 | 90.0ms |

- **underflow は最大4.6倍ばらついた**（4,769〜22,114）。idle に至っては 0 と 5,886 の両方が出ている。
  欠音イベントも 1〜5件・108〜502ms と揃わない。**条件を揃えても、この指標は回帰の検出に使えない。**
- **`queuedSec` の中央値は 82.5〜85.8ms（beep）／86.9〜90.0ms（idle）と4%以内に収まった。**
  これは自前のキューの深さであり、デバイス側の都合に左右されにくい。

したがって、`outputLatency` を揃えたことで音声が丸ごと使えるようになったわけではない。
**使えるようになったのは `queuedSec` の中央値だけ**である。underflow と欠音イベントは、
原因調査のための記録としては残すが、合否の判定には使わない。

`outputLatency` の切り分けは「音声が比較できない」問題の**一部**を解いたにすぎなかった。
デバイスが揃っていなければ何も比較できないが、揃えても比較できる指標は限られる。

### ハーネスの修正が実際に効いていることの確認

この日に追加で取った2本には `environment.host.audioOutputDevice` が
`{name: 'MacBook Airのスピーカー', transport: 'coreaudio_device_type_builtin', sampleRate: 48000}` として入っている。
同じ日に取った2組目の音声には**この項目が無い**（修正前のハーネスで取ったため）。
記録の有無そのものが、修正が本番経路に届いていることの証拠になっている。

## ワーカー移行 手順2：観測・診断系 query の非同期化（実装）

「段階移行の順序」手順2として、`LocalCoreProxy`(手順1で導入済み・`src/core-proxy.ts`)を初めて本番経路(`src/main.ts`)へ結線した。駆動ループ・永続化・入力には触れていない。

**Promise化した範囲(`BridgeHost`、`src/bridge.ts`)** — `screenshot`/`screenText`/`screenHash`/`reset`/`listDisks`/`readMemory`/`status` の7メソッドを `Promise<T>` に揃えた(`T | Promise<T>` の緩めた型ではなく、8節の「取りうる対応」どおり全面的に Promise へ揃える案を採った)。`dispatch()` 側は該当する全コマンドで `await` する。`wait_screen_change` のポーリングループも `screenHash()` を毎回 `await` するよう修正した(ここは元々同期呼び出しを2箇所で使っており、片方だけ直すと検出できない回帰になるため両方直した)。

**proxy に載せたもの** — `screenText`(debug API `__webx68kDebug.screenText()` と bridge の `screen_text`)、`readMemory`(bridge の `read_memory`)。どちらも `coreProxy.readTextScreen()` / `coreProxy.readMemory(addr, length)` を1回呼ぶだけの形にした。**1バイトずつ `host.peekByte()` を呼んでいた `bridgeHost.readMemory` の実装は削除し**、`proxy.readMemory()` が返す1本の `ArrayBuffer` を `Array.from(new Uint8Array(buf))` で `number[]` に変換するだけにした(範囲一括RPCという文書の決定どおり)。

**main に残したもの** — `screenshot`/`screenHash` は `canvas` 由来の同期処理(画像エンコード・間引きハッシュ)であり、コアの状態を読まないため proxy に載せる対象ではないと判断し、シグネチャだけ `async` 化した。`reset` は既存の `host.reset()` の意味を変えず `Promise<void>` でラップしただけ。`listDisks`/`status` は `slots`(UIの状態)を読むだけで proxy 対象外、`Promise.resolve()` で包んだだけ。

**LocalCoreProxy の結線方法(判断: 実装者)** — `host = new LibretroHost(...)` の生成と `host.init()` の呼び出しは既存の `bootCore()` にそのまま残した(手順2の範囲外)。そのため `LocalCoreProxy` を素朴に `new LocalCoreProxy(host)` すると、`host.init()` 完了後でも proxy 自身は `init()` を呼んでいないので `assertInitialized` が常に `INVALID_STATE` を投げてしまう。これを解決するため `LocalCoreProxy` のコンストラクタに `opts?: { initialized?: boolean }` を追加し、`await host.init(...)` が成功した直後に `coreProxy = new LocalCoreProxy(host, { initialized: true })` で構築するようにした。`restartCore()` で `host = null` にする際は `coreProxy = null` も合わせてリセットする。この `opts.initialized` は「host 側の初期化を proxy を経由せず別経路で済ませた」ことを正しく反映できる場合だけ立てる前提の抜け道であり、`core-proxy.ts` にもその条件をコメントで明記した。

**故障注入で確認した検出力** — 2件、いずれも実際にソースを一時的に壊し、追加したテストが失敗することを確認してから元に戻した(差分は `git diff` で確認済み、コミットには含めていない)。
1. `src/bridge.ts` の `wait_screen_change` から `await h.screenHash()` の `await` を2箇所とも外す → `test/bridge-dispatch.test.ts` の該当テストが `{ changed: true, settled: false }` を受け取って fail(Promiseオブジェクトどうしの比較になり `now !== last` が常に真になるため)。復元後は pass。
2. `src/core-proxy.ts` の `readMemory` を「`length` を無視して先頭1バイトだけ返す」実装に書き換える → `test/core-proxy.test.ts` の新規テストと既存テストの計2件が fail。復元後は pass。

**MCP ブリッジの実動確認** — 実際に確認した。`npm run dev` で Vite 開発サーバーを起動し、Browser ペインで `http://localhost:5299/?bridge=1` を開いて「システムディスクで起動」を実クリックした。`mcp/server.mjs` のWSプロトコルを直接模した使い捨てNodeスクリプト(検証専用、リポジトリには残していない)で `ws://127.0.0.1:3099` に接続し、`status`/`screen_text`/`read_memory`/`list_disks` を送った。起動完了後の応答は次のとおりで、いずれも正しく解決済みの値(Promiseの取りこぼしではない)が返っている。
- `status`: `running:true`, `fps:55.49...`, `slots` に `fdd0:"human302.xdf"`
- `screen_text`: `available:true`、実際のTVRAM内容(Human68k起動バナー、既知のUnicode変換不備込み)を反映
- `read_memory`(addr 0xed0000, length 8): `ok:true`、要求どおり8バイトの配列
- `list_disks`: `ok:true`、スロット一覧

**できなかったこと・未確認のこと**
- `read_memory` で TVRAM 領域(試しに `0xe00000`)を読んだところ全バイト0だった。**2026-08-28 確認済み: これは回帰ではなく、そのアドレスがこの窓から見えないだけ。** `src/text-screen.ts` は専用export `_webx68k_tvram_data()` でヒープ内ポインタを直接取得しており、TVRAM読み出しはそもそも `readMemory`/`peekByte` の経路を通らない。一方 `readMemory` の実体である `peekByte()`(`src/libretro-host.ts:375`、`_webx68k_peek8()`)はゲストのメモリバス経由で、`0xE00000` はこの経路に載っていない。手順2の前後でproxyは `peekByte` をlength回まわすだけなので、返るバイト値は変更前と同一(`screenText`が同時刻に正しい内容を返しているのはこのため)。「アドレス指定が悪い」のではなく「そのアドレスはこの窓からは見えない」が結論。
- MCP stdio 層(`mcp/server.mjs` の `McpServer`/`StdioServerTransport` 部分)は今回変更しておらず、実動確認もWSブリッジ層(`src/bridge.ts`)止まりで、実際の MCP クライアント(Claude Code等)経由では確認していない。
- `__webx68kDebug.screenText()` を呼ぶ計測スクリプト群(`scripts/measure-*.mjs`)は非同期化に合わせて `await` を足したが、実ブラウザでの通し実行(起動計測・3ドライブ認識・キー入力計測等)では再検証していない。型・構文レベルの整合のみ確認済み。

## ワーカー移行 手順3：ステートとFS転送の非同期化（実装）

「段階移行の順序」手順3として、`serialize`/`unserialize`(セーブステート)と互換用MEMFS書き込みを `LocalCoreProxy` 経由へ結線し、所有権移転が同一スレッドでも実際に守られることを構造で保証した。

**proxy に載せたもの**

- `handleSaveState()`/`handleLoadState()`(`src/main.ts`) — 従来の `host.serialize()`/`host.unserialize()` 直呼びを `coreProxy.serialize()`/`coreProxy.unserialize()` に置き換えた。`LocalCoreProxy` 自体は手順1で `serialize`/`unserialize`/`writeFile`/`readFile`/`removeFile` を実装済みだったため、今回追加したのは呼び出し側の結線と所有権移転の実装。
- `bootCore()` 内の互換用FS書き込み2箇所(`/system/keropi/config` の HDD0 設定、`/game/boot.cmd`) — `host.writeFile()` 直呼びから `coreProxy.writeFile()` に置き換えた。`host.writeDiskImage()`(FDD/HDD本体イメージの書き込み)はhotSwapFdd専用の実装詳細として今回もproxy対象外のまま残した(`core-proxy.ts` 末尾のコメント参照)。

**proxy に載せなかったもの(と理由)**

- `readLiveSlotImage()`/`hotSwapFdd()`(`src/main.ts`)内の `host.readFile()`/`host.removeFile()`/`host.setFddImage()` — FDDホットマウントとdirty capture(`flushAllSlots()`)の一部であり、手順8の対象。今回は触っていない。
- `fmReadFile()`/`fmWriteFile()`(ファイルマネージャ) — MEMFS上の生ファイルではなくFAT12/16ボリューム内のファイル操作(`fatReadFile`/`fatWriteFile`)であり、対象が異なる。今回のMEMFS互換read/writeとは無関係と判断した。
- HDD/大容量データのOPFS経路 — 決定2の実装は別途であり、今回は既存の全量bytes経路をproxyへ載せ替えただけ。

**手順3の肝: 同一スレッドでも所有権移転を実際に守らせる(detach)**

`src/core-proxy.ts` に `takeOwnership(buf: ArrayBuffer): ArrayBuffer` を追加した。中身は `structuredClone(buf, { transfer: [buf] })` で、`LocalCoreProxy#unserialize()` の `bytes` 引数と `#writeFile()` の `data` 引数の先頭で適用する。呼び出し側が渡した元の `ArrayBuffer` はこの時点で実際に detach され、以後 `byteLength` は0になる。

対処した問題: 手順3以前の `LocalCoreProxy` は `ArrayBuffer` を受け取っても参照を保持するだけで、実際には転送しない。そのため「呼び出し側が渡したあとも同じバッファを使い回す」という所有権契約違反が同一スレッドの間は無症状で通ってしまい、実Worker化(手順7以降)でpostMessageのtransfer listに載せた瞬間に初めて症状が出る。detachを先取りして入れることで、契約違反をWorker化前のこの段階で検出可能にした。

**2026-08-28 追記: レビューで判明した見落とし — 本番経路ではdetachが一度も発火していなかった**

上の「コスト実測」節(当初版)は `structuredClone(buf, { transfer: [buf] })` 単体の所要時間だけを測っていた。だが本番の呼び出し側(`main.ts`)は、渡す前に必ず `src/core-proxy.ts` の `toArrayBuffer(bytes: Uint8Array)` を経由しており、その実装は当時 **常に `bytes.buffer.slice(...)` でコピーを作っていた**。つまり:

- `takeOwnership()` が実際に detach するのは、`toArrayBuffer()` がその場で作った**使い捨てのコピー**であり、
- `main.ts` 側が保持し続けるバッファ(`stored.bytes` や `bootCore()` のFS書き込み元)は無傷のまま残る。

`test/core-proxy.test.ts` の「手順3の肝」節は `proxy.unserialize(buf)` のように**生の ArrayBuffer を直接渡す**形でdetachを確認していたため、この抜け(`toArrayBuffer()` を経由する本番の結線)を検出できていなかった。「ヘルパ単体テストは結線を見ていない」(`feedback_helper_unit_test_misses_the_wiring.md`)と同じ形の見落とし。

**修正**: `toArrayBuffer()` を `toOwnedArrayBuffer()` に分割・改名し、渡された `Uint8Array` が**バッファ全体を覆っている**とき(`byteOffset===0` かつ `byteLength===buffer.byteLength`。今回の全呼び出し元がこれに該当することを確認済み)は**コピーせず** `bytes.buffer` をそのまま返すようにした。部分ビュー(subarray)のときだけ従来どおり `slice()` でコピーする。常にコピーしたい場合向けに `copyArrayBuffer()`(旧実装と同じ、常にslice)も残し、「所有権を渡す」か「コピーを渡す」かを名前で区別できるようにした。`main.ts` の3箇所(`unserialize`/`writeFile`×2)を全て `toOwnedArrayBuffer()` に置き換え済み。

再入経路(`restartCore()` → `bootCore()` の2回目起動)も確認した。`bootCore()` 内の `iniText`/`cmdText` はどちらも呼び出しごとにローカルで `new TextEncoder().encode(...)` する使い捨てバッファであり、モジュールレベルのキャッシュや使い回しは無い。`handleLoadState()` の `stored.bytes` も `getState()` が毎回IndexedDBから新規デシリアライズしたバッファを返す(`state-store.ts` の `gunzip()`/レコード読み出し)ため、detachされても次回呼び出しに影響しない。2回目起動だけ壊れる経路は見つからなかった。

**故障注入(新規)**: `test/core-proxy.test.ts` に「main.tsの呼び出し形(toOwnedArrayBuffer経由)でもdetachが効く」節を追加。`toOwnedArrayBuffer()` を旧実装(常にslice、`copyArrayBuffer()`相当)に一時的に戻すと、新規テスト2件(unserialize・writeFileそれぞれ)が **2/2とも失敗**することを確認してから復元した(`storedBytes.byteLength` が期待の0でなく元の値のまま残ることを検出)。合わせて `copyArrayBuffer()` を使った恒久的な陽性対照テストも1件追加し、常にコピーする実装ではdetachされない(byteLengthが残る)ことを直接確認できるようにした。

**コスト実測のやり直し(2026-08-28、Node v22、このマシン)** — 「コピー(slice)」対「コピー無し(バッファそのまま返す)」を、15MB(セーブステート1本相当。px68kはRAM領域を12MB固定でシリアライズするため圧縮前のサイズ)のバッファで20試行ずつ計測(`process.hrtime.bigint()`で1回ごとの所要を記録し、min/median/mean/maxを取った。GCの影響を減らすため試行ごとに新規バッファを確保):

| 実装 | 所要時間(20試行、ms) |
|---|---|
| `slice()`(コピーあり。旧実装 = 現在の `copyArrayBuffer()`) | min 1.11 / median 1.95 / mean 3.62 / max 9.17 |
| バッファそのまま返す(コピー無し。現在の `toOwnedArrayBuffer()` の高速経路) | min 0.0003 / median 0.004 / mean 0.026 / max 0.28 |

当初報告の「15MBで0.01〜1.3ms」は `structuredClone` の transfer(=所有権の付け替え。元々O(1))だけを測ったものであり、支配的コストだった手前の `slice()` によるコピー(15MBの実コピー、中央値で約2ms)を含んでいなかった。今回コピーを回避したことで、detach込みの所要は約2ms→0.004ms(中央値)に縮んだ。

`state-store.ts` のコメントによれば同じ15MBステートのgzip圧縮に約60ms、IndexedDBのラウンドトリップはさらに掛かる。コピー無しにしたことでdetach経路のコストはそれらに対してさらに無視できる大きさになったため、**`import.meta.env.DEV` 限定にはせず本番へ常時適用したまま据え置く**。

**エラー処理**

- `unserialize()` は `host.unserialize()` の戻り値(`false`)・例外のどちらも握り潰さず、そのまま呼び出し側(`handleLoadState()`)へ伝える。`handleLoadState()` 側は失敗時に同じ `stateLoadFailed` トーストを出す(UIの見え方は変更前と同じ)が、内部では `console.error` でエラー内容(コード込み)をログに残すようにした。
- unserialize失敗時に以前のステートが壊れたまま走り続けないことは、`host.unserialize()`(実体は `retro_unserialize`)側の責務であり、今回の変更範囲では実機のコアの動作を変えていないため未確認のまま(既存動作を維持しただけ)。
- 「unserialize中は駆動を止め、成功応答後に音声flushと基準状態を更新する」は、`LocalCoreProxy` が同一スレッドadapterで `unserialize()` 内部が同期実行のまま(マイクロタスクの範囲でしか `await` しない)であるため、`await coreProxy.unserialize(...)` とその戻り値を見てから `audio?.flush()` 等を行う現状の実装で自然に満たされる。駆動ループ(`scheduleNext`/rAF)はマクロタスク境界を越えないと動かないため、明示的な一時停止コードは追加していない。この前提は実Worker化(手順7)で崩れるため、その段階で改めて明示的な停止が必要になる。

**故障注入で確認した検出力** — 2件、いずれも実際にソースを一時的に壊し、追加したテストが失敗することを確認してから元に戻した(差分は確認済み、コミットには含めていない)。

1. `takeOwnership()` を `structuredClone(..., { transfer: [buf] })` から `buf.slice(0)`(コピーのみ、detachしない)に書き換える → `test/core-proxy.test.ts` の「手順3の肝 — 所有権のdetach」2件(unserialize/writeFileそれぞれ)が `byteLength` が0にならず fail。他の25件は無傷で pass。復元後は27件全て pass。
2. `unserialize()` の最終戻り値を「例外・falseの両方を握り潰して常に `true` を返す」実装に書き換える → 「unserialize失敗時にエラーコードを握り潰さない」2件(false透過・例外透過それぞれ)が fail。復元後は pass。

**新規テスト** — `test/core-proxy.test.ts` に7件追加(506件 = 既存499件+7件): serialize/unserializeの往復1件、writeFile/readFile/removeFileの往復1件、detach確認3件(unserialize・writeFileそれぞれのdetach、および「detachはコピー後に起きるためhostが受け取る内容は書き換わらない」)、unserialize失敗時の非握り潰し2件(false透過・例外透過)。

**2026-08-28 追記** — 上記の見落とし修正に伴い、さらに3件追加(509件 = 506件+3件): 「main.tsの呼び出し形(toOwnedArrayBuffer経由)でもdetachが効く」節の unserialize/writeFile それぞれ1件、および `copyArrayBuffer()`(常にコピーする実装)ではdetachされないことを確認する恒久的な陽性対照1件。

**できなかったこと・未確認のこと**

- 実ブラウザでのセーブ/ロード(UI操作を実クリック)での通し確認はしていない(制約により `scripts/measure-*.mjs` を含め計測スクリプトは実行していない)。`npm test`/`npx tsc --noEmit` レベルの確認に留まる。
- `unserialize` 失敗時に「以前のステートが壊れたまま走り続けない」ことは、コア内部(`retro_unserialize`)の実装に依存し、今回の変更でコア自体には触れていないため実機的な確認はしていない。
- `core-protocol.ts` の `CoreCommand`/`AtomicCommand` 型には `writeFile`/`readFile`/`removeFile`/`serialize`/`unserialize` に対応する op がまだ無い(手順1時点で `serialize`/`readTextScreen`/`screenshot` は用意されていたが、FS系は未定義のまま)。実Workerの実メッセージプロトコルを固める手順4以降で追加が必要になる。今回は `LocalCoreProxy` が host を直接呼ぶ同一スレッド実装であり、postMessageを経由しないためこの型定義が無くても動作に支障はない。

### 計測ハーネスの通し確認（2026-08-28）

手順2で `__webx68kDebug.screenText()` を非同期化したため、`scripts/measure-*.mjs` を実ブラウザで通した。
**ハーネスの修正は不要だった。**
- `measure-drives`：正常系は起動成功・機能失敗0件。故障注入 `no-fdd1` で狙ったドライブBのみ失敗し `passed: true`
- `measure-key`：正常系は keybuf 2/2・**tvram 2/2**。故障注入 `drop-make` で tvram 0/2（`missingEcho: 2`）を検出
- `measure-boot`：正常系 1/1 成功（26,590ms）。故障注入 `wrong-marker` は陽性対照26,326ms成功のうえで検出

`screenText()` を判定に使う経路（drivesとkeyのTVRAM経路、bootの起動判定）すべてで「正常系で通り、故障注入で落ちる」の両方向を満たした。`await` 漏れで「常にマッチする」方向に壊れている可能性は潰した。

**これらの数値は基準値ではない**（試行1〜2回、静穏確認なし、出力デバイス未固定）。起動26,590msは基準幅23.5〜24.3秒の外だが、区間内訳は既知の「隣り合う2区間が入れ替わる」現象を示しており、合算17,718ms（基準の合算15,933〜16,100ms）で見ると整合する。

**運用上の失敗3件**（次回の同種作業で踏まないよう記録する）:
1. 計測を委譲した先が「完了」通知を返したあとも `measure-boot` を並走させており、その競合下で取った起動時間が45.6秒（基準の約1.9倍）になった。**委譲先の完了通知はプロセスの終了を意味しない。** 停止確認まで自分で持つこと
2. 委譲先を停止したとき vite 開発サーバーだけが落ち、計測スクリプトとChromeが孤児として残った。配信元を失ったページが `Aborted(both async and sync fetching of the wasm failed)` を出す。**アプリの不具合と紛らわしい**
3. 待機ループに書いた `pgrep -f "scripts/measure-"` が**自分自身のコマンドラインにマッチ**して終わらなかった。観測系そのもののバグ

### 実ブラウザでのUI確認：ステートの保存と復元（2026-08-28）

手順2・3はテストと計測ハーネスでは通っていたが、UI操作を通した確認が未実施だった。
dev サーバー（`npm run dev`、127.0.0.1:5299）に `?system=1&run=1` で接続し、実ブラウザで確認した。

**確認できたこと**

- 起動：Human68k がプロンプト（`A>`）まで到達。`fps 55.5`、`queuedSec 0.081`。`__webx68kDebug.screenText()` は非同期化後も正常に内容を返す
- **ステート保存**：`btn-save-state` を起動し、IndexedDB `webx68k-states` に**1件・276,142バイト**が保存された（`savedAt` あり）。`console.error` 0件
- **ステート復元の往復**（陰性対照つき）:

| 段階 | 画面（`screenText` の末尾） |
| --- | --- |
| 保存時 | `Command version 3.00` / `A>ECHO OFF` / `A>` |
| リセット後（**陰性対照**） | 空（`Command version` を含む行なし） |
| 復元後 | 保存時と同一の4行が復帰 |

リセットで画面が明確に変化したことを挟んでいるため、「たまたま同じ画面だった」という可能性は排除できている。復元後も `fps 55.5`、`console.error` 0件。

- **detach の再入経路**：リセットは `restartCore()` → `bootCore()` の2回目起動を通る。手順3で `writeFile` に detach を入れたため「2回目の起動だけ静かに壊れる」懸念があったが、2回目の起動も正常に完了し、その後のステート復元も成功した。**実アプリでの再入経路の確認が取れた。**

**確認できなかったこと（限界）**

- **ツールバーの「その他」メニューを自動操作で開けなかった。** `btn-save-state`/`btn-load-state` は `toolbar-overflow-sources`（`display:none` の待機置き場）に置かれ、メニューを開くと移動する作りだが、自動操作のクリックではメニューが開かず、ボタンが待機置き場から出なかった。そのため**ボタン要素を直接起動する形で確認した**（`handleSaveState`/`handleLoadState` という本番のハンドラは通っている）。**人手での確認が要る**としていたが、2026-08-28にユーザーが手元の実ブラウザで確認した：**ツールバーの「その他」→「ステート」メニューは、人手の操作では正常に開いた。** 手順は「ステート保存 → 復元 → 実キーで Enter を2回押して改行 → 復元」で、**2回目の復元で、Enterで進んだカーソル位置が元に戻った。** これにより、メニューを開けなかったのは自動操作固有の現象であり、実利用の不具合ではないと判断できる。また、この確認はこちらが行った「リセットを陰性対照に使う方法」より強い検証になっている。ゲスト内部の状態（カーソル位置）が変化し、それが復元で巻き戻ったことを確認できたため、画面の再描画ではなくゲスト状態そのものが復元されていることを示している。
- **合成キー入力がゲストに届かなかった。** ブラウザ自動操作の `type` で7文字入力したが `screenText` に現れなかった。既知の「自動ブラウザのキー入力は `code` が空」（`feedback_browser_automation_key_code_empty.md`）に該当する可能性が高い。そのため状態を変える手段としてリセットを使った。なお `scripts/measure-key.mjs` は puppeteer の keyboard API で `code` を明示するため影響を受けない。**2026-08-28の人手確認で、実キーの Enter はゲストに到達していることが裏づけられた。** 合成キーが届かなかったのは自動操作側の限界であることが確認できた
- 音声の実聴取、ファイルマネージャ経由の操作、FDD ホットマウントは今回確認していない

## ワーカー描画方式の実測（2026-08-28）

手順5・7（描画・音声出力、Worker駆動ループ）に着手する前に、「未決事項」に残っていた3点（A: 映像経路、B: `frame` event、C: Workerのスケジューラ）を、コアの移行はせず独立したプローブで実測した。新規追加は `scripts/probe-worker.html`（単体で開けるページ）と `scripts/probe-worker.mjs`（ヘッドフル実Chromeで駆動する既存様式のドライバ）のみで、`src/`・`test/` は変更していない。実行環境は `scripts/measure-env.mjs` の `collectEnvironment()` で記録した：Chrome 151.0.7922.174 / macOS 24.6.0 / Apple M2 8コア / 16GB / AC電源 / 出力デバイス「Beyond TV」(HDMI, 48000Hz)。768×512、目標55.5Hz(約18.018ms)、各測定は3試行。

### A. 映像経路 — 可否3点（最優先）

1. **`transferControlToOffscreen()` 後、main の `canvas.toDataURL()`** → **成立する**(`{ok:true}`)。screenshot相当の経路としてOffscreen後も使える。
2. **`getImageData()`(main側 `canvas.getContext('2d')`)** → **不成立**。`InvalidStateError: Cannot get context from a canvas that has transferred its control to offscreen.` screenHash相当のpixel直接読み取りはmain側では二度とできない(toDataURLで代替するしかない)。
3. **同じcanvas要素への再transfer** → **不成立**(想定どおり)。`Cannot transfer control from a canvas for more than one time.` Worker再生成時は**新しいcanvas要素**が必須で、旧canvasは`getContext`も二度と通らない(`oldCanvasGetContextAfterWorkerTerminate: {ok:false}`、同じエラー)。**新しいcanvas要素なら再transferは問題なく成立する**(`newCanvasTransferAfterRegen: {ok:true}`)。

→ **決定に直結する事実**: OffscreenCanvas方式を採るなら、screenHash相当(生pixel読み取り)は`toDataURL()`経由へ置き換える設計変更が要る。Worker再生成のたびにcanvas要素を作り直す実装(DOMツリーの再配置を含む)が必須になる。

### A. 速度(3試行×2方式、6秒/試行)

| 指標 | OffscreenCanvas直描画 | 転送(ImageBitmap相当のRGBA transferable) |
| --- | --- | --- |
| 提示フレーム数/目標 | 276〜285 / 333 | 270〜277 / 333 |
| Workerループ間隔(mean/p95/max) | 21.1〜21.8 / 23.9〜25.2 / 36〜156ms | 22.0〜22.3 / 23.3〜23.4 / 34〜62ms |
| main側の1フレームあたり処理 | **描画自体はmainで発生しない**(0) | putImageData+検証込みで mean 0.4〜0.7ms / p95 0.4〜4.7ms(GCと思われる散発max 25ms) |
| 転送コスト(bytes/frame) | — | 1,572,864B(768×512×4)固定、`postMessage`呼出自体は mean 0.05〜0.07ms(transferableのためコピー無し) |
| 受信遅延(worker送出→main受信、timeOrigin補正後) | — | mean 0.4〜1.0ms / p95 0.4〜0.5ms / max 5.8〜68.2ms(初回ジッタ) |

両方式ともWorkerループ間隔がmean 21〜22msで目標18.02msより明確に遅い(下記C節参照。原因はcanvas方式固有ではなくWorker内`setTimeout`そのもの)。転送方式のmain側コストはフレーム予算(18.02ms)の3%程度で軽微。

### B. `frame` event の費用(3試行×静穏/多忙、6秒/試行)

| 条件 | 遅延(mean/p95/max) | 取りこぼし(gapCount) |
| --- | --- | --- |
| 静穏(mainが他に何もしない) | 0.59〜0.71 / 0.6〜0.8 / 2.1〜19.4ms | 0(3試行とも) |
| 多忙(mainで40msビジーループを180ms周期で注入) | 5.38〜5.40 / 32.5〜33.3 / 40.7〜47.9ms | 0(3試行とも) |

frameNoの連番(`gapCount`)は多忙時も0で、メッセージ自体は失われない。遅延はp95で約1.8フレーム分(33ms)まで伸びるが、破綻(無制限の滞留)は観測されなかった。**ただしこの負荷は継続40ms/周期180ms(デューティ比22%)のみを試しており、より長い連続ブロックでの破綻点は未測定。**

### C. Worker のスケジューラ(3試行×{setTimeout, setInterval}×{前面, 背面}、5秒/試行)

| 条件 | 実測間隔mean | 累積ドリフト(5秒間) | rAF発火回数(同区間) |
| --- | --- | --- | --- |
| setTimeout・前面 | 21.46〜21.50ms | +804〜810ms | 300〜302 |
| setInterval・前面 | 18.01ms | -3〜+15ms(ほぼ0) | 301〜303 |
| setTimeout・背面(hidden) | 19.51〜19.85ms | +384〜463ms | **0**(3試行とも) |
| setInterval・背面(hidden) | 18.07ms | +14ms前後 | **0**(3試行とも) |

`document.visibilityState`は別タブを実際に前面へ出す方法で`hidden`にできたことを3試行とも確認した(puppeteerで`page.bringToFront()`によりタブを切り替え、`page.evaluate`でのなりすましではない)。

→ **決定に直結する事実**: **固定delayの`setTimeout`のみでは55.5Hzを正確に刻めない**(1周ごとに約3.4〜3.5msの正の系統誤差があり、5秒で800ms超・累積すると際限なく遅れていく)。**`setInterval`は同条件でドリフトがほぼ0**で、目標に対して安定している。背面(hidden)化した5秒間ではrAFは完全に停止する(0回)が、Worker内タイマー(setTimeout/setInterval とも)は5秒間止まらず動き続けた(間隔がむしろ前面よりやや目標に近づく結果になったが、この短時間では誤差の範囲とみて過度に解釈しない)。

### 測定系の検証(陽性対照・故障注入)

- **内容の正しさを検証する仕組み**: フレーム内容はframeNoの純関数(4隅+中央の5点マーカー、`pixelFor(frameNo, seed)`)で決まる。OffscreenCanvas方式はWorker自身が`getImageData()`で描いた直後に読み戻して照合、転送方式はmain側が受信後の`getImageData()`で照合する(自己参照にならないよう、転送方式は「描いた側」と「照合する側」が別コンテキスト)。
- **陽性対照**: 通常運転(skip無し)の全trialで一致率100%(`checkMismatches: 0` / `selfCheckMismatches: 0`)。
- **故障注入**: 2フレームに1回、意図的に描画をサボらせた(2秒間の専用試行)。結果、OffscreenCanvas方式は13サンプル中7件、転送方式は14サンプル中7件が不一致として検出された。**「未描画」を検出できることを確認してから通常計測に戻した。**
- **rAFのカウンタ**: ページ読込直後から回し続け、前面区間で毎回300前後(目標60Hzに対しdevicePixelRatio等の環境要因で実測60.89Hz相当)発火していることを確認、背面区間では0であることを確認した。rAFが「そもそも自動ブラウザで回っていない」可能性を排除した。
- **測定系のバグを1件発見・修正した**: 開発初期の実装では、Workerとmainの`performance.now()`を単純に引き算して受信遅延を出していたところ、trialを重ねるごとに遅延が25秒→31秒→37秒と成長する明らかにおかしい値が出た。原因は**Workerとmainで`performance.timeOrigin`(時刻の原点)が異なる**こと(mainはdocumentのnavigation start、Workerは自分自身の生成時刻)。`performance.timeOrigin + performance.now()`で絶対時刻に直してから差分を取るよう修正し、遅延はミリ秒オーダーの妥当な値になった(A/B節の数値は修正後のもの)。2つの時計を安易に混ぜて比較してはいけない、という既知の教訓(`feedback_two_logs_need_one_clock.md`)がここでも再現した形になる。

### 3つの未決事項に対する結論

- **A(OffscreenCanvas vs 転送)**: **決まらなかった**(速度だけでは優劣が出なかった。転送方式のmain側コストはフレーム予算の3%程度で軽微、OffscreenCanvasはmain側コストが実質0)。ただし**可否面での重要な制約が判明した**: OffscreenCanvas方式を採る場合、screenHash相当の生pixel読み取りは`toDataURL()`経由に置き換える設計変更が必須で、Worker再生成のたびに新しいcanvas要素へ差し替える実装が必須になる。この制約コストを踏まえた選定は今回の測定範囲外(実装難易度の見積りが必要)。
- **B(frame eventの間引き・背圧)**: **部分的に決まった**。今回試した負荷(main40msビジーループ・180ms周期・デューティ比22%)では取りこぼし無く、遅延も有限(p95約33ms)に収まり、間引き・背圧の仕組みが無くても即座には破綻しない。ただし**どこまで負荷を上げると破綻するかの閾値は決まらなかった**(より長い連続ブロックや高頻度負荷は未測定)。
- **C(setTimeoutのみで55.5Hzを刻めるか)**: **決まった**。固定delayの`setTimeout`だけでは系統的にドリフトし(mean 21.5ms、5秒で800ms超の累積遅れ)、55.5Hzを正確には刻めない。`setInterval`はドリフトがほぼ0で安定する。したがって Worker のスケジューラは**`setInterval`を使うか、`setTimeout`にドリフト補正(前回の超過分をdelayから差し引く等)を追加する必要がある**。後者(補正付きsetTimeout)は今回測定していない。

### 未確認のこと

- **iOS / Android実機は未実施。** `scripts/probe-worker.html`は単体で開けるページとして作ってあるため、後日iOS Safari・Android Chromeでもそのまま開いて`window.__pwFeasibility()`等を呼べる。
- Bの背圧について、より長い連続ブロック・より高頻度の負荷での破綻点。
- Cについて、ドリフト補正付き`setTimeout`の実測。
- 音声キューとの実結合(今回はqueuedSecを模擬値で流しただけで、実際のAudioWorkletとの同期は測っていない)。

## Aの追測：`setInterval`下での速度再測定、バッファ返却の検証（2026-08-28）

上の「A. 速度」節の比較は、**あとで誤りと判明した`setTimeout`固定delayの下**で行われたものだった(C節参照)。提示フレームは276〜285/333(83%)にとどまり、どちらの方式も目標55.5Hzに届いていない状態での比較だったため、Aの決定材料としては使えない。ユーザーと相談し、**転送方式(メイン側canvasを維持する)を本命とする**方針で合意した — OffscreenCanvasだとWorker再生成のたびにcanvas要素の作り直しが必須で、アスペクト補正・`rescale()`・フルスクリーン・仮想パッドのオーバーレイ・スクリーンショットが全て現在のcanvasを参照しているため。この合意を踏まえ、`scripts/probe-worker.html`/`scripts/probe-worker.mjs`を拡張し(作り直さず)、**全条件のスケジューラを`setInterval`に統一**した上で3条件を測り直した。

- **条件1: 転送・バッファ返却なし**(現行のまま。毎フレーム新規`ArrayBuffer`確保)
- **条件2: 転送・バッファ返却あり**(本命。メインが描き終えたバッファを`transfer`でWorkerへ返し、循環させる。`TRANSFER_POOL_WORKER_SRC`を新設)
- **条件3: OffscreenCanvas**(参照点。`setInterval`下での比較のため)

各3試行・6秒/試行(目標333フレーム)。環境はA節と同じ(Chrome 151.0.7922.174 / macOS / M2)。

### 結果：55.5Hzは`setInterval`下でも安定して出なかった

| 条件 | 提示フレーム数/333(3試行) | 達成率 |
| --- | --- | --- |
| 転送・返却なし | 328, 330, 319 | 98.5%, 99.1%, 95.8% |
| 転送・返却あり | 315, 324, 333 | 94.6%, 97.3%, **100%** |
| OffscreenCanvas | 318, 326, 331 | 95.5%, 97.9%, 99.4% |

**合格条件(99%以上)を3条件とも3試行そろって満たすことはできなかった。** setTimeout単独よりは大幅に改善した(83%→95〜100%)が、setIntervalに切り替えても、どの方式でも取りこぼしが残る試行があった。Workerループ間隔はmean 18.06〜19.10ms(目標18.018msに近い)だが、**散発的なmax(37.7〜191.4ms)が数フレーム分の欠落を生んでいる**とみられる。**A(映像経路の選定)は速度の観点では今回も決まらなかった**。

### main側1フレームあたり処理(mean/p95/max、3試行)

| 条件 | 試行1 | 試行2 | 試行3 |
| --- | --- | --- | --- |
| 転送・返却なし | 1.75 / 12.8 / **61.4**ms | 1.75 / 1.1 / **61.1**ms | 1.07 / 0.8 / **53.1**ms |
| 転送・返却あり | 1.52 / 0.7 / **194.2**ms | 0.46 / 0.7 / **1.0**ms | 0.57 / 0.7 / **17.7**ms |
| OffscreenCanvas | 0 / 0 / 0(main側処理なし) | 同左 | 同左 |

**バッファ返却によってGC由来と見られるmaxスパイクが消えるという想定は、今回は裏付けられなかった。** 返却ありの試行1はmax 194.2msとむしろ3条件中最大の値を記録している(試行2・3はmax 1.0ms・17.7msと小さく、試行間のばらつきが大きい)。返却なしはmax 53〜61ms台で3試行とも比較的揃っている。**この1回の計測だけでは「返却が効いているかどうか」を速度指標からは判定できない。**

### `poolMisses`(バッファ返却の陽性対照)

- 通常運転(返却あり、3試行): **2, 2, 5**(起動直後の数件のみ。想定どおり)
- 故障注入(b)：返却を意図的に止めた2秒試行 → **`poolMisses: 88` / `framesReceived: 88`**(**完全一致**。返却が黙って失敗した状態を確実に検出できることを確認した)
- 対照(同条件で返却あり) → `poolMisses: 2`(起動時のみ)

→ **返却の仕組み自体は正しく機能している**(通常運転でプールが枯渇するのは起動直後だけ)。故障注入で「返却できているつもり」を検出できることも確認済み。

### 故障注入(a)：描画スキップの検出(3条件、setInterval下で再確認)

2フレームに1回描画をサボらせる2秒試行。3条件とも不一致を検出した(転送8/16、返却あり7/13、OffscreenCanvas7/14)。通常運転(上表)はいずれも`checkMismatches: 0`。**内容照合(`pixelFor`の5点マーカー)が、setIntervalへの切り替え後・バッファ使い回し方式でも機能していることを確認した。** バッファ返却方式は全セル書き換え(`fillFrameRGBA`が先頭4バイト+`copyWithin`で埋め尽くす)なので、前フレームの内容が部分的に残ることはない設計になっている。

### rAF発火回数

この区間(3条件×3試行、約54秒)でrAFは**3271回**発火しており、自動ブラウザが正常に動き続けていたことを確認した(0回で無言停止していないことの確認)。

### 未決事項の更新

- **A(OffscreenCanvas vs 転送・返却の有無)**: **引き続き決まらなかった**。速度面では3条件とも同程度(達成率95〜100%の範囲に収まり、明確な優劣が出ない)。バッファ返却の仕組み自体は`poolMisses`で正しく機能していることを確認したが、期待していた「GCスパイクの減少」は今回の1回の計測では裏付けられなかった(返却ありの方がむしろ最大値の大きい試行があった)。**可否面の制約(OffscreenCanvasはWorker再生成のたびにcanvas要素の作り直しが必須)は前回のA節の結論のまま変わらない。** 方針としては転送方式(返却あり)を本命とする合意を維持するが、これは可否面の理由によるものであり、今回の速度測定が転送方式を積極的に支持したわけではない。
- **55.5Hzの安定達成**: **新たな未決事項として追加する。** `setInterval`に切り替えても3条件・3試行のいずれも99%を安定して満たせなかった。原因(GC・ブラウザのタイマー精度・他の要因)の切り分けは今回行っていない。

### 今回できなかったこと

- 速度測定・main側コストのばらつきが試行間で大きく(特にmax値)、**なぜ返却ありの試行1だけmax 194.2msになったのか**は未調査(3試行では原因を切り分けるのに足りない)。
- 55.5Hz未達の原因切り分け(GC・スケジューラ精度・ブラウザの背景プロセス等)は未実施。
- iOS/Android実機、より高負荷条件は引き続き未実施。

## ワーカー移行 手順4：初期化・load/AVのスケルトン実装（2026-08-28）

未決事項3点(映像経路・`frame` event・スケジューラ)の決定(上記「未決事項」参照)を踏まえ、手順4(初期化、オプション、load/AV)の**骨格だけ**を実装した。今回のスコープは意図的に小さく切ってあり、`initialize`→`ready`/`loadGame`/`fetchAvInfo`/`dispose` の command/response 往復のみを実装する。手順5(映像・音声出力)・手順6(入力)・手順7(駆動ループ)はまだ手を付けていない。

### 追加・変更したファイル

- `src/core-worker.ts`(新規): Worker のエントリポイント。`importScripts('/core/px68k_libretro.js')` で wasm glue を読み込み、実コアの駆動には既存の `LibretroHost`/`LocalCoreProxy` をそのまま再利用する。`LibretroHost` は内部で `canvas.getContext('2d')`/`width`/`height`/`createImageData`/`putImageData` しか使わない(`src/libretro-host.ts` 確認済み)ため、Worker内では `OffscreenCanvas` を「誰も読み出さない scratch 描画先」として渡している(`as unknown as HTMLCanvasElement` のキャスト付き)。決定Aにより実際に画面へ出す映像経路は手順5でメインスレッドの canvas への転送に置き換える設計であり、この scratch canvas の内容はどこにも転送されない。
- `src/core-proxy.ts`: `WorkerCoreProxy` を追加。`LocalCoreProxy` と同じ `LibretroHostProxy` を実装し、呼び出し側を差し替え可能にした。`generation`(このインスタンスは0固定。再生成は手順9でスコープ外)、`requestId` による pending 管理、`messageerror`/Worker の `error`/応答timeout を `WORKER_FAILURE` として扱いその世代の未完了 Promise を全て reject する処理を実装。`fatal` event も同様に扱う。今回実装した4 op(`initialize`/`loadGame`/`fetchAvInfo`/`dispose`)以外(`setCoreOption`/`reset`/`serialize`/`unserialize`/`readTextScreen`/`readMemory`/`hotSwapFdd`/`writeFile`/`readFile`/`removeFile`)は `UNSUPPORTED` の `CoreProxyError` を返す(手順5以降で実装)。
- `src/core-protocol.ts`: `CoreCommand` に `fetchAvInfo`/`dispose` op を追加(それぞれ独立した union member。同じ member に複数opを束ねると `Extract<CoreCommand, {op:'fetchAvInfo'}>` 等が `never` になり、core-worker.ts 側の型安全な handler 関数が書けなくなるため分離した)。`collectTransferables` の command 側 switch も追随。
- `src/url-params.ts`: `parseWorkerModeParam()` を追加。`?worker=1`/`true`/`yes`/`on` → `true`、`0`/`false`/`no`/`off` → `false`、それ以外は `null`(呼び出し側は既定 `false` を使う)。
- `src/main.ts`: `?worker=1` のときだけ、既定の `host`/`coreProxy`(実際に画面・音を出す既存経路)とは完全に切り離した試験用の `WorkerCoreProxy` を追加でもう1本立てる(`bootWorkerCoreProxySkeleton()`)。`initialize`→`loadGame`(実FDD/HDDのcmdファイルは書けない=`writeFile`未実装のため存在しないパスを渡すだけ)→`fetchAvInfo` を通し、結果を `console.log`/`console.warn` するだけ。例外は全て握り潰し、既定経路(`urlWorkerMode` が false のとき)には一切コードパスが触れない。

### `loadGameNone`/`unloadGame` の削除

前回合意の決定通り、`LibretroHostProxy` インタフェースから `loadGameNone()`/`unloadGame()` を削除した。`src/main.ts` から呼ばれておらず(grep で未使用を確認済み)、外部利用も確認できないため。`CoreHostSurface`(実体 `LibretroHost` との構造チェック用の型)と `LibretroHost` 自体には残しており、削除したのは proxy 境界だけである。

### テストと故障注入

`test/worker-core-proxy.test.ts`(新規)を追加。実 Worker の代わりに `WorkerLike` を満たす `FakeWorker`(command を記録し、任意の response/event を手動または自動で返せる)を使い、以下を確認した:

- command/response の往復(`initialize`→`ready` event/`loadGame`/`fetchAvInfo`/`dispose`)。
- 未実装opは `UNSUPPORTED` で reject し、Workerへ postMessage 自体しない。
- **世代が異なる response/event は無視される**(別世代からの遅延応答を模して確認)。
- **Worker の異常終了(`error` event)・`messageerror` で、その世代の未完了 Promise が全て reject される**。
- **応答timeoutが `WORKER_FAILURE` になる**。
- `dispose()` が command を送った上で `Worker.terminate()` を呼ぶこと、disposed後の呼び出しが `INVALID_STATE` になること。

**故障注入(陽性対照付き)を実施した**: (a) `handleMessage` の世代チェック(`if (message.generation !== this.generation) return;`)を一時的にコメントアウトして実行 → 「世代が異なるresponse/eventは無視する」テストが**失敗する**ことを確認(`expected true to be false`)。(b) `handleWorkerFailure` 内の `req.reject(...)` を一時的にコメントアウトして実行 → 異常終了・messageerror・timeoutの3テストが**全てtimeoutで失敗する**ことを確認。いずれも `cp`/`diff` でソースを退避してから壊し、`diff` で元と完全一致することを確認して復元した(検査が実際に効いていることを確認済み)。

`npx tsc --noEmit` はクリーン、`npm test` は既存509件+新規23件(url-params 16件、worker-core-proxy 7件)の**532件全通過**。既定経路(`?worker=1` を指定しない場合)は `LocalCoreProxy` のみを使う既存コードパスを変更していないため、既存テストが全通過することがそのまま無影響の担保になる。

### 今回やらなかったこと・未確認のこと

- 映像・音声の出力経路(手順5)、駆動ループ(手順7)、入力(手順6)は未着手。`?worker=1` で起動しても画面・音は一切出ない(意図した状態)。
- `WorkerCoreProxy` の自動再生成(手順9のスコープ)は今回実装していない。異常終了後は `failed` フラグが立ったままで、以後の呼び出しは即座に `WORKER_FAILURE` で reject される。

### 追記(2026-08-28): 実ブラウザでは一度も起動していなかった不具合と修正

上の「未検証」としていた実ブラウザでの `?worker=1` 動作確認を行ったところ、**テスト532件が全通過していたにもかかわらず、Worker骨格は実ブラウザでは一度も起動していなかった**(「コンパイルできる」は「動く」の証明にならない、の再現)。原因・修正・確認方法を以下に記録する。

**原因1: クラシックworker前提が dev では成立しない。** `src/core-proxy.ts` の `defaultCreateWorker()` は `new Worker(new URL('./core-worker.ts', import.meta.url))` を `type` 指定なしで生成していた。上のコメントでは「`vite.config.ts` が `worker.format` を明示していないため既定の `'iife'`(クラシックworker)でビルドされる想定」と書いていたが、これは **build 時の話であって dev サーバには当てはまらなかった**。実測すると、`vite dev` は type指定なしのWorkerを `?worker_file&type=classic` として配信するが、返す中身には ESM の `import { ... } from '/src/...'` 文がそのまま残っており、クラシックworkerはこれを解釈できず構文エラーで即死していた(`CoreProxyError: Workerでエラーが発生しました`)。

**修正1**: `defaultCreateWorker()` を `{ type: 'module' }` 付きに変更し、モジュールworkerとして生成するようにした。

**原因2: モジュールworkerでは `importScripts()` が使えない。** `src/core-worker.ts` は emscripten glue(`px68k_libretro.js`)を `importScripts('/core/px68k_libretro.js')` で読み込んでいたが、モジュールworker内ではこの関数自体が存在しない。またこのglueは「クラシックスクリプトとして`self.PX68K`/`window.PX68K`にグローバル代入する」形式であり、単純に `import()` で読み込むとモジュールスコープに閉じてグローバルへの代入が起きない。

**修正2**: `fetch('/core/px68k_libretro.js')` でソースを取得し、間接eval(`(0, eval)(src)`)でワーカーのグローバルスコープに対して評価する形に変更した。間接evalを使うことで、通常のeval(直接呼び出し)がその場のローカルスコープで実行されるのに対し、グローバル(`self`)スコープでの実行を保証している。実ブラウザで `self.PX68K` が実際に設定されることを確認済み(後述)。

**原因3: 起動ハンドシェイクの欠如による初回commandの取りこぼし。** 修正1・2の後も `initialize` が応答timeout(10秒)で失敗し続けた。調査の結果、`new Worker(...)` 直後に送った最初の command(`initialize`)が、Worker側の `self.onmessage` が実際にセットされた後になっても一度も届いていないことが分かった(`self.onmessage` が関数であることを実ブラウザで確認済みなのに、onmessage内のログが一切出ない)。モジュールworkerはimportグラフの解決・フェッチに実時間がかかり、その間にmainスレッドから送られたメッセージを取りこぼす挙動を実測した。

**修正3**: `src/core-protocol.ts` に generationを持たない専用のハンドシェイク型(`WORKER_BOOT_ACK_KIND`/`isWorkerBootAck`)を追加。`core-worker.ts` は `ctx.onmessage` の登録が完了した直後に一度だけこれを送り返し、`WorkerCoreProxy`(`core-proxy.ts`)側はこれを受け取るまで実際の `postMessage` を保留してキュー(`preBootQueue`)に積む設計にした。

**原因4: wasm glueの相対パス解決がWorkerでは狂う。** 修正1〜3の後、`self.PX68K` は設定されるようになったが、今度は glue が wasm ファイルを `/src/px68k_libretro.wasm`(誤ったパス)から取得しようとして失敗した。glueは既定で自分自身の scriptDirectory(メインスレッドでは `document.currentScript.src`、Workerでは `self.location.href`)から wasm の相対パスを推測するが、`fetch+eval` で読み込んでいるため `self.location.href` は core-worker.ts 自身のURLになってしまい、意図しないパスになっていた。

**修正4**: `src/libretro-host.ts` の `init()` で `getPX68KFactory()({ locateFile: (path) => `/core/${path}` })` のように `locateFile` を明示し、メインスレッド・Worker双方で scriptDirectory 推測に依存しないようにした(メインスレッドの `<script src="/core/px68k_libretro.js">` と同じ絶対パスであり、既存の挙動と一致する)。

**実ブラウザでの確認方法(dev・本番ビルド双方)**: puppeteer-core で実Chromeを起動し(`scripts/measure-*.mjs` の様式を参考に、scratchpad に独立したスクリプトを書いた。計測スクリプト本体は実行していない)、`http://127.0.0.1:5299/?system=1&run=1&worker=1` を開いて `console`/`pageerror`/`workercreated`(Worker自身のconsole/errorも `worker.on('console')` で購読)を収集した。

- **dev(`npm run dev`)**: `[worker skeleton] initialize/ready 完了。loadGame=false avInfo=ok` のログ到達を確認(`loadGame=false` は `/game/boot.cmd` が存在しないため想定どおりの失敗であり、`writeFile` 未実装によりこのcmdファイル自体をWorker側へ書けない設計上の制約であって今回のバグとは無関係)。
- **本番ビルド(`npm run build` → `npm run preview`)**: 同一URLで同じログ到達を確認。ビルド後の `dist/assets/core-worker-*.js` はIIFE形式(import/importScripts不使用)にバンドルされ、メインバンドル側の `new Worker(...)` 呼び出しにも `{type:"module"}` が保持されていることを確認した。
- 既定経路(`?worker=1` を指定しない `http://127.0.0.1:5299/?system=1&run=1`)は、今回の変更前後でコンソール出力が完全に同じ(sram write enable ログ・キーリピート設定ログのみ、エラー無し)であることを確認し、無影響を担保した。

**再発防止の静的検査(`test/core-worker-build-format.test.ts`、新規)**: 実ファイルを読んで (1) `defaultCreateWorker()` が `type: 'module'` 付きで `new Worker(...)` していること、(2) `core-worker.ts` が実コード中で `importScripts(` を呼んでいないこと(コメントの説明文と区別するため、判定前にコメントを除去する)、(3) glueの読み込みが `fetch('/core/px68k_libretro.js')` と `(0, eval)(` の組み合わせであること、を検査する。**陽性対照**: 実装時に `src/core-proxy.ts`/`src/core-worker.ts` を一時的に修正前の状態(type指定なし・importScripts使用)へ戻し、該当する3件のテストが実際に赤くなることを確認してから元に戻した(`cp`で退避 → 破壊 → `npx vitest run` で red 確認 → 復元、の手順)。

**この静的検査の限界(重要)**: これはあくまで「構文・API選択の形」を検査するものであり、**「実ブラウザで実際に `ready` まで到達する」ことは一切保証しない**。今回の不具合そのものが「テスト532件が全通過していたのに実ブラウザでは一度も起動していなかった」というケースであり(「コンパイルできる」は「動く」の証明にならない、の再現)、静的検査は再発の一部(型・API選択の巻き戻り)しか防げない。実ブラウザでの動作確認(dev・本番ビルド双方で `ready` に到達すること)は、この種の変更をコミットする前に毎回、手動またはスクリプトで別途行う必要がある。

修正後、`npx tsc --noEmit` はクリーン、`npm test` は既存532件+新規4件の**536件全通過**。

## ワーカー移行 手順5・7：映像・駆動ループの実装、`?worker=1` を本体経路化（2026-08-28）

手順4の骨格(メインスレッドのコアと並んで2本目のコアをWorkerに立てるだけの試験用の形)を、**`?worker=1` のときはWorker上のコアだけを本体として使う**形へ作り替えた。今回のスコープは映像(手順5)と駆動ループ(手順7)のみで、音声・入力・FDDホットマウント・SRAM・ステート保存/復元は引き続き未移行。

### 変更した設計判断の反映

- **映像は転送方式**: `src/core-worker.ts` は scratch `OffscreenCanvas` へ描画させたまま、毎tick `getImageData()` で読み出したRGBAを `frame` event の transferable として送る。メイン側(`src/main.ts` の `bootWorkerCore()`)は実際の `#screen` canvas へ `putImageData()` する。`ImageData(data, w, h)` コンストラクタは `data` をコピーせずそのまま backing store にする(HTML仕様どおり)ため、渡した `Uint8ClampedArray` を包む `ArrayBuffer` を `putImageData()` 直後にそのまま `WorkerCoreProxy#returnFrameBuffer()` で送り返せる。
- **バッファ返却**: `src/worker-drive-loop.ts` の `FrameBufferPool`(byteLengthキーのスタック)が受け持つ。プールが空で新規確保した回数を `misses` として公開し、`FrameSnapshot.poolMisses` に載せてmain側から観測できるようにした(`__webx68kDebug.workerStats()`)。**GCスパイク低減の効果は今回も確認していない**(既存の実測記録どおり)。採用理由は毎フレームの `new ArrayBuffer()` 確保そのものを無くすことにある。
- **駆動は `setInterval` + accumulator**: `src/worker-drive-loop.ts` の `runTick()` が既存メインループ(`src/main.ts` の `loop()`)と同じ考え方(`computeFrameBudget()` による取り戻し)を純粋関数として持つ。音声キューが無いため、メインループにある「音声キュー深さによる±2%のframeInterval補正」は入れず、`computeFrameBudget()` には `queued=0, speedMultiplier=1` を固定で渡す(コード中にコメントで明記)。`core-worker.ts` はこの純粋ロジックに `self.setInterval`/`performance.now()`/`LibretroHost` を結線するだけの薄い層になっている。

### 追加・変更したファイル

- `src/worker-drive-loop.ts`(新規): `runTick()`(取り戻し計算)と `FrameBufferPool`(バッファプール)。`self`/`OffscreenCanvas`/`fetch` に依存しない純粋ロジックだけを切り出し、`core-worker.ts`(実Workerグローバル依存、前例どおりNodeから直接実行しない)とは別に単体テスト可能にした。
- `src/core-worker.ts`: `setRunning`/`readTextScreen` を実装(残りの未実装opは引き続きUNSUPPORTED)。`handleInitialize()` で初期ディスク(`InitPayload.initialDisks`、後述)をマウントし `/game/boot.cmd`・`/system/keropi/config` を書いてから応答する。tick()ごとに `runTick()` を呼び、進んだフレームがあれば `sendFrame()` でRGBA+アクセスフラグ+`poolMisses`を送る。
- `src/core-protocol.ts`: `FrameSnapshot.poolMisses` を追加。`RETURN_FRAME_BUFFER_KIND`/`isReturnFrameBufferMessage`(generation/requestIdを持たない一方向のバッファ返却メッセージ。command/responseの往復に乗せると毎フレームのpending管理・timeoutオーバーヘッドを払うことになるため区別した)。`InitPayload.initialDisks` を「path参照のみ」から「`{slot, name, bytes}` の実体」へ変更(Workerはメインの MEMFS を共有しておらず、初回マウントには実バイト列が必須と判明したため。手順4時点のコメントで「bytesが必要になった場合は別opで」としていた宿題を、初回マウントは実行中の差し替え=FDDホットマウントとは別物と整理した上でここで解消した)。
- `src/core-proxy.ts`: `WorkerCoreProxy` に `setRunning()`/`returnFrameBuffer()`/`setEventHandler()`(`ready`/`frame`/`sramChanged` eventの購読)を追加。`readTextScreen()` を実装(`issue('readTextScreen', {})`)。`init()` に `initialDisks?: InitialDiskInput[]` を追加引数として持たせた(`LibretroHostProxy` インタフェースには無い、`WorkerCoreProxy` 固有の追加パラメータ。オプション引数なので構造的両立性は保たれる)。
- `src/main.ts`: `bootCore()` の先頭で `urlWorkerMode` のとき `bootWorkerCore()` へ完全分岐し、以降は元のコード(`host`=メインスレッドの`LibretroHost`を使う経路)へ一切触れない。`bootWorkerCore()` は `WorkerCoreProxy` を唯一のコアとして起動し、`slots.fdd0/fdd1/hdd` から `InitialDiskInput[]` を組み立てて渡し、frame eventをcanvasへ描画・アクセスランプへ反映する。`pollDiskAccess()` のランプ反映ロジックを `applyDiskAccess()` として切り出し、既定経路(host読み出し)とWorker経路(frame eventのdisk.access)の両方から使えるようにした。

### 未移行機能を「見える形」にする(手順4・5・7で要求された制約)

入力・音声・FDDホットマウント・SRAM・ステート保存/復元は今回のスコープ外。無言のno-opにしないため:

- 起動完了時に1回、`console.warn` + トースト(6秒表示、文言キー `workerModeUnsupported`、ja/en両方追加)で「入力・音声は未対応」と知らせる(キー入力のたびに出すと使い物にならないため、起動時の1回にまとめた)。
- FDDホットマウント(起動中のディスク挿入/排出): `insertDiskBytes()`/`ejectSlot()` の先頭で `urlWorkerMode && running` を見て弾き、トーストを出す。起動前のスロット選択(初期マウント用)は従来どおり通す。
- ステート保存/復元: `handleSaveState()`/`handleLoadState()` の先頭で `urlWorkerMode` を見て(起動中ならトースト、未起動なら無言で抜ける。従来の `!host` ガードと同じ挙動を維持しつつ、起動中に押した場合だけ理由を知らせる)。

### テストと故障注入

新規 `test/worker-drive-loop.test.ts`(10件)と `test/worker-core-proxy.test.ts` への追加(6件、既存5件+新規6件で計11件)。

- `runTick()`: 通常dt・遅延dt(取り戻しで複数フレーム進むこと)・runFrameOnce呼び出し回数の一致・異常なdt(タブ復帰)でのaccumulator破棄・tick内複数フレームでのアクセスフラグOR合成。
- `FrameBufferPool`: 新規確保でmisses増加・返却後の再利用でmissesが増えないこと(参照同一性で確認)・サイズ違いは別キー・返却しなければmissesが増え続けること(バッファ返却が効いていない状態の再現)。
- `WorkerCoreProxy`: `readTextScreen()`/`setRunning()`/`returnFrameBuffer()`(generation/requestId無しの一方向メッセージであることを確認)/`setEventHandler()`によるframe/ready eventの転送。

**陽性対照(故障注入、実装時に確認)**:
1. `runTick()` のwhileループを「1tick最大1フレーム」に書き換え → 「遅れたtickで複数フレーム進む」「tick内複数フレームのOR合成」の2件が実際にredになることを確認してから復元。
2. `WorkerCoreProxy#readTextScreen()` を `unsupported('readTextScreen')` に戻す → 該当テストがredになることを確認。
3. `handleMessage()` 内の `this.eventHandler?.(message)` をコメントアウト → frame/ready event転送のテストがredになることを確認。
いずれも `cp` で退避 → 破壊 → `npx vitest run` でred確認 → 復元、の手順。

修正後、`npx tsc --noEmit` はクリーン、`npm test` は既存536件+新規14件の**550件全通過**。

### 実ブラウザでの確認(dev・本番ビルド双方)

Claude_Browser(実Chrome、`?worker=1` で `http://localhost:<port>/?worker=1` を開き「システムディスクで起動」をクリック)で確認:

- **dev(`npm run dev`)**: 起動後10秒程度で `A>ECHO OFF` → `A>` プロンプトに到達。`__webx68kDebug.screenText()` が実際に `lines: ["Human68k for X680x0 version 3.02", ..., "A>ECHO OFF", "A>..."]` を返すことを確認(コマンド出力ではなく行内容そのものを目視確認)。`__webx68kDebug.workerStats()` は `frameNo` が1520→2259(3秒間で739フレーム、駆動ループが継続していることを確認)、**`poolMisses` は3のまま変化せず**(バッファ返却が効いて頭打ちになっていることを確認)。
- **本番ビルド(`npm run build` → `npm run preview`)**: 同一手順で同じく `A>ECHO OFF` の後 `A>` プロンプトの表示までスクリーンショットで確認(`__webx68kDebug` はDEV限定オブジェクトのためprodには存在せず、prodの確認はスクリーンショットによる目視のみ)。`dist/assets/core-worker-*.js` チャンクが生成されていることも確認した。
- **既定経路(`?worker=1` なし)は本番ビルドで従来どおり起動することを確認**(同一システムディスクで `A>` まで到達、画面表示に変化なし)。

FDD0のドライブ行に赤いアクセスランプが点灯することも上記スクリーンショットで確認しており、frame eventの `disk.access` → `applyDiskAccess()` の経路が実際に機能していることの追加証拠になっている。

### 今回できなかったこと・未確認のこと

- 入力・音声・FDDホットマウント・SRAM・ステート保存/復元(手順6・8・9のスコープ)は未着手のまま。
- puppeteer-core による自動化スクリプト(scratchpadに作成、`scripts/measure-*.mjs`ではない)は、手動のdevサーバーと重複起動させた際にプロトコルタイムアウトで不安定になった。最終的な合否判定はClaude_Browser(MCP)による手動確認で行った。自動化スクリプト自体の安定化は今回やっていない。
- 55.5Hz(31kHzモード)の達成率については「Aの追測」節で未決のまま残っている問題(`setInterval`下でも99%達成が3試行そろわない)を、今回はプロンプト到達の確認を優先し、定量的な再測定はしていない。
- iOS/Android実機での確認は未実施。

## Worker経路の起動時間：同一ビルドA/B（2026-08-28）

前節までの粗い観測(15秒刻みの目視、本番ビルド、既定経路は38秒時点で描画済み、Worker経路は45秒で未描画・60秒で描画)を受け、`scripts/measure-boot.mjs` を拡張してWorker経路(`?worker=1`)を計測できるようにし、同一ビルド・同一セッションでA/Bを取った。

### 計測系の変更

- `scripts/measure-boot.mjs` に `--worker` オプションを追加した。計測対象URLへ `worker=1` を付けるだけで、**未指定時の挙動には一切影響しない**(既存の `measurementUrl` 組み立てはそのままで、`if (config.worker)` の分岐を通らない)。
- このスクリプトはDOMのボタンクリックと `screenText()`/`status()` ポーリングだけで完了を判定しており、ゲストへのキー入力は使っていないことをコード読解で確認してから着手した(Worker経路は入力未対応のため、これが成立しないと計測自体が成り立たない)。
- **Worker経路特有の欠落を1件、`src/main.ts` に最小修正した**: 既定経路は `host.avInfo.fps` でコア稼働(coreReady)を判定するが、Worker経路は `host` が常に `null` のため、`__webx68kDebug.stat()` とブリッジの `status()` の両方で `fps` が恒久的に `null` になり、coreReadyが原理的に検出不能だった。`bootWorkerCore()` が `proxy.fetchAvInfo()` の戻り値を `workerAvInfo` という新規モジュール変数に保持し、`stat()`/`status()` は `host?.avInfo?.fps ?? workerAvInfo?.fps ?? null` にフォールバックするようにした。既定経路は `host.avInfo` が既に設定されるためこの分岐を通らず、**既定経路の挙動は変えていない**(`npx tsc --noEmit` クリーン、`npm test` 550件全通過で確認)。

### 計測条件

- 同一ビルド(コミット `d9927b1` + 本作業の未コミット差分、`environment.build.commit`/`dirtyFiles` で記録済み)・同一セッションで、`--mode=prod`(本番ビルド、MCPブリッジ経由でTVRAMを読む既存方式)を使用した。dev計測ではない(前節の移行前基準はdevの値であり、混同しないこと。後述)。
- 取得順は**既定経路5試行→Worker経路5試行**の順番固定(交互ではない)。それぞれ別のスクリプト起動(`npm run build` を含む)であり、ビルドは2回走っているが、両方とも同一コミット・同一の未コミット差分から生成されているためソースは同一である。
- 実行前に `pgrep -f "scripts/measure-|scripts/probe-|vite"` で他の計測が走っていないことを確認してから実行した。
- 出力: `default-prod-5.json`(既定、5/5成功)、`worker-prod-5.json`(Worker、`--worker --timeout=90000`、5/5成功)。

### 結果

| | 既定経路(5試行) | Worker経路(5試行) |
| --- | --- | --- |
| 起動時間 中央値 | 26,001.84 ms | 45,889 ms |
| 起動時間 分布 | 25,054〜27,730 ms(p95 27,427/p99 27,670) | 43,334〜57,979 ms |
| 成功率 | 5/5 | 5/5 |

**Worker経路は既定経路のおよそ1.76倍**。粗い観測(38秒 vs 45〜60秒、比にして概ね1.2〜1.6倍)と大まかに整合する。

区間内訳(既知の注意: `wasmFetchComplete` と `coreReady` の隣接2マイルストーンは判定位置のぶれで入れ替わり得るため、本来は合算して比べる約束だった。ところがWorker経路では**wasm取得がWorker自身のグローバルスコープで発生し、メインドキュメントの `performance.getEntriesByType('resource')` から一切見えない**ため、`clickToWasmFetchComplete`/`wasmFetchCompleteToCoreReady` は**5試行とも0件(null)**だった。したがって既定経路との区間比較は、`click→coreReady`(生の `milestones` から差分を再計算。マイルストーン定義自体は既定経路と共通)を単位にした):

| 区間 | 既定経路 中央値 | Worker経路 中央値 |
| --- | --- | --- |
| click→coreReady(起動〜コア稼働) | 15,971.67 ms | 6,258.37 ms |
| coreReady→promptStable(コア稼働〜プロンプト安定) | 9,687.70 ms | 40,840.86 ms |

**どこが遅いかについて言えること**: 遅延はほぼ全て「コア稼働後、ゲストがプロンプトに到達するまで」の区間(coreReady→promptStable)に集中している。この区間はWorker経路が既定経路のおよそ4.2倍(40,841 ms vs 9,688 ms)。逆に click→coreReady はWorker経路の方が速い(6,258 ms vs 15,972 ms、既定経路の半分以下)。したがって**「wasm取得・コア初期化そのもの」はWorker経路のボトルネックではない**。

**まだ言えないこと(原因は特定していない)**: coreReady→promptStable が遅い理由は特定していない。候補として、以下は今回の計測からは切り分けられていない:
- Worker↔メインスレッド間のメッセージ往復(`readTextScreen`/`status` の `postMessage`ラウンドトリップ)自体のオーバーヘッド
- frame event(putImageData + バッファ返却)の処理コストがメインスレッドを圧迫している可能性
- Worker内の駆動ループ(`setInterval` + 取り戻し、`TICK_MS=16`)がメインスレッドと別スレッドである分のスケジューリング差
- ブリッジ計測自体(bridge URLパラメータ・WebSocket経由の `screen_text`/`status` ポーリング)がWorker経路に対してだけ追加コストを課している可能性(既定経路も同じブリッジを使っているが、既定経路は `host` 直読みのぶん経路が短い)

これらを切り分けるには、Worker側にも frame No ベースの区間タイムスタンプ(既定経路の `frameProbe` 相当)を追加するなど、今回のスコープ外の計測系拡張が必要。**推測を結論として書かない。**

### 移行前基準(23.5〜24.3秒)との関係

「移行前基準の起動中央値23.5〜24.3秒」は**dev serverでの値**(凍結ビルド `cbb19b8`、「移行前基準：1組目」節)であり、本節の計測(`--mode=prod`)とはモードが異なるため**単純比較できない**(「本番ビルドでの計測は現時点で成立しない」「本番ビルドの起動時間」の両節で既に明記されている制約と同じ)。本節の既定経路(prod)中央値26,001.84msは移行前基準(dev)24,393msと近い値だが、これは偶然の近さであり、モードが違う以上「回帰していない」の根拠にはできない。**Worker経路の遅さは、あくまで同一セッションで取った既定経路(prod)との比較でのみ言える。**

### 計測系の検証(故障注入)

`--mode=prod --worker --fault=wrong-marker --runs=1 --timeout=90000` を実行した。陽性対照(fault無し)は成功(47,852.345 ms)、`wrong-marker` 注入後は5試行中0件成功・全件`timeout`理由で失敗し、**期待どおり検出**した。既定経路で検出できてもWorker経路で検出できなければ計測を信用できないため、この確認を必須とした。

### 試行数と結果ファイルの突き合わせ

| 実行 | config.runs | attempts件数 | positiveControl |
| --- | --- | --- | --- |
| 既定(`default-prod-5.json`) | 5 | 5 | なし |
| Worker(`worker-prod-5.json`) | 5 | 5 | なし |
| Worker故障注入(`worker-fault.json`) | 1 | 1 | あり(1件、成功) |

3回のスクリプト実行いずれも試行数と結果件数が一致し、欠測はない。

### できなかったこと

- coreReady→promptStable が遅い**根本原因の特定**(上記「まだ言えないこと」参照)。
- Worker経路でのwasm取得単体の時間計測(Worker自身のリソースタイミングを計測系へ橋渡しする仕組みが無いため)。
- A/A再測定(今回は1組のみ)。日差・負荷差の切り分けは未実施。
- dev モードでのWorker経路A/B(今回はprodのみ)。

## coreReady→promptStableが遅い原因調査：tick内訳プローブ（2026-08-28）

前節で特定した「coreReady→promptStableがWorker経路で既定経路の4.2倍遅い」を切り分けるため、Worker側の駆動ループ(`src/core-worker.ts` の `tick()`/`sendFrame()`)に1tickごとの内訳プローブを追加した。**推測で直す前に、まず測る**ことを目的とし、今回は製品コードの修正は行っていない(見つかったのは計測ツール自身の実装ミス1件のみ。後述)。

### 追加した計測系

- `src/core-worker.ts`: DEV限定・既定offの `WorkerTickProbe`。1tickごとに次を記録する: `sinceLastTickMs`(前tickからの実経過)、`ranFrames`(そのtickで実際に進めたフレーム数)、`budgetHint`(`computeFrameBudget()` を同じ入力で再計算した参考値)、`accumulatorBeforeMs`/`accumulatorAfterMs`、`runTotalMs`(`retro_run()`+`readDiskAccess()`の合計)、`convertMs`(`getImageData()`)、`postMs`(`postMessage()`)、`busyWaitInjectedMs`(故障注入)。`import.meta.env.DEV` はビルド時定数のため、prodビルドではこの分岐ごと消える(既存の `frameProbe`/`storageProbe` と同じ作法)。
- 制御はメインスレッドの `window` を直接触れないため、`CoreCommand`/`WorkerToMain` のunionを汚さない専用の生メッセージ(`__devTickProbe`/`__devTickProbeData`)で行う。`src/core-proxy.ts` に `devPostRawMessage()`/`setDevMessageHandler()` を追加し、`src/main.ts` に `workerTickProbeEnable/Reset/SetBusyWaitFault/Read` を追加した。`bootWorkerCore()` はproxyを起動のたびに作り直すため、「起動前に有効化したい」という意思(`workerTickProbeWanted`)を持ち越し、proxy生成直後に即enableする(遅れが集中する区間そのものを取り逃さないため)。
- 計測スクリプト `scripts/measure-worker-tick.mjs` を新規作成した。dev server(`import.meta.env.DEV` が true になる唯一のモード。prodではプローブごと消えるため)+ 実Chrome(ヘッドフル、`--disable-backgrounding-occluded-windows` 等でタブ非アクティブ扱いのスロットリングを避ける)で `?system=1&run=1&worker=1` を自動起動し、起動前にプローブを有効化、`A>` プロンプト安定を待ってから内訳を読み出す。

### 計測系の検証

- **プローブ自体のコスト**: dev server 1プロセス内でprobe有効/無効を交互に2回ずつ実行した。1回目(そのプロセスで最初に開いたページ)は順序に関わらず突出して遅く(devサーバーのモジュール変換キャッシュのコールドスタート。実測: 有効/無効を入れ替えると遅い方も入れ替わり、符号が反転した)、これはプローブのコストではなく計測条件そのものの効果と判断した。1回目を除いた2回目同士の比較では有効44,290ms・無効43,973msで差317ms(約0.7%)、ノイズの範囲内。**プローブのコストは無視できる。**
- **故障注入**: 30tickごとに固定30msのbusy waitを注入する経路を追加し、実行して `busyWaitInjectedMs>0` が927tick中31件観測された(30tickに1回の期待どおり)ことを確認した。この検証中に**計測系自身のバグを1件発見して修正した**: `workerTickProbeSetBusyWaitFault()` を起動前(proxy生成前)に呼ぶと `workerCoreProxy` が `null` で無言のno-opになり、`enable` と違って「起動時に持ち越す」フラグが無かったため、故障注入が一度も発火しなかった(`injectedCount: 0`)。`workerTickProbeBusyWaitFaultWanted` を追加し、proxy生成直後に `enable` と同様に送るよう修正した(`src/main.ts`)。修正後に再実行し、期待どおり検出できることを確認した。**これは計測ツールのバグであり、製品コード(既定経路・Worker経路の本体挙動)には影響しない。**

### 実測結果(dev server、`?system=1&run=1&worker=1`)

起動そのものがdev modeでは不安定で(1試行がタイムアウト、詳細は「できなかったこと」参照)、成功した1試行(`bootDurationMs=59,612ms`)の内訳:

- **tick数924、実行フレーム数合計1,809、実測区間の実効fps 35.7fps**(目標55.5fpsの約64%)。
- **1tickあたりの実行フレーム数の分布**(`ranFrames`のヒストグラム): 0フレーム113件(12%)・1フレーム546件(59%)・2〜7フレーム190件(21%)・**上限8フレーム(取り戻しの天井)に達したtickが75件(8%)**。取り戻し自体は実働で繰り返し発動しており、**「取り戻しが効いていない」という当初の仮説1は否定できる**。
- **時間帯ごとの推移**(tickを4等分): 実効fpsは前半から後半にかけて単調に上昇した(23.1fps→41.5fps→49.7fps→55.5fps)。**後半(第4四分位)は目標fpsにほぼ到達している**。遅れは起動直後に集中しており、定常化すれば速い。
- **内訳の内訳**: 中央値では `runTotalMs`(retro_run)3.16ms・`convertMs`(getImageData)3.56ms・`postMs`(postMessage)0.035msで、**postMessageは常に無視できるほど小さい**(仮説3「バッファ返却がループを律速している」は支持されない)。ただし第1四分位(tick 0〜230、壁時計24,759ms)だけを見ると `runTotalMs` の合計が12,123msに達し、**壁時計の49%をretro_run自体が占めている**。1フレームあたりのretro_run時間に換算すると第1四分位は約21ms/frame、第4四分位は約3.4ms/frameで、**起動直後はretro_run自体が定常状態の約6倍重い**(仮説2「1ティックの仕事が重い」は起動直後に限れば支持される。ただしrun/convert/postの合計だけでは壁時計の全てを説明できない。次点参照)。
- **説明のつかない空白**: tick単位で見ると、`sinceLastTickMs`(前tickからの実経過)が `runTotalMs+convertMs+postMs` の合計を大きく超えるケースが複数あった。最大は tick 2 で `sinceLastTickMs=8,826ms` に対し `runTotalMs=1,277ms`・`convertMs=14ms`・`postMs=0.06ms`(合計約1,291ms)で、**約7.5秒が計測した3区分のどれにも属さない**。同様の空白は tick 3(1,577ms中61.7ms計測)、tick 206(704ms中34.3ms)など複数件確認した。**これが仮説1〜3のいずれとも異なる、今回最大の未解明要素。**

### 比較参考値(既定経路、dev server、frameProbe流用)

既定経路にも同じ観点でframeProbeを流用して1試行採取した(内訳なし。`retro_run`合計時間のみ既存の`runEvents`から取得): frameCount 594・実測区間26,075ms・**実効fps 26.075fps**。既定経路も起動中は目標fpsを大きく下回っており、**起動直後にretro_run(またはコア/ゲスト側)が重い傾向はWorker経路に限らない可能性がある**。ただし計測手法(tick粒度 vs frame粒度)が異なるため、この数値だけでWorker経路固有の遅れの割合を分解することはできない。

### 原因について言えること・言えないこと

**言えること**:
- 取り戻し(1tickあたり最大8フレーム)は実働で繰り返し発動しており、機能していないわけではない(仮説1は否定)。
- postMessage(転送)は常に無視できるほど小さく、ボトルネックではない。
- 起動直後はretro_run自体が定常状態よりずっと重い(実測約6倍)。この傾向は既定経路のframeProbeでも(粒度は違うが)同様に低fpsが観測されており、Worker固有と決めつけられない。
- tick間隔が計測済みの内訳(run/convert/post)の合計を数秒単位で超える「空白」が複数回存在する。

**言えないこと(未特定)**:
- 上記「空白」の直接原因(setInterval自体のスロットリング、他の未計測処理、JIT起因の一時停止等、候補はいずれも今回のプローブでは切り分けられない)。
- Worker経路の「4.2倍」のうち、retro_run自体の重さと、この空白と、その他の要因がそれぞれどれだけ寄与しているかの定量分解。
- 起動直後にretro_runが重い現象がWorker経路固有か、既定経路と共通(コア/ゲスト側由来)かの確定(手法が違う数値の比較でしかない)。
- prodビルドでの同じ内訳(プローブがDEV限定のため、devでしか測れていない。dev/prodは絶対値が違うため、devで見えた傾向がprodでも同程度かは未確認)。

### できなかったこと

- **3試行以上の完走**。dev modeでの`?worker=1`起動タイムアウト(90,000ms)を1試行で踏んだため、時間内に安定して3試行を得られなかった(成功した1試行のみで内訳を報告している。中央値ではなく単一試行の値であることに注意)。
- 「空白」の直接原因特定(上記参照)。
- prodビルドでの同じ計測(プローブがDEV限定のため不可能)。
- 製品コードの修正(明白な単一原因が見つからなかったため、今回は計測のみ。修正コミットは無い)。

## 次にやること

移行前基準は2組そろい、**ワーカー移行に着手できる状態になった**。

1. ~~ワーカー移行の手順3(ステートと単純なFS転送)に進む。~~ → **2026-08-28 実施済み**（「ワーカー移行 手順3：ステートとFS転送の非同期化（実装）」参照）。~~次はワーカー移行の手順4(初期化、オプション、load/AV)に進む。~~ → **2026-08-28 実施済み**（「ワーカー移行 手順4：初期化・load/AVのスケルトン実装」参照）。~~手順5・7(映像・駆動ループ)に進む。~~ → **2026-08-28 実施済み**（「ワーカー移行 手順5・7：映像・駆動ループの実装、`?worker=1` を本体経路化」参照）。`?worker=1` でHuman68kが`A>`プロンプトまで到達することをdev・本番ビルド双方で確認済み。**次はワーカー移行の手順6(入力)に進む。**
2. **計測時に既定出力デバイスを内蔵スピーカーに固定する。**条件 (a)(b)(c) に加えて (d) とする。ハーネスが記録するようになったので、結果ファイルで照合できる。
3. **`persist()` の切り分け。**普段使いのプロファイルで `node scripts/probe-opfs.mjs --serve` のページを開き、`false` が使い捨てプロファイル固有かどうかを見る。
4. ~~iOS WebKit での確認。~~ → **2026-08-26 に確認済み**（「OPFS前提条件の実機確認（iOS、実測、2026-08-26）」参照）。A〜Eは成立し、決定2の対象範囲は変更不要と判断した。
5. ~~決定3の受け入れ条件をIndexedDBのレコード列挙で書き直す。~~ → **2026-08-28 に実施済み**（`src/disk-store.ts` の `measureDiskLibraryBytes()`、「決定3の受け入れ条件（IndexedDBのレコード列挙、2026-08-28 書き直し）」参照）。
6. **iOSのeviction実挙動の確認。**`persist()` がfalseのまま運用したとき、容量逼迫時にいつ・どういう条件でデータが消えるのかは未確認のまま。
7. ~~決定4：`showOpenFilePicker`/`FileSystemFileHandle` の対応状況調査(案②の実現性確認)。~~ → **2026-08-28、案②(実ファイルへの書き戻し)を不採用と決定したため不要になった**（「決定4：実ファイルへの書き戻し（案②）は採用しない（2026-08-28 改訂）」参照）。
8. **Pixel 6a(Android Chrome)でのOPFS同期ハンドルの実機確認。**決定4の改訂によりファイルピッカー対応は不要になったが、OPFS同期ハンドル(`createSyncAccessHandle`)がAndroid Chromeで動作することはまだ実測していない。iOS(Safari・Chrome for iOS)は「OPFS前提条件の実機確認（iOS、実測、2026-08-26）」で確認済みだが、docsにAndroidでの実測記述は現時点で0件。決定2(SCSIのI/OはOPFS同期ハンドル経由)の対象範囲にAndroidを含めてよいかを確定するため、宿題として追加する。
9. ドライブ計測の試行数を5から増やすか検討する（DIR A: の日差が±25%あり、現状では回帰を分離できない）。

**iPhone実機での計測はここでいったん区切る。**負荷併走・バックグラウンド復帰・排他は確認できたが、項目1は合成負荷であり、実際のエミュレータコアで測れているわけではない。次に実機計測が必要になるのは、**ワーカー移行が終わり、実際にコアがワーカー内で動く形になってから**である。そのタイミングで、合成負荷ではなく本物のコア負荷で項目1を測り直すのに合わせて、以下も宿題としてまとめて測る。

10. **長時間バックグラウンド化の確認。**今回は14.9秒しか試していない。数分〜数十分の凍結やメモリ逼迫下でのハンドル生存・ワーカー生存を確認する。
11. **2タブでの排他の実地確認。**単一タブ内の多重取得では排他が効くことを確認済みだが、実際に2枚のタブを開いての相互確認（`manualCrossTab`）は未実施のまま。案内UIの出し方も含めて確認する。
12. ~~手順5・7着手前の未決事項3点(映像経路・frame event・スケジューラ)の実測。~~ → **2026-08-28 実施済み**（「ワーカー描画方式の実測（2026-08-28）」参照）。Cは決着（`setInterval`採用が妥当、固定delayの`setTimeout`単独は不可）。AとBは部分決着にとどまり、**OffscreenCanvas方式を選ぶ場合はscreenHash相当の実装変更コストを見積る宿題が残る**。iOS/Android実機とより高負荷条件は未実施のまま。→ **2026-08-28 追測**（「Aの追測：`setInterval`下での速度再測定、バッファ返却の検証（2026-08-28）」参照）。`setInterval`下でも3条件(転送・返却なし/返却あり/OffscreenCanvas)とも55.5Hz達成率99%以上を3試行そろって満たせず、**Aは引き続き未決**。バッファ返却の仕組み自体は`poolMisses`で正しく機能していることを確認したが、期待していたGCスパイク減少は裏付けられなかった。転送方式(返却あり)を本命とする合意は可否面の理由によるもので維持する。**55.5Hz未達の原因切り分けが新たな宿題として残る。**
