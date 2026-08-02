import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    headers: {
      // AudioWorklet / 将来的な SharedArrayBuffer 利用を見据えたクロスオリジン分離ヘッダ
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
