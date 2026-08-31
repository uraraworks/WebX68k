// sliceKeyBufSnapshot(src/keybuf-probe.ts)の単体テスト(docs/STORAGE-SCSI.md
// 「KeyBufプローブのWorker対応」参照)。Worker経路のframe event相乗り方式で送られてくる
// 128バイト全体のスナップショットから、既定経路のLibretroHost.readKeyBufWindow(start, count)
// と同じ添字の意味(リングなのでstart+iを128で剰余)を再現できているかを検証する。
import { describe, expect, it } from 'vitest';
import type { KeyBufFrameProbe } from '../src/core-protocol';
import { sliceKeyBufSnapshot } from '../src/keybuf-probe';

function makeSnapshot(writePointer: number): KeyBufFrameProbe {
  // bytes[i] = i とし、切り出し結果からどのindexが選ばれたかを直接読み取れるようにする。
  return { writePointer, bytes: Array.from({ length: 128 }, (_, i) => i) };
}

describe('sliceKeyBufSnapshot', () => {
  it('start=0から範囲内を素直に切り出す', () => {
    const result = sliceKeyBufSnapshot(makeSnapshot(5), 0, 4);
    expect(result).toEqual({ writePointer: 5, bytes: [0, 1, 2, 3] });
  });

  it('writePointerをsnapshot側の値のままそっくり返す(main受信時点の値)', () => {
    const result = sliceKeyBufSnapshot(makeSnapshot(42), 10, 1);
    expect(result.writePointer).toBe(42);
  });

  it('126から4バイトを要求するとリング境界をまたいで0..1へ折り返す', () => {
    // readKeyBufWindow(start, count) はpeek(start+i)をリングとして解釈するため、
    // 126,127,128,129 は 126,127,0,1 として読める必要がある。
    const result = sliceKeyBufSnapshot(makeSnapshot(0), 126, 4);
    expect(result.bytes).toEqual([126, 127, 0, 1]);
  });

  it('start=127から2バイトで境界をまたぐ', () => {
    const result = sliceKeyBufSnapshot(makeSnapshot(0), 127, 2);
    expect(result.bytes).toEqual([127, 0]);
  });

  it('start=128(1周ぶん超過)は0と同じ結果になる', () => {
    const a = sliceKeyBufSnapshot(makeSnapshot(0), 128, 5);
    const b = sliceKeyBufSnapshot(makeSnapshot(0), 0, 5);
    expect(a.bytes).toEqual(b.bytes);
  });

  it('startが負数でも非負のインデックスへ正しく折り返す(JSの%は符号を保つ罠を避ける)', () => {
    const result = sliceKeyBufSnapshot(makeSnapshot(0), -1, 2);
    expect(result.bytes).toEqual([127, 0]);
  });

  it('count=0は空配列を返す', () => {
    const result = sliceKeyBufSnapshot(makeSnapshot(3), 10, 0);
    expect(result).toEqual({ writePointer: 3, bytes: [] });
  });

  it('writePointer自身から2バイト読む典型パターン(measure-key.mjsの使い方)', () => {
    const snapshot = makeSnapshot(0);
    // measure-key.mjs は make byte を readKeyBuf(startWp, 1)、break byte を
    // readKeyBuf(startWp, 2) の bytes[1] で読む。ここでは値がindexと一致する
    // 合成スナップショットなので、返る値がそのままindexと一致するかを確認する。
    const startWp = 100;
    const makeProbe = sliceKeyBufSnapshot(snapshot, startWp, 1);
    expect(makeProbe.bytes).toEqual([100]);
    const breakProbe = sliceKeyBufSnapshot(snapshot, startWp, 2);
    expect(breakProbe.bytes).toEqual([100, 101]);
  });
});
