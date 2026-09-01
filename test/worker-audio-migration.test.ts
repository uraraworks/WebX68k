// Worker経路(?worker=1)の音声出力移行(段階移行の順序 手順5、2026-09-01)の再発防止テスト。
//
// 経緯: src/core-worker.ts の frame snapshot 組み立ては、以前
// `audio: { chunks: [], sampleFrames: 0 }` を固定で送っており、コアが生成した音声サンプルは
// 一度も main へ渡らず捨てられていた(親セッションが2026-09-01に実測。docs/STORAGE-SCSI.md
// 「起動・3ドライブ・音声の基準比較(実測、2026-09-01)」節、_local/measure/
// wm-20260901-audio-worker.json 参照。underflowFrames が60秒ぶんちょうど=100%)。
//
// 修正: Worker側は LibretroHost の audioPush コールバックで受け取った生サンプルを
// pendingAudioChunks へ蓄積し、sendFrame() でそのまま(リサンプルせず) frame event に
// 相乗りさせて main へ transfer する。main側(bootWorkerCore()のframe eventハンドラ)は
// 既定経路(bootCore()内のLibretroHostコールバック)と全く同じ「speedMultiplier===1なら
// そのまま・それ以外はresampleSpeedしてaudio?.push()」を、受け取ったchunkごとに行う。
// 速度倍率のリサンプルとAudioEngine.push()をmain側だけに置くのは、既定経路とWorker経路で
// 音の加工経路を1本に保つため(過去の教訓「入力源は末端の唯一の窓口へ集約する」と同種の
// 失敗を避ける。docs/STORAGE-SCSI.md「段階移行の順序 手順5」参照)。
//
// このテストは他の静的検査(test/core-worker-option-order.test.ts等)と同じ手法を採る:
// core-worker.ts はWorkerグローバル(self/OffscreenCanvas等)に依存するためnode環境の
// vitestへ直接importできず、main.tsはDOM初期化を伴う巨大な副作用を持つため同様にimport
// できない(「ヘルパ単体テストは結線を見ていない」の教訓どおり、import可能な形に切り出す
// こと自体がここでは目的とずれる)。そのため実ファイルを読んで構造を検査する。
//
// 陽性対照(実装時に手動で確認済み。git diffを空に戻した状態でredになることも確認):
//   1. src/core-worker.ts の sendFrame() 内の audio フィールドを
//      `audio: { chunks: [], sampleFrames: 0 }` に戻す → 1つ目のテストがredになる。
//   2. src/main.ts の frame event ハンドラから `for (const chunkBuf of snapshot.audio.chunks)`
//      ブロックを削除する → 2つ目のテストがredになる。
// 実ブラウザでの末端確認(?worker=1、window.__webx68kDebug、既定経路との対照・陰性対照込み)は
// このAgentの作業報告(コミットメッセージ・docs追記箇所)を参照。
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

describe('Worker経路の音声出力移行(静的検査)', () => {
  it('core-worker.ts: sendFrame() はcoreが生成した音声サンプルを空でなく送る', () => {
    const code = stripComments(readSrc('src/core-worker.ts'));

    // 退行の再現形そのもの(空配列固定)がもう存在しないこと。
    expect(code).not.toMatch(/audio:\s*\{\s*chunks:\s*\[\]\s*,\s*sampleFrames:\s*0\s*\}/);

    // sendFrame() の中で、蓄積したpendingAudioChunks/pendingAudioSampleFramesを
    // audioフィールドへそのまま渡していること。
    const sendFrameMatch = code.match(/function sendFrame\([\s\S]*?\n\}\n/);
    expect(sendFrameMatch, 'sendFrame() が見つからない(core-worker.ts の構造が変わった?)').toBeTruthy();
    const sendFrameBody = sendFrameMatch![0];
    expect(sendFrameBody).toMatch(/audio:\s*\{\s*chunks:\s*pendingAudioChunks\s*,\s*sampleFrames:\s*pendingAudioSampleFrames\s*\}/);

    // LibretroHost へ渡すコールバックが「捨てるだけ」ではなく、蓄積側の関数(pushAudioSamples)
    // に差し替わっていること。
    const initMatch = code.match(/async function handleInitialize\([\s\S]*?\n\}\n/);
    expect(initMatch, 'handleInitialize() が見つからない').toBeTruthy();
    expect(initMatch![0]).toMatch(/new LibretroHost\([^,]+,\s*pushAudioSamples\)/);
  });

  it('main.ts: Worker frame event ハンドラは受け取ったaudio chunksをresample+AudioEngine.pushへ渡す', () => {
    const code = stripComments(readSrc('src/main.ts'));

    const handlerMatch = code.match(
      /proxy\.setEventHandler\(\(event: CoreEvent\) => \{[\s\S]*?\n {2}\}\);/,
    );
    expect(handlerMatch, 'proxy.setEventHandler(...) が見つからない(main.ts の構造が変わった?)').toBeTruthy();
    const handlerBody = handlerMatch![0];

    // chunk単位でループし、既定経路と同じ「speedMultiplier===1ならそのまま・それ以外は
    // resampleSpeed」の形でAudioEngineへ渡していること。
    expect(handlerBody).toMatch(/for\s*\(\s*const\s+chunkBuf\s+of\s+snapshot\.audio\.chunks\s*\)/);
    expect(handlerBody).toMatch(/new Float32Array\(chunkBuf\)/);
    expect(handlerBody).toMatch(/speedMultiplier === 1 \? samples : resampleSpeed\(samples, speedMultiplier, audioResampleState\)/);
    expect(handlerBody).toMatch(/audio\?\.push\(out\)/);

    // Worker側でリサンプルしていないこと(経路を1本に保つ制約)。resampleSpeedの呼び出しが
    // core-worker.ts側に無いことは別ファイルなのでここでは検査しない(下のテスト参照)。
  });

  it('core-worker.ts はresampleSpeedを呼ばない(速度倍率のリサンプルはmain側だけに残す制約)', () => {
    const code = stripComments(readSrc('src/core-worker.ts'));
    expect(code).not.toMatch(/resampleSpeed\s*\(/);
  });

  // 2026-09-01追記: 既定経路bootCore()は起動末尾でresetResampleState(audioResampleState)を
  // 呼ぶが、bootWorkerCore()は呼んでいなかった(経路差。起動直後はspeedMultiplier===1で
  // リサンプル経路を通らず、次に速度ボタンを押せばresetSpeedState()がどのみちリセットする
  // ため実害はない。あくまで経路の対称性を保つための対応)。故障注入で確認済み: 下の
  // resetResampleState呼び出しを一時的に削除するとこのテストがredになり、削除を戻すと
  // git diffが空に戻ることを確認した。
  it('main.ts: bootWorkerCore()も既定経路と同じくresetResampleState(audioResampleState)を呼ぶ', () => {
    const code = stripComments(readSrc('src/main.ts'));

    const bootWorkerMatch = code.match(/async function bootWorkerCore\(\)[\s\S]*?\n\}\n/);
    expect(bootWorkerMatch, 'bootWorkerCore() が見つからない(main.ts の構造が変わった?)').toBeTruthy();
    const bootWorkerBody = bootWorkerMatch![0];

    expect(bootWorkerBody).toMatch(/running = true;/);
    expect(bootWorkerBody).toMatch(/resetResampleState\(audioResampleState\);/);
  });
});
