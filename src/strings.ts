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
  /** ツールバーのポーズボタン(実行中)。 */
  toolbarPause(): string;
  /** ツールバーのポーズボタン(ポーズ中、再開させるとき)。 */
  toolbarResume(): string;
  /** ポーズ中オーバーレイの「ポーズ中」ラベル。 */
  pauseOverlayLabel(): string;
  toolbarHelp(): string;
  toolbarSettings(): string;
  toolbarSaveState(): string;
  toolbarLoadState(): string;
  toolbarScreenshot(): string;
  /** ツールバーの速度ボタン(ON/OFFトグル)のツールチップ/aria-label。 */
  toolbarSpeedLabel(): string;
  statusScreenshotSaved(): string;
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
  /** AudioWorklet が使えず無音で起動したときの案内(secure context 以外で開いた場合など)。 */
  audioUnavailable(): string;
  toolbarMouseCapture(): string;
  toolbarMouseRelease(): string;
  toolbarMouseResync(): string;
  toolbarFullscreen(): string;
  toolbarFullscreenExit(): string;
  toolbarFullscreenExitPseudo(): string;
  toolbarVirtualKeyboard(): string;
  toolbarVirtualKeyboardHide(): string;
  toolbarAspectNative(): string;
  toolbarAspect43(): string;
  /** オーバーフローメニューのマウスキャプチャ行専用ラベル(状態名。ON/OFFはチェックマークで示す)。 */
  toolbarMenuMouseCapture(): string;
  /** オーバーフローメニューの4:3表示行専用ラベル(状態名。ON/OFFはチェックマークで示す)。 */
  toolbarMenuAspect43(): string;
  /** ツールバーの「…」オーバーフローボタンのツールチップ/メニュー見出し。 */
  toolbarMore(): string;
  /** オーバーフローメニュー内のグループ見出し(表示/入力/ディスク/ステート)。 */
  toolbarGroupDisplay(): string;
  toolbarGroupInput(): string;
  toolbarGroupDisk(): string;
  toolbarGroupState(): string;
  stateDiskMismatch(args: { saved: string; current: string }): string;
  toolbarDiskLibrary(): string;
  toolbarFileManager(): string;
  /** ツールバーの言語トグルボタンに表示するラベル(＝切替先の言語名)。 */
  langToggle(): string;
  /** オーバーフローメニューの言語切替行のラベル(状態名。現在の言語名は library-menu-extra に出す)。 */
  toolbarLanguage(): string;
  fdSlotLabel(args: { drive: number }): string;
  hddSlotLabel(): string;
  fdEmpty(): string;
  slotInsert(): string;
  slotEject(): string;
  slotLockedWhileRunning(): string;
  /** SCSIスロットのドライブラベル。 */
  scsiSlotLabel(): string;
  /** SCSIスロット未挿入時の表示。 */
  scsiEmpty(): string;
  /** SCSIがこの環境で使えない(secure contextでない等)ときにスロットへ出す文言。 */
  scsiUnavailable(): string;
  /** SCSIディスクをOPFSへ取り込み中の進捗表示。 */
  scsiImporting(args: { percent: number }): string;
  /** SCSIディスクを挿したときの通知(次回起動から反映)。 */
  scsiInsertedNeedsRestart(): string;
  /** 起動中はSCSIディスクを差し替えられないときのツールチップ・通知。 */
  scsiLockedWhileRunning(): string;
  /** ディスクライブラリダイアログ内、SCSI用OPFSイメージ一覧セクションの見出し。 */
  scsiLibrarySectionTitle(): string;
  /** 同セクションの説明文(削除は取消不可・挿入中は削除不可であることを伝える)。 */
  scsiLibrarySectionDescription(): string;
  /** SCSIライブラリの削除ボタンが、現在挿入中のため無効化されているときのツールチップ。 */
  scsiLibraryDeleteDisabledMounted(): string;
  /** SCSIブランク作成ボタンのタイトル・aria-label(サイズはprompt()で別途聞くため範囲は含めない)。 */
  scsiCreateBlank(): string;
  /** ブランクSCSIディスクのサイズを尋ねるprompt()のメッセージ。 */
  scsiBlankSizePrompt(args: { min: number; max: number }): string;
  /** サイズ入力が数値として解釈できないときのアラート。 */
  scsiBlankSizeInvalidNotANumber(): string;
  /** サイズ入力が整数でない(小数)ときのアラート。 */
  scsiBlankSizeInvalidNotInteger(): string;
  /** サイズ入力が下限未満のときのアラート。 */
  scsiBlankSizeInvalidTooSmall(args: { min: number }): string;
  /** サイズ入力が上限超過のときのアラート。 */
  scsiBlankSizeInvalidTooLarge(args: { max: number }): string;
  /** ブランクSCSIディスクの作成が完了したときのトースト。 */
  statusScsiBlankCreated(args: { name: string; sizeMiB: number }): string;
  /** 実行中にFDを排出しようとしたときの確認(誤タップでゲストがフリーズする事故の防止)。 */
  slotEjectConfirmRunning(): string;
  /** ドライブアクセスランプのスクリーンリーダー向けラベル。 */
  diskLampLabel(args: { drive: string }): string;
  /** スロットの「ライブラリから挿入」ボタン(ツールチップ)。 */
  slotInsertFromLibrary(): string;
  /** 「ライブラリから挿入」メニューの見出し。 */
  slotInsertFromLibraryTitle(args: { drive: string }): string;
  /** FDDスロットの「ブランク作成」ボタン(2HD 1232KB 固定で即作成)。 */
  slotCreateBlank(): string;
  /** HDDスロットの「ブランクHDD作成」ボタン(起動前のみ・単一フォーマットで即作成)。 */
  hddCreateBlank(): string;
  /** ブランクHDDを作ってセットしたときの通知(トースト)。 */
  statusHddBlankCreated(args: { name: string }): string;
  /** HDDスロットのラベル(#label-hdd)に付けるツールチップ。表示ラベル自体は「HDD」のまま変えず、接続方式(SASI)を補足する。 */
  hddSlotTitle(): string;
  /** SCSIスロットのラベル(#label-scsi)に付けるツールチップ。HDDと非対称にならないよう、こちらも「種類」として補足する。 */
  scsiSlotTitle(): string;
  slotDownload(): string;
  libraryMenuEmpty(): string;
  alertBiosMissing(): string;
  alertBootFailed(args: { message: string }): string;
  toastResetting(): string;
  alertResetFailed(args: { message: string }): string;
  alertDownloadNoImage(): string;
  settingsTitle(): string;
  settingsDescription(): string;
  settingsBiosSectionTitle(): string;
  settingsMachineSectionTitle(): string;
  settingsMachineSectionNote(): string;
  settingsMachineResetNote(): string;
  settingsCpuSpeedLabel(): string;
  settingsRamSizeLabel(): string;
  settingsSpeedTitle(): string;
  settingsSpeedNote(): string;
  settingsSpeedLabel(): string;
  settingsSpeedUnlimited(): string;
  settingsSpeedActualPrefix(): string;
  /** ∞MHz(CPUクロック自動調整)中は速度倍率が使えない理由。 */
  settingsSpeedLockedByAutoClock(): string;
  settingsSerialTitle(): string;
  settingsSerialStatusLabel(): string;
  settingsSerialBaudLabel(): string;
  settingsSerialBaudNote(): string;
  settingsSerialBaudMismatch(args: { guestBaudRate: number; selectedBaudRate: number }): string;
  settingsSerialConnect(): string;
  settingsSerialDisconnect(): string;
  settingsSerialConnected(): string;
  settingsSerialDisconnected(): string;
  settingsSerialConnecting(): string;
  settingsSerialError(): string;
  settingsSerialUnsupported(): string;
  settingsSerialCoreUnsupported(): string;
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
  /** SCSIライブラリのイメージがファイル転送の対象一覧に出るときの理由注記(256MB超)。 */
  fmScsiTooLargeNote(): string;
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
  errNotFormatted(): string;

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
  /** 配信元がOneDrive(1drv.ms/onedrive.live.com/sharepoint.com)だった場合の案内(中継しても取得できないため即座に案内する)。 */
  urlFetchFailedOneDrive(args: { url: string }): string;
  /** 配信元がGoogle Drive/Dropboxで、かつ中継(VITE_DISK_PROXY)が未設定だった場合の案内。 */
  urlFetchFailedNeedsProxy(args: { url: string }): string;
  /** 中継サーバ経由の取得が失敗した場合のエラーメッセージ本文(中継側のエラーコードを反映)。 */
  urlFetchFailedProxy(args: { url: string; reason: string }): string;
  /** 取得結果がディスクイメージではなくHTMLページ(共有リンクの閲覧ページ等)だった場合の案内。 */
  urlFetchFailedHtmlPage(args: { url: string }): string;
  // --- 中継サーバ(VITE_DISK_PROXY)のエラーコード別の理由文言(urlFetchFailedProxy の reason に渡す) ---
  urlProxyReasonBadUrl(): string;
  urlProxyReasonOriginNotAllowed(): string;
  urlProxyReasonHostNotAllowed(): string;
  urlProxyReasonTooLarge(): string;
  urlProxyReasonRateLimited(): string;
  urlProxyReasonUpstreamFailed(): string;
  urlProxyReasonRedirectNotAllowed(): string;
  urlProxyReasonUnknown(args: { status: number }): string;
  /** スロット単位の取得失敗を伝えるトースト(他スロットの読み込み/起動は継続する)。 */
  urlLoadFailedToast(args: { label: string; message: string }): string;
  /** 同梱システムディスク(?system=1)の取得に失敗したときのトースト。 */
  urlSystemFetchFailed(): string;
  /** Sprout68k の共有リンク(#p1=)から作品を読み込んだときのトースト。tags は空のこともある。 */
  sproutShareLoaded(args: { tags: string }): string;
  /** Sprout68k の共有リンクを開けなかったときのトースト。 */
  sproutShareFailed(args: { message: string }): string;
  /** URLパラメータの取得結果がZIP/LZHで、前回展開済みのグループがライブラリにあり再ダウンロードせず復帰したときのトースト。 */
  urlArchiveResumed(args: { label: string; count: number }): string;
  /** URLパラメータで取得したアーカイブにディスクイメージが1つも見つからなかった場合のエラー。 */
  urlArchiveNoDiskImage(args: { label: string }): string;
  /** URLパラメータで取得したアーカイブに、対象スロット(FD/HDD)に合う種別のイメージが無かった場合のエラー。 */
  urlArchiveKindMismatch(args: { label: string; kind: 'hdd' | 'fd' }): string;
  /** URLパラメータのアーカイブが複数枚のディスクを含んでいたため、ライブラリを開いて選ばせるときの案内(run=1でも自動起動しない旨を含む)。 */
  urlArchiveNeedsSelection(): string;
  /** URLがディスク構成を指定しているため、指定外のスロットを起動前に取り出したことを知らせるトースト。「消えていません」を必ず含める。 */
  urlUnmountedOtherSlots(): string;
  /** ?lib=<url> (複数指定可)のトースト等で使う、何本目のlibか示すラベル(fdSlotLabel/hddSlotLabelのlib版)。 */
  urlLibSlotLabel(args: { index: number }): string;
  /** run=1自動起動時、自動再生制限でAudioContextがsuspendedのままのときに出す表示。 */
  audioMutedBanner(): string;

  // --- ジョイスティック設定ダイアログ(表示のみ。割当編集は次フェーズ) ---
  toolbarGamepad(): string;
  gamepadDialogTitle(): string;
  gamepadDialogDescription(): string;
  gamepadDialogClose(): string;
  /** パッド未接続時の案内(Chromeは入力があるまでgetGamepads()に列挙しないため)。 */
  gamepadNoPads(): string;
  gamepadConnectedTitle(): string;
  /** 接続順に割り当てられたポート番号(1/2)の表示。 */
  gamepadPortAssigned(args: { port: number }): string;
  /** 3台目以降など、どちらのポートにも割り当てられていない場合。 */
  gamepadPortUnassigned(): string;
  /** ライブ表示の各パッド見出し(パッド名+ポート表記)。Gamepad API index(0始まり)の生値は出さない。 */
  gamepadLiveTitle(args: { name: string; portLabel: string }): string;
  gamepadPhysicalTitle(): string;
  gamepadX68kTitle(): string;
  gamepadTargetUp(): string;
  gamepadTargetDown(): string;
  gamepadTargetLeft(): string;
  gamepadTargetRight(): string;

  // --- ジョイスティック割当編集(検出/コンボ選択/デッドゾーン/ポート選択/永続化) ---
  /** 編集対象パッドを選ぶセレクトのラベル。 */
  gamepadEditingPadLabel(): string;
  /** 割当編集テーブルの見出し。 */
  gamepadBindingsTitle(): string;
  /**
   * [検出]ボタン。押すと次の物理入力を「その行の唯一の割当」として設定し直す(置き換え動作。
   * 既存のチップは全て解除される)。複数の入力を1行に足したい場合はコンボ(gamepadComboPlaceholder)
   * を使う。
   */
  gamepadDetectBtn(): string;
  /** [検出]ボタンのツールチップ(title属性)。置き換え動作である旨を明記する。 */
  gamepadDetectBtnTitle(): string;
  /** 検出モード中の案内(次の入力待ち)。 */
  gamepadDetectWaiting(): string;
  /**
   * 検出待ち(行/キーボードどちらも共通)中に[検出]/[キーを割り当てる]ボタンと差し替えて出す
   * [キャンセル]ボタンのラベル。押すと検出を中止して元に戻る。Escキーが使えない環境
   * (スマホ等)でも中断できるようにするための導線。
   */
  gamepadCancelBtn(): string;
  /** [キャンセル]ボタンのツールチップ。 */
  gamepadCancelBtnTitle(): string;
  /** チップ(現在の割当1件)の削除ボタンのaria-label。 */
  gamepadRemoveBindingLabel(): string;
  /** コンボボックスの未選択時プレースホルダ(検出とは異なり、選ぶと既存の割当に追加される)。 */
  gamepadComboPlaceholder(): string;
  /** コンボボックスの「キーボード」optgroupラベル(中身の出力配線は次担当が実装)。 */
  gamepadComboKeyboardGroup(): string;
  /** 「その他の割当(キーボード)」セクション見出しの下に出す一行説明。何をする欄か読み取れない対策。 */
  gamepadGenericSectionDesc(): string;
  /** キーボード割当が0件のときのチップ表示(単なる「—」だと読み取れないため明示する)。 */
  gamepadGenericEmptyLabel(): string;
  /**
   * 「その他の割当」セクションの[検出]ボタンのツールチップ。JoyTarget行の[検出]と違い、
   * こちらは「新しい入力を捕まえてから宛先(ジョイスティック行 or キー)を選んで追加する」フローで、
   * 既存の割当を置き換えるものではない旨と、操作順(パッドのボタンを押す→キーを選ぶ)を明記する。
   */
  gamepadGenericDetectBtnTitle(): string;
  /** 「その他の割当」セクションの[検出]ボタンのラベル(置き換えではなく新規追加フローなので文言を分ける)。 */
  gamepadGenericDetectBtn(): string;
  /** コンボボックスの「ジョイスティック(物理入力)」optgroupラベル。 */
  gamepadComboJoystickGroup(): string;
  /** standardでないパッドのボタン表記(例: 「ボタン7」)。 */
  gamepadButtonLabel(args: { index: number }): string;
  /** standardでないパッドの軸表記(例: 「軸0 +」)。 */
  gamepadAxisLabel(args: { index: number; dir: string }): string;
  /** ライブ表示で範囲外の値を返す軸(ハット軸等)に付ける注記。 */
  gamepadAxisInvalidSuffix(): string;
  /**
   * ライブ表示で未較正の軸(観測開始してから一度も動かされていない軸)に付ける注記。
   * 実機のトリガ軸等、一度も動かしていない間は値に意味が無く、動かすまで割当対象にも
   * ならないことを短く案内する(gamepad.ts の AxisCalibration 参照)。
   */
  gamepadAxisUncalibratedSuffix(): string;
  /**
   * ライブ表示で較正中の軸(一度動かされて、離れてから確定するまでの観測が進行中)に付ける注記。
   * 「未較正(一度も動いていない)」とは別の文言にし、押しっぱなしの最中に「もう使える」と
   * 誤解されないようにする(gamepad.ts の AXIS_CALIBRATION_SETTLE_FRAMES 参照)。
   */
  gamepadAxisCalibratingSuffix(): string;
  gamepadDeadzoneLabel(): string;
  gamepadResetPresetBtn(): string;
  /** [既定に戻す]ボタンのツールチップ。接続中パッドに応じて既定値が変わる旨を明記する。 */
  gamepadResetPresetBtnTitle(): string;
  /** ポートごとの使用パッド選択セレクトのラベル。 */
  gamepadPortDeviceLabel(args: { port: number }): string;
  /** ポート選択の「自動(接続順)」オプション。 */
  gamepadPortAutoOption(): string;

  // --- ジョイスティックのパッド種別(px68k_joytype1/2。2ボタン/CPSF-MD/CPSF-SFC) ---
  gamepadPadTypeTitle(): string;
  /** ポートごとのパッド種別セレクトのラベル。 */
  gamepadPadTypeDeviceLabel(args: { port: number }): string;
  gamepadPadTypeDefault(): string;
  gamepadPadTypeCpsfMd(): string;
  gamepadPadTypeCpsfSfc(): string;
  /** パッド種別を実行中に変更した場合の案内(GET_VARIABLE_UPDATE未実装のため次回起動まで反映されない)。 */
  gamepadPadTypeRestartHint(): string;

  // --- ジョイスティック位置ベースのボタン表記(RetroPad命名(B/A/Y/X)は実機印刷と食い違うため) ---
  /** standardマッピングのボタン表記。indexを主表記にし、位置名を添える(例: 「#0 (下)」)。 */
  gamepadPositionalButtonLabel(args: { index: number; position: string }): string;
  gamepadPosDown(): string;
  gamepadPosRight(): string;
  gamepadPosLeft(): string;
  gamepadPosUp(): string;
  gamepadPosL(): string;
  gamepadPosR(): string;
  gamepadPosL2(): string;
  gamepadPosR2(): string;
  gamepadPosSelect(): string;
  gamepadPosStart(): string;
  gamepadPosL3(): string;
  gamepadPosR3(): string;
  gamepadPosDpadUp(): string;
  gamepadPosDpadDown(): string;
  gamepadPosDpadLeft(): string;
  gamepadPosDpadRight(): string;
  gamepadPosHome(): string;

  // --- 入力パネル(仮想キーボード/バーチャルパッド)切り替え ---
  /** ツールバーの入力パネルトグルボタン(どちらのパネルも非表示のとき)。 */
  toolbarInputPanel(): string;
  /** ツールバーの入力パネルトグルボタン(いずれかのパネルが表示中のとき)。 */
  toolbarInputPanelHide(): string;
  /** stage右上の切り替えチップ、仮想キーボード側ボタンのaria-label。 */
  inputPanelSwitchKeyboard(): string;
  /** stage右上の切り替えチップ、バーチャルパッド側ボタンのaria-label。 */
  inputPanelSwitchPad(): string;
  /** stage右上の切り替えチップ、バーチャルトラックパッド側ボタンのaria-label。 */
  inputPanelSwitchTrackpad(): string;
  /** バーチャルパッドの組み込みプロファイル表示名。 */
  vpadProfileJoy2Button(): string;
  vpadProfileCursorSpace(): string;
  vpadProfileTenkey(): string;
  vpadProfileJoy6Button(): string;
  /** 🎮プロファイルメニュー末尾の「割当を編集…」行。 */
  vpadEditAssignmentsMenuItem(): string;

  // --- 入力プロファイル編集ダイアログ(input-profile-ui.ts) ---
  inputProfileEditorTitle(): string;
  inputProfileEditorDescription(): string;
  inputProfileSelectLabel(): string;
  inputProfileDuplicateBtn(): string;
  inputProfileRenameBtn(): string;
  inputProfileDeleteBtn(): string;
  inputProfileBuiltinReadonlyNote(): string;
  inputProfileBindingsTitle(): string;
  inputProfileClearBindingBtn(): string;
  inputProfileRowSelectedHint(): string;
  inputProfilePickerTitle(): string;
  inputProfileTabKeyboard(): string;
  inputProfileTabJoystick(): string;
  /** TRG3以降がポート1のパッド種別によっては効かない旨の注記。 */
  inputProfileTrg3PlusNote(): string;
  /** 割当一覧で「未割当」を表す文言。 */
  inputProfileUnassigned(): string;
  /** 自動複製・手動複製の既定名(元プロファイル名+接尾辞)。 */
  inputProfileDuplicateLabel(options: { name: string }): string;
  inputProfileDuplicatePrompt(options: { name: string }): string;
  inputProfileRenamePrompt(): string;
  inputProfileDeleteConfirm(options: { name: string }): string;
  /** 組み込みプロファイル編集時に自動複製が起きたことを知らせるトースト。 */
  inputProfileAutoDuplicatedToast(options: { name: string }): string;
  /** バーチャルパッドの入力元一覧(割当編集ダイアログの行ラベル)。 */
  inputProfileSourceDpadUp(): string;
  inputProfileSourceDpadDown(): string;
  inputProfileSourceDpadLeft(): string;
  inputProfileSourceDpadRight(): string;
  /** 補助ボタン1/2の行ラベル。 */
  inputProfileSourceOpt(options: { n: number }): string;
  /** 入力元一覧が可変(bindings由来)のモードでのみ出る「キーを追加」ボタン。 */
  inputProfileAddKeyBtn(): string;
  /** 「キーを追加」待機中、同じボタンの表示テキスト(押すと待機をやめる)。 */
  inputProfileAddKeyCancelBtn(): string;
  /** 「キーを追加」待機中に出す案内文言。 */
  inputProfileAddKeyWaitingHint(): string;
  /** 入力元一覧が可変のモードでのみ出る、行ごとの削除ボタン(その入力元自体を一覧から消す)。 */
  inputProfileRemoveRowBtn(): string;

  // --- ホストキー(物理キーボード再割り当て)ダイアログ ---
  /** ツールバー「…」メニュー内の項目名兼ダイアログのボタンaria-label。 */
  toolbarHostKey(): string;
  hostKeyDialogTitle(): string;
  hostKeyDialogDescription(): string;
  /** 「キーボード割当を有効にする」チェックボックスのラベル。 */
  hostKeyEnableLabel(): string;
  hostKeyProfileSelectLabel(): string;
  hostKeyBindingsTitle(): string;
  /** 有効化の副作用(割り当てたキーが通常の文字入力として働かなくなる)を伝える注記。 */
  hostKeyDisableTypingNote(): string;
  /** 組み込みホストキープロファイルの表示名。 */
  hostKeyProfileArrowsJoy(): string;
  hostKeyProfileArrowsJoy6(): string;
  hostKeyProfileTenkey(): string;

  /** `?worker=1` (段階移行のWorker経路)で、まだ移行していない機能(音声/SRAM/
   * ステート保存・復元)を使おうとしたときのトースト文言(入力・FDDホットマウント/dirty
   * capture/オートセーブ/終了flushは手順6・手順8で移行済み)。 */
  workerModeUnsupported(): string;
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
    toolbarPause: () => 'ポーズ',
    toolbarResume: () => '再開',
    pauseOverlayLabel: () => 'ポーズ中',
    toolbarHelp: () => 'ヘルプ',
    toolbarSettings: () => '設定(BIOS / マシン構成)',
    toolbarSaveState: () => 'ステート保存',
    toolbarLoadState: () => 'ステート復元',
    toolbarScreenshot: () => 'スクリーンショット',
    toolbarSpeedLabel: () => '速度変更',
    statusScreenshotSaved: () => 'スクリーンショットを保存しました。',
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
    audioUnavailable: () =>
      '音声を初期化できなかったため、無音で起動しました。https または localhost で開くと音が出ます。',
    toolbarMouseCapture: () => 'マウスキャプチャ(右ダブルクリック)',
    toolbarMouseRelease: () => 'マウスキャプチャを解除(Esc)',
    toolbarMouseResync: () => 'マウス再同期',
    toolbarFullscreen: () => 'フルスクリーン',
    toolbarFullscreenExit: () => 'フルスクリーンを解除(Esc)',
    // 疑似フルスクリーン(CSSクラスのみ)はEscで抜けられない。Escはcanvas経由でX68000側の
    // ESCキーとして送られるため、ページ側で横取りするとゲストソフトのESC入力と競合する。
    // ネイティブのフルスクリーンはブラウザがページ外でEscを処理するのでこの競合が起きないが、
    // 疑似フルスクリーンで同じことをすると競合するため、解除はツールバーのボタンのみとし、
    // ラベルからも "(Esc)" を外す。
    toolbarFullscreenExitPseudo: () => 'フルスクリーンを解除',
    toolbarVirtualKeyboard: () => '仮想キーボードを表示',
    toolbarVirtualKeyboardHide: () => '仮想キーボードを隠す',
    // トグルなので現在の状態でなく「切替先」を表示する(仮想キーボードボタンと同じ流儀)。
    toolbarAspectNative: () => '4:3表示にする',
    toolbarAspect43: () => 'ドット等倍表示にする',
    toolbarMenuMouseCapture: () => 'マウスキャプチャ',
    toolbarMenuAspect43: () => '4:3表示',
    toolbarMore: () => 'その他',
    toolbarGroupDisplay: () => '表示',
    toolbarGroupInput: () => '入力',
    toolbarGroupDisk: () => 'ディスク',
    toolbarGroupState: () => 'ステート',
    stateDiskMismatch: ({ saved, current }) =>
      `保存時とディスク構成が異なります。\n保存時: ${saved}\n現在: ${current}\nこのまま復元すると誤動作する可能性があります。続けますか?`,
    toolbarDiskLibrary: () => 'ディスクライブラリ',
    toolbarFileManager: () => 'ファイル転送',
    langToggle: () => 'EN',
    toolbarLanguage: () => '言語',
    fdSlotLabel: ({ drive }) => `FDD${drive}`,
    hddSlotLabel: () => 'HDD',
    fdEmpty: () => '未挿入',
    slotInsert: () => 'ディスク挿入',
    slotEject: () => 'ディスク取り出し',
    slotLockedWhileRunning: () => '起動中はHDDを交換できません(ページを再読み込みしてから操作してください)',
    scsiSlotLabel: () => 'SCSI',
    scsiEmpty: () => '未挿入',
    scsiUnavailable: () => 'この環境では使えません(保護された接続が必要です)',
    scsiImporting: ({ percent }) => `取り込み中… ${percent}%`,
    scsiInsertedNeedsRestart: () => 'SCSIディスクを挿しました。次回の起動から使えます',
    scsiLockedWhileRunning: () => '起動中はSCSIディスクを差し替えられません',
    scsiLibrarySectionTitle: () => 'SCSIディスク',
    scsiLibrarySectionDescription: () =>
      'SCSIスロットに割り当てられるイメージです。削除すると復元できません(現在挿入中のものは削除できません)。',
    scsiLibraryDeleteDisabledMounted: () => '現在SCSIスロットに挿入中のため削除できません',
    scsiCreateBlank: () => 'ブランクSCSIディスクを作成(サイズ指定・FAT16)',
    scsiBlankSizePrompt: ({ min, max }) => `作成するSCSIディスクのサイズをMB単位で入力してください(${min}〜${max})`,
    scsiBlankSizeInvalidNotANumber: () => '数値を入力してください',
    scsiBlankSizeInvalidNotInteger: () => '整数(MB単位)で入力してください。小数は使えません',
    scsiBlankSizeInvalidTooSmall: ({ min }) => `${min}MB以上を指定してください`,
    scsiBlankSizeInvalidTooLarge: ({ max }) =>
      `${max}MBまでです(SCSI HLEがイメージサイズを32bit符号あり整数で扱うため、これを超えると壊れます)`,
    statusScsiBlankCreated: ({ name, sizeMiB }) =>
      `ブランクSCSIディスク「${name}」(${sizeMiB}MB)を作成しました。次回の起動から使えます`,
    slotEjectConfirmRunning: () =>
      '実行中のディスクを取り出しますか？ソフトがディスクを読んでいる場合、フリーズすることがあります。\n(ディスク交換は、取り出さずにそのまま次のディスクを挿入すればできます)',
    diskLampLabel: ({ drive }) => `${drive} アクセスランプ`,
    slotInsertFromLibrary: () => 'ライブラリから挿入',
    slotInsertFromLibraryTitle: ({ drive }) => `${drive} へ挿入`,
    slotCreateBlank: () => 'ブランク作成',
    hddCreateBlank: () => 'ブランクHDDを作成(40MB・FAT16)',
    statusHddBlankCreated: ({ name }) =>
      `ブランクHDD「${name}」を作成してセットしました(40MB・FAT16)。単体では起動できないため、FDDからHuman68kを起動してデータ用ドライブとして使ってください。`,
    hddSlotTitle: () => 'ハードディスク(SASI)',
    scsiSlotTitle: () => 'ハードディスク(SCSI)',
    slotDownload: () => 'ダウンロード',
    libraryMenuEmpty: () => '保存済みのディスクイメージはありません。',
    alertBiosMissing: () => 'BIOS ファイル (IPLROM.DAT / CGROM.DAT) を設定してください。',
    alertBootFailed: ({ message }) => `起動に失敗しました: ${message}`,
    toastResetting: () => 'リセット中…',
    alertResetFailed: ({ message }) =>
      `リセットに失敗しました: ${message}\nページを再読み込みしてください。`,
    alertDownloadNoImage: () => 'このドライブにはディスクが挿入されていません。',
    settingsTitle: () => '設定',
    settingsDescription: () =>
      'BIOS ファイル(IPLROM.DAT / CGROM.DAT)、マシン構成、シリアルポートを設定します。設定はブラウザに保存されます。',
    settingsBiosSectionTitle: () => 'BIOS 設定',
    settingsMachineSectionTitle: () => 'マシン構成',
    settingsMachineSectionNote: () => '(既定: X68000 XVI 相当 = 16MHz / 2MB)',
    settingsMachineResetNote: () => '変更を反映するにはリセットが必要です。',
    settingsCpuSpeedLabel: () => 'CPU速度',
    settingsRamSizeLabel: () => 'RAM',
    settingsSpeedTitle: () => 'エミュレーション速度',
    settingsSpeedNote: () =>
      'ツールバーの速度ボタンをONにしたときの倍率です。リセット不要で即時反映し、設定は保存されません。無制限モードでは音は出ません。',
    settingsSpeedLabel: () => '速度ボタンON時の倍率',
    settingsSpeedUnlimited: () => '無制限',
    settingsSpeedActualPrefix: () => '実測',
    settingsSpeedLockedByAutoClock: () => '∞MHz中は等速固定(同じ処理時間を奪い合うため)',
    settingsSerialTitle: () => 'シリアルポート',
    settingsSerialStatusLabel: () => '状態',
    settingsSerialBaudLabel: () => 'ボーレート',
    settingsSerialBaudNote: () => 'X68000（ゲスト）側と同じボーレートを選択してください。',
    settingsSerialBaudMismatch: ({ guestBaudRate, selectedBaudRate }) =>
      `X68000（ゲスト）側は約 ${guestBaudRate} bps、ブラウザー側は ${selectedBaudRate} bps です。設定が一致しないため通信できない可能性があります。`,
    settingsSerialConnect: () => '接続',
    settingsSerialDisconnect: () => '切断',
    settingsSerialConnected: () => '接続済み',
    settingsSerialDisconnected: () => '未接続',
    settingsSerialConnecting: () => '接続中…',
    settingsSerialError: () => '接続エラー',
    settingsSerialUnsupported: () =>
      'このブラウザでは Web Serial API を利用できません。対応するデスクトップブラウザを使用してください。',
    settingsSerialCoreUnsupported: () =>
      '読み込まれたエミュレーターコアはシリアルブリッジに対応していません。ページを再読み込みしてください。',
    settingsClose: () => '閉じる',
    biosStatusUser: () => '設定済み',
    biosStatusBundled: () => '同梱ROM使用中(差し替え可)',
    biosStatusNone: () => '未設定',
    libraryDialogTitle: () => 'ディスクライブラリ',
    libraryDialogDescription: () =>
      'これまでに挿入したディスクイメージはブラウザに保存され、ここから挿入するドライブ(FDD0 / FDD1 / HDD)を選んで再挿入できます。',
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
      'ホストPCとFDD0/FDD1/HDD・SCSIディスク・ライブラリ内のディスクイメージとの間でファイルをやり取りします。ファイル名は自動的に8.3形式へ変換されます。実行中のFDDスロットへ書き込んだ場合はディスクを入れ直したのと同じ扱いになります。起動中のHDDは読み出し専用です。起動中にSCSIスロットへ挿入中のイメージは扱えません。',
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
    fmScsiTooLargeNote: () => '256MB超のため対象外(イメージ全体をメモリへ読み込む実装のため)',
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
    errNotFormatted: () =>
      'このディスクは未フォーマットか、FAT12/16として読めない形式です。Human68kのFORMATコマンドでフォーマットするか、フォーマット済みのブランクディスクを作成してください。',

    urlDiskResumed: ({ label, name }) => `${label}: 前回保存した「${name}」を復元しました。`,
    urlFetching: ({ label, name }) => `${label}: 「${name}」を取得しています…`,
    urlFetchingProgress: ({ label, name, loaded, total }) =>
      `${label}: 「${name}」を取得中… ${loaded}${total ? ` / ${total}` : ''}`,
    urlFetchFailedNetwork: ({ url }) =>
      `ディスクイメージの取得に失敗しました: ${url}\n(取得先がCORSに対応していない可能性があります)`,
    urlFetchFailedHttp: ({ url, status }) => `ディスクイメージの取得に失敗しました: ${url} (HTTP ${status})`,
    urlFetchFailedOneDrive: ({ url }) =>
      `ディスクイメージの取得に失敗しました: ${url}\nOneDriveの共有リンクは仕様上ご利用いただけません。Google DriveかDropboxをお使いください。`,
    urlFetchFailedNeedsProxy: ({ url }) =>
      `ディスクイメージの取得に失敗しました: ${url}\nこの配信元は中継サーバ経由でのみ取得できますが、このビルドでは中継(VITE_DISK_PROXY)が設定されていません。自分でホストしている場合は VITE_DISK_PROXY を設定してください(詳細はREADME)。`,
    urlFetchFailedProxy: ({ url, reason }) => `ディスクイメージの取得に失敗しました: ${url}\n${reason}`,
    urlFetchFailedHtmlPage: ({ url }) =>
      `ディスクイメージの取得に失敗しました: ${url}\n取得結果がディスクイメージではなくWebページでした。共有リンクの公開設定(リンクを知っている全員が閲覧可)を確認するか、ダウンロードしたファイルを画面へドラッグ&ドロップしてください。`,
    urlProxyReasonBadUrl: () => '中継サーバがURLを解釈できませんでした。',
    urlProxyReasonOriginNotAllowed: () => '中継サーバがこのサイトからのリクエストを許可していません。',
    urlProxyReasonHostNotAllowed: () => '中継サーバがこの配信元への転送を許可していません。',
    urlProxyReasonTooLarge: () => 'ファイルサイズが中継サーバの上限を超えています。',
    urlProxyReasonRateLimited: () => '中継サーバのリクエスト数が上限に達しています。しばらく待って再度お試しください。',
    urlProxyReasonUpstreamFailed: () => '中継サーバから配信元への取得に失敗しました。',
    urlProxyReasonRedirectNotAllowed: () =>
      '配信元が別のサイト(ログイン画面など)へ転送しようとしたため中断しました。共有設定が「リンクを知っている全員が閲覧可」になっているか、共有リンクを省略せず全部コピーしているかご確認ください。',
    urlProxyReasonUnknown: ({ status }) => `中継サーバでエラーが発生しました (HTTP ${status})。`,
    urlLoadFailedToast: ({ label, message }) => `${label}の読み込みに失敗しました: ${message}`,
    urlSystemFetchFailed: () => '同梱システムディスクの取得に失敗しました。',
    sproutShareLoaded: ({ tags }) => `Sprout68k で作られた作品を読み込みました${tags}。`,
    sproutShareFailed: ({ message }) => `共有リンクを開けませんでした: ${message}`,
    urlArchiveResumed: ({ label, count }) =>
      `${label}: 前回展開した${count}件のディスクイメージをライブラリから復元しました(再ダウンロードなし)。`,
    urlArchiveNoDiskImage: ({ label }) => `${label}: アーカイブ内にディスクイメージが見つかりませんでした。`,
    urlArchiveKindMismatch: ({ label, kind }) =>
      `${label}: アーカイブ内に${kind === 'hdd' ? 'HDD' : 'FD'}用のディスクイメージが見つかりませんでした。`,
    urlArchiveNeedsSelection: () =>
      'アーカイブに複数のディスクイメージが含まれていたため、ライブラリを開きました。使用するイメージを選んでください(自動起動はしません)。',
    urlUnmountedOtherSlots: () =>
      'URLで指定されたディスク構成で起動するため、他のスロットを取り出しました(ディスクは消えていません)。',
    urlLibSlotLabel: ({ index }) => `ライブラリ${index}`,
    audioMutedBanner: () =>
      '自動再生の制限により音声が無効です。画面のタップ(クリック)またはキー入力で音声が有効になります。',

    toolbarGamepad: () => 'ジョイスティック設定',
    gamepadDialogTitle: () => 'ジョイスティック設定',
    gamepadDialogDescription: () =>
      '接続中のゲームパッドの割当を確認・編集できます。設定はブラウザに保存され、パッドごとに区別されます。',
    gamepadDialogClose: () => '閉じる',
    gamepadNoPads: () => 'パッドが検出されていません。パッドのボタンを1回押すと認識されます。',
    gamepadConnectedTitle: () => '接続中のパッド',
    gamepadPortAssigned: ({ port }) => `ポート${port}`,
    gamepadPortUnassigned: () => '未割当',
    gamepadLiveTitle: ({ name, portLabel }) => `${name} (${portLabel})`,
    gamepadPhysicalTitle: () => '物理入力',
    gamepadX68kTitle: () => 'X68000側入力',
    gamepadTargetUp: () => '上',
    gamepadTargetDown: () => '下',
    gamepadTargetLeft: () => '左',
    gamepadTargetRight: () => '右',

    gamepadEditingPadLabel: () => '編集するパッド',
    gamepadBindingsTitle: () => '割当編集',
    gamepadDetectBtn: () => '検出(置き換え)',
    gamepadDetectBtnTitle: () => '次に押した入力をこの行の割当として設定し直します(既存の割当は解除されます)',
    gamepadDetectWaiting: () => '入力を待っています…(Escでキャンセル)',
    gamepadCancelBtn: () => 'キャンセル',
    gamepadCancelBtnTitle: () => '入力待ちを中止して元に戻ります',
    gamepadRemoveBindingLabel: () => '削除',
    gamepadComboPlaceholder: () => '追加する入力を選択…',
    gamepadGenericSectionDesc: () =>
      'パッドのボタンにキーボードのキーを割り当てます。ゲーム開始やポーズがキー操作のソフト向けです。',
    gamepadGenericEmptyLabel: () => '割当なし',
    gamepadGenericDetectBtnTitle: () =>
      '押すとパッドの入力待ちになります。パッドのボタンを押すと、割り当てるキーを選ぶメニューが出ます(既存の割当は消えません)',
    gamepadGenericDetectBtn: () => 'キーを割り当てる',
    gamepadComboKeyboardGroup: () => 'キーボード',
    gamepadComboJoystickGroup: () => 'ジョイスティック(物理入力)',
    gamepadButtonLabel: ({ index }) => `ボタン${index}`,
    gamepadAxisLabel: ({ index, dir }) => `軸${index} ${dir}`,
    gamepadAxisInvalidSuffix: () => '(無効・範囲外の値)',
    gamepadAxisUncalibratedSuffix: () => '(未較正・一度動かすと使えます)',
    gamepadAxisCalibratingSuffix: () => '(較正中・そのまま数秒待ってください)',
    gamepadDeadzoneLabel: () => 'デッドゾーン',
    gamepadResetPresetBtn: () => '既定に戻す',
    gamepadResetPresetBtnTitle: () =>
      '接続中のパッドに合わせた既定の割当に戻します(8BitDo M30/Micro等は専用プリセット、それ以外はXInput標準または全未割当)',
    gamepadPortDeviceLabel: ({ port }) => `ポート${port}のパッド`,
    gamepadPortAutoOption: () => '自動(接続順)',
    gamepadPadTypeTitle: () => 'パッド種別',
    gamepadPadTypeDeviceLabel: ({ port }) => `ポート${port}のパッド種別`,
    gamepadPadTypeDefault: () => '標準(2ボタン)',
    gamepadPadTypeCpsfMd: () => 'CPSF-MD (8ボタン)',
    gamepadPadTypeCpsfSfc: () => 'CPSF-SFC (8ボタン)',
    gamepadPadTypeRestartHint: () => '変更はコアの再起動(リセットボタン)から反映されます。',

    gamepadPositionalButtonLabel: ({ index, position }) => `#${index} (${position})`,
    gamepadPosDown: () => '下',
    gamepadPosRight: () => '右',
    gamepadPosLeft: () => '左',
    gamepadPosUp: () => '上',
    gamepadPosL: () => 'L',
    gamepadPosR: () => 'R',
    gamepadPosL2: () => 'L2',
    gamepadPosR2: () => 'R2',
    gamepadPosSelect: () => 'Select',
    gamepadPosStart: () => 'Start',
    gamepadPosL3: () => 'L3',
    gamepadPosR3: () => 'R3',
    gamepadPosDpadUp: () => '十字上',
    gamepadPosDpadDown: () => '十字下',
    gamepadPosDpadLeft: () => '十字左',
    gamepadPosDpadRight: () => '十字右',
    gamepadPosHome: () => 'Home',

    toolbarInputPanel: () => '入力パネルを表示',
    toolbarInputPanelHide: () => '入力パネルを隠す',
    inputPanelSwitchKeyboard: () => '仮想キーボードに切替',
    inputPanelSwitchPad: () => 'バーチャルパッドに切替',
    inputPanelSwitchTrackpad: () => 'バーチャルトラックパッドに切替',
    vpadProfileJoy2Button: () => 'ジョイスティック(2ボタン)',
    vpadProfileCursorSpace: () => 'カーソルキー + スペース',
    vpadProfileTenkey: () => 'テンキー',
    vpadProfileJoy6Button: () => 'ジョイスティック(6ボタン)',
    vpadEditAssignmentsMenuItem: () => '割当を編集…',

    inputProfileEditorTitle: () => '割当編集',
    inputProfileEditorDescription: () => 'バーチャルパッドの各部品に割り当てる入力(ジョイスティック/キーボード)を編集します。',
    inputProfileSelectLabel: () => 'プロファイル',
    inputProfileDuplicateBtn: () => '複製',
    inputProfileRenameBtn: () => '名前を変更',
    inputProfileDeleteBtn: () => '削除',
    inputProfileBuiltinReadonlyNote: () => '組み込みプロファイルは編集できません。「複製」してから編集してください。',
    inputProfileBindingsTitle: () => '割当',
    inputProfileClearBindingBtn: () => 'この行の割当を解除',
    inputProfileRowSelectedHint: () => '下のキーボード/ジョイスティックから割り当てる入力を選んでください。',
    inputProfilePickerTitle: () => '割り当てる入力を選択',
    inputProfileTabKeyboard: () => 'キーボード',
    inputProfileTabJoystick: () => 'ジョイスティック',
    inputProfileTrg3PlusNote: () => 'TRG3以降は、ポート1のパッド種別が2ボタンのままだと効きません。',
    inputProfileUnassigned: () => 'なし',
    inputProfileDuplicateLabel: ({ name }) => `${name} のコピー`,
    inputProfileDuplicatePrompt: ({ name }) => `「${name}」を複製します。新しい名前を入力してください。`,
    inputProfileRenamePrompt: () => '新しい名前を入力してください。',
    inputProfileDeleteConfirm: ({ name }) => `「${name}」を削除します。よろしいですか?`,
    inputProfileAutoDuplicatedToast: ({ name }) => `組み込みプロファイル「${name}」を複製しました`,
    inputProfileSourceDpadUp: () => 'スティック上',
    inputProfileSourceDpadDown: () => 'スティック下',
    inputProfileSourceDpadLeft: () => 'スティック左',
    inputProfileSourceDpadRight: () => 'スティック右',
    inputProfileSourceOpt: ({ n }) => `補助${n}`,
    inputProfileAddKeyBtn: () => 'キーを追加',
    inputProfileAddKeyCancelBtn: () => 'キャンセル',
    inputProfileAddKeyWaitingHint: () => 'キーを押してください(Escで中止)',
    inputProfileRemoveRowBtn: () => '削除',
    toolbarHostKey: () => 'キーボード割当',
    hostKeyDialogTitle: () => 'キーボード割当',
    hostKeyDialogDescription: () =>
      'ジョイスティックを持っていなくても、物理キーボードでジョイスティック専用ソフトを遊べるようにする機能です。テンキー専用ソフト向けのキー変換にも使えます。',
    hostKeyEnableLabel: () => 'キーボード割当を有効にする',
    hostKeyProfileSelectLabel: () => 'プロファイル',
    hostKeyBindingsTitle: () => '割当内容',
    hostKeyDisableTypingNote: () => '有効にすると、割り当てたキーは通常の文字入力として働かなくなります。',
    hostKeyProfileArrowsJoy: () => '矢印キー -> ジョイスティック(2ボタン)',
    hostKeyProfileArrowsJoy6: () => '矢印キー -> ジョイスティック(6ボタン)',
    hostKeyProfileTenkey: () => '矢印キー -> テンキー',
    workerModeUnsupported: () =>
      '?worker=1 ではこの機能はまだ未対応です(SRAM・ステート保存/復元は次段で移行予定)。',
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
    toolbarPause: () => 'Pause',
    toolbarResume: () => 'Resume',
    pauseOverlayLabel: () => 'Paused',
    toolbarHelp: () => 'Help',
    toolbarSettings: () => 'Settings (BIOS / Machine Config)',
    toolbarSaveState: () => 'Save State',
    toolbarLoadState: () => 'Load State',
    toolbarScreenshot: () => 'Screenshot',
    toolbarSpeedLabel: () => 'Speed',
    statusScreenshotSaved: () => 'Screenshot saved.',
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
    audioUnavailable: () =>
      'Audio could not be initialized, so the machine started without sound. Open the page over https or localhost to get audio.',
    toolbarMouseCapture: () => 'Capture mouse (right double-click)',
    toolbarMouseRelease: () => 'Release mouse (Esc)',
    toolbarMouseResync: () => 'Re-sync mouse',
    toolbarFullscreen: () => 'Fullscreen',
    toolbarFullscreenExit: () => 'Exit fullscreen (Esc)',
    // Pseudo-fullscreen (a CSS class only) cannot be exited with Esc. Esc is forwarded to the
    // guest (X68000) via the canvas as its ESC key, so intercepting it on the page would
    // conflict with guest software that uses ESC. Native fullscreen doesn't have this problem
    // because the browser handles Esc outside the page, but pseudo-fullscreen would, so exit is
    // toolbar-button-only and the label drops "(Esc)" accordingly.
    toolbarFullscreenExitPseudo: () => 'Exit fullscreen',
    toolbarVirtualKeyboard: () => 'Show virtual keyboard',
    toolbarVirtualKeyboardHide: () => 'Hide virtual keyboard',
    toolbarAspectNative: () => 'Switch to 4:3 display',
    toolbarAspect43: () => 'Switch to 1:1 pixel display',
    toolbarMenuMouseCapture: () => 'Mouse capture',
    toolbarMenuAspect43: () => '4:3 display',
    toolbarMore: () => 'More',
    toolbarGroupDisplay: () => 'Display',
    toolbarGroupInput: () => 'Input',
    toolbarGroupDisk: () => 'Disk',
    toolbarGroupState: () => 'State',
    stateDiskMismatch: ({ saved, current }) =>
      `The mounted disks differ from when the state was saved.\nSaved: ${saved}\nCurrent: ${current}\nLoading anyway may cause the guest to misbehave. Continue?`,
    toolbarDiskLibrary: () => 'Disk Library',
    toolbarFileManager: () => 'File Transfer',
    langToggle: () => '日本語',
    toolbarLanguage: () => 'Language',
    fdSlotLabel: ({ drive }) => `FDD${drive}`,
    hddSlotLabel: () => 'HDD',
    fdEmpty: () => 'empty',
    slotInsert: () => 'Insert disk',
    slotEject: () => 'Eject disk',
    slotLockedWhileRunning: () => 'The HDD cannot be swapped while running (reload the page first)',
    scsiSlotLabel: () => 'SCSI',
    scsiEmpty: () => 'Empty',
    scsiUnavailable: () => 'Not available here (a secure connection is required)',
    scsiImporting: ({ percent }) => `Importing… ${percent}%`,
    scsiInsertedNeedsRestart: () => 'SCSI disk inserted. It will be used from the next boot.',
    scsiLockedWhileRunning: () => 'The SCSI disk cannot be changed while running.',
    scsiLibrarySectionTitle: () => 'SCSI Disks',
    scsiLibrarySectionDescription: () =>
      'Images that can be assigned to the SCSI slot. Deleting one cannot be undone (the one currently inserted cannot be deleted).',
    scsiLibraryDeleteDisabledMounted: () => 'Cannot delete: currently inserted in the SCSI slot',
    scsiCreateBlank: () => 'Create blank SCSI disk (choose size, FAT16)',
    scsiBlankSizePrompt: ({ min, max }) => `Enter the SCSI disk size in MB (${min}–${max})`,
    scsiBlankSizeInvalidNotANumber: () => 'Please enter a number',
    scsiBlankSizeInvalidNotInteger: () => 'Please enter a whole number of MB. Decimals are not allowed',
    scsiBlankSizeInvalidTooSmall: ({ min }) => `Please enter at least ${min}MB`,
    scsiBlankSizeInvalidTooLarge: ({ max }) =>
      `The limit is ${max}MB (the SCSI HLE stores the image size as a signed 32-bit integer; larger sizes get corrupted)`,
    statusScsiBlankCreated: ({ name, sizeMiB }) =>
      `Created blank SCSI disk "${name}" (${sizeMiB}MB). It will be used from the next boot.`,
    slotEjectConfirmRunning: () =>
      'Eject the disk while the machine is running? Software reading the disk may freeze.\n(To swap disks, just insert the next disk without ejecting.)',
    diskLampLabel: ({ drive }) => `${drive} access lamp`,
    slotInsertFromLibrary: () => 'Insert from library',
    slotInsertFromLibraryTitle: ({ drive }) => `Insert into ${drive}`,
    slotCreateBlank: () => 'New Blank',
    hddCreateBlank: () => 'Create blank HDD (40MB, FAT16)',
    statusHddBlankCreated: ({ name }) =>
      `Created and set blank HDD "${name}" (40MB, FAT16). It is not bootable on its own — boot Human68k from an FDD and use it as a data drive.`,
    hddSlotTitle: () => 'Hard disk (SASI)',
    scsiSlotTitle: () => 'Hard disk (SCSI)',
    slotDownload: () => 'Download',
    libraryMenuEmpty: () => 'No saved disk images yet.',
    alertBiosMissing: () => 'Please set the BIOS files (IPLROM.DAT / CGROM.DAT).',
    alertBootFailed: ({ message }) => `Failed to start: ${message}`,
    toastResetting: () => 'Resetting…',
    alertResetFailed: ({ message }) =>
      `Reset failed: ${message}\nPlease reload the page.`,
    alertDownloadNoImage: () => 'No disk is inserted in this drive.',
    settingsTitle: () => 'Settings',
    settingsDescription: () =>
      'Configure the BIOS files (IPLROM.DAT / CGROM.DAT), machine settings, and serial port. Settings are saved in your browser.',
    settingsBiosSectionTitle: () => 'BIOS Settings',
    settingsMachineSectionTitle: () => 'Machine Configuration',
    settingsMachineSectionNote: () => '(default: X68000 XVI equivalent = 16MHz / 2MB)',
    settingsMachineResetNote: () => 'Reset is required for changes to take effect.',
    settingsCpuSpeedLabel: () => 'CPU Speed',
    settingsRamSizeLabel: () => 'RAM',
    settingsSpeedTitle: () => 'Emulation Speed',
    settingsSpeedNote: () =>
      'The multiplier used when the toolbar speed button is turned on. Applied instantly, no reset needed, and not saved. Unlimited mode has no audio.',
    settingsSpeedLabel: () => 'Multiplier when the speed button is on',
    settingsSpeedUnlimited: () => 'Unlimited',
    settingsSpeedActualPrefix: () => 'Actual',
    settingsSpeedLockedByAutoClock: () =>
      'Locked to 100% while ∞MHz is active (both would compete for the same time)',
    settingsSerialTitle: () => 'Serial Port',
    settingsSerialStatusLabel: () => 'Status',
    settingsSerialBaudLabel: () => 'Baud rate',
    settingsSerialBaudNote: () => 'Select the same baud rate as the X68000 guest.',
    settingsSerialBaudMismatch: ({ guestBaudRate, selectedBaudRate }) =>
      `The X68000 guest is configured for approximately ${guestBaudRate} bps, but the browser port uses ${selectedBaudRate} bps. Communication may fail.`,
    settingsSerialConnect: () => 'Connect',
    settingsSerialDisconnect: () => 'Disconnect',
    settingsSerialConnected: () => 'Connected',
    settingsSerialDisconnected: () => 'Disconnected',
    settingsSerialConnecting: () => 'Connecting…',
    settingsSerialError: () => 'Connection error',
    settingsSerialUnsupported: () =>
      'Web Serial API is not available in this browser. Use a supported desktop browser.',
    settingsSerialCoreUnsupported: () =>
      'The loaded emulator core does not support the serial bridge. Reload the page.',
    settingsClose: () => 'Close',
    biosStatusUser: () => 'Configured',
    biosStatusBundled: () => 'Using bundled ROM (replaceable)',
    biosStatusNone: () => 'Not set',
    libraryDialogTitle: () => 'Disk Library',
    libraryDialogDescription: () =>
      'Disk images you have inserted are saved in your browser. Choose a drive (FDD0 / FDD1 / HDD) to insert one from here.',
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
      'Transfer files between this PC and disk images in FDD0/FDD1/HDD, SCSI disks, or the library. File names are automatically converted to 8.3 format. Writing to a running FDD slot is treated as reinserting the disk. The HDD is read-only while the emulator is running. An image currently inserted in the SCSI slot cannot be accessed while running.',
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
    fmScsiTooLargeNote: () => 'excluded: over 256MB (the implementation loads the whole image into memory)',
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
    errNotFormatted: () =>
      'This disk is unformatted, or not readable as FAT12/16. Format it with the Human68k FORMAT command, or create a pre-formatted blank disk.',

    urlDiskResumed: ({ label, name }) => `${label}: Resumed the previously saved "${name}".`,
    urlFetching: ({ label, name }) => `${label}: Fetching "${name}"...`,
    urlFetchingProgress: ({ label, name, loaded, total }) =>
      `${label}: Fetching "${name}"... ${loaded}${total ? ` / ${total}` : ''}`,
    urlFetchFailedNetwork: ({ url }) =>
      `Failed to fetch the disk image: ${url}\n(the origin may not support CORS)`,
    urlFetchFailedHttp: ({ url, status }) => `Failed to fetch the disk image: ${url} (HTTP ${status})`,
    urlFetchFailedOneDrive: ({ url }) =>
      `Failed to fetch the disk image: ${url}\nOneDrive share links can't be used due to OneDrive's own restrictions. Please use Google Drive or Dropbox instead.`,
    urlFetchFailedNeedsProxy: ({ url }) =>
      `Failed to fetch the disk image: ${url}\nThis source can only be fetched through the relay server, but this build has no relay (VITE_DISK_PROXY) configured. If you're hosting this yourself, set VITE_DISK_PROXY (see the README for details).`,
    urlFetchFailedProxy: ({ url, reason }) => `Failed to fetch the disk image: ${url}\n${reason}`,
    urlFetchFailedHtmlPage: ({ url }) =>
      `Failed to fetch the disk image: ${url}\nThe fetch returned a web page instead of a disk image. Check that the share link is public ("Anyone with the link"), or drag and drop the downloaded file onto the screen instead.`,
    urlProxyReasonBadUrl: () => 'The relay server could not parse the URL.',
    urlProxyReasonOriginNotAllowed: () => 'The relay server does not allow requests from this site.',
    urlProxyReasonHostNotAllowed: () => 'The relay server does not allow forwarding to this source.',
    urlProxyReasonTooLarge: () => 'The file exceeds the relay server\'s size limit.',
    urlProxyReasonRateLimited: () => 'The relay server rate limit was reached. Please try again later.',
    urlProxyReasonUpstreamFailed: () => 'The relay server failed to fetch from the source.',
    urlProxyReasonRedirectNotAllowed: () =>
      'The source tried to redirect to another site (e.g. a login page), so the request was blocked. Check that sharing is set to "Anyone with the link" and that you copied the full share link.',
    urlProxyReasonUnknown: ({ status }) => `The relay server returned an error (HTTP ${status}).`,
    urlLoadFailedToast: ({ label, message }) => `Failed to load ${label}: ${message}`,
    urlSystemFetchFailed: () => 'Failed to fetch the bundled system disk.',
    sproutShareLoaded: ({ tags }) => `Loaded a program made with Sprout68k${tags}.`,
    sproutShareFailed: ({ message }) => `Could not open the shared link: ${message}`,
    urlArchiveResumed: ({ label, count }) =>
      `${label}: Restored ${count} previously extracted disk image(s) from the library (no re-download).`,
    urlArchiveNoDiskImage: ({ label }) => `${label}: No disk image was found inside the archive.`,
    urlArchiveKindMismatch: ({ label, kind }) =>
      `${label}: The archive doesn't contain a ${kind === 'hdd' ? 'HDD' : 'FD'} disk image.`,
    urlArchiveNeedsSelection: () =>
      'The archive contains multiple disk images, so the library was opened. Please choose which image to use (auto-boot is skipped).',
    urlUnmountedOtherSlots: () =>
      'Ejected the other slots to boot with the disk configuration specified in the URL (the disks have not been deleted).',
    urlLibSlotLabel: ({ index }) => `Library ${index}`,
    audioMutedBanner: () =>
      'Audio is muted due to autoplay restrictions. Tap or click the screen, or press a key, to enable sound.',

    toolbarGamepad: () => 'Joystick Settings',
    gamepadDialogTitle: () => 'Joystick Settings',
    gamepadDialogDescription: () =>
      'Check and edit the button/axis assignment for each connected gamepad. Settings are saved in your browser, per pad.',
    gamepadDialogClose: () => 'Close',
    gamepadNoPads: () => 'No pad detected. Press any button on the pad once to have it recognized.',
    gamepadConnectedTitle: () => 'Connected Pads',
    gamepadPortAssigned: ({ port }) => `Port ${port}`,
    gamepadPortUnassigned: () => 'Unassigned',
    gamepadLiveTitle: ({ name, portLabel }) => `${name} (${portLabel})`,
    gamepadPhysicalTitle: () => 'Physical Input',
    gamepadX68kTitle: () => 'X68000 Input',
    gamepadTargetUp: () => 'Up',
    gamepadTargetDown: () => 'Down',
    gamepadTargetLeft: () => 'Left',
    gamepadTargetRight: () => 'Right',

    gamepadEditingPadLabel: () => 'Editing Pad',
    gamepadBindingsTitle: () => 'Edit Assignment',
    gamepadDetectBtn: () => 'Detect (Replace)',
    gamepadDetectBtnTitle: () => 'Sets the next input you press as this row\'s assignment, replacing any existing ones',
    gamepadDetectWaiting: () => 'Waiting for input… (Esc to cancel)',
    gamepadCancelBtn: () => 'Cancel',
    gamepadCancelBtnTitle: () => 'Stops waiting for input and returns to normal',
    gamepadRemoveBindingLabel: () => 'Remove',
    gamepadComboPlaceholder: () => 'Select an input to add…',
    gamepadGenericSectionDesc: () =>
      'Assigns keyboard keys to pad buttons, for games that use key presses to start or pause.',
    gamepadGenericEmptyLabel: () => 'No assignment',
    gamepadGenericDetectBtnTitle: () =>
      'Press this, then press a pad button — a menu to pick the key to assign will appear (existing assignments are kept)',
    gamepadGenericDetectBtn: () => 'Assign a Key',
    gamepadComboKeyboardGroup: () => 'Keyboard',
    gamepadComboJoystickGroup: () => 'Joystick (Physical Input)',
    gamepadButtonLabel: ({ index }) => `Button ${index}`,
    gamepadAxisLabel: ({ index, dir }) => `Axis ${index} ${dir}`,
    gamepadAxisInvalidSuffix: () => '(invalid, out of range)',
    gamepadAxisUncalibratedSuffix: () => '(not calibrated yet — move it once to use)',
    gamepadAxisCalibratingSuffix: () => '(calibrating — please wait a few seconds)',
    gamepadDeadzoneLabel: () => 'Deadzone',
    gamepadResetPresetBtn: () => 'Reset to Defaults',
    gamepadResetPresetBtnTitle: () =>
      'Resets to the defaults for the connected pad (8BitDo M30/Micro get a dedicated preset; others get XInput defaults or blank)',
    gamepadPortDeviceLabel: ({ port }) => `Port ${port} Pad`,
    gamepadPortAutoOption: () => 'Automatic (connection order)',
    gamepadPadTypeTitle: () => 'Pad Type',
    gamepadPadTypeDeviceLabel: ({ port }) => `Port ${port} Pad Type`,
    gamepadPadTypeDefault: () => 'Default (2 Buttons)',
    gamepadPadTypeCpsfMd: () => 'CPSF-MD (8 Buttons)',
    gamepadPadTypeCpsfSfc: () => 'CPSF-SFC (8 Buttons)',
    gamepadPadTypeRestartHint: () => 'This takes effect when the core restarts (via the Reset button).',

    gamepadPositionalButtonLabel: ({ index, position }) => `#${index} (${position})`,
    gamepadPosDown: () => 'Down',
    gamepadPosRight: () => 'Right',
    gamepadPosLeft: () => 'Left',
    gamepadPosUp: () => 'Up',
    gamepadPosL: () => 'L',
    gamepadPosR: () => 'R',
    gamepadPosL2: () => 'L2',
    gamepadPosR2: () => 'R2',
    gamepadPosSelect: () => 'Select',
    gamepadPosStart: () => 'Start',
    gamepadPosL3: () => 'L3',
    gamepadPosR3: () => 'R3',
    gamepadPosDpadUp: () => 'D-Pad Up',
    gamepadPosDpadDown: () => 'D-Pad Down',
    gamepadPosDpadLeft: () => 'D-Pad Left',
    gamepadPosDpadRight: () => 'D-Pad Right',
    gamepadPosHome: () => 'Home',

    toolbarInputPanel: () => 'Show input panel',
    toolbarInputPanelHide: () => 'Hide input panel',
    inputPanelSwitchKeyboard: () => 'Switch to virtual keyboard',
    inputPanelSwitchPad: () => 'Switch to virtual pad',
    inputPanelSwitchTrackpad: () => 'Switch to virtual trackpad',
    vpadProfileJoy2Button: () => 'Joystick (2 buttons)',
    vpadProfileCursorSpace: () => 'Cursor keys + Space',
    vpadProfileTenkey: () => 'Tenkey',
    vpadProfileJoy6Button: () => 'Joystick (6 buttons)',
    vpadEditAssignmentsMenuItem: () => 'Edit assignments…',

    inputProfileEditorTitle: () => 'Edit Assignments',
    inputProfileEditorDescription: () => 'Edit which input (joystick/keyboard) each virtual pad part sends.',
    inputProfileSelectLabel: () => 'Profile',
    inputProfileDuplicateBtn: () => 'Duplicate',
    inputProfileRenameBtn: () => 'Rename',
    inputProfileDeleteBtn: () => 'Delete',
    inputProfileBuiltinReadonlyNote: () => 'Built-in profiles cannot be edited. Duplicate it first.',
    inputProfileBindingsTitle: () => 'Assignments',
    inputProfileClearBindingBtn: () => 'Clear this assignment',
    inputProfileRowSelectedHint: () => 'Pick an input below (keyboard/joystick) to assign.',
    inputProfilePickerTitle: () => 'Pick an input to assign',
    inputProfileTabKeyboard: () => 'Keyboard',
    inputProfileTabJoystick: () => 'Joystick',
    inputProfileTrg3PlusNote: () => "TRG3 and above won't work while port 1's pad type stays 2-button.",
    inputProfileUnassigned: () => 'None',
    inputProfileDuplicateLabel: ({ name }) => `${name} copy`,
    inputProfileDuplicatePrompt: ({ name }) => `Duplicating "${name}". Enter a new name.`,
    inputProfileRenamePrompt: () => 'Enter a new name.',
    inputProfileDeleteConfirm: ({ name }) => `Delete "${name}"?`,
    inputProfileAutoDuplicatedToast: ({ name }) => `Duplicated built-in profile "${name}"`,
    inputProfileSourceDpadUp: () => 'Stick Up',
    inputProfileSourceDpadDown: () => 'Stick Down',
    inputProfileSourceDpadLeft: () => 'Stick Left',
    inputProfileSourceDpadRight: () => 'Stick Right',
    inputProfileSourceOpt: ({ n }) => `Aux ${n}`,
    inputProfileAddKeyBtn: () => 'Add Key',
    inputProfileAddKeyCancelBtn: () => 'Cancel',
    inputProfileAddKeyWaitingHint: () => 'Press a key (Esc to cancel)',
    inputProfileRemoveRowBtn: () => 'Remove',
    toolbarHostKey: () => 'Keyboard Assignment',
    hostKeyDialogTitle: () => 'Keyboard Assignment',
    hostKeyDialogDescription: () =>
      "Lets you play joystick-only software with the physical keyboard even without a joystick. Also useful for remapping keys for numpad-only software.",
    hostKeyEnableLabel: () => 'Enable keyboard assignment',
    hostKeyProfileSelectLabel: () => 'Profile',
    hostKeyBindingsTitle: () => 'Assignments',
    hostKeyDisableTypingNote: () => 'When enabled, assigned keys will no longer work as normal text input.',
    hostKeyProfileArrowsJoy: () => 'Arrows -> Joystick (2 Buttons)',
    hostKeyProfileArrowsJoy6: () => 'Arrows -> Joystick (6 Buttons)',
    hostKeyProfileTenkey: () => 'Arrows -> Numpad',
    workerModeUnsupported: () =>
      'Not supported yet under ?worker=1 (SRAM and save/load state are migrated in a later step).',
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

/**
 * 言語名をその言語自身の表記で返す(UI表示言語に関わらず一定。「日本語」「English」は自言語表記が慣例)。
 * オーバーフローメニューの言語切替行の右端(現在の言語名)に使う。
 */
export function langSelfName(lang: Lang): string {
  return lang === 'ja' ? '日本語' : 'English';
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
      case 'notFormatted':
        return t('errNotFormatted');
      default:
        break;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
