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

let biosIplBytes: Uint8Array | null = null;
let biosCgBytes: Uint8Array | null = null;
let pendingDisk: { name: string; data: Uint8Array } | null = null;

let audio: AudioEngine | null = null;
let host: LibretroHost | null = null;
let running = false;

function setBiosStatus(el: HTMLSpanElement, ok: boolean): void {
  el.textContent = ok ? '設定済み' : '未設定';
  el.className = ok ? 'status-ok' : 'status-ng';
}

async function fileToBytes(file: File): Promise<Uint8Array> {
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

async function restoreBiosFromIndexedDb(): Promise<void> {
  const [ipl, cg] = await Promise.all([loadBiosFile('ipl'), loadBiosFile('cg')]);
  if (ipl) {
    biosIplBytes = ipl;
    setBiosStatus(biosIplStatus, true);
  }
  if (cg) {
    biosCgBytes = cg;
    setBiosStatus(biosCgStatus, true);
  }
}

biosIplInput.addEventListener('change', async () => {
  const file = biosIplInput.files?.[0];
  if (!file) return;
  biosIplBytes = await fileToBytes(file);
  await saveBiosFile('ipl', biosIplBytes);
  setBiosStatus(biosIplStatus, true);
});

biosCgInput.addEventListener('change', async () => {
  const file = biosCgInput.files?.[0];
  if (!file) return;
  biosCgBytes = await fileToBytes(file);
  await saveBiosFile('cg', biosCgBytes);
  setBiosStatus(biosCgStatus, true);
});

async function handleDiskFile(file: File): Promise<void> {
  const data = await fileToBytes(file);
  pendingDisk = { name: file.name, data };
  statDisk.textContent = file.name;

  if (host && running) {
    // 起動中ならその場で差し替え
    host.unloadGame();
    const path = host.writeDiskImage(file.name, data);
    host.loadGame(path);
    btnEject.disabled = false;
  }
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

  requestAnimationFrame(loop);
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

    host = new LibretroHost(canvas, (samples) => audio!.push(samples));
    await host.init(biosIplBytes, biosCgBytes);

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
    requestAnimationFrame(loop);

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
  host?.unloadGame();
  pendingDisk = null;
  statDisk.textContent = '未挿入';
  btnEject.disabled = true;
});

void restoreBiosFromIndexedDb();
