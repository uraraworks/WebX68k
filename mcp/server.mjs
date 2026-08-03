#!/usr/bin/env node
// WebX68k MCP server: ブラウザで動く WebX68k(X68000 エミュレータ)を WebSocket 越しに操作し、
// MCP クライアント(Claude Code 等)から画面の取得・キー入力・ディスク操作を行えるようにする。
// 移植元は姉妹アプリ WebNP2 の mcp/server.mjs。
//
// 重要: stdout は MCP の stdio transport 専用。診断出力は必ず console.error() を使うこと。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer } from 'ws';
import { z } from 'zod';

const BRIDGE_PORT = Number(process.env.WEBX68K_BRIDGE_PORT) || 3099;
const REQUEST_TIMEOUT_MS = 20000;
// ページ側の再接続間隔(3秒)より長く待つ
const CLIENT_WAIT_MS = 8000;

// --- WebSocket ブリッジ ----------------------------------------------------

let activeClient = null;
let nextRequestId = 1;
const pending = new Map();

const wss = new WebSocketServer({ port: BRIDGE_PORT });

wss.on('listening', () => {
  console.error(`WebSocket bridge listening on port ${BRIDGE_PORT}`);
});

wss.on('error', (err) => {
  console.error('WebSocket server error:', err && err.stack ? err.stack : err);
});

wss.on('connection', (ws) => {
  console.error('Browser client connected');

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      console.error('Received non-JSON message from browser:', err.message);
      return;
    }

    // 新しいタブが名乗ってきたら、それを唯一の接続先として扱う。
    if (msg && msg.type === 'hello' && msg.role === 'webx68k') {
      if (activeClient && activeClient !== ws && activeClient.readyState === activeClient.OPEN) {
        console.error('Replacing previous active client');
        try {
          activeClient.close();
        } catch {
          // ignore
        }
      }
      activeClient = ws;
      console.error('Active WebX68k client registered');
      return;
    }

    if (msg && msg.id !== undefined && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(String(msg.error || 'bridge command failed')));
    }
  });

  ws.on('close', () => {
    if (activeClient === ws) activeClient = null;
    console.error('Browser client disconnected');
  });

  ws.on('error', (err) => {
    console.error('Browser client error:', err && err.message ? err.message : err);
  });
});

/**
 * ブラウザタブの接続を待つ。ページ側は切断されると3秒間隔で繋ぎ直しに来るので、
 * MCP サーバーを起動した直後や再起動した直後は「まだ繋がっていない」状態が数秒続く。
 * ここで待たないと最初の1回が必ず失敗して使いづらい。
 */
async function waitForClient(timeoutMs = CLIENT_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (activeClient && activeClient.readyState === activeClient.OPEN) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return activeClient !== null && activeClient.readyState === activeClient.OPEN;
}

async function sendCommand(cmd, args = {}) {
  if (!(await waitForClient())) {
    throw new Error('WebX68k のブラウザタブが接続されていません');
  }
  return new Promise((resolve, reject) => {
    if (!activeClient || activeClient.readyState !== activeClient.OPEN) {
      reject(new Error('WebX68k のブラウザタブが接続されていません'));
      return;
    }
    const id = nextRequestId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`コマンド ${cmd} がタイムアウトしました (${REQUEST_TIMEOUT_MS}ms)`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    activeClient.send(JSON.stringify({ id, cmd, args }));
  });
}

/** ブラウザ未接続時に、手順を添えたエラーを返す。 */
async function withBridge(fn) {
  try {
    return await fn();
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `${message}\n\n` +
            `WebX68k のタブが ?bridge=1 付きで開かれているか確認してください。\n` +
            `例: http://localhost:5299/?bridge=1 (ポートを変える場合は ?bridge=<port>)`,
        },
      ],
    };
  }
}

const textResult = (text) => ({ content: [{ type: 'text', text }] });
const jsonResult = (value) => textResult(JSON.stringify(value, null, 2));

// --- MCP サーバー ----------------------------------------------------------

const server = new McpServer({
  name: 'webx68k-mcp',
  version: '0.1.0',
});

server.tool(
  'status',
  'WebX68k の現在の状態(起動しているか、画面サイズ、各ドライブに入っているディスク、マウスキャプチャの有無)を取得する。まず最初にこれを呼ぶと状況が分かる。',
  {},
  async () => withBridge(async () => jsonResult(await sendCommand('status')))
);

server.tool(
  'screenshot',
  'X68000 の画面を PNG 画像として取得する。X68000 の画面はグラフィックなのでテキストとして読み出す手段が無く、画面の内容を確認する唯一の方法がこのツールになる。',
  {},
  async () =>
    withBridge(async () => {
      const result = await sendCommand('screenshot');
      const dataUrl = String(result?.dataUrl ?? '');
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      return { content: [{ type: 'image', data: base64, mimeType: 'image/png' }] };
    })
);

server.tool(
  'type_text',
  'ASCII 文字列をキーボード入力として送る(改行は Enter)。X68000 の JIS 配列に合わせて記号は SHIFT 付きに分解して送られる。全角文字は非対応(ゲスト側の FEP が必要なため)。送れなかった文字は skipped に返る。',
  {
    text: z.string().describe('入力する ASCII 文字列。改行は Enter として送られる。'),
  },
  async ({ text }) => withBridge(async () => jsonResult(await sendCommand('type_text', { text })))
);

server.tool(
  'key_sequence',
  'RETROK のキーコードを指定して、押す→離すを順番に実行する。type_text で送れない特殊キー(F1〜F10、矢印、ESC 等)に使う。',
  {
    steps: z
      .array(
        z.object({
          code: z.number().describe('libretro の RETROK 値。例: ESC=27, Enter=13, 上=273, 下=274, 左=276, 右=275, F1=282'),
          ms: z.number().optional().describe('押し下げ時間(ミリ秒、既定100)'),
        })
      )
      .describe('押すキーの並び'),
  },
  async ({ steps }) => withBridge(async () => jsonResult(await sendCommand('key_sequence', { steps })))
);

server.tool(
  'mouse_move',
  'マウスを相対移動させる。X68000 のマウスは相対移動量しか送れないため、絶対座標での指定はできない(カーソル位置はゲスト側が管理している)。',
  {
    dx: z.number().describe('X 方向の移動量(ゲストのドット単位)'),
    dy: z.number().describe('Y 方向の移動量(ゲストのドット単位)'),
  },
  async ({ dx, dy }) => withBridge(async () => jsonResult(await sendCommand('mouse_move', { dx, dy })))
);

server.tool(
  'mouse_click',
  'マウスボタンをクリックする(押して離す)。',
  {
    button: z.enum(['left', 'right']).optional().describe('ボタン(既定 left)'),
    ms: z.number().optional().describe('押し下げ時間(ミリ秒、既定80)'),
  },
  async ({ button, ms }) => withBridge(async () => jsonResult(await sendCommand('mouse_click', { button, ms })))
);

server.tool(
  'reset',
  'X68000 をリセットする(電源は入れ直さず、retro_reset 相当)。',
  {},
  async () => withBridge(async () => jsonResult(await sendCommand('reset')))
);

server.tool(
  'wait_screen_change',
  '画面が変化して落ち着くまで待つ。コマンドを打った後の処理完了待ちに使う。changed が false なら何も起きなかったということ。',
  {
    stable_ms: z.number().optional().describe('変化が止まったとみなすまでの時間(既定700ms)'),
    timeout_ms: z.number().optional().describe('最大待ち時間(既定10000ms)'),
  },
  async ({ stable_ms, timeout_ms }) =>
    withBridge(async () => jsonResult(await sendCommand('wait_screen_change', { stable_ms, timeout_ms })))
);

server.tool(
  'save_state',
  '現在の実行状態をステートとして保存する(クイックセーブ枠1つ)。',
  {},
  async () => withBridge(async () => jsonResult(await sendCommand('save_state')))
);

server.tool(
  'load_state',
  '保存したステートを復元する。保存時とドライブ構成が違う場合はブラウザ側で確認ダイアログが出る。',
  {},
  async () => withBridge(async () => jsonResult(await sendCommand('load_state')))
);

server.tool(
  'list_disks',
  '各ドライブ(FDD1=fdd0 / FDD2=fdd1 / HDD=hdd)に入っているディスクを一覧する。',
  {},
  async () => withBridge(async () => jsonResult(await sendCommand('list_disks')))
);

server.tool(
  'insert_disk',
  'ディスクイメージをドライブへ挿入する。FDD は実行中でもリセット無しで差し替わる。' +
    'HDD を交換できるのは起動前だけで(コアが実行中の HDD 挿抜に未対応のため)、起動前に指定した場合は' +
    'スロットへセットされるだけで起動はしない。実行中に HDD を指定するとエラーになる。',
  {
    slot: z.enum(['fdd0', 'fdd1', 'hdd']).describe('挿入先。fdd0=FDD1, fdd1=FDD2, hdd=HDD'),
    name: z.string().describe('ファイル名(拡張子で種別を判定する。例: game.xdf)'),
    data_base64: z.string().describe('ディスクイメージの中身を base64 で'),
  },
  async ({ slot, name, data_base64 }) =>
    withBridge(async () => jsonResult(await sendCommand('insert_disk', { slot, name, data_base64 })))
);

server.tool(
  'eject_disk',
  'ドライブからディスクを取り出す。',
  {
    slot: z.enum(['fdd0', 'fdd1', 'hdd']).describe('取り出すドライブ'),
  },
  async ({ slot }) => withBridge(async () => jsonResult(await sendCommand('eject_disk', { slot })))
);

server.tool(
  'disk_list_files',
  'ドライブに入っているディスクイメージの中身(FAT)を一覧する。ゲストを起動しなくてもファイル構成を確認できる。',
  {
    slot: z.enum(['fdd0', 'fdd1', 'hdd']).describe('対象ドライブ'),
    path: z.string().optional().describe('ディレクトリのパス(既定はルート)'),
  },
  async ({ slot, path }) =>
    withBridge(async () => jsonResult(await sendCommand('disk_list_files', { slot, path: path ?? '/' })))
);

server.tool(
  'disk_read_file',
  'ディスクイメージ内のファイルを読み出す(base64 で返る)。',
  {
    slot: z.enum(['fdd0', 'fdd1', 'hdd']).describe('対象ドライブ'),
    path: z.string().describe('ファイルのパス。例: /SYS/CONFIG.SYS'),
  },
  async ({ slot, path }) => withBridge(async () => jsonResult(await sendCommand('disk_read_file', { slot, path })))
);

server.tool(
  'disk_write_file',
  'ディスクイメージへファイルを書き込む。実行中の FDD スロットへ書くとディスクを入れ直したのと同じ扱いになる。' +
    'HDD へ書けるのは起動前にセットしただけの状態のときで、起動後は読み出し専用になる' +
    '(コアが HDD を掴んでいる間にホストが書き換えるとゲスト側のキャッシュと食い違うため)。',
  {
    slot: z.enum(['fdd0', 'fdd1', 'hdd']).describe('対象ドライブ'),
    path: z.string().describe('書き込み先のパス(8.3形式)。例: /TEST.TXT'),
    data_base64: z.string().describe('書き込む内容を base64 で'),
  },
  async ({ slot, path, data_base64 }) =>
    withBridge(async () => jsonResult(await sendCommand('disk_write_file', { slot, path, data_base64 })))
);

server.tool(
  'read_memory',
  'ゲスト(X68000)のメインメモリを読む。IOCS のワークエリアを覗く用途を想定している(例: $ACE=マウスカーソルX座標)。',
  {
    addr: z.number().describe('先頭アドレス(10進。$ACE なら 2766)'),
    length: z.number().optional().describe('読むバイト数(既定16)'),
  },
  async ({ addr, length }) =>
    withBridge(async () => jsonResult(await sendCommand('read_memory', { addr, length: length ?? 16 })))
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('WebX68k MCP server ready (stdio)');
