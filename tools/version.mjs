// WebX68k のビルド版表記を組み立てる純関数だけを置くモジュール。
//
// git 実行(副作用)を一切含まない。単体テスト(test/version-format.test.ts)から
// 直接呼び出せるようにするため、tools/compute-version.mjs(git を叩く側)と
// ファイル単位で分離してある。
//
// JST(UTC+9)はホストのタイムゾーン設定に一切依存しない固定オフセットで計算する。
// toLocaleString/getHours 等のローカルTZ依存APIは使わない。
// new Date(ts*1000 + 9*3600*1000) を作り、getUTCFullYear() 等の UTC系アクセサで
// 読むことで、「+9時間ずらしたUTC時刻」を素通しで表示する(日本には夏時間が無いので
// 年間を通じてこれで正しい)。

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * @param {number} commitTsSec コミット日時(unix秒, %ct)
 * @param {string} shortHash コミットの短縮ハッシュ
 * @param {boolean} dirty 作業ツリーに未コミットの変更があるか
 * @returns {{ footer: string, buildId: string }}
 */
export function formatVersion(commitTsSec, shortHash, dirty) {
  // ローカルタイムゾーンに依存しないよう、UTC epoch(ms)に+9時間ぶん足した
  // 「JSTの壁時計時刻」をUTCアクセサ(getUTCFullYear等)で読む。
  const jst = new Date(commitTsSec * 1000 + 9 * 3600 * 1000);
  const y = jst.getUTCFullYear();
  const mo = pad2(jst.getUTCMonth() + 1);
  const d = pad2(jst.getUTCDate());
  const hh = pad2(jst.getUTCHours());
  const mm = pad2(jst.getUTCMinutes());

  const footer = `WebX68k ${y}-${mo}-${d} ${hh}:${mm} JST (${shortHash}${dirty ? '+' : ''})`;
  // buildId はURLのクエリ文字列に載せる。"+" はqueryでは空白にデコードされて
  // しまうため、buildId側には含めない(表示用のfooterだけ"+"を付ける)。
  const buildId = dirty ? `${shortHash}-dirty` : shortHash;

  return { footer, buildId };
}

// git が使えない/リポジトリでない等、版情報の取得に失敗した場合に使う
// 明示的な値。空欄や'00'等のもっともらしい値で埋めず、「unknown」だと
// はっきりわかる表記にする。
export const UNKNOWN_VERSION = {
  footer: 'WebX68k (version unknown)',
  buildId: 'unknown',
};
