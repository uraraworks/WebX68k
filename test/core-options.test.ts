// src/core-options.ts のテスト。
//
// 発端(2026-08-31、コーディネータ指摘): Worker経路は起動時にコアオプションを一切
// 渡していなかったため、コア既定値(px68k-libretro/libretro_core_options.h)のまま
// 動いていた。px68k_cpuspeedはコア既定"10Mhz"・WebX68k既定"16Mhz"で食い違っており、
// Worker経路だけ既定経路と違うCPU速度で走っていた実績がある。修正後は
// src/main.ts の bootCore()(既定経路)・bootWorkerCore()(Worker経路)の両方が
// buildCoreOptions() を通して値を取るようにしたので、ここでは
// (1) WebX68kの既定値(DEFAULT_CPU_SPEED='16Mhz'・DEFAULT_RAM_SIZE='2MB'・
//     パッド既定'Default (2 Buttons)')を渡したときに期待どおりの値が返ること
// (2) 「両経路が同じ関数を通る」という構造的な一致保証そのもの
// を確認する。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCoreOptions } from '../src/core-options';

const REPO_ROOT = resolve(__dirname, '..');

// src/main.ts の DEFAULT_CPU_SPEED/DEFAULT_RAM_SIZE、src/gamepad.ts の
// PAD_TYPE_CORE_OPTION_VALUE.default と同じ値(main.tsはDOM依存で直接importできないため、
// ここでは既知の既定値として書き下す。値がずれたらこのテストごと更新すること)。
const WEBX68K_DEFAULT_CPU_SPEED = '16Mhz';
const WEBX68K_DEFAULT_RAM_SIZE = '2MB';
const WEBX68K_DEFAULT_JOYTYPE_CORE_VALUE = 'Default (2 Buttons)';

// px68k-libretro/libretro_core_options.h に書かれているコア自身の既定値(実測・突き合わせ済み。
// docs/STORAGE-SCSI.md「ワーカー移行 手順9」参照)。WebX68k既定と食い違うものがある
// (px68k_cpuspeedだけ食い違っていた)ことを明示するために、ここにも書いておく。
const CORE_DEFAULT_CPU_SPEED = '10Mhz'; // WebX68k既定(16Mhz)と食い違う
const CORE_DEFAULT_RAM_SIZE = '2MB'; // WebX68k既定と一致
const CORE_DEFAULT_JOYTYPE = 'Default (2 Buttons)'; // WebX68k既定と一致

describe('buildCoreOptions', () => {
  it('WebX68kの既定値を渡すと、既定経路が期待する7項目をすべて含む', () => {
    const options = buildCoreOptions({
      cpuSpeed: WEBX68K_DEFAULT_CPU_SPEED,
      ramSize: WEBX68K_DEFAULT_RAM_SIZE,
      joyType1CoreValue: WEBX68K_DEFAULT_JOYTYPE_CORE_VALUE,
      joyType2CoreValue: WEBX68K_DEFAULT_JOYTYPE_CORE_VALUE,
    });
    expect(options).toEqual({
      px68k_cpuspeed: '16Mhz',
      px68k_ramsize: '2MB',
      px68k_save_hdd_path: 'enabled',
      px68k_joy_mouse: 'Mouse',
      px68k_no_wait_mode: 'enabled',
      px68k_joytype1: 'Default (2 Buttons)',
      px68k_joytype2: 'Default (2 Buttons)',
    });
  });

  it('陽性対照: WebX68k既定のCPU速度(16Mhz)は、コア自身の既定値(10Mhz)とは異なる', () => {
    // これが「Worker経路がoptionsを渡さないとコア既定10Mhzのまま走る」実際の食い違いの正体。
    // buildCoreOptions()自体はこの食い違いを検出しないが(渡された値をそのまま返すだけ)、
    // 「渡す値」がコア既定と違うことをこのテストで記録しておく(値がコア側と同じになる
    // 変更が入ったら、このテストを見て気づけるように)。
    expect(WEBX68K_DEFAULT_CPU_SPEED).not.toBe(CORE_DEFAULT_CPU_SPEED);
  });

  it('RAM構成・パッド種別のWebX68k既定値は、コア自身の既定値と一致する(食い違いなし)', () => {
    expect(WEBX68K_DEFAULT_RAM_SIZE).toBe(CORE_DEFAULT_RAM_SIZE);
    expect(WEBX68K_DEFAULT_JOYTYPE_CORE_VALUE).toBe(CORE_DEFAULT_JOYTYPE);
  });

  it('cpuSpeed/ramSize/joyTypeが呼び出しごとに独立して反映される(共有状態を持たない純関数)', () => {
    const a = buildCoreOptions({
      cpuSpeed: '25Mhz',
      ramSize: '4MB',
      joyType1CoreValue: 'CPSF-MD (8 Buttons)',
      joyType2CoreValue: 'CPSF-SFC (8 Buttons)',
    });
    const b = buildCoreOptions({
      cpuSpeed: '10Mhz',
      ramSize: '2MB',
      joyType1CoreValue: 'Default (2 Buttons)',
      joyType2CoreValue: 'Default (2 Buttons)',
    });
    expect(a.px68k_cpuspeed).toBe('25Mhz');
    expect(a.px68k_ramsize).toBe('4MB');
    expect(a.px68k_joytype1).toBe('CPSF-MD (8 Buttons)');
    expect(a.px68k_joytype2).toBe('CPSF-SFC (8 Buttons)');
    expect(b.px68k_cpuspeed).toBe('10Mhz');
    expect(b.px68k_joytype1).toBe('Default (2 Buttons)');
  });
});

describe('main.ts: 既定経路・Worker経路が両方ともbuildCoreOptions()を通ること(静的検査)', () => {
  // main.ts はDOMに依存する巨大なエントリファイルで、Node(vitest)から直接importして
  // 実行することはできない(test/core-worker-build-format.test.tsと同じ理由・同じ手法)。
  // 「両経路が同じ関数から値を取る」という構造的な一致保証そのものは実行時には検査できないため、
  // ソースを読んで両方のブート関数がbuildCoreOptions()を呼んでいることだけを確認する。
  //
  // 重要な限界: この静的検査は「呼んでいる」ことしか確認できず、「渡している引数が
  // 正しいDEFAULT_CPU_SPEED等の値か」までは検査しない(main.tsをimportできないため)。
  // 陽性対照: bootWorkerCore()側のbuildCoreOptions()呼び出しを一時的に削り、以前の
  // オブジェクトリテラル直書きに戻したところ、このテストが実際に落ちることを確認してから
  // 元に戻した(git diff空を確認済み)。
  // コメント(行・ブロック)を落とした「実コードだけ」で判定する。この節自体の説明コメントが
  // "buildCoreOptions()" という文字列に言及しているため、コメントを残したままだと
  // 呼び出しを削っても文字列一致してしまい、故障注入で検出できない
  // (実際に最初の実装でこれを踏んだ。test/core-worker-build-format.test.tsのstripComments
  // と同じ対策)。
  function stripComments(s: string): string {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  }
  const src = stripComments(readFileSync(resolve(REPO_ROOT, 'src/main.ts'), 'utf8'));

  function bodyOf(fnName: string): string {
    const start = src.indexOf(`async function ${fnName}(`);
    expect(start, `${fnName}() が見つかりません`).toBeGreaterThanOrEqual(0);
    // 次の "async function " または "function " までを大雑把に本体とみなす
    // (main.tsのトップレベル関数はネストしないため、これで十分)。
    const rest = src.slice(start + 1);
    const nextFnRelative = rest.search(/\n(async )?function /);
    return nextFnRelative >= 0 ? rest.slice(0, nextFnRelative) : rest;
  }

  it('bootWorkerCore()がbuildCoreOptions()を呼んでいる', () => {
    expect(bodyOf('bootWorkerCore')).toMatch(/buildCoreOptions\(/);
  });

  it('bootCore()がbuildCoreOptions()を呼んでいる(既定経路)', () => {
    expect(bodyOf('bootCore')).toMatch(/buildCoreOptions\(/);
  });
});
