// KeyBufプローブのWorker対応: 純粋ロジックだけを切り出したファイル(docs/STORAGE-SCSI.md
// 「KeyBufプローブのWorker対応」参照)。Worker からframe eventに相乗りさせて送られてきた
// KeyBuf全体のスナップショット(src/core-protocol.ts の KeyBufFrameProbe、index 0..127の
// 物理位置)から、既定経路の LibretroHost.readKeyBufWindow(start, count) と同じ添字の意味
// (リングなので start+i を128で剰余)で範囲を切り出す。
//
// wasm側の _webx68k_keybuf_peek(index) は呼び出し側がマスクしていない index
// (test/core-keyboard-integration.test.ts では peek(start + 1) のような呼び方をしている)を
// 内部でマスクして解釈する。ここでも呼び出し側(この関数)でマスクする形に揃え、
// readKeyBufWindow(start, count) と同じ結果になるようにする。

import type { KeyBufFrameProbe } from './core-protocol';

export interface KeyBufWindow {
  writePointer: number;
  bytes: number[];
}

const KEYBUF_SIZE = 128;

/** JavaScriptの % は負数に対して符号を保つため、常に非負の剰余にする。 */
function keyBufIndex(value: number): number {
  return ((value % KEYBUF_SIZE) + KEYBUF_SIZE) % KEYBUF_SIZE;
}

/**
 * snapshot(KeyBuf全体128バイト、index 0..127の物理位置)から、
 * readKeyBufWindow(start, count) と同じ意味の範囲を切り出す。
 * snapshot.bytes の長さが128でない場合(実装違反)は範囲外を undefined のまま返さず、
 * インデックス計算を snapshot.bytes.length を基準にはせず常に128固定で行う
 * (呼び出し元の契約: KeyBufFrameProbe は必ず128バイト)。
 */
export function sliceKeyBufSnapshot(
  snapshot: KeyBufFrameProbe,
  start: number,
  count: number,
): KeyBufWindow {
  const bytes: number[] = [];
  for (let i = 0; i < count; i++) {
    bytes.push(snapshot.bytes[keyBufIndex(start + i)]);
  }
  return { writePointer: snapshot.writePointer, bytes };
}
