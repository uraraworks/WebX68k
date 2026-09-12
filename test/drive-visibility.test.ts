import { describe, expect, it } from 'vitest';
import { shouldShowDriveRow } from '../src/drive-visibility';

// shouldShowDriveRow()はHDD(SASI)/SCSI-HDD/HostFSの3行の表示可否を決める純関数。
// 「初期値は非表示」「トグルONで表示」「トグルOFFでも中身があれば表示」の3条件を確認する
// (親からの指示書のとおり: URLパラメータ経由のディスクや再接続待ちのHostFSも「中身あり」扱い)。

describe('shouldShowDriveRow (src/drive-visibility.ts)', () => {
  it('トグルOFF・中身なしなら隠す(初期値)', () => {
    expect(shouldShowDriveRow(false, false)).toBe(false);
  });

  it('トグルONなら中身が無くても表示する', () => {
    expect(shouldShowDriveRow(true, false)).toBe(true);
  });

  it('トグルOFFでも中身があれば表示する(ディスク挿入済み/HostFS接続済み・再接続待ち)', () => {
    expect(shouldShowDriveRow(false, true)).toBe(true);
  });

  it('トグルON・中身ありでも表示する', () => {
    expect(shouldShowDriveRow(true, true)).toBe(true);
  });
});
