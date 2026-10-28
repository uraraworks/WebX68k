import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';

it('送信済み画像が非表示後に届いても dupe 後の復帰画面に残る', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const start = source.indexOf("      if (snapshot.video.kind === 'rgba') {");
  const end = source.indexOf('      // 音声出力', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const receive = new Function('snapshot', 'canvas', 'rescale', 'document', 'ImageData', 'wctx', 'sharpView', 'workerCoreProxy', source.slice(start, end));
  const latest = new Uint8ClampedArray([255, 0, 0, 255]);
  let displayed = new Uint8ClampedArray([0, 0, 0, 255]);
  const document = { visibilityState: 'hidden' };
  const context = { putImageData: (image: { data: Uint8ClampedArray }) => { displayed = image.data.slice(); } };
  const ImageDataMock = class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} };
  const args = [{ width: 1, height: 1 }, vi.fn(), document, ImageDataMock, context, { present: vi.fn() }, { returnFrameBuffer: vi.fn() }] as const;
  receive({ video: { kind: 'rgba', bytes: latest.buffer, width: 1, height: 1 } }, ...args);
  receive({ video: { kind: 'dupe' } }, ...args);
  document.visibilityState = 'visible';
  receive({ video: { kind: 'dupe' } }, ...args);
  expect([...displayed]).toEqual([...latest]);
});
