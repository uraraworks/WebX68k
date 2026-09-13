// MCPブリッジ(?bridge=1)のtype_textが使う、1文字ずつの打鍵手順。main.tsのbridgeHostと
// test/type-text-integration.test.tsの両方から呼ぶ、コアの実体を知らない純粋なロジック。
//
// 背景(化けの原因): 従来の実装は壁時計のsetTimeoutだけで「押す→90ms待つ→離す→60ms待つ→
// 次の文字」を進めていた。Worker経路では、キー状態はframe eventを受け取るたびに1回
// sendWorkerInputUpdate()でまとめて送られるため、フレームの間に起きた「shiftを離す」と
// 「次の文字キーを押す」が同じ1回の更新にまとまってしまうことがあった。X68000のキー
// ボードはmake/breakを1つずつ送るハードウェアなので、同じポーリング内に複数の変化が
// 混ざるとどちらが先に見えるかを制御できず、':'のmakeがSHIFTのbreakより先に届けば
// '*'になる、といった入れ替わりが起きる。
//
// 対策: 状態を1つ変える(shift press / key press / key release / shift release)たびに、
// コアが確実にそのポーリングで読んだと言えるまで待ってから次の変更へ進む。「何回
// 待てば確実か」はホスト側(main.tsのwaitCorePolls)が経路(既定/Worker)ごとの事情を
//踏まえて決める。ここでは「待つ」というインターフェースだけに依存する。

import { charToKey, RETROK } from './keyboard';

export interface TypeTextDeps {
  /** RETROKコードのキーを押す。 */
  press(code: number): void;
  /** RETROKコードのキーを離す。 */
  release(code: number): void;
  /**
   * 直前の状態変更を、コアがn回のポーリングで確実に読んだと言えるまで待つ。
   * コアが停止している等でn回に届かないまま長時間経過した場合はrejectする
   * (呼び出し元はこの場合、次の文字へ進まずにそのまま失敗として扱うこと)。
   */
  waitPolls(n: number): Promise<void>;
}

export interface TypeTextResult {
  typed: number;
  skipped: string[];
}

// キーを押しっぱなしにしておくポーリング回数。1回だと「押した直後の1回のポーリングで
// ちょうど読み損ねる」余地が残るため、releaseを待つ回数(SETTLE_POLLS)より長めに
// 確保しておく。X68000側の実際のキー読み取り周期(IOCS経由のBITSNS等)に対して
// 十分な余裕を持たせるための安全側の値であり、この回数でなければならない根拠となる
// 実測値があるわけではない。
const HOLD_POLLS = 3;

// 状態変更(press/release)のあと、次の状態変更に進んでよいと判断するまでの
// 最小ポーリング回数。src/key-repeat.tsの知見(「releaseの後、押し直してよいのは
// 2回目のonPollから。1回目の時点ではそのフレームのinput_stateはまだ読まれていない」)
// と同じ理由で2回にしてある。
const SETTLE_POLLS = 2;

/**
 * ASCII文字列を1文字ずつ、shiftの有無を含めて正しい順序でキー入力として打鍵する。
 * 対応していない文字(全角等)はskippedへ積んで読み飛ばす。
 */
export async function typeTextSequence(text: string, deps: TypeTextDeps): Promise<TypeTextResult> {
  const skipped: string[] = [];
  let typed = 0;
  for (const ch of text) {
    const key = charToKey(ch);
    if (!key) {
      skipped.push(ch);
      continue;
    }
    if (key.shift) {
      deps.press(RETROK.LSHIFT);
      await deps.waitPolls(SETTLE_POLLS);
    }
    deps.press(key.code);
    await deps.waitPolls(HOLD_POLLS);
    deps.release(key.code);
    await deps.waitPolls(SETTLE_POLLS);
    if (key.shift) {
      deps.release(RETROK.LSHIFT);
      await deps.waitPolls(SETTLE_POLLS);
    }
    typed++;
  }
  return { typed, skipped };
}
