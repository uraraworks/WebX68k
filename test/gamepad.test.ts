import { describe, expect, it } from 'vitest';
import {
  assignPorts,
  axisDeviationDir,
  defaultProfileFor,
  DEFAULT_DEADZONE,
  detectNewlyActiveSource,
  extractVendorProduct,
  GamepadManager,
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
    mgr.poll([makeGamepad({})]); // rest確定(axes[0]の静止値=0)。
    const justBelow = makeGamepad({ axes: { 0: DEFAULT_DEADZONE - 0.01 } });
    expect(mgr.poll([justBelow])[0]).toBe(0);
  });

  it('左スティックのデッドゾーン境界: デッドゾーンちょうど/超えは反応する(+方向 = RIGHT)', () => {
    const mgr = new GamepadManager();
    mgr.poll([makeGamepad({})]); // rest確定。
    const atThreshold = makeGamepad({ axes: { 0: DEFAULT_DEADZONE } });
    expect(mgr.poll([atThreshold])[0]).toBe(1 << RETRO_RIGHT);
    const beyond = makeGamepad({ axes: { 0: 0.9 } });
    expect(mgr.poll([beyond])[0]).toBe(1 << RETRO_RIGHT);
  });

  it('左スティックの負方向(axes[0] <= -デッドゾーン)は LEFT になる', () => {
    const mgr = new GamepadManager();
    mgr.poll([makeGamepad({})]); // rest確定。
    const pad = makeGamepad({ axes: { 0: -0.9 } });
    expect(mgr.poll([pad])[0]).toBe(1 << RETRO_LEFT);
  });

  it('axes[1] は上下(負=UP/正=DOWN)に対応する', () => {
    const mgr = new GamepadManager();
    mgr.poll([makeGamepad({})]); // rest確定。
    expect(mgr.poll([makeGamepad({ axes: { 1: -0.9 } })])[0]).toBe(1 << RETRO_UP);
    expect(mgr.poll([makeGamepad({ axes: { 1: 0.9 } })])[0]).toBe(1 << RETRO_DOWN);
  });

  it('D-Pad ボタンと左スティックは OR で合成される(同時押しでも1ビット)', () => {
    const mgr = new GamepadManager();
    mgr.poll([makeGamepad({})]); // rest確定。
    const pad = makeGamepad({ buttons: { 15: true }, axes: { 0: 0.9 } });
    const [bits0] = mgr.poll([pad]);
    expect(bits0).toBe(1 << RETRO_RIGHT);
  });

  it('D-Pad と左スティックを別方向で同時に入力すると両方のビットが立つ', () => {
    const mgr = new GamepadManager();
    mgr.poll([makeGamepad({})]); // rest確定。
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

// 実機(8BitDo M30/Micro、D-inputモード)で判明した事実への対応。
// 「軸の値0が静止」という暗黙の前提だと、未押下で-1.0を返すトリガ軸が永久に入力ありと
// 誤判定される(ライブ表示が光りっぱなしになり、割り当てれば固着する)。
// 軸ごとの静止値(rest、そのパッドを最初に観測したときの値)からの偏差で判定することを保証する。
describe('軸の静止値判定(実機トリガ軸-1.0/範囲外ハット軸3.29への対応)', () => {
  it('①静止値-1.0のトリガ軸(axisDeviationDir)は、静止したままなら「入力なし」と判定される', () => {
    // 8BitDo M30/Microのaxes[3]/axes[4]は未押下でも常に-1.0を返す(0が静止値ではない)。
    expect(axisDeviationDir(-1.0, -1.0, DEFAULT_DEADZONE)).toBeNull();
  });

  it('①相当: GamepadManager.bitsForPadでも静止値-1.0のトリガ軸バインディングは常時OFFのまま', () => {
    const mgr = new GamepadManager([], DEFAULT_DEADZONE);
    mgr.addBinding({ kind: 'axis', index: 3, dir: -1 }, { kind: 'joy', target: 'TRG1' });
    // axes[3]が常に-1.0のパッド(未押下トリガ)を複数フレームぶんポーリングしても発火しない。
    const stuckPad = makeGamepad({ axes: { 3: -1.0 } });
    expect(mgr.bitsForPad(stuckPad)).toBe(0);
    expect(mgr.bitsForPad(stuckPad)).toBe(0);
    expect(mgr.bitsForPad(stuckPad)).toBe(0);
  });

  it('②静止値から動いたら有効になる(axisDeviationDirは静止値+デッドゾーンを超えた側にだけ反応する)', () => {
    expect(axisDeviationDir(-1.0, -1.0, DEFAULT_DEADZONE)).toBeNull(); // 静止のまま
    expect(axisDeviationDir(-0.3, -1.0, DEFAULT_DEADZONE)).toBe(1); // 静止値-1.0から+0.7動いた(正方向)
    expect(axisDeviationDir(-0.6, -1.0, DEFAULT_DEADZONE)).toBeNull(); // +0.4しか動いていない(デッドゾーン未満)
  });

  it('②相当: GamepadManager.bitsForPadでも静止値記録後に動かせばビットが立つ', () => {
    const mgr = new GamepadManager([], DEFAULT_DEADZONE);
    mgr.addBinding({ kind: 'axis', index: 3, dir: 1 }, { kind: 'joy', target: 'TRG1' });
    mgr.bitsForPad(makeGamepad({ axes: { 3: -1.0 } })); // 初回観測で静止値-1.0を記録。
    expect(mgr.bitsForPad(makeGamepad({ axes: { 3: -1.0 } }))).toBe(0); // 静止のまま。
    expect(mgr.bitsForPad(makeGamepad({ axes: { 3: 0 } }))).toBe(1 << 0); // -1.0から+1.0動いた(正方向)。
  });

  it('③範囲外([-1,1]の外)の軸は無効として扱われる(isAxisValueValid/axisDeviationDir)', () => {
    // 8BitDo M30実機のaxes[9]は常に3.29、Microは1.29(いずれも範囲外)。
    expect(isAxisValueValid(3.29)).toBe(false);
    expect(isAxisValueValid(1.29)).toBe(false);
    expect(isAxisValueValid(1.0)).toBe(true);
    expect(isAxisValueValid(-1.0)).toBe(true);
    expect(axisDeviationDir(3.29, 0, DEFAULT_DEADZONE)).toBeNull();
    expect(axisDeviationDir(0, 3.29, DEFAULT_DEADZONE)).toBeNull(); // restが範囲外でも無効。
  });

  it('③相当: GamepadManager.bitsForPad/axisStateは範囲外の軸を常に無視する', () => {
    const mgr = new GamepadManager([], DEFAULT_DEADZONE);
    mgr.addBinding({ kind: 'axis', index: 9, dir: 1 }, { kind: 'joy', target: 'TRG1' });
    const hatPad = makeGamepad({ axes: { 9: 3.29 } });
    expect(mgr.bitsForPad(hatPad)).toBe(0);
    expect(mgr.axisState(hatPad, 9)).toEqual({ valid: false, active: null });
  });

  it('④検出(detectNewlyActiveSource)は静止時点で偏差のある軸を誤って拾わない', () => {
    // 検出開始時点(baseline)で既にaxes[3]が-1.0(静止値)であれば、そのまま変化が無い限り拾わない。
    const baseline = snapshotPad(makeGamepad({ axes: { 3: -1.0 } }));
    const stillStuck = snapshotPad(makeGamepad({ axes: { 3: -1.0 } }));
    expect(detectNewlyActiveSource(baseline, stillStuck, DEFAULT_DEADZONE)).toBeNull();
  });

  it('④相当: 検出開始後に実際に動かせばSourceを拾う(静止→動いたの変化を要求)', () => {
    const baseline = snapshotPad(makeGamepad({ axes: { 3: -1.0 } }));
    const moved = snapshotPad(makeGamepad({ axes: { 3: 0.2 } })); // -1.0から+1.2動いた。
    expect(detectNewlyActiveSource(baseline, moved, DEFAULT_DEADZONE)).toEqual({ kind: 'axis', index: 3, dir: 1 });
  });

  it('④相当: 範囲外の軸(3.29)は検出でも常に無視される', () => {
    const baseline = snapshotPad(makeGamepad({ axes: { 9: 3.29 } }));
    const stillOutOfRange = snapshotPad(makeGamepad({ axes: { 9: 3.29 } }));
    expect(detectNewlyActiveSource(baseline, stillOutOfRange, DEFAULT_DEADZONE)).toBeNull();
  });

  // 実機M30(D-inputモード)の静止値は厳密な0ではなく-0.00392(axes[0]/[1]/[2]/[5])。
  // 「0が静止値」という暗黙の前提が残っていないか(rest記録の仕組みが本当に効いているか)を、
  // その実測値そのもので確認する。
  it('⑤ 実機の静止値-0.00392(0ちょうどではない)でも静止したままなら「入力なし」と判定される', () => {
    const REST = -0.00392;
    expect(axisDeviationDir(REST, REST, DEFAULT_DEADZONE)).toBeNull();

    const mgr = new GamepadManager([], DEFAULT_DEADZONE);
    mgr.addBinding({ kind: 'axis', index: 0, dir: -1 }, { kind: 'joy', target: 'LEFT' });
    mgr.addBinding({ kind: 'axis', index: 0, dir: 1 }, { kind: 'joy', target: 'RIGHT' });
    const restingPad = makeGamepad({ axes: { 0: REST } });
    expect(mgr.bitsForPad(restingPad)).toBe(0); // 初回観測でRESTをrestとして記録。
    expect(mgr.bitsForPad(restingPad)).toBe(0); // 以後も静止したままなら常に0。
    // 実機の静止値から実際に倒すとちゃんと反応する(rest基準が生きていることの確認)。
    const movedPad = makeGamepad({ axes: { 0: -1.0 } });
    expect(mgr.bitsForPad(movedPad)).toBe(1 << 6); // LEFT = RetroPad ID 6。
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
