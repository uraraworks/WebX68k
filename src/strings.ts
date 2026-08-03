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
  /** フッタの紹介ページ(about.html)リンクのラベル。 */
  footerAboutLabel(): string;
  footerPoweredByPrefix(): string;
  footerPoweredBySuffix(): string;
  overlayBootPlain(): string;
  /** いずれかのスロットにディスクがセット済みのときの1つ目のボタン文言。 */
  overlayBootPlainPending(): string;
  overlayBootSystem(): string;
  overlayNote1(): string;
  overlayNote2(): string;
  toolbarReset(): string;
  toolbarHelp(): string;
  toolbarSettings(): string;
  toolbarSaveState(): string;
  toolbarLoadState(): string;
  stateSaved(): string;
  stateLoaded(): string;
  stateSaveFailed(): string;
  stateLoadFailed(): string;
  stateNotFound(): string;
  mouseCaptured(): string;
  mouseReleased(): string;
  mouseResynced(): string;
  mouseTrackUnavailable(): string;
  mouseCaptureFailed(): string;
  toolbarMouseCapture(): string;
  toolbarMouseRelease(): string;
  toolbarMouseResync(): string;
  stateDiskMismatch(args: { saved: string; current: string }): string;
  toolbarDiskLibrary(): string;
  toolbarFileManager(): string;
  /** ツールバーの言語トグルボタンに表示するラベル(＝切替先の言語名)。 */
  langToggle(): string;
  fdSlotLabel(args: { drive: number }): string;
  hddSlotLabel(): string;
  fdEmpty(): string;
  slotInsert(): string;
  slotEject(): string;
  slotLockedWhileRunning(): string;
  /** ドライブアクセスランプのスクリーンリーダー向けラベル。 */
  diskLampLabel(args: { drive: string }): string;
  /** スロットの「ライブラリから挿入」ボタン(ツールチップ)。 */
  slotInsertFromLibrary(): string;
  /** 「ライブラリから挿入」メニューの見出し。 */
  slotInsertFromLibraryTitle(args: { drive: string }): string;
  slotCreateBlank(): string;
  /** 「ブランク作成」メニューの見出し。 */
  slotCreateBlankTitle(args: { drive: string }): string;
  /** HDDスロットの「ブランクHDD作成」ボタン(起動前のみ・単一フォーマットで即作成)。 */
  hddCreateBlank(): string;
  /** ブランクHDDを作ってセットしたときの通知(トースト)。 */
  statusHddBlankCreated(args: { name: string }): string;
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
  /** アーカイブ(ZIP/LZH)にディスクイメージが1つも見つからなかった場合。 */
  dropNoDiskImage(): string;
  /** アーカイブの展開自体に失敗した場合。 */
  statusArchiveFailed(args: { name: string; message: string }): string;
  /** アーカイブから展開してライブラリへ追加したときの通知。 */
  statusLibraryAdded(args: { count: number }): string;
  /** フォルダ(アーカイブ由来グループ)の名前変更プロンプト。 */
  libraryRenameGroupPrompt(): string;
  /** フォルダ行に出す枚数表示。 */
  libraryGroupCount(args: { count: number }): string;
  /** フォルダごと削除の確認。 */
  libraryDeleteGroupConfirm(args: { name: string; count: number }): string;
  /** URLパラメータ/D&D等で複数枚入りアーカイブを取り込み、該当グループを展開・選択した状態でライブラリを開いたときの案内文。 */
  libraryGroupFocusHint(): string;
  /** 「ライブラリから挿入」サブメニューの戻る行。 */
  libraryMenuBack(): string;

  // --- ファイルマネージャ(FTPクライアント風2ペイン) ---
  fmDialogTitle(): string;
  fmDialogNote(): string;
  fmHostPaneTitle(): string;
  fmDiskPaneTitle(): string;
  fmSelectFilesBtn(): string;
  fmDropHint(): string;
  fmStagedEmpty(): string;
  fmArchiveError(args: { name: string; message: string }): string;
  fmRemoveBtn(): string;
  fmUnmountedLabel(): string;
  fmMountedBadge(): string;
  fmNotEditableNote(): string;
  fmRunningLockedNote(): string;
  fmPathRoot(): string;
  fmUpDir(): string;
  fmDirMarker(): string;
  fmDeleteSelectedBtn(): string;
  fmMakeDirBtn(): string;
  fmMakeDirPrompt(): string;
  fmMakeDirInvalidName(args: { name: string }): string;
  fmCreateTransferFdBtn(): string;
  fmTransferFdCreated(args: { name: string }): string;
  fmFreeSpaceLabel(args: { free: string; total: string }): string;
  fmSelectEditableTarget(): string;
  fmEmptyDir(): string;
  fmRenameConfirm(args: { list: string }): string;
  fmOverwriteConfirm(args: { names: string }): string;
  fmInsufficientSpace(args: { needed: string; free: string }): string;
  fmTransferring(args: { current: number; total: number }): string;
  fmTransferDone(args: { succeeded: number; failed: number }): string;
  fmTransferFailedDetail(args: { names: string }): string;
  fmDeleteConfirm(args: { names: string }): string;
  fmCloseBtn(): string;
  fmListLoadFailed(args: { message: string }): string;

  // --- ディスク操作エラー(api/fat.ts の DiskError コードに対応) ---
  errD88NotEditable(): string;
  errHddInvalidHeader(args: { format: string }): string;
  errHddNoFatPartition(): string;
  errInvalidShortName(args: { name: string }): string;

  // --- URLパラメータ(?fd1=/?fd2=/?hdd=/?system=/?run=)によるディスク自動セット ---
  /** IndexedDBに保存済みのURL由来イメージを再利用するときのトースト。 */
  urlDiskResumed(args: { label: string; name: string }): string;
  /** ダウンロード開始直後のトースト(サイズ不明の間)。 */
  urlFetching(args: { label: string; name: string }): string;
  /** ダウンロード中の進捗トースト。totalがnullなら不明として表示する。 */
  urlFetchingProgress(args: { label: string; name: string; loaded: string; total: string | null }): string;
  /** fetch自体が失敗した(ネットワークエラー・CORS未対応の可能性を含む)場合のエラーメッセージ本文。 */
  urlFetchFailedNetwork(args: { url: string }): string;
  /** fetchはできたがHTTPステータスが失敗を示す場合のエラーメッセージ本文。 */
  urlFetchFailedHttp(args: { url: string; status: number }): string;
  /** スロット単位の取得失敗を伝えるトースト(他スロットの読み込み/起動は継続する)。 */
  urlLoadFailedToast(args: { label: string; message: string }): string;
  /** 同梱システムディスク(?system=1)の取得に失敗したときのトースト。 */
  urlSystemFetchFailed(): string;
  /** URLパラメータの取得結果がZIP/LZHで、前回展開済みのグループがライブラリにあり再ダウンロードせず復帰したときのトースト。 */
  urlArchiveResumed(args: { label: string; count: number }): string;
  /** URLパラメータで取得したアーカイブにディスクイメージが1つも見つからなかった場合のエラー。 */
  urlArchiveNoDiskImage(args: { label: string }): string;
  /** URLパラメータで取得したアーカイブに、対象スロット(FD/HDD)に合う種別のイメージが無かった場合のエラー。 */
  urlArchiveKindMismatch(args: { label: string; kind: 'hdd' | 'fd' }): string;
  /** URLパラメータのアーカイブが複数枚のディスクを含んでいたため、ライブラリを開いて選ばせるときの案内(run=1でも自動起動しない旨を含む)。 */
  urlArchiveNeedsSelection(): string;
  /** run=1自動起動時、自動再生制限でAudioContextがsuspendedのままのときに出す表示。 */
  audioMutedBanner(): string;
}

const STRINGS: Record<Lang, Dict> = {
  ja: {
    title: () => 'WebX68k - X68000 Emulator',
    headerTagline: () => 'The online X68000 emulator powered by px68k-libretro',
    footerCopyright: () => '© URARA-works',
    footerGithubLabel: () => 'GitHubで見る',
    footerAboutLabel: () => 'WebX68kについて',
    footerPoweredByPrefix: () => 'Powered by',
    footerPoweredBySuffix: () => '(GPLv2)',
    overlayBootPlain: () => 'ディスク無しで起動',
    overlayBootPlainPending: () => 'セットしたディスクで起動',
    overlayBootSystem: () => 'システムディスクで起動',
    overlayNote1: () => '音声再生の制限上、クリック操作で起動します。',
    overlayNote2: () => 'ディスクはツールバーのライブラリ、下のドライブ行、または画面へのドラッグ&ドロップから追加できます。',
    toolbarReset: () => 'リセット',
    toolbarHelp: () => 'ヘルプ',
    toolbarSettings: () => '設定(BIOS / マシン構成)',
    toolbarSaveState: () => 'ステート保存',
    toolbarLoadState: () => 'ステート復元',
    stateSaved: () => 'ステートを保存しました。',
    stateLoaded: () => 'ステートを復元しました。',
    stateSaveFailed: () => 'ステートの保存に失敗しました。',
    stateLoadFailed: () => 'ステートの復元に失敗しました。',
    stateNotFound: () => '保存されたステートがありません。',
    mouseCaptured: () => 'マウスをキャプチャしました(Esc で解除)。',
    mouseReleased: () => 'マウスのキャプチャを解除しました。',
    mouseResynced: () => 'マウスの基準を取り直しました。',
    mouseTrackUnavailable: () => 'このソフトではマウス追従を利用できません。右ダブルクリックでキャプチャしてください。',
    mouseCaptureFailed: () => 'マウスをキャプチャできませんでした。',
    toolbarMouseCapture: () => 'マウスキャプチャ(右ダブルクリック)',
    toolbarMouseRelease: () => 'マウスキャプチャを解除(Esc)',
    toolbarMouseResync: () => 'マウス再同期',
    stateDiskMismatch: ({ saved, current }) =>
      `保存時とディスク構成が異なります。\n保存時: ${saved}\n現在: ${current}\nこのまま復元すると誤動作する可能性があります。続けますか?`,
    toolbarDiskLibrary: () => 'ディスクライブラリ',
    toolbarFileManager: () => 'ファイル転送',
    langToggle: () => 'EN',
    fdSlotLabel: ({ drive }) => `FDD${drive}`,
    hddSlotLabel: () => 'HDD',
    fdEmpty: () => '未挿入',
    slotInsert: () => 'ディスク挿入',
    slotEject: () => 'ディスク取り出し',
    slotLockedWhileRunning: () => '起動中はHDDを交換できません(ページを再読み込みしてから操作してください)',
    diskLampLabel: ({ drive }) => `${drive} アクセスランプ`,
    slotInsertFromLibrary: () => 'ライブラリから挿入',
    slotInsertFromLibraryTitle: ({ drive }) => `${drive} へ挿入`,
    slotCreateBlank: () => 'ブランク作成',
    slotCreateBlankTitle: ({ drive }) => `${drive} へブランクディスクを作成`,
    hddCreateBlank: () => 'ブランクHDDを作成(40MB・FAT16)',
    statusHddBlankCreated: ({ name }) =>
      `ブランクHDD「${name}」を作成してセットしました(40MB・FAT16)。単体では起動できないため、FDDからHuman68kを起動してデータ用ドライブとして使ってください。`,
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
    dropNoDiskImage: () => 'ディスクイメージが見つかりませんでした。',
    statusArchiveFailed: ({ name, message }) => `${name} の展開に失敗しました: ${message}`,
    statusLibraryAdded: ({ count }) => `ディスクライブラリに${count}件追加しました。`,
    libraryRenameGroupPrompt: () => 'フォルダ名を入力してください',
    libraryGroupCount: ({ count }) => `${count}枚`,
    libraryDeleteGroupConfirm: ({ name, count }) =>
      `フォルダ「${name}」内の${count}件をすべて削除します。よろしいですか？`,
    libraryMenuBack: () => '← 戻る',
    libraryGroupFocusHint: () =>
      'このアーカイブには複数のディスクが入っています。使うディスクを選んでドライブへ挿入してください。',

    fmDialogTitle: () => 'ファイル転送',
    fmDialogNote: () =>
      'ホストPCとFDD1/FDD2/HDD・ライブラリ内のディスクイメージとの間でファイルをやり取りします。ファイル名は自動的に8.3形式へ変換されます。実行中のFDDスロットへ書き込んだ場合はディスクを入れ直したのと同じ扱いになります。起動中のHDDは読み出し専用です。',
    fmHostPaneTitle: () => 'ホスト(このPC)',
    fmDiskPaneTitle: () => 'ディスクイメージ',
    fmSelectFilesBtn: () => 'ファイルを選択',
    fmDropHint: () => 'ここにファイル/ZIP/LZHをドロップしても追加できます',
    fmStagedEmpty: () => '転送するファイルがありません',
    fmArchiveError: ({ name, message }) => `${name}: 展開に失敗しました(${message})`,
    fmRemoveBtn: () => '取り消す',
    fmUnmountedLabel: () => '未挿入',
    fmMountedBadge: () => 'マウント中',
    fmNotEditableNote: () => '編集非対応',
    fmRunningLockedNote: () => '起動中は変更不可',
    fmPathRoot: () => '/(ルート)',
    fmUpDir: () => '上の階層へ',
    fmDirMarker: () => 'DIR',
    fmDeleteSelectedBtn: () => '選択を削除',
    fmMakeDirBtn: () => 'フォルダ作成',
    fmMakeDirPrompt: () => '新しいフォルダ名を8.3形式で入力してください',
    fmMakeDirInvalidName: ({ name }) => `フォルダ名は8.3形式にしてください(2バイト文字/長い名前は不可): ${name}`,
    fmCreateTransferFdBtn: () => '転送用FD新規作成',
    fmTransferFdCreated: ({ name }) => `転送用FD「${name}」をライブラリに作成しました。`,
    fmFreeSpaceLabel: ({ free, total }) => `空き ${free} / 全体 ${total}`,
    fmSelectEditableTarget: () => '編集可能なディスクイメージを選択してください',
    fmEmptyDir: () => '(空のフォルダです)',
    fmRenameConfirm: ({ list }) => `以下の名前で転送します(8.3形式に自動変換):\n${list}\n\nよろしいですか？`,
    fmOverwriteConfirm: ({ names }) => `既存のファイルを上書きします: ${names}\nよろしいですか？`,
    fmInsufficientSpace: ({ needed, free }) => `空き容量が不足しています(必要 ${needed} / 空き ${free})`,
    fmTransferring: ({ current, total }) => `転送中... (${current}/${total})`,
    fmTransferDone: ({ succeeded }) => `${succeeded}件のファイルを転送しました。`,
    fmTransferFailedDetail: ({ names }) => `一部のファイルの転送に失敗しました: ${names}`,
    fmDeleteConfirm: ({ names }) => `以下のファイルを削除します: ${names}\nよろしいですか？`,
    fmCloseBtn: () => '閉じる',
    fmListLoadFailed: ({ message }) => `読み込みに失敗しました: ${message}`,
    errD88NotEditable: () => 'D88形式は編集に対応していません。',
    errHddInvalidHeader: ({ format }) => `${format}のヘッダが不正です。`,
    errHddNoFatPartition: () => 'HDDイメージ内にFAT12/16パーティションが見つかりません。',
    errInvalidShortName: ({ name }) =>
      `ファイル名は8.3形式にしてください(2バイト文字・長い名前は不可): ${name}`,

    urlDiskResumed: ({ label, name }) => `${label}: 前回保存した「${name}」を復元しました。`,
    urlFetching: ({ label, name }) => `${label}: 「${name}」を取得しています…`,
    urlFetchingProgress: ({ label, name, loaded, total }) =>
      `${label}: 「${name}」を取得中… ${loaded}${total ? ` / ${total}` : ''}`,
    urlFetchFailedNetwork: ({ url }) =>
      `ディスクイメージの取得に失敗しました: ${url}\n(取得先がCORSに対応していない可能性があります)`,
    urlFetchFailedHttp: ({ url, status }) => `ディスクイメージの取得に失敗しました: ${url} (HTTP ${status})`,
    urlLoadFailedToast: ({ label, message }) => `${label}の読み込みに失敗しました: ${message}`,
    urlSystemFetchFailed: () => '同梱システムディスクの取得に失敗しました。',
    urlArchiveResumed: ({ label, count }) =>
      `${label}: 前回展開した${count}件のディスクイメージをライブラリから復元しました(再ダウンロードなし)。`,
    urlArchiveNoDiskImage: ({ label }) => `${label}: アーカイブ内にディスクイメージが見つかりませんでした。`,
    urlArchiveKindMismatch: ({ label, kind }) =>
      `${label}: アーカイブ内に${kind === 'hdd' ? 'HDD' : 'FD'}用のディスクイメージが見つかりませんでした。`,
    urlArchiveNeedsSelection: () =>
      'アーカイブに複数のディスクイメージが含まれていたため、ライブラリを開きました。使用するイメージを選んでください(自動起動はしません)。',
    audioMutedBanner: () => '自動再生の制限により音声が無効です。クリックまたはキー入力で音声が有効になります。',
  },
  en: {
    title: () => 'WebX68k - X68000 Emulator',
    headerTagline: () => 'The online X68000 emulator powered by px68k-libretro',
    footerCopyright: () => '© URARA-works',
    footerGithubLabel: () => 'View on GitHub',
    footerAboutLabel: () => 'About WebX68k',
    footerPoweredByPrefix: () => 'Powered by',
    footerPoweredBySuffix: () => '(GPLv2)',
    overlayBootPlain: () => 'Start Without a Disk',
    overlayBootPlainPending: () => 'Boot with the Selected Disks',
    overlayBootSystem: () => 'Start with System Disk',
    overlayNote1: () => 'Audio requires a user gesture, so click to start.',
    overlayNote2: () => 'You can add disks from the toolbar library, the drive rows below, or by dragging & dropping onto the screen.',
    toolbarReset: () => 'Reset',
    toolbarHelp: () => 'Help',
    toolbarSettings: () => 'Settings (BIOS / Machine Config)',
    toolbarSaveState: () => 'Save State',
    toolbarLoadState: () => 'Load State',
    stateSaved: () => 'State saved.',
    stateLoaded: () => 'State loaded.',
    stateSaveFailed: () => 'Failed to save the state.',
    stateLoadFailed: () => 'Failed to load the state.',
    stateNotFound: () => 'No saved state found.',
    mouseCaptured: () => 'Mouse captured (press Esc to release).',
    mouseReleased: () => 'Mouse capture released.',
    mouseResynced: () => 'Mouse position re-synced.',
    mouseTrackUnavailable: () => 'Mouse tracking is unavailable for this software. Right double-click to capture instead.',
    mouseCaptureFailed: () => 'Could not capture the mouse.',
    toolbarMouseCapture: () => 'Capture mouse (right double-click)',
    toolbarMouseRelease: () => 'Release mouse (Esc)',
    toolbarMouseResync: () => 'Re-sync mouse',
    stateDiskMismatch: ({ saved, current }) =>
      `The mounted disks differ from when the state was saved.\nSaved: ${saved}\nCurrent: ${current}\nLoading anyway may cause the guest to misbehave. Continue?`,
    toolbarDiskLibrary: () => 'Disk Library',
    toolbarFileManager: () => 'File Transfer',
    langToggle: () => '日本語',
    fdSlotLabel: ({ drive }) => `FDD${drive}`,
    hddSlotLabel: () => 'HDD',
    fdEmpty: () => 'empty',
    slotInsert: () => 'Insert disk',
    slotEject: () => 'Eject disk',
    slotLockedWhileRunning: () => 'The HDD cannot be swapped while running (reload the page first)',
    diskLampLabel: ({ drive }) => `${drive} access lamp`,
    slotInsertFromLibrary: () => 'Insert from library',
    slotInsertFromLibraryTitle: ({ drive }) => `Insert into ${drive}`,
    slotCreateBlank: () => 'New Blank',
    slotCreateBlankTitle: ({ drive }) => `Create blank disk for ${drive}`,
    hddCreateBlank: () => 'Create blank HDD (40MB, FAT16)',
    statusHddBlankCreated: ({ name }) =>
      `Created and set blank HDD "${name}" (40MB, FAT16). It is not bootable on its own — boot Human68k from an FDD and use it as a data drive.`,
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
    dropNoDiskImage: () => 'No disk image was found.',
    statusArchiveFailed: ({ name, message }) => `Failed to extract ${name}: ${message}`,
    statusLibraryAdded: ({ count }) => `Added ${count} image(s) to the disk library.`,
    libraryRenameGroupPrompt: () => 'Enter a folder name',
    libraryGroupCount: ({ count }) => `${count} disk(s)`,
    libraryDeleteGroupConfirm: ({ name, count }) =>
      `This will delete all ${count} image(s) in the folder "${name}". Continue?`,
    libraryMenuBack: () => '← Back',
    libraryGroupFocusHint: () =>
      'This archive contains multiple disks. Choose the one you need and insert it into a drive.',

    fmDialogTitle: () => 'File Transfer',
    fmDialogNote: () =>
      'Transfer files between this PC and disk images in FDD1/FDD2/HDD or the library. File names are automatically converted to 8.3 format. Writing to a running FDD slot is treated as reinserting the disk. The HDD is read-only while the emulator is running.',
    fmHostPaneTitle: () => 'Host (this PC)',
    fmDiskPaneTitle: () => 'Disk Image',
    fmSelectFilesBtn: () => 'Select Files',
    fmDropHint: () => 'You can also drop files/ZIP/LZH here',
    fmStagedEmpty: () => 'No files staged for transfer',
    fmArchiveError: ({ name, message }) => `${name}: failed to extract (${message})`,
    fmRemoveBtn: () => 'Remove',
    fmUnmountedLabel: () => 'empty',
    fmMountedBadge: () => 'mounted',
    fmNotEditableNote: () => 'not editable',
    fmRunningLockedNote: () => 'locked while running',
    fmPathRoot: () => '/ (root)',
    fmUpDir: () => 'Up',
    fmDirMarker: () => 'DIR',
    fmDeleteSelectedBtn: () => 'Delete Selected',
    fmMakeDirBtn: () => 'New Folder',
    fmMakeDirPrompt: () => 'Enter a new folder name in 8.3 format',
    fmMakeDirInvalidName: ({ name }) => `Folder name must be 8.3 format (no double-byte/long names): ${name}`,
    fmCreateTransferFdBtn: () => 'New Transfer FD',
    fmTransferFdCreated: ({ name }) => `Created transfer FD "${name}" in the library.`,
    fmFreeSpaceLabel: ({ free, total }) => `Free ${free} / Total ${total}`,
    fmSelectEditableTarget: () => 'Please select an editable disk image',
    fmEmptyDir: () => '(empty folder)',
    fmRenameConfirm: ({ list }) => `Transferring with these names (auto-converted to 8.3):\n${list}\n\nProceed?`,
    fmOverwriteConfirm: ({ names }) => `This will overwrite existing files: ${names}\nProceed?`,
    fmInsufficientSpace: ({ needed, free }) => `Not enough free space (needed ${needed} / free ${free})`,
    fmTransferring: ({ current, total }) => `Transferring... (${current}/${total})`,
    fmTransferDone: ({ succeeded }) => `Transferred ${succeeded} file(s).`,
    fmTransferFailedDetail: ({ names }) => `Some files failed to transfer: ${names}`,
    fmDeleteConfirm: ({ names }) => `This will delete these files: ${names}\nProceed?`,
    fmCloseBtn: () => 'Close',
    fmListLoadFailed: ({ message }) => `Failed to load: ${message}`,
    errD88NotEditable: () => 'The D88 format is not supported for editing.',
    errHddInvalidHeader: ({ format }) => `Invalid ${format} header.`,
    errHddNoFatPartition: () => 'No FAT12/16 partition was found in this HDD image.',
    errInvalidShortName: ({ name }) =>
      `File names must be in 8.3 form (no double-byte or long names): ${name}`,

    urlDiskResumed: ({ label, name }) => `${label}: Resumed the previously saved "${name}".`,
    urlFetching: ({ label, name }) => `${label}: Fetching "${name}"...`,
    urlFetchingProgress: ({ label, name, loaded, total }) =>
      `${label}: Fetching "${name}"... ${loaded}${total ? ` / ${total}` : ''}`,
    urlFetchFailedNetwork: ({ url }) =>
      `Failed to fetch the disk image: ${url}\n(the origin may not support CORS)`,
    urlFetchFailedHttp: ({ url, status }) => `Failed to fetch the disk image: ${url} (HTTP ${status})`,
    urlLoadFailedToast: ({ label, message }) => `Failed to load ${label}: ${message}`,
    urlSystemFetchFailed: () => 'Failed to fetch the bundled system disk.',
    urlArchiveResumed: ({ label, count }) =>
      `${label}: Restored ${count} previously extracted disk image(s) from the library (no re-download).`,
    urlArchiveNoDiskImage: ({ label }) => `${label}: No disk image was found inside the archive.`,
    urlArchiveKindMismatch: ({ label, kind }) =>
      `${label}: The archive doesn't contain a ${kind === 'hdd' ? 'HDD' : 'FD'} disk image.`,
    urlArchiveNeedsSelection: () =>
      'The archive contains multiple disk images, so the library was opened. Please choose which image to use (auto-boot is skipped).',
    audioMutedBanner: () => 'Audio is muted due to autoplay restrictions. Click or press a key to enable sound.',
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

/**
 * 例外を利用者向けのメッセージへ変換する。
 * api/fat.ts の DiskError はコードを持つので現在の言語の文言へ差し替え、
 * それ以外(内部エラー)は素のメッセージをそのまま返す。
 * fat.ts を import せず、コードの有無をダックタイピングで判定して依存を作らない。
 */
export function describeError(err: unknown): string {
  if (err instanceof Error && 'code' in err) {
    const code = (err as Error & { code: unknown }).code;
    const params = ((err as Error & { params?: unknown }).params ?? {}) as {
      format: string;
      name: string;
    };
    switch (code) {
      case 'd88NotEditable':
        return t('errD88NotEditable');
      case 'hddInvalidHeader':
        return t('errHddInvalidHeader', params);
      case 'hddNoFatPartition':
        return t('errHddNoFatPartition');
      case 'invalidShortName':
        return t('errInvalidShortName', params);
      default:
        break;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
