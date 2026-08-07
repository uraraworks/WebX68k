import { describe, expect, it } from 'vitest';
import { DEFAULT_DEADZONE, GamepadManager } from '../src/gamepad';

// libretro.h の RETRO_DEVICE_ID_JOYPAD_* / TARGET_TO_RETRO_ID(gamepad.ts)と対応する。
const RETRO_B = 0; // TRG1
const RETRO_A = 8; // TRG2
const RETRO_UP = 4;
const RETRO_DOWN = 5;
const RETRO_LEFT = 6;
const RETRO_RIGHT = 7;

/** テスト用の最小 Gamepad モック(標準マッピング準拠、17ボタン/4軸)。 */
function makeGamepad(opts: { buttons?: Record<number, boolean>; axes?: Record<number, number> } = {}): Gamepad {
  const buttons = Array.from({ length: 17 }, (_, i) => ({
    pressed: opts.buttons?.[i] ?? false,
    touched: false,
    value: opts.buttons?.[i] ? 1 : 0,
  }));
  const axes = [0, 0, 0, 0];
  for (const [k, v] of Object.entries(opts.axes ?? {})) axes[Number(k)] = v;
  return {
    id: 'mock',
    index: 0,
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
