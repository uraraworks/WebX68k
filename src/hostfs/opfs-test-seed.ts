// HostFS (feature/hostfs) P2a #4: `?hostfs=opfs-test` 用。フォルダ選択は自動操作できない
// (プローブから叩けない)ため、OPFS上に検証用ファイル一式を作り、本物のバックエンド
// (HostFolderFs)へ同じHOSTFS_ATTACHメッセージで渡して通す。
//
// 親からの指示書どおりの構成:
//   hello.txt (3000バイト、行ごとに番号入り)
//   readme.doc
//   sub/abc.txt
//   日本語.txt
//   this_name_is_way_too_long_for_human68k.txt (出ないはず)
//   a.b.c (出ないはず、ドットが2つ)

async function writeFile(dir: FileSystemDirectoryHandle, name: string, content: string): Promise<void> {
  const fileHandle = await dir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

function makeNumberedLines(totalBytes: number): string {
  let out = '';
  let n = 1;
  while (out.length < totalBytes) {
    out += `line ${n}\n`;
    n++;
  }
  return out.slice(0, totalBytes);
}

/**
 * OPFS の hostfs-test/ 配下へ検証用ファイル一式を作り、そのDirectoryHandleを返す。
 * 既存のOPFS内容(前回実行分)は残っていてもよい(上書きされるため)。
 */
export async function seedHostFsOpfsTest(): Promise<FileSystemDirectoryHandle> {
  const opfsRoot = await navigator.storage.getDirectory();
  const testRoot = await opfsRoot.getDirectoryHandle('hostfs-test', { create: true });

  await writeFile(testRoot, 'hello.txt', makeNumberedLines(3000));
  await writeFile(testRoot, 'readme.doc', 'HostFS opfs-test: readme.doc\r\n');
  await writeFile(testRoot, '日本語.txt', 'HostFS opfs-test: 日本語ファイル名\r\n');
  await writeFile(testRoot, 'this_name_is_way_too_long_for_human68k.txt', '出ないはず(名前が長すぎる)\r\n');
  await writeFile(testRoot, 'a.b.c', '出ないはず(ドットが2つ)\r\n');

  const sub = await testRoot.getDirectoryHandle('sub', { create: true });
  await writeFile(sub, 'abc.txt', 'HostFS opfs-test: sub/abc.txt\r\n');

  return testRoot;
}
