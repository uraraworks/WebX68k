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
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
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
    const m = /^--([a-z0-9-]+)(?:=(.+))?$/.exec(a);
    if (!m) throw new Error(`不明な引数です: ${a}`);
    return [m[1], m[2] ?? 'true'];
  }),
);
const PORT = Number(args.port ?? 5311);
const TIMEOUT = Number(args.timeout ?? 60000);
// SCSI 基準器イメージ。個人のパスをリポジトリへ焼き込まないため環境変数で受ける
// (docs/STORAGE-SCSI.md「基準器の扱い」参照)。--image= でも指定できる。
const IMAGE = args.image ?? process.env.WEBX68K_SCSI_FIXTURE ?? null;
// ベクタ設定エントリが返す d2 の値。意味が未確定のため振れるようにしてある。
// 既定(未指定)はコア側の既定 -1 に任せる。
const INIT_D2 = args['init-d2'] === undefined ? null : Number(args['init-d2']);
const INIT_A4 = args['init-a4'] === undefined ? null : Number(args['init-a4']);
// デバイスドライバヘッダの属性ワード(+4)。意味が未確定のため振れるようにしてある。
const DRV_ATTR = args['drv-attr'] === undefined ? null : Number(args['drv-attr']);
const SRAM_INIT = args['scsi-sram'] !== undefined;
// 初期化コマンド($00)への返答値。どの欄が Human68k の判断に効くかを切り分けるための
// 実験用スイッチ。意味は core-shim.c の js_scsi_reply_* を参照。未指定はコア側の既定に任せる。
const REPLY_ERR = args['reply-err'] === undefined ? null : Number(args['reply-err']);
const REPLY_UNITS = args['reply-units'] === undefined ? null : Number(args['reply-units']);
const REPLY_END = args['reply-end'] === undefined ? null : Number(args['reply-end']);
const REPLY_BPB = args['reply-bpb'] === undefined ? null : Number(args['reply-bpb']);
const REPLY_STATUS = args['reply-status'] === undefined ? null : Number(args['reply-status']);
// ストラテジ/インタラプトから戻る d0。既定(未指定)はコア側の既定 -1(何もしない)に任せる。
const REPLY_D0 = args['reply-d0'] === undefined ? null : Number(args['reply-d0']);
// デバイスドライバヘッダ +$00(次のヘッダ)。既定(未指定)はコア側の既定 $ffffffff に任せる。
const DRV_NEXT = args['drv-next'] === undefined ? null : Number(args['drv-next']);
// FD1(2台目フロッピー)に挿すイメージのURL。CONFIG.SYSを差し替えた変種イメージ等を
// dev サーバ経由(例: public/test/ 配下、.gitignore で除外)で読ませたいときに使う。
// 未指定時はURLに一切手を加えない(挙動を変えないため)。
const FD1 = args.fd1 ?? null;
// 本物の外部SCSIボードROMイメージ(8192バイト)。指定時のみ window.__webx68kScsiRomBytes
// へ数値配列として置く。逆アセンブルはせず、本物を走らせて実測するためのオラクルとして使う。
// 未指定なら従来と1文字も挙動が変わらない。
const ROM = args.rom ?? null;

/**
 * 基準器イメージを Range 対応で配信する小さなサーバ。
 * vite の配信下に置くと fs.allow の設定や配布物への混入が要るため、別ポートで出す。
 * ページは COEP: require-corp で分離されているので CORP ヘッダが要る。
 */
async function startImageServer(path) {
  const { size } = await stat(path);
  const server = createServer((req, res) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    const head = {
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Access-Control-Allow-Origin': '*',
      // Range は CORS の safelisted request header ではないため、
      // 別オリジンから付けるとプリフライトが飛ぶ。許可と、
      // Content-Range を JS から読めるようにする露出指定が要る。
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
      'Access-Control-Max-Age': '86400',
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/octet-stream',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, head);
      res.end();
      return;
    }
    if (!range) {
      res.writeHead(200, { ...head, 'Content-Length': String(size) });
      createReadStream(path).pipe(res);
      return;
    }
    const start = Number(range[1]);
    const end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
    if (!Number.isSafeInteger(start) || start > end) {
      res.writeHead(416, { ...head, 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...head,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
    });
    createReadStream(path, { start, end }).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/image` , size };
}

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
let imageServer = null;
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
  if (IMAGE) {
    imageServer = await startImageServer(IMAGE);
    console.error(`[probe] 基準器を配信: ${IMAGE} (${imageServer.size} バイト) -> ${imageServer.url}`);
  }
  const page = await browser.newPage();
  if (imageServer) {
    // コア初期化より前に置く必要があるため evaluateOnNewDocument で入れる。
    await page.evaluateOnNewDocument((u) => {
      window.__webx68kScsiUrl = u;
    }, imageServer.url);
  }
  if (INIT_D2 !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kScsiInitD2 = v;
    }, INIT_D2);
  }
  if (SRAM_INIT) {
    await page.evaluateOnNewDocument(() => {
      window.__webx68kScsiSramInit = true;
    });
  }
  if (INIT_A4 !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kScsiInitA4 = v;
    }, INIT_A4);
  }
  if (DRV_ATTR !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kScsiDrvAttr = v;
    }, DRV_ATTR);
  }
  if (REPLY_ERR !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kScsiReplyErr = v;
    }, REPLY_ERR);
  }
  if (REPLY_UNITS !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kScsiReplyUnits = v;
    }, REPLY_UNITS);
  }
  if (REPLY_END !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kScsiReplyEnd = v;
    }, REPLY_END);
  }
  if (REPLY_BPB !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kScsiReplyBpb = v;
    }, REPLY_BPB);
  }
  if (REPLY_STATUS !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kScsiReplyStatus = v;
    }, REPLY_STATUS);
  }
  if (REPLY_D0 !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kScsiReplyD0 = v;
    }, REPLY_D0);
  }
  if (DRV_NEXT !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kScsiDrvNext = v;
    }, DRV_NEXT);
  }
  if (ROM !== null) {
    const romBytes = Array.from(await readFile(ROM));
    console.error(`[probe] 本物のSCSI ROMイメージを読み込む: ${ROM} (${romBytes.length} バイト)`);
    await page.evaluateOnNewDocument((bytes) => {
      window.__webx68kScsiRomBytes = bytes;
    }, romBytes);
  }
  const raw = [];
  page.on('console', (msg) => {
    const text = msg.text();
    // タグを列挙して照合すると、コア側でタグが増えたときに無言で取りこぼす
    // (実測: [SCSI-WINREAD]/[SCSI-WRITE] が '[SCSI]' に含まれず全て捨てられていた)。
    // 前方一致にして、SCSI 系のログは全て拾う。
    if (text.includes('[SCSI')) raw.push(text);
  });
  const fd1Query = FD1 !== null ? `&fd1=${encodeURIComponent(FD1)}` : '';
  await page.goto(`http://localhost:${PORT}/?${args['no-system'] ? '' : 'system=1&'}run=1${fd1Query}`, { waitUntil: 'domcontentloaded' });

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

  // SCSI IOCS ベクタ($7d4)が設定されているかを見る。ROMスタブの
  // 「IOCSベクタ設定エントリ」が呼ばれていれば $00ea004a が入るはずで、
  // 入っていなければ ROMスタブがそもそも拾われていないことになる。
  // まわりのベクタも一緒に読むのは、readMemory 自体が定数を返していないかを
  // 確かめるため(値が全て同一・全てゼロなら観測系を疑う)。
  // readMemory はブリッジ側の API なので、ページ内からは __webx68kDebug.peek()
  // (ワード単位)を使う。まわりのベクタも一緒に読むのは、peek 自体が定数を
  // 返していないかを確かめるため(値が全て同一・全てゼロなら観測系を疑う)。
  const vectors = await page
    .evaluate(() => {
      const dbg = window.__webx68kDebug;
      if (!dbg?.peek) return { error: 'peek がない' };
      const words = [];
      for (let a = 0x07c0; a < 0x0800; a += 4) {
        const hi = dbg.peek(a);
        const lo = dbg.peek(a + 2);
        if (hi === null || lo === null) return { error: `peek(${a}) が null` };
        words.push({
          addr: `$${a.toString(16).padStart(4, '0')}`,
          value: `$${(((hi << 16) >>> 0) + lo).toString(16).padStart(8, '0')}`,
        });
      }
      return words;
    })
    .catch((err) => ({ error: String(err) }));

  // --dump=<開始番地>:<バイト数> で、停止後のゲストRAMを覗く。
  // 「登録されたのか、拒否されたのか」はドライバ連鎖を見ないと分からないため、
  // 失敗した瞬間のメモリを比較できるようにしてある(複数指定は , 区切り)。
  let dumps = null;
  if (args.dump) {
    dumps = await page
      .evaluate((spec) => {
        const dbg = window.__webx68kDebug;
        if (!dbg?.peek) return { error: 'peek がない' };
        const out = {};
        for (const part of spec.split(',')) {
          const [a, n] = part.split(':');
          const base = Number(a);
          const len = Number(n);
          const bytes = [];
          for (let i = 0; i < len; i += 2) {
            const w = dbg.peek(base + i);
            if (w === null) return { error: `peek(${base + i}) が null` };
            bytes.push((w >> 8) & 0xff, w & 0xff);
          }
          out[`$${base.toString(16)}`] = bytes
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ');
        }
        return out;
      }, String(args.dump))
      .catch((err) => ({ error: String(err) }));
  }

  // 画面の実物を残す。screenText は文字集合の都合で化けることがあり、
  // 「何が表示されたか」の判断をテキストだけに頼れない。
  let shot = null;
  if (args.shot) {
    shot = args.shot;
    await page.screenshot({ path: shot }).catch(() => {
      shot = null;
    });
  }

  const entries = raw.map(parseLine).filter(Boolean);
  const byCmd = {};
  for (const e of entries) byCmd[e.cmd] = (byCmd[e.cmd] ?? 0) + 1;
  console.log(
    JSON.stringify(
      {
        booted,
        dumps,
        screenshot: shot,
        iocsVectors: vectors,
        scsiIocsVector: Array.isArray(vectors)
          ? (vectors.find((v) => v.addr === '$07d4')?.value ?? null)
          : null,
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
  if (imageServer) imageServer.server.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await sleep(500);
  }
}
