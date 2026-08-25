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

/**
 * `system_profiler SPAudioDataType -json` の出力から既定の**出力**デバイスを取り出す。
 *
 * 入力デバイスにも `coreaudio_default_audio_input_device` が付くため、出力側のキーだけを
 * 見る。既定出力が見つからない場合は null を返す（0や空オブジェクトで埋めない。
 * 「取得できなかった」と「そういう値だった」を混ぜないため）。
 *
 * @param {string} stdout
 * @returns {{name: string|null, transport: string|null, sampleRate: number|null}|null}
 */
export function parseAudioOutputDevice(stdout) {
  let items;
  try {
    items = JSON.parse(stdout)?.SPAudioDataType?.[0]?._items;
  } catch {
    return null;
  }
  if (!Array.isArray(items)) return null;
  const hit = items.find((d) => d?.coreaudio_default_audio_output_device === 'spaudio_yes');
  if (!hit) return null;
  return {
    name: hit._name ?? null,
    transport: hit.coreaudio_device_transport ?? null,
    sampleRate: hit.coreaudio_device_srate ?? null,
  };
}

/**
 * macOS の既定音声出力デバイスを返す。
 *
 * AudioContext.outputLatency は**このデバイスだけで決まる**（2026-08-25 の実測）。
 * 同一マシン・同一ビルドで HDMI 0.016秒 / 内蔵スピーカー 0.032秒 / Bluetooth 0.168秒。
 * デバイスを記録していなかったために、この差を長らく「日差」と誤読していた。
 * 音声指標を組の間で比較してよいのは、このデバイスが一致しているときだけである。
 */
async function collectAudioOutputDevice() {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync('system_profiler', ['SPAudioDataType', '-json'], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseAudioOutputDevice(stdout);
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
    audioOutputDevice: await collectAudioOutputDevice(),
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
 * parsedのpidから process.pid(selfPid) への祖先チェーンを辿り、selfPidを先祖に
 * 持つプロセス(および selfPid 自身)に selfDescendant: true を付ける。
 * `npm run dev` → vite → esbuild のように孫・ひ孫まで潜るため必ず根まで辿る。
 * ps出力が壊れてppidの環が生じても無限ループしないよう訪問済みpidを記録する。
 */
function markSelfDescendants(parsedList, selfPid) {
  const ppidByPid = new Map(parsedList.map((proc) => [proc.pid, proc.ppid]));
  const cache = new Map();
  const resolve = (pid) => {
    if (cache.has(pid)) return cache.get(pid);
    if (pid === selfPid) {
      cache.set(pid, true);
      return true;
    }
    const visited = new Set();
    let current = pid;
    let result = false;
    for (;;) {
      if (visited.has(current) || !ppidByPid.has(current)) {
        result = false;
        break;
      }
      visited.add(current);
      const parent = ppidByPid.get(current);
      if (parent === selfPid) {
        result = true;
        break;
      }
      if (cache.has(parent)) {
        result = cache.get(parent);
        break;
      }
      if (parent === current) {
        result = false;
        break;
      }
      current = parent;
    }
    cache.set(pid, result);
    return result;
  };
  for (const proc of parsedList) {
    proc.selfDescendant = resolve(proc.pid);
  }
}

/**
 * `ps -Ao pid,ppid,pcpu,etime,comm -r`(CPU降順)と `ps -Ao pid=,args=` を1回ずつ
 * 呼び、pidで突き合わせて全プロセスをスナップショットし、上位 limit 件を返す。
 * comm・argsのどちらも値に空白を含みうるため、1回の ps で両方同時に取得すると
 * フィールド境界が解析できない。必ず2回呼んでpidで突き合わせる。
 * 計測窓の「外」(開始直前・終了直後)で1回ずつ呼ぶ用途であり、計測窓の中では
 * 呼ばない(サブプロセス起動そのものが負荷になるため)。取得不能なら null
 * (空配列と区別する)。
 *
 * 上位 limit 件に加えて、args(コマンドライン全体)に 'vite' を含むプロセスは
 * (CPU使用率に関わらず)必ず含める。comm(実行ファイルパス)には現れない
 * ―― `node .../node_modules/.bin/vite` はcommが`node`にしかならず、'vite'の
 * 文字列は `ps -o args` にしか出ない。2026-08-19の「分類の確認」はcommに'vite'を
 * 含む合成オブジェクトを直接ルールへ通したため、この経路の穴が実プロセスの
 * 挙動と食い違ったまま見逃され、2026-08-23の計測で残存vite2本を検出できずに
 * verdictが誤って"quiet"寄りになった。record化するargsは300文字で切り詰める
 * (切り詰めた場合は末尾に'…')が、vite判定そのものは切り詰め前の生文字列
 * (argsByPid)に対して行う。
 *
 * 併せて、`process.pid`(このNodeプロセス自身、selfPid引数で差し替え可能)を
 * 先祖に持つプロセス(npm run dev が起動するvite・esbuild等の子孫、および自分
 * 自身)には selfDescendant: true を付ける。計測スクリプトが自ら起動した
 * dev サーバを competitor 扱いしないための印(buildLoadReport側で使う)。
 */
export async function snapshotProcesses(limit = 10, selfPid = process.pid) {
  try {
    const [{ stdout: mainOut }, { stdout: argsOut }] = await Promise.all([
      execFileAsync('ps', ['-Ao', 'pid,ppid,pcpu,etime,comm', '-r']),
      execFileAsync('ps', ['-Ao', 'pid=,args=']),
    ]);

    const argsByPid = new Map();
    for (const line of argsOut.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const [, pidStr, args] = match;
      argsByPid.set(Number(pidStr), args);
    }

    const lines = mainOut.split('\n').filter((line) => line.trim().length > 0);
    lines.shift(); // ヘッダ行
    const parsed = [];
    for (const line of lines) {
      const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const [, pidStr, ppidStr, pcpuStr, etime, comm] = match;
      const pid = Number(pidStr);
      const rawArgs = argsByPid.get(pid) ?? '';
      const args = rawArgs.length > 300 ? `${rawArgs.slice(0, 300)}…` : rawArgs;
      parsed.push({
        pid,
        ppid: Number(ppidStr),
        pcpu: Number(pcpuStr),
        etime,
        etimeSeconds: parseEtimeToSeconds(etime),
        comm: comm.trim(),
        args,
        selfDescendant: false,
      });
    }

    markSelfDescendants(parsed, selfPid);

    const top = parsed.slice(0, limit);
    const topPids = new Set(top.map((proc) => proc.pid));
    const viteMatches = parsed.filter(
      (proc) => !topPids.has(proc.pid) && /vite/i.test(argsByPid.get(proc.pid) ?? '')
    );
    return [...top, ...viteMatches];
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

// 2026-08-19 の実測で判明した問題: WindowServer(常時30〜45%CPU・経過107日)のような
// macOSの常駐プロセスは competitor 条件(a)に恒久的に該当し、verdict が常に "contended"
// に張り付いていた。これはこちらが止められるものではなく、良条件(16:12〜16:17、
// loadavg1正規化0.34〜0.40、起動中央値24,150ms)でも悪条件(15:22〜15:48、
// loadavg1正規化0.54〜0.76、起動中央値36,658ms)でも同様に動いていたため、
// 悪化の説明にもならない。そこで「止められない常駐プロセス」と「計測を駆動している
// Claudeデスクトップアプリ本体(このスクリプトを動かしている当人)」を許可リストで
// competitor 判定から除外する。ただし消すと「そのとき何が動いていたか」の記録が
// 失われるため、systemBackground という別枠へ退避して記録する(除外≠不可視化)。
//
// 一方、Chromeレンダラは今回の真犯人(悪条件で新たに現れたCPU31%・経過1日6時間の
// 放置タブ)そのものであり、除外しない。ブラウザのレンダラプロセスは検体アプリ
// (Chrome/Brave/Edge等)側のヘルパーであって、OS常駐プロセスでも計測ツール本体でも
// ないため、意図的にこの許可リストへは入れない。
const SYSTEM_BACKGROUND_ALLOWLIST = [
  // macOS の常駐プロセス(ユーザーが止める対象ではない)
  /WindowServer$/,
  /WindowManager\.app/,
  /fseventsd$/,
  /NotificationCenter\.app/,
  /locationd$/,
  /knowledge-agent$|knowledgeconstructiond$|knowledged$/,
  /sysmond$/,
  /launchd$/,
  /kernel_task$/,
  /opendirectoryd$/,
  /coreauthd$/,
  /searchpartyd$/,
  /CursorUIViewService|TextInputUIMacHelper/,
  /EcosystemAnalytics\.framework|ecosystemanalyticsd$/,
  /IntelligencePlatformCompute/,
  /BiomeStreams\.framework|biomed$|biomesyncd$|biometrickitd$/,
  // 計測を駆動しているClaudeデスクトップアプリ本体(Claude.app / claude-code CLI)。
  // 計測対象や「余計なもの」ではなく計測ツールそのもの。
  /\/Claude\.app\//,
  /\/claude-code\//,
];

export function isSystemBackground(proc) {
  if (!proc || typeof proc.comm !== 'string') return false;
  return SYSTEM_BACKGROUND_ALLOWLIST.some((pattern) => pattern.test(proc.comm));
}

/**
 * 計測を汚しうるプロセスの判定:
 *  (a) pcpu が10%以上、かつ経過時間が10分(600秒)以上 — 元の実インシデント
 *      (放置Chromeタブ: CPU31%・経過1日6時間)を捉えるための長時間居座り検出
 *  (a') pcpu が80%以上(経過時間は問わない) — 単一コアをほぼ張り付かせている
 *      プロセスは経過時間によらず計測を汚しうる。(a)は「長く居座る中負荷」を
 *      捉える設計だが、起動直後の高負荷プロセス(例: 故障注入テストで意図的に
 *      並走させるCPUスピナー)は経過600秒に達する前に計測が終わってしまい
 *      検出できない。反復試行の外で1回ずつしか ps を撮らない設計(このモジュール
 *      冒頭のコメント参照)上、経過時間に依存しない独立した基準が要る
 *  (b) args(コマンドライン全体)に 'vite' を含む(大文字小文字を区別しない)。
 *      comm(実行ファイルパス)には現れない ―― `node .../bin/vite` はcommが
 *      `node`にしかならず、'vite'という文字列は`ps -o args`にしか出ない。
 *      以前はcommを見ていたため実プロセスでは条件(b)が絶対に成立せず、
 *      2026-08-19の合成入力での検証(commに'vite'を含む自作オブジェクトを
 *      直接ルールへ通した)では穴が見えないまま「検出できた」ことになって
 *      いた。2026-08-23の計測で残存vite2本を見逃して発覚した。
 * ただし SYSTEM_BACKGROUND_ALLOWLIST に該当するものは対象外(systemBackground側に記録)。
 * selfDescendant(このNodeプロセス自身が起動したdevサーバの子孫)の除外は
 * ここではなく buildLoadReport 側で行う(selfPidと同じ扱い)。
 */
export function isCompetitor(proc) {
  if (!proc) return false;
  if (isSystemBackground(proc)) return false;
  const heavyAndLongRunning =
    Number.isFinite(proc.pcpu) &&
    proc.pcpu >= 10 &&
    Number.isFinite(proc.etimeSeconds) &&
    proc.etimeSeconds >= 600;
  const heavyBurst = Number.isFinite(proc.pcpu) && proc.pcpu >= 80;
  const isVite = typeof proc.args === 'string' && /vite/i.test(proc.args);
  return heavyAndLongRunning || heavyBurst || isVite;
}

/**
 * サンプラーの停止結果とプロセススナップショット(計測窓の前後)から、結果JSONへ
 * そのまま載せる load レポートを組み立てる。判定基準(verdictReason)は文字列として
 * ここで書き出し、結果ファイル自身から判定根拠が読めるようにする。
 */
export function buildLoadReport({ sampler, processesBefore, processesAfter, selfPid = process.pid }) {
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
  const systemBackgroundMap = new Map();
  for (const proc of [...(processesBefore ?? []), ...(processesAfter ?? [])]) {
    // 計測スクリプト自身のnodeプロセス(puppeteer起動やawait処理でCPUが瞬間的に
    // 跳ねうる)は「止められる余計なもの」ではなく計測ツールそのものであるため、
    // Claude.appと同様にsystemBackground側へ退避する(heavyBurst基準の自己検出を防ぐ)。
    //
    // 条件(b)がargsを見るようになったことで、計測スクリプト自身が`npm run dev`で
    // spawnしたvite(の子孫プロセス。npm→vite→esbuildと孫・ひ孫まで潜る)も
    // competitor条件(b)に該当してしまう。これは「別セッション由来の残存vite」とは
    // 別物で、計測対象を汚す余計なものではなく計測ツールそのものの一部であるため、
    // snapshotProcessesが付けたselfDescendant印を使い、selfPidと同様に
    // systemBackground側へ退避する(除外≠不可視化。記録は残す)。
    const isSelf = selfPid != null && proc?.pid === selfPid;
    const isSelfDescendant = proc?.selfDescendant === true;
    if (isSystemBackground(proc) || isSelf || isSelfDescendant) {
      if (!systemBackgroundMap.has(proc.pid)) systemBackgroundMap.set(proc.pid, proc);
      continue;
    }
    if (isCompetitor(proc) && !competitorMap.has(proc.pid)) {
      competitorMap.set(proc.pid, proc);
    }
  }
  const competitors = [...competitorMap.values()];
  const systemBackground = [...systemBackgroundMap.values()];

  // 閾値0.5(正規化loadavg1)の根拠: 2026-08-19の実測2条件の間に設定した。
  //   良(16:12〜16:17): loadavg1正規化 0.34〜0.40、起動中央値 24,150ms
  //   悪(15:22〜15:48): loadavg1正規化 0.54〜0.76、起動中央値 36,658ms(同条件6試行)
  const THRESHOLD_BASIS =
    '閾値0.5は2026-08-19の実測2条件(良: loadavg1正規化0.34-0.40/起動中央値24,150ms、' +
    '悪: loadavg1正規化0.54-0.76/起動中央値36,658ms)の間に設定した';

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
    verdictReason = `loadavg1 の median が cpuCount の 0.5 倍未満、かつ competitors が空。${THRESHOLD_BASIS}`;
  } else {
    verdict = 'contended';
    verdictReason =
      `loadavg1 の median (正規化 ${samplesReport.medianNormalized}) が cpuCount の0.5倍以上、` +
      `または competitors が ${competitors.length} 件検出された。${THRESHOLD_BASIS}`;
  }

  return {
    samples: samplesReport,
    processesBefore: processesBefore ?? null,
    processesAfter: processesAfter ?? null,
    systemBackground,
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
