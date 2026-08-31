// px68k-libretro のコアオプション(host.setCoreOption()に渡すキー・値)を1箇所から導出する。
//
// 発端(2026-08-31、コーディネータ指摘): ワーカー移行の途中まで、既定経路(src/main.ts の
// bootCore())は host.setCoreOption() を個別に7回呼び、Worker経路(bootWorkerCore())は
// options を一切渡していなかった(=常にコア側の既定値のまま起動していた)。修正で
// bootWorkerCore() 側にオプション一式を渡すようにしたが、その値を bootCore() 側の
// 個別呼び出しと「同じ文字列のつもりで書き写す」形にすると、今後どちらか片方だけを
// 直し忘れて再び食い違う(=Worker経路だけ違うCPU速度/RAM構成で走る)事故を防げない。
// ここに1つの関数として切り出し、bootCore()・bootWorkerCore() の両方がこれを呼ぶことで、
// 値の一致を構造的に保証する(単体テスト test/core-options.test.ts が退行検知の要)。
//
// 実際に食い違っていた実例(px68k-libretro/libretro_core_options.h と突き合わせて確認):
// - px68k_cpuspeed: コア側の既定値は "10Mhz"。WebX68k側の既定値(DEFAULT_CPU_SPEED)は
//   "16Mhz"。Worker経路はoptionsを渡していなかったため、コア既定の10Mhzで走っていた
//   (=既定経路の16Mhzと食い違っていた)。
// - px68k_ramsize: コア既定"2MB"、WebX68k既定(DEFAULT_RAM_SIZE)も"2MB"で一致していた
//   (たまたま食い違っていなかった)。
// - px68k_joytype1/2: コア既定"Default (2 Buttons)"、WebX68k既定(gamepadStore.joyType=
//   'default' → PAD_TYPE_CORE_OPTION_VALUE.default = "Default (2 Buttons)")も一致していた
//   (たまたま食い違っていなかった)。
// 詳細と過去の実測への影響はdocs/STORAGE-SCSI.md「ワーカー移行 手順9」参照。

export interface CoreOptionsInput {
  /** px68k_cpuspeed の値(例: "16Mhz")。src/main.ts の cpuSpeed(設定ダイアログの選択値)。 */
  cpuSpeed: string;
  /** px68k_ramsize の値(例: "2MB")。src/main.ts の ramSize。 */
  ramSize: string;
  /** px68k_joytype1 の値。PAD_TYPE_CORE_OPTION_VALUE[gamepadStore.joyType[0]]。 */
  joyType1CoreValue: string;
  /** px68k_joytype2 の値。PAD_TYPE_CORE_OPTION_VALUE[gamepadStore.joyType[1]]。 */
  joyType2CoreValue: string;
}

/**
 * 既定経路・Worker経路の両方が起動時に適用するコアオプション一式を返す。
 * キーの並びはbootCore()の個別呼び出し順(px68k_cpuspeed → px68k_ramsize →
 * px68k_save_hdd_path → px68k_joy_mouse → px68k_no_wait_mode → px68k_joytype1 →
 * px68k_joytype2)と揃えてある(意味のある順序ではないが、diffを読みやすくするため)。
 */
export function buildCoreOptions(input: CoreOptionsInput): Record<string, string> {
  return {
    px68k_cpuspeed: input.cpuSpeed,
    px68k_ramsize: input.ramSize,
    // HDD0 の永続化(config読込)を有効化。既定経路のbootCore()コメント参照。
    px68k_save_hdd_path: 'enabled',
    // マウスを有効化する。MouseSWが立っていないとMouse_Event()が丸ごと無視される。
    px68k_joy_mouse: 'Mouse',
    // 速度倍率ボタン(既定経路のloop()・Worker経路のtick()双方)を機能させるために必須。
    // 既定経路のbootCore()コメント(Timer_GetCount()の短絡)参照。
    px68k_no_wait_mode: 'enabled',
    px68k_joytype1: input.joyType1CoreValue,
    px68k_joytype2: input.joyType2CoreValue,
  };
}
