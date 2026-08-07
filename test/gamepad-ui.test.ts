import { beforeAll, describe, expect, it } from 'vitest';

// strings.ts はモジュール初期化時に resolveLang() → location.search を参照するため、
// Node環境(vitest environment: 'node')には無い location をここで用意してから
// dynamic import する(fat-not-formatted.test.ts と同じ流儀)。gamepad-ui.ts は strings.ts を
// 静的importしているため、gamepad-ui.ts 自体も dynamic import にする必要がある。
let toDisplayIndex: (typeof import('../src/gamepad-ui.ts'))['toDisplayIndex'];
let sourceLabel: (typeof import('../src/gamepad-ui.ts'))['sourceLabel'];

beforeAll(async () => {
  if (typeof (globalThis as { location?: unknown }).location === 'undefined') {
    (globalThis as { location?: { search: string } }).location = { search: '' };
  }
  ({ toDisplayIndex, sourceLabel } = await import('../src/gamepad-ui.ts'));
  // 実行環境のnavigator.languageに依存せず文言を固定するため、明示的に日本語へ設定する。
  const { setLang } = await import('../src/strings.ts');
  setLang('ja');
});

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
