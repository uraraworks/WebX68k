// src/keybuf-attribution.ts の純粋ロジックの単体テスト(docs/STORAGE-SCSI.md「帰属の定義」参照)。
// Worker経路(src/core-worker.ts)と既定経路(src/libretro-host.ts/src/main.ts)の両方が
// この関数を通して同じ定義を共有していることの土台になるテストなので、
// 「writePointerが動いたときだけ更新する」「動いていない間はstickyに保持する」
// 「フレーム差分はnullを正しく伝播する」という3点を重点的に確認する。
import { describe, expect, it } from 'vitest';
import { frameDelta, initialTrackerState, trackKeyBufWrite, type KeyBufWriteTrackerState } from '../src/keybuf-attribution';

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
