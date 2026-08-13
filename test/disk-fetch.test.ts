import { describe, expect, it } from 'vitest';
import { hostMatches, looksLikeHtml, PROXY_CAPABLE_HOSTS, shouldPreferProxy, urlHostname } from '../src/disk-fetch';

describe('urlHostname', () => {
  it('URLからホスト名を取り出す', () => {
    expect(urlHostname('https://drive.google.com/file/d/abc/view')).toBe('drive.google.com');
  });

  it('パース不可なら空文字を返す', () => {
    expect(urlHostname('not a url')).toBe('');
  });
});

describe('hostMatches', () => {
  it('完全一致する', () => {
    expect(hostMatches('dropbox.com', ['dropbox.com'])).toBe(true);
  });

  it('サブドメイン(.<entry>で終わる)にも一致する', () => {
    expect(hostMatches('www.dropbox.com', ['dropbox.com'])).toBe(true);
  });

  it('一致しないホストはfalse', () => {
    expect(hostMatches('example.com', ['dropbox.com', 'drive.google.com'])).toBe(false);
  });

  it('前方一致だけの偽陽性は起こさない(evildropbox.comはdropbox.comに一致しない)', () => {
    expect(hostMatches('evildropbox.com', ['dropbox.com'])).toBe(false);
  });
});

describe('shouldPreferProxy', () => {
  it.each(['https://drive.google.com/file/d/abc/view', 'https://docs.google.com/uc?id=abc', 'https://www.dropbox.com/s/abc/x.hdf?dl=1', 'https://dl.dropbox.com/s/abc/x.hdf'])(
    '中継が設定済みで共有ホスト(%s)なら直接fetchより中継を優先する',
    (url) => {
      expect(shouldPreferProxy(url, true)).toBe(true);
    },
  );

  it('中継が未設定なら共有ホストでも直接fetchを優先する(従来どおり)', () => {
    expect(shouldPreferProxy('https://drive.google.com/file/d/abc/view', false)).toBe(false);
  });

  it('共有ホスト以外(GitHub raw等)は中継が設定済みでも直接fetchを優先する', () => {
    expect(shouldPreferProxy('https://raw.githubusercontent.com/foo/bar/main/x.hdf', true)).toBe(false);
  });

  it('PROXY_CAPABLE_HOSTSに列挙されたホストで判定している', () => {
    expect(PROXY_CAPABLE_HOSTS).toEqual(
      expect.arrayContaining(['drive.google.com', 'docs.google.com', 'www.dropbox.com', 'dropbox.com']),
    );
  });
});

function bytesFrom(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('looksLikeHtml', () => {
  it('Content-Typeがtext/htmlならtrue', () => {
    expect(looksLikeHtml(new Uint8Array([0, 1, 2, 3]), 'text/html; charset=utf-8')).toBe(true);
  });

  it('Content-Typeが無くてもDOCTYPE宣言で始まるバイト列はtrue(Google Driveの共有ページ実測形)', () => {
    const html = '<!DOCTYPE html><html><head><title>Google Drive</title></head><body>...</body></html>';
    expect(looksLikeHtml(bytesFrom(html), null)).toBe(true);
  });

  it('<html>から始まるバイト列もtrue', () => {
    expect(looksLikeHtml(bytesFrom('<html><body>hi</body></html>'), undefined)).toBe(true);
  });

  it('先頭に空白/改行があってもtrue(trimしてから判定)', () => {
    expect(looksLikeHtml(bytesFrom('\n\n  <!DOCTYPE html><html></html>'), null)).toBe(true);
  });

  it('<?xml宣言で始まるバイト列もtrue', () => {
    expect(looksLikeHtml(bytesFrom('<?xml version="1.0"?><error>not found</error>'), null)).toBe(true);
  });

  it('大文字小文字を問わない', () => {
    expect(looksLikeHtml(bytesFrom('<HTML><BODY>hi</BODY></HTML>'), null)).toBe(true);
  });

  it('生のディスクイメージ(バイナリ)はfalse', () => {
    const bytes = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    expect(looksLikeHtml(bytes, 'application/octet-stream')).toBe(false);
  });

  it('全ゼロのブランクディスク相当のバイト列はfalse', () => {
    expect(looksLikeHtml(new Uint8Array(1024), null)).toBe(false);
  });
});
