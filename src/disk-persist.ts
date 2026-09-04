/**
 * ディスクの吸い出し(ゲストの書き込みをディスクライブラリへ回収する)ロジック。
 *
 * src/main.ts の persistSlotToLibrary()/flushAllSlots()/restartCore() から切り出した。
 * DOM/wasm(host)には一切触れず、依存はすべて注入で受け取る(touch-mouse.ts と同じ流儀。
 * host やライブラリの実体なしに vitest から「順序」を検証するため)。
 *
 * この切り出しの動機は PR #5 で直した不具合の再発防止(回帰テスト)。restartCore() は
 * flushAll() の直後に teardown+boot を行い、boot はスロットの data からディスクを
 * 書き直す。吸い出したバイト列をスロットへ反映するタイミングを await saveDisk()
 * (IndexedDB書き込み)の後に回すと、書き込みが終わる前に再起動が走って古いバイト列で
 * 再マウントされる(＝リセットでセーブデータが巻き戻る)。IndexedDBの遅いiOS Safariでは
 * 特に競合に負けやすい。スロットへの反映は必ず readLiveImage() と同じ同期区間で行うこと。
 */

/** スロットIDの型。呼び出し側(main.ts)の SlotId 型をそのまま渡せるよう汎用化してある。 */
export type SlotId = string;

export interface PendingDisk {
  name: string;
  data: Uint8Array;
  sourceKey?: string;
}

export interface DiskPersistenceDeps<S extends SlotId = SlotId> {
  getSlot(slot: S): PendingDisk | null;
  setSlot(slot: S, entry: PendingDisk): void;
  /** host があり実行中か。 */
  isLive(): boolean;
  clearDirty(slot: S): void;
  /** 実行中スロットの現時点のバイト列を同期で吸い出す(未マウント等は null)。 */
  readLiveImage(slot: S): Uint8Array | null;
  /**
   * probeContext は目的B「IndexedDBへのディスク全量書出し」の計測(src/storage-probe.ts /
   * src/disk-store.ts が使う)。disk-persist.ts 自体は DOM/env非依存のまま保つため、
   * 計測の中身には立ち入らず、deps.buildProbeContext() が返したものをそのまま渡すだけ。
   */
  saveDisk(
    args: { sourceKey: string; name: string; bytes: Uint8Array; savedAt: number },
    probeContext?: { slot: S; bytesReadyAtMs: number },
  ): Promise<void>;
  readDirtyState(): { fddMask: number; hdd: boolean };
  fddDriveOf(slot: S): number | null;
  /** ライブラリ一覧のリフレッシュ用(モーダル表示中のときだけ意味を持つ)。 */
  onSaved?(slot: S): void;
  now(): number;
  /**
   * 目的B計測用の probeContext を作る。呼ぶタイミングは readLiveImage() 直後(MEMFSから
   * 末尾まで取得・検査できた地点=bytesReadyAtMs)。import.meta.env.DEV でないビルド、または
   * 計測が要らない場合は省略してよい(undefined を返す実装、または deps 自体を省略)。
   */
  buildProbeContext?(slot: S): { slot: S; bytesReadyAtMs: number } | undefined;
}

/** 同梱ディスクの sourceKey。ライブラリ先頭の固定エントリで差し替えできないため回収しない。 */
export const BUNDLED_DISK_SOURCE_KEY = 'bundled:human302';

export interface DiskPersistence<S extends SlotId = SlotId> {
  /**
   * スロットの現在の内容(ゲストの書き込み反映後)をディスクライブラリへ書き戻す。
   *
   * 同梱ディスクはライブラリ先頭の固定エントリで差し替えできないため対象外。
   * ダーティフラグのクリアは吸い出しの「前」に行う(後にすると、吸い出し中に発生した
   * 書き込みまで一緒に消えて、その分が二度と保存されなくなる)。
   */
  persistSlot(slot: S): Promise<boolean>;
  /**
   * 全スロットを即座に書き戻す(排出・コア再起動・ページ離脱の直前用)。
   * readLiveImage() による吸い出しは同期なので、await しなくてもバイト列の取得だけは
   * この関数を抜ける前に終わっている。IndexedDB への書き込みだけが非同期で後を追う。
   */
  flushAll(): void;
  /**
   * flushAll() を済ませてから teardownAndBoot() へ進む。restartCore() の骨格。
   * 載せ直すと slots[].data から書き直すことになるので、その前にゲストの書き込みを
   * 回収する(設定変更でCPU速度を変えただけでセーブデータが消える、という事故を防ぐ)。
   */
  restartWithFlush(teardownAndBoot: () => Promise<void>): Promise<void>;
}

const SLOT_IDS_FALLBACK: SlotId[] = ['fdd0', 'fdd1', 'hdd'];

export function createDiskPersistence<S extends SlotId = SlotId>(
  deps: DiskPersistenceDeps<S>,
  slotIds: S[] = SLOT_IDS_FALLBACK as S[],
): DiskPersistence<S> {
  async function persistSlot(slot: S): Promise<boolean> {
    const pending = deps.getSlot(slot);
    if (!deps.isLive() || !pending) return false;
    const { sourceKey } = pending;
    // 同梱システムディスクは意図的に回収しない(リセットしても常にプリスチンな状態で起動し直す。
    // ライブラリ先頭の固定エントリで差し替えもできない)。
    if (sourceKey === BUNDLED_DISK_SOURCE_KEY) return false;

    deps.clearDirty(slot);

    let live: Uint8Array | null = null;
    try {
      live = deps.readLiveImage(slot);
    } catch (err) {
      console.error('ディスクの吸い出しに失敗しました。', err);
      return false;
    }
    if (!live) return false;
    const data = live.slice();
    // 目的B「IndexedDBへのディスク全量書出し」の始点(MEMFSから末尾まで取得・検査できた地点)。
    const probeContext = deps.buildProbeContext?.(slot);
    // 吸い出したバイト列は同期のうちにスロットへ反映する。restartWithFlush() は flushAll() の
    // 直後に teardownAndBoot() がスロットからディスクを書き直すため、反映を下の IndexedDB 書き込み
    // 完了後に回すと、書き込みが終わる前に再マウントが走って**古いバイト列で起動し直す**
    // (=リセットでセーブデータが巻き戻る)。IndexedDB の遅い iOS Safari では特に競合に負けやすい。
    // ここは冒頭で pending を読んだのと同じ同期区間なので、排出・差し替えと競合しない。
    deps.setSlot(slot, { ...pending, data });

    // ライブラリに実体を持たないディスク(MCPブリッジからの挿入等、sourceKey 無し)は
    // IndexedDB へは書き戻せないが、上のスロット反映によりリセットを跨いでは保持される。
    if (!sourceKey) return false;

    try {
      await deps.saveDisk({ sourceKey, name: pending.name, bytes: data, savedAt: deps.now() }, probeContext);
    } catch (err) {
      console.error('ディスクライブラリへの書き戻しに失敗しました。', err);
      return false;
    }

    deps.onSaved?.(slot);
    return true;
  }

  function flushAll(): void {
    if (!deps.isLive()) return;
    const dirty = deps.readDirtyState();
    for (const slot of slotIds) {
      const drive = deps.fddDriveOf(slot);
      const isDirty = drive === null ? dirty.hdd : (dirty.fddMask & (1 << drive)) !== 0;
      if (isDirty) void persistSlot(slot);
    }
  }

  async function restartWithFlush(teardownAndBoot: () => Promise<void>): Promise<void> {
    flushAll();
    await teardownAndBoot();
  }

  return { persistSlot, flushAll, restartWithFlush };
}
