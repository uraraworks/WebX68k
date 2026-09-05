// バーチャルトラックパッドが Worker 経路(既定)で丸ごと効かなかった不具合の再発防止テスト。
//
// 経緯: 2026-09-05、`applyMouseButton()`/`applyMouseDelta()` という「経路を明示分岐する
// 窓口」がすでに main.ts に存在していたにもかかわらず、バーチャルトラックパッドの
// `pumpTouchClickQueue()` だけが窓口を通さず `host` を直接触っていた(欠落A)。加えて、
// 毎フレーム処理 `stepTouchTrackpad()` が既定経路の `loop()` からしか呼ばれておらず、
// Worker 経路の frame event ハンドラには一度も配線されていなかった(欠落B)。
// 2つの独立した欠落が重なり、Worker 経路(既定)ではタップしてもクリックパルスが出ず、
// 長押しをドラッグへ変換する処理も走らず、ゲストのマウスボタン状態が無言のまま
// 変化しなくなっていた(実ブラウザで確認済み)。
//
// このテストは「実ファイルを読んで」以下の静的な形を検査する
// (test/core-worker-build-format.test.ts と同じ流儀。ヘルパの単体テストにしない):
//   検査1: src/main.ts の入力メソッド(setKey/sendKeyMake/setJoyState/setMouseButton/
//          addMouseDelta/clearMouseState)への `host` 直接呼び出しが、Worker 経路への
//          配線(下記マーカー識別子)から到達可能な波括弧ブロックの中にあること(欠落Aの再発防止)。
//   検査2: `loop()` だけが呼んでいて frame event ハンドラには配線されていない毎フレーム
//          処理の集合が、既知の許可リストと完全一致すること(欠落Bの再発防止。
//          `stepTouchTrackpad` は今回 frame event 側へ配線したので、差に現れてはいけない)。
//   検査3: (静的検査ではなく実挙動) src/mouse-track.ts の MouseTracker.hasRatio が
//          setDesiredRatio()/clearDesiredRatio() に追従すること。
//
// --- 検査1を作り直した理由(2026-09-05) ---
// 旧版の検査1は「行頭 function/const 定義」を素朴に関数境界とみなし、その名前が
// 窓口関数一覧(applyKey等)に含まれるかどうかで合否を決めていた。加えて「どの named
// 関数の中でもない(モジュール直下・匿名コールバックの中)」呼び出しはカテゴリごと
// 検査対象から除外していた。この除外により、**今日実際に直した欠陥そのものを
// そのまま元に戻しても緑のまま**になることを確認した:
//   `buttonDown: (button) => applyMouseButton(button, true)` を
//   `buttonDown: (button) => host?.setMouseButton(button, true)` に戻すと、
//   この呼び出しはオブジェクトリテラルのプロパティ内の匿名アロー関数(簡潔本体、
//   波括弧なし)にあり、「どの named 関数の中でもない」に分類されて除外対象になり、
//   `npx vitest run test/input-fanin-wiring.test.ts` は 7 tests passed のままだった。
// 検査が守るべき当の欠陥を検出できていなかったため、判定規則を「関数の名前」ではなく
// 「Worker 経路への配線が実際にその呼び出しから見える範囲にあるか」という、欠陥の
// 実体(Worker 経路の配線漏れ)によりに近い基準に作り直した。
//
// --- 新しい判定規則 ---
// 対象メソッドへの `host?.xxx(` / `host.xxx(` の各出現について:
//   1. その出現を含む「最も内側の波括弧ブロック」(出現位置で開いている波括弧の
//      スタックの最上段)を求める。
//   2. そのブロックのテキストに Worker 経路マーカー(urlWorkerMode/workerInput/
//      workerCoreProxy/clearWorkerInputGeneration のいずれか)が1つでも含まれれば合格。
//   3. 含まれなければ、1段だけ外側のブロックで同じ判定をする(`if (...) { ... }` が
//      コールバック本体の中にある形を許容するため)。
//   4. それでも含まれない、または外側へ出た結果モジュール直下(波括弧が一段も
//      開いていない深さ)に達した場合は不合格。モジュール直下をスコープとして
//      扱ってしまうと、ファイル全体にはマーカーが必ず存在するので検査が意味を
//      失うため、明示的に「モジュール直下では合格にしない」を判定に含めている。
// この規則により:
//   - 窓口関数(applyMouseButton 等)は自分自身の関数本体(=最も内側のブロック)に
//     urlWorkerMode があるので合格する。
//   - `window.addEventListener('blur', () => { host?.setJoyState(0,0); ...;
//     clearWorkerInputGeneration(); })` と visibilitychange の if ブロックは、
//     同じ/1段外のブロックに clearWorkerInputGeneration() があるので合格する
//     (apply* を経由しない、意図的な二重配線を誤検出しない)。
//   - `buttonDown: (button) => host?.setMouseButton(button, true)` (簡潔本体の
//     アロー、波括弧なし)は、最も内側のブロックがオブジェクトリテラル自体、
//     1段外が `const virtualTrackpad = createVirtualTrackpad(...)` の外側
//     (=モジュール直下)であり、どちらにもマーカーが無いため不合格になる。
//   - `pumpTouchClickQueue()` 内の直呼び出しも、関数本体(最も内側のブロック)に
//     マーカーが無く、1段外はモジュール直下なので不合格になる。
//
// 重要な限界: 検査1・検査2は「ソースの字面がどう配線されているか」という形だけを見る
// 素朴な静的検査であり、実ブラウザで実際に動作すること(initialize→ready→入力が反映される
// ところまで)は一切保証しない。波括弧の対応も、文字列・テンプレートリテラル内の
// `{`/`}` を区別しない素朴な数え上げ(完全な構文解析はしない)なので、この慣習から
// 外れた書き方をされると誤判定しうる。
//
// 陽性対照(実装時に手動で src/main.ts を書き換えて確認済み。確認後は必ず元へ戻した。
// この2回の意図的な破壊はコミットしていない):
//   1. `pumpTouchClickQueue()` 内の `applyMouseButton(button, true)` を
//      `host?.setMouseButton(button, true)` に戻す → 検査1が実際に落ちることを確認した。
//   2. `buttonDown: (button) => applyMouseButton(button, true)` を
//      `buttonDown: (button) => host?.setMouseButton(button, true)` に戻す →
//      検査1が実際に落ちることを確認した(これが今回の作り直しの主目的であり、
//      旧版ではここが緑のままだったため作り直した)。
//   両方とも `npx vitest run test/input-fanin-wiring.test.ts` で失敗を確認したのち、
//   `git diff` で元の内容に戻し、`git diff --stat` に src/ の差分が残っていないことを
//   確認した。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MouseTracker } from '../src/mouse-track';

const REPO_ROOT = resolve(__dirname, '..');

function readSrc(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
}

/** コメント(行コメント・ブロックコメント)を落とす。行番号がずれないよう、ブロック
 * コメント内の改行だけは残す(改行以外の文字を消す)。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/\/\/.*$/gm, '');
}

describe('検査1: hostへの入力メソッド直接呼び出しはWorker経路への配線が見える範囲にある', () => {
  const INPUT_METHODS = [
    'setKey',
    'sendKeyMake',
    'setJoyState',
    'setMouseButton',
    'addMouseDelta',
    'clearMouseState',
  ] as const;

  // Worker 経路への配線が実在する印となる識別子。これらのいずれかが呼び出しの
  // 「見える範囲」(最も内側のブロック、またはその1段外)に無ければ、Worker経路に
  // 一切配線されていない可能性が高い(=今回の欠陥と同型)と判定する。
  const WORKER_MARKERS = ['urlWorkerMode', 'workerInput', 'workerCoreProxy', 'clearWorkerInputGeneration'];

  interface Violation {
    line: number;
    method: string;
    sourceLine: string;
  }

  /**
   * 各 `host?.method(` / `host.method(` 出現について、「最も内側の波括弧ブロック」
   * (出現位置で開いたままの波括弧のうち最も内側のもの)と、その1段外のブロックの
   * テキストに WORKER_MARKERS が含まれるかを見る。どちらにも含まれない、または
   * 1段外に出た結果モジュール直下(波括弧0段)に達した場合は不合格とする。
   */
  function findFanInViolations(src: string): Violation[] {
    const code = stripComments(src);
    const hostCallRe = new RegExp(`host\\??\\.(${INPUT_METHODS.join('|')})\\(`, 'g');
    const occurrences: Array<{ index: number; method: string }> = [];
    let om: RegExpExecArray | null;
    while ((om = hostCallRe.exec(code))) {
      occurrences.push({ index: om.index, method: om[1] });
    }
    if (occurrences.length === 0) return [];

    const pendingByIndex = new Map<number, string>();
    for (const occ of occurrences) pendingByIndex.set(occ.index, occ.method);

    // 1パスで、(a) 各出現位置での「開いている波括弧インデックスのスタック」の
    // スナップショットと (b) 各開き波括弧→対応する閉じ波括弧インデックス、を同時に作る。
    const snapshots = new Map<number, number[]>();
    const matchClose = new Map<number, number>();
    const stack: number[] = [];
    for (let i = 0; i < code.length; i++) {
      if (pendingByIndex.has(i)) snapshots.set(i, stack.slice());
      const ch = code[i];
      if (ch === '{') {
        stack.push(i);
      } else if (ch === '}') {
        const open = stack.pop();
        if (open !== undefined) matchClose.set(open, i);
      }
    }

    function blockText(openIdx: number): string {
      const closeIdx = matchClose.get(openIdx);
      // 対応が取れない(構造が壊れている)場合は保守的に以降全部を見る。
      return closeIdx === undefined ? code.slice(openIdx) : code.slice(openIdx, closeIdx + 1);
    }
    function hasMarker(text: string): boolean {
      return WORKER_MARKERS.some((marker) => text.includes(marker));
    }

    const lineStarts: number[] = [0];
    for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1);
    function lineOf(idx: number): number {
      let line = 1;
      for (let i = 1; i < lineStarts.length; i++) {
        if (lineStarts[i] > idx) break;
        line = i + 1;
      }
      return line;
    }
    function sourceLineText(idx: number): string {
      const ln = lineOf(idx);
      const start = lineStarts[ln - 1];
      const end = code.indexOf('\n', start);
      return (end === -1 ? code.slice(start) : code.slice(start, end)).trim();
    }

    const violations: Violation[] = [];
    for (const occ of occurrences) {
      const snap = snapshots.get(occ.index) ?? [];
      let ok = false;
      if (snap.length > 0) {
        const level0 = snap[snap.length - 1];
        if (hasMarker(blockText(level0))) {
          ok = true;
        } else if (snap.length >= 2) {
          const level1 = snap[snap.length - 2];
          if (hasMarker(blockText(level1))) ok = true;
        }
        // snap.length === 1 でlevel0に無い場合、1段外は波括弧0段(モジュール直下)に
        // なるため、探索を打ち切って不合格のままにする(モジュール直下を許容しない)。
      }
      // snap.length === 0 (波括弧が一段も開いていない、モジュール直下での直接呼び出し)も
      // 不合格のままにする。
      if (!ok) {
        violations.push({ line: lineOf(occ.index), method: occ.method, sourceLine: sourceLineText(occ.index) });
      }
    }
    return violations;
  }

  it('src/main.ts: hostへの入力メソッド直接呼び出しは全てWorker経路への配線が見える範囲にある', () => {
    const src = readSrc('src/main.ts');
    const violations = findFanInViolations(src);
    if (violations.length > 0) {
      const detail = violations
        .map((v) => `  - line ${v.line}: ${v.method} -> ${v.sourceLine}`)
        .join('\n');
      throw new Error(
        `Worker経路への配線が見える範囲に無い host 直接呼び出しが見つかった。` +
          `バーチャルトラックパッドの不具合と同型の欠落の可能性がある:\n${detail}`
      );
    }
    expect(violations).toEqual([]);
  });

  it('陽性対照A: 関数本体(簡潔本体でない)からの直接呼び出しは不合格になる(合成ソースで確認)', () => {
    // pumpTouchClickQueue() 内で実際に host?.setMouseButton(...) に戻して確認した形を再現。
    const badSrc = `
function pumpTouchClickQueue(): void {
  if (touchClickBusy) return;
  host?.setMouseButton(button, true);
}
`;
    const violations = findFanInViolations(badSrc);
    expect(violations).toEqual([
      { line: 4, method: 'setMouseButton', sourceLine: 'host?.setMouseButton(button, true);' },
    ]);
  });

  it('陽性対照B: オブジェクトリテラル内の簡潔本体アローからの直接呼び出しは不合格になる(合成ソースで確認・今回の主目的)', () => {
    // buttonDown: (button) => host?.setMouseButton(button, true) に戻して確認した形を再現。
    // 最も内側のブロックはオブジェクトリテラル自体、1段外はモジュール直下(波括弧0段)であり、
    // どちらにもWorker経路マーカーが無いため不合格になるはず。
    const badSrc = `
const virtualTrackpad = createVirtualTrackpad(virtualTrackpadPanel, {
  moveBy: trackpadMoveBy,
  buttonDown: (button) => host?.setMouseButton(button, true),
  buttonUp: (button) => host?.setMouseButton(button, false),
});
`;
    const violations = findFanInViolations(badSrc);
    expect(violations).toEqual([
      { line: 4, method: 'setMouseButton', sourceLine: 'buttonDown: (button) => host?.setMouseButton(button, true),' },
      { line: 5, method: 'setMouseButton', sourceLine: 'buttonUp: (button) => host?.setMouseButton(button, false),' },
    ]);
  });

  it('陽性対照が捉える意図的な二重配線(blur/visibilitychange)は誤検出しない(合成ソースで確認)', () => {
    const goodSrc = `
window.addEventListener('blur', () => {
  host?.setJoyState(0, 0);
  host?.setJoyState(1, 0);
  releaseAllGamepadKeys();
  clearWorkerInputGeneration();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    host?.setJoyState(0, 0);
    host?.setJoyState(1, 0);
    releaseAllGamepadKeys();
    clearWorkerInputGeneration();
  }
});
`;
    expect(findFanInViolations(goodSrc)).toEqual([]);
  });

  it('窓口関数(apply*)自身の本体からの呼び出しは合格する(合成ソースで確認)', () => {
    const goodSrc = `
function applyMouseButton(button: 'left' | 'right', down: boolean): void {
  if (urlWorkerMode) {
    workerInput.mouseButton(button, down);
    return;
  }
  host?.setMouseButton(button, down);
}
`;
    expect(findFanInViolations(goodSrc)).toEqual([]);
  });
});

describe('検査2: loop() だけが呼ぶ毎フレーム処理は許可リストと完全一致する', () => {
  // 「Worker 経路には別配線がある」か「既定経路の内部処理」であることを確認済みの識別子。
  // stepTouchTrackpad は今回 frame event 側へ配線したので、ここに含めてはいけない
  // (含めてしまうと、また配線を忘れても検査2が気づけなくなる)。
  const ALLOW_LIST = [
    'computeFrameBudget',
    'drainSerialTx',
    'isAutoClockTurbo',
    'loop',
    'pollAutoSave',
    'pollDiskAccess',
    'recommendedWriteSize',
    'runFrame',
    'scheduleNext',
    'setSerialTxWritable',
    'setVideoSkip',
    'stepMouseTracking',
  ].sort();

  const RESERVED = new Set([
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'return',
    'typeof',
    'function',
    'Math',
    'performance',
    'requestAnimationFrame',
    'setTimeout',
    'setInterval',
    'clearInterval',
  ]);

  /** `startIndex` が指す `{` から、対応する `}` まで(両端含む)を切り出す。 */
  function extractBlockFrom(code: string, startIndex: number): string {
    let depth = 0;
    for (let i = startIndex; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') {
        depth--;
        if (depth === 0) return code.slice(startIndex, i + 1);
      }
    }
    throw new Error('波括弧の対応が取れなかった(対象コードの構造が変わった?)');
  }

  /** ブロック内で「識別子(」の形で呼ばれている識別子の集合を返す。`obj.method(` の場合は
   * obj/method のどちらかが除外語(予約語・Math・performance等のグローバル)なら捨てる。 */
  function extractCalledIdentifiers(block: string): Set<string> {
    const ids = new Set<string>();
    const re = /(?:([A-Za-z_$][A-Za-z0-9_$]*)\.)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block))) {
      const obj = m[1];
      const name = m[2];
      if (RESERVED.has(name)) continue;
      if (obj && RESERVED.has(obj)) continue;
      ids.add(name);
    }
    return ids;
  }

  function extractLoopBlock(code: string): string {
    const defMarker = 'function loop(t: number): void {';
    const defIdx = code.indexOf(defMarker);
    expect(defIdx, 'function loop(t: number): void { が見つからない(main.tsの構造が変わった?)').toBeGreaterThanOrEqual(0);
    const braceIdx = code.indexOf('{', defIdx);
    // シグネチャ行自体も含める(以後の識別子抽出で `loop` 自身の宣言も1件として数える。
    // これは許可リストに `loop` 自体が含まれていることの理由でもある)。
    return code.slice(defIdx, braceIdx) + extractBlockFrom(code, braceIdx);
  }

  function extractFrameEventBlock(code: string): string {
    const marker = "if (event.event === 'frame') {";
    const idx = code.indexOf(marker);
    expect(idx, "if (event.event === 'frame') { が見つからない(main.tsの構造が変わった?)").toBeGreaterThanOrEqual(0);
    const braceIdx = code.indexOf('{', idx);
    return extractBlockFrom(code, braceIdx);
  }

  function onlyInLoop(src: string): string[] {
    const code = stripComments(src);
    const loopIds = extractCalledIdentifiers(extractLoopBlock(code));
    const frameIds = extractCalledIdentifiers(extractFrameEventBlock(code));
    return [...loopIds].filter((id) => !frameIds.has(id)).sort();
  }

  it('src/main.ts: loop()の中だけにあってframe eventハンドラに無い呼び出しは、既知の許可リストのみ', () => {
    const src = readSrc('src/main.ts');
    const diff = onlyInLoop(src);
    if (JSON.stringify(diff) !== JSON.stringify(ALLOW_LIST)) {
      throw new Error(
        `loop()とframe eventハンドラの毎フレーム処理の差が変わった。\n` +
          `  実際の差分  : ${JSON.stringify(diff)}\n` +
          `  許可リスト  : ${JSON.stringify(ALLOW_LIST)}\n` +
          `差分に新しく増えたものは「loop()に増えた、Worker経路に未配線の処理」の疑いがある。\n` +
          `逆に許可リストにあるのに差分から消えたものは「許可リストの更新漏れ」の疑いがある。`
      );
    }
    expect(diff).toEqual(ALLOW_LIST);
  });

  it('陽性対照: 検出ロジック自体はloop()だけの新しい呼び出しを実際に落とせる(合成ソースで確認)', () => {
    const badSrc = `
function loop(t: number): void {
  stepTouchTrackpad();
}
proxy.setEventHandler((event: CoreEvent) => {
  if (event.event === 'frame') {
    doSomethingElse();
  }
});
`;
    const diff = onlyInLoop(badSrc);
    expect(diff).toEqual(['loop', 'stepTouchTrackpad']);
  });
});

describe('検査3: MouseTracker.hasRatio は setDesiredRatio/clearDesiredRatio に追従する(実挙動)', () => {
  it('setDesiredRatio() の後は hasRatio === true', () => {
    const tracker = new MouseTracker();
    expect(tracker.hasRatio).toBe(false);
    tracker.setDesiredRatio(0.5, 0.5);
    expect(tracker.hasRatio).toBe(true);
  });

  it('clearDesiredRatio() の後は hasRatio === false', () => {
    const tracker = new MouseTracker();
    tracker.setDesiredRatio(0.3, 0.7);
    expect(tracker.hasRatio).toBe(true);
    tracker.clearDesiredRatio();
    expect(tracker.hasRatio).toBe(false);
  });
});
