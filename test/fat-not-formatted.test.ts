import { beforeAll, describe, expect, it } from 'vitest';
import { DiskError, openDiskImage } from '../src/api/fat.ts';

// strings.ts はモジュール初期化時に resolveLang() → location.search を参照するため、
// Node環境(vitest environment: 'node')には無い location をここで用意してから
// dynamic import する。setLang/describeError は静的import時点の値ではなく
// 呼び出し時のcurrentLangを見るため、importのタイミング自体は問題にならない。
let setLang: (typeof import('../src/strings.ts'))['setLang'];
let describeError: (typeof import('../src/strings.ts'))['describeError'];

beforeAll(async () => {
  if (typeof (globalThis as { location?: unknown }).location === 'undefined') {
    (globalThis as { location?: { search: string } }).location = { search: '' };
  }
  ({ setLang, describeError } = await import('../src/strings.ts'));
});

describe('未フォーマットディスクを開いたときのエラー', () => {
  it('openDiskImageはDiskError(code=notFormatted)を投げる', () => {
    // ゼロ埋めイメージ = BPBのbytesPerSectorが0になり、FATボリュームとして読めない。
    const image = new Uint8Array(2 * 1024 * 1024);

    let thrown: unknown;
    try {
      openDiskImage(image, 'blank.hdf');
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(DiskError);
    expect((thrown as DiskError).code).toBe('notFormatted');
    // 開発者向けの原因はmessageにそのまま残す。
    expect((thrown as DiskError).message).toContain('invalid BPB (bytes/sector=0)');
  });

  it('describeErrorはユーザー向けの案内文(未フォーマット)を返す', () => {
    const image = new Uint8Array(2 * 1024 * 1024);

    let thrown: unknown;
    try {
      openDiskImage(image, 'blank.hdf');
    } catch (e) {
      thrown = e;
    }

    setLang('ja');
    expect(describeError(thrown)).toContain('未フォーマット');

    setLang('en');
    expect(describeError(thrown)).toContain('unformatted');
  });
});
