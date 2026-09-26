// SCSI起動 段階3(docs/STORAGE-SCSI.md)の調査用: profile(ユーザーデータディレクトリ)のOPFSに
// 保存されたSCSIイメージ(scsi/scsi0.hds)を、ホスト側でFATとして検証する(_verify-scsi-fat.mts)
// ためにファイルへ書き出す。OPFSはWorker/メインスレッド問わず同一originで共有されるため、
// probe-scsi-iocs.mjs --scsi-opfs で書いたファイルをこのスクリプトが素のページから読める。
// createSyncAccessHandle()はWorker専用だが、File System Access APIのgetFile()はメインスレッド
// からも呼べるため、ここではそちらを使う(排他ロックの取得は不要)。
// 100MB級のイメージをpage.evaluate()の戻り値でシリアライズすると重いため、Blobを
// <a download>でクリックさせてChromeのダウンロード機構(CDP Page.setDownloadBehavior)経由で
// ホストのファイルへ落とす(JSON化を経由しない)。
//
// 使い方: node scripts/_export-scsi-opfs.mjs <profileDir> <port> <outFile>
// 前提: <port> で指定したdevサーバが単独で(他の検証と同時に使っていない状態で)起動していること。
// 同じdevサーバ/同じprofileを他の検証(probe-scsi-iocs.mjs等)と並行して使うと、
// お互いの保存を上書きし合い結果が偽物になる。1本ずつ順に実行すること。
import puppeteer from 'puppeteer-core';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [, , profileDir, portArg, outFile] = process.argv;
if (!profileDir || !portArg || !outFile) {
  console.error('使い方: node opfs-export.mjs <profileDir> <port> <outFile>');
  process.exit(1);
}
const PORT = Number(portArg);
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const downloadDir = await mkdtemp(join(tmpdir(), 'webx68k-opfs-dl-'));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? DEFAULT_CHROME,
  headless: true,
  userDataDir: profileDir,
  args: ['--hide-scrollbars', '--window-size=1000,900'],
});
try {
  const page = await browser.newPage();
  const client = await page.target().createCDPSession();
  await client.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
  });
  await page.goto(`http://localhost:${PORT}/?run=1`, { waitUntil: 'domcontentloaded' });
  // OPFS読み出し+ダウンロードのトリガだけできればよいので、アプリの起動完了は待たない。
  await page.waitForFunction(() => typeof navigator !== 'undefined' && !!navigator.storage, { timeout: 15000 });

  const result = await page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('scsi', { create: false });
      const fh = await dir.getFileHandle('scsi0.hds', { create: false });
      const file = await fh.getFile();
      const blob = file; // File is a Blob
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'scsi0.hds';
      document.body.appendChild(a);
      a.click();
      return { ok: true, size: file.size };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  if (!result.ok) {
    console.error(JSON.stringify(result));
    process.exit(2);
  }
  // ダウンロード完了待ち(ファイルが出現し、サイズが安定するまで)。
  const deadline = Date.now() + 60000;
  let found = null;
  while (Date.now() < deadline) {
    const entries = await readdir(downloadDir).catch(() => []);
    const candidate = entries.find((e) => e.endsWith('.hds') || e === 'scsi0.hds');
    if (candidate) {
      found = join(downloadDir, candidate);
      // .crdownload が消えるまで待つ
      const stillDownloading = entries.some((e) => e.endsWith('.crdownload'));
      if (!stillDownloading) break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!found) {
    console.error(JSON.stringify({ ok: false, error: 'ダウンロードが検出できなかった', expectedSize: result.size }));
    process.exit(2);
  }
  const buf = await readFile(found);
  await import('node:fs/promises').then((fs) => fs.writeFile(outFile, buf));
  console.log(JSON.stringify({ ok: true, expectedSize: result.size, gotSize: buf.length }));
} finally {
  await browser.close();
  await rm(downloadDir, { recursive: true, force: true }).catch(() => {});
}
