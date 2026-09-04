/*
 * libretro コア用の C シム。
 * retro_log_printf_t は可変長引数のため JS の addFunction では実装できない。
 * ここで vsnprintf に畳んでから JS 側 (js_retro_log) へ渡す。
 */
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <emscripten.h>

#include "x68k/scc.h"
#include "x68k/irqh.h"

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

/*
 * 書き戻し(オートセーブ)用のダーティフラグ。
 * アクセスランプ用のフラグと違い毎フレームクリアされないので、JS 側は
 * 「立っている & ランプが静か」を条件に吸い出し、保存し終えてから clear を呼ぶ。
 * 取りこぼしを防ぐため、クリアは必ず「吸い出した後」ではなく「吸い出す直前」に
 * 行うこと(吸い出し中に来た書き込みを消さないため)。
 */
extern int FDD_DirtyMask;
extern int SASI_Dirty;

__attribute__((used))
int get_fdd_dirty_mask(void)
{
  return FDD_DirtyMask;
}

__attribute__((used))
void clear_fdd_dirty(int drive)
{
  FDD_DirtyMask &= ~(1 << drive);
}

__attribute__((used))
int get_sasi_dirty(void)
{
  return SASI_Dirty;
}

__attribute__((used))
void clear_sasi_dirty(void)
{
  SASI_Dirty = 0;
}

/*
 * FDD のホットマウント(実行中のディスク挿入・取り出し)用シム。
 * px68k 本体の FDD_SetFD()/FDD_EjectFD() はどちらも実行中に呼んで安全で、
 * 挿入時は SetDelay 経由、取り出し時は即時に FDC の割り込みを上げるため、
 * ゲスト(Human68k 等)にもメディア交換として通知される。
 * これを JS から叩けるようにすることで、ディスク差し替え時のコア再起動が不要になる。
 */
extern void FDD_SetFD(int drive, char *filename, int readonly);
extern void FDD_EjectFD(int drive);

__attribute__((used))
void webx68k_fdd_insert(int drive, const char *path)
{
  FDD_SetFD(drive, (char *)path, 0);
}

__attribute__((used))
void webx68k_fdd_eject(int drive)
{
  FDD_EjectFD(drive);
}

/*
 * マウス配線の診断用。
 * px68k の MouseX/MouseY(scc.c) はゲストが SCC 経由でポーリングしたときにしか更新されないため、
 * マウスを使うソフトが無い状態では常に 0 のままになる。fork 側 libretro/mouse.c に足した
 * アクセサ経由で「累積デルタ」「ボタン状態」「マウス有効フラグ(MouseSW)」を直接読み、
 * ホスト → コアまでの配線が通っているかをゲストソフト無しで確認できるようにする。
 */
extern float Mouse_PeekDX(void);
extern float Mouse_PeekDY(void);
extern int Mouse_PeekStat(void);
extern int Mouse_IsEnabled(void);

__attribute__((used))
double get_mouse_dx(void)
{
  return (double)Mouse_PeekDX();
}

__attribute__((used))
double get_mouse_dy(void)
{
  return (double)Mouse_PeekDY();
}

__attribute__((used))
int get_mouse_stat(void)
{
  return Mouse_PeekStat();
}

__attribute__((used))
int get_mouse_enabled(void)
{
  return Mouse_IsEnabled();
}

/*
 * ジョイスティック配線の結合テスト用。
 * libretro/joystick.c の Joystick_Read(num) をそのまま呼ぶ。
 * Config.JOY_TYPE[num] == PAD_2BUTTON(デフォルト)のとき、Joystick_Read は
 * JoyPortData[num] == 0xff の場合だけ 0xff(全ボタン未押下)を返し、それ以外は
 * Joystick_Update() が毎フレーム計算した JoyState[num][0] を返す。
 * JoyPortData の初期値は 0(0xff ではない)なので、ゲストソフトが明示的に
 * ポートへ 0xff を書き込まない限り Joystick_Read はホストの入力状態をそのまま
 * 反映する。ゲストが実際に I/O ポート経由で読む値と完全に一致させるため、
 * JoyState を直接覗くのではなく Joystick_Read() を呼ぶ方を選んだ。
 */
extern unsigned char Joystick_Read(unsigned char num);

__attribute__((used))
int webx68k_joystick_read(int port)
{
  return Joystick_Read((unsigned char)port);
}

/*
 * ゲストのメインメモリを読む。
 * IOCS はワークエリアにマウスカーソルの実座標と可動範囲を持っているので、
 * ここを直接読めばホスト側で位置を推定する必要がなくなる(閉ループ追従)。
 *   $ACE/$AD0 … カーソル X/Y 座標(word)
 *   $A9A/$A9C/$A9E/$AA0 … 可動範囲の min X / min Y / max X / max Y(word)
 *   $AA2 … カーソル表示スイッチ(byte)
 * 68000 なのでワードはビッグエンディアンだが、px68k は MEM をバイトスワップして保持しており
 * (mem_wrap.c の rm_main() が MEM[addr ^ 1] で読む)、素直に添字を辿ると上下バイトが入れ替わる。
 * ここでも同じ ^1 を適用すること。
 */
extern unsigned char *MEM;

__attribute__((used))
int webx68k_peek16(unsigned int addr)
{
  if (!MEM)
    return -1;
  return (MEM[addr ^ 1] << 8) | MEM[(addr + 1) ^ 1];
}

__attribute__((used))
int webx68k_peek8(unsigned int addr)
{
  if (!MEM)
    return -1;
  return MEM[addr ^ 1];
}

/*
 * マシン構成の RAM 設定が、実際にゲストのマシン構造(SRAM)まで反映されたかを
 * 検証する結合テスト用。
 * px68k-libretro の WinX68k_Exec()(libretro.c 内、retro_run から毎フレーム呼ばれる)は
 *   if (!(cpu_readmem24_dword(0xed0008) == Config.ram_size))
 *     cpu_writemem24_dword(0xed0008, Config.ram_size);
 * という形で、コアオプションから決まった Config.ram_size を SRAM の 0xed0008 に書き込む。
 * ここは X68000 の IPL/Human68k が搭載メモリ量を読み取る場所そのものであり、
 * 「ホストが値を渡したか」ではなく「値がマシンの構造まで届いたか」を裏取りするため、
 * SRAM 配列を直接覗くのではなく、コアが書き込みに使ったのと同じ経路
 * (cpu_readmem24_dword、x68k/x68kmemory.h で宣言)で読み戻す。
 * SRAM 配列を直接触るとバイトオーダーの解釈を自前で推測することになり、
 * 実装と食い違っても気づけないため、経路を合わせることが本質。
 * 0xed0008 固定の専用関数とし、任意アドレスを読める汎用リーダーにはしない
 * (I/O 領域を読むと副作用が出る恐れがあるため)。
 */
extern unsigned int cpu_readmem24_dword(unsigned int addr);

__attribute__((used))
unsigned int webx68k_configured_ram_size(void)
{
  return cpu_readmem24_dword(0xed0008);
}

/*
 * 仮想キーボードの結合テスト用。
 * libretro の入力状態から生成された X68000 スキャンコードを、コア内部の
 * リングバッファから直接観測する。読み出し側が範囲外のインデックスを渡しても
 * KeyBufSize が 2 の累乗であることを利用して必ず 0..KeyBufSize-1 に収める。
 */
#define KeyBufSize 128
extern unsigned char KeyBuf[KeyBufSize];
extern unsigned char KeyBufWP;

__attribute__((used))
int webx68k_keybuf_peek(unsigned int index)
{
  return KeyBuf[index & (KeyBufSize - 1)];
}

__attribute__((used))
int webx68k_keybuf_write_pointer(void)
{
  return KeyBufWP;
}

/*
 * テキスト画面取得スパイク用。
 * X68000 の TVRAM は文字コードではなく 1024x1024x4plane のビットマップなので、
 * JS 側で CGROM の 8x16 グリフと照合できるよう、生配列と表示範囲・スクロール量を公開する。
 * ポインタは Emscripten の HEAPU8 から読み、TVRAM 自体の所有権はコア側に残す。
 */
extern unsigned char TVRAM[0x80000];
extern unsigned int TextDotX;
extern unsigned int TextDotY;
extern unsigned int TextScrollX;
extern unsigned int TextScrollY;

__attribute__((used))
unsigned char *webx68k_tvram_data(void)
{
  return TVRAM;
}

__attribute__((used))
int webx68k_text_dot_x(void)
{
  return (int)TextDotX;
}

__attribute__((used))
int webx68k_text_dot_y(void)
{
  return (int)TextDotY;
}

__attribute__((used))
int webx68k_text_scroll_x(void)
{
  return (int)TextScrollX;
}

__attribute__((used))
int webx68k_text_scroll_y(void)
{
  return (int)TextScrollY;
}

/*
 * SCC へ実際に渡る値(x68k/scc.c のグローバル)。
 * ゲストがマウスをポーリングすると Mouse_SetData() が累積デルタをここへ移して 0 に戻すため、
 * 上の get_mouse_dx/dy と両方見ることで「累積中」か「ゲストに吸われた後」かを判別できる。
 */
extern signed char MouseX;
extern signed char MouseY;
extern unsigned char MouseSt;

__attribute__((used))
int get_mouse_scc_x(void)
{
  return MouseX;
}

__attribute__((used))
int get_mouse_scc_y(void)
{
  return MouseY;
}

__attribute__((used))
int get_mouse_scc_stat(void)
{
  return MouseSt;
}

/*
 * SRAM (ゲスト側 $ED0000-$ED3FFF) 読み出し用。
 * 罠: webx68k_peek8() は MEM[] をフラットに読むだけで SRAM を経由しないため、
 * SRAM 領域では一律 0xE5 が返る。x68k/mem_wrap.c の ReadMem 関数テーブルは
 * 0x00ed0000-0x00ed3fff を SRAM_Read/SRAM_Write へ特殊ディスパッチしており、
 * 実体は x68k/sram.c のグローバル配列 SRAM[0x4000] で、MEM とは別物。
 * さらに SRAM_Read() 自身が内部で adr ^= 1 のバイトスワップを行っているため、
 * SRAM[] を自前で直接読むと隣のバイトを読んでしまう。必ず SRAM_Read() 経由で読むこと。
 */
/* FASTCALL は libretro/common.h でこのビルド構成では空マクロ定義されるが、
 * ここではマクロを取り込まず、実体に合わせて素の関数宣言で受ける。 */
extern uint8_t SRAM_Read(uint32_t adr);

__attribute__((used))
int webx68k_sram_read(int offset)
{
  if (offset < 0 || offset >= 0x4000)
    return -1;
  return SRAM_Read(0x00ed0000 + (uint32_t)offset);
}

/* px68k-libretro の libretro/keyboard.c にある。第2引数は 2=make(P6K_DOWN) / 1=break(P6K_UP)。 */
extern void send_keycode(uint8_t code, int flag);

/* 実機のキーリピートと同じく、押下状態を変えずにmakeだけをキーバッファへ追加する。 */
__attribute__((used))
void webx68k_send_key_make(int scancode)
{
  if (scancode < 0 || scancode > 0x7f)
    return;
  send_keycode((uint8_t)scancode, 2);
}

/* SCC チャネルA(X68000 RS-232C)のホスト接続用シム。 */
__attribute__((used))
int webx68k_serial_rx(const uint8_t *data, int length)
{
  return SCC_SerialReceive(data, length);
}

__attribute__((used))
int webx68k_serial_tx_available(void)
{
  return SCC_SerialTxAvailable();
}

__attribute__((used))
int webx68k_serial_tx_drain(uint8_t *data, int max_length)
{
  int count = 0;
  int value;
  if (!data || max_length <= 0) return 0;
  while (count < max_length && (value = SCC_SerialReadTxByte()) >= 0)
    data[count++] = (uint8_t)value;
  return count;
}

__attribute__((used))
void webx68k_serial_reset(void)
{
  SCC_SerialHostReset();
}

__attribute__((used))
void webx68k_serial_set_connected(int connected)
{
  SCC_SerialSetConnected(connected);
}

__attribute__((used))
void webx68k_serial_set_tx_writable(int writable)
{
  SCC_SerialSetTxWritable(writable);
}

__attribute__((used))
int webx68k_serial_guest_baud_rate(void)
{
  return SCC_SerialGetGuestBaudRate();
}

#ifdef WEBX68K_CORE_TEST_EXPORTS
/* SCCチャネルAのレジスタ、FIFO、割り込み状態を実コア結合テストで観測するためのシム。 */
__attribute__((used))
int webx68k_scc_read(unsigned int address)
{
  return SCC_Read(address);
}

__attribute__((used))
void webx68k_scc_write(unsigned int address, int value)
{
  SCC_Write(address, (uint8_t)value);
}

__attribute__((used))
int webx68k_scc_test_acknowledge_irq(void)
{
  return (int)SCC_TestAcknowledgeInterrupt();
}

__attribute__((used))
int webx68k_scc_test_interrupt_cause(void)
{
  return (int)SCC_TestCurrentInterruptCause();
}

__attribute__((used))
int webx68k_scc_test_irq_pending(void)
{
  return IRQH_IsPending(5);
}
#endif
