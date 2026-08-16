#!/usr/bin/env node
// tools/compute-version.mjs の computeBuildVersion() が「壁時計を使わず、同じコミットから
// は常に同じ文字列を生成する」ことを検証する。FMSound の
// tools/verify_version_determinism.mjs を WebX68k(vite/node, python3不使用)向けに移植。
//
// 手順: computeBuildVersion() を1秒以上の間隔を挟んで2回実行し、結果が完全一致するか
// 比較する。一致しなければ壁時計(またはその他の非決定要素)を使っている疑いがあるためFAIL。
//
// 故障注入: 意図的に現在時刻を埋め込む「壊れた生成関数」を先に用意し、この検査が
// 実際に差分を検出できることを確認してから、本物の computeBuildVersion() を検証する
// (常にPASSする検査は無効、という要件への対応)。

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { computeBuildVersion } from './compute-version.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- 故障注入: 壁時計を使う「壊れた生成」を模擬し、検査がFAILを検出できるか確認 ---
function faultInjectedGenerate() {
  return { footer: `WebX68k ${new Date().toISOString()}`, buildId: 'fault', dirty: false, ok: true };
}

async function main() {
  const faultRun1 = JSON.stringify(faultInjectedGenerate());
  await sleep(1100);
  const faultRun2 = JSON.stringify(faultInjectedGenerate());
  if (faultRun1 === faultRun2) {
    console.error('FATAL: 故障注入(壁時計使用)のはずが2回とも一致した。検査ロジックが機能していない。');
    process.exit(1);
  }
  console.log('[故障注入] 壁時計版は1.1秒間隔で実行すると内容が変わることを確認(検査は機能している)。');

  // --- 本番: computeBuildVersion() を2回実行して比較 ---
  const run1 = computeBuildVersion(REPO_ROOT);
  await sleep(1100);
  const run2 = computeBuildVersion(REPO_ROOT);

  const run1Str = JSON.stringify(run1);
  const run2Str = JSON.stringify(run2);

  if (run1Str !== run2Str) {
    console.error('FAIL: computeBuildVersion() の出力が2回の実行で食い違った(壁時計等の非決定要素の疑い)。');
    console.error('--- run1 ---\n' + run1Str);
    console.error('--- run2 ---\n' + run2Str);
    process.exit(1);
  }

  if (!run1.ok) {
    console.error('FAIL: ok が true ではない(git情報の取得に失敗している可能性)。');
    console.error(run1Str);
    process.exit(1);
  }

  console.log('[本番] computeBuildVersion() を1.1秒間隔で2回実行し、出力が完全一致した:');
  console.log(run1Str);
  console.log('PASS: 同じコミットからのビルドは常に同じバージョン文字列になる(壁時計不使用)。');

  // --- TZ環境変数を変えても同じ文字列になることを確認 ---
  // 子プロセス(node -e)でTZを差し替えて computeBuildVersion() を実行し、TZ未指定時と
  // 完全一致することを確認する。JSTをローカルタイムゾーン依存APIで求めていると、
  // 実行環境のTZ設定次第で結果が変わってしまうため。
  function runInChildWithTz(tz) {
    const script = `
      import('${pathToFileUrl(path.join(REPO_ROOT, 'tools', 'compute-version.mjs'))}').then(({ computeBuildVersion }) => {
        console.log(JSON.stringify(computeBuildVersion(${JSON.stringify(REPO_ROOT)})));
      });
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, TZ: tz },
    });
    return out.trim();
  }

  function pathToFileUrl(p) {
    return new URL(`file://${p}`).href;
  }

  const runTzUtc = runInChildWithTz('UTC');
  if (runTzUtc !== run1Str) {
    console.error('FAIL: TZ=UTC で実行すると出力が変わった(ローカルTZ依存の疑い)。');
    console.error('--- run1(TZ未指定) ---\n' + run1Str);
    console.error('--- TZ=UTC ---\n' + runTzUtc);
    process.exit(1);
  }
  console.log('[TZ差し替え] TZ=UTC でも出力が一致した。');

  const runTzNy = runInChildWithTz('America/New_York');
  if (runTzNy !== run1Str) {
    console.error('FAIL: TZ=America/New_York で実行すると出力が変わった(ローカルTZ依存の疑い)。');
    console.error('--- run1(TZ未指定) ---\n' + run1Str);
    console.error('--- TZ=America/New_York ---\n' + runTzNy);
    process.exit(1);
  }
  console.log('[TZ差し替え] TZ=America/New_York でも出力が一致した。');

  if (!/JST \(/.test(run1.footer)) {
    console.error('FAIL: footer に"JST ("の明記が無い(基準タイムゾーンが分からない表記になっている)。');
    console.error(run1Str);
    process.exit(1);
  }
  console.log('PASS: TZ環境変数を変えてもcomputeBuildVersion()の出力は変わらない(JSTを固定オフセットで扱っている)。');

  // --- 実ビルド成果物の末端検査: クリーンなツリーからビルドしたdistにdirty印が付かないこと ---
  //
  // computeBuildVersion() を単体で呼ぶだけでは絶対に再現しない不具合がある: vite/vitest が
  // TS設定ファイルを読む際にリポジトリ直下へ vite.config.ts.timestamp-*.mjs という一時
  // ファイルを作り、git status --porcelain がその読み込みの最中に走るせいで、ワークツリーが
  // 完全にクリーンでも dirty=true になってしまう(.gitignoreで無視していない場合)。
  // これは実際に `npm run build` を実行し、生成された dist を見ないと検出できない。
  await verifyCleanBuildHasNoDirtyMark();
}

async function verifyCleanBuildHasNoDirtyMark() {
  const statusOut = execFileSync('git', ['status', '--porcelain'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();

  if (statusOut.length > 0) {
    console.log('='.repeat(70));
    console.log('[SKIP] 実ビルド末端検査: ワークツリーがクリーンではないため検査を実行しなかった。');
    console.log('       (この検査はクリーンな状態でのみ意味を持つため、汚れている場合は');
    console.log('        黙って通過させず、明示的にスキップしたことをここに出力している)');
    console.log('--- git status --porcelain ---');
    console.log(statusOut);
    console.log('='.repeat(70));
    return;
  }

  console.log('[実ビルド末端検査] ワークツリーはクリーン。npm run build を実行して dist を検査する...');
  execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'pipe' });

  const indexHtmlPath = path.join(REPO_ROOT, 'dist', 'index.html');
  const html = readFileSync(indexHtmlPath, 'utf8');

  const footerMatch = html.match(/id="footer-version"[^>]*>([^<]*)</);
  const footerText = footerMatch ? footerMatch[1] : '';
  const versionQueryMatches = [...html.matchAll(/\?v=([A-Za-z0-9-]+)/g)].map((m) => m[1]);

  const problems = [];
  if (footerText.includes('+')) {
    problems.push(`footer の版文字列に "+" が含まれている: "${footerText}"`);
  }
  const dirtyQueries = versionQueryMatches.filter((v) => v.includes('-dirty'));
  if (dirtyQueries.length > 0) {
    problems.push(`?v= の値に "-dirty" が含まれている: ${dirtyQueries.join(', ')}`);
  }

  if (problems.length > 0) {
    console.error('FAIL: クリーンなワークツリーからビルドしたのに dist/index.html に dirty 印が付いた。');
    for (const p of problems) console.error('  - ' + p);
    console.error(
      '原因の手がかり: ビルド中に生成される一時ファイル' +
        '(vite.config.ts.timestamp-*.mjs 等)が git status を汚していないか .gitignore を確認すること。'
    );
    process.exit(1);
  }

  console.log(`[実ビルド末端検査] footer: "${footerText}"`);
  console.log(`[実ビルド末端検査] ?v= の値: ${[...new Set(versionQueryMatches)].join(', ')}`);
  console.log('PASS: クリーンなワークツリーからビルドした dist に dirty 印は付かなかった。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
