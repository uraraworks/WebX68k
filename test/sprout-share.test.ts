/*
 * Sprout68k の共有リンク(#p1=)を受け取る側の検証。
 *
 * 復号と .xdf 組み立ての実装(src/sprout-share.mts)は **Sprout68k の送信側と
 * まったく同じ正典**を tools/fetch-sprout-runtime.mjs が持ってきたもの。
 * 自前で書き直すと送信側と静かに食い違うため、ここで見るのは
 *   1. 持ってきた写しが、同梱した manifest の SHA-256 と一致すること
 *   2. その実装で、壊れた入力・版違いをきちんと弾くこと
 * の2点。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISK, assembleXdf, decodeShareFragment, encodeShareFragment,
  packUserPayload, tagLabel, unpackUserPayload,
} from '../src/sprout-share.mts';

const ROOT = resolve(__dirname, '..');
const RUNTIME_DIR = resolve(ROOT, 'public/sprout-runtime/v1');
const manifest = JSON.parse(readFileSync(resolve(RUNTIME_DIR, 'manifest.json'), 'utf8'));
const layout = { ...manifest.layout, ...DEFAULT_DISK };

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const deflate = (bytes: Uint8Array) => new Uint8Array(deflateRawSync(bytes, { level: 9 }));
const inflate = (bytes: Uint8Array) => new Uint8Array(inflateRawSync(bytes));

describe('同梱した Sprout68k ランタイム', () => {
  it('manifest の SHA-256 と一致する', () => {
    const runtime = new Uint8Array(readFileSync(resolve(RUNTIME_DIR, 'runtime.bin')));
    const boot = new Uint8Array(readFileSync(resolve(RUNTIME_DIR, 'boot.bin')));
    expect(runtime.length).toBe(manifest.runtime.size);
    expect(sha256(runtime)).toBe(manifest.runtime.sha256);
    expect(sha256(boot)).toBe(manifest.boot.sha256);
  });

  it('復号と組み立ての実装が、配布元の正典と1バイトも違わない', () => {
    const share = new Uint8Array(readFileSync(resolve(ROOT, 'src/sprout-share.mts')));
    expect(share.length).toBe(manifest.share.size);
    expect(sha256(share)).toBe(manifest.share.sha256);
  });
});

describe('共有リンクの受け取り', () => {
  const body = new Uint8Array(Array.from({ length: 512 }, (_, index) => (index * 31) & 0xff));

  it('URL から復元した利用者コードが元に戻る', async () => {
    const fragment = await encodeShareFragment('binary', packUserPayload(body, layout), deflate, ['ai']);
    const decoded = await decodeShareFragment(`#${fragment}`, inflate);
    expect(decoded.kind).toBe('binary');
    expect(decoded.tags).toEqual(['ai']);
    expect(Array.from(unpackUserPayload(decoded.bytes, layout))).toEqual(Array.from(body));
  });

  it('組み立てた .xdf が実機と同じ大きさになり、利用者コードの大きさで変わらない', () => {
    const runtime = new Uint8Array(readFileSync(resolve(RUNTIME_DIR, 'runtime.bin')));
    const boot = new Uint8Array(readFileSync(resolve(RUNTIME_DIR, 'boot.bin')));
    const small = assembleXdf(boot, runtime, packUserPayload(new Uint8Array(16), layout), layout);
    const large = assembleXdf(boot, runtime, packUserPayload(body, layout), layout);
    expect(small.image.length).toBe(1_261_568);
    // 大きさが変わるとブートセクタの読むセクタ数と食い違い、大きい作品だけ起動しなくなる。
    expect(large.sectorCount).toBe(small.sectorCount);
    expect(large.bodySize).toBe(small.bodySize);
  });

  it('壊れたペイロードを弾く（エミュレータへ渡さない）', () => {
    const payload = packUserPayload(body, layout);
    const brokenMagic = new Uint8Array(payload);
    brokenMagic[0] ^= 0xff;
    expect(() => unpackUserPayload(brokenMagic, layout)).toThrow();

    const brokenVersion = new Uint8Array(payload);
    brokenVersion[5] = 99;
    expect(() => unpackUserPayload(brokenVersion, layout)).toThrow();

    expect(() => unpackUserPayload(payload.subarray(0, payload.length - 1), layout)).toThrow();
  });

  it('知らないタグは表示しない（語彙が増えても古い版が壊れない）', () => {
    expect(tagLabel('ai')).toBeTruthy();
    expect(tagLabel('zzz')).toBeNull();
  });
});
