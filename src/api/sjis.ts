// Unicode→Shift_JIS エンコーダ。
// 外部テーブルを持たず、ブラウザ組み込みの TextDecoder('shift_jis') を使って
// 全2バイトSJISコードペースを総当たりデコードし、リバースマップ(文字→バイト列)を
// 遅延構築する方式。ホスト側テキスト送信機能(webnp2_push_key_buffer)向け。

let reverseMap: Map<string, [number, number]> | null = null;

function buildReverseMap(): Map<string, [number, number]> {
  const map = new Map<string, [number, number]>();
  const decoder = new TextDecoder('shift_jis' as string);
  const leadRanges: Array<[number, number]> = [
    [0x81, 0x9f],
    [0xe0, 0xef],
  ];
  const trailRanges: Array<[number, number]> = [
    [0x40, 0x7e],
    [0x80, 0xfc],
  ];
  for (const [leadStart, leadEnd] of leadRanges) {
    for (let lead = leadStart; lead <= leadEnd; lead++) {
      for (const [trailStart, trailEnd] of trailRanges) {
        for (let trail = trailStart; trail <= trailEnd; trail++) {
          const decoded = decoder.decode(new Uint8Array([lead, trail]));
          if (decoded.length !== 1) continue;
          if (decoded === '�') continue;
          if (map.has(decoded)) continue;
          map.set(decoded, [lead, trail]);
        }
      }
    }
  }
  return map;
}

function getReverseMap(): Map<string, [number, number]> {
  if (!reverseMap) {
    reverseMap = buildReverseMap();
  }
  return reverseMap;
}

// 全角記号の表記ゆれをSJIS変換可能な代表字に正規化する。
const ALIASES: Record<string, string> = {
  '〜': '～',
  '−': '－',
  '―': '—',
};

export interface EncodeSjisResult {
  bytes: number[];
  skipped: string[];
}

export interface EncodeSjisUnitsResult {
  /** 1要素=1文字分のバイト列(1バイトまたはSJISペアの2バイト)。ペアは分断せずに積むこと。 */
  units: number[][];
  skipped: string[];
}

/**
 * 文字列をPC-98キーボードBIOSリングバッファへ積むためのバイト列(1バイト=1エントリ)に変換する。
 * - '\n'/'\r' は 0x0D (Enter) に変換する。連続する "\r\n" は1つの0x0Dにまとめる。
 * - ASCII 0x20-0x7E はそのまま1バイト。
 * - 半角カナ (U+FF61-U+FF9F) は 0xA1-0xDF。
 * - それ以外は SJIS 2バイトへのリバースマップ検索。見つからない文字は skipped に集めてスキップする。
 */
export function encodeSjis(text: string): EncodeSjisResult {
  const { units, skipped } = encodeSjisUnits(text);
  return { bytes: units.flat(), skipped };
}

/**
 * encodeSjis の文字単位版。SJIS 2バイト文字はキーバッファへアトミックに積む必要が
 * あるため(先行バイトだけ先にゲストへ消費されるとDBCSペアが崩れて化ける)、
 * 呼び出し側はユニット単位で webnp2_push_key_buffer(_pair) を使い分ける。
 */
export function encodeSjisUnits(text: string): EncodeSjisUnitsResult {
  const map = getReverseMap();
  const units: number[][] = [];
  const skipped: string[] = [];

  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    let ch = chars[i];

    if (ch === '\r') {
      // "\r\n" は1つの Enter にまとめる。
      if (chars[i + 1] === '\n') i++;
      units.push([0x0d]);
      continue;
    }
    if (ch === '\n') {
      units.push([0x0d]);
      continue;
    }

    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) {
      units.push([code]);
      continue;
    }

    if (code >= 0xff61 && code <= 0xff9f) {
      units.push([0xa1 + (code - 0xff61)]);
      continue;
    }

    if (ch === '¥') {
      units.push([0x5c]);
      continue;
    }

    if (ALIASES[ch]) {
      ch = ALIASES[ch];
    }

    const pair = map.get(ch);
    if (pair) {
      units.push([pair[0], pair[1]]);
      continue;
    }

    skipped.push(ch);
  }

  return { units, skipped };
}
