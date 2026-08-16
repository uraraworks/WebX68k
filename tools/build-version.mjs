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
// - JST(UTC+9)はホストのタイムゾーン設定に一切依存しない固定オフセットで計算する。
//   toLocaleString/getHours 等のローカルTZ依存APIは使わない。
//   new Date(ts*1000 + 9*3600*1000) を作り、getUTCFullYear() 等の UTC系アクセサで
//   読むことで、「+9時間ずらしたUTC時刻」を素通しで表示する(日本には夏時間が無いので
//   年間を通じてこれで正しい)。
// - git が使えない/リポジトリでない場合は例外を投げず、ok=false と
//   はっきり「unknown」とわかる値を返す。ビルドを失敗させない・もっともらしい
//   値(空欄や'00'等)で埋めない。

import { execFileSync } from 'node:child_process';

function runGit(args, repoRoot) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * @param {string} repoRoot リポジトリのルート絶対パス
 * @returns {{ ok: boolean, footer: string, buildId: string, dirty: boolean }}
 */
export function computeBuildVersion(repoRoot) {
  try {
    // --date=format はgitのバージョン/ロケールで挙動差があるため使わない。
    // unix秒(%ct, コミッターdate)を取り、JS側でJST固定オフセット変換する。
    const commitTsStr = runGit(['log', '-1', '--format=%ct', 'HEAD'], repoRoot);
    const hash = runGit(['rev-parse', '--short=7', 'HEAD'], repoRoot);
    if (!commitTsStr || !hash) {
      throw new Error('git出力が空でした');
    }
    const commitTs = Number(commitTsStr);
    if (!Number.isFinite(commitTs)) {
      throw new Error(`コミット日時の解析に失敗しました: ${commitTsStr}`);
    }

    // ローカルタイムゾーンに依存しないよう、UTC epoch(ms)に+9時間ぶん足した
    // 「JSTの壁時計時刻」をUTCアクセサ(getUTCFullYear等)で読む。
    const jst = new Date(commitTs * 1000 + 9 * 3600 * 1000);
    const y = jst.getUTCFullYear();
    const mo = pad2(jst.getUTCMonth() + 1);
    const d = pad2(jst.getUTCDate());
    const hh = pad2(jst.getUTCHours());
    const mm = pad2(jst.getUTCMinutes());

    // 作業ツリーに未コミットの変更があるかどうか。
    const statusOut = runGit(['status', '--porcelain'], repoRoot);
    const dirty = statusOut.length > 0;

    const footer = `WebX68k ${y}-${mo}-${d} ${hh}:${mm} JST (${hash}${dirty ? '+' : ''})`;
    // buildId はURLのクエリ文字列に載せる。"+" はqueryでは空白にデコードされて
    // しまうため、buildId側には含めない(表示用のfooterだけ"+"を付ける)。
    const buildId = dirty ? `${hash}-dirty` : hash;

    return { ok: true, footer, buildId, dirty };
  } catch (err) {
    // git が使えない/リポジトリでない等。ビルドを失敗させず、'unknown'と
    // はっきりわかる値を返す(空欄や'00'等のもっともらしい値で埋めない)。
    return { ok: false, footer: 'WebX68k version unknown', buildId: 'unknown', dirty: false };
  }
}
