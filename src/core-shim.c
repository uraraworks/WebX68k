/*
 * libretro コア用の C シム。
 * retro_log_printf_t は可変長引数のため JS の addFunction では実装できない。
 * ここで vsnprintf に畳んでから JS 側 (js_retro_log) へ渡す。
 */
#include <stdarg.h>
#include <stdio.h>
#include <emscripten.h>

EM_JS(void, js_retro_log, (int level, const char *msg), {
  var s = UTF8ToString(msg);
  if (level >= 3) console.error('[px68k]', s);
  else if (level === 2) console.warn('[px68k]', s);
  else console.log('[px68k]', s);
});

__attribute__((used))
void retro_log_shim(int level, const char *fmt, ...)
{
  char buf[1024];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  js_retro_log(level, buf);
}

/* JS 側からは関数テーブルのインデックス(=関数ポインタ)が取れないため getter を用意 */
__attribute__((used))
void *get_retro_log_shim(void)
{
  return (void *)retro_log_shim;
}
