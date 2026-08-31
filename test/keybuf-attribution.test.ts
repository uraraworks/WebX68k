// src/keybuf-attribution.ts の純粋ロジックの単体テスト(docs/STORAGE-SCSI.md「帰属の定義」参照)。
// Worker経路(src/core-worker.ts)と既定経路(src/libretro-host.ts/src/main.ts)の両方が
// この関数を通して同じ定義を共有していることの土台になるテストなので、
// 「writePointerが動いたときだけ更新する」「動いていない間はstickyに保持する」
// 「フレーム差分はnullを正しく伝播する」という3点を重点的に確認する。
import { describe, expect, it } from 'vitest';
import {
  computeAttributionBreakdown,
  frameDelta,
  initialTrackerState,
  trackKeyBufWrite,
  type KeyBufWriteTrackerState,
} from '../src/keybuf-attribution';

describe('initialTrackerState', () => {
  it('lastWritePointer=-1(まだ一度もチェックしていない)、writeFrameNo=nullで始まる', () => {
    expect(initialTrackerState()).toEqual({ lastWritePointer: -1, writeFrameNo: null });
  });
});

describe('trackKeyBufWrite', () => {
  it('初回チェックでwritePointerが0であっても、-1(未チェック)とは異なるため書き込みとして検出する', () => {
    const state = trackKeyBufWrite(initialTrackerState(), 0, 5);
    expect(state).toEqual({ lastWritePointer: 0, writeFrameNo: 5 });
  });

  it('writePointerが変化したフレームをwriteFrameNoとして記録する', () => {
    let state = initialTrackerState();
    state = trackKeyBufWrite(state, 3, 1);
    expect(state.writeFrameNo).toBe(1);
    state = trackKeyBufWrite(state, 5, 2);
    expect(state).toEqual({ lastWritePointer: 5, writeFrameNo: 2 });
  });

  it('writePointerが変化していないフレームでは直前のwriteFrameNoをsticky(そのまま保持)する', () => {
    let state = initialTrackerState();
    state = trackKeyBufWrite(state, 5, 2);
    state = trackKeyBufWrite(state, 5, 3);
    state = trackKeyBufWrite(state, 5, 4);
    expect(state.writeFrameNo).toBe(2); // 動いていないので3・4ではなく2のまま
  });

  it('リング境界で127→0へ折り返しても「変化」として検出する(値の大小でなく不一致で判定)', () => {
    let state = initialTrackerState();
    state = trackKeyBufWrite(state, 127, 10);
    state = trackKeyBufWrite(state, 0, 11);
    expect(state).toEqual({ lastWritePointer: 0, writeFrameNo: 11 });
  });

  it('副作用を持たない(渡したstateオブジェクト自体は変更しない)', () => {
    const before: KeyBufWriteTrackerState = { lastWritePointer: 1, writeFrameNo: 9 };
    const snapshot = { ...before };
    trackKeyBufWrite(before, 2, 10);
    expect(before).toEqual(snapshot);
  });
});

describe('frameDelta', () => {
  it('両方とも数値なら単純な差を返す', () => {
    expect(frameDelta(10, 7)).toBe(3);
    expect(frameDelta(7, 10)).toBe(-3);
    expect(frameDelta(5, 5)).toBe(0);
  });

  it('laterFrameNoがnullなら計算不能としてnullを返す(0と未検出を混同しない)', () => {
    expect(frameDelta(null, 3)).toBeNull();
  });

  it('earlierFrameNoがundefinedなら計算不能としてnullを返す', () => {
    expect(frameDelta(3, undefined)).toBeNull();
  });

  it('両方nullでもnullを返す', () => {
    expect(frameDelta(null, null)).toBeNull();
  });
});

// computeAttributionBreakdown: 2026-08-31再訂正(「帰属の定義の誤りと訂正」参照)。
// 旧定義(writeFrameNo - inputSendFrameNo)は、Worker経路ではinputSendFrameNoがmain視点の
// 古い値であり、既定経路の「同一スレッド上の生きた値」と同じ量を測っていなかった。
// applyFrameNo(実際に適用された瞬間の、単一クロック上のframeNo)を挟んで
// trueInjectionFrames(=writeFrameNo-applyFrameNo、両経路で直接比較できる量)と
// transmissionStalenessFrames(=applyFrameNo-inputSendFrameNo、mainの古い視点が混じる量)に
// 分解できることを確認する。
describe('computeAttributionBreakdown', () => {
  it('既定経路相当(inputSendFrameNo===applyFrameNo)ではtransmissionStalenessFramesが常に0になる', () => {
    // 既定経路は送信と適用が同一呼び出しの中で起きるため、inputSendFrameNoとapplyFrameNoは
    // 常に同値になる(src/main.ts applyKey()参照)。
    const result = computeAttributionBreakdown(5, 5, 6);
    expect(result.trueInjectionFrames).toBe(1); // writeFrameNo(6) - applyFrameNo(5)
    expect(result.transmissionStalenessFrames).toBe(0); // applyFrameNo(5) - inputSendFrameNo(5)
  });

  it('Worker経路相当(inputSendFrameNo<applyFrameNo、mainが古く見ていた分)を正しく2分割する', () => {
    // mainが送信時に知っていたframeNo=10、Workerが実際に適用した時点の生きたframeNo=13
    // (mainの視点が3フレーム古かった)、KeyBufに書かれたのはその1フレーム後の14。
    const result = computeAttributionBreakdown(10, 13, 14);
    expect(result.trueInjectionFrames).toBe(1); // 14 - 13 (既定経路の1と直接比較できる量)
    expect(result.transmissionStalenessFrames).toBe(3); // 13 - 10 (陳腐化分。実時間ではない)
    // 旧定義(writeFrameNo - inputSendFrameNo = 14 - 10 = 4)は2つの量の合算であり、
    // どちらの成分か区別できていなかったことを確認する。
    expect(frameDelta(14, 10)).toBe(4);
    expect(result.trueInjectionFrames! + result.transmissionStalenessFrames!).toBe(4);
  });

  it('いずれかがnull/undefinedなら対応する結果もnullを返す(0と未検出を混同しない)', () => {
    expect(computeAttributionBreakdown(null, 5, 6)).toEqual({
      trueInjectionFrames: 1,
      transmissionStalenessFrames: null,
    });
    expect(computeAttributionBreakdown(5, undefined, 6)).toEqual({
      trueInjectionFrames: null,
      transmissionStalenessFrames: null,
    });
    expect(computeAttributionBreakdown(5, 6, null)).toEqual({
      trueInjectionFrames: null,
      transmissionStalenessFrames: 1,
    });
  });

  it('故障注入: trueInjectionFramesの計算にapplyFrameNoでなくinputSendFrameNoを誤用すると、上の「Worker経路相当」テストが落ちる', () => {
    // 実装がtrueInjectionFrames = frameDelta(writeFrameNo, inputSendFrameNo)(旧定義への
    // 先祖返り)になっていないかを、この関数自体で確認する陽性対照。
    const buggyBreakdown = (
      inputSendFrameNo: number | null | undefined,
      applyFrameNo: number | null | undefined,
      writeFrameNo: number | null | undefined,
    ) => ({
      trueInjectionFrames: frameDelta(writeFrameNo, inputSendFrameNo), // 誤り: applyFrameNoを使っていない
      transmissionStalenessFrames: frameDelta(applyFrameNo, inputSendFrameNo),
    });
    const buggy = buggyBreakdown(10, 13, 14);
    expect(buggy.trueInjectionFrames).toBe(4); // 正しい実装なら1になるはずの値
    expect(buggy.trueInjectionFrames).not.toBe(computeAttributionBreakdown(10, 13, 14).trueInjectionFrames);
  });
});
