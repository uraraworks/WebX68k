// シリアル(SCCチャネルA / Web Serial)のWorker配線 (docs/STORAGE-SCSI.md参照)。
//
// master取り込み後、Web Serialの搬送層(src/serial.ts の WebSerialTransport)は
// src/libretro-host.ts(メインスレッドのLibretroHost)へは配線されたが、Worker経路
// (src/core-worker.ts)には一度も配線されていなかった(UIには設定が出るのに、Worker経路
// では無言で通信できないという穴)。この是正の実体は次の2方式:
//
// - 受信(main→Worker): 同期の往復ができないため、main側が「Worker側キュー長のミラー」を
//   持ち、しきい値以上ならWebSerialTransport.onDataに0を返させて背圧をかける
//   (搬送層側のwaitForReceiveCapacity()で待たせる)。しきい値未満ならバイト列を片道メッセージ
//   (SERIAL_RX_KIND)で送り、ミラーへ加算する。Worker側は届いたバイト列を順序を保ったまま
//   蓄積し(SerialRxQueue)、毎tick host.serialReceive() へ先頭から流し込む。
// - 送信(Worker→main): Worker側が毎tick host.drainSerialTx() した結果をframe eventへ
//   相乗りさせて運ぶ(音声chunkと同じ方式)。mainは受け取ったバイト列をそのまま
//   serialTransport.write() する。
//
// ここでは実 Worker グローバル(self/host)にもDOM(navigator.serial)にも依存しない
// 純粋ロジックだけを切り出す(src/worker-drive-loop.ts / src/worker-input.ts と同じ作法。
// 単体テスト対象)。src/core-worker.ts / src/main.ts はこのファイルへ薄く結線するだけにする。

/** main側の受信キュー長ミラーが、これ以上なら背圧をかける(受理を止める)しきい値。
 * WebSerialTransportの搬送層バッファ(recommendedWriteSize()の既定maxBytes=4096)より
 * 余裕を持たせ、複数チャンク分をためても即座には詰まらない値にしてある。 */
export const SERIAL_RX_BACKPRESSURE_THRESHOLD_BYTES = 8192;

/** ミラーがしきい値以上か。しきい値以上ならWebSerialTransport.onDataは0を返すべき
 * (=受理せず、搬送層に待たせる)。 */
export function shouldApplySerialRxBackpressure(
  mirrorQueueLength: number,
  thresholdBytes: number = SERIAL_RX_BACKPRESSURE_THRESHOLD_BYTES,
): boolean {
  return mirrorQueueLength >= thresholdBytes;
}

export interface SerialReceiveRouteResult {
  /** WebSerialTransport.onDataがそのまま返してよい、受理したバイト数。 */
  accepted: number;
  /** 呼び出し元(main.ts)がミラーへ加算すべき量。Worker経路で実際に送信した場合のみ非0。 */
  mirrorDelta: number;
}

/**
 * WebSerialTransport.onDataの実体となる、経路選択込みの受理判定。
 *
 * - 既定経路(workerMode===false): 判定を一切行わず hostReceive(bytes) をそのまま呼んで
 *   その戻り値を返すだけ(素通し)。既定経路(メインスレッドのLibretroHost)の挙動を
 *   一切変えないための分岐で、mirrorQueueLength/thresholdBytesはここでは見ない。
 * - Worker経路(workerMode===true): ミラーがしきい値未満なら渡されたbytes全体を受理した
 *   ことにして sendToWorker(bytes) を呼ぶ(部分受理はしない。理由はSERIAL_RX_KINDの
 *   コメント参照:transferする関係上、受理した分だけbytes.bufferを渡す設計にすると
 *   readLoop側の同一バッファ使い回しと衝突するため)。しきい値以上なら何もせず0を返す。
 */
export function routeSerialReceive(
  bytes: Uint8Array,
  workerMode: boolean,
  mirrorQueueLength: number,
  hostReceive: (bytes: Uint8Array) => number,
  sendToWorker: (bytes: Uint8Array) => void,
  thresholdBytes: number = SERIAL_RX_BACKPRESSURE_THRESHOLD_BYTES,
): SerialReceiveRouteResult {
  if (!workerMode) {
    return { accepted: hostReceive(bytes), mirrorDelta: 0 };
  }
  if (bytes.length === 0) return { accepted: 0, mirrorDelta: 0 };
  if (shouldApplySerialRxBackpressure(mirrorQueueLength, thresholdBytes)) {
    return { accepted: 0, mirrorDelta: 0 };
  }
  sendToWorker(bytes);
  return { accepted: bytes.length, mirrorDelta: bytes.length };
}

export interface SerialRxQueueReport {
  /** 更新後のミラー値(負値にはしない)。 */
  mirror: number;
  /** 直前のミラーより下がったか。trueのときだけ呼び出し元は
   * serialTransport.notifyReceiveCapacity() を呼ぶ(待っているreadLoopを起こす)。 */
  decreased: boolean;
}

/** frame eventが運んできたWorker側キュー長の報告を受けて、main側のミラーを更新する。 */
export function applySerialRxQueueReport(
  previousMirror: number,
  reportedQueueLength: number,
): SerialRxQueueReport {
  const mirror = Math.max(0, reportedQueueLength);
  return { mirror, decreased: mirror < previousMirror };
}

/**
 * Worker側の受信キュー(core-worker.ts が保持する実体)。main→Workerの片道メッセージ
 * (SERIAL_RX_KIND)で届いたバイト列を、届いた順のまま蓄積し、毎tick
 * host.serialReceive() 相当の関数へ先頭から流し込む。
 *
 * FIFOの順序保証: enqueue()はチャンク単位で配列末尾に積むだけ、drain()は必ず先頭
 * (chunks[0])から処理し、受理されなかった残りをchunks[0]に戻して打ち切る。したがって
 * 「受理されなかった続きを次のtickでも同じ順序で再試行する」が保たれる
 * (chunks[1]以降を先に処理することは無い)。
 */
export class SerialRxQueue {
  private chunks: Uint8Array[] = [];
  private length = 0;

  /** 現在キューに残っているバイト数の合計。frame eventのrxQueueLengthにそのまま使う。 */
  get queueLength(): number {
    return this.length;
  }

  enqueue(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  /**
   * キュー先頭から順に receive() へ渡す。receive() は host.serialReceive() と同じ契約
   * (受理したバイト数を返す)。受理が渡した長さより少なかった時点(0件も含む)で、
   * それ以上進めるとFIFOの順序が乱れるためそこで打ち切る(次のdrain()呼び出しで
   * 同じ残りから再試行される)。
   */
  drain(receive: (bytes: Uint8Array) => number): void {
    while (this.chunks.length > 0) {
      const front = this.chunks[0];
      const accepted = Math.max(0, Math.min(front.length, receive(front)));
      if (accepted === 0) break;
      this.length -= accepted;
      if (accepted < front.length) {
        this.chunks[0] = front.subarray(accepted);
        break;
      }
      this.chunks.shift();
    }
  }

  /** 切断・リセット時に呼ぶ。前セッションのデータを次の接続へ持ち越さないため、
   * 中身を空にしてlengthを0へ戻す。 */
  reset(): void {
    this.chunks = [];
    this.length = 0;
  }
}
