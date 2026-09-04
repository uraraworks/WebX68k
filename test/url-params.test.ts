import { describe, expect, it } from 'vitest';
import {
  AUTO_CPU_SPEED,
  AUTO_CPU_SPEED_TURBO,
  CPU_SPEED_OPTIONS,
  cpuSpeedOptionForMhz,
  parseAspectModeParam,
  parseCpuSpeedParam,
  parseRamSizeParam,
} from '../src/url-params';

describe('parseRamSizeParam', () => {
  it.each([
    ['12', '12MB'],
    ['12MB', '12MB'],
    [' 8mb ', '8MB'],
    ['1', '1MB'],
  ])('%s -> %s', (input, expected) => {
    expect(parseRamSizeParam(input)).toBe(expected);
  });

  it.each([null, '', '0', '13', 'abc', '2.5'])('%s -> null', (input) => {
    expect(parseRamSizeParam(input)).toBeNull();
  });
});

describe('parseCpuSpeedParam', () => {
  it.each([
    ['16', '16Mhz'],
    ['10mhz', '10Mhz'],
    [' 25MHZ ', '25Mhz'],
    ['33', '33Mhz (OC)'],
    ['66Mhz', '66Mhz (OC)'],
    ['100Mhz (OC)', '100Mhz (OC)'],
    // 選択肢に無い値もコアが受け付けるので、範囲内なら正規化して通す。
    ['20', '20Mhz'],
    ['200', '200Mhz (OC)'],
    ['777Mhz', '777Mhz (OC)'],
    ['1000', '1000Mhz (OC)'],
  ])('%s -> %s', (input, expected) => {
    expect(parseCpuSpeedParam(input)).toBe(expected);
  });

  it.each(['auto', 'AUTO', ' max ', 'inf', '∞'])('%s -> auto', (input) => {
    expect(parseCpuSpeedParam(input)).toBe(AUTO_CPU_SPEED);
  });

  // 'auto-max' は 'auto' の前に判定しないと 'auto' 側へ吸われる。
  it.each(['auto-max', 'AUTO-MAX', ' automax ', 'auto_max'])('%s -> auto-max', (input) => {
    expect(parseCpuSpeedParam(input)).toBe(AUTO_CPU_SPEED_TURBO);
  });

  // 範囲外は無効値。下限は実機の10MHz、上限はコア側 PX68K_CLOCK_MHZ_MAX と揃えた1000。
  it.each([null, '', '0', '9', '1001', 'abc', '16.5'])('%s -> null', (input) => {
    expect(parseCpuSpeedParam(input)).toBeNull();
  });
});

describe('CPU_SPEED_OPTIONS', () => {
  // 選択肢の表記と正規化規則がずれると、UIで選んだ値がコアに別物として渡る。
  it.each(CPU_SPEED_OPTIONS)('%s はそのまま正規化される', (option) => {
    expect(parseCpuSpeedParam(option)).toBe(option);
  });
});

describe('cpuSpeedOptionForMhz', () => {
  it.each([
    [10, '10Mhz'],
    [16, '16Mhz'],
    [25, '25Mhz'],
    [26, '26Mhz (OC)'],
    [100, '100Mhz (OC)'],
    [1000, '1000Mhz (OC)'],
  ])('%s -> %s', (mhz, expected) => {
    expect(cpuSpeedOptionForMhz(mhz)).toBe(expected);
  });

  it('範囲外は端に丸める', () => {
    expect(cpuSpeedOptionForMhz(1)).toBe('10Mhz');
    expect(cpuSpeedOptionForMhz(99999)).toBe('1000Mhz (OC)');
  });
});

describe('parseAspectModeParam', () => {
  it.each([
    ['4:3', '4:3'],
    ['43', '4:3'],
    ['4-3', '4:3'],
    ['4/3', '4:3'],
    [' 4:3 ', '4:3'],
    ['4:3'.toUpperCase(), '4:3'],
    ['native', 'native'],
    ['1:1', 'native'],
    ['11', 'native'],
    ['NATIVE', 'native'],
  ])('%s -> %s', (input, expected) => {
    expect(parseAspectModeParam(input)).toBe(expected);
  });

  it.each([null, '', '4:4', 'abc', '3:4'])('%s -> null', (input) => {
    expect(parseAspectModeParam(input)).toBeNull();
  });
});
