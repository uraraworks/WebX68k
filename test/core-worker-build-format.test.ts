// Worker骨格(手順4)の実ブラウザ起動不具合の再発防止テスト。
//
// 経緯(docs/STORAGE-SCSI.md「段階移行の順序」手順4参照): 2026-08-28、`?worker=1` の
// Worker骨格はテスト532件が全通過した状態のまま、実ブラウザでは一度も起動していなかった
// (「コンパイルできる」は「動く」の証明にならない、の再現)。原因は
// `new Worker(new URL('./core-worker.ts', import.meta.url))` が `{ type: 'module' }` を
// 指定しておらず、vite dev server がクラシックworker用に配信する内容に ESM の import 文が
// そのまま残っていたため、構文エラーで即死していたこと。
//
// このテストは「実ファイルを読んで」以下の静的な形を検査する(ヘルパの単体テストにしない):
//   1. src/core-proxy.ts の defaultCreateWorker() が `new Worker(...)` を
//      `{ type: 'module' }` 付きで生成していること
//   2. src/core-worker.ts が importScripts に依存していないこと
//      (モジュールworkerでは importScripts が使えないため)
//
// 重要な限界: この静的検査は「構文・API選択が正しい形をしている」ことしか確認できず、
// 「実ブラウザで実際に initialize→ready まで到達する」ことは一切保証しない。今回の不具合が
// まさに「テストは全部通っていたのに実ブラウザでは動いていなかった」ケースであり、静的検査は
// 再発の一部(型・API選択の巻き戻り)しか防げない。実ブラウザでの動作確認(dev/本番ビルド双方で
// `ready` に到達すること)は、コミット前に手動またはスクリプトで別途行う必要がある。
//
// 陽性対照: `{ type: 'module' }` を外す/`importScripts` を戻すと、このテストが実際に落ちる
// ことを実装時に手動で確認済み(一時的に元へ戻して `npm test` が red になることを見てから
// 現在の実装に復元した)。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..');

function readSrc(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
}

/** コメント(行コメント・ブロックコメント)を落とした「実コードだけ」を返す。
 * このファイル自体がコメントで "importScripts()" 等の文字列に言及しているため、
 * 実際の呼び出しの有無をコメントの説明文と区別するのに使う。文字列リテラル内の
 * `//` は考慮していない素朴な実装だが、対象ファイルの内容には該当しない。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('Worker生成のビルド形式(静的検査)', () => {
  it('defaultCreateWorker() は `new Worker(...)` を type: "module" 付きで生成する', () => {
    const src = readSrc('src/core-proxy.ts');
    const fnMatch = src.match(/function defaultCreateWorker\(\)[\s\S]*?\n}/);
    expect(fnMatch, 'defaultCreateWorker() が見つからない(core-proxy.ts の構造が変わった?)').toBeTruthy();
    const fnBody = fnMatch![0];
    expect(fnBody).toMatch(/new Worker\(/);
    // クラシックworker(type省略)だと vite dev server 配信内容に ESM import が残り
    // 構文エラーになる(実測)。type: 'module' の明示を必須にする。
    expect(fnBody).toMatch(/type:\s*['"]module['"]/);
  });

  it('core-worker.ts は importScripts を実際には呼んでいない(モジュールworkerでは使えない)', () => {
    // コメントには経緯説明として "importScripts()" という語自体は残るため、
    // コメントを除いた実コード部分だけを見る。
    const code = stripComments(readSrc('src/core-worker.ts'));
    expect(code).not.toMatch(/importScripts\s*\(/);
  });

  it('core-worker.ts は emscripten glue を fetch+eval で読み込む(import()ではない)', () => {
    // import() だとモジュールスコープで実行され、glueが期待する self.PX68K への
    // グローバル代入が起きない(実測)。fetch してソースを取得し評価する形を維持する。
    const code = stripComments(readSrc('src/core-worker.ts'));
    expect(code).toMatch(/fetch\(['"]\/core\/px68k_libretro\.js['"]\)/);
    expect(code).toMatch(/\(0,\s*eval\)\(/);
  });

  it('陽性対照: 検出ロジック自体は悪い形を実際に落とせる(合成ソースで確認)', () => {
    // 上のテストが「常にpass」する壊れた検査になっていないことを、実ファイルではなく
    // 合成した文字列で確認する(本物のファイルを一時的に壊す代わりに、ここでロジックだけ検証)。
    const badCreateWorker = `
function defaultCreateWorker() {
  return new Worker(new URL('./core-worker.ts', import.meta.url)) as unknown as WorkerLike;
}`;
    const fnMatch = badCreateWorker.match(/function defaultCreateWorker\(\)[\s\S]*?\n}/);
    expect(fnMatch![0]).not.toMatch(/type:\s*['"]module['"]/);

    const badWorkerSrc = `importScripts('/core/px68k_libretro.js');`;
    expect(badWorkerSrc).toMatch(/importScripts\s*\(/);
  });
});
