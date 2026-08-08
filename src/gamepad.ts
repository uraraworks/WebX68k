/**
 * ゲームパッド(Gamepad API)入力を X68000 の 2 ボタンジョイスティック入力へ変換する。
 *
 * Phase 1 では既定マッピング(XINPUT_PRESET)固定で実際に遊べる状態を作るところまでが目標。
 * ただし後続フェーズ(ユーザーが割当を編集して永続化する)で型を作り直さずに済むよう、
 * 最初からマッピングをデータ(Source -> Binding の対応表)として表現しておく。
 * 編集UI・永続化(localStorage 保存等)は Phase 3/4 で追加する。
 */

/**
 * X68000 側の入力先。
 * UP/DOWN/LEFT/RIGHT は方向、TRG1/TRG2 が標準 2 ボタンパッドのボタン。
 * TRG3..TRG8 は px68k-libretro が対応する CPSF-MD/CPSF-SFC(8ボタン)パッド向け。
 * どの RetroPad ID がどの TRGn になるかは padType(px68k_joytype1/2 コアオプション)によって
 * 変わるため、対応表は retroIdFor()/RETRO_ID_MAPS を参照すること(このコメントでは決め打ちしない)。
 */
export type JoyTarget =
  | 'UP'
  | 'DOWN'
  | 'LEFT'
  | 'RIGHT'
  | 'TRG1'
  | 'TRG2'
  | 'TRG3'
  | 'TRG4'
  | 'TRG5'
  | 'TRG6'
  | 'TRG7'
  | 'TRG8';

/** isBinding() の検証用に全 JoyTarget を列挙したもの(値そのものには意味を持たせない)。 */
const ALL_JOY_TARGETS: readonly JoyTarget[] = [
  'UP',
  'DOWN',
  'LEFT',
  'RIGHT',
  'TRG1',
  'TRG2',
  'TRG3',
  'TRG4',
  'TRG5',
  'TRG6',
  'TRG7',
  'TRG8',
];

/**
 * px68k-libretro のパッド種別(px68k_joytype1/2 コアオプション)。
 * サイバースティックは対象外(アナログモード非対応・ポート2に選択肢自体が無い)。
 * 値は libretro_core_options.h の選択肢文字列と1:1(PAD_TYPE_CORE_OPTION_VALUE で変換する)。
 */
export type PadType = 'default' | 'cpsf-md' | 'cpsf-sfc';

export const PAD_TYPES: readonly PadType[] = ['default', 'cpsf-md', 'cpsf-sfc'];

/**
 * PadType -> px68k_joytype1/2 コアオプションの値文字列。
 * px68k-libretro/libretro_core_options.h の px68k_joytype1/2 の選択肢表記と完全一致させること
 * (update_variables() が strcmp で照合しており、1文字でもずれると PAD_2BUTTON にフォールバックする)。
 */
export const PAD_TYPE_CORE_OPTION_VALUE: Record<PadType, string> = {
  default: 'Default (2 Buttons)',
  'cpsf-md': 'CPSF-MD (8 Buttons)',
  'cpsf-sfc': 'CPSF-SFC (8 Buttons)',
};

/** その padType で編集/表示すべき JoyTarget 一覧(表示順)。2ボタンは TRG1/TRG2 のみ、8ボタンは TRG1..TRG8。 */
export function joyTargetsForPadType(padType: PadType): readonly JoyTarget[] {
  const base: JoyTarget[] = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'TRG1', 'TRG2'];
  if (padType === 'default') return base;
  return [...base, 'TRG3', 'TRG4', 'TRG5', 'TRG6', 'TRG7', 'TRG8'];
}

// UP/DOWN/LEFT/RIGHT は px68k-libretro/libretro/joystick.c の D-Pad 判定(RETRO_DEVICE_ID_JOYPAD_UP=4 等、
// Joystick_Update() 235行目付近)に合わせてある。padType に関わらず共通。
const DIRECTION_RETRO_IDS = { UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7 } as const;

/**
 * JoyTarget -> RetroPad ID(inputStateCb の id 引数、= libretro の RETRO_DEVICE_ID_JOYPAD_*)対応表。
 * padType ごとに異なる(px68k-libretro/libretro/joystick.c の Joystick_Update() が padType(=
 * Config.JOY_TYPE[port])に応じて別の分岐でボタンを解釈するため)。値は同ファイルの実装から
 * 確定させたもので、推測は含まない。
 *
 * - default(PAD_2BUTTON, 250行目付近): Config.VbtnSwap 既定 false のとき、
 *   RetroPad B(id=0) -> JOY_TRG1, RetroPad A(id=8) -> JOY_TRG2。
 * - cpsf-md(PAD_CPSF_MD, 279〜312行目): A(id=8)->TRG1(Low-Kick), B(id=0)->TRG2(Mid-Kick),
 *   Y(id=1)->TRG3(Mid-Punch), X(id=9)->TRG4(Low-Punch), L(id=10)->TRG5(High-Punch),
 *   Start(id=3)->TRG6, Select(id=2)->TRG7, R(id=11)->TRG8(High-Kick)。
 * - cpsf-sfc(PAD_CPSF_SFC, 314〜342行目): B(id=0)->TRG1, A(id=8)->TRG2, X(id=9)->TRG3,
 *   Y(id=1)->TRG4, R(id=11)->TRG5, Start(id=3)->TRG6, Select(id=2)->TRG7, L(id=10)->TRG8。
 */
const RETRO_ID_MAPS: Record<PadType, Record<JoyTarget, number>> = {
  default: {
    ...DIRECTION_RETRO_IDS,
    TRG1: 0, // RetroPad B
    TRG2: 8, // RetroPad A
    // TRG3..TRG8 は default(2ボタン)では参照されない。default の入れ物として cpsf-md と同じ値を
    // 置いているだけで、実際に使われるのは padType が cpsf-md/cpsf-sfc のときだけ。
    TRG3: 1,
    TRG4: 9,
    TRG5: 10,
    TRG6: 3,
    TRG7: 2,
    TRG8: 11,
  },
  'cpsf-md': {
    ...DIRECTION_RETRO_IDS,
    TRG1: 8, // RetroPad A (Low-Kick)
    TRG2: 0, // RetroPad B (Mid-Kick)
    TRG3: 1, // RetroPad Y (Mid-Punch)
    TRG4: 9, // RetroPad X (Low-Punch)
    TRG5: 10, // RetroPad L (High-Punch)
    TRG6: 3, // RetroPad Start
    TRG7: 2, // RetroPad Select (Mode)
    TRG8: 11, // RetroPad R (High-Kick)
  },
  'cpsf-sfc': {
    ...DIRECTION_RETRO_IDS,
    TRG1: 0, // RetroPad B
    TRG2: 8, // RetroPad A
    TRG3: 9, // RetroPad X
    TRG4: 1, // RetroPad Y
    TRG5: 11, // RetroPad R
    TRG6: 3, // RetroPad Start
    TRG7: 2, // RetroPad Select
    TRG8: 10, // RetroPad L
  },
};

/** JoyTarget -> RetroPad ID を padType に応じて引く。padType省略時は default(2ボタン)。 */
export function retroIdFor(target: JoyTarget, padType: PadType = 'default'): number {
  return RETRO_ID_MAPS[padType][target];
}

/** 後方互換のため残す default(2ボタン)固定の対応表。isBinding() の検証にのみ使う。 */
export const TARGET_TO_RETRO_ID: Record<JoyTarget, number> = RETRO_ID_MAPS.default;

/**
 * 1つの物理入力(Source)に対する割当先。
 * `key` は Phase 4(物理キーボードのキーを直接叩く割当)で使う型。Phase 1 では作らない。
 */
export type Binding = { kind: 'joy'; target: JoyTarget } | { kind: 'key'; retrok: number };

/** 物理入力側。軸はデッドゾーンを超えた方向(dir)ごとに別の Source として扱う。 */
export type Source = { kind: 'button'; index: number } | { kind: 'axis'; index: number; dir: 1 | -1 };

function sourceKey(source: Source): string {
  return source.kind === 'button' ? `b${source.index}` : `a${source.index}${source.dir > 0 ? '+' : '-'}`;
}

/**
 * Gamepad API の standard mapping を前提にした既定割当。
 * buttons[0](下ボタン、standard mapping では B 相当)-> TRG1、buttons[1](右ボタン、A 相当)-> TRG2。
 * buttons[12..15] が D-Pad 上下左右。axes[0]/[1] は左スティックで左右/上下へ量子化する
 * (X68000 標準パッドはデジタルなので、アナログ量ではなく閾値越えの有無だけを見る)。
 */
export const XINPUT_PRESET: ReadonlyArray<{ source: Source; binding: Binding }> = [
  { source: { kind: 'button', index: 0 }, binding: { kind: 'joy', target: 'TRG1' } },
  { source: { kind: 'button', index: 1 }, binding: { kind: 'joy', target: 'TRG2' } },
  { source: { kind: 'button', index: 12 }, binding: { kind: 'joy', target: 'UP' } },
  { source: { kind: 'button', index: 13 }, binding: { kind: 'joy', target: 'DOWN' } },
  { source: { kind: 'button', index: 14 }, binding: { kind: 'joy', target: 'LEFT' } },
  { source: { kind: 'button', index: 15 }, binding: { kind: 'joy', target: 'RIGHT' } },
  { source: { kind: 'axis', index: 0, dir: -1 }, binding: { kind: 'joy', target: 'LEFT' } },
  { source: { kind: 'axis', index: 0, dir: 1 }, binding: { kind: 'joy', target: 'RIGHT' } },
  { source: { kind: 'axis', index: 1, dir: -1 }, binding: { kind: 'joy', target: 'UP' } },
  { source: { kind: 'axis', index: 1, dir: 1 }, binding: { kind: 'joy', target: 'DOWN' } },
];

/** 軸の既定デッドゾーン。この値を超えた(等しいだけでは超えない)ときにその方向を「入力あり」とみなす。 */
export const DEFAULT_DEADZONE = 0.5;

// --- 軸判定(静止値からの偏差・範囲外軸の除外・較正) ---
//
// 実機(8BitDo M30/Micro、D-inputモード)で判明した事実(2026-08-08、実機のライブ表示観測で確定):
// - 十字キーは axes[0]/axes[1] の軸で来る(ボタンではない)。
// - axes[3]/axes[4](アナログトリガ)は、そのパッドを観測開始してから一度もそのトリガを
//   動かしていない間は 0.0 を報告し続け、一度でも動かす(押す/離す)と、以後は真の静止値
//   -1.0 を報告するようになる。「軸の値には最初から意味がある」という前提そのものが誤りで、
//   「一度も動いていない軸の値は無意味(0.0 は偽の静止値)」というのが実機の挙動。
// - axes[9] は常に [-1,1] の範囲外の値(M30=3.29 / Micro=1.29)を返す。十字キーのハット軸が
//   数値化されたものと見られ、実質「無効な軸」として扱うしかない。
//
// --- これまでの4回の誤った修正(同じ失敗を繰り返さないための記録) ---
// 1回目: 初回観測値をそのまま静止値として固定する設計。押す前は0を返すため rest=0 と
//   記録してしまい、一度押した後の真の値(-1.0)との偏差が常にデッドゾーンを超え、ON固着した。
// 2回目: 既知パッド(M30/Micro)の axes[3]/[4] は実機の値(-1.0)を静止値として固定する設計
//   (knownAxisRestFor、削除済み)。押す前から rest=-1.0 なのに実際の値は0のため、今度は
//   押す前から偏差が生じてON固着した(症状が前倒しになっただけで解決していなかった)。
// 3回目: 「一度変化してから数フレーム(AXIS_CALIBRATION_STABLE_FRAMES=2)同じ値が続いたら
//   静止値として確定する」安定検出方式(advanceAxisCalibration の旧実装、削除済み)。
//   これは「安定して見えるか」だけを見ており、実機で L を押せば2フレーム(約33ms)など
//   一瞬で超えてしまうため、押している間の値(+1.0)がそのまま静止値として誤確定し、
//   離した後の真の値(-1.0)との偏差でON固着した。「一定フレーム変化しない」を安定の
//   証拠にする限り、押しっぱなしと本当の静止は区別できない。
// 4回目: 「一度動かされてから固定長のウィンドウ(AXIS_CALIBRATION_WINDOW_FRAMES=240フレーム
//   ≒4秒)ぶん、量子化した値ごとの滞在フレーム数(dwell)を数え、期間終了時点で最も長く滞在
//   した値を採用する」dwellベースの多数決方式(advanceAxisCalibration の旧実装、削除済み)。
//   離した後の滞在時間が押している時間より長いことを期待する設計だが、ウィンドウは「軸が
//   最初に動いた瞬間」から機械的に締め切られるため、押している時間がウィンドウの半分
//   (120フレーム)を超えると多数決が押下値側に傾き、離した後もそのまま誤確定する
//   (2026-08-08、実機のライブ操作で確認)。押している時間の長さを問わず「今まだ動いている
//   最中かもしれない値」を確定候補にしてしまう点は3回目と同根で、単に閾値を伸ばしただけ
//   だった。
//
// 結論(今回の設計・「離れてから確定」方式): 較正ウィンドウという「締め切り」自体を廃止する。
// 軸ごとに「較正済みか」の状態を持ち、未較正の間は判定に使わない(入力を一切生成しない、
// ここは従来どおり)。観測開始時の値を baseline として記録し、それと異なる値(量子化ビン)を
// 一度でも観測したら(=一度動かされたら)、そこから「区間(segment)」の追跡を始める:
// 値が量子化ビンで変わるたびに新しい区間として数え直し、区間番号(segments、baseline を
// 離れて最初にいる区間が1)と、その区間に連続して滞在しているフレーム数(segmentFrames)を
// 持つ。
// 「baseline を離れて最初の区間(segments===1)」は、それが押している最中の値である可能性を
// 排除できないため、どれだけ長く滞在してもそれだけでは確定しない(=旧実装のように締め切りで
// 機械的に確定することがない。これが4回目の失敗の直接の解決)。
// 2番目以降の区間(segments>=2、= 一度違う値へ移ってから今の値に来た区間)に
// AXIS_CALIBRATION_SETTLE_FRAMES フレーム連続で滞在したら、そこで初めて静止値として確定する。
// 「最初の押下(区間1)を離れて、別の値(区間2以降)に落ち着いた」ことを条件にすることで、
// 「一度離れてから戻ってきて落ち着いた値」だけを確定候補にする(要求仕様の不変条件)。
// 押しっぱなしがどれだけ長時間(区間1のまま)続いても確定せず、離す(区間が切り替わる)まで
// 待つ。較正完了後は静止値を二度と更新しない(押しっぱなしの間に静止値が追いついてOFFに戻って
// しまう問題を避けるため。この方針自体は旧実装から踏襲)。
// baseline のまま一度も動いていない軸は hasMoved が立たず区間の追跡自体を始めないため、
// 較正されない(初期状態から動かない軸が勝手に較正されて誤ったrest(baselineそのもの)を
// 採用してしまう事故を防ぐ)。
//
// --- 副作用の手当て(2026-08-08): 較正完了までUP/DOWN/LEFT/RIGHT等の入力が
// 一切効かなくなる問題 ---
// 上記の設計は「較正が終わるまで入力を一切生成しない」ことを前提にしていたが、
// 8BitDo M30 のように十字キーそのものが軸(axes[0]/[1])で来るパッドでは、十字キーを初めて
// 倒した瞬間から較正が始まり、区間2以降が確定するまでの間、方向入力が一切効かなくなって
// しまう(ゲーム中は致命的)。
// これを避けるため、GamepadManager.forEachActiveSource() は「その軸に割当があるかどうか」で
// 較正中の扱いを分ける: 割当のある軸は較正中でも baseline(観測開始時点=まだ動いていない
// 時点の値)を暫定の静止値として使い、較正完了を待たずに入力を生成する。通常のスティック/
// 十字キーは静止値が最初から0付近で正しいため、これで即座に正しく動く。割当の無い軸
// (未割当のトリガ軸等)は従来どおり較正完了まで入力を生成しない(今回の不具合はここで
// 起きていたため、塞いだままにする)。較正が完了したら(その軸のcalibrated:trueへの遷移)
// 暫定値(baseline)から確定値(rest)へ切り替わるが、通常は区間2(=一度動いてから戻った先)が
// baseline と同じ値になるケースが大半であるため rest は baseline と一致し、押しっぱなしの
// 入力が切り替え境界で途切れたり固着したりしない(forEachActiveSource() のコメント・
// test/gamepad.test.ts 参照)。
//
// 以下は純粋関数として切り出し、GamepadManager(継続的なビット計算)・gamepad-ui.ts
// (ライブ表示・検出モード)の両方から同じ判定ロジックを共有する。

/**
 * 軸の値が有効(Gamepad API の仕様上ありうる [-1, 1] の範囲内の有限値)かどうか。
 * 範囲外はハット軸などが数値化されて紛れ込んだものとみなし、無効な軸として扱う
 * (bitsFor/ライブ表示/検出モード/割当選択肢のいずれからも除外する)。
 */
export function isAxisValueValid(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -1 && value <= 1;
}

/**
 * 軸の現在値(value)が静止値(rest)からデッドゾーンを超えて偏差しているか、その方向を返す純粋関数。
 * value/rest のいずれかが無効な軸の値(isAxisValueValid が false)なら常に null(無効な軸として扱う)。
 * 静止値そのものからの偏差で見るため、rest が 0 でない軸(例: 未押下トリガの -1.0)でも
 * 「動いていなければ null」になる。
 */
export function axisDeviationDir(value: number, rest: number, deadzone: number): 1 | -1 | null {
  if (!isAxisValueValid(value) || !isAxisValueValid(rest)) return null;
  const delta = value - rest;
  if (delta <= -deadzone) return -1;
  if (delta >= deadzone) return 1;
  return null;
}

/**
 * 区間(segment)を数える際の量子化幅。
 * 浮動小数点の微小なブレ(実測: 通常スティックの静止値は厳密な0ではなく -0.00392 等)を
 * そのままキーにすると、本来同じ「静止している」フレーム同士が別の区間として扱われてしまい、
 * 滞在が分散して正しい静止値を選べなくなる。0.05刻みに丸めてビン分けすることでこれを防ぐ
 * (実機の主要な静止値/フルスケール値である 0 / ±1.0 はこの粒度でも丸め誤差なく厳密に載る)。
 */
export const AXIS_CALIBRATION_QUANTUM = 0.05;

/**
 * 「離れてから確定」方式で、ある値(区間)に静止値として確定するために必要な連続滞在フレーム数。
 * host.onPoll はエミュレートフレームごとに呼ばれ、X68000本来のフレームレート(約55.4Hz)は
 * およそ60fpsとみなせるので、60fps換算で1.5秒ぶんの目安として60fps×1.5秒=90に設定
 * (要求仕様の「目安1〜2秒」の中央値)。
 *
 * この定数が使われるのは baseline を離れて2番目以降の区間(segments>=2)だけである点が重要:
 * 最初の区間(baseline を離れて最初にいる値、segments===1)は、この定数の値に関わらず
 * どれだけ長く滞在しても確定しない(旧dwell実装が「押しっぱなしが長くても、離した後の滞在が
 * それを上回れば正しく較正できる」という前提のまま、長押し(数秒〜10秒)がウィンドウの過半を
 * 占めると誤確定していた反省から、「今まだ動いている最中かもしれない値」を確定候補にすること
 * 自体をやめた)。そのため、この値は「一度動いてから、別の値に落ち着くまで待つ時間」の
 * 短さ(体感の較正完了までの遅延)だけを左右し、長押しへの耐性には影響しない
 * (advanceAxisCalibration のコメント参照)。
 */
export const AXIS_CALIBRATION_SETTLE_FRAMES = 90;

/** value を AXIS_CALIBRATION_QUANTUM 刻みのビンへ丸める(区間判定のキー用)。-0 は 0 に正規化する。 */
function quantizeAxisValue(value: number): number {
  const q = Math.round(value / AXIS_CALIBRATION_QUANTUM) * AXIS_CALIBRATION_QUANTUM;
  return q === 0 ? 0 : q;
}

/**
 * 軸1本ぶんの較正状態。
 * - calibrated:false … まだ静止値が確定していない(入力判定には使わない)。baseline は
 *   観測開始時点(その軸を最初に見た瞬間)の値。hasMoved は baseline から一度でも変化した
 *   ことがあるか(false の間は区間の追跡を始めていない=較正未着手)。hasMoved:true の間は
 *   segmentValue(現在の区間の量子化値)・segmentFrames(その区間に連続して滞在している
 *   フレーム数)・segments(baseline を離れてから何番目の区間か、最初の区間が1)を持つ。
 * - calibrated:true … 静止値(rest)が確定済み。以後 advanceAxisCalibration() は状態を
 *   変えずにそのまま返す(二度と rest を更新しない)。
 */
export type AxisCalibration =
  | {
      calibrated: false;
      baseline: number;
      hasMoved: boolean;
      segmentValue: number;
      segmentFrames: number;
      segments: number;
    }
  | { calibrated: true; rest: number };

/** その軸を初めて観測した時点の較正状態を作る(baseline=今の値、まだ未較正・区間の追跡もまだ開始しない)。 */
export function initAxisCalibration(value: number): AxisCalibration {
  return { calibrated: false, baseline: value, hasMoved: false, segmentValue: quantizeAxisValue(value), segmentFrames: 0, segments: 0 };
}

/**
 * 軸較正状態を1フレームぶん進める純粋関数。GamepadManager(継続的な観測)と
 * gamepad-ui.ts(較正中の表示)の両方から同じロジックを共有するために切り出す。
 * 較正済み(calibrated:true)であれば何も変えずそのまま返す(rest固定)。
 *
 * 未較正の場合:
 * - まだ一度も動いていない(hasMoved:false)間、value(を量子化した値)が baseline のままなら
 *   何もせず返す(baseline に居続ける時間は較正に使わない。実機トリガは押す前ずっと 0.0 を
 *   返すため、ここで区間として数え始めると 0.0 がそのまま静止値として確定してしまう)。
 * - baseline から初めて変化した瞬間(hasMoved が false→true になる瞬間)、その値を区間1として
 *   追跡を始める(segments=1, segmentFrames=1)。
 * - 既に動いたことがある間、値(の量子化ビン)が今の区間と同じなら segmentFrames を1増やす。
 *   違う値になったら区間が切り替わったとみなし、新しい区間として segmentFrames=1 から数え直し、
 *   segments を1増やす。
 * - 区間1(segments===1、baseline を離れて最初にいる値)は、それが「まだ押している最中の値」
 *   である可能性を否定できないため、segmentFrames がいくつであっても確定しない。これが今回の
 *   設計の要(4回目の失敗=固定ウィンドウの締め切りが押している最中に来ると誤確定する、への
 *   直接の解決)。
 * - 区間2以降(segments>=2、= 一度違う値に移ってから今の値に落ち着いた区間)は、
 *   AXIS_CALIBRATION_SETTLE_FRAMES フレーム連続で滞在した時点で、その値を静止値として採用し
 *   較正完了とする(「一度離れてから戻ってきて落ち着いた値」だけを確定候補にする、という
 *   要求仕様の不変条件そのもの)。
 */
export function advanceAxisCalibration(state: AxisCalibration, value: number): AxisCalibration {
  if (state.calibrated) return state;
  const bin = quantizeAxisValue(value);
  if (!state.hasMoved) {
    if (bin === quantizeAxisValue(state.baseline)) return state; // baselineのまま: まだ区間を始めない。
    return { calibrated: false, baseline: state.baseline, hasMoved: true, segmentValue: bin, segmentFrames: 1, segments: 1 };
  }
  if (bin === state.segmentValue) {
    const segmentFrames = state.segmentFrames + 1;
    if (state.segments >= 2 && segmentFrames >= AXIS_CALIBRATION_SETTLE_FRAMES) {
      return { calibrated: true, rest: state.segmentValue };
    }
    return { calibrated: false, baseline: state.baseline, hasMoved: true, segmentValue: state.segmentValue, segmentFrames, segments: state.segments };
  }
  // 値が変わった: 新しい区間の1フレーム目として数え直す(区間1自体はここでは確定しえない。
  // AXIS_CALIBRATION_SETTLE_FRAMES が2以上である限り、直後にこの分岐へ来ても即確定しない)。
  return { calibrated: false, baseline: state.baseline, hasMoved: true, segmentValue: bin, segmentFrames: 1, segments: state.segments + 1 };
}

// --- 永続化(パッドごとのプロファイル) ---

/** 1つの Gamepad.id ぶんの設定。deadzone とバインディングの実体(配列表現)。 */
export interface GamepadProfile {
  deadzone: number;
  bindings: ReadonlyArray<{ source: Source; binding: Binding }>;
}

/**
 * localStorage に保存する形。バージョンを持たせ、壊れた/未知バージョンのデータは既定へフォールバックする。
 *
 * v2 で joyType(ポートごとのパッド種別)を追加した。v1 のデータ(joyType を持たない)は
 * isGamepadStoreV1() + migrateV1ToV2() で「既存の pads/portPads は活かしたまま joyType だけ
 * 既定値で補う」形にマイグレーションする。v1 保存データを isGamepadStoreV2 でそのまま弾いて
 * 空ストアへ全消しすると、割当編集(pads)やポート固定(portPads)を保存済みのユーザーの設定が
 * 一括で消えてしまうため、必ずこの経路を通すこと。
 */
export interface GamepadStore {
  version: 2;
  /** Gamepad.id -> プロファイル。挿し替えても両方残るよう、キーはポート番号ではなくidにする。 */
  pads: Record<string, GamepadProfile>;
  /** ポート0/1に手動で固定したい Gamepad.id。null は「自動割当のまま」。 */
  portPads: [string | null, string | null];
  /** ポート0/1(表示上はポート1/2)のパッド種別(px68k_joytype1/2 コアオプションに対応)。 */
  joyType: [PadType, PadType];
}

/** v1(joyType 追加前)のストア形。マイグレーション専用で外へは出さない。 */
interface GamepadStoreV1 {
  version: 1;
  pads: Record<string, GamepadProfile>;
  portPads: [string | null, string | null];
}

const GAMEPAD_STORAGE_KEY = 'webx68k.gamepad';

function emptyStore(): GamepadStore {
  return { version: 2, pads: {}, portPads: [null, null], joyType: ['default', 'default'] };
}

function isSource(v: unknown): v is Source {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.kind === 'button') return typeof o.index === 'number';
  if (o.kind === 'axis') return typeof o.index === 'number' && (o.dir === 1 || o.dir === -1);
  return false;
}

function isBinding(v: unknown): v is Binding {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.kind === 'joy') return typeof o.target === 'string' && (ALL_JOY_TARGETS as readonly string[]).includes(o.target);
  if (o.kind === 'key') return typeof o.retrok === 'number';
  return false;
}

function isGamepadProfile(v: unknown): v is GamepadProfile {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.deadzone !== 'number' || !Number.isFinite(o.deadzone)) return false;
  if (!Array.isArray(o.bindings)) return false;
  return o.bindings.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      isSource((entry as Record<string, unknown>).source) &&
      isBinding((entry as Record<string, unknown>).binding),
  );
}

function isPadsRecord(v: unknown): v is Record<string, GamepadProfile> {
  if (typeof v !== 'object' || v === null) return false;
  return Object.values(v as Record<string, unknown>).every(isGamepadProfile);
}

function isPortPads(v: unknown): v is [string | null, string | null] {
  if (!Array.isArray(v) || v.length !== 2) return false;
  return v.every((p) => p === null || typeof p === 'string');
}

function isPadType(v: unknown): v is PadType {
  return v === 'default' || v === 'cpsf-md' || v === 'cpsf-sfc';
}

/** 保存データ(v2)の構造検証。1箇所でも型が崩れていれば false を返す。 */
function isGamepadStoreV2(v: unknown): v is GamepadStore {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.version !== 2) return false;
  if (!isPadsRecord(o.pads)) return false;
  if (!isPortPads(o.portPads)) return false;
  if (!Array.isArray(o.joyType) || o.joyType.length !== 2) return false;
  return o.joyType.every(isPadType);
}

/** 保存データ(v1、joyType 無し)の構造検証。マイグレーション対象か判定するために使う。 */
function isGamepadStoreV1(v: unknown): v is GamepadStoreV1 {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.version !== 1) return false;
  if (!isPadsRecord(o.pads)) return false;
  return isPortPads(o.portPads);
}

function migrateV1ToV2(v1: GamepadStoreV1): GamepadStore {
  return { version: 2, pads: v1.pads, portPads: v1.portPads, joyType: ['default', 'default'] };
}

/**
 * localStorage から読み込む。存在しない/JSON破損/構造不正のいずれでも例外を投げず既定値
 * (空ストア)へフォールバックする。v1 データは pads/portPads を保ったまま v2 へ移行する。
 */
export function loadGamepadStore(storage: Pick<Storage, 'getItem'> = localStorage): GamepadStore {
  const raw = storage.getItem(GAMEPAD_STORAGE_KEY);
  if (!raw) return emptyStore();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isGamepadStoreV2(parsed)) return parsed;
    if (isGamepadStoreV1(parsed)) return migrateV1ToV2(parsed);
    return emptyStore();
  } catch {
    return emptyStore();
  }
}

export function saveGamepadStore(store: GamepadStore, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(GAMEPAD_STORAGE_KEY, JSON.stringify(store));
}

/** XINPUT_PRESET をそのまま GamepadProfile の形に変換する(standard mapping の既定値用)。 */
export function presetProfile(deadzone: number = DEFAULT_DEADZONE): GamepadProfile {
  return { deadzone, bindings: XINPUT_PRESET.map((e) => ({ source: e.source, binding: e.binding })) };
}

/** バインディングの無いプロファイル(non-standard パッドの初回既定=全未割当)。 */
export function blankProfile(deadzone: number = DEFAULT_DEADZONE): GamepadProfile {
  return { deadzone, bindings: [] };
}

// --- 8BitDo M30 / Micro 用の既知プリセット ---
//
// 実機(D-inputモード)で判明したボタン/軸の対応(内部index、0始まり)。表示は1始まりだが、
// ここでの値は内部indexそのもの。gamepad.id に 'M30'/'Micro' を含むかどうか(大文字小文字無視)で
// 判定する。standard 申告でない可能性が高いパッドのため、mapping==='standard' かどうかに関わらず
// このプリセットを優先して適用する(knownPadPresetFor が null を返す場合だけ、従来の
// mapping==='standard' ? XINPUT_PRESET : 全未割当、へフォールバックする)。

/** 十字キーは両パッド共通で axes[0]/axes[1] の軸で来る(ボタンではない)。padType に依存しない。 */
const DPAD_AXIS_BINDINGS: ReadonlyArray<{ source: Source; binding: Binding }> = [
  { source: { kind: 'axis', index: 0, dir: -1 }, binding: { kind: 'joy', target: 'LEFT' } },
  { source: { kind: 'axis', index: 0, dir: 1 }, binding: { kind: 'joy', target: 'RIGHT' } },
  { source: { kind: 'axis', index: 1, dir: -1 }, binding: { kind: 'joy', target: 'UP' } },
  { source: { kind: 'axis', index: 1, dir: 1 }, binding: { kind: 'joy', target: 'DOWN' } },
];

function joyBtn(index: number, target: JoyTarget): { source: Source; binding: Binding } {
  return { source: { kind: 'button', index }, binding: { kind: 'joy', target } };
}

/** 8BitDo M30 のボタン index(内部0始まり)。index 2/5 は空き。 */
const M30_BTN = { A: 0, B: 1, X: 3, Y: 4, Z: 6, C: 7, L: 8, R: 9, MINUS: 10, PLUS: 11 } as const;
/** 8BitDo Micro のボタン index(内部0始まり)。 */
const MICRO_BTN = { A: 0, B: 1, X: 3, Y: 4, L: 6, R: 7, L2: 8, R2: 9, MINUS: 10, PLUS: 11 } as const;

/** M30・標準(2ボタン): A→TRG1, B→TRG2。 */
export const M30_STANDARD_PRESET: ReadonlyArray<{ source: Source; binding: Binding }> = [
  ...DPAD_AXIS_BINDINGS,
  joyBtn(M30_BTN.A, 'TRG1'),
  joyBtn(M30_BTN.B, 'TRG2'),
];

/**
 * M30・CPSF-MD(8ボタン)。px68k-libretro の PAD_CPSF_MD では RetroPad L/R が MDパッドの Z/C の
 * 代役になっているため、パンチ3種(X/Y/Z)・キック3種(A/B/C)がこの対応で揃う。
 */
export const M30_CPSF_MD_PRESET: ReadonlyArray<{ source: Source; binding: Binding }> = [
  ...DPAD_AXIS_BINDINGS,
  joyBtn(M30_BTN.A, 'TRG1'),
  joyBtn(M30_BTN.B, 'TRG2'),
  joyBtn(M30_BTN.Y, 'TRG3'),
  joyBtn(M30_BTN.X, 'TRG4'),
  joyBtn(M30_BTN.Z, 'TRG5'),
  joyBtn(M30_BTN.PLUS, 'TRG6'),
  joyBtn(M30_BTN.MINUS, 'TRG7'),
  joyBtn(M30_BTN.C, 'TRG8'),
];

/** Micro・標準(2ボタン): A→TRG1, B→TRG2。 */
export const MICRO_STANDARD_PRESET: ReadonlyArray<{ source: Source; binding: Binding }> = [
  ...DPAD_AXIS_BINDINGS,
  joyBtn(MICRO_BTN.A, 'TRG1'),
  joyBtn(MICRO_BTN.B, 'TRG2'),
];

/** Micro・CPSF-SFC(8ボタン)。SFCパッドのラベルと同名のボタンに対応させてある。 */
export const MICRO_CPSF_SFC_PRESET: ReadonlyArray<{ source: Source; binding: Binding }> = [
  ...DPAD_AXIS_BINDINGS,
  joyBtn(MICRO_BTN.B, 'TRG1'),
  joyBtn(MICRO_BTN.A, 'TRG2'),
  joyBtn(MICRO_BTN.X, 'TRG3'),
  joyBtn(MICRO_BTN.Y, 'TRG4'),
  joyBtn(MICRO_BTN.R, 'TRG5'),
  joyBtn(MICRO_BTN.PLUS, 'TRG6'),
  joyBtn(MICRO_BTN.MINUS, 'TRG7'),
  joyBtn(MICRO_BTN.L, 'TRG8'),
];

/**
 * gamepad.id から USB Vendor/Product ID を抽出する純粋関数。
 *
 * ブラウザによって gamepad.id の書式が異なるため、両方を試す:
 * - Chrome/Edge 等: `(Vendor: 2dc8 Product: 0651)` の形でベンダー/プロダクトIDを埋め込む
 *   (表記の大文字小文字・桁数はブラウザ実装依存)。
 * - Firefox: `2dc8-0651-8BitDo M30 gamepad` のように、id の先頭が
 *   `vendorID-productID-name`(4桁16進のハイフン区切り)になる。
 * ここから `vendor:product`(共に小文字16進、桁は詰めない)の文字列を取り出す。
 * どちらにも一致しない/取り出せない場合は null(呼び出し側は id 文字列によるフォールバックに委ねること)。
 */
export function extractVendorProduct(padId: string): string | null {
  const named = /vendor:\s*([0-9a-f]+)\s+product:\s*([0-9a-f]+)/i.exec(padId);
  if (named) return `${named[1].toLowerCase()}:${named[2].toLowerCase()}`;
  const firefoxStyle = /^([0-9a-f]{4})-([0-9a-f]{4})-/i.exec(padId);
  if (firefoxStyle) return `${firefoxStyle[1].toLowerCase()}:${firefoxStyle[2].toLowerCase()}`;
  return null;
}

/**
 * Vendor:Product(小文字16進) -> 既知パッド種別。
 * 実機(ゲームパッドチェックサイトで実測、2026-08-08)で確定させた値:
 * - 8BitDo M30 gamepad: Vendor 2dc8 / Product 0651
 * - 8BitDo Micro gamepad: Vendor 2dc8 / Product 9020
 */
const VENDOR_PRODUCT_TO_KNOWN_PAD: Record<string, 'm30' | 'micro'> = {
  '2dc8:0651': 'm30',
  '2dc8:9020': 'micro',
};

/**
 * gamepad.id から既知パッド種別('m30'/'micro')を判定する、唯一の情報源。
 * knownPadPresetFor()(プリセット選択)がこれを使う(判定ロジックの二重実装を避けるため)。
 * 軸の静止値は固定値テーブルを持たず、パッド種別に関わらず動的な較正(AxisCalibration)で
 * 決める設計に変更したため、静止値の固定はここには存在しない(2026-08-08 参照)。
 * 一致しなければ null。
 *
 * 判定は Vendor/Product ID(extractVendorProduct())を最優先する。'Micro' の部分一致で
 * 判定すると 'Microsoft X-Box ...' のような無関係な id まで誤爆する
 * (2026-08-08 発覚。'Micro' は 'Microsoft' の部分文字列)ため、文字列パターンマッチは
 * 誤爆しない 'm30' のみをフォールバックとして残し、'micro' 系は vendor/product が
 * 取れた場合に限定する。
 */
function knownPadKindFor(padId: string): 'm30' | 'micro' | null {
  const vendorProduct = extractVendorProduct(padId);
  const known = vendorProduct ? VENDOR_PRODUCT_TO_KNOWN_PAD[vendorProduct] : undefined;
  if (known !== undefined) return known ?? null; // vendor/productは取れたが未知のペア: 誤爆を避けるため文字列フォールバックに落とさない。

  // vendor/product が取れない(ブラウザ実装差で id に埋め込まれていない)場合のみ、id文字列で
  // フォールバックする。'm30' は他の実在パッド名との衝突が知られていないため許容するが、
  // 'micro' は 'Microsoft' 等を誤爆するため vendor/product 経由でしか判定しない。
  const id = padId.toLowerCase();
  if (id.includes('m30')) return 'm30';
  return null;
}

/**
 * gamepad.id から既知パッド用の既定プリセットを1つ選ぶ、唯一の情報源。一致するパッドが
 * 無ければ null(呼び出し側は従来どおり mapping==='standard' か否かでフォールバックすること)。
 *
 * padType が「そのパッドの8ボタン仕様」と一致しない場合(例: M30 で CPSF-SFC を選んでいる等)は、
 * 8ボタン側のバインディング(パッド固有のTRG3..TRG8割当)は該当しないため、2ボタン側の
 * プリセットにフォールバックする(方向 + TRG1/TRG2 は両パターンとも壊さない)。
 */
export function knownPadPresetFor(padId: string, padType: PadType): ReadonlyArray<{ source: Source; binding: Binding }> | null {
  const kind = knownPadKindFor(padId);
  if (kind === 'm30') return padType === 'cpsf-md' ? M30_CPSF_MD_PRESET : M30_STANDARD_PRESET;
  if (kind === 'micro') return padType === 'cpsf-sfc' ? MICRO_CPSF_SFC_PRESET : MICRO_STANDARD_PRESET;
  return null;
}

/**
 * 保存済みプロファイルが無いパッドに対する既定値を決める、唯一の情報源。
 * 1. gamepad.id が既知パッド(M30/Micro)にマッチすれば、mapping の申告に関わらずそのプリセットを使う
 *    (これらは standard 申告でない可能性が高く、mapping 頼みだと全未割当のまま始まってしまうため)。
 * 2. マッチしなければ従来どおり: mapping === 'standard' のときだけ XINPUT_PRESET、
 *    そうでなければ全未割当で始める(index の意味がパッドごとに違うため、推測で埋めない)。
 *
 * padType省略時は 'default'(2ボタン)。id を渡さない呼び出し(既存テスト等)は常に2を通る。
 */
export function defaultProfileFor(pad: Pick<Gamepad, 'mapping'> & { id?: string }, padType: PadType = 'default'): GamepadProfile {
  const known = pad.id ? knownPadPresetFor(pad.id, padType) : null;
  if (known) return { deadzone: DEFAULT_DEADZONE, bindings: known.map((e) => ({ source: e.source, binding: e.binding })) };
  return pad.mapping === 'standard' ? presetProfile() : blankProfile();
}

// --- 検出(押して割り当て)用の純粋関数 ---

/** ある瞬間の物理入力のスナップショット(検出モードの「押されていない状態」の基準に使う)。 */
export interface PadSnapshot {
  buttons: readonly boolean[];
  axes: readonly number[];
}

export function snapshotPad(pad: Gamepad): PadSnapshot {
  return {
    buttons: Array.from(pad.buttons ?? [], (b) => b?.pressed === true),
    axes: Array.from(pad.axes ?? [], (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)),
  };
}

/**
 * prev(検出開始時のスナップショット)から curr(現在)への遷移を見て、
 * 「押されていなかったものが押された」Source を1つ返す(無ければ null)。
 * 押しっぱなしのボタン/既に閾値を超えていた軸は無視する(prevで既に真だったものは対象外)。
 * ボタンを軸より先に見る(同一フレームで両方遷移した場合はボタン優先、決定的な順序にするため)。
 *
 * isAxisEligible は「その軸を検出対象にしてよいか」を軸indexごとに判定する関数(省略時は
 * 全軸を対象にする、既存呼び出し・テストとの後方互換のため)。呼び出し側(gamepad-ui.ts)は
 * GamepadManager の較正状態(axisState().calibrated)を渡すこと。未較正の軸は「一度も
 * 動かされておらず、報告値に意味がない」状態のため、検出(押して割り当て)の対象から
 * 除外する必要がある(較正が終わるまで割当そのものができないようにする設計)。
 */
export function detectNewlyActiveSource(
  prev: PadSnapshot,
  curr: PadSnapshot,
  deadzone: number,
  isAxisEligible: (index: number) => boolean = () => true,
): Source | null {
  for (let i = 0; i < curr.buttons.length; i++) {
    const wasPressed = prev.buttons[i] === true;
    if (!wasPressed && curr.buttons[i]) return { kind: 'button', index: i };
  }
  // 軸は「静止 → 動いた」の変化を要求する: prev(検出開始時点、または直前フレーム)を
  // その軸の静止値(rest)とみなし、そこからの偏差がデッドゾーンを超えたときだけ拾う。
  // 0を静止値とみなす旧実装だと、未押下で-1.0を返すトリガ軸(8BitDo M30/Micro実機で確認)が
  // 検出開始時点で既に「デッドゾーンを超えている」ため誤検出しかねない。
  // isAxisValueValid で範囲外の軸([-1,1]の外。ハット軸が紛れ込んだもの)も除外する。
  for (let i = 0; i < curr.axes.length; i++) {
    if (!isAxisEligible(i)) continue;
    const prevValue = prev.axes[i] ?? 0;
    const currValue = curr.axes[i] ?? 0;
    const dir = axisDeviationDir(currValue, prevValue, deadzone);
    if (dir !== null) return { kind: 'axis', index: i, dir };
  }
  return null;
}

function bindingsEqual(a: Binding, b: Binding): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'joy' && b.kind === 'joy') return a.target === b.target;
  if (a.kind === 'key' && b.kind === 'key') return a.retrok === b.retrok;
  return false;
}

/** 2つの Source が同じ物理入力を指すか(編集UIでコンボ選択の現在値をハイライトする等に使う)。 */
export function sourcesEqual(a: Source, b: Source): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'button' && b.kind === 'button') return a.index === b.index;
  if (a.kind === 'axis' && b.kind === 'axis') return a.index === b.index && a.dir === b.dir;
  return false;
}

/**
 * 「どの Gamepad.index をどのポート(0/1)に割り当てるか」を決める、唯一の情報源。
 *
 * navigator.getGamepads() が返す配列(疎な配列。切断済みindexはnullのまま残る)から
 * 非nullのものだけを Gamepad.index の昇順に並べ、先頭からポート0/1へ割り当てる。
 * gamepadconnected/gamepaddisconnected イベントの発火有無には一切依存しない
 * (イベントを経ずに navigator.getGamepads() へ現れたパッドも正しく拾うため)。
 * 3台目以降は割当なし(呼び出し側は Map に index が無ければ未割当として扱う)。
 *
 * `manualPadIds` は「このポートはこの Gamepad.id を優先的に使う」という手動指定(既定は両方 null =
 * 完全自動)。指定されたidのパッドが接続中ならそのポートへ優先的に割り当て、残りのポートは
 * 従来通り接続順で埋める。手動指定されたパッドが接続されていなければ無視され、自動割当に委ねる。
 *
 * 戻り値は Gamepad.index -> port(0|1) の Map。
 */
export function assignPorts(
  gamepads: readonly (Gamepad | null)[],
  manualPadIds: readonly [string | null, string | null] = [null, null],
): ReadonlyMap<number, number> {
  const present = gamepads.filter((pad): pad is Gamepad => pad != null).sort((a, b) => a.index - b.index);
  const map = new Map<number, number>();
  const usedIndexes = new Set<number>();

  // 1st pass: 手動指定を優先して埋める。
  for (let port = 0; port < 2; port++) {
    const wantedId = manualPadIds[port];
    if (!wantedId) continue;
    const pad = present.find((p) => p.id === wantedId && !usedIndexes.has(p.index));
    if (!pad) continue;
    map.set(pad.index, port);
    usedIndexes.add(pad.index);
  }

  // 2nd pass: 残りのポートを、まだ使われていないパッドで接続順(index昇順)に埋める。
  let cursor = 0;
  for (let port = 0; port < 2; port++) {
    const alreadyAssigned = [...map.values()].includes(port);
    if (alreadyAssigned) continue;
    while (cursor < present.length && usedIndexes.has(present[cursor].index)) cursor++;
    if (cursor >= present.length) continue;
    map.set(present[cursor].index, port);
    usedIndexes.add(present[cursor].index);
    cursor++;
  }
  return map;
}

/**
 * Gamepad -> RetroPad ID ビットマスクへの変換器。
 *
 * ブラウザ無しでユニットテストできるよう、`navigator.getGamepads()` への依存は持たない。
 * 呼び出し側(main.ts)が毎フレーム取得した配列をそのまま `poll()` へ渡す形にしてある。
 */
export class GamepadManager {
  private deadzone: number;
  // Source -> Binding[] の逆引き。1つの物理入力に複数割当が乗るケース(編集UIで
  // 同じボタンに複数機能を足す等)を素直に扱うため、値は配列で持つ。
  // source自体もキーとは別に保持しておく(逆引きテーブルからUI表示用に「行から見た一覧」を
  // 引き直すため。sourceKey()は不可逆な文字列化なので、元のSourceを別途持つ必要がある)。
  private readonly bindings = new Map<string, Binding[]>();
  private readonly sourcesByKey = new Map<string, Source>();
  // 軸ごとの較正状態(AxisCalibration、gamepad.ts冒頭「軸判定」セクション参照)。
  // 較正が完了するまで(calibrated:false)は入力判定に使わない(未較正の軸は常に非アクティブ)。
  // 較正完了後(calibrated:true)は rest を固定し、二度と更新しない(継続的なポーリングのたびに
  // 更新すると、方向を入力し続けている最中に静止値が追いついてしまい、押しっぱなしのつもりが
  // 1フレームでOFFに戻ってしまう)。
  private readonly axisCalib = new Map<number, AxisCalibration>();

  constructor(
    preset: ReadonlyArray<{ source: Source; binding: Binding }> = XINPUT_PRESET,
    deadzone: number = DEFAULT_DEADZONE,
  ) {
    this.deadzone = deadzone;
    for (const { source, binding } of preset) this.addBinding(source, binding);
  }

  /** 保存済み/既定のプロファイルから GamepadManager を作る。 */
  static fromProfile(profile: GamepadProfile): GamepadManager {
    return new GamepadManager(profile.bindings, profile.deadzone);
  }

  /** 現在の状態をそのまま永続化できる GamepadProfile へ書き出す。 */
  toProfile(): GamepadProfile {
    return { deadzone: this.deadzone, bindings: this.getAllBindings() };
  }

  getDeadzone(): number {
    return this.deadzone;
  }

  setDeadzone(deadzone: number): void {
    this.deadzone = deadzone;
  }

  /** Source に Binding を追加する(編集UIの[検出]/コンボ選択から呼ぶ)。 */
  addBinding(source: Source, binding: Binding): void {
    const key = sourceKey(source);
    this.sourcesByKey.set(key, source);
    const list = this.bindings.get(key);
    if (list) list.push(binding);
    else this.bindings.set(key, [binding]);
  }

  /**
   * 指定 JoyTarget の kind:'joy' バインディングを、渡された1つの Source だけに置き換える
   * (編集UIの行の[検出]用。「最後に検出した1つだけになる」という置き換え動作)。
   * 対象は target の一致だけで選ぶ(source は問わない)ため、その行が複数Sourceの割当を
   * 持っていても全部消してから1つだけ積み直す。
   *
   * さらに、検出で拾った source が「別の target」に持っている kind:'joy' の割当も外す
   * (「このボタンは○○です」という宣言として扱うため。外さないと、例えばボタン3を
   * DOWN に割り当てた状態で UP の行で検出してボタン3を押すと、ボタン3が UP と DOWN の
   * 両方を押す状態になってしまう)。
   * ただし同じ source に乗っている kind:'key' の割当には触れない(joy とキーは別レイヤー。
   * 意図的に1ボタンへ複数機能を乗せたい場合は、従来どおりコンボボックス
   * 「追加する入力を選択…」から addBinding() で足せる)。
   */
  replaceTargetBinding(source: Source, target: JoyTarget): void {
    for (const { source: existingSource, binding } of this.getAllBindings()) {
      if (binding.kind !== 'joy') continue;
      const sameTarget = binding.target === target;
      const sameSource = sourcesEqual(existingSource, source);
      if (sameTarget || sameSource) {
        this.removeBinding(existingSource, binding);
      }
    }
    this.addBinding(source, { kind: 'joy', target });
  }

  /** 特定の Source から特定の Binding を1つ取り除く(チップの[削除])。一致が無ければ何もしない。 */
  removeBinding(source: Source, binding: Binding): void {
    const key = sourceKey(source);
    const list = this.bindings.get(key);
    if (!list) return;
    const next = list.filter((b) => !bindingsEqual(b, binding));
    if (next.length > 0) this.bindings.set(key, next);
    else {
      this.bindings.delete(key);
      this.sourcesByKey.delete(key);
    }
  }

  /** 保持している全 Source->Binding の対を平らな配列で返す(永続化・編集UIの一覧表示用)。 */
  getAllBindings(): Array<{ source: Source; binding: Binding }> {
    const out: Array<{ source: Source; binding: Binding }> = [];
    for (const [key, list] of this.bindings) {
      const source = this.sourcesByKey.get(key);
      if (!source) continue;
      for (const binding of list) out.push({ source, binding });
    }
    return out;
  }

  /** 指定 JoyTarget に割り当たっている Source 一覧(編集UIの行のチップ表示用)。 */
  bindingsForTarget(target: JoyTarget): Source[] {
    const out: Source[] = [];
    for (const { source, binding } of this.getAllBindings()) {
      if (binding.kind === 'joy' && binding.target === target) out.push(source);
    }
    return out;
  }

  /**
   * 全バインディングを消してから指定プリセットを積み直す([既定に戻す]ボタン用)。
   * 引数省略時は従来どおり XINPUT_PRESET(standard mapping 向け)。呼び出し側(main.ts)は
   * 接続中パッドの id/padType から knownPadPresetFor() で選んだプリセットを渡すこと
   * (8BitDo M30/Micro 等、パッドごとに既定が異なるため)。
   */
  resetToPreset(preset: ReadonlyArray<{ source: Source; binding: Binding }> = XINPUT_PRESET): void {
    this.bindings.clear();
    this.sourcesByKey.clear();
    for (const { source, binding } of preset) this.addBinding(source, binding);
  }

  /**
   * 単一の Gamepad についてビットマスクを計算する(パッドごとに GamepadManager を分けて持つ設計向け)。
   * padType は「このパッドが今送り先にしているポートの px68k_joytype」を渡すこと(省略時は default =
   * 2ボタン。TRG3..TRG8 のバインディングがあっても default では退避先が無いのでビットは立たない)。
   */
  bitsForPad(pad: Gamepad, padType: PadType = 'default'): number {
    return this.computeBits(pad, padType);
  }

  /**
   * 配列のインデックスがそのままポート番号として詰められた Gamepad 配列
   * (呼び出し側が既にポート割当を済ませたもの。要素数2、未接続ポートは null)から、
   * port 0/1 ぶんの RetroPad ID ビットマスクを計算して返す。
   * padTypes はポート0/1それぞれの px68k_joytype(省略時は両方 default)。
   */
  poll(gamepads: readonly (Gamepad | null)[], padTypes: readonly [PadType, PadType] = ['default', 'default']): [number, number] {
    const result: [number, number] = [0, 0];
    for (let port = 0; port < 2; port++) {
      const pad = gamepads[port];
      if (!pad) continue;
      result[port] = this.computeBits(pad, padTypes[port]);
    }
    return result;
  }

  /**
   * navigator.getGamepads() の戻り値そのまま(疎な配列、ポート未割当)を受け取り、
   * assignPorts() で port 0/1 を決めたうえでビットマスクを計算する。
   * 「割当をどう決めるか」の唯一の情報源は assignPorts() であることを保証するため、
   * 呼び出し側(main.ts の host.onPoll、gamepad-ui.ts のライブ表示)はこちらを使うこと。
   */
  pollByPort(
    gamepads: readonly (Gamepad | null)[],
    padTypes: readonly [PadType, PadType] = ['default', 'default'],
  ): [number, number] {
    const ports = assignPorts(gamepads);
    const byPort: [Gamepad | null, Gamepad | null] = [null, null];
    for (const pad of gamepads) {
      if (!pad) continue;
      const port = ports.get(pad.index);
      if (port === 0 || port === 1) byPort[port] = pad;
    }
    return this.poll(byPort, padTypes);
  }

  /**
   * 現在押されている物理Sourceのうち kind:'key' で割り当てられている retrok の集合を返す。
   * bitsForPad()(joy側)とは別の返り値にしてあるのは、呼び出し側(main.ts)が
   * SharedKeyInput へ渡す差分計算をjoy側のビットマスク処理と独立に行えるようにするため。
   * オートリピートはしない(呼び出し側が前フレームとの差分を見て press/release するだけの
   * 「今フレーム押されている集合」を返すのがこのメソッドの責務。押しっぱなしはpressを
   * 連打しない=呼び出し側で同じ retrok が続けて入っていれば無視される前提)。
   */
  keysForPad(pad: Gamepad): Set<number> {
    const keys = new Set<number>();
    this.forEachActiveSource(pad, (source) => {
      const list = this.bindings.get(sourceKey(source));
      if (!list) return;
      for (const binding of list) {
        if (binding.kind === 'key') keys.add(binding.retrok);
      }
    });
    return keys;
  }

  private computeBits(pad: Gamepad, padType: PadType): number {
    let bits = 0;
    this.forEachActiveSource(pad, (source) => {
      bits |= this.bitsFor(source, padType);
    });
    return bits;
  }

  /**
   * 現在押されている物理Sourceを列挙する(bitsFor/keysForPadの共通イテレータ)。
   *
   * 軸は較正状態(AxisCalibration)によって扱いが分かれる(2026-08-08 の副作用修正、詳細は
   * ファイル冒頭「軸判定」セクション参照):
   * - 較正済み(calibrated:true): 確定した静止値(rest)からの偏差で判定する(従来どおり)。
   * - 未較正かつその軸に割当がある: 較正完了(区間2以降が AXIS_CALIBRATION_SETTLE_FRAMES
   *   フレーム分確定するまで、長押しの間は無期限)を待たずに、暫定の静止値として
   *   baseline(観測開始時点=まだ一度も動いていない時点の値)からの偏差で入力を生成する。
   *   8BitDo M30 等、十字キーが軸(axes[0]/[1])で来るパッドは静止値が最初から0付近で
   *   正しいため、これで較正完了前でも即座に方向入力が効くようになる(このガードが無いと、
   *   較正が終わるまで方向入力が一切効かなくなってしまう=今回手当てした副作用)。
   * - 未較正かつその軸に割当が無い: 従来どおり入力を一切生成しない。未割当のトリガ軸
   *   (axes[3]/[4]等)が較正前に誤ってONになる不具合(このセクションのコメント参照)は
   *   割当の無い軸で起きていたため、ここは塞いだままにする。
   *
   * 較正が完了する瞬間(calibrated が false→true に変わるフレーム)も、暫定判定(baseline
   * 基準)と確定判定(rest基準)は同じ observeAxis() 呼び出しが返す1つの calib から計算する
   * ため、同一フレーム内で基準がずれることはない。またそのフレームで rest が baseline と
   * 一致していれば(区間2が静止=baselineのままだった、という通常のケース)、
   * 判定結果は暫定/確定のどちらでも同じになるため、押しっぱなしの入力が境界フレームで
   * 途切れたり固着したりしない。
   */
  private forEachActiveSource(pad: Gamepad, fn: (source: Source) => void): void {
    for (let index = 0; index < pad.buttons.length; index++) {
      if (!pad.buttons[index].pressed) continue;
      fn({ kind: 'button', index });
    }
    for (let index = 0; index < pad.axes.length; index++) {
      const value = pad.axes[index];
      if (!isAxisValueValid(value)) continue; // 範囲外(ハット軸等)は無効な軸として無視。
      const calib = this.observeAxis(index, value);
      if (calib.calibrated) {
        const dir = axisDeviationDir(value, calib.rest, this.deadzone);
        if (dir !== null) fn({ kind: 'axis', index, dir });
        continue;
      }
      if (!this.axisHasBinding(index)) continue; // 未較正・未割当: 較正完了まで入力を生成しない。
      // 未較正・割当あり: 暫定の静止値(baseline)からの偏差で判定する。
      const dir = axisDeviationDir(value, calib.baseline, this.deadzone);
      if (dir !== null) fn({ kind: 'axis', index, dir });
    }
  }

  /** 指定軸(index)の+方向/-方向のどちらかに1つでも kind:'joy' or 'key' の割当があるか。 */
  private axisHasBinding(index: number): boolean {
    return (
      this.bindings.has(sourceKey({ kind: 'axis', index, dir: 1 })) ||
      this.bindings.has(sourceKey({ kind: 'axis', index, dir: -1 }))
    );
  }

  /**
   * 指定軸の較正状態を1フレームぶん進めて記録する(副作用あり)。
   * advanceAxisCalibration()(純粋関数、gamepad.ts冒頭参照)へ委譲するだけで、判定ロジック
   * そのものはそちらの1箇所にしか存在しない。未観測の軸は初回呼び出し時に
   * initAxisCalibration() で baseline を記録する(この時点ではまだ未較正)。
   */
  private observeAxis(index: number, value: number): AxisCalibration {
    const existing = this.axisCalib.get(index);
    const next = existing ? advanceAxisCalibration(existing, value) : initAxisCalibration(value);
    this.axisCalib.set(index, next);
    return next;
  }

  /**
   * 指定軸の有効性・較正済みか・(較正中かどうか)・現在の偏差方向を返す
   * (gamepad-ui.ts のライブ表示・割当選択肢の判定用)。
   * bitsFor 計算と同じ較正状態(axisCalib)を共有するため、ライブ表示とコアへの実際の入力は常に一致する。
   * 範囲外の軸(無効)は valid:false, calibrated:false, calibrating:false, active:null を返す。
   * 未較正の軸は valid:true, calibrated:false, active:null を返す(未較正の間は常に非アクティブ。
   * 呼び出し側はこの calibrated で「較正待ち」の見た目を出し分けること)。
   * calibrating は「一度動かされて、区間の追跡(離れてから確定するまでの観測)が進行中」を表す
   * (calibrated:false かつ calibrating:false は「まだ一度も動かされていない」を意味し、
   * gamepad-ui.ts はこの2状態を別の見た目にできる)。
   */
  axisState(pad: Gamepad, index: number): { valid: boolean; calibrated: boolean; calibrating: boolean; active: 1 | -1 | null } {
    const value = pad.axes?.[index];
    if (!isAxisValueValid(value)) return { valid: false, calibrated: false, calibrating: false, active: null };
    const calib = this.observeAxis(index, value);
    if (!calib.calibrated) return { valid: true, calibrated: false, calibrating: calib.hasMoved, active: null };
    return { valid: true, calibrated: true, calibrating: false, active: axisDeviationDir(value, calib.rest, this.deadzone) };
  }

  /**
   * 指定軸の較正状態を、axisCalib への記録を発生させずに読む(observeAxis の観測なし版)。
   * デバッグフック(window.__webx68kDebug.axes())専用。デバッグ用の覗き見自体が観測対象
   * (較正の進行)を書き換えてしまうと、「まだ較正されていない軸がどう見えるか」を後から
   * 確認できなくなるため、副作用を持たせない。
   */
  private peekAxisCalibration(index: number): AxisCalibration | null {
    return this.axisCalib.get(index) ?? null;
  }

  /**
   * デバッグ用: そのパッドの全軸について、現在値・(記録を発生させずに読んだ)較正状態・
   * 有効性・現在のアクティブ判定をまとめて返す。
   * window.__webx68kDebug.axes() から呼ばれる想定(実機の軸挙動を観測するためのフック。
   * このメソッドの呼び出し自体が axisCalib への記録を引き起こしてはいけない。peekAxisCalibration 参照)。
   */
  describeAxes(pad: Gamepad): Array<{
    index: number;
    value: number;
    valid: boolean;
    calibrated: boolean;
    calibrating: boolean;
    rest: number | null;
    baseline: number | null;
    hasMoved: boolean;
    segments: number | null;
    segmentFrames: number | null;
    active: 1 | -1 | null;
  }> {
    const axes = pad.axes ?? [];
    const out: Array<{
      index: number;
      value: number;
      valid: boolean;
      calibrated: boolean;
      calibrating: boolean;
      rest: number | null;
      baseline: number | null;
      hasMoved: boolean;
      segments: number | null;
      segmentFrames: number | null;
      active: 1 | -1 | null;
    }> = [];
    for (let index = 0; index < axes.length; index++) {
      const rawValue = axes[index];
      const value = typeof rawValue === 'number' ? rawValue : NaN;
      const valid = isAxisValueValid(rawValue);
      const calib = this.peekAxisCalibration(index);
      if (calib === null) {
        out.push({
          index,
          value,
          valid,
          calibrated: false,
          calibrating: false,
          rest: null,
          baseline: null,
          hasMoved: false,
          segments: null,
          segmentFrames: null,
          active: null,
        });
        continue;
      }
      if (!calib.calibrated) {
        out.push({
          index,
          value,
          valid,
          calibrated: false,
          calibrating: calib.hasMoved,
          rest: null,
          baseline: calib.baseline,
          hasMoved: calib.hasMoved,
          segments: calib.segments,
          segmentFrames: calib.segmentFrames,
          active: null,
        });
        continue;
      }
      const active = valid ? axisDeviationDir(value, calib.rest, this.deadzone) : null;
      out.push({
        index,
        value,
        valid,
        calibrated: true,
        calibrating: false,
        rest: calib.rest,
        baseline: null,
        hasMoved: true,
        segments: null,
        segmentFrames: null,
        active,
      });
    }
    return out;
  }

  private bitsFor(source: Source, padType: PadType): number {
    const list = this.bindings.get(sourceKey(source));
    if (!list) return 0;
    let bits = 0;
    for (const binding of list) {
      if (binding.kind === 'joy') bits |= 1 << retroIdFor(binding.target, padType);
    }
    return bits;
  }
}
