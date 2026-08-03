// public/help/*.png (使い方ページの説明用スクリーンショット) を撮り直すスクリプト。
// 移植元: WebNP2 (../PC98/WebNP2/scripts/capture-help-shots.mjs)。
//
//   npm run dev            # 別ターミナルで開発サーバーを起動しておく(このスクリプトも自前で起動する)
//   node scripts/capture-help-shots.mjs
//
// WebX68k は同梱 BIOS(public/system/iplrom.dat, cgrom.dat)と同梱システムディスク
// (public/system/human302.xdf)だけで起動・ディスクライブラリ表示ができるため、
// WebNP2 版のようなライブラリ用ダミーレコードの注入は不要……だったが、help.html には
// 「複数枚入りアーカイブはフォルダにまとまる」という説明を書いた一方、撮影用プロファイルは
// 毎回まっさらで同梱ディスク1件しか無いため、library ショットが説明と食い違っていた。
// そのため WebNP2 と同様に、library ショットの直前だけ IndexedDB(webx68k-disks/disks、
// 構造は src/disk-store.ts の StoredDisk)へアーカイブ由来フォルダ入りのサンプルレコードを
// 注入し、撮影後すぐに撤去する(filemanager/overview など他ショットに写り込まないように)。
// 撮影用プロファイルは毎回捨てるので、手元のブラウザ環境には影響しない。
//
// 既知の落とし穴: headless だと requestAnimationFrame がスロットルされ、
// エミュレータ画面が真っ黒なまま撮影されてしまう。そのため headless: false で
// 起動し、bringToFront() でタブを前面に出したうえで、#screen canvas の
// 非黒ピクセル数を確認してから overview を撮る。

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const BASE_URL = process.env.WEBX68K_URL ?? 'http://localhost:5183';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR = new URL('../public/help/', import.meta.url).pathname;

/** 既存のスクリーンショットと同じ寸法になるビューポート(いずれも2倍解像度で保存する)。 */
const VIEWPORT = { width: 900, height: 700, deviceScaleFactor: 2 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `npm run dev` を専用ポートで起動し、応答が返るまで待つ。 */
async function startDevServer() {
  const port = new URL(BASE_URL).port || '5183';
  const child = spawn('npm', ['run', 'dev', '--', '--port', port, '--strictPort'], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: 'pipe',
  });
  let ready = false;
  child.stdout.on('data', (buf) => {
    if (buf.toString().includes('ready in')) ready = true;
  });
  const deadline = Date.now() + 20000;
  while (!ready && Date.now() < deadline) {
    await sleep(300);
  }
  await sleep(500);
  return child;
}

function stopDevServer(child) {
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(resolve, 3000);
  });
}

/** #screen canvas に十分な数の非黒ピクセルが描画されているか確認する。 */
async function waitForScreenPainted(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const nonBlack = await page.evaluate(() => {
      const canvas = document.getElementById('screen');
      if (!canvas) return 0;
      const ctx = canvas.getContext('2d');
      if (!ctx) return 0;
      const { width, height } = canvas;
      const data = ctx.getImageData(0, 0, width, height).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 8 || data[i + 1] > 8 || data[i + 2] > 8) count++;
      }
      return count;
    });
    if (nonBlack > 2000) return;
    if (Date.now() > deadline) {
      throw new Error(`画面が黒いまま(非黒ピクセル=${nonBlack})でタイムアウトしました`);
    }
    await sleep(500);
  }
}

async function shoot(page, selector, file) {
  const el = await page.$(selector);
  if (!el) throw new Error(`element not found: ${selector} (for ${file})`);
  await el.screenshot({ path: join(OUT_DIR, file) });
  console.log(`  wrote ${file}`);
}

async function clickToolbarButton(page, id) {
  await page.evaluate((elementId) => {
    const btn = document.getElementById(elementId);
    if (!btn) throw new Error(`button not found: ${elementId}`);
    btn.click();
  }, id);
  await sleep(600);
}

// library ショット用に IndexedDB(webx68k-disks/disks)へ注入するサンプルレコードの sourceKey。
// 実在の市販ソフト名は使わず、明らかに架空と分かる名前にする。
const LIBRARY_SAMPLE_KEYS = [
  'sample:disk1',
  'sample:harddisk1',
  'sample:game:1',
  'sample:game:2',
  'sample:game:3',
];
const LIBRARY_SAMPLE_GROUP_ID = 'sample-game-group';

/**
 * library ショットの直前に、単体ディスク2件 + 複数枚アーカイブ由来のフォルダ1件(3枚)を
 * IndexedDB へ注入する(移植元 WebNP2 の capture-help-shots.mjs と同じ方式)。
 * bytes は実イメージ不要なのでダミーの Uint8Array(全ゼロ)を使う。
 * バッジ判定は拡張子で行われるため、FD は .xdf / HDD は .hdf にする。
 */
async function injectLibrarySamples(page) {
  await page.evaluate(async () => {
    function openDb() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('webx68k-disks', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('disks')) {
            db.createObjectStore('disks', { keyPath: 'sourceKey' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    const db = await openDb();
    const put = (disk) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction('disks', 'readwrite');
        tx.objectStore('disks').put(disk);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

    const now = Date.now();
    const fdBytes = new Uint8Array(1474560); // 2HD 1440KB相当のダミーサイズ
    const hddBytes = new Uint8Array(20 * 1024 * 1024); // 20MB相当のダミーサイズ

    // 単体ディスク2件を最も新しい保存時刻にして、一覧の先頭(フォルダより上)に来るようにする。
    await put({ sourceKey: 'sample:disk1', name: 'sample_disk1.xdf', bytes: fdBytes, savedAt: now });
    await put({ sourceKey: 'sample:harddisk1', name: 'sample_harddisk.hdf', bytes: hddBytes, savedAt: now - 1000 });
    for (let i = 1; i <= 3; i++) {
      await put({
        sourceKey: `sample:game:${i}`,
        name: `sample_game_disk${i}.xdf`,
        displayName: `sample_game (Disk ${i} of 3)`,
        bytes: fdBytes,
        savedAt: now - 2000 - (3 - i) * 100,
        group: 'sample-game-group',
        groupName: 'sample_game.zip',
        groupIndex: i - 1,
      });
    }
    db.close();
  });
}

/** injectLibrarySamples() で入れたレコードだけを撤去する(他ショットに写り込ませないため)。 */
async function removeLibrarySamples(page) {
  await page.evaluate(async (keys) => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('webx68k-disks', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('disks', 'readwrite');
      const store = tx.objectStore('disks');
      for (const key of keys) store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, LIBRARY_SAMPLE_KEYS);
}

/** library モーダル内の「sample_game.zip」フォルダ行をクリックして展開状態にする。 */
async function expandLibrarySampleGroup(page) {
  await page.evaluate((groupId) => {
    const header = document.querySelector(
      `.library-group[data-group-id="${groupId}"] .library-list-group`,
    );
    if (!header) throw new Error('sample library group row not found');
    header.click();
  }, LIBRARY_SAMPLE_GROUP_ID);
  await sleep(300);
}

async function run() {
  const devServer = await startDevServer();
  const profile = await mkdtemp(join(tmpdir(), 'webx68k-shots-'));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    userDataDir: profile,
    // headless だと requestAnimationFrame がスロットルされ画面が真っ黒になるため、
    // 必ずヘッドフルで起動しタブを前面に出す。
    headless: false,
    args: ['--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=1000,900'],
  });

  try {
    for (const lang of ['ja', 'en']) {
      const suffix = lang === 'ja' ? '' : '-en';
      console.log(`[${lang}]`);
      const page = await browser.newPage();
      await page.setViewport(VIEWPORT);
      await page.bringToFront();

      // --- overlay: 起動前オーバーレイ ---
      await page.goto(`${BASE_URL}/?lang=${lang}`, { waitUntil: 'networkidle2' });
      await page.bringToFront();
      await sleep(1200);
      await shoot(page, '.console-card', `overlay${suffix}.png`);

      // --- library: ディスクライブラリ(同梱システムディスク human302.xdf に加え、
      //     アーカイブ由来フォルダの見え方を説明どおり撮るため撮影直前だけサンプルを注入する) ---
      // モーダルは max-height: 80vh; overflow-y: auto で、単体2件+展開フォルダの中身3件をすべて
      // 収めるには足りないので、フォルダの折りたたみ表示(▼ + "3枚")と中身の先頭1件が見えていれば良しとする。
      await injectLibrarySamples(page);
      await clickToolbarButton(page, 'btn-disk-library');
      await sleep(800);
      await expandLibrarySampleGroup(page);
      const libraryModal = await page.$('#library-backdrop .rom-modal');
      if (!libraryModal) throw new Error('library modal not found');
      await libraryModal.screenshot({ path: join(OUT_DIR, `library${suffix}.png`) });
      console.log(`  wrote library${suffix}.png`);
      await page.keyboard.press('Escape');
      await sleep(400);
      // 他のショット(filemanager/overview)に写り込まないよう、撮影後すぐに撤去する。
      await removeLibrarySamples(page);

      // --- filemanager: ファイル転送ダイアログ(対象はライブラリの human302.xdf) ---
      await clickToolbarButton(page, 'btn-file-manager');
      await sleep(800);
      const fmModal = await page.$('#file-manager-root .fm-modal');
      if (!fmModal) throw new Error('file manager modal not found');
      await fmModal.screenshot({ path: join(OUT_DIR, `filemanager${suffix}.png`) });
      console.log(`  wrote filemanager${suffix}.png`);
      await page.keyboard.press('Escape');
      await sleep(400);

      // --- overview: 「システムディスクで起動」でHuman68kを起動した実行中の画面 ---
      await page.reload({ waitUntil: 'networkidle2' });
      await page.bringToFront();
      await sleep(1200);
      await page.evaluate(() => {
        const btn = document.getElementById('btn-boot-system');
        if (!btn) throw new Error('btn-boot-system not found');
        btn.click();
      });
      // Human68kの起動完了(画面描画)まで、非黒ピクセルで判定して待つ。
      await sleep(20000);
      await waitForScreenPainted(page, 25000);
      await shoot(page, '.console-card', `overview${suffix}.png`);

      await page.close();
    }
  } finally {
    await browser.close();
    await rm(profile, { recursive: true, force: true });
    await stopDevServer(devServer);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
