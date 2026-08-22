#!/usr/bin/env node
// Sprout68k の共有ランタイムを取得して、この配布物へ同梱する。
//
// 共有リンク `#p1=` を開くのに要る。**ランタイムを作るのは Sprout68k だけ**で、
// ここが持つのは SHA-256 で検証できる写し。版ごとに凍結された不変のバイナリ
// なので更新は発生せず、増えるだけ。
//
// 取得は**ビルド時**に行い、実行時は自前で配信する。実行時にブラウザから
// GitHub Release を取りにいく形にしない理由:
//   - オフライン: 共有リンクを開いた瞬間にランタイムが要る。外部取得だと
//     Service Worker のキャッシュに乗らず、オフラインで開けない
//   - CORS: Release アセットは objects.githubusercontent.com へリダイレクトされる
//   - 可用性: 共有リンクは永久に動く必要がある。5KB のために外部依存を増やさない
//
// 使い方:
//   node tools/fetch-sprout-runtime.mjs <取得元> [--manifest-sha256 <hex>]
//     取得元: http(s) の URL、またはローカルの deploy/runtime/v1 ディレクトリ
//
// 取得元が公開前でもローカルパスで通せる（Sprout68k がまだ公開されていないため）。
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(ROOT, 'public/sprout-runtime/v1');
/** 復号と組み立ての正典。src からも import するのでここへ置く。 */
const SHARE_OUTPUT = resolve(ROOT, 'src/sprout-share.mts');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function read(source, name) {
  if (/^https?:\/\//.test(source)) {
    const base = source.endsWith('/') ? source : `${source}/`;
    const response = await fetch(new URL(name, base));
    if (!response.ok) throw new Error(`${response.url}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  const path = statSync(source).isDirectory() ? resolve(source, name) : resolve(dirname(source), name);
  return new Uint8Array(readFileSync(path));
}

const [source, ...rest] = process.argv.slice(2);
if (!source) {
  console.error('使い方: node tools/fetch-sprout-runtime.mjs <取得元> [--manifest-sha256 <hex>]');
  process.exit(1);
}
let expectedManifestSha;
for (let index = 0; index < rest.length; index++) {
  if (rest[index] === '--manifest-sha256') expectedManifestSha = rest[++index];
  else throw new Error(`未知の引数: ${rest[index]}`);
}

const manifestBytes = await read(source, 'manifest.json');
const manifestSha = sha256(manifestBytes);
// manifest の SHA-256 を先に固定しておけば、その先はすべて manifest から検証できる。
// 指定が無い場合は取得した値を表示するだけにする（黙って信用しない）。
if (expectedManifestSha && manifestSha !== expectedManifestSha) {
  throw new Error(`manifest の SHA-256 が一致しません: actual=${manifestSha}`);
}
const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
if (manifest.abiVersion !== 1) throw new Error(`未知の ABI 版です: ${manifest.abiVersion}`);

const files = [
  ['runtime.bin', manifest.runtime, OUTPUT],
  ['boot.bin', manifest.boot, OUTPUT],
];
mkdirSync(OUTPUT, { recursive: true });
for (const [name, entry, directory] of files) {
  const bytes = await read(source, name);
  if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
    throw new Error(`${name}: manifest と一致しません (size=${bytes.length}, sha256=${sha256(bytes)})`);
  }
  writeFileSync(resolve(directory, name), bytes);
  console.log(`  ${name}: ${bytes.length} バイト`);
}
writeFileSync(resolve(OUTPUT, 'manifest.json'), manifestBytes);

// 復号と .xdf の組み立ては、Sprout68k の送信側とまったく同じコードを使う。
// 自前で書くと、送信側と静かに食い違う。
const shareBytes = await read(source, manifest.share.name);
if (shareBytes.length !== manifest.share.size || sha256(shareBytes) !== manifest.share.sha256) {
  throw new Error(`${manifest.share.name}: manifest と一致しません`);
}
writeFileSync(SHARE_OUTPUT, shareBytes);
console.log(`  ${manifest.share.name}: ${shareBytes.length} バイト -> src/sprout-share.mts`);
console.log(`Sprout68k 共有ランタイム v${manifest.abiVersion} を同梱しました (manifest sha256=${manifestSha})`);
