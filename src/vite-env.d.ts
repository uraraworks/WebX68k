/// <reference types="vite/client" />

// vite.config.ts / vitest.config.ts の define で注入されるキャッシュバスティング用の
// 短い識別子。tools/build-version.mjs の computeBuildVersion() が計算する値をそのまま
// 文字列リテラルとして埋め込む(壁時計不使用。同じコミットからは常に同じ値)。
declare const __BUILD_ID__: string;
