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
const btnStart = document.getElementById('btn-start') as HTMLButtonElement;
const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
const btnSettings = document.getElementById('btn-settings') as HTMLButtonElement;
const settingsBackdrop = document.getElementById('settings-backdrop') as HTMLDivElement;
const settingsCloseBtn = document.getElementById('settings-close') as HTMLButtonElement;
const biosIplInput = document.getElementById('bios-ipl') as HTMLInputElement;
const biosCgInput = document.getElementById('bios-cg') as HTMLInputElement;
const biosIplStatus = document.getElementById('bios-ipl-status') as HTMLSpanElement;
const biosCgStatus = document.getElementById('bios-cg-status') as HTMLSpanElement;
const diskSlot = document.getElementById('disk-slot') as HTMLDivElement;
const diskInput = document.getElementById('disk-input') as HTMLInputElement;
const btnDiskInsert = document.getElementById('btn-disk-insert') as HTMLButtonElement;
const btnDiskEject = document.getElementById('btn-disk-eject') as HTMLButtonElement;
const btnDiskLibrary = document.getElementById('btn-disk-library') as HTMLButtonElement;
const diskName = document.getElementById('disk-name') as HTMLSpanElement;
const libraryBackdrop = document.getElementById('library-backdrop') as HTMLDivElement;
const libraryList = document.getElementById('library-list') as HTMLDivElement;
const libraryCloseBtn = document.getElementById('library-close') as HTMLButtonElement;
const statFps = document.getElementById('stat-fps') as HTMLElement;
const statRes = document.getElementById('stat-res') as HTMLElement;
const statDisk = document.getElementById('stat-disk') as HTMLElement;
const diskLamp = document.getElementById('disk-lamp') as HTMLElement;
const cfgCpuSpeed = document.getElementById('cfg-cpuspeed') as HTMLSelectElement;
const cfgRamSize = document.getElementById('cfg-ramsize') as HTMLSelectElement;

let biosIplBytes: Uint8Array | null = null;
let biosCgBytes: Uint8Array | null = null;
let pendingDisk: { name: string; data: Uint8Array } | null = null;

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

/**
 * ディスクが未挿入なら同梱のHuman68kシステムディスクをデフォルトとして挿入した状態にする。
 * ユーザーが別のディスクをドロップ/選択したらそちらが優先される(pendingDiskが上書きされるため)。
 */
async function restoreDefaultDisk(): Promise<void> {
  if (pendingDisk) return;
  const bytes = await fetchBytes(BUNDLED_DISK_URL);
  if (!bytes) return;
  pendingDisk = { name: BUNDLED_DISK_NAME, data: bytes };
  setDiskDisplay(`${BUNDLED_DISK_NAME} (同梱)`);
}

/** ディスクをドライブへセットする(pendingDisk更新 + 表示更新)。起動中なら実機同様コアを再起動して反映する。 */
async function insertDiskBytes(name: string, data: Uint8Array, displayLabel?: string): Promise<void> {
  pendingDisk = { name, data };
  setDiskDisplay(displayLabel ?? name);

  if (host && running) {
    // HDD イメージは実機同様ホットマウント不可(初回起動時のみ反映)のため、
    // 起動中の挿入はコアごと再起動して確実にブートし直す
    await restartCore();
  }
}

/** ディスク表示(スロット行のドライブ名 + ステータスバー + アクセスランプ + 取り出しボタン)をまとめて更新する。 */
function setDiskDisplay(name: string | null): void {
  const label = name ?? '未挿入';
  diskName.textContent = label;
  statDisk.textContent = label;
  diskLamp.classList.toggle('active', name !== null);
  btnDiskEject.disabled = name === null;
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
 * D&D/ファイル選択で受け取ったディスクをドライブへセットする。
 * WebNP2 のディスクライブラリと同じ流儀で、挿入と同時にディスクライブラリ(IndexedDB)へも自動登録する。
 */
async function handleDiskFile(file: File): Promise<void> {
  const data = await fileToBytes(file);
  const sourceKey = fileKeyFor(file.name, file.size);
  await saveDisk({ sourceKey, name: file.name, bytes: data, savedAt: Date.now() });
  await insertDiskBytes(file.name, data);
  if (!libraryBackdrop.classList.contains('hidden')) void refreshLibraryList();
}

/** ディスクライブラリの1件(または同梱ディスク)を現在のドライブへ挿入する。 */
async function insertFromLibrary(sourceKey: string): Promise<void> {
  if (sourceKey === BUNDLED_DISK_SOURCE_KEY) {
    const bytes = await fetchBytes(BUNDLED_DISK_URL);
    if (!bytes) return;
    await insertDiskBytes(BUNDLED_DISK_NAME, bytes, `${BUNDLED_DISK_NAME} (同梱)`);
    return;
  }
  const stored = await getDisk(sourceKey);
  if (!stored) return;
  await insertDiskBytes(stored.name, stored.bytes, stored.displayName ?? stored.name);
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

  const insertBtn = document.createElement('button');
  insertBtn.type = 'button';
  insertBtn.className = 'library-action-btn';
  insertBtn.textContent = '挿入';
  insertBtn.addEventListener('click', () => {
    void (async () => {
      await insertFromLibrary(entry.sourceKey);
      closeLibraryModal();
    })();
  });
  actions.append(insertBtn);

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

/** コアを初期化して起動する(pendingDisk があればそのディスクから) */
async function bootCore(): Promise<void> {
  host = new LibretroHost(canvas, (samples) => audio!.push(samples));
  host.setCoreOption('px68k_cpuspeed', cpuSpeed);
  host.setCoreOption('px68k_ramsize', ramSize);
  await host.init(biosIplBytes!, biosCgBytes!);

  if (pendingDisk) {
    const path = host.writeDiskImage(pendingDisk.name, pendingDisk.data);
    host.loadGame(path);
    btnDiskEject.disabled = false;
  } else {
    host.loadGameNone();
  }

  const info = host.fetchAvInfo();
  statRes.textContent = `${info.baseWidth}x${info.baseHeight}`;

  running = true;
  lastFrameTime = 0;
  accumulator = 0;
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

// ディスク挿入: WebNP2 の FDスロット行と同じ流儀(アイコンボタンでファイル選択 + スロット行へのD&D)。
btnDiskInsert.addEventListener('click', () => diskInput.click());
diskInput.addEventListener('change', () => {
  const file = diskInput.files?.[0];
  diskInput.value = '';
  if (file) void handleDiskFile(file);
});

// スロット行へのD&D(WebNP2 wireSlotDrop と同じ、dragenter/dragleaveの深さカウントで枠のちらつきを防ぐ)。
{
  let depth = 0;
  diskSlot.addEventListener('dragover', (e) => e.preventDefault());
  diskSlot.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    diskSlot.classList.add('dropzone-active');
  });
  diskSlot.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) diskSlot.classList.remove('dropzone-active');
  });
  diskSlot.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    diskSlot.classList.remove('dropzone-active');
    const file = e.dataTransfer?.files?.[0];
    if (file) void handleDiskFile(file);
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
  // 破綻(タブ非アクティブ復帰等)したら蓄積をリセット
  if (accumulator > frameInterval * 4) accumulator = 0;

  if (t - fpsWindowStart >= 1000) {
    statFps.textContent = String(frameCounter);
    frameCounter = 0;
    fpsWindowStart = t;
  }

  scheduleNext();
}

btnStart.addEventListener('click', async () => {
  if (!biosIplBytes || !biosCgBytes) {
    alert('BIOS ファイル (IPLROM.DAT / CGROM.DAT) を設定してください。');
    return;
  }

  btnStart.disabled = true;
  btnStart.title = '起動中...';

  try {
    audio = new AudioEngine();
    await audio.start();
    // タイマーがスロットルされる環境向け: オーディオスレッドの tick でも駆動する
    audio.setTickHandler(() => {
      if (running) enterLoop();
    });

    await bootCore();

    btnStart.title = '起動中';
    btnReset.disabled = false;
    canvas.focus();
  } catch (err) {
    console.error(err);
    alert(`起動に失敗しました: ${(err as Error).message ?? err}`);
    btnStart.disabled = false;
    btnStart.title = '起動';
  }
});

btnReset.addEventListener('click', () => {
  host?.reset();
});

btnDiskEject.addEventListener('click', () => {
  pendingDisk = null;
  setDiskDisplay(null);
  if (host && running) void restartCore();
});

cfgCpuSpeed.addEventListener('change', () => {
  cpuSpeed = cfgCpuSpeed.value;
  localStorage.setItem(CPU_SPEED_KEY, cpuSpeed);
  if (host && running) void restartCore();
});

cfgRamSize.addEventListener('change', () => {
  ramSize = cfgRamSize.value;
  localStorage.setItem(RAM_SIZE_KEY, ramSize);
  if (host && running) void restartCore();
});

void (async () => {
  await restoreBios();
  await restoreDefaultDisk();
})();
