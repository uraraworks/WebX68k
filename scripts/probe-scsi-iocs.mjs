// SCSI IOCS ($F5) の呼び出しを実測するプローブ。
//
// px68k の外部SCSIボードROMスタブは SCSI IOCS 呼び出しを "move.b d1, $e9f800" として
// 外へ出すが、この番地はメモリ書き込み表で wm_nop に落ちており、呼び出しは黙って
// 捨てられていた。コア側 (x68k/scsi.c の SCSI_IOCSPort_Write) に「動作を変えず
// ログだけ取る」フックを入れたうえで、起動中にどのコマンドがどんな引数で来るかを数える。
//
// 使い方:
//   node scripts/probe-scsi-iocs.mjs [--port=5311] [--timeout=60000]
//
// 出力は JSON (stdout)。コンソールの生行も含める。

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

// 注意: vite dev は既定で [::1] にのみ bind するため、接続先は 127.0.0.1 ではなく localhost。

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([a-z-]+)(?:=(.+))?$/.exec(a);
    if (!m) throw new Error(`不明な引数です: ${a}`);
    return [m[1], m[2] ?? 'true'];
  }),
);
const PORT = Number(args.port ?? 5311);
const TIMEOUT = Number(args.timeout ?? 60000);

async function startServer(port) {
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
  let ready = false;
  let log = '';
  const inspect = (b) => {
    log += b.toString();
    if (/ready in|Local:\s+http/.test(log)) ready = true;
  };
  child.stdout.on('data', inspect);
  child.stderr.on('data', inspect);
  const deadline = Date.now() + 20000;
  while (!ready && child.exitCode === null && Date.now() < deadline) await sleep(300);
  if (!ready) {
    child.kill('SIGTERM');
    throw new Error(`dev server を起動できませんでした: ${log.trim()}`);
  }
  await sleep(500);
  return child;
}

// "[SCSI-IOCS] #1 adr=$00e9f800 cmd=$21 d1=... pc=$..." を構造化する。
function parseLine(line) {
  const m = /\[SCSI-IOCS\] #(\d+) adr=\$([0-9a-f]+) cmd=\$([0-9a-f]+) d1=\$([0-9a-f]+) d2=\$([0-9a-f]+) d3=\$([0-9a-f]+) d4=\$([0-9a-f]+) d5=\$([0-9a-f]+) a1=\$([0-9a-f]+) pc=\$([0-9a-f]+)/.exec(
    line,
  );
  if (!m) return null;
  return {
    seq: Number(m[1]),
    adr: `$${m[2]}`,
    cmd: `$${m[3]}`,
    d1: `$${m[4]}`,
    d2: `$${m[5]}`,
    d3: `$${m[6]}`,
    d4: `$${m[7]}`,
    d5: `$${m[8]}`,
    a1: `$${m[9]}`,
    pc: `$${m[10]}`,
  };
}

let server;
let browser;
let profile;
try {
  server = await startServer(PORT);
  profile = await mkdtemp(join(tmpdir(), 'webx68k-probe-scsi-'));
  // Chrome の起動待ちタイムアウト(docs/STORAGE-SCSI.md 宿題20)が実際に出るため、
  // 待ち時間を延ばしたうえで1回だけ再試行する。原因は未特定であり、これは回避策である。
  const launchOnce = () =>
    puppeteer.launch({
      executablePath: args['chrome'] ?? DEFAULT_CHROME,
      userDataDir: profile,
      // headless では rAF がスロットルされ、ゲストがほとんど進まない。
      headless: false,
      timeout: 90000,
      args: ['--hide-scrollbars', '--window-size=1000,900'],
    });
  try {
    browser = await launchOnce();
  } catch (err) {
    console.error(`[probe] Chrome 起動に失敗したので再試行します: ${err.message}`);
    await sleep(2000);
    browser = await launchOnce();
  }
  const page = await browser.newPage();
  const raw = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[SCSI-IOCS]')) raw.push(text);
  });
  await page.goto(`http://localhost:${PORT}/?system=1&run=1`, { waitUntil: 'domcontentloaded' });

  // 起動待ち。到達しなくても観測は続行し、到達可否を結果に残す。
  const started = Date.now();
  let booted = false;
  let lastLines = null;
  while (Date.now() - started < TIMEOUT) {
    const dump = await page
      .evaluate(async () => {
        const dbg = window.__webx68kDebug;
        if (!dbg?.screenText) return null;
        try {
          return await dbg.screenText();
        } catch {
          return null;
        }
      })
      .catch(() => null);
    if (dump?.lines) {
      lastLines = dump.lines;
      if (dump.lines.some((l) => l.includes('A>'))) {
        booted = true;
        break;
      }
    }
    await sleep(500);
  }
  // プロンプト到達後もしばらく観測する(常駐ドライバが後から叩く可能性)。
  await sleep(3000);

  const entries = raw.map(parseLine).filter(Boolean);
  const byCmd = {};
  for (const e of entries) byCmd[e.cmd] = (byCmd[e.cmd] ?? 0) + 1;
  console.log(
    JSON.stringify(
      {
        booted,
        elapsedMs: Date.now() - started,
        totalLogged: entries.length,
        note: entries.length >= 64 ? 'コア側のログ上限(64件)に達している可能性がある' : null,
        byCmd,
        entries,
        rawUnparsed: raw.filter((l) => !parseLine(l)),
        lastScreenLines: booted ? undefined : lastLines,
      },
      null,
      2,
    ),
  );
} finally {
  if (browser) await browser.close().catch(() => {});
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await sleep(500);
  }
}
