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
import { FakeFs, SwitchableFs, NotConnectedFs } from './filesystem';
import { HostFolderFs } from './host-folder-fs';

/** LibretroHost が実際に持っていれば十分(循環import回避のため構造的に受け取る)。 */
export interface GuestMemoryHost {
  readGuestMemory(addr: number, len: number): Uint8Array;
  writeGuestMemory(addr: number, bytes: Uint8Array): void;
  /** P2a #1: 古いwasm(再ビルド前)では省略可(呼ばなくても従来どおり動く)。 */
  hostFsComplete?(): void;
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
  /**
   * mode==='real' のときだけ入る。HOSTFS_ATTACH/DETACH(core-worker.ts)から
   * バックエンドを差し替えるためのハンドル。
   */
  attach?: (dirHandle: FileSystemDirectoryHandle) => void;
  detach?: () => void;
}

/**
 * 有効化条件: ページ側(main.ts)が `?hostfs=fake` / それ以外(既定)を見て
 * globalThis.__webx68kHostFsMode を 'fake' | 'real' にしてhostGlobals経由でWorkerへ渡す。
 * 未設定なら何もしない(installed: false。既存のprobe等、HostFSを使わない起動経路を
 * 壊さないため)。
 *
 * - 'fake': 検証用FakeFs固定(P1譲り)。
 * - 'real': 起動時はNotConnectedFs(検索/開くとも-2)。HOSTFS_ATTACH/DETACHメッセージ
 *   (core-worker.ts)でFileSystemDirectoryHandleを受け取り、HostFolderFsへ差し替える。
 *   `?hostfs=opfs-test` もこの経路を使う(main.ts側でOPFSのハンドルをATTACHするだけ)。
 *
 * 一定間隔(5秒)で観測用カウンタ([HostFS] stats)をログへ出す。probeの
 * allLogsから「保留を返した回数」「pollで完了した回数」を拾えるようにする。
 */
export function installHostFsBridge(host: GuestMemoryHost): HostFsBridgeResult {
  const g = globalThis as Record<string, unknown>;
  const mode = g.__webx68kHostFsMode;
  if (mode !== 'fake' && mode !== 'real') {
    return { installed: false, reason: `__webx68kHostFsMode が 'fake'/'real' ではない(実際: ${JSON.stringify(mode)})` };
  }

  const mem = toGuestMemory(host);
  const switchable = mode === 'real' ? new SwitchableFs() : null;
  const fs = mode === 'fake' ? new FakeFs() : (switchable as SwitchableFs);
  // P2a #1: wasm→JS呼び出し回数の計測用。request()とpoll()のみが対象
  // (どちらもC側core-shim.cのEM_JSから呼ばれる=wasmからの呼び出し)。
  // 完了通知(notifyComplete→host.hostFsComplete())はJS→wasmなので数えない。
  let wasmToJsCallCount = 0;
  const dispatcher = new HostFsDispatcher(mem, fs, () => {
    host.hostFsComplete?.();
  });

  // ゲストの busy-loop(tools/x68/hostfs.sのrelay_poll)は1ティックの中で
  // ポート+5を何百〜何千回も読み直しうる。pollのたびに毎回ログを出すと
  // ログが埋もれてallLogs(probeの上限あり)がpendingCompleted=1の行へ
  // 届かなくなる(2026-09-11実測)。そのため request/pending/pollCompleted の
  // 変化は必ず出す一方、pollCount単体の増加は間引く(既定32回に1回)。
  let lastLogged: HostFsStats = dispatcher.getStats();
  const POLL_LOG_STRIDE = 32;
  // P2a #1: 「保留1回につきwasm→JS呼び出しが何回起きたか」を計測するため、
  // pendingReturnedCountが増えた瞬間のwasmToJsCallCountを覚えておき、
  // pollCompletedCountが増えた瞬間との差分をログへ出す。
  let callsAtPendingStart = wasmToJsCallCount;
  const logIfChanged = (): void => {
    const s = dispatcher.getStats();
    const pendingStarted = s.pendingReturnedCount !== lastLogged.pendingReturnedCount;
    const pendingCompleted = s.pollCompletedCount !== lastLogged.pollCompletedCount;
    const meaningfulChanged = s.requestCount !== lastLogged.requestCount || pendingStarted || pendingCompleted;
    const pollChanged = s.pollCount !== lastLogged.pollCount;
    const pollStrideHit = pollChanged && s.pollCount % POLL_LOG_STRIDE === 0;
    if (pendingStarted) {
      callsAtPendingStart = wasmToJsCallCount;
    }
    if (meaningfulChanged || pollStrideHit) {
      const callsThisPending = wasmToJsCallCount - callsAtPendingStart;
      console.log(
        `[HostFS] stats: request=${s.requestCount} pending=${s.pendingReturnedCount} ` +
          `poll=${s.pollCount} pollCompleted=${s.pollCompletedCount} ` +
          `wasmToJsCallCount=${wasmToJsCallCount}` +
          (pendingCompleted ? ` callsThisPending=${callsThisPending}` : ''),
      );
      lastLogged = s;
    }
  };

  g.__webx68kHostFs = {
    request: (addr: number): boolean => {
      wasmToJsCallCount++;
      const pending = dispatcher.request(addr);
      logIfChanged();
      return pending;
    },
    poll: (): boolean => {
      // P2a #1後は、Cの状態ポート読みはHostFsStatusフラグだけで答えるため、
      // ここが呼ばれるのは「まだ再ビルド前の古いwasm」のときだけのはず。
      // 呼ばれた場合もカウントし、ログで「本当に減ったか」を確認できるようにする。
      wasmToJsCallCount++;
      const pending = dispatcher.poll();
      logIfChanged();
      return pending;
    },
  };
  g.__webx68kHostFsWasmToJsCallCount = () => wasmToJsCallCount;

  if (mode === 'fake') {
    console.log('[WebX68k-worker] HostFS: fake (FakeFs, HELLO.TXT/WORLD.DOC) を有効化した');
    return { installed: true };
  }

  console.log('[WebX68k-worker] HostFS: real (未接続、NotConnectedFs) を有効化した');
  return {
    installed: true,
    attach: (dirHandle: FileSystemDirectoryHandle) => {
      (switchable as SwitchableFs).current = new HostFolderFs(dirHandle);
      console.log(`[WebX68k-worker] HostFS: フォルダを接続した (name=${dirHandle.name})`);
    },
    detach: () => {
      (switchable as SwitchableFs).current = new NotConnectedFs();
      console.log('[WebX68k-worker] HostFS: フォルダを切断した');
    },
  };
}
