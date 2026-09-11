// HostFS (feature/hostfs) 用: ゲストRAM読み書きの薄いラッパ。
//
// C側 export (webx68k_mem_read/webx68k_mem_write, src/core-shim.c) を直接
// LibretroHost経由で呼ぶ実装を Worker 内(src/hostfs/worker-bridge.ts)で
// 差し込む。ここではインターフェイスと、バイト列⇔整数の符号化だけを持つ
// (LibretroHostに依存させないことで単体テストしやすくする)。

/** ゲストRAMへのアクセス口。実体は LibretroHost.readGuestMemory/writeGuestMemory。 */
export interface GuestMemory {
  read(addr: number, len: number): Uint8Array;
  write(addr: number, bytes: Uint8Array): void;
}

/** ビッグエンディアンの符号なし32bitを読む。 */
export function readU32BE(mem: GuestMemory, addr: number): number {
  const b = mem.read(addr, 4);
  return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
}

/** ビッグエンディアンの符号付き32bit(シークの移動量など)を読む。 */
export function readI32BE(mem: GuestMemory, addr: number): number {
  const b = mem.read(addr, 4);
  return (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3];
}

/** ビッグエンディアンの符号付き32bit(戻り値/DOSエラー用)を書く。 */
export function writeI32BE(mem: GuestMemory, addr: number, value: number): void {
  const v = value | 0; // 32bit二の補数へ丸める
  const b = new Uint8Array(4);
  b[0] = (v >>> 24) & 0xff;
  b[1] = (v >>> 16) & 0xff;
  b[2] = (v >>> 8) & 0xff;
  b[3] = v & 0xff;
  mem.write(addr, b);
}

/** ビッグエンディアンの符号なし16bitを書く。 */
export function writeU16BE(mem: GuestMemory, addr: number, value: number): void {
  const v = value & 0xffff;
  const b = new Uint8Array(2);
  b[0] = (v >>> 8) & 0xff;
  b[1] = v & 0xff;
  mem.write(addr, b);
}

/** 1バイト読む。 */
export function readU8(mem: GuestMemory, addr: number): number {
  return mem.read(addr, 1)[0];
}

/** 1バイト書く。 */
export function writeU8(mem: GuestMemory, addr: number, value: number): void {
  mem.write(addr, new Uint8Array([value & 0xff]));
}
