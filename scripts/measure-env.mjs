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
