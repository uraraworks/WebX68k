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
 * TRG3..TRG8 は px68k-libretro が対応する多ボタンパッド(CPSF 等)向けの枠で、
 * Phase 1 では未使用(型だけ用意して後で埋める)。
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

/**
 * JoyTarget -> RetroPad ID(inputStateCb の id 引数、= libretro の RETRO_DEVICE_ID_JOYPAD_*)対応表。
 *
 * TRG1/TRG2 は px68k-libretro/libretro/joystick.c の Joystick_Update() に合わせてある
 * (Config.VbtnSwap 既定 false のとき、RetroPad B(id=0) -> JOY_TRG1, RetroPad A(id=8) -> JOY_TRG2)。
 * UP/DOWN/LEFT/RIGHT は同ファイルの D-Pad 判定(RETRO_DEVICE_ID_JOYPAD_UP=4 等)に合わせてある。
 * TRG3..TRG8 は現状 PAD_2BUTTON 固定では参照されない。将来 CPSF 等の多ボタン対応をする際に
 * 割り当て直す前提で、空いている RetroPad ボタン ID を仮に割り振ってあるだけの枠。
 */
export const TARGET_TO_RETRO_ID: Record<JoyTarget, number> = {
  UP: 4,
  DOWN: 5,
  LEFT: 6,
  RIGHT: 7,
  TRG1: 0, // RetroPad B
  TRG2: 8, // RetroPad A
  TRG3: 1, // RetroPad Y (未使用の枠)
  TRG4: 9, // RetroPad X (未使用の枠)
  TRG5: 10, // RetroPad L (未使用の枠)
  TRG6: 11, // RetroPad R (未使用の枠)
  TRG7: 12, // RetroPad L2 (未使用の枠)
  TRG8: 13, // RetroPad R2 (未使用の枠)
};

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

/**
 * Gamepad -> RetroPad ID ビットマスクへの変換器。
 *
 * ブラウザ無しでユニットテストできるよう、`navigator.getGamepads()` への依存は持たない。
 * 呼び出し側(main.ts)が毎フレーム取得した配列をそのまま `poll()` へ渡す形にしてある。
 */
export class GamepadManager {
  private readonly deadzone: number;
  // Source -> Binding[] の逆引き。1つの物理入力に複数割当が乗るケース(将来の編集UIで
  // 同じボタンに複数機能を足す等)を素直に扱うため、値は配列で持つ。
  private readonly bindings = new Map<string, Binding[]>();

  constructor(
    preset: ReadonlyArray<{ source: Source; binding: Binding }> = XINPUT_PRESET,
    deadzone: number = DEFAULT_DEADZONE,
  ) {
    this.deadzone = deadzone;
    for (const { source, binding } of preset) this.addBinding(source, binding);
  }

  /** Source に Binding を追加する(Phase 3 の編集UIから呼ぶ想定の口も兼ねる)。 */
  addBinding(source: Source, binding: Binding): void {
    const key = sourceKey(source);
    const list = this.bindings.get(key);
    if (list) list.push(binding);
    else this.bindings.set(key, [binding]);
  }

  /**
   * 接続中の Gamepad 配列(navigator.getGamepads() の戻り値そのまま)から、
   * port 0/1 ぶんの RetroPad ID ビットマスクを計算して返す。
   * 配列のインデックスがそのままポート番号になる(2台目以降は port 1 まで、それ以上は無視)。
   */
  poll(gamepads: readonly (Gamepad | null)[]): [number, number] {
    const result: [number, number] = [0, 0];
    for (let port = 0; port < 2; port++) {
      const pad = gamepads[port];
      if (!pad) continue;
      result[port] = this.computeBits(pad);
    }
    return result;
  }

  private computeBits(pad: Gamepad): number {
    let bits = 0;
    for (let index = 0; index < pad.buttons.length; index++) {
      if (!pad.buttons[index].pressed) continue;
      bits |= this.bitsFor({ kind: 'button', index });
    }
    for (let index = 0; index < pad.axes.length; index++) {
      const value = pad.axes[index];
      if (value <= -this.deadzone) bits |= this.bitsFor({ kind: 'axis', index, dir: -1 });
      if (value >= this.deadzone) bits |= this.bitsFor({ kind: 'axis', index, dir: 1 });
    }
    return bits;
  }

  private bitsFor(source: Source): number {
    const list = this.bindings.get(sourceKey(source));
    if (!list) return 0;
    let bits = 0;
    for (const binding of list) {
      if (binding.kind === 'joy') bits |= 1 << TARGET_TO_RETRO_ID[binding.target];
    }
    return bits;
  }
}
