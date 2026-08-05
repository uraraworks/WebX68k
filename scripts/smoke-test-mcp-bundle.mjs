#!/usr/bin/env node
// バンドル済み MCP サーバー(単一ファイル)が実際に起動して MCP ハンドシェイクを
// こなせるかを確認する。esbuild の bundle は依存の dynamic require で壊れることが
// あり、その手の事故は「起動してみる」以外では検出できないため Release 前に必ず通す。
//
// 使い方: node scripts/smoke-test-mcp-bundle.mjs <bundle.mjs へのパス>

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const target = process.argv[2];
if (!target || !existsSync(target)) {
  console.error(`usage: node ${process.argv[1]} <path to bundled server.mjs>`);
  process.exit(2);
}

// ブリッジの既定ポート(3099)は開発中の実サーバーと衝突しうるので別ポートを使う。
const BRIDGE_PORT = '13099';
const TIMEOUT_MS = 20000;

const child = spawn(process.execPath, [target], {
  env: { ...process.env, WEBX68K_BRIDGE_PORT: BRIDGE_PORT },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });

const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'webx68k-smoke-test', version: '1.0.0' },
  },
});
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

let done = false;

const fail = (message) => {
  if (done) return;
  done = true;
  console.error(`SMOKE TEST FAILED: ${message}`);
  if (stderr.trim()) console.error(`--- server stderr ---\n${stderr.trim()}`);
  child.kill('SIGKILL');
  process.exit(1);
};

const timer = setTimeout(() => fail(`no complete response within ${TIMEOUT_MS}ms`), TIMEOUT_MS);

child.on('exit', (code, signal) => {
  fail(`server exited early (code=${code}, signal=${signal})`);
});

const responses = new Map();
const check = () => {
  if (done) return;
  // stdout は改行区切り JSON。最後の行は途中かもしれないので落とす。
  const lines = stdout.split('\n');
  lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return fail(`stdout に JSON でない行が出た(MCP の stdio を汚している): ${line.slice(0, 200)}`);
    }
    if (msg.id != null) responses.set(msg.id, msg);
  }

  const init = responses.get(1);
  const tools = responses.get(2);
  if (!init || !tools) return;

  clearTimeout(timer);

  if (init.error) return fail(`initialize が失敗: ${JSON.stringify(init.error)}`);
  if (tools.error) return fail(`tools/list が失敗: ${JSON.stringify(tools.error)}`);

  const list = tools.result?.tools ?? [];
  if (list.length === 0) return fail('tools/list が空を返した');
  // 中核ツールが欠けていたら bundle が壊れているか登録漏れ。
  for (const name of ['status', 'screen_text', 'type_text', 'screenshot']) {
    if (!list.some((t) => t.name === name)) return fail(`ツール ${name} が見つからない`);
  }
  if (!/WebSocket bridge listening on port/.test(stderr)) {
    return fail('WebSocket ブリッジが起動していない');
  }

  done = true;
  console.log(`OK: ${init.result.serverInfo.name} v${init.result.serverInfo.version} / ${list.length} tools / bridge up`);
  child.kill('SIGKILL');
  process.exit(0);
};

child.stdout.on('data', check);
