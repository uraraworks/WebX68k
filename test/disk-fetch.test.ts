import { describe, expect, it } from 'vitest';
import {
  hostMatches,
  looksLikeHtml,
  PROXY_CAPABLE_HOSTS,
  PROXY_ONLY_HOSTS,
  rewriteDropboxUrl,
  rewriteGithubBlobUrl,
  shouldPreferProxy,
  urlHostname,
} from '../src/disk-fetch';

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
  it.each(['https://drive.google.com/file/d/abc/view', 'https://docs.google.com/uc?id=abc'])(
    '中継が設定済みで共有ホスト(%s)なら直接fetchより中継を優先する',
    (url) => {
      expect(shouldPreferProxy(url, true)).toBe(true);
    },
  );

  it.each(['https://www.dropbox.com/s/abc/x.hdf?dl=1', 'https://dl.dropbox.com/s/abc/x.hdf'])(
    'Dropbox(%s)はホスト置換で直接取得できるため中継を優先しない',
    (url) => {
      expect(shouldPreferProxy(url, true)).toBe(false);
    },
  );

  it('中継が未設定なら共有ホストでも直接fetchを優先する(従来どおり)', () => {
    expect(shouldPreferProxy('https://drive.google.com/file/d/abc/view', false)).toBe(false);
  });

  it('共有ホスト以外(GitHub raw等)は中継が設定済みでも直接fetchを優先する', () => {
    expect(shouldPreferProxy('https://raw.githubusercontent.com/foo/bar/main/x.hdf', true)).toBe(false);
  });

  it('PROXY_ONLY_HOSTSに列挙されたホスト(Google Driveのみ)で判定している', () => {
    expect(PROXY_ONLY_HOSTS).toEqual(['drive.google.com', 'docs.google.com']);
    expect(hostMatches('www.dropbox.com', PROXY_ONLY_HOSTS)).toBe(false);
  });

  it('PROXY_CAPABLE_HOSTSは案内文言用にDropboxを含んだまま残る', () => {
    expect(PROXY_CAPABLE_HOSTS).toEqual(
      expect.arrayContaining(['drive.google.com', 'docs.google.com', 'www.dropbox.com', 'dropbox.com']),
    );
  });
});

describe('rewriteDropboxUrl', () => {
  it('www.dropbox.comをdl.dropboxusercontent.comへ置換する(/scl/fi/形式)', () => {
    expect(rewriteDropboxUrl('https://www.dropbox.com/scl/fi/abc/x.zip?rlkey=xyz&dl=0')).toBe(
      'https://dl.dropboxusercontent.com/scl/fi/abc/x.zip?rlkey=xyz&dl=0',
    );
  });

  it('rlkey等のクエリを保持する(落とすと権限エラーになるため)', () => {
    const result = rewriteDropboxUrl('https://www.dropbox.com/scl/fi/abc/x.zip?rlkey=xyz&dl=0');
    expect(new URL(result).searchParams.get('rlkey')).toBe('xyz');
  });

  it('dl=0のままでも置換する(dl=1への書き換えは不要)', () => {
    expect(rewriteDropboxUrl('https://www.dropbox.com/scl/fi/abc/x.zip?rlkey=xyz&dl=0')).toContain('dl=0');
  });

  it('www無しのdropbox.comも置換する', () => {
    expect(rewriteDropboxUrl('https://dropbox.com/s/abc/x.hdf')).toBe('https://dl.dropboxusercontent.com/s/abc/x.hdf');
  });

  it('既にdl.dropboxusercontent.comなら変化しない(冪等)', () => {
    const url = 'https://dl.dropboxusercontent.com/scl/fi/abc/x.zip?rlkey=xyz';
    expect(rewriteDropboxUrl(url)).toBe(url);
  });

  it('Google Driveは変化しない', () => {
    const url = 'https://drive.google.com/file/d/abc/view';
    expect(rewriteDropboxUrl(url)).toBe(url);
  });

  it('GitHubは変化しない', () => {
    const url = 'https://github.com/foo/bar/blob/main/x.hdf';
    expect(rewriteDropboxUrl(url)).toBe(url);
  });

  it('任意のURLは変化しない', () => {
    const url = 'https://example.com/some/path/x.hdf';
    expect(rewriteDropboxUrl(url)).toBe(url);
  });

  it('前方一致だけの偽陽性は起こさない(evildropbox.comは置換されない)', () => {
    const url = 'https://evildropbox.com/scl/fi/abc/x.zip';
    expect(rewriteDropboxUrl(url)).toBe(url);
  });

  it('パース不可な文字列は変化しない', () => {
    expect(rewriteDropboxUrl('not a url')).toBe('not a url');
  });
});

describe('rewriteGithubBlobUrl', () => {
  it('blob URLをraw.githubusercontent.comへ書き換える', () => {
    expect(rewriteGithubBlobUrl('https://github.com/foo/bar/blob/main/x.hdf')).toBe(
      'https://raw.githubusercontent.com/foo/bar/main/x.hdf',
    );
  });

  it('raw URLも同様に書き換える', () => {
    expect(rewriteGithubBlobUrl('https://github.com/foo/bar/raw/main/x.hdf')).toBe(
      'https://raw.githubusercontent.com/foo/bar/main/x.hdf',
    );
  });

  it('多階層パスも書き換わる', () => {
    expect(rewriteGithubBlobUrl('https://github.com/foo/bar/blob/main/disks/games/x.hdf')).toBe(
      'https://raw.githubusercontent.com/foo/bar/main/disks/games/x.hdf',
    );
  });

  it('ブランチ名にスラッシュを含まない前提でrefが1セグメントとして扱われる', () => {
    expect(rewriteGithubBlobUrl('https://github.com/foo/bar/blob/v1.2.3/x.hdf')).toBe(
      'https://raw.githubusercontent.com/foo/bar/v1.2.3/x.hdf',
    );
  });

  it('/releases/download/ は書き換わらない(Release assetはrawで取得できないため中継が必要)', () => {
    const url = 'https://github.com/foo/bar/releases/download/v1.0.0/x.hdf';
    expect(rewriteGithubBlobUrl(url)).toBe(url);
  });

  it('/releases/latest/download/ も書き換わらない', () => {
    const url = 'https://github.com/foo/bar/releases/latest/download/x.hdf';
    expect(rewriteGithubBlobUrl(url)).toBe(url);
  });

  it('github.com以外のホスト(Google Drive)は変化しない', () => {
    const url = 'https://drive.google.com/file/d/abc/view';
    expect(rewriteGithubBlobUrl(url)).toBe(url);
  });

  it('github.com以外のホスト(Dropbox)は変化しない', () => {
    const url = 'https://www.dropbox.com/s/abc/x.hdf?dl=1';
    expect(rewriteGithubBlobUrl(url)).toBe(url);
  });

  it('github.com以外のホスト(任意のURL)は変化しない', () => {
    const url = 'https://example.com/some/path/x.hdf';
    expect(rewriteGithubBlobUrl(url)).toBe(url);
  });

  it('既にraw.githubusercontent.comのURLは変化しない', () => {
    const url = 'https://raw.githubusercontent.com/foo/bar/main/x.hdf';
    expect(rewriteGithubBlobUrl(url)).toBe(url);
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
