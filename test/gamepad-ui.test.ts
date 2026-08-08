import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_DEADZONE, detectNewlyActiveSource, snapshotPad, type PadSnapshot, type Source } from '../src/gamepad.ts';

// strings.ts はモジュール初期化時に resolveLang() → location.search を参照するため、
// Node環境(vitest environment: 'node')には無い location をここで用意してから
// dynamic import する(fat-not-formatted.test.ts と同じ流儀)。gamepad-ui.ts は strings.ts を
// 静的importしているため、gamepad-ui.ts 自体も dynamic import にする必要がある。
let toDisplayIndex: (typeof import('../src/gamepad-ui.ts'))['toDisplayIndex'];
let formatAxisValue: (typeof import('../src/gamepad-ui.ts'))['formatAxisValue'];
let sourceLabel: (typeof import('../src/gamepad-ui.ts'))['sourceLabel'];
let IDLE_DETECT_FLOW_STATE: (typeof import('../src/gamepad-ui.ts'))['IDLE_DETECT_FLOW_STATE'];
let startRowDetectFlow: (typeof import('../src/gamepad-ui.ts'))['startRowDetectFlow'];
let startGenericDetectFlow: (typeof import('../src/gamepad-ui.ts'))['startGenericDetectFlow'];
let resolveDetectFound: (typeof import('../src/gamepad-ui.ts'))['resolveDetectFound'];
let cancelDetectFlow: (typeof import('../src/gamepad-ui.ts'))['cancelDetectFlow'];
let cancelPendingGenericFlow: (typeof import('../src/gamepad-ui.ts'))['cancelPendingGenericFlow'];
let resolvePendingGenericPicked: (typeof import('../src/gamepad-ui.ts'))['resolvePendingGenericPicked'];
let freshPadFor: (typeof import('../src/gamepad-ui.ts'))['freshPadFor'];

beforeAll(async () => {
  if (typeof (globalThis as { location?: unknown }).location === 'undefined') {
    (globalThis as { location?: { search: string } }).location = { search: '' };
  }
  ({
    toDisplayIndex,
    formatAxisValue,
    sourceLabel,
    IDLE_DETECT_FLOW_STATE,
    startRowDetectFlow,
    startGenericDetectFlow,
    resolveDetectFound,
    cancelDetectFlow,
    cancelPendingGenericFlow,
    resolvePendingGenericPicked,
    freshPadFor,
  } = await import('../src/gamepad-ui.ts'));
  // 実行環境のnavigator.languageに依存せず文言を固定するため、明示的に日本語へ設定する。
  const { setLang } = await import('../src/strings.ts');
  setLang('ja');
});

const BASELINE: PadSnapshot = { buttons: [false, false], axes: [0, 0] };
const BUTTON0_SOURCE: Source = { kind: 'button', index: 0 };

// テスト用の最小 Gamepad モック(sourceLabel はボタン/軸の押下状態を見ないため中身は空でよい)。
// id/pressed は freshPadFor の回帰テスト(古いpad参照 vs 最新pads配列)のために追加。
function makeGamepad(
  opts: { id?: string; mapping?: '' | 'standard'; buttonCount?: number; pressed?: readonly number[] } = {},
): Gamepad {
  const buttonCount = opts.buttonCount ?? 17;
  const pressedSet = new Set(opts.pressed ?? []);
  const buttons = Array.from({ length: buttonCount }, (_, i) => ({
    pressed: pressedSet.has(i),
    touched: pressedSet.has(i),
    value: pressedSet.has(i) ? 1 : 0,
  }));
  return {
    id: opts.id ?? 'mock',
    index: 0,
    connected: true,
    timestamp: 0,
    mapping: opts.mapping ?? 'standard',
    buttons: buttons as unknown as readonly GamepadButton[],
    axes: [0, 0, 0, 0],
    hapticActuators: [],
    vibrationActuator: null as unknown as GamepadHapticActuator,
  } as Gamepad;
}

describe('toDisplayIndex', () => {
  it('0始まりのGamepad API indexを1始まりの表示用番号へ変換する', () => {
    expect(toDisplayIndex(0)).toBe(1);
    expect(toDisplayIndex(1)).toBe(2);
    expect(toDisplayIndex(15)).toBe(16);
  });
});

describe('formatAxisValue(丸めて0になる負値は"-0.00"ではなく"0.00"にする)', () => {
  it('丸めるとゼロになる微小な負値は符号を落とす', () => {
    expect(formatAxisValue(-0.00392)).toBe('0.00');
    expect(formatAxisValue(-0.004)).toBe('0.00');
  });
  it('丸めても非ゼロが残る負値は符号を保つ', () => {
    expect(formatAxisValue(-0.02)).toBe('-0.02');
    expect(formatAxisValue(-1)).toBe('-1.00');
  });
  it('ちょうど0とプラス値はそのまま', () => {
    expect(formatAxisValue(0)).toBe('0.00');
    expect(formatAxisValue(3.28571)).toBe('3.29');
  });
});

describe('sourceLabel (表示は1始まり)', () => {
  it('standard mappingのボタンindex0は#1として位置名付きで表示される(下ボタン)', () => {
    const pad = makeGamepad({ mapping: 'standard' });
    const label = sourceLabel({ kind: 'button', index: 0 }, pad);
    expect(label).toContain('#1');
    expect(label).not.toContain('#0');
  });

  it('standard mappingのボタンindex15は#16と表示される', () => {
    const pad = makeGamepad({ mapping: 'standard' });
    const label = sourceLabel({ kind: 'button', index: 15 }, pad);
    expect(label).toContain('#16');
  });

  it('非standard mappingのボタンは1始まり番号のみで表示される', () => {
    const pad = makeGamepad({ mapping: '' });
    expect(sourceLabel({ kind: 'button', index: 0 }, pad)).toBe('ボタン1');
    expect(sourceLabel({ kind: 'button', index: 15 }, pad)).toBe('ボタン16');
  });

  it('軸は1始まりのindexで表示される', () => {
    const pad = makeGamepad();
    expect(sourceLabel({ kind: 'axis', index: 0, dir: 1 }, pad)).toBe('軸1 +');
    expect(sourceLabel({ kind: 'axis', index: 3, dir: -1 }, pad)).toBe('軸4 -');
  });
});

// 検出待ち状態の純粋な状態遷移。実機で「'キーを割り当てる'ボタンが待機中も変わらないまま」
// 「その状態でパッドのボタンを押しても反応しない」の2件を調査した結果見つかった根本原因
// (pendingGeneric中に同じボタンを押し直すと startGenericDetect が黙って上書きしてしまう)
// が再発しないことを、DOM/Gamepad APIを介さずに保証するためのテスト。
describe('検出待ち状態の遷移(DOM非依存の純粋ロジック)', () => {
  it('行の検出: 開始→入力で確定→行のバインディングは呼び出し側が別途反映し、detectはidleに戻る', () => {
    const started = startRowDetectFlow('pad-1', 'TRG1', BASELINE);
    expect(started.detect).toEqual({ kind: 'row', padId: 'pad-1', target: 'TRG1', baseline: BASELINE });
    expect(started.pendingGeneric).toBeNull();

    const found = resolveDetectFound(started, BUTTON0_SOURCE);
    expect(found.detect).toBeNull();
    expect(found.pendingGeneric).toBeNull(); // 行は即確定。宛先選択待ちにはならない。
  });

  it('行の検出: キャンセルで開始前の状態(idle)に戻る', () => {
    const started = startRowDetectFlow('pad-1', 'TRG1', BASELINE);
    const cancelled = cancelDetectFlow(started);
    expect(cancelled).toEqual(IDLE_DETECT_FLOW_STATE);
  });

  it('キーボードの検出: 開始→入力で確定すると、即座には終わらず宛先選択待ち(pendingGeneric)へ進む', () => {
    const started = startGenericDetectFlow('pad-1', BASELINE);
    expect(started.detect).toEqual({ kind: 'generic', padId: 'pad-1', baseline: BASELINE });

    const found = resolveDetectFound(started, BUTTON0_SOURCE);
    expect(found.detect).toBeNull();
    expect(found.pendingGeneric).toEqual({ padId: 'pad-1', source: BUTTON0_SOURCE });
  });

  it('キーボードの検出: 宛先選択でidleに戻る(呼び出し側が別途addBindingを実行する)', () => {
    const pending = resolveDetectFound(startGenericDetectFlow('pad-1', BASELINE), BUTTON0_SOURCE);
    const picked = resolvePendingGenericPicked(pending);
    expect(picked).toEqual(IDLE_DETECT_FLOW_STATE);
  });

  it('キーボードの検出: 宛先選択待ち中のキャンセルでidleに戻る(専用の[キャンセル]ボタン用)', () => {
    const pending = resolveDetectFound(startGenericDetectFlow('pad-1', BASELINE), BUTTON0_SOURCE);
    const cancelled = cancelPendingGenericFlow(pending);
    expect(cancelled).toEqual(IDLE_DETECT_FLOW_STATE);
  });

  it('根本原因の再発防止: 宛先選択待ち中に検出をもう一度開始しても、以前検出できていた入力が' +
    '黙って上書きされることはない(呼び出し側はpendingGeneric中は開始ボタンをdisabledにする対策と対で、' +
    'ここでは少なくとも状態自体は素直に開始状態へ戻ることを確認する回帰テスト)', () => {
    const pending = resolveDetectFound(startGenericDetectFlow('pad-1', BASELINE), BUTTON0_SOURCE);
    expect(pending.pendingGeneric).not.toBeNull();
    const restarted = startGenericDetectFlow('pad-1', BASELINE);
    // 単体では「開始」自体は正しく動く。実際のバグは、UIがこの関数を呼べる状態のまま
    // 待機中の見た目を変えていなかったこと(genericDetectBtnをpendingGeneric中はdisabledにする)
    // にあったため、そちらはgamepad-ui.ts本体側(disabled制御)で担保する。
    expect(restarted.pendingGeneric).toBeNull();
    expect(restarted.detect).toEqual({ kind: 'generic', padId: 'pad-1', baseline: BASELINE });
  });

  it('別の行の検出を開始すると、キーボード側の宛先選択待ちは破棄される(両立させない)', () => {
    const pending = resolveDetectFound(startGenericDetectFlow('pad-1', BASELINE), BUTTON0_SOURCE);
    const switched = startRowDetectFlow('pad-1', 'TRG2', BASELINE);
    void pending;
    expect(switched.pendingGeneric).toBeNull();
    expect(switched.detect).toEqual({ kind: 'row', padId: 'pad-1', target: 'TRG2', baseline: BASELINE });
  });

  it('detectがnullの時にresolveDetectFoundを呼んでも何もしない(型ガード漏れの保険)', () => {
    expect(resolveDetectFound(IDLE_DETECT_FLOW_STATE, BUTTON0_SOURCE)).toEqual(IDLE_DETECT_FLOW_STATE);
  });
});

// 実機報告(2026-08-08): ページを開いた直後(パッド構成が一度も変わっていない状態)でのみ、
// 検出(キーボード側[キーを割り当てる]・行側[検出(置き換え)]の両方)がパッドの押下を
// 一切拾わなくなる不具合。
//
// 根本原因: renderBindingRow/renderGenericSection のクリックハンドラに閉じ込められた pad は
// 「最後に renderEditor() が走った時点」の Gamepad オブジェクト(=ダイアログを開いた瞬間の
// navigator.getGamepads() スナップショット)で、その後 navigator.getGamepads() を呼び直すまで
// 値が更新される保証が無い(MDNも「古い Gamepad 参照を使い回さず毎回取得し直す」よう注意している)。
// renderEditor() はパッド構成が変わった時だけ再実行されるため、開いてから一度もパッド構成が
// 変わっていなければ、この pad はダイアログを開いた瞬間の値のまま凍結され続ける。
// startRowDetect/startGenericDetect がこの凍結された pad をそのまま snapshotPad() に渡して
// baseline を作っていたため、baseline が「検出を始めた本当の瞬間」ではなく「ダイアログを
// 開いた瞬間」の状態になってしまい、以後の押下判定が実際の押下タイミングとズレて機能しなくなる。
// 修正: freshPadFor() で「今の pads 配列にある同じ id の pad」を都度取り直してから
// snapshotPad() に渡すようにした(src/gamepad-ui.ts の startRowDetect/startGenericDetect)。
describe('freshPadFor(検出開始時に古いpad参照ではなく最新スナップショットを使う, 実機報告の根本原因への対策)', () => {
  it('pads配列に同じidのpadがあれば、そちらを返す(渡されたpadが古くても最新を優先する)', () => {
    const stale = makeGamepad({ id: 'pad-1', pressed: [] });
    const fresh = makeGamepad({ id: 'pad-1', pressed: [6] });
    expect(freshPadFor([fresh], stale)).toBe(fresh);
  });

  it('該当パッドが見つからない(切断済み等)場合は、渡されたpadをそのまま返す', () => {
    const stale = makeGamepad({ id: 'pad-1' });
    expect(freshPadFor([], stale)).toBe(stale);
  });

  it('【回帰】検出開始直後の1フレーム目: 開始時点で既に押されている入力はbaselineに正しく反映され、' +
    '押しっぱなし扱いになる(=誤って「新規押下」として検出されない)', () => {
    // ダイアログを開いた瞬間(まだ何も押されていない)のpad参照。
    const atOpenTime = makeGamepad({ id: 'pad-1', pressed: [] });
    // ユーザーが[キーを割り当てる]を押す直前、実際には既にボタン6を押し込んでいた
    // (=検出を開始する「本当の瞬間」の状態)。pads配列は毎フレームnavigator.getGamepads()から
    // 取り直すため、この最新状態を持っている。
    const atClickTime = makeGamepad({ id: 'pad-1', pressed: [6] });
    const pads = [atClickTime];

    // 修正後: freshPadForで最新のpadを取り直してからbaselineを作る。
    const baseline = snapshotPad(freshPadFor(pads, atOpenTime));
    // 検出開始直後の1フレーム目、まだ何も状態変化が無い(押しっぱなしのまま)。
    const curr = snapshotPad(atClickTime);
    expect(detectNewlyActiveSource(baseline, curr, DEFAULT_DEADZONE)).toBeNull();
  });

  it('【回帰・修正前の再現】古いpad参照をそのままbaselineに使うと、検出開始前から押されていた' +
    'ボタンが「新規押下」に誤検出されてしまう(freshPadForを外すと再発することを保証する)', () => {
    const atOpenTime = makeGamepad({ id: 'pad-1', pressed: [] });
    const atClickTime = makeGamepad({ id: 'pad-1', pressed: [6] });

    // 修正前の実装を再現: freshPadForを挟まず、閉じ込められた古いpadをそのままsnapshotPadへ。
    const staleBaseline = snapshotPad(atOpenTime);
    const curr = snapshotPad(atClickTime);
    // baselineが古いため「押されていなかった→押された」に見えてしまう(誤検出)。
    expect(detectNewlyActiveSource(staleBaseline, curr, DEFAULT_DEADZONE)).toEqual({ kind: 'button', index: 6 });
  });

  it('検出開始直後の1フレーム目でも、そのフレームで新たに押されたボタンは取りこぼさず検出する', () => {
    const atStart = makeGamepad({ id: 'pad-1', pressed: [] });
    const pads = [atStart];
    const baseline = snapshotPad(freshPadFor(pads, atStart));
    // 開始した直後(1フレーム目)にボタン6が押された。
    const curr = snapshotPad(makeGamepad({ id: 'pad-1', pressed: [6] }));
    expect(detectNewlyActiveSource(baseline, curr, DEFAULT_DEADZONE)).toEqual({ kind: 'button', index: 6 });
  });
});
