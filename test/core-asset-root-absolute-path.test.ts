// 公開版(https://uraraworks.github.io/WebX68k/)が起動不能になっていた不具合の再発防止テスト。
//
// 経緯(実測、2026-09-06): コア資産(px68k_libretro.js / .wasm)の取得先が
// src/core-worker.ts の `fetch('/core/px68k_libretro.js')` と src/libretro-host.ts の
// `locateFile: (path) => \`/core/${path}\`` でサイトルートからの絶対パス `/core/...` に
// 直書きされていた。ローカルのdevサーバはサイトの `/` 直下で配信するため、この絶対パスは
// たまたま正しいURLと一致し、テストはもちろん手元のブラウザ確認でも何も壊れて見えなかった。
// ところが公開先はサブパス配信(`https://uraraworks.github.io/WebX68k/`)であり、
// `/core/px68k_libretro.js` はそのサブパスの外(存在しないURL)を指す。実測した壊れ方:
//   - 既定(Worker)経路: `px68k_libretro.js の取得に失敗しました (status=404)` → 起動オーバーレイのまま
//   - `?worker=0`: グルーJSは読めるが .wasm が404 → `both async and sync fetching of the wasm failed`
// 修正は、ページ側(main.ts、documentを持つ側)で `new URL('core/', document.baseURI).href` を
// 計算し、InitPayload.coreBaseUrl 経由でWorkerへ渡す形にした(Worker内にはdocumentが無い)。
// src/libretro-host.ts の locateFile もこの base を使うよう改めた。
//
// このテストは「実ファイルを読んで」以下の静的な形を検査する
// (test/core-worker-build-format.test.ts と同じ流儀。ヘルパの単体テストにしない):
//   src/**/*.ts の実コード(コメントを除いた部分)に、ルート絶対パスの文字列リテラル
//   `'/core/` または `"/core/` が残っていないこと。
//
// 重要な限界: この静的検査は「サイトルート絶対パスの文字列リテラルが無い」ことしか
// 確認できず、「サブパス配信下で実際に起動する」ことは保証しない(それは実ブラウザでの
// 確認でしか分からない。今回の修正では `dist/` をサブパス配下で配信し、
// `__webx68kDebug.screenText()` に `A>` が出るところまで別途確認している)。
//
// 陽性対照(実装時に手動で確認済み): src/core-worker.ts の `fetch(url)` を一時的に
// `fetch('/core/px68k_libretro.js')` へ書き戻すと、このテストが実際に落ちることを
// `npx vitest run test/core-asset-root-absolute-path.test.ts` で確認した(確認後は
// `git diff` で元に戻し、src/ に差分が残っていないことを確認済み)。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..');
const SRC_ROOT = resolve(REPO_ROOT, 'src');

/** src/ 配下の *.ts を再帰的に列挙する(node:fs.readdirSync の再帰オプションは
 * 環境依存を避けるため使わず、手動で再帰する)。 */
function listSrcTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      files.push(...listSrcTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

/** コメント(行コメント・ブロックコメント)を落とした「実コードだけ」を返す。
 * test/core-worker-build-format.test.ts の stripComments と同じ素朴な実装
 * (文字列・テンプレートリテラル内の `//` は考慮しないが、対象箇所には該当しない)。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('コア資産のルート絶対パス直書き(静的検査)', () => {
  it('src/**/*.ts の実コードにルート絶対パス \'/core/ が残っていない', () => {
    const files = listSrcTsFiles(SRC_ROOT);
    expect(files.length, 'src/ 配下の.tsファイルが1つも見つからない(探索ロジックが壊れている?)').toBeGreaterThan(0);
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      const raw = readFileSync(file, 'utf8');
      const code = stripComments(raw);
      const lines = code.split('\n');
      lines.forEach((line, idx) => {
        if (/['"]\/core\//.test(line)) {
          offenders.push({ file: file.slice(REPO_ROOT.length + 1), line: idx + 1, text: line.trim() });
        }
      });
    }
    expect(
      offenders,
      `サイトルート絶対パス '/core/...' の直書きが見つかった(サブパス配信で404になる。` +
        `InitPayload.coreBaseUrl 経由のbase URLを使うこと): ${JSON.stringify(offenders, null, 2)}`,
    ).toEqual([]);
  });
});
