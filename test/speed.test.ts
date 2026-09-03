import { describe, expect, it } from 'vitest';
import {
  createResampleState,
  DEFAULT_SPEED_STEP,
  parseSpeedSetting,
  parseSpeedStep,
  resampleSpeed,
  SPEED_STEPS,
  type ResampleState,
} from '../src/speed';

/** L=フレーム番号, R=-フレーム番号 の単純な interleaved ステレオ列を作る(値から由来フレームが分かる)。 */
function makeChunk(startFrame: number, frames: number): Float32Array {
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    out[i * 2] = startFrame + i;
    out[i * 2 + 1] = -(startFrame + i);
  }
  return out;
}

/**
 * 最適化前(事前確保なし・frameAt()のタプル返し・number[]へのpush)のリファレンス実装。
 * アロケーションを撒く最適化前バージョンと同じ計算を行い、最適化後の resampleSpeed が
 * 1サンプルも数値を変えていないことを検証するために使う。
 */
function referenceResample(input: Float32Array, k: number, state: ResampleState): Float32Array {
  const framesIn = input.length >> 1;
  if (framesIn === 0) return input;
  if (k === 1) {
    state.phase = 0;
    state.lastFrame = [input[input.length - 2], input[input.length - 1]];
    return input;
  }
  const frameAt = (i: number): readonly [number, number] => {
    if (i < 0) return state.lastFrame ?? [input[0], input[1]];
    return [input[i * 2], input[i * 2 + 1]];
  };
  const out: number[] = [];
  let pos = state.phase;
  while (Math.floor(pos) < framesIn - 1) {
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const [l0, r0] = frameAt(i0);
    const [l1, r1] = frameAt(i0 + 1);
    out.push(l0 + (l1 - l0) * frac, r0 + (r1 - r0) * frac);
    pos += k;
  }
  state.phase = pos - framesIn;
  state.lastFrame = [input[framesIn * 2 - 2], input[framesIn * 2 - 1]];
  return Float32Array.from(out);
}

describe('SPEED_STEPS', () => {
  it('100%(1)を含まない7段階(速度ボタンOFF時が100%のため)', () => {
    expect(SPEED_STEPS).toEqual([0.25, 0.5, 0.75, 1.5, 2, 3, 4]);
    expect(SPEED_STEPS).not.toContain(1);
  });
});

describe('parseSpeedStep', () => {
  it('SPEED_STEPS内の値はそのまま返す', () => {
    expect(parseSpeedStep('0.25')).toBe(0.25);
    expect(parseSpeedStep('4')).toBe(4);
  });

  it('不正な値(SPEED_STEPSに無い値・NaN)はDEFAULT_SPEED_STEPへフォールバックする', () => {
    expect(parseSpeedStep('1')).toBe(DEFAULT_SPEED_STEP);
    expect(parseSpeedStep('not-a-number')).toBe(DEFAULT_SPEED_STEP);
    expect(parseSpeedStep('')).toBe(DEFAULT_SPEED_STEP);
  });

  it('DEFAULT_SPEED_STEPはSPEED_STEPSに含まれる値である', () => {
    expect(SPEED_STEPS).toContain(DEFAULT_SPEED_STEP);
  });
});

describe('parseSpeedSetting', () => {
  it('"unlimited"はそのまま返す', () => {
    expect(parseSpeedSetting('unlimited')).toBe('unlimited');
  });

  it('SPEED_STEPS内の値はparseSpeedStepと同じ結果を返す', () => {
    expect(parseSpeedSetting('2')).toBe(2);
  });

  it('不正な値はDEFAULT_SPEED_STEPへフォールバックする', () => {
    expect(parseSpeedSetting('not-a-number')).toBe(DEFAULT_SPEED_STEP);
  });
});

describe('resampleSpeed', () => {
  it('k=1では入力がそのまま返る(バイパス)', () => {
    const input = makeChunk(0, 10);
    const state = createResampleState();
    const out = resampleSpeed(input, 1, state);
    expect(out).toBe(input);
  });

  it('k=2では出力フレーム数がほぼ半分になる', () => {
    const input = makeChunk(0, 100);
    const state = createResampleState();
    const out = resampleSpeed(input, 2, state);
    const framesOut = out.length / 2;
    expect(framesOut).toBeGreaterThanOrEqual(48);
    expect(framesOut).toBeLessThanOrEqual(50);
  });

  it('k=0.5では出力フレーム数がほぼ倍になる', () => {
    const input = makeChunk(0, 100);
    const state = createResampleState();
    const out = resampleSpeed(input, 0.5, state);
    const framesOut = out.length / 2;
    expect(framesOut).toBeGreaterThanOrEqual(198);
    expect(framesOut).toBeLessThanOrEqual(200);
  });

  it('チャンクをまたいでも位相が連続する(分割しても一括処理と同じ結果になる)', () => {
    const k = 2;
    const whole = makeChunk(0, 200);

    const wholeState = createResampleState();
    const wholeOut = resampleSpeed(whole, k, wholeState);

    const chunkA = makeChunk(0, 70);
    const chunkB = makeChunk(70, 130);
    const splitState = createResampleState();
    const outA = resampleSpeed(chunkA, k, splitState);
    const outB = resampleSpeed(chunkB, k, splitState);
    const splitOut = new Float32Array(outA.length + outB.length);
    splitOut.set(outA, 0);
    splitOut.set(outB, outA.length);

    expect(splitOut.length).toBe(wholeOut.length);
    for (let i = 0; i < wholeOut.length; i++) {
      expect(splitOut[i]).toBeCloseTo(wholeOut[i], 6);
    }
  });

  it('チャンク境界をまたぐ補間は前チャンク末尾フレームを保持して連続する', () => {
    // frame4(チャンクA末尾)とframe5(チャンクBの先頭)の間を補間するケースを作る。
    const chunkA = makeChunk(0, 5); // frames 0..4
    const chunkB = makeChunk(5, 5); // frames 5..9
    const state = createResampleState();
    // k=1.5: 位置 0, 1.5, 3, 4.5(=frame4と5の間, frac=0.5) ... とチャンクAをまたぐ位置が出る
    const outA = resampleSpeed(chunkA, 1.5, state);
    const outB = resampleSpeed(chunkB, 1.5, state);
    // 直前フレーム(frame4)が保持されていなければ計算できない値。落ちずに連続して出力されることを確認する。
    expect(outA.length).toBeGreaterThan(0);
    expect(outB.length).toBeGreaterThan(0);
    // 全出力のL値は単調増加(補間元が単調増加列のため)であるはず
    const all = [...outA, ...outB];
    const lValues = all.filter((_, i) => i % 2 === 0);
    for (let i = 1; i < lValues.length; i++) {
      expect(lValues[i]).toBeGreaterThanOrEqual(lValues[i - 1]);
    }
  });

  describe('最適化(事前確保+インデックス書き込み)は最適化前と1サンプルも結果を変えない', () => {
    const chunkSizes = [70, 130, 41, 3, 256];

    for (const k of [0.25, 0.5, 2, 3]) {
      it(`k=${k}: チャンクをまたいでもリファレンス実装と完全一致する`, () => {
        const optState = createResampleState();
        const refState = createResampleState();
        let frame = 0;
        for (const size of chunkSizes) {
          const chunk = makeChunk(frame, size);
          frame += size;
          // リファレンス実装は状態を書き換えるので、比較用に別々のFloat32Arrayを渡す
          // (同じ配列でも読み取りのみなので問題ないが、意図を明確にするため複製する)。
          const optOut = resampleSpeed(chunk.slice(), k, optState);
          const refOut = referenceResample(chunk.slice(), k, refState);

          expect(optOut.length).toBe(refOut.length);
          for (let i = 0; i < refOut.length; i++) {
            expect(optOut[i]).toBe(refOut[i]);
          }
          expect(optState.phase).toBeCloseTo(refState.phase, 10);
        }
      });
    }
  });
});
