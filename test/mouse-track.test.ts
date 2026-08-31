// マウスの閉ループ追従(段階移行 手順6後半、src/mouse-track.ts)のテスト。
//
// docs/STORAGE-SCSI.md「ワーカー移行 手順6後半」の制約:
// - 既定経路(?worker=1 なし)の計算結果が1ビットも変わらないこと。
// - 定数・加速カーブは切り出し前の値をそのまま移したこと。
// - 故障注入で検査が効くことを確認すること(このファイル末尾に記録)。
//
// 「既定経路の不変性」の担保方法: 切り出し前に src/main.ts に直書きされていたロジック
// (stepMouseTracking/resyncGuestMouse、git log の 2026-08-31 以前の版)を一字一句そのまま
// referenceStep()/referenceResync() としてこのファイルへ複製し(=切り出し前の「オラクル」)、
// 同一の疑似ランダムなカーソル軌跡に対して MouseTracker と referenceStep を並走させ、
// host.addMouseDelta() へ送る呼び出し列が全ステップで完全一致することを確認する
// (test('既定経路の不変性', ...)参照)。
import { describe, expect, it } from 'vitest';
import {
  MOUSE_HOMING_MARGIN,
  MOUSE_TRACK_ACK_FRAMES,
  MOUSE_TRACK_STALL_LIMIT,
  MouseTracker,
  sendAmountFor,
  type GuestCursor,
  type MouseTrackHost,
} from '../src/mouse-track';

/** MouseTrackHost を満たす fake。呼び出しを記録し、addMouseDelta の累積を cursor へ
 * 反映するかどうかを呼び出し側が制御できる(ack待ち・stall再現のため)。 */
class FakeMouseTrackHost implements MouseTrackHost {
  cursor: GuestCursor | null = null;
  pending = false;
  deltaCalls: Array<{ dx: number; dy: number }> = [];
  clearCalls = 0;
  /** true の間、addMouseDelta() が呼ばれるたびに cursor.x/y へそのまま加算反映する
   * (「ゲストがすぐ反映するソフト」を模す)。false なら反映しない(「反映しない/固着したソフト」)。 */
  reflectImmediately = true;

  readGuestCursor(): GuestCursor | null {
    return this.cursor;
  }

  hasPendingMouseDelta(): boolean {
    return this.pending;
  }

  addMouseDelta(dx: number, dy: number): void {
    this.deltaCalls.push({ dx, dy });
    if (this.reflectImmediately && this.cursor) {
      this.cursor = { ...this.cursor, x: this.cursor.x + dx, y: this.cursor.y + dy };
    }
  }

  clearMouseState(): void {
    this.clearCalls++;
  }
}

function cursor(x: number, y: number, opts?: Partial<GuestCursor>): GuestCursor {
  return { x, y, minX: 0, minY: 0, maxX: 200, maxY: 200, visible: true, ...opts };
}

describe('sendAmountFor', () => {
  it('3以下は1:1(加速なし)', () => {
    expect(sendAmountFor(1)).toBe(1);
    expect(sendAmountFor(2)).toBe(2);
    expect(sendAmountFor(3)).toBe(3);
    expect(sendAmountFor(-3)).toBe(-3);
  });

  it('負の距離は符号を保つ', () => {
    expect(sendAmountFor(-50)).toBe(-sendAmountFor(50));
  });

  it('大きな距離ほど「行き過ぎない範囲の最大送信量」が単調に増える(逆引きテーブルの性質)', () => {
    const a = sendAmountFor(10);
    const b = sendAmountFor(100);
    const c = sendAmountFor(1000);
    expect(a).toBeLessThanOrEqual(b);
    expect(b).toBeLessThanOrEqual(c);
  });

  it('0未満(誤差なし)は0', () => {
    expect(sendAmountFor(0)).toBe(0);
  });
});

describe('MouseTracker.step', () => {
  it('目標との差分を addMouseDelta で送る(基本の閉ループ)', () => {
    const host = new FakeMouseTrackHost();
    host.cursor = cursor(0, 0);
    const tracker = new MouseTracker();
    tracker.setDesiredRatio(0.5, 0.5); // target = (100, 100)

    const result = tracker.step(host, true);

    expect(result).toBeUndefined();
    expect(host.deltaCalls.length).toBe(1);
    // sendAmountFor(100) と一致すること(加速テーブルの実値そのものは sendAmountFor で別途検証済み)。
    expect(host.deltaCalls[0]).toEqual({ dx: sendAmountFor(100), dy: sendAmountFor(100) });
  });

  it('enabled=false のときは何もしない', () => {
    const host = new FakeMouseTrackHost();
    host.cursor = cursor(0, 0);
    const tracker = new MouseTracker();
    tracker.setDesiredRatio(0.5, 0.5);

    tracker.step(host, false);

    expect(host.deltaCalls.length).toBe(0);
  });

  it('目標比率が未設定(setDesiredRatioを一度も呼んでいない)なら何もしない', () => {
    const host = new FakeMouseTrackHost();
    host.cursor = cursor(0, 0);
    const tracker = new MouseTracker();

    tracker.step(host, true);

    expect(host.deltaCalls.length).toBe(0);
  });

  it('ワークエリア未初期化(readGuestCursorがnull)なら何もしない', () => {
    const host = new FakeMouseTrackHost();
    host.cursor = null;
    const tracker = new MouseTracker();
    tracker.setDesiredRatio(0.5, 0.5);

    tracker.step(host, true);

    expect(host.deltaCalls.length).toBe(0);
  });

  it('host.hasPendingMouseDelta()がtrueの間は新規送信しない(積み残し消化待ち)', () => {
    const host = new FakeMouseTrackHost();
    host.cursor = cursor(0, 0);
    host.pending = true;
    const tracker = new MouseTracker();
    tracker.setDesiredRatio(0.5, 0.5);

    tracker.step(host, true);

    expect(host.deltaCalls.length).toBe(0);
  });

  it('目標に一致したら送信しない(dx===0 && dy===0)', () => {
    const host = new FakeMouseTrackHost();
    host.cursor = cursor(100, 100);
    const tracker = new MouseTracker();
    tracker.setDesiredRatio(0.5, 0.5); // target = (100, 100) = 現在地

    tracker.step(host, true);

    expect(host.deltaCalls.length).toBe(0);
  });

  it('ack待ち: 送信直後、カーソルが動くまで次のstepでは再送しない', () => {
    const host = new FakeMouseTrackHost();
    host.cursor = cursor(0, 0);
    host.reflectImmediately = false; // ゲストがまだ反映していない状態を保つ
    const tracker = new MouseTracker();
    tracker.setDesiredRatio(0.5, 0.5);

    tracker.step(host, true); // 1回送信、ackPending=true
    expect(host.deltaCalls.length).toBe(1);

    tracker.step(host, true); // カーソルが動いていないので送信しない
    expect(host.deltaCalls.length).toBe(1);
  });

  it('ack待ち: カーソルが実際に動いたら次のstepで再送する', () => {
    const host = new FakeMouseTrackHost();
    host.cursor = cursor(0, 0);
    const tracker = new MouseTracker();
    tracker.setDesiredRatio(0.5, 0.5);

    tracker.step(host, true); // 送信、reflectImmediately=trueなのでcursorが動く
    expect(host.deltaCalls.length).toBe(1);

    tracker.step(host, true); // 目標に近づいたので再送(まだ届いていなければ)
    expect(host.deltaCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('ack待ちがMOUSE_TRACK_ACK_FRAMESを超えたら空回り判定へ回す(強制的に次の送信を試みる)', () => {
    const host = new FakeMouseTrackHost();
    host.cursor = cursor(0, 0);
    host.reflectImmediately = false; // カーソルは絶対動かない
    const tracker = new MouseTracker();
    tracker.setDesiredRatio(0.5, 0.5);

    tracker.step(host, true); // 1回目の送信、ackPending開始
    const callsAfterFirst = host.deltaCalls.length;
    expect(callsAfterFirst).toBe(1);

    // ack待ち中はMOUSE_TRACK_ACK_FRAMES回まで新規送信しない(trackAckFramesが
    // MOUSE_TRACK_ACK_FRAMESを"超えた"呼び出しで初めて強制的に空回り判定へ回るため、
    // ちょうどMOUSE_TRACK_ACK_FRAMES回では届かず、+1回目で発火する)。
    for (let i = 0; i < MOUSE_TRACK_ACK_FRAMES + 1; i++) {
      tracker.step(host, true);
    }
    // MOUSE_TRACK_ACK_FRAMESを超えたステップで、ack待ちを解いて次の送信を試みる
    expect(host.deltaCalls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('stallがMOUSE_TRACK_STALL_LIMITを超えたら追従を諦め、clearMouseState()を呼び\'disabled\'を返す', () => {
    const host = new FakeMouseTrackHost();
    host.cursor = cursor(0, 0);
    host.reflectImmediately = false; // 送っても絶対にカーソルが動かないソフトを模す
    const tracker = new MouseTracker();
    tracker.setDesiredRatio(0.5, 0.5);

    let disabledResult: string | undefined;
    // 大きめの回数ステップして、諦めるまで回す(ack待ちの往復を含めても十分な余裕を持たせる)。
    for (let i = 0; i < (MOUSE_TRACK_STALL_LIMIT + MOUSE_TRACK_ACK_FRAMES) * 3; i++) {
      const r = tracker.step(host, true);
      if (r === 'disabled') {
        disabledResult = r;
        break;
      }
    }

    expect(disabledResult).toBe('disabled');
    expect(host.clearCalls).toBe(1);
    expect(tracker.disabled).toBe(true);
  });

  it('disabled後は何もしない(clearMouseStateが2回目以降呼ばれない)', () => {
    const host = new FakeMouseTrackHost();
    host.cursor = cursor(0, 0);
    host.reflectImmediately = false;
    const tracker = new MouseTracker();
    tracker.setDesiredRatio(0.5, 0.5);

    for (let i = 0; i < (MOUSE_TRACK_STALL_LIMIT + MOUSE_TRACK_ACK_FRAMES) * 3; i++) {
      if (tracker.step(host, true) === 'disabled') break;
    }
    expect(tracker.disabled).toBe(true);
    const clearCallsAtDisable = host.clearCalls;
    const deltaCallsAtDisable = host.deltaCalls.length;

    tracker.step(host, true);
    tracker.step(host, true);

    expect(host.clearCalls).toBe(clearCallsAtDisable);
    expect(host.deltaCalls.length).toBe(deltaCallsAtDisable);
  });
});

describe('MouseTracker.resync', () => {
  it('カーソルが読める(IOCSワーク初期化済み)なら押し付け(ホーミング)をしない', () => {
    const host = new FakeMouseTrackHost();
    host.cursor = cursor(50, 50);
    const tracker = new MouseTracker();

    tracker.resync(host, { width: 768, height: 512 });

    expect(host.deltaCalls.length).toBe(0);
  });

  it('カーソルが読めない(未初期化)なら画面外まで押し切るホーミングを送る', () => {
    const host = new FakeMouseTrackHost();
    host.cursor = null;
    const tracker = new MouseTracker();

    tracker.resync(host, { width: 768, height: 512 });

    expect(host.deltaCalls.length).toBe(1);
    const distance = Math.max(768, 512) + MOUSE_HOMING_MARGIN;
    expect(host.deltaCalls[0]).toEqual({ dx: -distance, dy: -distance });
  });

  it('disabled状態を解除する(再同期後は追従が再開する)', () => {
    const host = new FakeMouseTrackHost();
    host.cursor = cursor(0, 0);
    host.reflectImmediately = false;
    const tracker = new MouseTracker();
    tracker.setDesiredRatio(0.5, 0.5);
    for (let i = 0; i < (MOUSE_TRACK_STALL_LIMIT + MOUSE_TRACK_ACK_FRAMES) * 3; i++) {
      if (tracker.step(host, true) === 'disabled') break;
    }
    expect(tracker.disabled).toBe(true);

    host.reflectImmediately = true;
    host.cursor = cursor(0, 0);
    tracker.resync(host, { width: 768, height: 512 });

    expect(tracker.disabled).toBe(false);
    const result = tracker.step(host, true);
    expect(result).toBeUndefined();
    expect(host.deltaCalls.length).toBeGreaterThan(0);
  });
});

// --- 既定経路の不変性(制約: 既定経路の挙動を一切変えないこと) ------------------------
//
// 切り出し前(2026-08-31以前)に src/main.ts に直書きされていた stepMouseTracking/
// resyncGuestMouse を一字一句コピーしたオラクル。MOUSE_TRACK_ACK_FRAMES/MOUSE_HOMING_MARGIN/
// MOUSE_ACCEL_TABLE 相当の定数・加速カーブは src/mouse-track.ts から輸入している値を使う
// (定数自体は変えていないので、これも「切り出し前と同じ値」であることの一部)。
interface ReferenceState {
  desiredRatioX: number;
  desiredRatioY: number;
  hasDesiredRatio: boolean;
  trackStallFrames: number;
  trackDisabled: boolean;
  trackAckPending: boolean;
  trackAckFrames: number;
  trackSentAtX: number;
  trackSentAtY: number;
}

function newReferenceState(): ReferenceState {
  return {
    desiredRatioX: 0,
    desiredRatioY: 0,
    hasDesiredRatio: false,
    trackStallFrames: 0,
    trackDisabled: false,
    trackAckPending: false,
    trackAckFrames: 0,
    trackSentAtX: -1,
    trackSentAtY: -1,
  };
}

function referenceSetDesiredRatio(s: ReferenceState, ratioX: number, ratioY: number): void {
  s.desiredRatioX = Math.max(0, Math.min(1, ratioX));
  s.desiredRatioY = Math.max(0, Math.min(1, ratioY));
  s.hasDesiredRatio = true;
}

/** 切り出し前の stepMouseTracking() の複製(host!==null && isMouseTracking() 相当は
 * 呼び出し側でenabledとして渡す形に絞ってある。ロジック本体は無改変)。 */
function referenceStep(s: ReferenceState, host: MouseTrackHost, enabled: boolean): 'disabled' | undefined {
  if (!enabled || !s.hasDesiredRatio || s.trackDisabled) return undefined;
  const cur = host.readGuestCursor();
  if (!cur) return undefined;

  if (s.trackAckPending) {
    if (cur.x !== s.trackSentAtX || cur.y !== s.trackSentAtY) {
      s.trackAckPending = false;
      s.trackStallFrames = 0;
    } else if (++s.trackAckFrames > MOUSE_TRACK_ACK_FRAMES) {
      s.trackAckPending = false;
      s.trackStallFrames += MOUSE_TRACK_ACK_FRAMES;
    } else {
      return undefined;
    }
  }

  if (host.hasPendingMouseDelta()) return undefined;

  const targetX = Math.round(cur.minX + s.desiredRatioX * (cur.maxX - cur.minX));
  const targetY = Math.round(cur.minY + s.desiredRatioY * (cur.maxY - cur.minY));
  const dx = targetX - cur.x;
  const dy = targetY - cur.y;
  if (dx === 0 && dy === 0) {
    s.trackStallFrames = 0;
    return undefined;
  }

  if (s.trackStallFrames > MOUSE_TRACK_STALL_LIMIT) {
    s.trackDisabled = true;
    host.clearMouseState();
    return 'disabled';
  }

  const sendX = sendAmountFor(dx);
  const sendY = sendAmountFor(dy);
  if (sendX === 0 && sendY === 0) {
    s.trackStallFrames = 0;
    return undefined;
  }

  host.addMouseDelta(sendX, sendY);
  s.trackSentAtX = cur.x;
  s.trackSentAtY = cur.y;
  s.trackAckPending = true;
  s.trackAckFrames = 0;
  return undefined;
}

/** 決定的な疑似乱数(xorshift32相当)。テストの再現性のためMath.randomは使わない。 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

describe('既定経路の不変性', () => {
  it('切り出し前(referenceStep)と切り出し後(MouseTracker)で、同一の疑似ランダム軌跡に対して送出するdelta列が完全一致する', () => {
    const rng = makeRng(0xC0FFEE);

    const refState = newReferenceState();
    const refHost = new FakeMouseTrackHost();
    refHost.cursor = cursor(0, 0);

    const tracker = new MouseTracker();
    const newHost = new FakeMouseTrackHost();
    newHost.cursor = cursor(0, 0);

    const STEPS = 400;
    for (let i = 0; i < STEPS; i++) {
      // 5フレームに1回程度、目標比率を変える(mousemoveの粒度を模す)。
      if (rng() < 0.2) {
        const ratioX = rng();
        const ratioY = rng();
        referenceSetDesiredRatio(refState, ratioX, ratioY);
        tracker.setDesiredRatio(ratioX, ratioY);
      }
      // ときどきゲストが反映しない(固着ソフトを模す)区間を作る。
      const reflect = rng() > 0.1;
      refHost.reflectImmediately = reflect;
      newHost.reflectImmediately = reflect;

      const enabled = rng() > 0.05; // ときどきキャプチャ中(enabled=false)を挟む
      const refResult = referenceStep(refState, refHost, enabled);
      const newResult = tracker.step(newHost, enabled);

      expect(newResult).toBe(refResult);
      expect(newHost.deltaCalls).toEqual(refHost.deltaCalls);
      expect(newHost.clearCalls).toBe(refHost.clearCalls);
      expect(newHost.cursor).toEqual(refHost.cursor);
    }

    // 空振りに終わっていない(実際に何度も送信が起きたこと)ことを確認する。
    expect(refHost.deltaCalls.length).toBeGreaterThan(0);
  });
});

// --- 陽性対照(規律: 故障注入で検査が効くことを確認する) ------------------------------
//
// 以下2件は実装時に実際にコードを一時的に壊し、対応するテストが red になることを確認してから
// 元に戻した(git diff が空であることも確認済み)。手順:
//
// (1) 目標計算をわざとずらす: step() 内の
//       const targetX = Math.round(cur.minX + this.desiredRatioX * (cur.maxX - cur.minX));
//     を
//       const targetX = Math.round(cur.minX + this.desiredRatioX * (cur.maxX - cur.minX)) + 999;
//     に変更 → 上の「目標との差分を addMouseDelta で送る(基本の閉ループ)」が
//     `expect(host.deltaCalls[0]).toEqual({ dx: sendAmountFor(100), dy: sendAmountFor(100) })`
//     で red になることを確認済み(実際に送られた dx が sendAmountFor(1099) 相当になり、
//     期待値と一致しなくなるため)。「既定経路の不変性」テストも同時に red になった
//     (referenceStep側はずらしていないため、1ステップ目から delta 列が食い違う)。
//
// (2) stall判定(諦める処理)を無効化する: step() 内の
//       if (this.trackStallFrames > MOUSE_TRACK_STALL_LIMIT) { ... return 'disabled'; }
//     の if 条件を `if (false)` に変更 → 上の
//     「stallがMOUSE_TRACK_STALL_LIMITを超えたら追従を諦め...」と
//     「disabled後は何もしない...」が、disabledResult が最後まで 'disabled' にならず
//     timeoutせずforループを最後まで回りきった上で `expect(disabledResult).toBe('disabled')`
//     が red になることを確認済み。
