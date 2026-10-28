import { resampleSpeed, type ResampleState } from './speed';
import type { AudioEngine } from './audio';

/** Worker から所有権を受けたチャンクを順に再生へ渡す。 */
export function deliverWorkerAudio(chunks: ArrayBuffer[], speed: number, state: ResampleState, audio: AudioEngine | null): void {
  for (const buffer of chunks) {
    const samples = new Float32Array(buffer);
    const out = speed === 1 ? samples : resampleSpeed(samples, speed, state);
    audio?.push(out, true);
  }
}
