// リロード(プロファイルの使い回し)をまたいで、SCSI(OPFS書き戻し経路)に書いた
// ファイルが「中身まで」残るかを検証するハーネス。
//
// 2026-09-04 に scripts/probe-scsi-iocs.mjs 側でOPFS書き戻し(--scsi-opfs)が成立する
// ところまでは実測済みだが(docs/STORAGE-SCSI.md 末尾3節参照)、判定は毎回「ディレクトリの
// 表示だけ」だった。直前まで踏んでいた不具合は「ディレクトリには正しい名前とサイズが出るのに
// 末尾の端数バイトだけが静かに落ちる」というもので、ディレクトリ表示だけの判定ではこれを
// 見逃す。本スクリプトは中身(先頭行と最終行のマーカー)まで読み返して判定する。
//
// scripts/probe-scsi-iocs.mjs を子プロセスとして呼ぶ薄いオーケストレータにしてある
// (打鍵まわりは何度も事故が起きて固められている。打鍵処理をここで自作しない)。
// 引数パース・--help・結果JSON出力・「ハーネスエラー」と「不合格」の区別・
// 故障注入+陽性対照の流儀は scripts/verify-disk-persistence.mjs に合わせた。
//
// 手順:
//   1. scripts/_gen-scsi-marker.mts で検体(SRC.TXT, HEAD-<id>〜TAIL-<id>)を作る
//      (<id>は実行ごとにランダム。使い回さない)
//   2. 書き込み実行(新しいプロファイルP): copy c:\src.txt c:\persist.txt;;dir c:
//      合格の前提(満たせなければハーネスエラー): typedMismatchがnull、画面に
//      コピー完了メッセージ、dir c:にpersistが出ている。打鍵は化けることがあるので
//      1回だけ再試行する。OPFSのflushには最大2秒の窓があるので、この実行のあと
//      数秒待つ(固定sleep。理由は上記flush窓)。
//   3. 読み返し実行(同じプロファイルP、同じ検体): type c:\persist.txt
//      合格条件: 画面にHEAD-<id>とTAIL-<id>の両方が現れること。あわせて、
//      この実行のログに「SCSI I/O: opfs (... 取り込み=なし)」が出ていること
//      (=検体を入れ直していない)と、この実行のwriteCountが0であることを記録する
//      (画面のファイルが「この実行で作られたもの」でない裏取り)。
//      TAILだけ無い場合は「末尾が落ちた」として単なる不合格と区別する
//      (直した不具合の再発)。
//   4. 陰性対照(新しいプロファイルQ、同じ検体): type c:\persist.txt
//      HEAD-<id>もTAIL-<id>も現れないこと。現れたらハーネスエラー
//      (検体自体に混入している=この検査は何でも通す)。
//   5. 故障注入+陽性対照(--fault指定時のみ、新しいプロファイルR):
//      手順2相当を --scsi-oracle-reply=0 を足して行い、手順3相当を同じRで行う。
//      TAIL-<id>が現れないことが期待。現れたら「この検査は修正の有無を見分けられて
//      いない」としてハーネスエラー。注入によりcopy自体が失敗することは想定内
//      (「注入により書き込みが成立しなかった」と記録し、陽性対照としては成立とみなす)。
//
// 終了コード: 合格=0、不合格=1、ハーネスエラー=2(区別する。SKIPが合格の顔をする事故が
// 過去にあるため)。
//
// 一時ファイル・プロファイルは _local/scsi/probes/ 配下(.gitignore済み)に作る。
// リポジトリに検体やプロファイルは入れない。

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const VALID_FAULTS = new Set(['no-oracle-reply', 'all']);
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

// --flush-grace は 0 を許す(デバウンスflush(src/scsi-opfs.ts)が効くようになったA/B比較で、
// 「待たずに読み返しても残るか」を確かめたいため)。他の待ち時間パラメータはそのまま
// parsePositiveInteger(>0必須)を使う。
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
    const match =
      /^--(port|probe-timeout|timeout|type-wait|post-write-wait|flush-grace|poll-scsi-debug|output|fault|chrome)=(.+)$/.exec(
        arg,
      );
    if (!match) throw new Error(`不明な引数です: ${arg}`);
    values[match[1]] = match[2];
  }
  return values;
}

function printHelp() {
  console.log(`Usage: node scripts/verify-scsi-persistence.mjs [options]

SCSI(OPFS書き戻し経路)に書いたファイルが、ブラウザプロファイルを使い回した
リロードをまたいで「中身まで」残るかを検証する機能ハーネス。
scripts/probe-scsi-iocs.mjs を子プロセスとして呼ぶオーケストレータ(打鍵は自作しない)。

  --port=<number>             probe-scsi-iocs.mjs のdev serverポート (既定: 5311)
  --type-wait=<ms>             打鍵後の待ち時間、probeへ--type-waitとして渡す (既定: 5000)
  --probe-timeout=<ms>         probe側の起動待ちタイムアウト(--timeout) (既定: 150000)
  --timeout=<ms>               このスクリプト側の子プロセス強制終了タイムアウト
                                (probe-timeoutより大きい値。既定: probe-timeout+60000)
  --post-write-wait=<ms>       (--flush-graceの旧名。互換のため残す。両方指定時は
                                --flush-graceを優先)
  --flush-grace=<ms>           書き込み実行の直後に置く固定待ち。デバウンスflush
                                (src/scsi-opfs.ts、既定250ms)が効くようになったため
                                目安は短くなったが、保険の定期flush(2秒)を跨ぎたい
                                検証のために残す。0を指定すると待たずに読み返す
                                (既定: 5000)
  --poll-scsi-debug=<ms>       読み返し実行でwriteCountを裏取りするポーリング時間
                                (既定: 8000)
  --fault=<no-oracle-reply|all>
                                故障注入+陽性対照を実行する(新しいプロファイルRで
                                --scsi-oracle-reply=0を足した書き込み→読み返しを行い、
                                TAIL-<id>が現れないことを確かめる)。未指定なら
                                この段は行わない(時間がかかるため)。
  --chrome=<path>               probeへ--chromeとして渡すChrome実行ファイルパス
  --output=<path>               結果JSONの保存先

終了コード: 合格=0、不合格=1、ハーネスエラー=2`);
}

function defaultOutputPath() {
  const serial = new Date().toISOString().replace(/[:.]/g, '-');
  return join(REPO_ROOT, '_local', 'scsi', 'probes', `verify-scsi-persistence-${serial}.json`);
}

function buildConfig(args) {
  const fault = args.fault ?? null;
  if (fault !== null && !VALID_FAULTS.has(fault)) {
    throw new Error(`fault は no-oracle-reply または all を指定してください: ${fault}`);
  }
  const probeTimeoutMs = parsePositiveInteger(args['probe-timeout'] ?? '150000', 'probe-timeout');
  const outputValue = args.output ?? defaultOutputPath();
  return {
    port: parsePositiveInteger(args.port ?? '5311', 'port'),
    typeWaitMs: parsePositiveInteger(args['type-wait'] ?? '5000', 'type-wait'),
    probeTimeoutMs,
    // 子プロセス強制終了のタイムアウトはprobe側の起動待ちタイムアウトより
    // 十分大きくする(probe自身が正常に打ち切るより先にここで殺してしまうと、
    // 「打ち切られた」のか「ハングした」のかが区別できなくなる)。
    childTimeoutMs: parsePositiveInteger(args.timeout ?? String(probeTimeoutMs + 60000), 'timeout'),
    postWriteWaitMs: parseNonNegativeInteger(
      args['flush-grace'] ?? args['post-write-wait'] ?? '5000',
      args['flush-grace'] !== undefined ? 'flush-grace' : 'post-write-wait',
    ),
    pollScsiDebugMs: parsePositiveInteger(args['poll-scsi-debug'] ?? '8000', 'poll-scsi-debug'),
    fault,
    chrome: args.chrome ?? null,
    outputPath: isAbsolute(outputValue) ? outputValue : resolve(REPO_ROOT, outputValue),
  };
}

function randomId() {
  return randomBytes(4).toString('hex');
}

/** scripts/_gen-scsi-marker.mts を子プロセスとして呼び、検体を作る。 */
async function genFixture(outPath, id) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('./node_modules/.bin/vite-node', ['scripts/_gen-scsi-marker.mts', outPath, id], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (b) => {
      stderr += b.toString();
    });
    child.on('close', (code) => {
      if (code !== 0) {
        rejectPromise(new HarnessError(`検体生成(_gen-scsi-marker.mts)に失敗しました(code=${code}): ${stderr.trim()}`));
      } else {
        resolvePromise(stderr.trim());
      }
    });
    child.on('error', (err) => {
      rejectPromise(new HarnessError(`検体生成スクリプトを起動できませんでした: ${err.message}`));
    });
  });
}

/** scripts/probe-scsi-iocs.mjs を子プロセスとして呼ぶ。stdoutはJSON1個だけの前提
 * (probe側はconsole.logを最後に1回しか呼ばない)。 */
async function runProbe(extraArgs, config, label) {
  const argv = [
    'scripts/probe-scsi-iocs.mjs',
    `--port=${config.port}`,
    `--timeout=${config.probeTimeoutMs}`,
    '--scsi-opfs',
    '--scsi-verbose-log=0',
    ...(config.chrome ? [`--chrome=${config.chrome}`] : []),
    ...extraArgs,
  ];
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('node', argv, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => {
      stdout += b.toString();
    });
    child.stderr.on('data', (b) => {
      stderr += b.toString();
    });
    let killedForTimeout = false;
    const timer = setTimeout(() => {
      killedForTimeout = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 5000);
    }, config.childTimeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killedForTimeout) {
        rejectPromise(
          new HarnessError(
            `[${label}] probe-scsi-iocs.mjs が --timeout(${config.childTimeoutMs}ms) を超えたため強制終了しました`,
          ),
        );
        return;
      }
      if (code !== 0) {
        rejectPromise(
          new HarnessError(`[${label}] probe-scsi-iocs.mjs が異常終了しました(code=${code}): ${stderr.slice(-2000)}`),
        );
        return;
      }
      let json;
      try {
        json = JSON.parse(stdout);
      } catch (err) {
        rejectPromise(
          new HarnessError(
            `[${label}] probe-scsi-iocs.mjs の出力をJSONとして解釈できませんでした: ${err.message}\n` +
              `stdout末尾: ${stdout.slice(-1000)}\nstderr末尾: ${stderr.slice(-1000)}`,
          ),
        );
        return;
      }
      resolvePromise(json);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectPromise(new HarnessError(`[${label}] 子プロセスを起動できませんでした: ${err.message}`));
    });
  });
}

function screenHas(json, substr, caseInsensitive = false) {
  if (!Array.isArray(json.typedScreen)) return false;
  return json.typedScreen.some((l) =>
    caseInsensitive ? l.toUpperCase().includes(substr.toUpperCase()) : l.includes(substr),
  );
}

/** 書き込み実行(copy;;dir)が「実行として成立したか」の判定。中身の永続化そのものは
 * 手順3(読み返し)で見るので、ここでは前提が満たせたかだけを見る。 */
function evaluateWrite(json) {
  const reasons = [];
  if (json.typedMismatch !== null) reasons.push(`打鍵が画面と一致しない: ${json.typedMismatch}`);
  if (!screenHas(json, '個のファイルをコピーしました')) reasons.push('コピー完了メッセージが画面に無い');
  if (!screenHas(json, 'PERSIST', true)) reasons.push('dir c: の出力にpersistが出ていない');
  return { ok: reasons.length === 0, reasons };
}

/** copy;;dir を1回打鍵する。打鍵の取りこぼしはtypedMismatchで検出できるので、
 * それが起きた場合だけ1回だけ再試行する(仕様どおり。無制限リトライはしない)。 */
async function performWrite(fixturePath, profileDir, config, { oracleReplyOff = false, label }) {
  const extraArgs = [
    `--profile=${profileDir}`,
    `--image=${fixturePath}`,
    '--type=copy c:\\src.txt c:\\persist.txt;;dir c:',
    `--type-wait=${config.typeWaitMs}`,
  ];
  if (oracleReplyOff) extraArgs.push('--scsi-oracle-reply=0');
  let json = null;
  let attempts = 0;
  for (; attempts < 2; attempts++) {
    json = await runProbe(extraArgs, config, label);
    if (json.typedMismatch === null) break;
  }
  return { json, attempts: attempts + 1 };
}

/** type c:\persist.txt を1回打鍵する。打鍵取りこぼし対策の再試行は書き込みと同様1回だけ。 */
async function performReadback(fixturePath, profileDir, config, label) {
  const extraArgs = [
    `--profile=${profileDir}`,
    `--image=${fixturePath}`,
    '--type=type c:\\persist.txt',
    `--type-wait=${config.typeWaitMs}`,
    `--poll-scsi-debug=${config.pollScsiDebugMs}`,
  ];
  let json = null;
  let attempts = 0;
  for (; attempts < 2; attempts++) {
    json = await runProbe(extraArgs, config, label);
    if (json.typedMismatch === null) break;
  }
  return { json, attempts: attempts + 1 };
}

/** 読み返し結果からHEAD/TAILの有無と裏取り情報(取り込み=なし、writeCount=0)を取り出す。 */
function evaluateReadback(json, id) {
  const head = `HEAD-${id}`;
  const tail = `TAIL-${id}`;
  const hasHead = screenHas(json, head);
  const hasTail = screenHas(json, tail);
  const importedNone =
    Array.isArray(json.rawUnparsed) &&
    json.rawUnparsed.some((l) => l.includes('SCSI I/O: opfs') && l.includes('取り込み=なし'));
  const importedSome =
    Array.isArray(json.rawUnparsed) &&
    json.rawUnparsed.some((l) => l.includes('SCSI I/O: opfs') && l.includes('取り込み=あり'));
  const samples = Array.isArray(json.scsiDebugSamples)
    ? json.scsiDebugSamples.filter((s) => s && typeof s.writeCount === 'number')
    : [];
  const lastSample = samples.length > 0 ? samples[samples.length - 1] : null;
  const writeCountZero = lastSample ? lastSample.writeCount === 0 : null; // null=観測できず
  return { hasHead, hasTail, importedNone, importedSome, writeCountZero, lastSample, typedMismatch: json.typedMismatch };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const config = buildConfig(args);
  const serial = new Date().toISOString().replace(/[:.]/g, '-');
  const workDir = join(REPO_ROOT, '_local', 'scsi', 'probes', `verify-${serial}`);
  await mkdir(workDir, { recursive: true });

  const id = randomId();
  const fixturePath = join(workDir, 'marker.hds');
  const profileP = join(workDir, 'profile-P');
  const profileQ = join(workDir, 'profile-Q');
  const profileR = join(workDir, 'profile-R');

  const log = [];
  const record = (msg) => {
    log.push(msg);
    console.error(`[verify] ${msg}`);
  };

  const startedAt = new Date().toISOString();
  const stages = {};
  let outcome;

  try {
    // 手順1: 検体を作る。
    record(`検体を生成: id=${id} -> ${fixturePath}`);
    const genLog = await genFixture(fixturePath, id);
    stages.fixture = { id, path: fixturePath, genLog };
    record(genLog);

    // 手順2: 書き込み実行(新しいプロファイルP)。
    record(`書き込み実行(profile=P): ${profileP}`);
    const write = await performWrite(fixturePath, profileP, config, { label: 'write' });
    const writeEval = evaluateWrite(write.json);
    stages.write = {
      profile: profileP,
      attempts: write.attempts,
      typedMismatch: write.json.typedMismatch,
      typedScreen: write.json.typedScreen,
      ok: writeEval.ok,
      reasons: writeEval.reasons,
    };
    if (!writeEval.ok) {
      throw new HarnessError(
        `書き込み実行の前提が満たせませんでした(${write.attempts}回試行): ${writeEval.reasons.join(' / ')}`,
      );
    }
    record(`書き込み実行OK(${write.attempts}回試行)`);

    // OPFSのflushには最大2秒の窓がある(scripts/verify-scsi-persistence.mjsのコメント冒頭
    // 参照、実体はsrc/scsi-opfs.tsのflush()。dirtyを立てて2秒ごとにまとめて書く)。
    // ここでは子プロセス終了直後に念のため固定sleepを置き、次のブラウザ起動までの
    // 猶予を作る(flush自体はprobe実行中の待ち時間(--type-wait)で既に走っているはずだが、
    // 仕様の要求どおり実行後にも待つ)。
    record(`flush猶予として${config.postWriteWaitMs}ms待機`);
    await sleep(config.postWriteWaitMs);

    // 手順3: 読み返し実行(同じプロファイルP、同じ検体)。
    record(`読み返し実行(profile=P): ${profileP}`);
    const readback = await performReadback(fixturePath, profileP, config, 'readback-P');
    const readbackEval = evaluateReadback(readback.json, id);
    stages.readback = {
      profile: profileP,
      attempts: readback.attempts,
      typedMismatch: readbackEval.typedMismatch,
      typedScreen: readback.json.typedScreen,
      hasHead: readbackEval.hasHead,
      hasTail: readbackEval.hasTail,
      importedNone: readbackEval.importedNone,
      importedSome: readbackEval.importedSome,
      writeCountZero: readbackEval.writeCountZero,
      lastScsiDebugSample: readbackEval.lastSample,
    };
    // 打鍵エコーの照合は「目印が1つも見つからなかったとき」だけ効かせる。
    // 実測(2026-09-04): `type` の出力がテキスト画面(96列×32行)を溢れさせると、
    // コマンドのエコー行そのものが上へ流れて消える。目印が読めているのに
    // 「打鍵が一致しない」でハーネスエラーにするのは、証拠があるのに
    // 手続きの都合で捨てているだけになる。
    // 逆に目印が1つも無い場合は「本当に残っていない」と「打鍵が化けた」を
    // 区別できないので、ハーネスエラーにして不合格とは呼ばない。
    if (readbackEval.typedMismatch !== null && !readbackEval.hasHead && !readbackEval.hasTail) {
      throw new HarnessError(
        `読み返し実行の打鍵が画面と一致せず、目印も1つも読めませんでした` +
          `(残っていないのか打鍵が化けたのか区別できません): ${readbackEval.typedMismatch}`,
      );
    }
    if (readbackEval.typedMismatch !== null) {
      record(
        `読み返し実行の打鍵エコーは照合できなかったが、目印は読めている` +
          `(typeの出力で画面から流れたとみられる): ${readbackEval.typedMismatch}`,
      );
    }
    record(
      `読み返し結果: HEAD=${readbackEval.hasHead} TAIL=${readbackEval.hasTail} ` +
        `取り込み=なし裏取り=${readbackEval.importedNone} writeCount=0裏取り=${readbackEval.writeCountZero}`,
    );

    // 主判定と矛盾する裏取りが出た場合(取り込みが起きていた/この実行で書き込みが
    // 発生していた)は、検査の前提そのものが崩れているのでハーネスエラーとして扱う
    // (「陽性対照が自分だけの抜け道を通る」事故を避けるため、主判定だけで通さない)。
    if (readbackEval.hasHead && readbackEval.hasTail) {
      if (readbackEval.importedSome) {
        throw new HarnessError(
          '読み返し実行でHEAD/TAILは検出できましたが、この実行でSCSIイメージを再度取り込んでいます' +
            '(取り込み=あり)。持続していたのではなく、検体の内容がそのまま見えているだけの疑いがあります。',
        );
      }
      if (readbackEval.writeCountZero === false) {
        throw new HarnessError(
          '読み返し実行でHEAD/TAILは検出できましたが、この実行自体でwriteCount>0でした。' +
            '「この実行で作られたものではない」という裏取りが取れていません。',
        );
      }
    }

    // 主判定: 合格/不合格(不合格は「末尾が落ちた」と「完全に無い」を区別する)。
    let persistenceResult;
    if (readbackEval.hasHead && readbackEval.hasTail) {
      persistenceResult = { result: 'pass', reason: 'HEAD/TAILとも読み返せた' };
    } else if (readbackEval.hasHead && !readbackEval.hasTail) {
      persistenceResult = {
        result: 'fail',
        reason: 'tail-truncated: HEADは読み返せたがTAILが無い(末尾が落ちた。直した不具合の再発)',
      };
    } else if (!readbackEval.hasHead && !readbackEval.hasTail) {
      persistenceResult = {
        result: 'fail',
        reason: 'not-found: HEAD/TAILとも読み返せなかった(永続化されていない)',
      };
    } else {
      persistenceResult = {
        result: 'fail',
        reason: 'head-missing-tail-present: TAILは読み返せたがHEADが無い(想定外のパターン)',
      };
    }
    stages.persistence = persistenceResult;
    record(`主判定: ${persistenceResult.result} (${persistenceResult.reason})`);

    // 手順4: 陰性対照(新しいプロファイルQ、同じ検体)。
    record(`陰性対照(profile=Q): ${profileQ}`);
    const negative = await performReadback(fixturePath, profileQ, config, 'readback-Q');
    const negativeEval = evaluateReadback(negative.json, id);
    stages.negativeControl = {
      profile: profileQ,
      attempts: negative.attempts,
      typedMismatch: negativeEval.typedMismatch,
      typedScreen: negative.json.typedScreen,
      hasHead: negativeEval.hasHead,
      hasTail: negativeEval.hasTail,
    };
    if (negativeEval.typedMismatch !== null) {
      throw new HarnessError(`陰性対照の打鍵が画面と一致しませんでした: ${negativeEval.typedMismatch}`);
    }
    if (negativeEval.hasHead || negativeEval.hasTail) {
      throw new HarnessError(
        `陰性対照(新しいプロファイル)でHEAD/TAILが検出されました(HEAD=${negativeEval.hasHead}, ` +
          `TAIL=${negativeEval.hasTail})。この検査は検体自体に混入している内容を検出しているだけで、` +
          '何を測っても合格してしまいます。',
      );
    }
    record('陰性対照OK(HEAD/TAILとも検出されなかった)');

    // 手順5: 故障注入+陽性対照(--fault指定時のみ)。
    if (config.fault !== null) {
      record(`故障注入(--scsi-oracle-reply=0、profile=R): ${profileR}`);
      const faultWrite = await performWrite(fixturePath, profileR, config, {
        oracleReplyOff: true,
        label: 'fault-write',
      });
      const faultWriteEval = evaluateWrite(faultWrite.json);
      // 故障注入時はcopy自体が失敗することがある(従来は要求ごと停止していた挙動)。
      // それも想定内なので、ここではエラーにせず記録するだけにする。
      stages.faultWrite = {
        profile: profileR,
        attempts: faultWrite.attempts,
        typedMismatch: faultWrite.json.typedMismatch,
        typedScreen: faultWrite.json.typedScreen,
        copySucceededOnScreen: faultWriteEval.ok,
        reasons: faultWriteEval.reasons,
      };
      if (faultWrite.json.typedMismatch !== null) {
        throw new HarnessError(`故障注入の書き込み実行で打鍵が画面と一致しませんでした: ${faultWrite.json.typedMismatch}`);
      }
      record(
        `故障注入の書き込み実行: 画面上のコピー成立=${faultWriteEval.ok}` +
          (faultWriteEval.ok ? '' : `(${faultWriteEval.reasons.join(' / ')}、注入により書き込みが成立しなかった)`),
      );

      await sleep(config.postWriteWaitMs);

      record(`故障注入の読み返し実行(profile=R): ${profileR}`);
      const faultReadback = await performReadback(fixturePath, profileR, config, 'fault-readback-R');
      const faultReadbackEval = evaluateReadback(faultReadback.json, id);
      stages.faultReadback = {
        profile: profileR,
        attempts: faultReadback.attempts,
        typedMismatch: faultReadbackEval.typedMismatch,
        typedScreen: faultReadback.json.typedScreen,
        hasHead: faultReadbackEval.hasHead,
        hasTail: faultReadbackEval.hasTail,
      };
      // 故障注入も「目印が出ないこと」が期待なので、陰性対照と同じ理由で緩めない。
      if (faultReadbackEval.typedMismatch !== null) {
        throw new HarnessError(`故障注入の読み返し実行で打鍵が画面と一致しませんでした: ${faultReadbackEval.typedMismatch}`);
      }
      if (faultReadbackEval.hasTail) {
        throw new HarnessError(
          '故障注入(--scsi-oracle-reply=0)を入れてもTAILが読み返せてしまいました。' +
            'この検査は修正の有無を見分けられていません(陽性対照が不成立)。',
        );
      }
      stages.positiveControl = {
        result: 'pass',
        reason: faultWriteEval.ok
          ? 'copyは画面上成立したが、リロード後にTAILは現れなかった(末尾が落ちる/永続化されない側の挙動が再現した)'
          : '注入によりcopy自体が成立しなかった(想定内。書き込みが成立しなかった時点で陽性対照としては成立とみなす)',
      };
      record(`陽性対照OK: ${stages.positiveControl.reason}`);
    }

    outcome = {
      result: persistenceResult.result,
      reason: persistenceResult.reason,
      id,
      fixturePath,
    };
  } catch (err) {
    if (err instanceof HarnessError) {
      outcome = { result: 'harness-error', reason: err.message, id, fixturePath };
    } else {
      throw err;
    }
  }

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    config: {
      port: config.port,
      typeWaitMs: config.typeWaitMs,
      probeTimeoutMs: config.probeTimeoutMs,
      childTimeoutMs: config.childTimeoutMs,
      postWriteWaitMs: config.postWriteWaitMs,
      pollScsiDebugMs: config.pollScsiDebugMs,
      fault: config.fault,
    },
    workDir,
    stages,
    log,
    outcome,
  };

  await mkdir(dirname(config.outputPath), { recursive: true });
  await writeFile(config.outputPath, JSON.stringify(report, null, 2));

  console.log(`id: ${id}`);
  console.log(`検体: ${fixturePath}`);
  console.log(`故障注入: ${config.fault ?? '(なし)'}`);
  console.log(`結果: ${outcome.result}`);
  console.log(`理由: ${outcome.reason}`);
  console.log(`結果JSON: ${config.outputPath}`);

  if (outcome.result === 'pass') process.exitCode = 0;
  else if (outcome.result === 'fail') process.exitCode = 1;
  else process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 2;
});
