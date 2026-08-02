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

/*
 * アクセスランプ用: px68k-libretro (fork) 側の x68k/fdd.c / x68k/sasi.c に生えている
 * グローバルを JS から読めるように getter でラップする。
 * FDD_IsReading / SASI_IsAccessing は retro_run() の毎フレーム先頭で 0 クリアされるため、
 * JS 側では毎フレーム後に読み出して「そのフレームでアクセスがあったか」を判定する。
 */
extern int FDD_IsReading;
extern int FDD_AccessDrive;
extern int SASI_IsAccessing;

__attribute__((used))
int get_fdd_is_reading(void)
{
  return FDD_IsReading;
}

__attribute__((used))
int get_fdd_access_drive(void)
{
  return FDD_AccessDrive;
}

__attribute__((used))
int get_sasi_is_accessing(void)
{
  return SASI_IsAccessing;
}
