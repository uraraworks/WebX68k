// Worker のエントリポイント (docs/STORAGE-SCSI.md「段階移行の順序」手順4のスケルトン)。
//
// 今回実装しているのは initialize→ready / loadGame / fetchAvInfo / dispose の
// command/response のみ。手順5(映像・音声出力)・手順6(入力)・手順7(駆動ループ)は
// まだここへ移していない。したがって loadGame が成功しても retro_run() は一度も
// 呼ばれず、画面や音は一切出ない。これは意図した状態であり、`?worker=1` は既定経路
// (LocalCoreProxy、src/main.ts の実際の描画・駆動ループ)を置き換えない裏のフラグとして
// 存在する(未完成のまま既定経路に混ざらないようにする設計。docs 参照)。
//
// 実コアの駆動には既存の LibretroHost / LocalCoreProxy をそのまま再利用する。
// LibretroHost は内部で canvas.getContext('2d') / width / height / createImageData /
// putImageData しか使わない(src/libretro-host.ts 参照)ため、Worker内では
// OffscreenCanvas を「実際には誰も読み出さない scratch 描画先」として渡す。
// docs の決定A(転送方式・メイン側canvas維持)により、実際に画面へ出す映像経路は
// 手順5でメインスレッドの canvas へ転送する形に置き換える。ここで作る scratch
// canvas の内容は今回どこにも転送されず、破棄されるだけ。
//
// Worker のビルド形式について(実測により訂正): vite dev server はクラシックworker
// 指定(type省略)でも、返す中身に ESM の import 文をそのまま残す(`?worker_file&type=classic`
// として配信されるが本文は `import { ... } from '/src/...'` を含む)。クラシックworkerは
// import を解釈できず構文エラーで即死するため、src/core-proxy.ts の defaultCreateWorker()
// では `{ type: 'module' }` を明示してモジュールworkerとして生成する。
//
// モジュールworkerでは importScripts() が使えない。一方 px68k_libretro.js
// (emscripten glue)はクラシックスクリプトで、グローバル(`self.PX68K` / `window.PX68K`)へ
// 代入する形式(index.htmlの<script src="/core/px68k_libretro.js">と同じもの)なので、
// `import()` で読み込むとモジュールスコープで実行されグローバルに何も設定されない。
// そのため fetch してソースを取得し、ワーカーのグローバルスコープで直接評価する
// (`(0, eval)(src)` の間接eval形にして、この関数のローカルスコープを汚さずグローバル
// self に代入させる)。実ブラウザで self.PX68K が設定されることを確認済み(docs参照)。

import {
  createCoreError,
  CoreProxyError,
  WORKER_BOOT_ACK_KIND,
  type CoreCommand,
  type CoreError,
  type WorkerToMain,
} from './core-protocol';
import { LocalCoreProxy } from './core-proxy';
import { LibretroHost } from './libretro-host';

/**
 * DOM lib と webworker lib は同一 tsconfig 内で共存できない(グローバル `self` の型が
 * 競合する)ため、tsconfig.json の lib はプロジェクト共通の ["ES2020","DOM","DOM.Iterable"]
 * のまま変更しない。Worker専用のグローバル(importScripts、postMessageの正確な引数形)だけを
 * ここで最小限に自前宣言し、`self` をそれらに絞ったshapeへキャストして使う。
 */
interface WorkerGlobalLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<CoreCommand>) => void) | null;
}

const ctx = self as unknown as WorkerGlobalLike;

/** メインの LocalCoreProxy を、initialize 完了後はこの Worker 内の実体として使う。 */
let proxy: LocalCoreProxy | null = null;
let coreModuleLoaded = false;

function post(message: WorkerToMain): void {
  ctx.postMessage(message);
}

function toCoreError(err: unknown, operation: string): CoreError {
  if (err instanceof CoreProxyError) return err.coreError;
  const message = err instanceof Error ? err.message : String(err);
  return createCoreError('CORE_FAILURE', message, { operation });
}

/** px68k-libretro (emscripten) の wasm glue を一度だけ読み込む。index.html の
 * `<script src="/core/px68k_libretro.js">` と同じ絶対パスを使う(base設定に依存しない)。
 * モジュールworker内では importScripts() が使えないため、fetch でソースを取得し
 * 間接eval(`(0, eval)(src)`)でワーカーのグローバルスコープで評価する。このglueは
 * クラシックスクリプトとして自身を `self.PX68K` に代入する形式(import()でモジュール
 * として読み込むとモジュールスコープに閉じてしまい失敗する)。 */
async function ensureCoreModuleLoaded(): Promise<void> {
  if (coreModuleLoaded) return;
  const res = await fetch('/core/px68k_libretro.js');
  if (!res.ok) {
    throw new Error(`px68k_libretro.js の取得に失敗しました (status=${res.status})`);
  }
  const src = await res.text();
  // 間接eval: グローバル(self)スコープで評価させ、この関数のローカルスコープを汚染しない。
  (0, eval)(src);
  coreModuleLoaded = true;
}

async function handleInitialize(
  cmd: Extract<CoreCommand, { op: 'initialize' }>,
): Promise<void> {
  const { generation, requestId, payload } = cmd;
  try {
    await ensureCoreModuleLoaded();
    // scratch canvas: 上のコメント参照。実映像経路は手順5で作る。
    const scratchCanvas = new OffscreenCanvas(1, 1) as unknown as HTMLCanvasElement;
    const host = new LibretroHost(scratchCanvas, () => {
      // 音声経路は手順5で移す。今回は生成されたサンプルを捨てるだけ。
    });
    await host.init(
      new Uint8Array(payload.biosIpl),
      new Uint8Array(payload.biosCg),
      payload.sram ? new Uint8Array(payload.sram) : undefined,
    );
    if (payload.options) {
      for (const [key, value] of Object.entries(payload.options)) {
        host.setCoreOption(key, value);
      }
    }
    proxy = new LocalCoreProxy(host, { initialized: true });
    const avInfo = host.fetchAvInfo();
    post({ kind: 'response', generation, requestId, ok: true, completedFrameNo: 0, result: undefined });
    post({ kind: 'event', generation, event: 'ready', avInfo });
  } catch (err) {
    post({
      kind: 'response',
      generation,
      requestId,
      ok: false,
      error: toCoreError(err, 'initialize'),
    });
  }
}

async function handleLoadGame(cmd: Extract<CoreCommand, { op: 'loadGame' }>): Promise<void> {
  const { generation, requestId, payload } = cmd;
  if (!proxy) {
    post({
      kind: 'response',
      generation,
      requestId,
      ok: false,
      error: createCoreError('INVALID_STATE', 'initialize が完了していません', { operation: 'loadGame' }),
    });
    return;
  }
  try {
    const result = await proxy.loadGame(payload.path ?? '');
    post({ kind: 'response', generation, requestId, ok: true, completedFrameNo: 0, result });
  } catch (err) {
    post({ kind: 'response', generation, requestId, ok: false, error: toCoreError(err, 'loadGame') });
  }
}

async function handleFetchAvInfo(
  cmd: Extract<CoreCommand, { op: 'fetchAvInfo' }>,
): Promise<void> {
  const { generation, requestId } = cmd;
  if (!proxy) {
    post({
      kind: 'response',
      generation,
      requestId,
      ok: false,
      error: createCoreError('INVALID_STATE', 'initialize が完了していません', { operation: 'fetchAvInfo' }),
    });
    return;
  }
  try {
    const result = await proxy.fetchAvInfo();
    post({ kind: 'response', generation, requestId, ok: true, completedFrameNo: 0, result });
  } catch (err) {
    post({ kind: 'response', generation, requestId, ok: false, error: toCoreError(err, 'fetchAvInfo') });
  }
}

async function handleDispose(cmd: Extract<CoreCommand, { op: 'dispose' }>): Promise<void> {
  const { generation, requestId } = cmd;
  try {
    // 決定(前回合意): _retro_deinit() は呼ばない。Worker ごと terminate するため
    // (手順9で改めて判断)。LocalCoreProxy#dispose() は元々 _retro_deinit を呼ばず
    // SRAM自動保存の停止とコールバック関数テーブルの解放のみを行う(src/libretro-host.ts
    // の LibretroHost#dispose() 参照)ので、ここではそれをそのまま使うだけでよい。
    if (proxy) {
      await proxy.dispose();
      proxy = null;
    }
    post({ kind: 'response', generation, requestId, ok: true, completedFrameNo: 0, result: undefined });
  } catch (err) {
    post({ kind: 'response', generation, requestId, ok: false, error: toCoreError(err, 'dispose') });
  }
}

ctx.onmessage = (ev: MessageEvent<CoreCommand>) => {
  const cmd = ev.data;
  switch (cmd.op) {
    case 'initialize':
      void handleInitialize(cmd);
      return;
    case 'loadGame':
      void handleLoadGame(cmd);
      return;
    case 'fetchAvInfo':
      void handleFetchAvInfo(cmd);
      return;
    case 'dispose':
      void handleDispose(cmd);
      return;
    // 以下は今回のスケルトンでは未実装(手順5以降)。UNSUPPORTED を返す。
    case 'setRunning':
    case 'updateInput':
    case 'hotSwapFdd':
    case 'serialize':
    case 'readTextScreen':
    case 'screenshot':
    case 'readMemory': {
      post({
        kind: 'response',
        generation: cmd.generation,
        requestId: cmd.requestId,
        ok: false,
        error: createCoreError(
          'UNSUPPORTED',
          `${cmd.op} はWorker経路でまだ実装していません(段階移行 手順5以降)`,
          { operation: cmd.op },
        ),
      });
      return;
    }
    default: {
      const _exhaustive: never = cmd;
      void _exhaustive;
    }
  }
};

// 起動ハンドシェイク(実測により追加): `ctx.onmessage` を登録した直後のこの時点で、
// Worker側は main からの command を受け取れる状態になっている。しかし実測では、
// main が `new Worker(...)` 直後に送った最初の command(initialize)がここまで一度も
// 届かず、応答timeoutでしか失敗が検知できないことがあった(module worker は import
// グラフの解決・フェッチに実時間がかかり、その間 main から届いたメッセージを取りこぼす
// ため。`self.onmessage` が実際にセットされた後の話ではなく、それより前に送られた
// メッセージがロストする)。そのため、起動が完了したこの時点で明示的に合図
// (WORKER_BOOT_ACK_KIND)を送り返し、main 側(src/core-proxy.ts の WorkerCoreProxy)は
// これを受け取るまで実際の postMessage を保留する形にした。
ctx.postMessage({ kind: WORKER_BOOT_ACK_KIND });
