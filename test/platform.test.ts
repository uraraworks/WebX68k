import { describe, expect, it } from 'vitest';
import { isIOSDevice } from '../src/platform';

// isIOSDevice() は src/platform.ts に切り出した DOM/BOM 非依存の純関数。
// iOS実機でしか navigator の値を偽装できず、ブラウザ側での確認手段がないため、
// UA/platform/maxTouchPoints を引数として渡せる形にしてここで検証する
// (aspect.ts・aspect-ratio-target-size.test.ts と同じ切り出し方針)。

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD_LEGACY_UA =
  'Mozilla/5.0 (iPad; CPU OS 12_5_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1';
const IPOD_UA =
  'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1';
// iPadOS 13以降は既定でデスクトップ版Safariを名乗るため、UAにはiPadの文字列が出ない。
const IPADOS13_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

describe('iOS判定(src/platform.ts の isIOSDevice)', () => {
  it('iPhoneのUAはtrue', () => {
    expect(isIOSDevice(IPHONE_UA, 'iPhone', 5)).toBe(true);
  });

  it('iPadOS12以前(UAにiPadを含む)のUAはtrue', () => {
    expect(isIOSDevice(IPAD_LEGACY_UA, 'iPad', 5)).toBe(true);
  });

  it('iPod touchのUAはtrue', () => {
    expect(isIOSDevice(IPOD_UA, 'iPod', 5)).toBe(true);
  });

  it('iPadOS13以降(MacIntel名乗り + マルチタッチ)はtrue', () => {
    expect(isIOSDevice(IPADOS13_DESKTOP_UA, 'MacIntel', 5)).toBe(true);
  });

  it('通常のMac(MacIntel + タッチ無し)はfalse', () => {
    expect(isIOSDevice(MAC_UA, 'MacIntel', 0)).toBe(false);
  });

  it('Windowsはfalse', () => {
    expect(isIOSDevice(WINDOWS_UA, 'Win32', 0)).toBe(false);
  });

  it('Androidはfalse', () => {
    expect(isIOSDevice(ANDROID_UA, 'Linux armv8l', 5)).toBe(false);
  });
});
