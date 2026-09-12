// HostFS: 未知コマンドの警告ラベル・ツールチップ・クリップボードへコピーする診断情報の
// 本文を組み立てる純粋関数(利用者の決定分)。
//
// 私的情報(フォルダの中のファイル名・覚え書きの本文・ホストの実際のパス)は、
// ここで扱うどの入力にも含めない。dispatcher.ts が記録するのはコマンド番号・回数・
// ヘッダのバイト列・ゲストRAM上のポインタ先バイト列だけであり、この方針はその記録の
// 作り方(dispatcher.ts の recordUnknownCommand コメント参照)から一貫している。
//
// main.ts のupdateHostFsUi()/クリックハンドラから使う。main.tsはDOM要素をモジュール
// 読み込み時に取得するためnode環境のvitestから素直にimportできないので、ロジック本体を
// ここへ切り出してテストする(buildRejectedTooltipLinesと同じ流儀)。

import type { HostFsUnknownCommandInfo } from '../core-protocol';

/** コマンド番号を「$4f」の形にする(2桁16進、小文字)。 */
export function formatUnknownCommandCode(cmd: number): string {
  return `$${(cmd & 0xff).toString(16).padStart(2, '0')}`;
}

/** HostFS行のラベルに使う「先頭のコマンドと、残り何種あるか」。0件ならnull。 */
export interface UnknownCommandLabelSummary {
  /** ラベルに出す代表のコマンド(記録順で最初のもの、dispatcher.getUnknownCommandsSummary()
   * は番号順なのでここも番号の小さい方が代表になる)。 */
  cmd: number;
  /** 代表以外の種類数(0なら「ほかN種」を出さない)。 */
  extraKinds: number;
}

export function summarizeUnknownCommandLabel(
  unknownCommands: HostFsUnknownCommandInfo[],
): UnknownCommandLabelSummary | null {
  if (unknownCommands.length === 0) return null;
  return { cmd: unknownCommands[0].cmd, extraKinds: unknownCommands.length - 1 };
}

/**
 * ツールチップ(title、改行区切り)本文。届いた未知のコマンドを1行1種(「$4f ×3」のような形、
 * countLineは呼び出し側でt()を使って組み立てる)で並べ、末尾に「クリックで診断情報を
 * コピー」相当の1行(copyHintLine)を足す。
 */
export function buildUnknownCommandTooltipLines(
  unknownCommands: HostFsUnknownCommandInfo[],
  countLine: (cmd: number, count: number) => string,
  copyHintLine: string,
): string[] {
  return [...unknownCommands.map((u) => countLine(u.cmd, u.count)), copyHintLine];
}

/** buildHostFsDiagText()への入力。私的情報(ファイル名・覚え書き・ホストのパス)は含めない。 */
export interface HostFsDiagInput {
  /** #footer-versionと同じ文字列。 */
  buildStamp: string;
  userAgent: string;
  unknownCommands: HostFsUnknownCommandInfo[];
  driverDetected: boolean;
  /** driverDetected=falseならnull。 */
  driveNumber: number | null;
  folderConnected: boolean;
  /** folderConnected=falseならnull。 */
  mode: 'readonly' | 'readwrite' | null;
}

function driveLetter(driveNumber: number | null): string {
  return driveNumber === null ? '-' : `${String.fromCharCode('A'.charCodeAt(0) + driveNumber)}:`;
}

/**
 * クリップボードへコピーする診断テキスト本文を組み立てる。利用者からの指示のとおり、
 * フォルダの中のファイル名・覚え書きの本文・ホストの実際のパスはどの項目にも含めない
 * (含めているのは: ビルド刻印・userAgent・未知コマンドの番号/回数/ヘッダ/ポインタ先・
 * HostFSの状態(検出有無・ドライブ番号・接続有無・モード)だけ)。
 * 言語非依存(英字ラベル)にして、そのままGitHub Issue等に貼れる形にする。
 */
export function buildHostFsDiagText(input: HostFsDiagInput): string {
  const lines: string[] = [];
  lines.push('WebX68k HostFS diagnostics');
  lines.push(`build: ${input.buildStamp}`);
  lines.push(`userAgent: ${input.userAgent}`);
  lines.push(
    `driver: detected=${input.driverDetected} drive=${input.driverDetected ? driveLetter(input.driveNumber) : '-'}`,
  );
  lines.push(`folder: connected=${input.folderConnected} mode=${input.folderConnected ? (input.mode ?? '-') : '-'}`);
  lines.push(`unknown commands (${input.unknownCommands.length}):`);
  for (const u of input.unknownCommands) {
    lines.push(`  ${formatUnknownCommandCode(u.cmd)} x${u.count} verify=${u.verify ? 'on' : 'off'}`);
    lines.push(`    header[+0..+25]: ${u.headerHex}`);
    lines.push(`    ptrDump[+14/+18 target, 32 bytes]: ${u.ptrDumpHex ?? '(none)'}`);
  }
  return lines.join('\n');
}
