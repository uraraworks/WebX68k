import { describe, expect, it } from 'vitest';
import { LONG_PRESS_MS, TAP_MAX_MS, TAP_SLOP_PX, TouchMouse, TWO_FINGER_TAP_MAX_MS, type TouchMouseButton } from '../src/touch-mouse';

// TouchMouse は src/touch-mouse.ts に切り出した DOM 非依存のジェスチャ認識(トラックパッド式の
// 相対移動専用)。タッチ実機(iOS Safari)でしか本物のポインタ列を再現できないため、イベント列を
// 引数として渡せる形にしてここで検証する(platform.ts と同じ切り出し方針)。

interface Recorded {
  deltas: Array<[number, number]>;
  downs: TouchMouseButton[];
  ups: TouchMouseButton[];
  taps: TouchMouseButton[];
}

function makeRecorder(): { rec: Recorded; tm: TouchMouse } {
  const rec: Recorded = { deltas: [], downs: [], ups: [], taps: [] };
  const tm = new TouchMouse({
    moveBy: (dx, dy) => rec.deltas.push([dx, dy]),
    buttonDown: (b) => rec.downs.push(b),
    buttonUp: (b) => rec.ups.push(b),
    tap: (b) => rec.taps.push(b),
  });
  return { rec, tm };
}

describe('タッチマウスのジェスチャ認識(src/touch-mouse.ts、トラックパッド式)', () => {
  it('接地ではカーソルを動かさない(moveByは出ない)', () => {
    const { rec, tm } = makeRecorder();
    tm.pointerDown(1, 100, 50, 0);
    expect(rec.deltas).toEqual([]);
  });

  it('スロップを超えてからの指の移動が差分(moveBy)になる(超えた瞬間は始点からの累積)', () => {
    const { rec, tm } = makeRecorder();
    tm.pointerDown(1, 100, 50, 0);
    tm.pointerMove(1, 120, 45); // スロップ超え: 始点からの累積(20,-5)をまとめて送る
    tm.pointerMove(1, 140, 45); // 以降は前回との差分
    expect(rec.deltas).toEqual([
      [20, -5],
      [20, 0],
    ]);
  });

  it('スロップ以内の微動ではカーソルを動かさない(タップのたびに標的からずれない)', () => {
    const { rec, tm } = makeRecorder();
    tm.pointerDown(1, 100, 50, 0);
    tm.pointerMove(1, 100 + TAP_SLOP_PX - 2, 50);
    tm.pointerUp(1, 100);
    expect(rec.deltas).toEqual([]);
    expect(rec.taps).toEqual(['left']); // タップとしても成立する
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
    tm.pointerMove(1, 100 + TAP_SLOP_PX * 2, 50); // スロップ超え
    tm.pointerMove(1, 100, 50); // 始点へ戻る
    tm.pointerUp(1, 100);
    expect(rec.taps).toEqual([]);
    // カーソル移動としては機能している(スロップ超え時の累積+戻る移動の2回ぶん)
    expect(rec.deltas.length).toBe(2);
  });

  it('タップは左クリック、2本指タップは右クリック', () => {
    const { rec, tm } = makeRecorder();
    tm.pointerDown(1, 100, 50, 0);
    tm.pointerUp(1, 80);
    tm.pointerDown(2, 100, 50, 200);
    tm.pointerDown(3, 140, 50, 220);
    tm.pointerUp(2, 300);
    tm.pointerUp(3, 320);
    expect(rec.taps).toEqual(['left', 'right']);
  });

  it('2本指タップは右クリック(カーソルは2本目に反応しない)', () => {
    const { rec, tm } = makeRecorder();
    tm.pointerDown(1, 100, 50, 0);
    tm.pointerDown(2, 140, 50, 30);
    const deltasBefore = rec.deltas.length;
    tm.pointerMove(2, 142, 50);
    expect(rec.deltas.length).toBe(deltasBefore);
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

  it('2本目の指はカーソルを動かさない', () => {
    const { rec, tm } = makeRecorder();
    tm.pointerDown(1, 100, 50, 0);
    tm.pointerDown(2, 200, 50, 20);
    tm.pointerMove(2, 220, 60);
    expect(rec.deltas).toEqual([]);
  });

  it('連続タップ(ダブルクリック相当)は2回のタップとして通知する', () => {
    const { rec, tm } = makeRecorder();
    tm.pointerDown(1, 100, 50, 0);
    tm.pointerUp(1, 80);
    tm.pointerDown(2, 101, 51, 150);
    tm.pointerUp(2, 230);
    expect(rec.taps).toEqual(['left', 'left']);
  });

  it('長押しで左ボタンを押し込み、離すと解放(ドラッグ)。押し込み中の移動は差分で届く', () => {
    const { rec, tm } = makeRecorder();
    tm.pointerDown(1, 100, 50, 0);
    tm.update(LONG_PRESS_MS - 10);
    expect(rec.downs).toEqual([]);
    tm.update(LONG_PRESS_MS + 10);
    expect(rec.downs).toEqual(['left']);
    tm.pointerMove(1, 90, 70); // スロップ(12px)超えの移動なので届く(押し込んだままカーソルを運ぶ=ドラッグ)
    expect(rec.deltas).toEqual([[-10, 20]]);
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
});
