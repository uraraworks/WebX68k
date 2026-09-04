// src/serial-worker-bridge.ts のテスト (Worker経路のシリアル配線の穴の是正)。
//
// 検証する5項目:
// 1. 背圧: ミラーがしきい値以上のとき onData 相当(routeSerialReceive)が0を返すこと。
//    しきい値未満なら受理してミラーが増えること。
// 2. 順序: 複数回に分けて送ったバイト列が、Worker側のキュー(SerialRxQueue)で
//    送信順に並ぶこと(部分受理を挟んでも順序が保たれること)。
// 3. キュー長の報告でミラーが下がり、notifyReceiveCapacity() 相当のフラグが立つこと。
// 4. 切断でキューとミラーがクリアされること(前セッションのデータが残らない)。
// 5. 陽性対照: 既定経路(メインスレッド)の挙動が変わっていないこと
//    (workerMode=false では判定を経由せず hostReceive がそのまま呼ばれ、戻り値も
//    そのまま返ること)。
import { describe, expect, it } from 'vitest';
import {
  applySerialRxQueueReport,
  routeSerialReceive,
  SERIAL_RX_BACKPRESSURE_THRESHOLD_BYTES,
  SerialRxQueue,
  shouldApplySerialRxBackpressure,
} from '../src/serial-worker-bridge';

describe('shouldApplySerialRxBackpressure / routeSerialReceive (項目1)', () => {
  it('ミラーがしきい値以上なら0を返し、Workerへは送らない', () => {
    expect(shouldApplySerialRxBackpressure(SERIAL_RX_BACKPRESSURE_THRESHOLD_BYTES)).toBe(true);
    expect(shouldApplySerialRxBackpressure(SERIAL_RX_BACKPRESSURE_THRESHOLD_BYTES + 1)).toBe(true);

    const bytes = new Uint8Array([1, 2, 3]);
    let sent: Uint8Array | null = null;
    const result = routeSerialReceive(
      bytes,
      true,
      SERIAL_RX_BACKPRESSURE_THRESHOLD_BYTES,
      () => bytes.length,
      (b) => {
        sent = b;
      },
    );
    expect(result.accepted).toBe(0);
    expect(result.mirrorDelta).toBe(0);
    expect(sent).toBeNull();
  });

  it('ミラーがしきい値未満なら全量受理し、Workerへ送ってミラーぶんのdeltaを返す', () => {
    expect(shouldApplySerialRxBackpressure(SERIAL_RX_BACKPRESSURE_THRESHOLD_BYTES - 1)).toBe(false);

    const bytes = new Uint8Array([9, 8, 7, 6]);
    let sent: Uint8Array | null = null;
    const result = routeSerialReceive(
      bytes,
      true,
      0,
      () => {
        throw new Error('Worker経路ではhostReceiveを呼んではいけない');
      },
      (b) => {
        sent = b;
      },
    );
    expect(result.accepted).toBe(4);
    expect(result.mirrorDelta).toBe(4);
    expect(sent).toBe(bytes);
  });
});

describe('SerialRxQueue (項目2: 順序)', () => {
  it('複数回に分けてenqueueしたバイト列が送信順に並ぶ(部分受理を挟んでも順序が保たれる)', () => {
    const queue = new SerialRxQueue();
    queue.enqueue(new Uint8Array([1, 2, 3]));
    queue.enqueue(new Uint8Array([4, 5]));
    queue.enqueue(new Uint8Array([6]));
    expect(queue.queueLength).toBe(6);

    const consumed: number[] = [];
    // 1回目のtick: コア側FIFOが2バイトしか受理できない状況を再現する。
    let capacity = 2;
    queue.drain((chunk) => {
      const accept = Math.min(capacity, chunk.length);
      capacity -= accept;
      consumed.push(...chunk.subarray(0, accept));
      return accept;
    });
    expect(consumed).toEqual([1, 2]);
    expect(queue.queueLength).toBe(4); // [3] + [4,5] + [6] の残り

    // 2回目のtick: 今度は十分な容量がある。
    capacity = 100;
    queue.drain((chunk) => {
      const accept = Math.min(capacity, chunk.length);
      capacity -= accept;
      consumed.push(...chunk.subarray(0, accept));
      return accept;
    });
    expect(consumed).toEqual([1, 2, 3, 4, 5, 6]);
    expect(queue.queueLength).toBe(0);
  });

  it('受理0件のときはそこで打ち切り、以降のチャンクを先に処理しない', () => {
    const queue = new SerialRxQueue();
    queue.enqueue(new Uint8Array([1, 2]));
    queue.enqueue(new Uint8Array([3, 4]));
    const calls: Uint8Array[] = [];
    queue.drain((chunk) => {
      calls.push(chunk);
      return 0; // コア側FIFOが満杯で何も受理できない。
    });
    expect(calls.length).toBe(1); // 先頭チャンクだけ試し、2番目には進まない。
    expect(queue.queueLength).toBe(4); // 何も減っていない。
  });
});

describe('applySerialRxQueueReport (項目3)', () => {
  it('報告されたキュー長がミラーより小さければdecreased=trueになる', () => {
    const result = applySerialRxQueueReport(100, 40);
    expect(result.mirror).toBe(40);
    expect(result.decreased).toBe(true);
  });

  it('報告されたキュー長がミラー以上ならdecreased=falseになる(notifyしない)', () => {
    const result = applySerialRxQueueReport(40, 40);
    expect(result.decreased).toBe(false);
    const grown = applySerialRxQueueReport(40, 100);
    expect(grown.decreased).toBe(false);
    expect(grown.mirror).toBe(100);
  });
});

describe('切断・リセット (項目4)', () => {
  it('SerialRxQueue#reset()でキューが空になり、前セッションのデータが残らない', () => {
    const queue = new SerialRxQueue();
    queue.enqueue(new Uint8Array([1, 2, 3]));
    expect(queue.queueLength).toBe(3);
    queue.reset();
    expect(queue.queueLength).toBe(0);
    const calls: Uint8Array[] = [];
    queue.drain((chunk) => {
      calls.push(chunk);
      return chunk.length;
    });
    expect(calls.length).toBe(0);
  });

  it('main側のミラーもリセット後は0から再開し、直後のreceiveがしきい値に阻まれない', () => {
    // リセット前: しきい値に張り付いていた状態を再現。
    expect(shouldApplySerialRxBackpressure(SERIAL_RX_BACKPRESSURE_THRESHOLD_BYTES)).toBe(true);
    // resetSerialBridge() 相当の処理でミラーを0へ戻す(main.ts側はここを`serialRxQueueMirror = 0`
    // という代入1行で行うため、専用関数は無い。0が受理される側であることだけを確認する)。
    const mirrorAfterReset = 0;
    expect(shouldApplySerialRxBackpressure(mirrorAfterReset)).toBe(false);
  });
});

describe('陽性対照: 既定経路(メインスレッド)の挙動(項目5)', () => {
  it('workerMode=falseのときは判定を経由せずhostReceiveがそのまま呼ばれ、戻り値もそのまま返る', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    let receivedArg: Uint8Array | null = null;
    let sendToWorkerCalled = false;
    const result = routeSerialReceive(
      bytes,
      false,
      // workerMode=falseならミラー・しきい値は一切見ないはず。しきい値以上を渡しても
      // 既定経路の結果に影響しないことも合わせて確認する。
      SERIAL_RX_BACKPRESSURE_THRESHOLD_BYTES + 1,
      (b) => {
        receivedArg = b;
        return 2; // host.serialReceive()が2バイトだけ受理した場合を模す。
      },
      () => {
        sendToWorkerCalled = true;
      },
    );
    expect(receivedArg).toBe(bytes);
    expect(result.accepted).toBe(2);
    expect(result.mirrorDelta).toBe(0);
    expect(sendToWorkerCalled).toBe(false);
  });
});
