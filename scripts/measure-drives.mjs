// WebX68k の FDD0/FDD1/HDD が Human68k から A:/B:/C: として正しく見えることと、
// DIR コマンドに対する応答時間を反復計測する。画面への到達を測るため、ホスト側の
// スロット状態ではなく __webx68kDebug.screenText() が返す TVRAM を判定対象にする。
//
// measure-boot.mjs は実行可能スクリプトであり、import すると計測本体まで実行されるうえ、
// 共通処理を export していない。その挙動を変えると既存基準値との比較を壊すため、dev server
// 起動、ヘッドフル Puppeteer、BrowserContext 分離、起動完了判定、統計・JSON 出力の必要部分を
// このファイルへ複製している。

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const REQUIRED_STABLE_POLLS = 3;
const RECOVERY_MAX_ATTEMPTS = 2;
const RECOVERY_TIMEOUT_MS = 5000;
const VALID_FAULTS = new Set(['no-fdd1', 'no-hdd']);
const DRIVE_LETTERS = ['A', 'B', 'C', 'D'];
const KEY_SPECS = [
  { code: 'KeyD', key: 'd' },
  { code: 'KeyI', key: 'i' },
  { code: 'KeyR', key: 'r' },
  { code: 'Space', key: ' ' },
  { code: 'KeyA', key: 'a' },
  { code: 'KeyB', key: 'b' },
  { code: 'KeyC', key: 'c' },
  { code: 'Quote', key: ':' },
  { code: 'Backspace', key: 'Backspace' },
  { code: 'Enter', key: 'Enter' },
  { code: 'ControlLeft', key: 'Control' },
];
const BUTTONS = {
  fdd1: { selector: '#btn-blank-fdd1', accessibleName: 'FDD1 ブランク作成' },
  hdd: {
    selector: '#btn-blank-hdd',
    accessibleName: 'HDD ブランクHDDを作成(40MB・FAT16)',
  },
  boot: { selector: '#btn-boot-system', accessibleName: 'システムディスクで起動' },
};

// 容量は完全一致ではなく生成・表示差を許容する。ただし B: は約1.2MB、C: は約40MBで
// 2桁違うため、この互いに重ならない範囲によって FDD1/HDD の取り違えを確実に検出する。
const CAPACITY_RANGES_KBYTE = {
  B: { expected: 1221, min: 1100, max: 1400 },
  C: { expected: 40781, min: 39000, max: 42000 },
};
const A_DIRECTORIES = ['SYS', 'HIS', 'BIN', 'BASIC2', 'ASK', 'ETC'];
const IDENTITY_LIMITATION =
  '媒体本来のディレクトリ名・ボリューム表示・容量による代用識別であり、同一容量かつ同じ識別情報を持つ媒体どうしの取り違えは検出できない';

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const roundMs = (value) => (value === null ? null : Math.round(value * 1000) / 1000);

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} は正の整数で指定してください: ${value}`);
  }
  return parsed;
}

function parseKeyDelay(value, name) {
  const parsed = parsePositiveInteger(value, name);
  if (parsed < 34) throw new Error(`${name} は2フレーム相当の34ms以上で指定してください: ${value}`);
  return parsed;
}

function parseArgs(argv) {
  const values = {};
  for (const arg of argv) {
    if (arg === '--help') {
      values.help = true;
      continue;
    }
    const match =
      /^--(port|runs|timeout|command-timeout|poll-interval|key-hold|key-gap|input-retries|output|fault)=(.+)$/.exec(
        arg,
      );
    if (!match) throw new Error(`不明な引数です: ${arg}`);
    values[match[1]] = match[2];
  }
  return values;
}

function printHelp() {
  console.log(`Usage: node scripts/measure-drives.mjs [options]

  --port=<number>               dev server のポート (既定: 5183)
  --runs=<number>               反復回数 (既定: 5)
  --timeout=<ms>                起動完了タイムアウト (既定: 90000)
  --command-timeout=<ms>        DIR 1回のタイムアウト (既定: 20000)
  --poll-interval=<ms>          TVRAM ポーリング間隔 (既定: 50)
  --key-hold=<ms>               キーを押し続ける時間 (既定: 70)
  --key-gap=<ms>                キー解放後、次の押下までの間隔 (既定: 70)
  --input-retries=<number>      コマンド行不一致時の再試行回数 (既定: 3)
  --output=<path>               JSON の保存先
  --fault=<no-fdd1|no-hdd>      故障注入。先に故障なしの陽性対照を1回行う

環境変数: WEBX68K_PORT, WEBX68K_DRIVE_RUNS, WEBX68K_DRIVE_TIMEOUT_MS,
          WEBX68K_DRIVE_COMMAND_TIMEOUT_MS, WEBX68K_DRIVE_POLL_INTERVAL_MS,
          WEBX68K_DRIVE_KEY_HOLD_MS, WEBX68K_DRIVE_KEY_GAP_MS,
          WEBX68K_DRIVE_INPUT_RETRIES,
          WEBX68K_DRIVE_MEASURE_OUTPUT, WEBX68K_URL, CHROME_PATH`);
}

function defaultOutputPath() {
  const serial = new Date().toISOString().replace(/[:.]/g, '-');
  return join(REPO_ROOT, '_local', 'measure', `drives-${serial}.json`);
}

function buildConfig(args) {
  const envUrl = process.env.WEBX68K_URL ? new URL(process.env.WEBX68K_URL) : null;
  const port = parsePositiveInteger(
    args.port ?? process.env.WEBX68K_PORT ?? envUrl?.port ?? '5183',
    'port',
  );
  const baseUrl = envUrl ?? new URL(`http://localhost:${port}`);
  baseUrl.port = String(port);
  const outputValue =
    args.output ?? process.env.WEBX68K_DRIVE_MEASURE_OUTPUT ?? defaultOutputPath();
  const fault = args.fault ?? null;
  if (fault !== null && !VALID_FAULTS.has(fault)) {
    throw new Error(`fault は no-fdd1 または no-hdd を指定してください: ${fault}`);
  }
  return {
    baseUrl: baseUrl.href.replace(/\/$/, ''),
    port,
    runs: parsePositiveInteger(args.runs ?? process.env.WEBX68K_DRIVE_RUNS ?? '5', 'runs'),
    bootTimeoutMs: parsePositiveInteger(
      args.timeout ?? process.env.WEBX68K_DRIVE_TIMEOUT_MS ?? '90000',
      'timeout',
    ),
    commandTimeoutMs: parsePositiveInteger(
      args['command-timeout'] ?? process.env.WEBX68K_DRIVE_COMMAND_TIMEOUT_MS ?? '20000',
      'command-timeout',
    ),
    pollIntervalMs: parsePositiveInteger(
      args['poll-interval'] ?? process.env.WEBX68K_DRIVE_POLL_INTERVAL_MS ?? '50',
      'poll-interval',
    ),
    keyHoldMs: parseKeyDelay(
      args['key-hold'] ?? process.env.WEBX68K_DRIVE_KEY_HOLD_MS ?? '70',
      'key-hold',
    ),
    keyGapMs: parseKeyDelay(
      args['key-gap'] ?? process.env.WEBX68K_DRIVE_KEY_GAP_MS ?? '70',
      'key-gap',
    ),
    inputRetries: parsePositiveInteger(
      args['input-retries'] ?? process.env.WEBX68K_DRIVE_INPUT_RETRIES ?? '3',
      'input-retries',
    ),
    outputPath: isAbsolute(outputValue) ? outputValue : resolve(REPO_ROOT, outputValue),
    executablePath: process.env.CHROME_PATH ?? DEFAULT_CHROME,
    fault,
  };
}

async function startServer(port) {
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
  let ready = false;
  let startupOutput = '';
  let spawnError = null;
  const inspectOutput = (buffer) => {
    const output = buffer.toString();
    startupOutput += output;
    if (output.includes('ready in') || /Local:\s+http/.test(output)) ready = true;
  };
  child.stdout.on('data', inspectOutput);
  child.stderr.on('data', inspectOutput);
  child.once('error', (error) => {
    spawnError = error;
  });

  const deadline = Date.now() + 20000;
  while (!ready && child.exitCode === null && !spawnError && Date.now() < deadline) await sleep(300);
  if (!ready) {
    await stopServer(child);
    const detail = spawnError?.message ?? startupOutput.trim();
    throw new Error(`dev server を起動できませんでした${detail ? `: ${detail}` : ''}`);
  }
  await sleep(500);
  return child;
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveStop) => {
    const timer = setTimeout(resolveStop, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill('SIGTERM');
  });
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function summarize(samples) {
  if (samples.length === 0) {
    return { medianMs: null, p95Ms: null, minMs: null, maxMs: null };
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    medianMs: roundMs(percentile(sorted, 0.5)),
    p95Ms: roundMs(percentile(sorted, 0.95)),
    minMs: roundMs(sorted[0]),
    maxMs: roundMs(sorted.at(-1)),
  };
}

async function waitForText(page, selector, expected, timeoutMs) {
  await page.waitForFunction(
    ({ targetSelector, expectedText }) =>
      document.querySelector(targetSelector)?.textContent?.trim() === expectedText,
    { timeout: timeoutMs },
    { targetSelector: selector, expectedText: expected },
  );
}

async function clickNamedButton(page, definition) {
  await page.waitForSelector(definition.selector, { visible: true });
  const clicked = await page.evaluate(({ selector, expectedName }) => {
    const button = document.querySelector(selector);
    if (!(button instanceof HTMLButtonElement)) return { ok: false, actualName: null };
    const actualName =
      button.getAttribute('aria-label') ?? button.getAttribute('title') ?? button.textContent?.trim() ?? '';
    button.click();
    return { ok: true, actualName };
  }, { selector: definition.selector, expectedName: definition.accessibleName });
  if (!clicked.ok) throw new Error(`ボタンが見つかりません: ${definition.accessibleName}`);
  return { expectedName: definition.accessibleName, actualName: clicked.actualName };
}

async function releaseAllKeys(page) {
  await page.evaluate((specs) => {
    for (const spec of specs) {
      window.dispatchEvent(
        new KeyboardEvent('keyup', {
          code: spec.code,
          key: spec.key,
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );
    }
  }, KEY_SPECS);
}

async function waitForBootPrompt(page, timeoutMs, pollIntervalMs) {
  return page.evaluate(async ({ timeout, pollInterval, stablePolls }) => {
    const startedAt = performance.now();
    let lastPollAt = -Infinity;
    let consecutive = 0;
    let lastAPromptLine = null;
    let lastNonEmptyLine = null;
    while (performance.now() - startedAt < timeout) {
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      const now = performance.now();
      if (now - lastPollAt < pollInterval) continue;
      lastPollAt = now;
      let dump = null;
      try {
        dump = window.__webx68kDebug?.screenText?.() ?? null;
      } catch {
        consecutive = 0;
        continue;
      }
      if (!dump?.available || !Array.isArray(dump.lines)) {
        consecutive = 0;
        continue;
      }
      const lines = dump.lines.filter((line) => line.length > 0);
      lastNonEmptyLine = lines.at(-1) ?? null;
      lastAPromptLine = lines.filter((line) => line.startsWith('A>')).at(-1) ?? null;
      const remainderLength =
        lastAPromptLine === null ? Number.POSITIVE_INFINITY : Array.from(lastAPromptLine.slice(2)).length;
      consecutive = lastAPromptLine !== null && remainderLength <= 1 ? consecutive + 1 : 0;
      if (consecutive >= stablePolls) {
        return {
          success: true,
          durationMs: performance.now() - startedAt,
          lastAPromptLine,
          lastNonEmptyLine,
        };
      }
    }
    return {
      success: false,
      durationMs: performance.now() - startedAt,
      lastAPromptLine,
      lastNonEmptyLine,
    };
  }, { timeout: timeoutMs, pollInterval: pollIntervalMs, stablePolls: REQUIRED_STABLE_POLLS });
}

// DIR のタイムアウト後は、Enter、Ctrl+C の順でそれぞれ1回だけ試す。
// 各試行後に起動完了判定と同じ安定条件で A> を待ち、成否にかかわらず全キーを解放する。
async function recoverPrompt(page, config) {
  const recoveryTimeoutMs = Math.min(config.commandTimeoutMs, RECOVERY_TIMEOUT_MS);
  const methods = [
    { method: 'Enter', keys: ['Enter'] },
    { method: 'Ctrl+C', keys: ['ControlLeft', 'KeyC'] },
  ];
  const attempts = [];

  for (const definition of methods.slice(0, RECOVERY_MAX_ATTEMPTS)) {
    try {
      await page.evaluate(
        async ({ method, keyHold, keyGap }) => {
          const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
          const dispatch = (type, code, key, extra = {}) => {
            window.dispatchEvent(
              new KeyboardEvent(type, {
                code,
                key,
                bubbles: true,
                composed: true,
                cancelable: true,
                ...extra,
              }),
            );
          };
          if (method === 'Enter') {
            dispatch('keydown', 'Enter', 'Enter');
            await wait(keyHold);
            dispatch('keyup', 'Enter', 'Enter');
          } else {
            dispatch('keydown', 'ControlLeft', 'Control', { ctrlKey: true });
            dispatch('keydown', 'KeyC', 'c', { ctrlKey: true });
            await wait(keyHold);
            dispatch('keyup', 'KeyC', 'c', { ctrlKey: true });
            dispatch('keyup', 'ControlLeft', 'Control');
          }
          await wait(keyGap);
        },
        { method: definition.method, keyHold: config.keyHoldMs, keyGap: config.keyGapMs },
      );
      const prompt = await waitForBootPrompt(page, recoveryTimeoutMs, config.pollIntervalMs);
      attempts.push({
        attempt: attempts.length + 1,
        method: definition.method,
        sentKeys: definition.keys,
        keysReleased: true,
        prompt: { ...prompt, durationMs: roundMs(prompt.durationMs) },
      });
      if (prompt.success) {
        return { attempted: true, recovered: true, maxAttempts: RECOVERY_MAX_ATTEMPTS, attempts };
      }
    } finally {
      await releaseAllKeys(page);
    }
  }
  return { attempted: true, recovered: false, maxAttempts: RECOVERY_MAX_ATTEMPTS, attempts };
}

/**
 * DIR を合成 KeyboardEvent で入力する。アプリは e.code を読むため code を必ず指定し、
 * コロンも実測済みの Quote code で送る。ゲストはフレーム単位でキーをポーリングするため、
 * keyup 直後の次の keydown までにポーリングが2回以上走れるよう、保持時間とキー間隔を
 * それぞれ十分に空ける。応答時間は Enter の keydown と、そのドライブ固有の最初の識別出力を
 * TVRAMで観測した時刻との差で、すべてページ内 performance.now() を使う。
 */
async function executeDir(page, letter, config) {
  return page.evaluate(
    async ({
      driveLetter,
      timeout,
      pollInterval,
      stablePolls,
      allKeySpecs,
      keyHold,
      keyGap,
      inputRetries,
    }) => {
      const keyByCode = new Map(allKeySpecs.map((spec) => [spec.code, spec]));
      const release = () => {
        for (const spec of allKeySpecs) {
          window.dispatchEvent(
            new KeyboardEvent('keyup', {
              code: spec.code,
              key: spec.key,
              bubbles: true,
              composed: true,
              cancelable: true,
            }),
          );
        }
      };
      const nextFrame = () => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
      const press = async (code) => {
        const spec = keyByCode.get(code);
        if (!spec) throw new Error(`未定義のキーです: ${code}`);
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            code: spec.code,
            key: spec.key,
            bubbles: true,
            composed: true,
            cancelable: true,
          }),
        );
        await wait(keyHold);
        window.dispatchEvent(
          new KeyboardEvent('keyup', {
            code: spec.code,
            key: spec.key,
            bubbles: true,
            composed: true,
            cancelable: true,
          }),
        );
        await wait(keyGap);
      };
      const readLines = () => {
        const dump = window.__webx68kDebug?.screenText?.();
        return dump?.available && Array.isArray(dump.lines) ? dump.lines.filter((line) => line.length > 0) : [];
      };
      const countLineContaining = (lines, needle) =>
        lines.filter((line) => line.includes(needle)).length;
      const latestPromptLine = () => readLines().filter((line) => line.startsWith('A>')).at(-1) ?? null;
      const expectedCommandLine = `A>dir ${driveLetter.toLowerCase()}:`;
      // TVRAM上のカーソルが行末の1文字として現れる場合だけを許容し、欠落・置換は許さない。
      const commandLineMatches = (line) => {
        if (line === expectedCommandLine) return true;
        if (line === null || !line.startsWith(expectedCommandLine)) return false;
        return Array.from(line.slice(expectedCommandLine.length)).length === 1;
      };
      const clearCommandLine = async () => {
        const current = latestPromptLine();
        const typedLength = current?.startsWith('A>') ? Array.from(current.slice(2)).length : 0;
        // カーソル表示を文字数に数えても安全なよう余分に送り、空のプロンプトでは止まる。
        const backspaceCount = Math.max(8, Math.min(80, typedLength + 2));
        for (let index = 0; index < backspaceCount; index++) await press('Backspace');
      };
      const hasResponseEvidence = (lines, baselineLines) => {
        const text = lines.join('\n');
        if (driveLetter === 'A') {
          const countName = (targetLines, name) => {
            const pattern = new RegExp(`(^|[^A-Z0-9_])${name}([^A-Z0-9_]|$)`);
            return targetLines.filter((line) => pattern.test(line.toUpperCase())).length;
          };
          // 起動ログにも \SYS\... が残る場合があるため、Enter 前から見えていた名前ではなく、
          // 必須ディレクトリ名の出現数が増えた最初の時点を A: の応答とする。
          return ['SYS', 'HIS', 'BIN', 'BASIC2', 'ASK', 'ETC'].some(
            (name) => countName(lines, name) > countName(baselineLines, name),
          );
        }
        if (driveLetter === 'B' || driveLetter === 'C') {
          const needle = `ボリュームがありません ${driveLetter}:\\`;
          return countLineContaining(lines, needle) > countLineContaining(baselineLines, needle);
        }
        // no-hdd では直前の C: と D: が同じエラー文を出す。既に画面にある C: の文を
        // D: の応答と誤認しないよう、同じ文の出現数が Enter 前より増えたことを要求する。
        const needle = 'ドライブ名が無効です';
        return countLineContaining(lines, needle) > countLineContaining(baselineLines, needle);
      };

      release();
      const letterCode = `Key${driveLetter}`;
      const commandCodes = ['KeyD', 'KeyI', 'KeyR', 'Space', letterCode, 'Quote'];
      const inputAttempts = [];
      let commandLineVerified = false;
      for (let attempt = 1; attempt <= inputRetries + 1; attempt++) {
        if (attempt > 1) await clearCommandLine();
        for (const code of commandCodes) await press(code);
        const actualLine = latestPromptLine();
        const matched = commandLineMatches(actualLine);
        inputAttempts.push({ attempt, expectedLine: expectedCommandLine, actualLine, matched });
        if (matched) {
          commandLineVerified = true;
          break;
        }
      }
      if (!commandLineVerified) {
        release();
        return {
          letter: driveLetter,
          command: `DIR ${driveLetter}:`,
          input: {
            passed: false,
            failureType: 'input-failure',
            retryCount: inputAttempts.length - 1,
            attempts: inputAttempts,
            clearMethod: 'Backspaceを8回以上送信',
          },
          enterAt: null,
          responseAt: null,
          completedAt: null,
          responseMs: null,
          completionMs: null,
          timedOut: false,
          responseEvidenceFound: false,
          observedLines: readLines(),
          lastAPromptLine: latestPromptLine(),
        };
      }
      const baselineLines = readLines();
      const observedLineSet = new Set();
      let enterAt = null;
      let responseAt = null;
      let completedAt = null;
      let consecutive = 0;
      let lastPollAt = -Infinity;
      let lastAPromptLine = null;

      try {
        const enterSpec = keyByCode.get('Enter');
        enterAt = performance.now();
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            code: enterSpec.code,
            key: enterSpec.key,
            bubbles: true,
            composed: true,
            cancelable: true,
          }),
        );
        await wait(keyHold);
        window.dispatchEvent(
          new KeyboardEvent('keyup', {
            code: enterSpec.code,
            key: enterSpec.key,
            bubbles: true,
            composed: true,
            cancelable: true,
          }),
        );

        while (performance.now() - enterAt < timeout) {
          await nextFrame();
          const now = performance.now();
          if (now - lastPollAt < pollInterval) continue;
          lastPollAt = now;
          const lines = readLines();
          // 容量範囲とドライブ固有文で後から切り分けられるため、コマンド実行中に見えた
          // TVRAM 行は全て残す。これにより同じエラー文を出す連続コマンドも生データに残る。
          for (const line of lines) observedLineSet.add(line);
          if (responseAt === null && hasResponseEvidence(lines, baselineLines)) responseAt = now;

          lastAPromptLine = lines.filter((line) => line.startsWith('A>')).at(-1) ?? null;
          const remainderLength =
            lastAPromptLine === null
              ? Number.POSITIVE_INFINITY
              : Array.from(lastAPromptLine.slice(2)).length;
          consecutive = lastAPromptLine !== null && remainderLength <= 1 ? consecutive + 1 : 0;
          if (consecutive >= stablePolls) {
            completedAt = now;
            break;
          }
        }
      } finally {
        release();
      }

      return {
        letter: driveLetter,
        command: `DIR ${driveLetter}:`,
        input: {
          passed: true,
          failureType: null,
          retryCount: inputAttempts.length - 1,
          attempts: inputAttempts,
          clearMethod: 'Backspaceを8回以上送信',
        },
        enterAt,
        responseAt,
        completedAt,
        responseMs: responseAt === null ? null : responseAt - enterAt,
        completionMs: completedAt === null ? null : completedAt - enterAt,
        timedOut: completedAt === null,
        responseEvidenceFound: responseAt !== null,
        observedLines: [...observedLineSet],
        lastAPromptLine,
      };
    },
    {
      driveLetter: letter,
      timeout: config.commandTimeoutMs,
      pollInterval: config.pollIntervalMs,
      stablePolls: REQUIRED_STABLE_POLLS,
      allKeySpecs: KEY_SPECS,
      keyHold: config.keyHoldMs,
      keyGap: config.keyGapMs,
      inputRetries: config.inputRetries,
    },
  );
}

function containsAsciiName(text, name) {
  return new RegExp(`(^|[^A-Z0-9_])${name}([^A-Z0-9_]|$)`).test(text.toUpperCase());
}

function extractCapacityCandidates(text) {
  return [...text.matchAll(/([\d,]+)\s*K\s*Byte/gi)]
    .map((match) => Number(match[1].replaceAll(',', '')))
    .filter(Number.isFinite);
}

function judgeIdentity(letter, observedLines, responseEvidenceFound) {
  const text = observedLines.join('\n');
  if (letter === 'A') {
    const directories = Object.fromEntries(A_DIRECTORIES.map((name) => [name, containsAsciiName(text, name)]));
    const missing = A_DIRECTORIES.filter((name) => !directories[name]);
    return {
      passed: missing.length === 0,
      medium: 'FDD0 システムディスク',
      evidence: { directories, missingDirectories: missing },
      reason: missing.length === 0 ? null : `必須ディレクトリが不足: ${missing.join(', ')}`,
    };
  }
  if (letter === 'B' || letter === 'C') {
    const range = CAPACITY_RANGES_KBYTE[letter];
    const volumeText = `ボリュームがありません ${letter}:\\`;
    const volumeMessageFound = text.includes(volumeText);
    const capacityCandidatesKByte = extractCapacityCandidates(text);
    const capacityKByte =
      capacityCandidatesKByte.find((value) => value >= range.min && value <= range.max) ?? null;
    const passed = volumeMessageFound && capacityKByte !== null;
    return {
      passed,
      medium: letter === 'B' ? 'FDD1 blank_2hd1232.xdf' : 'HDD blank_hdd.hdf',
      evidence: {
        volumeMessage: volumeText,
        volumeMessageFound,
        capacityCandidatesKByte,
        acceptedCapacityRangeKByte: range,
        capacityKByte,
      },
      reason: passed
        ? null
        : [
            volumeMessageFound ? null : 'ボリュームなし表示を確認できない',
            capacityKByte === null ? `${range.min}〜${range.max}K Byte の容量を確認できない` : null,
          ]
            .filter(Boolean)
            .join('; '),
    };
  }
  const invalidDriveMessageFound =
    responseEvidenceFound === true && text.includes('ドライブ名が無効です');
  return {
    passed: invalidDriveMessageFound,
    medium: '未割り当て',
    evidence: { invalidDriveMessage: 'ドライブ名が無効です', invalidDriveMessageFound },
    reason: invalidDriveMessageFound ? null : 'ドライブ名が無効という表示を確認できない',
  };
}

function makeSkippedDrive(letter, reason) {
  return {
    letter,
    command: `DIR ${letter}:`,
    input: { passed: null, failureType: null, retryCount: 0, attempts: [] },
    responseMs: null,
    completionMs: null,
    timedOut: false,
    skipped: true,
    judgement: 'indeterminate',
    observedLines: [],
    identity: { passed: null, evaluated: false, medium: null, evidence: {}, reason },
  };
}

async function measureOnce(browser, config, trial, fault) {
  // IndexedDB と各スロットの状態を試行間で持ち越さないため、毎回新規 BrowserContext を使う。
  const context = await browser.createBrowserContext();
  let page = null;
  const clickedButtons = [];
  const displayedMedia = { fdd1: null, hdd: null };
  try {
    page = await context.newPage();
    await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 2 });
    await page.bringToFront();
    await page.goto(config.baseUrl, { waitUntil: 'networkidle2' });
    await page.bringToFront();

    // 前試行が例外・タイムアウトで中断されていても、入力開始前に全キーを解放する。
    await releaseAllKeys(page);
    if (fault !== 'no-fdd1') {
      clickedButtons.push(await clickNamedButton(page, BUTTONS.fdd1));
      await waitForText(page, '#name-fdd1', 'blank_2hd1232.xdf', 15000);
      displayedMedia.fdd1 = 'blank_2hd1232.xdf';
    }
    if (fault !== 'no-hdd') {
      clickedButtons.push(await clickNamedButton(page, BUTTONS.hdd));
      await waitForText(page, '#name-hdd', 'blank_hdd.hdf', 15000);
      displayedMedia.hdd = 'blank_hdd.hdf';
    }
    clickedButtons.push(await clickNamedButton(page, BUTTONS.boot));
    const boot = await waitForBootPrompt(page, config.bootTimeoutMs, config.pollIntervalMs);
    if (!boot.success) {
      throw new Error(
        `起動完了を確認できませんでした (lastAPromptLine=${boot.lastAPromptLine ?? 'なし'})`,
      );
    }

    const drives = {};
    let commandBlockedReason = null;
    for (const letter of DRIVE_LETTERS) {
      if (commandBlockedReason) {
        drives[letter] = makeSkippedDrive(letter, commandBlockedReason);
        continue;
      }
      const raw = await executeDir(page, letter, config);
      const identity = raw.input.passed
        ? judgeIdentity(letter, raw.observedLines, raw.responseEvidenceFound)
        : {
            passed: false,
            evaluated: false,
            medium: null,
            evidence: {},
            reason: '入力失敗のためドライブ判定を行っていない',
          };
      let recovery = null;
      if (raw.timedOut) recovery = await recoverPrompt(page, config);
      const judgement = raw.input.passed === false || !identity.passed ? 'failed' : 'passed';
      drives[letter] = {
        ...raw,
        enterAt: roundMs(raw.enterAt),
        responseAt: roundMs(raw.responseAt),
        completedAt: roundMs(raw.completedAt),
        responseMs: roundMs(raw.responseMs),
        completionMs: roundMs(raw.completionMs),
        skipped: false,
        judgement,
        recovery,
        identity,
      };
      if (raw.timedOut && !recovery.recovered) {
        commandBlockedReason = `${letter}: の DIR タイムアウトから復帰できなかったため未実行`;
      }
    }
    const inputFailedDrives = DRIVE_LETTERS.filter((letter) => drives[letter].input.passed === false);
    const driveJudgementFailedDrives = DRIVE_LETTERS.filter(
      (letter) => drives[letter].input.passed === true && !drives[letter].identity.passed,
    );
    const failedDrives = [...new Set([...inputFailedDrives, ...driveJudgementFailedDrives])];
    const indeterminateDrives = DRIVE_LETTERS.filter(
      (letter) => drives[letter].judgement === 'indeterminate',
    );
    const validMeasurement = inputFailedDrives.length === 0 && indeterminateDrives.length === 0;
    return {
      trial,
      fault,
      success: failedDrives.length === 0 && indeterminateDrives.length === 0,
      validMeasurement,
      inputFailedDrives,
      driveJudgementFailedDrives,
      failedDrives,
      indeterminateDrives,
      boot: { ...boot, durationMs: roundMs(boot.durationMs) },
      displayedMedia,
      clickedButtons,
      drives,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      trial,
      fault,
      success: false,
      validMeasurement: false,
      inputFailedDrives: [],
      driveJudgementFailedDrives: [],
      failedDrives: [],
      indeterminateDrives: [...DRIVE_LETTERS],
      reason: 'measurement-error',
      error: message,
      displayedMedia,
      clickedButtons,
      drives: Object.fromEntries(
        DRIVE_LETTERS.map((letter) => [letter, makeSkippedDrive(letter, `計測エラー: ${message}`)]),
      ),
    };
  } finally {
    // ページ内処理の例外時にも解放し、さらに BrowserContext の破棄で状態を隔離する。
    if (page && !page.isClosed()) {
      try {
        await releaseAllKeys(page);
      } catch {
        // ページ自体が壊れている場合も context.close() は必ず続行する。
      }
    }
    await context.close();
  }
}

function buildDriveSummaries(attempts) {
  return Object.fromEntries(
    DRIVE_LETTERS.map((letter) => {
      const results = attempts.map((attempt) => attempt.drives[letter]);
      const validResults = attempts
        .filter((attempt) => attempt.inputFailedDrives.length === 0)
        .map((attempt) => attempt.drives[letter])
        .filter((drive) => drive.judgement === 'passed' && Number.isFinite(drive.responseMs));
      const samplesMs = validResults.map((drive) => drive.responseMs);
      const validAttemptResults = attempts
        .filter((attempt) => attempt.inputFailedDrives.length === 0)
        .map((attempt) => attempt.drives[letter]);
      return [
        letter,
        {
          total: results.length,
          passed: results.filter((drive) => drive.judgement === 'passed').length,
          failed: results.filter((drive) => drive.judgement === 'failed').length,
          indeterminate: results.filter((drive) => drive.judgement === 'indeterminate').length,
          inputFailed: results.filter((drive) => drive.input.passed === false).length,
          invalidatedByTrialInputFailure: attempts.filter(
            (attempt) =>
              attempt.inputFailedDrives.length > 0 && attempt.drives[letter].input.passed === true,
          ).length,
          driveJudgementPassed: validAttemptResults.filter(
            (drive) => drive.input.passed === true && drive.identity.passed,
          ).length,
          driveJudgementFailed: validAttemptResults.filter(
            (drive) => drive.input.passed === true && !drive.identity.passed,
          ).length,
          responseSampleCount: samplesMs.length,
          samplesMs,
          ...summarize(samplesMs),
        },
      ];
    }),
  );
}

function buildFaultCheck(fault, positiveControl, attempts) {
  if (!fault) return null;
  const expectedFailedDrive = fault === 'no-fdd1' ? 'B' : 'C';
  const positiveControlPassed = positiveControl?.success === true;
  const inputFailurePresent =
    (positiveControl?.inputFailedDrives?.length ?? 0) > 0 ||
    attempts.some((attempt) => attempt.inputFailedDrives.length > 0);
  const attemptChecks = attempts.map((attempt) => {
    const judgementPossible = attempt.inputFailedDrives.length === 0;
    const targetFailed = attempt.driveJudgementFailedDrives.includes(expectedFailedDrive);
    const unaffectedFailedDrives = attempt.failedDrives.filter(
      (letter) => letter !== expectedFailedDrive,
    );
    const unaffectedDrivesPassed = DRIVE_LETTERS.filter((letter) => letter !== expectedFailedDrive).every(
      (letter) => attempt.drives[letter].judgement === 'passed',
    );
    const noUnaffectedDriveFailed = unaffectedFailedDrives.length === 0;
    return {
      trial: attempt.trial,
      failedDrives: attempt.failedDrives,
      indeterminateDrives: attempt.indeterminateDrives,
      inputFailedDrives: attempt.inputFailedDrives,
      driveJudgementFailedDrives: attempt.driveJudgementFailedDrives,
      judgementPossible,
      targetFailed,
      unaffectedFailedDrives,
      unaffectedDrivesPassed,
      noUnaffectedDriveFailed,
      onlyFaultedTargetFailed:
        judgementPossible && targetFailed && noUnaffectedDriveFailed,
    };
  });
  const onlyFaultedTargetFailed =
    attempts.length > 0 && attemptChecks.every((check) => check.onlyFaultedTargetFailed);
  const allDrivesFailed = attemptChecks.some((check) => check.failedDrives.length === DRIVE_LETTERS.length);
  const passed = !inputFailurePresent && positiveControlPassed && onlyFaultedTargetFailed;
  return {
    fault,
    expectedFailedDrive,
    positiveControlPassed,
    positiveControlIndeterminateDrives: positiveControl?.indeterminateDrives ?? [],
    inputFailurePresent,
    judgementPossible: !inputFailurePresent,
    detectionPowerConfirmed: positiveControlPassed,
    attemptChecks,
    indeterminateDrivesByTrial: attemptChecks
      .filter((check) => check.indeterminateDrives.length > 0)
      .map((check) => ({ trial: check.trial, drives: check.indeterminateDrives })),
    onlyFaultedTargetFailed,
    allDrivesFailed,
    passed,
    reason: inputFailurePresent
      ? '入力失敗が混在したため故障注入の判定不能'
      : !positiveControlPassed
      ? 'positive-control-failed: 正常系が成功せず検出力を確認できない'
      : onlyFaultedTargetFailed
        ? null
        : allDrivesFailed
          ? '判定が粗すぎる: 全ドライブが失敗した試行がある'
          : `故障対象 ${expectedFailedDrive}: だけの失敗を確認できない`,
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const config = buildConfig(args);
  let server = null;
  let browser = null;
  let profile = null;
  try {
    server = await startServer(config.port);
    profile = await mkdtemp(join(tmpdir(), 'webx68k-measure-drives-'));
    browser = await puppeteer.launch({
      executablePath: config.executablePath,
      userDataDir: profile,
      // headless では rAF が絞られるため、起動計測と同じくヘッドフル・前面タブで行う。
      headless: false,
      args: ['--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=1000,900'],
    });

    // 故障注入前に必ず正常系を成功として検出できることを確認する。常に失敗する検出器は
    // 故障注入だけなら通るため、陽性対照が失敗した場合は注入試行を行わない。
    const positiveControl = config.fault ? await measureOnce(browser, config, 1, null) : null;
    const attempts = [];
    if (!positiveControl || positiveControl.success) {
      for (let trial = 1; trial <= config.runs; trial++) {
        attempts.push(await measureOnce(browser, config, trial, config.fault));
      }
    }

    const summaries = buildDriveSummaries(attempts);
    const faultCheck = buildFaultCheck(config.fault, positiveControl, attempts);
    const result = {
      schemaVersion: 3,
      measuredAt: new Date().toISOString(),
      measurement: 'Human68k の DIR A:/B:/C:/D: による3ドライブ認識とTVRAM応答時間',
      config: {
        baseUrl: config.baseUrl,
        port: config.port,
        runs: config.runs,
        bootTimeoutMs: config.bootTimeoutMs,
        commandTimeoutMs: config.commandTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        keyHoldMs: config.keyHoldMs,
        keyGapMs: config.keyGapMs,
        inputRetries: config.inputRetries,
        requiredStablePolls: REQUIRED_STABLE_POLLS,
        recovery: {
          methods: ['Enter', 'Ctrl+C'],
          maxAttempts: RECOVERY_MAX_ATTEMPTS,
          timeoutMs: Math.min(config.commandTimeoutMs, RECOVERY_TIMEOUT_MS),
          successCondition: '起動完了判定と同じ条件で A> が安定して現れること',
        },
        fault: config.fault,
        headless: false,
        contextIsolation: '試行ごとに新規 BrowserContext',
      },
      timingDefinition: {
        start: '合成 Enter KeyboardEvent の keydown を dispatch したページ内 performance.now()',
        end: 'そのドライブ固有の最初の識別出力をTVRAMで観測したページ内 performance.now()',
        observationDelay: '最大で概ね pollIntervalMs 分',
      },
      inputValidation: {
        expected: 'Enter送信前の最新A>行が A>dir <drive>: と一致すること',
        cursorAllowance: '期待文字列への完全一致、または末尾にカーソル1文字だけ付加された状態',
        retryCount: config.inputRetries,
        clearMethod: 'Backspaceを現在行の文字数+2回（最低8回）送信',
        invalidationRule: '入力失敗が1件でもある試行は全ドライブの応答時間を有効値に含めない',
      },
      judgementClassification: {
        passed: 'DIR を実行し、媒体識別条件を満たした',
        failed: 'DIR の入力または媒体識別条件に失敗した',
        indeterminate: '先行DIRのタイムアウトから復帰できず、未実行のため判定不能',
      },
      identityRules: {
        A: { medium: 'FDD0 システムディスク', requiredDirectories: A_DIRECTORIES },
        B: {
          medium: 'FDD1 blank_2hd1232.xdf',
          requiredVolumeMessage: 'ボリュームがありません B:\\',
          capacityKByte: CAPACITY_RANGES_KBYTE.B,
        },
        C: {
          medium: 'HDD blank_hdd.hdf',
          requiredVolumeMessage: 'ボリュームがありません C:\\',
          capacityKByte: CAPACITY_RANGES_KBYTE.C,
        },
        D: { medium: '未割り当て', requiredMessage: 'ドライブ名が無効です' },
        capacityDesign:
          'B: と C: は容量が2桁違うため、互いに重ならない許容範囲で媒体の取り違えを検出する',
        limitation: IDENTITY_LIMITATION,
      },
      positiveControl,
      attempts,
      summaries,
      faultCheck,
      limitations: [
        IDENTITY_LIMITATION,
        '応答時刻はTVRAMのポーリング観測であり、物理ディスプレイへの表示完了時刻ではない',
        'A: の応答時刻は必須ディレクトリの最初の1件、B:/C: はボリュームなし表示、D: は無効ドライブ表示の初回観測時刻である',
      ],
    };

    await mkdir(dirname(config.outputPath), { recursive: true });
    await writeFile(config.outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

    const successCount = attempts.filter((attempt) => attempt.success).length;
    const validMeasurementCount = attempts.filter((attempt) => attempt.validMeasurement).length;
    const inputFailureCount = attempts.reduce(
      (count, attempt) => count + attempt.inputFailedDrives.length,
      0,
    );
    const driveJudgementFailureCount = attempts.reduce(
      (count, attempt) => count + attempt.driveJudgementFailedDrives.length,
      0,
    );
    const indeterminateCount = attempts.reduce(
      (count, attempt) => count + attempt.indeterminateDrives.length,
      0,
    );
    console.log(
      `3ドライブ計測: 成功 ${successCount}/${attempts.length}, ` +
        `有効試行 ${validMeasurementCount}/${attempts.length}, 出力 ${config.outputPath}`,
    );
    console.log(
      `失敗内訳: 入力失敗 ${inputFailureCount}件, ` +
        `ドライブ判定失敗 ${driveJudgementFailureCount}件, ` +
        `判定不能（未実行） ${indeterminateCount}件`,
    );
    for (const letter of DRIVE_LETTERS) {
      const summary = summaries[letter];
      console.log(
        `${letter}: 入力失敗 ${summary.inputFailed}, ` +
          `試行無効化 ${summary.invalidatedByTrialInputFailure}, ` +
          `分類 成功 ${summary.passed}/失敗 ${summary.failed}/判定不能 ${summary.indeterminate}, ` +
          `ドライブ判定 成功 ${summary.driveJudgementPassed}/失敗 ${summary.driveJudgementFailed}, ` +
          `中央値 ${summary.medianMs ?? '-'} ms, p95 ${summary.p95Ms ?? '-'} ms, ` +
          `最小 ${summary.minMs ?? '-'} ms, 最大 ${summary.maxMs ?? '-'} ms`,
      );
    }
    if (faultCheck) {
      const positiveInputFailures = positiveControl?.inputFailedDrives?.length ?? 0;
      const positiveJudgementFailures = positiveControl?.driveJudgementFailedDrives?.length ?? 0;
      console.log(
        `陽性対照: ${faultCheck.positiveControlPassed ? '成功' : '失敗（検出力を確認できない）'}, ` +
          `入力失敗 ${positiveInputFailures}件, ` +
          `ドライブ判定失敗 ${positiveJudgementFailures}件`,
      );
      if (faultCheck.positiveControlIndeterminateDrives.length > 0) {
        console.log(
          `陽性対照: 判定不能（未実行） ${faultCheck.positiveControlIndeterminateDrives.join(', ')}`,
        );
      }
      console.log(
        `故障注入 ${config.fault}: ${
          faultCheck.passed
            ? `${faultCheck.expectedFailedDrive}: だけの失敗を確認`
            : faultCheck.judgementPossible
              ? `不合格（${faultCheck.reason}）`
              : `判定不能（${faultCheck.reason}）`
        }`,
      );
      for (const entry of faultCheck.indeterminateDrivesByTrial) {
        console.log(`故障注入 試行${entry.trial}: 判定不能（未実行） ${entry.drives.join(', ')}`);
      }
      if (!faultCheck.passed) process.exitCode = 1;
    } else if (attempts.some((attempt) => !attempt.success)) {
      process.exitCode = 1;
    }
  } finally {
    if (browser) await browser.close();
    if (profile) await rm(profile, { recursive: true, force: true });
    await stopServer(server);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
