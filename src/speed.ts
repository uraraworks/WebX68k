// エミュレーション速度倍率まわりの純粋関数群。
//
// px68k_cpuspeed(コアの CPU クロック設定、マシン構成扱い)とは別物。あちらは実機のクロックを
// 変える設定でリセットが要る。こちらは「ホスト側のフレーム供給ペースを何倍で回すか」で、
// 実行中に即時反映される。

/**
 * 選択可能な速度倍率。100%(1) はここに含めない。
 *
 * この値はツールバーの速度ボタンをONにしたときの倍率であり、ボタンOFF時は常に実効倍率が
 * 1(100%)になる。もし選択肢に100%を残すと「ONにしても何も起きない」意味のない組み合わせが
 * できてしまうため、意図的に外している。
 */
export const SPEED_STEPS = [0.25, 0.5, 0.75, 1.5, 2, 3, 4] as const;
export type SpeedStep = (typeof SPEED_STEPS)[number];

/** cfg-speed の既定値。早送り(倍速)が最多用途と見込まれるため200%を既定にする。 */
export const DEFAULT_SPEED_STEP: SpeedStep = 2;

/** cfg-speed の value(文字列)を SPEED_STEPS の中の値へ検証つきで変換する。不正値は既定倍率へ倒す。 */
export function parseSpeedStep(raw: string): SpeedStep {
  const n = Number(raw);
  const found = SPEED_STEPS.find((step) => step === n);
  return found ?? DEFAULT_SPEED_STEP;
}

/**
 * 可変レートリサンプラの内部状態。
 *
 * コアは1エミュフレームぶんの音声サンプルを必ず一定量吐くため、速度倍率 k のときは
 * 単純に間引き/水増しするだけでは音の高さが変わらずブツブツ途切れる(テープの一時停止を
 * 繰り返すのと同じ)。ここでは「テープ早送り」のように読み出し位置を k ずつ進めて線形補間する
 * ことで、ピッチが変わる自然な早送り/スローに聞こえるようにする。
 *
 * phase / lastFrame はチャンク(main.ts が受け取る1回ぶんの Float32Array)をまたいで
 * 保持する必要がある。チャンクごとに 0 へ戻すと、境界のたびに位相が飛んでプチノイズが乗る。
 */
export interface ResampleState {
  /** 次に読み出すフレーム位置。現在のチャンク先頭を 0 とした相対位置(負値は前チャンク側)。 */
  phase: number;
  /** 直前チャンクの最終フレーム [L, R]。まだ何も処理していなければ null。 */
  lastFrame: readonly [number, number] | null;
}

export function createResampleState(): ResampleState {
  return { phase: 0, lastFrame: null };
}

/** 速度変更・ステートロード・リセット等で内部状態を初期化する。 */
export function resetResampleState(state: ResampleState): void {
  state.phase = 0;
  state.lastFrame = null;
}

/**
 * interleaved ステレオ Float32Array([L0,R0,L1,R1,...]) を速度倍率 k で線形補間リサンプルする。
 *
 * k === 1 のときは呼び出し側(main.ts)で完全にバイパスし、この関数自体を呼ばないのが基本だが、
 * 誤って呼ばれても入力をそのまま返すフェイルセーフとして k===1 を特別扱いする。速度ボタンが
 * OFFのとき(実効倍率が常に1)にこの経路を通るため、SPEED_STEPS から1を外した後も必要。
 */
export function resampleSpeed(input: Float32Array, k: number, state: ResampleState): Float32Array {
  const framesIn = input.length >> 1;
  if (framesIn === 0) return input;

  if (k === 1) {
    state.phase = 0;
    state.lastFrame = [input[input.length - 2], input[input.length - 1]];
    return input;
  }

  // このコールバックは音声ホットパス(コアの1フレームごと=最大で秒間数百回)で呼ばれ、
  // 低倍率(0.25倍等)では1チャンクあたり出力フレーム数が数千に達する。フレームごとに
  // 配列(number[]のpush、frameAt()が返すタプル)を生成するとGCの負荷が無視できないため、
  // 出力長を先に見積もって Float32Array を1回だけ確保し、インデックス書き込みする。
  //
  // 見積り式 ceil((framesIn-1-phase)/k) は理論上ぴったりの出力フレーム数と一致するはずだが、
  // 浮動小数の丸めで実際のループ回数と1ずれる可能性があるため、+1して必ず上限側に倒し、
  // 実際に書き込んだフレーム数(n)で最後に subarray して正確な長さへ切り詰める。
  const lastFrame = state.lastFrame;
  const estFrames = Math.max(0, Math.ceil((framesIn - 1 - state.phase) / k) + 1);
  const out = new Float32Array(estFrames * 2);

  let pos = state.phase;
  let n = 0;
  // i0+1 がまだ現チャンクに存在しない位置まで来たら打ち切り、続きは次チャンクへ持ち越す。
  while (Math.floor(pos) < framesIn - 1) {
    const i0 = Math.floor(pos);
    const frac = pos - i0;

    let l0: number, r0: number;
    if (i0 < 0) {
      [l0, r0] = lastFrame ?? [input[0], input[1]];
    } else {
      l0 = input[i0 * 2];
      r0 = input[i0 * 2 + 1];
    }

    const i1 = i0 + 1;
    let l1: number, r1: number;
    if (i1 < 0) {
      [l1, r1] = lastFrame ?? [input[0], input[1]];
    } else {
      l1 = input[i1 * 2];
      r1 = input[i1 * 2 + 1];
    }

    out[n * 2] = l0 + (l1 - l0) * frac;
    out[n * 2 + 1] = r0 + (r1 - r0) * frac;
    n++;
    pos += k;
  }

  state.phase = pos - framesIn;
  state.lastFrame = [input[framesIn * 2 - 2], input[framesIn * 2 - 1]];
  return n === estFrames ? out : out.subarray(0, n * 2);
}
