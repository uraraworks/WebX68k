import './style.css';
import { AudioEngine } from './audio';
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
import { codeToRetrok } from './keyboard';
import { LibretroHost } from './libretro-host';

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const bootOverlay = document.getElementById('boot-overlay') as HTMLDivElement;
const btnBootPlain = document.getElementById('btn-boot-plain') as HTMLButtonElement;
const btnBootSystem = document.getElementById('btn-boot-system') as HTMLButtonElement;
const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
const btnSettings = document.getElementById('btn-settings') as HTMLButtonElement;
const btnDiskLibrary = document.getElementById('btn-disk-library') as HTMLButtonElement;
const settingsBackdrop = document.getElementById('settings-backdrop') as HTMLDivElement;
const settingsCloseBtn = document.getElementById('settings-close') as HTMLButtonElement;
const biosIplInput = document.getElementById('bios-ipl') as HTMLInputElement;
const biosCgInput = document.getElementById('bios-cg') as HTMLInputElement;
const biosIplStatus = document.getElementById('bios-ipl-status') as HTMLSpanElement;
const biosCgStatus = document.getElementById('bios-cg-status') as HTMLSpanElement;
const libraryBackdrop = document.getElementById('library-backdrop') as HTMLDivElement;
const libraryList = document.getElementById('library-list') as HTMLDivElement;
const libraryCloseBtn = document.getElementById('library-close') as HTMLButtonElement;
const statFps = document.getElementById('stat-fps') as HTMLElement;
const statRes = document.getElementById('stat-res') as HTMLElement;
const cfgCpuSpeed = document.getElementById('cfg-cpuspeed') as HTMLSelectElement;
const cfgRamSize = document.getElementById('cfg-ramsize') as HTMLSelectElement;

// WebNP2 のドライブ行に合わせた FDD0 / FDD1 / HDD の3スロット構成。
// 各スロットは「アクセスランプ + ドライブ名 + ファイル名 + 挿入/取り出しボタン」を持つ。
type SlotId = 'fdd0' | 'fdd1' | 'hdd';
const SLOT_IDS: SlotId[] = ['fdd0', 'fdd1', 'hdd'];

interface SlotElements {
  lamp: HTMLElement;
  name: HTMLElement;
  insertBtn: HTMLButtonElement;
  input: HTMLInputElement;
  ejectBtn: HTMLButtonElement;
}

function slotEls(id: SlotId): SlotElements {
  return {
    lamp: document.getElementById(`lamp-${id}`) as HTMLElement,
    name: document.getElementById(`name-${id}`) as HTMLElement,
    insertBtn: document.getElementById(`btn-insert-${id}`) as HTMLButtonElement,
    input: document.getElementById(`input-${id}`) as HTMLInputElement,
    ejectBtn: document.getElementById(`btn-eject-${id}`) as HTMLButtonElement,
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
}

// 各ドライブへの挿入予定(起動前)/実際に挿入中(起動後)のディスク。
const slots: Record<SlotId, PendingDisk | null> = { fdd0: null, fdd1: null, hdd: null };

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

let audio: AudioEngine | null = null;
let host: LibretroHost | null = null;
let running = false;
let bootStarted = false;

// 同梱ROM/ディスク(public/system/)のパス。ユーザーが独自ファイルを設定した場合はそちらを優先する。
const BUNDLED_IPL_URL = '/system/iplrom.dat';
const BUNDLED_CG_URL = '/system/cgrom.dat';
const BUNDLED_DISK_URL = '/system/human302.xdf';
const BUNDLED_DISK_NAME = 'human302.xdf';
// 同梱ディスクはIndexedDBには保存せず、ディスクライブラリの先頭に固定表示する(削除不可)。
const BUNDLED_DISK_SOURCE_KEY = 'bundled:human302';

function setBiosStatus(el: HTMLSpanElement, state: 'user' | 'bundled' | 'none'): void {
  if (state === 'user') {
    el.textContent = '設定済み';
    el.className = 'status-ok';
  } else if (state === 'bundled') {
    el.textContent = '同梱ROM使用中(差し替え可)';
    el.className = 'status-bundled';
  } else {
    el.textContent = '未設定';
    el.className = 'status-ng';
  }
}

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
    setBiosStatus(biosIplStatus, 'user');
  } else {
    const bundled = await fetchBytes(BUNDLED_IPL_URL);
    if (bundled) {
      biosIplBytes = bundled;
      setBiosStatus(biosIplStatus, 'bundled');
    } else {
      setBiosStatus(biosIplStatus, 'none');
    }
  }

  if (cg) {
    biosCgBytes = cg;
    setBiosStatus(biosCgStatus, 'user');
  } else {
    const bundled = await fetchBytes(BUNDLED_CG_URL);
    if (bundled) {
      biosCgBytes = bundled;
      setBiosStatus(biosCgStatus, 'bundled');
    } else {
      setBiosStatus(biosCgStatus, 'none');
    }
  }
}

/** スロット1件分の表示(ドライブ行のファイル名 + 取り出しボタン活性)を更新する。 */
function updateSlotDisplay(slot: SlotId, label: string | null): void {
  const els = slotElements[slot];
  els.name.textContent = label ?? '未挿入';
  els.ejectBtn.disabled = label === null;
}

/** ディスクをドライブへセットする(slots更新 + 表示更新)。起動中なら実機同様コアを再起動して反映する。 */
async function insertDiskBytes(
  slot: SlotId,
  name: string,
  data: Uint8Array,
  displayLabel?: string,
): Promise<void> {
  slots[slot] = { name, data };
  updateSlotDisplay(slot, displayLabel ?? name);

  if (host && running) {
    // FDD/HDD いずれもコアは実行中のホットマウントに対応していないため、
    // 起動中の挿入はコアごと再起動して確実にブートし直す。
    await restartCore();
  }
}

function ejectSlot(slot: SlotId): void {
  slots[slot] = null;
  updateSlotDisplay(slot, null);
  if (host && running) void restartCore();
}

biosIplInput.addEventListener('change', async () => {
  const file = biosIplInput.files?.[0];
  if (!file) return;
  biosIplBytes = await fileToBytes(file);
  await saveBiosFile('ipl', biosIplBytes);
  setBiosStatus(biosIplStatus, 'user');
});

biosCgInput.addEventListener('change', async () => {
  const file = biosCgInput.files?.[0];
  if (!file) return;
  biosCgBytes = await fileToBytes(file);
  await saveBiosFile('cg', biosCgBytes);
  setBiosStatus(biosCgStatus, 'user');
});

/**
 * D&D/ファイル選択で受け取ったディスクを指定ドライブへセットする。
 * WebNP2 のディスクライブラリと同じ流儀で、挿入と同時にディスクライブラリ(IndexedDB)へも自動登録する。
 */
async function handleDiskFile(slot: SlotId, file: File): Promise<void> {
  const data = await fileToBytes(file);
  const sourceKey = fileKeyFor(file.name, file.size);
  await saveDisk({ sourceKey, name: file.name, bytes: data, savedAt: Date.now() });
  await insertDiskBytes(slot, file.name, data);
  if (!libraryBackdrop.classList.contains('hidden')) void refreshLibraryList();
}

/** ディスクライブラリの1件(または同梱ディスク)を指定ドライブへ挿入する。 */
async function insertFromLibrary(sourceKey: string, slot: SlotId): Promise<void> {
  if (sourceKey === BUNDLED_DISK_SOURCE_KEY) {
    const bytes = await fetchBytes(BUNDLED_DISK_URL);
    if (!bytes) return;
    await insertDiskBytes(slot, BUNDLED_DISK_NAME, bytes, `${BUNDLED_DISK_NAME} (同梱)`);
    return;
  }
  const stored = await getDisk(sourceKey);
  if (!stored) return;
  await insertDiskBytes(slot, stored.name, stored.bytes, stored.displayName ?? stored.name);
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

const SLOT_INSERT_LABEL: Record<SlotId, string> = { fdd0: 'FDD0へ', fdd1: 'FDD1へ', hdd: 'HDDへ' };

/** ディスクライブラリ1件分の行(バッジ/名前/サイズ/操作ボタン)を組み立てる。 */
function buildLibraryRow(entry: LibraryRowEntry): HTMLElement {
  const row = document.createElement('div');
  row.className = 'library-list-item';

  const kind = classifyDiskKind(entry.name);
  const badge = document.createElement('span');
  badge.className = `library-item-badge ${entry.bundled ? 'bundled' : kind === 'hdd' ? 'hdd' : ''}`.trim();
  badge.textContent = entry.bundled ? '同梱' : kind === 'hdd' ? 'HDD' : 'FD';
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
      ? '常時利用可能'
      : `${formatLibrarySize(entry.size)} / ${new Date(entry.savedAt).toLocaleString()}`;
  row.append(metaEl);

  const actions = document.createElement('div');
  actions.className = 'library-item-actions';

  // 挿入先ドライブを選べるようにする: HDDイメージはHDDへのみ、FDイメージはFDD0/FDD1へ挿入可能。
  const insertTargets: SlotId[] = kind === 'hdd' ? ['hdd'] : ['fdd0', 'fdd1'];
  for (const target of insertTargets) {
    const insertBtn = document.createElement('button');
    insertBtn.type = 'button';
    insertBtn.className = 'library-action-btn';
    insertBtn.textContent = SLOT_INSERT_LABEL[target];
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
    note.textContent = '同梱ディスク(削除不可)';
    actions.append(note);
  } else {
    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'library-action-btn';
    renameBtn.textContent = '名前変更';
    renameBtn.addEventListener('click', () => {
      const next = prompt(`表示名を入力してください(元のファイル名: ${entry.name})`, entry.displayName);
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
    deleteBtn.textContent = '削除';
    deleteBtn.addEventListener('click', () => {
      if (!confirm(`保存済みデータ「${entry.displayName}」を削除します。よろしいですか？`)) return;
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
      displayName: `${BUNDLED_DISK_NAME} (同梱)`,
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
  await host.init(biosIplBytes!, biosCgBytes!);

  const fdd0Path = slots.fdd0
    ? host.writeDiskImage(`fdd0_${sanitizeFileName(slots.fdd0.name)}`, slots.fdd0.data)
    : '';
  const fdd1Path = slots.fdd1
    ? host.writeDiskImage(`fdd1_${sanitizeFileName(slots.fdd1.name)}`, slots.fdd1.data)
    : '';

  if (slots.hdd) {
    const hddPath = host.writeDiskImage(`hdd_${sanitizeFileName(slots.hdd.name)}`, slots.hdd.data);
    const iniText = `[WinX68k]\r\nHDD0=${hddPath}\r\n`;
    host.writeFile('/system/keropi/config', new TextEncoder().encode(iniText));
  }

  // px68k-libretro は "px68k <fd0> <fd1>" 形式の.cmdファイルでFDD0/FDD1を同時指定できる
  // (libretro.c pmain(): argc==3で FDDImage[0]/[1] を両方設定)。空スロットは空文字列で渡す。
  const cmdText = `px68k "${fdd0Path}" "${fdd1Path}"\n`;
  host.writeFile('/game/boot.cmd', new TextEncoder().encode(cmdText));
  host.loadGame('/game/boot.cmd');

  for (const slot of SLOT_IDS) {
    slotElements[slot].ejectBtn.disabled = slots[slot] === null;
  }

  const info = host.fetchAvInfo();
  statRes.textContent = `${info.baseWidth}x${info.baseHeight}`;

  running = true;
  lastFrameTime = 0;
  accumulator = 0;
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

// ドライブ行の挿入ボタン・D&D配線(WebNP2 の FDスロット行と同じ流儀)。
for (const slot of SLOT_IDS) {
  const els = slotElements[slot];
  els.insertBtn.addEventListener('click', () => els.input.click());
  els.input.addEventListener('change', () => {
    const file = els.input.files?.[0];
    els.input.value = '';
    if (file) void handleDiskFile(slot, file);
  });
  els.ejectBtn.addEventListener('click', () => ejectSlot(slot));

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
canvas.addEventListener('click', () => canvas.focus());

let lastFrameTime = 0;
let accumulator = 0;
let frameCounter = 0;
let fpsWindowStart = 0;
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

function loop(t: number): void {
  if (!running || !host) return;

  if (lastFrameTime === 0) {
    lastFrameTime = t;
    fpsWindowStart = t;
  }
  const dt = (t - lastFrameTime) / 1000;
  lastFrameTime = t;

  const fps = host.avInfo?.fps ?? 60;
  const frameInterval = 1 / fps;
  accumulator += dt;

  let ran = 0;
  while (accumulator >= frameInterval && ran < 2) {
    host.runFrame();
    accumulator -= frameInterval;
    ran++;
    frameCounter++;
  }
  if (ran > 0) pollDiskAccess(t);
  // 破綻(タブ非アクティブ復帰等)したら蓄積をリセット
  if (accumulator > frameInterval * 4) accumulator = 0;

  if (t - fpsWindowStart >= 1000) {
    statFps.textContent = String(frameCounter);
    frameCounter = 0;
    fpsWindowStart = t;
  }

  scheduleNext();
}

/** 起動前オーバーレイのボタン(「そのまま起動」/「システムディスクで起動」)から呼ばれる起動処理。 */
async function startFromOverlay(withSystemDisk: boolean): Promise<void> {
  if (bootStarted) return;
  bootStarted = true;

  if (!biosIplBytes || !biosCgBytes) {
    alert('BIOS ファイル (IPLROM.DAT / CGROM.DAT) を設定してください。');
    bootStarted = false;
    return;
  }

  if (withSystemDisk && !slots.fdd0) {
    const bytes = await fetchBytes(BUNDLED_DISK_URL);
    if (bytes) {
      slots.fdd0 = { name: BUNDLED_DISK_NAME, data: bytes };
      updateSlotDisplay('fdd0', `${BUNDLED_DISK_NAME} (同梱)`);
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
    canvas.focus();
  } catch (err) {
    console.error(err);
    alert(`起動に失敗しました: ${(err as Error).message ?? err}`);
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

void (async () => {
  await restoreBios();
})();
