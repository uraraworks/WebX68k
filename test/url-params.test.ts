import { describe, expect, it } from 'vitest';
import {
  parseAspectModeParam,
  parseCpuSpeedParam,
  parseRamSizeParam,
  parseWorkerModeParam,
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
  ])('%s -> %s', (input, expected) => {
    expect(parseCpuSpeedParam(input)).toBe(expected);
  });

  it.each([null, '', '20', '0', 'abc', '16.5'])('%s -> null', (input) => {
    expect(parseCpuSpeedParam(input)).toBeNull();
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

describe('parseWorkerModeParam', () => {
  it.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['yes', true],
    ['on', true],
    [' 1 ', true],
    ['0', false],
    ['false', false],
    ['FALSE', false],
    ['no', false],
    ['off', false],
  ])('%s -> %s', (input, expected) => {
    expect(parseWorkerModeParam(input)).toBe(expected);
  });

  it.each([null, '', '2', 'abc', 'worker'])('%s -> null', (input) => {
    expect(parseWorkerModeParam(input)).toBeNull();
  });
});
