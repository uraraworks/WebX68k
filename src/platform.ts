/**
 * 実行環境(主に iOS 判定)。DOM/BOM に一切触れない純関数として main.ts から切り出した。
 * 理由: Node環境(vitest)から import してロジック自体を検証できるようにするため
 * (iOS実機でしかUAを偽装できず、ブラウザ側で確認できないため純関数化が必須)。
 */

/**
 * iOS(iPhone/iPad/iPod、および iPadOS 13以降の「Macとして名乗る」端末)かどうかを判定する。
 *
 * `navigator.platform` は非推奨だが、iPadOS 13以降は既定でデスクトップ版Safariの
 * User-Agentを名乗る(`navigator.userAgent` に "iPad" が出ない)ため、
 * `platform === 'MacIntel'` かつ `maxTouchPoints > 1`(タッチ対応の実Mac相当の判定)
 * との組み合わせでしか実用上見分けられない。
 */
export function isIOSDevice(
  userAgent: string,
  platform: string,
  maxTouchPoints: number,
): boolean {
  if (/iP(hone|ad|od)/.test(userAgent)) return true;
  return platform === 'MacIntel' && maxTouchPoints > 1;
}

/** 現在の実行環境(ブラウザ)が iOS かどうか。判定ロジック本体は isIOSDevice() 参照。 */
export function isIOS(): boolean {
  return isIOSDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
}
