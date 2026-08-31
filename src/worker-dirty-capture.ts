// Worker側の不可分ダーティキャプチャ/ホットマウント(段階移行 手順8)の純粋ロジック。
// core-worker.ts(実Workerグローバル: self/OffscreenCanvas/fetch/LibretroHost)には依存せず、
// 単体テスト(test/worker-dirty-capture.test.ts)で検証できる形に切り出す(前例:
// src/worker-drive-loop.ts / src/worker-input.ts / src/mouse-track.ts と同じ作法)。
//
// --- なぜ不可分にする必要があるか(docs/STORAGE-SCSI.md「ワーカー移行 手順8」参照) --------
//
// 既定経路(main.ts の persistSlotToLibrary/flushAllSlots)は、
//   (1) host.readDirtyState() でダーティなスロットを読む
//   (2) そのスロットのイメージ全体を読み出す
//   (3) host.clearDirty(...) でフラグを落とす
// の3ステップを別々に呼んでいる。既定経路はメインスレッドとコアが同一スレッドなので、
// この3つの間にretro_run()が挟まることはなく(JSは実行順序を保証する)、事実上不可分になる。
//
// しかしWorker境界を挟むと(1)〜(3)がそれぞれ独立したpostMessageの往復になり得る。
// その合間にWorkerの駆動ループ(setInterval)がフレームを進めると、
// 「(2)でイメージを読んだ後、(3)でフラグを落とすまでの間にゲストが書いた内容」が、
// 保存されないままフラグだけ消える。書き込みが無言で失われる。
//
// ここでは captureSlot()/hotSwapFdd() の中に読み出しとdirtyクリアの両方を閉じ込め、
// 呼び出し側(core-worker.ts の1つのcommandハンドラ)が同期的に1回呼ぶだけで完結させる。
// Workerは単一スレッドであり、JSの関数呼び出しはrun-to-completion(呼び出し中は他の
// メッセージ処理・タイマーが割り込まない)ため、1回の同期呼び出し内に閉じ込めることが
// そのまま不可分性の根拠になる(command/responseの往復回数を減らすための最適化ではなく、
// 正しさそのものがこれに懸かっている)。
//
// --- 永続化失敗時の再dirty化について -------------------------------------------------
//
// px68k本体(wasmコア、src/core-shim.c)にはダーティフラグを外から「立てる」APIが無い
// (get_fdd_dirty_mask/clear_fdd_dirty/get_sasi_dirty/clear_sasi_dirtyのみで、setは無い)。
// ネイティブ側(C)を改修して再ビルドするのは影響範囲が大きく今回のスコープ外と判断し、
// ここでは代わりにJS側の「影のダーティフラグ」(overrideDirty)を持つ。captureSlot()は
// コア本体のフラグと影のフラグの両方を同じ呼び出し内でクリアし、dirtyState()は両者を
// OR で合成して返す(main.ts はこの合成済みの値をポーリングに使うため、影のフラグが
// 立っていれば通常のダーティと区別なく次のオートセーブ対象になる)。
//
// 既定経路(main.ts の persistSlotToLibrary)は現状、永続化(IndexedDBへの保存)が失敗しても
// ダーティフラグを立て直していない(catchでfalseを返すだけ。2026-08-31、この実装時に発見した
// 既存の欠落で、今回は既定経路の挙動を変えない制約のため既定経路側は直していない)。
// Worker経路はこの影のフラグの仕組みがちょうど「新規追加する機構」であるため、
// main.ts側がWorker経路でだけ永続化失敗時にmarkDirty()を呼ぶようにし、既定経路より
// 安全にした(docs参照。既定経路のこの欠落は別タスクとして切り出す)。

export type DiskSlotId = 'fdd0' | 'fdd1' | 'hdd';

export const DISK_SLOT_IDS: DiskSlotId[] = ['fdd0', 'fdd1', 'hdd'];

export function fddDriveOf(slot: DiskSlotId): 0 | 1 | null {
  if (slot === 'fdd0') return 0;
  if (slot === 'fdd1') return 1;
  return null;
}

/** captureSlot() が要求する host 側の面(実体は src/libretro-host.ts の LibretroHost)。 */
export interface DirtyCaptureHost {
  setFddImage(drive: number, path: string): void;
  readFile(path: string): Uint8Array;
  clearDirty(target: { fddDrive?: number; hdd?: boolean }): void;
}

/** hotSwapFdd() はさらに write/remove も要求する。 */
export interface HotSwapHost extends DirtyCaptureHost {
  writeDiskImage(filename: string, data: Uint8Array): string;
  removeFile(path: string): void;
}

export interface CapturedSlot {
  slot: DiskSlotId;
  bytes: Uint8Array | null;
}

export interface HotSwapOutcome {
  previousImage: Uint8Array | null;
  mountedPath: string | null;
}

/**
 * Worker内で「どのスロットがどのFS上のパスにマウントされているか」と、JS側の影の
 * ダーティフラグ(overrideDirty)を保持する状態。initialize時のマウント・hotSwapFddの
 * 結果でmountedPathsを更新し、markDirty()/captureSlot()でoverrideDirtyを更新する。
 */
export class WorkerMediaState {
  private readonly mountedPaths: Record<DiskSlotId, string | null> = { fdd0: null, fdd1: null, hdd: null };
  private readonly overrideDirty: Record<DiskSlotId, boolean> = { fdd0: false, fdd1: false, hdd: false };

  setMountedPath(slot: DiskSlotId, path: string | null): void {
    this.mountedPaths[slot] = path;
  }

  getMountedPath(slot: DiskSlotId): string | null {
    return this.mountedPaths[slot];
  }

  /** 永続化失敗時の再dirty化(main側からのmarkDirtyコマンド)。 */
  markDirty(slots: DiskSlotId[]): void {
    for (const slot of slots) this.overrideDirty[slot] = true;
  }

  /** frame event に載せる合成ダーティ状態(コア本体のフラグ ∪ 影のフラグ)。 */
  dirtyState(hostDirty: { fddMask: number; hdd: boolean }): { fddMask: number; hdd: boolean } {
    let fddMask = hostDirty.fddMask;
    if (this.overrideDirty.fdd0) fddMask |= 1 << 0;
    if (this.overrideDirty.fdd1) fddMask |= 1 << 1;
    const hdd = hostDirty.hdd || this.overrideDirty.hdd;
    return { fddMask, hdd };
  }

  /**
   * 指定スロットを不可分に捕獲する: マウント済みでなければ null。FDDはEject(→FS書き戻し)→
   * 読み出し→再Insertの順(main.ts の readLiveSlotImage() と同じ意味論。既定経路の
   * この関数を書き換えたわけではなく、Worker側に同じ順序を再実装したもの)。HDDはEject不要で
   * そのまま読み出す。読み出し直後、同じ呼び出し内でdirty(コア本体+影)をクリアする
   * (ファイル冒頭コメントの不可分性の説明を参照。ここが本節の中核)。
   */
  captureSlot(slot: DiskSlotId, host: DirtyCaptureHost): Uint8Array | null {
    const path = this.mountedPaths[slot];
    if (!path) return null;
    const drive = fddDriveOf(slot);
    let bytes: Uint8Array;
    if (drive !== null) {
      host.setFddImage(drive, '');
      try {
        bytes = host.readFile(path);
      } finally {
        host.setFddImage(drive, path);
      }
      host.clearDirty({ fddDrive: drive });
    } else {
      bytes = host.readFile(path);
      host.clearDirty({ hdd: true });
    }
    this.overrideDirty[slot] = false;
    return bytes;
  }

  captureSlots(slots: DiskSlotId[], host: DirtyCaptureHost): CapturedSlot[] {
    return slots.map((slot) => ({ slot, bytes: this.captureSlot(slot, host) }));
  }

  /**
   * FDDホットマウント(手順8): Eject→旧内容の回収→(新イメージがあれば)write→insert、
   * 無ければ旧ファイルをunlinkするだけ、を1回の呼び出しで完結させる。
   *
   * 順序は必ず Eject→(ファイル更新)→Insert(feedback_px68k_fdd_eject_writeback.md、
   * test/core-fdd-hotswap.test.ts と同じ理由): px68k の Eject は無条件でメモリ上の
   * イメージをファイルへ書き戻すため、先にファイルを書いてから Eject すると、
   * 同名パス(=同じファイルへの差し替え。openSlotVolume() の persist() 等)では
   * 古い内容で上書きされ、転送・編集結果が丸ごと消える。
   *
   * 旧内容の回収(previousImage)と同時に、そのスロットのdirty(コア本体+影)もクリアする。
   * 既定経路(main.ts)はejectSlot()がpersistSlotToLibrary()→hotSwapFdd()の2段構えで
   * 同じことをするが(同一スレッドなので間にフレームが進まず安全)、Worker経路は
   * ラウンドトリップを畳むためこの1関数にまとめた。
   */
  hotSwapFdd(
    slot: DiskSlotId,
    drive: 0 | 1,
    image: { name: string; bytes: Uint8Array } | null,
    host: HotSwapHost,
  ): HotSwapOutcome {
    const oldPath = this.mountedPaths[slot];
    // 必ず先にEject: 旧ディスクの内容をFSへ書き戻させる。
    host.setFddImage(drive, '');

    let previousImage: Uint8Array | null = null;
    if (oldPath) {
      try {
        previousImage = host.readFile(oldPath);
      } catch {
        previousImage = null;
      }
    }
    host.clearDirty({ fddDrive: drive });
    this.overrideDirty[slot] = false;
    this.mountedPaths[slot] = null;

    let mountedPath: string | null = null;
    if (image) {
      const path = host.writeDiskImage(image.name, image.bytes);
      if (oldPath && oldPath !== path) host.removeFile(oldPath);
      host.setFddImage(drive, path);
      this.mountedPaths[slot] = path;
      mountedPath = path;
    } else if (oldPath) {
      host.removeFile(oldPath);
    }
    return { previousImage, mountedPath };
  }
}
