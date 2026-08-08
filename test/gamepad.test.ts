import { describe, expect, it } from 'vitest';
import {
  assignPorts,
  defaultProfileFor,
  DEFAULT_DEADZONE,
  detectNewlyActiveSource,
  GamepadManager,
  joyTargetsForPadType,
  loadGamepadStore,
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
