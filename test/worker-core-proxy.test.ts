// WorkerCoreProxy (src/core-proxy.ts) のテスト。
// 実 Worker の代わりに WorkerLike を満たす FakeWorker を使い、
// - command/response の往復
// - 世代(generation)が違う response/event を無視すること
// - Worker の異常終了(error/messageerror)時、その世代の未完了 Promise が全て reject されること
// - 応答timeoutが WORKER_FAILURE になること
// を確認する。故障注入(陽性対照)は本ファイルではなく作業報告に記録した手順で
// 一時的にソースを壊して実施した(このファイル自体は正常経路の検査のみを持つ)。
import { describe, expect, it } from 'vitest';
import {
  INPUT_UPDATE_KIND,
  RETURN_FRAME_BUFFER_KIND,
  WORKER_BOOT_ACK_KIND,
  type CoreCommand,
  type CoreEvent,
  type FrameSnapshot,
  type InputUpdate,
  type WorkerToMain,
} from '../src/core-protocol';
import { WorkerCoreProxy, type WorkerLike } from '../src/core-proxy';
import type { AvInfo } from '../src/libretro-host';
import type { TextScreenDump } from '../src/text-screen';

type AnyListener = (ev: unknown) => void;

/** WorkerLike を満たす fake。postMessage されたcommandを記録し、respond() が返した
 * WorkerToMainを『Workerからの応答』として即座にmessageリスナーへ配る。 */
class FakeWorker implements WorkerLike {
  sent: CoreCommand[] = [];
  /** returnFrameBuffer 等、generation/requestId を持たないfire-and-forgetメッセージの記録
   * (RETURN_FRAME_BUFFER_KINDのテスト用)。 */
  rawSent: unknown[] = [];
  terminated = false;
  private messageListeners: AnyListener[] = [];
  private errorListeners: AnyListener[] = [];
  private messageErrorListeners: AnyListener[] = [];
  /** 既定は defaultAutoResponder。テストごとに差し替えて「以後応答しない」等を表現する。 */
  respond: (cmd: CoreCommand) => WorkerToMain[] = defaultAutoResponder;

  postMessage(message: unknown): void {
    this.rawSent.push(message);
    const asRecord = message as { kind?: unknown };
    // 応答不要のfire-and-forget(RETURN_FRAME_BUFFER_KIND/INPUT_UPDATE_KIND)。
    if (asRecord.kind === RETURN_FRAME_BUFFER_KIND || asRecord.kind === INPUT_UPDATE_KIND) return;
    const cmd = message as CoreCommand;
    this.sent.push(cmd);
    for (const out of this.respond(cmd)) this.emit(out);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: 'message' | 'error' | 'messageerror', listener: AnyListener): void {
    if (type === 'message') {
      this.messageListeners.push(listener);
      // 実Workerの起動ハンドシェイク(src/core-worker.ts が onmessage 登録直後に送る
      // WORKER_BOOT_ACK_KIND)を模す。実装との対応: FakeWorkerには実際のロード遅延が
      // 無いので、message リスナー登録(=WorkerCoreProxyのコンストラクタ完了)の直後に
      // 即座に返す。これが無いと WorkerCoreProxy 側の preBootQueue に command が
      // 積まれたまま実際には送信されず、全テストが応答timeoutになる。
      listener({ data: { kind: WORKER_BOOT_ACK_KIND } });
    } else if (type === 'error') this.errorListeners.push(listener);
    else this.messageErrorListeners.push(listener);
  }

  /** Worker からの response/event をテストから明示的に送る(世代不一致テスト等で使う)。 */
  emit(data: WorkerToMain): void {
    for (const l of this.messageListeners) l({ data });
  }

  emitError(ev: unknown = { message: 'boom' }): void {
    for (const l of this.errorListeners) l(ev);
  }

  emitMessageError(ev: unknown = { message: 'bad clone' }): void {
    for (const l of this.messageErrorListeners) l(ev);
  }
}

const AV_INFO: AvInfo = {
  baseWidth: 768,
  baseHeight: 512,
  maxWidth: 768,
  maxHeight: 512,
  aspectRatio: 1.5,
  fps: 55.5,
  sampleRate: 48000,
};

const TEXT_SCREEN_STUB: TextScreenDump = {
  available: true,
  lines: ['A>'],
  diagnostics: {
    columns: 2,
    rows: 1,
    nonEmptyCells: 2,
    matchedCells: 2,
    unknownCells: 0,
    coverage: 1,
    nonEmptyPlaneCells: [2, 0, 0, 0],
    kanjiFontAvailable: false,
  },
};

function defaultAutoResponder(cmd: CoreCommand): WorkerToMain[] {
  const base = { kind: 'response' as const, generation: cmd.generation, requestId: cmd.requestId };
  switch (cmd.op) {
    case 'initialize':
      return [
        { ...base, ok: true, completedFrameNo: 0, result: undefined },
        { kind: 'event', generation: cmd.generation, event: 'ready', avInfo: AV_INFO },
      ];
    case 'loadGame':
      return [{ ...base, ok: true, completedFrameNo: 0, result: true }];
    case 'fetchAvInfo':
      return [{ ...base, ok: true, completedFrameNo: 0, result: AV_INFO }];
    case 'dispose':
      return [{ ...base, ok: true, completedFrameNo: 0, result: undefined }];
    case 'setRunning':
      return [{ ...base, ok: true, completedFrameNo: 0, result: undefined }];
    case 'readTextScreen':
      return [{ ...base, ok: true, completedFrameNo: 0, result: TEXT_SCREEN_STUB }];
    default:
      return [];
  }
}

function makeBios(): { biosIpl: Uint8Array; biosCg: Uint8Array } {
  return { biosIpl: new Uint8Array([1, 2, 3]), biosCg: new Uint8Array([4, 5, 6]) };
}

describe('WorkerCoreProxy', () => {
  it('command/response が往復する(initialize→ready/loadGame/fetchAvInfo/dispose)', async () => {
    const worker = new FakeWorker();
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    const { biosIpl, biosCg } = makeBios();

    await proxy.init(biosIpl, biosCg);
    await expect(proxy.loadGame('/game/boot.cmd')).resolves.toBe(true);
    await expect(proxy.fetchAvInfo()).resolves.toEqual(AV_INFO);
    await proxy.dispose();

    expect(worker.sent.map((c) => c.op)).toEqual(['initialize', 'loadGame', 'fetchAvInfo', 'dispose']);
    expect(worker.terminated).toBe(true);
  });

  it('未実装のop(setCoreOption等)はUNSUPPORTEDでrejectする(手順5以降の宿題)', async () => {
    const worker = new FakeWorker();
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    await proxy.init(...(Object.values(makeBios()) as [Uint8Array, Uint8Array]));

    await expect(proxy.setCoreOption('k', 'v')).rejects.toMatchObject({
      coreError: { code: 'UNSUPPORTED' },
    });
    await expect(proxy.serialize()).rejects.toMatchObject({ coreError: { code: 'UNSUPPORTED' } });
    // 未実装の呼び出しはWorkerへ何もpostMessageしない(commandを送らずに即rejectする実装のため)。
    expect(worker.sent.some((c) => c.op === 'setCoreOption')).toBe(false);
  });

  it('世代が異なるresponse/eventは無視する', async () => {
    const worker = new FakeWorker();
    worker.respond = () => []; // 自動応答を止め、手動でresponseを送る
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    const { biosIpl, biosCg } = makeBios();

    const initPromise = proxy.init(biosIpl, biosCg);
    const sentCmd = worker.sent[0];
    expect(sentCmd.op).toBe('initialize');

    // 別世代からの遅延応答(旧世代の生き残り)を模す。無視されるはず。
    worker.emit({
      kind: 'response',
      generation: sentCmd.generation + 1,
      requestId: sentCmd.requestId,
      ok: true,
      completedFrameNo: 0,
      result: undefined,
    });

    let settled = false;
    void initPromise.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false); // 別世代の応答は無視され、まだ未解決のはず

    // 正しい世代のresponseなら解決する。
    worker.emit({
      kind: 'response',
      generation: sentCmd.generation,
      requestId: sentCmd.requestId,
      ok: true,
      completedFrameNo: 0,
      result: undefined,
    });
    await initPromise;
  });

  it('Workerの異常終了(error event)でその世代の未完了Promiseが全てrejectされる', async () => {
    const worker = new FakeWorker();
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    const { biosIpl, biosCg } = makeBios();
    await proxy.init(biosIpl, biosCg);

    worker.respond = () => []; // 以後応答しない
    const p1 = proxy.loadGame('/a');
    const p2 = proxy.fetchAvInfo();

    worker.emitError();

    await expect(p1).rejects.toMatchObject({ coreError: { code: 'WORKER_FAILURE' } });
    await expect(p2).rejects.toMatchObject({ coreError: { code: 'WORKER_FAILURE' } });
    expect(worker.terminated).toBe(true);

    // 異常終了後の新規呼び出しも即rejectされる(自動再生成はスコープ外)。
    await expect(proxy.loadGame('/b')).rejects.toMatchObject({ coreError: { code: 'WORKER_FAILURE' } });
  });

  it('messageerrorでもその世代の未完了Promiseが全てrejectされる', async () => {
    const worker = new FakeWorker();
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    const { biosIpl, biosCg } = makeBios();
    await proxy.init(biosIpl, biosCg);

    worker.respond = () => [];
    const p = proxy.fetchAvInfo();
    worker.emitMessageError();

    await expect(p).rejects.toMatchObject({ coreError: { code: 'WORKER_FAILURE' } });
    expect(worker.terminated).toBe(true);
  });

  it('応答timeoutがWORKER_FAILUREになる', async () => {
    const worker = new FakeWorker();
    worker.respond = (cmd) => (cmd.op === 'initialize' ? defaultAutoResponder(cmd) : []);
    const proxy = new WorkerCoreProxy({ createWorker: () => worker, responseTimeoutMs: 20 });
    const { biosIpl, biosCg } = makeBios();
    await proxy.init(biosIpl, biosCg);

    const p = proxy.fetchAvInfo();
    await expect(p).rejects.toMatchObject({ coreError: { code: 'WORKER_FAILURE' } });
    expect(worker.terminated).toBe(true);
  });

  it('dispose()はcommandを送りWorkerをterminateする', async () => {
    const worker = new FakeWorker();
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    const { biosIpl, biosCg } = makeBios();
    await proxy.init(biosIpl, biosCg);

    await proxy.dispose();
    expect(worker.sent.at(-1)?.op).toBe('dispose');
    expect(worker.terminated).toBe(true);

    // dispose後の呼び出しはINVALID_STATEでrejectされる。
    await expect(proxy.fetchAvInfo()).rejects.toMatchObject({ coreError: { code: 'INVALID_STATE' } });
  });

  it('readTextScreen()はcommandを送りWorker側の結果を返す(手順5・7でscreenText()が使えるようになった分)', async () => {
    const worker = new FakeWorker();
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    const { biosIpl, biosCg } = makeBios();
    await proxy.init(biosIpl, biosCg);

    await expect(proxy.readTextScreen()).resolves.toEqual(TEXT_SCREEN_STUB);
    expect(worker.sent.some((c) => c.op === 'readTextScreen')).toBe(true);
  });

  it('setRunning()は駆動ループの開始/停止commandを送る(手順7固有のメソッド)', async () => {
    const worker = new FakeWorker();
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    const { biosIpl, biosCg } = makeBios();
    await proxy.init(biosIpl, biosCg);

    await proxy.setRunning(true);
    await proxy.setRunning(false);
    const setRunningCmds = worker.sent.filter((c) => c.op === 'setRunning');
    expect(setRunningCmds.map((c) => (c as Extract<CoreCommand, { op: 'setRunning' }>).payload.running)).toEqual([
      true,
      false,
    ]);
  });

  it('returnFrameBuffer()はgeneration/requestIdを持たない一方向メッセージをtransferで送る(応答を待たない)', async () => {
    const worker = new FakeWorker();
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    const { biosIpl, biosCg } = makeBios();
    await proxy.init(biosIpl, biosCg);

    const buffer = new ArrayBuffer(64);
    proxy.returnFrameBuffer(buffer);

    expect(worker.rawSent).toContainEqual({ kind: RETURN_FRAME_BUFFER_KIND, buffer });
    // command/responseの往復には乗らない(sentに積まれるのはcommandだけ)。
    expect(worker.sent.some((c) => (c as unknown as { kind: unknown }).kind === RETURN_FRAME_BUFFER_KIND)).toBe(
      false,
    );
  });

  it('sendInput()はgeneration/requestIdを持たない一方向メッセージを送る(応答を待たない。決定7)', async () => {
    const worker = new FakeWorker();
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    const { biosIpl, biosCg } = makeBios();
    await proxy.init(biosIpl, biosCg);

    const update: InputUpdate = {
      keys: [1, 2],
      pads: [3, 0],
      mouseButtons: { left: true, right: false },
      mouseDelta: { dx: 5, dy: -2 },
      inputGeneration: 0,
      keyMakes: [7],
    };
    proxy.sendInput(update);

    expect(worker.rawSent).toContainEqual({ kind: INPUT_UPDATE_KIND, update });
    // command/responseの往復には乗らない(sentに積まれるのはcommandだけ)。
    expect(worker.sent.some((c) => (c as unknown as { kind: unknown }).kind === INPUT_UPDATE_KIND)).toBe(false);
  });

  it('dispose後にsendInput()を呼んでも何も送らない(fire-and-forgetの安全側)', async () => {
    const worker = new FakeWorker();
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    const { biosIpl, biosCg } = makeBios();
    await proxy.init(biosIpl, biosCg);
    await proxy.dispose();

    const rawSentCountBeforeSendInput = worker.rawSent.length;
    proxy.sendInput({
      keys: [],
      pads: [0, 0],
      mouseButtons: { left: false, right: false },
      mouseDelta: { dx: 0, dy: 0 },
      inputGeneration: 0,
      keyMakes: [],
    });
    expect(worker.rawSent.length).toBe(rawSentCountBeforeSendInput);
  });

  it('setEventHandler()で登録した購読者へframe/ready eventがそのまま転送される(手順5・7の橋渡し)', async () => {
    const worker = new FakeWorker();
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    const { biosIpl, biosCg } = makeBios();

    const received: CoreEvent[] = [];
    proxy.setEventHandler((event) => received.push(event));

    await proxy.init(biosIpl, biosCg);
    // init()完了時点で 'ready' event が既に届いているはず(defaultAutoResponderが返す)。
    expect(received.some((e) => e.event === 'ready')).toBe(true);

    const snapshot: FrameSnapshot = {
      frameNo: 1,
      av: { fps: 60, sampleRate: 44100, width: 768, height: 512 },
      video: { kind: 'rgba', bytes: new ArrayBuffer(768 * 512 * 4), width: 768, height: 512 },
      audio: { chunks: [], sampleFrames: 0 },
      disk: { access: { fddReading: true, fddDrive: 0, hddAccessing: false }, dirty: { fddMask: 0, hdd: false } },
      poolMisses: 2,
    };
    worker.emit({ kind: 'event', generation: 0, event: 'frame', snapshot });

    const frameEvents = received.filter((e) => e.event === 'frame');
    expect(frameEvents).toHaveLength(1);
    expect((frameEvents[0] as Extract<CoreEvent, { event: 'frame' }>).snapshot.poolMisses).toBe(2);
  });
});
