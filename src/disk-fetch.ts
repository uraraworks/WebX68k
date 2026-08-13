// ディスクURL取得まわりの純粋関数群(main.ts から切り出し、単体テスト可能にする)。

/** URLのホスト名を取り出す。パース不可なら空文字を返す(呼び出し側は「一致なし」として扱う)。 */
export function urlHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function hostMatches(hostname: string, list: readonly string[]): boolean {
  return list.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

// 直接fetchしても共有ページのHTMLしか返らない(=生のファイルは絶対に返らない)ことが実測で
// 判明している配信元のホスト一覧(2026-08-13 curl実測: Google DriveのGoogleは、直接fetchに対して
// Originをechoした access-control-allow-origin を付け、共有ページのHTML(約122KB)を200で返す。
// CORSエラーにならないため「直接fetchが失敗したときだけ中継する」フォールバックが発動しない)。
// 中継(VITE_DISK_PROXY)が設定されている場合、これらのURLは直接fetchを試さず最初から中継を使う
// (中継サーバ側が /file/d/<ID>/view のような共有URLを実ダウンロードURLへ正規化しているため)。
export const PROXY_CAPABLE_HOSTS = ['drive.google.com', 'docs.google.com', 'www.dropbox.com', 'dropbox.com'];

/**
 * 直接fetchを試さず最初から中継を使うべきかどうかを判定する。
 * 中継(hasProxy)が未設定の場合は常にfalse(従来どおり直接fetchのみを試し、失敗時のみ案内する)。
 */
export function shouldPreferProxy(url: string, hasProxy: boolean): boolean {
  if (!hasProxy) return false;
  return hostMatches(urlHostname(url), PROXY_CAPABLE_HOSTS);
}

// github.com の blob/raw URL(https://github.com/<owner>/<repo>/(blob|raw)/<ref>/<path...>)を
// マッチさせる。第3セグメントが blob/raw であることを要求するため、
// /releases/download/<tag>/<asset> や /releases/latest/download/<asset> のような
// Release asset のURL(第3セグメントが releases)は元々この正規表現に一致しない
// (Release assetは raw.githubusercontent.com からは取得できず、中継が必要なため書き換えない)。
const GITHUB_BLOB_OR_RAW_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/;

/**
 * github.com の blob/raw URLを raw.githubusercontent.com へ書き換える。
 * raw.githubusercontent.com は CORS 対応(access-control-allow-origin: *)なので、中継を通さず
 * 直接取得できる。github.com の該当URLは302で raw.githubusercontent.com へリダイレクトするが、
 * その302レスポンスには access-control-allow-origin が無いためブラウザの直fetchが失敗する。
 * 2026-08-14
 *
 * github.com 以外のホスト、および Release asset の URL(上記正規表現が除外)はそのまま返す。
 */
export function rewriteGithubBlobUrl(url: string): string {
  const m = GITHUB_BLOB_OR_RAW_RE.exec(url);
  if (!m) return url;
  const [, owner, repo, ref, path] = m;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
}

/**
 * 取得したバイト列がディスクイメージではなくHTMLページに見えるかどうかを判定する。
 * Google Driveの共有リンクを直接fetchすると、CORSエラーにはならずHTML閲覧ページが200で
 * 返ってくることが実測で判明しているため(2026-08-13 curl実測)、HTTPステータスやCORSの成否だけでは
 * ディスクイメージを取得できたかどうか判定できない。Content-Typeが`text/html`ならそれを信用し、
 * 無い/信用できない場合は先頭バイトのシグネチャ(`<!DOCTYPE` / `<html` / `<?xml`、大小文字問わず)で判定する。
 */
export function looksLikeHtml(bytes: Uint8Array, contentType?: string | null): boolean {
  if (contentType && /^\s*text\/html/i.test(contentType)) return true;
  const sample = bytes.subarray(0, 512);
  const decoded = new TextDecoder('latin1')
    .decode(sample)
    .replace(/^﻿/, '')
    .trimStart();
  return /^<!do/i.test(decoded) || /^<htm/i.test(decoded) || /^<\?xm/i.test(decoded);
}
