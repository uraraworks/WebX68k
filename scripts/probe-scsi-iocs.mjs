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

// 押して離すまでを1フレーム以上あける。puppeteer の press は down/up が同一フレームに
// 収まりゲスト側のポーリングに拾われないことがある(実測 2026-09-03: Enter が効かず
// コマンドが実行されなかった)。
async function pressHeld(page, key, holdMs = 120) {
  await page.keyboard.down(key);
  await sleep(holdMs);
  await page.keyboard.up(key);
  await sleep(80);
}

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
// テスト専用のRAMオーバーレイで書き込み経路(core-shim.c の __webx68kScsiWrite/
// __webx68kScsiRead フック)を有効にする。永続化はしない。本命の書き戻し経路
// (OPFS)が入るまで、書き込み経路を端から端まで確かめるためだけのもの。
const SCSI_RAM_WRITES = args['scsi-ram-writes'] !== undefined;
// 初期化コマンド($00)への返答値。どの欄が Human68k の判断に効くかを切り分けるための
// 実験用スイッチ。意味は core-shim.c の js_scsi_reply_* を参照。未指定はコア側の既定に任せる。
const REPLY_ERR = args['reply-err'] === undefined ? null : Number(args['reply-err']);
const REPLY_UNITS = args['reply-units'] === undefined ? null : Number(args['reply-units']);
const REPLY_END = args['reply-end'] === undefined ? null : Number(args['reply-end']);
const REPLY_BPB = args['reply-bpb'] === undefined ? null : Number(args['reply-bpb']);
const REPLY_STATUS = args['reply-status'] === undefined ? null : Number(args['reply-status']);
// 2回目以降の初期化コマンドに「ドライバ無し」で返答するかどうか。値を取らないフラグ。
const REPLY_INIT_ONCE = args['reply-init-once'] !== undefined;
// ストラテジ/インタラプトから戻る d0。既定(未指定)はコア側の既定 -1(何もしない)に任せる。
const REPLY_D0 = args['reply-d0'] === undefined ? null : Number(args['reply-d0']);
// デバイスドライバヘッダ +$00(次のヘッダ)。既定(未指定)はコア側の既定 $ffffffff に任せる。
const DRV_NEXT = args['drv-next'] === undefined ? null : Number(args['drv-next']);
const DRV_RAM = args['drv-ram'] === undefined ? null : Number(args['drv-ram']);
const DRV_RAM_FROM = args['drv-ram-from'] === undefined ? null : Number(args['drv-ram-from']);
// SPC(MB89352)セレクト応答関連。意味は core-shim.c の js_scsi_spc_* / x68k/scsi.c
// の SCSI_SpcSelectCheck を参照。未指定はコア側の既定(ints-sel=$08 / ints-timeout=$20 /
// ssts・psns=-1=触らない)に任せる。本物ROM使用時(--rom=)のみ効く。
// ssts・psns は -2 を渡すと「掃引」モードになり、実際の読み出しのたびに
// 0x00〜0xffを1ずつ増やして返す(x68k/scsi.c の SCSI_SpcSweepRead 参照)。
// spc-clear-on-pctl は PCTL($ea0011)書き込みでSSTSのbit7を落とすかどうか
// (既定1=落とす)。実験的な規則で実機の仕様として測ったものではない。
// spc-target: セレクトに応答するSCSI IDに相当するTEMP($ea0017)値(既定1)。
// TEMPの値がこれと一致したときだけセレクト成功にする(応答する相手を1つに絞る)。
// 実測ではTEMPに$01と$07が観測されており、値を振って正解を探すためのスイッチ
// (core-shim.c の js_scsi_spc_target / x68k/scsi.c の SCSI_SpcSelectCheck 参照)。
const SPC_TARGET = args['spc-target'] === undefined ? null : Number(args['spc-target']);
const SPC_INTS_SEL = args['spc-ints-sel'] === undefined ? null : Number(args['spc-ints-sel']);
const SPC_INTS_TIMEOUT = args['spc-ints-timeout'] === undefined ? null : Number(args['spc-ints-timeout']);
const SPC_SSTS = args['spc-ssts'] === undefined ? null : Number(args['spc-ssts']);
const SPC_PSNS = args['spc-psns'] === undefined ? null : Number(args['spc-psns']);
// PSNS/SSTS掃引(-2)の開始値。本物ROMは1回の起動でPSNS/SSTSを16回程度しか読まないため、
// 開始値をずらして複数回実行すれば0〜255の全値を試せる(x68k/scsi.c の SCSI_SpcSweepRead
// 参照)。未指定ならコア側の既定(0)のまま、従来と挙動は変わらない。
const SPC_PSNS_BASE = args['spc-psns-base'] === undefined ? null : Number(args['spc-psns-base']);
const SPC_SSTS_BASE = args['spc-ssts-base'] === undefined ? null : Number(args['spc-ssts-base']);
// PSNSの「交互」モード(--spc-psns=-3 と併用)。読み出しのたびにA/Bを入れ替えて
// 返す。掃引(-2)は「読むたびに+1」で連続2回が必ず(v, v+1)の組にしかならず、
// 「ある値の次に別の特定の値」という決まったハンドシェイクは掃引では試せない
// ため用意した(x68k/scsi.c の SCSI_SpcSweepRead 参照)。未指定ならコア側の
// 既定($8a/$0a)のまま。
const SPC_PSNS_A = args['spc-psns-a'] === undefined ? null : Number(args['spc-psns-a']);
const SPC_PSNS_B = args['spc-psns-b'] === undefined ? null : Number(args['spc-psns-b']);
// PCTL($ea0011)書き込みでSSTSのbit7を落とすかどうか(既定1=落とす)。実機の仕様として
// 測ったものではなく、再試行のたびに測定を1つ進めるための実験的な規則
// (x68k/scsi.c の SCSI_SpcWrite コメント参照)。0で無効化できる。
const SPC_CLEAR_ON_PCTL = args['spc-clear-on-pctl'] === undefined ? null : Number(args['spc-clear-on-pctl']);
// SPCの転送状態機械(COMMAND/DATAIN/STATUS/MSGIN)関連。__webx68kSpcPsns が既定(-1)
// のときだけ働く(x68k/scsi.c の SCSI_SpcSetPhase 等参照)。
// spc-phase-bits: COMMANDフェーズのPSNSフェーズビット。既定-1(組み込みの$02を使う)。
// spc-ints-xfer: 転送完了時にINTSへ立てるビット(既定$10、当てはめ)。
// spc-ints-disc: 切断(BUSFREE)時にINTSへ立てるビット(既定$04、当てはめ)。
const SPC_PHASE_BITS = args['spc-phase-bits'] === undefined ? null : Number(args['spc-phase-bits']);
const SPC_INTS_XFER = args['spc-ints-xfer'] === undefined ? null : Number(args['spc-ints-xfer']);
const SPC_INTS_DISC = args['spc-ints-disc'] === undefined ? null : Number(args['spc-ints-disc']);
// spc-cdb-from-temp: CDBをDREGでなくTEMP($ea0017)経由で受け取る仮説の有効/無効
// (既定1=有効)。2026-09-02の実測(ROMがDREGに一切書かずTEMP経由に見える並びを
// 繰り返した)を受けた未実測の仮説。0で従来どおり(DREGのみ)に戻せる。
// DREG経由自体はこの値に関わらず常に有効(両方の口を開けておく)。
// 詳細は x68k/scsi.c の SCSI_SpcXferStart コメント参照。
const SPC_CDB_FROM_TEMP = args['spc-cdb-from-temp'] === undefined ? null : Number(args['spc-cdb-from-temp']);
// spc-ssts-data-bit: DATAIN中に渡すべきバイトが残っている間、SSTS($ea000d)へ
// 立てる当てはめのビット(既定$08)。2026-09-02の実測(READ CAPACITY応答直前に
// TC=8を書きSCMD上位3bit=100を書いたあとSSTSを95回ポーリングし続けた)を受けた
// 仮説。値を振って正解を探すためホストから変更できる。
// -2 を渡すと「掃引」モードになり、DATAINで渡すべきバイトが残っている間の
// SSTS読み出しのたびに $80(接続中、常に立てたまま)へ0〜255を1ずつ変えた値を
// ORして返す(ポーリング回数が多い箇所での当てずっぽう探索用)。
// 詳細は x68k/scsi.c の SCSI_SpcXferStartData / SCSI_SpcSstsSetDataBit /
// SCSI_SpcSstsDataSweepRead 参照。
const SPC_SSTS_DATA_BIT = args['spc-ssts-data-bit'] === undefined ? null : Number(args['spc-ssts-data-bit']);
// spc-ssts-tc0: DATAIN中にTC(転送カウンタ)が0になったとき、SSTS($ea000d)へ
// 立てる当てはめのビット(既定$10)。2026-09-02の実測(データビット単体の
// パルス化だけでは通らず、掃引で抜けた瞬間の値$b0が$80|$20|$10だった)を
// 受けた仮説。データビットと違いパルスにはせず、TCが残っている間は落とし
// 0になったら立てたままにする。詳細は x68k/scsi.c の SCSI_SpcSstsSetTc0Bit 参照。
const SPC_SSTS_TC0 = args['spc-ssts-tc0'] === undefined ? null : Number(args['spc-ssts-tc0']);
// [SCSI-BUS] の「同一PCからの通算アクセスが閾値を超えたら以後そのPCのログを
// 止める」圧縮の閾値(既定32、コア側 x68k/scsi.c の SCSI_BusPcAllow 参照)。
// この圧縮は過去に無限ループを「バスアクセスが止まった」ように見せて誤った
// 結論を作ったことがあるため、--bus-pc-limit=0 で丸ごと無効化(全件出力)できる。
// 未指定ならコア側の既定(32)のまま。
const BUS_PC_LIMIT = args['bus-pc-limit'] === undefined ? null : Number(args['bus-pc-limit']);
// [SCSI-BUS] の総件数上限(既定4000、x68k/scsi.c の SCSI_BusLogGate 参照)。
// 未指定ならコア側の既定(4000)のまま。
const BUS_LOG_MAX = args['bus-log-max'] === undefined ? null : Number(args['bus-log-max']);
// FD1(2台目フロッピー)に挿すイメージのURL。CONFIG.SYSを差し替えた変種イメージ等を
// dev サーバ経由(例: public/test/ 配下、.gitignore で除外)で読ませたいときに使う。
// 未指定時はURLに一切手を加えない(挙動を変えないため)。
const FD1 = args.fd1 ?? null;
// --type=<文字列>: 起動後にゲストへ打鍵する(末尾で Enter)。--type-wait=<ms> で待ち時間。
const TYPE_TEXT = args.type === undefined ? null : String(args.type);
// --hdd=<パス>: SASIのHDDスロットへ挿す(?hdd=)。SCSIと同居できるかを測る用。
const HDD = args.hdd ?? null;
// 本物の外部SCSIボードROMイメージ(8192バイト)。指定時のみ window.__webx68kScsiRomBytes
// へ数値配列として置く。逆アセンブルはせず、本物を走らせて実測するためのオラクルとして使う。
// 未指定なら従来と1文字も挙動が変わらない。
const ROM = args.rom ?? null;
// ゲストRAM書き込みの実測用フック(x68k/mem_wrap.c の webx68k_ram_watch_check)。
// --ram-watch=<開始>:<終了> で範囲(両端含む)を指定する。10進・16進(0x接頭辞)どちらも可。
// 未指定なら window.__webx68kRamWatchLo/Hi は設定せず、コア側の既定(-1=無効)のまま。
function parseRamWatchAddr(s) {
  const t = s.trim();
  const n = /^0x/i.test(t) ? parseInt(t, 16) : parseInt(t, 10);
  if (!Number.isFinite(n)) throw new Error(`--ram-watch の番地が不正です: ${s}`);
  return n;
}
let RAM_WATCH_LO = null;
let RAM_WATCH_HI = null;
if (args['ram-watch'] !== undefined) {
  const m = /^(.+):(.+)$/.exec(String(args['ram-watch']));
  if (!m) throw new Error('--ram-watch は <開始>:<終了> の形で指定してください(例: --ram-watch=0x67de:0x6800)');
  RAM_WATCH_LO = parseRamWatchAddr(m[1]);
  RAM_WATCH_HI = parseRamWatchAddr(m[2]);
}
// 書いた側のPCで絞る条件。--ram-watch-pc=<開始>:<終了> で指定する(両端含む、10進・16進どちらも可)。
// 未指定なら window.__webx68kRamWatchPcLo/Hi は設定せず、コア側の既定(-1=PCでは絞らない)のまま。
let RAM_WATCH_PC_LO = null;
let RAM_WATCH_PC_HI = null;
if (args['ram-watch-pc'] !== undefined) {
  const m = /^(.+):(.+)$/.exec(String(args['ram-watch-pc']));
  if (!m) throw new Error('--ram-watch-pc は <開始>:<終了> の形で指定してください(例: --ram-watch-pc=0xea0000:0xea1fff)');
  RAM_WATCH_PC_LO = parseRamWatchAddr(m[1]);
  RAM_WATCH_PC_HI = parseRamWatchAddr(m[2]);
}
// ゲストメモリ「読み出し」の実測用フック(x68k/mem_wrap.c の webx68k_mem_read_watch_check)。
// --mem-read-watch=<開始>:<終了> で範囲(両端含む)を指定する。10進・16進(0x接頭辞)どちらも可。
// 未指定なら window.__webx68kMemReadWatchLo/Hi は設定せず、コア側の既定(-1=無効)のまま。
let MEM_READ_WATCH_LO = null;
let MEM_READ_WATCH_HI = null;
if (args['mem-read-watch'] !== undefined) {
  const m = /^(.+):(.+)$/.exec(String(args['mem-read-watch']));
  if (!m) throw new Error('--mem-read-watch は <開始>:<終了> の形で指定してください(例: --mem-read-watch=0xea0000:0xea1fff)');
  MEM_READ_WATCH_LO = parseRamWatchAddr(m[1]);
  MEM_READ_WATCH_HI = parseRamWatchAddr(m[2]);
}
// 読んだ側のPCで絞る条件。--mem-read-watch-pc=<開始>:<終了> で指定する(両端含む、10進・16進どちらも可)。
// 未指定なら window.__webx68kMemReadWatchPcLo/Hi は設定せず、コア側の既定(-1=PCでは絞らない)のまま。
let MEM_READ_WATCH_PC_LO = null;
let MEM_READ_WATCH_PC_HI = null;
if (args['mem-read-watch-pc'] !== undefined) {
  const m = /^(.+):(.+)$/.exec(String(args['mem-read-watch-pc']));
  if (!m) throw new Error('--mem-read-watch-pc は <開始>:<終了> の形で指定してください(例: --mem-read-watch-pc=0xea144a:0xea144e)');
  MEM_READ_WATCH_PC_LO = parseRamWatchAddr(m[1]);
  MEM_READ_WATCH_PC_HI = parseRamWatchAddr(m[2]);
}

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
  if (SCSI_RAM_WRITES) {
    // テスト専用のRAMオーバーレイ。書き込みは永続化しない。
    // 本番の書き戻し経路(OPFS)が入るまで、書き込み経路を端から端まで
    // 確かめるためだけのもの。
    await page.evaluateOnNewDocument(() => {
      window.__webx68kScsiOverlay = new Map(); // lba -> Uint8Array(512)
      window.__webx68kScsiWrite = (lba, heap, ptr) => {
        window.__webx68kScsiOverlay.set(lba >>> 0, heap.slice(ptr, ptr + 512));
        return 0;
      };
      // 読み出し側: オーバーレイに書いたセクタがあればそれを返し、
      // 無ければ -2 を返して core-shim.c 側で従来のXHR経路へ委譲させる。
      window.__webx68kScsiRead = (lba, heap, ptr) => {
        const hit = window.__webx68kScsiOverlay.get(lba >>> 0);
        if (!hit) return -2;
        heap.set(hit, ptr);
        return 0;
      };
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
  if (REPLY_INIT_ONCE) {
    await page.evaluateOnNewDocument(() => {
      window.__webx68kScsiReplyInitOnce = 1;
    });
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
  if (DRV_RAM !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kScsiDrvRam = v;
    }, DRV_RAM);
  }
  if (DRV_RAM_FROM !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kScsiDrvRamFrom = v;
    }, DRV_RAM_FROM);
  }
  if (SPC_TARGET !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kSpcTarget = v;
    }, SPC_TARGET);
  }
  if (SPC_INTS_SEL !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kSpcIntsSel = v;
    }, SPC_INTS_SEL);
  }
  if (SPC_INTS_TIMEOUT !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kSpcIntsTimeout = v;
    }, SPC_INTS_TIMEOUT);
  }
  if (SPC_SSTS !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kSpcSsts = v;
    }, SPC_SSTS);
  }
  if (SPC_PSNS !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kSpcPsns = v;
    }, SPC_PSNS);
  }
  if (SPC_PSNS_BASE !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kSpcPsnsBase = v;
    }, SPC_PSNS_BASE);
  }
  if (SPC_SSTS_BASE !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kSpcSstsBase = v;
    }, SPC_SSTS_BASE);
  }
  if (SPC_PSNS_A !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kSpcPsnsA = v;
    }, SPC_PSNS_A);
  }
  if (SPC_PSNS_B !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kSpcPsnsB = v;
    }, SPC_PSNS_B);
  }
  if (SPC_CLEAR_ON_PCTL !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kSpcClearOnPctl = v;
    }, SPC_CLEAR_ON_PCTL);
  }
  if (SPC_PHASE_BITS !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kSpcPhaseBits = v;
    }, SPC_PHASE_BITS);
  }
  if (SPC_INTS_XFER !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kSpcIntsXfer = v;
    }, SPC_INTS_XFER);
  }
  if (SPC_INTS_DISC !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kSpcIntsDisc = v;
    }, SPC_INTS_DISC);
  }
  if (SPC_CDB_FROM_TEMP !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kSpcCdbFromTemp = v;
    }, SPC_CDB_FROM_TEMP);
  }
  if (SPC_SSTS_DATA_BIT !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kSpcSstsDataBit = v;
    }, SPC_SSTS_DATA_BIT);
  }
  if (SPC_SSTS_TC0 !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kSpcSstsTc0Bit = v;
    }, SPC_SSTS_TC0);
  }
  if (BUS_PC_LIMIT !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kBusPcLimit = v;
    }, BUS_PC_LIMIT);
  }
  if (BUS_LOG_MAX !== null) {
    await page.evaluateOnNewDocument((v) => {
      window.__webx68kBusLogMax = v;
    }, BUS_LOG_MAX);
  }
  if (RAM_WATCH_LO !== null) {
    await page.evaluateOnNewDocument((lo, hi) => {
      window.__webx68kRamWatchLo = lo;
      window.__webx68kRamWatchHi = hi;
    }, RAM_WATCH_LO, RAM_WATCH_HI);
  }
  if (RAM_WATCH_PC_LO !== null) {
    await page.evaluateOnNewDocument((lo, hi) => {
      window.__webx68kRamWatchPcLo = lo;
      window.__webx68kRamWatchPcHi = hi;
    }, RAM_WATCH_PC_LO, RAM_WATCH_PC_HI);
  }
  if (MEM_READ_WATCH_LO !== null) {
    await page.evaluateOnNewDocument((lo, hi) => {
      window.__webx68kMemReadWatchLo = lo;
      window.__webx68kMemReadWatchHi = hi;
    }, MEM_READ_WATCH_LO, MEM_READ_WATCH_HI);
  }
  if (MEM_READ_WATCH_PC_LO !== null) {
    await page.evaluateOnNewDocument((lo, hi) => {
      window.__webx68kMemReadWatchPcLo = lo;
      window.__webx68kMemReadWatchPcHi = hi;
    }, MEM_READ_WATCH_PC_LO, MEM_READ_WATCH_PC_HI);
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
  const fd1Query =
    (FD1 !== null ? `&fd1=${encodeURIComponent(FD1)}` : '') +
    (HDD !== null ? `&hdd=${encodeURIComponent(HDD)}` : '');
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

  // --type=<文字列> でゲストへ打鍵する(末尾に改行を付ける)。
  // ドライブが実際に見えているかは「誰かが触る」まで分からないため、
  // 起動後に DIR C: 等を打って読み出しコマンドが来るかを測る用。
  // 打鍵後の画面は typedScreen に残す(打つ前の lastLines と区別するため)。
  let typedScreen = null;
  if (TYPE_TEXT !== null) {
    await page.evaluate(() => {
      const c = document.querySelector('canvas');
      if (c) { c.setAttribute('tabindex', '0'); c.focus(); }
    }).catch(() => {});
    // ゲストはJIS配列で解釈するため、US配列前提の puppeteer の打鍵とずれる記号がある。
    // 実測(2026-09-03): "DIR C:" と打つと画面には "dir c;" と出た(Shift+Semicolon が
    // JISでは ';' のまま)。':' はJISでは独立キー(US配列の Quote の位置)なので、
    // ':' だけキー名で押す。他にずれる記号が出たら、同じ形でここに足すこと。
    for (const cmdText of TYPE_TEXT.split(';;')) {
    // ';;' 区切りで複数コマンドを続けて打てる(コピーしてから dir で確かめる等)。
    for (const part of cmdText.split(':')) {
      if (part) await page.keyboard.type(part, { delay: 60 });
      if (part !== cmdText.split(':').at(-1)) await pressHeld(page, 'Quote');
    }
    await sleep(300);
    await pressHeld(page, 'Enter');
    await sleep(4000);
    }
    await sleep(Number(args['type-wait'] ?? 6000));
    typedScreen = await page
      .evaluate(async () => {
        const dbg = window.__webx68kDebug;
        if (!dbg?.screenText) return null;
        try { return (await dbg.screenText())?.lines ?? null; } catch { return null; }
      })
      .catch(() => null);
  }

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
        // 実行時の引数をそのまま残す。2026-09-03、過去の成功例(hdr2.json)の
        // 条件が復元できず行き止まりになった。当時の陽性対照ログは設定の一部しか
        // 出しておらず、どの --spc-* で走らせたのかが結果ファイルから分からなかった。
        // 代理(ログに出る一部の設定)ではなく、条件そのものを記録する。
        invocation: process.argv.slice(2),
        booted,
        typedScreen,
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
