import type { HostGlobalValue } from './core-protocol';

/**
 * ページ(main)側の `globalThis.__webx68k*` をWorkerへ渡すためのスナップショットを取る際の
 * 判定・収集ロジック(docs/STORAGE-SCSI.md参照)。SCSIの設定(__webx68kScsiUrl等)や
 * 計測用の監視範囲(__webx68kRamWatchLo等)はwasmからglobalThis経由で読まれるため、
 * Workerを別グローバル(別スレッド)で走らせるとこれが渡らず丸ごと効かない
 * (2026-09-03実測)。
 *
 * main.ts から `globalThis` への依存とDOM依存(トースト表示)を切り離すため、
 * 判定対象のオブジェクトと警告用コールバックを引数として受け取る形にしてある
 * (単体テストで globalThis や showToast/DOM を用意せずに検証できるようにするため)。
 *
 * 2026-09-04修正: 以前は string/number/boolean しか転写せず、配列や ArrayBuffer/TypedArray
 * で渡す設定(例: 本物SCSI ROMのバイト列を渡す設定)が**無言で**落ち、Worker側は
 * 気づかずフォールバック実装に切り替わっていた(直前のセッションでこれを踏み、
 * `--worker=0`で既定経路に切り替えて初めてROMが読めていることが判明した)。
 * ここでは structured clone で運べる型(string/number/boolean/ArrayBuffer/
 * ArrayBufferView/配列)はすべて転写し、**渡せない値(関数・Symbol・通常のobject等)
 * だけを警告して除外する**。「0件」と「落として0件」を区別できるよう、除外が
 * 発生した場合は必ず `onSkipped` を呼ぶ(呼び出し側が console.warn / トーストを出す)。
 *
 * ArrayBuffer/TypedArrayはWorkerへ渡すたびに structured clone でコピーされる
 * (`collectTransferables()` が hostGlobals の中身を transfer list に加えないため、
 * 意図的にコピー渡しにしている。main.ts側の実体を detach させないため)。
 * サイズが大きい値を毎回コピーするコストが問題になる場合はここで別対応が要るが、
 * 現状のROM等のサイズ(数百KB〜数MB)では起動・リセット時(低頻度)の一度のコピーで
 * 無視できる範囲と判断している。
 */
/**
 * 転写できなくて当然の DEV 専用フック(デバッグ/計測用で関数を持つため structured clone
 * で運べない)の一覧。DEV ビルドで Worker を起動するたびに毎回これらの警告が出ており、
 * 本来の目的(設定が無言で落ちたことに気づく)を果たせなくなっていた(2026-09-05実測、
 * 実ブラウザのコンソールで毎回必ず4件の警告を確認)。
 *
 * ここに載っているキーは従来どおり転写しない(挙動は変えない)が、`onSkipped` には
 * 含めない(警告を出さない)。挙動を変えているのは「警告に出すかどうか」だけである点に
 * 注意。
 *
 * **新しい `__webx68k*` の DEV 専用プローブ/デバッグフックを追加したら、
 * このSetにも追加すること。** さもないと転写できない旨の警告が毎回鳴り続け、
 * 本物の取りこぼし(設計外の欠落)に気づけなくなる。
 */
export const KNOWN_DEV_ONLY_HOST_GLOBALS: ReadonlySet<string> = new Set([
  '__webx68kDebug',
  '__webx68kStorageProbe',
  '__webx68kFrameProbe',
  '__webx68kKeybufAttributionProbe',
]);

export function isTransferableHostGlobalValue(v: unknown): v is HostGlobalValue {
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return true;
  if (v instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(v)) return true;
  if (Array.isArray(v)) return true;
  return false;
}

/**
 * `source`(通常は `globalThis`)から `__webx68k` で始まるキーを集め、
 * structured clone で運べる値だけを収集する。運べなかったキーがあれば、
 * それらのキー名(スキップされたキー一覧、空配列にはならない)を添えて
 * `onSkipped` を呼ぶ。`onSkipped` が渡されなければ何も通知しない
 * (main.ts側は必ず渡し、console.warn + トーストを行う)。
 */
export function collectHostGlobals(
  source: Record<string, unknown>,
  onSkipped?: (skippedKeys: string[]) => void,
): Record<string, HostGlobalValue> {
  const out: Record<string, HostGlobalValue> = {};
  const skipped: string[] = [];
  for (const key of Object.keys(source)) {
    if (!key.startsWith('__webx68k')) continue;
    const v = source[key];
    if (isTransferableHostGlobalValue(v)) {
      out[key] = v;
    } else if (!KNOWN_DEV_ONLY_HOST_GLOBALS.has(key)) {
      skipped.push(key);
    }
  }
  if (skipped.length > 0) {
    onSkipped?.(skipped);
  }
  return out;
}
