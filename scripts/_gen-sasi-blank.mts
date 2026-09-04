// 使い捨ての生成スクリプト(調査用、SASIオラクル用)。createFormattedHdd()の
// ブランクを「実行するたびに新しく」作るために使う。
// 使い方: ./node_modules/.bin/vite-node scripts/_gen-sasi-blank.mts <出力先.hds>
import { writeFileSync } from 'node:fs';
import { createFormattedHdd } from '../src/api/fat.ts';

const out = process.argv[2];
if (!out) {
  console.error('使い方: vite-node scripts/_gen-sasi-blank.mts <出力先.hds>');
  process.exit(1);
}
const data = createFormattedHdd();
writeFileSync(out, data);
console.error(`[gen] ${out} (${data.length} バイト) を作成した(SASIオラクル用)`);
