import { describe, expect, it } from 'vitest';
import {
  createFormattedScsi,
  fatFreeSpace,
  fatList,
  fatMakeDir,
  fatReadFile,
  fatWriteFile,
  hasScsiHeaderSignature,
  openDiskImage,
  SCSI_BLANK_MAX_MIB,
  SCSI_BLANK_MIN_MIB,
  validateScsiBlankSizeMiB,
} from '../src/api/fat.ts';

describe('validateScsiBlankSizeMiB', () => {
  it('既定値100を受け入れる', () => {
    expect(validateScsiBlankSizeMiB('100')).toEqual({ ok: true, sizeMiB: 100 });
  });

  it('非数値を拒否する', () => {
    expect(validateScsiBlankSizeMiB('abc')).toEqual({ ok: false, reason: 'notANumber' });
    expect(validateScsiBlankSizeMiB('')).toEqual({ ok: false, reason: 'notANumber' });
    expect(validateScsiBlankSizeMiB('  ')).toEqual({ ok: false, reason: 'notANumber' });
  });

  it('小数を拒否する', () => {
    expect(validateScsiBlankSizeMiB('100.5')).toEqual({ ok: false, reason: 'notInteger' });
  });

  it('下限未満を拒否する', () => {
    expect(validateScsiBlankSizeMiB('0')).toEqual({ ok: false, reason: 'tooSmall' });
    expect(validateScsiBlankSizeMiB('-5')).toEqual({ ok: false, reason: 'tooSmall' });
  });

  it('上限超過を拒否する', () => {
    expect(validateScsiBlankSizeMiB(String(SCSI_BLANK_MAX_MIB + 1))).toEqual({ ok: false, reason: 'tooLarge' });
  });

  it('境界値(下限・上限)は受け入れる', () => {
    expect(validateScsiBlankSizeMiB(String(SCSI_BLANK_MIN_MIB))).toEqual({ ok: true, sizeMiB: SCSI_BLANK_MIN_MIB });
    expect(validateScsiBlankSizeMiB(String(SCSI_BLANK_MAX_MIB))).toEqual({ ok: true, sizeMiB: SCSI_BLANK_MAX_MIB });
  });
});

describe('createFormattedScsi', () => {
  it('"X68SCSI1"ヘッダを持つ', () => {
    const image = createFormattedScsi(100);
    expect(hasScsiHeaderSignature(image)).toBe(true);
    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...image.subarray(offset, offset + length));
    expect(ascii(0, 8)).toBe('X68SCSI1');
  });

  it('LBA0ヘッダのbytesPerSectorが512、総ブロック数がイメージ全体と一致する', () => {
    const image = createFormattedScsi(100);
    const bytesPerSector = (image[8] << 8) | image[9];
    expect(bytesPerSector).toBe(512);
    const totalBlocksMinus1 =
      (image[10] << 24) | (image[11] << 16) | (image[12] << 8) | image[13];
    expect((totalBlocksMinus1 >>> 0) + 1).toBe(image.length / 512);
  });

  it('パーティションテーブルが0x800の"X68K" + "Human68k"になっている', () => {
    const image = createFormattedScsi(100);
    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...image.subarray(offset, offset + length));
    expect(ascii(0x800, 4)).toBe('X68K');
    expect(ascii(0x810, 8)).toBe('Human68k');
  });

  it('テーブルヘッダの+4(使用済み末尾ブロック)は総ブロック数そのもの、' +
    '+8/+12(総1KBブロック数-1)とはちょうど1違う' +
    '(実測: twopart.HDSで+4=203808・+8=+12=203807。ここを同じ値にすると' +
    'Human68kが「ディスクの管理領域が壊されています」で拒否する実バグを実ブラウザで確認した)', () => {
    const image = createFormattedScsi(100);
    const readU32BE = (off: number) =>
      ((image[off] << 24) | (image[off + 1] << 16) | (image[off + 2] << 8) | image[off + 3]) >>> 0;
    const total1kBlocks = image.length / 1024;
    expect(readU32BE(0x804)).toBe(total1kBlocks);
    expect(readU32BE(0x808)).toBe(total1kBlocks - 1);
    expect(readU32BE(0x80c)).toBe(total1kBlocks - 1);
    expect(readU32BE(0x804)).not.toBe(readU32BE(0x808));
  });

  it('openDiskImageで開ける(SCSI形式のパーティションテーブル + FAT16)', () => {
    const image = createFormattedScsi(100);
    const vol = openDiskImage(image, 'blank.hds');
    expect(vol.fatType).toBe('FAT16');
    expect(vol.bytesPerSector).toBe(1024);
  });

  it('生成直後のルートディレクトリは空で、100MB相当の空き容量がある', () => {
    const image = createFormattedScsi(100);
    const vol = openDiskImage(image, 'blank.hds');
    expect(fatList(vol, '')).toEqual([]);
    const { free, total } = fatFreeSpace(vol);
    expect(free).toBe(total);
    expect(total).toBeGreaterThan(95 * 1024 * 1024);
  });

  it('ファイル書き込み→読み出しでバイト完全一致', () => {
    const image = createFormattedScsi(100);
    const vol = openDiskImage(image, 'blank.hds');
    const data = new Uint8Array(4096);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    fatWriteFile(vol, 'HELLO.TXT', data);

    const reopened = openDiskImage(image, 'blank.hds');
    expect(fatList(reopened, '').map((e) => e.name)).toContain('HELLO.TXT');
    expect(Array.from(fatReadFile(reopened, 'HELLO.TXT'))).toEqual(Array.from(data));
  });

  it('サブディレクトリ作成とその中へのファイル書き込みができる', () => {
    const image = createFormattedScsi(100);
    const vol = openDiskImage(image, 'blank.hds');
    fatMakeDir(vol, 'GAMES');
    fatWriteFile(vol, 'GAMES/README.TXT', new Uint8Array([1, 2, 3]));

    const reopened = openDiskImage(image, 'blank.hds');
    expect(fatList(reopened, '').map((e) => e.name)).toEqual(['GAMES']);
    expect(fatList(reopened, 'GAMES').map((e) => e.name)).toContain('README.TXT');
    expect(Array.from(fatReadFile(reopened, 'GAMES/README.TXT'))).toEqual([1, 2, 3]);
  });

  it('FATが全クラスタを表現できるサイズになっている', () => {
    const image = createFormattedScsi(100);
    const vol = openDiskImage(image, 'blank.hds');
    const fatBytesNeeded = (vol.totalClusters + 2) * 2;
    expect(vol.sectorsPerFat * vol.bytesPerSector).toBeGreaterThanOrEqual(fatBytesNeeded);
  });

  it('FAT先頭の予約エントリが実測(twopart.HDS)と同じバイト列 [media, 0xFF, 0xFF, 0xFF] になっている' +
    '(writeU16BEの0xff00|mediaだと逆順の[0xFF, media]になり、実ブラウザでのHuman68k copyが' +
    '「ディスクの管理領域が壊されています」で拒否されることを実測で確認した)', () => {
    const image = createFormattedScsi(99);
    const p = 32 * 1024;
    const reserved = 1;
    const spf = 100;
    const fatStart = p + reserved * 1024;
    const fat2Start = fatStart + spf * 1024;
    expect(Array.from(image.subarray(fatStart, fatStart + 4))).toEqual([0xf7, 0xff, 0xff, 0xff]);
    expect(Array.from(image.subarray(fat2Start, fat2Start + 4))).toEqual([0xf7, 0xff, 0xff, 0xff]);
  });

  it('実測(twopart.HDS、99MB区画)とビット単位で一致する spc=2 / sectorsPerFat=100 になる', () => {
    // twopart.HDSの区画0は101376個の1KBセクタ(≒99MB)でspc=2・sectorsPerFat=100だった
    // (docs/STORAGE-SCSI.md参照)。createFormattedScsi(99)は同じ総セクタ数(99*1024=101376)の
    // 区画を作るので、実測値とビット単位で一致することを確認する。
    const image = createFormattedScsi(99);
    const p = 32 * 1024;
    expect(image[p + 0x14]).toBe(2); // sectorsPerCluster
    expect(image[p + 0x1d]).toBe(100); // sectorsPerFat
  });

  it('sectorsPerFatは「実データ領域を差し引いた後のクラスタ数」ではなく' +
    '「floor(総セクタ数/spc)」ベースの式で決まる(2段階計算だと1ずれて実測と食い違う)', () => {
    const image = createFormattedScsi(99);
    const p = 32 * 1024;
    const spc = image[p + 0x14];
    const spf = image[p + 0x1d];
    const totalSectors = 99 * 1024;
    const rootDirSectors = Math.ceil((512 * 32) / 1024); // 16
    const twoStageClusters = Math.floor((totalSectors - 1 - 2 * spf - rootDirSectors) / spc);
    const twoStageSpf = Math.ceil(((twoStageClusters + 2) * 2) / 1024);
    // 2段階計算(実データ領域ベース)だと99になり、実測の100とは一致しない。
    expect(twoStageSpf).not.toBe(spf);
    expect(twoStageSpf).toBe(99);
    expect(spf).toBe(100);
  });

  it('上限MiB(2047)でも生成でき、開ける(js_scsi_get_sizeのint32クランプ0x7fffffff未満)', () => {
    const image = createFormattedScsi(SCSI_BLANK_MAX_MIB);
    expect(image.length).toBeLessThan(0x7fffffff);
    const vol = openDiskImage(image, 'blank.hds');
    expect(vol.fatType).toBe('FAT16');
  });

  it('範囲外のサイズはDiskError(scsiSizeInvalid)を投げる', () => {
    expect(() => createFormattedScsi(0)).toThrow();
    expect(() => createFormattedScsi(SCSI_BLANK_MAX_MIB + 1)).toThrow();
    expect(() => createFormattedScsi(1.5)).toThrow();
  });

  it('故障注入(自作リーダーで検出できる範囲): totalSectors32を実際の区画サイズを超える値へ' +
    'ずらすと openDiskImage の整合性検査(hddInvalidHeader)が落ちる', () => {
    // 注意: これは「自作FATリーダーで検出できる」範囲の故障注入にすぎない。
    // sectorsPerFatを1ずらすような不整合(Human68k実機でだけ症状が出るクラスの不整合)は
    // 自作リーダーの書き込み・読み出しが同じフィールドを参照して自己無矛盾になってしまうため
    // 単体テストでは検出できない(自作の相手役でテストすると通ってしまう問題)。
    // このクラスの故障は実機/実ブラウザでのHuman68k起動でしか検出できず、今回のスコープでは
    // 未検証のまま残る(docs/STORAGE-SCSI.md 追記節を参照)。
    const good = createFormattedScsi(100);
    const bad = good.slice();
    const p = 32 * 1024;
    const before = [bad[p + 0x1e], bad[p + 0x1f], bad[p + 0x20], bad[p + 0x21]];
    // totalSectors32を2倍にして、区画の実サイズを超える値へ壊す。
    const totalSectors = ((bad[p + 0x1e] << 24) | (bad[p + 0x1f] << 16) | (bad[p + 0x20] << 8) | bad[p + 0x21]) >>> 0;
    const corrupted = totalSectors * 2;
    bad[p + 0x1e] = (corrupted >>> 24) & 0xff;
    bad[p + 0x1f] = (corrupted >>> 16) & 0xff;
    bad[p + 0x20] = (corrupted >>> 8) & 0xff;
    bad[p + 0x21] = corrupted & 0xff;
    // 壊す前後でバイト列が実際に変わっていることを先に確認する(故障注入の陽性対照)。
    expect([bad[p + 0x1e], bad[p + 0x1f], bad[p + 0x20], bad[p + 0x21]]).not.toEqual(before);

    expect(() => openDiskImage(good, 'blank.hds')).not.toThrow();
    expect(() => openDiskImage(bad, 'blank.hds')).toThrow();
  });
});

// createFormattedScsi()は区画サイズによらず常にFAT16のブランクを作っていたが、
// openFat()(読み取り側)は総クラスタ数4085未満をFAT12と判定していたため、
// 小さいSCSIブランクは自作のリーダに読ませても食い違う不正なイメージになっていた
// (親セッションの実測: 1/2/4MiBはopenFat()がFAT12と判定するのに予約エントリは
// FAT16の書式のままで、FAT12として読んだentry2が$0FF=空きでない、になっていた)。
// このdescribeブロックはその欠陥そのものを射抜くための回帰テスト。
describe('createFormattedScsi: FAT12/FAT16判定とブランクの整合性(回帰)', () => {
  // 親セッションが実機で確認した「1MiB(FAT12だと実測)を境にクラスタ2から
  // 確保できるかどうかが変わる」に対応する、判定の代表サイズ。
  const knownFatType: Array<{ sizeMiB: number; fatType: 'FAT12' | 'FAT16' }> = [
    { sizeMiB: 1, fatType: 'FAT12' },
    { sizeMiB: 2, fatType: 'FAT12' },
    { sizeMiB: 4, fatType: 'FAT12' },
    { sizeMiB: 5, fatType: 'FAT16' },
  ];

  for (const { sizeMiB, fatType } of knownFatType) {
    it(`${sizeMiB}MiBは${fatType}になる(親セッションの実測どおり)`, () => {
      const image = createFormattedScsi(sizeMiB);
      const vol = openDiskImage(image, 'blank.hds');
      expect(vol.fatType).toBe(fatType);
    });
  }

  // SCSI_BLANK_MIN_MIB(FAT12域)から上限近く(FAT16域)まで代表サイズを掃引する。
  const sweepSizesMiB = [SCSI_BLANK_MIN_MIB, 2, 3, 4, 5, 8, 16, 100, 500];

  for (const sizeMiB of sweepSizesMiB) {
    it(`${sizeMiB}MiB: openFat(createFormattedScsi())が成功し、フォーマッタが選んだ型どおりに読め、` +
      'クラスタ2が空きとして読める', () => {
      const image = createFormattedScsi(sizeMiB);
      // フォーマッタ自身が書き込んだBPBから「意図した型」を独立に読み取る
      // (openFat()の判定結果と比較するため、openFat()自体を使わずBPBを直接見る)。
      const partitionStartByte = 32 * 1024;
      const totalSectors =
        ((image[partitionStartByte + 0x1e] << 24) |
          (image[partitionStartByte + 0x1f] << 16) |
          (image[partitionStartByte + 0x20] << 8) |
          image[partitionStartByte + 0x21]) >>>
        0;
      const sectorsPerCluster = image[partitionStartByte + 0x14];
      const reservedSectors = (image[partitionStartByte + 0x16] << 8) | image[partitionStartByte + 0x17];
      const numFats = image[partitionStartByte + 0x15];
      const sectorsPerFat = image[partitionStartByte + 0x1d];
      const rootEntries = (image[partitionStartByte + 0x18] << 8) | image[partitionStartByte + 0x19];
      const rootDirSectors = Math.ceil((rootEntries * 32) / 1024);
      const dataStartSector = reservedSectors + numFats * sectorsPerFat + rootDirSectors;
      const intendedTotalClusters = Math.floor((totalSectors - dataStartSector) / sectorsPerCluster);
      const intendedFatType: 'FAT12' | 'FAT16' = intendedTotalClusters < 4085 ? 'FAT12' : 'FAT16';

      expect(() => openDiskImage(image, 'blank.hds')).not.toThrow();
      const vol = openDiskImage(image, 'blank.hds');

      expect(vol.fatType).toBe(intendedFatType);

      // クラスタ2が「空き」として読めること = 全クラスタが空きのまま(新規ブランクなので)。
      const { free, total } = fatFreeSpace(vol);
      expect(total).toBeGreaterThan(0);
      expect(free).toBe(total);
    });
  }
});

// 各代表サイズで書き込み→読み戻しがバイト一致すること。1クラスタで収まるものと、
// 2クラスタ以上必要なもの(チェーンを張る経路)の両方を含める。
describe('createFormattedScsi: 書き込み→読み戻しの往復一致(FAT12/FAT16の両方)', () => {
  const roundTripSizesMiB = [SCSI_BLANK_MIN_MIB, 4, 5, 100];

  for (const sizeMiB of roundTripSizesMiB) {
    it(`${sizeMiB}MiB: 1クラスタに収まるファイルと2クラスタ以上必要なファイルの両方が往復一致する`, () => {
      const image = createFormattedScsi(sizeMiB);
      const vol = openDiskImage(image, 'blank.hds');
      const bytesPerCluster = vol.bytesPerCluster;

      const small = new Uint8Array(Math.max(1, Math.floor(bytesPerCluster / 4)));
      for (let i = 0; i < small.length; i++) small[i] = i & 0xff;
      const big = new Uint8Array(bytesPerCluster * 2 + 123); // 3クラスタにまたがる
      for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;

      fatWriteFile(vol, 'SMALL.BIN', small);
      fatWriteFile(vol, 'BIG.BIN', big);

      const reopened = openDiskImage(image, 'blank.hds');
      expect(Array.from(fatReadFile(reopened, 'SMALL.BIN'))).toEqual(Array.from(small));
      expect(Array.from(fatReadFile(reopened, 'BIG.BIN'))).toEqual(Array.from(big));
    });
  }
});
