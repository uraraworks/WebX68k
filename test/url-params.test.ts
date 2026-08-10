import { describe, expect, it } from 'vitest';
import { parseCpuSpeedParam, parseRamSizeParam } from '../src/url-params';

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
  ])('%s -> %s', (input, expected) => {
    expect(parseCpuSpeedParam(input)).toBe(expected);
  });

  it.each([null, '', '20', '0', 'abc', '16.5'])('%s -> null', (input) => {
    expect(parseCpuSpeedParam(input)).toBeNull();
  });
});
