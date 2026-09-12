// HostFS: 未対応の要求(未知コマンド)の記録・診断情報組み立てのテスト(利用者の決定分)。
//
// 検証する範囲:
// - 回数の記録(2回目以降はcountだけ増える)
// - 初回だけヘッダ・ポインタ先を保存する(2回目以降は上書きしない)
// - 記録する種類数の上限(16種)
// - リセット(=新しいHostFsDispatcherインスタンス)で記録が消え、フォルダのつなぎ替え
//   (SwitchableFsの差し替え相当)では消えないこと
// - 診断テキストの組み立てに、ファイル名・覚え書き・ホストのパス等の私的情報が
//   一切乗らないこと

import { describe, expect, it } from 'vitest';
import type { GuestMemory } from '../src/hostfs/guest-memory';
import { HostFsDispatcher } from '../src/hostfs/dispatcher';
import { FakeFs } from '../src/hostfs/filesystem';
import {
  buildHostFsDiagText,
  buildUnknownCommandTooltipLines,
  formatUnknownCommandCode,
  summarizeUnknownCommandLabel,
  type HostFsDiagInput,
} from '../src/hostfs/diag-report';
import type { HostFsUnknownCommandInfo } from '../src/core-protocol';

function makeFakeGuestMemory(size = 0x10000): { mem: GuestMemory; ram: Uint8Array } {
  const ram = new Uint8Array(size);
  const mem: GuestMemory = {
    read: (addr, len) => ram.slice(addr, addr + len),
    write: (addr, bytes) => ram.set(bytes, addr),
  };
  return { mem, ram };
}

function writeU32(ram: Uint8Array, addr: number, off: number, v: number): void {
  ram[addr + off] = (v >>> 24) & 0xff;
  ram[addr + off + 1] = (v >>> 16) & 0xff;
  ram[addr + off + 2] = (v >>> 8) & 0xff;
  ram[addr + off + 3] = v & 0xff;
}

const HDR_ADDR = 0x1000;

describe('HostFsDispatcher: 未対応の要求(未知コマンド)の記録', () => {
  it('初回はヘッダ26バイトを保存し、2回目以降は回数だけ増える', () => {
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    ram[HDR_ADDR + 2] = 0x5f;
    ram[HDR_ADDR + 5] = 0xab; // ヘッダの一部(+5)に印を付けて、初回のものが残るか確認する
    dispatcher.request(HDR_ADDR);
    // 2回目は中身を変えて送る(記録は初回のまま変わらないはず)。
    ram[HDR_ADDR + 5] = 0xff;
    dispatcher.request(HDR_ADDR);
    dispatcher.request(HDR_ADDR);

    const summary = dispatcher.getUnknownCommandsSummary();
    expect(summary).toHaveLength(1);
    expect(summary[0].cmd).toBe(0x5f);
    expect(summary[0].count).toBe(3);
    // ヘッダhexの3バイト目(+2)がコマンド番号、6バイト目(+5)が初回の印(0xab)のままのはず。
    expect(summary[0].headerHex.slice(4, 6)).toBe('5f');
    expect(summary[0].headerHex.slice(10, 12)).toBe('ab');
  });

  it('+14がゲストRAMを指すポインタらしければ、その先32バイトを初回だけ保存する', () => {
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    const PTR = 0x2000;
    for (let i = 0; i < 32; i++) ram[PTR + i] = i;
    ram[HDR_ADDR + 2] = 0x60;
    writeU32(ram, HDR_ADDR, 14, PTR);
    dispatcher.request(HDR_ADDR);

    const summary = dispatcher.getUnknownCommandsSummary();
    expect(summary[0].ptrDumpHex).toBe(
      Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join(''),
    );
  });

  it('+14/+18のどちらもポインタらしくなければptrDumpHexはnull', () => {
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    ram[HDR_ADDR + 2] = 0x61;
    // +14/+18とも0のまま(0は「0より大きい」を満たさずポインタ扱いされない)。
    dispatcher.request(HDR_ADDR);
    expect(dispatcher.getUnknownCommandsSummary()[0].ptrDumpHex).toBeNull();
  });

  it('$C00000以上や奇数番地はポインタとして扱わない', () => {
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    ram[HDR_ADDR + 2] = 0x62;
    writeU32(ram, HDR_ADDR, 14, 0xc00000); // 上限ちょうど(条件は「未満」なので外れる)
    writeU32(ram, HDR_ADDR, 18, 5); // 奇数
    dispatcher.request(HDR_ADDR);
    expect(dispatcher.getUnknownCommandsSummary()[0].ptrDumpHex).toBeNull();
  });

  it('$56/$57(既に対応済み)は未知コマンドとして記録されない', () => {
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    for (const cmd of [0x56, 0x57]) {
      ram[HDR_ADDR + 2] = cmd;
      dispatcher.request(HDR_ADDR);
    }
    expect(dispatcher.getUnknownCommandsSummary()).toHaveLength(0);
  });

  it('記録する種類数は16までで、17種目以降は記録されない(戻り値は変わらず-2のまま)', () => {
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    // 既知コマンド($40/$41...$50、$56/$57)と衝突しない範囲の番号を20種類使う。
    const cmds = Array.from({ length: 20 }, (_, i) => 0x60 + i);
    for (const cmd of cmds) {
      ram[HDR_ADDR + 2] = cmd;
      const pending = dispatcher.request(HDR_ADDR);
      expect(pending).toBe(false);
      expect(readI32(ram, HDR_ADDR + 18)).toBe(-2); // 戻り値は上限を超えても変わらない
    }
    expect(dispatcher.getUnknownCommandsSummary()).toHaveLength(16);
  });

  it('新しいHostFsDispatcherインスタンス(=リセット・再起動相当)では記録が消える', () => {
    const { mem, ram } = makeFakeGuestMemory();
    const d1 = new HostFsDispatcher(mem, new FakeFs());
    ram[HDR_ADDR + 2] = 0x70;
    d1.request(HDR_ADDR);
    expect(d1.getUnknownCommandsSummary()).toHaveLength(1);

    const d2 = new HostFsDispatcher(mem, new FakeFs());
    expect(d2.getUnknownCommandsSummary()).toHaveLength(0);
  });

  it('fsの差し替え(フォルダのつなぎ替え相当)では記録は消えない(同じdispatcherインスタンスのまま)', () => {
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    ram[HDR_ADDR + 2] = 0x71;
    dispatcher.request(HDR_ADDR);
    // フォルダのつなぎ替えはdispatcher自体を作り直さない(worker-bridge.tsのSwitchableFs.current
    // を差し替えるだけ)。dispatcherインスタンスが同じままなら記録は残る、という前提を確認する。
    expect(dispatcher.getUnknownCommandsSummary()).toHaveLength(1);
  });

  it('DEV限定フック: debugInjectSyntheticUnknownCommandは実ゲストRAMに触れず記録する', () => {
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    const before = ram.slice(); // 実ゲストRAM全体のコピー
    dispatcher.debugInjectSyntheticUnknownCommand(0x5f);
    // 実ゲストRAM(ram)は一切書き換わっていないこと。
    expect(ram).toEqual(before);
    const summary = dispatcher.getUnknownCommandsSummary();
    expect(summary).toHaveLength(1);
    expect(summary[0].cmd).toBe(0x5f);
    expect(summary[0].count).toBe(1);
    // 合成ヘッダの+14はポインタらしい値にしてあるので、ptrDumpHexも埋まる。
    expect(summary[0].ptrDumpHex).not.toBeNull();
  });

  it('debugInjectSyntheticUnknownCommand呼び出し後も、通常のrequest()は実ゲストRAM経由のまま', () => {
    const { mem, ram } = makeFakeGuestMemory();
    const dispatcher = new HostFsDispatcher(mem, new FakeFs());
    dispatcher.debugInjectSyntheticUnknownCommand(0x5f);
    ram[HDR_ADDR + 2] = 0x72;
    dispatcher.request(HDR_ADDR);
    expect(readI32(ram, HDR_ADDR + 18)).toBe(-2);
    expect(dispatcher.getUnknownCommandsSummary().map((u) => u.cmd)).toEqual([0x5f, 0x72]);
  });
});

function readI32(ram: Uint8Array, addr: number): number {
  return (ram[addr] << 24) | (ram[addr + 1] << 16) | (ram[addr + 2] << 8) | ram[addr + 3];
}

describe('diag-report: 未対応の要求のラベル・ツールチップ・診断テキスト組み立て', () => {
  const sample: HostFsUnknownCommandInfo[] = [
    { cmd: 0x4f, count: 3, headerHex: 'aa'.repeat(26), ptrDumpHex: 'bb'.repeat(32) },
    { cmd: 0x5a, count: 1, headerHex: 'cc'.repeat(26), ptrDumpHex: null },
  ];

  it('formatUnknownCommandCode: 2桁16進(小文字)の$付き表記', () => {
    expect(formatUnknownCommandCode(0x4f)).toBe('$4f');
    expect(formatUnknownCommandCode(0x05)).toBe('$05');
  });

  it('summarizeUnknownCommandLabel: 0件はnull、1件はextraKinds=0、複数件は先頭+残り数', () => {
    expect(summarizeUnknownCommandLabel([])).toBeNull();
    expect(summarizeUnknownCommandLabel([sample[0]])).toEqual({ cmd: 0x4f, extraKinds: 0 });
    expect(summarizeUnknownCommandLabel(sample)).toEqual({ cmd: 0x4f, extraKinds: 1 });
  });

  it('buildUnknownCommandTooltipLines: 1行1種+末尾にコピーの案内', () => {
    const lines = buildUnknownCommandTooltipLines(
      sample,
      (cmd, count) => `${formatUnknownCommandCode(cmd)} ×${count}`,
      'クリックで診断情報をコピー',
    );
    expect(lines).toEqual(['$4f ×3', '$5a ×1', 'クリックで診断情報をコピー']);
  });

  it('buildHostFsDiagText: ビルド刻印・userAgent・未知コマンドの番号/回数/ヘッダ/ポインタ先・HostFSの状態を含む', () => {
    const input: HostFsDiagInput = {
      buildStamp: 'v1.2.3 (2026-09-13)',
      userAgent: 'TestAgent/1.0',
      unknownCommands: sample,
      driverDetected: true,
      driveNumber: 2,
      folderConnected: true,
      mode: 'readonly',
    };
    const text = buildHostFsDiagText(input);
    expect(text).toContain('v1.2.3 (2026-09-13)');
    expect(text).toContain('TestAgent/1.0');
    expect(text).toContain('detected=true');
    expect(text).toContain('drive=C:');
    expect(text).toContain('connected=true');
    expect(text).toContain('mode=readonly');
    expect(text).toContain('$4f x3');
    expect(text).toContain('aa'.repeat(26));
    expect(text).toContain('bb'.repeat(32));
    expect(text).toContain('$5a x1');
    expect(text).toContain('(none)'); // ptrDumpHex=nullのとき
  });

  it('buildHostFsDiagText: 未接続・未検出のときはdrive/modeが"-"になる', () => {
    const text = buildHostFsDiagText({
      buildStamp: 'v0',
      userAgent: 'UA',
      unknownCommands: [],
      driverDetected: false,
      driveNumber: null,
      folderConnected: false,
      mode: null,
    });
    expect(text).toContain('detected=false drive=-');
    expect(text).toContain('connected=false mode=-');
    expect(text).toContain('unknown commands (0):');
  });

  it('私的情報(ファイル名・覚え書き・ホストのパス)を状態にわざと混ぜても出力に出ない', () => {
    // HostFsDiagInputの型にはそもそもファイル名等のフィールドが無いが、実行時に
    // 紛れ込むケース(呼び出し側のバグ等)を想定し、余分なプロパティを持つオブジェクトを
    // asでキャストして渡しても、出力にそれらの値が一切現れないことを確かめる。
    const contaminated = {
      buildStamp: 'v9',
      userAgent: 'UA9',
      unknownCommands: [],
      driverDetected: false,
      driveNumber: null,
      folderConnected: true,
      mode: 'readwrite',
      // 以下は本来渡してはいけない私的情報(型には存在しないフィールド)。
      hostFileName: 'SECRET-DIARY.TXT',
      hostNote: 'これは私の日記帳フォルダ',
      hostPath: '/Users/example/Documents/秘密のフォルダ',
    } as unknown as HostFsDiagInput;

    const text = buildHostFsDiagText(contaminated);
    expect(text).not.toContain('SECRET-DIARY.TXT');
    expect(text).not.toContain('日記帳');
    expect(text).not.toContain('秘密のフォルダ');
    expect(text).not.toContain('/Users/example');
  });
});
