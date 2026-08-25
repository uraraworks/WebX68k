// scripts/measure-env.mjs の既定音声出力デバイス抽出に関するテスト。
//
// 背景: AudioContext.outputLatency は 2026-08-17〜08-25 の計測で 0.016 / 0.032 / 0.168 秒の
// 3値を取り、当初は日差やChromeのバージョン差を疑っていた。実測の結果、値を決めているのは
// **既定の音声出力デバイスだけ**だった(HDMI 0.016 / 内蔵スピーカー 0.032 / Bluetooth 0.168。
// それぞれ4〜14試行で完全に再現)。電源(AC/バッテリー)は介入実験で否定した。
// 計測系がデバイスを記録していなかったため、この差を条件差として扱えなかった。
//
// このテストは抽出規則そのものを固定する。実際に system_profiler と繋がっていることは
// 実走で別途確認する(このテストは結線を見ていない)。

import { describe, expect, it } from 'vitest';
import { parseAudioOutputDevice } from '../scripts/measure-env.mjs';

function sp(items: unknown[]): string {
  return JSON.stringify({ SPAudioDataType: [{ _items: items }] });
}

const builtinSpeaker = {
  _name: 'MacBook Airのスピーカー',
  coreaudio_default_audio_output_device: 'spaudio_yes',
  coreaudio_device_transport: 'coreaudio_device_type_builtin',
  coreaudio_device_srate: 48000,
};

const builtinMic = {
  _name: 'MacBook Airのマイク',
  coreaudio_default_audio_input_device: 'spaudio_yes',
  coreaudio_device_transport: 'coreaudio_device_type_builtin',
  coreaudio_device_srate: 48000,
};

describe('parseAudioOutputDevice', () => {
  it('既定の出力デバイスを名前・経路・サンプルレートで返す', () => {
    expect(parseAudioOutputDevice(sp([builtinMic, builtinSpeaker]))).toEqual({
      name: 'MacBook Airのスピーカー',
      transport: 'coreaudio_device_type_builtin',
      sampleRate: 48000,
    });
  });

  it('既定の入力デバイスを出力と取り違えない', () => {
    // 入力デバイスが先に並んでいても、出力側のキーを持つものだけを拾う。
    // 取り違えると「マイクが出力デバイス」という記録が残り、条件照合が壊れる。
    const parsed = parseAudioOutputDevice(sp([builtinMic]));
    expect(parsed).toBeNull();
  });

  it('Bluetooth と HDMI を経路で区別できる', () => {
    const airpods = {
      _name: 'AirPods Pro',
      coreaudio_default_audio_output_device: 'spaudio_yes',
      coreaudio_device_transport: 'coreaudio_device_type_bluetooth',
      coreaudio_device_srate: 48000,
    };
    const hdmi = {
      _name: 'Beyond TV',
      coreaudio_default_audio_output_device: 'spaudio_yes',
      coreaudio_device_transport: 'coreaudio_device_type_hdmi',
      coreaudio_device_srate: 48000,
    };
    expect(parseAudioOutputDevice(sp([airpods]))?.transport).toBe('coreaudio_device_type_bluetooth');
    expect(parseAudioOutputDevice(sp([hdmi]))?.transport).toBe('coreaudio_device_type_hdmi');
  });

  it('既定出力が存在しなければ null（空オブジェクトで埋めない）', () => {
    const other = { ...builtinSpeaker, coreaudio_default_audio_output_device: 'spaudio_no' };
    expect(parseAudioOutputDevice(sp([other]))).toBeNull();
  });

  it('壊れた入力では null を返す（例外を投げない）', () => {
    expect(parseAudioOutputDevice('not json')).toBeNull();
    expect(parseAudioOutputDevice('{}')).toBeNull();
    expect(parseAudioOutputDevice(JSON.stringify({ SPAudioDataType: [] }))).toBeNull();
    expect(parseAudioOutputDevice(JSON.stringify({ SPAudioDataType: [{ _items: 'x' }] }))).toBeNull();
  });

  it('欠けている項目は null になる（既定値で埋めない）', () => {
    const minimal = { coreaudio_default_audio_output_device: 'spaudio_yes' };
    expect(parseAudioOutputDevice(sp([minimal]))).toEqual({
      name: null,
      transport: null,
      sampleRate: null,
    });
  });
});
