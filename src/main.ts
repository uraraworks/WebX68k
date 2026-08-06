import './style.css';
import { AudioEngine } from './audio';
import {
  createFormattedFd,
  createFormattedHdd,
  fatDeleteFile,
  fatFreeSpace,
  fatList,
  fatMakeDir,
  fatReadFile,
  fatWriteFile,
  openDiskImage,
  type BlankFdFormatId,
  type FatEntry,
} from './api/fat';
import { loadBiosFile, saveBiosFile } from './bios-store';
import {
  classifyDiskBytes,
  classifyDiskKind,
  deleteDisk,
  deleteDiskGroup,
  detectDiskContentKind,
  ensureDiskExtension,
  fileKeyFor,
  getDisk,
  listDisks,
  renameDisk,
  renameDiskGroup,
  saveDisk,
  type StoredDisk,
} from './disk-store';
import { extractArchive, isArchive, resolveArchiveFileName } from './api/archive';
import {
  buildLibraryNodes,
  splitDisplayName,
  type LibraryEntry,
  type LibraryGroup,
  type LibraryNode,
} from './api/library';
import { buildFileManagerDialog, type FmTarget } from './filemanager';
import { Bridge, resolveBridgeUrl, type BridgeHost } from './bridge';
import { RETROK, charToKey, codeToRetrok } from './keyboard';
import { LibretroHost } from './libretro-host';
import { createVirtualKeyboard, SharedKeyInput } from './virtual-keyboard';
import {
  getState,
  saveState as putState,
  type StateDiskConfig,
} from './state-store';
import { describeError, getLang, setLang, t } from './strings';

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const bootOverlay = document.getElementById('boot-overlay') as HTMLDivElement;
const btnBootPlain = document.getElementById('btn-boot-plain') as HTMLButtonElement;
const btnBootSystem = document.getElementById('btn-boot-system') as HTMLButtonElement;
const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
const btnScreenshot = document.getElementById('btn-screenshot') as HTMLButtonElement;
const btnMouseCapture = document.getElementById('btn-mouse-capture') as HTMLButtonElement;
const btnMouseResync = document.getElementById('btn-mouse-resync') as HTMLButtonElement;
const btnFullscreen = document.getElementById('btn-fullscreen') as HTMLButtonElement;
const btnVirtualKeyboard = document.getElementById('btn-virtual-keyboard') as HTMLButtonElement;
const virtualKeyboardPanel = document.getElementById('virtual-keyboard') as HTMLDivElement;
const stageEl = document.querySelector('.stage') as HTMLDivElement;
// ウィンドウ表示時のリスケール(後述の rescale())で高さ計算に使う周辺要素。
const mainEl = document.querySelector('main') as HTMLElement;
const consoleCardEl = document.querySelector('.console-card') as HTMLElement;
const consoleFooterEl = document.querySelector('.console-footer') as HTMLElement;
const pageHeaderEl = document.querySelector('header.app-header') as HTMLElement | null;
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
const libraryDescriptionEl = document.getElementById('library-description') as HTMLParagraphElement;
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

// 物理・仮想・ブリッジ入力を入力元ごとに保持し、同じキーの片側だけが先に離れても
// コア側の押下状態が消えないよう集約する。
const sharedKeyInput = new SharedKeyInput((retrok, down) => host?.setKey(retrok, down));
const virtualKeyboard = createVirtualKeyboard(
  virtualKeyboardPanel,
  sharedKeyInput,
  (visible) => {
    btnVirtualKeyboard.classList.toggle('active', visible);
    btnVirtualKeyboard.setAttribute('aria-pressed', visible ? 'true' : 'false');
    btnVirtualKeyboard.title = visible ? t('toolbarVirtualKeyboardHide') : t('toolbarVirtualKeyboard');
    btnVirtualKeyboard.setAttribute('aria-label', btnVirtualKeyboard.title);
    // 仮想キーボードの表示/非表示でパネル高が変わり、画面に使える縦幅も変わるため再計算する。
    // このコールバックは virtual-keyboard.ts の refreshLayout() が rAF 内(パネル実測後)で
    // 呼んでくれるので、ここで呼ぶ rescale() も実測済みの高さを見て走る。
    rescale();
  },
);
btnVirtualKeyboard.addEventListener('click', () => virtualKeyboard.toggle());

// 同梱ROM/ディスク(public/system/)のパス。ユーザーが独自ファイルを設定した場合はそちらを優先する。
// GitHub Pages のプロジェクトページ(https://<user>.github.io/WebX68k/)配下でも解決できるよう、
// ルート絶対パスではなくドキュメント相対で指定すること(絶対パスだと /system/... を見に行き404になる)。
const BUNDLED_IPL_URL = './system/iplrom.dat';
const BUNDLED_CG_URL = './system/cgrom.dat';
const BUNDLED_DISK_URL = './system/human302.xdf';
const BUNDLED_DISK_NAME = 'human302.xdf';
// 同梱ディスクはIndexedDBには保存せず、ディスクライブラリの先頭に固定表示する(削除不可)。
const BUNDLED_DISK_SOURCE_KEY = 'bundled:human302';

// --- URLパラメータ(WebNP2 に準拠。fd1/fd2/hdd でディスクURL指定、run=1で自動起動)。---
// system=1: 同梱システムディスク(human302.xdf)をFDD1として使う(WebNP2の freedos=1 相当)。
// fd1 が同時指定されていれば fd1 を優先する。
const urlParams = new URLSearchParams(location.search);
const urlFd1 = urlParams.get('fd1') ?? undefined;
const urlFd2 = urlParams.get('fd2') ?? undefined;
const urlHdd = urlParams.get('hdd') ?? undefined;
const urlRun = urlParams.get('run') === '1';
const urlSystem = urlParams.get('system') === '1';

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
 * 進捗コールバック付きでURLからバイト列を取得する(WebNP2 の fetchWithProgress に準拠)。
 * fetch自体が失敗した場合(典型的にはCORS未対応オリジン)とHTTPステータスが失敗の場合とで
 * メッセージを分け、CORSが原因である可能性を利用者に伝える。
 */
async function fetchBytesWithProgress(
  url: string,
  onProgress: (loaded: number, total: number | null) => void,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error(t('urlFetchFailedNetwork', { url }));
  }
  if (!response.ok) {
    throw new Error(t('urlFetchFailedHttp', { url, status: response.status }));
  }
  const totalHeader = response.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : null;

  if (!response.body) {
    const buf = await response.arrayBuffer();
    onProgress(buf.byteLength, total);
    return new Uint8Array(buf);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total);
    }
  }
  const result = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** URLの末尾ファイル名を、クエリ/フラグメントを除いた部分から取り出す(配布URLの拡張子判定に使う)。 */
function urlFileNameGuess(url: string, label: string): string {
  const path = url.split('#')[0].split('?')[0];
  const base = path.split('/').pop();
  return decodeURIComponent(base || `${label}.img`);
}

/** URLパラメータのスロット(fd1/fd2/hdd)に対応する、アーカイブ内で受け入れるディスク種別。 */
function requiredKindForSlot(slot: SlotId): 'hdd' | 'fd' {
  return slot === 'hdd' ? 'hdd' : 'fd';
}

/** URLパラメータ経由のディスク解決結果。1枚ならそのままスロットへ、複数枚ならライブラリを開いて選ばせる。 */
type UrlSlotOutcome =
  | { kind: 'single'; name: string; bytes: Uint8Array; sourceKey: string }
  | { kind: 'group'; groupId: string }
  | { kind: 'error' };

/**
 * URLパラメータ由来のディスクイメージを用意する(WebNP2 の resolveImage に準拠)。
 * 取得結果がZIP/LZHアーカイブの場合は展開し、D&D/ファイル選択と同じ枚数分岐
 * (1枚ならそのままスロットへ、複数枚ならライブラリへ登録して選ばせる)を適用する。
 * アーカイブの展開・ライブラリ登録は同じURLの再訪時は再ダウンロードせず復帰する
 * (グループIDに `arcurl:<url>` を使い、展開済みのレコードがライブラリにあればそれを使う)。
 * 取得やスロットとの不一致で処理できない場合はここでトースト/アラートを出したうえで
 * { kind: 'error' } を返す(呼び出し側は他スロットの処理を継続できる)。
 */
async function resolveUrlSlotContent(url: string, label: string, slot: SlotId): Promise<UrlSlotOutcome> {
  const groupId = `arcurl:${url}`;
  const requiredKind = requiredKindForSlot(slot);

  // 展開済みのアーカイブ由来グループ(前回このURLを展開済み)があれば再ダウンロードせず復帰する。
  const stored = await listDisks();
  const resumedDisks = stored
    .filter((d) => d.sourceKey.startsWith(`${groupId}/`))
    .map((d): RegisteredDisk => ({ name: d.name, sourceKey: d.sourceKey, data: d.bytes, kind: classifyDiskKind(d.name) ?? 'fd' }));
  if (resumedDisks.length > 0) {
    showToast(t('urlArchiveResumed', { label, count: resumedDisks.length }));
    return finishArchiveDisks(resumedDisks, label, requiredKind, groupId);
  }

  // 非アーカイブの単体ディスクとして既に保存済みなら(従来どおり sourceKey===url)、そちらを使う。
  const plainStored = await getDisk(url);
  if (plainStored) {
    showToast(t('urlDiskResumed', { label, name: plainStored.name }));
    return { kind: 'single', name: plainStored.name, bytes: plainStored.bytes, sourceKey: url };
  }

  const name = urlFileNameGuess(url, label);
  showToast(t('urlFetching', { label, name }), null);
  let bytes: Uint8Array;
  try {
    bytes = await fetchBytesWithProgress(url, (loaded, total) => {
      showToast(
        t('urlFetchingProgress', {
          label,
          name,
          loaded: formatLibrarySize(loaded),
          total: total !== null ? formatLibrarySize(total) : null,
        }),
        null,
      );
    });
  } catch (err) {
    console.error(`URLパラメータのディスク取得に失敗しました (${label}): ${url}`, err);
    showToast(t('urlLoadFailedToast', { label, message: describeError(err) }), 8000);
    return { kind: 'error' };
  }

  // 拡張子で判定できない配布URL(拡張子無し)向けに、バイト列のシグネチャでもアーカイブかどうかを見る。
  const archiveName = resolveArchiveFileName(name, bytes);
  if (archiveName) {
    const disks = await registerArchiveBytesToLibrary(archiveName, bytes, groupId, name);
    return finishArchiveDisks(disks, label, requiredKind, groupId);
  }

  await saveDisk({ sourceKey: url, name, bytes, savedAt: Date.now() });
  return { kind: 'single', name, bytes, sourceKey: url };
}

/**
 * 展開済みのアーカイブ内容(disks)を、枚数とスロットの種別一致に応じて振り分ける。
 * - 0枚: ディスクイメージが見つからなかった旨のエラー
 * - スロットに合う種別が1つも無い: 不一致のエラー(例: hdd指定なのにFDしか無い)
 * - 1枚(かつ種別一致): そのままスロットへ
 * - 2枚以上: グループとして登録済みなので、呼び出し側でライブラリを開いて選ばせる
 */
function finishArchiveDisks(
  disks: RegisteredDisk[],
  label: string,
  requiredKind: 'hdd' | 'fd',
  groupId: string,
): UrlSlotOutcome {
  if (disks.length === 0) {
    showToast(t('urlArchiveNoDiskImage', { label }), 8000);
    return { kind: 'error' };
  }
  const matching = disks.some((d) => d.kind === requiredKind);
  if (!matching) {
    showToast(t('urlArchiveKindMismatch', { label, kind: requiredKind }), 8000);
    return { kind: 'error' };
  }
  if (disks.length === 1) {
    const only = disks[0];
    return { kind: 'single', name: only.name, bytes: only.data, sourceKey: only.sourceKey };
  }
  return { kind: 'group', groupId };
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

/** いずれかのスロットにディスクがセット済みか。起動オーバーレイのボタン文言の出し分けに使う。 */
function hasAnySlotSet(): boolean {
  return SLOT_IDS.some((slot) => slots[slot] !== null);
}

/** 起動前オーバーレイの1つ目のボタン文言を、セット状態に合わせて更新する。 */
function updateOverlayBootLabel(): void {
  btnBootPlain.textContent = hasAnySlotSet() ? t('overlayBootPlainPending') : t('overlayBootPlain');
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
    if (els.blankBtn) {
      els.blankBtn.title = locked ? lockedHint : slot === 'hdd' ? t('hddCreateBlank') : t('slotCreateBlank');
    }
    els.ejectBtn.title = locked ? lockedHint : t('slotEject');
  }
  // 起動前にセットしただけ(コア未マウント)のHDDは、マウント済みと区別できるよう控えめに印を付ける。
  slotElements.hdd.name.classList.toggle('pending', slots.hdd !== null && !running);
  updateOverlayBootLabel();
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
 * 実行中スロットの「現時点の」イメージバイト列を取り出す(未起動/未マウントなら null)。
 *
 * FDD は px68k がイメージをまるごとメモリに載せて動かし、FS 上のファイルへ書き戻すのは
 * Eject のときだけなので、ファイルをそのまま読むと「マウントした瞬間の内容」しか得られない
 * (ゲストが作ったファイルは見えないし、それを土台に書き戻すとゲストの書き込みが消える)。
 * そこで一度 Eject して書き戻させ、同じファイルを入れ直してから読む。
 * HDD(SASI)はセクタ単位で FS のファイルを直接書き換えるため、そのまま読めばよい。
 */
function readLiveSlotImage(slot: SlotId): Uint8Array | null {
  const path = mountedPaths[slot];
  if (!host || !running || !path) return null;
  const drive = fddDriveOf(slot);
  if (drive === null) return host.readFile(path);
  host.setFddImage(drive, '');
  try {
    return host.readFile(path);
  } finally {
    host.setFddImage(drive, path);
  }
}

/**
 * 実行中の FDD にディスクをホットマウントする(コア再起動なし)。
 * px68k の FDD_SetFD()/FDD_EjectFD() は実行中に呼んでも安全で、FDC の割り込みを通じて
 * ゲストにメディア交換として伝わるため、実機同様に「入れ替えただけ」の挙動になる。
 */
function hotSwapFdd(slot: SlotId, drive: number, image: { name: string; data: Uint8Array } | null): void {
  const oldPath = mountedPaths[slot];
  if (image) {
    // 必ず先に Eject すること。FDD_SetFD は内部で旧ディスクを Eject し、そのとき
    // XDF_Eject/DIM_Eject/D88_Eject が「コアがメモリに持っているイメージ」を無条件で
    // ファイルへ書き戻す。ファイルを先に書いてから SetFD すると、同名パス(=同じスロットへ
    // 同じディスクを入れ直すファイルマネージャの書き戻し)では古い内容で上書きされ、
    // 転送・mkdir の結果が丸ごと消える。test/core-fdd-hotswap.test.ts で実測済み。
    host!.setFddImage(drive, '');
    mountedPaths[slot] = null;
    const path = host!.writeDiskImage(`${slot}_${sanitizeFileName(image.name)}`, image.data);
    if (oldPath && oldPath !== path) host!.removeFile(oldPath);
    host!.setFddImage(drive, path);
    mountedPaths[slot] = path;
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
  const { sourceKey, data } = await saveDiskFileToLibrary(file);
  await insertDiskBytes(slot, file.name, data, undefined, sourceKey);
  if (!libraryBackdrop.classList.contains('hidden')) void refreshLibraryList();
}

/**
 * ディスク単体ファイル(アーカイブでない1枚)をそのままディスクライブラリ(IndexedDB)へ保存する。
 * スロットへの挿入は呼び出し側の責務(挿入せずライブラリ登録だけしたい呼び出し元と共用するため分離)。
 */
async function saveDiskFileToLibrary(file: File): Promise<{ sourceKey: string; data: Uint8Array }> {
  const data = await fileToBytes(file);
  const sourceKey = fileKeyFor(file.name, file.size);
  await saveDisk({ sourceKey, name: file.name, bytes: data, savedAt: Date.now() });
  return { sourceKey, data };
}

// --- アーカイブ(ZIP/LZH)の展開とライブラリ登録 ---
// WebNP2 のディスクライブラリ(圧縮ファイル展開登録)を移植。ロジックはそちら準拠、UIはこのファイル内で完結させる。

/** ライブラリへ登録した(起動/挿入にそのまま流用する)ディスクイメージ1件。 */
interface RegisteredDisk {
  name: string;
  sourceKey: string;
  data: Uint8Array;
  kind: 'hdd' | 'fd';
}

/** アーカイブ内パスからファイル名部分のみを取り出す(グループ内表示とイメージ種別判定に使う)。 */
function baseNameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * ZIP/LZH のバイト列を展開し、中に含まれるディスクイメージだけを取り出す(readme等の非対応拡張子は無視する)。
 * `groupId` は同一アーカイブから展開した複数ディスクをまとめるID兼sourceKeyの接頭辞
 * (D&D/ファイル選択なら `arc:name:size`、URLパラメータなら `arcurl:url` を渡す)。
 */
async function expandArchiveBytesToDisks(
  archiveName: string,
  archiveBytes: Uint8Array,
  groupId: string,
): Promise<RegisteredDisk[]> {
  const entries = await extractArchive(archiveName, archiveBytes);
  const disks: RegisteredDisk[] = [];
  for (const entry of entries) {
    const rawName = baseNameOf(entry.name);
    // アーカイブ内エントリに限り、拡張子で判定できない場合はサイズ/シグネチャによる内容ベース判定へフォールバックする
    // (X68000のディスクはLZH配布で拡張子なしのファイル名が珍しくないため)。単体ファイルの取り込みでは使わない。
    const kind = classifyDiskBytes(rawName, entry.data);
    if (!kind) continue;
    // 内容ベースで判定した場合は、後からライブラリのバッジ判定(classifyDiskKind)が壊れないよう拡張子を補う。
    // DIMヘッダ付きと判定したイメージは px68k がヘッダの有無を".dim"拡張子で見分けるため ".xdf" にしない。
    const contentKind = detectDiskContentKind(rawName, entry.data);
    const name = ensureDiskExtension(rawName, kind, contentKind);
    // アーカイブ間で同名同サイズのディスクが衝突しないよう、キーにアーカイブ内パスを含める。
    disks.push({ name, sourceKey: `${groupId}/${entry.name}`, data: entry.data, kind });
  }
  return disks;
}

/**
 * アーカイブ(ZIP/LZH)のバイト列を展開し、中のディスクイメージをすべてライブラリ(IndexedDB)へ保存する。
 * 2枚以上を含む場合は `groupId`/`groupDisplayName` でグループ(フォルダ)としてまとめる。
 * 戻り値は保存したイメージ本体(直後に起動/挿入へそのままバイト列を流用するため)。
 */
async function registerArchiveBytesToLibrary(
  archiveName: string,
  archiveBytes: Uint8Array,
  groupId: string,
  groupDisplayName: string,
): Promise<RegisteredDisk[]> {
  let disks: RegisteredDisk[];
  try {
    disks = await expandArchiveBytesToDisks(archiveName, archiveBytes, groupId);
  } catch (err) {
    alert(t('statusArchiveFailed', { name: archiveName, message: err instanceof Error ? err.message : String(err) }));
    return [];
  }
  const grouped = disks.length > 1;
  for (let i = 0; i < disks.length; i++) {
    const disk = disks[i];
    // 同じアーカイブを再取り込みしたときに、以前付けた表示名/グループ情報を消さない(saveDiskが優先する)。
    await saveDisk({
      sourceKey: disk.sourceKey,
      name: disk.name,
      bytes: disk.data,
      savedAt: Date.now(),
      group: grouped ? groupId : undefined,
      groupName: grouped ? groupDisplayName : undefined,
      groupIndex: grouped ? i : undefined,
    });
  }
  return disks;
}

/**
 * アーカイブ(ZIP/LZH、File)を展開し、中のディスクイメージをすべてライブラリ(IndexedDB)へ保存する
 * (D&D/ファイル選択用の薄いラッパ。groupIdはファイル名+サイズ由来)。
 */
async function registerArchiveToLibrary(file: File): Promise<RegisteredDisk[]> {
  const archiveBytes = await fileToBytes(file);
  return registerArchiveBytesToLibrary(file.name, archiveBytes, `arc:${file.name}:${file.size}`, file.name);
}

/**
 * D&D/ファイル選択で受け取ったファイルをスロットへ反映する。ZIP/LZHの場合は中のディスクイメージだけを
 * 取り出してライブラリへ登録し、1枚ならそのままスロットへ挿入、複数枚ならライブラリを開いて
 * どれを使うか選ばせる(実行中の取り込みも同様に受け付ける。挿入自体は insertDiskBytes が
 * 起動前/起動中どちらも扱えるため、WebNP2のような起動前後の分岐は不要)。
 *
 * `slot` はドライブ行D&D/ファイル選択のように投入先が既に決まっている場合はそのスロットIDを、
 * 画面(stage)へのD&Dのように「イメージの種別(hdd/fd)を見てから投入先を決めたい」場合は
 * `(kind) => SlotId` の関数を渡す。関数を渡した場合、非アーカイブは拡張子から、アーカイブは
 * 展開後1枚だけ残った実際のイメージの種別(`RegisteredDisk.kind`)から解決する。
 */
async function handleDroppedOrPickedFile(
  slot: SlotId | ((kind: 'hdd' | 'fd') => SlotId),
  file: File,
): Promise<void> {
  const resolveSlot = (kind: 'hdd' | 'fd'): SlotId => (typeof slot === 'function' ? slot(kind) : slot);

  if (!isArchive(file.name)) {
    await handleDiskFile(resolveSlot(classifyDiskKind(file.name) ?? 'fd'), file);
    return;
  }
  const groupId = `arc:${file.name}:${file.size}`;
  const registered = await registerArchiveToLibrary(file);
  if (registered.length === 0) {
    alert(t('dropNoDiskImage'));
    return;
  }
  if (registered.length === 1) {
    const only = registered[0];
    await insertDiskBytes(resolveSlot(only.kind), only.name, only.data, undefined, only.sourceKey);
    if (!libraryBackdrop.classList.contains('hidden')) void refreshLibraryList();
    return;
  }
  showToast(t('statusLibraryAdded', { count: registered.length }));
  openLibraryModal(groupId);
}

/**
 * ディスクライブラリのダイアログへD&Dされたファイルを扱う。スロットには入れず、ライブラリへの
 * 登録だけを行う(ライブラリを開いている=どこに入れるかはこれから選ぶ、という文脈のため)。
 * 複数枚アーカイブの場合は openLibraryModal と同じ「グループを展開・強調」の仕組みをそのまま使う。
 */
async function handleDroppedFileForLibrary(file: File): Promise<void> {
  if (!isArchive(file.name)) {
    await saveDiskFileToLibrary(file);
    showToast(t('statusLibraryAdded', { count: 1 }));
    void refreshLibraryList();
    return;
  }
  const groupId = `arc:${file.name}:${file.size}`;
  const registered = await registerArchiveToLibrary(file);
  if (registered.length === 0) {
    alert(t('dropNoDiskImage'));
    return;
  }
  showToast(t('statusLibraryAdded', { count: registered.length }));
  if (registered.length > 1) {
    openLibraryModal(groupId); // グループを展開・強調表示(refreshLibraryListも内部で呼ばれる)
  } else {
    void refreshLibraryList();
  }
}

/**
 * 画面(stage)へのD&Dで、ディスクの種別(hdd/fd)から投入先スロットを決める。
 * - HDDイメージ: 常にHDDスロットへ(起動中でロック済みの場合は insertDiskBytes 内の
 *   isSlotLocked チェックが既存のロック時メッセージを出す)。
 * - FDイメージ: FDD1が空ならFDD1へ。FDD1が埋まっていてFDD2が空なら、2ドライブ運用の
 *   利便性を優先してFDD2へ入れる(WebNP2には無い挙動だがドライブ行が2本あるWebX68k独自の配慮)。
 *   両方埋まっている/両方空の場合はFDD1をデフォルトの投入先とする
 *   (ドライブ行へ直接ドロップしたときと同じ「常に決め打ちのスロットへ入る」既定動作に合わせる)。
 */
function resolveStageDropSlot(kind: 'hdd' | 'fd'): SlotId {
  if (kind === 'hdd') return 'hdd';
  if (slots.fdd0 !== null && slots.fdd1 === null) return 'fdd1';
  return 'fdd0';
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

/** 展開状態のグループID。ライブラリダイアログの再描画をまたいで開閉を保つ。 */
const expandedLibraryGroups = new Set<string>();

/**
 * URLパラメータ/D&D等で複数枚入りアーカイブを取り込んだ直後にライブラリを開いたとき、
 * 「これです」と分かるように展開・強調・スクロールするグループID。手動でライブラリを開いたとき(ツールバーの
 * ボタン等)は null のままで従来どおりの見た目になる。
 */
let highlightedLibraryGroupId: string | null = null;

/** ホバー用のtitle文字列。リネーム済みなら表示名と元ファイル名を併記し、未リネームなら表示名のみ。 */
function libraryNameTitle(displayName: string, name: string): string {
  return displayName !== name ? `${displayName} (${name})` : displayName;
}

/**
 * 表示名を先頭側(head)/末尾側(tail)の2要素に分けてcontainerへ追加する(中間省略)。
 * X68000のディスクイメージは「共通の長いタイトル + 末尾に (Disk n of m)」という命名が多く、
 * 通常のCSS末尾ellipsisだと同一アーカイブ内の複数枚がすべて同じ表示になってしまう。
 * head側はCSSでellipsis省略、tail側は固定文字数をそのまま表示することで、
 * 作品名(先頭)と何枚目か(末尾)を両方視認できるようにする。
 */
function appendSplitName(container: HTMLElement, name: string, headClass: string, tailClass: string): void {
  const { head, tail } = splitDisplayName(name);
  const headEl = document.createElement('span');
  headEl.className = headClass;
  headEl.textContent = head;
  container.append(headEl);
  if (tail) {
    const tailEl = document.createElement('span');
    tailEl.className = tailClass;
    tailEl.textContent = tail;
    container.append(tailEl);
  }
}

/** ライブラリ1件分の行(バッジ/名前/サイズ/操作ボタン)を組み立てる。inGroup ならフォルダ配下として一段下げる。 */
function buildLibraryRow(entry: LibraryRowEntry, inGroup = false): HTMLElement {
  const row = document.createElement('div');
  row.className = `library-list-item${inGroup ? ' in-group' : ''}`;

  const kind = classifyDiskKind(entry.name);
  const badge = document.createElement('span');
  badge.className = `library-item-badge ${entry.bundled ? 'bundled' : kind === 'hdd' ? 'hdd' : ''}`.trim();
  badge.textContent = entry.bundled ? t('libraryBadgeBundled') : kind === 'hdd' ? t('libraryBadgeHdd') : t('libraryBadgeFd');
  row.append(badge);

  const nameEl = document.createElement('span');
  nameEl.className = 'library-item-name';
  appendSplitName(nameEl, entry.displayName, 'library-item-name-head', 'library-item-name-tail');
  // 常に完全な名前をツールチップで確認できるようにする(リネーム済みなら元のファイル名も併記)。
  nameEl.title = libraryNameTitle(entry.displayName, entry.name);
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

/** LibraryEntry(api/library.ts のツリー要素)を buildLibraryRow が期待する行データへ変換する。 */
function entryToRow(entry: LibraryEntry): LibraryRowEntry {
  return {
    sourceKey: entry.sourceKey,
    name: entry.name,
    displayName: entry.displayName,
    size: entry.size,
    savedAt: entry.savedAt,
    bundled: false,
  };
}

/** アーカイブ由来グループのフォルダ行(クリックで開閉)と、展開時はその中身の行をまとめて組み立てる。 */
function buildLibraryGroupRow(group: LibraryGroup): HTMLElement {
  const expanded = expandedLibraryGroups.has(group.id);

  const twisty = document.createElement('span');
  twisty.className = 'library-group-twisty';
  twisty.textContent = expanded ? '▼' : '▶';

  const nameEl = document.createElement('span');
  nameEl.className = 'library-group-name';
  nameEl.textContent = group.name;
  nameEl.title = group.name;

  const countEl = document.createElement('span');
  countEl.className = 'library-item-meta';
  countEl.textContent = t('libraryGroupCount', { count: group.entries.length });

  const actions = document.createElement('div');
  actions.className = 'library-item-actions';

  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'library-action-btn';
  renameBtn.textContent = t('libraryActionRename');
  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = prompt(t('libraryRenameGroupPrompt'), group.name);
    if (next === null) return;
    void (async () => {
      await renameDiskGroup(group.id, next);
      await refreshLibraryList();
    })();
  });
  actions.append(renameBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'library-action-btn danger';
  deleteBtn.textContent = t('libraryActionDelete');
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!confirm(t('libraryDeleteGroupConfirm', { name: group.name, count: group.entries.length }))) return;
    void (async () => {
      await deleteDiskGroup(group.id);
      await refreshLibraryList();
    })();
  });
  actions.append(deleteBtn);

  const header = document.createElement('div');
  header.className = 'library-list-group';
  header.setAttribute('role', 'button');
  header.tabIndex = 0;
  header.setAttribute('aria-expanded', String(expanded));
  header.append(twisty, nameEl, countEl, actions);
  const toggle = (): void => {
    if (expandedLibraryGroups.has(group.id)) expandedLibraryGroups.delete(group.id);
    else expandedLibraryGroups.add(group.id);
    void refreshLibraryList();
  };
  header.addEventListener('click', toggle);
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });

  const wrap = document.createElement('div');
  wrap.className = `library-group${group.id === highlightedLibraryGroupId ? ' focused' : ''}`;
  wrap.dataset.groupId = group.id;
  wrap.append(header);
  if (expanded) {
    for (const entry of group.entries) wrap.append(buildLibraryRow(entryToRow(entry), true));
  }
  return wrap;
}

/**
 * ディスクライブラリ一覧を再描画する。先頭に同梱ディスク(固定・削除不可)、続けてグループ(フォルダ)/
 * 単体ディスクが混在したツリー(トップレベルは保存時刻降順、フォルダ内はアーカイブ内の出現順)。
 */
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

  const nodes = buildLibraryNodes(stored, classifyDiskKind);
  for (const node of nodes) {
    libraryList.append(node.kind === 'group' ? buildLibraryGroupRow(node.group) : buildLibraryRow(entryToRow(node.entry)));
  }

  // 注目グループがあれば、一覧が長い場合に備えて画面内へスクロールする(展開/強調自体はbuildLibraryGroupRow側で反映済み)。
  if (highlightedLibraryGroupId) {
    const target = libraryList.querySelector<HTMLElement>(
      `.library-group[data-group-id="${CSS.escape(highlightedLibraryGroupId)}"]`,
    );
    target?.scrollIntoView({ block: 'nearest' });
  }
}

/**
 * ディスクライブラリダイアログを開く。`focusGroupId` を渡すと(URLパラメータ/D&D等の
 * 複数枚アーカイブ取り込み直後の呼び出し)、そのグループを展開・強調・スクロール表示し、
 * 案内文を差し替える。手動でのオープン(ツールバーのボタン等)は引数なしで呼ばれ、従来どおりの見た目になる。
 */
function openLibraryModal(focusGroupId?: string): void {
  libraryBackdrop.classList.remove('hidden');
  highlightedLibraryGroupId = focusGroupId ?? null;
  if (focusGroupId) expandedLibraryGroups.add(focusGroupId);
  libraryDescriptionEl.textContent = focusGroupId ? t('libraryGroupFocusHint') : t('libraryDialogDescription');
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
// 「ライブラリから挿入」はフォルダ(アーカイブ由来グループ)行をクリックすると、
// ライブラリダイアログを開かずにこのメニューのまま中身(サブメニュー)へ切り替わる。

function closeSlotPopupMenu(): void {
  slotPopupMenu.classList.add('hidden');
  slotPopupMenu.textContent = '';
}

/**
 * @param options.splitName ディスク名(displayName)を表示する行のとき true。head/tail に分割し中間省略する。
 * @param options.title 行全体につけるツールチップ(完全な名前を常に見られるようにする)。
 */
function menuRow(
  label: string,
  extra?: string,
  cls = '',
  options?: { splitName?: boolean; title?: string },
): HTMLElement {
  const children: Array<Node | string> = [];
  const labelEl = document.createElement('span');
  labelEl.className = 'library-menu-label';
  if (options?.splitName) {
    appendSplitName(labelEl, label, 'library-menu-label-head', 'library-menu-label-tail');
  } else {
    labelEl.textContent = label;
  }
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
  if (options?.title) row.title = options.title;
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

/** グループ内のディスク一覧(サブメニュー)を描画する。対象スロットの種別(FD/HDD)に合うものだけ表示する。 */
function renderSlotLibrarySubmenu(
  slot: SlotId,
  anchorEl: HTMLButtonElement,
  group: LibraryGroup,
  nodes: LibraryNode[],
): void {
  const wantKind = slot === 'hdd' ? 'hdd' : 'fd';
  slotPopupMenu.textContent = '';
  const back = menuRow(t('libraryMenuBack'), undefined, 'back');
  onActivate(back, () => renderSlotLibraryMenu(slot, anchorEl, nodes));
  slotPopupMenu.append(back);
  const title = document.createElement('div');
  title.className = 'library-menu-title';
  title.textContent = group.name;
  slotPopupMenu.append(title);

  for (const entry of group.entries) {
    if (entry.kind !== wantKind) continue;
    const row = menuRow(entry.displayName, undefined, '', {
      splitName: true,
      title: libraryNameTitle(entry.displayName, entry.name),
    });
    onActivate(row, () => {
      closeSlotPopupMenu();
      void insertFromLibrary(entry.sourceKey, slot);
    });
    slotPopupMenu.append(row);
  }
  positionSlotPopupMenu(anchorEl);
}

/** メニューの第1階層(同梱ディスク + 単体ディスク + グループのフォルダ行)を描画する。 */
function renderSlotLibraryMenu(slot: SlotId, anchorEl: HTMLButtonElement, nodes: LibraryNode[]): void {
  const wantKind = slot === 'hdd' ? 'hdd' : 'fd';
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
      void insertFromLibrary(BUNDLED_DISK_SOURCE_KEY, slot);
    });
    slotPopupMenu.append(row);
    shown++;
  }

  for (const node of nodes) {
    if (node.kind === 'group') {
      // 対象スロットの種別(FD/HDD)を1枚も含まないグループは挿入先が無いので出さない。
      const count = node.group.entries.filter((e) => e.kind === wantKind).length;
      if (count === 0) continue;
      const row = menuRow(node.group.name, t('libraryGroupCount', { count }), 'group', {
        title: node.group.name,
      });
      onActivate(row, () => renderSlotLibrarySubmenu(slot, anchorEl, node.group, nodes));
      slotPopupMenu.append(row);
      shown++;
    } else {
      if (node.entry.kind !== wantKind) continue;
      const row = menuRow(node.entry.displayName, undefined, '', {
        splitName: true,
        title: libraryNameTitle(node.entry.displayName, node.entry.name),
      });
      onActivate(row, () => {
        closeSlotPopupMenu();
        void insertFromLibrary(node.entry.sourceKey, slot);
      });
      slotPopupMenu.append(row);
      shown++;
    }
  }
  if (shown === 0) {
    const empty = document.createElement('div');
    empty.className = 'library-menu-empty';
    empty.textContent = t('libraryMenuEmpty');
    slotPopupMenu.append(empty);
  }
  positionSlotPopupMenu(anchorEl);
}

/** 「ライブラリから挿入」ポップアップ: 対象スロットの種別(FD/HDD)に合うライブラリ内容だけを一覧表示する。 */
async function openSlotLibraryMenu(slot: SlotId, anchorEl: HTMLButtonElement): Promise<void> {
  const stored = await listDisks();
  const nodes = buildLibraryNodes(stored, classifyDiskKind);
  renderSlotLibraryMenu(slot, anchorEl, nodes);
}

// X68000 標準フォーマット(2HD 1232KB=XDF標準 / 2HD 1440KB / 2DD 640KB / 2DD 720KB)。
// 中身はFAT12フォーマット済み(createFormattedFd())で生成する。
// イメージ長は createFormattedFd() 側のジオメトリで決まる(disk-store.ts の FD_SIZE_* と一致)。
const BLANK_FORMATS: Array<{ id: BlankFdFormatId; labelKey: 'blankFormat2hd1232' | 'blankFormat2hd1440' | 'blankFormat2dd640' | 'blankFormat2dd720' }> = [
  { id: '2hd1232', labelKey: 'blankFormat2hd1232' },
  { id: '2hd1440', labelKey: 'blankFormat2hd1440' },
  { id: '2dd640', labelKey: 'blankFormat2dd640' },
  { id: '2dd720', labelKey: 'blankFormat2dd720' },
];

/** 既存のライブラリ登録名と重複しないブランクディスク名を作る(WebNP2の createBlankFd の命名規則を踏襲)。 */
function uniqueBlankName(baseName: string, existingNames: Set<string>, ext = '.xdf'): string {
  let name = `${baseName}${ext}`;
  for (let i = 2; existingNames.has(name); i++) {
    name = `${baseName}${i}${ext}`;
  }
  return name;
}

/** FAT12フォーマット済みのブランクディスクを生成し、指定スロットへ挿入してライブラリにも登録する。 */
async function handleCreateBlank(slot: SlotId, formatId: BlankFdFormatId): Promise<void> {
  const stored = await listDisks();
  const existingNames = new Set(stored.map((d) => d.name));
  const name = uniqueBlankName(`blank_${formatId}`, existingNames);
  const data = createFormattedFd(formatId);
  const sourceKey = fileKeyFor(name, data.length);
  await saveDisk({ sourceKey, name, bytes: data, savedAt: Date.now() });
  await insertDiskBytes(slot, name, data, undefined, sourceKey);
  if (!libraryBackdrop.classList.contains('hidden')) void refreshLibraryList();
}

/**
 * FAT16フォーマット済みのブランクHDD(40MB)を生成し、HDDスロットへセットしてライブラリにも登録する。
 * FDと違いフォーマットは単一(createFormattedHdd()固定)なのでメニューは出さず即作成する(起動前のみ)。
 * IPLの実体を持たないためHDD単体では起動できず、FDDからHuman68kを起動してデータドライブとして
 * 使う想定(WebNP2のcreateFormattedHdd()と同じ案内をトーストで出す)。
 */
async function handleCreateBlankHdd(): Promise<void> {
  if (isSlotLocked('hdd')) return;
  const stored = await listDisks();
  const existingNames = new Set(stored.map((d) => d.name));
  const name = uniqueBlankName('blank_hdd', existingNames, '.hdf');
  const data = createFormattedHdd();
  const sourceKey = fileKeyFor(name, data.length);
  await saveDisk({ sourceKey, name, bytes: data, savedAt: Date.now() });
  await insertDiskBytes('hdd', name, data, undefined, sourceKey);
  if (!libraryBackdrop.classList.contains('hidden')) void refreshLibraryList();
  showToast(t('statusHddBlankCreated', { name }));
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
      void handleCreateBlank(slot, fmt.id);
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
  // 起動中でFSへ書き込み済みなら、ゲスト側の書き込みを反映した最新バイト列を読み直す
  // (FDD はコアのメモリ上にあるので readLiveSlotImage() が Eject 経由で吸い出す)。
  let bytes: Uint8Array = pending.data;
  try {
    bytes = readLiveSlotImage(slot) ?? pending.data;
  } catch (err) {
    console.error('FS からのディスク読み出しに失敗しました。挿入時点のバイト列を使用します。', err);
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
  // X68000 は画面モード変更で実行中に canvas の実解像度(width/height)が変わる。
  // ウィンドウ表示のリスケールは実解像度基準で倍率を決めるため、変わった直後に再計算させる。
  host.onResolutionChanged = () => rescale();
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
    if (file) void handleDroppedOrPickedFile(slot, file);
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
    // HDDはフォーマットが単一(FAT16固定)なのでメニューを出さず即作成する。FDは従来通り選択メニュー。
    if (slot === 'hdd') void handleCreateBlankHdd();
    else openSlotBlankMenu(slot, els.blankBtn!);
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
    if (file) void handleDroppedOrPickedFile(slot, file);
  });
}

// 画面(stage、canvasを含む領域)へのD&D配線。WebNP2 の stage D&D(dragenterカウンタ方式)を移植し、
// 投入先の決定だけ resolveStageDropSlot 経由で WebX68k のスロット構成(FDD1/FDD2/HDD)に合わせる。
// 起動前・起動中どちらでも受け付ける(insertDiskBytes/hotSwapFdd が両方を扱えるため)。
{
  let stageDropDepth = 0;
  stageEl.addEventListener('dragover', (e) => e.preventDefault());
  stageEl.addEventListener('dragenter', (e) => {
    e.preventDefault();
    stageDropDepth++;
    stageEl.classList.add('dropzone-active');
  });
  stageEl.addEventListener('dragleave', () => {
    stageDropDepth = Math.max(0, stageDropDepth - 1);
    if (stageDropDepth === 0) stageEl.classList.remove('dropzone-active');
  });
  stageEl.addEventListener('drop', (e) => {
    e.preventDefault();
    stageDropDepth = 0;
    stageEl.classList.remove('dropzone-active');
    const file = e.dataTransfer?.files?.[0];
    if (file) void handleDroppedOrPickedFile(resolveStageDropSlot, file);
  });
}

// ディスクライブラリのダイアログへのD&D配線。開いているライブラリへ放り込んで登録するだけの用途
// (スロットには入れない)。バックドロップ全体ではなくダイアログ本体(.rom-modal)だけを受け口にする。
{
  const libraryDialogEl = libraryBackdrop.querySelector('.rom-modal') as HTMLDivElement;
  let libraryDropDepth = 0;
  libraryDialogEl.addEventListener('dragover', (e) => e.preventDefault());
  libraryDialogEl.addEventListener('dragenter', (e) => {
    e.preventDefault();
    libraryDropDepth++;
    libraryDialogEl.classList.add('dropzone-active');
  });
  libraryDialogEl.addEventListener('dragleave', () => {
    libraryDropDepth = Math.max(0, libraryDropDepth - 1);
    if (libraryDropDepth === 0) libraryDialogEl.classList.remove('dropzone-active');
  });
  libraryDialogEl.addEventListener('drop', (e) => {
    e.preventDefault();
    libraryDropDepth = 0;
    libraryDialogEl.classList.remove('dropzone-active');
    const file = e.dataTransfer?.files?.[0];
    if (file) void handleDroppedFileForLibrary(file);
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
  updateOverlayBootLabel();
  btnBootSystem.textContent = t('overlayBootSystem');

  btnReset.title = t('toolbarReset');
  btnReset.setAttribute('aria-label', t('toolbarReset'));
  btnScreenshot.title = t('toolbarScreenshot');
  btnScreenshot.setAttribute('aria-label', t('toolbarScreenshot'));
  btnMouseCapture.setAttribute('aria-label', t('toolbarMouseCapture'));
  btnMouseResync.setAttribute('aria-label', t('toolbarMouseResync'));
  updateMouseControls();
  updateFullscreenControl();
  btnVirtualKeyboard.title = virtualKeyboard.isVisible() ? t('toolbarVirtualKeyboardHide') : t('toolbarVirtualKeyboard');
  btnVirtualKeyboard.setAttribute('aria-label', btnVirtualKeyboard.title);
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
    els.blankBtn?.setAttribute('aria-label', `${drive} ${slot === 'hdd' ? t('hddCreateBlank') : t('slotCreateBlank')}`);
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
  libraryDescriptionEl.textContent = highlightedLibraryGroupId ? t('libraryGroupFocusHint') : t('libraryDialogDescription');
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
const physicalPressed = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (document.activeElement !== canvas || !host) return;
  const code = codeToRetrok(e.code);
  if (code === RETROK.UNKNOWN) return;
  const firstPress = !physicalPressed.has(e.code);
  physicalPressed.add(e.code);
  sharedKeyInput.press(`physical:${e.code}`, code);
  if (firstPress && code === RETROK.BROWSER_REFRESH) virtualKeyboard.togglePhysicalKanaLock();
  e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  if (!physicalPressed.delete(e.code)) return;
  const code = codeToRetrok(e.code);
  if (code === RETROK.UNKNOWN) return;
  sharedKeyInput.release(`physical:${e.code}`, code);
  e.preventDefault();
});
window.addEventListener('blur', () => physicalPressed.clear());
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

/**
 * フルスクリーン化の対象は canvas ではなく .stage(黒背景+canvas を中央寄せする箱)。
 * 理由は style.css 側の .stage:fullscreen 系ルールのコメントを参照。
 * アスペクト比の維持自体は CSS (:fullscreen 時の #screen の object-fit:contain) に
 * 任せており、ここでは要素の全画面化/解除のトグルだけを行う。
 */
function isStageFullscreen(): boolean {
  return document.fullscreenElement === stageEl || (document as any).webkitFullscreenElement === stageEl;
}

/**
 * ネイティブの Fullscreen API が使えるか。
 *
 * iPhone の WebKit は <video> 以外の全画面表示に対応しておらず、
 * requestFullscreen も webkitRequestFullscreen も生えていない
 * (iPad は webkit 版を持つ)。iOS版 Chrome も中身は WebKit なので同じ。
 * 呼んでも例外すら出ずに何も起きないため、事前に判定して代替(疑似フルスクリーン)へ倒す。
 */
function nativeFullscreenSupported(el: HTMLElement): boolean {
  const withWebkit = el as HTMLElement & { webkitRequestFullscreen?: () => void };
  const doc = document as Document & { webkitFullscreenEnabled?: boolean };
  const hasMethod =
    typeof el.requestFullscreen === 'function' || typeof withWebkit.webkitRequestFullscreen === 'function';
  const enabled = document.fullscreenEnabled ?? doc.webkitFullscreenEnabled ?? false;
  return hasMethod && enabled;
}

/** 現在ページ側のクロームを畳んで疑似フルスクリーン中かどうか。 */
function isPseudoFullscreen(): boolean {
  return document.body.classList.contains('pseudo-fullscreen');
}

function setFullscreen(makeFullscreen: boolean): void {
  if (makeFullscreen) {
    if (isStageFullscreen()) return;
    const req =
      stageEl.requestFullscreen?.bind(stageEl) ??
      (stageEl as any).webkitRequestFullscreen?.bind(stageEl);
    void Promise.resolve(req?.()).catch(() => {
      // 一部環境(iOS Safari 等)は canvas 以外の任意要素の requestFullscreen に対応していない。
      // フルスクリーン非対応環境向けの代替UIは用意していないため、ここでは失敗を静かに無視する。
    });
  } else if (isStageFullscreen()) {
    const exit = document.exitFullscreen?.bind(document) ?? (document as any).webkitExitFullscreen?.bind(document);
    void Promise.resolve(exit?.());
  }
}

/** フルスクリーンボタンの見た目(トグル状態)を実際の全画面状態に追従させる。マウスキャプチャボタンと同じ流儀。 */
function updateFullscreenControl(): void {
  const nativeFs = isStageFullscreen();
  const pseudoFs = isPseudoFullscreen();
  btnFullscreen.classList.toggle('active', nativeFs || pseudoFs);
  // 疑似フルスクリーンは Esc では抜けられない(nativeFullscreenSupported() の
  // コメント/click ハンドラのコメント参照: Esc は canvas 経由で X68000 の ESC
  // キーとして送られるため、ページ側で横取りするとゲストソフトと競合する)。
  // ネイティブと同じ "(Esc)" 付きラベルを出すと嘘になるので、疑似フルスクリーン
  // 専用のラベルを別に用意して3分岐にする。
  btnFullscreen.title = nativeFs
    ? t('toolbarFullscreenExit')
    : pseudoFs
      ? t('toolbarFullscreenExitPseudo')
      : t('toolbarFullscreen');
  btnFullscreen.setAttribute('aria-label', btnFullscreen.title);
  btnFullscreen.setAttribute('aria-pressed', nativeFs || pseudoFs ? 'true' : 'false');
}

btnFullscreen.addEventListener('click', () => {
  if (nativeFullscreenSupported(stageEl)) {
    setFullscreen(!isStageFullscreen());
    return;
  }
  // iPhone の WebKit は <video> 以外の Fullscreen API を持たないため、ネイティブ版は
  // 無反応になる。ページ側のクロームを畳んで画面を最大化する疑似フルスクリーンで
  // 代替する(解除操作のため .toolbar は残す)。
  document.body.classList.toggle('pseudo-fullscreen');
  updateFullscreenControl();
  rescale();
});
document.addEventListener('fullscreenchange', updateFullscreenControl);
document.addEventListener('webkitfullscreenchange', updateFullscreenControl);

/*
 * ==== ウィンドウ表示時のリスケール ====
 * style.css の #screen は width/height:auto + max-width/max-height なので、canvas の固有
 * サイズ(コアの実解像度)より狭くする方向にしか効かず、ウィンドウが大きいときに画面が
 * 等倍より拡大されない(auto は img/canvas のような置換要素でも“縮小”専用で、拡大には
 * object-fit 系が要る。フルスクリーンだけ object-fit:contain で拡大できているのはそのため)。
 * ここでは移植元 WebNP2 (src/ui/player.ts の rescale()) と同じく、実際に存在するヘッダー/
 * コンソールバー/仮想キーボードパネルの高さを実測して JS 側で倍率を決め、canvas に
 * インラインの width/height(px)を直接指定する。
 */

// ユーザーの明示的な指定(WebNP2 の見た目に揃える)。整数倍スケールはこれを超えて拡大しない。
const MAX_SCALE = 2;
// 実解像度(canvas.width/height)がまだ0(起動前・BIOS未設定時など)の場合のフォールバック。
// X68000起動直後の既定解像度(768x512, テキストV-RAM相当)を使う。
const FALLBACK_NATIVE_WIDTH = 768;
const FALLBACK_NATIVE_HEIGHT = 512;

/**
 * canvas の表示倍率(等倍〜整数倍、収まらない場合は端数の縮小)を実測して決める。
 * フルスクリーン中は CSS 側(.stage:fullscreen #screen の object-fit:contain、
 * style.css の該当コメント参照)に表示サイズを任せているため、ここでインラインの
 * width/height を触ると「スタイルシートよりインラインが強い」性質でフルスクリーンの
 * CSS ルールが効かなくなってしまう。フルスクリーン中は何もしない
 * (fullscreenchange 側で入る/抜けるタイミングにインラインスタイルの付け外しをしている)。
 */
/**
 * getComputedStyle() から取り出した長さ値を安全に数値化する。
 * 外部スタイルシートの読み込みが完了する前(下記 rescale() のコメント参照)は
 * getComputedStyle() が空文字を返すことがあり、parseFloat("") は NaN になる。
 * NaN はそのまま四則演算に伝播して最終的に canvas.style.width = "NaNpx" のような
 * 無効値の代入(ブラウザに黙って無視される)を引き起こすため、ここで 0 に丸めておく。
 */
function parseLengthOrZero(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function rescale(): void {
  if (isStageFullscreen()) return;

  const nativeWidth = canvas.width || FALLBACK_NATIVE_WIDTH;
  const nativeHeight = canvas.height || FALLBACK_NATIVE_HEIGHT;

  const mainStyle = getComputedStyle(mainEl);
  const mainPaddingH = parseLengthOrZero(mainStyle.paddingLeft) + parseLengthOrZero(mainStyle.paddingRight);
  const mainPaddingV = parseLengthOrZero(mainStyle.paddingTop) + parseLengthOrZero(mainStyle.paddingBottom);
  const cardStyle = getComputedStyle(consoleCardEl);
  const cardGap = parseLengthOrZero(cardStyle.rowGap || cardStyle.gap);

  const availWidth = Math.max(1, window.innerWidth - mainPaddingH);

  const kbdVisible = !virtualKeyboardPanel.classList.contains('hidden');
  // .console-card の子要素は stage / virtual-keyboard(表示時のみ) / console-footer の順。
  // gap は「表示されている子要素の間」の数だけ効く。
  const visibleCardChildren = 2 + (kbdVisible ? 1 : 0);
  const gapsInCard = Math.max(0, visibleCardChildren - 1) * cardGap;

  const reservedHeight =
    (pageHeaderEl?.getBoundingClientRect().height ?? 0) +
    consoleFooterEl.getBoundingClientRect().height +
    (kbdVisible ? virtualKeyboardPanel.getBoundingClientRect().height : 0) +
    mainPaddingV +
    gapsInCard;

  // 実測誤差(サブピクセル丸め・スクロールバー分など)の余白として少し余裕を持たせる。
  const availHeight = Math.max(1, window.innerHeight - reservedHeight - 4);

  const fit = Math.min(availWidth / nativeWidth, availHeight / nativeHeight);
  // 実機検証の結果、1倍未満への縮小を禁止すると狭い画面(スマホ等)で画面下のツールバー/
  // ドライブ行がビューポート外へ押し出されて操作できなくなることが判明したため、
  // 等倍未満への縮小を復活させた。fit は幅・高さ両方から求めた最小値であり、
  // 高さでも縮む(=UIがはみ出さない)のが今回の狙いそのものなので、幅だけを基準にする
  // WebNP2 方式は採用しない。
  //
  // WebNP2 の rescale() コメントには「高さ由来で縮めると、カード幅縮小→ツールバー折返しで
  // 周辺高さ増→さらに縮小…の収縮ループに陥る」という注意書きがあるが、これは
  // ResizeObserver 等でカードのサイズ変化を監視して rescale() を再帰的に呼び直す実装
  // (WebNP2側)特有の懸念であり、WebX68k の rescale() は resize 等のイベント発火のたびに
  // 1パスだけ計算して終わる(自分自身の呼び直しをトリガーする仕組みを持たない)ため、
  // この収縮ループは原理的に起こらない。よってここでは単純に幅・高さ両方の fit を使う。
  // 疑似フルスクリーン中は整数倍への丸めと MAX_SCALE の上限を外し、fit をそのまま使って
  // 画面いっぱいに拡大する(下限 0.3 は維持)。ネイティブのフルスクリーンは
  // .stage:fullscreen #screen の object-fit:contain で整数倍に丸めず連続的に最大化して
  // いるため、その代替である疑似フルスクリーンも同じ見え方に揃えるのが狙い。
  const scale = isPseudoFullscreen()
    ? Math.max(0.3, fit)
    : fit >= 1
      ? Math.min(MAX_SCALE, Math.floor(fit))
      : Math.max(0.3, Math.min(1, fit));

  const w = Math.round(nativeWidth * scale);
  const h = Math.round(nativeHeight * scale);
  // 上流の getComputedStyle() 由来の値が(NaN ガードをすり抜けるような想定外の経路で)
  // 有限値でなかった場合、"NaNpx" のような無効値をインラインへ書き込むとブラウザはそれを
  // 黙って無視する(=canvas.style.width が未設定のまま残り続ける)。無効な計算結果を
  // そのまま突っ込むより、ここで諦めて CSS 側のフォールバック(width/height:auto)に
  // 任せたほうが安全なので、書き換えずに抜ける。
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
}

// visualViewport の resize は購読しない: ピンチズーム操作でも発火するため、ここで再フィット
// すると自前のリサイズがピンチ操作を引き戻してしまう(既知の罠。WebNP2でも同じ理由で避けている)。
window.addEventListener('resize', rescale);
window.addEventListener('orientationchange', rescale);

// フルスクリーンの出入りに合わせてインラインスタイルを付け外しする。
// canvas.style.width/height を設定したままだと、インラインスタイルはスタイルシートの
// セレクタより強いため、フルスクリーン用ルール(.stage:fullscreen #screen の
// width:100%/height:100%/object-fit:contain)が効かなくなりフルスクリーンが壊れる。
document.addEventListener('fullscreenchange', () => {
  if (isStageFullscreen()) {
    canvas.style.width = '';
    canvas.style.height = '';
  } else {
    rescale();
  }
});
document.addEventListener('webkitfullscreenchange', () => {
  if (isStageFullscreen()) {
    canvas.style.width = '';
    canvas.style.height = '';
  } else {
    rescale();
  }
});

// スクリプト読み込み直後(起動前オーバーレイが出ている段階)にも一度リスケールしておく。
// resize 等のイベントが飛んでくるのを待つだけの設計だと、ユーザーが最初に開いたときに
// 見る画面が(ウィンドウが2倍以上収まる広さであっても)常に1倍のまま固まってしまう
// (実測で確認済み: リロード直後は canvas.style.width が未設定=CSSのwidth:autoフォールバック
// のままで、resize を1回発生させて初めて意図した倍率になっていた)。
// rescale() はヘッダー/.console-footer の高さを getBoundingClientRect() で実測するため、
// レイアウトが確定してから呼ぶ必要があり、rAF を1回挟んで呼ぶ。起動前は canvas.width/height
// がまだ0の可能性があるが、その場合は rescale() 内の768x512フォールバックが使われるので
// そのままでよい(bootCore() 直後に実解像度確定後の再計算が別途走る)。
requestAnimationFrame(() => rescale());
// ↑の rAF は「できるだけ早く正しい倍率にする」ためのもので、devサーバーでは十分だった。
// しかし GitHub Pages への本番デプロイ(index.htmlが外部<link>でCSSを読み込む構成)では、
// rAF が発火した時点でまだ外部スタイルシートの適用が終わっておらず、getComputedStyle()が
// パディング等を空文字で返す→NaN計算→無効な"NaNpx"が黙って無視される、という形で
// リロード直後は必ず1倍に固まる不具合が実機で再現した(devサーバーはViteがCSSをJS経由で
// 同期的に注入するため、rAF時点で既に適用済みで再現しなかった)。上のNaNガードで
// 無効値の代入自体は防いだが、それだけだと「安全に何もしない」だけで倍率は直らないため、
// window の load イベント(外部CSS/フォント/画像を含め読み込みが確実に終わったタイミング)
// でもう一度呼び、最終的に正しい倍率へ収束させる保険を入れる。
window.addEventListener('load', () => rescale());

// Esc の挙動について(実キーボードで確認済み):
// フルスクリーン + マウスキャプチャ(Pointer Lock)の両方が有効な状態で Esc を1回押すと、
// **キャプチャとフルスクリーンが同時に解除される**。「1回目でキャプチャだけ解除され、
// フルスクリーンは維持される」という2段階挙動にはならない。
//
// これはブラウザ側の実装によるもので、こちらからは制御できない:
// - Esc による Pointer Lock 解除もフルスクリーン解除も preventDefault で止められない
//   (ブラウザプロセス側の生入力ハンドラで処理されるため、ページの keydown より手前)
// - Esc で抜けた直後にプログラムからフルスクリーンへ復帰させることもできない
//   (requestFullscreen はユーザー操作を必要とし、Esc 由来の離脱直後は特に拒否される)
//
// その結果「マウスを外したいだけなのにフルスクリーンも抜ける」ことになる。フルスクリーンの
// 対象を .stage(画面のみ)にしている以上、全画面中はツールバーが見えず、キャプチャ解除の
// 手段が Esc しかないためこれは避けられない。没入感を優先して画面のみを全画面にする方針を
// 採ったうえで、この挙動は仕様として README / help.html に明記してある。
// (.console-card ごと全画面にしてツールバーを残せば回避できるが、画面が狭くなるため採らない)
//
// 自動検証について: CDP(Input.dispatchKeyEvent)経由の合成 Esc では
// pointerlockchange/fullscreenchange のどちらも発火しない。Chromium の Esc 解除処理が
// ブラウザプロセス側にあり、レンダラへ直接注入する合成キーはそのフックを通らないため。
// 上記の結論は実キーボードでの手動確認によるもの。
// なお、フルスクリーン化・マウスキャプチャそれぞれの開始/解除(ボタン操作)や、
// フルスクリーン中の解像度変更追従・アスペクト比維持は Puppeteer + 実ブラウザで検証済み。

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

/**
 * run=1 自動起動時はブラウザの自動再生制限によりAudioContextがsuspendedのまま無音になる
 * (ページ読み込みだけではユーザー操作とみなされないため)。起動直後にこの状態を検知したら
 * 「音が出ていない」ことが分かる表示を出し、最初のクリック/キー入力で audio.resume() を呼んで
 * 再開を試みる。実際に再開できた(state === 'running')ことを確認してから表示を消す。
 * 通常のボタン起動(ユーザー操作起点)では既に running のことが多く、その場合は何もしない。
 */
function maybeShowAudioMutedBanner(): void {
  const ctx = audio?.context;
  if (!ctx || ctx.state !== 'suspended') return;

  showToast(t('audioMutedBanner'), null);

  const onStateChange = () => {
    if (ctx.state !== 'running') return;
    ctx.removeEventListener('statechange', onStateChange);
    document.removeEventListener('click', tryResume);
    document.removeEventListener('keydown', tryResume);
    hideToast();
  };
  const tryResume = () => audio?.resume();

  ctx.addEventListener('statechange', onStateChange);
  document.addEventListener('click', tryResume);
  document.addEventListener('keydown', tryResume);
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
    // 起動直後(初回描画後)の実解像度で一度リスケールしておく。以降は
    // host.onResolutionChanged(解像度変更時)と各種resize/表示切替のイベントに任せる。
    rescale();

    btnReset.disabled = false;
    btnSaveState.disabled = false;
    btnLoadState.disabled = false;
    btnScreenshot.disabled = false;
    btnFullscreen.disabled = false;
    btnVirtualKeyboard.disabled = false;
    updateMouseControls();
    updateFullscreenControl();
    canvas.focus();
    maybeShowAudioMutedBanner();
  } catch (err) {
    console.error(err);
    alert(t('alertBootFailed', { message: describeError(err) }));
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

/**
 * 実行画面を PNG としてダウンロードさせる(WebNP2 の saveScreenshot() を移植)。
 *
 * X68000 は PC-98 と異なり画面モード(256x256 / 512x512 / 768x512 等)によって実解像度が
 * 変わるが、libretro-host.ts の handleVideoRefresh() は retro_video_refresh のたびに
 * width/height が前回と変われば canvas.width/height をその実解像度へ直接書き換えている
 * (黒帯を残したまま固定サイズのバッファへ描画する、という実装にはなっていない)。
 * つまり canvas は常にコアが今出している実解像度と一致しており、余白の黒帯は生じないため、
 * PC-98版のように描画領域を切り出す必要はなく canvas 全体をそのまま保存すればよい。
 */
function saveScreenshot(): void {
  const src = canvas;
  const tmp = document.createElement('canvas');
  tmp.width = src.width;
  tmp.height = src.height;
  const ctx = tmp.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(src, 0, 0);
  tmp.toBlob((blob) => {
    if (!blob) return;
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace('T', '_')
      .slice(0, 15);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `webx68k_${stamp}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    showToast(t('statusScreenshotSaved'));
  }, 'image/png');
}

btnScreenshot.addEventListener('click', () => {
  saveScreenshot();
});

// --- ステートセーブ / ロード(WebNP2 のツールバー2ボタンに準拠。スロットはクイック1枠のみ) ---
const STATE_SLOT = 'quick';
let toastTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 画面下部に一時通知を出す(既定は2.5秒で自動的に消える)。
 * durationMs に null を渡すと自動で消えない(ダウンロード進捗・音声ミュート表示など、
 * 明示的に消すまで出しっぱなしにしたい用途向け)。
 */
function showToast(message: string, durationMs: number | null = 2500): void {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  if (toastTimer !== undefined) {
    clearTimeout(toastTimer);
    toastTimer = undefined;
  }
  if (durationMs !== null) {
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), durationMs);
  }
}

/** showToast の持続表示を即座に消す(次のトーストで上書きされるより前に、明示的に閉じたいとき用)。 */
function hideToast(): void {
  toastEl.classList.add('hidden');
  if (toastTimer !== undefined) {
    clearTimeout(toastTimer);
    toastTimer = undefined;
  }
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
 * 実行中かつ実際にコアへマウント済みなら、readLiveSlotImage() でゲスト側の書き込みを
 * 反映した最新バイト列を取り出す(FDD はコアのメモリ上にあり、Eject しないとファイルへ
 * 出てこないため。ここを怠るとゲストが作ったファイルが見えず、書き戻しで消える)。
 * persist() は書き換え結果を slots[] へ書き戻し、実行中なら反映する。反映方法は
 * 通常のディスク差し替えと揃えており、FDD はホットマウントで入れ替え(リセット無し)。
 * 起動中の HDD は交換禁止(isSlotLocked)なので、読み出し専用として扱い persist() は拒否する。
 */
function openSlotVolume(slot: SlotId): FmVolumeHandle {
  const pending = slots[slot];
  if (!pending) throw new Error('ディスクが挿入されていません');
  const image = readLiveSlotImage(slot) ?? pending.data;
  const vol = openDiskImage(image, pending.name);
  return {
    vol,
    persist: async () => {
      if (isSlotLocked(slot)) throw new Error(t('slotLockedWhileRunning'));
      slots[slot] = { name: pending.name, data: image, sourceKey: pending.sourceKey };
      // ライブラリ(IndexedDB)由来のイメージなら、そちらにも書き戻す。これが無いと
      // ページ再読み込みでファイル転送による編集が消えてしまう(同梱ディスクは対象外)。
      if (pending.sourceKey && pending.sourceKey !== BUNDLED_DISK_SOURCE_KEY) {
        await saveDisk({ sourceKey: pending.sourceKey, name: pending.name, bytes: image, savedAt: Date.now() });
        if (!libraryBackdrop.classList.contains('hidden')) void refreshLibraryList();
      }
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
  // 同じイメージがスロットにマウント済みなら、スロット側を実体として扱う。
  // ライブラリの複製を書き換えても、マウント中のディスク(コアのメモリ上)には届かず、
  // 「転送したのにゲストから見えない」状態になるため。openSlotVolume の persist が
  // IndexedDB へも書き戻すので、ライブラリ側の内容もずれない。
  const mountedSlot = SLOT_IDS.find((slot) => slots[slot]?.sourceKey === sourceKey);
  if (mountedSlot) return openSlotVolume(mountedSlot);

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

/**
 * URLパラメータ(fd1/fd2/hdd/system/run)に応じてディスクを起動前にセットし、
 * run=1 なら自動起動する(WebNP2 の同名パラメータ方式に準拠)。
 * 1つのディスクの取得に失敗しても他スロットの読み込み・起動は継続する(要件3)。
 * いずれのパラメータも無ければ何もしない(要件7: 既存のオーバーレイ2択のまま)。
 */
async function applyUrlParams(): Promise<void> {
  // system=1: fd1 の明示指定が無いときだけ、同梱システムディスクをFDD1として使う
  // (WebNP2 の freedos=1 相当。fd1 が指定されていればそちらを優先する)。
  const wantsBundledSystem = urlSystem && !urlFd1;
  if (!urlFd1 && !urlFd2 && !urlHdd && !wantsBundledSystem && !urlRun) return;

  if (wantsBundledSystem) {
    const bytes = await fetchBytes(BUNDLED_DISK_URL);
    if (bytes) {
      await insertDiskBytes('fdd0', BUNDLED_DISK_NAME, bytes, t('bundledDiskDisplayName'), BUNDLED_DISK_SOURCE_KEY);
    } else {
      showToast(t('urlSystemFetchFailed'), 8000);
    }
  }

  const jobs: Array<{ slot: SlotId; url: string | undefined; label: string }> = [
    { slot: 'fdd0', url: urlFd1, label: t('fdSlotLabel', { drive: 1 }) },
    { slot: 'fdd1', url: urlFd2, label: t('fdSlotLabel', { drive: 2 }) },
    { slot: 'hdd', url: urlHdd, label: t('hddSlotLabel') },
  ];

  // アーカイブが複数枚のディスクを含んでいた場合は自動起動できない(要件3)ため、
  // その旨のトーストを出したうえでライブラリを開き、run=1 の自動起動は抑止する。
  // 複数のジョブが同時に複数枚アーカイブになることは稀だが、その場合は最初に見つかったグループへ注目させる。
  let unresolvedGroupId: string | undefined;
  for (const job of jobs) {
    if (!job.url) continue;
    const outcome = await resolveUrlSlotContent(job.url, job.label, job.slot);
    if (outcome.kind === 'error') continue; // 失敗/不一致でも他のスロットの読み込みは続行する
    if (outcome.kind === 'group') {
      unresolvedGroupId ??= outcome.groupId;
      continue;
    }
    await insertDiskBytes(job.slot, outcome.name, outcome.bytes, undefined, outcome.sourceKey);
  }

  if (unresolvedGroupId) {
    showToast(t('urlArchiveNeedsSelection'), 8000);
    openLibraryModal(unresolvedGroupId);
    return; // 複数枚のときは run=1 でも自動起動しない(要件3)
  }

  // run=1: オーバーレイの2択を待たずそのまま自動起動する(ディスク未指定でも run=1 だけで起動する)。
  if (urlRun) await startFromOverlay(false);
}

applyDocumentStrings();

void (async () => {
  await restoreBios();
  await applyUrlParams();
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
  screenText: () => host?.readTextScreen() ?? {
    available: false,
    unavailableReason: 'コアが起動していません',
    lines: [],
    diagnostics: {
      columns: 0, rows: 0, nonEmptyCells: 0, matchedCells: 0, unknownCells: 0,
      coverage: 0, nonEmptyPlaneCells: [0, 0, 0, 0],
      kanjiFontAvailable: false,
    },
  },
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
  setKey: (retrok, down) => down
    ? sharedKeyInput.press('bridge:key', retrok)
    : sharedKeyInput.release('bridge:key', retrok),
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
      if (key.shift) sharedKeyInput.press('bridge:type', RETROK.LSHIFT);
      sharedKeyInput.press('bridge:type', key.code);
      await new Promise((r) => setTimeout(r, 90));
      sharedKeyInput.release('bridge:type', key.code);
      if (key.shift) sharedKeyInput.release('bridge:type', RETROK.LSHIFT);
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
