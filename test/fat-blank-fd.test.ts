import { describe, expect, it } from 'vitest';
import {
  createFormattedFd,
  fatFreeSpace,
  fatList,
  fatMakeDir,
  fatReadFile,
  fatWriteFile,
  openDiskImage,
  openFat,
  type BlankFdFormatId,
} from '../src/api/fat.ts';

import { FD_SIZE_2DD_640, FD_SIZE_2DD_720, FD_SIZE_2HD_1232, FD_SIZE_2HD_1440 } from '../src/disk-store.ts';

const FORMAT_IDS: BlankFdFormatId[] = ['2hd1232', '2hd1440', '2dd640', '2dd720'];
const EXPECTED_SIZES: Record<BlankFdFormatId, number> = {
  '2hd1232': FD_SIZE_2HD_1232,
  '2hd1440': FD_SIZE_2HD_1440,
  '2dd640': FD_SIZE_2DD_640,
  '2dd720': FD_SIZE_2DD_720,
};

describe('createFormattedFd', () => {
  for (const id of FORMAT_IDS) {
    describe(`format: ${id}`, () => {
      it('openDiskImageで例外を投げずに開ける', () => {
        const image = createFormattedFd(id);
        expect(() => openDiskImage(image, 'blank.xdf')).not.toThrow();
      });

      it('生成直後のルートディレクトリは空', () => {
        const image = createFormattedFd(id);
        const vol = openDiskImage(image, 'blank.xdf');
        expect(fatList(vol, '')).toEqual([]);
      });

      it('ファイル書き込み→読み出しでバイト完全一致', () => {
        const image = createFormattedFd(id);
        const vol = openDiskImage(image, 'blank.xdf');
        const data = new Uint8Array(1024);
        for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff;
        fatWriteFile(vol, 'TEST.TXT', data);

        const reopened = openDiskImage(image, 'blank.xdf');
        expect(fatList(reopened, '').map((e) => e.name)).toContain('TEST.TXT');
        expect(Array.from(fatReadFile(reopened, 'TEST.TXT'))).toEqual(Array.from(data));
      });

      it('サブディレクトリ作成がfatListの一覧に現れる', () => {
        const image = createFormattedFd(id);
        const vol = openDiskImage(image, 'blank.xdf');
        fatMakeDir(vol, 'SUBDIR');

        const reopened = openDiskImage(image, 'blank.xdf');
        expect(fatList(reopened, '').map((e) => e.name)).toContain('SUBDIR');
      });

      it('fatFreeSpace(vol).totalがtotalClusters*bytesPerClusterと一致する', () => {
        const image = createFormattedFd(id);
        const vol = openFat(image, 0);
        const { total } = fatFreeSpace(vol);
        expect(total).toBe(vol.totalClusters * vol.bytesPerCluster);
        expect(total).toBeGreaterThan(0);
      });

      // px68k は XDF を「拡張子から決まる固定サイズ」で読み書きするため、
      // ジオメトリを変えてもイメージ長は disk-store.ts の判定値と一致していなければならない。
      it('イメージ長がdisk-store.tsのFDサイズ判定と一致する', () => {
        expect(createFormattedFd(id).length).toBe(EXPECTED_SIZES[id]);
      });
    });
  }
});
