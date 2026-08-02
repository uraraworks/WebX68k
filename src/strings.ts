// UI文字列辞書 + 言語解決。日本語/英語を切り替える。
// WebNP2 (../PC98/WebNP2/src/ui/strings.ts) の方式をそのまま移植する。
// キーは Dict インターフェースで型定義し、ja/en どちらかにしか無いキーはコンパイルエラーになる。

export type Lang = 'ja' | 'en';

const STORAGE_KEY = 'webx68k.lang';

interface Dict {
  title(): string;
  headerTagline(): string;
  footerCopyright(): string;
  footerGithubLabel(): string;
  footerPoweredByPrefix(): string;
  footerPoweredBySuffix(): string;
  overlayBootPlain(): string;
  overlayBootSystem(): string;
  overlayNote1(): string;
  overlayNote2(): string;
  toolbarReset(): string;
  toolbarSettings(): string;
  toolbarDiskLibrary(): string;
  /** ツールバーの言語トグルボタンに表示するラベル(＝切替先の言語名)。 */
  langToggle(): string;
  fdSlotLabel(args: { drive: number }): string;
  hddSlotLabel(): string;
  fdEmpty(): string;
  slotInsert(): string;
  slotEject(): string;
  /** ドライブアクセスランプのスクリーンリーダー向けラベル。 */
  diskLampLabel(args: { drive: string }): string;
  /** スロットの「ライブラリから挿入」ボタン(ツールチップ)。 */
  slotInsertFromLibrary(): string;
  /** 「ライブラリから挿入」メニューの見出し。 */
  slotInsertFromLibraryTitle(args: { drive: string }): string;
  slotCreateBlank(): string;
  /** 「ブランク作成」メニューの見出し。 */
  slotCreateBlankTitle(args: { drive: string }): string;
  slotDownload(): string;
  libraryMenuEmpty(): string;
  blankFormat2hd1232(): string;
  blankFormat2hd1440(): string;
  blankFormat2dd640(): string;
  blankFormat2dd720(): string;
  alertBiosMissing(): string;
  alertBootFailed(args: { message: string }): string;
  alertDownloadNoImage(): string;
  settingsTitle(): string;
  settingsDescription(): string;
  settingsBiosSectionTitle(): string;
  settingsMachineSectionTitle(): string;
  settingsMachineSectionNote(): string;
  settingsCpuSpeedLabel(): string;
  settingsRamSizeLabel(): string;
  settingsClose(): string;
  biosStatusUser(): string;
  biosStatusBundled(): string;
  biosStatusNone(): string;
  libraryDialogTitle(): string;
  libraryDialogDescription(): string;
  libraryDialogClose(): string;
  libraryBadgeBundled(): string;
  libraryBadgeHdd(): string;
  libraryBadgeFd(): string;
  libraryMetaAlwaysAvailable(): string;
  libraryInsertTo(args: { drive: string }): string;
  libraryBundledNote(): string;
  libraryActionRename(): string;
  libraryActionDelete(): string;
  libraryRenamePrompt(args: { name: string }): string;
  libraryDeleteConfirm(args: { name: string }): string;
  bundledDiskDisplayName(): string;
}

const STRINGS: Record<Lang, Dict> = {
  ja: {
    title: () => 'WebX68k - X68000 Emulator',
    headerTagline: () => 'The online X68000 emulator powered by px68k-libretro',
    footerCopyright: () => '© URARA-works',
    footerGithubLabel: () => 'GitHubで見る',
    footerPoweredByPrefix: () => 'Powered by',
    footerPoweredBySuffix: () => '(GPLv2)',
    overlayBootPlain: () => 'そのまま起動',
    overlayBootSystem: () => 'システムディスクで起動',
    overlayNote1: () => '音声再生の制限上、クリック操作で起動します。',
    overlayNote2: () => 'ディスクはツールバーのライブラリ、または下のドライブ行から追加できます。',
    toolbarReset: () => 'リセット',
    toolbarSettings: () => '設定(BIOS / マシン構成)',
    toolbarDiskLibrary: () => 'ディスクライブラリ',
    langToggle: () => 'EN',
    fdSlotLabel: ({ drive }) => `FDD${drive}`,
    hddSlotLabel: () => 'HDD',
    fdEmpty: () => '未挿入',
    slotInsert: () => 'ディスク挿入',
    slotEject: () => 'ディスク取り出し',
    diskLampLabel: ({ drive }) => `${drive} アクセスランプ`,
    slotInsertFromLibrary: () => 'ライブラリから挿入',
    slotInsertFromLibraryTitle: ({ drive }) => `${drive} へ挿入`,
    slotCreateBlank: () => 'ブランク作成',
    slotCreateBlankTitle: ({ drive }) => `${drive} へブランクディスクを作成`,
    slotDownload: () => 'ダウンロード',
    libraryMenuEmpty: () => '保存済みのディスクイメージはありません。',
    blankFormat2hd1232: () => '2HD 1232KB (XDF標準)',
    blankFormat2hd1440: () => '2HD 1440KB',
    blankFormat2dd640: () => '2DD 640KB',
    blankFormat2dd720: () => '2DD 720KB',
    alertBiosMissing: () => 'BIOS ファイル (IPLROM.DAT / CGROM.DAT) を設定してください。',
    alertBootFailed: ({ message }) => `起動に失敗しました: ${message}`,
    alertDownloadNoImage: () => 'このドライブにはディスクが挿入されていません。',
    settingsTitle: () => '設定',
    settingsDescription: () =>
      'BIOS ファイル(IPLROM.DAT / CGROM.DAT)とマシン構成を設定します。設定はブラウザに保存され、次回起動時から反映されます。',
    settingsBiosSectionTitle: () => 'BIOS 設定',
    settingsMachineSectionTitle: () => 'マシン構成',
    settingsMachineSectionNote: () => '(既定: X68000 XVI 相当 = 16MHz / 2MB)',
    settingsCpuSpeedLabel: () => 'CPU速度',
    settingsRamSizeLabel: () => 'RAM',
    settingsClose: () => '閉じる',
    biosStatusUser: () => '設定済み',
    biosStatusBundled: () => '同梱ROM使用中(差し替え可)',
    biosStatusNone: () => '未設定',
    libraryDialogTitle: () => 'ディスクライブラリ',
    libraryDialogDescription: () =>
      'これまでに挿入したディスクイメージはブラウザに保存され、ここから挿入するドライブ(FDD1 / FDD2 / HDD)を選んで再挿入できます。',
    libraryDialogClose: () => '閉じる',
    libraryBadgeBundled: () => '同梱',
    libraryBadgeHdd: () => 'HDD',
    libraryBadgeFd: () => 'FD',
    libraryMetaAlwaysAvailable: () => '常時利用可能',
    libraryInsertTo: ({ drive }) => `${drive}へ`,
    libraryBundledNote: () => '同梱ディスク(削除不可)',
    libraryActionRename: () => '名前変更',
    libraryActionDelete: () => '削除',
    libraryRenamePrompt: ({ name }) => `表示名を入力してください(元のファイル名: ${name})`,
    libraryDeleteConfirm: ({ name }) => `保存済みデータ「${name}」を削除します。よろしいですか？`,
    bundledDiskDisplayName: () => 'human302.xdf (同梱)',
  },
  en: {
    title: () => 'WebX68k - X68000 Emulator',
    headerTagline: () => 'The online X68000 emulator powered by px68k-libretro',
    footerCopyright: () => '© URARA-works',
    footerGithubLabel: () => 'View on GitHub',
    footerPoweredByPrefix: () => 'Powered by',
    footerPoweredBySuffix: () => '(GPLv2)',
    overlayBootPlain: () => 'Start As-Is',
    overlayBootSystem: () => 'Start with System Disk',
    overlayNote1: () => 'Audio requires a user gesture, so click to start.',
    overlayNote2: () => 'You can add disks from the toolbar library, or from the drive rows below.',
    toolbarReset: () => 'Reset',
    toolbarSettings: () => 'Settings (BIOS / Machine Config)',
    toolbarDiskLibrary: () => 'Disk Library',
    langToggle: () => '日本語',
    fdSlotLabel: ({ drive }) => `FDD${drive}`,
    hddSlotLabel: () => 'HDD',
    fdEmpty: () => 'empty',
    slotInsert: () => 'Insert disk',
    slotEject: () => 'Eject disk',
    diskLampLabel: ({ drive }) => `${drive} access lamp`,
    slotInsertFromLibrary: () => 'Insert from library',
    slotInsertFromLibraryTitle: ({ drive }) => `Insert into ${drive}`,
    slotCreateBlank: () => 'New Blank',
    slotCreateBlankTitle: ({ drive }) => `Create blank disk for ${drive}`,
    slotDownload: () => 'Download',
    libraryMenuEmpty: () => 'No saved disk images yet.',
    blankFormat2hd1232: () => '2HD 1232KB (XDF standard)',
    blankFormat2hd1440: () => '2HD 1440KB',
    blankFormat2dd640: () => '2DD 640KB',
    blankFormat2dd720: () => '2DD 720KB',
    alertBiosMissing: () => 'Please set the BIOS files (IPLROM.DAT / CGROM.DAT).',
    alertBootFailed: ({ message }) => `Failed to start: ${message}`,
    alertDownloadNoImage: () => 'No disk is inserted in this drive.',
    settingsTitle: () => 'Settings',
    settingsDescription: () =>
      'Configure the BIOS files (IPLROM.DAT / CGROM.DAT) and machine settings. Settings are saved in your browser and applied from the next start.',
    settingsBiosSectionTitle: () => 'BIOS Settings',
    settingsMachineSectionTitle: () => 'Machine Configuration',
    settingsMachineSectionNote: () => '(default: X68000 XVI equivalent = 16MHz / 2MB)',
    settingsCpuSpeedLabel: () => 'CPU Speed',
    settingsRamSizeLabel: () => 'RAM',
    settingsClose: () => 'Close',
    biosStatusUser: () => 'Configured',
    biosStatusBundled: () => 'Using bundled ROM (replaceable)',
    biosStatusNone: () => 'Not set',
    libraryDialogTitle: () => 'Disk Library',
    libraryDialogDescription: () =>
      'Disk images you have inserted are saved in your browser. Choose a drive (FDD1 / FDD2 / HDD) to insert one from here.',
    libraryDialogClose: () => 'Close',
    libraryBadgeBundled: () => 'Bundled',
    libraryBadgeHdd: () => 'HDD',
    libraryBadgeFd: () => 'FD',
    libraryMetaAlwaysAvailable: () => 'Always available',
    libraryInsertTo: ({ drive }) => `To ${drive}`,
    libraryBundledNote: () => 'Bundled disk (cannot be deleted)',
    libraryActionRename: () => 'Rename',
    libraryActionDelete: () => 'Delete',
    libraryRenamePrompt: ({ name }) => `Enter a display name (original file name: ${name})`,
    libraryDeleteConfirm: ({ name }) => `This will delete the saved data "${name}". Continue?`,
    bundledDiskDisplayName: () => 'human302.xdf (bundled)',
  },
};

function readStoredLang(): Lang | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'ja' || v === 'en' ? v : null;
  } catch {
    return null;
  }
}

/** 優先順位: URL ?lang= ＞ localStorage ＞ navigator.language(ja判定) ＞ 既定 'en'。 */
export function resolveLang(): Lang {
  const fromUrl = new URLSearchParams(location.search).get('lang');
  if (fromUrl === 'ja' || fromUrl === 'en') return fromUrl;

  const stored = readStoredLang();
  if (stored) return stored;

  if (navigator.language?.toLowerCase().startsWith('ja')) return 'ja';

  return 'en';
}

let currentLang: Lang = resolveLang();

export function getLang(): Lang {
  return currentLang;
}

export function setLang(lang: Lang): void {
  currentLang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // localStorage が使えない環境ではメモリ上の切替のみ有効。
  }
}

export type StringKey = keyof Dict;

export function t<K extends StringKey>(key: K, ...args: Parameters<Dict[K]>): string {
  const fn = STRINGS[currentLang][key] as (...a: unknown[]) => string;
  return fn(...args);
}
