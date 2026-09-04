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
import {
  FrameBufferPool,
  runTick,
  runUnlimitedTick,
  shouldPresentUnlimitedFrame,
} from '../src/worker-drive-loop';

const FPS_60 = 60;
const FRAME_INTERVAL_60 = 1 / FPS_60;

describe('runTick', () => {
  it('通常のdt(≈1フレームぶん)では1〜2フレーム進む', () => {
    const result = runTick(FRAME_INTERVAL_60, FPS_60, 0, 1, () => ({
      fddReading: false,
      fddDrive: -1,
      hddAccessing: false,
    }));
    expect(result.ranFrames).toBeGreaterThanOrEqual(1);
    expect(result.ranFrames).toBeLessThanOrEqual(2);
  });

  it('遅れたtick(dt≈5フレームぶん)では取り戻しで複数フレーム進む', () => {
    const dt = FRAME_INTERVAL_60 * 5;
    const result = runTick(dt, FPS_60, 0, 1, () => ({
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
    const result = runTick(FRAME_INTERVAL_60 * 3, FPS_60, 0, 1, () => {
      calls++;
      return { fddReading: false, fddDrive: -1, hddAccessing: false };
    });
    expect(calls).toBe(result.ranFrames);
  });

  it('タブ復帰直後等の異常なdt(数秒)ではaccumulatorが破棄され蓄積が残らない', () => {
    const result = runTick(5, FPS_60, 0, 1, () => ({
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
    const result = runTick(0, FPS_60, 0, 1, () => {
      throw new Error('呼ばれてはいけない');
    });
    expect(result.ranFrames).toBe(0);
    expect(result.access).toEqual({ fddReading: false, fddDrive: -1, hddAccessing: false });
  });

  it('tick内の複数フレームのいずれかでアクセスがあればORで合成する', () => {
    let call = 0;
    const result = runTick(FRAME_INTERVAL_60 * 3, FPS_60, 0, 1, () => {
      call++;
      // 2フレーム目だけFDD1にアクセスがあったことにする。
      if (call === 2) return { fddReading: true, fddDrive: 1, hddAccessing: false };
      return { fddReading: false, fddDrive: -1, hddAccessing: false };
    });
    expect(result.ranFrames).toBeGreaterThanOrEqual(2);
    expect(result.access).toEqual({ fddReading: true, fddDrive: 1, hddAccessing: false });
  });
});

describe('runTick: 速度倍率(手順9で追加。以前はspeedMultiplier=1固定だった)', () => {
  it('speedMultiplier=2は等倍の約2倍のフレームを進める(同じdtで比較)', () => {
    const dt = FRAME_INTERVAL_60 * 4;
    const at1x = runTick(dt, FPS_60, 0, 1, () => ({ fddReading: false, fddDrive: -1, hddAccessing: false }));
    const at2x = runTick(dt, FPS_60, 0, 2, () => ({ fddReading: false, fddDrive: -1, hddAccessing: false }));
    // frameIntervalが半分になる(1/(fps*2))ため、同じdtでも約2倍のフレームを消化できる。
    expect(at2x.ranFrames).toBeGreaterThan(at1x.ranFrames);
  });

  it('speedMultiplier=0.5は等倍より進むフレーム数が少ない', () => {
    const dt = FRAME_INTERVAL_60 * 4;
    const at1x = runTick(dt, FPS_60, 0, 1, () => ({ fddReading: false, fddDrive: -1, hddAccessing: false }));
    const atHalf = runTick(dt, FPS_60, 0, 0.5, () => ({ fddReading: false, fddDrive: -1, hddAccessing: false }));
    expect(atHalf.ranFrames).toBeLessThan(at1x.ranFrames);
  });

});

describe('runUnlimitedTick(無制限速度モードのWorker側1tick駆動、この穴の是正で追加)', () => {
  // now()は「時間はretro_run()の実行中にだけ進む」擬似クロック(フレーム実行1回につき
  // frameCostMsぶん進める)。now()呼び出し自体は瞬時とみなし、budgetMs・frameCostMsだけで
  // ranFramesが決定的に求まるようにするため。
  function makeClock(frameCostMs: number): { now: () => number; runFrameOnce: () => ReturnType<typeof noAccess> } {
    let value = 0;
    return {
      now: () => value,
      runFrameOnce: () => {
        value += frameCostMs;
        return noAccess();
      },
    };
  }
  function noAccess() {
    return { fddReading: false, fddDrive: -1, hddAccessing: false };
  }

  // 2026-09-04の設計修正: 占有率上限は「1tickの中の割合」ではなく実時間ベースの
  // nextAllowedAtMsで守るようになった。既存テストの多くは占有率の上限そのものを
  // 見ていないため、maxDuty=1・nextAllowedAtMsIn=0(常に許可)で固定して呼ぶ。

  it('【不具合の再現】フレーム単価がtick間隔(16ms)の半分を超えても、複数フレーム回る', () => {
    // 実機実測: この環境の1フレームのコストは約8.3ms(4倍速で頭打ち122.7fpsから逆算)。
    // 旧実装(tick間隔16msに収める予算11.2ms、そこから1フレーム分を引いたdeadline)では
    // 2フレーム目を始める余地が無く、無制限モードが「1tickにつき1フレームしか回らない」
    // (62.5fps、2倍速より遅い)という不具合になっていた。
    // 新実装は絶対値の予算(初期値33ms、tick間隔に縛られない)いっぱいまで回るため、
    // フレーム単価8.3msでも複数フレーム回ること。
    const FRAME_COST = 8.3;
    const clock = makeClock(FRAME_COST);
    let calls = 0;
    const result = runUnlimitedTick(
      clock.now,
      33, // WORKER_UNLIMITED_TICK_BUDGET_MSの初期値と同じ
      1, // maxDuty(このテストでは占有率上限は見ない)
      0, // nextAllowedAtMsIn(常に許可)
      FRAME_COST, // frameCostMsIn(実測と一致させ、EMAのドリフトを無くして決定的にする)
      () => {
        calls++;
        return clock.runFrameOnce();
      },
      () => {},
    );
    expect(result.ranFrames).toBeGreaterThanOrEqual(3);
    expect(calls).toBe(result.ranFrames);
  });

  it('予算いっぱいまで中間フレームを回し、最後に必ず1フレーム映像提示ぶんを追加する', () => {
    const FRAME_COST = 2;
    const clock = makeClock(FRAME_COST);
    let calls = 0;
    const skipStates: boolean[] = [];
    let currentSkip = false;
    const result = runUnlimitedTick(
      clock.now,
      20, // budgetMs
      1,
      0,
      FRAME_COST, // frameCostMsIn(実測と一致させ、EMAのドリフトを無くして決定的にする)
      () => {
        calls++;
        skipStates.push(currentSkip);
        return clock.runFrameOnce();
      },
      (skip) => {
        currentSkip = skip;
      },
    );
    // 手計算: nowValue+frameCostMs*2<=20 を満たす間だけ中間フレームを回す(0,2,...,16で通過、
    // 18で不通過)ため中間9回+最後の映像提示1回=10回。
    expect(result.ranFrames).toBe(10);
    expect(calls).toBe(10);
  });

  it('中間フレームはsetVideoSkip(true)、最後の1フレームだけfalseで回る', () => {
    const FRAME_COST = 2;
    const clock = makeClock(FRAME_COST);
    const skipStates: boolean[] = [];
    let currentSkip = false;
    runUnlimitedTick(
      clock.now,
      20,
      1,
      0,
      FRAME_COST,
      () => {
        skipStates.push(currentSkip);
        return clock.runFrameOnce();
      },
      (skip) => {
        currentSkip = skip;
      },
    );
    expect(skipStates.length).toBeGreaterThan(1);
    // 最後の1回だけfalse、それ以外は全てtrue。
    expect(skipStates.slice(0, -1).every((s) => s === true)).toBe(true);
    expect(skipStates[skipStates.length - 1]).toBe(false);
  });

  it('runFrameOnceが例外を投げても、finallyでsetVideoSkip(false)に戻る', () => {
    const clock = makeClock(2);
    let currentSkip = false;
    let call = 0;
    expect(() =>
      runUnlimitedTick(
        clock.now,
        20,
        1,
        0,
        2,
        () => {
          call++;
          if (call === 2) throw new Error('故障注入');
          return clock.runFrameOnce();
        },
        (skip) => {
          currentSkip = skip;
        },
      ),
    ).toThrow('故障注入');
    expect(currentSkip).toBe(false);
  });

  it('予算が極端に小さくても(0以下)最低1フレームは回る', () => {
    const clock = makeClock(2);
    let calls = 0;
    const result = runUnlimitedTick(
      clock.now,
      0, // budgetMs
      1,
      0,
      2,
      () => {
        calls++;
        return clock.runFrameOnce();
      },
      () => {},
    );
    expect(result.ranFrames).toBe(1);
    expect(calls).toBe(1);
  });

  it('accumulatorは常に0を返す(無制限モードでは使わない)', () => {
    const clock = makeClock(2);
    const result = runUnlimitedTick(clock.now, 20, 1, 0, 2, () => clock.runFrameOnce(), () => {});
    expect(result.accumulator).toBe(0);
  });

  it('tick内の複数フレームのいずれかでアクセスがあればORで合成する', () => {
    const clock = makeClock(2);
    let call = 0;
    const result = runUnlimitedTick(
      clock.now,
      20,
      1,
      0,
      2,
      () => {
        call++;
        clock.runFrameOnce();
        // 3フレーム目だけFDD0にアクセスがあったことにする。
        if (call === 3) return { fddReading: true, fddDrive: 0, hddAccessing: false };
        return noAccess();
      },
      () => {},
    );
    expect(result.access).toEqual({ fddReading: true, fddDrive: 0, hddAccessing: false });
  });

  it('frameCostMsは実測に応じて更新され呼び出し側へ返る(次tickへ持ち越すため)', () => {
    const clock = makeClock(5); // 実測は5msだが、初期推定は1msとずれさせる
    const result = runUnlimitedTick(clock.now, 20, 1, 0, 1, () => clock.runFrameOnce(), () => {});
    // EMAが実測(5ms)方向へ動くこと(初期値1から増えていること)。
    expect(result.frameCostMs).toBeGreaterThan(1);
  });

  it('nextAllowedAtMsより前に呼ばれたtickは何もしない(占有率の上限)', () => {
    const clock = makeClock(2);
    let calls = 0;
    const result = runUnlimitedTick(
      clock.now,
      20,
      1,
      100, // nextAllowedAtMsIn: now()=0はこれより前なので何もしない
      2,
      () => {
        calls++;
        return clock.runFrameOnce();
      },
      () => {},
    );
    expect(result.ranFrames).toBe(0);
    expect(calls).toBe(0);
    expect(result.access).toEqual(noAccess());
    // 何もしなかった場合はnextAllowedAtMsInをそのまま持ち越す。
    expect(result.nextAllowedAtMs).toBe(100);
  });

  it('costMsが大きいほどnextAllowedAtMsが先になる(占有率の式が効いている)', () => {
    // budgetMsを変え、実際にかかる時間(costMs)を変えて比較する。
    const shortClock = makeClock(2);
    const shortResult = runUnlimitedTick(shortClock.now, 4, 0.5, 0, 2, () => shortClock.runFrameOnce(), () => {});
    const longClock = makeClock(2);
    const longResult = runUnlimitedTick(longClock.now, 20, 0.5, 0, 2, () => longClock.runFrameOnce(), () => {});
    expect(longResult.ranFrames).toBeGreaterThan(shortResult.ranFrames);
    expect(longResult.nextAllowedAtMs).toBeGreaterThan(shortResult.nextAllowedAtMs);
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

// 2026-09-04追加: 無制限モードのWorker経路にも既定経路(src/main.ts)と同じ
// frame event間引き(UNLIMITED_PRESENT_INTERVAL_MS)を入れる是正。既定経路との対称性を
// 保つため、Worker側も「このtickで提示するか」を判定する純粋関数を切り出してテストする
// (呼び出し側 src/core-worker.ts の tick() のコメント参照)。
describe('shouldPresentUnlimitedFrame(無制限モードのframe event間引き判定)', () => {
  it('lastPresentAtMsが0(まだ一度も出していない/直後にリセットされた)なら無条件でtrue', () => {
    expect(shouldPresentUnlimitedFrame(1000, 0, 33)).toBe(true);
  });

  it('陽性対照: 間隔未満(interval未満)ならfalseを返す(間引かれる)', () => {
    // 直近の提示から10msしか経っていない(33ms未満)。
    expect(shouldPresentUnlimitedFrame(1010, 1000, 33)).toBe(false);
  });

  it('間隔以上ならtrueを返す(提示してよい)', () => {
    expect(shouldPresentUnlimitedFrame(1033, 1000, 33)).toBe(true);
    expect(shouldPresentUnlimitedFrame(1500, 1000, 33)).toBe(true);
  });
});

// 2026-09-04追加: runUnlimitedTick()のpresentFinalFrame引数(既定true=従来どおり)。
// falseのときは「frame eventを出さないtickでもフレーム自体は回り続ける」ことを保証する
// (呼び出し元の frameNo は runFrameOnce() の呼び出し回数に比例して進むため、
// ranFrames/呼び出し回数がここでのfreameNo進行の代理指標になる)。
describe('runUnlimitedTick の presentFinalFrame引数(frame event間引き対象tickの映像スキップ)', () => {
  function makeClock(frameCostMs: number): { now: () => number; runFrameOnce: () => { fddReading: boolean; fddDrive: number; hddAccessing: boolean } } {
    let value = 0;
    return {
      now: () => value,
      runFrameOnce: () => {
        value += frameCostMs;
        return { fddReading: false, fddDrive: -1, hddAccessing: false };
      },
    };
  }

  it('presentFinalFrame=falseでも最後の保証フレームは必ず回る(frameNo相当の呼び出し回数が進む)', () => {
    const clock = makeClock(2);
    let calls = 0;
    const result = runUnlimitedTick(
      clock.now,
      0, // budgetMs(極端に小さくても最低1フレームは回る仕様、既存テストと同条件)
      1,
      0,
      2,
      () => {
        calls++;
        return clock.runFrameOnce();
      },
      () => {},
      false, // presentFinalFrame
    );
    expect(result.ranFrames).toBe(1);
    expect(calls).toBe(1);
  });

  it('presentFinalFrame=falseでは、setVideoSkip(false)が一度も呼ばれない(映像を作らない)', () => {
    const clock = makeClock(2);
    const skipCalls: boolean[] = [];
    runUnlimitedTick(
      clock.now,
      20,
      1,
      0,
      2,
      () => clock.runFrameOnce(),
      (skip) => skipCalls.push(skip),
      false, // presentFinalFrame
    );
    expect(skipCalls.length).toBeGreaterThan(0);
    expect(skipCalls.every((s) => s === true)).toBe(true);
  });

  it('陽性対照: presentFinalFrame=true(既定)では従来どおり最後にsetVideoSkip(false)が呼ばれる', () => {
    const clock = makeClock(2);
    const skipCalls: boolean[] = [];
    runUnlimitedTick(
      clock.now,
      20,
      1,
      0,
      2,
      () => clock.runFrameOnce(),
      (skip) => skipCalls.push(skip),
      true, // presentFinalFrame
    );
    expect(skipCalls[skipCalls.length - 1]).toBe(false);
  });
});

describe('runTick: 占有率ゲート(呼び出し元指摘の是正、2026-09-04追加)', () => {
  // 既定経路(src/main.ts loop())のFRAME_LOOP_MAX_DUTYゲートと同じ考え方をrunTick()自身に
  // 持ち込んだ。ゲートを効かせるのはcantKeepUp(1フレームの実測コスト>実時間1フレーム)の
  // ときだけで、追いついている通常時・倍速時は従来と完全に同じ経路を通ること(倍速を
  // 潰さないための線引き)。

  it('陽性対照: 追いついているとき(frameCostMsInが実時間1フレーム以下)は、ゲート引数の有無で回るフレーム数が変わらない', () => {
    const dt = FRAME_INTERVAL_60 * 5; // 遅れを取り戻す典型ケース
    const runFrameOnce = () => ({ fddReading: false, fddDrive: -1, hddAccessing: false });

    // ゲート引数を渡さない(＝ゲートが存在しなかった旧実装と同じ)呼び出し。
    const ungated = runTick(dt, FPS_60, 0, 1, runFrameOnce);

    // ゲート引数を渡すが、frameCostMsIn(1ms)は実時間1フレーム(1000/60≈16.7ms)より
    // 十分小さい=cantKeepUpが偽になるケース。nowは呼ばれるたびに時計を進めるが、
    // cantKeepUpが偽なのでゲート条件`(!cantKeepUp || ...)`は常にtrueのまま素通りするはず。
    let nowValue = 0;
    const gated = runTick(
      dt,
      FPS_60,
      0,
      1,
      runFrameOnce,
      () => (nowValue += 0.1),
      1, // frameCostMsIn(実時間1フレームよりずっと小さい)
      0,
      0.85,
    );

    expect(gated.ranFrames).toBe(ungated.ranFrames);
    expect(gated.accumulator).toBeCloseTo(ungated.accumulator, 10);
  });

  it('追いつけないとき(frameCostMsInが実時間1フレームより大きい)は、nextAllowedAtMsより前のtickでフレームを回さない', () => {
    const dt = FRAME_INTERVAL_60 * 5;
    let calls = 0;
    const runFrameOnce = () => {
      calls++;
      return { fddReading: false, fddDrive: -1, hddAccessing: false };
    };
    const realFrameMs = 1000 / FPS_60;

    const result = runTick(
      dt,
      FPS_60,
      0,
      1,
      runFrameOnce,
      () => 1000, // now(): tickStartが常に1000msを指す固定クロック
      realFrameMs * 2, // frameCostMsIn: 実時間1フレームより明らかに大きい(cantKeepUp=true)
      2000, // nextAllowedAtMsIn: nowより先の時刻なので、このtickはまだ許可されていない
      0.85,
    );

    expect(result.ranFrames).toBe(0);
    expect(calls).toBe(0);
    // ゲートで弾かれたtickはnextAllowedAtMsをそのまま持ち越す(変化しない)。
    expect(result.nextAllowedAtMs).toBe(2000);
  });

  it('追いつけない状態から回復すると(nextAllowedAtMsを過ぎたら)フレームが回り、次のnextAllowedAtMsが実測コストから再計算される', () => {
    const dt = FRAME_INTERVAL_60 * 5;
    const realFrameMs = 1000 / FPS_60;
    // nowは呼び出しごとに5msずつ進む擬似クロック(1回目の呼び出しがtickStart=0)。
    let nowValue = -5;
    const now = () => (nowValue += 5);
    let calls = 0;
    const runFrameOnce = () => {
      calls++;
      return { fddReading: false, fddDrive: -1, hddAccessing: false };
    };

    const result = runTick(
      dt,
      FPS_60,
      0,
      1,
      runFrameOnce,
      now,
      realFrameMs * 2, // cantKeepUp=true
      0, // nextAllowedAtMsIn: 過去(tickStart=0以下)なのでこのtickは許可される
      0.85,
    );

    expect(result.ranFrames).toBeGreaterThan(0);
    expect(calls).toBe(result.ranFrames);
    // cantKeepUpかつ1フレーム以上回った場合、nextAllowedAtMsはtickStart基準で
    // 実測コストから再計算される(0より大きい新しい値になる)。
    expect(result.nextAllowedAtMs).toBeGreaterThan(0);
  });
});
