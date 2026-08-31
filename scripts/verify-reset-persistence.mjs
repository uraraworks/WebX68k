// 手順9(異常系の検証)の「正常 reset の保存→終了→ready」を末端まで検証するハーネス。
//
// scripts/verify-disk-persistence.mjs は「リロード」をまたいだ永続化(IndexedDBライブラリ
// 経由の保存)を検証するもので、「アプリ内のリセットボタン(restartCore()、コアを丸ごと
// 作り直すハードリセット)」は対象にしていない。本スクリプトはそちらを検証する。
//
// 検証手順:
//   1. ?system=1&run=1&fd2=/system/human302.xdf (--worker指定時は&worker=1) で起動しA>を待つ
//   2. ゲストに B: へ書き込ませる(MKDIR B:WKTEST)。打鍵後にコマンド行を読み直して検証し、
//      食い違っていれば行をクリアして打ち直す(リトライ。verify-disk-persistence.mjsのtypeCommandVerified流用)。
//   3. DIR B: でWKTESTが作成できたことを画面で確認(できていなければハーネスエラー)
//   4. #btn-reset をクリックする(リロードではなく、restartCore()経路のアプリ内リセット)。
//      restartCore()はゲストの書き込みを回収(flushAllSlots/flushAllSlotsWorker)してから
//      旧コアをdispose()し、新しいコアをbootする(docs/STORAGE-SCSI.md「ワーカー移行
//      手順9」参照)。
//   5. 再びA>に到達するのを待つ
//   6. DIR B: でWKTESTが残っていることを確認 → 合格/不合格
//
// verify-disk-persistence.mjsで確立した作法をそのまま踏襲する:
// - 「ハーネスエラー」(前提条件が満たせず検証が成立しなかった)と「不合格」(検証は成立したが
//   症状(WKTESTが無い)が出た)を区別する。
// - 打鍵は検証してリトライする(typeCommandVerified()。同じロジックを本ファイル内に複製した。
//   verify-disk-persistence.mjsをimportする形は取らない。--fault等の引数パースやURL組み立てが
//   スクリプトごとに違い、共有モジュール化は今回のスコープ外と判断した)。
// - --fault は実際に注入する(ラベルだけのフラグにしない)。src/main.tsに用意した
//   dev限定・既定offのURLパラメータ(debugDisableResetFlush=1 / debugResetFlushNoAwait=1)を
//   実際に付与して起動する。
// - --worker で両経路を通せる。

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VALID_FAULTS = new Set(['disable-reset-flush', 'reset-flush-no-await']);
const FD2_PATH = '/system/human302.xdf';
const MARKER = 'WKTEST';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 検証の前提条件が満たせなかった(検証そのものが成立しなかった)ことを表す。
 * 合格/不合格とは別の第三の状態として扱う(SKIPが合格の顔をする事故を避けるため)。 */
class HarnessError extends Error {}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} は正の整数で指定してください: ${value}`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} は0以上の整数で指定してください: ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const values = {};
  for (const arg of argv) {
    if (arg === '--help') {
      values.help = true;
      continue;
    }
    if (arg === '--worker') {
      values.worker = true;
      continue;
    }
    const match = /^--(port|boot-timeout|reset-timeout|key-hold|key-gap|type-retries|output|fault)=(.+)$/.exec(arg);
    if (!match) throw new Error(`不明な引数です: ${arg}`);
    values[match[1]] = match[2];
  }
  return values;
}

function printHelp() {
  console.log(`Usage: node scripts/verify-reset-persistence.mjs [options]

アプリ内リセット(#btn-reset、restartCore()経路)をまたいで、ゲストが書いた内容が
失われないかを検証する機能ハーネス(レイテンシ計測ではない)。

  --port=<number>            dev server のポート (既定: 5186)
  --worker                   ?worker=1 (Worker経路)で検証する。既定は既定経路。
  --boot-timeout=<ms>        起動完了(A>到達)タイムアウト (既定: 90000)
  --reset-timeout=<ms>       リセット後の再起動完了(A>到達)タイムアウト (既定: 30000)
  --key-hold=<ms>            合成キー押下の保持時間 (既定: 70)
  --key-gap=<ms>             合成キー間の間隔 (既定: 70)
  --type-retries=<number>    コマンド行の打鍵検証・リトライ上限 (既定: 3)
  --output=<path>            結果JSONの保存先
  --fault=<disable-reset-flush|reset-flush-no-await>
                             故障注入。実装側(src/main.ts)に用意した
                             dev限定・既定offのURLパラメータを実際に付与して起動する
                             (ソースの手編集は不要。付与するパラメータ:
                             disable-reset-flush -> debugDisableResetFlush=1,
                             reset-flush-no-await -> debugResetFlushNoAwait=1。
                             reset-flush-no-awaitは--worker指定時のみ意味を持つ
                             既定経路のflushAllSlots()は同一スレッド同期処理のため
                             この壊し方を再現できない)。
                             不合格(fail)になることを確認する陽性対照用。

環境変数: WEBX68K_PORT, WEBX68K_VERIFY_BOOT_TIMEOUT_MS, WEBX68K_VERIFY_OUTPUT,
          WEBX68K_URL, CHROME_PATH`);
}

function defaultOutputPath() {
  const serial = new Date().toISOString().replace(/[:.]/g, '-');
  return join(REPO_ROOT, '_local', 'measure', `reset-persistence-${serial}.json`);
}

function buildConfig(args) {
  const envUrl = process.env.WEBX68K_URL ? new URL(process.env.WEBX68K_URL) : null;
  const port = parsePositiveInteger(args.port ?? process.env.WEBX68K_PORT ?? envUrl?.port ?? '5186', 'port');
  const baseUrl = envUrl ?? new URL(`http://localhost:${port}`);
  baseUrl.port = String(port);
  const fault = args.fault ?? null;
  if (fault !== null && !VALID_FAULTS.has(fault)) {
    throw new Error(`fault は disable-reset-flush または reset-flush-no-await を指定してください: ${fault}`);
  }
  const worker = args.worker === true;
  if (fault === 'reset-flush-no-await' && !worker) {
    throw new Error('--fault=reset-flush-no-await は --worker と併用してください(既定経路では再現できない壊し方のため)');
  }
  const outputValue = args.output ?? process.env.WEBX68K_VERIFY_OUTPUT ?? defaultOutputPath();
  return {
    baseUrl: baseUrl.href.replace(/\/$/, ''),
    port,
    worker,
    bootTimeoutMs: parsePositiveInteger(
      args['boot-timeout'] ?? process.env.WEBX68K_VERIFY_BOOT_TIMEOUT_MS ?? '90000',
      'boot-timeout',
    ),
    resetTimeoutMs: parsePositiveInteger(args['reset-timeout'] ?? '30000', 'reset-timeout'),
    keyHoldMs: parsePositiveInteger(args['key-hold'] ?? '70', 'key-hold'),
    keyGapMs: parsePositiveInteger(args['key-gap'] ?? '70', 'key-gap'),
    typeRetries: parseNonNegativeInteger(args['type-retries'] ?? '3', 'type-retries'),
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
  child.stdout.on('data', (b) => {
    startupOutput += b.toString();
    if (/ready in|Local:\s+http/.test(startupOutput)) ready = true;
  });
  child.stderr.on('data', (b) => {
    startupOutput += b.toString();
  });
  const deadline = Date.now() + 20000;
  while (!ready && child.exitCode === null && Date.now() < deadline) await sleep(300);
  if (!ready) {
    await stopServer(child);
    throw new Error(`dev server を起動できませんでした: ${startupOutput.trim()}`);
  }
  await sleep(500);
  return child;
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((r) => {
    const timer = setTimeout(r, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      r();
    });
    child.kill('SIGTERM');
  });
}

/** 故障注入は src/main.ts に用意した dev限定・既定offのURLパラメータを実際に付与する形で
 * 行う(verify-disk-persistence.mjsと同じ理由・同じ流儀)。 */
function buildUrl(config) {
  const url = new URL(config.baseUrl);
  url.searchParams.set('system', '1');
  url.searchParams.set('run', '1');
  url.searchParams.set('fd2', FD2_PATH);
  if (config.worker) url.searchParams.set('worker', '1');
  if (config.fault === 'disable-reset-flush') url.searchParams.set('debugDisableResetFlush', '1');
  if (config.fault === 'reset-flush-no-await') url.searchParams.set('debugResetFlushNoAwait', '1');
  return url.href;
}

async function waitForBootPrompt(page, timeoutMs) {
  await page.waitForFunction(
    async () => {
      const dump = await window.__webx68kDebug?.screenText?.();
      if (!dump?.available) return false;
      const lines = dump.lines.filter((l) => l.length > 0);
      const last = lines.filter((l) => l.startsWith('A>')).at(-1);
      return last !== undefined && last.length <= 2;
    },
    { timeout: timeoutMs, polling: 100 },
  );
}

/** 1文字 -> 合成KeyboardEventのcode/key。verify-disk-persistence.mjsと同じ範囲。 */
function keySpecForChar(ch) {
  if (/^[a-z]$/.test(ch)) return { code: `Key${ch.toUpperCase()}`, key: ch };
  if (/^[0-9]$/.test(ch)) return { code: `Digit${ch}`, key: ch };
  if (ch === ' ') return { code: 'Space', key: ' ' };
  if (ch === ':') return { code: 'Quote', key: ':' };
  throw new Error(`keySpecForChar: 未対応の文字です: ${JSON.stringify(ch)}`);
}

async function dispatchKeys(page, specs, config) {
  await page.evaluate(
    async ({ keySpecs, keyHold, keyGap }) => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      for (const spec of keySpecs) {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { code: spec.code, key: spec.key, bubbles: true, composed: true, cancelable: true }),
        );
        await wait(keyHold);
        window.dispatchEvent(
          new KeyboardEvent('keyup', { code: spec.code, key: spec.key, bubbles: true, composed: true, cancelable: true }),
        );
        await wait(keyGap);
      }
    },
    { keySpecs: specs, keyHold: config.keyHoldMs, keyGap: config.keyGapMs },
  );
}

async function readScreenLines(page) {
  return page.evaluate(async () => {
    const dump = await window.__webx68kDebug?.screenText?.();
    return dump?.available && Array.isArray(dump.lines) ? dump.lines.filter((l) => l.length > 0) : [];
  });
}

async function readPromptLine(page) {
  const lines = await readScreenLines(page);
  return lines.filter((l) => l.startsWith('A>')).at(-1) ?? null;
}

/** カーソルが行末に1文字だけ付くことがある(verify-disk-persistence.mjsと同じ配慮)。 */
function promptLineMatches(line, expected) {
  if (line === expected) return true;
  if (line === null || !line.startsWith(expected)) return false;
  return Array.from(line.slice(expected.length)).length === 1;
}

async function waitForPromptSettled(page, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  let lastLine = null;
  let stableCount = 0;
  while (Date.now() < deadline) {
    const line = await readPromptLine(page);
    if (line !== null && line === lastLine) {
      stableCount++;
      if (stableCount >= 3) return line;
    } else {
      stableCount = 0;
    }
    lastLine = line;
    await sleep(pollIntervalMs);
  }
  return lastLine;
}

/**
 * コマンド文字列を打鍵し、コマンド行を読み直して期待どおりかを検証する。食い違っていれば
 * 行をクリアして打ち直す(verify-disk-persistence.mjsのtypeCommandVerified()と同一ロジック。
 * 「同じものを書き直さない」ため import する形も検討したが、--fault/URL組み立てが
 * スクリプトごとに違い、共有モジュール化はスコープ外と判断してここに複製した)。
 */
async function typeCommandVerified(page, command, config) {
  const expected = `A>${command}`;
  for (let attempt = 0; attempt <= config.typeRetries; attempt++) {
    if (attempt > 0) {
      const current = await readPromptLine(page);
      const typedLength = current && current.startsWith('A>') ? Array.from(current.slice(2)).length : 0;
      const backspaceCount = Math.max(8, Math.min(80, typedLength + 4));
      const backspaces = Array.from({ length: backspaceCount }, () => ({ code: 'Backspace', key: 'Backspace' }));
      await dispatchKeys(page, backspaces, config);
      await sleep(300);
    }
    const specs = Array.from(command).map((ch) => keySpecForChar(ch));
    await dispatchKeys(page, specs, config);
    await sleep(300);
    const line = await readPromptLine(page);
    if (promptLineMatches(line, expected)) {
      return { retries: attempt, observedLine: line };
    }
  }
  const finalLine = await readPromptLine(page);
  throw new HarnessError(
    `コマンド行の打鍵が${config.typeRetries}回リトライしても一致しませんでした(症状ではなくハーネスの入力信頼性の問題として扱う): ` +
      `expected=${JSON.stringify(expected)}, observed=${JSON.stringify(finalLine)}`,
  );
}

/** DIR B: を実行し、直後の画面出力にMARKERが含まれるかを返す。 */
async function checkMarkerViaDir(page, config) {
  const typing = await typeCommandVerified(page, 'dir b:', config);
  await dispatchKeys(page, [{ code: 'Enter', key: 'Enter' }], config);
  await sleep(Math.max(1000, config.keyHoldMs + config.keyGapMs) * 3);
  const lines = await readScreenLines(page);
  const text = lines.join('\n').toUpperCase();
  return { found: text.includes(MARKER), lines, retries: typing.retries };
}

/** #btn-reset をクリックする。ボタンがdisabledのまま(=起動未完了)であればハーネスエラー。 */
async function clickResetButton(page) {
  const disabled = await page.evaluate(() => {
    const btn = document.getElementById('btn-reset');
    if (!btn) return 'missing';
    return btn.disabled ? 'disabled' : 'ok';
  });
  if (disabled === 'missing') throw new HarnessError('#btn-reset が見つかりませんでした(DOM構造の変更?)');
  if (disabled === 'disabled') throw new HarnessError('#btn-reset がdisabledのままでした(起動未完了?)');
  await page.click('#btn-reset');
}

async function verifyOnce(browser, config) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 2 });
  await page.bringToFront();
  const steps = [];
  const retries = {};
  // src/main.tsのrestartCore()失敗経路(btnReset.addEventListener内の.catch)はalert()を呼ぶ。
  // ヘッドフルPuppeteerでdialogハンドラを登録していないと、alert()はOSレベルのモーダルとして
  // 実際にJS実行をブロックし続け、以後__webx68kDebug経由の全評価が固まってwaitForBootPrompt()が
  // 原因不明のタイムアウトになる(症状と原因が一見結びつかない)。ここで検出してHarnessErrorに
  // 変換し、原因を握り潰さない。
  const dialogMessages = [];
  page.on('dialog', (dialog) => {
    dialogMessages.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss().catch(() => {});
  });

  const closeAndReturn = async (result) => {
    await context.close();
    return { ...result, retries };
  };

  try {
    return await verifySteps(page, config, steps, retries, closeAndReturn, dialogMessages);
  } catch (err) {
    // HarnessErrorはrun()側でsteps:[]固定にしていたが、それだと「どこまで進んだか」が
    // 結果JSONから消え、タイムアウト等の原因切り分けがしづらい。ここで積み上がった
    // stepsをエラーオブジェクトに載せてrun()側で使えるようにする。
    if (err instanceof HarnessError) err.steps = steps;
    throw err;
  }
}

async function verifySteps(page, config, steps, retries, closeAndReturn, dialogMessages) {
  const url = buildUrl(config);
  await page.goto(url, { waitUntil: 'networkidle2' });
  await page.bringToFront();
  try {
    await waitForBootPrompt(page, config.bootTimeoutMs);
  } catch (err) {
    throw new HarnessError(`起動タイムアウト(A>に到達しませんでした): ${err.message}`);
  }
  steps.push('boot');

  // 手順1: B: へ書き込ませる(打鍵検証・リトライ込み)。
  const mkdirTyping = await typeCommandVerified(page, 'mkdir b:wktest', config);
  retries.mkdir = mkdirTyping.retries;
  await dispatchKeys(page, [{ code: 'Enter', key: 'Enter' }], config);
  await waitForPromptSettled(page, 8000, 200);
  steps.push('mkdir-sent');

  // 手順2: DIR B: で作成できたことを画面で確認。
  const createdCheck = await checkMarkerViaDir(page, config);
  retries.dirAfterMkdir = createdCheck.retries;
  if (!createdCheck.found) {
    throw new HarnessError(
      `MKDIR B:WKTEST の作成を画面で確認できませんでした(DIR B: の出力にWKTESTが無い)。出力: ${JSON.stringify(createdCheck.lines)}`,
    );
  }
  steps.push('mkdir-confirmed');

  // 手順3: リセットボタンを押す(restartCore()経路)。リロードは使わない。
  try {
    await clickResetButton(page);
  } catch (err) {
    if (err instanceof HarnessError) throw err;
    throw new HarnessError(`#btn-resetのクリックに失敗しました: ${err.message}`);
  }
  steps.push('reset-clicked');

  // 手順4: 再びA>に到達するのを待つ。
  try {
    await waitForBootPrompt(page, config.resetTimeoutMs);
  } catch (err) {
    // リセット後に起動しなかった場合、故障注入によってはこれ自体が症状(fail)の可能性もあるが、
    // 「起動そのものが完了しない」のは前提条件の欠落に近いと判断しHarnessErrorにする
    // (WKTESTの有無で判定するpass/failとは性質が違う。verify-disk-persistence.mjsの
    // 「リロード後の起動タイムアウト」と同じ扱い)。
    const dialogNote = dialogMessages.length > 0 ? ` / ページ内dialog検出: ${JSON.stringify(dialogMessages)}` : '';
    throw new HarnessError(`リセット後の起動タイムアウト: ${err.message}${dialogNote}`);
  }
  steps.push('reset-boot');

  // 手順5: DIR B: でWKTESTが残っていることを確認。
  const survivedCheck = await checkMarkerViaDir(page, config);
  retries.dirAfterReset = survivedCheck.retries;
  if (!survivedCheck.found) {
    return closeAndReturn({
      result: 'fail',
      reason: `リセット後、DIR B: の出力にWKTESTが見つかりませんでした(症状: リセットで書き込みが失われた)。出力: ${JSON.stringify(survivedCheck.lines)}`,
      steps: [...steps, 'reset-check-failed'],
    });
  }
  steps.push('reset-check-passed');

  return closeAndReturn({ result: 'pass', reason: 'リセット後もDIR B: にWKTESTが残っていることを確認した', steps });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const config = buildConfig(args);
  let server;
  let browser;
  let profile;
  const startedAt = new Date().toISOString();
  let outcome;
  try {
    server = await startServer(config.port);
    profile = await mkdtemp(join(tmpdir(), 'webx68k-verify-reset-persistence-'));
    browser = await puppeteer.launch({
      executablePath: config.executablePath,
      userDataDir: profile,
      headless: false,
      args: ['--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=1000,900'],
    });

    try {
      outcome = await verifyOnce(browser, config);
    } catch (err) {
      if (err instanceof HarnessError) {
        outcome = { result: 'harness-error', reason: err.message, steps: err.steps ?? [], retries: {} };
      } else {
        throw err;
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await stopServer(server);
  }

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    config: {
      worker: config.worker,
      port: config.port,
      bootTimeoutMs: config.bootTimeoutMs,
      resetTimeoutMs: config.resetTimeoutMs,
      typeRetries: config.typeRetries,
      fault: config.fault,
    },
    outcome,
  };

  await mkdir(dirname(config.outputPath), { recursive: true });
  await writeFile(config.outputPath, JSON.stringify(report, null, 2));

  console.log(`経路: ${config.worker ? 'Worker(?worker=1)' : '既定'}`);
  console.log(`故障注入: ${config.fault ?? '(なし)'}`);
  console.log(`結果: ${outcome.result}`);
  console.log(`理由: ${outcome.reason}`);
  console.log(`ステップ: ${outcome.steps.join(' -> ')}`);
  console.log(`打鍵リトライ: ${JSON.stringify(outcome.retries)}`);
  console.log(`結果JSON: ${config.outputPath}`);

  if (outcome.result !== 'pass') process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
