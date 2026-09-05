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
  CORE_OPTION_UPDATE_KIND,
  INPUT_UPDATE_KIND,
  PAUSE_UPDATE_KIND,
  RETURN_FRAME_BUFFER_KIND,
  SPEED_UPDATE_KIND,
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
  /** postMessageのtransfer listに載ったArrayBufferの、detach直前の内容のコピー
   * (byteOffset順、Uint8Arrayとして保存)。detach後は元のArrayBufferから内容を読めなく
   * なるため、テストが「転送された内容が正しいか」を確認したい場合はここを見る。 */
  transferredSnapshots: Uint8Array[] = [];
  private messageListeners: AnyListener[] = [];
  private errorListeners: AnyListener[] = [];
  private messageErrorListeners: AnyListener[] = [];
  /** 既定は defaultAutoResponder。テストごとに差し替えて「以後応答しない」等を表現する。 */
  respond: (cmd: CoreCommand) => WorkerToMain[] = defaultAutoResponder;

  postMessage(message: unknown, transfer?: Transferable[]): void {
    // 実Workerのpostmessage(message, transfer)を模す: transfer listに載ったArrayBufferは
    // 呼び出し側で実際にdetachされる(structuredClone(buf, {transfer:[buf]})で、送信先へ
    // 渡す複製を作ると同時に元のbufをdetachする、というのがブラウザの実挙動)。
    // 既にdetach済みのArrayBuffer(byteLength===0)をtransfer listへ再度載せようとすると
    // ブラウザは`DataCloneError: ...already detached`を同期的に投げる。structuredCloneも
    // 同じ例外を投げるため、ここでも実際に呼んでその再現性を保つ(2026-08-31:
    // リセット復帰の欠陥のfake worker側の裏取り。src/core-proxy.tsのWorkerCoreProxy#init()
    // コメント参照)。
    for (const t of transfer ?? []) {
      if (t instanceof ArrayBuffer) {
        this.transferredSnapshots.push(new Uint8Array(t.slice(0)));
        structuredClone(t, { transfer: [t] });
      }
    }
    this.rawSent.push(message);
    const asRecord = message as { kind?: unknown };
    // 応答不要のfire-and-forget(RETURN_FRAME_BUFFER_KIND/INPUT_UPDATE_KIND/SPEED_UPDATE_KIND/
    // CORE_OPTION_UPDATE_KIND/PAUSE_UPDATE_KIND)。
    if (
      asRecord.kind === RETURN_FRAME_BUFFER_KIND ||
      asRecord.kind === INPUT_UPDATE_KIND ||
      asRecord.kind === SPEED_UPDATE_KIND ||
      asRecord.kind === CORE_OPTION_UPDATE_KIND ||
      asRecord.kind === PAUSE_UPDATE_KIND
    )
      return;
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
    case 'hotSwapFdd':
      return [{ ...base, ok: true, completedFrameNo: 0, result: { previousImage: null, mountedPath: '/game/fdd0_x.xdf' } }];
    case 'captureDirtyMedia':
      return [{ ...base, ok: true, completedFrameNo: 0, result: { captured: [] } }];
    case 'markDirty':
      return [{ ...base, ok: true, completedFrameNo: 0, result: undefined }];
    default:
      return [];
  }
}

function makeBios(): { biosIpl: Uint8Array; biosCg: Uint8Array } {
  return { biosIpl: new Uint8Array([1, 2, 3]), biosCg: new Uint8Array([4, 5, 6]) };
}

/** 最初のframe eventを模す(WorkerCoreProxy#startupSettledの境界)。'ready'ではなく
 * 'frame'を受け取って初めて起動完了とみなす実装であることをテストから明示的に叩くために使う。 */
function makeFrameEvent(generation = 0): CoreEvent {
  const snapshot: FrameSnapshot = {
    frameNo: 1,
    av: { fps: 60, sampleRate: 44100, width: 768, height: 512 },
    video: { kind: 'rgba', bytes: new ArrayBuffer(4), width: 1, height: 1 },
    audio: { chunks: [], sampleFrames: 0 },
    disk: { access: { fddReading: false, fddDrive: 0, hddAccessing: false }, dirty: { fddMask: 0, hdd: false } },
    poolMisses: 0,
    frameCostMs: 0,
  };
  return { kind: 'event', generation, event: 'frame', snapshot };
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

  it(
    '2026-08-31: リセット復帰の欠陥の回帰テスト。main.tsが同じbiosIpl/biosCg/' +
      'initialDisksの実体を使い回して2回init()を呼んでも(=2回のリセット相当)、' +
      '2回目もDataCloneErrorにならず成功する。' +
      'main.tsのbootWorkerCore()は起動のたびに新しいWorkerCoreProxyインスタンスを作るが、' +
      'biosIplBytes/biosCgBytes/slots.fdd0等.dataはmodule-levelに保持され続け、同じ' +
      'Uint8Arrayインスタンスを再度渡してくる。修正前はWorkerCoreProxy#init()内で' +
      'toOwnedArrayBuffer()(バッファ全体を覆うUint8Arrayならコピーせずbufferをそのまま' +
      '返す)を経由していたため、1回目のinit()でtransferされ実際にdetachされた' +
      'ArrayBufferを2回目でも再びtransferしようとして例外になっていた' +
      '(実機での症状: `DataCloneError: ArrayBuffer at index 0 is already detached`)。',
    async () => {
      // main.tsのbiosIplBytes/biosCgBytes/slots.fdd0.dataに相当する、複数回のinit()を
      // またいで使い回される「同じ実体」。
      const sharedBiosIpl = new Uint8Array([1, 2, 3]);
      const sharedBiosCg = new Uint8Array([4, 5, 6]);
      const sharedFdd0 = new Uint8Array([7, 8, 9, 10]);

      // 1回目の起動。
      const worker1 = new FakeWorker();
      const proxy1 = new WorkerCoreProxy({ createWorker: () => worker1 });
      await proxy1.init(sharedBiosIpl, sharedBiosCg, undefined, [
        { slot: 'fdd0', name: 'a.xdf', bytes: sharedFdd0 },
      ]);
      await proxy1.dispose();

      // main.ts側の実体(sharedBiosIpl等)はここまでで一切detachされていないこと
      // (=WorkerCoreProxy#init()がcopyArrayBuffer()でコピーしてから渡した証拠)。
      expect(sharedBiosIpl.buffer.byteLength).toBe(3);
      expect(sharedBiosCg.buffer.byteLength).toBe(3);
      expect(sharedFdd0.buffer.byteLength).toBe(4);

      // 2回目の起動(リセット相当)。同じ実体を再び渡す。新しいWorkerCoreProxy/Workerだが、
      // main.ts側の変数は使い回している点がbootWorkerCore()の実際の呼び方と一致する。
      const worker2 = new FakeWorker();
      const proxy2 = new WorkerCoreProxy({ createWorker: () => worker2 });
      await expect(
        proxy2.init(sharedBiosIpl, sharedBiosCg, undefined, [
          { slot: 'fdd0', name: 'a.xdf', bytes: sharedFdd0 },
        ]),
      ).resolves.toBeUndefined();

      // 2回目のinitializeコマンドに載ったArrayBufferは、渡した実体そのものではなく
      // 独立したコピーであること(=渡した先で毎回detachされてよいのは複製の方だけ、という
      // 「転送するのは所有権を手放してよいバッファだけ」の原則が保たれていることの確認)。
      const initCmd2 = worker2.sent.find((c) => c.op === 'initialize') as Extract<
        CoreCommand,
        { op: 'initialize' }
      >;
      expect(initCmd2.payload.biosIpl).not.toBe(sharedBiosIpl.buffer);
      // postMessage時点(detachされる直前)の内容が正しくコピーされていたこと
      // (transferredSnapshotsはFakeWorker#postMessage参照)。
      expect(worker2.transferredSnapshots).toContainEqual(sharedBiosIpl);
      expect(worker2.transferredSnapshots).toContainEqual(sharedFdd0);
      // main.ts側の実体は2回目のinit()後も無傷のまま(=3回目のリセットも同様に成立する)。
      expect(sharedBiosIpl.buffer.byteLength).toBe(3);
      expect(sharedFdd0.buffer.byteLength).toBe(4);
    },
  );

  it('手順8: hotSwapFdd/captureDirtyMedia/markDirtyがcommand/responseとして往復する(proxyの結線のみ確認。不可分性そのものはtest/worker-dirty-capture.test.ts参照)', async () => {
    const worker = new FakeWorker();
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    await proxy.init(...(Object.values(makeBios()) as [Uint8Array, Uint8Array]));

    const image = new Uint8Array([1, 2, 3]).buffer;
    await expect(
      proxy.hotSwapFdd({ drive: 0, image: { name: 'x.xdf', bytes: image } }),
    ).resolves.toEqual({ previousImage: null, mountedPath: '/game/fdd0_x.xdf' });

    await expect(proxy.captureDirtyMedia({ slots: ['fdd0', 'hdd'] })).resolves.toEqual({ captured: [] });
    await expect(proxy.markDirty({ slots: ['fdd0'] })).resolves.toBeUndefined();

    const ops = worker.sent.map((c) => c.op);
    expect(ops).toContain('hotSwapFdd');
    expect(ops).toContain('captureDirtyMedia');
    expect(ops).toContain('markDirty');
    const captureCmd = worker.sent.find((c) => c.op === 'captureDirtyMedia');
    expect(captureCmd && 'payload' in captureCmd ? captureCmd.payload : null).toEqual({ slots: ['fdd0', 'hdd'] });
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

  it('世代が異なるresponse/eventは無視する(response、およびframe event)', async () => {
    const worker = new FakeWorker();
    worker.respond = () => []; // 自動応答を止め、手動でresponseを送る
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    const { biosIpl, biosCg } = makeBios();

    const received: CoreEvent[] = [];
    proxy.setEventHandler((event) => received.push(event));

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

    // 手順9: 旧世代からの遅延frame eventも同じ理由で破棄されるはず(responseだけでなく
    // event全般がgeneration不一致で捨てられることを確認する。実際の再生成は
    // bootWorkerCore()がproxyインスタンスごと作り直す形で行われる=このテストのように
    // 同一proxy内でgenerationがずれることは起きないが、フィルタ自体はresponse/eventで
    // 共通のため、ここで一括して確認しておく)。
    const staleSnapshot: FrameSnapshot = {
      frameNo: 999,
      av: { fps: 60, sampleRate: 44100, width: 768, height: 512 },
      video: { kind: 'rgba', bytes: new ArrayBuffer(4), width: 1, height: 1 },
      audio: { chunks: [], sampleFrames: 0 },
      disk: { access: { fddReading: false, fddDrive: 0, hddAccessing: false }, dirty: { fddMask: 0, hdd: false } },
      poolMisses: 0,
      frameCostMs: 0,
    };
    worker.emit({ kind: 'event', generation: sentCmd.generation + 1, event: 'frame', snapshot: staleSnapshot });
    expect(received.some((e) => e.event === 'frame')).toBe(false); // 旧世代のframeは届かない

    worker.emit({ kind: 'event', generation: sentCmd.generation, event: 'frame', snapshot: staleSnapshot });
    expect(received.some((e) => e.event === 'frame')).toBe(true); // 正しい世代なら届く
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
    worker.emit(makeFrameEvent()); // 起動完了(startupSettled=true)にしてから通常timeoutを確認する。

    const p = proxy.fetchAvInfo();
    await expect(p).rejects.toMatchObject({ coreError: { code: 'WORKER_FAILURE' } });
    expect(worker.terminated).toBe(true);
  });

  describe('起動中(最初のframe eventを受け取るまで)は長い方のtimeout(startupResponseTimeoutMs)を使う', () => {
    // 実測(2026-09-04): まっさらなプロファイルではコアが最初のフレームを出すまで約22秒
    // かかる。固定10秒だとその途中でコアを異常終了扱いにして復帰できなくなる(実測)。
    // f0642f1で「initializeの応答が返るまで」を境界にしたが、実機で効いていないことを
    // 実測した(probe-scsi-iocs.mjs): workerStats().frameNoが+28sまで0のままなのに
    // 「応答timeout(10000ms): readTextScreen」が出た。initializeの応答は先に返っており、
    // 重い処理はその後にある。そのため境界を「最初のframe eventを受け取ったとき」に
    // 変更した。無タイマにはせず、起動中は長い方(startupResponseTimeoutMs)のtimeoutを
    // 張る(src/core-proxy.ts の WorkerCoreProxy#startupSettled 参照)。

    it('起動中(最初のframe受信前)に投げたコマンドは、通常timeout相当の時間を過ぎてもWORKER_FAILUREにならない', async () => {
      const worker = new FakeWorker();
      // initializeだけ自動応答('ready'は届くが'frame'は届かない=起動中のまま)、以後は応答しない。
      worker.respond = (cmd) => (cmd.op === 'initialize' ? defaultAutoResponder(cmd) : []);
      const proxy = new WorkerCoreProxy({
        createWorker: () => worker,
        responseTimeoutMs: 20,
        startupResponseTimeoutMs: 10_000, // 通常timeout(20ms)を大きく超える値にしておく
      });
      const { biosIpl, biosCg } = makeBios();

      const failures: string[] = [];
      proxy.setFailureHandler((message) => failures.push(message));

      await proxy.init(biosIpl, biosCg); // 'ready'のみ届く。frameはまだ=startupSettled===false
      const p = proxy.fetchAvInfo();
      let pSettled = false;
      void p.then(
        () => (pSettled = true),
        () => (pSettled = true),
      );

      // responseTimeoutMs(20ms)を大きく超えて待っても、startupResponseTimeoutMs(10s)には
      // 遠く及ばないため未解決のまま(=偽タイマならぬ実タイマで通常timeout分だけ経過させても
      // 異常終了しない)。
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(pSettled).toBe(false);
      expect(worker.terminated).toBe(false);
      expect(failures).toHaveLength(0);
    });

    it('陽性対照: 最初のframeを受け取ったあとは従来どおり、応答が無いコマンドは通常timeoutでWORKER_FAILUREになる', async () => {
      const worker = new FakeWorker();
      worker.respond = (cmd) => (cmd.op === 'initialize' ? defaultAutoResponder(cmd) : []);
      const proxy = new WorkerCoreProxy({ createWorker: () => worker, responseTimeoutMs: 20 });
      const { biosIpl, biosCg } = makeBios();
      await proxy.init(biosIpl, biosCg);
      worker.emit(makeFrameEvent()); // 最初のframeを受け取り起動完了(startupSettled=true)

      const p = proxy.fetchAvInfo();
      await expect(p).rejects.toMatchObject({ coreError: { code: 'WORKER_FAILURE' } });
      expect(worker.terminated).toBe(true);
    });

    it('起動中に投げてまだ応答が無いコマンドは、最初のframeを受け取った時点からタイマが張られ、そこから通常timeout時間が過ぎるとWORKER_FAILUREになる', async () => {
      const worker = new FakeWorker();
      // initializeだけ自動応答('ready'のみ)し、以後は一切応答しない。
      worker.respond = (cmd) => (cmd.op === 'initialize' ? defaultAutoResponder(cmd) : []);
      const proxy = new WorkerCoreProxy({
        createWorker: () => worker,
        responseTimeoutMs: 30,
        startupResponseTimeoutMs: 10_000,
      });
      const { biosIpl, biosCg } = makeBios();

      await proxy.init(biosIpl, biosCg);
      // まだframeを受け取っていない(=startupSettled===falseの)うちに投げる。
      const p = proxy.fetchAvInfo();

      worker.emit(makeFrameEvent()); // ここでstartupSettled=trueになり、pへ通常timeoutが張られる

      // タイマが張られた直後は、まだ余裕があるので生きている。
      let pSettled = false;
      void p.then(
        () => (pSettled = true),
        () => (pSettled = true),
      );
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(pSettled).toBe(false);

      // frame受信時点から responseTimeoutMs(30ms) を過ぎるとWORKER_FAILUREになる。
      await expect(p).rejects.toMatchObject({ coreError: { code: 'WORKER_FAILURE' } });
      expect(worker.terminated).toBe(true);
    });

    it('起動が永久に終わらない(frameが一度も来ない)場合、startupResponseTimeoutMsを過ぎるとWORKER_FAILUREになる', async () => {
      const worker = new FakeWorker();
      worker.respond = () => []; // initializeを含め一切自動応答しない(=起動が永久に終わらない)
      const proxy = new WorkerCoreProxy({
        createWorker: () => worker,
        responseTimeoutMs: 10_000, // 通常timeoutは大きくしておき、こちらでは満了しないようにする
        startupResponseTimeoutMs: 20,
      });
      const { biosIpl, biosCg } = makeBios();

      const failures: string[] = [];
      proxy.setFailureHandler((message) => failures.push(message));

      const initPromise = proxy.init(biosIpl, biosCg);
      await expect(initPromise).rejects.toMatchObject({ coreError: { code: 'WORKER_FAILURE' } });
      expect(worker.terminated).toBe(true);
      expect(failures).toHaveLength(1);
    });
  });

  it('手順9: setFailureHandlerはpendingなcommandが無くても呼ばれる(error/messageerror/timeout/fatal)', async () => {
    // 「たまたま呼び出し中のcommandがあれば、そのcatch節でしか利用者に伝わらない」という
    // 抜けを塞いだ通知経路(docs/STORAGE-SCSI.md「ワーカー移行 手順9」参照)。
    // frame event配信中などpendingが空の状態でWorkerが壊れても必ず1回呼ばれることを確認する。
    for (const trigger of ['error', 'messageerror', 'timeout', 'fatal'] as const) {
      const worker = new FakeWorker();
      const proxy = new WorkerCoreProxy({ createWorker: () => worker, responseTimeoutMs: 20 });
      const { biosIpl, biosCg } = makeBios();
      await proxy.init(biosIpl, biosCg);
      worker.emit(makeFrameEvent()); // 起動完了(startupSettled=true)にして通常timeoutで検査する

      const failures: string[] = [];
      proxy.setFailureHandler((message) => failures.push(message));

      // ここではあえて何もcommandを呼ばない(pendingが空の状態で失敗させる)。
      switch (trigger) {
        case 'error':
          worker.emitError();
          break;
        case 'messageerror':
          worker.emitMessageError();
          break;
        case 'timeout':
          worker.respond = () => []; // 以後応答しない
          // pendingを1件作ってからtimeoutさせる。rejectはWORKER_FAILUREになる想定どおりなので
          // ここで拾っておき、unhandled rejectionにしない。
          await expect(proxy.fetchAvInfo()).rejects.toMatchObject({ coreError: { code: 'WORKER_FAILURE' } });
          break;
        case 'fatal':
          worker.emit({
            kind: 'event',
            generation: 0,
            event: 'fatal',
            error: { code: 'WORKER_FAILURE', message: 'handler内例外' },
          });
          break;
      }

      expect(failures, `trigger=${trigger}`).toHaveLength(1);
    }
  });

  it('手順9: setFailureHandlerはerror/messageerrorが立て続けに来ても1回しか呼ばれない(二重処理防止)', async () => {
    const worker = new FakeWorker();
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    const { biosIpl, biosCg } = makeBios();
    await proxy.init(biosIpl, biosCg);

    const failures: string[] = [];
    proxy.setFailureHandler((message) => failures.push(message));

    worker.emitError();
    worker.emitMessageError();
    worker.emitError();

    expect(failures).toHaveLength(1);
  });

  it('手順9: fatal eventはeventHandlerへは転送されずsetFailureHandler側にのみ通知される', async () => {
    // src/core-proxy.tsのhandleMessage()はfatalをhandleWorkerFailure()へ横取りし、
    // 通常のevent配信(setEventHandler)には流さない。main.ts側は以前ここに
    // event.event === 'fatal' の死んだ分岐を持っていた(手順9で発見、setFailureHandlerへ一本化)。
    const worker = new FakeWorker();
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    const { biosIpl, biosCg } = makeBios();

    const received: CoreEvent[] = [];
    proxy.setEventHandler((event) => received.push(event));
    const failures: string[] = [];
    proxy.setFailureHandler((message) => failures.push(message));

    await proxy.init(biosIpl, biosCg);
    worker.emit({
      kind: 'event',
      generation: 0,
      event: 'fatal',
      error: { code: 'WORKER_FAILURE', message: 'boom' },
    });

    expect(received.some((e) => e.event === 'fatal')).toBe(false);
    expect(failures).toHaveLength(1);
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

  it('手順9: setSpeedMultiplier()はgeneration/requestIdを持たない一方向メッセージを送る(応答を待たない)', async () => {
    // コーディネータ指摘への対応: 「速度ボタンがWorker経路で効かないのに効いたように見える」
    // 欠陥を修正した際に追加。sendInput/sendMouseTrackと同じfire-and-forgetの枠組み。
    const worker = new FakeWorker();
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    const { biosIpl, biosCg } = makeBios();
    await proxy.init(biosIpl, biosCg);

    proxy.setSpeedMultiplier(2);

    expect(worker.rawSent).toContainEqual({ kind: SPEED_UPDATE_KIND, multiplier: 2 });
    expect(worker.sent.some((c) => (c as unknown as { kind: unknown }).kind === SPEED_UPDATE_KIND)).toBe(false);
  });

  it('手順9: dispose後にsetSpeedMultiplier()を呼んでも何も送らない(fire-and-forgetの安全側。sendInputと同じ規約)', async () => {
    const worker = new FakeWorker();
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    const { biosIpl, biosCg } = makeBios();
    await proxy.init(biosIpl, biosCg);
    await proxy.dispose();

    const rawSentCountBefore = worker.rawSent.length;
    proxy.setSpeedMultiplier(2);
    expect(worker.rawSent.length).toBe(rawSentCountBefore);
  });

  it('呼び出し元指摘の是正(2026-09-05): setPaused()はgeneration/requestIdを持たない一方向メッセージを送る(応答を待たない)', async () => {
    // ポーズが既定経路のloop()早期returnで実現されておりWorker経路にはprotocolが無かった
    // 欠陥の是正。sendMouseTrack/setSpeedMultiplierと同じfire-and-forgetの枠組み。
    const worker = new FakeWorker();
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    const { biosIpl, biosCg } = makeBios();
    await proxy.init(biosIpl, biosCg);

    proxy.setPaused(true);

    expect(worker.rawSent).toContainEqual({ kind: PAUSE_UPDATE_KIND, update: { paused: true } });
    expect(worker.sent.some((c) => (c as unknown as { kind: unknown }).kind === PAUSE_UPDATE_KIND)).toBe(false);
  });

  it('呼び出し元指摘の是正(2026-09-05): dispose後にsetPaused()を呼んでも何も送らない(fire-and-forgetの安全側)', async () => {
    const worker = new FakeWorker();
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    const { biosIpl, biosCg } = makeBios();
    await proxy.init(biosIpl, biosCg);
    await proxy.dispose();

    const rawSentCountBefore = worker.rawSent.length;
    proxy.setPaused(true);
    expect(worker.rawSent.length).toBe(rawSentCountBefore);
  });

  it('この是正(コアオプションの走行中更新): setCoreOptionLive()はgeneration/requestIdを持たない一方向メッセージを送る(応答を待たない)', async () => {
    // 呼び出し元指摘への対応: cfgCpuSpeedのchangeハンドラ・∞MHzの自動クロック調整が
    // Worker経路では丸ごと無反応になっていた欠陥の是正。setSpeedMultiplier()と同じ
    // fire-and-forgetの枠組み。
    const worker = new FakeWorker();
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    const { biosIpl, biosCg } = makeBios();
    await proxy.init(biosIpl, biosCg);

    proxy.setCoreOptionLive('px68k_cpuspeed', '25Mhz');

    expect(worker.rawSent).toContainEqual({
      kind: CORE_OPTION_UPDATE_KIND,
      key: 'px68k_cpuspeed',
      value: '25Mhz',
    });
    // command/responseの往復には乗らない(sentに積まれるのはcommandだけ)。
    expect(
      worker.sent.some((c) => (c as unknown as { kind: unknown }).kind === CORE_OPTION_UPDATE_KIND),
    ).toBe(false);
  });

  it('この是正: dispose後にsetCoreOptionLive()を呼んでも何も送らない(fire-and-forgetの安全側。setSpeedMultiplierと同じ規約)', async () => {
    const worker = new FakeWorker();
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    const { biosIpl, biosCg } = makeBios();
    await proxy.init(biosIpl, biosCg);
    await proxy.dispose();

    const rawSentCountBefore = worker.rawSent.length;
    proxy.setCoreOptionLive('px68k_cpuspeed', '25Mhz');
    expect(worker.rawSent.length).toBe(rawSentCountBefore);
  });

  it('手順9: init()にoptionsを渡すとinitializeコマンドのpayload.optionsとして送られる(px68k_cpuspeed等)', async () => {
    // コーディネータ指摘への対応: src/core-worker.tsのhandleInitialize()はpayload.optionsを
    // 読んでsetCoreOption()を回す実装が既にあったが、呼び出し元(ここ)が一度もoptionsを
    // 渡していなかったため常に未設定だった欠陥の修正。
    const worker = new FakeWorker();
    const proxy = new WorkerCoreProxy({ createWorker: () => worker });
    const { biosIpl, biosCg } = makeBios();

    await proxy.init(biosIpl, biosCg, undefined, undefined, {
      px68k_cpuspeed: '16MHz(標準)',
      px68k_ramsize: '2MB(標準)',
      px68k_no_wait_mode: 'enabled',
    });

    const initCmd = worker.sent.find((c) => c.op === 'initialize');
    expect(initCmd && 'payload' in initCmd ? (initCmd.payload as { options?: unknown }).options : null).toEqual({
      px68k_cpuspeed: '16MHz(標準)',
      px68k_ramsize: '2MB(標準)',
      px68k_no_wait_mode: 'enabled',
    });
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
      frameCostMs: 0,
    };
    worker.emit({ kind: 'event', generation: 0, event: 'frame', snapshot });

    const frameEvents = received.filter((e) => e.event === 'frame');
    expect(frameEvents).toHaveLength(1);
    expect((frameEvents[0] as Extract<CoreEvent, { event: 'frame' }>).snapshot.poolMisses).toBe(2);
  });
});
