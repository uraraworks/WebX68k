// HostFS (feature/hostfs) P2a #2 用: ファイルの lastModified をFILBUFの日付/時刻形式
// (filbuf.ts の FakeFsDate/FakeFsTime、ローカル時刻)へ変換する。
//
// 親からの指示書のとおり:
//   - ファイルは lastModified をローカル時刻のDOS形式に直す。
//   - ディレクトリは日時が取れないので、1980-01-01 00:00とする。

import { type FakeFsDate, type FakeFsTime, encodeDate, encodeTime } from './filbuf';

export const DIRECTORY_DATE: FakeFsDate = { year: 1980, month: 1, day: 1 };
export const DIRECTORY_TIME: FakeFsTime = { hour: 0, minute: 0, second: 0 };

export function dateFromMillis(ms: number): FakeFsDate {
  const d = new Date(ms);
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

export function timeFromMillis(ms: number): FakeFsTime {
  const d = new Date(ms);
  return { hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() };
}

/**
 * $4f(_FILEDATE)用: FILBUFの日付/時刻ワードと同じエンコードを、DATETIME(long、
 * 上位ワード=日付・下位ワード=時刻。PRO-68Kマニュアルp.195)へまとめて詰める。
 */
export function packDateTime(date: FakeFsDate, time: FakeFsTime): number {
  return (((encodeDate(date) & 0xffff) << 16) | (encodeTime(time) & 0xffff)) >>> 0;
}
