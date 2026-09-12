// 起動中にライブラリからFDDへ挿入→リセットすると
// `Cannot perform ArrayBuffer.prototype.slice on a detached ArrayBuffer` になる不具合の
// 再発防止テスト(実測、2026-09-12)。
//
// 原因: src/main.ts の workerHotSwapFdd() が、スロットが持ち続ける image.data を
// toOwnedArrayBuffer() でWorkerへ転送(transfer listに載せてdetach)していた。
// toOwnedArrayBuffer()は「バッファ全体を覆っているUint8Arrayならコピーせずbytesをそのまま
// 返す」ため、slots[slot].data も道連れでdetachされ、次のリセット(bootCore()→
// WorkerCoreProxy#init())がその同じバッファに対して copyArrayBuffer() 経由の .slice() を
// 呼んで失敗する。直し方は copyArrayBuffer() (常にコピー)に替えること。
//
// 同種の不具合は 2026-08-31(init()の経路)と今回(挿入=hotSwapFddの経路)の2回起きている。
// test/core-proxy.test.ts の「main.tsのworkerHotSwapFdd呼び出し形」は、main.ts の
// 呼び出し方をテストの中で"真似た"ものであり、main.ts のソース自体が将来また
// toOwnedArrayBuffer(image.data) に戻っても検出できない。このテストは
// test/core-asset-root-absolute-path.test.ts と同じ流儀で、main.ts のソースそのものを
// 静的に検査する。
//
// 陽性対照(実装時に手動で確認済み): src/main.ts の workerHotSwapFdd() 内の
// `copyArrayBuffer(image.data)` を一時的に `toOwnedArrayBuffer(image.data)` へ書き戻すと、
// 下の「呼び出し方」テストが実際に落ちることを `npx vitest run
// test/main-worker-hotswap-fdd-detach.test.ts` で確認した(確認後は git diff で元に戻し、
// src/ に差分が残っていないことを確認済み)。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..');
const MAIN_TS_PATH = resolve(REPO_ROOT, 'src/main.ts');

/** コメント(行コメント・ブロックコメント)を落とした「実コードだけ」を返す。
 * test/core-asset-root-absolute-path.test.ts / test/core-worker-build-format.test.ts と
 * 同じ素朴な実装(文字列・テンプレートリテラル内の `//` は考慮しないが、対象箇所には
 * 該当しない)。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** `functionName` という名前の `function` 宣言の本体(開始 `{` から対応する閉じ `}` まで、
 * 両端の波括弧込み)を、素朴な波括弧カウントで切り出す。文字列/テンプレートリテラル中の
 * `{`/`}` は考慮しないが、対象の関数本体には該当しない(呼び出し元コード中心のため)。 */
function extractFunctionBody(code: string, functionName: string): string {
  const marker = new RegExp(`function\\s+${functionName}\\s*\\(`);
  const match = marker.exec(code);
  if (!match) {
    throw new Error(`関数 ${functionName} の宣言が見つからない(名前が変わった/削除された?)`);
  }
  // 引数リストの型注釈(例: `image: { name: string; data: Uint8Array } | null`)にも `{` が
  // 現れうるため、まず引数リストの対応する ')' まで括弧カウントでスキップしてから、本体の
  // 開始 '{' を探す。
  const paramStart = code.indexOf('(', match.index);
  if (paramStart === -1) {
    throw new Error(`関数 ${functionName} の引数リスト開始 '(' が見つからない`);
  }
  let parenDepth = 0;
  let paramEnd = -1;
  for (let i = paramStart; i < code.length; i++) {
    if (code[i] === '(') parenDepth++;
    else if (code[i] === ')') {
      parenDepth--;
      if (parenDepth === 0) {
        paramEnd = i;
        break;
      }
    }
  }
  if (paramEnd === -1) {
    throw new Error(`関数 ${functionName} の引数リスト終端 ')' が見つからない`);
  }
  const braceStart = code.indexOf('{', paramEnd + 1);
  if (braceStart === -1) {
    throw new Error(`関数 ${functionName} の本体開始 '{' が見つからない`);
  }
  let depth = 0;
  for (let i = braceStart; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return code.slice(braceStart, i + 1);
    }
  }
  throw new Error(`関数 ${functionName} の本体終端 '}' が見つからない(波括弧の対応が崩れている?)`);
}

/** `toOwnedArrayBuffer(` 呼び出しの引数部分(対応する閉じ ')' まで、素朴な括弧カウントで
 * 抽出、末尾の閉じ括弧は含まない)を全て列挙する。 */
function findToOwnedArrayBufferArgs(code: string): string[] {
  const args: string[] = [];
  const callRe = /toOwnedArrayBuffer\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(code))) {
    const argStart = m.index + m[0].length;
    let depth = 1;
    let i = argStart;
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) {
      throw new Error(`toOwnedArrayBuffer( の対応する ')' が見つからない(位置 ${m.index} 付近)`);
    }
    args.push(code.slice(argStart, i));
  }
  return args;
}

describe('src/main.ts の workerHotSwapFdd(): image.dataをdetachしない(静的検査)', () => {
  const raw = readFileSync(MAIN_TS_PATH, 'utf8');
  const code = stripComments(raw);
  const body = extractFunctionBody(code, 'workerHotSwapFdd');

  it('workerHotSwapFdd() の本体に toOwnedArrayBuffer( を使っていない', () => {
    expect(
      body.includes('toOwnedArrayBuffer('),
      'workerHotSwapFdd() の中で toOwnedArrayBuffer( が使われている。' +
        'image.data は呼び出し元(slots[slot].data)が挿入後も持ち続ける実体であり、' +
        'toOwnedArrayBuffer() はバッファ全体を覆う場合コピーせず転送でdetachしてしまう。' +
        'copyArrayBuffer() を使うこと。',
    ).toBe(false);
  });

  it('workerHotSwapFdd() の本体で image.data を copyArrayBuffer( 経由で渡している', () => {
    expect(
      /copyArrayBuffer\(\s*image\.data\s*\)/.test(body),
      'workerHotSwapFdd() の本体に copyArrayBuffer(image.data) の呼び出しが見つからない。' +
        '(image.dataは呼び出し元が持ち続ける実体なので、Workerへ渡す前に必ずコピーが必要)',
    ).toBe(true);
  });
});

describe('src/main.ts 全体の toOwnedArrayBuffer( 呼び出し(許可リストとの照合、静的検査)', () => {
  // toOwnedArrayBuffer() は「呼び出し元がそのバイト列を以後使わない(使い捨て)」場合にだけ
  // 安全(転送でdetachされてよいため)。以下は実際にソースを読んで「使い捨てである」ことを
  // 確認済みの引数の式(照合は行番号ではなく式そのもので行う)。
  //   - `new TextEncoder().encode(...)`: その場で新規生成したバッファで、以後参照されない
  //     (iniText/cmdTextの書き込み。src/main.ts の bootCore 系処理)。
  //   - `stored.bytes`: IndexedDBから読み直したばかりの値で、この呼び出し以降使わない
  //     (unserialize時の復元。呼び出し元コメントで明示済み)。
  // このリストに無い呼び出しが増えたら、このテストが落ちる。
  const ALLOWED_ARG_PATTERNS: RegExp[] = [
    /^\s*new TextEncoder\(\)\.encode\(/,
    /^\s*stored\.bytes\s*$/,
  ];

  it('許可リストに無い引数での toOwnedArrayBuffer( 呼び出しが増えていない', () => {
    const raw = readFileSync(MAIN_TS_PATH, 'utf8');
    const code = stripComments(raw);
    const args = findToOwnedArrayBufferArgs(code);
    expect(args.length, 'toOwnedArrayBuffer( の呼び出しが1つも見つからない(検出ロジックが壊れている?)').toBeGreaterThan(0);

    const unlisted = args.filter((arg) => !ALLOWED_ARG_PATTERNS.some((pattern) => pattern.test(arg)));
    expect(
      unlisted,
      `src/main.ts に許可リストに無い toOwnedArrayBuffer(...) 呼び出しが見つかった: ` +
        `${JSON.stringify(unlisted)}。呼び出し元がそのバイト列(実体)を以後も持ち続けるなら ` +
        `copyArrayBuffer() を使うこと(toOwnedArrayBuffer()は転送でdetachされ、呼び出し元の値も ` +
        `壊れる)。使い捨て(このバイト列を以後参照しない)だと確かめたなら、このテストの ` +
        `ALLOWED_ARG_PATTERNS に式を足すこと。`,
    ).toEqual([]);
  });
});
