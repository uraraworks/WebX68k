import { describe, expect, it } from 'vitest';
import { dateFromMillis, timeFromMillis, DIRECTORY_DATE, DIRECTORY_TIME } from '../src/hostfs/dos-datetime';

describe('dos-datetime', () => {
  it('lastModifiedをローカル時刻の年月日へ変換する', () => {
    const d = new Date(2026, 8, 11, 12, 34, 56); // 2026-09-11 12:34:56 ローカル
    const date = dateFromMillis(d.getTime());
    expect(date).toEqual({ year: 2026, month: 9, day: 11 });
  });

  it('lastModifiedをローカル時刻の時分秒へ変換する', () => {
    const d = new Date(2026, 8, 11, 12, 34, 56);
    const time = timeFromMillis(d.getTime());
    expect(time).toEqual({ hour: 12, minute: 34, second: 56 });
  });

  it('ディレクトリの既定日時は1980-01-01 00:00', () => {
    expect(DIRECTORY_DATE).toEqual({ year: 1980, month: 1, day: 1 });
    expect(DIRECTORY_TIME).toEqual({ hour: 0, minute: 0, second: 0 });
  });
});
