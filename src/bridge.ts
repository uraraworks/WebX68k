// WebSocket ブリッジ: 外部ツール(MCP サーバー等)から WebX68k を遠隔操作するための最小プロトコル。
// 移植元は姉妹アプリ WebNP2 (../PC98/WebNP2/src/api/bridge.ts)。
// メッセージ形式は {id, cmd, args} を受け取り、{id, ok, result} または {id, ok:false, error} を返す。
//
// エミュレータ本体はブラウザ内で動き、MCP サーバーはユーザーのマシン上で動く。ページ側から
// ws://127.0.0.1:<port> へ繋ぎに行く構成なので、ローカル開発サーバーでも公開ページでも同じように使える。

import type { TextScreenDump } from './text-screen';

/** ブリッジから叩くエミュレータ側の操作。main.ts が実装を渡す。 */
export interface BridgeHost {
  /** 画面を PNG の dataURL で取得 */
  screenshot(): string;
  /** TVRAM に描画された ANK・16x16漢字テキストと認識診断を取得 */
  screenText(): TextScreenDump;
  /** 画面の内容が変わったかを判定するためのハッシュ */
  screenHash(): number;
  reset(): void;
  /** RETROK コードのキーを押す/離す */
  setKey(retrok: number, down: boolean): void;
  /** ASCII 文字列をキー入力として流し込む */
  typeText(text: string): Promise<{ typed: number; skipped: string[] }>;
  mouseMove(dx: number, dy: number): void;
  mouseButton(button: 'left' | 'right', down: boolean): void;
  saveState(): Promise<void>;
  loadState(): Promise<void>;
  listDisks(): Array<{ slot: string; name: string | null }>;
  insertDisk(slot: string, name: string, bytes: Uint8Array): Promise<void>;
  ejectDisk(slot: string): void;
  diskListFiles(slot: string, path: string): Promise<Array<Record<string, unknown>>>;
  diskReadFile(slot: string, path: string): Promise<Uint8Array>;
  diskWriteFile(slot: string, path: string, bytes: Uint8Array): Promise<void>;
  readMemory(addr: number, length: number): number[];
  status(): Record<string, unknown>;
}

interface IncomingMessage {
  id?: unknown;
  cmd?: string;
  args?: Record<string, unknown>;
}

const RECONNECT_DELAY_MS = 3000;
const DEFAULT_BRIDGE_PORT = 3099;

/** `?bridge=...` の値から接続先 WebSocket URL を決める。未指定なら null。 */
export function resolveBridgeUrl(search: string): string | null {
  const raw = new URLSearchParams(search).get('bridge');
  if (raw === null) return null;
  if (raw === '1' || raw === '') return `ws://127.0.0.1:${DEFAULT_BRIDGE_PORT}`;
  if (/^\d+$/.test(raw)) return `ws://127.0.0.1:${raw}`;
  return raw;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000; // 一度に渡しすぎるとスタックが溢れるので分割する
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export class Bridge {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url = '';

  constructor(private host: BridgeHost) {}

  connect(url: string): void {
    this.url = url;
    this.clearReconnectTimer();
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      try {
        old.close();
      } catch {
        // 既に閉じている場合は無視
      }
    }
    this.open();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, RECONNECT_DELAY_MS);
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.clearReconnectTimer();
      ws.send(JSON.stringify({ type: 'hello', role: 'webx68k' }));
    });
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null;
      this.scheduleReconnect();
    });
    ws.addEventListener('error', () => this.scheduleReconnect());
    ws.addEventListener('message', (ev: MessageEvent) => void this.handleMessage(ws, ev));
  }

  private async handleMessage(ws: WebSocket, ev: MessageEvent): Promise<void> {
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(String(ev.data));
    } catch (err) {
      console.error('[WebX68k bridge] 不正なメッセージ', err);
      return;
    }
    const { id, cmd, args } = msg;
    try {
      const result = await this.dispatch(cmd, args ?? {});
      ws.send(JSON.stringify({ id, ok: true, result }));
    } catch (err) {
      ws.send(JSON.stringify({ id, ok: false, error: String(err) }));
    }
  }

  /** WebSocket を経由せず、ページ内 JS から直接コマンドを実行するための入口(デバッグ用)。 */
  async exec(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.dispatch(cmd, args);
  }

  private async dispatch(cmd: string | undefined, args: Record<string, unknown>): Promise<unknown> {
    const h = this.host;
    switch (cmd) {
      case 'ping':
        return { pong: true };

      case 'status':
        return h.status();

      case 'screenshot':
        return { dataUrl: h.screenshot() };

      case 'screen_text':
        return h.screenText();

      case 'reset':
        h.reset();
        return { done: true };

      // --- キーボード ---
      case 'type_text':
        return await h.typeText(String(args.text ?? ''));

      case 'key':
        h.setKey(Number(args.code), Boolean(args.down));
        return { done: true };

      case 'key_sequence': {
        // steps: [{ code: RETROK値, ms?: 押し下げ時間 }]
        const steps = Array.isArray(args.steps) ? (args.steps as Array<Record<string, unknown>>) : [];
        for (const step of steps) {
          const code = Number(step.code);
          const holdMs = step.ms !== undefined ? Number(step.ms) : 100;
          h.setKey(code, true);
          await delay(holdMs);
          h.setKey(code, false);
          await delay(60);
        }
        return { sent: steps.length };
      }

      // --- マウス ---
      case 'mouse_move':
        h.mouseMove(Number(args.dx ?? 0), Number(args.dy ?? 0));
        return { done: true };

      case 'mouse_button':
        h.mouseButton(args.button === 'right' ? 'right' : 'left', Boolean(args.down));
        return { done: true };

      case 'mouse_click': {
        const button = args.button === 'right' ? 'right' : 'left';
        h.mouseButton(button, true);
        await delay(args.ms !== undefined ? Number(args.ms) : 80);
        h.mouseButton(button, false);
        return { done: true };
      }

      // --- ステート ---
      case 'save_state':
        await h.saveState();
        return { done: true };

      case 'load_state':
        await h.loadState();
        return { done: true };

      // --- ディスク ---
      case 'list_disks':
        return { slots: h.listDisks() };

      case 'insert_disk':
        await h.insertDisk(
          String(args.slot ?? 'fdd0'),
          String(args.name ?? 'disk.xdf'),
          base64ToBytes(String(args.data_base64 ?? '')),
        );
        return { done: true };

      case 'eject_disk':
        h.ejectDisk(String(args.slot ?? 'fdd0'));
        return { done: true };

      case 'disk_list_files':
        return { entries: await h.diskListFiles(String(args.slot ?? 'fdd0'), String(args.path ?? '/')) };

      case 'disk_read_file': {
        const bytes = await h.diskReadFile(String(args.slot ?? 'fdd0'), String(args.path ?? ''));
        return { size: bytes.length, data_base64: bytesToBase64(bytes) };
      }

      case 'disk_write_file':
        await h.diskWriteFile(
          String(args.slot ?? 'fdd0'),
          String(args.path ?? ''),
          base64ToBytes(String(args.data_base64 ?? '')),
        );
        return { done: true };

      // --- メモリ ---
      case 'read_memory':
        return { bytes: h.readMemory(Number(args.addr ?? 0), Number(args.length ?? 16)) };

      // --- 画面変化待ち ---
      case 'wait_screen_change': {
        const stableMs = args.stable_ms !== undefined ? Number(args.stable_ms) : 700;
        const timeoutMs = args.timeout_ms !== undefined ? Number(args.timeout_ms) : 10000;
        const started = performance.now();
        let last = h.screenHash();
        let changed = false;
        let lastChangeAt = started;
        while (performance.now() - started < timeoutMs) {
          await delay(100);
          const now = h.screenHash();
          if (now !== last) {
            changed = true;
            last = now;
            lastChangeAt = performance.now();
          } else if (changed && performance.now() - lastChangeAt >= stableMs) {
            return { changed: true, settled: true };
          }
        }
        return { changed, settled: false };
      }

      default:
        throw new Error(`unknown command: ${String(cmd)}`);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
