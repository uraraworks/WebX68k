// public/help/hostfs-guide/*.png (HostFS導入ガイド hostfs.html の説明用スクリーンショット) を
// 撮るスクリプト。既存の scripts/capture-help-shots.mjs (使い方ページ help.html 用) とは
// 出力先・対象ページが別なので、そちらを壊さないよう新規に分けている。ブラウザの起動設定・
// VIEWPORT・shoot/shootUnion/clickToolbarButton 等の補助関数・ファイル冒頭コメントの流儀は
// capture-help-shots.mjs から写して揃えた。
//
//   node scripts/capture-hostfs-guide-shots.mjs
//   (WEBX68K_URL=http://localhost:5192 のように dev サーバーを別途起動しておく想定。
//    このスクリプト自身は dev サーバーを起動しない — 呼び出し側が run_in_background で
//    立てたポートを渡す運用にする)
//
// 実フォルダの選択(showDirectoryPicker)はユーザー操作起点でしか開けず自動化できないため、
// page.evaluateOnNewDocument で window.showDirectoryPicker を差し替え、OPFS上のディレクトリの
// ハンドルを返すようにする(直前の実測ハーネス scratchpad/hostfs-measure/common.mjs の
// installFakeDirectoryPicker と同じ方式)。`?hostfs=opfs-test` は使わない — 起動時に自動で
// ATTACHされてしまい、「つなぐ」ボタンでモード選択ダイアログを開く手順そのものを
// 撮れなくなるため(このガイドの主眼である「つなぐ」操作を迂回してしまう)。
//
// 8種類のショットの手順は scratchpad/hostfs-measure/ の実測(RESULT.md)で確定済み:
//   1. 「…」メニュー→「表示」グループのサブメニュー(HostFSを表示トグルが見える状態)
//   2. 「つなぐ」→ モード選択ダイアログ(覚え書き記入済み)→ 読み取り専用で実際に接続
//   3. ディスクライブラリ(同梱ディスク行+「HostFSを組み込む」ボタン)
//   4. 組み込み後にライブラリへ増えた human302-hostfs.xdf の行+「FDD0へ」ボタン→実際に挿入
//   5. 起動前オーバーレイの「セットしたディスクで起動」(FDD0挿入済みなのでボタン文言が変わる)
//   6. 起動後のHostFSバナー(A>まで進み、HostFS行に警告が出ていない状態)
//   7. dir c: 実行結果(README等のファイル一覧)
//   8. 別ページで、組み込んでいない同梱ディスクで起動→接続→警告が出た状態のHostFS行
//
// 確認ダイアログ(組み込み実行前のconfirm())はブラウザ標準ダイアログなのでスクリーンショットに
// 写せない。hostfs.html の step3-install の alt 文はそれを踏まえて「確認ダイアログ」の記述を
// 外してある。
//
// 2026-09-13 全枚撮り直し(アプリ側でHostFS警告がゲスト起動中のみ出るよう修正され、警告文が
// 英語UIでは英語で出るようになったのに合わせた)。前回撮影で見つかった3件の対策を追加:
//   - step5-boot: FDD0挿入直後のトースト(「…にHostFSを組み込みました」)がまだ残っている
//     ことがあり画面に重なっていた。#toast が .hidden クラスを持つまで待ってから撮る
//     (waitForToastHidden)。あわせて起動前なのでhostfs-warningが出ていないことも確認する。
//   - step7-dir: 合成キー入力が複数パターンで化けることを実測で確認した(':' が '*' に化ける
//     ケースだけでなく、直前の大文字ドライブレターのSHIFTが抜けて"dir C:"→"dir c:"に
//     小文字化するケース、"cls"→"csl"のように文字が入れ替わるケースもあった)。対策として
//     cls・dir c: の両方を typeLineVerified() で「Enter抜きで打鍵→screenTextの最後の
//     プロンプト行("A>"で始まる行、テキスト画面最下段の罫線飾りではない)が期待と大小文字
//     区別なしで一致するか確認→一致しなければ Backspace で行を消して打ち直す」方式にした。
//     ESCキーはHuman68kのCOMMAND.Xでは行クリアではなく"^C"表示のキャンセル扱いになり行が
//     消えずに残ることを実測で確認した(2026-09-13)ため使わない。打ち直し回数はログに残す。
//   - warning: 警告文言が言語どおりか(日本語/英語)をDOMのtextContentで照合してから撮る。

import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const BASE_URL = process.env.WEBX68K_URL ?? 'http://localhost:5192';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR = new URL('../public/help/hostfs-guide/', import.meta.url).pathname;

// OPFS上に用意する、フォルダ接続用の検体ディレクトリ名と、中に置くファイル。
// 説明用として自然な名前にする(実測ハーネスのHELLO.TXT一本だけでなく、複数ファイルを
// 置いて「一覧表示」らしい絵にする)。
const HOSTFS_TEST_DIR = 'my-project';
const HOSTFS_NOTE = 'Win の D:\\dev\\my-project';
const SEED_FILES = [
  { name: 'README.TXT', body: 'HostFS guide sample folder.\r\nThis is README.TXT.\r\n' },
  { name: 'HELLO.BAS', body: '10 PRINT "HELLO"\r\n20 END\r\n' },
  { name: 'MEMO.TXT', body: 'memo: capture-hostfs-guide-shots.mjs sample file.\r\n' },
];

/** 既存の使い方ページのショットと同じ寸法になるビューポート(2倍解像度で保存する)。 */
const VIEWPORT = { width: 900, height: 700, deviceScaleFactor: 2 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(page, selector, file) {
  const el = await page.$(selector);
  if (!el) throw new Error(`element not found: ${selector} (for ${file})`);
  await el.screenshot({ path: join(OUT_DIR, file) });
  console.log(`  wrote ${file}`);
}

/**
 * 複数セレクタの要素の和(バウンディングボックスの外接矩形)を1枚として撮る。
 * position:fixed の要素(メニュー/モーダル)は要素スクリーンショットでは他要素の下に
 * 隠れて写らないことがあるため、clip 指定で撮る(capture-help-shots.mjs の shootUnion と同じ)。
 */
async function shootUnion(page, selectors, file, padding = 12, options = {}) {
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
  // captureBeyondViewport の既定(true)はページ全体を描き直すため、position:fixed の
  // モーダル/メニューが無言で消えた画像が保存される。呼び出し側で false を渡すこと。
  await page.screenshot({ path: join(OUT_DIR, file), clip, ...options });
  console.log(`  wrote ${file}`);
}

async function clickId(page, id) {
  const ok = await page.evaluate((elId) => {
    const el = document.getElementById(elId);
    if (!el) return false;
    el.click();
    return true;
  }, id);
  if (!ok) throw new Error(`element not found: #${id}`);
}

async function clickToolbarButton(page, id) {
  await clickId(page, id);
  await sleep(600);
}

/** showDirectoryPicker を差し替え、OPFS上の HOSTFS_TEST_DIR のハンドルを返すようにする。 */
async function installFakeDirectoryPicker(page) {
  await page.evaluateOnNewDocument((dirName) => {
    globalThis.showDirectoryPicker = async (_opts) => {
      const root = await navigator.storage.getDirectory();
      return await root.getDirectoryHandle(dirName, { create: true });
    };
  }, HOSTFS_TEST_DIR);
}

/** OPFS上に検体ディレクトリとファイル数点を作る(ナビゲーション後、ページのコンテキストで実行)。 */
async function seedOpfsFiles(page, files) {
  await page.evaluate(
    async (dirName, files) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(dirName, { create: true });
      for (const f of files) {
        const fh = await dir.getFileHandle(f.name, { create: true });
        const w = await fh.createWritable();
        await w.write(f.body);
        await w.close();
      }
    },
    HOSTFS_TEST_DIR,
    files,
  );
}

async function screenText(page) {
  return page.evaluate(async () => {
    const dump = await window.__webx68kDebug.screenText();
    return dump?.lines ?? [];
  });
}

async function typeText(page, text) {
  return page.evaluate((t) => window.__webx68kBridge.exec('type_text', { text: t }), text);
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

/** #toast が .hidden クラスを持つ(=表示されていない)まで待つ。 */
async function waitForToastHidden(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hidden = await page.evaluate(() => {
      const el = document.getElementById('toast');
      return !el || el.classList.contains('hidden');
    });
    if (hidden) return;
    if (Date.now() > deadline) throw new Error('toast did not become hidden in time');
    await sleep(300);
  }
}

/** 画面上に "A>" プロンプトが出るまで待つ(Human68kの起動完了判定)。 */
async function waitForBootPrompt(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastLines = null;
  for (;;) {
    const lines = await screenText(page).catch(() => null);
    if (lines) {
      lastLines = lines;
      if (lines.some((l) => /^[A-Z]>/.test(l.trim()) || l.includes('A>'))) {
        await sleep(700); // 検出直後は表示がまだ確定していないことがあるため一呼吸置く
        return await screenText(page);
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`A>プロンプトが出ないままタイムアウトしました。最後の画面: ${JSON.stringify(lastLines)}`);
    }
    await sleep(500);
  }
}

/**
 * 画面の最後の「プロンプト行」("A>"等で始まる行)を返す。screenText の最終行は常に
 * テキスト画面下端の罫線飾り(非空だが無関係な文字列)なので、末尾から素直に非空行を
 * 拾うとそれを掴んでしまう(2026-09-13に実際に発覚)。プロンプト行だけを狙って拾う。
 */
function lastPromptLine(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (/^[A-Z]>/.test(t)) return t;
  }
  return '';
}

/**
 * 1行をEnter抜きで打鍵し、エコーが期待どおりか確認してからEnterを送る(まれに合成入力が
 * スクランブルされるため)。実測で確認できた化け方は複数あり、
 *   - ':' が '*' に化ける(同じ物理キーでshift有無だけが違うため)
 *   - 直前の大文字のシフトが抜けて小文字化する(例: "dir C:"→"dir c:")
 *   - 文字の入れ替わり(例: "cls"→"csl")
 * のいずれも「打った行が期待と違う」という形で現れるので、比較は大小文字を区別せず行い、
 * 一致しなければ ESC ではなく Backspace で行を消して打ち直す(Human68kのCOMMAND.Xは
 * ESCキーを行クリアではなく"^C"表示のキャンセル扱いにして行が残ってしまうため、実測で
 * ESC方式は使えないと判明した — 2026-09-13)。
 */
async function typeLineVerified(page, text, maxAttempts = 6) {
  const expected = `A>${text}`.toLowerCase();
  let retypes = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await typeText(page, text); // Enterなし
    await sleep(700);
    const lines = await screenText(page);
    const last = lastPromptLine(lines).toLowerCase();
    if (last === expected) {
      await typeText(page, '\r');
      await sleep(1000);
      return { ok: true, retypes, lines: await screenText(page) };
    }
    if (attempt === maxAttempts) {
      return { ok: false, retypes, lines };
    }
    const steps = Array.from({ length: text.length + 10 }, () => ({ code: 8, ms: 40 })); // Backspace
    await page.evaluate((s) => window.__webx68kBridge.exec('key_sequence', { steps: s }), steps);
    await sleep(400);
    retypes++;
  }
  return { ok: false, retypes, lines: await screenText(page) };
}

/** dir コマンドを打鍵する。cls も含め、両方とも typeLineVerified で確認しながら打つ。 */
async function runDirCommandReliable(page, drive, maxAttempts = 6) {
  const clsResult = await typeLineVerified(page, 'cls', maxAttempts);
  if (!clsResult.ok) {
    return { ok: false, retypes: clsResult.retypes, lines: clsResult.lines, failedAt: 'cls' };
  }
  const cmd = `dir ${drive}:`;
  const dirResult = await typeLineVerified(page, cmd, maxAttempts);
  return {
    ok: dirResult.ok,
    retypes: clsResult.retypes + dirResult.retypes,
    lines: dirResult.lines,
    failedAt: dirResult.ok ? undefined : 'dir',
  };
}

/** ディスクライブラリの行から、textContent が指定文字列を含むボタンを押す。 */
async function clickLibraryButtonByText(page, includesText) {
  return page.evaluate((text) => {
    const rows = Array.from(document.querySelectorAll('.library-list-item'));
    for (const row of rows) {
      const btn = Array.from(row.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
      if (btn) {
        btn.click();
        return row.querySelector('.library-item-name')?.textContent ?? 'unknown';
      }
    }
    return null;
  }, includesText);
}

async function launchBrowser() {
  const profile = await mkdtemp(join(tmpdir(), 'webx68k-hostfs-guide-'));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    userDataDir: profile,
    // headless だと requestAnimationFrame がスロットルされ画面が真っ黒になるため、
    // 必ずヘッドフルで起動する。
    headless: false,
    args: ['--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=1000,900'],
  });
  return { browser, profile };
}

async function run() {
  await mkdir(OUT_DIR, { recursive: true });

  {
    for (const lang of ['ja', 'en']) {
      const suffix = lang === 'ja' ? '' : '-en';
      const installLabel = lang === 'ja' ? '組み込む' : 'Install';
      const fdd0Label = lang === 'ja' ? 'FDD0' : 'FDD0';
      console.log(`[${lang}]`);
      // ja/en を同じブラウザプロファイルで撮ると、ja周回で組み込んだ human302-hostfs.xdf が
      // IndexedDB(webx68k-disks)に残ったまま en 周回のライブラリを開くことになり、
      // step3-install が「組み込み前」の絵にならない(2026-09-13に実際に発覚)。
      // 各言語ごとに毎回まっさらなプロファイルで起動する。
      const { browser, profile } = await launchBrowser();
      const page = await browser.newPage();
      await page.setViewport(VIEWPORT);
      await page.bringToFront();
      page.on('dialog', (dialog) => {
        dialog.accept().catch(() => {});
      });
      await installFakeDirectoryPicker(page);

      await page.goto(`${BASE_URL}/?lang=${lang}&bridge=1`, { waitUntil: 'networkidle2' });
      await page.bringToFront();
      await sleep(1000);
      await seedOpfsFiles(page, SEED_FILES);

      // --- step1-show-row: 「…」メニュー→「表示」グループのサブメニュー ---
      // menu ショット(capture-help-shots.mjs)と同じ理由で、狭いビューポートだと
      // サブメニューが左反転してしまうため、開く前にビューポートを広げて落ち着くまで待つ。
      await page.setViewport({ ...VIEWPORT, width: 1280 });
      await sleep(600);
      await clickToolbarButton(page, 'btn-toolbar-overflow');
      await sleep(300);
      await page.evaluate(() => {
        const row = document.querySelector('#slot-popup-menu .library-menu-item.group');
        if (!row) throw new Error('overflow menu group row (display) not found');
        row.click();
      });
      await sleep(300);
      await page.evaluate(() => {
        const parent = document.querySelector('#slot-popup-menu');
        const sub = document.querySelector('#overflow-submenu');
        if (!parent || !sub) throw new Error('menu elements not found');
        if (sub.hidden) throw new Error('overflow submenu is hidden');
      });
      await shootUnion(
        page,
        ['.console-card', '#slot-popup-menu', '#overflow-submenu'],
        `step1-show-row${suffix}.png`,
        12,
        { captureBeyondViewport: false },
      );
      await page.keyboard.press('Escape');
      await sleep(300);
      await page.setViewport(VIEWPORT);
      await sleep(400);

      // --- step2-connect: 「つなぐ」ダイアログ(覚え書き記入済み)。撮影後は「読み取り専用」で
      //     実際に接続する(差し替えた showDirectoryPicker が OPFS の検体を返す)。 ---
      await clickId(page, 'btn-connect-hostfs');
      await sleep(300);
      await page.evaluate((note) => {
        const input = document.getElementById('hostfs-mode-note');
        if (!input) throw new Error('hostfs-mode-note not found');
        input.value = note;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, HOSTFS_NOTE);
      await shootUnion(page, ['#hostfs-mode-backdrop .rom-modal'], `step2-connect${suffix}.png`, 12, {
        captureBeyondViewport: false,
      });
      await clickId(page, 'hostfs-mode-readonly');
      await sleep(600);
      const uiStateAfterConnect = await page.evaluate(() => window.__webx68kDebug.hostfsUiState());
      if (!uiStateAfterConnect?.connected) {
        throw new Error(`connect failed: ${JSON.stringify(uiStateAfterConnect)}`);
      }

      // --- step3-install: ディスクライブラリ(同梱ディスク行+「HostFSを組み込む」ボタン) ---
      await clickToolbarButton(page, 'btn-disk-library');
      await sleep(500);
      await page.evaluate((label) => {
        const rows = Array.from(document.querySelectorAll('.library-list-item'));
        const bundled = rows.find((r) => r.querySelector('.library-item-badge.bundled'));
        if (!bundled) throw new Error('bundled disk row not found');
        const installBtn = Array.from(bundled.querySelectorAll('button')).find((b) =>
          b.textContent?.includes(label),
        );
        if (!installBtn) throw new Error('install-hostfs button not found on bundled row');
      }, installLabel);
      const libraryModal1 = await page.$('#library-backdrop .rom-modal');
      if (!libraryModal1) throw new Error('library modal not found (step3)');
      await libraryModal1.screenshot({ path: join(OUT_DIR, `step3-install${suffix}.png`) });
      console.log(`  wrote step3-install${suffix}.png`);

      // 確認ダイアログ(標準confirm、page.on('dialog')が自動acceptする)を経て実行。
      const installedRowName = await clickLibraryButtonByText(page, installLabel);
      if (!installedRowName) throw new Error('failed to click install-hostfs button');
      await sleep(600);

      // --- step4-insert: 増えた human302-hostfs.xdf の行+「FDD0へ」ボタン。撮影後「FDD0へ」を押す ---
      await page.evaluate((label) => {
        const rows = Array.from(document.querySelectorAll('.library-list-item'));
        const target = rows.find((r) => r.querySelector('.library-item-name')?.textContent?.toLowerCase().includes('hostfs'));
        if (!target) throw new Error('human302-hostfs row not found');
        const fdd0Btn = Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
        if (!fdd0Btn) throw new Error('FDD0 insert button not found on hostfs row');
      }, fdd0Label);
      const libraryModal2 = await page.$('#library-backdrop .rom-modal');
      if (!libraryModal2) throw new Error('library modal not found (step4)');
      await libraryModal2.screenshot({ path: join(OUT_DIR, `step4-insert${suffix}.png`) });
      console.log(`  wrote step4-insert${suffix}.png`);

      const insertResult = await page.evaluate((label) => {
        const rows = Array.from(document.querySelectorAll('.library-list-item'));
        const target = rows.find((r) => r.querySelector('.library-item-name')?.textContent?.toLowerCase().includes('hostfs'));
        if (!target) return { ok: false, reason: 'row not found' };
        const fdd0Btn = Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
        if (!fdd0Btn) return { ok: false, reason: 'button not found' };
        fdd0Btn.click();
        return { ok: true };
      }, fdd0Label);
      if (!insertResult.ok) throw new Error(`FDD0 insert failed: ${JSON.stringify(insertResult)}`);
      await sleep(600);

      // --- step5-boot: 起動前オーバーレイの「セットしたディスクで起動」 ---
      // FDD0挿入直後の「組み込みました」トーストがまだ画面に重なっていることがあるため、
      // #toast が.hiddenになるまで待ってから撮る。あわせて起動前(まだrunning===false)
      // なのでhostfs-warningが出ていないことをDOMで確認する。
      const bootPlainLabel = await page.evaluate(() => document.getElementById('btn-boot-plain')?.textContent);
      console.log(`  btn-boot-plain label: ${bootPlainLabel}`);
      await waitForToastHidden(page, 8000);
      await page.evaluate(() => {
        const warning = document.getElementById('hostfs-warning');
        if (warning && !warning.hidden) {
          throw new Error('hostfs-warning is shown for step5-boot (expected hidden, guest not booted yet)');
        }
      });
      await shoot(page, '.console-card', `step5-boot${suffix}.png`);

      // --- step6-banner: 起動し、HostFSバナーが出て A> まで進んだ状態 ---
      await clickId(page, 'btn-boot-plain');
      await waitForScreenPainted(page, 40000);
      const dump = await waitForBootPrompt(page, 45000);
      const bannerOk = dump.some((l) => l.includes('HostFS')) && dump.some((l) => l.includes('割り当てました') || l.toLowerCase().includes('assign'));
      if (!bannerOk) {
        throw new Error(`HostFS banner not found in boot screen: ${JSON.stringify(dump)}`);
      }
      // #screen canvas の非黒ピクセル数、および HostFS 行に警告が出ていないことを確認する。
      await page.evaluate(() => {
        const canvas = document.getElementById('screen');
        const ctx = canvas.getContext('2d');
        const { width, height } = canvas;
        const data = ctx.getImageData(0, 0, width, height).data;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] > 8 || data[i + 1] > 8 || data[i + 2] > 8) count++;
        }
        if (count <= 2000) throw new Error(`screen still mostly black (nonBlack=${count})`);
        const warning = document.getElementById('hostfs-warning');
        if (warning && !warning.hidden) {
          throw new Error('hostfs-warning is shown for step6-banner (expected hidden)');
        }
      });
      await shoot(page, '.console-card', `step6-banner${suffix}.png`);

      // --- step7-dir: dir c: を打鍵し、ファイル一覧が出たことを確認してから撮る ---
      const uiState = await page.evaluate(() => window.__webx68kDebug.hostfsUiState());
      const driveLetter = uiState?.driveNumber != null ? String.fromCharCode(65 + uiState.driveNumber) : 'C';
      const dirResult = await runDirCommandReliable(page, driveLetter);
      if (!dirResult.ok) {
        throw new Error(
          `dir ${driveLetter}: echo not confirmed (${dirResult.failedAt}の最終行が一致せず): ${JSON.stringify(dirResult.lines)}`,
        );
      }
      console.log(`  [${lang}] dir ${driveLetter}: 打ち直し回数=${dirResult.retypes}`);
      const hasReadme = dirResult.lines.some((l) => l.includes('README'));
      if (!hasReadme) {
        throw new Error(`dir output does not contain README: ${JSON.stringify(dirResult.lines.slice(-20))}`);
      }
      // 化けたまま実行された過去のコマンド行(cls等)は cls\r で毎回消しているので、
      // ここで数えるのは最終画面上の「dir 〜:」表記の出現回数(大小文字を区別しない)。
      const dirLineRe = new RegExp(`dir\\s+${driveLetter}:`, 'i');
      const cmdOccurrences = dirResult.lines.filter((l) => dirLineRe.test(l)).length;
      if (cmdOccurrences !== 1) {
        throw new Error(
          `dir command should appear exactly once, found ${cmdOccurrences}: ${JSON.stringify(dirResult.lines)}`,
        );
      }
      await shoot(page, '.console-card', `step7-dir${suffix}.png`);

      await browser.close();
      await rm(profile, { recursive: true, force: true });
    }

    // --- warning: 別のまっさらなプロファイル。組み込んでいない同梱ディスクで起動→フォルダ接続→警告 ---
    for (const lang of ['ja', 'en']) {
      const suffix = lang === 'ja' ? '' : '-en';
      console.log(`[${lang}] warning`);
      const { browser, profile } = await launchBrowser();
      const page = await browser.newPage();
      await page.setViewport(VIEWPORT);
      await page.bringToFront();
      page.on('dialog', (dialog) => {
        dialog.accept().catch(() => {});
      });
      await installFakeDirectoryPicker(page);
      await page.goto(`${BASE_URL}/?lang=${lang}&bridge=1`, { waitUntil: 'networkidle2' });
      await page.bringToFront();
      await sleep(1000);
      await seedOpfsFiles(page, SEED_FILES);

      // 「システムディスクで起動」(組み込みなしのhuman302.xdfそのまま)
      await clickId(page, 'btn-boot-system');
      await waitForScreenPainted(page, 40000);
      await waitForBootPrompt(page, 45000);
      await sleep(400);

      // 起動後にフォルダを接続する
      await clickId(page, 'btn-connect-hostfs');
      await sleep(300);
      await clickId(page, 'hostfs-mode-readonly');
      await sleep(700);

      // HostFS行に警告が、かつ言語どおりの文言で出ていることをDOMで確認してから撮る。
      const expectedWarningText =
        lang === 'ja' ? '⚠ ゲストで HOSTFS.SYS が読み込まれていません' : '⚠ HOSTFS.SYS is not loaded in the guest';
      await page.evaluate(
        (expected) => {
          const row = document.getElementById('slot-hostfs');
          if (!row || row.hidden) throw new Error('hostfs row not visible for warning shot');
          const warning = document.getElementById('hostfs-warning');
          if (!warning || warning.hidden) {
            throw new Error('hostfs-warning is not shown (expected visible) for warning shot');
          }
          if (warning.textContent !== expected) {
            throw new Error(`hostfs-warning text mismatch: got "${warning.textContent}", expected "${expected}"`);
          }
        },
        expectedWarningText,
      );
      await shootUnion(page, ['#slot-hostfs'], `warning${suffix}.png`, 12, {
        captureBeyondViewport: false,
      });

      await browser.close();
      await rm(profile, { recursive: true, force: true });
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
