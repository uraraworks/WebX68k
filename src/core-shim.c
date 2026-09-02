/*
 * libretro コア用の C シム。
 * retro_log_printf_t は可変長引数のため JS の addFunction では実装できない。
 * ここで vsnprintf に畳んでから JS 側 (js_retro_log) へ渡す。
 */
#include <stdarg.h>
#include <stdint.h>
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

/*
 * SCSI HLE のセクタI/O(ホスト側)。
 * 決定2(docs/STORAGE-SCSI.md)により、SCSI の I/O は emscripten の
 * ファイルシステムを経由せず、コアからこのフック経由でホストへ出す。
 *
 * この段階の実体は同期 XHR + Range リクエストである。目的は2つ:
 *   - wasm ヒープに載るのは1セクタ(512バイト)だけ、という形を最初から取る
 *   - 最終形(OPFS の同期ハンドル)と同じ「同期・セクタ単位」の呼び出し形にする
 * 実体の差し替えは実施順序の手順3で行う。
 *
 * イメージの所在は JS 側のグローバル __webx68kScsiUrl で渡す。
 * 未設定ならデバイス無しとして -1 を返す。
 */
EM_JS(int, js_scsi_get_size, (), {
  var g = globalThis;
  var url = g.__webx68kScsiUrl;
  if (!url) {
    console.log('[SCSI] __webx68kScsiUrl が未設定');
    return -1;
  }
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.setRequestHeader('Range', 'bytes=0-0');
    xhr.send(null);
    var cr = xhr.getResponseHeader('Content-Range');   /* 例: "bytes 0-0/104857600" */
    if (!cr) return -1;
    /* 正規表現は使わない。EM_JS の本体は C の文字列化を通るため
     * バックスラッシュが失われ、"/\/" が "//" (行コメント)に化ける。 */
    var slash = cr.lastIndexOf('/');
    if (slash < 0) return -1;
    var n = parseInt(cr.substring(slash + 1), 10);
    if (!(n > 0)) return -1;
    return (n > 0x7fffffff) ? 0x7fffffff : n;
  } catch (e) {
    console.warn('[SCSI] サイズ取得に失敗:', String(e));
    return -1;
  }
});

EM_JS(int, js_scsi_read_sector, (unsigned int lba, unsigned char *buf), {
  var g = globalThis;
  var url = g.__webx68kScsiUrl;
  if (!url) return -1;
  try {
    var start = lba * 512;
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.setRequestHeader('Range', 'bytes=' + start + '-' + (start + 511));
    /* 同期XHR(メインスレッド)では responseType を指定できないため、
     * バイナリを1バイト1文字で受ける古典的な手を使う。 */
    xhr.overrideMimeType('text/plain; charset=x-user-defined');
    xhr.send(null);
    if (xhr.status !== 206 && xhr.status !== 200) return -1;
    var t = xhr.responseText;
    if (t.length < 512) return -1;
    for (var i = 0; i < 512; i++) HEAPU8[buf + i] = t.charCodeAt(i) & 0xff;
    return 0;
  } catch (e) {
    console.warn('[SCSI] セクタ読み出しに失敗:', String(e));
    return -1;
  }
});

__attribute__((used))
int webx68k_scsi_get_size(void)
{
  return js_scsi_get_size();
}

__attribute__((used))
int webx68k_scsi_read_sector(unsigned int lba, unsigned char *buf)
{
  return js_scsi_read_sector(lba, buf);
}

/*
 * ベクタ設定エントリが返す d2 の値。既定は -1(px68k 元来の値)。
 * この値の意味はまだ確定しておらず、値を振って挙動を見る必要がある。
 * 再ビルドせずに振れるよう、JS 側のグローバルから読む。
 */
EM_JS(int, js_scsi_init_d2, (), {
  var v = globalThis.__webx68kScsiInitD2;
  return (typeof v === 'number') ? (v | 0) : -1;
});

__attribute__((used))
int webx68k_scsi_init_d2(void)
{
  return js_scsi_init_d2();
}

/* ベクタ設定エントリが返す a4。既定 0(元の状態と同じ)。d2 と同じ理由で振れるようにする。 */
EM_JS(int, js_scsi_init_a4, (), {
  var v = globalThis.__webx68kScsiInitA4;
  return (typeof v === 'number') ? (v | 0) : 0;
});

__attribute__((used))
int webx68k_scsi_init_a4(void)
{
  return js_scsi_init_a4();
}

/* デバイスドライバヘッダ(+$04)の属性ワード。既定 0。
 * ヘッダの形自体は Human68k デバイスドライバの一般形(未実測の知識)から
 * 組んでいるため、値の意味が分かるまで再ビルドせずに振れるようにする。 */
EM_JS(int, js_scsi_drv_attr, (), {
  var v = globalThis.__webx68kScsiDrvAttr;
  return (typeof v === 'number') ? (v | 0) : 0;
});

__attribute__((used))
int webx68k_scsi_drv_attr(void)
{
  return js_scsi_drv_attr();
}

/* SCSI ローダが書くはずの SRAM 既定値を、こちらで書いてしまうかどうか。
 * 既定 0(書かない)。資料の記述が成り立つかを実測するための実験用スイッチ。 */
EM_JS(int, js_scsi_sram_init, (), {
  return globalThis.__webx68kScsiSramInit ? 1 : 0;
});

__attribute__((used))
int webx68k_scsi_sram_init(void)
{
  return js_scsi_sram_init();
}

/*
 * 初期化コマンド($00)への返答値。再ビルドせずに振れるよう JS 側から読む。
 * どの欄が Human68k の判断に効くかを切り分けるための実験用スイッチ。
 * 既定値のままなら、いままでのハードコード値と同じ動作になる。
 */
EM_JS(int, js_scsi_reply_err, (), {
  var v = globalThis.__webx68kScsiReplyErr;
  return (typeof v === 'number') ? (v | 0) : 0;
});

__attribute__((used))
int webx68k_scsi_reply_err(void)
{
  return js_scsi_reply_err();
}

EM_JS(int, js_scsi_reply_units, (), {
  var v = globalThis.__webx68kScsiReplyUnits;
  return (typeof v === 'number') ? (v | 0) : 1;
});

__attribute__((used))
int webx68k_scsi_reply_units(void)
{
  return js_scsi_reply_units();
}

EM_JS(int, js_scsi_reply_end, (), {
  var v = globalThis.__webx68kScsiReplyEnd;
  return (typeof v === 'number') ? (v | 0) : 0x00ea0500;
});

__attribute__((used))
int webx68k_scsi_reply_end(void)
{
  return js_scsi_reply_end();
}

EM_JS(int, js_scsi_reply_bpb, (), {
  var v = globalThis.__webx68kScsiReplyBpb;
  return (typeof v === 'number') ? (v | 0) : 0x00ea0600;
});

__attribute__((used))
int webx68k_scsi_reply_bpb(void)
{
  return js_scsi_reply_bpb();
}

/* +4 のステータスワード。既定 -1(何もしない)。0以上のときだけ呼び出し側が +4 に書く。 */
EM_JS(int, js_scsi_reply_status, (), {
  var v = globalThis.__webx68kScsiReplyStatus;
  return (typeof v === 'number') ? (v | 0) : -1;
});

__attribute__((used))
int webx68k_scsi_reply_status(void)
{
  return js_scsi_reply_status();
}

/* ストラテジ($40)/インタラプト($41)から戻る d0。既定 -1(何もしない)。
 * 返答の中身をどう振っても起動が止まる件の残る候補のひとつ。 */
EM_JS(int, js_scsi_reply_d0, (), {
  var v = globalThis.__webx68kScsiReplyD0;
  return (typeof v === 'number') ? (v | 0) : -1;
});

__attribute__((used))
int webx68k_scsi_reply_d0(void)
{
  return js_scsi_reply_d0();
}

/* デバイスドライバヘッダ +$00(次のヘッダ)。既定 $ffffffff(従来と同じ)。 */
EM_JS(int, js_scsi_drv_next, (), {
  var v = globalThis.__webx68kScsiDrvNext;
  return (typeof v === 'number') ? (v | 0) : -1;
});

__attribute__((used))
unsigned int webx68k_scsi_drv_next(void)
{
  return (unsigned int)js_scsi_drv_next();
}

/*
 * 本物の外部SCSIボードROMイメージ(8192バイト)をホストから流し込む経路。
 * 逆アセンブルはせず、実機ROMを走らせて「何番地を叩き、何を返すか」を
 * 実測するためのオラクルとして使う。JS 側のグローバルは
 * __webx68kScsiRomBytes (数値配列 or Uint8Array)。
 * 長さが取れない/0のときは 0 を返し、コア側は従来どおり自前スタブを使う。
 */
EM_JS(int, js_scsi_rom_len, (), {
  var v = globalThis.__webx68kScsiRomBytes;
  if (!v) return 0;
  var n = v.length;
  return (typeof n === 'number' && n > 0) ? (n | 0) : 0;
});

__attribute__((used))
int webx68k_scsi_rom_len(void)
{
  return js_scsi_rom_len();
}

/* i 番目のバイト(0-255)。範囲外/未設定は -1。 */
EM_JS(int, js_scsi_rom_byte, (int i), {
  var v = globalThis.__webx68kScsiRomBytes;
  if (!v) return -1;
  if (i < 0 || i >= v.length) return -1;
  var b = v[i];
  return (typeof b === 'number') ? (b & 0xff) : -1;
});

__attribute__((used))
int webx68k_scsi_rom_byte(int i)
{
  return js_scsi_rom_byte(i);
}

/*
 * SPC(MB89352)のセレクト応答を再ビルドせずに振るための欄。
 * $ea0000〜$ea001f をどのレジスタに当てはめるか(SEL=$ea0005/INTS=$ea0009/
 * TEMP=$ea0017/SSTS=$ea000d/PSNS=$ea000b、という「$ea0001+2n」の対応)は
 * 実測ではなく知識からの当てはめであり未実測。 x68k/scsi.c 側コメントも参照。
 * 既定値は本物ROM未使用時と同じ挙動(=何もしない)になるよう選んである。
 */

/* セレクト成功時に INTS へ立てるビット。既定 $08(SEL効果を表すとされる値の一例)。 */
EM_JS(int, js_scsi_spc_ints_sel, (), {
  var v = globalThis.__webx68kSpcIntsSel;
  return (typeof v === 'number') ? (v | 0) : 0x08;
});

__attribute__((used))
int webx68k_scsi_spc_ints_sel(void)
{
  return js_scsi_spc_ints_sel();
}

/* セレクト失敗(タイムアウト)時に INTS へ立てるビット。既定 $20。 */
EM_JS(int, js_scsi_spc_ints_timeout, (), {
  var v = globalThis.__webx68kSpcIntsTimeout;
  return (typeof v === 'number') ? (v | 0) : 0x20;
});

__attribute__((used))
int webx68k_scsi_spc_ints_timeout(void)
{
  return js_scsi_spc_ints_timeout();
}

/* SSTS($ea000d) の値をどう決めるか。既定 -1: 状態機械に任せる
 * (セレクト成立でbit7を立て、バス開放/リセットで落とす。実測に基づく
 * 挙動、詳細は x68k/scsi.c の SCSI_SpcSstsSetBit7 コメント参照)。
 * -2 のときは従来どおり「掃引」モード: 実際の読み出し(SCSI_Read)の
 * たびに 0x00〜0xff を1ずつ増やして返す(x68k/scsi.c の
 * SCSI_SpcSweepRead 参照)。0以上のときは従来どおりその固定値。 */
EM_JS(int, js_scsi_spc_ssts, (), {
  var v = globalThis.__webx68kSpcSsts;
  return (typeof v === 'number') ? (v | 0) : -1;
});

__attribute__((used))
int webx68k_scsi_spc_ssts(void)
{
  return js_scsi_spc_ssts();
}

/* セレクト成功時に PSNS($ea000b) へ入れる値。既定 -1(触らない)。
 * -2 のときは「掃引」モード(SSTSと同様、x68k/scsi.c の SCSI_SpcSweepRead 参照)。
 * -3 のときは「交互」モード: 実際の読み出し(SCSI_Read)のたびに
 * __webx68kSpcPsnsA / __webx68kSpcPsnsB(既定 $8a / $0a)を交互に返す。
 * 掃引(-2)は「読むたびに+1」なので連続する2回の読み出しは必ず(v, v+1)の
 * 組にしかならず、「ある値の次に別の特定の値」という決まったハンドシェイクを
 * 待っているケースは原理的に満たせない。それを試すためのモード
 * (x68k/scsi.c の SCSI_SpcSweepRead 参照)。 */
EM_JS(int, js_scsi_spc_psns, (), {
  var v = globalThis.__webx68kSpcPsns;
  return (typeof v === 'number') ? (v | 0) : -1;
});

__attribute__((used))
int webx68k_scsi_spc_psns(void)
{
  return js_scsi_spc_psns();
}

/* 交互モード(-3)でのA値。既定 $8a。 */
EM_JS(int, js_scsi_spc_psns_a, (), {
  var v = globalThis.__webx68kSpcPsnsA;
  return (typeof v === 'number') ? (v | 0) : 0x8a;
});

__attribute__((used))
int webx68k_scsi_spc_psns_a(void)
{
  return js_scsi_spc_psns_a();
}

/* 交互モード(-3)でのB値。既定 $0a。 */
EM_JS(int, js_scsi_spc_psns_b, (), {
  var v = globalThis.__webx68kSpcPsnsB;
  return (typeof v === 'number') ? (v | 0) : 0x0a;
});

__attribute__((used))
int webx68k_scsi_spc_psns_b(void)
{
  return js_scsi_spc_psns_b();
}

/* 掃引モード(-2)での開始値。既定0(従来どおり0から)。
 * 本物ROMは1回の起動でPSNS/SSTSを16回程度しか読まないため、開始値を
 * ずらして複数回実行すれば0〜255の全値を試せる
 * (x68k/scsi.c の SCSI_SpcSweepRead 参照)。 */
EM_JS(int, js_scsi_spc_psns_base, (), {
  var v = globalThis.__webx68kSpcPsnsBase;
  return (typeof v === 'number') ? (v | 0) : 0;
});

__attribute__((used))
int webx68k_scsi_spc_psns_base(void)
{
  return js_scsi_spc_psns_base();
}

/* SSTS掃引の開始値。既定0。上のPSNS版と同じ趣旨。 */
EM_JS(int, js_scsi_spc_ssts_base, (), {
  var v = globalThis.__webx68kSpcSstsBase;
  return (typeof v === 'number') ? (v | 0) : 0;
});

__attribute__((used))
int webx68k_scsi_spc_ssts_base(void)
{
  return js_scsi_spc_ssts_base();
}

/* PCTL($ea0011)への書き込みでSSTSのbit7を落とすかどうか。既定 1(落とす)。
 * これは実機で確認した仕様ではなく、再試行のたびに観測を1つ進めるための
 * 実験的な規則(詳細は x68k/scsi.c の SCSI_SpcWrite コメント参照)。
 * 0 を渡すと従来どおり(SCMDのバス開放/SCTLのリセットのみで落とす)。 */
EM_JS(int, js_scsi_spc_clear_on_pctl, (), {
  var v = globalThis.__webx68kSpcClearOnPctl;
  return (typeof v === 'number') ? (v | 0) : 1;
});

__attribute__((used))
int webx68k_scsi_spc_clear_on_pctl(void)
{
  return js_scsi_spc_clear_on_pctl();
}

/* [SCSI-BUS] の「同一PCからの通算アクセスが閾値を超えたら以後そのPCの
 * ログを止める」圧縮の閾値。既定32(従来と同じ)。0 を渡すと抑制しない
 * (=全件出す)。過去にこの圧縮が無限ループを「バスアクセスが止まった」
 * ように見せて誤った結論を作ったことがあり、セレクト成功後にROMが
 * 何をしているかを正確に追いたいときにここを0にして丸ごと確認する。
 * 詳細は x68k/scsi.c の SCSI_BusPcAllow コメント参照。 */
EM_JS(int, js_scsi_bus_pc_limit, (), {
  var v = globalThis.__webx68kBusPcLimit;
  return (typeof v === 'number') ? (v | 0) : 32;
});

__attribute__((used))
int webx68k_scsi_bus_pc_limit(void)
{
  return js_scsi_bus_pc_limit();
}

/* [SCSI-BUS] の総件数上限。既定4000(従来と同じ)。上限に達すると
 * 以降は出力を止める(x68k/scsi.c の SCSI_BusLogGate 参照)。 */
EM_JS(int, js_scsi_bus_log_max, (), {
  var v = globalThis.__webx68kBusLogMax;
  return (typeof v === 'number') ? (v | 0) : 4000;
});

__attribute__((used))
int webx68k_scsi_bus_log_max(void)
{
  return js_scsi_bus_log_max();
}

/*
 * ゲストRAM書き込みの実測用フック。
 * 実体(ホットパス・ログ出力・陽性対照)は px68k-libretro 側
 * x68k/mem_wrap.c の webx68k_ram_watch_check() / webx68k_ram_watch_selftest()。
 * ここでは既存の webx68k_scsi_* と同じ流儀で JS 側グローバル
 * (globalThis.__webx68kRamWatchLo / __webx68kRamWatchHi、既定は無効=-1)を読み、
 * mem_wrap.c 側の static 変数へ反映する。
 *
 * 毎バイト書き込みのたびに EM_JS(JS呼び出し)を挟むと通常利用の速度を
 * 落としてしまうため、ここは libretro.c の retro_run() から「毎フレーム
 * 先頭で1回だけ」呼ぶ設計にしてある。ホットパス(wm_cnt)側は
 * static 変数の比較のみで済む。
 */
EM_JS(int, js_ram_watch_lo, (), {
  var v = globalThis.__webx68kRamWatchLo;
  return (typeof v === 'number') ? (v | 0) : -1;
});

EM_JS(int, js_ram_watch_hi, (), {
  var v = globalThis.__webx68kRamWatchHi;
  return (typeof v === 'number') ? (v | 0) : -1;
});

/*
 * 書いた側のPCで絞る条件(globalThis.__webx68kRamWatchPcLo/Hi、既定は無効=-1)。
 * アドレス範囲のwebx68k_ram_watch_lo/hiと同じ流儀。
 */
EM_JS(int, js_ram_watch_pc_lo, (), {
  var v = globalThis.__webx68kRamWatchPcLo;
  return (typeof v === 'number') ? (v | 0) : -1;
});

EM_JS(int, js_ram_watch_pc_hi, (), {
  var v = globalThis.__webx68kRamWatchPcHi;
  return (typeof v === 'number') ? (v | 0) : -1;
});

extern int32_t webx68k_ram_watch_lo;
extern int32_t webx68k_ram_watch_hi;
extern int32_t webx68k_ram_watch_pc_lo;
extern int32_t webx68k_ram_watch_pc_hi;
extern int      webx68k_ram_watch_count;

__attribute__((used))
void webx68k_ram_watch_refresh(void)
{
  int lo = js_ram_watch_lo();
  int hi = js_ram_watch_hi();
  int pc_lo = js_ram_watch_pc_lo();
  int pc_hi = js_ram_watch_pc_hi();

  if (lo != webx68k_ram_watch_lo || hi != webx68k_ram_watch_hi ||
      pc_lo != webx68k_ram_watch_pc_lo || pc_hi != webx68k_ram_watch_pc_hi)
    webx68k_ram_watch_count = 0; /* 範囲が変わったら件数を数え直す */

  webx68k_ram_watch_lo = lo;
  webx68k_ram_watch_hi = hi;
  webx68k_ram_watch_pc_lo = pc_lo;
  webx68k_ram_watch_pc_hi = pc_hi;
}

/*
 * ゲストメモリ「読み出し」監視用フック。
 * 実体(ホットパス・ログ出力・圧縮・陽性対照)は px68k-libretro 側
 * x68k/mem_wrap.c の webx68k_mem_read_watch_check() / _selftest()。
 * webx68k_ram_watch_refresh() と同じ流儀で JS 側グローバル
 * (globalThis.__webx68kMemReadWatchLo/Hi、__webx68kMemReadWatchPcLo/Hi、
 * 既定は無効=-1)を読み、mem_wrap.c 側の static 変数へ反映する。
 */
EM_JS(int, js_mem_read_watch_lo, (), {
  var v = globalThis.__webx68kMemReadWatchLo;
  return (typeof v === 'number') ? (v | 0) : -1;
});

EM_JS(int, js_mem_read_watch_hi, (), {
  var v = globalThis.__webx68kMemReadWatchHi;
  return (typeof v === 'number') ? (v | 0) : -1;
});

EM_JS(int, js_mem_read_watch_pc_lo, (), {
  var v = globalThis.__webx68kMemReadWatchPcLo;
  return (typeof v === 'number') ? (v | 0) : -1;
});

EM_JS(int, js_mem_read_watch_pc_hi, (), {
  var v = globalThis.__webx68kMemReadWatchPcHi;
  return (typeof v === 'number') ? (v | 0) : -1;
});

extern int32_t webx68k_mem_read_watch_lo;
extern int32_t webx68k_mem_read_watch_hi;
extern int32_t webx68k_mem_read_watch_pc_lo;
extern int32_t webx68k_mem_read_watch_pc_hi;
extern int      webx68k_mem_read_watch_count;

__attribute__((used))
void webx68k_mem_read_watch_refresh(void)
{
  int lo = js_mem_read_watch_lo();
  int hi = js_mem_read_watch_hi();
  int pc_lo = js_mem_read_watch_pc_lo();
  int pc_hi = js_mem_read_watch_pc_hi();

  if (lo != webx68k_mem_read_watch_lo || hi != webx68k_mem_read_watch_hi ||
      pc_lo != webx68k_mem_read_watch_pc_lo || pc_hi != webx68k_mem_read_watch_pc_hi)
    webx68k_mem_read_watch_count = 0; /* 範囲が変わったら件数を数え直す */

  webx68k_mem_read_watch_lo = lo;
  webx68k_mem_read_watch_hi = hi;
  webx68k_mem_read_watch_pc_lo = pc_lo;
  webx68k_mem_read_watch_pc_hi = pc_hi;
}

