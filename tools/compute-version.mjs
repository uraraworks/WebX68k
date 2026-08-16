// WebX68k のビルド版表記を計算する共通モジュール。
//
// vite.config.ts (build/dev両方) と vitest.config.ts の両方から import して使う
// (二重管理しないため、値を出す場所はここ1箇所だけにする)。
//
// 方針(FMSound の tools/gen_version.py と同じ。詳細はそちらのコメント参照):
// - ビルド時刻(壁時計)は使わない。Date.now() や new Date()(引数なし)は使わない。
//   同じコミットから何度ビルドしても同じ文字列になることを保証するため
//   (「配布物が本当にコミットXのものか」を後から確認できるようにする)。
// - 情報源は git の「コミット日時(コミッターdate, %ct)」と「コミットハッシュ」のみ。
// - 文字列整形(JST固定オフセット計算・dirty印・ゼロ埋め)は純関数の
//   tools/version.mjs に分離してある。ここでは git を叩いて値を集めるだけ。
// - git が使えない/リポジトリでない場合は例外を投げず、ok=false と
//   はっきり「unknown」とわかる値を返す。ビルドを失敗させない・もっともらしい
//   値(空欄や'00'等)で埋めない。

import { execFileSync } from 'node:child_process';
import { formatVersion, UNKNOWN_VERSION } from './version.mjs';

function runGit(args, repoRoot) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * @param {string} repoRoot リポジトリのルート絶対パス
 * @returns {{ ok: boolean, footer: string, buildId: string, dirty: boolean }}
 */
export function computeBuildVersion(repoRoot) {
  try {
    // --date=format はgitのバージョン/ロケールで挙動差があるため使わない。
    // unix秒(%ct, コミッターdate)を取り、formatVersion() でJST固定オフセット変換する。
    const commitTsStr = runGit(['log', '-1', '--format=%ct', 'HEAD'], repoRoot);
    const hash = runGit(['rev-parse', '--short=7', 'HEAD'], repoRoot);
    if (!commitTsStr || !hash) {
      throw new Error('git出力が空でした');
    }
    const commitTs = Number(commitTsStr);
    if (!Number.isFinite(commitTs)) {
      throw new Error(`コミット日時の解析に失敗しました: ${commitTsStr}`);
    }

    // 作業ツリーに未コミットの変更があるかどうか。
    const statusOut = runGit(['status', '--porcelain'], repoRoot);
    const dirty = statusOut.length > 0;

    const { footer, buildId } = formatVersion(commitTs, hash, dirty);

    return { ok: true, footer, buildId, dirty };
  } catch (err) {
    // git が使えない/リポジトリでない等。ビルドを失敗させず、'unknown'と
    // はっきりわかる値を返す(空欄や'00'等のもっともらしい値で埋めない)。
    return { ok: false, footer: UNKNOWN_VERSION.footer, buildId: UNKNOWN_VERSION.buildId, dirty: false };
  }
}
