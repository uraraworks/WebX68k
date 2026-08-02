import './style.css';
import { AudioEngine } from './audio';
import { loadBiosFile, saveBiosFile } from './bios-store';
import { codeToRetrok } from './keyboard';
import { LibretroHost } from './libretro-host';

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const btnStart = document.getElementById('btn-start') as HTMLButtonElement;
const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
const btnEject = document.getElementById('btn-eject') as HTMLButtonElement;
const biosIplInput = document.getElementById('bios-ipl') as HTMLInputElement;
const biosCgInput = document.getElementById('bios-cg') as HTMLInputElement;
const biosIplStatus = document.getElementById('bios-ipl-status') as HTMLSpanElement;
const biosCgStatus = document.getElementById('bios-cg-status') as HTMLSpanElement;
const dropzone = document.getElementById('dropzone') as HTMLDivElement;
const diskInput = document.getElementById('disk-input') as HTMLInputElement;
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
  statDisk.textContent = `${BUNDLED_DISK_NAME} (同梱)`;
  diskLamp.classList.add('active');
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

async function handleDiskFile(file: File): Promise<void> {
  const data = await fileToBytes(file);
  pendingDisk = { name: file.name, data };
  statDisk.textContent = file.name;
  diskLamp.classList.add('active');

  if (host && running) {
    // HDD イメージは実機同様ホットマウント不可(初回起動時のみ反映)のため、
    // 起動中の挿入はコアごと再起動して確実にブートし直す
    await restartCore();
  }
}

/** コアを初期化して起動する(pendingDisk があればそのディスクから) */
async function bootCore(): Promise<void> {
  host = new LibretroHost(canvas, (samples) => audio!.push(samples));
  host.setCoreOption('px68k_cpuspeed', cpuSpeed);
  host.setCoreOption('px68k_ramsize', ramSize);
  await host.init(biosIplBytes!, biosCgBytes!);

  if (pendingDisk) {
    const path = host.writeDiskImage(pendingDisk.name, pendingDisk.data);
    host.loadGame(path);
    btnEject.disabled = false;
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

dropzone.addEventListener('click', () => diskInput.click());
diskInput.addEventListener('change', () => {
  const file = diskInput.files?.[0];
  if (file) void handleDiskFile(file);
});
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  const file = e.dataTransfer?.files?.[0];
  if (file) void handleDiskFile(file);
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
  btnStart.textContent = '起動中...';

  try {
    audio = new AudioEngine();
    await audio.start();
    // タイマーがスロットルされる環境向け: オーディオスレッドの tick でも駆動する
    audio.setTickHandler(() => {
      if (running) enterLoop();
    });

    await bootCore();

    btnStart.textContent = '起動中';
    btnReset.disabled = false;
    canvas.focus();
  } catch (err) {
    console.error(err);
    alert(`起動に失敗しました: ${(err as Error).message ?? err}`);
    btnStart.disabled = false;
    btnStart.textContent = '起動';
  }
});

btnReset.addEventListener('click', () => {
  host?.reset();
});

btnEject.addEventListener('click', () => {
  pendingDisk = null;
  statDisk.textContent = '未挿入';
  diskLamp.classList.remove('active');
  btnEject.disabled = true;
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
