// 使い捨ての生成スクリプト(調査用)。createFormattedScsi(8)の8MiBブランクに、
// テキストファイル SRC.TXT を1つ書く。scripts/verify-scsi-persistence.mjs が、
// 「リロード(プロファイル使い回し)をまたいで中身まで残るか」を検証するための検体を
// 作るために使う。
//
// 中身は印字可能ASCIIのみ・改行はCRLF。1行目が `HEAD-<id>`、最終行が `TAIL-<id>`、
// 間を固定の埋め行で埋める(<id> は実行ごとに変える引数)。全体のサイズを
// あえてセクタ境界(512の倍数)からずらしてある。docs/STORAGE-SCSI.md
// (「端数セクタが届かない」節)が示すとおり、以前は末尾の端数バイトだけが
// 静かに落ちる不具合があった。検体がぴったりセクタ境界に収まっていると、
// この不具合を検体自体が踏まなくなってしまう。
//
// 使い方:
//   ./node_modules/.bin/vite-node scripts/_gen-scsi-marker.mts <出力先.hds> <id>
import { writeFileSync } from 'node:fs';
import { createFormattedScsi, openDiskImage, fatWriteFile, fatList } from '../src/api/fat.ts';

const [, , out, id] = process.argv;
if (!out || !id) {
  console.error('使い方: vite-node scripts/_gen-scsi-marker.mts <出力先.hds> <id>');
  process.exit(1);
}
if (!/^[A-Za-z0-9]+$/.test(id)) {
  console.error(`id は英数字のみにしてください: ${JSON.stringify(id)}`);
  process.exit(1);
}

const HEAD = `HEAD-${id}`;
const TAIL = `TAIL-${id}`;
// 2026-09-04追記: 当初は16文字幅の埋め行×多数(バイト数を1500前後に合わせる方式)で
// 作っていたが、実機検証で「type」の出力がテキスト画面(768x512px = 96列×32行、
// src/text-screen.tsのデフォルト)からあふれ、HEADが画面からスクロールアウトして
// 消えることが実測された(verify-scsi-persistence.mjsの初回実行で発覚。データは
// ちゃんと残っていたのに検査側がHEADを画面外に押し出していただけだった)。
// バイト数ではなく「埋め行の本数」を主導にし、1行を広く(64文字)取ることで、
// 同じバイト数でも行数を1/4に抑え、HEAD〜TAILが1画面に収まるようにする。
const FILLER = '0123456789ABCDEF'.repeat(4); // 64文字(96列の画面幅に余裕を持って収まる)
// 埋め行の本数。HEAD+埋め行+TAILが余裕を持って1画面(32行)に収まる本数にする
// (コマンドエコー行・空行・次のプロンプト行の分も見込む)。
const FILLER_COUNT = 14;

function buildBody(): string {
  let body = `${HEAD}\r\n`;
  for (let i = 0; i < FILLER_COUNT; i++) body += `${FILLER}\r\n`;
  body += `${TAIL}\r\n`;
  return body;
}

let body = buildBody();
// 端数がセクタ境界(512の倍数)にちょうど一致しないことを保証する(直した不具合の
// 再発を検体で踏むため)。一致してしまった場合は埋め行をもう1本足してずらす
// (TAILは常に最終行のままにする。行数が1本増えても画面には十分収まる)。
if (body.length % 512 === 0) {
  body = body.slice(0, -(TAIL.length + 2)) + `${FILLER}\r\n${TAIL}\r\n`;
}
if (body.length % 512 === 0) {
  console.error(`[gen] 端数がセクタ境界(512の倍数)に一致してしまいました(${body.length}バイト)。FILLER_COUNTを調整してください。`);
  process.exit(1);
}

// 印字可能ASCII(+CR/LF)のみであることを確認する(念のため。上の構築ロジックなら
// 常に満たすはずだが、検体の性質そのものが検証条件なので機械的に確かめておく)。
for (const ch of body) {
  const code = ch.charCodeAt(0);
  if (ch !== '\r' && ch !== '\n' && (code < 0x20 || code > 0x7e)) {
    console.error(`[gen] 印字可能ASCII以外の文字が含まれています: ${JSON.stringify(ch)}`);
    process.exit(1);
  }
}

const data = new TextEncoder().encode(body);

const image = createFormattedScsi(8);
const vol = openDiskImage(image, out);
fatWriteFile(vol, 'SRC.TXT', data);

// 直後に開き直してサイズを確認し、標準エラーへログを出す(既存の流儀)。
const reopened = openDiskImage(image, out);
const entry = fatList(reopened, '\\').find((e) => e.name.toUpperCase() === 'SRC.TXT');
if (!entry) {
  console.error('[gen] 書き込み直後の再読み出しでファイルが見つからない: SRC.TXT');
  process.exit(1);
}
console.error(
  `[gen] ${out} (${image.length} バイト, 8MiB) に SRC.TXT (${entry.size} バイト, id=${id}) を書き込んだ` +
    ` (末尾セクタ端数=${entry.size % 512}バイト)`,
);

writeFileSync(out, image);
