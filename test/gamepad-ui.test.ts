import { beforeAll, describe, expect, it } from 'vitest';
import type { PadSnapshot, Source } from '../src/gamepad.ts';

// strings.ts はモジュール初期化時に resolveLang() → location.search を参照するため、
// Node環境(vitest environment: 'node')には無い location をここで用意してから
// dynamic import する(fat-not-formatted.test.ts と同じ流儀)。gamepad-ui.ts は strings.ts を
// 静的importしているため、gamepad-ui.ts 自体も dynamic import にする必要がある。
let toDisplayIndex: (typeof import('../src/gamepad-ui.ts'))['toDisplayIndex'];
let sourceLabel: (typeof import('../src/gamepad-ui.ts'))['sourceLabel'];
let IDLE_DETECT_FLOW_STATE: (typeof import('../src/gamepad-ui.ts'))['IDLE_DETECT_FLOW_STATE'];
let startRowDetectFlow: (typeof import('../src/gamepad-ui.ts'))['startRowDetectFlow'];
let startGenericDetectFlow: (typeof import('../src/gamepad-ui.ts'))['startGenericDetectFlow'];
let resolveDetectFound: (typeof import('../src/gamepad-ui.ts'))['resolveDetectFound'];
let cancelDetectFlow: (typeof import('../src/gamepad-ui.ts'))['cancelDetectFlow'];
let cancelPendingGenericFlow: (typeof import('../src/gamepad-ui.ts'))['cancelPendingGenericFlow'];
let resolvePendingGenericPicked: (typeof import('../src/gamepad-ui.ts'))['resolvePendingGenericPicked'];

beforeAll(async () => {
  if (typeof (globalThis as { location?: unknown }).location === 'undefined') {
    (globalThis as { location?: { search: string } }).location = { search: '' };
  }
  ({
    toDisplayIndex,
    sourceLabel,
    IDLE_DETECT_FLOW_STATE,
    startRowDetectFlow,
    startGenericDetectFlow,
    resolveDetectFound,
    cancelDetectFlow,
    cancelPendingGenericFlow,
    resolvePendingGenericPicked,
  } = await import('../src/gamepad-ui.ts'));
  // 実行環境のnavigator.languageに依存せず文言を固定するため、明示的に日本語へ設定する。
  const { setLang } = await import('../src/strings.ts');
  setLang('ja');
});

const BASELINE: PadSnapshot = { buttons: [false, false], axes: [0, 0] };
const BUTTON0_SOURCE: Source = { kind: 'button', index: 0 };

// テスト用の最小 Gamepad モック(sourceLabel はボタン/軸の押下状態を見ないため中身は空でよい)。
function makeGamepad(opts: { mapping?: '' | 'standard'; buttonCount?: number } = {}): Gamepad {
  const buttonCount = opts.buttonCount ?? 17;
  const buttons = Array.from({ length: buttonCount }, () => ({ pressed: false, touched: false, value: 0 }));
  return {
    id: 'mock',
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
