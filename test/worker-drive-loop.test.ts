// Worker側駆動ループ(段階移行 手順7)の純粋ロジック(src/worker-drive-loop.ts)のテスト。
// core-worker.ts 自体は実Workerグローバル(self/OffscreenCanvas/fetch)に依存するため、
// 前例(test/core-worker-build-format.test.ts)と同様ここでは対象にしない。取り戻し計算と
// バッファプールという、実際にはグローバルに依存しない部分だけを切り出して実行可能なテストにする。
//
// 陽性対照(手順7 受け入れ条件): runTick() から取り戻し(whileループでbudget分だけ複数フレーム
// 進める部分)を外し、1tickにつき最大1フレームしか進めない実装に一時的に書き換えたところ、
// 「取り戻しで複数フレーム走ること」のテストが実際に red になることを確認してから元に戻した
// (2026-08-28、実装時に確認済み)。
import { describe, expect, it } from 'vitest';
import { FrameBufferPool, runTick, WORKER_MAX_FRAMES_PER_TICK } from '../src/worker-drive-loop';

const FPS_60 = 60;
const FRAME_INTERVAL_60 = 1 / FPS_60;

describe('runTick', () => {
  it('通常のdt(≈1フレームぶん)では1〜2フレーム進む', () => {
    const result = runTick(FRAME_INTERVAL_60, FPS_60, 0, () => ({
      fddReading: false,
      fddDrive: -1,
      hddAccessing: false,
    }));
    expect(result.ranFrames).toBeGreaterThanOrEqual(1);
    expect(result.ranFrames).toBeLessThanOrEqual(2);
  });

  it('遅れたtick(dt≈5フレームぶん)では取り戻しで複数フレーム進む', () => {
    const dt = FRAME_INTERVAL_60 * 5;
    const result = runTick(dt, FPS_60, 0, () => ({
      fddReading: false,
      fddDrive: -1,
      hddAccessing: false,
    }));
    // computeFrameBudget()のクランプ内で、1フレームだけでは追いつけないはずの遅れを
    // 複数フレーム進めて取り戻すこと(素のsetIntervalなら1回のtickで1フレームしか進まず、
    // 遅れがそのまま蓄積し続ける)。
    expect(result.ranFrames).toBeGreaterThan(1);
  });

  it('runFrameOnceの呼び出し回数はranFramesと一致する', () => {
    let calls = 0;
    const result = runTick(FRAME_INTERVAL_60 * 3, FPS_60, 0, () => {
      calls++;
      return { fddReading: false, fddDrive: -1, hddAccessing: false };
    });
    expect(calls).toBe(result.ranFrames);
  });

  it('タブ復帰直後等の異常なdt(数秒)ではaccumulatorが破棄され蓄積が残らない', () => {
    const result = runTick(5, FPS_60, 0, () => ({
      fddReading: false,
      fddDrive: -1,
      hddAccessing: false,
    }));
    // budgetでクランプされ、余った分は破棄される(蓄積したまま次tickへ持ち越さない)。
    expect(result.accumulator).toBeLessThan(FRAME_INTERVAL_60 * 4);
  });

  it('1フレームも進まなかったtickではaccessが常にfalse/-1になる(dupe扱い)', () => {
    // budgetが0になる状況(音声キュー枯渇/過多はWorker側では常にqueued=0固定なので
    // 起きないが、dt=0のようにaccumulatorが閾値未満のケースで再現する)。
    const result = runTick(0, FPS_60, 0, () => {
      throw new Error('呼ばれてはいけない');
    });
    expect(result.ranFrames).toBe(0);
    expect(result.access).toEqual({ fddReading: false, fddDrive: -1, hddAccessing: false });
  });

  it('tick内の複数フレームのいずれかでアクセスがあればORで合成する', () => {
    let call = 0;
    const result = runTick(FRAME_INTERVAL_60 * 3, FPS_60, 0, () => {
      call++;
      // 2フレーム目だけFDD1にアクセスがあったことにする。
      if (call === 2) return { fddReading: true, fddDrive: 1, hddAccessing: false };
      return { fddReading: false, fddDrive: -1, hddAccessing: false };
    });
    expect(result.ranFrames).toBeGreaterThanOrEqual(2);
    expect(result.access).toEqual({ fddReading: true, fddDrive: 1, hddAccessing: false });
  });
});

describe('runTick maxFramesPerTick (Worker注入レイテンシ対策)', () => {
  // 2026-08-31: 親セッションが実測したKeyBuf帰属計測(make注入フレーム数)で、Worker経路は
  // 中央2・最大13フレームの裾を持つことが分かった。原因は「取り戻しバースト中は
  // ctx.onmessageが割り込めず、届いた入力の反映がバースト終了まで遅れる」こと
  // (src/worker-drive-loop.ts冒頭コメント参照)。maxFramesPerTickはこのバーストの長さを
  // 追加で絞り、超過分をaccumulatorへ持ち越して次tick(=次のonmessage割り込み機会)へ回す。

  it('省略時(既定main.ts loop()相当)は取り戻しでcomputeFrameBudget()いっぱいまで進む(従来どおり)', () => {
    const dt = FRAME_INTERVAL_60 * 5;
    const result = runTick(dt, FPS_60, 0, () => ({
      fddReading: false,
      fddDrive: -1,
      hddAccessing: false,
    }));
    expect(result.ranFrames).toBeGreaterThan(WORKER_MAX_FRAMES_PER_TICK);
  });

  it('maxFramesPerTickを指定すると、大きく遅れたtickでも1tickの実行フレーム数がその上限を超えない', () => {
    const dt = FRAME_INTERVAL_60 * 5; // 取り戻しが本来なら複数フレーム走るはずの遅れ
    const result = runTick(
      dt,
      FPS_60,
      0,
      () => ({ fddReading: false, fddDrive: -1, hddAccessing: false }),
      WORKER_MAX_FRAMES_PER_TICK,
    );
    expect(result.ranFrames).toBeLessThanOrEqual(WORKER_MAX_FRAMES_PER_TICK);
  });

  it('上限で切り詰めた分はaccumulatorに残り、次tickへ持ち越される(取り戻し量そのものは失われない)', () => {
    const dt = FRAME_INTERVAL_60 * 5;
    const capped = runTick(
      dt,
      FPS_60,
      0,
      () => ({ fddReading: false, fddDrive: -1, hddAccessing: false }),
      WORKER_MAX_FRAMES_PER_TICK,
    );
    const uncapped = runTick(dt, FPS_60, 0, () => ({
      fddReading: false,
      fddDrive: -1,
      hddAccessing: false,
    }));
    // 上限で切り詰めた分だけ、cappedのaccumulatorがuncappedより多く残る。
    expect(capped.accumulator).toBeGreaterThan(uncapped.accumulator);
    // 次tickにdt=0で呼べば、持ち越したaccumulatorから残りのフレームが進むこと
    // (取り戻し量そのものが消えていないことの確認)。
    let remaining = 0;
    let acc = capped.accumulator;
    while (acc >= FRAME_INTERVAL_60) {
      const r = runTick(
        0,
        FPS_60,
        acc,
        () => ({ fddReading: false, fddDrive: -1, hddAccessing: false }),
        WORKER_MAX_FRAMES_PER_TICK,
      );
      if (r.ranFrames === 0) break;
      remaining += r.ranFrames;
      acc = r.accumulator;
    }
    expect(capped.ranFrames + remaining).toBeGreaterThanOrEqual(uncapped.ranFrames);
  });

  it('故障注入: 上限を無効化した(undefinedのまま渡す)状態に戻すと、1tickの実行フレーム数上限を検査するテストが落ちる', () => {
    // 「maxFramesPerTickを指定すると1tickの実行フレーム数がその上限を超えない」テストの
    // 検査対象を、実装がそれを無視した場合(=引数を渡し忘れた場合)を模して確認する
    // (受け入れ条件: この故障注入で当該テストがredになること。2026-08-31確認)。
    const dt = FRAME_INTERVAL_60 * 5;
    const withoutCap = runTick(dt, FPS_60, 0, () => ({
      fddReading: false,
      fddDrive: -1,
      hddAccessing: false,
    })); // maxFramesPerTickを渡さない = core-worker.ts側で配線を忘れた状態を模擬
    // このアサーションは「上限を指定すれば守られる」テストとは別に、
    // 「指定を忘れると守られない(=検査が対象を実際に踏んでいる)」ことを示す陽性対照。
    expect(withoutCap.ranFrames).toBeGreaterThan(WORKER_MAX_FRAMES_PER_TICK);
  });
});

describe('FrameBufferPool', () => {
  it('空のプールから取得すると新規確保され、missesが増える', () => {
    const pool = new FrameBufferPool();
    expect(pool.misses).toBe(0);
    const buf = pool.acquire(1024);
    expect(buf.byteLength).toBe(1024);
    expect(pool.misses).toBe(1);
  });

  it('返却したバッファは次回同じサイズの取得で再利用され、missesが増えない', () => {
    const pool = new FrameBufferPool();
    const first = pool.acquire(2048);
    expect(pool.misses).toBe(1);
    pool.release(first);
    const second = pool.acquire(2048);
    expect(pool.misses).toBe(1); // 増えていない = 再利用された
    expect(second).toBe(first); // 同一インスタンス(参照同一性で再利用を確認)
  });

  it('サイズが変わると(解像度変更相当)別キーとして新規確保される', () => {
    const pool = new FrameBufferPool();
    const a = pool.acquire(1024);
    pool.release(a);
    const b = pool.acquire(2048); // 別サイズ。1024のプールは使われない。
    expect(pool.misses).toBe(2);
    expect(b).not.toBe(a);
  });

  it('陽性対照: 返却しなければ毎回missesが増え続ける(バッファ返却が効いていない状態を再現)', () => {
    const pool = new FrameBufferPool();
    for (let i = 0; i < 5; i++) {
      pool.acquire(4096); // release()を呼ばない
    }
    expect(pool.misses).toBe(5);
  });
});
