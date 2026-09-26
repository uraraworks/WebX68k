// src/sram-boot-device.ts のテスト。
// docs/STORAGE-SCSI.md「SCSI起動 段階4」参照。SRAMの起動デバイス設定
// ($ed0018/$ed000c)の判定・書き込みバイト列生成・SCSIスロットのロック判定を
// 純粋関数として切り出し、実機/実コアを起動せずに検証する。
import { describe, expect, it } from 'vitest';
import {
  bootDeviceWriteEntries,
  computeBootedFromScsi,
  describeBootDevice,
  reinjectBootAddrFor,
  shouldLockScsiSlot,
  SCSI_000C,
  SCSI_0018,
  STANDARD_000C,
  STANDARD_0018,
} from '../src/sram-boot-device';

describe('describeBootDevice', () => {
  it('シグネチャ不一致(未初期化SRAM)は unknown', () => {
    expect(describeBootDevice(false, SCSI_0018, SCSI_000C)).toEqual({
      kind: 'unknown',
      raw0018: -1,
      raw000c: -1,
    });
  });

  it('$ed0018=$0000 は standard($ed000cの値は問わない)', () => {
    expect(describeBootDevice(true, STANDARD_0018, 0x00bffffc).kind).toBe('standard');
    expect(describeBootDevice(true, STANDARD_0018, 0x12345678).kind).toBe('standard');
  });

  it('$ed0018=$a000 かつ $ed000c=$00ea0020 は scsi', () => {
    expect(describeBootDevice(true, SCSI_0018, SCSI_000C).kind).toBe('scsi');
  });

  it('$ed0018=$a000 だが $ed000c が食い違うと other(SCSIとして書いた値ではない)', () => {
    const info = describeBootDevice(true, SCSI_0018, 0x00000000);
    expect(info.kind).toBe('other');
    expect(info.raw0018).toBe(SCSI_0018);
  });

  it('既知の2値以外の $ed0018 は other', () => {
    expect(describeBootDevice(true, 0x1234, 0).kind).toBe('other');
  });
});

describe('bootDeviceWriteEntries', () => {
  it('scsi は $ed0018=$a000 / $ed000c=$00ea0020 の6バイトを書く', () => {
    const entries = bootDeviceWriteEntries('scsi');
    expect(entries).toEqual([
      { offset: 0x0c, value: 0x00 },
      { offset: 0x0d, value: 0xea },
      { offset: 0x0e, value: 0x00 },
      { offset: 0x0f, value: 0x20 },
      { offset: 0x18, value: 0xa0 },
      { offset: 0x19, value: 0x00 },
    ]);
  });

  it('standard は段階1a実測の既定値($00bffffc)に戻す', () => {
    const entries = bootDeviceWriteEntries('standard');
    expect(entries).toEqual([
      { offset: 0x0c, value: 0x00 },
      { offset: 0x0d, value: 0xbf },
      { offset: 0x0e, value: 0xff },
      { offset: 0x0f, value: 0xfc },
      { offset: 0x18, value: 0x00 },
      { offset: 0x19, value: 0x00 },
    ]);
    expect(STANDARD_000C).toBe(0x00bffffc);
  });
});

describe('reinjectBootAddrFor', () => {
  it('scsi は再注入対象アドレスを返す', () => {
    expect(reinjectBootAddrFor('scsi')).toBe(SCSI_000C);
  });
  it('standard は0(何もしない=IPL既定のまま)', () => {
    expect(reinjectBootAddrFor('standard')).toBe(0);
  });
});

describe('computeBootedFromScsi', () => {
  it('標準を選んでいれば常にfalse(SCSI側の読み出しがあってもロック対象にしない)', () => {
    expect(computeBootedFromScsi('standard', true, 0, 5)).toBe(false);
  });
  it('SCSIを選んでいてもマウントされていなければfalse', () => {
    expect(computeBootedFromScsi('scsi', false, 0, 5)).toBe(false);
  });
  it('SCSIを選び、マウント済みで、リセット後に読み出しカウンタが増えていればtrue', () => {
    expect(computeBootedFromScsi('scsi', true, 3, 4)).toBe(true);
  });
  it('SCSIを選び、マウント済みでも読み出しカウンタが増えていなければfalse(制御が渡っていない=段階2b等)', () => {
    expect(computeBootedFromScsi('scsi', true, 3, 3)).toBe(false);
  });
  it('カウンタが取れない古いコア(-1)ではフォールバックしてtrue', () => {
    expect(computeBootedFromScsi('scsi', true, -1, -1)).toBe(true);
  });
});

describe('shouldLockScsiSlot', () => {
  it('起動中かつSCSI起動のときだけロックする', () => {
    expect(shouldLockScsiSlot(true, true)).toBe(true);
    expect(shouldLockScsiSlot(true, false)).toBe(false);
    expect(shouldLockScsiSlot(false, true)).toBe(false);
    expect(shouldLockScsiSlot(false, false)).toBe(false);
  });
});
