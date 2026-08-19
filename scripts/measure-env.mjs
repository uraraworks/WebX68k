// 計測結果へ「実行環境」を記録する共通モジュール。
//
// 背景: docs/STORAGE-SCSI.md の計測計画が要求する共通条件(アセットのSHA-256、
// ブラウザ/OS/端末、AudioContextのsampleRate等)が結果ファイルへ入っておらず、
// 日をまたいだ2組の計測結果の差が「日差」なのか「ビルド差」なのか帰属できなかった。
// このモジュールはその埋め合わせであり、既存の計測ロジック(判定条件・タイムアウト・
// 集計方法)には一切触れない。
//
// 方針: 取得できなかった値は必ず null にする。0や空文字で埋めると「取得不能」と
// 「実測値が0」を区別できなくなり、特に baseLatency/outputLatency は
// 未対応ブラウザで undefined になるため、そのまま0にすると誤読を招く。

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

const REPO_ROOT = new URL('..', import.meta.url).pathname;

// docs/STORAGE-SCSI.md が要求する共通条件の対象5ファイル。
const ASSET_RELATIVE_PATHS = [
  'public/core/px68k_libretro.wasm',
  'public/core/px68k_libretro.js',
  'public/system/iplrom.dat',
  'public/system/cgrom.dat',
  'public/system/human302.xdf',
];

async function runGit(args) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: REPO_ROOT });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * git status --porcelain 専用。各行の先頭列(index側の状態)は空白1文字であり得るため、
 * 全体へ.trim()を掛けると先頭行だけその空白が失われ、1件目のファイルの状態列が
 * 破損する(index側の状態とworktree側の状態を取り違える)。末尾の改行だけ落とし、
 * 各行の中身には触れない。
 */
async function runGitStatusPorcelain() {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: REPO_ROOT });
    return stdout.replace(/\n+$/, '');
  } catch {
    return null;
  }
}

async function hashFile(relativePath) {
  try {
    const buffer = await readFile(join(REPO_ROOT, relativePath));
    return createHash('sha256').update(buffer).digest('hex');
  } catch {
    return null;
  }
}

async function collectBuild() {
  const commit = await runGit(['rev-parse', 'HEAD']);
  const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const statusOutput = await runGitStatusPorcelain();
  const dirtyFiles = statusOutput ? statusOutput.split('\n').filter((line) => line.length > 0) : [];

  const assets = {};
  for (const relativePath of ASSET_RELATIVE_PATHS) {
    assets[relativePath] = await hashFile(relativePath);
  }

  return {
    commit,
    branch,
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
    assets,
  };
}

async function collectPowerSource() {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync('pmset', ['-g', 'batt']);
    const firstLine = stdout.split('\n')[0] ?? '';
    if (firstLine.includes('AC Power')) return 'AC Power';
    if (firstLine.includes('Battery Power')) return 'Battery Power';
    return null;
  } catch {
    return null;
  }
}

async function collectHost() {
  let cpuModel = null;
  let cpuCount = null;
  let totalMemMiB = null;
  try {
    const cpus = os.cpus();
    cpuModel = cpus?.[0]?.model ?? null;
    cpuCount = cpus?.length ?? null;
  } catch {
    // 取得不能ならnullのまま
  }
  try {
    totalMemMiB = Math.round(os.totalmem() / 1048576);
  } catch {
    totalMemMiB = null;
  }

  return {
    platform: safeCall(() => os.platform()),
    release: safeCall(() => os.release()),
    arch: safeCall(() => os.arch()),
    cpuModel,
    cpuCount,
    totalMemMiB,
    nodeVersion: process.version ?? null,
    powerSource: await collectPowerSource(),
  };
}

function safeCall(fn) {
  try {
    return fn() ?? null;
  } catch {
    return null;
  }
}

/**
 * ページ内で requestAnimationFrame を最大1200msだけ集め、実測の表示リフレッシュレートを
 * 算出する。rAFが1回も発火しない環境が実在する(feedback_headless_raf_never_runs.md参照)
 * ため、必ずタイムアウトを置きハングさせない。0回なら null を返す。
 */
async function collectPageRefreshRate(page) {
  try {
    return await page.evaluate(() => {
      return new Promise((resolvePage) => {
        const collectWindowMs = 1000;
        const hardTimeoutMs = 1200;
        let count = 0;
        let settled = false;
        const start = performance.now();
        const finish = () => {
          if (settled) return;
          settled = true;
          const elapsedMs = performance.now() - start;
          if (count <= 0 || elapsedMs <= 0) {
            resolvePage({ refreshRateHz: null, rafSampleCount: 0 });
            return;
          }
          const hz = (count / elapsedMs) * 1000;
          resolvePage({ refreshRateHz: Math.round(hz * 100) / 100, rafSampleCount: count });
        };
        const tick = () => {
          count += 1;
          if (performance.now() - start >= collectWindowMs) {
            finish();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        setTimeout(finish, hardTimeoutMs);
      });
    });
  } catch {
    return { refreshRateHz: null, rafSampleCount: 0 };
  }
}

async function collectPage(page) {
  const viewport = safeCall(() => page.viewport());
  const refresh = await collectPageRefreshRate(page);

  let deviceInfo = null;
  try {
    deviceInfo = await page.evaluate(() => ({
      screenWidth: window.screen?.width ?? null,
      screenHeight: window.screen?.height ?? null,
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      deviceMemory: navigator.deviceMemory ?? null,
    }));
  } catch {
    deviceInfo = null;
  }

  return {
    viewportWidth: viewport?.width ?? null,
    viewportHeight: viewport?.height ?? null,
    devicePixelRatio: viewport?.deviceScaleFactor ?? null,
    screenWidth: deviceInfo?.screenWidth ?? null,
    screenHeight: deviceInfo?.screenHeight ?? null,
    hardwareConcurrency: deviceInfo?.hardwareConcurrency ?? null,
    deviceMemory: deviceInfo?.deviceMemory ?? null,
    refreshRateHz: refresh?.refreshRateHz ?? null,
    rafSampleCount: refresh?.rafSampleCount ?? 0,
  };
}

async function collectBrowser(page) {
  try {
    const version = await page.browser().version();
    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => null);
    return { version: version ?? null, userAgent: userAgent ?? null };
  } catch {
    return { version: null, userAgent: null };
  }
}

/**
 * window.__webx68kDebug.audioEnv() を呼ぶ。フックが無い/nullなら audio 全体を null にする。
 * outputLatency/baseLatencyがundefinedのブラウザで0を入れないよう、src/audio.ts側の
 * audioEnv()実装でnull変換済みの値をそのまま受け取る。
 */
async function collectAudio(page) {
  try {
    const result = await page.evaluate(() => {
      const debug = window.__webx68kDebug;
      if (typeof debug?.audioEnv !== 'function') return null;
      const env = debug.audioEnv();
      if (!env) return null;
      return {
        sampleRate: env.sampleRate ?? null,
        baseLatency: env.baseLatency ?? null,
        outputLatency: env.outputLatency ?? null,
        state: env.state ?? null,
      };
    });
    return result ?? null;
  } catch {
    return null;
  }
}

// --- 負荷の記録 ------------------------------------------------------------
//
// 背景: 2026-08-19、同一ビルド(アセット5件のSHA-256一致)にもかかわらず起動計測の
// 中央値が悪化した。原因はCPUを食う無関係プロセス(古いChromeレンダラ・残存vite
// preview)との取り合いであり、結果ファイルには「そのとき何が同時に動いていたか」が
// 一切記録されていなかった。以下は既存の collectEnvironment とは別に、計測の
// 全区間(反復試行すべてを含む)にわたって負荷を記録するための独立した仕組み。
//
// collectEnvironment 側の収集(build/host/browser/page/audio)は計測窓の外で1回
// 行えば足りるが、負荷はその瞬間だけ静かで前後が汚れているケースを取り逃すため、
// 計測窓の「中」で継続サンプリングしないと意味がない。サブプロセスを起動する
// 方式(ps等)は毎回起動コストがあり、それ自体が負荷になり得るため、区間中の
// 継続サンプリングには os.loadavg() のみを使う(同期・プロセス起動なし)。

const DEFAULT_LOAD_SAMPLE_INTERVAL_MS = 5000;

/**
 * os.loadavg() を一定間隔でサンプリングし続けるサンプラーを起動する。
 * サブプロセスは一切起動しない(loadavgはOSがカーネル内で保持する値を読むだけ)。
 * stop() を呼ぶまで動き続けるが、setInterval には unref() を掛けてあるため、
 * 呼び忘れてもプロセスの終了自体はブロックしない(ただし明示的に stop() すること)。
 */
export function startLoadSampler(options = {}) {
  const intervalMs = options.intervalMs ?? DEFAULT_LOAD_SAMPLE_INTERVAL_MS;
  const cpuCount = safeCall(() => os.cpus()?.length ?? null);
  const samples = [];

  const sampleOnce = () => {
    try {
      const value = os.loadavg()[0];
      if (Number.isFinite(value)) samples.push(value);
    } catch {
      // 取得不能ならサンプルを増やさない(0で埋めない)
    }
  };

  sampleOnce();
  const timer = setInterval(sampleOnce, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  let stopped = false;
  return {
    stop() {
      if (!stopped) {
        clearInterval(timer);
        stopped = true;
      }
      return { samples: [...samples], intervalMs, cpuCount };
    },
  };
}

/**
 * [[dd-]hh:]mm:ss 形式の `ps -o etime` 出力を秒数へ変換する。パース不能なら null。
 */
function parseEtimeToSeconds(etime) {
  if (typeof etime !== 'string' || etime.length === 0) return null;
  const dayMatch = /^(\d+)-(.+)$/.exec(etime);
  const days = dayMatch ? Number(dayMatch[1]) : 0;
  const rest = dayMatch ? dayMatch[2] : etime;
  const parts = rest.split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return null;
  let seconds;
  if (parts.length === 3) {
    seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else {
    seconds = parts[0] * 60 + parts[1];
  }
  return days * 86400 + seconds;
}

/**
 * `ps -Ao pid,pcpu,etime,comm -r`(CPU降順)で全プロセスを1回だけスナップショットし、
 * 上位 limit 件を返す。計測窓の「外」(開始直前・終了直後)で1回ずつ呼ぶ用途であり、
 * 計測窓の中では呼ばない(サブプロセス起動そのものが負荷になるため)。
 * 取得不能なら null(空配列と区別する)。
 */
export async function snapshotProcesses(limit = 10) {
  try {
    const { stdout } = await execFileAsync('ps', ['-Ao', 'pid,pcpu,etime,comm', '-r']);
    const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
    lines.shift(); // ヘッダ行
    const parsed = [];
    for (const line of lines) {
      const match = /^\s*(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const [, pidStr, pcpuStr, etime, comm] = match;
      parsed.push({
        pid: Number(pidStr),
        pcpu: Number(pcpuStr),
        etime,
        etimeSeconds: parseEtimeToSeconds(etime),
        comm: comm.trim(),
      });
    }
    return parsed.slice(0, limit);
  } catch {
    return null;
  }
}

function median(sortedAsc) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedAsc[mid - 1] + sortedAsc[mid]) / 2 : sortedAsc[mid];
}

function round2(value) {
  return value === null ? null : Math.round(value * 100) / 100;
}

/**
 * 計測を汚しうるプロセスの判定:
 *  (a) pcpu が10%以上、かつ経過時間が10分(600秒)以上
 *  (b) comm に 'vite' を含む(大文字小文字を区別しない)
 */
function isCompetitor(proc) {
  if (!proc) return false;
  const heavyAndLongRunning =
    Number.isFinite(proc.pcpu) &&
    proc.pcpu >= 10 &&
    Number.isFinite(proc.etimeSeconds) &&
    proc.etimeSeconds >= 600;
  const isVite = typeof proc.comm === 'string' && /vite/i.test(proc.comm);
  return heavyAndLongRunning || isVite;
}

/**
 * サンプラーの停止結果とプロセススナップショット(計測窓の前後)から、結果JSONへ
 * そのまま載せる load レポートを組み立てる。判定基準(verdictReason)は文字列として
 * ここで書き出し、結果ファイル自身から判定根拠が読めるようにする。
 */
export function buildLoadReport({ sampler, processesBefore, processesAfter }) {
  const rawSamples = sampler?.samples ?? [];
  const cpuCount = sampler?.cpuCount ?? null;
  const sorted = [...rawSamples].sort((a, b) => a - b);
  const minLoadavg1 = sorted.length ? sorted[0] : null;
  const maxLoadavg1 = sorted.length ? sorted[sorted.length - 1] : null;
  const medianLoadavg1 = median(sorted);
  const normalize = (value) => (value !== null && cpuCount ? value / cpuCount : null);

  const samplesReport = {
    intervalMs: sampler?.intervalMs ?? null,
    sampleCount: rawSamples.length,
    minLoadavg1: round2(minLoadavg1),
    medianLoadavg1: round2(medianLoadavg1),
    maxLoadavg1: round2(maxLoadavg1),
    cpuCount,
    minNormalized: round2(normalize(minLoadavg1)),
    medianNormalized: round2(normalize(medianLoadavg1)),
    maxNormalized: round2(normalize(maxLoadavg1)),
  };

  const competitorMap = new Map();
  for (const proc of [...(processesBefore ?? []), ...(processesAfter ?? [])]) {
    if (isCompetitor(proc) && !competitorMap.has(proc.pid)) {
      competitorMap.set(proc.pid, proc);
    }
  }
  const competitors = [...competitorMap.values()];

  let verdict;
  let verdictReason;
  if (
    rawSamples.length === 0 ||
    cpuCount === null ||
    processesBefore === null ||
    processesAfter === null
  ) {
    verdict = 'unknown';
    verdictReason =
      'loadavgサンプルまたはプロセススナップショット(ps)の取得に失敗したため判定不能';
  } else if ((samplesReport.medianNormalized ?? Infinity) < 0.5 && competitors.length === 0) {
    verdict = 'quiet';
    verdictReason = 'loadavg1 の median が cpuCount の 0.5 倍未満、かつ competitors が空';
  } else {
    verdict = 'contended';
    verdictReason =
      `loadavg1 の median (正規化 ${samplesReport.medianNormalized}) が cpuCount の0.5倍以上、` +
      `または competitors が ${competitors.length} 件検出された`;
  }

  return {
    samples: samplesReport,
    processesBefore: processesBefore ?? null,
    processesAfter: processesAfter ?? null,
    competitors,
    verdict,
    verdictReason,
  };
}

/**
 * 計測環境をまとめて収集する。page が null の場合は node 側(build/host)だけを返し、
 * browser/page/audio は null にする。個々の項目の取得失敗は全体を落とさず null にする。
 *
 * @param {import('puppeteer-core').Page | null} page
 */
export async function collectEnvironment(page) {
  const collectedAt = new Date().toISOString();
  const build = await collectBuild().catch(() => null);
  const host = await collectHost().catch(() => null);

  if (!page) {
    return { collectedAt, build, host, browser: null, page: null, audio: null };
  }

  const browser = await collectBrowser(page).catch(() => null);
  const pageInfo = await collectPage(page).catch(() => null);
  const audio = await collectAudio(page).catch(() => null);

  return { collectedAt, build, host, browser, page: pageInfo, audio };
}
