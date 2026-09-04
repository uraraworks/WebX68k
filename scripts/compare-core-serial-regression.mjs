import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const TARGET_TEST = 'Web Serial接続中も520個のマウスパケットを欠落なく処理する';

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function summarize(output) {
  const plain = stripAnsi(output);
  const summary = plain.split(/\r?\n/).findLast((line) => /^\s*Tests\s+/.test(line)) ?? '';
  return {
    failed: Number(summary.match(/(\d+) failed/)?.[1] ?? 0),
    passed: Number(summary.match(/(\d+) passed/)?.[1] ?? 0),
    targetFailed: plain.includes(`FAIL  test/core-serial-integration.test.ts > px68k-libretro SCCチャネルA結合 > ${TARGET_TEST}`),
    output: plain,
  };
}

function runCore(label, corePath) {
  if (!corePath || !existsSync(corePath)) {
    fail(`${label}コアが見つかりません: ${corePath ?? '(未指定)'}`);
  }

  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    fail('npm CLIのパスを取得できません。npm run test:core:compare から実行してください。');
  }
  const result = spawnSync(process.execPath, [npmCli, 'run', 'test:core'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NO_COLOR: '1',
      WEBX68K_TEST_CORE_JS: corePath,
    },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error) {
    fail(`${label}コアのテストを起動できません: ${result.error.message}`);
  }

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return {
    ...summarize(output),
    status: result.status ?? 1,
  };
}

const beforePath = readOption('--before');
const afterPath = readOption('--after');
if (!beforePath || !afterPath) {
  fail('使用法: npm run test:core:compare -- --before <変更前のpx68k_libretro.js> --after <変更後のpx68k_libretro.js>');
}

const before = runCore('変更前', beforePath);
const after = runCore('変更後', afterPath);

process.stdout.write(`変更前: ${before.passed}成功 / ${before.failed}失敗（対象試験: ${before.targetFailed ? '失敗を再現' : '再現せず'}）\n`);
process.stdout.write(`変更後: ${after.passed}成功 / ${after.failed}失敗\n`);

if (before.status === 0 || !before.targetFailed) {
  process.stderr.write('\n変更前コアで対象の回帰を再現できませんでした。\n');
  process.stderr.write(before.output);
  process.exit(1);
}
if (after.status !== 0) {
  process.stderr.write('\n変更後コアのテストが成功しませんでした。\n');
  process.stderr.write(after.output);
  process.exit(1);
}

process.stdout.write('比較結果: 変更後コアでマウスパケット取りこぼしの回帰が解消されています。\n');
