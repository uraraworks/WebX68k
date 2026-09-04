// Worker経路(?worker=1)の無制限速度モードに、既定経路(src/main.ts)と同じ
// 「無制限中は音声を捨てる」「画面提示を間引く」を持ち込む是正(2026-09-04)の再発防止テスト。
//
// 経緯: 直前のコミット(2aeb139)でWorker経路の無制限モードの予算モデルを実時間ベースへ
// 直したところ、実機で 等倍55.6fps / 無制限173fps / 4倍192fps(この環境の上限) という
// 実測が得られた。無制限が4倍より遅いのは 192 × WORKER_UNLIMITED_MAX_DUTY(0.9) = 173 で
// 占有率の上限に張り付いているため(実装は意図どおり)。しかし既定経路(メインスレッド)は
// 無制限中に「音を捨てる」「画面提示を間引く(UNLIMITED_PRESENT_INTERVAL_MS=33ms)」ことで
// 占有率の使いみちをコア実行に寄せており、Worker経路にはこれが入っていなかった。
// 本コミットでWorker側にも同じ対称性を持ち込み、無制限モードの上限そのものを引き上げる。
//
// このテストは他の静的検査(test/worker-audio-migration.test.ts等)と同じ手法を採る:
// core-worker.ts はWorkerグローバル(self/OffscreenCanvas等)に依存するためnode環境の
// vitestへ直接importできない。実行可能な単体テスト(pure logicの切り出し)は
// test/worker-drive-loop.test.ts の shouldPresentUnlimitedFrame / runUnlimitedTick の
// presentFinalFrame引数のテストで別途担保しており、ここではその結果が実際に
// core-worker.ts の駆動ループ・音声蓄積へ正しく結線されていることだけを検査する。
//
// 陽性対照(実装時に手動で確認済み。この分岐を外すとredになることを確認してから戻した):
//   1. pushAudioSamples() の `if (unlimitedActive) return;` を削除する
//      → 1つ目のテストがredになる(無制限中も蓄積される退行を検出できない)。
//   2. tick() の `if (result.ranFrames > 0 && shouldSendFrame)` を
//      `if (result.ranFrames > 0)` に戻す → 2つ目のテストがredになる
//      (間引きが無効化されたのを検出できない)。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..');

function readSrc(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('Worker経路の無制限モード: 音声を捨てる/frame eventを間引く(静的検査)', () => {
  it('pushAudioSamples(): 無制限中は蓄積せず即returnする(既定経路のaudioPushコールバックと同じ挙動)', () => {
    const code = stripComments(readSrc('src/core-worker.ts'));

    const fnMatch = code.match(/function pushAudioSamples\([\s\S]*?\n\}\n/);
    expect(fnMatch, 'pushAudioSamples() が見つからない(core-worker.ts の構造が変わった?)').toBeTruthy();
    const body = fnMatch![0];

    // 陽性対照: 無制限中に即returnする分岐が、蓄積処理(pendingAudioSampleFrames加算)より
    // 前にあること。
    const guardIdx = body.search(/if\s*\(\s*unlimitedActive\s*\)\s*return\s*;/);
    const accumulateIdx = body.search(/pendingAudioSampleFrames\s*\+=/);
    expect(guardIdx, '無制限中に捨てるガードが見つからない').toBeGreaterThan(-1);
    expect(accumulateIdx, '蓄積処理(pendingAudioSampleFrames +=)が見つからない').toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(accumulateIdx);

    // 陰性対照: 無制限OFF(unlimitedActive===false)のときは、このガードを素通りして
    // 従来どおり蓄積処理(pendingAudioChunks.push / pendingAudioSampleFrames +=)へ
    // 到達する経路が残っていること(ガードが早期returnであって、蓄積処理自体を
    // 削除・条件反転していないことの確認)。
    expect(body).toMatch(/pendingAudioChunks\.push\(/);
  });

  it('tick(): frame eventの送信(sendFrame呼び出し)はshouldSendFrameでも判定する(無制限中の間引き対象)', () => {
    const code = stripComments(readSrc('src/core-worker.ts'));

    const fnMatch = code.match(/function tick\(\)[\s\S]*?\n\}\n\nfunction sendFrame/);
    expect(fnMatch, 'tick() が見つからない(core-worker.ts の構造が変わった?)').toBeTruthy();
    const body = fnMatch![0];

    // 陽性対照: sendFrame()呼び出しのガードにshouldSendFrameが含まれること
      // (無制限モードの間引き判定が実際に配線されていること)。
    expect(body).toMatch(/if\s*\(\s*result\.ranFrames\s*>\s*0\s*&&\s*shouldSendFrame\s*\)\s*\{\s*\n\s*sendFrame\(/);

    // 陰性対照: 無制限OFF時にshouldSendFrameがfalseへ倒れないよう、既定値がtrueで
    // 宣言され、書き換えは`if (unlimitedActive)`ブロックの内側に閉じていること
    // (無制限OFFでは毎tick出る=従来どおりの挙動を保証)。
    const letIdx = body.search(/let shouldSendFrame = true;/);
    const unlimitedIfIdx = body.search(/if\s*\(\s*unlimitedActive\s*\)\s*\{/);
    const assignIdx = body.search(/shouldSendFrame = shouldPresentUnlimitedFrame\(/);
    expect(letIdx, 'let shouldSendFrame = true; が見つからない').toBeGreaterThan(-1);
    expect(unlimitedIfIdx, 'if (unlimitedActive) { が見つからない').toBeGreaterThan(-1);
    expect(assignIdx, 'shouldSendFrame = shouldPresentUnlimitedFrame(...) が見つからない').toBeGreaterThan(-1);
    expect(letIdx).toBeLessThan(unlimitedIfIdx);
    expect(unlimitedIfIdx).toBeLessThan(assignIdx);

    // shouldSendFrame の間引き間隔にWORKER_UNLIMITED_PRESENT_INTERVAL_MSを使っていること
    // (33ms未満に粗くすると入力往復が遅れるため。frameBudget.tsのコメント参照)。
    expect(body).toMatch(/shouldPresentUnlimitedFrame\(\s*now\s*,\s*workerUnlimitedLastPresentAtMs\s*,\s*WORKER_UNLIMITED_PRESENT_INTERVAL_MS\s*,?\s*\)/);
  });
});
