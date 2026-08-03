import './style.css';
import { AudioEngine } from './audio';
import {
  createFormattedFd,
  fatDeleteFile,
  fatFreeSpace,
  fatList,
  fatMakeDir,
  fatReadFile,
  fatWriteFile,
  openDiskImage,
  type FatEntry,
} from './api/fat';
import { loadBiosFile, saveBiosFile } from './bios-store';
import {
  classifyDiskKind,
  deleteDisk,
  fileKeyFor,
  getDisk,
  listDisks,
  renameDisk,
  saveDisk,
  type StoredDisk,
} from './disk-store';
import { buildFileManagerDialog, type FmTarget } from './filemanager';
import { Bridge, resolveBridgeUrl, type BridgeHost } from './bridge';
import { RETROK, charToKey, codeToRetrok } from './keyboard';
import { LibretroHost } from './libretro-host';
import {
  getState,
  saveState as putState,
  type StateDiskConfig,
} from './state-store';
import { getLang, setLang, t } from './strings';

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const bootOverlay = document.getElementById('boot-overlay') as HTMLDivElement;
const btnBootPlain = document.getElementById('btn-boot-plain') as HTMLButtonElement;
const btnBootSystem = document.getElementById('btn-boot-system') as HTMLButtonElement;
const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
const btnMouseCapture = document.getElementById('btn-mouse-capture') as HTMLButtonElement;
const btnMouseResync = document.getElementById('btn-mouse-resync') as HTMLButtonElement;
const btnSaveState = document.getElementById('btn-save-state') as HTMLButtonElement;
const btnLoadState = document.getElementById('btn-load-state') as HTMLButtonElement;
const toastEl = document.getElementById('toast') as HTMLDivElement;
const btnSettings = document.getElementById('btn-settings') as HTMLButtonElement;
const btnDiskLibrary = document.getElementById('btn-disk-library') as HTMLButtonElement;
const btnFileManager = document.getElementById('btn-file-manager') as HTMLButtonElement;
const fileManagerRoot = document.getElementById('file-manager-root') as HTMLDivElement;
const btnHelp = document.getElementById('btn-help') as HTMLButtonElement;
const btnLang = document.getElementById('btn-lang') as HTMLButtonElement;
const settingsBackdrop = document.getElementById('settings-backdrop') as HTMLDivElement;
const settingsCloseBtn = document.getElementById('settings-close') as HTMLButtonElement;
const biosIplInput = document.getElementById('bios-ipl') as HTMLInputElement;
const biosCgInput = document.getElementById('bios-cg') as HTMLInputElement;
const biosIplStatus = document.getElementById('bios-ipl-status') as HTMLSpanElement;
const biosCgStatus = document.getElementById('bios-cg-status') as HTMLSpanElement;
const libraryBackdrop = document.getElementById('library-backdrop') as HTMLDivElement;
const libraryList = document.getElementById('library-list') as HTMLDivElement;
const libraryCloseBtn = document.getElementById('library-close') as HTMLButtonElement;
const slotPopupMenu = document.getElementById('slot-popup-menu') as HTMLDivElement;
const cfgCpuSpeed = document.getElementById('cfg-cpuspeed') as HTMLSelectElement;
const cfgRamSize = document.getElementById('cfg-ramsize') as HTMLSelectElement;

// WebNP2 のドライブ行に合わせた FDD1 / FDD2 / HDD の3スロット構成(表示ラベルのみ1始まり。
// コア内部のドライブindexは 0/1 のまま、要素IDも従来通り fdd0/fdd1 を使う)。
type SlotId = 'fdd0' | 'fdd1' | 'hdd';
const SLOT_IDS: SlotId[] = ['fdd0', 'fdd1', 'hdd'];

/** スロットの表示用ドライブ名(FDD1/FDD2/HDD)。 */
function slotDisplayName(slot: SlotId): string {
  if (slot === 'fdd0') return t('fdSlotLabel', { drive: 1 });
  if (slot === 'fdd1') return t('fdSlotLabel', { drive: 2 });
  return t('hddSlotLabel');
}

interface SlotElements {
  lamp: HTMLElement;
  label: HTMLElement;
  name: HTMLElement;
  insertBtn: HTMLButtonElement;
  input: HTMLInputElement;
  libraryBtn: HTMLButtonElement | null;
  blankBtn: HTMLButtonElement | null;
  ejectBtn: HTMLButtonElement;
  downloadBtn: HTMLButtonElement;
}

function slotEls(id: SlotId): SlotElements {
  return {
    lamp: document.getElementById(`lamp-${id}`) as HTMLElement,
    label: document.getElementById(`label-${id}`) as HTMLElement,
    name: document.getElementById(`name-${id}`) as HTMLElement,
    insertBtn: document.getElementById(`btn-insert-${id}`) as HTMLButtonElement,
    input: document.getElementById(`input-${id}`) as HTMLInputElement,
    libraryBtn: document.getElementById(`btn-library-${id}`) as HTMLButtonElement | null,
    blankBtn: document.getElementById(`btn-blank-${id}`) as HTMLButtonElement | null,
    ejectBtn: document.getElementById(`btn-eject-${id}`) as HTMLButtonElement,
    downloadBtn: document.getElementById(`btn-download-${id}`) as HTMLButtonElement,
  };
}

const slotElements: Record<SlotId, SlotElements> = {
  fdd0: slotEls('fdd0'),
  fdd1: slotEls('fdd1'),
  hdd: slotEls('hdd'),
};

interface PendingDisk {
  name: string;
  data: Uint8Array;
  /** ディスクライブラリ(IndexedDB)上のsourceKey。ファイルマネージャでライブラリ側との対応(マウント中バッジ)を
   *  取るために使う。ファイルマネージャ経由の書き込み等では変更しない。 */
  sourceKey?: string;
}

// 各ドライブへの挿入予定(起動前)/実際に挿入中(起動後)のディスク。
const slots: Record<SlotId, PendingDisk | null> = { fdd0: null, fdd1: null, hdd: null };
// 実行中コアの FS 上のパス。ダウンロード時にゲスト側の書き込みを反映した最新バイト列を
// mod.FS.readFile() で読み直すために使う(コアは /game 配下のファイルを直接書き換えるため)。
const mountedPaths: Record<SlotId, string | null> = { fdd0: null, fdd1: null, hdd: null };

let biosIplBytes: Uint8Array | null = null;
let biosCgBytes: Uint8Array | null = null;

// マシン構成(px68k-libretro のコアオプション px68k_cpuspeed / px68k_ramsize)。
// libretro_core_options.h の表記(大文字小文字含む)と完全一致させる必要がある。
const CPU_SPEED_KEY = 'webx68k-cpuspeed';
const RAM_SIZE_KEY = 'webx68k-ramsize';
// 既定は X68000 XVI 準拠 (CPU 16MHz / RAM 2MB)
const DEFAULT_CPU_SPEED = '16Mhz';
const DEFAULT_RAM_SIZE = '2MB';

function loadMachineConfig(): { cpuSpeed: string; ramSize: string } {
  const cpuSpeed = localStorage.getItem(CPU_SPEED_KEY) || DEFAULT_CPU_SPEED;
  const ramSize = localStorage.getItem(RAM_SIZE_KEY) || DEFAULT_RAM_SIZE;
  return { cpuSpeed, ramSize };
}

let { cpuSpeed, ramSize } = loadMachineConfig();
cfgCpuSpeed.value = cpuSpeed;
cfgRamSize.value = ramSize;

cfgCpuSpeed.addEventListener('change', () => {
  cpuSpeed = cfgCpuSpeed.value;
  localStorage.setItem(CPU_SPEED_KEY, cpuSpeed);
});
cfgRamSize.addEventListener('change', () => {
  ramSize = cfgRamSize.value;
  localStorage.setItem(RAM_SIZE_KEY, ramSize);
});

let audio: AudioEngine | null = null;
let host: LibretroHost | null = null;
let running = false;
let bootStarted = false;

// 同梱ROM/ディスク(public/system/)のパス。ユーザーが独自ファイルを設定した場合はそちらを優先する。
// GitHub Pages のプロジェクトページ(https://<user>.github.io/WebX68k/)配下でも解決できるよう、
// ルート絶対パスではなくドキュメント相対で指定すること(絶対パスだと /system/... を見に行き404になる)。
const BUNDLED_IPL_URL = './system/iplrom.dat';
const BUNDLED_CG_URL = './system/cgrom.dat';
const BUNDLED_DISK_URL = './system/human302.xdf';
const BUNDLED_DISK_NAME = 'human302.xdf';
// 同梱ディスクはIndexedDBには保存せず、ディスクライブラリの先頭に固定表示する(削除不可)。
const BUNDLED_DISK_SOURCE_KEY = 'bundled:human302';

function setBiosStatus(el: HTMLSpanElement, state: 'user' | 'bundled' | 'none'): void {
  if (state === 'user') {
    el.textContent = t('biosStatusUser');
    el.className = 'status-ok';
  } else if (state === 'bundled') {
    el.textContent = t('biosStatusBundled');
    el.className = 'status-bundled';
  } else {
    el.textContent = t('biosStatusNone');
    el.className = 'status-ng';
  }
}

let biosIplState: 'user' | 'bundled' | 'none' = 'none';
let biosCgState: 'user' | 'bundled' | 'none' = 'none';

async function fileToBytes(file: File): Promise<Uint8Array> {
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

async function fetchBytes(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`同梱ファイルの取得に失敗しました: ${url} (HTTP ${res.status})`);
      return null;
    }
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    console.error(`同梱ファイルの取得に失敗しました: ${url}`, err);
    return null;
  }
}

/**
 * BIOS(IPLROM/CGROM)を用意する。優先順位: ユーザー設定(IndexedDB) > 同梱ROM(public/system/)。
 * 同梱ROMはあくまでデフォルトなので IndexedDB には保存しない。
 */
async function restoreBios(): Promise<void> {
  const [ipl, cg] = await Promise.all([loadBiosFile('ipl'), loadBiosFile('cg')]);

  if (ipl) {
    biosIplBytes = ipl;
    biosIplState = 'user';
  } else {
    const bundled = await fetchBytes(BUNDLED_IPL_URL);
    if (bundled) {
      biosIplBytes = bundled;
      biosIplState = 'bundled';
    } else {
      biosIplState = 'none';
    }
  }

  if (cg) {
    biosCgBytes = cg;
    biosCgState = 'user';
  } else {
    const bundled = await fetchBytes(BUNDLED_CG_URL);
    if (bundled) {
      biosCgBytes = bundled;
      biosCgState = 'bundled';
    } else {
      biosCgState = 'none';
    }
  }
  setBiosStatus(biosIplStatus, biosIplState);
  setBiosStatus(biosCgStatus, biosCgState);
}

/**
 * 起動中は操作できないスロットか。
 * HDD(SASI)は実機でも活線挿抜する機器ではなく、差し替えるとゲスト側が握っている
 * マウント情報・キャッシュと実体がズレてしまうため、起動後は挿入も取り出しも禁止する
 * (FDD は px68k の FDD_SetFD/FDD_EjectFD でホットマウントできるので対象外)。
 */
function isSlotLocked(slot: SlotId): boolean {
  return slot === 'hdd' && host !== null && running;
}

/** ドライブ行のボタン活性・ツールチップを現在の状態に合わせて更新する。 */
function updateSlotControls(): void {
  for (const slot of SLOT_IDS) {
    const els = slotElements[slot];
    const locked = isSlotLocked(slot);
    const mounted = slots[slot] !== null;
    els.insertBtn.disabled = locked;
    if (els.libraryBtn) els.libraryBtn.disabled = locked;
    if (els.blankBtn) els.blankBtn.disabled = locked;
    els.ejectBtn.disabled = locked || !mounted;
    // ダウンロードは中身を読むだけなので起動中でも許可する
    els.downloadBtn.disabled = !mounted;

    // ロック中は理由をツールチップで出す。解除時は本来のタイトルへ戻す。
    const lockedHint = t('slotLockedWhileRunning');
    els.insertBtn.title = locked ? lockedHint : t('slotInsert');
    if (els.libraryBtn) els.libraryBtn.title = locked ? lockedHint : t('slotInsertFromLibrary');
    if (els.blankBtn) els.blankBtn.title = locked ? lockedHint : t('slotCreateBlank');
    els.ejectBtn.title = locked ? lockedHint : t('slotEject');
  }
}

/** スロット1件分の表示(ドライブ行のファイル名 + 各ボタン活性)を更新する。 */
function updateSlotDisplay(slot: SlotId, label: string | null): void {
  slotElements[slot].name.textContent = label ?? t('fdEmpty');
  updateSlotControls();
}

/** FDD スロット(fdd0/fdd1)をドライブ番号へ変換する。HDD は対象外なので null。 */
function fddDriveOf(slot: SlotId): number | null {
  if (slot === 'fdd0') return 0;
  if (slot === 'fdd1') return 1;
  return null;
}

/**
 * 実行中の FDD にディスクをホットマウントする(コア再起動なし)。
 * px68k の FDD_SetFD()/FDD_EjectFD() は実行中に呼んでも安全で、FDC の割り込みを通じて
 * ゲストにメディア交換として伝わるため、実機同様に「入れ替えただけ」の挙動になる。
 */
function hotSwapFdd(slot: SlotId, drive: number, image: { name: string; data: Uint8Array } | null): void {
  const oldPath = mountedPaths[slot];
  if (image) {
    const path = host!.writeDiskImage(`${slot}_${sanitizeFileName(image.name)}`, image.data);
    // FDD_SetFD は内部で先に旧ディスクを Eject する(= 旧イメージのファイルへ書き戻す)ため、
    // 新パスをセットしてから旧ファイルを片付ける順序にすること。
    host!.setFddImage(drive, path);
    mountedPaths[slot] = path;
    if (oldPath && oldPath !== path) host!.removeFile(oldPath);
  } else {
    // Eject 側もコア内部で FS のファイルへ書き戻してから外れるので、その後に削除する。
    host!.setFddImage(drive, '');
    mountedPaths[slot] = null;
    if (oldPath) host!.removeFile(oldPath);
  }
}

/**
 * ディスクをドライブへセットする(slots更新 + 表示更新)。
 * 起動中の場合、FDD は実機同様ホットマウントで差し替える(リセットは掛からない)。
 * HDD は起動中の交換を禁止しているため(isSlotLocked)、ここへ来るのは起動前だけ。
 */
async function insertDiskBytes(
  slot: SlotId,
  name: string,
  data: Uint8Array,
  displayLabel?: string,
  sourceKey?: string,
): Promise<void> {
  // ボタンは無効化してあるが、ドラッグ&ドロップ等の経路もあるためここでも弾く
  if (isSlotLocked(slot)) {
    alert(t('slotLockedWhileRunning'));
    return;
  }
  slots[slot] = { name, data, sourceKey };
  updateSlotDisplay(slot, displayLabel ?? name);

  if (host && running) {
    const drive = fddDriveOf(slot);
    if (drive !== null) hotSwapFdd(slot, drive, { name, data });
    else await restartCore(); // 保険(現状 HDD はロック済みでここへは来ない)
  }
}

function ejectSlot(slot: SlotId): void {
  if (isSlotLocked(slot)) {
    alert(t('slotLockedWhileRunning'));
    return;
  }
  const drive = fddDriveOf(slot);
  const wasRunning = host !== null && running;
  slots[slot] = null;
  updateSlotDisplay(slot, null);
  if (wasRunning && drive !== null) {
    hotSwapFdd(slot, drive, null);
    return;
  }
  mountedPaths[slot] = null;
  if (wasRunning) void restartCore();
}

biosIplInput.addEventListener('change', async () => {
  const file = biosIplInput.files?.[0];
  if (!file) return;
  biosIplBytes = await fileToBytes(file);
  await saveBiosFile('ipl', biosIplBytes);
  biosIplState = 'user';
  setBiosStatus(biosIplStatus, biosIplState);
});

biosCgInput.addEventListener('change', async () => {
  const file = biosCgInput.files?.[0];
  if (!file) return;
  biosCgBytes = await fileToBytes(file);
  await saveBiosFile('cg', biosCgBytes);
  biosCgState = 'user';
  setBiosStatus(biosCgStatus, biosCgState);
});

/**
 * D&D/ファイル選択で受け取ったディスクを指定ドライブへセットする。
 * WebNP2 のディスクライブラリと同じ流儀で、挿入と同時にディスクライブラリ(IndexedDB)へも自動登録する。
 */
async function handleDiskFile(slot: SlotId, file: File): Promise<void> {
  const data = await fileToBytes(file);
  const sourceKey = fileKeyFor(file.name, file.size);
  await saveDisk({ sourceKey, name: file.name, bytes: data, savedAt: Date.now() });
  await insertDiskBytes(slot, file.name, data, undefined, sourceKey);
  if (!libraryBackdrop.classList.contains('hidden')) void refreshLibraryList();
}

/** ディスクライブラリの1件(または同梱ディスク)を指定ドライブへ挿入する。 */
async function insertFromLibrary(sourceKey: string, slot: SlotId): Promise<void> {
  if (sourceKey === BUNDLED_DISK_SOURCE_KEY) {
    const bytes = await fetchBytes(BUNDLED_DISK_URL);
    if (!bytes) return;
    await insertDiskBytes(slot, BUNDLED_DISK_NAME, bytes, t('bundledDiskDisplayName'), sourceKey);
    return;
  }
  const stored = await getDisk(sourceKey);
  if (!stored) return;
  await insertDiskBytes(slot, stored.name, stored.bytes, stored.displayName ?? stored.name, sourceKey);
}

function formatLibrarySize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

interface LibraryRowEntry {
  sourceKey: string;
  name: string;
  displayName: string;
  size: number | null;
  savedAt: number | null;
  bundled: boolean;
}

function slotInsertLabel(slot: SlotId): string {
  return t('libraryInsertTo', { drive: slotDisplayName(slot) });
}

/** ディスクライブラリ1件分の行(バッジ/名前/サイズ/操作ボタン)を組み立てる。 */
function buildLibraryRow(entry: LibraryRowEntry): HTMLElement {
  const row = document.createElement('div');
  row.className = 'library-list-item';

  const kind = classifyDiskKind(entry.name);
  const badge = document.createElement('span');
  badge.className = `library-item-badge ${entry.bundled ? 'bundled' : kind === 'hdd' ? 'hdd' : ''}`.trim();
  badge.textContent = entry.bundled ? t('libraryBadgeBundled') : kind === 'hdd' ? t('libraryBadgeHdd') : t('libraryBadgeFd');
  row.append(badge);

  const nameEl = document.createElement('span');
  nameEl.className = 'library-item-name';
  nameEl.textContent = entry.displayName;
  // リネーム済みなら元のファイル名をツールチップで確認できるようにする。
  if (entry.displayName !== entry.name) nameEl.title = entry.name;
  row.append(nameEl);

  const metaEl = document.createElement('span');
  metaEl.className = 'library-item-meta';
  metaEl.textContent =
    entry.size === null || entry.savedAt === null
      ? t('libraryMetaAlwaysAvailable')
      : `${formatLibrarySize(entry.size)} / ${new Date(entry.savedAt).toLocaleString()}`;
  row.append(metaEl);

  const actions = document.createElement('div');
  actions.className = 'library-item-actions';

  // 挿入先ドライブを選べるようにする: HDDイメージはHDDへのみ、FDイメージはFDD1/FDD2へ挿入可能。
  const insertTargets: SlotId[] = kind === 'hdd' ? ['hdd'] : ['fdd0', 'fdd1'];
  for (const target of insertTargets) {
    const insertBtn = document.createElement('button');
    insertBtn.type = 'button';
    insertBtn.className = 'library-action-btn';
    insertBtn.textContent = slotInsertLabel(target);
    insertBtn.addEventListener('click', () => {
      void (async () => {
        await insertFromLibrary(entry.sourceKey, target);
        closeLibraryModal();
      })();
    });
    actions.append(insertBtn);
  }

  if (entry.bundled) {
    const note = document.createElement('span');
    note.className = 'library-item-note';
    note.textContent = t('libraryBundledNote');
    actions.append(note);
  } else {
    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'library-action-btn';
    renameBtn.textContent = t('libraryActionRename');
    renameBtn.addEventListener('click', () => {
      const next = prompt(t('libraryRenamePrompt', { name: entry.name }), entry.displayName);
      if (next === null) return;
      void (async () => {
        await renameDisk(entry.sourceKey, next);
        await refreshLibraryList();
      })();
    });
    actions.append(renameBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'library-action-btn danger';
    deleteBtn.textContent = t('libraryActionDelete');
    deleteBtn.addEventListener('click', () => {
      if (!confirm(t('libraryDeleteConfirm', { name: entry.displayName }))) return;
      void (async () => {
        await deleteDisk(entry.sourceKey);
        await refreshLibraryList();
      })();
    });
    actions.append(deleteBtn);
  }

  row.append(actions);
  return row;
}

/** ディスクライブラリ一覧を再描画する。先頭に同梱ディスク(固定・削除不可)、続けて保存時刻降順のユーザー登録分。 */
async function refreshLibraryList(): Promise<void> {
  const stored: StoredDisk[] = await listDisks();
  libraryList.textContent = '';

  libraryList.append(
    buildLibraryRow({
      sourceKey: BUNDLED_DISK_SOURCE_KEY,
      name: BUNDLED_DISK_NAME,
      displayName: t('bundledDiskDisplayName'),
      size: null,
      savedAt: null,
      bundled: true,
    }),
  );

  for (const item of stored) {
    libraryList.append(
      buildLibraryRow({
        sourceKey: item.sourceKey,
        name: item.name,
        displayName: item.displayName ?? item.name,
        size: item.bytes.byteLength,
        savedAt: item.savedAt,
        bundled: false,
      }),
    );
  }
}

function openLibraryModal(): void {
  libraryBackdrop.classList.remove('hidden');
  void refreshLibraryList();
}
function closeLibraryModal(): void {
  libraryBackdrop.classList.add('hidden');
}
btnDiskLibrary.addEventListener('click', () => openLibraryModal());
libraryCloseBtn.addEventListener('click', () => closeLibraryModal());
libraryBackdrop.addEventListener('click', (e) => {
  if (e.target === libraryBackdrop) closeLibraryModal();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !libraryBackdrop.classList.contains('hidden')) closeLibraryModal();
});

// --- スロットボタンのポップアップメニュー(WebNP2 の fdLibraryMenu を踏襲) ---
// 「ライブラリから挿入」「ブランク作成」の2種類でこの単一メニュー要素を使い回す。

function closeSlotPopupMenu(): void {
  slotPopupMenu.classList.add('hidden');
  slotPopupMenu.textContent = '';
}

function menuRow(label: string, extra?: string, cls = ''): HTMLElement {
  const children: Array<Node | string> = [];
  const labelEl = document.createElement('span');
  labelEl.className = 'library-menu-label';
  labelEl.textContent = label;
  children.push(labelEl);
  if (extra) {
    const extraEl = document.createElement('span');
    extraEl.className = 'library-menu-extra';
    extraEl.textContent = extra;
    children.push(extraEl);
  }
  const row = document.createElement('div');
  row.className = `library-menu-item ${cls}`.trim();
  row.setAttribute('role', 'menuitem');
  row.tabIndex = 0;
  row.append(...children);
  return row;
}

function onActivate(node: HTMLElement, handler: () => void): void {
  node.addEventListener('click', handler);
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handler();
    }
  });
}

/** ボタン直上にポップアップメニューを表示する(スロット行はカード下端にあるため下方向は画面外に出やすい)。 */
function positionSlotPopupMenu(anchorEl: HTMLElement): void {
  slotPopupMenu.style.left = '0px';
  slotPopupMenu.style.top = '0px';
  slotPopupMenu.classList.remove('hidden');
  const rect = anchorEl.getBoundingClientRect();
  const menuRect = slotPopupMenu.getBoundingClientRect();
  const left = Math.max(4, Math.min(rect.left, window.innerWidth - menuRect.width - 4));
  const top = Math.max(4, rect.top - menuRect.height - 4);
  slotPopupMenu.style.left = `${Math.round(left)}px`;
  slotPopupMenu.style.top = `${Math.round(top)}px`;
}

/** 「ライブラリから挿入」ポップアップ: 対象スロットの種別(FD/HDD)に合うライブラリ内容だけを一覧表示する。 */
async function openSlotLibraryMenu(slot: SlotId, anchorEl: HTMLButtonElement): Promise<void> {
  const stored = await listDisks();
  slotPopupMenu.textContent = '';
  const title = document.createElement('div');
  title.className = 'library-menu-title';
  title.textContent = t('slotInsertFromLibraryTitle', { drive: slotDisplayName(slot) });
  slotPopupMenu.append(title);

  let shown = 0;
  if (slot !== 'hdd') {
    const row = menuRow(t('bundledDiskDisplayName'));
    onActivate(row, () => {
      closeSlotPopupMenu();
      void (async () => {
        await insertFromLibrary(BUNDLED_DISK_SOURCE_KEY, slot);
      })();
    });
    slotPopupMenu.append(row);
    shown++;
  }
  for (const item of stored) {
    const kind = classifyDiskKind(item.name);
    const wantKind = slot === 'hdd' ? 'hdd' : 'fd';
    if (kind !== wantKind) continue;
    const row = menuRow(item.displayName ?? item.name);
    onActivate(row, () => {
      closeSlotPopupMenu();
      void insertFromLibrary(item.sourceKey, slot);
    });
    slotPopupMenu.append(row);
    shown++;
  }
  if (shown === 0) {
    const empty = document.createElement('div');
    empty.className = 'library-menu-empty';
    empty.textContent = t('libraryMenuEmpty');
    slotPopupMenu.append(empty);
  }
  positionSlotPopupMenu(anchorEl);
}

// X68000 標準フォーマット(2HD 1232KB=XDF標準 / 2HD 1440KB / 2DD 640KB / 2DD 720KB)。
// 中身はゼロ埋め(Human68kのFORMAT.Xで初期化する前提)。
const BLANK_FORMATS: Array<{ id: string; labelKey: 'blankFormat2hd1232' | 'blankFormat2hd1440' | 'blankFormat2dd640' | 'blankFormat2dd720'; size: number }> = [
  { id: '2hd1232', labelKey: 'blankFormat2hd1232', size: 1261568 },
  { id: '2hd1440', labelKey: 'blankFormat2hd1440', size: 1474560 },
  { id: '2dd640', labelKey: 'blankFormat2dd640', size: 655360 },
  { id: '2dd720', labelKey: 'blankFormat2dd720', size: 737280 },
];

/** 既存のライブラリ登録名と重複しないブランクディスク名を作る(WebNP2の createBlankFd の命名規則を踏襲)。 */
function uniqueBlankName(baseName: string, existingNames: Set<string>): string {
  let name = `${baseName}.xdf`;
  for (let i = 2; existingNames.has(name); i++) {
    name = `${baseName}${i}.xdf`;
  }
  return name;
}

/** 未フォーマットのブランクディスク(ゼロ埋め)を生成し、指定スロットへ挿入してライブラリにも登録する。 */
async function handleCreateBlank(slot: SlotId, formatId: string, sizeBytes: number): Promise<void> {
  const stored = await listDisks();
  const existingNames = new Set(stored.map((d) => d.name));
  const name = uniqueBlankName(`blank_${formatId}`, existingNames);
  const data = new Uint8Array(sizeBytes); // ゼロ埋め
  const sourceKey = fileKeyFor(name, data.length);
  await saveDisk({ sourceKey, name, bytes: data, savedAt: Date.now() });
  await insertDiskBytes(slot, name, data, undefined, sourceKey);
  if (!libraryBackdrop.classList.contains('hidden')) void refreshLibraryList();
}

/** 「ブランク作成」ポップアップ: X68000標準フォーマットから選ばせる。 */
function openSlotBlankMenu(slot: SlotId, anchorEl: HTMLButtonElement): void {
  slotPopupMenu.textContent = '';
  const title = document.createElement('div');
  title.className = 'library-menu-title';
  title.textContent = t('slotCreateBlankTitle', { drive: slotDisplayName(slot) });
  slotPopupMenu.append(title);

  for (const fmt of BLANK_FORMATS) {
    const row = menuRow(t(fmt.labelKey));
    onActivate(row, () => {
      closeSlotPopupMenu();
      void handleCreateBlank(slot, fmt.id, fmt.size);
    });
    slotPopupMenu.append(row);
  }
  positionSlotPopupMenu(anchorEl);
}

slotPopupMenu.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => {
  if (slotPopupMenu.classList.contains('hidden')) return;
  closeSlotPopupMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSlotPopupMenu();
});

/** 現在ドライブに入っているイメージをファイルとしてダウンロードする(WebNP2の slotDownload 相当)。 */
async function handleDownloadDisk(slot: SlotId): Promise<void> {
  const pending = slots[slot];
  if (!pending) {
    alert(t('alertDownloadNoImage'));
    return;
  }
  // 起動中でFSへ書き込み済みなら、ゲスト側の書き込みを反映した最新バイト列を
  // mod.FS.readFile() で読み直す(コアは/game配下のファイルを直接書き換えるため)。
  const path = mountedPaths[slot];
  let bytes: Uint8Array = pending.data;
  if (host && running && path) {
    try {
      bytes = host.readFile(path);
    } catch (err) {
      console.error('FS からのディスク読み出しに失敗しました。挿入時点のバイト列を使用します。', err);
    }
  }
  const blob = new Blob([bytes.slice()], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = pending.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/** ファイル名を FS 上のパスに使っても安全な形へ簡易サニタイズする。 */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/]/g, '_');
}

/**
 * コアを初期化して起動する(slots にセットされたディスクから)。
 *
 * FDD0/FDD1 は px68k-libretro の cmd ファイル展開(`px68k <fd0> <fd1>`)で同時指定できる。
 * HDD は cmd ファイル経由の `-h` 形式だと argc==3 限定で FDD と排他になってしまうため使わず、
 * 代わりに px68k_save_hdd_path コアオプションを有効にして起動前に /system/keropi/config へ
 * `[WinX68k]\nHDD0=...` を書き込む(LoadConfig() が拾う)ことで、FDD0/FDD1/HDD の3台を
 * 同時搭載できるようにしている。
 */
async function bootCore(): Promise<void> {
  host = new LibretroHost(canvas, (samples) => audio!.push(samples));
  host.setCoreOption('px68k_cpuspeed', cpuSpeed);
  host.setCoreOption('px68k_ramsize', ramSize);
  // HDD0 の永続化(config読込)を有効化。これでLoadConfig()が /system/keropi/config の
  // HDD0= を読み、cmdファイル(FDD0/FDD1指定)と共存できる。
  host.setCoreOption('px68k_save_hdd_path', 'enabled');
  // マウスを有効化する。px68k は MouseSW が立っていないと Mouse_Event() を丸ごと無視するため、
  // このオプション("Mouse")が Mouse_StartCapture(1) を呼ぶまでマウス入力は一切通らない。
  host.setCoreOption('px68k_joy_mouse', 'Mouse');
  await host.init(biosIplBytes!, biosCgBytes!);

  const fdd0Path = slots.fdd0
    ? host.writeDiskImage(`fdd0_${sanitizeFileName(slots.fdd0.name)}`, slots.fdd0.data)
    : '';
  const fdd1Path = slots.fdd1
    ? host.writeDiskImage(`fdd1_${sanitizeFileName(slots.fdd1.name)}`, slots.fdd1.data)
    : '';
  mountedPaths.fdd0 = slots.fdd0 ? fdd0Path : null;
  mountedPaths.fdd1 = slots.fdd1 ? fdd1Path : null;

  if (slots.hdd) {
    const hddPath = host.writeDiskImage(`hdd_${sanitizeFileName(slots.hdd.name)}`, slots.hdd.data);
    mountedPaths.hdd = hddPath;
    const iniText = `[WinX68k]\r\nHDD0=${hddPath}\r\n`;
    host.writeFile('/system/keropi/config', new TextEncoder().encode(iniText));
  } else {
    mountedPaths.hdd = null;
  }

  // px68k-libretro は "px68k <fd0> <fd1>" 形式の.cmdファイルでFDD0/FDD1を同時指定できる
  // (libretro.c pmain(): argc==3で FDDImage[0]/[1] を両方設定)。空スロットは空文字列で渡す。
  const cmdText = `px68k "${fdd0Path}" "${fdd1Path}"\n`;
  host.writeFile('/game/boot.cmd', new TextEncoder().encode(cmdText));
  host.loadGame('/game/boot.cmd');

  host.fetchAvInfo();

  running = true;
  lastFrameTime = 0;
  accumulator = 0;
  // running が立ってから更新する(HDD行のロック状態がここで確定する)
  updateSlotControls();
  resetAccessLamps();
  scheduleNext();
}

/** 実行中のコアを破棄して作り直す */
async function restartCore(): Promise<void> {
  running = false;
  cancelScheduled();
  host?.dispose();
  host = null;
  await bootCore();
}

// ドライブ行の挿入ボタン・ライブラリ/ブランクボタン・D&D配線(WebNP2 の FDスロット行と同じ流儀)。
for (const slot of SLOT_IDS) {
  const els = slotElements[slot];
  els.insertBtn.addEventListener('click', () => els.input.click());
  els.input.addEventListener('change', () => {
    const file = els.input.files?.[0];
    els.input.value = '';
    if (file) void handleDiskFile(slot, file);
  });
  els.libraryBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!slotPopupMenu.classList.contains('hidden')) {
      closeSlotPopupMenu();
      return;
    }
    void openSlotLibraryMenu(slot, els.libraryBtn!);
  });
  els.blankBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!slotPopupMenu.classList.contains('hidden')) {
      closeSlotPopupMenu();
      return;
    }
    openSlotBlankMenu(slot, els.blankBtn!);
  });
  els.ejectBtn.addEventListener('click', () => ejectSlot(slot));
  els.downloadBtn.addEventListener('click', () => void handleDownloadDisk(slot));

  const slotRow = document.getElementById(`slot-${slot}`) as HTMLDivElement;
  let depth = 0;
  slotRow.addEventListener('dragover', (e) => e.preventDefault());
  slotRow.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    slotRow.classList.add('dropzone-active');
  });
  slotRow.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) slotRow.classList.remove('dropzone-active');
  });
  slotRow.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    slotRow.classList.remove('dropzone-active');
    const file = e.dataTransfer?.files?.[0];
    if (file) void handleDiskFile(slot, file);
  });
}

// ドロップゾーン外(ページ余白等)に落としたとき、ブラウザが既定動作でファイルを開いてしまうのを抑止する。
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// 設定ダイアログ(BIOS登録 + マシン構成)。WebNP2 の ROM登録ダイアログと同じ開閉の仕組み。
function openSettingsDialog(): void {
  settingsBackdrop.classList.remove('hidden');
}
function closeSettingsDialog(): void {
  settingsBackdrop.classList.add('hidden');
}
btnSettings.addEventListener('click', () => openSettingsDialog());
settingsCloseBtn.addEventListener('click', () => closeSettingsDialog());
settingsBackdrop.addEventListener('click', (e) => {
  if (e.target === settingsBackdrop) closeSettingsDialog();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsBackdrop.classList.contains('hidden')) closeSettingsDialog();
});

// --- 言語切り替え(日本語/英語)。WebNP2 の langToggle 方式を踏襲。 ---
function applyDocumentStrings(): void {
  document.title = t('title');
  document.getElementById('doc-title')!.textContent = t('title');
  document.getElementById('header-tagline')!.textContent = t('headerTagline');
  document.getElementById('overlay-note-1')!.textContent = t('overlayNote1');
  document.getElementById('overlay-note-2')!.textContent = t('overlayNote2');
  btnBootPlain.textContent = t('overlayBootPlain');
  btnBootSystem.textContent = t('overlayBootSystem');

  btnReset.title = t('toolbarReset');
  btnReset.setAttribute('aria-label', t('toolbarReset'));
  btnMouseCapture.setAttribute('aria-label', t('toolbarMouseCapture'));
  btnMouseResync.setAttribute('aria-label', t('toolbarMouseResync'));
  updateMouseControls();
  btnSaveState.title = t('toolbarSaveState');
  btnSaveState.setAttribute('aria-label', t('toolbarSaveState'));
  btnLoadState.title = t('toolbarLoadState');
  btnLoadState.setAttribute('aria-label', t('toolbarLoadState'));
  btnSettings.title = t('toolbarSettings');
  btnSettings.setAttribute('aria-label', t('toolbarSettings'));
  btnDiskLibrary.title = t('toolbarDiskLibrary');
  btnDiskLibrary.setAttribute('aria-label', t('toolbarDiskLibrary'));
  btnFileManager.title = t('toolbarFileManager');
  btnFileManager.setAttribute('aria-label', t('toolbarFileManager'));
  btnHelp.title = t('toolbarHelp');
  btnHelp.setAttribute('aria-label', t('toolbarHelp'));
  btnLang.textContent = t('langToggle');

  for (const slot of SLOT_IDS) {
    const els = slotElements[slot];
    const drive = slotDisplayName(slot);
    els.label.textContent = drive;
    els.lamp.setAttribute('aria-label', t('diskLampLabel', { drive }));
    // title(ツールチップ)はロック状態で文言が変わるため updateSlotControls() 側で貼る
    els.insertBtn.setAttribute('aria-label', `${drive} ${t('slotInsert')}`);
    els.libraryBtn?.setAttribute('aria-label', `${drive} ${t('slotInsertFromLibrary')}`);
    els.blankBtn?.setAttribute('aria-label', `${drive} ${t('slotCreateBlank')}`);
    els.ejectBtn.setAttribute('aria-label', `${drive} ${t('slotEject')}`);
    els.downloadBtn.title = t('slotDownload');
    els.downloadBtn.setAttribute('aria-label', `${drive} ${t('slotDownload')}`);
    if (slots[slot] === null) els.name.textContent = t('fdEmpty');
    // 同梱ディスクの表示名は言語依存(「(同梱)」/「(bundled)」)なので貼り直す
    else if (slots[slot]!.sourceKey === BUNDLED_DISK_SOURCE_KEY) {
      els.name.textContent = t('bundledDiskDisplayName');
    }
  }
  updateSlotControls();


  document.getElementById('footer-copyright')!.textContent = t('footerCopyright');
  document.getElementById('footer-github')!.textContent = t('footerGithubLabel');
  // 紹介ページは単体HTMLなので、現在の言語を ?lang= で引き継いで開く。
  const footerAbout = document.getElementById('footer-about') as HTMLAnchorElement;
  footerAbout.textContent = t('footerAboutLabel');
  footerAbout.href = `./about.html?lang=${getLang()}`;
  document.getElementById('footer-poweredby-prefix')!.textContent = t('footerPoweredByPrefix');
  document.getElementById('footer-poweredby-suffix')!.textContent = t('footerPoweredBySuffix');

  document.getElementById('settings-title')!.textContent = t('settingsTitle');
  document.getElementById('settings-description')!.textContent = t('settingsDescription');
  document.getElementById('settings-bios-title')!.textContent = t('settingsBiosSectionTitle');
  document.getElementById('settings-machine-title')!.textContent = t('settingsMachineSectionTitle');
  document.getElementById('settings-machine-note')!.textContent = t('settingsMachineSectionNote');
  document.getElementById('settings-cpuspeed-label')!.textContent = t('settingsCpuSpeedLabel');
  document.getElementById('settings-ramsize-label')!.textContent = t('settingsRamSizeLabel');
  settingsCloseBtn.textContent = t('settingsClose');
  setBiosStatus(biosIplStatus, biosIplState);
  setBiosStatus(biosCgStatus, biosCgState);

  document.getElementById('library-title')!.textContent = t('libraryDialogTitle');
  document.getElementById('library-description')!.textContent = t('libraryDialogDescription');
  libraryCloseBtn.textContent = t('libraryDialogClose');
  if (!libraryBackdrop.classList.contains('hidden')) void refreshLibraryList();

  fileManagerDialog.applyStrings();
}

btnLang.addEventListener('click', () => {
  setLang(getLang() === 'ja' ? 'en' : 'ja');
  applyDocumentStrings();
});

// キーボード入力: canvas にフォーカスがある間だけ捕捉する
canvas.tabIndex = 0;
window.addEventListener('keydown', (e) => {
  if (document.activeElement !== canvas || !host) return;
  const code = codeToRetrok(e.code);
  host.setKey(code, true);
  e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  if (document.activeElement !== canvas || !host) return;
  const code = codeToRetrok(e.code);
  host.setKey(code, false);
  e.preventDefault();
});
// --- マウス入力 ---
// X68000 のマウスは SCC 経由で相対移動量(-128..127)を送る方式で、カーソル位置はゲストが
// 自前で管理する。そのため WebNP2 と同じく2つのモードを用意する。
//
//   追従モード(既定) … キャプチャせず、canvas 上のホストカーソル位置へゲストカーソルを追従させる。
//                       相対量しか送れないので「基準合わせ(ホーミング)」でゲストカーソルを
//                       左上へ寄せてから、推定位置との差分を送る。ズレたら「マウス再同期」で
//                       ホーミングをやり直す。
//   キャプチャモード … Pointer Lock で掴んで movementX/Y をそのまま送る。相対移動が要る
//                       ソフト向け。右ダブルクリック or ツールバーのボタンで切り替え、Esc で解除。
const MOUSE_SENSITIVITY_KEY = 'webx68k.mouseSensitivity';
const mouseSensitivity = Number(localStorage.getItem(MOUSE_SENSITIVITY_KEY)) || 1;
/** 右ダブルクリック判定の猶予(ms)。WebNP2 と同じ。 */
const RIGHT_DOUBLE_CLICK_MS = 500;
/**
 * 追従モード(キャプチャせずホストカーソルへゲストカーソルを追従させる)。
 *
 * X68000 のマウスは相対量しか送れないが、IOCS はワークエリアにカーソルの実座標と可動範囲を
 * 持っている($ACE/$AD0 と $A9A..$AA0)。そこを毎フレーム読んで差分を送る閉ループにしている。
 */
const ENABLE_MOUSE_TRACKING = true;
/**
 * IOCS のマウス加速テーブル(実測値)。[送信量, 実際に動くドット数]。
 *
 * IOCS は移動量に加速をかけるため、誤差をそのまま送ると**最大7.5倍に増幅されて行き過ぎ**、
 * 画面端から端へ発振する。3以下は加速がかからず 1:1 で、16 を境に急に倍率が上がる。
 * 逆引きして「予測移動量が誤差を超えない範囲で最大の送信量」を選べば必ず不足側に倒れるので、
 * 行き過ぎが原理的に起きない。残りは次フレーム以降の閉ループが詰め、最後は 1:1 の領域に
 * 入るのでぴたりと止まる。
 *
 * 加速の効き方は IOCS の設定で変わり得るが、この表は「行き過ぎないための上限見積もり」
 * としてしか使わないので、多少ずれても収束する。
 */
const MOUSE_ACCEL_TABLE: Array<[send: number, move: number]> = [
  [1, 1],
  [2, 2],
  [3, 3],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [8, 10],
  [10, 12],
  [12, 15],
  [14, 17],
  [16, 40],
  [20, 50],
  [24, 90],
  [32, 160],
  [48, 360],
];
/** カーソルが実際に動いたのを確認できるまで待つ最大フレーム数 */
const MOUSE_TRACK_ACK_FRAMES = 12;
/** IOCS ワークが読めないソフト向けフォールバックで、画面外まで押し切るための余白(ドット) */
const MOUSE_HOMING_MARGIN = 64;

/** 目標移動量(絶対値)に対して、行き過ぎない範囲で最大の送信量を返す。 */
function sendAmountFor(distance: number): number {
  const abs = Math.abs(distance);
  let send = 0;
  for (const [candidate, move] of MOUSE_ACCEL_TABLE) {
    if (move <= abs) send = candidate;
    else break;
  }
  return distance < 0 ? -send : send;
}

/** ホスト側カーソルの canvas 内相対位置(0..1)。実際の目標座標はゲストの可動範囲から毎フレーム決める。 */
let desiredRatioX = 0;
let desiredRatioY = 0;
let hasDesiredRatio = false;
/** 追従が空回りしている(送っているのにカーソルが動かない)ことを検出するためのカウンタ */
let trackStallFrames = 0;
let trackDisabled = false;
/** 送信後、カーソルが実際に動くのを待っている間の状態 */
let trackAckPending = false;
let trackAckFrames = 0;
let trackSentAtX = -1;
let trackSentAtY = -1;

function isMouseCaptured(): boolean {
  return document.pointerLockElement === canvas;
}

function isMouseTracking(): boolean {
  return ENABLE_MOUSE_TRACKING && running && !isMouseCaptured();
}

/**
 * 追従モードの1フレーム分の追い込み(閉ループ)。
 *
 * X68000 のマウスは相対量しか送れないが、IOCS はワークエリアにカーソルの実座標と可動範囲を
 * 持っている($ACE/$AD0 と $A9A..$AA0)。そこを毎フレーム読んで「目標との差分」を送るため、
 * ホスト側で位置を推定する必要がなく、ズレも自動的に吸収される。
 * ±128/回でしか送れないので、大きなジャンプは数フレームかけて収束する。
 */
function stepMouseTracking(): void {
  if (!host || !isMouseTracking() || !hasDesiredRatio || trackDisabled) return;
  const cur = host.readGuestCursor();
  // マウスを使っていないソフトではワークエリアが初期化されていない。その場合は何もしない。
  if (!cur) return;

  // 送った直後は、ゲストがまだ反映していない可能性がある。実際に動いたのを確認する前に
  // 次を送ると、同じ誤差に対して二重に送ることになって行き過ぎる。
  if (trackAckPending) {
    if (cur.x !== trackSentAtX || cur.y !== trackSentAtY) {
      trackAckPending = false;
      trackStallFrames = 0;
    } else if (++trackAckFrames > MOUSE_TRACK_ACK_FRAMES) {
      // 動かないまま待ち続けても仕方ないので、いったん待ちを解いて空回り判定に回す
      trackAckPending = false;
      trackStallFrames += MOUSE_TRACK_ACK_FRAMES;
    } else {
      return;
    }
  }

  if (host.hasPendingMouseDelta()) return;

  const targetX = Math.round(cur.minX + desiredRatioX * (cur.maxX - cur.minX));
  const targetY = Math.round(cur.minY + desiredRatioY * (cur.maxY - cur.minY));
  const dx = targetX - cur.x;
  const dy = targetY - cur.y;
  if (dx === 0 && dy === 0) {
    trackStallFrames = 0;
    return;
  }

  // 安全弁: 目標に届いていないのにカーソルがまったく動かない(IOCS ワークを使わず
  // 自前でカーソルを管理するソフト等)場合、送り続けても無駄なので追従を止める。
  if (trackStallFrames > 90) {
    trackDisabled = true;
    host.clearMouseState();
    showToast(t('mouseTrackUnavailable'));
    return;
  }

  const sendX = sendAmountFor(dx);
  const sendY = sendAmountFor(dy);
  // 加速の下限(1ドット)未満しか誤差が無い軸は動かさない
  if (sendX === 0 && sendY === 0) {
    trackStallFrames = 0;
    return;
  }

  host.addMouseDelta(sendX, sendY);
  trackSentAtX = cur.x;
  trackSentAtY = cur.y;
  trackAckPending = true;
  trackAckFrames = 0;
}

/**
 * 強制的に基準を取り直す(ツールバーの「マウス再同期」)。
 * 閉ループ追従が効いていれば本来ズレないが、IOCS ワークを使わず自前でカーソルを管理する
 * ソフトのために、左上へ押し付ける従来のホーミングをフォールバックとして残す。
 */
function resyncGuestMouse(): void {
  if (!host) return;
  // 止めていた追従を再開させる
  trackDisabled = false;
  trackStallFrames = 0;
  trackAckPending = false;
  if (host.readGuestCursor()) return; // 閉ループが効いているので押し付け不要
  const w = host.avInfo?.baseWidth || canvas.width;
  const h = host.avInfo?.baseHeight || canvas.height;
  const distance = Math.max(w, h) + MOUSE_HOMING_MARGIN;
  host.addMouseDelta(-distance, -distance);
}

function setMouseCaptured(capture: boolean): void {
  if (!running) return;
  if (capture) {
    if (isMouseCaptured()) return;
    // requestPointerLock はユーザー操作から同期的に呼ぶ必要があるので非同期処理を挟まない
    void Promise.resolve(canvas.requestPointerLock()).catch(() => {
      showToast(t('mouseCaptureFailed'));
    });
  } else {
    document.exitPointerLock();
  }
}

canvas.addEventListener('click', () => canvas.focus());

document.addEventListener('pointerlockchange', () => {
  if (isMouseCaptured()) {
    showToast(t('mouseCaptured'));
  } else {
    // 解除時は積み残しのデルタと押しっぱなし判定を捨てる(ボタンを押したまま Esc された場合の保険)。
    // 追従モードへ戻るので基準も作り直す。
    host?.clearMouseState();
    if (running) showToast(t('mouseReleased'));
  }
  updateMouseControls();
});

// キャプチャ開始は右ダブルクリック。追従モードでは左クリックをゲストへ通す必要があるため、
// 左クリックはキャプチャのトリガにしない(WebNP2 と同じ流儀)。
let lastRightClickAt = 0;
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  // キャプチャ中の右クリックはゲストの操作なので、解除には使わない(解除は Esc とツールバー)。
  // ここでトグルにすると、ゲスト側で右ダブルクリックを使う操作が勝手にキャプチャを外してしまう。
  if (!running || isMouseCaptured()) return;
  const now = performance.now();
  if (now - lastRightClickAt < RIGHT_DOUBLE_CLICK_MS) {
    lastRightClickAt = 0;
    setMouseCaptured(true);
    return;
  }
  lastRightClickAt = now;
});

canvas.addEventListener('mousemove', (e) => {
  if (!host || !running) return;
  if (isMouseCaptured()) {
    // movementX/Y は CSS ピクセル単位。canvas は拡大表示されるので、ゲスト側の1ドットへ換算する。
    const scale = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1;
    host.addMouseDelta(e.movementX * scale * mouseSensitivity, e.movementY * scale * mouseSensitivity);
    return;
  }
  // 追従モード: canvas 内の相対位置(0..1)だけ記録し、実際の送信は stepMouseTracking に任せる
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  desiredRatioX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  desiredRatioY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
  hasDesiredRatio = true;
});

// ボタンはキャプチャ中だけゲストへ渡す。
// 非キャプチャ時にも渡すと、キャプチャ開始の右ダブルクリックがそのままゲストに届いてしまい、
// X68000 側のソフトキーボード(ASK68K)が開くなど、意図しない反応を起こす。
canvas.addEventListener('mousedown', (e) => {
  if (!host || !isMouseCaptured()) return;
  if (e.button === 0) host.setMouseButton('left', true);
  else if (e.button === 2) host.setMouseButton('right', true);
  e.preventDefault();
});

window.addEventListener('mouseup', (e) => {
  if (!host) return;
  if (e.button === 0) host.setMouseButton('left', false);
  else if (e.button === 2) host.setMouseButton('right', false);
});

/** マウス関連ボタンの活性・表示状態を現在のモードに合わせる。 */
function updateMouseControls(): void {
  const captured = isMouseCaptured();
  btnMouseCapture.disabled = !running;
  btnMouseCapture.classList.toggle('active', captured);
  btnMouseCapture.title = captured ? t('toolbarMouseRelease') : t('toolbarMouseCapture');
  btnMouseCapture.setAttribute('aria-pressed', captured ? 'true' : 'false');
  // 再同期は追従モード専用(キャプチャ中は基準という概念が無い)
  btnMouseResync.disabled = !running || captured;
  btnMouseResync.title = t('toolbarMouseResync');
}

btnMouseCapture.addEventListener('click', () => setMouseCaptured(!isMouseCaptured()));
btnMouseResync.addEventListener('click', () => {
  if (!isMouseTracking()) return;
  resyncGuestMouse();
  showToast(t('mouseResynced'));
});

let lastFrameTime = 0;
let accumulator = 0;
let rafId = 0;
let timerId: ReturnType<typeof setTimeout> | undefined;

// rAF と setTimeout の両方でスケジュールし、先に発火した方が他方を取り消す。
// rAF が抑制される環境(非アクティブタブ・ヘッドレス)でもエミュレーションを止めないため。
// さらに AudioWorklet の tick (タブ非表示でも止まらない) からも enterLoop が呼ばれる。
function cancelScheduled(): void {
  cancelAnimationFrame(rafId);
  if (timerId !== undefined) clearTimeout(timerId);
  timerId = undefined;
}

function enterLoop(): void {
  cancelScheduled();
  loop(performance.now());
}

function scheduleNext(): void {
  rafId = requestAnimationFrame(() => enterLoop());
  timerId = setTimeout(() => enterLoop(), 32);
}

// アクセスランプ: コアが実際にディスクを読み書きしたフレームだけ点灯させる。
// 単純にそのフレームだけだと視認しづらいため、直近アクセスから ACCESS_GLOW_MS の間は
// 点灯を保持する(残光)。既定(アクセスなし)は枠だけの消灯状態。
const ACCESS_GLOW_MS = 120;
let lastAccessAt: Record<SlotId, number> = { fdd0: -Infinity, fdd1: -Infinity, hdd: -Infinity };

function resetAccessLamps(): void {
  lastAccessAt = { fdd0: -Infinity, fdd1: -Infinity, hdd: -Infinity };
  for (const slot of SLOT_IDS) slotElements[slot].lamp.classList.remove('active');
}

function pollDiskAccess(now: number): void {
  if (!host) return;
  const { fddReading, fddDrive, hddAccessing } = host.readDiskAccess();
  if (fddReading) {
    if (fddDrive === 0) lastAccessAt.fdd0 = now;
    else if (fddDrive === 1) lastAccessAt.fdd1 = now;
  }
  if (hddAccessing) lastAccessAt.hdd = now;

  for (const slot of SLOT_IDS) {
    const lit = now - lastAccessAt[slot] < ACCESS_GLOW_MS;
    slotElements[slot].lamp.classList.toggle('active', lit);
  }
}

// 開発時デバッグ用: 音声遅延(キュー滞留秒)とコアの現在 fps をコンソールから覗けるようにする。
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__webx68kDebug = {
    stat: () => ({ queuedSec: audio?.queuedSeconds ?? null, fps: host?.avInfo?.fps ?? null }),
    mouse: () => ({ captured: isMouseCaptured(), tracking: isMouseTracking(), ratio: { x: desiredRatioX, y: desiredRatioY }, pending: host?.hasPendingMouseDelta() ?? null, cursor: host?.readGuestCursor() ?? null, sensitivity: mouseSensitivity, core: host?.readMouseState() ?? null }),
    // Pointer Lock を経由せずに相対移動/ボタンを注入する。自動テスト用で、
    // 将来の MCP ブリッジ(mouse_move 相当)もこの経路をそのまま使う想定。
    peek: (addr: number) => host?.peekWord(addr) ?? null,
    moveMouse: (dx: number, dy: number) => host?.addMouseDelta(dx, dy),
    mouseButton: (button: 'left' | 'right', down: boolean) => host?.setMouseButton(button, down),
  };
}

function loop(t: number): void {
  if (!running || !host) return;

  if (lastFrameTime === 0) lastFrameTime = t;
  const dt = (t - lastFrameTime) / 1000;
  lastFrameTime = t;

  // fps は画面モード(15kHz/31kHz)切り替えでコアから再通知される(SET_SYSTEM_AV_INFO)。
  // 毎回 avInfo から読み直すことで、コアの1フレーム音声サンプル数(44100/fps)と
  // ホストのフレーム供給レートを一致させ、音声の遅延蓄積を防ぐ。
  const fps = host.avInfo?.fps ?? 60;

  // 音声キューの滞留量(= 実際の音声遅延)を見てフレーム供給ペースを微調整する。
  // 目標より溜まっていればフレーム間隔をわずかに伸ばして供給を絞り、少なければ詰める。
  // 補正幅は最大±2%で、ピッチ変化として聞き取れるレベルではない。
  // これが無いと、ディスクアクセス等で一度膨らんだ遅延がそのまま居座り続ける。
  const queued = audio?.queuedSeconds ?? 0;
  const err = queued - AudioEngine.TARGET_LATENCY_SEC;
  const adjust = Math.max(-0.02, Math.min(0.02, err / 2));
  const frameInterval = (1 / fps) * (1 + adjust);
  accumulator += dt;

  // 補正が追いつかない急変(タブ復帰・重い処理からの復帰)に備えた保険。
  let budget = 2;
  if (queued > AudioEngine.MAX_LATENCY_SEC * 0.8) budget = 0;
  else if (queued < AudioEngine.TARGET_LATENCY_SEC * 0.4) budget = 3;

  let ran = 0;
  while (accumulator >= frameInterval && ran < budget) {
    host.runFrame();
    accumulator -= frameInterval;
    ran++;
  }
  if (ran > 0) {
    pollDiskAccess(t);
    stepMouseTracking();
  }
  // 破綻(タブ非アクティブ復帰等)したら蓄積をリセット
  if (accumulator > frameInterval * 4) accumulator = 0;

  scheduleNext();
}

/** 起動前オーバーレイのボタン(「そのまま起動」/「システムディスクで起動」)から呼ばれる起動処理。 */
async function startFromOverlay(withSystemDisk: boolean): Promise<void> {
  if (bootStarted) return;
  bootStarted = true;

  if (!biosIplBytes || !biosCgBytes) {
    alert(t('alertBiosMissing'));
    bootStarted = false;
    return;
  }

  if (withSystemDisk && !slots.fdd0) {
    const bytes = await fetchBytes(BUNDLED_DISK_URL);
    if (bytes) {
      slots.fdd0 = { name: BUNDLED_DISK_NAME, data: bytes, sourceKey: BUNDLED_DISK_SOURCE_KEY };
      updateSlotDisplay('fdd0', t('bundledDiskDisplayName'));
    }
  }

  bootOverlay.classList.add('hidden');

  try {
    audio = new AudioEngine();
    await audio.start();
    // タイマーがスロットルされる環境向け: オーディオスレッドの tick でも駆動する
    audio.setTickHandler(() => {
      if (running) enterLoop();
    });

    await bootCore();

    btnReset.disabled = false;
    btnSaveState.disabled = false;
    btnLoadState.disabled = false;
    updateMouseControls();
    canvas.focus();
  } catch (err) {
    console.error(err);
    alert(t('alertBootFailed', { message: (err as Error).message ?? String(err) }));
    bootOverlay.classList.remove('hidden');
    bootStarted = false;
  }
}

btnBootPlain.addEventListener('click', () => void startFromOverlay(false));
btnBootSystem.addEventListener('click', () => void startFromOverlay(true));
// オーバーレイの空白部分(ボタン以外)をクリックしても「そのまま起動」と同じ扱いにする(WebNP2準拠)。
bootOverlay.addEventListener('click', (e) => {
  if (e.target === bootOverlay) void startFromOverlay(false);
});

btnReset.addEventListener('click', () => {
  host?.reset();
});

// --- ステートセーブ / ロード(WebNP2 のツールバー2ボタンに準拠。スロットはクイック1枠のみ) ---
const STATE_SLOT = 'quick';
let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** 画面下部に一時通知を出す(数秒で自動的に消える)。 */
function showToast(message: string): void {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2500);
}

/**
 * 現在のドライブ構成。ステートには**ディスクの中身もマウントパスも含まれない**ため
 * (px68k の FDD_StateAction はドライブのメタ情報しか保存しない)、これを別途記録しておき
 * ロード時に照合して、違うディスクの上へ復元して暴走するのを防ぐ。
 */
function currentDiskConfig(): StateDiskConfig {
  return {
    fdd0: slots.fdd0?.name ?? null,
    fdd1: slots.fdd1?.name ?? null,
    hdd: slots.hdd?.name ?? null,
  };
}

function describeDiskConfig(cfg: StateDiskConfig): string {
  return SLOT_IDS.map((slot) => `${slotDisplayName(slot)}: ${cfg[slot] ?? t('fdEmpty')}`).join(' / ');
}

function sameDiskConfig(a: StateDiskConfig, b: StateDiskConfig): boolean {
  return SLOT_IDS.every((slot) => a[slot] === b[slot]);
}

async function handleSaveState(): Promise<void> {
  if (!host || !running) return;
  const bytes = host.serialize();
  if (!bytes) {
    showToast(t('stateSaveFailed'));
    return;
  }
  try {
    await putState({ slot: STATE_SLOT, bytes, savedAt: Date.now(), disks: currentDiskConfig() });
  } catch (err) {
    console.error('ステートの保存に失敗しました。', err);
    showToast(t('stateSaveFailed'));
    return;
  }
  showToast(t('stateSaved'));
}

async function handleLoadState(): Promise<void> {
  if (!host || !running) return;
  let stored;
  try {
    stored = await getState(STATE_SLOT);
  } catch (err) {
    console.error('ステートの読み出しに失敗しました。', err);
    showToast(t('stateLoadFailed'));
    return;
  }
  if (!stored) {
    showToast(t('stateNotFound'));
    return;
  }

  const current = currentDiskConfig();
  if (!sameDiskConfig(stored.disks, current)) {
    const proceed = confirm(
      t('stateDiskMismatch', {
        saved: describeDiskConfig(stored.disks),
        current: describeDiskConfig(current),
      }),
    );
    if (!proceed) return;
  }

  if (!host.unserialize(new Uint8Array(stored.bytes))) {
    showToast(t('stateLoadFailed'));
    return;
  }
  // 復元直後は旧状態の音がキューに残っているので捨て、フレーム供給の蓄積もリセットする
  audio?.flush();
  lastFrameTime = 0;
  accumulator = 0;
  resetAccessLamps();
  showToast(t('stateLoaded'));
}

btnSaveState.addEventListener('click', () => void handleSaveState());
btnLoadState.addEventListener('click', () => void handleLoadState());

// --- ファイルマネージャ(FTPクライアント風2ペイン) ---
// FAT12/16として読み書き可能なFD拡張子。D88(セクタ形式が異なり非対応)はここに含めない。
const FM_EDITABLE_FD_EXTENSIONS = ['.xdf', '.dim', '.hdm', '.img', '.2hd'];

function isFmEditableFdName(name: string): boolean {
  const lower = name.toLowerCase();
  return FM_EDITABLE_FD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** FAT操作対象のイメージバイト列とFatVolume、変更を書き戻すためのpersist()をまとめたハンドル。 */
interface FmVolumeHandle {
  vol: ReturnType<typeof openDiskImage>;
  persist: () => Promise<void>;
}

/**
 * スロットのディスクイメージをFATボリュームとして開く。
 * 実行中かつ実際にコアへマウント済みなら、ゲスト側の書き込みを反映した最新バイト列を
 * FS(host.readFile)から読み直す(コアは/game配下のファイルを直接書き換えるため)。
 * persist() は書き換え結果を slots[] へ書き戻し、実行中なら反映する。反映方法は
 * 通常のディスク差し替えと揃えており、FDD はホットマウントで入れ替え(リセット無し)。
 * 起動中の HDD は交換禁止(isSlotLocked)なので、読み出し専用として扱い persist() は拒否する。
 */
function openSlotVolume(slot: SlotId): FmVolumeHandle {
  const pending = slots[slot];
  if (!pending) throw new Error('ディスクが挿入されていません');
  const path = mountedPaths[slot];
  const image = host && running && path ? host.readFile(path) : pending.data;
  const vol = openDiskImage(image, pending.name);
  return {
    vol,
    persist: async () => {
      if (isSlotLocked(slot)) throw new Error(t('slotLockedWhileRunning'));
      slots[slot] = { name: pending.name, data: image, sourceKey: pending.sourceKey };
      if (host && running) {
        const drive = fddDriveOf(slot);
        if (drive !== null) hotSwapFdd(slot, drive, { name: pending.name, data: image });
        else await restartCore();
      }
    },
  };
}

/** ライブラリ(IndexedDB)上のディスクイメージをFATボリュームとして開く。書き戻しはIndexedDBへ保存する。 */
async function openLibraryVolume(sourceKey: string): Promise<FmVolumeHandle> {
  const stored = await getDisk(sourceKey);
  if (!stored) throw new Error('ライブラリにイメージが見つかりません');
  const image = stored.bytes.slice();
  const vol = openDiskImage(image, stored.name);
  return {
    vol,
    persist: async () => {
      await saveDisk({ sourceKey, name: stored.name, bytes: image, savedAt: Date.now() });
      if (!libraryBackdrop.classList.contains('hidden')) void refreshLibraryList();
    },
  };
}

/** ファイルマネージャのターゲット一覧: FDD1/FDD2/HDD(実行中スロット) + ライブラリ内イメージ。 */
async function fmListTargets(): Promise<FmTarget[]> {
  const targets: FmTarget[] = [];
  for (const slot of SLOT_IDS) {
    const pending = slots[slot];
    const drive = slotDisplayName(slot);
    let editable = false;
    let note = '';
    if (!pending) {
      note = t('fmUnmountedLabel');
    } else if (isSlotLocked(slot)) {
      // 起動中の HDD は交換できないため、閲覧・取り出しのみ(書き込み不可)
      note = t('fmRunningLockedNote');
    } else if (slot !== 'hdd' && !isFmEditableFdName(pending.name)) {
      note = t('fmNotEditableNote');
    } else {
      editable = true;
    }
    const label = pending ? `${drive}: ${pending.name}${note ? ` (${note})` : ''}` : `${drive} (${note})`;
    targets.push({ kind: 'slot', ref: slot, label, mounted: !!pending, editable });
  }

  const stored = await listDisks();
  for (const item of stored) {
    const kind = classifyDiskKind(item.name);
    if (kind === null) continue;
    const editable = kind === 'hdd' || (kind === 'fd' && isFmEditableFdName(item.name));
    const note = editable ? '' : t('fmNotEditableNote');
    const mountedSlot = SLOT_IDS.find((s) => slots[s]?.sourceKey === item.sourceKey);
    const displayName = item.displayName ?? item.name;
    const label = `${displayName}${mountedSlot ? ` [${t('fmMountedBadge')}]` : ''}${note ? ` (${note})` : ''}`;
    targets.push({ kind: 'library', ref: item.sourceKey, label, mounted: !!mountedSlot, editable });
  }
  return targets;
}

async function fmOpenVolume(target: FmTarget): Promise<FmVolumeHandle> {
  if (target.kind === 'slot') return openSlotVolume(target.ref as SlotId);
  return openLibraryVolume(target.ref);
}

async function fmListDir(target: FmTarget, path: string): Promise<{ entries: FatEntry[]; free: number; total: number }> {
  const { vol } = await fmOpenVolume(target);
  const entries = fatList(vol, path);
  const { free, total } = fatFreeSpace(vol);
  return { entries, free, total };
}

async function fmReadFile(target: FmTarget, path: string): Promise<Uint8Array> {
  const { vol } = await fmOpenVolume(target);
  return fatReadFile(vol, path);
}

async function fmWriteFile(target: FmTarget, path: string, data: Uint8Array): Promise<void> {
  const h = await fmOpenVolume(target);
  fatWriteFile(h.vol, path, data);
  await h.persist();
}

async function fmDeleteFile(target: FmTarget, path: string): Promise<void> {
  const h = await fmOpenVolume(target);
  fatDeleteFile(h.vol, path);
  await h.persist();
}

async function fmMakeDir(target: FmTarget, path: string): Promise<void> {
  const h = await fmOpenVolume(target);
  fatMakeDir(h.vol, path);
  await h.persist();
}

/** FAT12フォーマット済みの転送用FDを新規生成し、既存ライブラリ名と重複しないよう連番を振ってライブラリへ保存する。 */
async function fmCreateTransferFd(desiredName: string): Promise<{ sourceKey: string; name: string }> {
  const stored = await listDisks();
  const existing = new Set(stored.map((d) => d.name.toLowerCase()));
  const dot = desiredName.lastIndexOf('.');
  const base = dot > 0 ? desiredName.slice(0, dot) : desiredName;
  const ext = dot > 0 ? desiredName.slice(dot) : '';
  let name = desiredName;
  for (let i = 2; existing.has(name.toLowerCase()); i++) {
    name = `${base}${i}${ext}`;
  }
  const bytes = createFormattedFd();
  const sourceKey = fileKeyFor(name, bytes.length);
  await saveDisk({ sourceKey, name, bytes, savedAt: Date.now() });
  return { sourceKey, name };
}

const fileManagerDialog = buildFileManagerDialog(fileManagerRoot, {
  listTargets: fmListTargets,
  listDir: fmListDir,
  readFile: fmReadFile,
  writeFile: fmWriteFile,
  deleteFile: fmDeleteFile,
  makeDir: fmMakeDir,
  createTransferFd: fmCreateTransferFd,
});
btnFileManager.addEventListener('click', () => fileManagerDialog.open());
btnHelp.addEventListener('click', () => window.open(`./help.html?lang=${getLang()}`, '_blank'));

applyDocumentStrings();

void (async () => {
  await restoreBios();
})();

// --- MCP ブリッジ(?bridge=1 で有効) ---------------------------------------
// エミュレータ本体はブラウザ内、MCP サーバーはユーザーのマシン上。ページ側から
// ws://127.0.0.1:<port> へ繋ぎに行く(詳細は mcp/README.md)。

/** ブリッジのスロット名(fdd0/fdd1/hdd)を検証する。 */
function toSlotId(value: string): SlotId {
  if (value === 'fdd0' || value === 'fdd1' || value === 'hdd') return value;
  throw new Error(`unknown slot: ${value} (fdd0/fdd1/hdd)`);
}

const bridgeHost: BridgeHost = {
  screenshot: () => canvas.toDataURL('image/png'),
  screenHash: () => {
    // 全画素を舐めると重いので間引いてハッシュする(画面変化の検出用途)
    const ctx = canvas.getContext('2d');
    if (!ctx) return 0;
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let h = 0;
    for (let i = 0; i < d.length; i += 997) h = (h * 31 + d[i]) | 0;
    return h;
  },
  reset: () => host?.reset(),
  setKey: (retrok, down) => host?.setKey(retrok, down),
  typeText: async (text) => {
    if (!host) throw new Error('not booted');
    const skipped: string[] = [];
    let typed = 0;
    for (const ch of text) {
      const key = charToKey(ch);
      if (!key) {
        skipped.push(ch);
        continue;
      }
      if (key.shift) host.setKey(RETROK.LSHIFT, true);
      host.setKey(key.code, true);
      await new Promise((r) => setTimeout(r, 90));
      host.setKey(key.code, false);
      if (key.shift) host.setKey(RETROK.LSHIFT, false);
      await new Promise((r) => setTimeout(r, 60));
      typed++;
    }
    return { typed, skipped };
  },
  mouseMove: (dx, dy) => host?.addMouseDelta(dx, dy),
  mouseButton: (button, down) => host?.setMouseButton(button, down),
  saveState: () => handleSaveState(),
  loadState: () => handleLoadState(),
  listDisks: () =>
    SLOT_IDS.map((slot) => ({ slot, name: slots[slot]?.name ?? null })),
  insertDisk: async (slot, name, bytes) => {
    await insertDiskBytes(toSlotId(slot), name, bytes);
  },
  ejectDisk: (slot) => ejectSlot(toSlotId(slot)),
  diskListFiles: async (slot, path) => {
    const { entries } = await fmListDir({ kind: 'slot', ref: toSlotId(slot), label: slot, mounted: true, editable: true }, path);
    return entries.map((e) => ({ name: e.name, size: e.size, isDir: e.isDir, mtime: e.mtime }));
  },
  diskReadFile: (slot, path) =>
    fmReadFile({ kind: 'slot', ref: toSlotId(slot), label: slot, mounted: true, editable: true }, path),
  diskWriteFile: (slot, path, bytes) =>
    fmWriteFile({ kind: 'slot', ref: toSlotId(slot), label: slot, mounted: true, editable: true }, path, bytes),
  readMemory: (addr, length) => {
    if (!host) throw new Error('not booted');
    const out: number[] = [];
    for (let i = 0; i < length; i++) out.push(host.peekByte(addr + i));
    return out;
  },
  status: () => ({
    running,
    fps: host?.avInfo?.fps ?? null,
    screen: { width: canvas.width, height: canvas.height },
    slots: SLOT_IDS.map((slot) => ({ slot, name: slots[slot]?.name ?? null })),
    mouseCaptured: isMouseCaptured(),
  }),
};

const bridgeUrl = resolveBridgeUrl(location.search);
if (bridgeUrl) {
  const bridge = new Bridge(bridgeHost);
  bridge.connect(bridgeUrl);
  (window as unknown as Record<string, unknown>).__webx68kBridge = bridge;
  console.info(`[WebX68k] MCP ブリッジへ接続します: ${bridgeUrl}`);
}
