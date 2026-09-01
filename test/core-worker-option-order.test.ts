// Worker経路(?worker=1)で HDD が Human68k から見えなくなる不具合の再発防止テスト。
//
// 経緯(2026-09-01、コーディネータ指摘・実測): `?worker=1` で「ブランクHDDを作成」して起動すると
// `dir c:` が「ドライブ名が無効です」になり、既定経路(?worker=1なし)では同じ手順で正常に
// C: が見える(40781K Byte 使用可能)。原因は src/core-worker.ts の handleInitialize() が
// newHost.init()(内部で mod._retro_init() を同期呼び出しする)を、payload.options を
// newHost.setCoreOption() へ適用するより「先に」呼んでいたこと。
//
// px68k-libretro (libretro/prop.c LoadConfig(), libretro.c retro_init()/pmain()) を実際に
// 読んで確認した事実:
//   - retro_init() は末尾で update_variables(0) を呼び、その場で environ_cb(GET_VARIABLE)
//     経由の現在値を Config へ読み込む。
//   - LibretroHost#setCoreOption()(src/libretro-host.ts)はコア側の状態を持たないJS側の
//     キャッシュへ積むだけで、init()前後どちらでも「呼べる」(例外にはならない)。しかし
//     init()の後に呼ぶと、直前のretro_init()内のupdate_variables(0)には間に合わない
//     (次に環境変数が読まれるのは実行開始後のretro_run()のfirstcallまで無い)。
//   - LoadConfig()(pmain()内、retro_load_game()から呼ばれる)は
//     `if (Config.save_hdd_path) { ...HDD0を読む... }` という実装で、save_hdd_pathが
//     真になっていないとHDD0のパスをiniから読まない。1回でも間に合わないと、
//     以後LoadConfig()が再度呼ばれることは無いためHDDは起動後もずっと無効のまま。
// 既定経路(src/main.ts bootCore())は host.setCoreOption() を host.init() より前に
// 呼んでおり、Worker経路だけこの順序が食い違っていた。
//
// 実ブラウザでの実測(2026-09-01、npm run dev + ?worker=1 + ?bridge=1、ブランクHDD作成→
// システムディスクで起動→`dir c:`):
//   - 修正前: 「ドライブ名が無効です」
//   - 修正後: 「ボリュームがありません C:\」「40781K Byte 使用可能」(既定経路と同じ結果)
//
// このテストは「実ファイルを読んで」handleInitialize() 内で setCoreOption() の適用が
// newHost.init() より前に書かれていることを静的に検査する(core-worker-build-format.test.ts
// と同じ手法: 単体テストでは結線の逆転を検出できない教訓 - docs/STORAGE-SCSI.md
// 「ワーカー移行 手順9」・記憶 feedback_helper_unit_test_misses_the_wiring 参照)。
//
// 陽性対照: 順序を元(init()が先)に戻すと、このテストが実際に落ちることを実装時に手動で
// 確認済み(git diff を空に戻した状態でテストがredになることも確認した)。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..');

function readSrc(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
}

describe('Worker経路のコアオプション適用順序(静的検査)', () => {
  it('handleInitialize() は setCoreOption() を newHost.init() より前に呼ぶ', () => {
    const src = readSrc('src/core-worker.ts');
    const fnMatch = src.match(/async function handleInitialize\([\s\S]*?\n}\n/);
    expect(fnMatch, 'handleInitialize() が見つからない(core-worker.ts の構造が変わった?)').toBeTruthy();
    const fnBody = fnMatch![0];

    const setOptionIdx = fnBody.indexOf('newHost.setCoreOption(');
    const initIdx = fnBody.indexOf('await newHost.init(');

    expect(setOptionIdx, 'newHost.setCoreOption(...) 呼び出しが見つからない').toBeGreaterThan(-1);
    expect(initIdx, 'await newHost.init(...) 呼び出しが見つからない').toBeGreaterThan(-1);
    // setCoreOption() の適用(payload.optionsループ)が newHost.init() より前でなければならない。
    // px68k-libretro の retro_init() が update_variables(0) を末尾で呼び、その時点の
    // environ_cb(GET_VARIABLE) 値を Config へ焼き込むため(コメント参照)。
    expect(setOptionIdx).toBeLessThan(initIdx);
  });
});
