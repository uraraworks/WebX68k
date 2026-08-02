#!/usr/bin/env node
// 東雲フォント(Shinonome, Public Domain)の配布アーカイブを取得して展開する。
// フォント原本はリポジトリにコミットしないため、generate.js の実行前にこのスクリプトを叩く。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FONTS_DIR = path.join(__dirname, 'fonts');
const ARCHIVE_URL = 'http://openlab.ring.gr.jp/efont/dist/shinonome/shinonome-0.9.11p1.tar.bz2';
const ARCHIVE_PATH = path.join(FONTS_DIR, 'shinonome.tar.bz2');
const EXTRACTED_DIR = path.join(FONTS_DIR, 'shinonome-0.9.11');

function main() {
  fs.mkdirSync(FONTS_DIR, { recursive: true });

  if (fs.existsSync(path.join(EXTRACTED_DIR, 'bdf', 'shnmk16.bdf'))) {
    console.log('東雲フォントは既に取得済みです:', EXTRACTED_DIR);
    return;
  }

  console.log('東雲フォントをダウンロード中...', ARCHIVE_URL);
  execFileSync('curl', ['-sL', '--max-time', '60', ARCHIVE_URL, '-o', ARCHIVE_PATH], { stdio: 'inherit' });

  console.log('展開中...');
  execFileSync('tar', ['xjf', ARCHIVE_PATH, '-C', FONTS_DIR], { stdio: 'inherit' });

  if (!fs.existsSync(path.join(EXTRACTED_DIR, 'bdf', 'shnmk16.bdf'))) {
    console.error('展開に失敗しました');
    process.exit(1);
  }
  console.log('完了:', EXTRACTED_DIR);
}

main();
