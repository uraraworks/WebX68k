import { defineConfig } from 'vitest/config';
import { computeBuildVersion } from './tools/build-version.mjs';

// test/ から src/libretro-host.ts や src/main.ts が import されるため、vite.config.ts と
// 同じ define が無いと __BUILD_ID__ / __BUILD_VERSION_FOOTER__ が未定義でテストが落ちる。
// 値の計算自体は tools/build-version.mjs に一本化してある(二重管理しない)。
const { footer: buildVersionFooter, buildId } = computeBuildVersion(__dirname);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
});
