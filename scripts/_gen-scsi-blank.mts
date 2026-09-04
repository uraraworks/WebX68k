// 使い捨ての生成スクリプト(調査用)。createFormattedScsi(1)のブランクを
// 「実行するたびに新しく」作るために使う。前回実行の書き込みが残った同じ
// ファイルを使い回すと比較の条件が変わってしまうため、対照A/Bそれぞれの
// 実行の直前に必ずこれで作り直すこと。
// 使い方: ./node_modules/.bin/vite-node scripts/_gen-scsi-blank.mts <出力先.hds> [サイズMiB(既定1)]
import { writeFileSync } from 'node:fs';
import { createFormattedScsi } from '../src/api/fat.ts';

const out = process.argv[2];
const sizeMiB = process.argv[3] ? Number(process.argv[3]) : 1;
if (!out) {
  console.error('使い方: vite-node scripts/_gen-scsi-blank.mts <出力先.hds> [サイズMiB]');
  process.exit(1);
}
const data = createFormattedScsi(sizeMiB);
writeFileSync(out, data);
console.error(`[gen] ${out} (${data.length} バイト, ${sizeMiB}MiB) を作成した`);
