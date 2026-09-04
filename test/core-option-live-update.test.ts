// コアオプションの走行中更新がWorker経路へ配線されていることの静的検査(呼び出し元指摘の
// 是正、2026-09-04)。
//
// 発端: cfgCpuSpeedのchangeハンドラ・∞MHzの自動クロック調整(stepAutoClock())が
// `host?.setCoreOption(...)` という書き方になっていた。既定経路のhostは非nullだが、
// Worker経路(?worker=1)のhostは常にnullのため、`?.`がWorker経路では無言で素通りして
// 何も起きない欠陥だった。
//
// main.ts はDOM依存の巨大なエントリファイルでNode(vitest)から直接importできないため
// (test/core-options.test.tsと同じ理由・同じ手法)、ソースを読んで
//   (1) 「両経路が同じ入口(setCoreOptionLive())を通る」構造
//   (2) 入口自体がurlWorkerModeで明示的に分岐し、Worker経路ではworkerCoreProxyへ渡す
// ことだけを確認する。「渡している値が正しいか」までは検査しない(main.tsをimportできない
// ため)。字面を厳しく縛る(例: 分岐直後の1行だけを見る)と、後続の無関係な修正で
// 落ちやすくなるため、ここでは「必要な呼び出しが本文に含まれているか」という緩い一致に
// 留める(呼び出し元指摘: 「if (...) { の直後の1行まで縛った検査が別の修正で落ちた」事例に
// 倣う)。
//
// src/core-worker.ts側は、走行中更新メッセージ(CORE_OPTION_UPDATE_KIND)を受けて
// host.setCoreOption()を呼ぶ実装がある(test/worker-core-proxy.test.tsのfire-and-forget
// テストがWorkerCoreProxy側の送信を確認済み)ため、ここではmain.ts側の配線だけを見る。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..');

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const mainSrc = stripComments(readFileSync(resolve(REPO_ROOT, 'src/main.ts'), 'utf8'));

/** `function ${name}(` から、次のトップレベル関数定義(または`}\n\n`)までを大雑把に本体とみなす。
 * test/core-options.test.tsのbodyOf()と同じ手法(main.tsの関数はネストしないため十分)。 */
function bodyOf(name: string): string {
  const start = mainSrc.search(new RegExp(`(async )?function ${name}\\(`));
  expect(start, `${name}() が見つかりません`).toBeGreaterThanOrEqual(0);
  const rest = mainSrc.slice(start + 1);
  const nextFnRelative = rest.search(/\n(async )?function /);
  return nextFnRelative >= 0 ? rest.slice(0, nextFnRelative) : rest;
}

describe('コアオプションの走行中更新(main.ts、静的検査)', () => {
  it('setCoreOptionLive() が urlWorkerMode で明示的に分岐し、Worker経路では workerCoreProxy.setCoreOptionLive() を呼ぶ', () => {
    const body = bodyOf('setCoreOptionLive');
    expect(body).toMatch(/urlWorkerMode/);
    expect(body).toMatch(/workerCoreProxy\?\.setCoreOptionLive\(/);
    // 既定経路(host.setCoreOption)もこの入口の中に残っていること(else側)。
    expect(body).toMatch(/host\?\.setCoreOption\(/);
  });

  it('cfgCpuSpeedのchangeハンドラは setCoreOptionLive() 経由で呼ぶ(host?.setCoreOption()を直接は呼ばない)', () => {
    const idx = mainSrc.indexOf("cfgCpuSpeed.addEventListener('change'");
    expect(idx, 'cfgCpuSpeedのchangeハンドラが見つかりません').toBeGreaterThanOrEqual(0);
    const rest = mainSrc.slice(idx);
    const endIdx = rest.indexOf('\n});');
    const handlerBody = endIdx >= 0 ? rest.slice(0, endIdx) : rest;
    expect(handlerBody).toMatch(/setCoreOptionLive\(/);
    // 陽性対照相当: 「host?.setCoreOption(」という素通り書き方そのものが復活していないこと。
    expect(handlerBody).not.toMatch(/host\?\.setCoreOption\(/);
  });

  it('stepAutoClock() は host?. 単独ではなく setCoreOptionLive() 経由でコアオプションを更新する', () => {
    const body = bodyOf('stepAutoClock');
    expect(body).toMatch(/setCoreOptionLive\(/);
    expect(body).not.toMatch(/host\.setCoreOption\(/);
  });

  it('stepAutoClock() が既定経路(host)・Worker経路(workerCoreProxy)のどちらか片方だけに固定されたガードを持たない', () => {
    // 以前は `if (!isAutoClock() || !host) return;` でWorker経路(hostは常にnull)を
    // 一律弾いていた。修正後はworkerCoreProxyの有無も見ること。
    const body = bodyOf('stepAutoClock');
    expect(body).toMatch(/workerCoreProxy/);
  });

  it('bootWorkerCore() のframe eventハンドラが stepAutoClock() を呼ぶ(Worker経路でも呼ばれること)', () => {
    const body = bodyOf('bootWorkerCore');
    expect(body).toMatch(/stepAutoClock\(/);
    // ∞MHzの実測コスト源(既定経路のautoClockFrameCostMsに相当)がframe eventの
    // snapshot.frameCostMsから供給されていること。
    expect(body).toMatch(/snapshot\.frameCostMs/);
  });
});

describe('frame event スナップショットへの1フレームコスト実測値の相乗り(src/core-worker.ts、静的検査)', () => {
  const workerSrc = stripComments(readFileSync(resolve(REPO_ROOT, 'src/core-worker.ts'), 'utf8'));

  it('sendFrame() が組み立てる FrameSnapshot に frameCostMs が含まれる', () => {
    const start = workerSrc.indexOf('function sendFrame(');
    expect(start, 'sendFrame() が見つかりません').toBeGreaterThanOrEqual(0);
    const rest = workerSrc.slice(start);
    const nextFnRelative = rest.slice(1).search(/\nfunction /);
    const body = nextFnRelative >= 0 ? rest.slice(0, nextFnRelative + 1) : rest;
    // FrameSnapshotオブジェクトリテラルのフィールドとして frameCostMs が乗っていること
    // (引数名をそのままプロパティ省略記法で使っている想定。呼び出し元の値の出どころまでは
    // ここでは縛らない)。
    expect(body).toMatch(/frameCostMs/);
  });

  it('tick() が result.frameCostMs を sendFrame() へ渡す', () => {
    const start = workerSrc.indexOf('function tick(');
    expect(start, 'tick() が見つかりません').toBeGreaterThanOrEqual(0);
    const rest = workerSrc.slice(start);
    const nextFnRelative = rest.slice(1).search(/\nfunction /);
    const body = nextFnRelative >= 0 ? rest.slice(0, nextFnRelative + 1) : rest;
    expect(body).toMatch(/sendFrame\(/);
    expect(body).toMatch(/result\.frameCostMs/);
  });
});
