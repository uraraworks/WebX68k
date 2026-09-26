/**
 * SCSI起動 段階4(UI): SRAMの起動デバイス設定($ed0018/$ed000c)を解釈・生成する純粋関数群。
 *
 * 値の出どころ(docs/STORAGE-SCSI.md「SCSI起動 段階0」「段階1a」「段階1b」参照、実測):
 *   - 標準: $ed0018=$0000。$ed000c〜$ed001bはIPLが起動直後に無条件上書きする固定値
 *     ($00 $bf $ff $fc / $00 $ed $01 $00 / $ff $ff $ff $ff / $00 $00 / $4e $07)。
 *     本モジュールが扱うのは先頭4バイト($ed000c〜$ed000f=$00bffffc)のみ
 *     ($ed0010以降はSCSI/標準どちらでも同じ値のため、この判定・書き換えでは触れない)。
 *   - SCSI(ID 0): $ed0018=$a000, $ed000c〜$ed000f=$00ea0020。
 * SRAM先頭8バイトの機種シグネチャ(「Ｘ68000W」相当)が一致しない場合は、SRAM自体が
 * 未初期化(まっさらな新規プロファイル等)であり$ed0018の値も信頼できないため、
 * 呼び出し側は判定に回さず kind:'unknown' を使うこと(describeBootDevice の sigValid=false)。
 */

export type BootDeviceKind = 'standard' | 'scsi' | 'other' | 'unknown';

export interface BootDeviceInfo {
  kind: BootDeviceKind;
  /** $ed0018 の16bit値。sigValid=false のときは -1。 */
  raw0018: number;
  /** $ed000c〜$ed000f の32bit値。sigValid=false のときは -1。 */
  raw000c: number;
}

/** 標準時の $ed0018。 */
export const STANDARD_0018 = 0x0000;
/** SCSI(ID 0)時の $ed0018。 */
export const SCSI_0018 = 0xa000;
/** SCSI(ID 0)時の $ed000c〜$ed000f。 */
export const SCSI_000C = 0x00ea0020;
/**
 * 標準に戻すときの $ed000c〜$ed000f。段階1aで実測したIPL初期化時の固定値
 * ($00 $bf $ff $fc)。SCSI_Init()が居なければIPLが元々書く値そのものなので、
 * 「標準」に戻す = この値を書く、で実機のSWITCH.X「標準」相当に揃う。
 */
export const STANDARD_000C = 0x00bffffc;

/**
 * SRAMの現在値から起動デバイスの種別を判定する(表示用)。
 * sigValid が false(機種シグネチャ不一致=SRAM未初期化)のときは値を読まず 'unknown'。
 */
export function describeBootDevice(sigValid: boolean, raw0018: number, raw000c: number): BootDeviceInfo {
  if (!sigValid) return { kind: 'unknown', raw0018: -1, raw000c: -1 };
  if (raw0018 === STANDARD_0018) return { kind: 'standard', raw0018, raw000c };
  if (raw0018 === SCSI_0018 && raw000c === SCSI_000C) return { kind: 'scsi', raw0018, raw000c };
  return { kind: 'other', raw0018, raw000c };
}

/** UIで選べる起動デバイス(「その他」「不明」はUIからは選べない=読み取り専用の表示専用値)。 */
export type SelectableBootDevice = 'standard' | 'scsi';

/**
 * 指定した起動デバイスにするために SRAM へ書くべき (offset, value) の一覧。
 * offset は $ed0000 からの相対(webx68k_sram_read/writeと同じ単位)。
 * 書く範囲は $ed000c〜$ed000f と $ed0018〜$ed0019 の6バイトのみ
 * (SCSI_Init()が元々書いていた範囲と同じ。$ed0010以降は触らない)。
 */
export function bootDeviceWriteEntries(
  device: SelectableBootDevice,
): { offset: number; value: number }[] {
  const bootAddr = device === 'scsi' ? SCSI_000C : STANDARD_000C;
  const selector = device === 'scsi' ? SCSI_0018 : STANDARD_0018;
  return [
    { offset: 0x0c, value: (bootAddr >>> 24) & 0xff },
    { offset: 0x0d, value: (bootAddr >>> 16) & 0xff },
    { offset: 0x0e, value: (bootAddr >>> 8) & 0xff },
    { offset: 0x0f, value: bootAddr & 0xff },
    { offset: 0x18, value: (selector >>> 8) & 0xff },
    { offset: 0x19, value: selector & 0xff },
  ];
}

/**
 * まっさらなSRAM(署名無効・IPLが起動時に既定値へ初期化する状態)を想定した、再注入フック用の
 * ROM起動アドレス値。x68k/sram.c の SRAM_Write() 再注入フック
 * (webx68k_scsi_sram_boot_addr())へそのまま渡す値で、0 なら「何もしない」(=IPL既定の
 * 標準のまま)、非0ならその値を $ed000c〜$ed000f へ再注入する(現状の実装は $ed0018 も
 * 併せて $a000 に固定して書くため、SCSI以外の値を再注入する経路は無い。標準を再注入したい
 * 場合は単に 0 を渡して「何もしない」でよい。IPL既定=標準と一致するため)。
 *
 * **呼び出し側は、この値を「起動前のSRAM署名が無効だったとき」だけ渡すこと。** 署名が
 * 有効(=一度でも正常に永続化された後)なら常に `reinjectBootAddrFor` を呼ばず
 * グローバルへ0をセットする(`shouldArmSramReinject`参照)。理由(2026-09-26、UI実装後の
 * 是正): x68k/sram.c の再注入フックは元々「$ed001bへの書き込みであれば発生源を問わず
 * 発火する」実装で、IPL自身のまっさらなSRAM初期化コピーだけでなくHuman68k自身の
 * 無関係な書き込み(実測: pc=$001a2c02)でも反応していた(段階1a参照)。フック側は
 * 「この起動で最初の1回だけ」に絞ったが、それでも「起動のたびにSCSIを再注入し続ける」
 * 状態のままだと、SRAMが既に有効(署名一致)なのに1回目の$ed001b書き込みで無条件に
 * 上書きしてしまい、「SWITCH.Xで標準に変えた直後の起動でSCSIへ戻る」という
 * 「SRAMを正とする」仕様違反が起きる。署名が有効なブートでは常に0(=何もしない)を
 * 渡すことで、このケースでは再注入自体が起きないようにする。
 */
export function reinjectBootAddrFor(device: SelectableBootDevice): number {
  return device === 'scsi' ? SCSI_000C : 0;
}

/** SRAMの機種シグネチャ(「Ｘ68000W」、先頭8バイト)。src/libretro-host.ts の
 * SRAM_SIGNATURE と同じ値(実測で確定済み)。値の出どころは1つだが、Node単体テストで
 * ブラウザ専用コードを経由せずに検証したいため、ここに複製する。 */
export const SRAM_SIGNATURE_BYTES = [0x82, 0x77, 0x36, 0x38, 0x30, 0x30, 0x30, 0x57];

/**
 * 起動前(コア初期化前)に読み込んだSRAMバイト列(IndexedDBの永続化ファイル、
 * `loadSramFile()`の戻り値)の先頭8バイトが機種シグネチャと一致するか。
 * bytesがnull(初回起動でまだ何も永続化されていない)、または長さが足りない場合はfalse
 * (未初期化=まっさらとみなす)。
 */
export function hasValidSramSignatureBytes(bytes: Uint8Array | null | undefined): boolean {
  if (!bytes || bytes.length < SRAM_SIGNATURE_BYTES.length) return false;
  for (let i = 0; i < SRAM_SIGNATURE_BYTES.length; i++) {
    if (bytes[i] !== SRAM_SIGNATURE_BYTES[i]) return false;
  }
  return true;
}

/**
 * SRAM再注入フック(x68k/sram.c、`globalThis.__webx68kScsiSramBoot`経由)を、今回の起動で
 * 武装(非0にする)してよいか。**「起動前のSRAM署名が無効だったとき」だけ**武装する
 * (reinjectBootAddrForのコメント参照)。署名が有効なら、SCSIを選んでいても常にfalseを
 * 返し、呼び出し側は`globalThis.__webx68kScsiSramBoot`へ0をセットすること
 * (SRAM自体が既に正しい値を持っているので、再注入という強制上書きの出番が無い)。
 */
export function shouldArmSramReinject(sramSignatureValidBeforeBoot: boolean): boolean {
  return !sramSignatureValidBeforeBoot;
}

/** SCSIスロットの交換等を禁止すべきか。 */
export function shouldLockScsiSlot(running: boolean, bootedFromScsi: boolean): boolean {
  return running && bootedFromScsi;
}
