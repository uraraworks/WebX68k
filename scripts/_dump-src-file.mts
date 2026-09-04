// 使い捨て(調査用): FDイメージから指定パスのファイル先頭バイトを表示する。
import { readFileSync } from 'node:fs';
import { openDiskImage, fatReadFile, fatList } from '../src/api/fat.ts';

const imgPath = process.argv[2];
const filePath = process.argv[3];
const img = new Uint8Array(readFileSync(imgPath));
const vol = openDiskImage(img, imgPath);
const data = fatReadFile(vol, filePath);
console.error(`[dump] ${filePath}: ${data.length} バイト`);
console.error(Array.from(data.slice(0, 32)).map((b) => b.toString(16).padStart(2, '0')).join(' '));
