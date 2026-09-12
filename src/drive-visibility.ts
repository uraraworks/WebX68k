// ドライブ行(HDD(SASI)/SCSI-HDD/HostFS)の表示切り替え(feature/hostfs 追加分)。
//
// 親からの指示書のとおり、この3行は初期値で非表示、FDDの2行は常に表示する。
// 「…」メニューの3つのトグル(aria-pressed)でON/OFFでき、状態はlocalStorageへ保存する
// (main.ts側、webx68k.<名前>の既存命名規約に合わせる)。
//
// ただし「ディスクが入っている(URLパラメータ経由を含む)」「HostFSがつながっている
// (再接続待ちを含む)」行は、トグルがOFFでも隠さない(空の行を見せない意図でトグルを
// 導入したのに、既に使っている行まで隠すと利用者が「消えた」と誤解するため)。
//
// この判定を「行のhidden属性を直接いじるコード」から切り離した純関数にすることで、
// DOM無しでテストできるようにする(親からの指示書のとおり)。

/**
 * ドライブ行を表示するかどうか。
 * @param userPref  トグル(localStorage)で利用者が選んだ表示希望。
 * @param hasContent その行が既に使われているか(ディスク挿入済み/HostFS接続済み・再接続待ち)。
 */
export function shouldShowDriveRow(userPref: boolean, hasContent: boolean): boolean {
  return userPref || hasContent;
}
