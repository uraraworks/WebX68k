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

/**
 * 複数セレクタの要素の和(バウンディングボックスの外接矩形)を1枚として撮る。
 * #slot-popup-menu / #overflow-submenu は body 直下の絶対配置(fixed/absolute)要素なので、
 * 要素スクリーンショット(shoot())では他要素の下に隠れて写らない。clip 指定で撮る必要がある。
 *
 * バウンディングボックスの和をそのままクリップ範囲にすると、要素の端(メニューの枠線)が
 * 画像の端とぴったり一致し、枠が切れているように見えてしまう。そのため padding 分だけ
 * 四辺を広げる。ただしページ範囲の外へはみ出すと puppeteer の screenshot がエラーになる
 * ため、ページの実サイズ(document.documentElement.scrollWidth/Height)でクランプする。
 */
async function shootUnion(page, selectors, file, padding = 12) {
  const clip = await page.evaluate(
    (sels, pad) => {
      let left = Infinity;
      let top = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`element not found: ${sel}`);
        const rect = el.getBoundingClientRect();
        left = Math.min(left, rect.left);
        top = Math.min(top, rect.top);
        right = Math.max(right, rect.right);
        bottom = Math.max(bottom, rect.bottom);
      }
      const pageWidth = document.documentElement.scrollWidth;
      const pageHeight = document.documentElement.scrollHeight;
      const clampedLeft = Math.max(0, left - pad);
      const clampedTop = Math.max(0, top - pad);
      const clampedRight = Math.min(pageWidth, right + pad);
      const clampedBottom = Math.min(pageHeight, bottom + pad);
      return {
        x: clampedLeft,
        y: clampedTop,
        width: clampedRight - clampedLeft,
        height: clampedBottom - clampedTop,
      };
    },
    selectors,
    padding,
  );
  await page.screenshot({ path: join(OUT_DIR, file), clip });
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

/**
 * gamepad ショットの直前だけ、navigator.getGamepads() を standard mapping の偽パッド
 * (buttons 17個・axes 4個、いくつか押下/傾け状態)に差し替える。パッドが繋がっていない
 * 撮影環境でもジョイスティック設定ダイアログの見た目を撮れるようにするため
 * (library ショットの直前だけ IndexedDB へサンプルを注入する既存の前例と同じ考え方)。
 * gamepad-ui.ts のダイアログは毎フレーム navigator.getGamepads() を直接読むだけなので、
 * gamepadconnected イベントの発火は不要。
 */
async function injectFakeGamepad(page) {
  await page.evaluate(() => {
    function makeButton(pressed) {
      return { pressed, touched: pressed, value: pressed ? 1 : 0 };
    }
    const fakePad = {
      id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
      index: 0,
      connected: true,
      mapping: 'standard',
      timestamp: performance.now(),
      // axes[1](左スティック縦)を大きく傾けておき、ライブ表示が光っている絵にする。
      axes: [0, -0.9, 0, 0],
      buttons: Array.from({ length: 17 }, (_, i) => makeButton(i === 0 || i === 9 || i === 12)),
      vibrationActuator: null,
    };
    window.__origGetGamepads = navigator.getGamepads.bind(navigator);
    navigator.getGamepads = () => [fakePad, null, null, null];
  });
}

/** injectFakeGamepad() で差し替えた navigator.getGamepads を元に戻す。 */
async function removeFakeGamepad(page) {
  await page.evaluate(() => {
    if (window.__origGetGamepads) {
      navigator.getGamepads = window.__origGetGamepads;
      delete window.__origGetGamepads;
    }
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

      // --- gamepad: ジョイスティック設定ダイアログ(撮影直前だけ偽パッドを1台繋いだことにする) ---
      await injectFakeGamepad(page);
      await clickToolbarButton(page, 'btn-gamepad');
      await sleep(800);
      const gpModal = await page.$('#gamepad-root .gp-modal');
      if (!gpModal) throw new Error('gamepad modal not found');
      await gpModal.screenshot({ path: join(OUT_DIR, `gamepad${suffix}.png`) });
      console.log(`  wrote gamepad${suffix}.png`);
      await page.keyboard.press('Escape');
      await sleep(400);
      await removeFakeGamepad(page);

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

      // --- menu: 「…」オーバーフローメニュー(overviewで起動済みのHuman68k画面を流用)。
      //     先頭グループ(表示)行を押し、右にカスケードしたサブメニューごと撮る。
      //     グループ行の並び順は main.ts の OVERFLOW_GROUP_ORDER で固定されており、
      //     「表示」は言語に関わらず必ず先頭なので、ラベル文字列に頼らず
      //     `.library-menu-item.group` の1番目を選べば日英どちらでも同じ行を掴める。
      //
      // 通常のビューポート(900px幅)だと親メニューの右端が画面端に近く、実装の
      // 「右端からはみ出す場合は左に反転する」条件に入ってサブメニューが親の左側に
      // 開いてしまう。使い方ページの本文は「右側に開く」と説明しているため、図が
      // 本文と矛盾しないよう、このショットの撮影中だけビューポートを広げて標準の
      // 右開き挙動を撮る(keyboard ショットが縦だけ一時的に広げる前例に倣う)。
      await page.setViewport({ ...VIEWPORT, width: 1280 });
      await clickToolbarButton(page, 'btn-toolbar-overflow');
      await sleep(300);
      await page.evaluate(() => {
        const row = document.querySelector('#slot-popup-menu .library-menu-item.group');
        if (!row) throw new Error('overflow menu group row not found');
        row.click();
      });
      await sleep(300);
      // ガード: サブメニューが実際に親メニューの右側に開いていることを検証する。
      // ここが崩れると「右に開く」と説明する本文と食い違う図が黙って出力されてしまうため、
      // 警告ではなく例外にして撮影自体を失敗させる。
      await page.evaluate(() => {
        const parent = document.querySelector('#slot-popup-menu');
        const sub = document.querySelector('#overflow-submenu');
        if (!parent || !sub) throw new Error('menu elements not found for right-open check');
        const parentRect = parent.getBoundingClientRect();
        const subRect = sub.getBoundingClientRect();
        // 実装は left を Math.round(parentRect.right) で丸めて設定するため、sub-pixel
        // 分だけ subRect.left が parentRect.right をわずかに下回ることがある(数値誤差)。
        // それは「左反転」ではないので、2pxの許容誤差を設けて誤検知しないようにする。
        if (subRect.left < parentRect.right - 2) {
          throw new Error(
            `submenu did not open to the right of the parent menu (parent.right=${parentRect.right}, sub.left=${subRect.left}); widen the viewport`,
          );
        }
      });
      await shootUnion(
        page,
        ['.console-card', '#slot-popup-menu', '#overflow-submenu'],
        `menu${suffix}.png`,
      );
      // メニューを閉じてから次のショット(keyboard)へ進む。
      await page.keyboard.press('Escape');
      await sleep(300);
      await page.setViewport(VIEWPORT);

      // --- keyboard: 仮想キーボードパネル(overviewで起動済みのHuman68k画面を流用) ---
      // 仮想キーボードを開くと .console-card の縦が伸びてビューポート(700px)に収まらないため、
      // 撮影中だけ縦を1100pxに広げる。
      await page.setViewport({ ...VIEWPORT, height: 1100 });
      await clickToolbarButton(page, 'btn-virtual-keyboard');
      await sleep(400);
      await shoot(page, '.console-card', `keyboard${suffix}.png`);
      await clickToolbarButton(page, 'btn-virtual-keyboard');
      await page.setViewport(VIEWPORT);

      // --- virtualpad: バーチャルパッド(縦持ち相当のパネル配置) ---
      // 縦持ち(幅<高さ、375x812)にすると画面下に余白ができ、仮想キーボードと同じ帯状の
      // "panel" 配置が自動で選ばれる(表示位置は実測値から決まる。src/virtual-pad.ts 参照)。
      // 入力パネルの既定側(⌨/🎮)は前回選んだ側が localStorage(webx68k.inputPanel)に残るため、
      // 同じブラウザプロファイルを使い回す ja/en の2周目以降は⌨側が既定とは限らない。
      // 🎮チップは「パッドが非表示なら切替、表示済みならプロファイル選択メニューを開く」という
      // 状態依存の役割を持つ(main.ts の btnPanelPad ハンドラ参照)ため、決め打ちで2回押すと
      // 2周目にメニューが開いてしまう。実際にパッドが表示されているかをDOMで見てから
      // 必要な場合だけ押す。
      await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2 });
      await clickToolbarButton(page, 'btn-virtual-keyboard'); // 入力パネルを開く(前回選択側)
      const padAlreadyShown = await page.evaluate(() => {
        const pad = document.getElementById('virtual-pad');
        return !!pad && !pad.classList.contains('hidden');
      });
      if (!padAlreadyShown) {
        await clickToolbarButton(page, 'btn-panel-pad'); // 🎮側へ切替
      }
      await shoot(page, '.console-card', `virtualpad${suffix}.png`);

      // --- virtualpad-sides: バーチャルパッド(横持ちの左右配置) ---
      // 横持ち(812x375)+疑似フルスクリーンにすると、画面の左右に余白ができ "sides" 配置が
      // 自動で選ばれる。ただし .console-card:fullscreen は width:100vw;height:100vh で
      // ビューポート全体を埋める実装(style.css)のため、ネイティブ全画面では左右の余白が
      // 常に0になり sides 判定に絶対到達しない(実測して判明)。実機のiPhone Safariが
      // <video>以外のFullscreen APIを持たない(main.ts のコメント参照)のと同じ状況を
      // 作るため、nativeFullscreenSupported() が見る document.fullscreenEnabled を
      // false に差し替えてからボタンを押す(navigator.getGamepads を差し替える
      // injectFakeGamepad() と同じ「テスト環境に無いハードウェア/APIを模す」考え方)。
      // これにより click ハンドラは最初からtogglePseudoFullscreen()の分岐を通る。
      await page.setViewport({ width: 812, height: 375, deviceScaleFactor: 2 });
      await page.evaluate(() => {
        Object.defineProperty(document, 'fullscreenEnabled', { get: () => false, configurable: true });
      });
      await clickToolbarButton(page, 'btn-fullscreen');
      const enteredPseudoFullscreen = await page.evaluate(() =>
        document.body.classList.contains('pseudo-fullscreen'),
      );
      if (!enteredPseudoFullscreen) {
        throw new Error('pseudo-fullscreen に入りませんでした(virtualpad-sides 撮影に必要)');
      }
      await sleep(300); // sides レイアウトの再計算を待つ
      await page.screenshot({ path: join(OUT_DIR, `virtualpad-sides${suffix}.png`) });
      console.log(`  wrote virtualpad-sides${suffix}.png`);
      await clickToolbarButton(page, 'btn-fullscreen'); // 疑似フルスクリーンを解除
      await sleep(300);
      await page.setViewport(VIEWPORT);

      // --- vpad-editor: バーチャルパッドの割当編集ダイアログ ---
      // パッドは virtualpad ショットからずっと表示中(閉じていない)ので、🎮チップを押すと
      // 「切替」ではなくプロファイル選択メニューが開く(main.ts の btnPanelPad ハンドラ参照)。
      await clickToolbarButton(page, 'btn-panel-pad');
      await page.evaluate(() => {
        // メニュー末尾の「割当を編集…」行を、文言に頼らず(日英どちらでも同じ位置になる)
        // 最後の .library-menu-item として掴む(区切り線 div は class が違うので混ざらない)。
        const rows = document.querySelectorAll('#slot-popup-menu .library-menu-item');
        const editRow = rows[rows.length - 1];
        if (!editRow) throw new Error('vpad edit-assignments menu row not found');
        editRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await sleep(400);
      const vpadEditorModal = await page.$('#input-profile-root .gp-modal');
      if (!vpadEditorModal) throw new Error('input profile editor modal not found');
      await vpadEditorModal.screenshot({ path: join(OUT_DIR, `vpad-editor${suffix}.png`) });
      console.log(`  wrote vpad-editor${suffix}.png`);
      await page.keyboard.press('Escape');
      await sleep(300);

      // --- trackpad: バーチャルトラックパッド(入力パネル第3の種類) ---
      // バーチャルパッドがまだ表示中なので、🖱チップを押してトラックパッドへ切り替える。
      // 🖱チップは⌨/🎮と違って状態依存の役割を持たない(main.ts の btnPanelTrackpad ハンドラ
      // 参照: 常に openInputPanel('trackpad') を呼ぶだけ)が、念のため virtualpad ショットと
      // 同じ「実際に表示されているかをDOMで見てから必要な場合だけ押す」方式に揃える。
      await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2 });
      const trackpadAlreadyShown = await page.evaluate(() => {
        const el = document.getElementById('virtual-trackpad');
        return !!el && !el.classList.contains('hidden');
      });
      if (!trackpadAlreadyShown) {
        await clickToolbarButton(page, 'btn-panel-trackpad'); // 🖱側へ切替
      }
      await sleep(300);
      await shoot(page, '.console-card', `trackpad${suffix}.png`);

      await clickToolbarButton(page, 'btn-virtual-keyboard'); // 入力パネルを閉じる(後続に影響させない)
      await page.setViewport(VIEWPORT); // 後続(hostkeyショット等)へ影響させない

      // --- hostkey: 物理キーボード→ジョイスティック割当ダイアログ ---
      await clickToolbarButton(page, 'btn-hostkey');
      await sleep(400);
      const hostkeyModal = await page.$('#hostkey-root .gp-modal');
      if (!hostkeyModal) throw new Error('hostkey modal not found');
      await hostkeyModal.screenshot({ path: join(OUT_DIR, `hostkey${suffix}.png`) });
      console.log(`  wrote hostkey${suffix}.png`);
      await page.keyboard.press('Escape');
      await sleep(300);

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
