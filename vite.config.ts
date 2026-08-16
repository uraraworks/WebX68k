import { defineConfig, type Plugin } from 'vite';
import { computeBuildVersion } from './tools/build-version.mjs';

// git のコミット日時/ハッシュから求めた版表記(footer)とキャッシュバスティング用の
// 短い識別子(buildId)。同じコミットからは常に同じ値になる(壁時計不使用。
// 詳細は tools/build-version.mjs 参照)。
const { footer: buildVersionFooter, buildId } = computeBuildVersion(__dirname);

// index.html に版表記を書き込み、固定名アセットのURLに ?v=<buildId> を付けるプラグイン。
// transformIndexHtml は `vite build` だけでなく `vite dev` の初回HTMLレスポンスでも
// 呼ばれるため、開発サーバでも同じ挙動になる。
//
// キャッシュバストの対象は明示的な許可リストのみ(正規表現で全src/hrefを舐めない)。
// vite が出力する assets/index-*.js 等は既にファイル名ハッシュ付きなので対象外。
function versionFooterPlugin(): Plugin {
  return {
    name: 'webx68k-version-footer',
    enforce: 'post',
    transformIndexHtml(html) {
      const placeholder = '<span id="footer-version" class="footer-version"></span>';
      // index.html 側の span を変更すると(属性追加・クラス順変更など)このリテラル一致が
      // 無言で外れ、版表記が空欄のままビルドが「成功」してしまう。それを防ぐため、
      // 置換前に一致有無を確認してすぐ気付けるようにする。
      // dev サーバでも transformIndexHtml は呼ばれるが、throw しても壊れるのはその
      // リクエストのレスポンス(Vite のエラーオーバーレイ/500)だけでサーバ自体は落ちない
      // ため、build/dev のどちらでも throw して構わない。
      if (!html.includes(placeholder)) {
        throw new Error(
          'index.html に版表記の差し込み先 <span id="footer-version" class="footer-version"></span> が見つからない。' +
            ' index.html を変更した場合は vite.config.ts のプレースホルダも合わせて更新すること。',
        );
      }
      let out = html.replace(
        placeholder,
        `<span id="footer-version" class="footer-version">${buildVersionFooter}</span>`,
      );

      const cacheBustTargets = [
        // index.html のソース上は "/core/px68k_libretro.js"(ルート絶対)だが、
        // vite が base:'./' に合わせて先に "./core/px68k_libretro.js" へ書き換えた
        // 後(このプラグインは enforce:'post')で目にすることになるため両方を許可リストに
        // 入れる(どちらであっても対象は同じ1本のファイルなので範囲は広がらない)。
        '/core/px68k_libretro.js',
        './core/px68k_libretro.js',
        './x68icon.png',
        './x68icon-180.png',
        './manifest.webmanifest',
      ];
      for (const target of cacheBustTargets) {
        // href="target" / src="target" の形をそのまま対象にする(target自体が
        // 許可リストで固定されているため、置換範囲が意図せず広がることはない)。
        out = out.split(`"${target}"`).join(`"${target}?v=${buildId}"`);
      }

      return out;
    },
  };
}

export default defineConfig({
  base: './',
  server: {
    headers: {
      // AudioWorklet / 将来的な SharedArrayBuffer 利用を見据えたクロスオリジン分離ヘッダ
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  plugins: [versionFooterPlugin()],
});
