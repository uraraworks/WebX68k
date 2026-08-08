import { describe, expect, it } from 'vitest';
import {
  advanceAxisCalibration,
  assignPorts,
  axisDeviationDir,
  AXIS_CALIBRATION_QUANTUM,
  AXIS_CALIBRATION_SETTLE_FRAMES,
  defaultProfileFor,
  DEFAULT_DEADZONE,
  detectNewlyActiveSource,
  extractVendorProduct,
  GamepadManager,
  initAxisCalibration,
  isAxisValueValid,
  joyTargetsForPadType,
  knownPadPresetFor,
  loadGamepadStore,
  M30_CPSF_MD_PRESET,
  M30_STANDARD_PRESET,
  MICRO_CPSF_SFC_PRESET,
  MICRO_STANDARD_PRESET,
  type PadType,
  presetProfile,
  retroIdFor,
  saveGamepadStore,
  snapshotPad,
  type GamepadStore,
} from '../src/gamepad';
import { SharedKeyInput } from '../src/virtual-keyboard';

// libretro.h の RETRO_DEVICE_ID_JOYPAD_* / retroIdFor()(gamepad.ts、default=2ボタン)と対応する。
const RETRO_B = 0; // TRG1
const RETRO_A = 8; // TRG2
const RETRO_UP = 4;
const RETRO_DOWN = 5;
const RETRO_LEFT = 6;
const RETRO_RIGHT = 7;

/** テスト用の最小 Gamepad モック(既定は標準マッピング準拠、17ボタン/4軸)。 */
function makeGamepad(
  opts: {
    buttons?: Record<number, boolean>;
    axes?: Record<number, number>;
    index?: number;
    id?: string;
    mapping?: string;
    buttonCount?: number;
    axesCount?: number;
  } = {},
): Gamepad {
  const buttonCount = opts.buttonCount ?? 17;
  const axesCount = opts.axesCount ?? 4;
  const buttons = Array.from({ length: buttonCount }, (_, i) => ({
    pressed: opts.buttons?.[i] ?? false,
    touched: false,
    value: opts.buttons?.[i] ? 1 : 0,
  }));
  const axes = Array.from({ length: axesCount }, () => 0);
  for (const [k, v] of Object.entries(opts.axes ?? {})) axes[Number(k)] = v;
  return {
    id: opts.id ?? 'mock',
    index: opts.index ?? 0,
    connected: true,
    timestamp: 0,
    mapping: (opts.mapping ?? 'standard') as GamepadMappingType,
    buttons: buttons as unknown as readonly GamepadButton[],
    axes,
    hapticActuators: [],
    vibrationActuator: null as unknown as GamepadHapticActuator,
  } as Gamepad;
}

/**
 * 軸の較正(AxisCalibration、「離れてから確定」方式)を実機と同じ手順で完了させ、静止値を
 * restValue に確定させるテスト用ヘルパー。GamepadManager は「baseline(観測開始時点の値)から
 * 一度でも変化したら区間1として追跡を始め、区間1は確定させず、そこからさらに違う値(区間2)へ
 * 移って AXIS_CALIBRATION_SETTLE_FRAMES フレーム連続で滞在したら、その値を採用する」設計
 * (gamepad.ts の advanceAxisCalibration 参照)なので、
 *   1. baseline を restValue で観測(まだ区間を始めない)
 *   2. restValue と異なる値へ一度動かす(区間1が始まる。この区間は確定しない)
 *   3. restValue へ戻す(区間2が始まる)
 *   4. AXIS_CALIBRATION_SETTLE_FRAMES フレームぶん restValue に滞在させ、確定させる
 * という手順をそのまま踏む。
 */
function calibrateAxis(
  mgr: GamepadManager,
  axisIndex: number,
  restValue: number,
  padOpts: Omit<Parameters<typeof makeGamepad>[0], 'axes'> = {},
): void {
  mgr.bitsForPad(makeGamepad({ ...padOpts, axes: { [axisIndex]: restValue } })); // 1. baseline。
  const transient = restValue === 0 ? 1 : 0; // restValueと確実に異なる値。
  mgr.bitsForPad(makeGamepad({ ...padOpts, axes: { [axisIndex]: transient } })); // 2. 区間1(確定しない)。
  for (let i = 0; i < AXIS_CALIBRATION_SETTLE_FRAMES; i++) {
    mgr.bitsForPad(makeGamepad({ ...padOpts, axes: { [axisIndex]: restValue } })); // 3.+4. 区間2に滞在させ、確定させる。
  }
}

/**
 * axes[0..axesCount-1] を全て静止値0で較正完了させるヘルパー(通常のスティック向けテスト用)。
 * GamepadManager は1回の poll でその Gamepad が持つ全軸を同時に観測するため、calibrateAxis()を
 * 軸ごとに呼ぶ代わりにまとめて較正できる。
 */
function calibrateAllAxesAtZero(mgr: GamepadManager, axesCount = 4): void {
  const zero = makeGamepad({ axesCount });
  mgr.bitsForPad(zero); // 1. baseline(全軸0)。
  const moved = makeGamepad({ axesCount, axes: Object.fromEntries(Array.from({ length: axesCount }, (_, i) => [i, 1])) });
  mgr.bitsForPad(moved); // 2. 一度全軸を動かす(区間1、確定しない)。
  for (let i = 0; i < AXIS_CALIBRATION_SETTLE_FRAMES; i++) mgr.bitsForPad(zero); // 3.+4. 戻して滞在させ、確定させる。
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

  // 軸は「静止値(rest、そのパッドを最初に観測したときの値)からの偏差」で判定するため、
  // 以降のテストはまず axes 全て0(静止)の状態で1回 poll() して rest=0 を確定させてから、
  // 実際に動かした値で判定する(GamepadManagerインスタンスを使い回す)。
  it('左スティックのデッドゾーン境界: デッドゾーン以下は無反応', () => {
    const mgr = new GamepadManager();
    calibrateAllAxesAtZero(mgr); // 全軸を静止値0で較正完了させる。
    const justBelow = makeGamepad({ axes: { 0: DEFAULT_DEADZONE - 0.01 } });
    expect(mgr.poll([justBelow])[0]).toBe(0);
  });

  it('左スティックのデッドゾーン境界: デッドゾーンちょうど/超えは反応する(+方向 = RIGHT)', () => {
    const mgr = new GamepadManager();
    calibrateAllAxesAtZero(mgr); // 全軸を静止値0で較正完了させる。
    const atThreshold = makeGamepad({ axes: { 0: DEFAULT_DEADZONE } });
    expect(mgr.poll([atThreshold])[0]).toBe(1 << RETRO_RIGHT);
    const beyond = makeGamepad({ axes: { 0: 0.9 } });
    expect(mgr.poll([beyond])[0]).toBe(1 << RETRO_RIGHT);
  });

  it('左スティックの負方向(axes[0] <= -デッドゾーン)は LEFT になる', () => {
    const mgr = new GamepadManager();
    calibrateAllAxesAtZero(mgr); // 全軸を静止値0で較正完了させる。
    const pad = makeGamepad({ axes: { 0: -0.9 } });
    expect(mgr.poll([pad])[0]).toBe(1 << RETRO_LEFT);
  });

  it('axes[1] は上下(負=UP/正=DOWN)に対応する', () => {
    const mgr = new GamepadManager();
    calibrateAllAxesAtZero(mgr); // 全軸を静止値0で較正完了させる。
    expect(mgr.poll([makeGamepad({ axes: { 1: -0.9 } })])[0]).toBe(1 << RETRO_UP);
    expect(mgr.poll([makeGamepad({ axes: { 1: 0.9 } })])[0]).toBe(1 << RETRO_DOWN);
  });

  it('D-Pad ボタンと左スティックは OR で合成される(同時押しでも1ビット)', () => {
    const mgr = new GamepadManager();
    calibrateAllAxesAtZero(mgr); // 全軸を静止値0で較正完了させる。
    const pad = makeGamepad({ buttons: { 15: true }, axes: { 0: 0.9 } });
    const [bits0] = mgr.poll([pad]);
    expect(bits0).toBe(1 << RETRO_RIGHT);
  });

  it('D-Pad と左スティックを別方向で同時に入力すると両方のビットが立つ', () => {
    const mgr = new GamepadManager();
    calibrateAllAxesAtZero(mgr); // 全軸を静止値0で較正完了させる。
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

  it('手動指定(portPads)が接続中なら優先し、残りは自動で埋める', () => {
    const padA = makeGamepad({ index: 0 });
    const padB = makeGamepad({ index: 1 });
    // A(index0)はもともと自動ならport0だが、port1へ手動固定されているのでそちらへ。
    const ports = assignPorts([padA, padB], [null, 'mock']);
    // padA/padBはどちらもid='mock'なので、最初に見つかったpresent順(index昇順=padA)がport1に固定される。
    expect(ports.get(0)).toBe(1);
    expect(ports.get(1)).toBe(0);
  });

  it('手動指定されたidが未接続なら無視して自動割当のみで埋める', () => {
    const pad0 = makeGamepad({ index: 0 });
    const ports = assignPorts([pad0], ['not-connected', null]);
    expect(ports.get(0)).toBe(0);
  });
});

/** テスト用の簡易 Storage 実装(localStorageの代わりに渡す)。 */
class FakeStorage implements Pick<Storage, 'getItem' | 'setItem'> {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe('gamepad永続化(loadGamepadStore/saveGamepadStore)', () => {
  it('保存→読込のラウンドトリップ', () => {
    const storage = new FakeStorage();
    const store: GamepadStore = {
      version: 2,
      pads: { 'pad-a': presetProfile(0.3) },
      portPads: ['pad-a', null],
      joyType: ['default', 'default'],
    };
    saveGamepadStore(store, storage);
    const loaded = loadGamepadStore(storage);
    expect(loaded).toEqual(store);
  });

  it('未保存(初回)は空ストアを返す', () => {
    const storage = new FakeStorage();
    const loaded = loadGamepadStore(storage);
    expect(loaded).toEqual({ version: 2, pads: {}, portPads: [null, null], joyType: ['default', 'default'] });
  });

  it('壊れたJSONで例外を投げず既定へフォールバックする', () => {
    const storage = new FakeStorage();
    storage.setItem('webx68k.gamepad', '{not valid json');
    const loaded = loadGamepadStore(storage);
    expect(loaded).toEqual({ version: 2, pads: {}, portPads: [null, null], joyType: ['default', 'default'] });
  });

  it('未知バージョンのデータは既定へフォールバックする', () => {
    const storage = new FakeStorage();
    storage.setItem('webx68k.gamepad', JSON.stringify({ version: 99, pads: {}, portPads: [null, null] }));
    const loaded = loadGamepadStore(storage);
    expect(loaded).toEqual({ version: 2, pads: {}, portPads: [null, null], joyType: ['default', 'default'] });
  });

  it('構造が不正な保存データ(bindingsが配列でない等)でも既定へフォールバックする', () => {
    const storage = new FakeStorage();
    storage.setItem(
      'webx68k.gamepad',
      JSON.stringify({
        version: 2,
        pads: { 'pad-a': { deadzone: 0.5, bindings: 'oops' } },
        portPads: [null, null],
        joyType: ['default', 'default'],
      }),
    );
    const loaded = loadGamepadStore(storage);
    expect(loaded).toEqual({ version: 2, pads: {}, portPads: [null, null], joyType: ['default', 'default'] });
  });

  it('複数パッドのプロファイルが共存する(挿し替えても両方残る)', () => {
    const storage = new FakeStorage();
    const store: GamepadStore = {
      version: 2,
      pads: {
        'pad-a': presetProfile(0.5),
        'pad-b': { deadzone: 0.4, bindings: [{ source: { kind: 'button', index: 3 }, binding: { kind: 'joy', target: 'TRG1' } }] },
      },
      portPads: [null, null],
      joyType: ['default', 'default'],
    };
    saveGamepadStore(store, storage);
    const loaded = loadGamepadStore(storage);
    expect(Object.keys(loaded.pads).sort()).toEqual(['pad-a', 'pad-b']);
    expect(loaded.pads['pad-a']).toEqual(presetProfile(0.5));
    expect(loaded.pads['pad-b'].bindings).toHaveLength(1);
  });

  // v1(joyType追加前)保存データのマイグレーション回帰テスト。
  // 「未知バージョンは空ストアへ」の実装をそのまま流用すると、joyTypeを追加しただけのv1データまで
  // 一括で消してしまう(既存ユーザーの割当編集・ポート固定が消滅する)。v1は必ずpads/portPadsを
  // 保ったままv2へ移行すること。
  describe('v1(joyType追加前)からのマイグレーション', () => {
    it('v1データはpads/portPadsを保ったままjoyType(既定=default両方)を補ってv2として読み込まれる', () => {
      const storage = new FakeStorage();
      const v1 = {
        version: 1,
        pads: { 'pad-a': presetProfile(0.4) },
        portPads: ['pad-a', null],
      };
      storage.setItem('webx68k.gamepad', JSON.stringify(v1));
      const loaded = loadGamepadStore(storage);
      expect(loaded).toEqual({
        version: 2,
        pads: { 'pad-a': presetProfile(0.4) },
        portPads: ['pad-a', null],
        joyType: ['default', 'default'],
      });
    });

    it('v1データのpadsが構造不正なら(v2同様)空ストアへフォールバックする', () => {
      const storage = new FakeStorage();
      storage.setItem(
        'webx68k.gamepad',
        JSON.stringify({ version: 1, pads: { 'pad-a': { deadzone: 0.5, bindings: 'oops' } }, portPads: [null, null] }),
      );
      const loaded = loadGamepadStore(storage);
      expect(loaded).toEqual({ version: 2, pads: {}, portPads: [null, null], joyType: ['default', 'default'] });
    });
  });

  describe('joyType(パッド種別)の永続化ラウンドトリップ', () => {
    it('cpsf-md/cpsf-sfc を含む joyType を保存→読込できる', () => {
      const storage = new FakeStorage();
      const store: GamepadStore = {
        version: 2,
        pads: {},
        portPads: [null, null],
        joyType: ['cpsf-md', 'cpsf-sfc'],
      };
      saveGamepadStore(store, storage);
      expect(loadGamepadStore(storage)).toEqual(store);
    });

    it('joyTypeに不正な値が入っていれば全体を既定へフォールバックする', () => {
      const storage = new FakeStorage();
      storage.setItem(
        'webx68k.gamepad',
        JSON.stringify({ version: 2, pads: {}, portPads: [null, null], joyType: ['default', 'not-a-padtype'] }),
      );
      const loaded = loadGamepadStore(storage);
      expect(loaded).toEqual({ version: 2, pads: {}, portPads: [null, null], joyType: ['default', 'default'] });
    });
  });
});

describe('joyTargetsForPadType(パッド種別ごとの表示対象)', () => {
  it('default(2ボタン)はUP/DOWN/LEFT/RIGHT/TRG1/TRG2の6項目', () => {
    expect(joyTargetsForPadType('default')).toEqual(['UP', 'DOWN', 'LEFT', 'RIGHT', 'TRG1', 'TRG2']);
  });

  it('cpsf-md/cpsf-sfc(8ボタン)はTRG1..TRG8まで含む12項目', () => {
    const expected = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'TRG1', 'TRG2', 'TRG3', 'TRG4', 'TRG5', 'TRG6', 'TRG7', 'TRG8'];
    expect(joyTargetsForPadType('cpsf-md')).toEqual(expected);
    expect(joyTargetsForPadType('cpsf-sfc')).toEqual(expected);
  });
});

// TRG3..TRG8 と RetroPad ID の対応は px68k-libretro/libretro/joystick.c の Joystick_Update() から
// 確定させた値(推測ではない)。CPSF-MD は279〜312行目付近、CPSF-SFCは314〜342行目付近。
// RetroPad ID (libretro.h の retro_device_id_joypad): B=0, Y=1, SELECT=2, START=3, UP=4, DOWN=5,
// LEFT=6, RIGHT=7, A=8, X=9, L=10, R=11。
describe('retroIdFor(TRG3..TRG8 と RetroPad ID の対応、joystick.c 由来)', () => {
  it('cpsf-md: A(8)->TRG1, B(0)->TRG2, Y(1)->TRG3, X(9)->TRG4, L(10)->TRG5, Start(3)->TRG6, Select(2)->TRG7, R(11)->TRG8', () => {
    const padType: PadType = 'cpsf-md';
    expect(retroIdFor('TRG1', padType)).toBe(8);
    expect(retroIdFor('TRG2', padType)).toBe(0);
    expect(retroIdFor('TRG3', padType)).toBe(1);
    expect(retroIdFor('TRG4', padType)).toBe(9);
    expect(retroIdFor('TRG5', padType)).toBe(10);
    expect(retroIdFor('TRG6', padType)).toBe(3);
    expect(retroIdFor('TRG7', padType)).toBe(2);
    expect(retroIdFor('TRG8', padType)).toBe(11);
  });

  it('cpsf-sfc: B(0)->TRG1, A(8)->TRG2, X(9)->TRG3, Y(1)->TRG4, R(11)->TRG5, Start(3)->TRG6, Select(2)->TRG7, L(10)->TRG8', () => {
    const padType: PadType = 'cpsf-sfc';
    expect(retroIdFor('TRG1', padType)).toBe(0);
    expect(retroIdFor('TRG2', padType)).toBe(8);
    expect(retroIdFor('TRG3', padType)).toBe(9);
    expect(retroIdFor('TRG4', padType)).toBe(1);
    expect(retroIdFor('TRG5', padType)).toBe(11);
    expect(retroIdFor('TRG6', padType)).toBe(3);
    expect(retroIdFor('TRG7', padType)).toBe(2);
    expect(retroIdFor('TRG8', padType)).toBe(10);
  });

  it('default(2ボタン)はTRG1/TRG2のみ px68k-libretro が参照する(B(0)->TRG1, A(8)->TRG2)', () => {
    expect(retroIdFor('TRG1')).toBe(0);
    expect(retroIdFor('TRG2')).toBe(8);
  });

  it('UP/DOWN/LEFT/RIGHTはpadTypeによらず共通(D-Pad判定はPAD種別分岐の外)', () => {
    for (const padType of ['default', 'cpsf-md', 'cpsf-sfc'] as const) {
      expect(retroIdFor('UP', padType)).toBe(4);
      expect(retroIdFor('DOWN', padType)).toBe(5);
      expect(retroIdFor('LEFT', padType)).toBe(6);
      expect(retroIdFor('RIGHT', padType)).toBe(7);
    }
  });
});

describe('GamepadManager.bitsForPad(padType引数、CPSF-MD/SFCのTRG3..TRG8配線)', () => {
  it('cpsf-mdでTRG3(RetroPad Y=id1)に割り当てたボタンを押すと、TRG3のRetroPad ID(1)のビットが立つ', () => {
    const mgr = new GamepadManager([], 0.5);
    mgr.addBinding({ kind: 'button', index: 5 }, { kind: 'joy', target: 'TRG3' });
    const pad = makeGamepad({ buttons: { 5: true } });
    expect(mgr.bitsForPad(pad, 'cpsf-md')).toBe(1 << 1);
  });

  it('cpsf-mdとdefaultで同じTRG1バインディングでも異なるRetroPad IDになる(TRG1: cpsf-md=8, default=0)', () => {
    const mgr = new GamepadManager([], 0.5);
    mgr.addBinding({ kind: 'button', index: 0 }, { kind: 'joy', target: 'TRG1' });
    const pad = makeGamepad({ buttons: { 0: true } });
    expect(mgr.bitsForPad(pad, 'default')).toBe(1 << 0);
    expect(mgr.bitsForPad(pad, 'cpsf-md')).toBe(1 << 8);
  });

  it('poll()/pollByPort()もpadTypesを port ごとに渡せる', () => {
    const mgr = new GamepadManager([], 0.5);
    mgr.addBinding({ kind: 'button', index: 0 }, { kind: 'joy', target: 'TRG8' });
    const pad = makeGamepad({ buttons: { 0: true } });
    const [bits0] = mgr.poll([pad, null], ['cpsf-sfc', 'default']);
    expect(bits0).toBe(1 << 10); // cpsf-sfc: TRG8 -> RetroPad L(id10)
  });
});

describe('defaultProfileFor', () => {
  it('mapping===standard なら XINPUT_PRESET を既定にする', () => {
    const profile = defaultProfileFor({ mapping: 'standard' });
    expect(profile).toEqual(presetProfile());
  });

  it('standard 以外(non-standard)は全未割当で始める', () => {
    const profile = defaultProfileFor({ mapping: '' });
    expect(profile.bindings).toEqual([]);
  });
});

describe('detectNewlyActiveSource(検出モードの押下判定)', () => {
  it('押されていなかったボタンが押されたら、そのSourceを返す', () => {
    const pad = makeGamepad({ buttons: { 3: true } });
    const prev = snapshotPad(makeGamepad({}));
    const curr = snapshotPad(pad);
    expect(detectNewlyActiveSource(prev, curr, DEFAULT_DEADZONE)).toEqual({ kind: 'button', index: 3 });
  });

  it('押しっぱなしのボタン(prevで既に真)は誤検出しない', () => {
    const held = makeGamepad({ buttons: { 3: true } });
    const prev = snapshotPad(held);
    const curr = snapshotPad(held);
    expect(detectNewlyActiveSource(prev, curr, DEFAULT_DEADZONE)).toBeNull();
  });

  it('軸がデッドゾーンを超えた方向をdir込みで返す(正方向)', () => {
    const prev = snapshotPad(makeGamepad({}));
    const curr = snapshotPad(makeGamepad({ axes: { 0: 0.9 } }));
    expect(detectNewlyActiveSource(prev, curr, DEFAULT_DEADZONE)).toEqual({ kind: 'axis', index: 0, dir: 1 });
  });

  it('軸がデッドゾーンを超えた方向をdir込みで返す(負方向)', () => {
    const prev = snapshotPad(makeGamepad({}));
    const curr = snapshotPad(makeGamepad({ axes: { 1: -0.9 } }));
    expect(detectNewlyActiveSource(prev, curr, DEFAULT_DEADZONE)).toEqual({ kind: 'axis', index: 1, dir: -1 });
  });

  it('何も変化が無ければnull', () => {
    const pad = makeGamepad({ buttons: { 0: true }, axes: { 0: 0.8 } });
    const snap = snapshotPad(pad);
    expect(detectNewlyActiveSource(snap, snap, DEFAULT_DEADZONE)).toBeNull();
  });
});

describe('GamepadManager プロファイル往復・編集操作', () => {
  it('fromProfile/toProfileでラウンドトリップする', () => {
    const profile = presetProfile(0.4);
    const mgr = GamepadManager.fromProfile(profile);
    expect(mgr.getDeadzone()).toBe(0.4);
    expect(mgr.toProfile().bindings.length).toBe(profile.bindings.length);
  });

  it('addBinding/removeBindingで行のチップが増減する', () => {
    const mgr = new GamepadManager([], 0.5);
    const source = { kind: 'button' as const, index: 5 };
    mgr.addBinding(source, { kind: 'joy', target: 'TRG1' });
    expect(mgr.bindingsForTarget('TRG1')).toEqual([source]);
    mgr.removeBinding(source, { kind: 'joy', target: 'TRG1' });
    expect(mgr.bindingsForTarget('TRG1')).toEqual([]);
  });

  it('resetToPresetでXINPUT_PRESET相当に戻る', () => {
    const mgr = new GamepadManager([], 0.5);
    mgr.addBinding({ kind: 'button', index: 5 }, { kind: 'joy', target: 'TRG1' });
    mgr.resetToPreset();
    expect(mgr.bindingsForTarget('TRG1')).toEqual([{ kind: 'button', index: 0 }]);
  });

  it('bitsForPadは単一Gamepadに対してpoll()と同じ結果を返す', () => {
    const mgr = new GamepadManager();
    const pad = makeGamepad({ buttons: { 0: true } });
    expect(mgr.bitsForPad(pad)).toBe(mgr.poll([pad])[0]);
  });
});

// [検出]の置き換え動作(replaceTargetBinding)。既存の割当が残ったまま追加される不具合の修正対象。
describe('GamepadManager.replaceTargetBinding([検出]の置き換え動作)', () => {
  it('対象行に既存の割当があっても、検出後はその行のソースが1つだけになる', () => {
    const mgr = new GamepadManager([], 0.5);
    mgr.addBinding({ kind: 'button', index: 0 }, { kind: 'joy', target: 'TRG1' });
    mgr.addBinding({ kind: 'button', index: 1 }, { kind: 'joy', target: 'TRG1' });
    expect(mgr.bindingsForTarget('TRG1')).toEqual([
      { kind: 'button', index: 0 },
      { kind: 'button', index: 1 },
    ]);

    mgr.replaceTargetBinding({ kind: 'button', index: 2 }, 'TRG1');
    expect(mgr.bindingsForTarget('TRG1')).toEqual([{ kind: 'button', index: 2 }]);
  });

  // 二重割当バグの再現/修正確認。修正前は「検出で拾った source が他の target に持つ joy 割当」が
  // 残ってしまい、例えばボタン3を DOWN に割り当てた状態で UP の行を検出してボタン3を押すと
  // ボタン3が UP/DOWN 両方を押す状態になっていた。
  it('検出で拾った物理入力が別の行(target)に joy 割当を持っていた場合、その割当も外れる', () => {
    const mgr = new GamepadManager([], 0.5);
    const shared = { kind: 'button' as const, index: 3 };
    // button 3 が TRG1 と TRG2 の両方に割り当たっている状態を作る。
    mgr.addBinding(shared, { kind: 'joy', target: 'TRG1' });
    mgr.addBinding(shared, { kind: 'joy', target: 'TRG2' });
    mgr.addBinding({ kind: 'button', index: 0 }, { kind: 'joy', target: 'TRG1' });

    // TRG1 の行を button 3 で置き換える。「このボタンは TRG1」という宣言として扱われるべき。
    mgr.replaceTargetBinding(shared, 'TRG1');

    expect(mgr.bindingsForTarget('TRG1')).toEqual([shared]);
    // TRG2 側に残っていた同じ物理入力の割当は、二重押下を防ぐため外れる。
    expect(mgr.bindingsForTarget('TRG2')).toEqual([]);
  });

  it('別の物理入力に割り当たっている他の行(target)には触れない', () => {
    const mgr = new GamepadManager([], 0.5);
    const other = { kind: 'button' as const, index: 9 };
    mgr.addBinding(other, { kind: 'joy', target: 'TRG2' });
    mgr.addBinding({ kind: 'button', index: 0 }, { kind: 'joy', target: 'TRG1' });

    mgr.replaceTargetBinding({ kind: 'button', index: 2 }, 'TRG1');

    // button 9 -> TRG2 は無傷。
    expect(mgr.bindingsForTarget('TRG2')).toEqual([other]);
  });

  it('同じ物理入力への kind:key バインディングは巻き込まれない(joyとキーは別レイヤー)', () => {
    const mgr = new GamepadManager([], 0.5);
    const shared = { kind: 'button' as const, index: 4 };
    mgr.addBinding(shared, { kind: 'key', retrok: 97 });
    // shared がすでに別 target(TRG2) にも joy 割当を持っている状態も混ぜておく。
    mgr.addBinding(shared, { kind: 'joy', target: 'TRG2' });
    mgr.addBinding({ kind: 'button', index: 0 }, { kind: 'joy', target: 'TRG1' });

    mgr.replaceTargetBinding(shared, 'TRG1');

    expect(mgr.bindingsForTarget('TRG1')).toEqual([shared]);
    // joy側の他target割当(TRG2)は外れる。
    expect(mgr.bindingsForTarget('TRG2')).toEqual([]);
    // key割当は joy とは別レイヤーなので残る。
    const keyBindings = mgr
      .getAllBindings()
      .filter((e) => e.binding.kind === 'key')
      .map((e) => e.source);
    expect(keyBindings).toEqual([shared]);
  });

  it('コンボ(addBinding)からの追加は従来どおり件数が増える', () => {
    const mgr = new GamepadManager([], 0.5);
    mgr.addBinding({ kind: 'button', index: 0 }, { kind: 'joy', target: 'TRG1' });
    mgr.addBinding({ kind: 'button', index: 1 }, { kind: 'joy', target: 'TRG1' });
    expect(mgr.bindingsForTarget('TRG1').length).toBe(2);
  });
});

// kind:'key' バインディングの出力配線(main.ts の host.onPoll 経路が使う)。
// joy側(bitsForPad)とは独立に「今フレーム押されている retrok の集合」を返すことを確認する。
describe('GamepadManager.keysForPad(kind:key バインディングの出力)', () => {
  it('kind:key を割り当てたボタンが押されていればその retrok を含む集合を返す', () => {
    const mgr = new GamepadManager([], 0.5);
    mgr.addBinding({ kind: 'button', index: 5 }, { kind: 'key', retrok: 97 });
    expect(mgr.keysForPad(makeGamepad({ buttons: { 5: true } }))).toEqual(new Set([97]));
    expect(mgr.keysForPad(makeGamepad({ buttons: { 5: false } }))).toEqual(new Set());
  });

  it('joy割当とkey割当は独立に共存する(bitsForPadとkeysForPadが別々に効く)', () => {
    const mgr = new GamepadManager([], 0.5);
    mgr.addBinding({ kind: 'button', index: 0 }, { kind: 'joy', target: 'TRG1' });
    mgr.addBinding({ kind: 'button', index: 1 }, { kind: 'key', retrok: 122 });
    const pad = makeGamepad({ buttons: { 0: true, 1: true } });
    expect(mgr.bitsForPad(pad)).toBe(1 << RETRO_B);
    expect(mgr.keysForPad(pad)).toEqual(new Set([122]));
  });

  it('複数ボタンに割り当てたkeyは全て集合に含まれる', () => {
    const mgr = new GamepadManager([], 0.5);
    mgr.addBinding({ kind: 'button', index: 0 }, { kind: 'key', retrok: 97 });
    mgr.addBinding({ kind: 'button', index: 1 }, { kind: 'key', retrok: 98 });
    const pad = makeGamepad({ buttons: { 0: true, 1: true } });
    expect(mgr.keysForPad(pad)).toEqual(new Set([97, 98]));
  });
});

// main.ts の syncGamepadKeys()/releaseGamepadKeys() 相当のロジック(SharedKeyInputへの
// press/release差分配線と解放漏れ対策)。main.ts自体はDOM初期化を伴い直接importできないため、
// 実際に使うのと同じ2つの部品(GamepadManager.keysForPad + SharedKeyInput)を組み合わせて検証する。
describe('ゲームパッドkey割当のSharedKeyInput配線(main.tsのsyncGamepadKeys相当)', () => {
  /** main.ts の syncGamepadKeys() と同じ「前フレームとの差分だけpress/release」ロジック。 */
  function makeSync(input: SharedKeyInput, mgr: GamepadManager, source: string) {
    let prev = new Set<number>();
    return (pad: Gamepad | null) => {
      const next = pad ? mgr.keysForPad(pad) : new Set<number>();
      for (const k of next) if (!prev.has(k)) input.press(source, k);
      for (const k of prev) if (!next.has(k)) input.release(source, k);
      prev = next;
    };
  }

  it('①押下→保持→解放が press/release として1回ずつだけ出る(オートリピートしない)', () => {
    const events: Array<[number, boolean]> = [];
    const input = new SharedKeyInput((retrok, down) => events.push([retrok, down]));
    const mgr = new GamepadManager([], 0.5);
    mgr.addBinding({ kind: 'button', index: 0 }, { kind: 'key', retrok: 97 });
    const sync = makeSync(input, mgr, 'gamepad:0');

    sync(makeGamepad({ buttons: { 0: true } })); // press
    sync(makeGamepad({ buttons: { 0: true } })); // 押しっぱなし: 何も出ない
    sync(makeGamepad({ buttons: { 0: true } })); // 押しっぱなし: 何も出ない
    sync(makeGamepad({ buttons: { 0: false } })); // release

    expect(events).toEqual([[97, true], [97, false]]);
  });

  it('②同じretrokが物理キーボードとゲームパッドのkey割当の両方から来ても参照カウントで壊れない', () => {
    const events: Array<[number, boolean]> = [];
    const input = new SharedKeyInput((retrok, down) => events.push([retrok, down]));
    const mgr = new GamepadManager([], 0.5);
    mgr.addBinding({ kind: 'button', index: 0 }, { kind: 'key', retrok: 97 });
    const sync = makeSync(input, mgr, 'gamepad:0');

    input.press('physical:KeyA', 97); // 物理キーボードが先に押す
    sync(makeGamepad({ buttons: { 0: true } })); // ゲームパッド側でも同じキーが押される
    expect(events).toEqual([[97, true]]); // 既に押下中なので二重にpressは出ない

    sync(makeGamepad({ buttons: { 0: false } })); // ゲームパッドだけ離す
    expect(events).toEqual([[97, true]]); // 物理キーボードがまだ押しているので解放されない

    input.release('physical:KeyA', 97);
    expect(events).toEqual([[97, true], [97, false]]); // 最後の入力元が離れて初めて解放される
  });

  it('③解放漏れ対策: releaseSource(gamepad:N) でそのポート由来の押下だけをまとめて解放できる(切断/割当変更/編集時)', () => {
    const events: Array<[number, boolean]> = [];
    const input = new SharedKeyInput((retrok, down) => events.push([retrok, down]));
    const mgr = new GamepadManager([], 0.5);
    mgr.addBinding({ kind: 'button', index: 0 }, { kind: 'key', retrok: 97 });
    mgr.addBinding({ kind: 'button', index: 1 }, { kind: 'key', retrok: 98 });
    const sync = makeSync(input, mgr, 'gamepad:0');

    sync(makeGamepad({ buttons: { 0: true, 1: true } }));
    expect(events.filter(([, down]) => down)).toEqual(
      expect.arrayContaining([[97, true], [98, true]]),
    );

    // パッド切断/ポート割当変更/割当編集はいずれも「そのポートのsourceを丸ごと解放する」で
    // 塞ぐ(main.tsのreleaseGamepadKeys相当)。物理キーボード側の押下は無関係のsourceなので
    // 巻き込まれない。
    input.press('physical:KeyA', 97);
    input.releaseSource('gamepad:0');
    const releases = events.filter(([, down]) => !down);
    expect(releases).toEqual(expect.arrayContaining([[98, false]]));
    // 97は物理キーボードがまだ押しているので解放されていないはず。
    expect(releases.find(([retrok]) => retrok === 97)).toBeUndefined();
  });
});

// 実機(8BitDo M30、ユーザーがライブ表示を目視観測)で確定した事実(2026-08-08):
// トリガ軸(axes[3]/axes[4])は、そのトリガを一度も動かしていない間は 0.00 を報告し続け、
// 一度でも動かす(押す/離す)と、以後は真の静止値 -1.00 を報告するようになる。
// 「軸の値には最初から意味がある」という前提そのものが誤りで、「一度も動いていない軸の
// 値は無意味」というのが実機の挙動。
//
// これまでの4回の誤った修正(gamepad.ts 冒頭のコメント参照):
// 1回目=初回観測値をそのまま静止値に固定、2回目=既知パッドの静止値を-1.0に固定
// (knownAxisRestFor、削除済み)、3回目=数フレーム安定したら確定する方式
// (advanceAxisCalibration旧実装、削除済み)。ここまでは gamepad.ts 冒頭コメント参照。
//
// 4回目=「一度動かされてから固定長のウィンドウ(240フレーム≒4秒)ぶん、量子化した値ごとの
// 滞在フレーム数(dwell)を数え、期間終了時点で最も長く滞在した値を採用する」dwellベースの
// 多数決方式(advanceAxisCalibration の旧実装、削除済み)。実機(8BitDo M30)で、ページを
// 開いて十字キーの左を押して離すと、A1(axes[0])が静止値(-0.00)に戻っているのに青
// (アクティブ)のままになり、X68000側は「右」が点灯しっぱなしになる不具合が確認された
// (2026-08-08)。原因はウィンドウが「軸が最初に動いた瞬間」から機械的に締め切られるため、
// 押している時間がウィンドウの中で無視できない割合を占めると、離した後の滞在がまだそれに
// 追いつかないうちに締め切りが来て、多数決が押下値側に傾いたまま確定してしまうこと
// (下の「4回目の不具合の再現」で、修正前の実装がこの通り壊れることを確認済み)。
//
// 今回の設計(離れてから確定方式): 較正ウィンドウという「締め切り」自体を廃止する。
// 軸ごとに「較正済みか」を持ち、未較正の間は判定に一切使わない(常に非アクティブ)。
// baselineから一度でも値が変化したら、そこから「区間(segment)」の追跡を始める:
// 最初の区間(baselineを離れて最初にいる値)は、まだ押している最中の値かもしれないため、
// どれだけ長く滞在してもそれだけでは確定しない(4回目の不具合の直接の解決)。
// 2番目以降の区間(一度違う値に移ってから今の値に落ち着いた区間)に
// AXIS_CALIBRATION_SETTLE_FRAMES(目安1〜2秒)連続で滞在したら、そこで初めて静止値として
// 採用する。「一度離れてから戻ってきて落ち着いた値」だけを確定候補にすることで、
// 押しっぱなしの継続時間に関わらず安全側になる(gamepad.ts の advanceAxisCalibration 参照)。
describe('軸較正(AxisCalibration・離れてから確定方式): 実機で確認した「押した値のまま固着する」不具合への対応', () => {
  /** フレーム列(values)を initial からの状態へ順に適用し、最終状態を返す(純粋関数テスト用ヘルパー)。 */
  function runFrames(initial: ReturnType<typeof initAxisCalibration>, values: number[]): ReturnType<typeof initAxisCalibration> {
    return values.reduce((state, v) => advanceAxisCalibration(state, v), initial);
  }

  describe('advanceAxisCalibration(純粋関数): フレーム列を与えて較正結果を検証する', () => {
    it('baselineのまま値が変化しない間はいくら経っても較正されない(区間の追跡自体が始まらない)', () => {
      let state = initAxisCalibration(0.0);
      expect(state).toEqual({ calibrated: false, baseline: 0.0, hasMoved: false, segmentValue: 0, segmentFrames: 0, segments: 0 });
      state = runFrames(state, Array(10).fill(0.0));
      expect(state).toEqual({ calibrated: false, baseline: 0.0, hasMoved: false, segmentValue: 0, segmentFrames: 0, segments: 0 });
    });

    // (1) 実機の再現シナリオ。実機観測どおりの baseline(-0.004)から出発する。
    //
    // 実装上の注記: 旧dwell実装(4回目)は「離した後の滞在がウィンドウ内で押下時間の滞在を
    // 上回れば正しく較正できる」設計だったため、押下がごく短時間(要求仕様どおりの30フレーム)
    // だと、離した後の滞在(長時間)が240フレームのウィンドウ内で押下(30フレーム)を圧倒的に
    // 上回り、旧実装でも偶然正しく較正できてしまうことを確認した(=30フレームという値単体では
    // 4回目の不具合を再現できない)。実機で報告された症状(短い押下操作で発生)を単体テストで
    // 確実に再現するには、「離した後の滞在時間がウィンドウの締め切りに追いつく前に、押下側の
    // 滞在が多数決で優位に立つ」だけの押下フレーム数(=ウィンドウの半分である120フレームを
    // 超える程度)が要る。実機のボタン押下は最大でも「数十〜100フレーム程度」という旧実装の
    // 前提を踏まえ、その前提が破れる境界に近い 200 フレームで再現する(旧実装のコメントが
    // 「押しっぱなしは数十〜100フレーム程度」としていたにも関わらず、実機ではメニュー操作等で
    // これより長く十字キーを押し続けることは普通に起こりうる、という前提の誤りが真因)。
    it('(1) 実機の再現シナリオ: baseline(-0.004) → 左押下(-1.0)を200フレーム → 解放(-0.004)を長時間、で' +
      'rest≒-0.004に確定し、静止状態は非アクティブ・+方向(右)は立たない', () => {
      let state = initAxisCalibration(-0.004);
      state = runFrames(state, [-1.0]); // 押した瞬間: 区間1が始まる(この区間はどれだけ滞在しても確定しない)。
      state = runFrames(state, Array(199).fill(-1.0)); // 押しっぱなし、計200フレーム。
      expect(state.calibrated).toBe(false); // 区間1のまま(4回目の不具合ならここで誤確定していた域)。
      state = runFrames(state, Array(2000).fill(-0.004)); // 解放して長時間静止(区間2)。
      expect(state.calibrated).toBe(true);
      const rest = (state as { rest: number }).rest;
      expect(Math.abs(rest - -0.004)).toBeLessThan(AXIS_CALIBRATION_QUANTUM); // 量子化により rest≒-0.004(実際は0)。
      // 静止状態(-0.004)は非アクティブ、+方向(右)は立たない。
      expect(axisDeviationDir(-0.004, rest, DEFAULT_DEADZONE)).toBeNull();
    });

    // (2) 長押しシナリオ。要求仕様どおり600フレーム(10秒相当)保持しても確定しないこと、
    // 解放後にrest≒-0.004で確定することを確認する。
    it('(2) 長押しシナリオ: -1.0 を600フレーム(10秒相当)保持 → 解放(-0.004)、で' +
      '保持中は確定せず、解放後にrest≒-0.004で確定する', () => {
      let state = initAxisCalibration(0.0);
      state = runFrames(state, [-1.0]); // 区間1開始。
      const midHold = runFrames(state, Array(599).fill(-1.0)); // 計600フレーム保持。
      expect(midHold.calibrated).toBe(false); // 10秒保持しても区間1のままなので確定しない。
      state = runFrames(midHold, Array(2000).fill(-0.004)); // 解放して長時間静止(区間2)。
      expect(state.calibrated).toBe(true);
      const rest = (state as { rest: number }).rest;
      expect(Math.abs(rest - -0.004)).toBeLessThan(AXIS_CALIBRATION_QUANTUM);
    });

    // (3) 実機トリガのシナリオ(0.0は「一度も動かしていないトリガの偽の静止値」)。
    // 区間1(+1.0)から区間2(-1.0)へ移った瞬間から数えるため、区間1の長さ(60フレーム以上)には
    // 依存せず、区間2側だけがAXIS_CALIBRATION_SETTLE_FRAMES滞在すれば確定する。
    it('(3) 実機トリガのシナリオ: 0.0(未較正) → +1.0を60フレーム以上 → -1.0を長時間、で' +
      'rest=-1.0に確定し、静止で非アクティブになる', () => {
      let state = initAxisCalibration(0.0);
      state = runFrames(state, Array(65).fill(1.0)); // 区間1(+1.0、確定しない)。
      expect(state.calibrated).toBe(false);
      state = runFrames(state, Array(2000).fill(-1.0)); // 区間2(-1.0)へ移って長時間静止。
      expect(state).toEqual({ calibrated: true, rest: -1.0 });
      expect(axisDeviationDir(-1.0, (state as { rest: number }).rest, DEFAULT_DEADZONE)).toBeNull();
    });

    it('通常のスティック: 0.0長時間 → +1.0を数十フレーム → 0.0へ戻る、で rest=0(近傍)に確定する', () => {
      let state = initAxisCalibration(0.0);
      state = runFrames(state, Array(50).fill(0.0));
      state = runFrames(state, Array(40).fill(1.0)); // スティックを倒す(区間1、数十フレーム)。
      state = runFrames(state, Array(AXIS_CALIBRATION_SETTLE_FRAMES).fill(0.0)); // 中央へ戻して確定させる(区間2)。
      expect(state).toEqual({ calibrated: true, rest: 0 });
      expect(axisDeviationDir(0.0, (state as { rest: number }).rest, DEFAULT_DEADZONE)).toBeNull(); // 静止で非アクティブ。
    });

    it('通常のスティックの実測に近い静止値(厳密な0ではない -0.00392)でも量子化により rest=0へ丸まる', () => {
      let state = initAxisCalibration(-0.00392);
      state = runFrames(state, Array(50).fill(-0.00392));
      state = runFrames(state, Array(40).fill(1.0));
      state = runFrames(state, Array(AXIS_CALIBRATION_SETTLE_FRAMES).fill(-0.00392));
      expect(state).toEqual({ calibrated: true, rest: 0 });
    });

    // (4) 確定後は押しっぱなしでも rest を更新しない。
    it('(4) 較正済みなら二度と rest を更新しない(押しっぱなしを渡しても状態自体が変わらない)', () => {
      const calibrated = { calibrated: true as const, rest: 0 };
      expect(advanceAxisCalibration(calibrated, 0.9)).toBe(calibrated);
      expect(advanceAxisCalibration(calibrated, 0.9)).toBe(calibrated);
    });

    // (5) 一度も動かない軸は永久に未較正のまま。
    it('(5) 一度も動かない軸はいくらフレームが経っても較正されない(baselineをrestとして誤採用しない)', () => {
      let state = initAxisCalibration(0.0);
      state = runFrames(state, Array(1000).fill(0.0));
      expect(state.calibrated).toBe(false);
    });
  });

  it('GamepadManager: 値が0.0を返し続ける間(未押下トリガ)は非アクティブ(未較正)のまま', () => {
    const mgr = new GamepadManager([], DEFAULT_DEADZONE);
    mgr.addBinding({ kind: 'axis', index: 3, dir: -1 }, { kind: 'joy', target: 'TRG1' });
    const untouched = makeGamepad({ axes: { 3: 0.0 } });
    expect(mgr.bitsForPad(untouched)).toBe(0);
    expect(mgr.axisState(untouched, 3)).toEqual({ valid: true, calibrated: false, calibrating: false, active: null });
    // 何度ポーリングしても(=時間が経っても)勝手には較正されない(一度も動いていないため)。
    expect(mgr.bitsForPad(untouched)).toBe(0);
    expect(mgr.bitsForPad(untouched)).toBe(0);
    expect(mgr.axisState(untouched, 3)).toEqual({ valid: true, calibrated: false, calibrating: false, active: null });
  });

  // (3) の GamepadManager 版。この軸(3)には binding があるため、較正完了を待たずに暫定の
  // 静止値(baseline=観測開始時点の0.0)から入力を生成する(今回手当てした副作用の主対象)。
  // +1.0の間はTRG1(dir:1)がアクティブになり続け、-1.0側(dir:-1、無割当)は較正完了まで
  // 常に非アクティブのまま。静止値が最終的に-1.0へ確定した後も、-1.0そのものは
  // rest(-1.0)から見て偏差なし(非アクティブ)であり続ける。
  it('(3) GamepadManager: 実機トリガシナリオ(0.0観測開始→+1.0を押しっぱなし相当65フレーム→-1.0で長時間静止)で' +
    '静止値が-1.0に確定し、静止状態は非アクティブへ収束する(割当のある+1.0方向は較正中も暫定値で即アクティブ)', () => {
    const mgr = new GamepadManager([], DEFAULT_DEADZONE);
    mgr.addBinding({ kind: 'axis', index: 3, dir: 1 }, { kind: 'joy', target: 'TRG1' });

    // 観測開始: 0.0(未押下、未較正)。baselineと同値なのでON判定になってはいけない。
    expect(mgr.bitsForPad(makeGamepad({ axes: { 3: 0.0 } }))).toBe(0);

    // 押しっぱなし相当: +1.0を65フレーム(区間1)。dir:1(TRG1)には割当があるため、較正完了前でも
    // 暫定の静止値(baseline=0.0)からの偏差でずっとアクティブになる(今回の手当ての本体)。
    for (let i = 0; i < 65; i++) {
      expect(mgr.bitsForPad(makeGamepad({ axes: { 3: 1.0 } }))).toBe(1 << 0); // TRG1
    }

    // 解放: -1.0へ変化(区間2)。dir:-1には割当が無いため、区間2がAXIS_CALIBRATION_SETTLE_FRAMES
    // 分溜まるまでbitsは常に0のまま(今回の不具合=未割当のトリガ軸が較正前に誤ってONになる、は
    // こちらの経路で起きていた)。
    for (let i = 1; i < AXIS_CALIBRATION_SETTLE_FRAMES; i++) {
      expect(mgr.bitsForPad(makeGamepad({ axes: { 3: -1.0 } }))).toBe(0);
    }
    // 区間2が確定フレーム数に達した時点で較正完了。静止値が-1.0として確定し、非アクティブへ収束する(=ON固着しない)。
    const settled = makeGamepad({ axes: { 3: -1.0 } });
    expect(mgr.bitsForPad(settled)).toBe(0);
    expect(mgr.axisState(settled, 3)).toEqual({ valid: true, calibrated: true, calibrating: false, active: null });

    // 較正後、-1.0のまま何フレーム経っても固着しない(静止値が-1.0で固定されているため)。
    expect(mgr.bitsForPad(makeGamepad({ axes: { 3: -1.0 } }))).toBe(0);
    expect(mgr.bitsForPad(makeGamepad({ axes: { 3: -1.0 } }))).toBe(0);
  });

  // (2) の GamepadManager 版。区間1(押しっぱなし)がAXIS_CALIBRATION_SETTLE_FRAMESを大きく
  // 超えても確定しないことを、割当のある方向が暫定値でアクティブになり続ける挙動とあわせて確認する。
  it('(2) GamepadManager: 押しっぱなしがAXIS_CALIBRATION_SETTLE_FRAMESの何倍も続いても確定せず、' +
    '離した後の区間2で初めてrest=-1.0になる(割当のある+1.0方向は較正中も暫定値でアクティブになり続ける)', () => {
    const mgr = new GamepadManager([], DEFAULT_DEADZONE);
    mgr.addBinding({ kind: 'axis', index: 3, dir: 1 }, { kind: 'joy', target: 'TRG1' });
    expect(mgr.bitsForPad(makeGamepad({ axes: { 3: 0.0 } }))).toBe(0);
    for (let i = 0; i < AXIS_CALIBRATION_SETTLE_FRAMES * 4; i++) {
      // 押しっぱなし(確定フレーム数の4倍): 割当のある方向は暫定の静止値(baseline=0.0)基準でアクティブ。
      expect(mgr.bitsForPad(makeGamepad({ axes: { 3: 1.0 } }))).toBe(1 << 0); // TRG1
      // 区間1のままなので、この間ずっと較正は完了しない。
      expect(mgr.axisState(makeGamepad({ axes: { 3: 1.0 } }), 3).calibrated).toBe(false);
    }
    for (let i = 0; i < AXIS_CALIBRATION_SETTLE_FRAMES; i++) {
      mgr.bitsForPad(makeGamepad({ axes: { 3: -1.0 } }));
    }
    const settled = makeGamepad({ axes: { 3: -1.0 } });
    mgr.bitsForPad(settled);
    expect(mgr.axisState(settled, 3)).toEqual({ valid: true, calibrated: true, calibrating: false, active: null });
    // 押した瞬間(+1.0)はアクティブになる。静止値が誤って+1.0側に確定していないことの確認。
    expect(mgr.bitsForPad(makeGamepad({ axes: { 3: 1.0 } }))).toBe(1 << 0); // TRG1
  });

  it('較正後: +1.0へ振れたらアクティブ、静止値(-1.0)に戻れば非アクティブ', () => {
    const mgr = new GamepadManager([], DEFAULT_DEADZONE);
    mgr.addBinding({ kind: 'axis', index: 3, dir: 1 }, { kind: 'joy', target: 'TRG1' });
    calibrateAxis(mgr, 3, -1.0);
    expect(mgr.bitsForPad(makeGamepad({ axes: { 3: -1.0 } }))).toBe(0);
    expect(mgr.bitsForPad(makeGamepad({ axes: { 3: 1.0 } }))).toBe(1 << 0); // TRG1
    expect(mgr.bitsForPad(makeGamepad({ axes: { 3: -1.0 } }))).toBe(0);
  });

  // (4) の GamepadManager 版。
  it('(4) 押しっぱなし(較正後に値が変化せず振れたまま)でも静止値が追いつかず、アクティブのまま', () => {
    const mgr = new GamepadManager([], DEFAULT_DEADZONE);
    mgr.addBinding({ kind: 'axis', index: 0, dir: 1 }, { kind: 'joy', target: 'TRG1' });
    calibrateAxis(mgr, 0, 0); // 通常のスティック、静止値0で較正完了させる。
    const held = makeGamepad({ axes: { 0: 0.9 } });
    expect(mgr.bitsForPad(held)).toBe(1 << 0);
    // 何フレーム経っても静止値は0のまま更新されないので、押しっぱなしでもアクティブが続く。
    expect(mgr.bitsForPad(held)).toBe(1 << 0);
    expect(mgr.bitsForPad(held)).toBe(1 << 0);
  });

  it('通常のスティック(静止0.0、±1.0へ振れる)は較正完了後、従来どおりデッドゾーン判定で動く', () => {
    const mgr = new GamepadManager([], DEFAULT_DEADZONE);
    mgr.addBinding({ kind: 'axis', index: 0, dir: -1 }, { kind: 'joy', target: 'LEFT' });
    mgr.addBinding({ kind: 'axis', index: 0, dir: 1 }, { kind: 'joy', target: 'RIGHT' });
    calibrateAxis(mgr, 0, 0);
    expect(mgr.bitsForPad(makeGamepad({ axes: { 0: 0 } }))).toBe(0);
    expect(mgr.bitsForPad(makeGamepad({ axes: { 0: 0.9 } }))).toBe(1 << RETRO_RIGHT);
    expect(mgr.bitsForPad(makeGamepad({ axes: { 0: -0.9 } }))).toBe(1 << RETRO_LEFT);
  });

  // (5) の GamepadManager 版。
  it('(5) 初期状態から一度も動かない軸は、いくらポーリングしても勝手に較正されない(baselineをrestとして誤採用しない)', () => {
    const mgr = new GamepadManager([], DEFAULT_DEADZONE);
    const idle = makeGamepad({ axes: { 0: 0 } });
    for (let i = 0; i < 1000; i++) mgr.bitsForPad(idle);
    expect(mgr.axisState(idle, 0)).toEqual({ valid: true, calibrated: false, calibrating: false, active: null });
  });

  it('範囲外([-1,1]の外)の軸は較正されず常に無効(valid:false)のまま', () => {
    const mgr = new GamepadManager([], DEFAULT_DEADZONE);
    mgr.addBinding({ kind: 'axis', index: 9, dir: 1 }, { kind: 'joy', target: 'TRG1' });
    const hatPad = makeGamepad({ axes: { 9: 3.29 } }); // 8BitDo M30実機のaxes[9]は常に3.29(範囲外)。
    expect(mgr.bitsForPad(hatPad)).toBe(0);
    expect(mgr.axisState(hatPad, 9)).toEqual({ valid: false, calibrated: false, calibrating: false, active: null });
  });

  it('一度動かされてから区間2が確定するまでの間は calibrating:true(較正待ちと較正中を区別できる)', () => {
    const mgr = new GamepadManager([], DEFAULT_DEADZONE);
    const untouched = makeGamepad({ axes: { 3: 0.0 } });
    expect(mgr.axisState(untouched, 3)).toEqual({ valid: true, calibrated: false, calibrating: false, active: null });
    mgr.bitsForPad(makeGamepad({ axes: { 3: 1.0 } })); // 初めて動かす。
    expect(mgr.axisState(makeGamepad({ axes: { 3: 1.0 } }), 3)).toEqual({
      valid: true,
      calibrated: false,
      calibrating: true, // 「一度も動いていない」ではなく「較正中」。
      active: null,
    });
  });

  // (6) 割当のある軸が較正中も暫定静止値で入力を生成すること(2026-08-08 副作用手当ての回帰)。
  describe('(6) 較正中の暫定入力(2026-08-08 副作用手当て): 割当のある軸は較正完了前でもbaseline基準で入力を生成する', () => {
    it('割当のある軸は較正中でも入力を生成する(暫定静止値=初期観測値からの偏差で判定)', () => {
      const mgr = new GamepadManager([], DEFAULT_DEADZONE);
      mgr.addBinding({ kind: 'axis', index: 1, dir: -1 }, { kind: 'joy', target: 'UP' });
      // 観測開始: baseline=0.0として記録されるだけで、この時点ではまだ較正されない。
      expect(mgr.bitsForPad(makeGamepad({ axes: { 1: 0.0 } }))).toBe(0);
      expect(mgr.axisState(makeGamepad({ axes: { 1: 0.0 } }), 1).calibrated).toBe(false);
      // 十字キー相当を倒す(-1.0): 較正完了を待たず、baseline(0.0)からの偏差で
      // 即座にUPがアクティブになる(=今回手当てした主目的そのもの)。
      const pressed = makeGamepad({ axes: { 1: -1.0 } });
      expect(mgr.bitsForPad(pressed)).toBe(1 << RETRO_UP);
      // axisState()(ライブ表示用)は暫定判定を反映しない: 較正中は従来どおり active:null を返し、
      // 見た目は「較正中」のまま維持する(暫定値を使うのは実際の入力生成(bitsForPad)側だけ)。
      expect(mgr.axisState(pressed, 1)).toEqual({ valid: true, calibrated: false, calibrating: true, active: null });
    });

    it('割当のない軸は較正完了まで入力を生成しない(暫定値を使わない)', () => {
      const mgr = new GamepadManager([], DEFAULT_DEADZONE); // 何も割り当てない。
      expect(mgr.bitsForPad(makeGamepad({ axes: { 4: 0.0 } }))).toBe(0);
      // 動かしても(=hasMoved:trueになっても)割当が無いのでbitsは0のまま。
      for (let i = 0; i < 10; i++) {
        expect(mgr.bitsForPad(makeGamepad({ axes: { 4: -1.0 } }))).toBe(0);
      }
    });

    it('実機トリガのシナリオ(0.0長時間→+1.0を60フレーム以上→-1.0長時間)で、割当が無い場合は一度もアクティブにならない', () => {
      const mgr = new GamepadManager([], DEFAULT_DEADZONE); // トリガ軸(4)には何も割り当てない。
      for (let i = 0; i < 80; i++) {
        expect(mgr.bitsForPad(makeGamepad({ axes: { 4: 0.0 } }))).toBe(0); // 押す前: 長時間0.0。
      }
      for (let i = 0; i < 65; i++) {
        expect(mgr.bitsForPad(makeGamepad({ axes: { 4: 1.0 } }))).toBe(0); // 押しっぱなし65フレーム(60超)。
      }
      for (let i = 0; i < AXIS_CALIBRATION_SETTLE_FRAMES + 50; i++) {
        expect(mgr.bitsForPad(makeGamepad({ axes: { 4: -1.0 } }))).toBe(0); // 離した後、較正完了後も長時間0。
      }
      // 較正自体はbindingと無関係に進む(区間の追跡はaxisごとに独立)。値のみの確認。
      expect(mgr.axisState(makeGamepad({ axes: { 4: -1.0 } }), 4).calibrated).toBe(true);
    });

    // 旧dwell実装では、較正完了の判定(framesObserved>=ウィンドウ)が「今どの値を読んでいるか」
    // と無関係に(=押しっぱなしの最中でも)成立しうったため、「較正完了の境界フレームをまたいで
    // 別の値を押しっぱなしにしていても bits が途切れない」ことを確認する意味があった。
    // 新設計(離れてから確定方式)では、確定は常に「今まさに観測している値」がその区間で
    // AXIS_CALIBRATION_SETTLE_FRAMES 連続したときにしか起こらない。つまり確定した瞬間に
    // ポーリングしている値は、確定した rest そのものと必ず一致する(暫定判定の基準(baseline)と
    // 確定後の基準(rest)がその1フレームだけ食い違う、という状況が構造的に起こりえない)。
    // そのため、境界フレームをまたいで「別の値を押しっぱなし」にする形の再現は成立しない
    // (むしろ、境界フレームでの値は必ず確定値と同じになる)。この前提を直接検証する。
    it('較正が完了する境界フレームでは、そのとき観測している値が必ず確定した rest と一致する' +
      '(暫定判定と確定判定が食い違う瞬間が構造的に存在しないことの確認)', () => {
      const mgr = new GamepadManager([], DEFAULT_DEADZONE);
      mgr.addBinding({ kind: 'axis', index: 3, dir: 1 }, { kind: 'joy', target: 'TRG1' });
      expect(mgr.bitsForPad(makeGamepad({ axes: { 3: 0.0 } }))).toBe(0); // baseline確立。
      mgr.bitsForPad(makeGamepad({ axes: { 3: 1.0 } })); // 区間1(確定しない)。
      let calibratedAt = -1;
      for (let i = 0; i < AXIS_CALIBRATION_SETTLE_FRAMES + 5; i++) {
        const pad = makeGamepad({ axes: { 3: 0.0 } }); // 区間2、baselineへ戻って滞在。
        mgr.bitsForPad(pad);
        if (calibratedAt < 0 && mgr.axisState(pad, 3).calibrated) {
          calibratedAt = i;
          // 確定した瞬間、そのフレームで観測していた値(0.0)がそのまま rest として採用されている。
          expect(mgr.axisState(pad, 3)).toEqual({ valid: true, calibrated: true, calibrating: false, active: null });
        }
      }
      expect(calibratedAt).toBeGreaterThanOrEqual(0); // 実際に確定していること。
      // 押しっぱなし(1.0)へ戻れば、境界をまたいだ後も違和感なくアクティブになる(rest=baseline=0のため)。
      expect(mgr.bitsForPad(makeGamepad({ axes: { 3: 1.0 } }))).toBe(1 << 0); // TRG1
      // 較正完了後の静止値はbaselineどおり0(押しっぱなしが最終的なrestを乗っ取っていない)。
      expect(mgr.axisState(makeGamepad({ axes: { 3: 0.0 } }), 3).active).toBeNull();
    });
  });

  it('isAxisValueValid/axisDeviationDir(純粋関数)は較正とは独立に、範囲外の値・静止値からの偏差を判定する', () => {
    expect(isAxisValueValid(3.29)).toBe(false);
    expect(isAxisValueValid(1.29)).toBe(false);
    expect(isAxisValueValid(1.0)).toBe(true);
    expect(isAxisValueValid(-1.0)).toBe(true);
    expect(axisDeviationDir(-1.0, -1.0, DEFAULT_DEADZONE)).toBeNull(); // 静止のまま
    expect(axisDeviationDir(-0.3, -1.0, DEFAULT_DEADZONE)).toBe(1); // 静止値-1.0から+0.7動いた
    expect(axisDeviationDir(-0.6, -1.0, DEFAULT_DEADZONE)).toBeNull(); // +0.4はデッドゾーン未満
  });

  // 検出モード(gamepad-ui.tsのtickDetect)は「未較正の軸を検出対象にしない」ため、
  // detectNewlyActiveSource() は isAxisEligible で軸ごとに対象外を指定できる。
  describe('detectNewlyActiveSource: isAxisEligibleで未較正の軸を検出対象から除外できる', () => {
    it('isAxisEligible省略時は従来どおり全軸が対象', () => {
      const prev = snapshotPad(makeGamepad({}));
      const curr = snapshotPad(makeGamepad({ axes: { 0: 0.9 } }));
      expect(detectNewlyActiveSource(prev, curr, DEFAULT_DEADZONE)).toEqual({ kind: 'axis', index: 0, dir: 1 });
    });

    it('isAxisEligibleがfalseを返す軸は、デッドゾーンを超えて変化していても拾わない', () => {
      const prev = snapshotPad(makeGamepad({ axes: { 3: 0.0 } }));
      const curr = snapshotPad(makeGamepad({ axes: { 3: 1.0 } }));
      // axes[3](未較正のトリガ軸)は検出対象から除外する。
      expect(detectNewlyActiveSource(prev, curr, DEFAULT_DEADZONE, (i) => i !== 3)).toBeNull();
    });

    it('isAxisEligibleがfalseの軸を飛ばして、他の対象軸は通常どおり拾う', () => {
      const prev = snapshotPad(makeGamepad({ axes: { 0: 0.0, 3: 0.0 } }));
      const curr = snapshotPad(makeGamepad({ axes: { 0: 0.9, 3: 1.0 } }));
      expect(detectNewlyActiveSource(prev, curr, DEFAULT_DEADZONE, (i) => i !== 3)).toEqual({ kind: 'axis', index: 0, dir: 1 });
    });

    it('ボタンはisAxisEligibleの影響を受けない', () => {
      const prev = snapshotPad(makeGamepad({}));
      const curr = snapshotPad(makeGamepad({ buttons: { 3: true } }));
      expect(detectNewlyActiveSource(prev, curr, DEFAULT_DEADZONE, () => false)).toEqual({ kind: 'button', index: 3 });
    });
  });

  // window.__webx68kDebug.axes()(実機の軸挙動を観測するためのデバッグフック、main.ts)が使う
  // GamepadManager.describeAxes() の回帰テスト。原因調査用の計測手段であり、このフック自体が
  // 観測対象(axisCalib)を変えてしまっては測定にならないため、非破壊であることを最優先で担保する。
  describe('describeAxes(): 較正状態を非破壊で覗く(デバッグフック用)', () => {
    it('未観測の軸は記録を発生させずに calibrated:false, rest:null を返す', () => {
      const mgr = new GamepadManager([], DEFAULT_DEADZONE);
      const pad = makeGamepad({ axes: { 0: 0.3, 1: -1.0 } });

      const before = mgr.describeAxes(pad);
      expect(before).toEqual([
        { index: 0, value: 0.3, valid: true, calibrated: false, calibrating: false, rest: null, baseline: null, hasMoved: false, segments: null, segmentFrames: null, active: null },
        { index: 1, value: -1.0, valid: true, calibrated: false, calibrating: false, rest: null, baseline: null, hasMoved: false, segments: null, segmentFrames: null, active: null },
        { index: 2, value: 0, valid: true, calibrated: false, calibrating: false, rest: null, baseline: null, hasMoved: false, segments: null, segmentFrames: null, active: null },
        { index: 3, value: 0, valid: true, calibrated: false, calibrating: false, rest: null, baseline: null, hasMoved: false, segments: null, segmentFrames: null, active: null },
      ]);

      // 呼び出し自体が axisCalib への記録を引き起こしていないこと(何度呼んでも結果が変わらない)。
      expect(mgr.describeAxes(pad)).toEqual(before);

      // describeAxes() では記録されていないことを、実際に軸を使う axisState() で確認する:
      // axisState() は観測を行うため、初めて呼ぶとその値(-1.0)を baseline として記録し
      // (まだ較正はされない)、calibrated:false のまま active:null を返すはず。
      expect(mgr.axisState(pad, 1)).toEqual({ valid: true, calibrated: false, calibrating: false, active: null });
    });

    it('較正の途中(一度動いたが区間2が確定していない)の状態を、記録を変えずに読める', () => {
      const mgr = new GamepadManager([], DEFAULT_DEADZONE);
      mgr.bitsForPad(makeGamepad({ axes: { 0: 0.0 } })); // baseline観測。
      mgr.bitsForPad(makeGamepad({ axes: { 0: 1.0 } })); // 一度動かした(区間1、まだ較正未完了)。

      const result = mgr.describeAxes(makeGamepad({ axes: { 0: 1.0 } }));
      expect(result[0]).toEqual({
        index: 0,
        value: 1.0,
        valid: true,
        calibrated: false,
        calibrating: true,
        rest: null,
        baseline: 0.0,
        hasMoved: true,
        segments: 1,
        segmentFrames: 1,
        active: null,
      });
      // 覗いただけで状態が進行していないこと(再度呼んでも同じまま)。
      expect(mgr.describeAxes(makeGamepad({ axes: { 0: 1.0 } }))[0]).toEqual(result[0]);
    });

    it('較正済みの軸は calibrated:true と確定した rest を返し、記録は変えない', () => {
      const mgr = new GamepadManager([], DEFAULT_DEADZONE);
      calibrateAxis(mgr, 0, -0.2);

      const moved = makeGamepad({ axes: { 0: 0.6 } });
      const result = mgr.describeAxes(moved);
      expect(result[0]).toEqual({
        index: 0,
        value: 0.6,
        valid: true,
        calibrated: true,
        calibrating: false,
        rest: -0.2,
        baseline: null,
        hasMoved: true,
        segments: null,
        segmentFrames: null,
        active: 1,
      });

      // 覗いただけで rest が動かされていないこと(再度呼んでも同じ-0.2のまま)。
      expect(mgr.describeAxes(moved)[0].rest).toBe(-0.2);
      expect(mgr.axisState(moved, 0)).toEqual({ valid: true, calibrated: true, calibrating: false, active: 1 }); // 通常経路と結果が一致。
    });

    it('範囲外(ハット軸混入等)の軸は valid:false, calibrated:false, active:null を返す', () => {
      const mgr = new GamepadManager([], DEFAULT_DEADZONE);
      const pad = makeGamepad({ axes: { 0: 3.29 } }); // isAxisValueValid の範囲外([-1,1]外)。
      const result = mgr.describeAxes(pad);
      expect(result[0]).toEqual({
        index: 0,
        value: 3.29,
        valid: false,
        calibrated: false,
        calibrating: false,
        rest: null,
        baseline: null,
        hasMoved: false,
        segments: null,
        segmentFrames: null,
        active: null,
      });
    });
  });
});

// 8BitDo M30/Micro 用プリセット(Vendor/Product ID一致で選ばれる既定バインディング)。
// 値は実機で確認済みのボタンindex(内部0始まり)対応表そのもの(推測ではない)。
//
// 誤爆対策(2026-08-08発覚): 旧実装は gamepad.id に'Micro'を含むかどうか(大文字小文字無視)で
// 判定していたが、'Micro'は'Microsoft'の部分文字列のため 'Microsoft X-Box 360 pad' のような
// Xboxコントローラのidでも誤爆してMicro用プリセットが選ばれてしまっていた。
// 現在は Vendor/Product ID(gamepad.idに埋め込まれる `(Vendor: xxxx Product: yyyy)`)を
// 最優先で見る。実機値: M30=2dc8:0651, Micro=2dc8:9020(ゲームパッドチェックサイトで実測)。
const M30_ID = '8BitDo M30 gamepad (Vendor: 2dc8 Product: 0651)';
const MICRO_ID = '8BitDo Micro gamepad (Vendor: 2dc8 Product: 9020)';

describe('extractVendorProduct(gamepad.id からのVendor/Product抽出)', () => {
  it('Chromeが埋め込む "(Vendor: xxxx Product: yyyy)" 形式から小文字の vendor:product を取り出す', () => {
    expect(extractVendorProduct(M30_ID)).toBe('2dc8:0651');
    expect(extractVendorProduct(MICRO_ID)).toBe('2dc8:9020');
  });

  it('大文字小文字/桁の揺れを吸収する', () => {
    expect(extractVendorProduct('pad (VENDOR: 2DC8 PRODUCT: 0651)')).toBe('2dc8:0651');
  });

  it('Vendor/Productが含まれないidはnull', () => {
    expect(extractVendorProduct('Xbox Wireless Controller')).toBeNull();
    expect(extractVendorProduct('Microsoft X-Box 360 pad')).toBeNull();
  });

  // 2026-08-08 再調査時に追加: Firefoxはgamepad.idを "vendorID-productID-name" 形式
  // (例: "2dc8-0651-8BitDo M30 gamepad")で報告する。Chrome前提の "(Vendor: .. Product: ..)"
  // 正規表現だけだと、Firefoxでは既知パッド判定(knownPadKindFor/knownAxisRestFor)が
  // vendor/productを取れず、常に文字列フォールバックだけに頼ることになる
  // (Microは'Microsoft'誤爆を避けるためvendor/product必須にしてあるため、Firefoxでは
  // Microを一切既知パッドとして認識できなくなってしまう)。この形式にも対応させてある。
  it('Firefox形式("vendorID-productID-name")からも vendor:product を取り出す', () => {
    expect(extractVendorProduct('2dc8-0651-8BitDo M30 gamepad')).toBe('2dc8:0651');
    expect(extractVendorProduct('2dc8-9020-8BitDo Micro gamepad')).toBe('2dc8:9020');
    expect(extractVendorProduct('2DC8-0651-8BitDo M30 gamepad')).toBe('2dc8:0651'); // 大文字小文字を吸収。
  });
});

describe('knownPadPresetFor(8BitDo M30/MicroのVendor/Product一致プリセット)', () => {
  it('⑤ Vendor/Product一致するM30パッドはpadType===defaultでM30_STANDARD_PRESETが選ばれる(A→TRG1,B→TRG2)', () => {
    expect(knownPadPresetFor(M30_ID, 'default')).toBe(M30_STANDARD_PRESET);
  });

  it('⑤ idの大文字小文字は問わない(フォールバック文字列マッチ相当)', () => {
    expect(knownPadPresetFor('8BitDo M30 gamepad', 'default')).toBe(M30_STANDARD_PRESET); // Vendor/Product無し、'm30'部分一致フォールバック。
    expect(knownPadPresetFor('8BITDO M30 GAMEPAD', 'default')).toBe(M30_STANDARD_PRESET);
  });

  it('⑤ Vendor/Product一致するM30パッドはpadType===cpsf-mdでM30_CPSF_MD_PRESETが選ばれる', () => {
    const preset = knownPadPresetFor(M30_ID, 'cpsf-md');
    expect(preset).toBe(M30_CPSF_MD_PRESET);
    // 方向: axes[0]-/+→左右, axes[1]-/+→上下(両パッド共通)。
    expect(preset).toContainEqual({ source: { kind: 'axis', index: 0, dir: -1 }, binding: { kind: 'joy', target: 'LEFT' } });
    expect(preset).toContainEqual({ source: { kind: 'axis', index: 1, dir: 1 }, binding: { kind: 'joy', target: 'DOWN' } });
    // A(0)→TRG1, B(1)→TRG2, Y(4)→TRG3, X(3)→TRG4, Z(6)→TRG5, +(11)→TRG6, -(10)→TRG7, C(7)→TRG8。
    expect(preset).toContainEqual({ source: { kind: 'button', index: 0 }, binding: { kind: 'joy', target: 'TRG1' } });
    expect(preset).toContainEqual({ source: { kind: 'button', index: 1 }, binding: { kind: 'joy', target: 'TRG2' } });
    expect(preset).toContainEqual({ source: { kind: 'button', index: 4 }, binding: { kind: 'joy', target: 'TRG3' } });
    expect(preset).toContainEqual({ source: { kind: 'button', index: 3 }, binding: { kind: 'joy', target: 'TRG4' } });
    expect(preset).toContainEqual({ source: { kind: 'button', index: 6 }, binding: { kind: 'joy', target: 'TRG5' } });
    expect(preset).toContainEqual({ source: { kind: 'button', index: 11 }, binding: { kind: 'joy', target: 'TRG6' } });
    expect(preset).toContainEqual({ source: { kind: 'button', index: 10 }, binding: { kind: 'joy', target: 'TRG7' } });
    expect(preset).toContainEqual({ source: { kind: 'button', index: 7 }, binding: { kind: 'joy', target: 'TRG8' } });
  });

  it('⑤ Vendor/Product一致するMicroパッドはpadType===defaultでMICRO_STANDARD_PRESETが選ばれる(A→TRG1,B→TRG2)', () => {
    expect(knownPadPresetFor(MICRO_ID, 'default')).toBe(MICRO_STANDARD_PRESET);
    expect(knownPadPresetFor(MICRO_ID.toUpperCase(), 'default')).toBe(MICRO_STANDARD_PRESET); // 大文字小文字無視。
  });

  it('⑤ Vendor/Product一致するMicroパッドはpadType===cpsf-sfcでMICRO_CPSF_SFC_PRESETが選ばれる', () => {
    const preset = knownPadPresetFor(MICRO_ID, 'cpsf-sfc');
    expect(preset).toBe(MICRO_CPSF_SFC_PRESET);
    // B(1)→TRG1, A(0)→TRG2, X(3)→TRG3, Y(4)→TRG4, R(7)→TRG5, +(11)→TRG6, -(10)→TRG7, L(6)→TRG8。
    expect(preset).toContainEqual({ source: { kind: 'button', index: 1 }, binding: { kind: 'joy', target: 'TRG1' } });
    expect(preset).toContainEqual({ source: { kind: 'button', index: 0 }, binding: { kind: 'joy', target: 'TRG2' } });
    expect(preset).toContainEqual({ source: { kind: 'button', index: 3 }, binding: { kind: 'joy', target: 'TRG3' } });
    expect(preset).toContainEqual({ source: { kind: 'button', index: 4 }, binding: { kind: 'joy', target: 'TRG4' } });
    expect(preset).toContainEqual({ source: { kind: 'button', index: 7 }, binding: { kind: 'joy', target: 'TRG5' } });
    expect(preset).toContainEqual({ source: { kind: 'button', index: 11 }, binding: { kind: 'joy', target: 'TRG6' } });
    expect(preset).toContainEqual({ source: { kind: 'button', index: 10 }, binding: { kind: 'joy', target: 'TRG7' } });
    expect(preset).toContainEqual({ source: { kind: 'button', index: 6 }, binding: { kind: 'joy', target: 'TRG8' } });
  });

  it('未知のパッドidはnull(呼び出し側がmapping===standardか否かでフォールバックする)', () => {
    expect(knownPadPresetFor('Xbox Wireless Controller', 'default')).toBeNull();
    expect(knownPadPresetFor('Xbox Wireless Controller', 'cpsf-md')).toBeNull();
  });

  // 誤爆回帰テスト(2026-08-08): 'Micro'は'Microsoft'の部分文字列のため、旧実装(部分一致judge)は
  // Xboxコントローラ等のidでMicro用プリセットを誤って選んでいた。Vendor/Product不一致であれば
  // 'Micro'という文字列が含まれていても選ばれてはならない。
  it('⑥ "Microsoft X-Box 360 pad" のようなidはMicroプリセットを誤爆しない(Vendor/Product不一致)', () => {
    expect(knownPadPresetFor('Microsoft X-Box 360 pad (Vendor: 045e Product: 028e)', 'default')).toBeNull();
    expect(knownPadPresetFor('Microsoft X-Box 360 pad (Vendor: 045e Product: 028e)', 'cpsf-sfc')).toBeNull();
    expect(knownPadPresetFor('Microsoft X-Box 360 pad', 'default')).toBeNull(); // Vendor/Product無しでも'micro'部分一致は使わない。
  });

  it('⑥ Vendor/Productが未知のペアなら文字列フォールバックへ落とさない(誤爆防止を優先)', () => {
    // 'micro'を含むが実機のVendor/Productと異なる架空のidは、フォールバックで拾わずnullのまま。
    expect(knownPadPresetFor('Some Micro Pad (Vendor: 1234 Product: 5678)', 'default')).toBeNull();
  });

  it('defaultProfileFor: id一致すればmapping===standardでなくても既知プリセットが適用される', () => {
    // 実機M30/Microはstandard申告でない可能性が高い(mapping===''でも既定が全未割当にならないことを確認)。
    const profile = defaultProfileFor({ mapping: '', id: '8BitDo M30 gamepad' }, 'default');
    expect(profile.bindings.length).toBeGreaterThan(0);
    expect(profile.bindings).toContainEqual({ source: { kind: 'button', index: 0 }, binding: { kind: 'joy', target: 'TRG1' } });
  });

  it('defaultProfileFor: id未指定/不一致は従来どおり(standardならXINPUT_PRESET、それ以外は全未割当)', () => {
    expect(defaultProfileFor({ mapping: 'standard' })).toEqual(presetProfile());
    expect(defaultProfileFor({ mapping: '', id: 'Xbox Wireless Controller' }).bindings).toEqual([]);
  });
});

// main.tsのmanagerForPad()相当: 「gamepadStore.pads[pad.id] ?? defaultProfileFor(pad, padType)」の
// 順序を保証する回帰テスト。パッド種別変更やM30/Microプリセット追加で、ユーザーが既に手で
// 編集したプロファイルを勝手に上書きしてしまわないことを確認する(main.ts自体はDOM初期化を
// 伴い直接importできないため、同じロジックをここで再現する)。
describe('手編集済みプロファイルの保護(main.tsのmanagerForPad相当ロジック)', () => {
  function resolveProfileLikeMain(store: GamepadStore, padId: string, padType: PadType, mapping: string) {
    return store.pads[padId] ?? defaultProfileFor({ mapping, id: padId }, padType);
  }

  it('⑥ 保存済みプロファイルがあれば、id一致するM30プリセットより優先される(勝手に上書きしない)', () => {
    const customProfile = {
      deadzone: 0.3,
      bindings: [{ source: { kind: 'button' as const, index: 5 }, binding: { kind: 'joy' as const, target: 'TRG1' as const } }],
    };
    const store: GamepadStore = {
      version: 2,
      pads: { '8BitDo M30 gamepad': customProfile },
      portPads: [null, null],
      joyType: ['default', 'default'],
    };
    const resolved = resolveProfileLikeMain(store, '8BitDo M30 gamepad', 'default', '');
    expect(resolved).toEqual(customProfile); // M30_STANDARD_PRESETではなく手編集の内容のまま。
  });

  it('⑥ 保存済みプロファイルが無いパッドは初回のみ既定プリセットで初期化される', () => {
    const store: GamepadStore = { version: 2, pads: {}, portPads: [null, null], joyType: ['cpsf-md', 'default'] };
    const resolved = resolveProfileLikeMain(store, '8BitDo M30 gamepad', 'cpsf-md', '');
    expect(resolved.bindings).toEqual(M30_CPSF_MD_PRESET.map((e) => ({ source: e.source, binding: e.binding })));
  });

  it('⑥ [既定に戻す]相当の明示リセットは、手編集済みでもその時点でプリセットへ置き換わる(意図的操作のみ許可)', () => {
    const mgr = new GamepadManager([], 0.5);
    mgr.addBinding({ kind: 'button', index: 5 }, { kind: 'joy', target: 'TRG1' }); // 手編集。
    mgr.resetToPreset(M30_STANDARD_PRESET); // ユーザーが明示的に[既定に戻す]を押した想定。
    expect(mgr.bindingsForTarget('TRG1')).toEqual([{ kind: 'button', index: 0 }]); // M30のA(0)。
  });
});

// 実機M30(buttons 16個/axes 10個)はこれまでのテストの前提(17ボタン/4軸)と異なる。
// M30_CPSF_MD_PRESETはTRG3..TRG8にbuttons index 6/7/10/11を、TRG1/TRG2にDPAD_AXIS_BINDINGS経由で
// axes 0/1を参照するため、実機と同じ本数(16ボタン/10軸)でも参照indexが配列長を超えて
// 例外を投げたり誤動作したりしないことを確認する。
describe('実機と同じボタン/軸本数(16ボタン/10軸)での安定動作', () => {
  it('16ボタン/10軸のGamepadでもbitsForPad/pollが例外を投げず正しく動く(M30_CPSF_MD_PRESET)', () => {
    const mgr = new GamepadManager(M30_CPSF_MD_PRESET, DEFAULT_DEADZONE);
    const pad = makeGamepad({ id: M30_ID, buttonCount: 16, axesCount: 10, buttons: { 0: true } }); // A→TRG1
    expect(() => mgr.bitsForPad(pad, 'cpsf-md')).not.toThrow();
    expect(mgr.bitsForPad(pad, 'cpsf-md')).toBe(1 << 8); // TRG1(cpsf-md)= RetroPad A(id8)。
    expect(() => mgr.poll([pad])).not.toThrow();
  });

  it('16ボタン/10軸のGamepadでもXINPUT_PRESET(既定)のbitsForPadが例外を投げない(未押下なら0)', () => {
    const mgr = new GamepadManager(); // 既定=XINPUT_PRESET(buttons[12..15]等を参照)。
    const pad = makeGamepad({ buttonCount: 16, axesCount: 10 });
    expect(() => mgr.bitsForPad(pad)).not.toThrow();
    expect(mgr.bitsForPad(pad)).toBe(0);
  });
});
