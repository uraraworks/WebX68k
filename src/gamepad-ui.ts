// ジョイスティック設定ダイアログ(見える化 + 割当編集)。
//
// 目的: ゲームパッド入力自体は gamepad.ts の GamepadManager + main.ts の host.onPoll で配線済み。
// このダイアログは「繋がっているか」「どのボタンが何番か」「割当が効いているか」の確認に加えて、
// 割当そのものの編集(検出/コンボ選択/デッドゾーン/ポート選択/XInput標準へのリセット)を担当する。
// バインディングの実体(GamepadManager・永続化)は持たず、すべて main.ts から渡された callbacks
// 経由で読み書きする(gamepad-ui.ts はロジックの二重実装をしない)。
//
// 重要: ライブ表示・検出モードの押下判定は host.onPoll(retro_run 駆動)に相乗りしない。コアが
// 動いていないと呼ばれないため、起動前の確認・設定ができなくなってしまう。ダイアログが開いている
// 間だけ独立した requestAnimationFrame ループで navigator.getGamepads() を読み、閉じたら必ず止める
// (リーク防止)。このループはコアへ入力を送らない(表示専用)。コアへ送るのは従来通り
// host.onPoll 経由の GamepadManager.poll() のみ。
//
// 編集UIの再描画方針: ライブ表示(物理入力/X68000側入力のON/OFF)は状態がフレームごとに変わるため
// 毎フレーム再構築して問題ない。一方、編集用の <select>/<input type=range> はユーザー操作中に
// DOMノードを丸ごと差し替えるとネイティブのドロップダウン選択やドラッグ操作が中断してしまう。
// そのため編集エリア(renderEditor)は「接続中パッドの集合が変わった時」「バインディングを
// 実際に追加/削除/リセットした時」など状態が変わった契機でのみ再構築し、毎フレームは回さない。
// 検出モードの押下判定自体は毎フレーム行う必要があるため、そちらは既存のON/OFFテキストを
// その場で書き換えるだけ(DOM再構築なし)にして両立させる。

import {
  type Binding,
  detectNewlyActiveSource,
  isAxisValueValid,
  joyTargetsForPadType,
  type JoyTarget,
  PAD_TYPES,
  type PadSnapshot,
  type PadType,
  retroIdFor,
  snapshotPad,
  type Source,
} from './gamepad';
import { t } from './strings';
import { KBD_ROWS, KEYPAD_ROWS } from './virtual-keyboard';

/**
 * Gamepad API の standard mapping における物理ボタンの「位置」表記。
 * RetroPad命名(id=0='B' 等)をそのまま出すと、8BitDo M30 や Xboxパッドの実機印刷と
 * 食い違って確実に混乱する(下ボタンが「B」と表示される等)ため、index主表記+位置名の
 * 併記にする(例: 「#1 (下)」。表示は1始まり、配列自体は0始まりのGamepad API index順)。
 * indexはライブ表示のボタン番号表示と対応が取れる。
 * 並びは standard mapping の button index 順(0..16)。
 */
const STANDARD_BUTTON_POSITIONS: ReadonlyArray<() => string> = [
  () => t('gamepadPosDown'), // 0
  () => t('gamepadPosRight'), // 1
  () => t('gamepadPosLeft'), // 2
  () => t('gamepadPosUp'), // 3
  () => t('gamepadPosL'), // 4
  () => t('gamepadPosR'), // 5
  () => t('gamepadPosL2'), // 6
  () => t('gamepadPosR2'), // 7
  () => t('gamepadPosSelect'), // 8
  () => t('gamepadPosStart'), // 9
  () => t('gamepadPosL3'), // 10
  () => t('gamepadPosR3'), // 11
  () => t('gamepadPosDpadUp'), // 12
  () => t('gamepadPosDpadDown'), // 13
  () => t('gamepadPosDpadLeft'), // 14
  () => t('gamepadPosDpadRight'), // 15
  () => t('gamepadPosHome'), // 16
];

/**
 * 「その他の割当(キーボード)」セクションで選べるキー一覧。
 * virtual-keyboard.ts の KBD_ROWS/KEYPAD_ROWS(X68000キーボードの全キー定義。VirtualKeyDefの
 * label/retrokを持つ)をそのまま流用し、ここでの重複ハードコードは持たない
 * (キー配列の唯一の情報源は virtual-keyboard.ts 側)。
 */
const KEYBOARD_OPTIONS: ReadonlyArray<{ retrok: number; label: string }> = (() => {
  const seen = new Set<number>();
  const out: Array<{ retrok: number; label: string }> = [];
  for (const row of [...KBD_ROWS, ...KEYPAD_ROWS]) {
    for (const def of row) {
      if (def.retrok === undefined || seen.has(def.retrok)) continue;
      seen.add(def.retrok);
      out.push({ retrok: def.retrok, label: def.label.replace('\n', ' ') });
    }
  }
  return out;
})();

/**
 * main.ts側(割当ロジック・永続化の実体を持つ側)から渡してもらう情報。
 * gamepad-ui.ts はバインディングのロジック・保存を持たず、表示と編集操作の仲介に徹する。
 */
export interface GamepadDialogCallbacks {
  /** 接続中 Gamepad.index に対する現在のポート割当(0/1)。3台目以降など未割当ならnull。 */
  getPort(gamepadIndex: number): number | null;
  /**
   * その Gamepad の入力を、現在の割当で解決した RetroPad ID ビットマスクへ変換する。
   * main.ts 側の GamepadManager.bitsForPad() をそのまま使ってもらう想定(割当ロジックの二重実装を避ける)。
   * padType は表示対象の行と RetroPad ID の対応を決めるため、そのパッドが繋がっているポートの
   * 現在の種別(getPadType()の戻り値)を渡すこと。
   */
  resolveBits(pad: Gamepad, padType: PadType): number;
  /**
   * 指定軸が有効(Gamepad APIの仕様上ありうる[-1,1]の範囲内)か、較正済みか、較正中か、静止値からの
   * 偏差でどちら向きに反応しているか(未反応/未較正はnull)を返す。範囲外の軸(ハット軸等)は
   * valid:false になる。calibrated:false かつ calibrating:false は「観測開始してから一度も
   * 動かされていない軸」、calibrated:false かつ calibrating:true は「一度動かされて較正の観測が
   * 進行中(離れてから確定するまでの観測中)」を意味する。いずれの未較正状態でも active は常に
   * null(未較正の軸は入力を生成しない。gamepad.ts の AxisCalibration 参照)。
   * bitsFor計算(resolveBits)と同じ較正状態を共有するため、ライブ表示と実際の入力は必ず一致する。
   */
  getAxisState(pad: Gamepad, axisIndex: number): { valid: boolean; calibrated: boolean; calibrating: boolean; active: 1 | -1 | null };
  /** 指定パッドの現在のデッドゾーン。 */
  getDeadzone(pad: Gamepad): number;
  setDeadzone(pad: Gamepad, value: number): void;
  /** 指定パッドについて、指定 JoyTarget に割り当たっている Source 一覧(チップ表示用)。 */
  getBindingsForTarget(pad: Gamepad, target: JoyTarget): Source[];
  /** 指定パッドの kind:'key' バインディング一覧(「その他の割当」セクションのチップ表示用)。 */
  getKeyBindings(pad: Gamepad): Array<{ source: Source; retrok: number }>;
  addBinding(pad: Gamepad, source: Source, binding: Binding): void;
  removeBinding(pad: Gamepad, source: Source, binding: Binding): void;
  /**
   * [検出]で拾った入力を、指定 JoyTarget の唯一のソースへ置き換える(既存の割当は全解除)。
   * 複数割当を追加したい場合は従来どおりコンボ(addBinding)を使うこと。こちらは検出専用。
   */
  replaceTargetBinding(pad: Gamepad, source: Source, target: JoyTarget): void;
  /** そのパッドの割当を XInput標準へ丸ごとリセットする([XInput標準に戻す])。 */
  resetToPreset(pad: Gamepad): void;
  /** ポート0/1に手動固定中の Gamepad.id(未固定はnull)。 */
  getPortSelection(): readonly [string | null, string | null];
  setPortSelection(port: 0 | 1, padId: string | null): void;
  /** ポート0/1(表示上はポート1/2)の現在のパッド種別(px68k_joytype1/2)。 */
  getPadType(port: 0 | 1): PadType;
  /** パッド種別を変更する。localStorage への永続化は callbacks 側の責務。 */
  setPadType(port: 0 | 1, padType: PadType): void;
  /** コアが現在実行中か。パッド種別変更が即時反映されない旨の案内を出し分けるために使う。 */
  isCoreRunning(): boolean;
}

export interface GamepadDialog {
  open(): void;
  /** 言語切替時、ダイアログ内の静的文言を現在の言語で貼り直す。開いていればライブ表示・編集エリアも再描画する。 */
  applyStrings(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

function targetLabel(target: JoyTarget): string {
  switch (target) {
    case 'UP':
      return t('gamepadTargetUp');
    case 'DOWN':
      return t('gamepadTargetDown');
    case 'LEFT':
      return t('gamepadTargetLeft');
    case 'RIGHT':
      return t('gamepadTargetRight');
    default:
      // TRG1..TRG8 はそのままの表記(ja/enどちらでも同じ)。
      return target;
  }
}

function padTypeLabel(padType: PadType): string {
  switch (padType) {
    case 'default':
      return t('gamepadPadTypeDefault');
    case 'cpsf-md':
      return t('gamepadPadTypeCpsfMd');
    case 'cpsf-sfc':
      return t('gamepadPadTypeCpsfSfc');
  }
}

/**
 * ボタン/軸番号の表示専用変換(内部は0始まりのGamepad API index、UI表示のみ1始まり)。
 * Windowsの「ゲームコントローラーの設定」の表記に合わせるための変換で、ここでしか+1しない
 * (localStorageの保存値やwindow.__webx68kDebugの生値は0始まりのまま扱うこと)。
 */
export function toDisplayIndex(index: number): number {
  return index + 1;
}

/**
 * 軸の生値を表示用に小数2桁へ丸める。判定(有効/較正/ON)には使わず表示のみに使う。
 * -0.00392 のような「丸めると0になる負値」を toFixed(2) だけで整形すると "-0.00" という
 * 見た目上マイナスに見えてしまう(実際には静止しているだけ)ため、丸めた結果が0になる場合は
 * 符号を落として "0.00" にする。
 */
export function formatAxisValue(value: number): string {
  const rounded = value.toFixed(2);
  return rounded === '-0.00' ? '0.00' : rounded;
}

/**
 * 検出開始(行の[検出(置き換え)]・キーボードの[キーを割り当てる])で baseline を作る直前に、
 * 渡された pad を「今の pads 配列にある同じ id の pad」へ差し替える。
 *
 * 根本原因: renderBindingRow/renderGenericSection のクリックハンドラが閉じ込めている pad は
 * 「最後に renderEditor() が走った時点」の Gamepad オブジェクトで、その後 navigator.getGamepads()
 * を呼び直すまで値が更新される保証が無い(MDNも同種の注意書きあり)。renderEditor() は接続パッド
 * の集合が変わった時だけ呼ばれる=ダイアログを開いてから一度もパッド構成が変わっていなければ、
 * ボタン/軸の状態は open() 時点のまま凍結されている。この凍結された pad をそのまま snapshotPad()
 * に渡すと、baseline が「検出を始めた本当の瞬間」の状態ではなく「ダイアログを開いた瞬間」の状態に
 * なり、その間に何か押されていた/離されていたりすると押しっぱなし判定がズレる。
 * 呼び出し側は必ず connectedPads() のような最新の pads 配列をここへ渡すこと。
 * 該当パッドが見つからない(切断済み等)場合は渡された pad をそのまま返す(呼び出し側の
 * padId/検出対象は変えず、次のtickで pad が戻ってくれば再開できる従来の挙動を壊さない)。
 */
export function freshPadFor(pads: readonly Gamepad[], pad: Gamepad): Gamepad {
  return pads.find((p) => p.id === pad.id) ?? pad;
}

/** ボタン/軸の物理入力を人間可読なラベルへ。standard mapping なら位置ベースの名前、それ以外はindex表記。 */
export function sourceLabel(source: Source, pad: Gamepad): string {
  if (source.kind === 'button') {
    const positionFn = pad.mapping === 'standard' ? STANDARD_BUTTON_POSITIONS[source.index] : undefined;
    if (positionFn) return t('gamepadPositionalButtonLabel', { index: toDisplayIndex(source.index), position: positionFn() });
    return t('gamepadButtonLabel', { index: toDisplayIndex(source.index) });
  }
  if (source.kind === 'axis') {
    return t('gamepadAxisLabel', { index: toDisplayIndex(source.index), dir: source.dir > 0 ? '+' : '-' });
  }
  // kind:'touch' はバーチャルパッド(タッチ)用の Source で、この編集UI(物理ゲームパッド向け)からは
  // 生成されない。到達しない分岐だが、Source が3種になった型を網羅するために形だけ用意しておく。
  return source.id;
}

/**
 * そのパッドで選択可能な物理Source一覧(コンボボックスの選択肢生成用)。
 * 範囲外の値を返す軸(isAxisValueValid が false。ハット軸等)は無効な軸として選択肢に出さない
 * (「そんな軸がある」こと自体はライブ表示(renderAxes)側で見えるようにするが、割当対象には選べない)。
 * 未較正の軸(観測開始してから一度も動かされていない)も選択肢に出さない: 較正が終わるまで
 * その軸の値には意味が無く、割り当てても入力を生成しない(gamepad.ts の AxisCalibration 参照)。
 * 「一度動かせば選べるようになる」ことは、ライブ表示側(renderAxes)の見た目で案内する。
 */
function sourceOptionsFor(pad: Gamepad, callbacks: GamepadDialogCallbacks): Array<{ source: Source; label: string }> {
  const out: Array<{ source: Source; label: string }> = [];
  const buttonCount = pad.buttons?.length ?? 0;
  for (let i = 0; i < buttonCount; i++) {
    out.push({ source: { kind: 'button', index: i }, label: sourceLabel({ kind: 'button', index: i }, pad) });
  }
  const axesCount = pad.axes?.length ?? 0;
  for (let i = 0; i < axesCount; i++) {
    if (!isAxisValueValid(pad.axes[i])) continue;
    if (!callbacks.getAxisState(pad, i).calibrated) continue;
    out.push({ source: { kind: 'axis', index: i, dir: 1 }, label: sourceLabel({ kind: 'axis', index: i, dir: 1 }, pad) });
    out.push({
      source: { kind: 'axis', index: i, dir: -1 },
      label: sourceLabel({ kind: 'axis', index: i, dir: -1 }, pad),
    });
  }
  return out;
}

/**
 * 検出待ち状態(行の[検出(置き換え)]・キーボードの[キーを割り当てる]共通)の純粋な状態遷移。
 * DOM操作やGamepad APIの読み取りを一切持たない、テストしやすい形にするために
 * buildGamepadDialog() 本体から切り出した(実機で「検出待ち中もボタンが変わらない」
 * 「押しても反応しない」を調査した際、状態遷移そのものをDOMと分離して検証できないと
 * 再発を防げないため)。buildGamepadDialog() 側の各関数(startRowDetect等)はここの
 * 純粋関数を呼んで次状態を作り、DOM再構築(renderEditor)はその後に副作用として行う。
 */
export type DetectState =
  | { kind: 'row'; padId: string; target: JoyTarget; baseline: PadSnapshot }
  | { kind: 'generic'; padId: string; baseline: PadSnapshot }
  | null;

export interface DetectFlowState {
  /** 検出(押して割り当て)待ち中の状態。行/キーボードどちらか一方のみ、同時に両方は待てない。 */
  detect: DetectState;
  /** キーボード検出が成功し、宛先(ジョイスティック行 or キー)の選択待ちになっている状態。 */
  pendingGeneric: { padId: string; source: Source } | null;
}

export const IDLE_DETECT_FLOW_STATE: DetectFlowState = { detect: null, pendingGeneric: null };

/** 行の[検出(置き換え)]を開始する。既存の宛先選択待ち(キーボード側)は両立させず破棄する。 */
export function startRowDetectFlow(padId: string, target: JoyTarget, baseline: PadSnapshot): DetectFlowState {
  return { detect: { kind: 'row', padId, target, baseline }, pendingGeneric: null };
}

/** キーボードの[キーを割り当てる]を開始する。以前の宛先選択待ちは破棄する(新しい検出が優先)。 */
export function startGenericDetectFlow(padId: string, baseline: PadSnapshot): DetectFlowState {
  return { detect: { kind: 'generic', padId, baseline }, pendingGeneric: null };
}

/**
 * 検出待ち中に新規入力(Source)を検出した時の遷移。
 * kind:'row' は呼び出し側が別途 replaceTargetBinding を実行し、ここでは detect を空に戻すだけ。
 * kind:'generic' は即座に確定させず、宛先選択待ち(pendingGeneric)へ進める
 * (「その他の割当」は押した入力の宛先をジョイスティック行/キーボードキーから選ぶ2段階フローのため)。
 * detect が null(検出待ちでない)ときに呼んでも何もしない(呼び出し側の型ガード漏れに対する保険)。
 */
export function resolveDetectFound(state: DetectFlowState, source: Source): DetectFlowState {
  if (state.detect === null) return state;
  if (state.detect.kind === 'row') return { detect: null, pendingGeneric: state.pendingGeneric };
  return { detect: null, pendingGeneric: { padId: state.detect.padId, source } };
}

/** 検出待ちを中断して何もせず元に戻す(行/キーボード共通。[キャンセル]ボタン・Escから呼ぶ)。 */
export function cancelDetectFlow(state: DetectFlowState): DetectFlowState {
  if (state.detect === null) return state;
  return { ...state, detect: null };
}

/**
 * キーボード検出成功後の宛先選択待ちを中断して破棄する([キャンセル]ボタン・Escから呼ぶ)。
 * これが無かった頃は、待機中に見た目が変わらない[キーを割り当てる]ボタンを利用者が押し直すと
 * startGenericDetect() がこの pendingGeneric を黙って上書きしてしまい、検出できていた入力ごと
 * 消えて「押しても反応しない」ように見えていた(実機報告の根本原因)。
 */
export function cancelPendingGenericFlow(state: DetectFlowState): DetectFlowState {
  if (state.pendingGeneric === null) return state;
  return { ...state, pendingGeneric: null };
}

/** 宛先選択(destSelect)で確定した時の遷移。呼び出し側が別途 addBinding を実行してから呼ぶ。 */
export function resolvePendingGenericPicked(state: DetectFlowState): DetectFlowState {
  return { ...state, pendingGeneric: null };
}

/**
 * ジョイスティック設定ダイアログを構築して container へ追加する。
 * main.ts からはボタン1つ分の配線(open()呼び出しとapplyStrings()連携)だけ行えばよい
 * (filemanager.ts の buildFileManagerDialog と同じ流儀)。
 */
export function buildGamepadDialog(container: HTMLElement, callbacks: GamepadDialogCallbacks): GamepadDialog {
  const titleEl = el('h2', { class: 'gp-title' }, [t('gamepadDialogTitle')]);
  const descEl = el('p', { class: 'gp-desc' }, [t('gamepadDialogDescription')]);
  const listTitleEl = el('h3', { class: 'rom-modal-section-title' }, [t('gamepadConnectedTitle')]);
  const padListEl = el('div', { class: 'gp-pad-list' });
  const portSelectEl = el('div', { class: 'gp-port-select' });
  const padTypeTitleEl = el('h3', { class: 'rom-modal-section-title' }, [t('gamepadPadTypeTitle')]);
  const padTypeSelectEl = el('div', { class: 'gp-padtype-select' });
  const liveContainerEl = el('div', { class: 'gp-live-container' });
  const editorTitleEl = el('h3', { class: 'rom-modal-section-title' }, [t('gamepadBindingsTitle')]);
  const editorPadSelectEl = el('div', { class: 'gp-edit-pad-select' });
  const editorEl = el('div', { class: 'gp-editor' });
  const closeBtn = el('button', { type: 'button', class: 'rom-close-btn' }, [t('gamepadDialogClose')]);
  const modal = el('div', { class: 'rom-modal gp-modal', role: 'dialog', 'aria-modal': 'true' }, [
    titleEl,
    descEl,
    listTitleEl,
    padListEl,
    portSelectEl,
    padTypeTitleEl,
    padTypeSelectEl,
    liveContainerEl,
    editorTitleEl,
    editorPadSelectEl,
    editorEl,
    el('div', { class: 'rom-modal-footer' }, [closeBtn]),
  ]);
  const backdrop = el('div', { class: 'rom-modal-backdrop gp-modal-backdrop hidden' }, [modal]);
  container.append(backdrop);

  let rafId: number | null = null;
  // 編集対象パッド(ダイアログ内で選んだ Gamepad.id)。接続が切れたら次のtickで再選出する。
  let editingPadId: string | null = null;
  // 直前に編集エリアを構築したときの接続パッド構成(id列)。変化した時だけ編集エリアを再構築する
  // (ユーザーがselect/rangeを操作中にDOMを丸ごと差し替えて操作を中断させないため)。
  let lastEditorKey = '';

  // 検出待ちの状態遷移そのものは純粋関数(startRowDetectFlow等、ファイル冒頭で定義・export済み)に
  // 委譲する。ここではその結果を保持するだけ(DOM再構築の要否判断とrenderEditor呼び出しはこの
  // ファイル内の各関数が担う)。
  let detect: DetectState = IDLE_DETECT_FLOW_STATE.detect;
  // detect成功後、キーボード宛か確定するまで保持する一時状態(「その他の割当」フロー用)。
  let pendingGeneric: DetectFlowState['pendingGeneric'] = IDLE_DETECT_FLOW_STATE.pendingGeneric;

  // renderEditor()で作った行ごとのDOM参照。detect中の案内文をフレームごとに書き換えるためだけに使う
  // (行そのものの再構築はrenderEditor()が呼ばれた時だけ)。
  const rowStatusEls = new Map<JoyTarget, HTMLElement>();
  const rowDetectBtns = new Map<JoyTarget, HTMLButtonElement>();
  let genericStatusEl: HTMLElement | null = null;
  let genericDetectBtn: HTMLButtonElement | null = null;

  /** navigator.getGamepads() は疎な配列(切断済みindexがnullのまま残る)なので、非nullだけ拾う。 */
  function connectedPads(): Gamepad[] {
    const all = navigator.getGamepads();
    const out: Gamepad[] = [];
    for (const pad of all) {
      if (pad) out.push(pad);
    }
    return out;
  }

  function renderPadList(pads: Gamepad[]): void {
    padListEl.textContent = '';
    if (pads.length === 0) {
      padListEl.append(el('div', { class: 'gp-hint' }, [t('gamepadNoPads')]));
      return;
    }
    for (const pad of pads) {
      const port = callbacks.getPort(pad.index);
      const portLabel = port === null ? t('gamepadPortUnassigned') : t('gamepadPortAssigned', { port: port + 1 });
      padListEl.append(
        el('div', { class: 'gp-pad-row' }, [
          el('span', { class: 'gp-pad-id' }, [pad.id]),
          el('span', { class: 'gp-pad-mapping' }, [pad.mapping || '(no mapping)']),
          el('span', { class: 'gp-pad-port' }, [portLabel]),
        ]),
      );
    }
  }

  /**
   * ポート0/1(表示上はポート1/2)のパッド種別セレクト。px68k_joytype1/2 に対応する。
   * 変更は次回のコア起動時から反映される(GET_VARIABLE_UPDATE 未実装のため実行中には効かない、
   * main.ts の bootCore()/コアオプション反映タイミングのコメント参照)。実行中の変更時だけ、
   * その旨の案内を選択直下に出す。
   */
  function renderPadTypeSelect(): void {
    padTypeSelectEl.textContent = '';
    for (const port of [0, 1] as const) {
      const label = el('label', { class: 'gp-padtype-select-row' }, [t('gamepadPadTypeDeviceLabel', { port: port + 1 })]);
      const select = el('select', { class: 'gp-padtype-select-input' });
      for (const padType of PAD_TYPES) select.append(new Option(padTypeLabel(padType), padType));
      select.value = callbacks.getPadType(port);
      const hintEl = el('span', { class: 'gp-padtype-restart-hint hidden' }, [t('gamepadPadTypeRestartHint')]);
      select.addEventListener('change', () => {
        callbacks.setPadType(port, select.value as PadType);
        hintEl.classList.toggle('hidden', !callbacks.isCoreRunning());
        // TRG3..TRG8 の表示有無・RetroPad ID対応が変わるため、ライブ表示・編集エリアを作り直す。
        lastEditorKey = '__force__';
        renderPortSelect(connectedPads());
        renderEditor(connectedPads());
      });
      label.append(select);
      padTypeSelectEl.append(label, hintEl);
    }
  }

  /** ポート0/1へ手動固定するパッドを選ぶセレクト(既定は自動割当のまま)。 */
  function renderPortSelect(pads: Gamepad[]): void {
    portSelectEl.textContent = '';
    const selection = callbacks.getPortSelection();
    for (const port of [0, 1] as const) {
      const label = el('label', { class: 'gp-port-select-row' }, [t('gamepadPortDeviceLabel', { port: port + 1 })]);
      const select = el('select', { class: 'gp-port-select-input' });
      select.append(new Option(t('gamepadPortAutoOption'), ''));
      for (const pad of pads) {
        select.append(new Option(`${pad.id} (#${toDisplayIndex(pad.index)})`, pad.id));
      }
      select.value = selection[port] ?? '';
      select.addEventListener('change', () => {
        callbacks.setPortSelection(port, select.value === '' ? null : select.value);
        renderPadList(connectedPads());
      });
      label.append(select);
      portSelectEl.append(label);
    }
  }

  /** buttons配列の長さ・要素は環境やモックによってまちまちなので、欠けや長さ違いを前提に組み立てる。 */
  function renderButtons(pad: Gamepad): HTMLElement {
    const wrap = el('div', { class: 'gp-btns' });
    const buttons = pad.buttons ?? [];
    for (let i = 0; i < buttons.length; i++) {
      const pressed = buttons[i]?.pressed === true;
      wrap.append(el('span', { class: pressed ? 'gp-btn active' : 'gp-btn' }, [String(toDisplayIndex(i))]));
    }
    return wrap;
  }

  /**
   * axes配列も同様に長さ・値が不定な前提。静止値からの偏差(callbacks.getAxisState、
   * resolveBitsと同じ判定・同じ較正状態)でハイライトする。範囲外の軸(ハット軸等)は
   * 無効として見た目で区別する(光らせない・「無効」の注記を出す)。
   * 未較正の軸(観測開始してから一度も動かされていない)は、値が0(や他の見かけ上の静止値)を
   * 示していても青く光らせない(ON判定に使っていないため)。グレー表示+注記で「一度動かせば
   * 使えるようになる」ことを案内する(実機のトリガ軸で「押す前から光っている」ように見える
   * 固着バグの再発防止。gamepad.ts の AxisCalibration 参照)。
   * 一度動かされた後、静止値が確定するまでの間(calibrating:true)は、
   * 未較正のうち「一度も動いていない」ものとは別の見た目(「較正中」)にする。押しっぱなしの
   * 最中に「使えるようになりました」と誤解されるのを避けるため。
   */
  function renderAxes(pad: Gamepad): HTMLElement {
    const wrap = el('div', { class: 'gp-axes' });
    const axes = pad.axes ?? [];
    for (let i = 0; i < axes.length; i++) {
      const raw = axes[i];
      const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
      const state = callbacks.getAxisState(pad, i);
      const classes = ['gp-axis'];
      let suffix = '';
      if (!state.valid) {
        classes.push('invalid');
        suffix = ` ${t('gamepadAxisInvalidSuffix')}`;
      } else if (state.calibrating) {
        classes.push('calibrating');
        suffix = ` ${t('gamepadAxisCalibratingSuffix')}`;
      } else if (!state.calibrated) {
        classes.push('uncalibrated');
        suffix = ` ${t('gamepadAxisUncalibratedSuffix')}`;
      } else if (state.active !== null) {
        classes.push('active');
      }
      wrap.append(el('span', { class: classes.join(' ') }, [`A${toDisplayIndex(i)}: ${formatAxisValue(value)}${suffix}`]));
    }
    return wrap;
  }

  function renderTargets(bits: number, padType: PadType): HTMLElement {
    const wrap = el('div', { class: 'gp-targets' });
    for (const target of joyTargetsForPadType(padType)) {
      const active = (bits & (1 << retroIdFor(target, padType))) !== 0;
      wrap.append(el('span', { class: active ? 'gp-target active' : 'gp-target' }, [targetLabel(target)]));
    }
    return wrap;
  }

  /**
   * そのパッドが現在割り当たっているポートのパッド種別。3台目以降など未割当のパッドは
   * どのpx68k_joytypeにも属さない(bitsForPad()も未接続ポート扱いで呼ばれず意味を持たない)ため、
   * 表示だけ default(2ボタン)にフォールバックする。
   */
  function padTypeForPad(pad: Gamepad): PadType {
    const port = callbacks.getPort(pad.index);
    return port === 0 || port === 1 ? callbacks.getPadType(port) : 'default';
  }

  function renderLive(pads: Gamepad[]): void {
    liveContainerEl.textContent = '';
    for (const pad of pads) {
      const padType = padTypeForPad(pad);
      let bits = 0;
      try {
        bits = callbacks.resolveBits(pad, padType);
      } catch {
        // 偽パッド(テスト/ヘッドレス検証用)がbuttons/axesの形を崩していても表示だけは壊さない。
        bits = 0;
      }
      const port = callbacks.getPort(pad.index);
      const portLabel = port === null ? t('gamepadPortUnassigned') : t('gamepadPortAssigned', { port: port + 1 });
      const header = el('h4', { class: 'gp-live-title' }, [t('gamepadLiveTitle', { name: pad.id, portLabel })]);
      const physical = el('div', { class: 'gp-live-col' }, [
        el('div', { class: 'gp-live-col-title' }, [t('gamepadPhysicalTitle')]),
        renderButtons(pad),
        renderAxes(pad),
      ]);
      const x68k = el('div', { class: 'gp-live-col' }, [
        el('div', { class: 'gp-live-col-title' }, [t('gamepadX68kTitle')]),
        renderTargets(bits, padType),
      ]);
      liveContainerEl.append(
        el('div', { class: 'gp-live-block' }, [header, el('div', { class: 'gp-live-row' }, [physical, x68k])]),
      );
    }
  }

  /** 編集対象パッドが未接続/未選択なら、接続中パッドの先頭を自動選出する。 */
  function ensureEditingPad(pads: Gamepad[]): Gamepad | null {
    let pad = pads.find((p) => p.id === editingPadId) ?? null;
    if (!pad) {
      pad = pads[0] ?? null;
      editingPadId = pad?.id ?? null;
    }
    return pad;
  }

  function applyFlow(next: DetectFlowState): void {
    detect = next.detect;
    pendingGeneric = next.pendingGeneric;
  }

  function startRowDetect(pad: Gamepad, target: JoyTarget): void {
    // pad はボタン行のクリックハンドラに閉じ込められた、古くなっているかもしれない参照
    // (freshPadFor のコメント参照)。baseline は必ず今この瞬間の状態から作る。
    const fresh = freshPadFor(connectedPads(), pad);
    applyFlow(startRowDetectFlow(fresh.id, target, snapshotPad(fresh)));
    renderEditor(connectedPads());
  }

  function startGenericDetect(pad: Gamepad): void {
    const fresh = freshPadFor(connectedPads(), pad);
    applyFlow(startGenericDetectFlow(fresh.id, snapshotPad(fresh)));
    renderEditor(connectedPads());
  }

  function cancelDetect(): void {
    if (detect === null) return;
    applyFlow(cancelDetectFlow({ detect, pendingGeneric }));
    renderEditor(connectedPads());
  }

  /**
   * 検出成功後、宛先(ジョイスティック/キーボード)選択待ちの状態(pendingGeneric)を破棄する。
   * この状態のとき[キーを割り当てる]ボタンは disabled にしてあるので、以前はここへの導線が
   * 無く、押し直すと startGenericDetect() が pendingGeneric を黙って上書きしてしまっていた
   * (検出したのに何も起きないように見える原因の一つ)。専用の[キャンセル]ボタンから呼ぶ。
   */
  function cancelPendingGeneric(): void {
    if (pendingGeneric === null) return;
    applyFlow(cancelPendingGenericFlow({ detect, pendingGeneric }));
    renderEditor(connectedPads());
  }

  /** 割当編集エリア(パッド選択・6行のバインディング表・デッドゾーン・キーボード枠)を丸ごと再構築する。 */
  function renderEditor(pads: Gamepad[]): void {
    rowStatusEls.clear();
    rowDetectBtns.clear();
    genericStatusEl = null;
    genericDetectBtn = null;

    editorPadSelectEl.textContent = '';
    editorEl.textContent = '';

    if (pads.length === 0) {
      editorEl.append(el('div', { class: 'gp-hint' }, [t('gamepadNoPads')]));
      return;
    }
    const pad = ensureEditingPad(pads);
    if (!pad) return;

    // 編集対象パッド選択。
    const padSelectLabel = el('label', { class: 'gp-edit-pad-row' }, [t('gamepadEditingPadLabel')]);
    const padSelect = el('select', { class: 'gp-edit-pad-input' });
    for (const p of pads) padSelect.append(new Option(`${p.id} (#${toDisplayIndex(p.index)})`, p.id));
    padSelect.value = pad.id;
    padSelect.addEventListener('change', () => {
      editingPadId = padSelect.value;
      applyFlow(IDLE_DETECT_FLOW_STATE);
      renderEditor(connectedPads());
    });
    padSelectLabel.append(padSelect);
    editorPadSelectEl.append(padSelectLabel);

    // デッドゾーン。
    const deadzone = callbacks.getDeadzone(pad);
    const deadzoneRow = el('div', { class: 'gp-deadzone-row' });
    const deadzoneLabel = el('span', { class: 'gp-deadzone-label' }, [t('gamepadDeadzoneLabel')]);
    const deadzoneInput = el('input', {
      type: 'range',
      min: '0.1',
      max: '0.9',
      step: '0.05',
      value: String(deadzone),
      class: 'gp-deadzone-input',
    }) as HTMLInputElement;
    const deadzoneValue = el('span', { class: 'gp-deadzone-value' }, [deadzone.toFixed(2)]);
    deadzoneInput.addEventListener('input', () => {
      const value = Number(deadzoneInput.value);
      callbacks.setDeadzone(pad, value);
      deadzoneValue.textContent = value.toFixed(2);
    });
    deadzoneRow.append(deadzoneLabel, deadzoneInput, deadzoneValue);

    // 既定へリセット(接続中パッドのid/種別に合う既定値。8BitDo M30/Micro等は専用プリセット、
    // それ以外は standard mapping なら XInput標準、そうでなければ全未割当)。
    const resetBtn = el('button', { type: 'button', class: 'gp-reset-btn', title: t('gamepadResetPresetBtnTitle') }, [
      t('gamepadResetPresetBtn'),
    ]);
    resetBtn.addEventListener('click', () => {
      callbacks.resetToPreset(pad);
      applyFlow(cancelDetectFlow({ detect, pendingGeneric }));
      renderEditor(connectedPads());
    });

    editorEl.append(deadzoneRow, resetBtn);

    // バインディング表(2ボタン=6行、CPSF-MD/SFC=12行。行数はそのパッドが繋がっているポートの
    // パッド種別で決まる。未割当パッドは default=6行のまま編集できる)。
    const table = el('div', { class: 'gp-bind-table' });
    for (const target of joyTargetsForPadType(padTypeForPad(pad))) {
      table.append(renderBindingRow(pad, target));
    }
    editorEl.append(table);

    // その他の割当(キーボード枠)。今回は選べるだけで出力配線は次担当が行う。
    editorEl.append(renderGenericSection(pad, padTypeForPad(pad)));
  }

  function renderBindingRow(pad: Gamepad, target: JoyTarget): HTMLElement {
    const sources = callbacks.getBindingsForTarget(pad, target);
    const chipsEl = el('div', { class: 'gp-chip-list' });
    for (const source of sources) {
      const removeBtn = el('button', { type: 'button', class: 'gp-chip-remove', 'aria-label': t('gamepadRemoveBindingLabel') }, ['×']);
      removeBtn.addEventListener('click', () => {
        callbacks.removeBinding(pad, source, { kind: 'joy', target });
        renderEditor(connectedPads());
      });
      chipsEl.append(el('span', { class: 'gp-chip' }, [sourceLabel(source, pad), removeBtn]));
    }
    if (sources.length === 0) {
      chipsEl.append(el('span', { class: 'gp-chip-empty' }, ['—']));
    }

    const statusEl = el('span', { class: 'gp-detect-status' });
    rowStatusEls.set(target, statusEl);

    // 検出待ち中は[検出(置き換え)]自体を[キャンセル]に差し替える。以前はラベル・見た目が
    // 変わらないままステータス文言(gp-detect-status)だけが変化していたため、待機中に
    // ボタンが消えず残っているように見えた(問題1)。押せば即座に中断できるようにし、
    // Escが使えない環境(スマホ等)でも抜けられるようにする(問題3)。
    const isActive = detect !== null && detect.kind === 'row' && detect.target === target;
    const detectBtn = el(
      'button',
      {
        type: 'button',
        class: 'gp-detect-btn',
        title: isActive ? t('gamepadCancelBtnTitle') : t('gamepadDetectBtnTitle'),
      },
      [isActive ? t('gamepadCancelBtn') : t('gamepadDetectBtn')],
    );
    detectBtn.addEventListener('click', () => {
      if (detect !== null && detect.kind === 'row' && detect.target === target) {
        cancelDetect();
      } else {
        startRowDetect(pad, target);
      }
    });
    rowDetectBtns.set(target, detectBtn);

    const combo = el('select', { class: 'gp-source-combo', title: t('gamepadComboPlaceholder') });
    combo.append(new Option(t('gamepadComboPlaceholder'), ''));
    const optgroup = document.createElement('optgroup');
    optgroup.label = t('gamepadComboJoystickGroup');
    const options = sourceOptionsFor(pad, callbacks);
    options.forEach((entry, idx) => optgroup.append(new Option(entry.label, String(idx))));
    combo.append(optgroup);
    combo.addEventListener('change', () => {
      if (combo.value === '') return;
      const entry = options[Number(combo.value)];
      if (entry) callbacks.addBinding(pad, entry.source, { kind: 'joy', target });
      renderEditor(connectedPads());
    });

    return el('div', { class: 'gp-bind-row' }, [
      el('span', { class: 'gp-bind-row-label' }, [targetLabel(target)]),
      chipsEl,
      detectBtn,
      combo,
      statusEl,
    ]);
  }

  /** 「その他の割当(キーボード)」セクション。検出→宛先(ジョイスティック/キーボード)選択→追加、の2段階フロー。 */
  function renderGenericSection(pad: Gamepad, padType: PadType): HTMLElement {
    const title = el('h4', { class: 'gp-generic-title' }, [t('gamepadComboKeyboardGroup')]);
    const desc = el('p', { class: 'gp-generic-desc' }, [t('gamepadGenericSectionDesc')]);

    const chipsEl = el('div', { class: 'gp-chip-list' });
    for (const { source, retrok } of callbacks.getKeyBindings(pad)) {
      const label = KEYBOARD_OPTIONS.find((k) => k.retrok === retrok)?.label ?? `0x${retrok.toString(16)}`;
      const removeBtn = el('button', { type: 'button', class: 'gp-chip-remove', 'aria-label': t('gamepadRemoveBindingLabel') }, ['×']);
      removeBtn.addEventListener('click', () => {
        callbacks.removeBinding(pad, source, { kind: 'key', retrok });
        renderEditor(connectedPads());
      });
      chipsEl.append(el('span', { class: 'gp-chip' }, [`${sourceLabel(source, pad)} → ${label}`, removeBtn]));
    }
    if (callbacks.getKeyBindings(pad).length === 0) {
      chipsEl.append(el('span', { class: 'gp-chip-empty' }, [t('gamepadGenericEmptyLabel')]));
    }

    const statusEl = el('span', { class: 'gp-detect-status' });
    genericStatusEl = statusEl;

    const isPending = pendingGeneric !== null && pendingGeneric.padId === pad.id;
    // 検出待ち中は[キーを割り当てる]を[キャンセル]に差し替える(問題1・3。行側と同じ理由)。
    // 検出成功後、宛先選択待ち(pendingGeneric)の間はこのボタンを disabled にする:
    // 以前は有効なままだったため、待機中の見た目が変わらないことに気づいた利用者が
    // もう一度このボタンを押すと startGenericDetect() が pendingGeneric を黙って
    // 上書きし、せっかく検出できていた入力ごと消えてしまっていた(問題2の一因)。
    const isActive = detect !== null && detect.kind === 'generic';
    const detectBtn = el(
      'button',
      {
        type: 'button',
        class: 'gp-detect-btn',
        title: isActive ? t('gamepadCancelBtnTitle') : t('gamepadGenericDetectBtnTitle'),
      },
      [isActive ? t('gamepadCancelBtn') : t('gamepadGenericDetectBtn')],
    );
    detectBtn.disabled = isPending;
    detectBtn.addEventListener('click', () => {
      if (detect !== null && detect.kind === 'generic') cancelDetect();
      else startGenericDetect(pad);
    });
    genericDetectBtn = detectBtn;

    const row = el('div', { class: 'gp-generic-row' }, [chipsEl, detectBtn, statusEl]);

    if (pendingGeneric && pendingGeneric.padId === pad.id) {
      const source = pendingGeneric.source;
      const destSelect = el('select', { class: 'gp-dest-combo' });
      destSelect.append(new Option(t('gamepadComboPlaceholder'), ''));
      const joyGroup = document.createElement('optgroup');
      joyGroup.label = t('gamepadComboJoystickGroup');
      joyTargetsForPadType(padType).forEach((tgt) => joyGroup.append(new Option(targetLabel(tgt), `joy:${tgt}`)));
      const keyGroup = document.createElement('optgroup');
      keyGroup.label = t('gamepadComboKeyboardGroup');
      KEYBOARD_OPTIONS.forEach((k) => keyGroup.append(new Option(k.label, `key:${k.retrok}`)));
      destSelect.append(joyGroup, keyGroup);
      destSelect.addEventListener('change', () => {
        const value = destSelect.value;
        if (value === '') return;
        if (value.startsWith('joy:')) {
          callbacks.addBinding(pad, source, { kind: 'joy', target: value.slice(4) as JoyTarget });
        } else if (value.startsWith('key:')) {
          callbacks.addBinding(pad, source, { kind: 'key', retrok: Number(value.slice(4)) });
        }
        applyFlow(resolvePendingGenericPicked({ detect, pendingGeneric }));
        renderEditor(connectedPads());
      });
      const cancelPendingBtn = el(
        'button',
        { type: 'button', class: 'gp-detect-btn', title: t('gamepadCancelBtnTitle') },
        [t('gamepadCancelBtn')],
      );
      cancelPendingBtn.addEventListener('click', () => cancelPendingGeneric());
      row.append(
        el('span', { class: 'gp-pending-source' }, [sourceLabel(source, pad)]),
        el('span', {}, ['→']),
        destSelect,
        cancelPendingBtn,
      );
    }

    return el('div', { class: 'gp-generic-section' }, [title, desc, row]);
  }

  /** 検出モードの押下判定(毎フレーム)。DOM再構築はせず、案内テキストと他ボタンのdisabledだけその場で更新する。 */
  function tickDetect(pads: Gamepad[]): void {
    for (const [target, statusEl] of rowStatusEls) {
      const active = detect !== null && detect.kind === 'row' && detect.target === target;
      statusEl.textContent = active ? t('gamepadDetectWaiting') : '';
      const btn = rowDetectBtns.get(target);
      if (btn) btn.disabled = detect !== null && !active;
    }
    if (genericStatusEl) {
      const active = detect !== null && detect.kind === 'generic';
      genericStatusEl.textContent = active ? t('gamepadDetectWaiting') : '';
    }
    // pendingGeneric中(宛先選択待ち)もdisabledを維持する。renderGenericSection()側の初期値を
    // ここで上書きしないよう条件を合わせておく(合わせないと、detectがnullに戻った瞬間に
    // このtickが disabled=false へ戻してしまい、pendingGeneric中でも押せてしまう)。
    if (genericDetectBtn) {
      genericDetectBtn.disabled =
        (detect !== null && detect.kind !== 'generic') || (pendingGeneric !== null && pendingGeneric.padId === editingPadId);
    }

    if (detect === null) return;
    const pad = pads.find((p) => p.id === detect!.padId);
    if (!pad) return; // 検出中に抜かれた場合はそのまま待機(戻ってくれば再開できる)。
    const curr = snapshotPad(pad);
    const deadzone = callbacks.getDeadzone(pad);
    // 未較正の軸(観測開始してから一度も動かされていない)は検出対象から除外する。較正されるまで
    // その軸の値には意味が無く、誤って割り当ててしまうと使い物にならない入力ができてしまうため
    // (gamepad.ts の AxisCalibration 参照。一度動かせば較正され、次回以降は検出できるようになる)。
    const found = detectNewlyActiveSource(detect.baseline, curr, deadzone, (axisIndex) => callbacks.getAxisState(pad, axisIndex).calibrated);
    if (found) {
      if (detect.kind === 'row') callbacks.replaceTargetBinding(pad, found, detect.target);
      applyFlow(resolveDetectFound({ detect, pendingGeneric }, found));
      renderEditor(pads);
      return;
    }
    // ローリング基準: 押しっぱなしのボタンを誤検出しないため、
    // 「直前フレームで既に押されていたか」を毎フレーム更新しながら「新規の押下」だけを拾う。
    detect = { ...detect, baseline: curr };
  }

  function render(): void {
    const pads = connectedPads();
    renderPadList(pads);
    renderLive(pads);
    tickDetect(pads);
    const key = pads.map((p) => p.id).join(',');
    if (key !== lastEditorKey) {
      lastEditorKey = key;
      renderPortSelect(pads);
      renderEditor(pads);
    }
  }

  function tick(): void {
    render();
    rafId = requestAnimationFrame(tick);
  }

  function close(): void {
    backdrop.classList.add('hidden');
    applyFlow(IDLE_DETECT_FLOW_STATE);
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  closeBtn.addEventListener('click', () => close());
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || backdrop.classList.contains('hidden')) return;
    if (detect !== null) {
      cancelDetect();
      return;
    }
    if (pendingGeneric !== null) {
      cancelPendingGeneric();
      return;
    }
    close();
  });

  function open(): void {
    backdrop.classList.remove('hidden');
    lastEditorKey = '__force__'; // 開くたびにパッド選択・編集表を作り直す。
    renderPadTypeSelect();
    render();
    if (rafId === null) rafId = requestAnimationFrame(tick);
  }

  return {
    open,
    applyStrings(): void {
      titleEl.textContent = t('gamepadDialogTitle');
      descEl.textContent = t('gamepadDialogDescription');
      listTitleEl.textContent = t('gamepadConnectedTitle');
      padTypeTitleEl.textContent = t('gamepadPadTypeTitle');
      editorTitleEl.textContent = t('gamepadBindingsTitle');
      closeBtn.textContent = t('gamepadDialogClose');
      if (!backdrop.classList.contains('hidden')) {
        lastEditorKey = '__force__';
        renderPadTypeSelect();
        render();
      }
    },
  };
}
