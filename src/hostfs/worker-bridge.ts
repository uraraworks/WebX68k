// HostFS (feature/hostfs) 用: Worker内で globalThis.__webx68kHostFs を生やす。
//
// hostGlobals(src/host-globals.ts)は関数を運べないため、フック自体は
// Worker自身のglobalThisへここで直接生やす必要がある(src/scsi-opfs.tsと同じ流儀)。
//
// C側(x68k/mem_wrap.c の HOSTFS_Write/HOSTFS_Read)は
//   globalThis.__webx68kHostFs.request(addr) -> boolean(true=保留)
//   globalThis.__webx68kHostFs.poll()        -> boolean(true=保留)
// を src/core-shim.c の EM_JS 経由で同期呼び出しする。

import type { GuestMemory } from './guest-memory';
import { HostFsDispatcher, type HostFsStats } from './dispatcher';
import { FakeFs } from './filesystem';

/** LibretroHost が実際に持っていれば十分(循環import回避のため構造的に受け取る)。 */
export interface GuestMemoryHost {
  readGuestMemory(addr: number, len: number): Uint8Array;
  writeGuestMemory(addr: number, bytes: Uint8Array): void;
}

function toGuestMemory(host: GuestMemoryHost): GuestMemory {
  return {
    read: (addr, len) => host.readGuestMemory(addr, len),
    write: (addr, bytes) => host.writeGuestMemory(addr, bytes),
  };
}

export interface HostFsBridgeResult {
  installed: boolean;
  /** installed=false のときだけ。理由を必ず入れる(沈黙させないため)。 */
  reason?: string;
}

/**
 * 有効化条件: ページ側(main.ts)が `?hostfs=fake` を見て
 * globalThis.__webx68kHostFsMode = 'fake' をhostGlobals経由でWorkerへ渡す。
 * それ以外の値/未設定なら何もしない(installed: false)。
 *
 * 一定間隔(5秒)で観測用カウンタ([HostFS] stats)をログへ出す。probeの
 * allLogsから「保留を返した回数」「pollで完了した回数」を拾えるようにする。
 */
export function installHostFsBridge(host: GuestMemoryHost): HostFsBridgeResult {
  const g = globalThis as Record<string, unknown>;
  const mode = g.__webx68kHostFsMode;
  if (mode !== 'fake') {
    return { installed: false, reason: `__webx68kHostFsMode が 'fake' ではない(実際: ${JSON.stringify(mode)})` };
  }

  const mem = toGuestMemory(host);
  const fs = new FakeFs();
  const dispatcher = new HostFsDispatcher(mem, fs);

  // ゲストの busy-loop(tools/x68/hostfs.sのrelay_poll)は1ティックの中で
  // ポート+5を何百〜何千回も読み直しうる。pollのたびに毎回ログを出すと
  // ログが埋もれてallLogs(probeの上限あり)がpendingCompleted=1の行へ
  // 届かなくなる(2026-09-11実測)。そのため request/pending/pollCompleted の
  // 変化は必ず出す一方、pollCount単体の増加は間引く(既定32回に1回)。
  let lastLogged: HostFsStats = dispatcher.getStats();
  const POLL_LOG_STRIDE = 32;
  const logIfChanged = (): void => {
    const s = dispatcher.getStats();
    const meaningfulChanged =
      s.requestCount !== lastLogged.requestCount ||
      s.pendingReturnedCount !== lastLogged.pendingReturnedCount ||
      s.pollCompletedCount !== lastLogged.pollCompletedCount;
    const pollChanged = s.pollCount !== lastLogged.pollCount;
    const pollStrideHit = pollChanged && s.pollCount % POLL_LOG_STRIDE === 0;
    if (meaningfulChanged || pollStrideHit) {
      console.log(
        `[HostFS] stats: request=${s.requestCount} pending=${s.pendingReturnedCount} ` +
          `poll=${s.pollCount} pollCompleted=${s.pollCompletedCount}`,
      );
      lastLogged = s;
    }
  };

  g.__webx68kHostFs = {
    request: (addr: number): boolean => {
      const pending = dispatcher.request(addr);
      logIfChanged();
      return pending;
    },
    poll: (): boolean => {
      const pending = dispatcher.poll();
      logIfChanged();
      return pending;
    },
  };

  console.log('[WebX68k-worker] HostFS: fake (FakeFs, HELLO.TXT/WORLD.DOC) を有効化した');
  return { installed: true };
}
