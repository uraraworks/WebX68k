import { describe, expect, it } from 'vitest';
import {
  LONG_PRESS_MS,
  TAP_MAX_MS,
  TAP_SLOP_PX,
  TouchMouse,
  TWO_FINGER_TAP_MAX_MS,
  type TouchMouseButton,
} from '../src/touch-mouse';

// TouchMouse は src/touch-mouse.ts に切り出した DOM 非依存のジェスチャ認識。
// タッチ実機(iOS Safari)でしか本物のポインタ列を再現できないため、イベント列を
// 引数として渡せる形にしてここで検証する(platform.ts と同じ切り出し方針)。

interface Recorded {
  moves: Array<[number, number]>;
  downs: TouchMouseButton[];
  ups: TouchMouseButton[];
  taps: TouchMouseButton[];
}

function makeRecorder(): { rec: Recorded; tm: TouchMouse } {
  const rec: Recorded = { moves: [], downs: [], ups: [], taps: [] };
  const tm = new TouchMouse({
    moveTo: (x, y) => rec.moves.push([x, y]),
    buttonDown: (b) => rec.downs.push(b),
    buttonUp: (b) => rec.ups.push(b),
    tap: (b) => rec.taps.push(b),
  });
  return { rec, tm };
}

describe('タッチマウスのジェスチャ認識(src/touch-mouse.ts)', () => {
  it('接地した瞬間にカーソルが目標位置へ向かう(タップ時に移動→クリックの順序を作る)', () => {
    const { rec, tm } = makeRecorder();
    tm.pointerDown(1, 100, 50, 0);
    expect(rec.moves).toEqual([[100, 50]]);
  });

  it('短いタップは左クリック', () => {
    const { rec, tm } = makeRecorder();
    tm.pointerDown(1, 100, 50, 0);
    tm.pointerUp(1, TAP_MAX_MS - 50);
    expect(rec.taps).toEqual(['left']);
    expect(rec.downs).toEqual([]);
  });

  it('接地時間がTAP_MAX_MSを超えたらタップにしない', () => {
    const { rec, tm } = makeRecorder();
    tm.pointerDown(1, 100, 50, 0);
    tm.pointerUp(1, TAP_MAX_MS + 50);
    expect(rec.taps).toEqual([]);
  });

  it('スロップを超えて動いたらタップにしない(始点へ戻ってきても同じ)', () => {
    const { rec, tm } = makeRecorder();
    tm.pointerDown(1, 100, 50, 0);
    tm.pointerMove(1, 100 + TAP_SLOP_PX * 2, 50);
    tm.pointerMove(1, 100, 50); // 始点へ戻る
    tm.pointerUp(1, 100);
    expect(rec.taps).toEqual([]);
    // カーソル移動としては機能している
    expect(rec.moves.length).toBe(3);
  });

  it('スロップ以内の指の震えはタップのまま', () => {
    const { rec, tm } = makeRecorder();
    tm.pointerDown(1, 100, 50, 0);
    tm.pointerMove(1, 100 + TAP_SLOP_PX - 2, 50);
    tm.pointerUp(1, 100);
    expect(rec.taps).toEqual(['left']);
  });

  it('2本指タップは右クリック(カーソルは2本目に反応しない)', () => {
    const { rec, tm } = makeRecorder();
    tm.pointerDown(1, 100, 50, 0);
    tm.pointerDown(2, 140, 50, 30);
    const movesBefore = rec.moves.length;
    tm.pointerMove(2, 142, 50);
    expect(rec.moves.length).toBe(movesBefore);
    tm.pointerUp(1, 120);
    tm.pointerUp(2, 150);
    expect(rec.taps).toEqual(['right']);
  });

  it('2本目の接地から離すまでが遅い2本指はタップにしない', () => {
    const { rec, tm } = makeRecorder();
    tm.pointerDown(1, 100, 50, 0);
    tm.pointerDown(2, 140, 50, 30);
    tm.pointerUp(1, 100);
    tm.pointerUp(2, 30 + TWO_FINGER_TAP_MAX_MS + 50);
    expect(rec.taps).toEqual([]);
  });

  it('2本指のどちらかが動いたら右クリックにしない(先に離れた指の移動も忘れない)', () => {
    const { rec, tm } = makeRecorder();
    tm.pointerDown(1, 100, 50, 0);
    tm.pointerDown(2, 140, 50, 20);
    tm.pointerMove(2, 140 + TAP_SLOP_PX * 2, 50);
    tm.pointerUp(2, 60); // 動いた2本目が先に離れる
    tm.pointerUp(1, 100);
    expect(rec.taps).toEqual([]);
  });

  it('長押しで左ボタンを押し込み、離すと解放(ドラッグ)', () => {
    const { rec, tm } = makeRecorder();
    tm.pointerDown(1, 100, 50, 0);
    tm.update(LONG_PRESS_MS - 10);
    expect(rec.downs).toEqual([]);
    tm.update(LONG_PRESS_MS + 10);
    expect(rec.downs).toEqual(['left']);
    tm.pointerMove(1, 160, 90); // 押し込んだままカーソルを運ぶ = ドラッグ
    tm.pointerUp(1, LONG_PRESS_MS + 500);
    expect(rec.ups).toEqual(['left']);
    expect(rec.taps).toEqual([]); // ドラッグはタップにしない
  });

  it('動かした後は長押しにしない(移動のつもりの指を押し込まない)', () => {
    const { rec, tm } = makeRecorder();
    tm.pointerDown(1, 100, 50, 0);
    tm.pointerMove(1, 100 + TAP_SLOP_PX * 2, 50);
    tm.update(LONG_PRESS_MS + 100);
    expect(rec.downs).toEqual([]);
  });

  it('2本指になったら長押しにしない', () => {
    const { rec, tm } = makeRecorder();
    tm.pointerDown(1, 100, 50, 0);
    tm.pointerDown(2, 140, 50, 30);
    tm.update(LONG_PRESS_MS + 100);
    expect(rec.downs).toEqual([]);
  });

  it('ドラッグ中に触れた追加の指は無視する(掌の接触事故)', () => {
    const { rec, tm } = makeRecorder();
    tm.pointerDown(1, 100, 50, 0);
    tm.update(LONG_PRESS_MS + 10);
    tm.pointerDown(2, 200, 100, LONG_PRESS_MS + 50);
    tm.pointerUp(1, LONG_PRESS_MS + 200);
    expect(rec.downs).toEqual(['left']);
    expect(rec.ups).toEqual(['left']);
    expect(rec.taps).toEqual([]);
  });

  it('reset()はドラッグ中のボタンを必ず解放する(pointercancel対策)', () => {
    const { rec, tm } = makeRecorder();
    tm.pointerDown(1, 100, 50, 0);
    tm.update(LONG_PRESS_MS + 10);
    tm.reset();
    expect(rec.ups).toEqual(['left']);
    // reset後は新しいストロークを普通に受け付ける
    tm.pointerDown(3, 10, 10, 1000);
    tm.pointerUp(3, 1050);
    expect(rec.taps).toEqual(['left']);
  });

  it('連続タップ(ダブルクリック相当)は2回のタップとして通知する', () => {
    const { rec, tm } = makeRecorder();
    tm.pointerDown(1, 100, 50, 0);
    tm.pointerUp(1, 80);
    tm.pointerDown(2, 101, 51, 150);
    tm.pointerUp(2, 230);
    expect(rec.taps).toEqual(['left', 'left']);
  });
});
