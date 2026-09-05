// URLパラメータのパース関数群(main.ts から純粋関数として切り出し、単体テスト可能にする)。

import type { AspectMode } from './aspect';

/**
 * `?ram=` の値を px68k_ramsize コアオプション形式(例: '12MB')にパースする。
 * 受理形式: '12' / '12MB' / '12mb' / 前後空白あり(trim + 大小文字無視)。
 * 有効範囲は 1〜12 の整数のみ。範囲外・非数値・小数などは無効値として null を返す。
 */
export function parseRamSizeParam(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const match = /^(\d+)\s*mb$/i.exec(trimmed) ?? /^(\d+)$/.exec(trimmed);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n < 1 || n > 12) return null;
  return `${n}MB`;
}

/**
 * index.html の #cfg-cpuspeed が並べる option 値(∞MHz の 'auto' 系を除く)。
 * px68k-libretro の libretro_core_options.h の表記と完全一致させる必要があるため、
 * この配列を書き換える場合は index.html も合わせて直すこと。
 * パースはこの配列に限定しない(コアは選択肢外の値も受け付ける)が、
 * ここに並ぶ値は必ず正規化結果と一致すること(test/url-params.test.ts で検査)。
 *
 * 200/400/800MHz は**あえて選択肢に置いていない**。実測でこのクラスのMacでも
 * 100MHz で実測50%(ベンチ所要が11.4秒→23.0秒)、800MHz で実測10%(同 約10倍)になり、
 * 数字は伸びても待ち時間が線形に増えるだけで実用域を外れる。「このマシンで出せる最大」は
 * ∞MHz が自動で見つけるので、固定の高クロックを選ぶ理由がほぼ無い。
 * ただし capability は残してあり、`?cpu=200` のようなURL指定では 10〜1000 を指定できる。
 */
export const CPU_SPEED_OPTIONS = [
  '10Mhz',
  '16Mhz',
  '25Mhz',
  '33Mhz (OC)',
  '66Mhz (OC)',
  '100Mhz (OC)',
] as const;

/**
 * CPUクロックを「ホストが追いつく範囲で自動調整する」モードを表す番兵値。
 * これはコアオプションの値ではないので、コアへ渡す前に必ず具体的な MHz へ解決すること。
 */
export const AUTO_CPU_SPEED = 'auto';

/**
 * ∞MHz の「描画を捨てて最速」版を表す番兵値。
 * 制御ループは AUTO_CPU_SPEED と同じだが、画面提示を約30fpsへ間引き、コア実行に許す
 * メインスレッド占有の上限も引き上げる。画面の滑らかさと引き換えにクロックを稼ぐモード。
 */
export const AUTO_CPU_SPEED_TURBO = 'auto-max';

/**
 * 受理する CPU クロック(MHz)の範囲。px68k-libretro 側の
 * PX68K_CLOCK_MHZ_MIN / PX68K_CLOCK_MHZ_MAX と揃えること。
 * コアは選択肢に無い値でも先頭の10進数を MHz として読むので、選択肢の外の値も渡せる。
 */
export const CPU_MHZ_MIN = 10;
export const CPU_MHZ_MAX = 1000;

/**
 * 数値の MHz を px68k_cpuspeed のコアオプション文字列へ正規化する。
 * 実機に存在する 10/16/25MHz は '(OC)' を付けず、それより上は '(OC)' 付きにする
 * (既存の選択肢6段の表記をそのまま踏襲した規則)。
 */
export function cpuSpeedOptionForMhz(mhz: number): string {
  const n = Math.max(CPU_MHZ_MIN, Math.min(CPU_MHZ_MAX, Math.round(mhz)));
  return n > 25 ? `${n}Mhz (OC)` : `${n}Mhz`;
}

/**
 * `?cpu=` の値を px68k_cpuspeed コアオプション形式(例: '16Mhz', '33Mhz (OC)')にパースする。
 * 受理形式: '16' / '16Mhz' / '16MHz' / 前後空白あり(trim + 大小文字無視)。
 * '(OC)' の有無は問わず、CPU_MHZ_MIN〜CPU_MHZ_MAX の整数ならそのまま正規化して返す
 * (コアが選択肢外の値も受け付けるため、選択肢の6段+3段に限定していない)。
 * 'auto' / 'max' / 'inf' / '∞' は AUTO_CPU_SPEED(ホスト次第の自動調整)を、
 * 'auto-max' / 'automax' は AUTO_CPU_SPEED_TURBO(描画を捨てて最速)を返す。
 * 範囲外・非数値・小数などは無効値として null を返す。
 */
export function parseCpuSpeedParam(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const lower = trimmed.toLowerCase();
  if (lower === 'auto-max' || lower === 'automax' || lower === 'auto_max')
    return AUTO_CPU_SPEED_TURBO;
  if (lower === 'auto' || lower === 'max' || lower === 'inf' || trimmed === '∞')
    return AUTO_CPU_SPEED;
  const match = /^(\d+)\s*mhz(?:\s*\(oc\))?$/i.exec(trimmed) ?? /^(\d+)$/.exec(trimmed);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n < CPU_MHZ_MIN || n > CPU_MHZ_MAX) return null;
  return cpuSpeedOptionForMhz(n);
}

/**
 * `?worker=` の値を、Worker 経路を使うかどうかの boolean にパースする。
 * 受理形式(trim + 大小文字無視): '1' / 'true' / 'yes' / 'on' → true、
 * '0' / 'false' / 'no' / 'off' → false。それ以外・空文字・null は無効値として null を返す
 * (呼び出し側は null のとき既定(false = 従来の LocalCoreProxy 経路)を使うこと)。
 *
 * docs/STORAGE-SCSI.md「段階移行の順序」に記載の通り、Worker 経路は当面このフラグの裏でのみ
 * 有効化する試験的スケルトンであり、指定が無い既定の挙動(LocalCoreProxy)は変えない。
 */
export function parseWorkerModeParam(raw: string | null): boolean | null {
  if (raw === null) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '') return null;
  if (trimmed === '1' || trimmed === 'true' || trimmed === 'yes' || trimmed === 'on') return true;
  if (trimmed === '0' || trimmed === 'false' || trimmed === 'no' || trimmed === 'off') return false;
  return null;
}

/**
 * `?aspect=` の値を AspectMode('4:3' | 'native')にパースする。
 * 受理形式(trim + 大小文字無視): '4:3' / '43' / '4-3' / '4/3' → '4:3'、
 * 'native' / '1:1' / '11' → 'native'。それ以外・空文字・null は無効値として null を返す。
 */
export function parseAspectModeParam(raw: string | null): AspectMode | null {
  if (raw === null) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '') return null;
  if (trimmed === '4:3' || trimmed === '43' || trimmed === '4-3' || trimmed === '4/3') return '4:3';
  if (trimmed === 'native' || trimmed === '1:1' || trimmed === '11') return 'native';
  return null;
}

/** URL のディスク構成指定(?fd1=/?fd2=/?hdd=/?system=1)を表す。 */
export interface UrlSlotSpec {
  fd1?: string | undefined;
  fd2?: string | undefined;
  hdd?: string | undefined;
  system: boolean;
}

/**
 * URL がディスク構成を指定しているとき、指定外のスロットを解除する対象を返す。
 *
 * 共有リンクは「誰が開いても同じ状態で起動する」のが本来だが、前のセッションで挿さっていた
 * スロットがそのまま残ると、意図しないディスクが同時に挿さった状態で起動してしまう。
 * 実測でも、起動可能な SCSI ディスクが挿さっていると FDD0 の起動ディスクを指定していても
 * IPL が止まる(「システムを起動できませんでした」)ことを確認している。
 *
 * `fd1`/`fd2`/`hdd`/`system` のいずれも無ければ(`run=1` だけの URL 等)、
 * 「いま挿さっているもので起動する」という意味なので何も解除しない。
 */
export function slotsToUnmountForUrl(
  spec: UrlSlotSpec,
): { fdd0: boolean; fdd1: boolean; hdd: boolean; scsi: boolean } {
  // system=1 は fd1 が無いときだけ fdd0 の指定として扱われる(main.ts の wantsBundledSystem と同じ規則)。
  const specifiesFdd0 = spec.fd1 !== undefined || spec.system;
  const specifiesAny = specifiesFdd0 || spec.fd2 !== undefined || spec.hdd !== undefined;
  if (!specifiesAny) return { fdd0: false, fdd1: false, hdd: false, scsi: false };
  return {
    fdd0: !specifiesFdd0,
    fdd1: spec.fd2 === undefined,
    hdd: spec.hdd === undefined,
    // SCSI は URL から指定する手段が無いため、この規則が働く場面では常に解除対象になる。
    scsi: true,
  };
}
