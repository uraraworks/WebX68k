// ファイルマネージャUI (FTPクライアント風2ペイン)。
// 移植元: WebNP2 (../PC98/WebNP2/src/ui/filemanager.ts)。
// ホスト(ブラウザ)⇔実行中スロット(FDD1/FDD2/HDD)/ライブラリ内イメージ間でファイルを出し入れする。
// 実際のディスクI/OはWebX68k(main.ts経由のコールバック)に委譲し、このモジュールは
// DOM構築・ステージング管理・アーカイブ展開・8.3名変換・転送フローのみを担当する。
//
// WebNP2版との差分: FmTarget は表示ラベルを呼び出し側(main.ts)で組み立て済みの
// 文字列として受け取る(drive番号からの組み立てをUI側で持たない)。これはWebX68kが
// FDD1/FDD2/HDDの3スロット構成の表示名を一元管理するため。

import { describeError, t } from './strings.ts';
import type { FatEntry } from './api/fat.ts';
import { isArchive, extractArchive } from './api/archive.ts';

/** 転送先/転送元として選択できる1件(実行中スロット or ライブラリ内イメージ)。 */
export interface FmTarget {
  kind: 'slot' | 'library';
  /** kind='slot': 'fdd0'|'fdd1'|'hdd'。kind='library': disk-store.tsのsourceKey。 */
  ref: string;
  /** 呼び出し側で組み立て済みの表示ラベル(ドライブ名/ファイル名/非対応理由等を含む)。 */
  label: string;
  /** ライブラリ側のエントリが、いずれかの実行中スロットにマウント中かどうか。 */
  mounted: boolean;
  /** FAT12/16として読み書きできるか(D88等の非対応イメージはfalse)。 */
  editable: boolean;
}

/** filemanager.ts が main.ts 側(IndexedDB/コア)へ委譲する操作。 */
export interface FileManagerCallbacks {
  listTargets(): Promise<FmTarget[]>;
  listDir(target: FmTarget, path: string): Promise<{ entries: FatEntry[]; free: number; total: number }>;
  readFile(target: FmTarget, path: string): Promise<Uint8Array>;
  writeFile(target: FmTarget, path: string, data: Uint8Array): Promise<void>;
  deleteFile(target: FmTarget, path: string): Promise<void>;
  makeDir(target: FmTarget, path: string): Promise<void>;
  /** 未フォーマットではなくFAT12フォーマット済みの転送用FDを新規生成し、ライブラリへ保存する。 */
  createTransferFd(desiredName: string): Promise<{ sourceKey: string; name: string }>;
}

export interface FileManagerDialog {
  open(): void;
  /** 言語切替時、ダイアログ内の表示文言・一覧を現在の言語で再構築する。 */
  applyStrings(): void;
}

/** ステージング(ホスト側)1件。アーカイブ展開後のエントリも同じ形で保持する。 */
interface StagedItem {
  id: number;
  name: string;
  size: number;
  data: Uint8Array;
  /** 展開元アーカイブ名。トップレベルから直接追加したファイルはundefined。 */
  group?: string;
}

interface StagedError {
  id: number;
  group: string;
  message: string;
}

let nextStagedId = 1;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

// WebNP2の extractAndValidate83Basename と同じ8.3許容文字集合。
const VALID_83_RE = /^[A-Za-z0-9_\-$~!#%'@(){}^]{1,8}(\.[A-Za-z0-9_\-$~!#%'@(){}^]{1,3})?$/;
const SAFE_83_CHAR_RE = /^[A-Z0-9_\-$~!#%'@(){}^]$/;

function splitBaseExt(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { base: name.slice(0, dot), ext: name.slice(dot + 1) } : { base: name, ext: '' };
}

/** 8.3形式で使える文字だけを残し、それ以外(2バイト文字含む)は'_'に置き換える(大文字化込み)。 */
function clean83Segment(s: string, maxLen: number): string {
  let out = '';
  for (const ch of s.toUpperCase()) {
    if (out.length >= maxLen) break;
    out += SAFE_83_CHAR_RE.test(ch) ? ch : '_';
  }
  return out;
}

/** Unicodeファイル名を8.3形式のDOSファイル名候補へ変換する(重複解消前)。 */
function sanitize83(name: string): string {
  const { base, ext } = splitBaseExt(name);
  const b = clean83Segment(base, 8) || 'FILE';
  const e = clean83Segment(ext, 3);
  return e ? `${b}.${e}` : b;
}

/** 提案名の重複を "~1" 等の連番で解消する(既存ファイル名/他の提案名とも突き合わせる)。 */
function dedupe83(names: string[], existingNames: string[]): string[] {
  const used = new Set(existingNames.map((n) => n.toUpperCase()));
  const result: string[] = [];
  for (const original of names) {
    const { base, ext } = splitBaseExt(original);
    let candidate = original;
    if (used.has(candidate.toUpperCase())) {
      for (let i = 1; i < 10000; i++) {
        const suffix = `~${i}`;
        const trimmedBase = `${base.slice(0, Math.max(1, 8 - suffix.length))}${suffix}`;
        candidate = ext ? `${trimmedBase}.${ext}` : trimmedBase;
        if (!used.has(candidate.toUpperCase())) break;
      }
    }
    used.add(candidate.toUpperCase());
    result.push(candidate);
  }
  return result;
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function downloadBytes(name: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes.slice()], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * ファイルマネージャダイアログを構築し container へ追加する。
 * main.ts からはボタン1つ分の配線(open()呼び出しとapplyStrings()連携)だけ行えばよい。
 */
export function buildFileManagerDialog(container: HTMLElement, callbacks: FileManagerCallbacks): FileManagerDialog {
  const titleEl = el('h2', { class: 'fm-title' }, [t('fmDialogTitle')]);
  const noteEl = el('p', { class: 'fm-note' }, [t('fmDialogNote')]);

  // --- 左ペイン(ホスト) ---
  const hostTitle = el('h3', { class: 'fm-pane-title' }, [t('fmHostPaneTitle')]);
  const hostFileInput = el('input', { type: 'file', class: 'fm-file-input', multiple: 'true' });
  const hostSelectBtn = el('button', { type: 'button', class: 'fm-select-btn' }, [t('fmSelectFilesBtn')]);
  const hostDropHint = el('p', { class: 'fm-drop-hint' }, [t('fmDropHint')]);
  const hostList = el('div', { class: 'fm-staged-list' });
  const hostPane = el('div', { class: 'fm-pane fm-pane-host' }, [
    hostTitle,
    el('div', { class: 'fm-pane-actions' }, [hostSelectBtn, hostFileInput]),
    hostDropHint,
    hostList,
  ]);

  // --- 中央の転送ボタン ---
  const toDiskBtn = el('button', { type: 'button', class: 'fm-transfer-btn' }, ['→']);
  const toHostBtn = el('button', { type: 'button', class: 'fm-transfer-btn' }, ['←']);
  const transferControls = el('div', { class: 'fm-transfer-controls' }, [toDiskBtn, toHostBtn]);

  // --- 右ペイン(ディスク) ---
  const diskTitle = el('h3', { class: 'fm-pane-title' }, [t('fmDiskPaneTitle')]);
  const targetSelect = el('select', { class: 'fm-target-select' }) as HTMLSelectElement;
  const createFdBtn = el('button', { type: 'button', class: 'fm-action-btn' }, [t('fmCreateTransferFdBtn')]);
  const targetRow = el('div', { class: 'fm-target-row' }, [targetSelect, createFdBtn]);
  const upBtn = el('button', { type: 'button', class: 'fm-action-btn' }, [t('fmUpDir')]);
  const pathLabel = el('span', { class: 'fm-path-label' }, [t('fmPathRoot')]);
  const pathRow = el('div', { class: 'fm-path-row' }, [upBtn, pathLabel]);
  const diskList = el('div', { class: 'fm-disk-list' });
  const spaceFill = el('div', { class: 'fm-space-fill' });
  const spaceTrack = el('div', { class: 'fm-space-track' }, [spaceFill]);
  const spaceLabel = el('div', { class: 'fm-space-label' });
  const deleteBtn = el('button', { type: 'button', class: 'fm-action-btn danger' }, [t('fmDeleteSelectedBtn')]);
  const mkdirBtn = el('button', { type: 'button', class: 'fm-action-btn' }, [t('fmMakeDirBtn')]);
  const diskActions = el('div', { class: 'fm-disk-actions' }, [deleteBtn, mkdirBtn]);
  const diskPane = el('div', { class: 'fm-pane fm-pane-disk' }, [
    diskTitle,
    targetRow,
    pathRow,
    diskList,
    spaceTrack,
    spaceLabel,
    diskActions,
  ]);

  const body = el('div', { class: 'fm-body' }, [hostPane, transferControls, diskPane]);
  const statusLine = el('div', { class: 'fm-status' });
  const closeBtn = el('button', { type: 'button', class: 'rom-close-btn' }, [t('fmCloseBtn')]);
  const modal = el('div', { class: 'rom-modal fm-modal', role: 'dialog', 'aria-modal': 'true' }, [
    titleEl,
    noteEl,
    body,
    statusLine,
    el('div', { class: 'rom-modal-footer' }, [closeBtn]),
  ]);
  const backdrop = el('div', { class: 'rom-modal-backdrop fm-modal-backdrop hidden' }, [modal]);
  container.append(backdrop);

  // --- 状態 ---
  let staged: StagedItem[] = [];
  let stagedErrors: StagedError[] = [];
  const selectedStaged = new Set<number>();
  let targets: FmTarget[] = [];
  let currentTarget: FmTarget | null = null;
  let currentPath = '';
  let currentEntries: FatEntry[] = [];
  const selectedDiskNames = new Set<string>();
  let freeBytes = 0;
  let totalBytes = 0;

  function setStatus(message: string, isError = false): void {
    statusLine.textContent = message;
    statusLine.classList.toggle('error', isError);
  }

  function setBusy(v: boolean): void {
    toDiskBtn.disabled = v;
    toHostBtn.disabled = v;
    hostSelectBtn.disabled = v;
    deleteBtn.disabled = v;
    mkdirBtn.disabled = v;
    createFdBtn.disabled = v;
    targetSelect.disabled = v;
    upBtn.disabled = v || currentPath === '';
    closeBtn.disabled = v;
  }

  // --- ホスト側(左ペイン) ---
  function renderStagedList(): void {
    hostList.textContent = '';
    if (staged.length === 0 && stagedErrors.length === 0) {
      hostList.append(el('div', { class: 'fm-list-empty' }, [t('fmStagedEmpty')]));
      return;
    }
    const groups = new Map<string | undefined, StagedItem[]>();
    for (const item of staged) {
      const list = groups.get(item.group) ?? [];
      list.push(item);
      groups.set(item.group, list);
    }
    for (const item of groups.get(undefined) ?? []) {
      hostList.append(renderStagedRow(item));
    }
    for (const [group, items] of groups) {
      if (group === undefined) continue;
      hostList.append(el('div', { class: 'fm-staged-group-title' }, [group]));
      for (const item of items) hostList.append(renderStagedRow(item));
    }
    for (const err of stagedErrors) {
      hostList.append(
        el('div', { class: 'fm-staged-error' }, [t('fmArchiveError', { name: err.group, message: err.message })]),
      );
    }
  }

  function renderStagedRow(item: StagedItem): HTMLElement {
    const checkbox = el('input', { type: 'checkbox' }) as HTMLInputElement;
    checkbox.checked = selectedStaged.has(item.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedStaged.add(item.id);
      else selectedStaged.delete(item.id);
    });
    const nameEl = el('span', { class: 'fm-item-name' }, [item.name]);
    const sizeEl = el('span', { class: 'fm-item-size' }, [formatSize(item.size)]);
    const removeBtn = el('button', { type: 'button', class: 'fm-remove-btn', title: t('fmRemoveBtn') }, ['×']);
    removeBtn.addEventListener('click', () => {
      staged = staged.filter((s) => s.id !== item.id);
      selectedStaged.delete(item.id);
      renderStagedList();
    });
    return el('div', { class: 'fm-staged-item' }, [checkbox, nameEl, sizeEl, removeBtn]);
  }

  async function addHostFiles(files: File[]): Promise<void> {
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (isArchive(file.name)) {
        try {
          const entries = await extractArchive(file.name, bytes);
          for (const entry of entries) {
            staged.push({
              id: nextStagedId++,
              name: entry.name,
              size: entry.data.length,
              data: entry.data,
              group: file.name,
            });
          }
        } catch (err) {
          stagedErrors.push({
            id: nextStagedId++,
            group: file.name,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        staged.push({ id: nextStagedId++, name: file.name, size: bytes.length, data: bytes });
      }
    }
    renderStagedList();
  }

  hostSelectBtn.addEventListener('click', () => hostFileInput.click());
  hostFileInput.addEventListener('change', () => {
    const files = Array.from(hostFileInput.files ?? []);
    hostFileInput.value = '';
    if (files.length > 0) void addHostFiles(files);
  });
  {
    let depth = 0;
    hostPane.addEventListener('dragover', (e) => e.preventDefault());
    hostPane.addEventListener('dragenter', (e) => {
      e.preventDefault();
      depth++;
      hostPane.classList.add('dropzone-active');
    });
    hostPane.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) hostPane.classList.remove('dropzone-active');
    });
    hostPane.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      depth = 0;
      hostPane.classList.remove('dropzone-active');
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) void addHostFiles(files);
    });
  }

  // --- ディスク側(右ペイン) ---
  function renderTargetOptions(): void {
    const prevIndex = targetSelect.selectedIndex;
    targetSelect.textContent = '';
    targets.forEach((target, index) => {
      const opt = el('option', { value: String(index) }, [target.label]);
      if (!target.editable) opt.disabled = true;
      targetSelect.append(opt);
    });
    if (prevIndex >= 0 && prevIndex < targets.length) targetSelect.selectedIndex = prevIndex;
  }

  async function refreshTargets(preferRef?: string): Promise<void> {
    targets = await callbacks.listTargets();
    renderTargetOptions();
    let index = preferRef ? targets.findIndex((tg) => tg.ref === preferRef && tg.editable) : -1;
    if (index < 0) index = targets.findIndex((tg) => tg.editable);
    if (index < 0) index = 0;
    targetSelect.selectedIndex = targets.length > 0 ? index : -1;
    currentTarget = targets[index] ?? null;
    currentPath = '';
    await refreshDiskList();
  }

  targetSelect.addEventListener('change', () => {
    currentTarget = targets[targetSelect.selectedIndex] ?? null;
    currentPath = '';
    void refreshDiskList();
  });

  function renderPath(): void {
    pathLabel.textContent = currentPath ? `/${currentPath}` : t('fmPathRoot');
    upBtn.disabled = currentPath === '';
  }

  function renderSpace(): void {
    const used = totalBytes > 0 ? Math.min(1, Math.max(0, (totalBytes - freeBytes) / totalBytes)) : 0;
    spaceFill.style.width = `${Math.round(used * 100)}%`;
    spaceLabel.textContent = t('fmFreeSpaceLabel', { free: formatSize(freeBytes), total: formatSize(totalBytes) });
  }

  function renderDiskList(): void {
    diskList.textContent = '';
    selectedDiskNames.clear();
    if (!currentTarget || !currentTarget.editable) {
      diskList.append(el('div', { class: 'fm-list-empty' }, [t('fmSelectEditableTarget')]));
      return;
    }
    if (currentEntries.length === 0) {
      diskList.append(el('div', { class: 'fm-list-empty' }, [t('fmEmptyDir')]));
      return;
    }
    const sorted = [...currentEntries].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of sorted) diskList.append(renderDiskRow(entry));
  }

  function renderDiskRow(entry: FatEntry): HTMLElement {
    const checkbox = el('input', { type: 'checkbox' }) as HTMLInputElement;
    checkbox.disabled = entry.isDir;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedDiskNames.add(entry.name);
      else selectedDiskNames.delete(entry.name);
    });
    const nameEl = el('span', { class: 'fm-item-name' }, [
      entry.isDir ? `[${t('fmDirMarker')}] ${entry.name}` : entry.name,
    ]);
    const sizeEl = el('span', { class: 'fm-item-size' }, [entry.isDir ? '' : formatSize(entry.size)]);
    const mtimeEl = el('span', { class: 'fm-item-mtime' }, [entry.mtime ? new Date(entry.mtime).toLocaleString() : '']);
    const row = el('div', { class: entry.isDir ? 'fm-disk-item dir' : 'fm-disk-item' }, [
      checkbox,
      nameEl,
      sizeEl,
      mtimeEl,
    ]);
    if (entry.isDir) {
      row.addEventListener('dblclick', () => {
        currentPath = joinPath(currentPath, entry.name);
        void refreshDiskList();
      });
    }
    return row;
  }

  upBtn.addEventListener('click', () => {
    if (!currentPath) return;
    const segments = currentPath.split('/');
    segments.pop();
    currentPath = segments.join('/');
    void refreshDiskList();
  });

  async function refreshDiskList(): Promise<void> {
    renderPath();
    if (!currentTarget || !currentTarget.editable) {
      currentEntries = [];
      freeBytes = 0;
      totalBytes = 0;
      renderDiskList();
      renderSpace();
      return;
    }
    try {
      const { entries, free, total } = await callbacks.listDir(currentTarget, currentPath);
      currentEntries = entries;
      freeBytes = free;
      totalBytes = total;
      renderDiskList();
      renderSpace();
    } catch (err) {
      // 空き容量表示も戻すこと。残したままだと直前に選んでいた別ディスクの数値が
      // そのまま出て、読めなかったディスクの容量に見えてしまう。
      currentEntries = [];
      freeBytes = 0;
      totalBytes = 0;
      renderDiskList();
      renderSpace();
      setStatus(t('fmListLoadFailed', { message: describeError(err) }), true);
    }
  }

  mkdirBtn.addEventListener('click', () => {
    if (!currentTarget || !currentTarget.editable) return;
    const name = prompt(t('fmMakeDirPrompt'), '');
    if (!name) return;
    if (!VALID_83_RE.test(name)) {
      alert(t('fmMakeDirInvalidName', { name }));
      return;
    }
    const target = currentTarget;
    void (async () => {
      try {
        await callbacks.makeDir(target, joinPath(currentPath, name));
        await refreshDiskList();
      } catch (err) {
        setStatus(t('fmListLoadFailed', { message: describeError(err) }), true);
      }
    })();
  });

  deleteBtn.addEventListener('click', () => {
    if (!currentTarget || !currentTarget.editable) return;
    const names = Array.from(selectedDiskNames);
    if (names.length === 0) return;
    if (!confirm(t('fmDeleteConfirm', { names: names.join(', ') }))) return;
    const target = currentTarget;
    void (async () => {
      setBusy(true);
      for (const name of names) {
        try {
          await callbacks.deleteFile(target, joinPath(currentPath, name));
        } catch (err) {
          setStatus(t('fmListLoadFailed', { message: describeError(err) }), true);
        }
      }
      setBusy(false);
      await refreshDiskList();
    })();
  });

  createFdBtn.addEventListener('click', () => {
    void (async () => {
      setBusy(true);
      try {
        const { sourceKey, name } = await callbacks.createTransferFd('transfer.xdf');
        await refreshTargets(sourceKey);
        setStatus(t('fmTransferFdCreated', { name }));
      } catch (err) {
        setStatus(t('fmListLoadFailed', { message: describeError(err) }), true);
      }
      setBusy(false);
    })();
  });

  // --- 転送 ---
  toDiskBtn.addEventListener('click', () => void transferToDisk());
  toHostBtn.addEventListener('click', () => void transferToHost());

  async function transferToDisk(): Promise<void> {
    if (!currentTarget || !currentTarget.editable) {
      setStatus(t('fmSelectEditableTarget'), true);
      return;
    }
    const target = currentTarget;
    const items = staged.filter((s) => selectedStaged.has(s.id));
    if (items.length === 0) return;

    const existingNames = currentEntries.map((e) => e.name);
    const proposed = dedupe83(
      items.map((it) => sanitize83(it.name)),
      existingNames,
    );

    const renameList = items.map((it, i) => `${it.name} → ${proposed[i]}`).join('\n');
    if (!confirm(t('fmRenameConfirm', { list: renameList }))) return;

    const totalSize = items.reduce((sum, it) => sum + it.data.length, 0);
    if (totalSize > freeBytes) {
      alert(t('fmInsufficientSpace', { needed: formatSize(totalSize), free: formatSize(freeBytes) }));
      return;
    }

    const overwriteNames = proposed.filter((n) => existingNames.some((e) => e.toUpperCase() === n.toUpperCase()));
    if (overwriteNames.length > 0 && !confirm(t('fmOverwriteConfirm', { names: overwriteNames.join(', ') }))) {
      return;
    }

    setBusy(true);
    let succeeded = 0;
    const failedNames: string[] = [];
    for (let i = 0; i < items.length; i++) {
      setStatus(t('fmTransferring', { current: i + 1, total: items.length }));
      try {
        await callbacks.writeFile(target, joinPath(currentPath, proposed[i]), items[i].data);
        succeeded++;
        selectedStaged.delete(items[i].id);
      } catch (err) {
        failedNames.push(`${proposed[i]} (${describeError(err)})`);
      }
    }
    setBusy(false);
    renderStagedList();
    await refreshDiskList();
    setStatus(
      failedNames.length === 0
        ? t('fmTransferDone', { succeeded, failed: 0 })
        : t('fmTransferFailedDetail', { names: failedNames.join(', ') }),
      failedNames.length > 0,
    );
  }

  async function transferToHost(): Promise<void> {
    if (!currentTarget || !currentTarget.editable) {
      setStatus(t('fmSelectEditableTarget'), true);
      return;
    }
    const target = currentTarget;
    const names = Array.from(selectedDiskNames);
    const fileEntries = currentEntries.filter((e) => names.includes(e.name) && !e.isDir);
    if (fileEntries.length === 0) return;

    setBusy(true);
    let succeeded = 0;
    const failedNames: string[] = [];
    for (let i = 0; i < fileEntries.length; i++) {
      setStatus(t('fmTransferring', { current: i + 1, total: fileEntries.length }));
      try {
        const bytes = await callbacks.readFile(target, joinPath(currentPath, fileEntries[i].name));
        downloadBytes(fileEntries[i].name, bytes);
        succeeded++;
        // 連続ダウンロードのポップアップブロック軽減のため少し間隔を空ける。
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
      } catch (err) {
        failedNames.push(`${fileEntries[i].name} (${describeError(err)})`);
      }
    }
    setBusy(false);
    setStatus(
      failedNames.length === 0
        ? t('fmTransferDone', { succeeded, failed: 0 })
        : t('fmTransferFailedDetail', { names: failedNames.join(', ') }),
      failedNames.length > 0,
    );
  }

  function close(): void {
    backdrop.classList.add('hidden');
  }

  closeBtn.addEventListener('click', () => close());
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  function open(): void {
    backdrop.classList.remove('hidden');
    setStatus('');
    void refreshTargets();
  }

  return {
    open,
    applyStrings(): void {
      titleEl.textContent = t('fmDialogTitle');
      noteEl.textContent = t('fmDialogNote');
      hostTitle.textContent = t('fmHostPaneTitle');
      hostSelectBtn.textContent = t('fmSelectFilesBtn');
      hostDropHint.textContent = t('fmDropHint');
      diskTitle.textContent = t('fmDiskPaneTitle');
      createFdBtn.textContent = t('fmCreateTransferFdBtn');
      upBtn.textContent = t('fmUpDir');
      deleteBtn.textContent = t('fmDeleteSelectedBtn');
      mkdirBtn.textContent = t('fmMakeDirBtn');
      closeBtn.textContent = t('fmCloseBtn');
      if (!backdrop.classList.contains('hidden')) void refreshTargets(currentTarget?.ref);
      renderStagedList();
      renderPath();
      renderDiskList();
      renderSpace();
    },
  };
}
