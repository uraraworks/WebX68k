// tools/version.mjs の formatVersion() を純関数として検証する。
//
// 注意: このテストは実行マシンのローカルタイムゾーンに依存しない実装であることを
// 期待しているが、テスト自体はローカルTZを差し替えずに実行する。もし実装が誤って
// ローカルTZ依存API(toLocaleString/getHours等)を使っていても、このマシンが
// たまたまJSTであれば偶然テストが通ってしまう可能性がある。
// TZを実際に差し替えた「本命」の決定性検証は tools/verify_version_determinism.mjs
// (TZ=UTC / TZ=America/New_York で子プロセスを起動して比較する)が担っている。
// このファイルはあくまで文字列整形ロジックそのものの単体テスト。

import { describe, expect, it } from 'vitest';
// @ts-expect-error tools/ は tsconfig の include 対象外(src のみ)のため型情報が無い。
import { formatVersion, UNKNOWN_VERSION } from '../tools/version.mjs';

describe('formatVersion', () => {
  it('既知のepochから既知の文字列を作る(検算済みの実値)', () => {
    const { footer, buildId } = formatVersion(1786633856, 'abc1234', false);
    expect(footer).toBe('WebX68k 2026-08-14 00:10 JST (abc1234)');
    expect(buildId).toBe('abc1234');
  });

  it('UTCの日付境界をまたぐ場合でもJSTで正しい日付になる', () => {
    // UTC 2026-08-13T15:30:00Z は JST 2026-08-14 00:30 (日付が進む)
    const boundaryTs = Date.UTC(2026, 7, 13, 15, 30, 0) / 1000;
    const { footer } = formatVersion(boundaryTs, 'def5678', false);
    expect(footer).toBe('WebX68k 2026-08-14 00:30 JST (def5678)');
  });

  it('dirty=true のとき footer に"+"が付き、buildIdに"-dirty"が付く', () => {
    const { footer, buildId } = formatVersion(1786633856, 'abc1234', true);
    expect(footer).toBe('WebX68k 2026-08-14 00:10 JST (abc1234+)');
    expect(buildId).toBe('abc1234-dirty');
  });

  it('buildId には"+"を含まない(URLのクエリで空白にデコードされるため)', () => {
    const { buildId } = formatVersion(1786633856, 'abc1234', true);
    expect(buildId).not.toContain('+');
  });

  it('dirty=false のとき footer/buildId のどちらにも印が付かない', () => {
    const { footer, buildId } = formatVersion(1786633856, 'abc1234', false);
    expect(footer).not.toContain('+');
    expect(buildId).not.toContain('+');
    expect(buildId).not.toContain('-dirty');
  });

  it('月/日/時/分が1桁のときゼロ埋めされる', () => {
    // JST 2026-01-02 03:04 になるepochを作る(UTC epoch = JST - 9h)
    const ts = Date.UTC(2026, 0, 1, 18, 4, 0) / 1000;
    const { footer } = formatVersion(ts, 'abc1234', false);
    expect(footer).toBe('WebX68k 2026-01-02 03:04 JST (abc1234)');
  });
});

describe('UNKNOWN_VERSION', () => {
  it('取得失敗時の値は"(version unknown)"表記', () => {
    expect(UNKNOWN_VERSION.footer).toBe('WebX68k (version unknown)');
    expect(UNKNOWN_VERSION.buildId).toBe('unknown');
  });
});
