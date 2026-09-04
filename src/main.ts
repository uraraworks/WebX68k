import './style.css';
import { AudioEngine } from './audio';
import { buildCoreOptions } from './core-options';
import {
  computeFrameBudget,
  UNLIMITED_TICK_BUDGET_MS,
  UNLIMITED_PRESENT_INTERVAL_MS,
  UNLIMITED_MAX_DUTY,
} from './frameBudget';
import {
  createFormattedFd,
  createFormattedHdd,
  createFormattedScsi,
  fatDeleteFile,
  fatFreeSpace,
  fatList,
  fatMakeDir,
  fatReadFile,
  fatWriteFile,
  openDiskImage,
  validateScsiBlankSizeMiB,
  SCSI_BLANK_MAX_MIB,
  SCSI_BLANK_MIN_MIB,
  type BlankFdFormatId,
  type FatEntry,
} from './api/fat';
import { loadBiosFile, saveBiosFile } from './bios-store';
import { storageProbe, frameProbe, keybufAttributionProbe } from './storage-probe';
import { computeAttributionBreakdown } from './keybuf-attribution';
import { loadSramFile, saveSramFile } from './sram-store';
import {
  canDeleteScsiImage,
  deleteScsiImage,
  isScsiStorageAvailable,
  listScsiImages,
  putScsiImage,
  readScsiImage,
  type ScsiEntry,
} from './scsi-store';
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
import type { TouchMouseButton } from './touch-mouse';
import { createDiskPersistence } from './disk-persist';
import { Bridge, resolveBridgeUrl, type BridgeHost } from './bridge';
import { RETROK, charToKey, codeToRetrok } from './keyboard';
import { LibretroHost, type AvInfo } from './libretro-host';
import {
  LocalCoreProxy,
  WorkerCoreProxy,
  toOwnedArrayBuffer,
  type InitialDiskInput,
  type LibretroHostProxy,
} from './core-proxy';
import type {
  CoreEvent,
  FrameSnapshot,
  HostGlobalValue,
  KeyBufFrameProbe,
  MouseTrackFrameProbe,
  ScsiDebugFrameProbe,
} from './core-protocol';
import { collectHostGlobals } from './host-globals';
import { sliceKeyBufSnapshot } from './keybuf-probe';
import { computeShouldAcceptGuestKeyInput, MainInputSnapshot } from './worker-input';
import { MouseTracker } from './mouse-track';
import {
  parseAspectModeParam,
  parseCpuSpeedParam,
  parseRamSizeParam,
  parseWorkerModeParam,
} from './url-params';
import {
  hostMatches,
  looksLikeHtml,
  PROXY_CAPABLE_HOSTS,
  rewriteDropboxUrl,
  rewriteGithubBlobUrl,
  shouldPreferProxy,
  urlHostname,
} from './disk-fetch';
import {
  createResampleState,
  DEFAULT_SPEED_STEP,
  parseSpeedSetting,
  resampleSpeed,
  resetResampleState,
  type SpeedSetting,
  type SpeedStep,
} from './speed';
import {
  assignPorts,
  defaultProfileFor,
  GamepadManager,
  knownPadPresetFor,
  loadGamepadStore,
  PAD_TYPE_CORE_OPTION_VALUE,
  type PadType,
  saveGamepadStore,
  XINPUT_PRESET,
  type Binding,
  type GamepadStore,
  type Source,
} from './gamepad';
import { buildGamepadDialog } from './gamepad-ui';
import { buildInputProfileEditor, type InputSourceDef } from './input-profile-ui';
import { buildHostKeyDialog } from './hostkey-ui';
import { createVirtualKeyboard, SharedKeyInput } from './virtual-keyboard';
import { isRepeatableKey, KeyRepeater } from './key-repeat';
import {
  createVirtualPad,
  readSafeAreaInsets,
  resolveLandscapeInsets,
  screenAngle,
  vpadSideBoxesFor,
  type VpadPlacement,
  type VpadSideBoxes,
} from './virtual-pad';
import { createVirtualTrackpad, type VirtualTrackpad } from './virtual-trackpad';
// Sprout68k の共有リンク(#p1=)を開くための復号と .xdf 組み立て。
// **送信側(Sprout68k)とまったく同じ正典**を tools/fetch-sprout-runtime.mjs が持ってくる。
import {
  DEFAULT_DISK, assembleXdf, decodeShareFragment, packUserPayload, tagLabel, unpackUserPayload,
} from './sprout-share.mts';
import {
  activeProfile,
  BUILTIN_CURSOR_SPACE_ID,
  BUILTIN_HOSTKEY_ARROWS_JOY_ID,
  BUILTIN_HOSTKEY_ARROWS_JOY6_ID,
  BUILTIN_HOSTKEY_TENKEY_ID,
  BUILTIN_JOY_2BUTTON_ID,
  BUILTIN_JOY_6BUTTON_ID,
  BUILTIN_TENKEY_ID,
  HOSTKEY_STORAGE_KEY,
  joyBitsForPressedCodes,
  loadInputProfileStore,
  resolveHostKeyBinding,
  saveInputProfileStore,
  setActiveProfile,
  VPAD_BTN_A,
  VPAD_BTN_B,
  VPAD_BTN_C,
  VPAD_BTN_D,
  VPAD_BTN_E,
  VPAD_BTN_F,
  VPAD_BTN_OPT1,
  VPAD_BTN_OPT2,
  VPAD_DPAD_DOWN,
  VPAD_DPAD_LEFT,
  VPAD_DPAD_RIGHT,
  VPAD_DPAD_UP,
  VPAD_STORAGE_KEY,
  type InputProfile,
  type InputProfileStore,
} from './input-profile';
import {
  getState,
  saveState as putState,
  type StateDiskConfig,
} from './state-store';
import { describeError, getLang, langSelfName, setLang, t } from './strings';
import { fitDeviceScale, getTargetSize, resolveAspectMode, type AspectMode } from './aspect';
import { isIOS } from './platform';
import {
  isSerialBaudRateMismatch,
  loadSerialBaudRate,
  normalizeGuestSerialBaudRate,
  saveSerialBaudRate,
  type SerialConnectionState,
  WebSerialTransport,
} from './serial';

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const bootOverlay = document.getElementById('boot-overlay') as HTMLDivElement;
const btnBootPlain = document.getElementById('btn-boot-plain') as HTMLButtonElement;
const btnBootSystem = document.getElementById('btn-boot-system') as HTMLButtonElement;
const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
const btnPause = document.getElementById('btn-pause') as HTMLButtonElement;
const btnPauseIcon = document.getElementById('btn-pause-icon') as unknown as SVGPathElement;
const pauseOverlay = document.getElementById('pause-overlay') as HTMLDivElement;
const btnPauseOverlayResume = document.getElementById('btn-pause-overlay-resume') as HTMLButtonElement;
const pauseOverlayLabelEl = document.getElementById('pause-overlay-label') as HTMLDivElement;
const btnScreenshot = document.getElementById('btn-screenshot') as HTMLButtonElement;
const btnSpeed = document.getElementById('btn-speed') as HTMLButtonElement;
const btnSpeedBadge = document.getElementById('btn-speed-badge') as HTMLSpanElement;
const btnMouseCapture = document.getElementById('btn-mouse-capture') as HTMLButtonElement;
const btnMouseResync = document.getElementById('btn-mouse-resync') as HTMLButtonElement;
const btnFullscreen = document.getElementById('btn-fullscreen') as HTMLButtonElement;
const btnVirtualKeyboard = document.getElementById('btn-virtual-keyboard') as HTMLButtonElement;
const btnAspect = document.getElementById('btn-aspect') as HTMLButtonElement;
const btnToolbarOverflow = document.getElementById('btn-toolbar-overflow') as HTMLButtonElement;
const virtualKeyboardPanel = document.getElementById('virtual-keyboard') as HTMLDivElement;
const virtualPadPanel = document.getElementById('virtual-pad') as HTMLDivElement;
const virtualTrackpadPanel = document.getElementById('virtual-trackpad') as HTMLDivElement;
const inputPanelSwitchEl = document.getElementById('input-panel-switch') as HTMLDivElement;
const btnPanelKeyboard = document.getElementById('btn-panel-keyboard') as HTMLButtonElement;
const btnPanelPad = document.getElementById('btn-panel-pad') as HTMLButtonElement;
const btnPanelTrackpad = document.getElementById('btn-panel-trackpad') as HTMLButtonElement;
const stageEl = document.querySelector('.stage') as HTMLDivElement;
// .stage を囲む領域確保用ラッパ(style.css の .stage-frame 参照)。4:3切替でレイアウトが
// 動かないよう、rescale() が常に「4:3時のサイズ」をここへインラインで指定する。
const stageFrameEl = document.querySelector('.stage-frame') as HTMLDivElement;
// ウィンドウ表示時のリスケール(後述の rescale())で高さ計算に使う周辺要素。
const mainEl = document.querySelector('main') as HTMLElement;
const consoleCardEl = document.querySelector('.console-card') as HTMLElement;
const consoleFooterEl = document.querySelector('.console-footer') as HTMLElement;
const pageHeaderEl = document.querySelector('header.app-header') as HTMLElement | null;
// ページ最下部の著作権表示フッタ。バーチャルパッドをパネルモードにできるかどうかの
// 縦の余り(rescale() 内)を測るときに、これも「画面に既に確保されている領域」として引く。
const pageFooterEl = document.querySelector('footer.app-footer') as HTMLElement | null;
const btnSaveState = document.getElementById('btn-save-state') as HTMLButtonElement;
const btnLoadState = document.getElementById('btn-load-state') as HTMLButtonElement;
const toastEl = document.getElementById('toast') as HTMLDivElement;
const btnGamepad = document.getElementById('btn-gamepad') as HTMLButtonElement;
const gamepadRoot = document.getElementById('gamepad-root') as HTMLDivElement;
const inputProfileRoot = document.getElementById('input-profile-root') as HTMLDivElement;
const btnHostKey = document.getElementById('btn-hostkey') as HTMLButtonElement;
const hostkeyRoot = document.getElementById('hostkey-root') as HTMLDivElement;
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
// SCSI用OPFSイメージ一覧(FDD/HDD用のIndexedDBライブラリとは別系統)。「削除の受け皿」専用で、
// 挿入操作はスロット側の「ライブラリから挿入」ポップアップ(openScsiLibraryMenu)で行う。
const libraryScsiSection = document.getElementById('library-scsi-section') as HTMLDivElement;
const libraryScsiList = document.getElementById('library-scsi-list') as HTMLDivElement;
const libraryScsiTitleEl = document.getElementById('library-scsi-title') as HTMLElement;
const libraryScsiDescriptionEl = document.getElementById('library-scsi-description') as HTMLParagraphElement;
const slotPopupMenu = document.getElementById('slot-popup-menu') as HTMLDivElement;
// ツールバー「…」オーバーフローメニュー専用のカスケードサブメニュー要素。詳細は renderOverflowMenu() 群を参照。
const overflowSubmenu = document.getElementById('overflow-submenu') as HTMLDivElement;
const cfgCpuSpeed = document.getElementById('cfg-cpuspeed') as HTMLSelectElement;
const cfgRamSize = document.getElementById('cfg-ramsize') as HTMLSelectElement;
const cfgSpeed = document.getElementById('cfg-speed') as HTMLSelectElement;
const speedActualEl = document.getElementById('speed-actual') as HTMLSpanElement;
const serialControlsEl = document.getElementById('settings-serial-controls') as HTMLDivElement;
const serialUnsupportedEl = document.getElementById('settings-serial-unsupported') as HTMLParagraphElement;
const serialStatusEl = document.getElementById('settings-serial-status') as HTMLSpanElement;
const serialToggleBtn = document.getElementById('settings-serial-toggle') as HTMLButtonElement;
const cfgSerialBaud = document.getElementById('cfg-serial-baud') as HTMLSelectElement;
const serialBaudNoteEl = document.getElementById('settings-serial-baud-note') as HTMLParagraphElement;

// WebNP2 のドライブ行に合わせた FDD0 / FDD1 / HDD の3スロット構成(実機のFDD呼称
// FDD0/FDD1に合わせ、表示ラベルもコア内部のドライブindex 0/1 と一致させている。
// 要素IDも従来通り fdd0/fdd1 を使う)。
type SlotId = 'fdd0' | 'fdd1' | 'hdd';
const SLOT_IDS: SlotId[] = ['fdd0', 'fdd1', 'hdd'];

/** スロットの表示用ドライブ名(FDD0/FDD1/HDD)。 */
function slotDisplayName(slot: SlotId): string {
  if (slot === 'fdd0') return t('fdSlotLabel', { drive: 0 });
  if (slot === 'fdd1') return t('fdSlotLabel', { drive: 1 });
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

// SCSIスロット(手順4)。FDD/HDDのSlotId系(コアへ渡すFDD/HDDの経路)とは別系統。
// ライブラリ・D&Dは2026-09-04に対応済み。ブランク作成(サイズ指定)も同日対応した。
interface ScsiElements {
  lamp: HTMLElement;
  label: HTMLElement;
  name: HTMLElement;
  insertBtn: HTMLButtonElement;
  input: HTMLInputElement;
  libraryBtn: HTMLButtonElement;
  blankBtn: HTMLButtonElement;
  ejectBtn: HTMLButtonElement;
  downloadBtn: HTMLButtonElement;
}

const scsiElements: ScsiElements = {
  lamp: document.getElementById('lamp-scsi') as HTMLElement,
  label: document.getElementById('label-scsi') as HTMLElement,
  name: document.getElementById('name-scsi') as HTMLElement,
  insertBtn: document.getElementById('btn-insert-scsi') as HTMLButtonElement,
  input: document.getElementById('input-scsi') as HTMLInputElement,
  libraryBtn: document.getElementById('btn-library-scsi') as HTMLButtonElement,
  blankBtn: document.getElementById('btn-blank-scsi') as HTMLButtonElement,
  ejectBtn: document.getElementById('btn-eject-scsi') as HTMLButtonElement,
  downloadBtn: document.getElementById('btn-download-scsi') as HTMLButtonElement,
};

// iOS の Chrome ではファイル選択ダイアログが accept 属性の拡張子を UTI(Uniform Type
// Identifier)へ変換して候補を絞る。.xdf/.hdf/.dup/.hdm/.2hd/.dim のような拡張子は
// UTI が登録されておらず、候補から丸ごと消えて .zip だけが残ってしまう(ホーム画面に
// 追加したWKWebView版では発生しない、Chrome/Safariのタブだけの制約。実機で確認済み)。
// 単体ファイルの選択は読み込み後に拡張子で内容を検証している(docs/DESIGN.md「ディスク
// イメージの形式判定(拡張子 vs 内容ベース)」節)ため、accept はダイアログの絞り込み
// (利便性)にすぎず、外しても無関係なファイルを受け入れてしまう心配はない。
// デスクトップでは候補が絞られたほうが便利なので、iOS のときだけ外す。
if (isIOS()) {
  for (const key of Object.keys(slotElements) as SlotId[]) {
    slotElements[key].input.removeAttribute('accept');
  }
  scsiElements.input.removeAttribute('accept');
  biosIplInput.removeAttribute('accept');
  biosCgInput.removeAttribute('accept');
}

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

// --- SCSI(OPFS常駐、手順4の1枚目)---
// FDD/HDDのslots/mountedPathsとは独立に管理する。現在挿している名前だけを
// localStorage(webx68k.scsi)へ持ち、実体(バイト列)は常にOPFSの scsi/<name> に置く
// (取出はlocalStorageのエントリを消すだけで、OPFS側のファイルは消さない)。
const SCSI_STORAGE_KEY = 'webx68k.scsi';
let scsiName: string | null = localStorage.getItem(SCSI_STORAGE_KEY);
// isScsiStorageAvailable() の判定結果(secure contextでない等でOPFSが使えない環境)。
// 判定前はtrueのまま(=通常表示)にしておき、initScsiUi()の完了後に確定する。
let scsiStorageAvailable = true;

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

// ?cpu=<10|16|25|33|66|100> : 起動時のみ CPU クロックを上書きする(共有URLで推奨環境を再現するため)。
// 意図的に localStorage には保存しない。共有リンクを開いただけで利用者の既定設定が
// 書き換わってしまうと、リンクを踏むたびに意図せず設定が上書きされる事故になるため。
const cpuParamRaw = new URLSearchParams(location.search).get('cpu');
const urlCpuSpeed = parseCpuSpeedParam(cpuParamRaw);
if (cpuParamRaw !== null && urlCpuSpeed === null) {
  console.warn('?cpu= の値が不正です(10/16/25/33/66/100 のいずれか、または "16Mhz" 形式で指定してください)');
} else if (urlCpuSpeed !== null) {
  cpuSpeed = urlCpuSpeed;
}

// ?ram=<1〜12> : 起動時のみ RAM サイズを上書きする(共有URLで推奨環境を再現するため)。
// 意図的に localStorage には保存しない。共有リンクを開いただけで利用者の既定設定が
// 書き換わってしまうと、リンクを踏むたびに意図せず設定が上書きされる事故になるため。
const ramParamRaw = new URLSearchParams(location.search).get('ram');
const urlRamSize = parseRamSizeParam(ramParamRaw);
if (ramParamRaw !== null && urlRamSize === null) {
  console.warn('?ram= の値が不正です(1〜12の整数、または "12MB" 形式で指定してください)');
} else if (urlRamSize !== null) {
  ramSize = urlRamSize;
}

// `?worker=` : コアをWorkerで回すかどうか。**2026-09-03 から既定は Worker 経路**。
// `?worker=0` で従来の LocalCoreProxy(メインスレッド)へ戻せる。
// 既定を入れ替えた理由: 決定2(SCSIのI/OはOPFSの同期ハンドル経由)が
// `FileSystemSyncAccessHandle`=ワーカー専用に依存しており、メインスレッド経路では
// 原理的に成立しないため。docs/STORAGE-SCSI.md「段階移行の順序」参照。
const workerParamRaw = new URLSearchParams(location.search).get('worker');
const parsedWorkerMode = parseWorkerModeParam(workerParamRaw);
if (workerParamRaw !== null && parsedWorkerMode === null) {
  console.warn('?worker= の値が不正です(1/0, true/false, yes/no, on/off のいずれかで指定してください)');
}
const urlWorkerMode = parsedWorkerMode ?? true;

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

// --- エミュレーション速度倍率 ---
// px68k_cpuspeed(上のマシン構成、コアのCPUクロック設定でリセットが要る)とは別物。
// こちらはホスト側のフレーム供給ペースを変えるだけで実行中に即時反映され、あえて
// localStorage には保存しない(共有目的の設定ではなく、常に起動時はOFF(100%)から
// 始まってほしいため)。
//
// 状態の出どころは selectedSpeed(設定モーダルのセレクト値) と speedEnabled(ツールバーの
// 速度ボタンのON/OFF)の2つだけにし、実効倍率(speedMultiplier)は必ずこの2つから導出する。
// 実効値を書き込む場所を複数に増やすと、片方だけ更新し忘れてボタン表示と実際の速度が
// 食い違う事故につながる。
let selectedSpeed: SpeedSetting = DEFAULT_SPEED_STEP;
let speedEnabled = false;
// 実効倍率は「ボタンOFF時の1」を含むため SpeedStep(=SPEED_STEPS の要素型、1を含まない)とは
// 別の型になる。
let speedMultiplier: SpeedStep | 1 = 1;
// selectedSpeed === 'unlimited' かつ speedEnabled のときだけ true。無制限モードは
// speedMultiplier(数値倍率)では表現できない別経路のため、専用フラグで持つ。
let unlimitedActive = false;
// 無制限モードの時間配分に使う実測移動平均(ms)。初期値は実測の中央値から取った目安で、
// 数tickで実測値へ収束する(EMA: x = x*0.8 + measured*0.2)。速度ボタンのOFF/ON・
// resetSpeedState() ではリセットしない(ホスト性能の実測値なので持ち越してよい)。
let unlimitedPresentCostMs = 6.5; // 画面提示1回ぶん(コア1フレーム+RGB565→RGBA変換+putImageData)
let unlimitedFrameCostMs = 3; // コア1フレームぶん(描画スキップ時)
let unlimitedLastPresentAt = 0;
/** 無制限モードで次のtickを走らせてよい最短時刻(performance.now基準)。占有率の上限を守るために使う。 */
let unlimitedNextAllowedAt = 0;
// コアの音声出力(1エミュフレームぶんのサンプル)を速度倍率に合わせて可変レートリサンプルする
// ための状態。チャンクをまたいで位相を持ち越す必要があるためモジュールスコープに置く。
const audioResampleState = createResampleState();

/** selectedSpeed/speedEnabled から実効倍率(speedMultiplier)とunlimitedActiveを再計算する唯一の場所。 */
function recomputeSpeedMultiplier(): void {
  unlimitedActive = speedEnabled && selectedSpeed === 'unlimited';
  speedMultiplier = speedEnabled && !unlimitedActive ? (selectedSpeed as SpeedStep) : 1;
}

/** 速度・状態の切り替わりでフレーム供給と音声リサンプラの持ち越し状態をリセットする。 */
function resetSpeedState(): void {
  accumulator = 0;
  resetResampleState(audioResampleState);
  audio?.flush();
  // unlimitedPresentCostMs/unlimitedFrameCostMsはホスト性能の実測値なので持ち越すが、
  // 提示タイミングだけは切り替え直後に必ず1回提示させるためリセットする。
  unlimitedLastPresentAt = 0;
  unlimitedNextAllowedAt = 0;
}

/** #btn-speed の見た目(押し込み状態・バッジ・ツールチップ)を現在の状態から一括更新する。 */
function updateSpeedButtonUi(): void {
  btnSpeed.classList.toggle('active', speedEnabled);
  btnSpeed.setAttribute('aria-pressed', String(speedEnabled));
  if (speedEnabled && unlimitedActive) {
    btnSpeedBadge.textContent = '∞';
    btnSpeedBadge.hidden = false;
    const label = `${t('toolbarSpeedLabel')} (${t('settingsSpeedUnlimited')})`;
    btnSpeed.title = label;
    btnSpeed.setAttribute('aria-label', label);
  } else if (speedEnabled) {
    const pct = `${Math.round((selectedSpeed as SpeedStep) * 100)}%`;
    btnSpeedBadge.textContent = pct;
    btnSpeedBadge.hidden = false;
    const label = `${t('toolbarSpeedLabel')} (${pct})`;
    btnSpeed.title = label;
    btnSpeed.setAttribute('aria-label', label);
  } else {
    btnSpeedBadge.hidden = true;
    btnSpeed.title = t('toolbarSpeedLabel');
    btnSpeed.setAttribute('aria-label', t('toolbarSpeedLabel'));
  }
}

// 手順9: Worker経路(?worker=1)対応。以前はurlWorkerModeを見ずに常にspeedEnabled/badgeを
// 更新していたため、実際には何も変わらないのにボタンだけ押し込み表示・倍率バッジが出る
// (=UIが「効いている」と嘘をつく)状態だった(コーディネータ指摘、docs/STORAGE-SCSI.md
// 「ワーカー移行 手順9」参照)。実装コストを見積もった結果、既にWorker側にInitPayload.options
// 経由の土台(px68k_no_wait_mode等、上のbootWorkerCore()参照)があったため対応した:
// Worker経路ではworkerCoreProxy.setSpeedMultiplier()で実際に反映しつつ、UI更新は
// 既定経路と共通のupdateSpeedButtonUi()をそのまま使う(表示と実体が一致する)。
function applySpeedChangeToWorker(): void {
  if (urlWorkerMode) workerCoreProxy?.setSpeedMultiplier(speedMultiplier);
}

cfgSpeed.value = String(selectedSpeed);
cfgSpeed.addEventListener('change', () => {
  selectedSpeed = parseSpeedSetting(cfgSpeed.value);
  if (speedEnabled) {
    recomputeSpeedMultiplier();
    if (urlWorkerMode) applySpeedChangeToWorker();
    else resetSpeedState();
  }
  updateSpeedButtonUi();
});

btnSpeed.addEventListener('click', () => {
  speedEnabled = !speedEnabled;
  recomputeSpeedMultiplier();
  if (urlWorkerMode) applySpeedChangeToWorker();
  else resetSpeedState();
  updateSpeedButtonUi();
});

// 実測速度表示(約500msごと): 直近区間で実際に走ったエミュフレーム数 ÷ (fps × 経過秒)。
// 端末性能で頭打ちになったことが見えるように、設定した倍率どおりに出ていない場合に気づける。
const SPEED_MEASURE_INTERVAL_MS = 500;
let speedMeasureFrameCount = 0;
let speedMeasureLastAt = 0;

function updateSpeedActualDisplay(now: number): void {
  if (!running) {
    speedActualEl.textContent = '';
    return;
  }
  if (speedMeasureLastAt === 0) {
    speedMeasureLastAt = now;
    speedMeasureFrameCount = 0;
    return;
  }
  const elapsedMs = now - speedMeasureLastAt;
  if (elapsedMs < SPEED_MEASURE_INTERVAL_MS) return;
  const fps = host?.avInfo?.fps ?? 60;
  const expectedFrames = fps * (elapsedMs / 1000);
  const pct = expectedFrames > 0 ? Math.round((speedMeasureFrameCount / expectedFrames) * 100) : 0;
  speedActualEl.textContent = `${t('settingsSpeedActualPrefix')} ${pct}%`;
  speedMeasureFrameCount = 0;
  speedMeasureLastAt = now;
}

let audio: AudioEngine | null = null;
let host: LibretroHost | null = null;
// docs/STORAGE-SCSI.md「段階移行の順序」手順2: 観測・診断系 query を LocalCoreProxy 経由にする。
// host 自体はまだ同一スレッド実装のままで、駆動ループ・永続化はこの proxy を通さない。
// host.init() が完了した後に initialized:true で構築する(host.init() は既存経路のまま呼ぶため、
// proxy 自身は init を経由しない。詳細は core-proxy.ts の LocalCoreProxy コンストラクタ参照)。
// `?worker=1` のときは WorkerCoreProxy、既定はこれまで通り LocalCoreProxy。呼び出し側
// (screenText/serialize等)は LibretroHostProxy 型でだけ扱うため、どちらが入っていても
// 同じコードで動く(docs/STORAGE-SCSI.md「境界の原則」参照)。
let coreProxy: LibretroHostProxy | null = null;
// `?worker=1` のときだけ非null。setRunning/returnFrameBuffer/setEventHandler は
// LibretroHostProxy(既定経路のLocalCoreProxyと共通の形)には無い、Worker経路固有の
// メソッドのため、型を絞った専用の参照を別途持つ。bootCore()呼び出しのたびに前回のものを
// disposeしてから作り直す。
let workerCoreProxy: WorkerCoreProxy | null = null;
// DEV専用: 駆動ループ内訳プローブ(src/core-worker.ts の workerTickProbe)の制御状態。
// bootWorkerCore() は起動のたびに proxy を作り直すため、「有効にしたい」という意思は
// proxy インスタンスをまたいで持ち回る必要がある(起動前に window.__webx68kDebug 経由で
// 立てても、その時点ではまだ proxy が存在しないため)。次回 bootWorkerCore() が proxy を
// 作った直後にこのフラグを見て、即座に enable メッセージを送る(docs/STORAGE-SCSI.md参照)。
let workerTickProbeWanted = false;
// busy-wait故障注入も同じ理由(proxy作り直し)で意思を持ち回る必要がある。
let workerTickProbeBusyWaitFaultWanted = false;
interface WorkerTickProbeReadResult {
  events: unknown[];
  commandEvents: unknown[];
}
let pendingWorkerTickProbeRead: ((result: WorkerTickProbeReadResult) => void) | null = null;
// DEV専用: KeyBufプローブ(src/core-worker.ts の keyBufProbeEnabled、docs/STORAGE-SCSI.md
// 「KeyBufプローブのWorker対応」参照)。workerTickProbeWantedと同じ理由(proxy作り直し)で
// 意思を持ち回る。workerLastKeyBufProbeは直近のframe eventで受け取ったKeyBuf全体の
// スナップショットで、__webx68kDebug.keybuf()がこれを同期のまま切り出して返す
// (Workerへ往復問い合わせしない。物差しを変えないための決定)。
let workerKeyBufProbeWanted = false;
let workerLastKeyBufProbe: KeyBufFrameProbe | null = null;
// 帰属計測(2026-08-31訂正、2026-08-31再訂正「帰属の定義の誤りと訂正」参照)。
// workerLastKeyBufWriteFrameNo: 直近のframe eventで受け取ったkeyBufWriteFrameNo(KeyBufへ
// 最後に何か書かれたフレーム)。workerLastInputSendFrameNo: sendWorkerInputUpdate()を
// 最後に呼んだ時点でmainが知っていた直近のWorker側frameNo(workerLastFrameNo。構造的に
// 古くなりうる値。「伝送＋陳腐化」の起点にのみ使う)。workerLastInputApplyFrameNo: 直近の
// frame eventで受け取ったinputApplyFrameNo(Workerが実際にInputUpdateを適用した瞬間の、
// Worker自身の単一クロック上のframeNo。「真の注入」の起点)。
// 3つともDEV専用・__webx68kDebug.keybufAttribution()経由でのみ読む。
let workerLastKeyBufWriteFrameNo: number | null = null;
let workerLastInputSendFrameNo: number | null = null;
let workerLastInputApplyFrameNo: number | null = null;
// マウス閉ループ追従(手順6後半)のデバッグスナップショット。keyBufProbeと同じ有効化フラグ
// (workerKeyBufProbeWanted)を共用する(専用のtoggleを増やさない。core-protocol.tsの
// FrameSnapshot.mouseTrackProbeコメント参照)。__webx68kDebug.mouse()がこれを同期のまま
// 切り出して返す。
let workerLastMouseTrackProbe: MouseTrackFrameProbe | null = null;
// 調査用(2026-09-04、docs/STORAGE-SCSI.md参照): SCSI要求カウンタ。
// mouseTrackProbeと同じ相乗り方式(workerKeyBufProbeWanted)。
let workerLastScsiDebugProbe: ScsiDebugFrameProbe | null = null;

const serialTransport = new WebSerialTransport();
function resetSerialBridge(): void {
  serialTransport.discardPendingReceive();
  host?.resetSerialBridge();
}
function syncSerialConnectionToCore(): void {
  if (host?.isInitialized() && !host.hasSerialBridge()) {
    if (serialTransport.state === 'connected') void serialTransport.disconnect();
    return;
  }
  const connected = serialTransport.state === 'connected';
  host?.setSerialConnected(connected);
  host?.setSerialTxWritable(connected && serialTransport.canWrite);
}
serialTransport.onData = (bytes) => {
  // Web Serialの非同期コールバックと同期的なretro_run()は同じJSイベントループ上で直列実行される。
  return host?.serialReceive(bytes) ?? 0;
};
serialTransport.onStateChange = (state) => {
  const connected = state === 'connected';
  syncSerialConnectionToCore();
  if (!connected) resetSerialBridge();
  updateSerialUi();
};
cfgSerialBaud.value = String(loadSerialBaudRate());
let running = false;
let bootStarted = false;

// --- ジョイスティック(ゲームパッド)入力 ---
// マッピングの実体は gamepad.ts の GamepadManager。パッドごとに割当(bindings)とデッドゾーンが
// 異なりうる(non-standard パッドは index の意味がパッド固有なので、他パッドの設定を流用できない)ため、
// GamepadManager は「Gamepad.id ごとに1つ」持つ(managerForPad())。永続化(localStorage)も
// Gamepad.id をキーにしており、挿し替えても両方のプロファイルが残る。
// 「どの Gamepad.index をどのポート(0/1)に割り当てるか」は gamepad.ts の assignPorts() が
// 唯一の情報源(毎回の navigator.getGamepads() の結果と、手動固定(gamepadStore.portPads)だけから
// 決まる純粋関数)。
// gamepadconnected/gamepaddisconnected イベントでは状態を持たない
// (イベントを経ずに navigator.getGamepads() へ現れたパッドを割当から取りこぼすバグを踏んだため。
//  UIの再描画は gamepad-ui.ts 側の requestAnimationFrame ループが担っており、
//  ここでイベント購読して明示的に再描画をトリガする必要は無い)。
const gamepadStore: GamepadStore = loadGamepadStore();
const gamepadManagers = new Map<string, GamepadManager>();

/**
 * そのパッドが現在割り当たっているポートの px68k_joytype(パッド種別)。未割当のパッドは
 * どのポートにも属さないため 'default'(2ボタン)にフォールバックする(gamepad-ui.ts の
 * padTypeForPad() と同じ考え方。GamepadManager単位の判断に使うためmain.ts側にも持つ)。
 */
function padTypeForPad(pad: Gamepad): PadType {
  const port = assignPorts(navigator.getGamepads(), gamepadStore.portPads).get(pad.index);
  return port === 0 || port === 1 ? gamepadStore.joyType[port] : 'default';
}

/** Gamepad.id に対応する GamepadManager を返す(無ければ保存済み/既定プロファイルから作る)。 */
function managerForPad(pad: Gamepad): GamepadManager {
  let mgr = gamepadManagers.get(pad.id);
  if (!mgr) {
    const profile = gamepadStore.pads[pad.id] ?? defaultProfileFor(pad, padTypeForPad(pad));
    if (!gamepadStore.pads[pad.id]) {
      gamepadStore.pads[pad.id] = profile;
      saveGamepadStore(gamepadStore);
    }
    mgr = GamepadManager.fromProfile(profile);
    gamepadManagers.set(pad.id, mgr);
  }
  return mgr;
}

/** そのパッドの現在の GamepadManager 状態を localStorage へ書き戻す(編集操作のたびに呼ぶ)。 */
function persistPad(pad: Gamepad): void {
  gamepadStore.pads[pad.id] = managerForPad(pad).toProfile();
  saveGamepadStore(gamepadStore);
}

/** navigator.getGamepads() を assignPorts() でポート0/1に詰めた Gamepad 配列(未接続ポートは null)を作る。 */
function gamepadsByPort(): [Gamepad | null, Gamepad | null] {
  const all = navigator.getGamepads();
  const ports = assignPorts(all, gamepadStore.portPads);
  const byPort: [Gamepad | null, Gamepad | null] = [null, null];
  for (const pad of all) {
    if (!pad) continue;
    const port = ports.get(pad.index);
    if (port === 0 || port === 1) byPort[port] = pad;
  }
  return byPort;
}

/**
 * port0/1ぶんのRetroPadビットマスクを、各パッド固有のGamepadManagerで計算する。
 * TRG3..TRG8 が正しい RetroPad ID に化けるかは、そのポートの現在のパッド種別
 * (gamepadStore.joyType、px68k_joytype1/2)に依存するため、必ずここで渡す。
 */
function pollBitsByPort(pads: readonly (Gamepad | null)[]): [number, number] {
  const result: [number, number] = [0, 0];
  for (let port = 0; port < 2; port++) {
    const pad = pads[port];
    if (pad) result[port] = managerForPad(pad).bitsForPad(pad, gamepadStore.joyType[port]);
  }
  return result;
}

// --- ゲームパッドの kind:'key' 割当の出力配線 ---
// joy側(px68kのジョイスティックポート)とは別に、パッドのボタン/軸へキーボードキーを割り当てた
// ぶんは SharedKeyInput 経由でゲストへ届ける。source文字列は `gamepad:0`/`gamepad:1` のように
// ポート別にする(sharedKeyInput は宣言がこのブロックより後にあるため、関数はここでは定義だけ
// し、実体の呼び出しは sharedKeyInput 定義後にまとめる)。
// 「今フレーム押されている retrok の集合」を毎フレーム前フレームと差分し、増えた分をpress、
// 減った分をreleaseする(押しっぱなしはpressを連打しない=オートリピートしない。リピートは
// ゲスト側の責務)。
let gamepadKeyState: [Set<number>, Set<number>] = [new Set(), new Set()];

/** ポートport(0/1)の `gamepad:N` ソースから、現在保持している押下をすべて解放する。 */
function releaseGamepadKeys(port: 0 | 1): void {
  sharedKeyInput.releaseSource(`gamepad:${port}`);
  gamepadKeyState[port] = new Set();
}

function releaseAllGamepadKeys(): void {
  releaseGamepadKeys(0);
  releaseGamepadKeys(1);
}

/**
 * そのGamepadが現在ポート0/1のどちらに割り当たっているかを調べ、割り当たっていれば
 * そのポートの `gamepad:N` ソースを解放する(バインディング編集直後の固着防止)。
 * 未接続/未割当のパッドに対しては何もしない。
 */
function releaseGamepadKeysForPad(pad: Gamepad): void {
  const port = assignPorts(navigator.getGamepads(), gamepadStore.portPads).get(pad.index);
  if (port === 0 || port === 1) releaseGamepadKeys(port);
}

/**
 * host.onPoll から毎フレーム呼ぶ。port0/1ぶんの kind:'key' 押下集合を計算し、
 * 前フレームとの差分だけを sharedKeyInput へ press/release する。
 * パッドが切断された(pads[port]がnull)場合は次の集合が空になるため、
 * 保持していたキーは自然に全解放される(切断イベントに頼らない設計と一貫)。
 */
function syncGamepadKeys(pads: readonly (Gamepad | null)[]): void {
  for (let port = 0; port < 2; port++) {
    const pad = pads[port];
    const next = pad ? managerForPad(pad).keysForPad(pad) : new Set<number>();
    const prev = gamepadKeyState[port];
    const source = `gamepad:${port}`;
    for (const retrok of next) {
      if (!prev.has(retrok)) sharedKeyInput.press(source, retrok);
    }
    for (const retrok of prev) {
      if (!next.has(retrok)) sharedKeyInput.release(source, retrok);
    }
    gamepadKeyState[port] = next;
  }
}

// ジョイスティック設定ダイアログ(見える化+割当編集)。
// バインディングの実体(GamepadManager)・永続化は main.ts 側に持ったまま、gamepad-ui.ts へは
// 読み書きの操作だけをコールバックで渡す(gamepad-ui.ts はロジックを持たず表示と仲介に徹する)。
const gamepadDialog = buildGamepadDialog(gamepadRoot, {
  getPort: (gamepadIndex) => assignPorts(navigator.getGamepads(), gamepadStore.portPads).get(gamepadIndex) ?? null,
  resolveBits: (pad, padType) => managerForPad(pad).bitsForPad(pad, padType),
  getAxisState: (pad, axisIndex) => managerForPad(pad).axisState(pad, axisIndex),
  getDeadzone: (pad) => managerForPad(pad).getDeadzone(),
  setDeadzone: (pad, value) => {
    managerForPad(pad).setDeadzone(value);
    persistPad(pad);
  },
  getBindingsForTarget: (pad, target) => managerForPad(pad).bindingsForTarget(target),
  getKeyBindings: (pad) =>
    managerForPad(pad)
      .getAllBindings()
      .filter((e): e is { source: Source; binding: Extract<Binding, { kind: 'key' }> } => e.binding.kind === 'key')
      .map((e) => ({ source: e.source, retrok: e.binding.retrok })),
  addBinding: (pad, source, binding) => {
    managerForPad(pad).addBinding(source, binding);
    persistPad(pad);
    // 割当を追加した瞬間、そのポートが既に(別の割当で)キーを押しっぱなし扱いのままだと
    // 新しい割当と混ざって固着しうるため、編集のたびに一旦解放して次のpollでクリーンに再計算させる。
    releaseGamepadKeysForPad(pad);
  },
  removeBinding: (pad, source, binding) => {
    managerForPad(pad).removeBinding(source, binding);
    persistPad(pad);
    releaseGamepadKeysForPad(pad);
  },
  replaceTargetBinding: (pad, source, target) => {
    managerForPad(pad).replaceTargetBinding(source, target);
    persistPad(pad);
    releaseGamepadKeysForPad(pad);
  },
  // 「既定に戻す」: そのパッドの id/現在の padType に合う既知プリセット(8BitDo M30/Micro等)が
  // あればそれを、無ければ従来どおり mapping==='standard' か否かで XInput標準/全未割当に戻す。
  resetToPreset: (pad) => {
    const known = knownPadPresetFor(pad.id, padTypeForPad(pad));
    const fallback = pad.mapping === 'standard' ? XINPUT_PRESET : [];
    managerForPad(pad).resetToPreset(known ?? fallback);
    persistPad(pad);
    releaseGamepadKeysForPad(pad);
  },
  getPortSelection: () => gamepadStore.portPads,
  setPortSelection: (port, padId) => {
    gamepadStore.portPads[port] = padId;
    saveGamepadStore(gamepadStore);
    // ポート割当が変わると `gamepad:0`/`gamepad:1` とパッドの対応がずれるため、両方解放する。
    releaseAllGamepadKeys();
  },
  getPadType: (port) => gamepadStore.joyType[port],
  // px68k_joytype1/2 は起動時(bootCore())にしか反映されない(コアが
  // RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE を実装しておらず、libretro-host.ts もこの環境コマンドを
  // 未対応にしてあるため、実行中に setCoreOption() を呼んでも次フレームで再読込されない)。
  // ここでは永続化のみ行い、実行中の反映有無は isCoreRunning() を見た gamepad-ui.ts 側が案内する。
  setPadType: (port, padType) => {
    gamepadStore.joyType[port] = padType;
    saveGamepadStore(gamepadStore);
    // バーチャルパッドの送り先は常にポート0(表示上のポート1)。TRG3..TRG8のビット位置が
    // padTypeで変わるため、設定ダイアログでの変更にも追従させる(docs/DESIGN.md参照)。
    if (port === 0) virtualPad.setPadType(padType);
  },
  isCoreRunning: () => running,
});
btnGamepad.addEventListener('click', () => gamepadDialog.open());

// --- 入力の集約(手順6「入力」。docs/STORAGE-SCSI.md「ワーカー移行 手順6」参照) --------------
//
// 物理キーボード・仮想キーボード・ブリッジ(setKey/typeText)・ゲームパッド・バーチャルパッド・
// ホストキー割り当て・マウスのすべてが、既定経路(host = メインスレッドの LibretroHost)と
// Worker経路(?worker=1)の両方で、必ずこの1か所(applyKey/applyKeyMake/applyMouseDelta/
// applyMouseButton/applyJoyState)を通す。呼び出し側で個別に urlWorkerMode 分岐を書かないのは、
// 片方に足し忘れても無症状で通ってしまう事故(「入力源は末端の唯一の窓口へ集約する」の教訓)を
// 避けるため。urlWorkerMode は起動時に固定される定数なので、既定経路(urlWorkerMode===false)
// では常に host 分岐だけが通り、挙動は変わらない。
//
// workerInput: Worker経路でのみ使う、main側が保持する入力スナップショット。実体は
// src/worker-input.ts の MainInputSnapshot(DOM/hostに依存しない純粋な状態機械。
// WorkerInputStateと対になっており、単体テスト(test/worker-input.test.ts)の対象にしてある)。
// frame event契機(未決事項の1つだった「ゲームパッドをどう poll するか」への回答。docs参照)で
// 1回だけ正規化・合成してWorkerへ送る。mouseDelta/keyMakesは送信(take())のたびに
// MainInputSnapshot内部でゼロ/空へ戻る(加算値・追加注入分であり、状態ではないため)。
const workerInput = new MainInputSnapshot();

// 決定9(2026-08-31、コーディネータ指摘): キー押下/解放・keyMakes・マウスボタンのような
// **離散イベント**は、発生した時点で即座に updateInput を送る(sendWorkerInputUpdate()を
// その場で呼ぶ)。従来は frame event 契機(次の frame event が来るまで最大1フレーム
// 送信そのものが遅れる)のみだったため、コアがmakeを書くタイミングそのものが
// 「利用者が実際に受ける入力レイテンシ」として不必要に遅れていた(3fad878の実測で
// KeyBuf中央値が既定経路の約8倍になった一因。docs/STORAGE-SCSI.md「KeyBufプローブの
// Worker対応」節参照)。ゲームパッドのビット合成とマウスの加算deltaは連続的な状態で
// あり、frame event契機のままでよい(「ゲームパッドを何契機でpollするか」への回答
// (frame event契機)は送信タイミング全体を縛るものではない)。
// sendWorkerInputUpdate()は片道メッセージで「最新が勝つ」設計であり、1フレームに
// 複数回送っても加算値(mouseDelta)・追加注入分(keyMakes)はtake()のたびにリセットされる
// ため取りこぼさない(test/worker-input.test.ts参照)。

function applyKey(retrok: number, down: boolean): void {
  if (urlWorkerMode) {
    workerInput.key(retrok, down);
    sendWorkerInputUpdate();
    return;
  }
  // 既定経路の帰属計測(docs/STORAGE-SCSI.md「帰属の定義の誤りと訂正」参照)。DEVかつ
  // keybufAttributionProbe.enabledのときだけ、この送信時点でプローブが知っていた
  // frameNoを「注入の遅れ」の起点として覚える(単純な代入でコストは無視できる)。
  // applyFrameNoも同じ値・同じ場所で記録する: 既定経路は送信と適用(直後のhost?.setKey)が
  // 同一スレッド上の同じ呼び出しの中で起きるため、Worker経路のような陳腐化が原理的に
  // 発生しない(2026-08-31再訂正で追加。Worker経路との式を揃えるための対)。
  if (import.meta.env.DEV && keybufAttributionProbe.enabled) {
    keybufAttributionProbe.inputSendFrameNo = keybufAttributionProbe.frameNo;
    keybufAttributionProbe.applyFrameNo = keybufAttributionProbe.frameNo;
  }
  host?.setKey(retrok, down);
}

/** KeyRepeaterからの、押下状態を変えないmake注入。 */
function applyKeyMake(retrok: number): void {
  if (urlWorkerMode) {
    workerInput.keyMake(retrok);
    sendWorkerInputUpdate();
    return;
  }
  if (import.meta.env.DEV && keybufAttributionProbe.enabled) {
    keybufAttributionProbe.inputSendFrameNo = keybufAttributionProbe.frameNo;
    keybufAttributionProbe.applyFrameNo = keybufAttributionProbe.frameNo;
  }
  host?.sendKeyMake(retrok);
}

function applyMouseDelta(dx: number, dy: number): void {
  if (urlWorkerMode) {
    workerInput.mouseDelta(dx, dy);
    return;
  }
  host?.addMouseDelta(dx, dy);
}

function applyMouseButton(button: 'left' | 'right', down: boolean): void {
  if (urlWorkerMode) {
    workerInput.mouseButton(button, down);
    sendWorkerInputUpdate();
    return;
  }
  host?.setMouseButton(button, down);
}

function applyJoyState(port: 0 | 1, bits: number): void {
  if (urlWorkerMode) {
    workerInput.joyState(port, bits);
    return;
  }
  host?.setJoyState(port, bits);
}

/**
 * workerInput.take() が作った InputUpdate を Worker へ送る(take() 自体が加算値(mouseDelta)・
 * 追加注入分(keyMakes)を送信相当のタイミングでクリアする。決定「加算 mouseDelta」参照)。
 * Worker経路以外(既定経路)では何もしない。
 */
function sendWorkerInputUpdate(): void {
  if (!urlWorkerMode || !workerCoreProxy) return;
  // 帰属計測(2026-08-31訂正): この送信時点でmainが知っていた直近のWorker側frameNoを
  // 覚えておく。__webx68kDebug.keybufAttribution()経由で「注入の遅れ」の起点として使う。
  // 単純な代入でコストは無視できるためDEVガードは付けない(host読み取り等は伴わない)。
  workerLastInputSendFrameNo = workerLastFrameNo;
  workerCoreProxy.sendInput(workerInput.take());
}

/**
 * マウス閉ループ追従(手順6後半)の目標更新をWorkerへ送る。既定経路(!urlWorkerMode)では
 * 何もしない(閉ループそのものがWorker側にしか無いため)。低頻度(mousemove/
 * pointerlockchange契機)の片道メッセージで、main側の mouseTracker(ratioの記録専用。実際の
 * 閉ループ計算はWorker側の別インスタンスが行う)から現在値を読んで渡す。
 */
function sendWorkerMouseTrackUpdate(): void {
  if (!urlWorkerMode || !workerCoreProxy) return;
  workerCoreProxy.sendMouseTrack({
    enabled: isMouseTracking(),
    ratioX: mouseTracker.ratioX,
    ratioY: mouseTracker.ratioY,
  });
}

/**
 * Worker経路専用: blur/visibility(hidden)で入力世代を進め、押下状態をすべてmain側の
 * スナップショットからも落として即送信する(決定「世代付き clear」。Worker側は世代が
 * 上がった更新を適用する前にコア側の状態を先に完全クリアする。src/core-worker.ts参照)。
 * 既定経路では何もしない(既定経路の clear は既存の host?.setJoyState(...)/
 * releaseAllGamepadKeys() のまま変えない)。
 */
function clearWorkerInputGeneration(): void {
  if (!urlWorkerMode || !workerCoreProxy) return;
  workerInput.bumpGeneration();
  sendWorkerInputUpdate();
}

/**
 * 物理キーボードのkeydownを受け付けてよいかを判定する(実体は
 * src/worker-input.ts の computeShouldAcceptGuestKeyInput、純粋ロジックとして単体テスト対象)。
 * 既定経路は従来どおり `host !== null` で判定し、Worker経路(urlWorkerMode)だけ
 * `running` で判定する(host はWorker経路では常にnullのため、host基準のままだと
 * 入力が永久に届かない。2026-08-31、実ブラウザ確認で発覚した欠陥の修正)。
 */
function shouldAcceptGuestKeyInput(): boolean {
  return computeShouldAcceptGuestKeyInput({ urlWorkerMode, running, hostPresent: host !== null });
}

// 押しっぱなし固着の予防(仮想キーボードの releaseAll と同じ思想)。
// フォーカスが外れた/タブが隠れた瞬間の入力は届いても意味がないので、コア側の状態を明示的に0へ戻す。
window.addEventListener('blur', () => {
  host?.setJoyState(0, 0);
  host?.setJoyState(1, 0);
  releaseAllGamepadKeys();
  clearWorkerInputGeneration();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    host?.setJoyState(0, 0);
    host?.setJoyState(1, 0);
    releaseAllGamepadKeys();
    clearWorkerInputGeneration();
  }
});

// 物理・仮想・ブリッジ入力を入力元ごとに保持し、同じキーの片側だけが先に離れても
// コア側の押下状態が消えないよう集約する。
const sharedKeyInput = new SharedKeyInput((retrok, down) => applyKey(retrok, down));
// 物理・仮想キーボードで同じインスタンスを共有し、押下状態を保ったままmakeだけを注入する。
const keyRepeater = new KeyRepeater((retrok) => applyKeyMake(retrok));
const virtualKeyboard = createVirtualKeyboard(
  virtualKeyboardPanel,
  sharedKeyInput,
  (_visible) => {
    // 仮想キーボードの表示/非表示でパネル高が変わり、画面に使える縦幅も変わるため再計算する。
    // このコールバックは virtual-keyboard.ts の refreshLayout() が rAF 内(パネル実測後)で
    // 呼んでくれるので、ここで呼ぶ rescale() も実測済みの高さを見て走る。
    syncInputPanelUi();
    rescale();
  },
  keyRepeater,
);

// --- バーチャルパッド(オンスクリーンパッド)+ 入力パネル(仮想キーボード/パッド)切り替え ---
// docs/DESIGN.md「バーチャルパッド」節・「切り替えUI(案C採用)」参照。
// ツールバーの btn-virtual-keyboard は「入力パネル」トグル(押すと最後に選んだ側が開く/
// 両方閉じる)に役割変更し、どちらを出すかは stage 右上のチップ(⌨/🎮)で切り替える。
const virtualPad = createVirtualPad(virtualPadPanel, sharedKeyInput);

// --- バーチャルパッドの配置(パネルモード/オーバーレイモード/サイドモード)---
// 判定・reparentの詳細は rescale() 内の applyVpadPlacement() を参照。判定順は
// 「panel → sides → overlay」: 縦の余りが十分あればパネル(console-card内の帯として
// 画面を潰さず表示)、無くても左右のデッドスペースが十分あればサイド(左にスティック・
// 右にボタンを振り分け、画面の外側だけを使う)、どちらも無ければ従来通りオーバーレイ
// (stageに重ねる。画面を削らない代わりに指が被る)。
const VPAD_PANEL_MIN_HEIGHT = 160;
const VPAD_PANEL_MAX_HEIGHT = 260;
// 左右の余白がこれ未満ならサイドモードにしない(部品が縮みすぎて押しにくくなるため)。
// 横持ちフルスクリーンの実測(812x375で左右194px)より十分小さい値にしてあり、
// 画面幅の決め打ちにはしていない(実測した余白そのものと比較するだけ)。
const VPAD_SIDES_MIN_WIDTH = 140;
// #virtual-pad の初期DOM位置(index.html: .stage内、#toastの直前)。オーバーレイモードへ
// 戻すときの再挿入先として使う(挿入順そのものは見た目に影響しない。全部品absolute配置のため)。
let vpadPlacement: VpadPlacement = 'overlay';

/**
 * バーチャルパッドの置き場所を確定させる。モードが変わったときだけ reparent し
 * (毎フレームreparentしない)、パネルモードの帯の高さは呼び出し側(rescale())が実測した
 * 余りをそのまま反映する。sides の左右ボックスは placement が変わらない呼び出しでも
 * 毎回 virtualPad.setPlacement() へ渡し直す(ビューポートサイズの変化に追従するため。
 * virtual-pad.ts の setPlacement() 側がボックスだけの更新を安全に処理する)。
 * かつてはネイティブフルスクリーン中に強制的に overlay へ倒していたが、フルスクリーン
 * 対象がページ全体(documentElement)になり、body 直下へ出しても描画対象の中に留まる
 * ようになったため不要になった。通常どおり呼び出し側の判定(余り高さ・左右余白)に従う。
 */
function applyVpadPlacement(next: VpadPlacement, panelHeight: number, sidesBoxes: VpadSideBoxes): void {
  virtualPadPanel.style.height = next === 'panel' ? `${Math.round(panelHeight)}px` : '';
  const changed = next !== vpadPlacement;
  if (changed) vpadPlacement = next;
  virtualPad.setPlacement(next, sidesBoxes);
  if (changed) {
    if (next === 'panel') {
      // #virtual-keyboard の兄弟として、その直前(= .console-footer より前)に置く。
      consoleCardEl.insertBefore(virtualPadPanel, virtualKeyboardPanel);
    } else if (next === 'sides') {
      // 左右のデッドスペースにまたがって重ねるため、.console-card の外(document.body直下)へ
      // 出す。position:fixed;inset:0(style.css の .vpad-sides)でビューポート全体を覆うが、
      // コンテナ自体は pointer-events:none にしてあるのでツールバー等のタップは素通りする
      // (style.css の .virtual-pad.vpad-overlay, .virtual-pad.vpad-sides 参照)。
      document.body.appendChild(virtualPadPanel);
    } else {
      // .stage 内の元の位置(#toast の直前)へ戻す。
      stageEl.insertBefore(virtualPadPanel, toastEl);
    }
  }
  virtualPad.refreshLayout();
}

const INPUT_PANEL_STORAGE_KEY = 'webx68k.inputPanel';
type InputPanelKind = 'keyboard' | 'pad' | 'trackpad';

/** 保存が無い初回だけ、粗いポインタ(タッチ主体の端末)ならパッド優先で始める。 */
function defaultInputPanelKind(): InputPanelKind {
  return window.matchMedia('(pointer: coarse)').matches ? 'pad' : 'keyboard';
}

function loadInputPanelPref(): InputPanelKind {
  const v = localStorage.getItem(INPUT_PANEL_STORAGE_KEY);
  return v === 'keyboard' || v === 'pad' || v === 'trackpad' ? v : defaultInputPanelKind();
}

function saveInputPanelPref(kind: InputPanelKind): void {
  localStorage.setItem(INPUT_PANEL_STORAGE_KEY, kind);
}

let inputPanelPref: InputPanelKind = loadInputPanelPref();

let vpadStore: InputProfileStore = loadInputProfileStore(VPAD_STORAGE_KEY);

/** 組み込みプロファイルは strings.ts 経由の翻訳済みラベルへ差し替えて表示する(label自体は内部識別用)。 */
function vpadProfileLabel(profile: InputProfile): string {
  switch (profile.id) {
    case BUILTIN_JOY_2BUTTON_ID:
      return t('vpadProfileJoy2Button');
    case BUILTIN_CURSOR_SPACE_ID:
      return t('vpadProfileCursorSpace');
    case BUILTIN_TENKEY_ID:
      return t('vpadProfileTenkey');
    case BUILTIN_JOY_6BUTTON_ID:
      return t('vpadProfileJoy6Button');
    default:
      return profile.label;
  }
}

function applyActiveVpadProfile(): void {
  const profile = activeProfile(vpadStore) ?? vpadStore.profiles[0] ?? null;
  if (profile) virtualPad.setProfile(profile);
}

applyActiveVpadProfile();

// バーチャルパッドの割当編集ダイアログ。編集対象の入力元一覧(画面部品ID)はここで組み立てて渡す
// (input-profile-ui.ts 自体はバーチャルパッド固有の知識を持たず、将来ホストキー再割り当てにも
// 使い回せるようにするため)。label は言語切替のたびに applyDocumentStrings() 側で貼り直す
// (配列そのものはここで1回だけ作り、以後は同じオブジェクトの label を書き換える)。
const vpadSourceDefs: InputSourceDef[] = [
  { id: VPAD_DPAD_UP, label: t('inputProfileSourceDpadUp') },
  { id: VPAD_DPAD_DOWN, label: t('inputProfileSourceDpadDown') },
  { id: VPAD_DPAD_LEFT, label: t('inputProfileSourceDpadLeft') },
  { id: VPAD_DPAD_RIGHT, label: t('inputProfileSourceDpadRight') },
  { id: VPAD_BTN_A, label: 'A' },
  { id: VPAD_BTN_B, label: 'B' },
  { id: VPAD_BTN_C, label: 'C' },
  { id: VPAD_BTN_D, label: 'X' },
  { id: VPAD_BTN_E, label: 'Y' },
  { id: VPAD_BTN_F, label: 'Z' },
  { id: VPAD_BTN_OPT1, label: t('inputProfileSourceOpt', { n: 1 }) },
  { id: VPAD_BTN_OPT2, label: t('inputProfileSourceOpt', { n: 2 }) },
];

function refreshVpadSourceLabels(): void {
  vpadSourceDefs[0].label = t('inputProfileSourceDpadUp');
  vpadSourceDefs[1].label = t('inputProfileSourceDpadDown');
  vpadSourceDefs[2].label = t('inputProfileSourceDpadLeft');
  vpadSourceDefs[3].label = t('inputProfileSourceDpadRight');
  vpadSourceDefs[10].label = t('inputProfileSourceOpt', { n: 1 });
  vpadSourceDefs[11].label = t('inputProfileSourceOpt', { n: 2 });
}

const inputProfileEditor = buildInputProfileEditor(
  inputProfileRoot,
  { kind: 'fixed', sources: vpadSourceDefs },
  {
    getStore: () => vpadStore,
    applyStore: (store) => {
      vpadStore = store;
      saveInputProfileStore(VPAD_STORAGE_KEY, vpadStore);
      applyActiveVpadProfile();
    },
    labelFor: (profile) => vpadProfileLabel(profile),
    getPadType: () => gamepadStore.joyType[0],
  },
  (message) => showToast(message),
);

// --- ホストキー(物理キーボード再割り当て)。vpadStore と同じ流儀(input-profile.ts の器を共有)。
let hostKeyStore: InputProfileStore = loadInputProfileStore(HOSTKEY_STORAGE_KEY);

/** 組み込みプロファイルは strings.ts 経由の翻訳済みラベルへ差し替えて表示する(vpadProfileLabel と同じ流儀)。 */
function hostKeyProfileLabel(profile: InputProfile): string {
  switch (profile.id) {
    case BUILTIN_HOSTKEY_ARROWS_JOY_ID:
      return t('hostKeyProfileArrowsJoy');
    case BUILTIN_HOSTKEY_ARROWS_JOY6_ID:
      return t('hostKeyProfileArrowsJoy6');
    case BUILTIN_HOSTKEY_TENKEY_ID:
      return t('hostKeyProfileTenkey');
    default:
      return profile.label;
  }
}

const hostKeyDialog = buildHostKeyDialog(
  hostkeyRoot,
  {
    getStore: () => hostKeyStore,
    applyStore: (store) => {
      hostKeyStore = store;
      saveInputProfileStore(HOSTKEY_STORAGE_KEY, hostKeyStore);
    },
    labelFor: (profile) => hostKeyProfileLabel(profile),
    getPadType: () => gamepadStore.joyType[0],
  },
  (message) => showToast(message),
);
btnHostKey.addEventListener('click', () => hostKeyDialog.open());

/** ツールバーボタンの見た目・チップの表示/非表示をまとめて同期する(3パネル共通の唯一の情報源)。 */
function syncInputPanelUi(): void {
  const anyVisible = virtualKeyboard.isVisible() || virtualPad.isVisible() || virtualTrackpad.isVisible();
  btnVirtualKeyboard.classList.toggle('active', anyVisible);
  btnVirtualKeyboard.setAttribute('aria-pressed', anyVisible ? 'true' : 'false');
  btnVirtualKeyboard.title = anyVisible ? t('toolbarInputPanelHide') : t('toolbarInputPanel');
  btnVirtualKeyboard.setAttribute('aria-label', btnVirtualKeyboard.title);

  inputPanelSwitchEl.classList.toggle('hidden', !anyVisible);
  btnPanelKeyboard.setAttribute('aria-pressed', virtualKeyboard.isVisible() ? 'true' : 'false');
  btnPanelPad.setAttribute('aria-pressed', virtualPad.isVisible() ? 'true' : 'false');
  btnPanelTrackpad.setAttribute('aria-pressed', virtualTrackpad.isVisible() ? 'true' : 'false');
}

/** 3パネルすべてを閉じる。閉じる側は必ず releaseAll() を呼び、押しっぱなしの固着を防ぐ。 */
function closeInputPanels(): void {
  if (virtualKeyboard.isVisible()) {
    virtualKeyboard.setVisible(false);
    virtualKeyboard.releaseAll();
  }
  if (virtualPad.isVisible()) {
    virtualPad.setVisible(false); // 内部で releaseAllInternal() を呼ぶ(virtual-pad.ts 参照)。
  }
  if (virtualTrackpad.isVisible()) {
    virtualTrackpad.setVisible(false); // 内部で reset()+strokeEnd() を呼ぶ(virtual-trackpad.ts 参照)。
  }
  syncInputPanelUi();
  rescale();
}

/** 指定した1種類だけを開く(残り2種は必ず閉じて releaseAll() する)。選んだ種類を既定として保存する。 */
function openInputPanel(kind: InputPanelKind): void {
  if (virtualKeyboard.isVisible() && kind !== 'keyboard') {
    virtualKeyboard.setVisible(false);
    virtualKeyboard.releaseAll();
  }
  if (virtualPad.isVisible() && kind !== 'pad') virtualPad.setVisible(false);
  if (virtualTrackpad.isVisible() && kind !== 'trackpad') virtualTrackpad.setVisible(false);

  if (kind === 'keyboard') virtualKeyboard.setVisible(true);
  else if (kind === 'pad') virtualPad.setVisible(true);
  else virtualTrackpad.setVisible(true);

  inputPanelPref = kind;
  saveInputPanelPref(kind);
  syncInputPanelUi();
  rescale();
}

btnVirtualKeyboard.addEventListener('click', () => {
  if (virtualKeyboard.isVisible() || virtualPad.isVisible() || virtualTrackpad.isVisible()) closeInputPanels();
  else openInputPanel(inputPanelPref);
});
btnPanelKeyboard.addEventListener('click', () => openInputPanel('keyboard'));
// 🎮 は状態で役割が変わる: 他のパネル表示中はパッドへの即切替(ゲーム中に素早く出す用途を
// 優先しメニューは出さない)、バーチャルパッドが既に表示中ならプロファイル選択メニューを開く。
btnPanelPad.addEventListener('click', (e) => {
  if (virtualPad.isVisible()) {
    e.stopPropagation();
    if (!slotPopupMenu.classList.contains('hidden')) {
      closeSlotPopupMenu();
      return;
    }
    renderVpadProfileMenu(btnPanelPad);
  } else {
    openInputPanel('pad');
  }
});
btnPanelTrackpad.addEventListener('click', () => openInputPanel('trackpad'));

// 同梱ROM/ディスク(public/system/)のパス。ユーザーが独自ファイルを設定した場合はそちらを優先する。
// GitHub Pages のプロジェクトページ(https://<user>.github.io/WebX68k/)配下でも解決できるよう、
// ルート絶対パスではなくドキュメント相対で指定すること(絶対パスだと /system/... を見に行き404になる)。
// ?v=<buildId> はキャッシュバスティング用。BUNDLED_DISK_NAME/BUNDLED_DISK_SOURCE_KEY は
// 別定数(このURLをそのまま使っていない)なので、クエリを足してもディスクライブラリの
// 表示名やIndexedDBのキーには混ざらない(fetchBytes() で取得する時にだけ使われる)。
const BUNDLED_IPL_URL = `./system/iplrom.dat?v=${__BUILD_ID__}`;
const BUNDLED_CG_URL = `./system/cgrom.dat?v=${__BUILD_ID__}`;
const BUNDLED_DISK_URL = `./system/human302.xdf?v=${__BUILD_ID__}`;
const BUNDLED_DISK_NAME = 'human302.xdf';
// 同梱ディスクはIndexedDBには保存せず、ディスクライブラリの先頭に固定表示する(削除不可)。
const BUNDLED_DISK_SOURCE_KEY = 'bundled:human302';

// --- URLパラメータ(WebNP2 に準拠。fd1/fd2/hdd でディスクURL指定、run=1で自動起動)。---
// system=1: 同梱システムディスク(human302.xdf)をFDD0として使う(WebNP2の freedos=1 相当)。
// fd1 が同時指定されていれば fd1 を優先する。
const urlParams = new URLSearchParams(location.search);
const urlFd1 = urlParams.get('fd1') ?? undefined;
const urlFd2 = urlParams.get('fd2') ?? undefined;
const urlHdd = urlParams.get('hdd') ?? undefined;
const urlRun = urlParams.get('run') === '1';
const urlSystem = urlParams.get('system') === '1';
// lib=<url>: 複数指定可(ディスクライブラリへ登録するだけの共有リンク用)。
// カンマ区切りにしないのはURL自体にカンマが含まれ得るため。複数指定は getAll で受け取る。
const urlLib = urlParams.getAll('lib').filter((v) => v !== '');
// audioProbe=1: dev限定の音声振幅プローブ(handleAudioBatch内の積算)を有効化する。
// 既定offで、計測スクリプト(scripts/measure-audio.mjs)が明示的に指定したときだけ使う
// (docs/STORAGE-SCSI.md「基準値：音声遅延」の作業0参照。常時onはdev計測全般にコストが
// 乗るため既定を変更した)。
const urlAudioProbe = urlParams.get('audioProbe') === '1';
// debugDisableAutosave=1 / debugForceUrlRefetch=1: dev限定・既定off。
// scripts/verify-disk-persistence.mjs の --fault 用に追加した「ページ側から実際に
// 壊せるフック」(docs/STORAGE-SCSI.md「末端の永続化検証」節参照)。ソースの手編集を
// 要求すると陽性対照が再現できない(実行者が誤解した実績あり)ため、URLパラメータで
// 切り替えられるようにした。既定はoffで、いずれも指定しなければ挙動は変わらない。
// debugDisableAutosave=1: pollAutoSave()/pollWorkerAutoSave()の先頭で即returnする
// (captureDirtyMedia/readDirtyStateの結果を捨てるのと等価)。
// debugForceUrlRefetch=1: resolveUrlToLibrary()の「既にライブラリに保存済みなら
// 再利用する」分岐(plainStored)を無効化し、毎回ネットワークから再取得させる。
// URLパラメータなのでリロードをまたいでも同じ値が効く(JS変数だとリロードで消える)。
const urlDebugDisableAutosave = import.meta.env.DEV && urlParams.get('debugDisableAutosave') === '1';
const urlDebugForceUrlRefetch = import.meta.env.DEV && urlParams.get('debugForceUrlRefetch') === '1';
// debugDisableResetFlush=1 / debugResetFlushNoAwait=1: 上と同じ理由・同じ流儀(dev限定・既定off)。
// scripts/verify-reset-persistence.mjs の --fault 用(docs/STORAGE-SCSI.md「ワーカー移行
// 手順9：異常系の検証」節参照)。restartCore() が持つ「保存→終了→ready」の順序を
// 実際に壊すためのフック。
// debugDisableResetFlush=1: restartCore()内のflushAllSlots()/flushAllSlotsWorker()呼び出し
// 自体を丸ごとスキップする(保存が起きない)。
// debugResetFlushNoAwait=1: flushAllSlotsWorker()の完了を待たずにhost.dispose()/coreProxy=null
// へ進めてしまう(Worker経路限定。既定経路のflushAllSlots()は同一スレッド同期処理のため
// このフラグでは再現できない再現対象外)。
const urlDebugDisableResetFlush = import.meta.env.DEV && urlParams.get('debugDisableResetFlush') === '1';
const urlDebugResetFlushNoAwait = import.meta.env.DEV && urlParams.get('debugResetFlushNoAwait') === '1';

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

// 中継サービスのベースURL(空文字なら中継しない=直接fetchのみ)。ビルド時に環境変数
// VITE_DISK_PROXY から注入される(リポジトリ内の既定は空。詳細は .github/workflows/deploy.yml 参照)。
const DISK_PROXY_BASE = (import.meta.env.VITE_DISK_PROXY ?? '').trim().replace(/\/+$/, '');

// OneDriveの共有リンクは実測で中継しても取得できないことが判明しているため、中継を試さず
// 即座に案内を出すためのホスト一覧。
const ONEDRIVE_HOSTS = ['1drv.ms', 'onedrive.live.com', 'sharepoint.com'];
// PROXY_CAPABLE_HOSTS / urlHostname / hostMatches / looksLikeHtml / shouldPreferProxy は
// ./disk-fetch (単体テスト可能な純粋関数) からimportする。

/** 中継サーバのエラーJSON(`{"error":"host_not_allowed"}` 等)をHTTPステータスとあわせて利用者向け理由文言に変換する。 */
function describeProxyError(status: number, code: string | undefined): string {
  switch (code) {
    case 'bad_url':
      return t('urlProxyReasonBadUrl');
    case 'origin_not_allowed':
      return t('urlProxyReasonOriginNotAllowed');
    case 'host_not_allowed':
      return t('urlProxyReasonHostNotAllowed');
    case 'too_large':
      return t('urlProxyReasonTooLarge');
    case 'rate_limited':
      return t('urlProxyReasonRateLimited');
    case 'upstream_failed':
      return t('urlProxyReasonUpstreamFailed');
    case 'redirect_not_allowed':
      return t('urlProxyReasonRedirectNotAllowed');
    default:
      return t('urlProxyReasonUnknown', { status });
  }
}

/** fetch結果(成功時のResponse)をストリームで読み進め、進捗コールバックを呼びながらバイト列に組み立てる。 */
async function readResponseWithProgress(
  response: Response,
  onProgress: (loaded: number, total: number | null) => void,
): Promise<Uint8Array> {
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

/**
 * 進捗コールバック付きでURLからバイト列を取得する(WebNP2 の fetchWithProgress に準拠)。
 *
 * 通常はまず指定URLへ直接fetchする(GitHub raw のようにCORS対応済みのURLに無駄な中継を挟まない
 * ため)。ただし Google Drive の共有URLは、直接fetchしても生のファイルは絶対に返らず
 * 共有ページのHTMLが(CORSエラーにもならず)200で返ってくることが実測で判明している
 * (2026-08-13 curl実測: Googleが Origin をechoした access-control-allow-origin を付けて返す)。
 * そのため中継(VITE_DISK_PROXY)が設定されている場合、このホスト(`PROXY_ONLY_HOSTS`)は
 * 直接fetchを試さず最初から中継を使う(`shouldPreferProxy`)。
 * Dropboxは中継優先(skipDirect)対象から外れ、`rewriteDropboxUrl` でホスト名を
 * `dl.dropboxusercontent.com` に置換したうえで直接取得を試みる(2026-08-18、FMSoundでの
 * ブラウザ実測の移植。WebX68kのディスクイメージURLでの実リンク実測は未実施)。中継に渡すURLは
 * 利用者が入力した元のURL(`fetchUrl`、置換前)のままにする(中継はサーバ側から取得するため
 * 置換不要で、元の共有URLで実績があるため)。
 *
 * 直接fetchを試した場合でも、取得結果が `looksLikeHtml` でHTMLに見えるときはディスクイメージ
 * ではないとみなし、中継が設定されていればそちらで再取得を試みる(対象外ホストにも効く保険)。
 * 中継経由でもHTMLだった場合、あるいは中継が未設定の場合は専用のエラーで案内する。
 *
 * それ以外の失敗(直接取得の失敗)は、中継が設定されていればそちらで再取得を試みる。
 * ただしOneDriveの共有リンクは実測で中継しても取得できないため中継を試さず即座に専用の
 * 案内を出し、中継が未設定の場合はGoogle Drive/Dropboxのみ「直接取得できません」と案内する
 * (それ以外は従来どおりCORS未対応の可能性を伝える)。
 */
async function fetchBytesWithProgress(
  url: string,
  onProgress: (loaded: number, total: number | null) => void,
): Promise<Uint8Array> {
  const hostname = urlHostname(url);
  if (hostMatches(hostname, ONEDRIVE_HOSTS)) {
    throw new Error(t('urlFetchFailedOneDrive', { url }));
  }

  // raw.githubusercontent.com は CORS 対応なので、中継を通さず直接取得できる。
  // github.com の 302 には ACAO が無いためブラウザの直fetchが失敗する。2026-08-14
  // (Release asset の URL は rewriteGithubBlobUrl 内で除外され書き換わらない)
  const fetchUrl = rewriteGithubBlobUrl(url);

  const hasProxy = DISK_PROXY_BASE !== '';
  const preferProxy = shouldPreferProxy(url, hasProxy);

  let directError: Error | null = null;
  let directWasHtml = false;
  if (!preferProxy) {
    // Dropboxの共有URLはホスト名だけ置換して直接取得を試みる(中継に渡すfetchUrlは
    // 元のまま)。Dropbox以外のホストは何も変わらない。
    const directUrl = rewriteDropboxUrl(fetchUrl);
    try {
      const response = await fetch(directUrl);
      if (!response.ok) {
        throw new Error(t('urlFetchFailedHttp', { url, status: response.status }));
      }
      const contentType = response.headers.get('content-type');
      const bytes = await readResponseWithProgress(response, onProgress);
      if (!looksLikeHtml(bytes, contentType)) {
        return bytes;
      }
      directWasHtml = true;
    } catch (err) {
      directError = err instanceof Error && err.message ? err : new Error(t('urlFetchFailedNetwork', { url }));
    }
  }

  if (!hasProxy) {
    if (directWasHtml) {
      throw new Error(t('urlFetchFailedHtmlPage', { url }));
    }
    if (hostMatches(hostname, PROXY_CAPABLE_HOSTS)) {
      throw new Error(t('urlFetchFailedNeedsProxy', { url }));
    }
    throw directError ?? new Error(t('urlFetchFailedNetwork', { url }));
  }

  const proxyUrl = `${DISK_PROXY_BASE}/fetch?url=${encodeURIComponent(fetchUrl)}`;
  let proxyResponse: Response;
  try {
    proxyResponse = await fetch(proxyUrl);
  } catch {
    if (directWasHtml) throw new Error(t('urlFetchFailedHtmlPage', { url }));
    throw directError ?? new Error(t('urlFetchFailedNetwork', { url }));
  }
  if (!proxyResponse.ok) {
    let code: string | undefined;
    try {
      const body = (await proxyResponse.clone().json()) as { error?: string };
      code = body.error;
    } catch {
      // 中継側がJSONを返さなかった場合はステータスのみで案内する。
    }
    throw new Error(t('urlFetchFailedProxy', { url, reason: describeProxyError(proxyResponse.status, code) }));
  }
  const proxyContentType = proxyResponse.headers.get('content-type');
  const proxyBytes = await readResponseWithProgress(proxyResponse, onProgress);
  if (looksLikeHtml(proxyBytes, proxyContentType)) {
    throw new Error(t('urlFetchFailedHtmlPage', { url }));
  }
  return proxyBytes;
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

/** `?lib=` 経由のディスク解決結果。スロットへの自動挿入はしないため名前/バイト列は持たず、ライブラリを開く材料のみ返す。 */
type UrlLibOutcome = { kind: 'single'; sourceKey: string } | { kind: 'group'; groupId: string } | { kind: 'error' };

/**
 * `resolveUrlToLibrary` の戻り値。`fromArchive` は disks がアーカイブ展開由来かどうかを示す
 * (`resolveUrlSlotContent` が種別チェックを行うかどうかの分岐に使う。非アーカイブの単体ディスクは
 * 従来どおり種別チェックなしで直接スロットへ入れられる必要があるため区別が要る)。
 */
type UrlLibraryResult = { disks: RegisteredDisk[]; fromArchive: boolean } | { kind: 'error' };

/**
 * URL由来のディスクイメージを取得し、ディスクライブラリ(IndexedDB)へ登録する共通処理
 * (WebNP2 の resolveImage に準拠)。スロットの種別(fd/hdd)は一切見ない。
 * 取得結果がZIP/LZHアーカイブの場合は展開し、中の全ディスクをライブラリへ登録する。
 * アーカイブの展開・登録は同じURLの再訪時は再ダウンロードせず復帰する
 * (グループIDに `arcurl:<url>` を使い、展開済みのレコードがライブラリにあればそれを使う)。
 * 非アーカイブの単体ディスクも同様に、既に保存済み(sourceKey===url)なら再ダウンロードしない。
 *
 * 戻り値は登録済みディスクの配列と、それがアーカイブ展開由来かどうか
 * (0件ならアーカイブ内にディスクイメージが無かったことを示す)。
 * 取得自体に失敗した場合はここでトーストを出したうえで `{ kind: 'error' }` を返す
 * (呼び出し側は他スロット/他URLの処理を継続できる)。
 */
async function resolveUrlToLibrary(url: string, label: string): Promise<UrlLibraryResult> {
  const groupId = `arcurl:${url}`;

  // 展開済みのアーカイブ由来グループ(前回このURLを展開済み)があれば再ダウンロードせず復帰する。
  // ただしバグ(HTML閲覧ページをディスクイメージとして誤保存してしまう不具合)を踏んで保存された
  // 壊れたレコードは復帰の対象にしない(復帰させると修正後も壊れたHTMLが永久に復帰し続けるため)。
  const stored = await listDisks();
  const resumedDisks = stored
    .filter((d) => d.sourceKey.startsWith(`${groupId}/`) && !looksLikeHtml(d.bytes))
    .map((d): RegisteredDisk => ({ name: d.name, sourceKey: d.sourceKey, data: d.bytes, kind: classifyDiskKind(d.name) ?? 'fd' }));
  if (resumedDisks.length > 0) {
    showToast(t('urlArchiveResumed', { label, count: resumedDisks.length }));
    return { disks: resumedDisks, fromArchive: true };
  }

  // 非アーカイブの単体ディスクとして既に保存済みなら(従来どおり sourceKey===url)、そちらを使う。
  // urlDebugForceUrlRefetchは検証ハーネス専用の故障注入(dev限定・既定off)。この分岐を
  // 無効化し、常にネットワークから再取得させる(docs/STORAGE-SCSI.md「末端の永続化検証」参照)。
  // 加えて、HTMLに見える壊れたレコードは復帰させず、下の再取得処理へフォールスルーする
  // (再取得に成功すれば同じsourceKeyへ上書き保存され、壊れたレコードは自然に修復される)。
  const plainStored = urlDebugForceUrlRefetch ? undefined : await getDisk(url);
  if (plainStored && !looksLikeHtml(plainStored.bytes)) {
    showToast(t('urlDiskResumed', { label, name: plainStored.name }));
    return {
      disks: [{ name: plainStored.name, sourceKey: url, data: plainStored.bytes, kind: classifyDiskKind(plainStored.name) ?? 'fd' }],
      fromArchive: false,
    };
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

  // 取得完了後は最後の進捗表示を0.5秒だけ残して消す(持続表示のままだと、以降トーストが
  // 出ない経路(単体ディスクをスロットへ入れて起動するだけ)で画面に固着してしまう)。
  scheduleToastHide(500);

  // 拡張子で判定できない配布URL(拡張子無し)向けに、バイト列のシグネチャでもアーカイブかどうかを見る。
  const archiveName = resolveArchiveFileName(name, bytes);
  if (archiveName) {
    const disks = await registerArchiveBytesToLibrary(archiveName, bytes, groupId, name);
    return { disks, fromArchive: true };
  }

  await saveDisk({ sourceKey: url, name, bytes, savedAt: Date.now() });
  return { disks: [{ name, sourceKey: url, data: bytes, kind: classifyDiskKind(name) ?? 'fd' }], fromArchive: false };
}

/**
 * URLパラメータ由来のディスクイメージをスロット(fd1/fd2/hdd)向けに解決する。
 * `resolveUrlToLibrary` で取得・ライブラリ登録したうえで、アーカイブ展開由来(`fromArchive`)の
 * 場合のみ `finishArchiveDisks` によるスロットの種別一致チェックと枚数分岐(1枚ならそのまま
 * スロットへ、複数枚ならライブラリを開いて選ばせる)を適用する。非アーカイブの単体ディスクは
 * 従来どおり種別チェックなしでそのままスロットへ入れる(旧実装の挙動を維持するための分岐)。
 */
async function resolveUrlSlotContent(url: string, label: string, slot: SlotId): Promise<UrlSlotOutcome> {
  const groupId = `arcurl:${url}`;
  const requiredKind = requiredKindForSlot(slot);
  const result = await resolveUrlToLibrary(url, label);
  if ('kind' in result) return { kind: 'error' };
  if (!result.fromArchive) {
    const only = result.disks[0];
    return { kind: 'single', name: only.name, bytes: only.data, sourceKey: only.sourceKey };
  }
  return finishArchiveDisks(result.disks, label, requiredKind, groupId);
}

/**
 * `?lib=` パラメータ由来のディスクイメージをライブラリへ登録する(スロットへの自動挿入はしない)。
 * 種別(hdd/fd)のチェックは行わない(HDD/FD混在のzipもそのまま登録できるようにする。
 * スロットへ挿入する時点で既存のチェックが効くので安全性は変わらない)。
 */
async function resolveUrlLibContent(url: string, label: string): Promise<UrlLibOutcome> {
  const groupId = `arcurl:${url}`;
  const result = await resolveUrlToLibrary(url, label);
  if ('kind' in result) return { kind: 'error' };
  if (result.disks.length === 0) {
    showToast(t('urlArchiveNoDiskImage', { label }), 8000);
    return { kind: 'error' };
  }
  if (result.disks.length === 1) return { kind: 'single', sourceKey: result.disks[0].sourceKey };
  return { kind: 'group', groupId };
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
  updateScsiControls();
}

/**
 * SCSI(SASI経路とは別のOPFS常駐イメージ)は活線挿抜すると次回起動まで反映されないため、
 * HDDと同じ考え方で起動中は挿入/取出を禁止する(isSlotLocked相当)。
 */
function isScsiLocked(): boolean {
  return running;
}

/** SCSIドライブ行のボタン活性・ツールチップ・表示名を現在の状態に合わせて更新する。 */
function updateScsiControls(): void {
  if (!scsiStorageAvailable) {
    scsiElements.insertBtn.disabled = true;
    scsiElements.libraryBtn.disabled = true;
    scsiElements.blankBtn.disabled = true;
    scsiElements.ejectBtn.disabled = true;
    scsiElements.downloadBtn.disabled = true;
    scsiElements.name.textContent = t('scsiUnavailable');
    return;
  }
  const locked = isScsiLocked();
  const mounted = scsiName !== null;
  scsiElements.insertBtn.disabled = locked;
  scsiElements.libraryBtn.disabled = locked;
  scsiElements.blankBtn.disabled = locked;
  scsiElements.ejectBtn.disabled = locked || !mounted;
  // ダウンロードは中身を読むだけなので起動中でも許可する
  scsiElements.downloadBtn.disabled = !mounted;

  const lockedHint = t('scsiLockedWhileRunning');
  scsiElements.insertBtn.title = locked ? lockedHint : t('slotInsert');
  scsiElements.libraryBtn.title = locked ? lockedHint : t('slotInsertFromLibrary');
  scsiElements.blankBtn.title = locked ? lockedHint : t('scsiCreateBlank');
  scsiElements.ejectBtn.title = locked ? lockedHint : t('slotEject');
  scsiElements.downloadBtn.title = t('slotDownload');

  scsiElements.name.textContent = scsiName ?? t('scsiEmpty');
}

/**
 * SCSIディスクを挿入する。putScsiImage()でOPFSへ書き込みながら name-scsi に進捗を出し、
 * 完了したら localStorage に名前を保存して次回起動から使われるようにする(活線挿抜はしない)。
 */
async function handleInsertScsi(file: File): Promise<void> {
  if (isScsiLocked()) {
    alert(t('scsiLockedWhileRunning'));
    return;
  }
  try {
    scsiElements.name.textContent = t('scsiImporting', { percent: 0 });
    await putScsiImage(file, (done, total) => {
      const percent = total > 0 ? Math.floor((done / total) * 100) : 0;
      scsiElements.name.textContent = t('scsiImporting', { percent });
    });
    scsiName = file.name;
    localStorage.setItem(SCSI_STORAGE_KEY, scsiName);
    updateScsiControls();
    showToast(t('scsiInsertedNeedsRestart'));
    if (!libraryBackdrop.classList.contains('hidden')) void refreshScsiLibraryList();
  } catch (e) {
    console.error('SCSIディスクの取り込みに失敗しました。', e);
    updateScsiControls();
    alert(t('alertBootFailed', { message: String(e) }));
  }
}

/** 既存のOPFS上のSCSIイメージ名(listScsiImages()の結果)と衝突しない名前を作る。 */
function uniqueScsiName(baseName: string, existingNames: Set<string>): string {
  const ext = '.hds';
  let name = `${baseName}${ext}`;
  for (let i = 2; existingNames.has(name); i++) {
    name = `${baseName}${i}${ext}`;
  }
  return name;
}

/**
 * サイズ指定のブランクSCSIディスクを生成し、SCSIスロットへセットしてライブラリにも登録する。
 * FDD/HDDのhandleCreateBlank()系と同じ導線(prompt()でサイズを聞く→生成→OPFSへ保存→
 * スロットへ割り当て→開いていればライブラリ一覧も更新)にする。1パーティション固定
 * (createFormattedScsi()参照)。上限・下限・非数値・小数は validateScsiBlankSizeMiB() が
 * 理由付きで弾き、対応する文言をアラートで出す。
 */
async function handleCreateBlankScsi(): Promise<void> {
  if (isScsiLocked()) {
    alert(t('scsiLockedWhileRunning'));
    return;
  }
  const input = prompt(
    t('scsiBlankSizePrompt', { min: SCSI_BLANK_MIN_MIB, max: SCSI_BLANK_MAX_MIB }),
    '100',
  );
  if (input === null) return;

  const validation = validateScsiBlankSizeMiB(input);
  if (!validation.ok) {
    switch (validation.reason) {
      case 'notANumber':
        alert(t('scsiBlankSizeInvalidNotANumber'));
        break;
      case 'notInteger':
        alert(t('scsiBlankSizeInvalidNotInteger'));
        break;
      case 'tooSmall':
        alert(t('scsiBlankSizeInvalidTooSmall', { min: SCSI_BLANK_MIN_MIB }));
        break;
      case 'tooLarge':
        alert(t('scsiBlankSizeInvalidTooLarge', { max: SCSI_BLANK_MAX_MIB }));
        break;
    }
    return;
  }

  try {
    const existingNames = new Set((await listScsiImages()).map((e) => e.name));
    const name = uniqueScsiName(`blank_scsi_${validation.sizeMiB}mb`, existingNames);
    const data = createFormattedScsi(validation.sizeMiB);
    const file = new File([data.slice()], name, { type: 'application/octet-stream' });
    scsiElements.name.textContent = t('scsiImporting', { percent: 0 });
    await putScsiImage(file, (done, total) => {
      const percent = total > 0 ? Math.floor((done / total) * 100) : 0;
      scsiElements.name.textContent = t('scsiImporting', { percent });
    });
    scsiName = name;
    localStorage.setItem(SCSI_STORAGE_KEY, scsiName);
    updateScsiControls();
    showToast(t('statusScsiBlankCreated', { name, sizeMiB: validation.sizeMiB }));
    if (!libraryBackdrop.classList.contains('hidden')) void refreshScsiLibraryList();
  } catch (e) {
    console.error('ブランクSCSIディスクの作成に失敗しました。', e);
    updateScsiControls();
    alert(t('alertBootFailed', { message: String(e) }));
  }
}

/**
 * ライブラリ(OPFS上に既にあるSCSIイメージ)から選んでSCSIスロットへ割り当てる。
 * 実体は既にOPFSにあるので putScsiImage() での再取り込みは不要で、handleInsertScsi() の
 * 取り込み完了後と同じ状態(localStorageの紐付け差し替え)にするだけでよい。
 */
function selectScsiFromLibrary(name: string): void {
  if (isScsiLocked()) {
    alert(t('scsiLockedWhileRunning'));
    return;
  }
  scsiName = name;
  localStorage.setItem(SCSI_STORAGE_KEY, scsiName);
  updateScsiControls();
  showToast(t('scsiInsertedNeedsRestart'));
  if (!libraryBackdrop.classList.contains('hidden')) void refreshScsiLibraryList();
}

/**
 * SCSIディスクを取り出す(localStorageのエントリを消すだけ。OPFS上の実体は消さない。
 * 削除はライブラリダイアログのSCSI節の仕事)。
 */
function handleEjectScsi(): void {
  if (isScsiLocked()) {
    alert(t('scsiLockedWhileRunning'));
    return;
  }
  scsiName = null;
  localStorage.removeItem(SCSI_STORAGE_KEY);
  updateScsiControls();
  // 挿入中は削除できない節なので、取り出した直後は削除ボタンが有効になり得る。
  if (!libraryBackdrop.classList.contains('hidden')) void refreshScsiLibraryList();
}

/** 現在挿しているSCSIディスクをファイルとしてダウンロードする(既存のhandleDownloadDiskと同じ導線)。 */
async function handleDownloadScsi(): Promise<void> {
  if (!scsiName) {
    alert(t('alertDownloadNoImage'));
    return;
  }
  let file: File;
  try {
    file = await readScsiImage(scsiName);
  } catch (e) {
    console.error('SCSIディスクの読み出しに失敗しました。', e);
    alert(t('alertDownloadNoImage'));
    return;
  }
  const url = URL.createObjectURL(file);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

scsiElements.insertBtn.addEventListener('click', () => {
  if (isScsiLocked()) {
    alert(t('scsiLockedWhileRunning'));
    return;
  }
  scsiElements.input.click();
});
scsiElements.input.addEventListener('change', () => {
  const file = scsiElements.input.files?.[0];
  scsiElements.input.value = '';
  if (!file) return;
  void handleInsertScsi(file);
});
scsiElements.libraryBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!slotPopupMenu.classList.contains('hidden')) {
    closeSlotPopupMenu();
    return;
  }
  void openScsiLibraryMenu(scsiElements.libraryBtn);
});
scsiElements.blankBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!slotPopupMenu.classList.contains('hidden')) {
    closeSlotPopupMenu();
    return;
  }
  void handleCreateBlankScsi();
});
scsiElements.ejectBtn.addEventListener('click', () => handleEjectScsi());
scsiElements.downloadBtn.addEventListener('click', () => void handleDownloadScsi());

// SCSIドライブ行へのD&D配線(他スロットと同じdragenterカウンタ方式)。取り込み先は常にSCSIスロット
// 固定なので resolveStageDropSlot 相当の判定は不要。stage全体へのD&Dは今回は触らない。
{
  const scsiRow = document.getElementById('slot-scsi') as HTMLDivElement;
  let scsiDropDepth = 0;
  scsiRow.addEventListener('dragover', (e) => e.preventDefault());
  scsiRow.addEventListener('dragenter', (e) => {
    e.preventDefault();
    scsiDropDepth++;
    scsiRow.classList.add('dropzone-active');
  });
  scsiRow.addEventListener('dragleave', () => {
    scsiDropDepth = Math.max(0, scsiDropDepth - 1);
    if (scsiDropDepth === 0) scsiRow.classList.remove('dropzone-active');
  });
  scsiRow.addEventListener('drop', (e) => {
    e.preventDefault();
    scsiDropDepth = 0;
    scsiRow.classList.remove('dropzone-active');
    const file = e.dataTransfer?.files?.[0];
    if (file) void handleInsertScsi(file);
  });
}

/**
 * 起動前に一度だけ呼ぶ: この環境でSCSIのOPFS保存が使えるか確認し、使えなければ
 * スロット全体を無効化して name-scsi に案内を出す。使える場合は現在の表示を合わせる。
 */
async function initScsiUi(): Promise<void> {
  scsiStorageAvailable = await isScsiStorageAvailable();
  updateScsiControls();
}
void initScsiUi();

/** スロット1件分の表示(ドライブ行のファイル名 + 各ボタン活性)を更新する。 */
function updateSlotDisplay(slot: SlotId, label: string | null): void {
  slotElements[slot].name.textContent = label ?? t('fdEmpty');
  updateSlotControls();
}

/** FDD スロット(fdd0/fdd1)をドライブ番号へ変換する。HDD は対象外なので null。 */
function fddDriveOf(slot: SlotId): 0 | 1 | null {
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
 * Worker経路(?worker=1)でのFDDホットマウント本体(手順8、docs/STORAGE-SCSI.md
 * 「ワーカー移行 手順8」参照)。Eject→旧内容の回収→(必要なら)write→insert を
 * WorkerCoreProxy#hotSwapFdd() 1回の呼び出しでWorker側の1つのcommandハンドラへ委譲する
 * (src/core-worker.ts の handleHotSwapFdd、src/worker-dirty-capture.ts 参照)。
 *
 * 既定経路のhotSwapFdd()(上の関数)は旧内容の回収をしない(呼び出し元のejectSlot()が
 * 別途persistSlotToLibrary()を先に呼ぶ2段構え。同一スレッドなので間にフレームが進まず
 * 安全)。Worker経路はラウンドトリップを増やしたくないため、Worker側のhotSwapFddが
 * 旧内容(previousImage)を一緒に返し、ここでライブラリへ書き戻す1段構えにした。
 *
 * previousSlot: 差し替え前のslots[slot](sourceKey/nameの由来)。呼び出し元がslots[slot]を
 * 新しい内容で上書きする前に取っておいたものを渡すこと(上書き後では旧sourceKeyが失われる)。
 */
async function workerHotSwapFdd(
  slot: SlotId,
  drive: 0 | 1,
  image: { name: string; data: Uint8Array } | null,
  previousSlot: PendingDisk | null,
): Promise<void> {
  if (!workerCoreProxy) return;
  let result: { previousImage: ArrayBuffer | null; mountedPath: string | null };
  try {
    result = await workerCoreProxy.hotSwapFdd({
      drive,
      image: image ? { name: sanitizeFileName(image.name), bytes: toOwnedArrayBuffer(image.data) } : null,
    });
  } catch (err) {
    console.error('Worker経路のFDDホットマウントに失敗しました。', err);
    showToast(t('workerModeUnsupported'));
    return;
  }
  mountedPaths[slot] = result.mountedPath;
  // 旧内容(previousImage)をライブラリへ書き戻す。既定経路のpersistSlotToLibrary()と同じ
  // 条件(sourceKeyがあり、同梱ディスクではない)でだけ保存する。
  if (result.previousImage && previousSlot?.sourceKey && previousSlot.sourceKey !== BUNDLED_DISK_SOURCE_KEY) {
    try {
      await saveDisk({
        sourceKey: previousSlot.sourceKey,
        name: previousSlot.name,
        bytes: new Uint8Array(result.previousImage),
        savedAt: Date.now(),
      });
      if (!libraryBackdrop.classList.contains('hidden')) void refreshLibraryList();
    } catch (err) {
      console.error('ディスクライブラリへの書き戻しに失敗しました(ホットマウント時の旧内容)。', err);
      // 注: Worker側のhotSwapFddは旧スロットのdirty(コア本体+影)を既にクリア済み
      // (captureDirtyMediaと同じ理由。src/worker-dirty-capture.ts 参照)。保存に失敗しても
      // このスロットには既に新しいディスクがマウントされており、旧内容を指す
      // マウントパス自体がもう存在しないため、captureDirtyMediaのような再dirty化による
      // 再試行はできない(docs/STORAGE-SCSI.md「できなかったこと」参照)。
    }
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
  const previousSlot = slots[slot];
  // Worker経路(?worker=1)は手順8でFDDホットマウントに対応した。HDDの起動中差し替えは
  // 既定経路と同じくisSlotLocked()で弾かれるためここへは来ないはずだが、念のため
  // fddDriveOf()がnullを返す(=HDD)場合は警告して抜ける(無言のUI/実体食い違いを防ぐ)。
  if (urlWorkerMode && running) {
    const drive = fddDriveOf(slot);
    if (drive === null) {
      warnWorkerModeUnsupported();
      return;
    }
    slots[slot] = { name, data, sourceKey };
    updateSlotDisplay(slot, displayLabel ?? name);
    await workerHotSwapFdd(slot, drive, { name, data }, previousSlot);
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

function ejectSlot(slot: SlotId, confirmIfRunning = true): void {
  if (isSlotLocked(slot)) {
    alert(t('slotLockedWhileRunning'));
    return;
  }
  // insertDiskBytes と同じ理由(手順8でFDDホットマウントに対応した)。
  if (urlWorkerMode && running) {
    const drive = fddDriveOf(slot);
    if (drive === null) {
      warnWorkerModeUnsupported();
      return;
    }
    const previousSlot = slots[slot];
    slots[slot] = null;
    updateSlotDisplay(slot, null);
    void workerHotSwapFdd(slot, drive, null, previousSlot);
    return;
  }
  // 実行中の排出は、ディスクを読んでいるゲストがそのままフリーズする事故に直結する
  // (特にタッチ操作ではドライブ行の誤タップが起きやすい)。ディスク交換は排出を経ずに
  // 挿入(ホットスワップ)でできるため、実行中にこのボタンが必要な場面は稀 — 確認を挟む。
  // MCPブリッジ経由(明示的な操作)は confirmIfRunning=false で従来どおり即排出する。
  if (confirmIfRunning && host && running && slots[slot] && !confirm(t('slotEjectConfirmRunning'))) {
    return;
  }
  // 抜く前にゲストの書き込みを回収する(吸い出しは同期なので、ここを抜ける時点で取得済み)。
  void persistSlotToLibrary(slot);
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
 * - FDイメージ: FDD0が空ならFDD0へ。FDD0が埋まっていてFDD1が空なら、2ドライブ運用の
 *   利便性を優先してFDD1へ入れる(WebNP2には無い挙動だがドライブ行が2本あるWebX68k独自の配慮)。
 *   両方埋まっている/両方空の場合はFDD0をデフォルトの投入先とする
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
  // 目的B「起動時のRAM展開」のIndexedDB get区間(getDisk()のrequest発行側ではなく、
  // 結果bytesを受け取った直後まで)。DEVかつstorageProbe.enabledのときだけ記録する。
  const idbGetStartAtMs = import.meta.env.DEV && storageProbe.enabled ? performance.now() : 0;
  const stored = await getDisk(sourceKey);
  if (import.meta.env.DEV && storageProbe.enabled && stored) {
    storageProbe.libraryLoads.push({
      sourceKey,
      slot,
      byteLength: stored.bytes.byteLength,
      idbGetStartAtMs,
      idbGetEndAtMs: performance.now(),
    });
  }
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

  // 挿入先ドライブを選べるようにする: HDDイメージはHDDへのみ、FDイメージはFDD0/FDD1へ挿入可能。
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
 * ライブラリダイアログのSCSI節(OPFS上のSCSIイメージの一覧+削除)を組み立てる1行。
 * FDD/HDD用の buildLibraryRow() と違い、リネームや複数挿入先は無く(挿入はスロット側の
 * openScsiLibraryMenu() の仕事)、削除だけを扱う。現在SCSIスロットに挿入中のイメージは
 * canDeleteScsiImage() で判定して削除ボタンを無効化し、理由をtitleに出す。
 */
function buildScsiLibraryRow(entry: ScsiEntry): HTMLElement {
  const row = document.createElement('div');
  row.className = 'library-list-item';

  const nameEl = document.createElement('span');
  nameEl.className = 'library-item-name';
  appendSplitName(nameEl, entry.name, 'library-item-name-head', 'library-item-name-tail');
  nameEl.title = entry.name;
  row.append(nameEl);

  const metaEl = document.createElement('span');
  metaEl.className = 'library-item-meta';
  metaEl.textContent = formatLibrarySize(entry.bytes);
  row.append(metaEl);

  const actions = document.createElement('div');
  actions.className = 'library-item-actions';

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'library-action-btn danger';
  deleteBtn.textContent = t('libraryActionDelete');
  const deletable = canDeleteScsiImage(entry.name, scsiName);
  deleteBtn.disabled = !deletable;
  deleteBtn.title = deletable ? '' : t('scsiLibraryDeleteDisabledMounted');
  deleteBtn.addEventListener('click', () => {
    if (!confirm(t('libraryDeleteConfirm', { name: entry.name }))) return;
    void (async () => {
      await deleteScsiImage(entry.name);
      await refreshScsiLibraryList();
    })();
  });
  actions.append(deleteBtn);

  row.append(actions);
  return row;
}

/**
 * ライブラリダイアログのSCSI節を再描画する。OPFSが使えない環境では節ごと隠す
 * (scsiStorageAvailable は initScsiUi() で確定済みの値をそのまま見る)。
 */
async function refreshScsiLibraryList(): Promise<void> {
  if (!scsiStorageAvailable) {
    libraryScsiSection.classList.add('hidden');
    return;
  }
  libraryScsiSection.classList.remove('hidden');
  const entries = await listScsiImages();
  libraryScsiList.textContent = '';
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'library-menu-empty';
    empty.textContent = t('libraryMenuEmpty');
    libraryScsiList.append(empty);
    return;
  }
  for (const entry of entries) libraryScsiList.append(buildScsiLibraryRow(entry));
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
  void refreshScsiLibraryList();
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
// 同じ #slot-popup-menu 要素・同じ menuRow/positionSlotPopupMenu/closeSlotPopupMenu の仕組みを、
// 後述のツールバー「…」オーバーフローメニュー(renderOverflowMenu() 系)とも共用する。
// 常に片方しか開かない前提(開く前に必ず textContent をクリアする)なので単一要素で問題ない。

/** トグル項目(4:3表示・マウスキャプチャ等)がONのときメニュー行に添えるチェックマーク。 */
const MENU_CHECK_MARK = '✓';

function closeSlotPopupMenu(): void {
  slotPopupMenu.classList.add('hidden');
  slotPopupMenu.textContent = '';
  // overflowSubmenu はオーバーフローメニュー(この関数が閉じる親)にしか従属し得ないので、
  // 呼び出し元を選ばず常に一緒に閉じてよい(スロットのライブラリメニュー側では最初から空のまま)。
  closeOverflowSubmenu();
}

/**
 * @param options.splitName ディスク名(displayName)を表示する行のとき true。head/tail に分割し中間省略する。
 * @param options.title 行全体につけるツールチップ(完全な名前を常に見られるようにする)。
 * @param options.icon 行頭に添えるアイコン(既存ツールバーボタンの `.btn-icon` SVGを流用する想定。
 *   内部で複製するので呼び出し側で clone しなくてよい)。
 * @param options.iconSlot icon が無い行でも、アイコン1つ分の幅を空けてからラベルを書き出す
 *   (同じメニュー内でアイコン付き行とアイコン無し行が混在するとき、ラベルの書き出しx座標を
 *   揃えるため。オーバーフローメニューのグループ見出し行・戻る行で使う)。icon 指定時は無視される。
 * @param options.disabled true のとき行を無効表示にし、クリック/キー操作を受け付けなくする
 *   (起動前で使えないトグル系メニュー項目を再現するため。オーバーフローメニュー参照)。
 * @param options.checked トグル項目(4:3表示・マウスキャプチャ等)の現在状態。指定すると
 *   role が menuitemcheckbox になり、行右端(library-menu-extra)にチェックマークを出す。
 */
function menuRow(
  label: string,
  extra?: string,
  cls = '',
  options?: {
    splitName?: boolean;
    title?: string;
    icon?: SVGElement | null;
    iconSlot?: boolean;
    disabled?: boolean;
    checked?: boolean;
  },
): HTMLElement {
  const children: Array<Node | string> = [];
  if (options?.icon) {
    const iconEl = options.icon.cloneNode(true) as SVGElement;
    children.push(iconEl);
  } else if (options?.iconSlot) {
    const placeholder = document.createElement('span');
    placeholder.className = 'library-menu-icon-placeholder';
    placeholder.setAttribute('aria-hidden', 'true');
    children.push(placeholder);
  }
  const labelEl = document.createElement('span');
  labelEl.className = 'library-menu-label';
  if (options?.splitName) {
    appendSplitName(labelEl, label, 'library-menu-label-head', 'library-menu-label-tail');
  } else {
    labelEl.textContent = label;
  }
  children.push(labelEl);
  const extraText = options?.checked ? `${MENU_CHECK_MARK}${extra ? ` ${extra}` : ''}` : extra;
  if (extraText) {
    const extraEl = document.createElement('span');
    extraEl.className = 'library-menu-extra';
    extraEl.textContent = extraText;
    children.push(extraEl);
  }
  const disabled = options?.disabled ?? false;
  const row = document.createElement('div');
  row.className = `library-menu-item ${cls} ${disabled ? 'disabled' : ''}`.trim();
  row.setAttribute('role', options?.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
  if (options?.checked !== undefined) row.setAttribute('aria-checked', options.checked ? 'true' : 'false');
  if (disabled) {
    row.setAttribute('aria-disabled', 'true');
    row.tabIndex = -1;
  } else {
    row.tabIndex = 0;
  }
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

/**
 * SCSIスロットの「ライブラリから挿入」ポップアップ。FDD/HDDの openSlotLibraryMenu() と
 * 同じ #slot-popup-menu 要素・同じ体裁(menuRow/positionSlotPopupMenu)を使い回すが、
 * ソースはOPFSの scsi/ ディレクトリ(listScsiImages())で、FDD/HDD用IndexedDBライブラリとは別系統。
 * 選択したイメージは既にOPFSにある実体をそのまま使うので、選択= localStorageの紐付け差し替えのみ
 * (selectScsiFromLibrary)。空のときは既存のFDDライブラリメニューと同じ libraryMenuEmpty() を出す。
 */
async function openScsiLibraryMenu(anchorEl: HTMLButtonElement): Promise<void> {
  const entries = await listScsiImages();
  slotPopupMenu.textContent = '';
  const title = document.createElement('div');
  title.className = 'library-menu-title';
  title.textContent = t('slotInsertFromLibraryTitle', { drive: t('scsiSlotLabel') });
  slotPopupMenu.append(title);

  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'library-menu-empty';
    empty.textContent = t('libraryMenuEmpty');
    slotPopupMenu.append(empty);
  } else {
    for (const entry of entries) {
      const row = menuRow(entry.name, formatLibrarySize(entry.bytes), '', {
        splitName: true,
        title: entry.name,
      });
      onActivate(row, () => {
        closeSlotPopupMenu();
        selectScsiFromLibrary(entry.name);
      });
      slotPopupMenu.append(row);
    }
  }
  positionSlotPopupMenu(anchorEl);
}

/**
 * バーチャルパッドのプロファイル選択メニュー(旧 #vpad-profile <select> の置き換え)。
 * 組み込み4種を単一階層で並べ、現在有効なプロファイルの行に checked(チェックマーク)を付ける。
 * 選択すると setActiveProfile() → saveInputProfileStore() → virtualPad.setProfile() の順に適用してから閉じる。
 */
function renderVpadProfileMenu(anchorEl: HTMLButtonElement): void {
  slotPopupMenu.textContent = '';
  const current = vpadStore.activeId;
  for (const profile of vpadStore.profiles) {
    const row = menuRow(vpadProfileLabel(profile), undefined, '', { checked: profile.id === current });
    onActivate(row, () => {
      closeSlotPopupMenu();
      vpadStore = setActiveProfile(vpadStore, profile.id);
      saveInputProfileStore(VPAD_STORAGE_KEY, vpadStore);
      applyActiveVpadProfile();
    });
    slotPopupMenu.append(row);
  }
  const separator = document.createElement('div');
  separator.className = 'vpad-menu-separator';
  slotPopupMenu.append(separator);
  const editRow = menuRow(t('vpadEditAssignmentsMenuItem'));
  onActivate(editRow, () => {
    closeSlotPopupMenu();
    inputProfileEditor.open();
  });
  slotPopupMenu.append(editRow);
  positionSlotPopupMenu(anchorEl);
}

// --- ツールバー「…」オーバーフローメニュー ---
// 上の #slot-popup-menu / menuRow() / positionSlotPopupMenu() / closeSlotPopupMenu() をそのまま
// 再利用し、階層は「グループ一覧(第1階層)→ グループ内の項目(第2階層、← 戻るで戻れる)」の
// 2段のみ。各行は「toolbar-overflow-sources」(index.html、非表示)にある元のツールバーボタンを
// そのままミラーする: ラベルはボタンの title、状態は disabled/active を読み、クリック時は
// そのボタンの click() を呼ぶだけでハンドラを二重化しない。
//
// ただしトグル行(aria-pressed を持つボタン由来の行)は例外: ツールバーボタンの title は
// 「切替先」を表す文言(例: 4:3表示中なら「ドット等倍表示にする」)で、ホバー時のツールチップ
// としては正しい。しかしメニュー行はチェックマークで ON/OFF を示す流儀なので、切替先の文言を
// そのまま流用すると「ドット等倍表示にする ✓」のように意味が逆に読める矛盾した表示になる。
// そのためトグル行だけは OVERFLOW_MENU_LABEL_OVERRIDES に登録した「状態名」の固定文言を使う。
const OVERFLOW_MENU_LABEL_OVERRIDES = new Map<HTMLButtonElement, () => string>([
  [btnAspect, () => t('toolbarMenuAspect43')],
  [btnMouseCapture, () => t('toolbarMenuMouseCapture')],
  [btnLang, () => t('toolbarLanguage')],
]);

/**
 * 行右端(library-menu-extra)に添える補足文言の上書き。他の行と同じ「ラベル=状態名、右端=状態」の
 * 流儀に揃えるため、言語切替行だけ現在の言語名(その言語自身の表記)をここで返す。
 */
const OVERFLOW_MENU_EXTRA_OVERRIDES = new Map<HTMLButtonElement, () => string>([
  [btnLang, () => langSelfName(getLang())],
]);

type OverflowGroupId = 'display' | 'input' | 'disk' | 'state';

interface OverflowGroup {
  title: () => string;
  actions: HTMLButtonElement[];
}

const OVERFLOW_GROUP_ORDER: OverflowGroupId[] = ['display', 'input', 'disk', 'state'];

const OVERFLOW_GROUPS: Record<OverflowGroupId, OverflowGroup> = {
  display: { title: () => t('toolbarGroupDisplay'), actions: [btnAspect] },
  input: { title: () => t('toolbarGroupInput'), actions: [btnMouseCapture, btnMouseResync, btnGamepad, btnHostKey] },
  disk: { title: () => t('toolbarGroupDisk'), actions: [btnDiskLibrary, btnFileManager] },
  state: { title: () => t('toolbarGroupState'), actions: [btnSaveState, btnLoadState] },
};

/** グループに属さず直接メニューに並ぶ項目(設定/ヘルプ/言語切替)。 */
const OVERFLOW_DIRECT_ACTIONS: HTMLButtonElement[] = [btnSettings, btnHelp, btnLang];

/**
 * 元のツールバーボタン(現在は非表示)を1行に変換する。ラベル/disabled/トグル状態は
 * すべてそのボタンの現在値をそのまま読むので、呼び出し側で個別に文言や状態を持つ必要がない。
 */
function overflowActionRow(btn: HTMLButtonElement): HTMLElement {
  const icon = btn.querySelector<SVGElement>('.btn-icon') ?? null;
  const label = OVERFLOW_MENU_LABEL_OVERRIDES.get(btn)?.() ?? (btn.title || btn.textContent?.trim() || '');
  const extra = OVERFLOW_MENU_EXTRA_OVERRIDES.get(btn)?.();
  const isToggle = btn.classList.contains('icon-btn') && btn.hasAttribute('aria-pressed');
  const row = menuRow(label, extra, '', {
    icon,
    iconSlot: true,
    disabled: btn.disabled,
    checked: isToggle ? btn.classList.contains('active') : undefined,
  });
  if (!btn.disabled) {
    onActivate(row, () => {
      closeSlotPopupMenu();
      btn.click();
    });
  }
  return row;
}

/**
 * 広い画面かどうか。style.css の「スマホ幅」ブレークポイント(`@media (width < 640px)`)と揃える。
 * カスケード(グループ行の右にサブメニューを別要素で出す)は横に余白が要るため、この閾値未満では
 * 従来通り「同じメニュー内で差し替え + ← 戻る」に留める(狭い画面では右に出す余地がなく、
 * 左右反転を重ねてもタップしづらいだけなので分岐する)。
 */
function isWideOverflowMenu(): boolean {
  return !isNarrowToolbar();
}

/**
 * ツールバーが「スマホ幅」ブレークポイント未満かどうか。style.css の `@media (width < 640px)`
 * (#btn-speed を非表示にする条件)と必ず同じ 640px を使う共有ヘルパ。JS側で数値をここ以外に
 * 書かないこと(CSSとJSで条件がずれると「ボタンは消えたがメニューにも出ない」穴が空くため)。
 */
function isNarrowToolbar(): boolean {
  return window.matchMedia('(width < 640px)').matches;
}

/** 第1階層: グループ4種 + グループ無しの直置き項目(設定/ヘルプ/言語切替)。 */
function renderOverflowMenu(anchorEl: HTMLButtonElement): void {
  slotPopupMenu.textContent = '';
  closeOverflowSubmenu();
  // 第1階層は「…」ボタンを押して開いたことが自明なため、見出し「その他」は出さない
  // (第2階層 renderOverflowGroupMenu() は親メニューが消えて階層が分からなくなるので見出しを残す)。

  const wide = isWideOverflowMenu();
  if (!wide) {
    // 狭い画面(#btn-speed が常設から外れる)では速度切替をメニュー先頭に単独行で出す。
    // 表示/入力/ディスク/状態のどのグループにも意味的に合わないため、グループより前に置く
    // (常設から降りてきた頻用トグルなので埋もれさせない)。
    slotPopupMenu.append(overflowActionRow(btnSpeed));
  }
  for (const groupId of OVERFLOW_GROUP_ORDER) {
    const group = OVERFLOW_GROUPS[groupId];
    const row = menuRow(group.title(), undefined, 'group', { iconSlot: true });
    if (wide) {
      // カスケード: 差し替え式だと押した項目が画面上で消え、次に押したい項目が
      // カーソルから遠い位置に来てしまう(=マウス移動量が大きい)ため、親は開いたまま
      // 行の右側に別要素でサブメニューを重ねる(Windowsのメニューと同じ挙動)。
      onActivate(row, () => openOverflowSubmenu(row, groupId));
    } else {
      onActivate(row, () => renderOverflowGroupMenu(anchorEl, groupId));
    }
    slotPopupMenu.append(row);
  }
  for (const btn of OVERFLOW_DIRECT_ACTIONS) {
    slotPopupMenu.append(overflowActionRow(btn));
  }
  positionSlotPopupMenu(anchorEl);
}

/** 第2階層(狭い画面用): 単一グループの中身。「← 戻る」で renderOverflowMenu() に戻る(スロットメニューと同じ流儀)。 */
function renderOverflowGroupMenu(anchorEl: HTMLButtonElement, groupId: OverflowGroupId): void {
  const group = OVERFLOW_GROUPS[groupId];
  slotPopupMenu.textContent = '';
  const back = menuRow(t('libraryMenuBack'), undefined, 'back', { iconSlot: true });
  onActivate(back, () => renderOverflowMenu(anchorEl));
  slotPopupMenu.append(back);
  const title = document.createElement('div');
  title.className = 'library-menu-title';
  title.textContent = group.title();
  slotPopupMenu.append(title);
  for (const btn of group.actions) {
    slotPopupMenu.append(overflowActionRow(btn));
  }
  positionSlotPopupMenu(anchorEl);
}

/** カスケードサブメニューを閉じる(中身をクリアし #overflow-submenu を隠すだけ。親の #slot-popup-menu は触らない)。 */
function closeOverflowSubmenu(): void {
  overflowSubmenu.classList.add('hidden');
  overflowSubmenu.textContent = '';
}

/**
 * 第2階層(広い画面用、カスケード): 親メニュー(#slot-popup-menu)は開いたまま、押したグループ行の
 * 右側に #overflow-submenu を重ねて出す。別のグループ行を押した場合もこの関数が呼ばれ、
 * 同じ要素の中身を作り直して位置も再計算するので「前のサブメニューを閉じて新しい方を開く」を
 * 自然に満たす。「← 戻る」行は親が開いたままなので不要(親の行を直接押し直せる)。
 */
function openOverflowSubmenu(rowEl: HTMLElement, groupId: OverflowGroupId): void {
  const group = OVERFLOW_GROUPS[groupId];
  overflowSubmenu.textContent = '';
  // カスケードは親メニューの行(グループ名)が見えたまま隣に出るため見出しは不要。
  // (差し替え式の renderOverflowGroupMenu() は親メニューが消えるので見出しを残す)
  for (const btn of group.actions) {
    overflowSubmenu.append(overflowActionRow(btn));
  }
  positionOverflowSubmenu(rowEl);
}

/**
 * サブメニューの位置決め。上端はクリックした行の上端、左端は親メニューの右端に接する位置が基本だが、
 * 画面右端に収まらない場合は親メニューの左側へ反転し、画面下端に収まらない場合は上方向にずらす。
 */
function positionOverflowSubmenu(rowEl: HTMLElement): void {
  overflowSubmenu.style.left = '0px';
  overflowSubmenu.style.top = '0px';
  overflowSubmenu.classList.remove('hidden');
  const parentRect = slotPopupMenu.getBoundingClientRect();
  const rowRect = rowEl.getBoundingClientRect();
  const subRect = overflowSubmenu.getBoundingClientRect();

  let left = parentRect.right;
  if (left + subRect.width > window.innerWidth - 4) {
    left = parentRect.left - subRect.width;
  }
  left = Math.max(4, Math.min(left, window.innerWidth - subRect.width - 4));

  let top = rowRect.top;
  if (top + subRect.height > window.innerHeight - 4) {
    top = window.innerHeight - subRect.height - 4;
  }
  top = Math.max(4, top);

  overflowSubmenu.style.left = `${Math.round(left)}px`;
  overflowSubmenu.style.top = `${Math.round(top)}px`;
}

btnToolbarOverflow.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!slotPopupMenu.classList.contains('hidden')) {
    closeSlotPopupMenu();
    return;
  }
  renderOverflowMenu(btnToolbarOverflow);
});

// メニューを開いたまま画面幅が変わると、#btn-speed 行の有無(isNarrowToolbar())が
// 実際の配置と食い違いうるため、開いていれば閉じる(再度開けば作り直される)。
window.addEventListener('resize', () => {
  if (!slotPopupMenu.classList.contains('hidden')) closeSlotPopupMenu();
});

/*
 * ブランクディスクは 2HD 1232KB(XDF標準)のみ作れる。中身はFAT12フォーマット済み
 * (createFormattedFd())で生成する。
 *
 * かつては 2HD 1440KB / 2DD 640KB / 2DD 720KB も選べたが、これらは動作しないので外した。
 * px68k のベタイメージ(XDF)ドライバは x68k/disk_xdf.c が 1,261,568 バイト固定で malloc/read/
 * write し、セクタ読み書きも `memcpy(buf, XDFImg+pos, 1024)` と 1024B 決め打ちになっている。
 * つまり 512B/セクタの形式(1440KB・2DD)は、FAT としては正しく作れてもコアが 1024B/セクタとして
 * 読むため、書き込みが本来と違う位置に落ちてディレクトリに現れない(見かけ上は書き込みに成功する
 * ので気づきにくい)。拡張子による判定(fdd.c の GetDiskType)で .d88/.dim 以外は XDF 扱いになる。
 *
 * これらの形式に対応するなら、ベタイメージではなくセクタ長を持てる D88 コンテナで書き出す必要が
 * ある(px68k の disk_d88.c はセクタ単位の情報を持つので任意ジオメトリを扱える)。その場合は
 * ファイル転送(fat.ts)側も D88 の読み書きに対応させること。
 * createFormattedFd() 自体は他ジオメトリのFATも正しく生成できるので、そのまま残してある。
 */

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

slotPopupMenu.addEventListener('click', (e) => e.stopPropagation());
// カスケードサブメニューの上でのクリックも(項目実行以外は)閉じてはいけないので同様に止める。
// 項目実行時は overflowActionRow() が closeSlotPopupMenu() を呼び、そちらが親子とも閉じる。
overflowSubmenu.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => {
  if (slotPopupMenu.classList.contains('hidden') && overflowSubmenu.classList.contains('hidden')) return;
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

/** Worker経路(?worker=1)で直近受け取った frame event の poolMisses。
 * デバッグフック(__webx68kDebug.workerStats)・自動計測から観測できるようにするための
 * 唯一の保持場所(バッファ返却が効いているかの確認用。docs/STORAGE-SCSI.md参照)。 */
let workerLastPoolMisses = 0;
let workerLastFrameNo = 0;

/** Worker経路(?worker=1)で `proxy.fetchAvInfo()` が返した値。既定経路の `host.avInfo` に相当する
 * 値がWorker経路には無いため、計測フック(__webx68kDebug.stat/bridgeHost.status)の
 * fps読み取りをWorker経路でも成立させる目的だけで保持する(docs/STORAGE-SCSI.md
 * 「Worker経路の起動時間：同一ビルドA/B」参照。host.avInfoと同様、以後更新しない)。 */
let workerAvInfo: AvInfo | null = null;

/** `?worker=1` でだけ利用者へ見せる、未移行機能のトースト。
 * 手順6(2026-08-31)でキー・パッド・マウスボタン・加算マウスdelta、手順6後半(2026-08-31)で
 * マウスの閉ループ追従、手順8(2026-08-31)でFDDホットマウント/dirty capture/オートセーブ/
 * 終了flush、手順5(2026-09-01)で音声出力は対応した(このトーストの対象から外れた)。
 * SRAM・ステート保存/復元は今回もスコープ外のまま(docs/STORAGE-SCSI.md「段階移行の順序」
 * 参照)。HDDの起動中差し替えは元々既定経路でもisSlotLocked()で禁止されている機能で、
 * Worker経路固有の制約ではない。無言のno-opにせず、必ずここを通してから抜けること。 */
/**
 * ページ(main)側の `globalThis.__webx68k*` をWorkerへ渡すためのスナップショットを取る
 * (docs/STORAGE-SCSI.md参照)。判定・収集ロジック本体は src/host-globals.ts に切り出して
 * ある(globalThisやDOM/showToastに依存しない形にして単体テスト可能にするため。
 * test/host-globals.test.ts参照)。ここでは実際の globalThis を渡し、除外が発生した際の
 * 通知(console.warn + トースト)だけを担う。
 */
function collectHostGlobalsFromWindow(): Record<string, HostGlobalValue> {
  return collectHostGlobals(globalThis as unknown as Record<string, unknown>, (skippedKeys) => {
    const message =
      `[worker] Workerへ転写できない __webx68k* 設定を ${skippedKeys.length} 件、` +
      `無言で無視せず警告として落としました(structured cloneできない型: 関数等): ` +
      `${skippedKeys.join(', ')}`;
    console.warn(message);
    try {
      showToast(message, 8000);
    } catch {
      // showToast未初期化(DOM構築前)等でも、collectHostGlobalsFromWindow自体は落とさない。
      // console.warnで既に利用者に伝わる経路は確保済み。
    }
  });
}

function warnWorkerModeUnsupported(): void {
  console.warn('[worker] ?worker=1 ではこの機能はまだ未対応です(SRAM・ステート保存/復元)。');
  showToast(t('workerModeUnsupported'));
}

/**
 * `?worker=1` のときの起動経路。既定経路(host = メインスレッドの LibretroHost)を一切作らず、
 * Worker 上のコアだけを本体として使う(手順4のスケルトンと違い、2本目のコアではなくこちらが
 * 唯一のコアになる)。host はこの経路では常に null のまま(input/audio/hotswap/state系の
 * 呼び出しが誤って本体があるかのように動かないための安全策も兼ねる)。
 *
 * 映像(手順5)は Worker が scratch canvas から毎フレーム吸い出した RGBA を frame event で
 * 送ってきたものを、ここで実際の画面 canvas へ putImageData() する(決定A: 転送方式・メイン側
 * canvas維持。docs参照)。putImageData() し終えた ArrayBuffer は同じ event ハンドラの中で
 * 即座に Worker のプールへ返す(バッファ返却)。
 */
async function bootWorkerCore(): Promise<void> {
  speedEnabled = false;
  recomputeSpeedMultiplier();
  updateSpeedButtonUi();

  if (workerCoreProxy) {
    const previous = workerCoreProxy;
    workerCoreProxy = null;
    coreProxy = null;
    workerAvInfo = null;
    workerLastKeyBufProbe = null;
    workerLastKeyBufWriteFrameNo = null;
    workerLastInputSendFrameNo = null;
    workerLastInputApplyFrameNo = null;
    workerLastMouseTrackProbe = null;
    workerLastScsiDebugProbe = null;
    try {
      await previous.dispose();
    } catch (err) {
      console.warn('[worker] 前回のWorkerコアのdisposeに失敗しました', err);
    }
  }
  if (!biosIplBytes || !biosCgBytes) {
    throw new Error('BIOS/CGROMが未設定です');
  }

  const wctx = canvas.getContext('2d');
  if (!wctx) throw new Error('2D コンテキストの取得に失敗しました');

  const savedSram = await loadSramFile();
  // SRAM/ステートの永続化はスコープ外だが、初回のSWITCH.X設定(起動ドライブ等)を引き継ぐため
  // 初期値として渡すことだけは既定経路と揃える(以後の自動保存は行わない。startSramAutosave
  // 相当はWorker側に無い)。
  const proxy = new WorkerCoreProxy();
  workerCoreProxy = proxy;
  coreProxy = proxy;

  // DEV専用の計測プローブ応答(workerTickProbeRead()参照)。以前のpending readはこの
  // 世代交代で応答が来ないため、resolve せずに新しいproxyの応答だけを繋ぐ
  // (workerTickProbeReadのタイムアウト保険が最終的に片付ける)。
  proxy.setDevMessageHandler((msg) => {
    const m = msg as { kind?: string; events?: unknown[]; commandEvents?: unknown[] };
    if (m?.kind === '__devTickProbeData' && pendingWorkerTickProbeRead) {
      const resolve = pendingWorkerTickProbeRead;
      pendingWorkerTickProbeRead = null;
      resolve({ events: m.events ?? [], commandEvents: m.commandEvents ?? [] });
    }
  });
  // 起動前に window.__webx68kDebug.workerTickProbeEnable(true) が呼ばれていた場合、
  // このproxy(=今回の起動)に対しても即座に有効化する(起動が終わるのを待たない。
  // 遅れが集中する「コア稼働後」区間を取り逃さないため)。
  if (workerTickProbeWanted) {
    proxy.devPostRawMessage({ kind: '__devTickProbe', action: 'enable' });
  }
  if (workerTickProbeBusyWaitFaultWanted) {
    proxy.devPostRawMessage({ kind: '__devTickProbe', action: 'setBusyWaitFault', value: true });
  }
  // KeyBufプローブも同様(docs/STORAGE-SCSI.md「KeyBufプローブのWorker対応」参照)。
  if (workerKeyBufProbeWanted) {
    proxy.devPostRawMessage({ kind: '__devKeyBufProbe', action: 'enable' });
  }

  // 手順9: error/messageerror/timeout/fatal のどれで壊れても、pendingなcommandの有無に
  // 関わらず必ずここが呼ばれる(src/core-proxy.tsのfailureHandler参照)。従来は「たまたま
  // その瞬間に呼び出し中だったcommandがあれば、そのcatch節でしか」利用者に伝わらず、
  // frame event配信中(pendingが空)にWorkerが死ぬと無言で画面が静止したまま何も起きなかった。
  proxy.setFailureHandler((message) => {
    console.error('[worker] Workerコアが異常終了しました。', message);
    showToast(`Workerコアが異常終了しました: ${message}`, null);
    running = false;
  });

  proxy.setEventHandler((event: CoreEvent) => {
    if (event.event === 'frame') {
      const snapshot: FrameSnapshot = event.snapshot;
      workerLastPoolMisses = snapshot.poolMisses;
      workerLastFrameNo = snapshot.frameNo;
      if (snapshot.keyBufProbe) workerLastKeyBufProbe = snapshot.keyBufProbe;
      if (snapshot.keyBufWriteFrameNo !== undefined) workerLastKeyBufWriteFrameNo = snapshot.keyBufWriteFrameNo;
      if (snapshot.inputApplyFrameNo !== undefined) workerLastInputApplyFrameNo = snapshot.inputApplyFrameNo;
      if (snapshot.mouseTrackProbe) workerLastMouseTrackProbe = snapshot.mouseTrackProbe;
      if (snapshot.scsiDebugProbe) workerLastScsiDebugProbe = snapshot.scsiDebugProbe;
      if (snapshot.video.kind === 'rgba') {
        const { bytes, width, height } = snapshot.video;
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
          rescale();
        }
        // ImageData(data, w, h) は data をコピーせずそのまま backing store にする
        // (HTML仕様上、渡した Uint8ClampedArray が ImageData.data そのものになる)。
        const imageData = new ImageData(new Uint8ClampedArray(bytes), width, height);
        wctx.putImageData(imageData, 0, 0);
        // バッファ返却(決定「バッファ返却あり」): putImageData() は同期的にピクセルを
        // 読み終えるので、この直後に同じ ArrayBuffer を Worker のプールへ返してよい。
        workerCoreProxy?.returnFrameBuffer(bytes);
      }
      // 音声出力(手順5、2026-09-01): Workerはリサンプルせず生サンプル(Float32、stereo
      // interleaved)をchunk単位でそのまま送ってくる(1chunk = Worker側の1回のaudioPush
      // 呼び出しに対応。src/core-worker.tsのpushAudioSamples参照)。速度倍率の可変レート
      // リサンプル(resampleSpeed)とAudioEngine.push()は既定経路(bootCore()内のcallback)と
      // 全く同じ処理をここで行う。経路を1本に保つため、Worker側では絶対にリサンプルしない
      // (過去の教訓「入力源は末端の唯一の窓口へ集約する」と同種の失敗を避ける)。
      // audioがnullになりうる(AudioWorkletが使えない環境)のは既定経路と同じ: 行き先が
      // 無いときはサンプルを捨てるだけでよい(bootCore()のコメント参照。ここを`audio!`に
      // すると無音環境で起動ごと壊れる)。
      for (const chunkBuf of snapshot.audio.chunks) {
        const samples = new Float32Array(chunkBuf);
        const out =
          speedMultiplier === 1 ? samples : resampleSpeed(samples, speedMultiplier, audioResampleState);
        audio?.push(out);
      }
      applyDiskAccess(performance.now(), snapshot.disk.access);
      // 手順8: 既定経路のhost.readDirtyState()ポーリングに相当する値をframe eventから
      // 更新し、同じframe eventを契機にオートセーブ判定を行う(pollDiskAccessと同じ考え方)。
      workerLastDirty = snapshot.disk.dirty;
      pollWorkerAutoSave(performance.now());
      // 入力(手順6): 受信した frame event を契機に1回だけ、既定経路の host.onPoll と
      // 同じ合成規則(bits0 | virtualPad.getJoyBits() | hostKeyJoyBits())でポート0/1の
      // ビットを合成し、workerInput へ書いてから送信する(未決事項だった「ゲームパッドを
      // 何を契機にpollするか」への回答。docs/STORAGE-SCSI.md「ワーカー移行 手順6」参照。
      // 余分なタイマーを増やさないため、専用のpollループは持たない)。
      const pads = gamepadsByPort();
      const [bits0, bits1] = pollBitsByPort(pads);
      applyJoyState(0, bits0 | virtualPad.getJoyBits() | hostKeyJoyBits());
      applyJoyState(1, bits1);
      syncGamepadKeys(pads);
      sendWorkerInputUpdate();
      return;
    }
    // 'fatal' はここには来ない: src/core-proxy.tsのhandleMessage()がWORKER_FAILUREとして
    // handleWorkerFailure()へ横取りし、eventHandlerへは転送しない(以前ここに書いてあった
    // event.event === 'fatal' の分岐は実際には一度も実行されない死んだコードだった。
    // 手順9で気づき、上のproxy.setFailureHandler()に一本化した)。
    if (event.event === 'mouseTrackDisabled') {
      // Worker側の閉ループが追従を諦めた(手順6後半)。既定経路(stepMouseTracking)と同じ
      // 通知を出す。無言で死なせないこと(docs/STORAGE-SCSI.md「ワーカー移行 手順6後半」参照)。
      showToast(t('mouseTrackUnavailable'));
      return;
    }
    // 'ready'/'sramChanged' はこの経路では特に処理しない
    // (avInfoはfetchAvInfo()の戻り値を、SRAM監視は今回スコープ外のため)。
  });

  const fdd0 = slots.fdd0;
  const fdd1 = slots.fdd1;
  const hdd = slots.hdd;
  // 2026-08-31追記(リセット復帰の欠陥、docs/STORAGE-SCSI.md「ワーカー移行 手順9」参照):
  // slots.fdd0/fdd1/hdd.data・biosIplBytes/biosCgBytesはmodule-levelに保持され、
  // リセットのたびに同じインスタンスがWorkerCoreProxy#init()へ渡る。init()側が
  // 呼び出し都度コピーしてから転送するよう修正した(src/core-proxy.ts WorkerCoreProxy#init()
  // のコメント参照)ので、ここではそのまま渡してよい(以前はここでコピーする案も検討したが、
  // 「所有権を渡す/コピーを渡す」の判断はproxy境界の内側に閉じ込めるほうが、この呼び出し元を
  // 含む全呼び出し元で同じ間違いが起きなくなるため、init()側1箇所に寄せた)。
  const initialDisks: InitialDiskInput[] = [];
  if (fdd0) initialDisks.push({ slot: 'fdd0', name: sanitizeFileName(fdd0.name), bytes: fdd0.data });
  if (fdd1) initialDisks.push({ slot: 'fdd1', name: sanitizeFileName(fdd1.name), bytes: fdd1.data });
  if (hdd) initialDisks.push({ slot: 'hdd', name: sanitizeFileName(hdd.name), bytes: hdd.data });
  mountedPaths.fdd0 = fdd0 ? fdd0.name : null;
  mountedPaths.fdd1 = fdd1 ? fdd1.name : null;
  mountedPaths.hdd = hdd ? hdd.name : null;

  // 手順9: コアオプション(既定経路がbootCore()内でhost.setCoreOption()を直接呼んでいるのと
  // 同じもの)。src/core-worker.ts の handleInitialize() は InitPayload.options を読んで
  // setCoreOption() を回す実装を(この配線を追加する前から)既に持っていたが、ここが
  // 一度もoptionsを渡していなかったため、Worker経路ではCPU速度/RAM構成/パッド種別/
  // HDD永続化/マウス有効化、そして速度倍率が実際に効くために必須のpx68k_no_wait_mode
  // (下のbtnSpeed/cfgSpeedハンドラ、および既定経路のbootCore()コメント参照)が
  // 一度も設定されていなかった(コーディネータ指摘、docs/STORAGE-SCSI.md「ワーカー移行
  // 手順9」参照)。
  //
  // 2026-08-31追記(コーディネータの2回目の指摘への対応): 「既定経路のオプション一覧と揃える」
  // だけでは、bootCore()側の個別呼び出しとここのオブジェクトリテラルを別々に書き写す形になり、
  // 将来どちらかだけ直し忘れると再び食い違う(実際にpx68k_cpuspeedはコア既定"10Mhz"と
  // WebX68k既定"16Mhz"が食い違っており、Worker経路は今まで10Mhzで走っていた実績がある)。
  // src/core-options.ts の buildCoreOptions() 1箇所から両経路が値を取るようにして、
  // 一致を構造的に保証する(test/core-options.test.ts が退行検知)。
  const workerCoreOptions = buildCoreOptions({
    cpuSpeed,
    ramSize,
    joyType1CoreValue: PAD_TYPE_CORE_OPTION_VALUE[gamepadStore.joyType[0]],
    joyType2CoreValue: PAD_TYPE_CORE_OPTION_VALUE[gamepadStore.joyType[1]],
  });
  virtualPad.setPadType(gamepadStore.joyType[0]);

  await proxy.init(
    biosIplBytes,
    biosCgBytes,
    savedSram ?? undefined,
    initialDisks,
    workerCoreOptions,
    collectHostGlobalsFromWindow(),
  );
  await proxy.loadGame('/game/boot.cmd');
  workerAvInfo = await proxy.fetchAvInfo();
  await proxy.setRunning(true);
  // 起動直後の実効速度をWorkerへ知らせる(通常は1=等倍。速度ボタンは既定でOFFに揃えてある。
  // 上のspeedEnabled=falseと合わせ、Worker再生成のたびに必ず等倍から始まる)。
  proxy.setSpeedMultiplier(speedMultiplier);

  running = true;
  // 既定経路のbootCore()末尾(accumulator=0と並ぶ箇所)と同じ位置づけでリサンプラ状態を
  // リセットする。起動直後はspeedEnabled=false(speedMultiplier===1)でリサンプル経路自体を
  // 通らず、次に速度ボタンを押せばresetSpeedState()がどのみちリセットするため、これを
  // 呼ばなくても音が壊れるわけではない。前世代のリサンプラの持ち越し状態を残さないよう、
  // 経路間の対称性を保つための対応。
  resetResampleState(audioResampleState);
  updateSlotControls();
  resetAccessLamps();
  // 手順6(2026-08-31)でキー・パッド・マウスボタン・加算マウスdelta、手順6後半(2026-08-31)で
  // マウスの閉ループ追従、手順8(2026-08-31)でFDDホットマウント/dirty capture/オートセーブ/
  // 終了flushは対応した。手順9(2026-08-31、コーディネータ指摘への対応)で速度ボタン・
  // CPU速度/RAM構成/パッド種別のコアオプション配線も対応した。手順5(2026-09-01)で音声出力
  // (生サンプルの転送・main側でのリサンプル・AudioEngineへのpush)も対応したため、
  // 起動完了時の一律トーストは廃止した(残るSRAM・ステート保存/復元は実際に操作した
  // タイミングで個別に警告する。warnWorkerModeUnsupportedの他の呼び出し箇所参照)。
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
  // `?worker=1` は既定経路(この関数の残り、host=メインスレッドのLibretroHostを使う経路)を
  // 一切変えない裏フラグ(制約: 既定経路の挙動を変えないこと)。ここで完全に分岐する。
  if (urlWorkerMode) {
    // SCSI(手順4の1枚目)はWorker内(src/scsi-opfs.ts)からだけ使われる経路。
    // 「もうOPFSにある物を開くだけ」で、URLからの取り込みはしない。scsiName が無ければ
    // ここでは何もしない(既存のプローブ(scripts/probe-scsi-iocs.mjs)が
    // window.__webx68kScsiOpfs/__webx68kScsiUrl を直接立てて使う経路と衝突しないよう、
    // UIが一度もSCSIを挿していないときに他所が立てた値を勝手に消さない)。
    if (scsiName) {
      const g = globalThis as Record<string, unknown>;
      g.__webx68kScsiOpfs = true;
      g.__webx68kScsiOpfsPath = `scsi/${scsiName}`;
    }
    await bootWorkerCore();
    return;
  }
  // 起動時・リセット時は必ず速度ボタンをOFF(実効100%)に戻す。状態を保存しない設計のため、
  // ここで揃えておかないとリセット直後だけ前回のON状態が残ってしまう。
  speedEnabled = false;
  recomputeSpeedMultiplier();
  updateSpeedButtonUi();
  // audio は null になりうる(AudioWorklet が使えない環境。呼び出し元の起動処理を参照)。
  // ここを `audio!` にしていると、無音で起動したときにコアからの最初の音声コールバックで
  // 例外になり、フレームループごと巻き込んで画面が真っ黒のまま止まる。
  // 音の行き先が無いときはサンプルを捨てるだけでよい。
  host = new LibretroHost(canvas, (samples) => {
    // 無制限モードは実時間の何倍もの速さでサンプルを吐くため、そのままpushするとキューが
    // 即座に溢れ、computeFrameBudget() の「queued > MAX_LATENCY_SEC*0.8 ならbudget=0」という
    // ブレーキが効いてフレーム供給が止まってしまう(無制限モードはそのゲートを通らない別経路
    // だが、pushしたサンプル自体はキューに残るため次にゲートを使う通常モードへ戻った時に
    // 影響する)。無制限中は実時間で消費しきれない音を最初から捨てる(=無音)。
    if (unlimitedActive) return;
    // k===1 はバイパスして元の配列をそのまま渡す(従来と同一の経路)。
    // それ以外は速度倍率ぶん可変レートでリサンプルし、テープ早送りのようにピッチを変える。
    const out =
      speedMultiplier === 1 ? samples : resampleSpeed(samples, speedMultiplier, audioResampleState);
    audio?.push(out);
  });
  if (import.meta.env.DEV) host.audioProbeEnabled = urlAudioProbe;
  // X68000 は画面モード変更で実行中に canvas の実解像度(width/height)が変わる。
  // ウィンドウ表示のリスケールは実解像度基準で倍率を決めるため、変わった直後に再計算させる。
  host.onResolutionChanged = () => rescale();
  // 2026-08-31追記(コーディネータ指摘への対応、手順9): 以前はここで文字列リテラルを
  // 直接setCoreOption()へ渡していたが、Worker経路(bootWorkerCore())側は同じ値の
  // つもりで別々に組み立てたオブジェクトを渡しており、実際に px68k_cpuspeed が
  // 食い違っていた(コア既定"10Mhz"のままWorker経路が起動していた実績がある)。
  // src/core-options.ts の buildCoreOptions() から両経路が値を取ることで、
  // 一致を構造的に保証する(test/core-options.test.ts が退行検知)。setCoreOption()を
  // 個別に呼ぶ順序・回数はそれぞれのコメントごと変えていない(既定経路の挙動は不変)。
  const defaultCoreOptions = buildCoreOptions({
    cpuSpeed,
    ramSize,
    joyType1CoreValue: PAD_TYPE_CORE_OPTION_VALUE[gamepadStore.joyType[0]],
    joyType2CoreValue: PAD_TYPE_CORE_OPTION_VALUE[gamepadStore.joyType[1]],
  });
  host.setCoreOption('px68k_cpuspeed', defaultCoreOptions.px68k_cpuspeed);
  host.setCoreOption('px68k_ramsize', defaultCoreOptions.px68k_ramsize);
  // HDD0 の永続化(config読込)を有効化。これでLoadConfig()が /system/keropi/config の
  // HDD0= を読み、cmdファイル(FDD0/FDD1指定)と共存できる。
  host.setCoreOption('px68k_save_hdd_path', defaultCoreOptions.px68k_save_hdd_path);
  // マウスを有効化する。px68k は MouseSW が立っていないと Mouse_Event() を丸ごと無視するため、
  // このオプション("Mouse")が Mouse_StartCapture(1) を呼ぶまでマウス入力は一切通らない。
  host.setCoreOption('px68k_joy_mouse', defaultCoreOptions.px68k_joy_mouse);
  // 速度倍率ボタンを機能させるために必須。px68k-libretro は libretro.c の retro_run() 内で
  // `Config.NoWaitMode || Timer_GetCount()` を満たさない限り WinX68k_Exec()(実際にゲストを
  // 1フレーム進める処理)を呼ばない。Timer_GetCount() は実時間の経過を積算し、1フレームぶん
  // 溜まったときだけ1を返すため、無効のままだと retro_run() を何倍の頻度で呼んでもゲストは
  // 実時間どおりの回数しか進まない(速度倍率が効かない=見た目の速度が変わらない)。
  // 'enabled' にすると `||` の短絡で Timer_GetCount() 自体が呼ばれなくなり、retro_run() 1回
  // につき必ず1フレーム進む。つまり「進行のペースを決める時計」がコア内部から、上の loop()
  // (音声キューの滞留量でフレーム供給ペースを自動調整する側)へ移る。loop() は実質
  // AudioContext の 44100Hz に同期しているので、これで速度ボタンの倍率がそのままゲストの
  // 体感速度に反映される。
  // px68k_audio_desync_hack は代わりに有効化しないこと。あちらは溜まりすぎた音声サンプルを
  // 単純に間引いて捨てる実装で、こちらの可変レートリサンプラ(resampleSpeed)と機能が衝突する。
  // また、この設定はコアの update_variables() が起動直後の1回目の retro_run() でしか読まない
  // (ホスト側がRETRO_ENVIRONMENT_SET_VARIABLE_UPDATEに対応していないため)。速度ボタンの
  // ON/OFFに連動させる余地は無く、起動時に固定で 'enabled' にしておく。
  host.setCoreOption('px68k_no_wait_mode', defaultCoreOptions.px68k_no_wait_mode);
  // ジョイスティックのパッド種別(2ボタン/CPSF-MD/CPSF-SFC)。gamepadStore.joyType(設定ダイアログの
  // パッド種別セレクタ、localStorage永続化)がそのまま唯一の情報源。この設定は update_variables()
  // が firstcall(起動直後の1回目のretro_run)でしか読まないため、変更を反映するには
  // このbootCore()をやり直す(=コアを再起動する)必要がある。実行中にgamepadStore.joyTypeだけ
  // 書き換えても次に読み込まれるのは次回起動時。
  host.setCoreOption('px68k_joytype1', defaultCoreOptions.px68k_joytype1);
  host.setCoreOption('px68k_joytype2', defaultCoreOptions.px68k_joytype2);
  // バーチャルパッドの送り先は常にポート0(表示上のポート1)。TRG3..TRG8のビット位置は
  // そのポートのpadTypeに依存するため、コア起動時点の値を渡しておく(設定ダイアログで
  // 変更されたときは setPadType コールバック側で追従させる)。
  virtualPad.setPadType(gamepadStore.joyType[0]);
  // リロード後もSWITCH.Xの設定(起動ドライブ・キーリピート等)が残るよう、前回保存したSRAMを
  // retro_load_game()より前に渡す(無ければ未初期化のままIPLが既定値を書く=初回起動相当)。
  const savedSram = await loadSramFile();
  await host.init(biosIplBytes!, biosCgBytes!, savedSram ?? undefined);
  // host.init() は上で直接完了させた(段階移行の途中でinit経路自体は変えない)。
  // 以後の観測系呼び出し(screenText/readMemory等)だけをこの proxy 経由にする。
  coreProxy = new LocalCoreProxy(host, { initialized: true });
  // `?worker=1` はこの関数の先頭(bootCore()冒頭のurlWorkerMode分岐)で bootWorkerCore() へ
  // 完全に分岐済みなので、ここへは来ない(既定経路のみがここに到達する)。
  syncSerialConnectionToCore();
  serialTransport.notifyReceiveCapacity();
  updateSerialUi();
  host.startSramAutosave((bytes) => {
    saveSramFile(bytes).catch((err) => console.warn('SRAMの保存に失敗しました', err));
  });
  // SWITCH.Xでの設定変更をKeyRepeaterへ追従させるためのSRAM監視状態。
  // 毎フレーム読むのは無駄なので60フレーム(約1秒)おきに間引く。bootCore()呼び出し
  // ごと(コア再起動ごと)にローカル変数として作り直されるので、古いコアの値を
  // 次のコアへ引きずることはない。
  let keyRepeatPollFrameCount = 0;
  let lastKeyRepeatConfig: { delayMs: number; intervalMs: number } | null = null;
  host.onPoll = () => {
    keyRepeatPollFrameCount++;
    if (keyRepeatPollFrameCount >= 60) {
      keyRepeatPollFrameCount = 0;
      // SRAMが未初期化・古いコア等でnullのときはKeyRepeaterの既定値のまま据え置く
      // (readKeyRepeatConfig()のコメント参照)。
      const config = host!.readKeyRepeatConfig();
      if (
        config &&
        (lastKeyRepeatConfig === null ||
          config.delayMs !== lastKeyRepeatConfig.delayMs ||
          config.intervalMs !== lastKeyRepeatConfig.intervalMs)
      ) {
        lastKeyRepeatConfig = config;
        keyRepeater.setTiming(config.delayMs, config.intervalMs);
        console.log(
          `キーリピート設定を SRAM から取得: 開始 ${config.delayMs}ms / 間隔 ${config.intervalMs}ms`,
        );
      }
    }
    const pads = gamepadsByPort();
    const [bits0, bits1] = pollBitsByPort(pads);
    // 物理パッド・バーチャルパッド・ホストキー(物理キーボード再割り当て)が同じポート(0)に
    // 乗りうるため、ビットマスクはORで合成する(docs/DESIGN.md「joy出力の合成」参照)。
    host!.setJoyState(0, bits0 | virtualPad.getJoyBits() | hostKeyJoyBits());
    host!.setJoyState(1, bits1);
    syncGamepadKeys(pads);
  };

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
    // 互換用FS書き込みはproxy経由にする(手順3)。writeDiskImageはhotSwapFdd専用の実装詳細
    // として host に残す(core-proxy.ts末尾のコメント参照、今回の対象外)。
    await coreProxy!.writeFile('/system/keropi/config', toOwnedArrayBuffer(new TextEncoder().encode(iniText)));
  } else {
    mountedPaths.hdd = null;
  }

  // px68k-libretro は "px68k <fd0> <fd1>" 形式の.cmdファイルでFDD0/FDD1を同時指定できる
  // (libretro.c pmain(): argc==3で FDDImage[0]/[1] を両方設定)。空スロットは空文字列で渡す。
  const cmdText = `px68k "${fdd0Path}" "${fdd1Path}"\n`;
  await coreProxy!.writeFile('/game/boot.cmd', toOwnedArrayBuffer(new TextEncoder().encode(cmdText)));
  host.loadGame('/game/boot.cmd');

  host.fetchAvInfo();

  running = true;
  lastFrameTime = 0;
  accumulator = 0;
  resetResampleState(audioResampleState);
  speedMeasureLastAt = 0;
  speedMeasureFrameCount = 0;
  // running が立ってから更新する(HDD行のロック状態がここで確定する)
  updateSlotControls();
  resetAccessLamps();
  scheduleNext();
}

/** 実行中のコアを破棄して作り直す */
async function restartCore(): Promise<void> {
  // 載せ直すと slots[].data から書き直すことになるので、その前にゲストの書き込みを回収する
  // (設定変更でCPU速度を変えただけでセーブデータが消える、という事故を防ぐ)。
  // Worker経路(手順8)はpostMessageの往復を伴う正真正銘の非同期なのでawaitする
  // (既定経路のflushAllSlots()は同一スレッドの同期処理なのでawait不要。両者の違いは
  // 「ここでawaitするかどうか」だけで、どちらも書き戻しの完了を待ってから
  // bootCore()へ進む点は同じ)。
  //
  // 手順9(異常系の検証)の故障注入用フック(dev限定・既定off、docs/STORAGE-SCSI.md
  // 「ワーカー移行 手順9：異常系の検証」参照): scripts/verify-reset-persistence.mjs の
  // --fault から実際に壊すための分岐。
  // - urlDebugDisableResetFlush: 書き戻しそのものをスキップする(保存が起きない)。
  // - urlDebugResetFlushNoAwait: Worker経路限定。flushAllSlotsWorker()の完了を待たずに
  //   次へ進める(保存→終了→readyの順序を壊す。既定経路のflushAllSlots()は同一スレッド
  //   同期処理でこの壊し方を再現できないため対象外)。
  if (urlDebugDisableResetFlush) {
    // 何もしない(書き戻しを丸ごと省略する)。
  } else if (urlWorkerMode) {
    if (urlDebugResetFlushNoAwait) void flushAllSlotsWorker();
    else await flushAllSlotsWorker();
  } else {
    flushAllSlots();
  }
  running = false;
  cancelScheduled();
  resetSerialBridge();
  host?.dispose();
  host = null;
  coreProxy = null;
  try {
    await bootCore();
  } catch (error) {
    await serialTransport.disconnect();
    updateSerialUi();
    throw error;
  }
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
    // HDD は FAT16 固定、FD も 2HD 1232KB のみになったのでメニューを出さず即作成する。
    if (slot === 'hdd') void handleCreateBlankHdd();
    else void handleCreateBlank(slot, '2hd1232');
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
// 投入先の決定だけ resolveStageDropSlot 経由で WebX68k のスロット構成(FDD0/FDD1/HDD)に合わせる。
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
function serialStateLabel(state: SerialConnectionState): string {
  switch (state) {
    case 'connected':
      return t('settingsSerialConnected');
    case 'connecting':
      return t('settingsSerialConnecting');
    case 'error':
      return t('settingsSerialError');
    default:
      return t('settingsSerialDisconnected');
  }
}

const SERIAL_BAUD_POLL_INTERVAL_MS = 250;
let nextSerialBaudPollAt = 0;
let lastSerialBaudNoteKey = '';
let lastSerialBaudWarningKey = '';
function updateSerialBaudNote(force = false): void {
  const now = performance.now();
  if (!force && now < nextSerialBaudPollAt) return;
  nextSerialBaudPollAt = now + SERIAL_BAUD_POLL_INTERVAL_MS;

  const selectedBaudRate = Number(cfgSerialBaud.value);
  const guestBaudRate = host?.serialGuestBaudRate() ?? 0;
  const normalizedGuestBaudRate = normalizeGuestSerialBaudRate(guestBaudRate);
  const mismatch = serialTransport.state === 'connected' &&
    isSerialBaudRateMismatch(selectedBaudRate, guestBaudRate);
  const noteText = mismatch && normalizedGuestBaudRate !== null
    ? t('settingsSerialBaudMismatch', { guestBaudRate: normalizedGuestBaudRate, selectedBaudRate })
    : t('settingsSerialBaudNote');
  const noteKey = `${serialTransport.state}:${selectedBaudRate}:${normalizedGuestBaudRate ?? 'unknown'}:${mismatch}:${noteText}`;
  if (noteKey === lastSerialBaudNoteKey) return;
  lastSerialBaudNoteKey = noteKey;

  serialBaudNoteEl.textContent = noteText;
  serialBaudNoteEl.classList.toggle('status-ng', mismatch);

  const warningKey = mismatch ? `${normalizedGuestBaudRate}:${selectedBaudRate}` : '';
  if (warningKey && warningKey !== lastSerialBaudWarningKey)
    showToast(serialBaudNoteEl.textContent, 8000);
  lastSerialBaudWarningKey = warningKey;
}

function updateSerialUi(): void {
  const browserSupported = serialTransport.isSupported();
  const coreSupported = !host || !host.isInitialized() || host.hasSerialBridge();
  const supported = browserSupported && coreSupported;
  const state = serialTransport.state;
  serialUnsupportedEl.textContent = browserSupported
    ? t('settingsSerialCoreUnsupported')
    : t('settingsSerialUnsupported');
  serialUnsupportedEl.hidden = supported;
  serialControlsEl.hidden = !supported;
  serialStatusEl.textContent = serialStateLabel(state);
  serialStatusEl.className = state === 'connected' ? 'status-ok' : state === 'connecting' ? 'status-bundled' : 'status-ng';
  serialToggleBtn.textContent = state === 'connected' ? t('settingsSerialDisconnect') : t('settingsSerialConnect');
  serialToggleBtn.disabled = state === 'connecting' || !supported;
  serialToggleBtn.setAttribute('aria-disabled', String(state === 'connecting' || !supported));
  serialToggleBtn.setAttribute('aria-busy', String(state === 'connecting'));
  // 接続中のポート設定は Web Serial API から変更できないため、再接続まで固定する。
  cfgSerialBaud.disabled = state === 'connecting' || state === 'connected';
  updateSerialBaudNote(true);
}

async function toggleSerialConnection(): Promise<void> {
  if (serialTransport.state === 'connecting') return;
  if (serialTransport.state === 'connected') {
    host?.setSerialConnected(false);
    await serialTransport.disconnect();
    resetSerialBridge();
    return;
  }
  if (host?.isInitialized() && !host.hasSerialBridge()) {
    showToast(t('settingsSerialCoreUnsupported'), 8000);
    updateSerialUi();
    return;
  }
  const baudRate = Number(cfgSerialBaud.value);
  saveSerialBaudRate(baudRate);
  try {
    resetSerialBridge();
    await serialTransport.connect({ baudRate });
    syncSerialConnectionToCore();
  } catch (error) {
    console.error('Web Serial connection failed', error);
    showToast(`${t('settingsSerialError')}: ${describeError(error)}`, 8000);
  }
}

cfgSerialBaud.addEventListener('change', () => {
  saveSerialBaudRate(Number(cfgSerialBaud.value));
  updateSerialBaudNote();
});
serialToggleBtn.addEventListener('click', () => void toggleSerialConnection());
window.addEventListener('pagehide', (event) => {
  // bfcacheへ退避する場合は同じページへ復帰するため、接続と読み取りタスクを維持する。
  if (event.persisted) return;
  // pagehide では非同期切断を待てないため、先にコア側の接続状態を解除する。
  host?.setSerialConnected(false);
  resetSerialBridge();
  void serialTransport.disconnect();
});

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
  {
    const pauseLabel = t(pausedByUser ? 'toolbarResume' : 'toolbarPause');
    btnPause.title = pauseLabel;
    btnPause.setAttribute('aria-label', pauseLabel);
  }
  pauseOverlayLabelEl.textContent = t('pauseOverlayLabel');
  btnScreenshot.title = t('toolbarScreenshot');
  btnScreenshot.setAttribute('aria-label', t('toolbarScreenshot'));
  updateSpeedButtonUi();
  btnMouseCapture.setAttribute('aria-label', t('toolbarMouseCapture'));
  btnMouseResync.setAttribute('aria-label', t('toolbarMouseResync'));
  updateMouseControls();
  updateFullscreenControl();
  syncInputPanelUi();
  btnPanelKeyboard.title = t('inputPanelSwitchKeyboard');
  btnPanelKeyboard.setAttribute('aria-label', t('inputPanelSwitchKeyboard'));
  btnPanelPad.title = t('inputPanelSwitchPad');
  btnPanelPad.setAttribute('aria-label', t('inputPanelSwitchPad'));
  btnPanelTrackpad.title = t('inputPanelSwitchTrackpad');
  btnPanelTrackpad.setAttribute('aria-label', t('inputPanelSwitchTrackpad'));
  updateAspectControl();
  btnSaveState.title = t('toolbarSaveState');
  btnSaveState.setAttribute('aria-label', t('toolbarSaveState'));
  btnLoadState.title = t('toolbarLoadState');
  btnLoadState.setAttribute('aria-label', t('toolbarLoadState'));
  btnGamepad.title = t('toolbarGamepad');
  btnGamepad.setAttribute('aria-label', t('toolbarGamepad'));
  gamepadDialog.applyStrings();
  refreshVpadSourceLabels();
  inputProfileEditor.applyStrings();
  btnHostKey.title = t('toolbarHostKey');
  btnHostKey.setAttribute('aria-label', t('toolbarHostKey'));
  hostKeyDialog.applyStrings();
  btnSettings.title = t('toolbarSettings');
  btnSettings.setAttribute('aria-label', t('toolbarSettings'));
  btnDiskLibrary.title = t('toolbarDiskLibrary');
  btnDiskLibrary.setAttribute('aria-label', t('toolbarDiskLibrary'));
  btnFileManager.title = t('toolbarFileManager');
  btnFileManager.setAttribute('aria-label', t('toolbarFileManager'));
  btnHelp.title = t('toolbarHelp');
  btnHelp.setAttribute('aria-label', t('toolbarHelp'));
  document.getElementById('btn-lang-text')!.textContent = t('langToggle');
  btnToolbarOverflow.title = t('toolbarMore');
  btnToolbarOverflow.setAttribute('aria-label', t('toolbarMore'));

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

  // SCSI行(SlotId系とは別のScsiElements)。他スロットと違いここに専用ブロックを持たないと
  // ライブラリボタンのaria-labelが言語切替に追従しなかったため、他スロットと同じ場所にまとめる。
  {
    const scsiDrive = t('scsiSlotLabel');
    scsiElements.label.textContent = scsiDrive;
    scsiElements.lamp.setAttribute('aria-label', t('diskLampLabel', { drive: scsiDrive }));
    scsiElements.insertBtn.setAttribute('aria-label', `${scsiDrive} ${t('slotInsert')}`);
    scsiElements.libraryBtn.setAttribute('aria-label', `${scsiDrive} ${t('slotInsertFromLibrary')}`);
    scsiElements.blankBtn.setAttribute('aria-label', `${scsiDrive} ${t('scsiCreateBlank')}`);
    scsiElements.ejectBtn.setAttribute('aria-label', `${scsiDrive} ${t('slotEject')}`);
    scsiElements.downloadBtn.setAttribute('aria-label', `${scsiDrive} ${t('slotDownload')}`);
  }
  updateScsiControls();

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
  document.getElementById('settings-machine-reset-note')!.textContent = t('settingsMachineResetNote');
  document.getElementById('settings-cpuspeed-label')!.textContent = t('settingsCpuSpeedLabel');
  document.getElementById('settings-ramsize-label')!.textContent = t('settingsRamSizeLabel');
  document.getElementById('settings-speed-title')!.textContent = t('settingsSpeedTitle');
  document.getElementById('settings-speed-note')!.textContent = t('settingsSpeedNote');
  document.getElementById('settings-speed-label')!.textContent = t('settingsSpeedLabel');
  document.getElementById('speed-opt-unlimited')!.textContent = t('settingsSpeedUnlimited');
  document.getElementById('settings-serial-title')!.textContent = t('settingsSerialTitle');
  document.getElementById('settings-serial-status-label')!.textContent = t('settingsSerialStatusLabel');
  document.getElementById('settings-serial-baud-label')!.textContent = t('settingsSerialBaudLabel');
  serialUnsupportedEl.textContent = t('settingsSerialUnsupported');
  updateSerialUi();
  settingsCloseBtn.textContent = t('settingsClose');
  setBiosStatus(biosIplStatus, biosIplState);
  setBiosStatus(biosCgStatus, biosCgState);

  document.getElementById('library-title')!.textContent = t('libraryDialogTitle');
  libraryDescriptionEl.textContent = highlightedLibraryGroupId ? t('libraryGroupFocusHint') : t('libraryDialogDescription');
  libraryCloseBtn.textContent = t('libraryDialogClose');
  libraryScsiTitleEl.textContent = t('scsiLibrarySectionTitle');
  libraryScsiDescriptionEl.textContent = t('scsiLibrarySectionDescription');
  if (!libraryBackdrop.classList.contains('hidden')) {
    void refreshLibraryList();
    void refreshScsiLibraryList();
  }

  fileManagerDialog.applyStrings();
}

btnLang.addEventListener('click', () => {
  setLang(getLang() === 'ja' ? 'en' : 'ja');
  applyDocumentStrings();
});

// キーボード入力: canvas にフォーカスがある間だけ捕捉する
canvas.tabIndex = 0;
const physicalPressed = new Set<string>();
// ホストキー(物理キーボード再割り当て)で横取り中の e.code -> press時点で確定した割当。
// keyup側は「今のhostKeyStore/アクティブプロファイル」で再解決せず、必ずこのMapに記録された
// press時点の割当を使って release する(押している最中にプロファイルが切り替わっても、
// sharedKeyInput.press/releaseのretrokが噛み合わなくなる=固着する事故を防ぐため)。
const hostKeyPressed = new Map<string, Binding>();
window.addEventListener('keydown', (e) => {
  if (document.activeElement !== canvas || !shouldAcceptGuestKeyInput()) return;
  // 自前のKeyRepeaterで刻むため、ブラウザ/OS由来のオートリピートはゲストへ渡さない。
  if (e.repeat) {
    e.preventDefault();
    return;
  }
  // ホストキー割当(ジョイスティック等への横取り)経路はここで早期returnするため、
  // 以降のkeyRepeater.start()に到達しない = 連打(リピート)対象にならない。
  const hostBinding = resolveHostKeyBinding(hostKeyStore, e.code);
  if (hostBinding) {
    hostKeyPressed.set(e.code, hostBinding);
    if (hostBinding.kind === 'key') sharedKeyInput.press(`physical:${e.code}`, hostBinding.retrok);
    e.preventDefault();
    return;
  }
  const code = codeToRetrok(e.code);
  if (code === RETROK.UNKNOWN) return;
  const firstPress = !physicalPressed.has(e.code);
  physicalPressed.add(e.code);
  sharedKeyInput.press(`physical:${e.code}`, code);
  // 自前タイマ(KeyRepeater)で刻み、OSごとに異なるキーリピート間隔設定へ依存させない。
  if (firstPress && isRepeatableKey(code)) keyRepeater.start(`physical:${e.code}`, code);
  if (firstPress && code === RETROK.BROWSER_REFRESH) virtualKeyboard.togglePhysicalKanaLock();
  e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  const hostBinding = hostKeyPressed.get(e.code);
  if (hostBinding) {
    hostKeyPressed.delete(e.code);
    if (hostBinding.kind === 'key') sharedKeyInput.release(`physical:${e.code}`, hostBinding.retrok);
    e.preventDefault();
    return;
  }
  if (!physicalPressed.delete(e.code)) return;
  const code = codeToRetrok(e.code);
  if (code === RETROK.UNKNOWN) return;
  keyRepeater.stop(`physical:${e.code}`);
  sharedKeyInput.release(`physical:${e.code}`, code);
  e.preventDefault();
});
/** ホストキー由来の押下記録を全解除する(blur時。押しっぱなし固着の予防、physicalPressed.clear()と同じ思想)。 */
function clearHostKeyPressed(): void {
  for (const [code, binding] of hostKeyPressed) {
    if (binding.kind === 'key') sharedKeyInput.release(`physical:${code}`, binding.retrok);
  }
  hostKeyPressed.clear();
}
window.addEventListener('blur', () => {
  keyRepeater.stopAll();
  physicalPressed.clear();
  clearHostKeyPressed();
});
/**
 * ホストキー由来のjoyビットマスク(ポート0、host.onPollからOR合成する)。padTypeは
 * gamepadStore.joyType[0](TRG3..TRG8のビット位置がパッド種別で変わるため、バーチャルパッドと
 * 同じ考え方)。押している最中に割当が変わっても hostKeyPressed に記録済みの押下時点の割当を
 * そのまま使う(固着防止、resolveHostKeyBinding/joyBitsForPressedCodesのコメント参照)。
 */
function hostKeyJoyBits(): number {
  return joyBitsForPressedCodes(hostKeyPressed.keys(), (code) => hostKeyPressed.get(code), gamepadStore.joyType[0]);
}
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

// 閉ループの計算(加速テーブル・ack待ち・stall判定)そのものは src/mouse-track.ts の
// MouseTracker(純粋クラス、単体テストは test/mouse-track.test.ts)に切り出してある
// (段階移行 手順6後半、docs/STORAGE-SCSI.md参照)。既定経路(このファイル)はそのクラスを
// そのまま呼ぶだけで、旧実装(stepMouseTracking/resyncGuestMouse に直書きしていた計算)と
// 完全に同じ計算になる(切り出しに伴う書き換えをしていない)。
//
// mouseTracker: 既定経路(host = メインスレッドの LibretroHost)専用のインスタンス。
// Worker経路(?worker=1)は Worker 内(src/core-worker.ts)に別インスタンスを持ち、main側は
// 目標比率(desiredRatio)と有効/無効の送信・再同期コマンドの発行・診断表示用のミラーとして
// このインスタンスを使う(実際の閉ループ計算はWorker側が行う。下の
// mirrorMouseTrackTargetForDebug 呼び出し箇所のコメント参照)。
const mouseTracker = new MouseTracker();

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
 *
 * (mouse-track.ts の MouseTracker が内部に同じ表を持つが非公開のため、トラックパッド側の
 * 残差送出用にここでも同じ値を持つ。docs/STORAGE-SCSI.md「境界の原則」参照)。
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

/** 目標移動量(絶対値)に対して、行き過ぎない範囲で最大の送信量を返す。トラックパッドの残差送出で使う。 */
function sendAmountFor(distance: number): number {
  const abs = Math.abs(distance);
  let send = 0;
  for (const [candidate, move] of MOUSE_ACCEL_TABLE) {
    if (move <= abs) send = candidate;
    else break;
  }
  return distance < 0 ? -send : send;
}

/** sendAmountFor() が返した送信量が実際に動かす見込みのドット数(加速テーブルの逆方向)。 */
function predictedMoveFor(send: number): number {
  const abs = Math.abs(send);
  for (const [candidate, move] of MOUSE_ACCEL_TABLE) {
    if (candidate === abs) return send < 0 ? -move : move;
  }
  return 0;
}

function isMouseCaptured(): boolean {
  return document.pointerLockElement === canvas;
}

function isMouseTracking(): boolean {
  return ENABLE_MOUSE_TRACKING && running && !isMouseCaptured();
}

/**
 * 追従モードの1フレーム分の追い込み(閉ループ)。既定経路(host = メインスレッドの
 * LibretroHost)専用。Worker経路の閉ループは src/core-worker.ts の tick() 内で
 * Worker側の mouseTracker が担う(host がWorker経路では常にnullのため、この関数自体が
 * 一度も意味のある処理をしない)。
 */
function stepMouseTracking(): void {
  if (!host) return;
  const result = mouseTracker.step(host, isMouseTracking());
  if (result === 'disabled') showToast(t('mouseTrackUnavailable'));
}

/**
 * 強制的に基準を取り直す(ツールバーの「マウス再同期」)。既定経路は mouseTracker.resync() を
 * 直接呼ぶ。Worker経路は host が無いためここでは何もできず、呼び出し元
 * (btnMouseResync のクリックハンドラ)が urlWorkerMode を見て Worker へコマンドを送る。
 */
function resyncGuestMouse(): void {
  if (!host) return;
  const w = host.avInfo?.baseWidth || canvas.width;
  const h = host.avInfo?.baseHeight || canvas.height;
  mouseTracker.resync(host, { width: w, height: h });
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
  // 追従モードの有効/無効(isMouseTracking())が変わったことをWorkerへ伝える(手順6後半)。
  // 既定経路では何もしない(sendWorkerMouseTrackUpdate内部のurlWorkerModeガード参照)。
  sendWorkerMouseTrackUpdate();
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
  if (!running) return;
  if (isMouseCaptured()) {
    // movementX/Y は CSS ピクセル単位。canvas は拡大表示されるので、ゲスト側の1ドットへ換算する。
    // 4:3表示モードでは表示上の縦横比とcanvasの実解像度比が食い違うため、X/Yを別々の倍率で
    // 換算する必要がある(等倍/整数倍のドット等倍モードではscaleX===scaleYになるので実質同じ)。
    const scaleX = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1;
    const scaleY = canvas.clientHeight > 0 ? canvas.height / canvas.clientHeight : 1;
    applyMouseDelta(e.movementX * scaleX * mouseSensitivity, e.movementY * scaleY * mouseSensitivity);
    return;
  }
  // 追従モード: canvas 内の相対位置(0..1)だけ記録する。既定経路は実際の送信を
  // stepMouseTracking()(loop() 契機)に任せる。Worker経路(手順6後半、2026-08-31実装)は
  // 閉ループ自体がWorker側にあるため、目標比率をここで即座にWorkerへ送る(低頻度の
  // 片道メッセージ。docs/STORAGE-SCSI.md「ワーカー移行 手順6後半」参照)。
  // 前回の欠陥(`if (!host) return;` で Worker経路がここへ一度も届かなかった)の再発防止として、
  // このハンドラ自体は host の有無で早期returnしない(表はdocsの「hostガードの洗い出し」節参照)。
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const ratioX = (e.clientX - rect.left) / rect.width;
  const ratioY = (e.clientY - rect.top) / rect.height;
  mouseTracker.setDesiredRatio(ratioX, ratioY);
  sendWorkerMouseTrackUpdate();
});

// ボタンはキャプチャ中だけゲストへ渡す。
// 非キャプチャ時にも渡すと、キャプチャ開始の右ダブルクリックがそのままゲストに届いてしまい、
// X68000 側のソフトキーボード(ASK68K)が開くなど、意図しない反応を起こす。
canvas.addEventListener('mousedown', (e) => {
  if (!isMouseCaptured()) return;
  if (e.button === 0) applyMouseButton('left', true);
  else if (e.button === 2) applyMouseButton('right', true);
  e.preventDefault();
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 0) applyMouseButton('left', false);
  else if (e.button === 2) applyMouseButton('right', false);
});

// --- バーチャルトラックパッド --------------------------------------------------
// iOS Safari は Pointer Lock 非対応でキャプチャモードが成立しない。バーチャルトラックパッド
// (入力パネルの第3の種類、virtual-trackpad.ts)はその代替として、専用の操作面での指の
// 相対移動をマウス移動量へ変換する。ジェスチャの解釈(タップ/2本指タップ/長押しドラッグ)は
// touch-mouse.ts の純ロジックが受け持ち、ここは CSSピクセル→ゲストのドット数への換算
// (加速テーブルの逆引き含む)と、クリックパルスのタイミング制御だけを行う。
/** クリックパルスの押下時間(ms)。コアは retro_run() 中に1回しかボタンを読まないため、数フレームぶん保持する。 */
const TOUCH_CLICK_PULSE_MS = 100;
/** 連続タップ(ダブルクリック)の押下間隔(ms)。間隔ゼロだと押しっぱなしと区別できない。 */
const TOUCH_CLICK_GAP_MS = 60;
/** クリック待ち行列。tap が来たら積み、フレームループ(stepTouchTrackpad)からパルスにして流す。 */
const touchClickQueue: TouchMouseButton[] = [];
let touchClickBusy = false;
/**
 * 指のCSSピクセル移動量→ゲストのドット数への換算倍率。canvas の表示倍率
 * (canvas.width / canvas.clientWidth)は使わない。トラックパッドは canvas と無関係な
 * 専用の操作面であり、モバイルでは canvas の表示倍率が2倍を超えることがあって、これを
 * そのまま使うと1イベントぶんの移動量が IOCS の加速域(16以上で最大7.5倍)に入って
 * カーソルが飛ぶ(stepMouseTrackingのコメント参照)。固定倍率にすることでこの問題を
 * 構造的に避ける。
 */
const TRACKPAD_SCALE = 1.5;
/** トラックパッド操作中の加速逆補正で生じる送信残差(ドット)。指を離したら捨てる。 */
let touchPadResidX = 0;
let touchPadResidY = 0;

function pumpTouchClickQueue(): void {
  if (touchClickBusy) return;
  const button = touchClickQueue.shift();
  if (button === undefined) return;
  touchClickBusy = true;
  host?.setMouseButton(button, true);
  window.setTimeout(() => {
    host?.setMouseButton(button, false);
    window.setTimeout(() => {
      touchClickBusy = false;
      pumpTouchClickQueue();
    }, TOUCH_CLICK_GAP_MS);
  }, TOUCH_CLICK_PULSE_MS);
}

/** virtual-trackpad.ts からの相対移動(CSSピクセル)をゲストのドット数へ換算して送る。 */
function trackpadMoveBy(dx: number, dy: number): void {
  if (!host) return;
  // キャプチャモードの mousemove と同じ考え方(感度倍率)だが、換算倍率は canvas 表示倍率
  // ではなく TRACKPAD_SCALE 固定(上記コメント参照)。
  touchPadResidX += dx * TRACKPAD_SCALE * mouseSensitivity;
  touchPadResidY += dy * TRACKPAD_SCALE * mouseSensitivity;
  const sendX = sendAmountFor(touchPadResidX);
  const sendY = sendAmountFor(touchPadResidY);
  // 古い絶対位置の目標(マウスの追従モード側)が残っていると閉ループが相対移動と
  // 綱引きするので捨てる。
  mouseTracker.clearDesiredRatio();
  if (sendX === 0 && sendY === 0) return;
  touchPadResidX -= predictedMoveFor(sendX);
  touchPadResidY -= predictedMoveFor(sendY);
  host.addMouseDelta(sendX, sendY);
}

/** ストローク終了(全指離れた/キャンセル/パネルを閉じた)の通知。次のストロークへ残差を持ち越さない。 */
function trackpadStrokeEnd(): void {
  touchPadResidX = 0;
  touchPadResidY = 0;
}

const virtualTrackpad: VirtualTrackpad = createVirtualTrackpad(virtualTrackpadPanel, {
  moveBy: trackpadMoveBy,
  buttonDown: (button) => host?.setMouseButton(button, true),
  buttonUp: (button) => host?.setMouseButton(button, false),
  tap: (button) => touchClickQueue.push(button),
  strokeEnd: trackpadStrokeEnd,
});

/** フレームループから毎フレーム呼ぶ(長押し判定はvirtual-trackpad.tsのstep()、クリックパルスはここ)。 */
function stepTouchTrackpad(): void {
  virtualTrackpad.step(performance.now());
  if (touchClickQueue.length > 0) pumpTouchClickQueue();
}

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
  if (urlWorkerMode) {
    // 閉ループ自体がWorker側にあるため、resync命令をそのまま送るだけ(手順6後半)。
    workerCoreProxy?.sendMouseTrackResync();
  } else {
    resyncGuestMouse();
  }
  showToast(t('mouseResynced'));
});

/**
 * フルスクリーン化の対象はページ全体(document.documentElement)。
 *
 * ネイティブ全画面はその部分木の外にある要素を一切描画しない。かつては .stage を
 * 対象にしていてツールバーが消え、次に .console-card へ移してツールバーは残ったが、
 * バーチャルパッドは sides配置のとき document.body 直下へ出す(左右のデッドスペースへ
 * またがるため)ので、カード対象では必ず対象の外に出てパッドが消えていた
 * (WebNP2 の Android 実機で発覚、2026-08-20。iPhone は Fullscreen API 自体が無く
 * 疑似フルスクリーンへ倒れるのでこの経路を踏まない)。
 * ページ全体を対象にすれば、どこへ reparent しても消えない。
 * アスペクト比の維持・サイズ決定は rescale() (JS側)が getTargetSize() 経由で行う
 * (旧 object-fit:contain の CSS 任せはやめた)。
 */
const fullscreenRootEl = document.documentElement;

function isNativeFullscreen(): boolean {
  return (
    document.fullscreenElement === fullscreenRootEl ||
    (document as any).webkitFullscreenElement === fullscreenRootEl
  );
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

/**
 * 現在ページ側のクロームを畳んで疑似フルスクリーン中かどうか。
 * 見た目を決めるCSSセレクタ自体は body.immersive に一本化したため、この関数は
 * 「Fullscreen API が無いので CSS で代替している」という内部状態の識別にのみ使う
 * (fullscreenchangeが飛んでこない経路なので、ボタンの3分岐ラベル判定に必要)。
 */
function isPseudoFullscreen(): boolean {
  return document.body.classList.contains('pseudo-fullscreen');
}

/**
 * ネイティブ全画面(.console-card)・疑似フルスクリーンのどちらかで「没入モード」中かどうか。
 * body.immersive クラスの有無をそのまま見る単一の判定にすることで、ネイティブ/疑似の
 * 違いをスケール計算(rescale())や表示切り替えの分岐から追い出す。
 */
function isImmersive(): boolean {
  return document.body.classList.contains('immersive');
}

/**
 * requestFullscreen() を呼んでから「通らなかった」と見なすまでの待ち時間(ms)。
 * 実際の全画面遷移は数十msで fullscreenchange が飛ぶので、これより十分短い。
 */
const FULLSCREEN_FALLBACK_MS = 400;

function setFullscreen(makeFullscreen: boolean): void {
  if (makeFullscreen) {
    if (isNativeFullscreen()) return;
    const req =
      fullscreenRootEl.requestFullscreen?.bind(fullscreenRootEl) ??
      (fullscreenRootEl as any).webkitRequestFullscreen?.bind(fullscreenRootEl);
    // requestFullscreen は「メソッドが生えていて document.fullscreenEnabled も true」でも
    // 実行時に通らないことがある(埋め込み webview 等)。nativeFullscreenSupported() のような
    // 静的な能力判定だけでは足りない。以前はここで失敗を黙って無視していたため、
    // そういう環境では全画面ボタンを押しても「何も起きない」状態になっていた。
    //
    // 通らない形は2種類あり、両方を拾う必要がある(どちらも実測):
    //  1. Promise が reject される(ユーザー操作起点でない等) -> catch で拾う
    //  2. Promise が resolve も reject もされないまま放置される -> catch では拾えないので
    //     タイムアウトで拾う(この挙動を埋め込みブラウザで実測した)
    // どちらの場合も、代替として用意してある疑似フルスクリーンへ倒す。
    let settled = false;
    void Promise.resolve(req?.()).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
        togglePseudoFullscreen(true);
      },
    );
    window.setTimeout(() => {
      if (settled || isNativeFullscreen() || isPseudoFullscreen()) return;
      togglePseudoFullscreen(true);
    }, FULLSCREEN_FALLBACK_MS);
  } else if (isNativeFullscreen()) {
    const exit = document.exitFullscreen?.bind(document) ?? (document as any).webkitExitFullscreen?.bind(document);
    void Promise.resolve(exit?.());
  }
}

/** フルスクリーンボタンの見た目(トグル状態)を実際の全画面状態に追従させる。マウスキャプチャボタンと同じ流儀。 */
function updateFullscreenControl(): void {
  const nativeFs = isNativeFullscreen();
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

/**
 * 疑似フルスクリーンを切り替える(ネイティブが使えない/拒否された場合の代替)。
 * ページ側のクロームを畳んで実行画面へ面積を明け渡す。解除操作のため .toolbar は残す。
 */
function togglePseudoFullscreen(on?: boolean): void {
  document.body.classList.toggle('pseudo-fullscreen', on);
  document.body.classList.toggle('immersive', isPseudoFullscreen() || isNativeFullscreen());
  updateFullscreenControl();
  rescale();
}

btnFullscreen.addEventListener('click', () => {
  // 疑似フルスクリーン中は(ネイティブが使える環境かどうかに関わらず)まずそちらを解除する。
  // ネイティブが拒否されて疑似へ倒れた状態から抜けられなくなるのを防ぐ。
  if (isPseudoFullscreen()) {
    togglePseudoFullscreen(false);
    return;
  }
  if (nativeFullscreenSupported(fullscreenRootEl)) {
    setFullscreen(!isNativeFullscreen());
    return;
  }
  // iPhone の WebKit は <video> 以外の Fullscreen API を持たないため、ネイティブ版は
  // 無反応になる。疑似フルスクリーンで代替する。
  togglePseudoFullscreen();
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

// 4:3表示モードの判定・目標サイズ計算(getTargetSize())は src/aspect.ts へ切り出し済み。
// 縮小禁止方針の設計コメントもそちらに移してある。
const ASPECT_MODE_KEY = 'webx68k.aspectMode';

// 既定値の判定(resolveAspectMode)は src/aspect.ts へ切り出し済み。理由もそちらに記載。
function loadAspectMode(): AspectMode {
  return resolveAspectMode(localStorage.getItem(ASPECT_MODE_KEY));
}

let aspectMode: AspectMode = loadAspectMode();

// ?aspect=<4:3|native> : 起動時のみ表示縦横比モードを上書きする(共有URLで推奨環境を再現するため)。
// 意図的に localStorage には保存しない。共有リンクを開いただけで利用者の既定設定が
// 書き換わってしまうと、リンクを踏むたびに意図せず設定が上書きされる事故になるため。
const aspectParamRaw = new URLSearchParams(location.search).get('aspect');
const urlAspectMode = parseAspectModeParam(aspectParamRaw);
if (aspectParamRaw !== null && urlAspectMode === null) {
  console.warn('?aspect= の値が不正です("4:3" または "native" で指定してください)');
} else if (urlAspectMode !== null) {
  aspectMode = urlAspectMode;
}

/** アスペクト比ボタンの見た目(トグル状態)を現在のモードに合わせる。フルスクリーンボタンと同じ流儀。 */
function updateAspectControl(): void {
  const is43 = aspectMode === '4:3';
  btnAspect.classList.toggle('active', is43);
  btnAspect.setAttribute('aria-pressed', is43 ? 'true' : 'false');
  btnAspect.title = is43 ? t('toolbarAspect43') : t('toolbarAspectNative');
  btnAspect.setAttribute('aria-label', btnAspect.title);
  // 4:3化そのものは(フルスクリーン中も含めて)rescale() が getTargetSize() 経由で計算する。
  // ここで stage 要素に付けるクラスは、4:3時だけ image-rendering を補間ありに切り替える
  // 表示用ルール(.stage.aspect-4-3 #screen、style.css 参照)のためのもの。
  stageEl.classList.toggle('aspect-4-3', is43);
}

btnAspect.addEventListener('click', () => {
  aspectMode = aspectMode === '4:3' ? 'native' : '4:3';
  localStorage.setItem(ASPECT_MODE_KEY, aspectMode);
  updateAspectControl();
  rescale();
});

updateAspectControl();

/**
 * canvas の表示倍率(等倍〜整数倍、収まらない場合は端数の縮小)を実測して決める。
 * かつてはフルスクリーン中は CSS 側(.stage:fullscreen #screen の object-fit:contain)に
 * 表示サイズを丸投げして早期returnしていたが、フルスクリーン対象が .stage から
 * .console-card に変わり、中の stage サイズを決めるCSSルールが無くなったため、
 * ネイティブ全画面中もここでサイズを決める必要がある。よって早期returnは廃止し、
 * 没入モード判定(isImmersive())は下の scale 計算の分岐にのみ残す。
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
  const nativeWidth = canvas.width || FALLBACK_NATIVE_WIDTH;
  const nativeHeight = canvas.height || FALLBACK_NATIVE_HEIGHT;
  // 4:3モードでは実解像度(nativeWidth x nativeHeight)そのものではなく、そこから導いた
  // 4:3の目標サイズを基準にフィット計算する(getTargetSize() のコメント参照)。canvas の
  // ピクセルバッファ(width/height属性)自体は実解像度のままなので、目標サイズと縦横比が
  // 違えばこの後 w/h として与えるインラインスタイルが自動的に中身を伸縮させる。
  const target = getTargetSize(aspectMode, nativeWidth, nativeHeight);
  // .stage-frame(領域確保用ラッパ)の目標サイズは、現在の aspectMode に関わらず常に
  // 「4:3時のサイズ」で固定する。これにより等倍⇔4:3の切り替えでも枠自体のサイズが
  // 変わらず、下のツールバー等が押し下げられない(このファイル冒頭のタスク趣旨参照)。
  // fit/scale もこの4:3基準のサイズで計算することで、等倍モードでも4:3時と同じ倍率が
  // 選ばれるようにする(切り替えで画面の大きさが跳ねるのを防ぐ)。
  const reserveTarget = getTargetSize('4:3', nativeWidth, nativeHeight);

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

  const fit = Math.min(availWidth / reserveTarget.width, availHeight / reserveTarget.height);
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
  // 没入モード中(ネイティブ全画面 or 疑似フルスクリーン、isImmersive() 参照)は整数倍への
  // 丸めと MAX_SCALE の上限を外し、fit をそのまま使って画面いっぱいに拡大する
  // (下限 0.3 は維持)。ネイティブ全画面も疑似フルスクリーンも同じ「画面を最大限使う」
  // 見え方に揃えるのが狙いで、フルスクリーン対象が .console-card になった今はどちらも
  // このJS計算がサイズを決める(旧 object-fit:contain へ丸投げする経路は無くなった)。
  const rawScale = isImmersive()
    ? Math.max(0.3, fit)
    : fit >= 1
      ? Math.min(MAX_SCALE, Math.floor(fit))
      : Math.max(0.3, Math.min(1, fit));
  // 端数倍のときは物理ピクセル整数倍へ寄せる(寄せられなければ補間へ落とす)。
  // 非没入かつ fit>=1 の経路は既にCSS整数倍なので触らない(DPRが整数の環境では物理も整数倍)。
  // 没入モードは fit をそのまま使う設計なので、1倍以上でも端数倍になるのが常態であり、
  // ここを通さないと最近傍のまま端数倍になって1ドット幅の線が周期的に間引かれる。
  const fractional = isImmersive() || fit < 1;
  const fitted = fractional ? fitDeviceScale(rawScale, window.devicePixelRatio) : { scale: rawScale, smooth: false };
  const scale = fitted.scale;
  // 補間へ落とす指定。4:3モード側は .stage.aspect-4-3 #screen で常に auto にしてあるので、
  // このクラスが効くのはドット等倍モードのときだけ。
  canvas.classList.toggle('smooth-scaled', fitted.smooth);

  const w = Math.round(target.width * scale);
  const h = Math.round(target.height * scale);
  // .stage-frame は常に4:3基準のサイズを確保する(このファイル冒頭のコメント参照)。
  // aspectMode が 'native' でも同じ scale で計算するため、切り替えで枠のサイズが
  // 変わらない。
  const frameW = Math.round(reserveTarget.width * scale);
  const frameH = Math.round(reserveTarget.height * scale);
  // 上流の getComputedStyle() 由来の値が(NaN ガードをすり抜けるような想定外の経路で)
  // 有限値でなかった場合、"NaNpx" のような無効値をインラインへ書き込むとブラウザはそれを
  // 黙って無視する(=canvas.style.width が未設定のまま残り続ける)。無効な計算結果を
  // そのまま突っ込むより、ここで諦めて CSS 側のフォールバック(width/height:auto)に
  // 任せたほうが安全なので、書き換えずに抜ける。
  if (
    !Number.isFinite(w) ||
    !Number.isFinite(h) ||
    w <= 0 ||
    h <= 0 ||
    !Number.isFinite(frameW) ||
    !Number.isFinite(frameH) ||
    frameW <= 0 ||
    frameH <= 0
  ) {
    return;
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  stageFrameEl.style.width = `${frameW}px`;
  stageFrameEl.style.height = `${frameH}px`;

  // --- バーチャルパッドの配置決定 ---
  // 手順(このファイル冒頭の指示コメントの順序を守る。逆にすると自己参照して発振する):
  // 1. ここまでの w/h/frameH は「パッドのパネル高さを0とした」stageサイズであり、
  //    パッドの有無で変化しない(=パッドを出しても画面が縮まないことがこの時点で保証される)。
  // 2. その結果(frameH)から縦の余りを実測する。既存のreservedHeight計算と同じ実測要素
  //    (ヘッダー/console-footer/仮想キーボード)に加え、ページ最下部のフッタも引く。
  //    パネルモードにすると console-card 内の子要素が1つ増える分の gap も見込んで引いておく
  //    (このgapは今回のパッド用に新しく必要になるもので、上の gapsInCard には含まれていない)。
  const leftover =
    window.innerHeight -
    (pageHeaderEl?.getBoundingClientRect().height ?? 0) -
    frameH -
    consoleFooterEl.getBoundingClientRect().height -
    (kbdVisible ? virtualKeyboardPanel.getBoundingClientRect().height : 0) -
    (pageFooterEl?.getBoundingClientRect().height ?? 0) -
    mainPaddingV -
    gapsInCard -
    cardGap -
    4;
  // 3. 縦の余りが足りない場合に備え、左右の余白も実測しておく(sides判定用)。
  //    横持ちで4:3維持のため画面が縦に制限されると、画面の左右に余白が生まれる。
  //
  //    基準は **.stage** の矩形にすること(.console-card ではない)。
  //    ネイティブ全画面では .console-card が 100vw/100vh に広げられるため、
  //    カード基準で測ると左右の余白が常に 0 になり、**sides 配置が絶対に発動しなくなる**
  //    (Android の横持ち全画面という一番効かせたい場面で効かない、という状態だった)。
  //    .stage 基準なら、ウィンドウ表示でも全画面でも「画面の横に空いている幅」を同じ式で測れる。
  //    左右で幅が違う場合は狭い方で判定する(狭い側に部品がはみ出すのを避けるため)。
  const stageRect = stageEl.getBoundingClientRect();
  // ボックスの縦範囲は .stage の上端〜下端に合わせる(画面と同じ高さの帯にすると
  // 指の位置が自然になるため)。ただし切り欠き/ホームインジケータの下は使わない:
  // index.html の viewport は viewport-fit=cover なので、スタンドアロン表示や
  // Android の全画面ではビューポートが切り欠きの下まで広がり、x:0〜innerWidth の
  // ままボックスを取ると外縁の部品(左のスティック/右端のボタン)が隠れる。
  const sidesBoxes: VpadSideBoxes = vpadSideBoxesFor(
    { x: stageRect.left, y: stageRect.top, w: stageRect.width, h: stageRect.height },
    { width: window.innerWidth, height: window.innerHeight },
    resolveLandscapeInsets(readSafeAreaInsets(), screenAngle()),
  );
  // 4. 判定順は panel → sides → overlay。
  //    - 縦の余り >= VPAD_PANEL_MIN_HEIGHT ならパネルモード(帯の高さは余りと
  //      VPAD_PANEL_MAX_HEIGHT の小さい方)。
  //    - そうでなくても左右の余白が両方とも VPAD_SIDES_MIN_WIDTH 以上あればサイドモード。
  //    - どちらでもなければ従来通りオーバーレイモード。
  // sides にするかどうかは、セーフエリアを引いた後の実際のボックス幅で決める
  // (切り欠きに食われて狭くなった側で判定しないと、部品が縮みすぎたまま sides になる)。
  const sidesMargin = Math.min(sidesBoxes.left.w, sidesBoxes.right.w);
  const nextVpadPlacement: VpadPlacement =
    leftover >= VPAD_PANEL_MIN_HEIGHT ? 'panel' : sidesMargin >= VPAD_SIDES_MIN_WIDTH ? 'sides' : 'overlay';
  const vpadPanelHeight = Math.min(Math.max(leftover, 0), VPAD_PANEL_MAX_HEIGHT);
  // 5. モードが変わったときだけ reparent する(applyVpadPlacement内部で判定)。sidesBoxes は
  //    モード不変でも毎回渡す(ビューポートサイズの変化に追従させるため)。
  applyVpadPlacement(nextVpadPlacement, vpadPanelHeight, sidesBoxes);
}

// visualViewport の resize は購読しない: ピンチズーム操作でも発火するため、ここで再フィット
// すると自前のリサイズがピンチ操作を引き戻してしまう(既知の罠。WebNP2でも同じ理由で避けている)。
window.addEventListener('resize', rescale);
window.addEventListener('orientationchange', rescale);

// ネイティブ全画面の出入りに合わせて body.immersive を付け外し、rescale() を呼び直す。
// かつては canvas.style.width/height の付け外しと、パッドをoverlayへ強制する処理を
// ここに置いていたが、フルスクリーン対象が .console-card になりパッドも画面内に残る
// ようになったため不要になった(サイズ決定・パッド配置ともrescale()に一本化された)。
function onNativeFullscreenChange(): void {
  // ネイティブが遅れて通った場合(タイムアウトで疑似へ倒した後に fullscreenchange が来る)、
  // 疑似との二重掛けを解いてネイティブ側に一本化する。
  if (isNativeFullscreen() && isPseudoFullscreen()) document.body.classList.remove('pseudo-fullscreen');
  document.body.classList.toggle('immersive', isNativeFullscreen() || isPseudoFullscreen());
  rescale();
}
document.addEventListener('fullscreenchange', onNativeFullscreenChange);
document.addEventListener('webkitfullscreenchange', onNativeFullscreenChange);

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
// 対象は .console-card(ツールバーを内包)にしてあるため、Esc を使わずツールバーの
// マウスキャプチャボタンから解除する経路も用意してあるが、Esc 自体の挙動(キャプチャと
// 同時にフルスクリーンも抜ける)はブラウザ実装によるものでこちらからは制御できない。
// この挙動は仕様として README / help.html に明記してある。
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

// ユーザーがツールバーのポーズボタンで止めているか。WebNP2 はコア(SDL2)が内部で
// メインループを持つためコア側にポーズフラグが必要だったが、WebX68k は libretro で
// メインループが JS 側(この下の loop())にあるため、コアの再ビルドは不要で
// host.runFrame() を呼ばないだけでポーズになる。
//
// 意図的に localStorage へは保存しない。ポーズしたままリロードすると、次回起動時に
// コアはポーズされていない(コアの状態はページ再読み込みで消える)のにこのフラグだけ
// 「ポーズ中」を覚えていて画面が理由もわからず止まって見える、という事故を避けるため。
let pausedByUser = false;

// ポーズ中に rAF を使わず待機する間隔。60Hz で空回りさせないための CPU 削減用で、
// あくまで「次に enterLoop を呼ぶまでの待ち時間」であり精度は要らない。
const PAUSE_SLEEP_MS = 200;

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
  // ポーズ中は rAF を張らず setTimeout だけにする。AudioWorklet の tick からも
  // enterLoop() が呼ばれ続けるが、loop() 冒頭の pausedByUser 早期 return が受けるので
  // 二重駆動にはならない。
  if (pausedByUser) {
    timerId = setTimeout(() => enterLoop(), PAUSE_SLEEP_MS);
    return;
  }
  rafId = requestAnimationFrame(() => enterLoop());
  timerId = setTimeout(() => enterLoop(), 32);
}

// ポーズ状態の唯一の更新経路。pausedByUser の書き換えとUI反映(ボタンのアイコン/
// title/aria-label/active クラス、オーバーレイの表示)を1か所に集約する。
//
// WebNP2 では4Hzのポーリングから毎回無条件にボタンの子要素を replaceChildren して
// いたため、mousedown〜mouseup の間に要素が差し替わって click が発火しない不具合が
// あった(WebNP2 src/ui/pause-ui.ts 冒頭のコメント参照)。WebX68k はポーズ状態が
// コアでなく JS 側のこの pausedByUser 一つだけにあるためポーリングが要らない。
// 状態が変わったときだけ DOM を触る設計にし、定期ポーリングは足さないこと。
// またアイコンは <svg> ごと作り直さず <path> の d 属性だけを setAttribute で
// 差し替える(クリック対象の要素そのものを DOM から外さないため)。
function setPaused(next: boolean): void {
  pausedByUser = next;
  btnPause.classList.toggle('active', pausedByUser);
  btnPauseIcon.setAttribute('d', pausedByUser ? 'M7 4l13 8-13 8z' : 'M8 5v14 M16 5v14');
  const label = t(pausedByUser ? 'toolbarResume' : 'toolbarPause');
  btnPause.title = label;
  btnPause.setAttribute('aria-label', label);
  pauseOverlay.classList.toggle('hidden', !pausedByUser);
  if (!pausedByUser) {
    // 200ms の setTimeout を待たせず即座にループを再開させる。
    cancelScheduled();
    enterLoop();
  }
}

btnPause.addEventListener('click', () => {
  if (btnPause.disabled) return;
  setPaused(!pausedByUser);
});
// 再開はこのボタンからのみ行う(オーバーレイの余白クリックでは再開しない。誤操作防止。
// WebNP2 6d7dbe7 と同じ判断)。
btnPauseOverlayResume.addEventListener('click', () => setPaused(false));

// アクセスランプ: コアが実際にディスクを読み書きしたフレームだけ点灯させる。
// 単純にそのフレームだけだと視認しづらいため、直近アクセスから ACCESS_GLOW_MS の間は
// 点灯を保持する(残光)。既定(アクセスなし)は枠だけの消灯状態。
const ACCESS_GLOW_MS = 120;
let lastAccessAt: Record<SlotId, number> = { fdd0: -Infinity, fdd1: -Infinity, hdd: -Infinity };

function resetAccessLamps(): void {
  lastAccessAt = { fdd0: -Infinity, fdd1: -Infinity, hdd: -Infinity };
  for (const slot of SLOT_IDS) slotElements[slot].lamp.classList.remove('active');
}

/** アクセスランプの残光管理そのもの(値の出所は問わない)。既定経路(pollDiskAccess、
 * host.readDiskAccess()を毎フレーム読む)とWorker経路(frame eventのdisk.access、手順5・7)の
 * 両方から呼べるよう切り出す。 */
function applyDiskAccess(
  now: number,
  access: { fddReading: boolean; fddDrive: number; hddAccessing: boolean },
): void {
  if (access.fddReading) {
    if (access.fddDrive === 0) lastAccessAt.fdd0 = now;
    else if (access.fddDrive === 1) lastAccessAt.fdd1 = now;
  }
  if (access.hddAccessing) lastAccessAt.hdd = now;

  for (const slot of SLOT_IDS) {
    const lit = now - lastAccessAt[slot] < ACCESS_GLOW_MS;
    slotElements[slot].lamp.classList.toggle('active', lit);
  }
}

/** 既定経路(メインスレッドの host)専用。Worker経路(?worker=1)では host が常にnullなので、
 * 代わりに frame event の disk.access を直接 applyDiskAccess() へ渡す(下のbootWorkerCore参照)。 */
function pollDiskAccess(now: number): void {
  if (!host) return;
  applyDiskAccess(now, host.readDiskAccess());
}

// --- ディスクのオートセーブ ---
// px68k はゲストの書き込みを、FDD ならコアのメモリ上のイメージ、HDD なら FS 上のファイルに
// しか持たない。何もしないとページを離れた時点で消えるため(ゲーム内セーブが次回に残らない)、
// fork 側に足した書き込み専用のダーティフラグを見て、静かなタイミングでライブラリへ書き戻す。
const AUTOSAVE_POLL_MS = 1000;
// FDD の吸い出しは Eject を挟む=ゲストにはメディア交換として見えるため、読み書きの最中に
// やるとソフトが転ぶ。アクセスランプが消えてこの時間が経つまで待つ。
const FDD_QUIET_MS = 1500;
// HDD は 40MB 級になるので、書き込みが続いている間も保存間隔を空ける。
const HDD_MIN_INTERVAL_MS = 10000;

let lastAutoSaveCheckAt = 0;
let lastHddSaveAt = -Infinity;
let autoSaveRunning = false;

/** ファイル転送ダイアログが開いている間は、同じイメージを両側から書き換えないよう触らない。 */
function isFileManagerOpen(): boolean {
  return fileManagerRoot.querySelector('.fm-modal-backdrop:not(.hidden)') !== null;
}

// ディスクの吸い出しロジック本体は src/disk-persist.ts へ切り出した(DOM/wasm非依存。
// restartCore() が flushAll → teardown+boot の「順序」を壊さないことを vitest で検証するため)。
// ここでの各依存は main.ts 側の実体(host/slots等)への薄いアダプタ。
const diskPersistence = createDiskPersistence(
  {
    getSlot: (slot) => slots[slot],
    setSlot: (slot, entry) => {
      slots[slot] = entry;
    },
    isLive: () => host !== null && running,
    clearDirty: (slot) => {
      const drive = fddDriveOf(slot);
      host!.clearDirty(drive === null ? { hdd: true } : { fddDrive: drive });
    },
    readLiveImage: (slot) => readLiveSlotImage(slot),
    saveDisk: (args, probeContext) => saveDisk(args, probeContext),
    readDirtyState: () => host!.readDirtyState(),
    fddDriveOf: (slot) => fddDriveOf(slot),
    onSaved: () => {
      if (!libraryBackdrop.classList.contains('hidden')) void refreshLibraryList();
    },
    now: () => Date.now(),
    // 目的B「IndexedDBへのディスク全量書出し」の計測(src/storage-probe.ts / src/disk-store.ts
    // が使う)。旧 persistSlotToLibrary() の bytesReadyAtMs と同じ条件・タイミングで作る。
    buildProbeContext: (slot) =>
      import.meta.env.DEV ? { slot, bytesReadyAtMs: performance.now() } : undefined,
  },
  SLOT_IDS,
);

/**
 * スロットの現在の内容(ゲストの書き込み反映後)をディスクライブラリへ書き戻す。
 * 本体は src/disk-persist.ts。ここは既存呼び出し元(ejectSlot/pollAutoSave等)向けの薄いラッパ。
 */
async function persistSlotToLibrary(slot: SlotId): Promise<boolean> {
  return diskPersistence.persistSlot(slot);
}

/**
 * 全スロットを即座に書き戻す(排出・コア再起動・ページ離脱の直前用)。
 * 本体は src/disk-persist.ts。
 */
function flushAllSlots(): void {
  diskPersistence.flushAll();
}

function pollAutoSave(now: number): void {
  // 検証ハーネス専用の故障注入(dev限定・既定off)。docs/STORAGE-SCSI.md「末端の永続化検証」参照。
  if (urlDebugDisableAutosave) return;
  if (!host || !running || autoSaveRunning) return;
  if (now - lastAutoSaveCheckAt < AUTOSAVE_POLL_MS) return;
  lastAutoSaveCheckAt = now;
  if (isFileManagerOpen()) return;

  const dirty = host.readDirtyState();
  const targets: SlotId[] = [];
  for (const slot of ['fdd0', 'fdd1'] as const) {
    const drive = fddDriveOf(slot)!;
    if ((dirty.fddMask & (1 << drive)) === 0) continue;
    if (now - lastAccessAt[slot] < FDD_QUIET_MS) continue;
    targets.push(slot);
  }
  if (dirty.hdd && now - lastHddSaveAt >= HDD_MIN_INTERVAL_MS) targets.push('hdd');
  if (targets.length === 0) return;

  autoSaveRunning = true;
  void (async () => {
    try {
      for (const slot of targets) {
        const saved = await persistSlotToLibrary(slot);
        if (saved && slot === 'hdd') lastHddSaveAt = performance.now();
      }
    } finally {
      autoSaveRunning = false;
    }
  })();
}

// --- Worker経路(?worker=1)のオートセーブ・flush(手順8) --------------------------
//
// 既定経路のpersistSlotToLibrary/flushAllSlots/pollAutoSaveは「host.readDirtyState()で
// 読む→readLiveSlotImage()で吸い出す→host.clearDirty()で消す」の3ステップを直接呼んでいるが、
// これはhostが常にnullのWorker経路では最初から動かない(!hostで早期return)。
// Worker経路はWorkerCoreProxy#captureDirtyMedia()(1コマンドで読み出し+dirtyクリアを完結、
// src/core-worker.ts の handleHotSwapFdd/handleCaptureDirtyMedia、
// src/worker-dirty-capture.ts 参照)を使って同じ役割を果たす。

/** Worker側のframe eventが最後に伝えてきたdirty状態(コア本体+影のフラグの合成済み)。
 * 既定経路のhost.readDirtyState()ポーリングに相当する値をここに保持する
 * (bootWorkerCoreのproxy.setEventHandler内で毎frame更新する)。 */
let workerLastDirty: { fddMask: number; hdd: boolean } = { fddMask: 0, hdd: false };

/**
 * captureDirtyMedia()が返した1スロットぶんの内容をライブラリへ書き戻す。
 * 永続化(saveDisk)に失敗した場合、Worker側へmarkDirty()を送って汚れフラグを立て直す
 * (「永続化失敗時の再dirty化」。docs/STORAGE-SCSI.md「ワーカー移行 手順8」参照)。
 * markDirty()はfire-and-forgetでよい(応答を待つ必要が無い。次のpollWorkerAutoSaveの
 * frame eventで結果が見える)。
 */
async function persistCapturedSlot(slot: SlotId, bytes: ArrayBuffer | null): Promise<boolean> {
  const pending = slots[slot];
  if (!bytes || !pending) return false;
  const { sourceKey } = pending;
  if (!sourceKey || sourceKey === BUNDLED_DISK_SOURCE_KEY) return false;
  const data = new Uint8Array(bytes);
  try {
    await saveDisk({ sourceKey, name: pending.name, bytes: data, savedAt: Date.now() });
  } catch (err) {
    console.error('ディスクライブラリへの書き戻しに失敗しました。', err);
    void workerCoreProxy?.markDirty({ slots: [slot] });
    return false;
  }
  // 待っている間に排出・差し替えが起きているかもしれないので、同じディスクのままの
  // ときだけスロット側も更新する(既定経路のpersistSlotToLibraryと同じ配慮)。
  if (slots[slot]?.sourceKey === sourceKey) slots[slot] = { ...slots[slot]!, data };
  if (!libraryBackdrop.classList.contains('hidden')) void refreshLibraryList();
  return true;
}

/** 指定スロットをcaptureDirtyMedia()で不可分に捕獲し、順にライブラリへ書き戻す。 */
async function persistWorkerSlots(targetSlots: SlotId[]): Promise<void> {
  if (!workerCoreProxy || targetSlots.length === 0) return;
  let result: { captured: Array<{ slot: SlotId; bytes: ArrayBuffer | null }> };
  try {
    result = await workerCoreProxy.captureDirtyMedia({ slots: targetSlots });
  } catch (err) {
    console.error('Worker経路のダーティキャプチャに失敗しました。', err);
    return;
  }
  for (const item of result.captured) {
    await persistCapturedSlot(item.slot, item.bytes);
  }
}

/**
 * persistSlotToLibrary()のWorker経路版(1スロットを即座に強制captureDirtyMedia()し、
 * ライブラリへ書き戻す。既定経路のpersistSlotToLibrary()と同じ「dirty状態に関わらず
 * 現在の内容を強制的に書き戻す」意味論)。
 *
 * 2026-08-31追記(コーディネータ指摘への対応): `storageProbeSaveSlot`(下の
 * __webx68kDebug 参照)は元々`persistSlotToLibrary(slot)`に直結していたため、hostが
 * 常にnullのWorker経路では常にfalseを返すだけで、実際には何も試みていなかった
 * (「未対応」でも「無効」でもなく、無言で「失敗」を偽装していた)。この関数を新設し、
 * Worker経路でも実際にcaptureDirtyMedia経由の永続化を試みたうえでtrue/falseを返すように
 * した(scripts/verify-disk-persistence.mjs による末端検証、および手動デバッグの両方で
 * Worker経路の永続化を直接確認できるようにするため)。
 */
async function persistSlotToLibraryWorker(slot: SlotId): Promise<boolean> {
  if (!workerCoreProxy || !running) return false;
  const pending = slots[slot];
  if (!pending) return false;
  let result: { captured: Array<{ slot: SlotId; bytes: ArrayBuffer | null }> };
  try {
    result = await workerCoreProxy.captureDirtyMedia({ slots: [slot] });
  } catch (err) {
    console.error('Worker経路のダーティキャプチャに失敗しました(storageProbeSaveSlot)。', err);
    return false;
  }
  const entry = result.captured.find((c) => c.slot === slot);
  if (!entry || !entry.bytes) return false; // 未マウント等、保存対象が無い。
  return persistCapturedSlot(slot, entry.bytes);
}

/** flushAllSlots()のWorker経路版。既定経路と違い実際にpostMessageの往復を伴うため、
 * 呼び出し元がawaitできる形にしてある(restartCore()等、書き戻し完了を待ちたい場面向け)。
 * 「終了flushはあくまで保険で、主役は定期保存」という既定経路の設計方針は変えない
 * (このawaitできる形も、離脱時イベントへの依存を増やす意図ではなく、restartCore()が
 * コアを破棄する前に書き戻しを完走させたいという既存の要請に応えるためのもの)。 */
function flushAllSlotsWorker(): Promise<void> {
  if (!workerCoreProxy) return Promise.resolve();
  const dirty = workerLastDirty;
  const targets: SlotId[] = [];
  for (const slot of SLOT_IDS) {
    const drive = fddDriveOf(slot);
    const isDirty = drive === null ? dirty.hdd : (dirty.fddMask & (1 << drive)) !== 0;
    if (isDirty) targets.push(slot);
  }
  return persistWorkerSlots(targets);
}

let workerAutoSaveRunning = false;
let workerLastAutoSaveCheckAt = 0;

/** pollAutoSave()のWorker経路版。既定経路と同じ間隔・静穏条件(FDD_QUIET_MS/
 * HDD_MIN_INTERVAL_MS)を使う。bootWorkerCoreのframe eventハンドラから毎フレーム呼ぶ
 * (Worker経路にはloop()に相当する周期処理が無いため、frame eventの到着そのものを
 * 周期のトリガに使う。既定経路のpollDiskAccess()呼び出しと同じ考え方)。 */
function pollWorkerAutoSave(now: number): void {
  // 検証ハーネス専用の故障注入(dev限定・既定off)。docs/STORAGE-SCSI.md「末端の永続化検証」参照。
  if (urlDebugDisableAutosave) return;
  if (!workerCoreProxy || !running || workerAutoSaveRunning) return;
  if (now - workerLastAutoSaveCheckAt < AUTOSAVE_POLL_MS) return;
  workerLastAutoSaveCheckAt = now;
  if (isFileManagerOpen()) return;

  const dirty = workerLastDirty;
  const targets: SlotId[] = [];
  for (const slot of ['fdd0', 'fdd1'] as const) {
    const drive = fddDriveOf(slot)!;
    if ((dirty.fddMask & (1 << drive)) === 0) continue;
    if (now - lastAccessAt[slot] < FDD_QUIET_MS) continue;
    targets.push(slot);
  }
  if (dirty.hdd && now - lastHddSaveAt >= HDD_MIN_INTERVAL_MS) targets.push('hdd');
  if (targets.length === 0) return;

  workerAutoSaveRunning = true;
  void (async () => {
    try {
      await persistWorkerSlots(targets);
      if (targets.includes('hdd')) lastHddSaveAt = performance.now();
    } finally {
      workerAutoSaveRunning = false;
    }
  })();
}

// SCSI(OPFS)の明示flush依頼(取りこぼしの窓の是正、docs/STORAGE-SCSI.md参照)。
// 本命は src/scsi-opfs.ts 側のデバウンスで、ここはページ離脱イベントに乗せた上積み
// (ページが破棄される瞬間の postMessage が届く保証は無いため、これで確実というわけではない)。
// Worker経路(OPFSハンドルはWorker内にしか無い)のときだけ意味がある。
function flushScsiOnLeave(): void {
  if (urlWorkerMode) workerCoreProxy?.sendFlushScsi();
}

// ページ離脱時の保険。beforeunload/unload は非同期処理を完走できず、モバイル Safari では
// そもそも発火しないことがあるため、最後に信頼できる visibilitychange(hidden) で叩く。
// ただし主役はあくまで上の定期保存で、こちらは取りこぼしを拾うだけ。
// SCSI(OPFS)の明示flushもここに相乗りさせる(同じ「離脱の合図」を使うだけの別用途)。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (urlWorkerMode) void flushAllSlotsWorker();
    else flushAllSlots();
    flushScsiOnLeave();
  }
});

// visibilitychange(hidden)だけでは拾えない離脱経路の上積み(pagehide/freeze)。
// SCSI(OPFS)の明示flush専用(FDD/HDDの定期保存は上のvisibilitychangeが担う)。
window.addEventListener('pagehide', flushScsiOnLeave);
document.addEventListener('freeze', flushScsiOnLeave);

// iOS はアプリ切替/画面ロックで AudioContext を suspend し、復帰時に自動では
// 再開しない。フォアグラウンド復帰のたびに running でなければ resume を試みる。
// 上の保存用リスナとは用途が別のため混ぜず、新規に登録する。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && audio?.context?.state !== 'running') {
    audio?.resume();
  }
});

// 開発時デバッグ用: 音声遅延(キュー滞留秒)とコアの現在 fps をコンソールから覗けるようにする。
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__webx68kDebug = {
    // Worker経路(?worker=1)はhostが常にnullのため、その場合だけworkerAvInfoへ
    // フォールバックする(既定経路はhost.avInfoが既に設定されるため、この分岐は通らない)。
    stat: () => ({ queuedSec: audio?.queuedSeconds ?? null, fps: host?.avInfo?.fps ?? workerAvInfo?.fps ?? null }),
    // 計測環境記録(scripts/measure-env.mjs)用。AudioContext未生成ならnull。
    audioEnv: () => audio?.audioEnv() ?? null,
    // マウス閉ループ追従(手順6後半)のデバッグフック。captured/tracking/ratio/sensitivity は
    // 両経路とも main側の値をそのまま返す(pointer lock・ENABLE_MOUSE_TRACKING・
    // 直近の目標比率はmain側にしかない/両経路で共通)。pending/cursor/core だけが経路で
    // 分かれる: 既定経路は host から同期で直接読む(従来どおり)。Worker経路は
    // keyBufProbeと同じ有効化フラグ(workerKeyBufProbeWanted)に相乗りしたframe event
    // (workerLastMouseTrackProbe)から同期のまま切り出す(Workerへ往復問い合わせしない)。
    // keybuf()と同じ作法で、「未対応(urlWorkerModeでない)」と区別できるよう
    // workerProbeDisabled/workerProbePendingを無言のnullに埋没させない。
    mouse: () => {
      const base = {
        captured: isMouseCaptured(),
        tracking: isMouseTracking(),
        ratio: { x: mouseTracker.ratioX, y: mouseTracker.ratioY },
        sensitivity: mouseSensitivity,
      };
      if (urlWorkerMode) {
        if (!workerKeyBufProbeWanted) {
          return { ...base, pending: null, cursor: null, core: null, workerProbeDisabled: true as const };
        }
        if (!workerLastMouseTrackProbe) {
          return { ...base, pending: null, cursor: null, core: null, workerProbePending: true as const };
        }
        return {
          ...base,
          pending: workerLastMouseTrackProbe.pending,
          cursor: workerLastMouseTrackProbe.cursor,
          core: workerLastMouseTrackProbe.core,
        };
      }
      return {
        ...base,
        pending: host?.hasPendingMouseDelta() ?? null,
        cursor: host?.readGuestCursor() ?? null,
        core: host?.readMouseState() ?? null,
      };
    },
    // Pointer Lock を経由せずに相対移動/ボタンを注入する。自動テスト用で、
    // 将来の MCP ブリッジ(mouse_move 相当)もこの経路をそのまま使う想定。
    peek: (addr: number) => host?.peekWord(addr) ?? null,
    // 調査用(2026-09-04、docs/STORAGE-SCSI.md参照): console/log_cbを経由しない
    // SCSI要求カウンタ。「本当にSCSI要求が来なくなったか」をログの取りこぼしや
    // 上限とは無関係に確かめる用。Worker経路(urlWorkerMode)では host が常にnullのため、
    // mouse()と同じ作法でworkerLastScsiDebugProbe(frame event相乗り、
    // keybufProbeEnable(true)で有効化)へフォールバックする。
    scsiDebug: () => (urlWorkerMode ? workerLastScsiDebugProbe : host?.scsiDebugCounters()) ?? null,
    moveMouse: (dx: number, dy: number) => applyMouseDelta(dx, dy),
    mouseButton: (button: 'left' | 'right', down: boolean) => applyMouseButton(button, down),
    // 各ポートの解決済みRetroPadビットマスクと、解決前の生の入力(pressed/axes)を返す。
    // ヘッドレスでの検証用(ブラウザUIを開かなくても割当が効いているか確認できる)。
    //
    // bits は host.onPoll が実際に setJoyState() へ渡すのと同じ値にすること
    // (= ポート0はバーチャルパッドのビットもORした後の値)。ここが「物理パッドぶんだけ」に
    // なっていると、バーチャルパッドの割当を調べているつもりで別の値を見ることになり、
    // 「配線したのに0のまま」という誤った結論を導く。観測する値は必ず末端へ送る値と揃える。
    joy: () => {
      const pads = gamepadsByPort();
      const [rawBits0, bits1] = pollBitsByPort(pads);
      const vpadBits = virtualPad.getJoyBits();
      const keyboardBits = hostKeyJoyBits();
      const bits0 = rawBits0 | vpadBits | keyboardBits;
      const rawOf = (pad: Gamepad | null) =>
        pad === null
          ? null
          : {
              id: pad.id,
              index: pad.index,
              buttons: Array.from(pad.buttons, (b) => b.pressed),
              axes: Array.from(pad.axes),
            };
      return {
        port0: { bits: bits0, raw: rawOf(pads[0]), physicalBits: rawBits0, vpadBits, keyboardBits },
        port1: { bits: bits1, raw: rawOf(pads[1]) },
      };
    },
    // 目的B(docs/STORAGE-SCSI.md)「IndexedDBへのディスク全量書出し」「起動時のRAM展開」専用フック。
    // scripts/measure-disk-save.mjs / scripts/measure-ram-expansion.mjs から呼ぶ。
    // storageProbe.enabled を立てたときだけ各所の追加計測コードが動く(既定off)。
    storageProbeEnable: (enabled: boolean) => {
      storageProbe.enabled = enabled;
    },
    storageProbeReset: () => storageProbe.reset(),
    storageProbeRead: () => ({
      diskSaves: storageProbe.diskSaves,
      ramExpansions: storageProbe.ramExpansions,
      libraryLoads: storageProbe.libraryLoads,
    }),
    // IndexedDB全量書出しの測定系検証: 次回のputだけtx.abort()させる。
    storageProbeAbortNextPut: () => {
      storageProbe.abortNextPut = true;
    },
    // 起動時RAM展開の測定系検証: 次回のMEMFS writeFile()だけ故障注入する。
    storageProbeSetNextRamFault: (fault: 'skip-write' | 'truncate-tail' | 'corrupt-checksum' | null) => {
      storageProbe.nextRamFault = fault;
    },
    // 指定スロットを即座にライブラリ(IndexedDB)へ書き戻す。既定経路はpersistSlotToLibrary、
    // Worker経路はcaptureDirtyMedia経由のpersistSlotToLibraryWorkerを叩く(手順8、
    // 2026-08-31。以前はurlWorkerModeを見ずpersistSlotToLibraryへ直結しており、hostが
    // 常にnullのWorker経路では無条件にfalseを返すだけで実際には何も試みていなかった)。
    // 戻り値は保存できたか(スロットが空/未マウントならfalse)。
    storageProbeSaveSlot: (slot: SlotId) =>
      urlWorkerMode ? persistSlotToLibraryWorker(slot) : persistSlotToLibrary(slot),
    // ライブラリ(IndexedDB)のディスクを指定スロットへ読み込む(insertFromLibraryを直接叩く)。
    storageProbeLoadFromLibrary: (sourceKey: string, slot: SlotId) => insertFromLibrary(sourceKey, slot),
    // ライブラリから指定キーを削除する(次回のstorageProbeSaveSlotを「初回追加」にするための
    // 測定用リセット。deleteDiskはUI操作を経由すると確認ダイアログ等が絡むため直接叩く)。
    storageProbeDeleteFromLibrary: (sourceKey: string) => deleteDisk(sourceKey),
    // 起動前にスロットを空にする(ejectSlotを直接叩く)。IndexedDB getを起動時RAM展開の
    // 測定に含めるため、ブランク作成直後の「メモリに載ったまま」状態を一度払い落とす用途。
    storageProbeEjectSlot: (slot: SlotId) => ejectSlot(slot),
    // ライブラリ一覧(sourceKey/name/size)を返す。作成直後のブランクディスクのキーを
    // 拾うのに使う。
    storageProbeListLibrary: () => listDisks(),

    // TVRAM の文字画面をテキストで読む(ゲームパッドのキー割当検証等、末端(ゲスト側の受信結果)を
    // 実測するためのフック。?bridge=1 のMCPブリッジと同じ host.readTextScreen() を使う)。
    //
    // 2026-08-31追記(リセット復帰の欠陥調査で発見): `coreProxy?.readTextScreen() ?? ...` は
    // coreProxyがnull/undefinedのときしかフォールバックしない。Worker経路では
    // `coreProxy = proxy`(bootWorkerCore()冒頭、new WorkerCoreProxy()直後)から
    // `await proxy.init(...)`完了までの間、coreProxyは非nullだが対応するWorkerの
    // initializeはまだ完了していない。この窓でscreenText()を呼ぶと(scripts/verify-*.mjsの
    // ポーリングが典型例。reference_webx68k_headless_driving.md参照)
    // coreProxy.readTextScreen()がreject(WORKER側の「initialize が完了していません」)し、
    // `??`はrejectしたPromiseそのものをすり抜けさせる(Promiseオブジェクト自体はnullish
    // ではないため)ため、呼び出し元で無言のunhandled rejectionになる(実測:
    // scripts/verify-reset-persistence.mjsでpageerrorとして観測)。catchして安全側の
    // nullへ倒す。
    screenText: () => coreProxy?.readTextScreen().catch(() => null) ?? Promise.resolve(null),
    // KeyBuf(wasm内128バイトリングバッファ)の書き込みポインタと指定範囲を読む。
    // 計測スクリプト(scripts/measure-key.mjs)がブラウザ経路の末端到達を検証するためのフック。
    //
    // 既定経路(urlWorkerMode===false)は従来どおり host.readKeyBufWindow() を直接呼ぶ同期
    // 呼び出しで、呼ばれたときだけHEAPを読む受動的なAPI(毎フレーム処理には一切関与しない)。
    // 移行前基準(4.3〜4.9ms、docs/STORAGE-SCSI.md「移行前基準の確定」)はこの経路で取られて
    // いるため、ここは一切変更しない。
    //
    // Worker経路(urlWorkerMode===true)はhostが常にnullで直接読めない。async化して
    // Workerへ往復問い合わせすると、その遅延が上記の主指標にそのまま乗ってしまうため
    // (docs「KeyBufプローブのWorker対応」参照)採用しない。代わりに直近のframe eventで
    // 受け取ったスナップショット(workerLastKeyBufProbe)から**同期のまま**切り出す。
    // 戻り値は3通りに分かれ、呼び出し側(計測スクリプト)が「未対応(既定経路の古いwasm)」と
    // 「Worker経路でプローブ未有効化」を無言のnullで混同しないようにしてある:
    //   - { writePointer, bytes }        … 通常(既定経路、またはWorker経路で受信済み)
    //   - null                            … 既定経路のみ: exportの無い古いwasm
    //   - { workerProbeDisabled: true }   … Worker経路: keybufProbeEnable(true)未呼び出し
    //   - { workerProbePending: true }    … Worker経路: 有効化直後でまだ1フレームも未受信
    keybuf: (start: number, count: number) => {
      if (urlWorkerMode) {
        if (!workerKeyBufProbeWanted) return { workerProbeDisabled: true as const };
        if (!workerLastKeyBufProbe) return { workerProbePending: true as const };
        return sliceKeyBufSnapshot(workerLastKeyBufProbe, start, count);
      }
      return host?.readKeyBufWindow(start, count) ?? null;
    },
    // KeyBufプローブ(Worker経路専用)の有効化フック。workerTickProbeEnableと同じ作法で、
    // 起動前に呼んでも(proxyがまだ無くても)意思だけ記録し、次の起動で即有効化される
    // (bootWorkerCore()のworkerKeyBufProbeWanted分岐参照)。既定経路では何もしない
    // (host.readKeyBufWindow()は常時受動的で、有効化操作を必要としない)。
    // Worker経路(urlWorkerMode===true)ではWorker側のKeyBufプローブ+帰属計測(frame event
    // 相乗り方式)を、既定経路(urlWorkerMode===false)ではhost.readKeyBufWindow()自体は
    // 常時受動的で有効化不要だが、帰属計測(注入/観測をフレーム数で切り分ける、Worker経路と
    // 同じ定義。src/keybuf-attribution.ts参照)専用のカウンタ(keybufAttributionProbe、
    // DEV限定・既定off)をここで一緒に有効化/リセットする(2026-08-31、両経路対応)。
    keybufProbeEnable: (enabled: boolean) => {
      if (urlWorkerMode) {
        workerKeyBufProbeWanted = enabled;
        if (!enabled) workerLastKeyBufProbe = null;
        // 帰属計測もこの有効化区間からやり直す(前回の有効化区間の値を持ち越さない。
        // src/core-worker.tsのenable時リセットと対にしてある)。
        workerLastKeyBufWriteFrameNo = null;
        workerLastInputSendFrameNo = null;
        workerLastInputApplyFrameNo = null;
        workerCoreProxy?.devPostRawMessage({
          kind: '__devKeyBufProbe',
          action: enabled ? 'enable' : 'disable',
        });
        return;
      }
      keybufAttributionProbe.enabled = enabled;
      keybufAttributionProbe.reset();
    },
    // 帰属計測(2026-08-31訂正、2026-08-31両経路対応、2026-08-31再訂正
    // 「帰属の定義の誤りと訂正」、docs/STORAGE-SCSI.md参照)。
    // 「keydown発生→updateInput送信」(注入)と「KeyBufへの書き込み→mainが知る」(観測)を
    // フレーム数で切り分けるための読み取り専用フック。scripts/measure-key.mjsが使う。
    // urlWorkerModeで経路を判定し、それぞれの実体(Worker経路はworkerLastFrameNo系、
    // 既定経路はkeybufAttributionProbe)を同じ形({inputSendFrameNo, applyFrameNo,
    // writeFrameNo, currentFrameNo, trueInjectionFrames, transmissionStalenessFrames})で
    // 返す。既定経路のcurrentFrameNoはkeybufAttributionProbe.frameNoをそのまま返す
    // (メインスレッド上の同期呼び出しなので、Worker経路のようなpostMessage往復による
    // 遅延は原理的に発生しない)。
    //
    // trueInjectionFrames/transmissionStalenessFramesはsrc/keybuf-attribution.tsの
    // computeAttributionBreakdown()(純粋関数、両経路共通)で計算する。旧来の
    // 「writeFrameNo - inputSendFrameNo」という単純な差分は、Worker経路では
    // inputSendFrameNo(main視点の古い値)が混入しており既定経路と同じ量になっていな
    // かった(旧定義の誤り。訂正の経緯はdocs参照)。
    keybufAttribution: () => {
      if (urlWorkerMode) {
        const breakdown = computeAttributionBreakdown(
          workerLastInputSendFrameNo,
          workerLastInputApplyFrameNo,
          workerLastKeyBufWriteFrameNo,
        );
        return {
          inputSendFrameNo: workerLastInputSendFrameNo,
          applyFrameNo: workerLastInputApplyFrameNo,
          writeFrameNo: workerLastKeyBufWriteFrameNo,
          currentFrameNo: workerLastFrameNo,
          trueInjectionFrames: breakdown.trueInjectionFrames,
          transmissionStalenessFrames: breakdown.transmissionStalenessFrames,
        };
      }
      const breakdown = computeAttributionBreakdown(
        keybufAttributionProbe.inputSendFrameNo,
        keybufAttributionProbe.applyFrameNo,
        keybufAttributionProbe.tracker.writeFrameNo,
      );
      return {
        inputSendFrameNo: keybufAttributionProbe.inputSendFrameNo,
        applyFrameNo: keybufAttributionProbe.applyFrameNo,
        writeFrameNo: keybufAttributionProbe.tracker.writeFrameNo,
        currentFrameNo: keybufAttributionProbe.frameNo,
        trueInjectionFrames: breakdown.trueInjectionFrames,
        transmissionStalenessFrames: breakdown.transmissionStalenessFrames,
      };
    },
    // 音声振幅プローブ(予備確認: docs/STORAGE-SCSI.md「音声遅延」参照)。resetAudioProbe()で
    // 積算区間を開始し、readAudioProbe()で最大振幅・サンプル数・非無音サンプル数を読む。
    // queuedSecと違い、無音サンプルとの区別が付く。
    resetAudioProbe: () => host?.resetAudioProbe(),
    readAudioProbe: () => host?.readAudioProbe() ?? null,
    // AudioWorklet内キュープローブ(計測計画「音声遅延」(1)、docs/STORAGE-SCSI.md
    // 「基準値：音声遅延」参照)。送り側(audioPush呼出時刻)ではなくAudioWorklet自身が
    // 報告するtickを時系列で貯める。scripts/measure-audio.mjs 専用。
    startQueueProbe: () => audio?.startQueueProbe(),
    stopQueueProbe: () => audio?.stopQueueProbe() ?? [],
    readQueueProbeLog: () => audio?.readQueueProbeLog() ?? [],
    // 計測専用の故障注入(本番ビルドには含まれない。上のAudioEngine実装参照)。
    faultDropNextChunk: () => audio?.faultDropNextChunk(),
    faultDelayReportSec: (sec: number) => audio?.faultDelayReportSec(sec),
    // 軸の較正状態(AxisCalibration)を実機で観測するためのフック。8BitDo M30 実機で
    // 「L/Rを離してもトリガ軸(axes[3]/[4])のON判定が固着する」報告の原因調査・再発防止用
    // (2026-08-08。実機のライブ表示観測で「一度も動かしていない間は0.00を報告し、一度動かすと
    // 以後は真の静止値-1.00を報告する」ことが確定し、軸ごとの較正状態を持つ設計にした)。
    // 呼び出し自体が観測(axisCalibへの記録)を引き起こさないよう、GamepadManager側の
    // describeAxes()(peekAxisCalibration 経由の非破壊読み取り)をそのまま返すだけにしてある。
    // port省略時は0。該当ポートにパッドが無ければ null。
    axes: (port: 0 | 1 = 0) => {
      const pad = gamepadsByPort()[port];
      if (!pad) return null;
      return {
        id: pad.id,
        mapping: pad.mapping,
        buttonsLength: pad.buttons.length,
        axesLength: pad.axes.length,
        axes: managerForPad(pad).describeAxes(pad),
      };
    },
    // 目的B(docs/STORAGE-SCSI.md)「フレーム時間の分布」専用フック。
    // scripts/measure-frame-timing.mjs から呼ぶ。frameProbe.enabled を立てたときだけ
    // libretro-host.ts の runFrame()/handleVideoRefresh() と、下のrAF観測ループ・long task
    // observerが動く(既定off)。
    frameProbeEnable: (enabled: boolean) => setFrameProbeEnabled(enabled),
    frameProbeSetBusyWaitFault: (enabled: boolean) => {
      frameProbe.busyWaitFaultEnabled = enabled;
    },
    frameProbeReset: () => frameProbe.reset(),
    frameProbeRead: () => ({
      runEvents: frameProbe.runEvents,
      videoEvents: frameProbe.videoEvents,
      rafSamples: frameProbe.rafSamples,
      longTasks: frameProbe.longTasks,
      fps: host?.avInfo?.fps ?? null,
    }),
    // `?worker=1` の受け入れ条件検証用(docs/STORAGE-SCSI.md参照)。poolMissesが起動時の
    // 数件で頭打ちになっていることを実測で確認するためのフック。
    workerStats: () => ({
      active: urlWorkerMode,
      poolMisses: workerLastPoolMisses,
      frameNo: workerLastFrameNo,
    }),
    // Worker経路(?worker=1)専用の駆動ループ内訳プローブ(src/core-worker.ts の
    // workerTickProbe)。既定経路のframeProbe*と同じ作法だが、実体がWorker内にあるため
    // postMessage越しに制御する(workerTickProbeWanted/pendingWorkerTickProbeRead参照)。
    // 起動前に呼んでも(proxyがまだ無くても)意思だけ記録し、次の起動で即有効化される。
    workerTickProbeEnable: (enabled: boolean) => {
      workerTickProbeWanted = enabled;
      workerCoreProxy?.devPostRawMessage({
        kind: '__devTickProbe',
        action: enabled ? 'enable' : 'disable',
      });
    },
    workerTickProbeSetBusyWaitFault: (enabled: boolean) => {
      workerTickProbeBusyWaitFaultWanted = enabled;
      workerCoreProxy?.devPostRawMessage({
        kind: '__devTickProbe',
        action: 'setBusyWaitFault',
        value: enabled,
      });
    },
    workerTickProbeReset: () => {
      workerCoreProxy?.devPostRawMessage({ kind: '__devTickProbe', action: 'reset' });
    },
    workerTickProbeRead: (): Promise<WorkerTickProbeReadResult> =>
      new Promise((resolve) => {
        if (!workerCoreProxy) {
          resolve({ events: [], commandEvents: [] });
          return;
        }
        pendingWorkerTickProbeRead = resolve;
        workerCoreProxy.devPostRawMessage({ kind: '__devTickProbe', action: 'read' });
        // 応答が来ない場合(proxy破棄・generation交代等)にpendingを永久に残さないための保険。
        setTimeout(() => {
          if (pendingWorkerTickProbeRead === resolve) {
            pendingWorkerTickProbeRead = null;
            resolve({ events: [], commandEvents: [] });
          }
        }, 2000);
      }),
    // 無制限モードの時間配分を外から観測するためのフック。占有率(duty)が高すぎると
    // ページが操作不能になるため、実測できる窓口を残しておく(2026-09-03に占有率95.9%で
    // 操作不能になった回帰の検出用)。
    unlimitedTiming: () => ({
      active: unlimitedActive,
      presentCostMs: unlimitedPresentCostMs,
      frameCostMs: unlimitedFrameCostMs,
      budgetMs: UNLIMITED_TICK_BUDGET_MS,
      presentIntervalMs: UNLIMITED_PRESENT_INTERVAL_MS,
      maxDuty: UNLIMITED_MAX_DUTY,
      nextAllowedInMs: unlimitedNextAllowedAt - performance.now(),
    }),
    // ポーズ状態の取得/設定。ヘッドレスでの自動検証用(実ブラウザで rAF が回るとは
    // 限らないため、フレーム進行の判定は canvas 内容のハッシュ等の末端の値で行うこと)。
    // 引数省略時は現在の状態を返すだけ(副作用なし)。
    pause: (v?: boolean) => {
      if (v !== undefined) setPaused(v);
      return pausedByUser;
    },
  };
}

// --- 目的B「フレーム時間の分布」: 前面タブのrAF観測間隔とlong task ---
// 駆動ループ(scheduleNext/enterLoop、rAFとsetTimeoutの競争)とは別の、観測専用の
// 独立したrequestAnimationFrameチェーン。駆動用タイマーの発火順に影響されず、
// 「前面タブが実際にrAFを発火できた間隔」だけを見るためにあえて分離する。
let frameProbeRafId = 0;
let longTaskObserver: PerformanceObserver | null = null;

function frameProbeRafTick(): void {
  if (!frameProbe.enabled) {
    frameProbeRafId = 0;
    return;
  }
  frameProbe.rafSamples.push(performance.now());
  frameProbeRafId = requestAnimationFrame(frameProbeRafTick);
}

function setFrameProbeEnabled(enabled: boolean): void {
  frameProbe.enabled = enabled;
  if (enabled) {
    if (frameProbeRafId === 0) frameProbeRafId = requestAnimationFrame(frameProbeRafTick);
    if (longTaskObserver === null && typeof PerformanceObserver !== 'undefined') {
      try {
        longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            frameProbe.longTasks.push({ startAtMs: entry.startTime, durationMs: entry.duration });
          }
        });
        longTaskObserver.observe({ entryTypes: ['longtask'] });
      } catch {
        // long task API 非対応ブラウザ。longTasksは空のまま(取得不可であって0件確定ではない旨は
        // 呼び出し側=計測スクリプトが判定する)。
        longTaskObserver = null;
      }
    }
  } else {
    if (frameProbeRafId !== 0) {
      cancelAnimationFrame(frameProbeRafId);
      frameProbeRafId = 0;
    }
    if (longTaskObserver !== null) {
      longTaskObserver.disconnect();
      longTaskObserver = null;
    }
  }
}

function loop(t: number): void {
  if (!running || !host) return;

  // ポーズ中は host.runFrame() を呼ばずに抜ける。lastFrameTime/accumulator を
  // 0 に戻しておかないと、再開直後の dt が「ポーズしていた時間ぶん」の巨大な値になり、
  // computeFrameBudget() がその巨大な dt を一気に消化しようとして大量のフレームを
  // まとめて回す(早送りになる)。scheduleNext() 側でポーズ中は rAF を張らず
  // setTimeout(PAUSE_SLEEP_MS) だけにして 60Hz の空回りを避ける。
  if (pausedByUser) {
    lastFrameTime = 0;
    accumulator = 0;
    scheduleNext();
    return;
  }

  if (lastFrameTime === 0) lastFrameTime = t;
  const dt = (t - lastFrameTime) / 1000;
  lastFrameTime = t;

  // 無制限速度モード: 「目標倍率」が無いため、fps/queued/frameInterval/accumulator/
  // computeFrameBudget() を一切使わず、時間予算(UNLIMITED_TICK_BUDGET_MS)いっぱいまで
  // retro_run() を回し切る別経路。中間フレームは描画をスキップ(host.setVideoSkip)し、
  // tick末尾の1フレームだけ画面に出す。
  //
  // UNLIMITED_TICK_BUDGET_MS はコア実行だけでなく画面提示のコストも含む「総予算」
  // (詳細は frameBudget.ts のコメント参照)。画面提示は固定費が大きい(実測6.56ms)ため
  // 毎tick行うと予算がそれだけで尽きてしまう。UNLIMITED_PRESENT_INTERVAL_MS(30fps相当)
  // まで頻度を落として固定費を分散させ、コア実行に予算を残す。
  if (unlimitedActive) {
    const tickStart = performance.now();
    // 呼び出し元(rAF / setTimeout(32) / AudioWorklet の tick)が何であれ、無制限モードは
    // 1回呼ばれるごとに予算を使い切る。呼ばれた回数がそのまま占有率になるため、実時間で
    // 次に走ってよい時刻を決めて上限を掛ける。ここが無いと占有率99.8%でページが固まる。
    if (tickStart < unlimitedNextAllowedAt) {
      scheduleNext();
      return;
    }
    // このtickで画面を提示するか。提示は固定費(約6.5ms)なので毎tickやると
    // コア実行に回せる時間がほとんど残らない。30fpsまで落として固定費を分散させる。
    const present = tickStart - unlimitedLastPresentAt >= UNLIMITED_PRESENT_INTERVAL_MS;
    // 総予算から、このtickで払う提示コストの見込みを先に引く。
    const coreBudget = UNLIMITED_TICK_BUDGET_MS - (present ? unlimitedPresentCostMs : 0);
    // 「入らないフレームは始めない」。deadlineを1フレームぶん手前に置くことで
    // 予算の踏み越えを防ぐ(旧実装はこれが無く2.4ms超過していた)。
    const deadline = tickStart + coreBudget - unlimitedFrameCostMs;

    let ran = 0;
    try {
      host.setVideoSkip(true);
      do {
        const frameStart = performance.now();
        host.runFrame();
        unlimitedFrameCostMs = unlimitedFrameCostMs * 0.8 + (performance.now() - frameStart) * 0.2;
        ran++;
      } while (performance.now() < deadline);
    } finally {
      host.setVideoSkip(false);
    }

    if (present) {
      const presentStart = performance.now();
      host.runFrame(); // このフレームだけ画面に出す
      ran++;
      unlimitedPresentCostMs = unlimitedPresentCostMs * 0.8 + (performance.now() - presentStart) * 0.2;
      unlimitedLastPresentAt = presentStart;
    }

    pollDiskAccess(t);
    pollAutoSave(t);
    stepMouseTracking();
    stepTouchTrackpad();
    speedMeasureFrameCount += ran;
    updateSpeedActualDisplay(t);
    accumulator = 0;
    // 実際にかかった時間から、占有率が UNLIMITED_MAX_DUTY を超えないだけの間隔を空ける。
    // 予算値ではなく実コストを使うので、遅いホストでは自動的に間隔が広がる。
    const costMs = performance.now() - tickStart;
    unlimitedNextAllowedAt = tickStart + costMs / UNLIMITED_MAX_DUTY;
    scheduleNext();
    return;
  }

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
  // 速度倍率ぶんフレーム間隔を短く(倍率>1)/長く(倍率<1)する。
  const frameInterval = (1 / (fps * speedMultiplier)) * (1 + adjust);
  accumulator += dt;

  // 補正が追いつかない急変(タブ復帰・重い処理からの復帰)や rAF スロットリング
  // (低電力モード/サーマルスロットリングで30Hz等に落ちる環境)に備えた保険。
  // 固定値ではなく実測dtから必要フレーム数を導出する(src/frameBudget.ts)。
  const budget = computeFrameBudget(dt, frameInterval, queued, speedMultiplier);

  let ran = 0;
  while (accumulator >= frameInterval && ran < budget) {
    host.runFrame();
    accumulator -= frameInterval;
    ran++;
  }
  if (ran > 0) {
    serialTransport.notifyReceiveCapacity();
    updateSerialBaudNote();
    if (serialTransport.canWrite) {
      const serialHost = host;
      serialHost.setSerialTxWritable(false);
      const serialBytes = serialHost.drainSerialTx(serialTransport.recommendedWriteSize());
      if (serialBytes.length > 0) {
        // 失敗時の再送は順序の重複を招くため行わない。
        void serialTransport.write(serialBytes)
          .catch((error) => {
            console.warn('Web Serial write failed; bytes were not retried', error);
          })
          .finally(() => {
            if (host === serialHost)
              serialHost.setSerialTxWritable(serialTransport.canWrite);
          });
      } else {
        serialHost.setSerialTxWritable(true);
      }
    }
    pollDiskAccess(t);
    pollAutoSave(t);
    stepMouseTracking();
    stepTouchTrackpad();
  }
  speedMeasureFrameCount += ran;
  updateSpeedActualDisplay(t);
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

  // 復帰トリガーは pointerdown/touchend/click/keydown の4種、すべて capture 段で登録する。
  // スマホでは仮想キーボードのボタン(virtual-keyboard.ts)が pointerdown で
  // event.preventDefault() を呼んでおり、互換 click イベントが生成されない。
  // bubble 段の document リスナには何も届かないため、preventDefault/stopPropagation
  // より先に走る capture 段で拾う必要がある。
  const resumeEvents: (keyof DocumentEventMap)[] = ['pointerdown', 'touchend', 'click', 'keydown'];

  const onStateChange = () => {
    if (ctx.state !== 'running') return;
    ctx.removeEventListener('statechange', onStateChange);
    for (const ev of resumeEvents) {
      document.removeEventListener(ev, tryResume, { capture: true });
    }
    hideToast();
  };
  const tryResume = () => audio?.resume();

  ctx.addEventListener('statechange', onStateChange);
  for (const ev of resumeEvents) {
    document.addEventListener(ev, tryResume, { capture: true });
  }
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
    // 音声の初期化失敗で起動そのものを止めないこと。AudioWorklet は secure context
    // (https または localhost)でしか使えず、例えば LAN の IP アドレス
    // (http://192.168.x.x:port/)で開くと ctx.audioWorklet が undefined になる。
    // 以前はこの初期化を bootCore() と同じ try に入れて await していたため、
    // そういう環境では「起動に失敗しました: Cannot read properties of undefined
    // (reading 'addModule')」で Human68k すら立ち上がらなかった。
    // 音が出ないだけならエミュレータとしては使えるので、警告を出して先へ進む。
    try {
      const engine = new AudioEngine();
      await engine.start();
      // タイマーがスロットルされる環境向け: オーディオスレッドの tick でも駆動する
      engine.setTickHandler(() => {
        if (running) enterLoop();
      });
      audio = engine;
    } catch {
      // audio は null のまま。以降の参照はすべて audio?. で null 安全にしてある。
      // 駆動は rAF + setTimeout(scheduleNext())が担うので、無音でも実行は続く。
      audio = null;
      showToast(t('audioUnavailable'));
    }

    await bootCore();
    // 起動直後(初回描画後)の実解像度で一度リスケールしておく。以降は
    // host.onResolutionChanged(解像度変更時)と各種resize/表示切替のイベントに任せる。
    rescale();

    btnReset.disabled = false;
    btnPause.disabled = false;
    setPaused(false);
    btnSaveState.disabled = false;
    btnLoadState.disabled = false;
    btnScreenshot.disabled = false;
    btnSpeed.disabled = false;
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
// かつてはオーバーレイの空白部分(ボタン以外)クリックも「そのまま起動」扱いにしていた(WebNP2準拠)。
// しかしボタンを狙ったつもりで少し外れると意図せず「そのまま起動」が走ってしまう誤爆があるため撤廃。
// 起動はボタン(btn-boot-plain / btn-boot-system)を押した場合のみに限定する。
// 同じ理由で将来また足されることのないよう、この経緯をここに残しておく。

// リセットボタン: ソフトリセット(_retro_reset())ではなく restartCore() でコアを丸ごと
// 作り直すハードリセットにしている。CPU速度/RAM/パッド種別等のコアオプションは
// update_variables() が起動直後の1回目の retro_run(firstcall)でしか読まないため、
// ソフトリセットでは設定ダイアログでの変更が反映されない(従来はページのリロードが必要だった)。
// restartCore() は非同期でゲストの書き込み回収(flushAllSlots)を伴うため、多重起動を防ぐ
// 目的で処理中はボタンを disabled にする。失敗時はコアが破棄されたまま無言で操作不能になるのを
// 避けるため、startFromOverlay() と同じ流儀でエラーを通知する(ここではリロードを促す)。
btnReset.addEventListener('click', () => {
  if (btnReset.disabled) return;
  btnReset.disabled = true;
  showToast(t('toastResetting'), null);
  restartCore()
    .then(() => {
      btnReset.disabled = false;
      setPaused(false);
      hideToast();
    })
    .catch((err) => {
      console.error(err);
      alert(t('alertResetFailed', { message: describeError(err) }));
      // host が null のまま(コア破棄後に再構築失敗)なので、操作不能を隠さずボタンは無効のままにする。
      // ただしポーズ中オーバーレイだけは解除する(コアが無い=止まっているのが正しい状態で、
      // 「ポーズ中」の表示のまま残るのは事実と食い違うため)。
      setPaused(false);
    });
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

/** 現在表示中のトーストを指定ミリ秒後に消す(持続表示で出したものを、後から時間で閉じたいとき用)。 */
function scheduleToastHide(delayMs: number): void {
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), delayMs);
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
  // ステート保存/復元はWorker経路(?worker=1)では今回のスコープ外。host(メインスレッドの
  // コア)が無い=Worker経路なので、無言で抜けずに利用者へ知らせる。
  if (urlWorkerMode) {
    if (running) warnWorkerModeUnsupported();
    return;
  }
  if (!host || !running || !coreProxy) return;
  let buf: ArrayBuffer | null;
  try {
    buf = await coreProxy.serialize();
  } catch (err) {
    // CoreProxyError の code (host.serialize() が例外を投げた場合は CORE_FAILURE)を握り潰さず
    // ログには残す。UI 側の見え方は従来の「serialize()がnullを返した場合」と同じにする。
    console.error('ステートのシリアライズに失敗しました。', err);
    showToast(t('stateSaveFailed'));
    return;
  }
  if (!buf) {
    showToast(t('stateSaveFailed'));
    return;
  }
  try {
    await putState({
      slot: STATE_SLOT,
      bytes: new Uint8Array(buf),
      savedAt: Date.now(),
      disks: currentDiskConfig(),
    });
  } catch (err) {
    console.error('ステートの保存に失敗しました。', err);
    showToast(t('stateSaveFailed'));
    return;
  }
  showToast(t('stateSaved'));
}

async function handleLoadState(): Promise<void> {
  // handleSaveState と同じ理由(ステート保存/復元はWorker経路では今回のスコープ外)。
  if (urlWorkerMode) {
    if (running) warnWorkerModeUnsupported();
    return;
  }
  if (!host || !running || !coreProxy) return;
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

  let ok: boolean;
  try {
    // coreProxy.unserialize() は渡した ArrayBuffer の所有権を受け取り detach する
    // (core-proxy.ts の takeOwnership 参照)。stored.bytes は IndexedDB から読み直した
    // ばかりの値でこの呼び出し以降使わないため、そのまま渡してよい。
    ok = await coreProxy.unserialize(toOwnedArrayBuffer(stored.bytes));
  } catch (err) {
    // unserialize失敗時に以前のステートのまま走り続けていないか(host.unserialize()内部の
    // 責務)はここでは保証できないが、エラーコードは握り潰さずログに残し、失敗として扱う。
    console.error('ステートの復元に失敗しました。', err);
    showToast(t('stateLoadFailed'));
    return;
  }
  if (!ok) {
    showToast(t('stateLoadFailed'));
    return;
  }
  resetSerialBridge();
  // 復元直後は旧状態の音がキューに残っているので捨て、フレーム供給の蓄積もリセットする。
  // unserialize の応答(ok)を待ってから行う(docs/STORAGE-SCSI.md
  // 「unserialize中は駆動を止め、成功応答後に音声flushと基準状態を更新する」)。
  audio?.flush();
  resetResampleState(audioResampleState);
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

/** ファイルマネージャのターゲット一覧: FDD0/FDD1/HDD(実行中スロット) + ライブラリ内イメージ。 */
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

  // ライブラリ側はライブラリ一覧/スロットメニューと同じ並び(グループごとにまとまり、表示名の自然順)にする。
  // ここは平坦なセレクトなので、グループのディスクはそのグループの位置に連続して並べる。
  const nodes = buildLibraryNodes(await listDisks(), classifyDiskKind);
  for (const entry of nodes.flatMap((n) => (n.kind === 'group' ? n.group.entries : [n.entry]))) {
    const editable = entry.kind === 'hdd' || (entry.kind === 'fd' && isFmEditableFdName(entry.name));
    const note = editable ? '' : t('fmNotEditableNote');
    const mountedSlot = SLOT_IDS.find((s) => slots[s]?.sourceKey === entry.sourceKey);
    const label = `${entry.displayName}${mountedSlot ? ` [${t('fmMountedBadge')}]` : ''}${note ? ` (${note})` : ''}`;
    targets.push({ kind: 'library', ref: entry.sourceKey, label, mounted: !!mountedSlot, editable });
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
 * URLパラメータ(fd1/fd2/hdd/system/run/lib)に応じてディスクを起動前にセットし、
 * run=1 なら自動起動する(WebNP2 の同名パラメータ方式に準拠)。
 * 1つのディスクの取得に失敗しても他スロットの読み込み・起動は継続する(要件3)。
 * いずれのパラメータも無ければ何もしない(要件7: 既存のオーバーレイ2択のまま)。
 *
 * lib=<url> (複数指定可): 種別を問わずディスクライブラリへ登録するだけの共有リンク用パラメータ
 * (複数ディスク入りzipを配布し、受け取った側はリンクを開くだけでライブラリから選べるようにする用途)。
 * fd1/fd2/hdd と異なりスロットへの自動挿入は行わず、必ずライブラリダイアログを開く。
 * fd1/fd2/hdd と併用された場合は、それらのスロット処理を先に行ってから lib を処理する。
 */
/**
 * Sprout68k の共有リンク `#p1=` を開く。
 *
 * URL に載っているのは**利用者コードだけ**（数百バイト〜数KB）。ライブラリは
 * この配布物が持っているランタイム(public/sprout-runtime/v1)側にあり、固定番地の
 * ジャンプテーブル越しに呼ばれる。ここで両者を合体させて .xdf にする。
 *
 * 復号と組み立ては src/sprout-share.mts（Sprout68k の送信側とまったく同じ正典を
 * tools/fetch-sprout-runtime.mjs が持ってきたもの）を通す。自前で書くと、
 * 送信側と静かに食い違う。
 *
 * `#` より後ろはサーバへ送られないので、この作品はどこにもアップロードされていない。
 */
async function applySprout68kShare(): Promise<boolean> {
  const fragment = location.hash;
  if (!/(?:^|[#&])p1=/.test(fragment)) return false;
  try {
    const inflate = async (bytes: Uint8Array): Promise<Uint8Array> => {
      // Uint8Array をそのまま Blob へ渡すと SharedArrayBuffer の可能性で型が通らないため、
      // 実体の範囲だけを ArrayBuffer に切り出して渡す。
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    };
    const { bytes, tags } = await decodeShareFragment(fragment, inflate);

    const base = './sprout-runtime/v1/';
    const manifestResponse = await fetch(`${base}manifest.json`);
    if (!manifestResponse.ok) throw new Error(`ランタイムを読み込めません (HTTP ${manifestResponse.status})`);
    const manifest = await manifestResponse.json();
    const fetchBin = async (name: string): Promise<Uint8Array> => {
      const response = await fetch(`${base}${name}`);
      if (!response.ok) throw new Error(`${name} を読み込めません (HTTP ${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    };
    const [runtime, boot] = await Promise.all([fetchBin('runtime.bin'), fetchBin('boot.bin')]);
    const layout = { ...manifest.layout, ...DEFAULT_DISK };

    // ヘッダ検査をここで通す（版違いや壊れたURLをエミュレータへ渡さない）。
    const user = unpackUserPayload(bytes, layout);
    const { image } = assembleXdf(boot, runtime, packUserPayload(user, layout), layout);

    const labels = tags.map((code) => tagLabel(code)).filter(Boolean);
    const tagText = labels.length > 0 ? `(${labels.join(' / ')})` : '';
    await insertDiskBytes('fdd0', 'sprout68k-share.xdf', image, undefined, 'sprout68k:share');
    showToast(t('sproutShareLoaded', { tags: tagText }), 6000);
    await startFromOverlay(false);
    return true;
  } catch (error) {
    console.error('Sprout68k の共有リンクを開けませんでした', error);
    showToast(t('sproutShareFailed', { message: (error as Error).message }), 8000);
    return false;
  }
}

async function applyUrlParams(): Promise<void> {
  // Sprout68k の共有リンクが来ていたら、それだけを処理して終わる
  // （他のURLパラメータと混ざると、どのディスクで起動するのか分からなくなる）。
  if (await applySprout68kShare()) return;

  // system=1: fd1 の明示指定が無いときだけ、同梱システムディスクをFDD0として使う
  // (WebNP2 の freedos=1 相当。fd1 が指定されていればそちらを優先する)。
  const wantsBundledSystem = urlSystem && !urlFd1;
  if (!urlFd1 && !urlFd2 && !urlHdd && !wantsBundledSystem && !urlRun && urlLib.length === 0) return;

  if (wantsBundledSystem) {
    const bytes = await fetchBytes(BUNDLED_DISK_URL);
    if (bytes) {
      await insertDiskBytes('fdd0', BUNDLED_DISK_NAME, bytes, t('bundledDiskDisplayName'), BUNDLED_DISK_SOURCE_KEY);
    } else {
      showToast(t('urlSystemFetchFailed'), 8000);
    }
  }

  const jobs: Array<{ slot: SlotId; url: string | undefined; label: string }> = [
    { slot: 'fdd0', url: urlFd1, label: t('fdSlotLabel', { drive: 0 }) },
    { slot: 'fdd1', url: urlFd2, label: t('fdSlotLabel', { drive: 1 }) },
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

  // lib=: 種別を問わずライブラリへ登録するだけの共有リンク。1件でもスロットへは挿入せず、
  // 必ずライブラリを開く(共有リンクの意図として一貫させる)。run=1 でも自動起動しない。
  if (urlLib.length > 0) {
    let firstOutcome: UrlLibOutcome | undefined;
    for (let i = 0; i < urlLib.length; i++) {
      const label = t('urlLibSlotLabel', { index: i + 1 });
      const outcome = await resolveUrlLibContent(urlLib[i], label);
      if (outcome.kind === 'error') continue; // 失敗しても他のURLの処理は続行する
      firstOutcome ??= outcome;
    }
    if (firstOutcome) {
      openLibraryModal(firstOutcome.kind === 'group' ? firstOutcome.groupId : undefined);
    }
    return;
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
  screenshot: () => Promise.resolve(canvas.toDataURL('image/png')),
  // 2026-08-31追記: __webx68kDebug.screenTextと同じ理由でcatchが要る(上のコメント参照)。
  // coreProxy.readTextScreen()がreject(Worker初期化未完了)した場合もこのフォールバック値へ倒す。
  screenText: async () =>
    (await coreProxy?.readTextScreen().catch(() => null)) ?? {
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
    // 全画素を舐めると重いので間引いてハッシュする(画面変化の検出用途)。
    // canvas 由来の同期処理であり、proxy(コアのメモリ/画面状態)には載せていない
    // (docs/STORAGE-SCSI.md「段階移行の順序」手順2の報告参照)。シグネチャだけ async 化する。
    const ctx = canvas.getContext('2d');
    if (!ctx) return Promise.resolve(0);
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let h = 0;
    for (let i = 0; i < d.length; i += 997) h = (h * 31 + d[i]) | 0;
    return Promise.resolve(h);
  },
  reset: async () => {
    // UIのリセットボタン(restartCore)と同じく、リセット後に旧セッションのシリアルデータが
    // 流入しないようJS側の受信残りとコア側FIFOを破棄する。_retro_reset()自体もコア側FIFOを
    // 消すが、WebSerialTransportが保持している受信チャンクの残りには手が届かない。
    host?.reset();
    resetSerialBridge();
  },
  setKey: (retrok, down) => down
    ? sharedKeyInput.press('bridge:key', retrok)
    : sharedKeyInput.release('bridge:key', retrok),
  typeText: async (text) => {
    // Worker経路(?worker=1)ではhostが常にnullなので、`running`で起動済みかを判定する
    // (host基準のままだとWorker経路のキー入力(手順6で対応済み)がtypeTextだけ塞がれてしまう)。
    if (!running) throw new Error('not booted');
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
  mouseMove: (dx, dy) => applyMouseDelta(dx, dy),
  mouseButton: (button, down) => applyMouseButton(button, down),
  saveState: () => handleSaveState(),
  loadState: () => handleLoadState(),
  listDisks: () =>
    Promise.resolve(SLOT_IDS.map((slot) => ({ slot, name: slots[slot]?.name ?? null }))),
  insertDisk: async (slot, name, bytes) => {
    await insertDiskBytes(toSlotId(slot), name, bytes);
  },
  ejectDisk: (slot) => ejectSlot(toSlotId(slot), false),
  diskListFiles: async (slot, path) => {
    const { entries } = await fmListDir({ kind: 'slot', ref: toSlotId(slot), label: slot, mounted: true, editable: true }, path);
    return entries.map((e) => ({ name: e.name, size: e.size, isDir: e.isDir, mtime: e.mtime }));
  },
  diskReadFile: (slot, path) =>
    fmReadFile({ kind: 'slot', ref: toSlotId(slot), label: slot, mounted: true, editable: true }, path),
  diskWriteFile: (slot, path, bytes) =>
    fmWriteFile({ kind: 'slot', ref: toSlotId(slot), label: slot, mounted: true, editable: true }, path, bytes),
  readMemory: async (addr, length) => {
    if (!coreProxy) throw new Error('not booted');
    // 範囲を1回の proxy 呼び出しでまとめて読む(1バイトずつ host.peekByte を呼ぶ実装は廃止。
    // docs/STORAGE-SCSI.md「取りうる対応」の「read_memory は範囲一括 RPC」に従う)。
    const buf = await coreProxy.readMemory(addr, length);
    return Array.from(new Uint8Array(buf));
  },
  status: () =>
    Promise.resolve({
      running,
      // Worker経路(?worker=1)はhostが常にnullのため、その場合だけworkerAvInfoへ
      // フォールバックする(既定経路はhost.avInfoが既に設定されるため、この分岐は通らない)。
      fps: host?.avInfo?.fps ?? workerAvInfo?.fps ?? null,
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
