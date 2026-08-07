import { describe, expect, it } from 'vitest';
import { assignPorts, DEFAULT_DEADZONE, GamepadManager } from '../src/gamepad';

// libretro.h の RETRO_DEVICE_ID_JOYPAD_* / TARGET_TO_RETRO_ID(gamepad.ts)と対応する。
const RETRO_B = 0; // TRG1
const RETRO_A = 8; // TRG2
const RETRO_UP = 4;
const RETRO_DOWN = 5;
const RETRO_LEFT = 6;
const RETRO_RIGHT = 7;

/** テスト用の最小 Gamepad モック(標準マッピング準拠、17ボタン/4軸)。 */
function makeGamepad(
  opts: { buttons?: Record<number, boolean>; axes?: Record<number, number>; index?: number } = {},
): Gamepad {
  const buttons = Array.from({ length: 17 }, (_, i) => ({
    pressed: opts.buttons?.[i] ?? false,
    touched: false,
    value: opts.buttons?.[i] ? 1 : 0,
  }));
  const axes = [0, 0, 0, 0];
  for (const [k, v] of Object.entries(opts.axes ?? {})) axes[Number(k)] = v;
  return {
    id: 'mock',
    index: opts.index ?? 0,
    connected: true,
    timestamp: 0,
    mapping: 'standard',
    buttons: buttons as unknown as readonly GamepadButton[],
    axes,
    hapticActuators: [],
    vibrationActuator: null as unknown as GamepadHapticActuator,
  } as Gamepad;
}

describe('GamepadManager (XINPUT_PRESET)', () => {
  it('buttons[0](下ボタン)押下で TRG1 ビットが立つ', () => {
    const mgr = new GamepadManager();
    const pad = makeGamepad({ buttons: { 0: true } });
    const [bits0] = mgr.poll([pad]);
    expect(bits0).toBe(1 << RETRO_B);
  });

  it('buttons[1](右ボタン)押下で TRG2 ビットが立つ', () => {
    const mgr = new GamepadManager();
    const pad = makeGamepad({ buttons: { 1: true } });
    const [bits0] = mgr.poll([pad]);
    expect(bits0).toBe(1 << RETRO_A);
  });

  it('D-Pad(buttons[12..15])が UP/DOWN/LEFT/RIGHT に対応する', () => {
    const mgr = new GamepadManager();
    expect(mgr.poll([makeGamepad({ buttons: { 12: true } })])[0]).toBe(1 << RETRO_UP);
    expect(mgr.poll([makeGamepad({ buttons: { 13: true } })])[0]).toBe(1 << RETRO_DOWN);
    expect(mgr.poll([makeGamepad({ buttons: { 14: true } })])[0]).toBe(1 << RETRO_LEFT);
    expect(mgr.poll([makeGamepad({ buttons: { 15: true } })])[0]).toBe(1 << RETRO_RIGHT);
  });

  it('未割当のボタン(例: buttons[2] SELECT)は無視される', () => {
    const mgr = new GamepadManager();
    const pad = makeGamepad({ buttons: { 2: true, 3: true, 10: true, 11: true } });
    const [bits0] = mgr.poll([pad]);
    expect(bits0).toBe(0);
  });

  it('左スティックのデッドゾーン境界: デッドゾーン以下は無反応', () => {
    const mgr = new GamepadManager();
    const justBelow = makeGamepad({ axes: { 0: DEFAULT_DEADZONE - 0.01 } });
    expect(mgr.poll([justBelow])[0]).toBe(0);
  });

  it('左スティックのデッドゾーン境界: デッドゾーンちょうど/超えは反応する(+方向 = RIGHT)', () => {
    const mgr = new GamepadManager();
    const atThreshold = makeGamepad({ axes: { 0: DEFAULT_DEADZONE } });
    expect(mgr.poll([atThreshold])[0]).toBe(1 << RETRO_RIGHT);
    const beyond = makeGamepad({ axes: { 0: 0.9 } });
    expect(mgr.poll([beyond])[0]).toBe(1 << RETRO_RIGHT);
  });

  it('左スティックの負方向(axes[0] <= -デッドゾーン)は LEFT になる', () => {
    const mgr = new GamepadManager();
    const pad = makeGamepad({ axes: { 0: -0.9 } });
    expect(mgr.poll([pad])[0]).toBe(1 << RETRO_LEFT);
  });

  it('axes[1] は上下(負=UP/正=DOWN)に対応する', () => {
    const mgr = new GamepadManager();
    expect(mgr.poll([makeGamepad({ axes: { 1: -0.9 } })])[0]).toBe(1 << RETRO_UP);
    expect(mgr.poll([makeGamepad({ axes: { 1: 0.9 } })])[0]).toBe(1 << RETRO_DOWN);
  });

  it('D-Pad ボタンと左スティックは OR で合成される(同時押しでも1ビット)', () => {
    const mgr = new GamepadManager();
    const pad = makeGamepad({ buttons: { 15: true }, axes: { 0: 0.9 } });
    const [bits0] = mgr.poll([pad]);
    expect(bits0).toBe(1 << RETRO_RIGHT);
  });

  it('D-Pad と左スティックを別方向で同時に入力すると両方のビットが立つ', () => {
    const mgr = new GamepadManager();
    const pad = makeGamepad({ buttons: { 12: true }, axes: { 0: 0.9 } });
    const [bits0] = mgr.poll([pad]);
    expect(bits0).toBe((1 << RETRO_UP) | (1 << RETRO_RIGHT));
  });

  it('port1 は poll() の配列2番目の Gamepad に対応する', () => {
    const mgr = new GamepadManager();
    const pad0 = makeGamepad({ buttons: { 0: true } });
    const pad1 = makeGamepad({ buttons: { 1: true } });
    const [bits0, bits1] = mgr.poll([pad0, pad1]);
    expect(bits0).toBe(1 << RETRO_B);
    expect(bits1).toBe(1 << RETRO_A);
  });

  it('未接続ポート(null)は0を返す', () => {
    const mgr = new GamepadManager();
    const [bits0, bits1] = mgr.poll([null, null]);
    expect(bits0).toBe(0);
    expect(bits1).toBe(0);
  });
});

// gamepadconnected イベントを経ずに navigator.getGamepads() へ現れたパッドが
// ポート割当から漏れるバグ(ライブ表示は正しく光るのにコアへ届かない)への回帰テスト。
// assignPorts() は毎回のポーリング結果だけから割当を決める純粋関数であること、
// イベントの発火有無に依存しないことを保証する。
describe('assignPorts', () => {
  it('非nullが1つだけ(index 0)なら port0 に割り当てる', () => {
    const pad = makeGamepad({ index: 0 });
    const ports = assignPorts([pad]);
    expect(ports.get(0)).toBe(0);
    expect(ports.size).toBe(1);
  });

  it('配列に穴がある(index 0 が null, index 1 に実体)場合でも詰めて port0 へ割り当てる', () => {
    const pad1 = makeGamepad({ index: 1 });
    const ports = assignPorts([null, pad1]);
    expect(ports.get(1)).toBe(0);
    expect(ports.size).toBe(1);
  });

  it('2台接続時は index の昇順で port0/port1 に詰める(navigator配列中の位置には依存しない)', () => {
    const padHigh = makeGamepad({ index: 3 });
    const padLow = makeGamepad({ index: 1 });
    // 配列上は index 3 のパッドが先に来ていても、index の昇順で割り当てる。
    const ports = assignPorts([padHigh, padLow]);
    expect(ports.get(1)).toBe(0);
    expect(ports.get(3)).toBe(1);
  });

  it('3台目は未割当のまま(Mapにエントリが無い)', () => {
    const pad0 = makeGamepad({ index: 0 });
    const pad1 = makeGamepad({ index: 1 });
    const pad2 = makeGamepad({ index: 2 });
    const ports = assignPorts([pad0, pad1, pad2]);
    expect(ports.get(0)).toBe(0);
    expect(ports.get(1)).toBe(1);
    expect(ports.has(2)).toBe(false);
  });

  it('切断で詰め直る: index 0 が消えても残りは port0 から詰め直される', () => {
    const pad1 = makeGamepad({ index: 1 });
    const pad2 = makeGamepad({ index: 2 });
    // 直前まで index 0 が port0, index 1 が port1 だった状態から index 0 が切断された想定。
    const ports = assignPorts([null, pad1, pad2]);
    expect(ports.get(1)).toBe(0);
    expect(ports.get(2)).toBe(1);
    expect(ports.has(0)).toBe(false);
  });
});
