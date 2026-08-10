import { describe, expect, it } from 'vitest';
import { parseRamSizeParam } from '../src/url-params';

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
