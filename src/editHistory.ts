import * as vscode from 'vscode';

/**
 * History of every code change made by the extension (event timeline, paperdoll editor,
 * definition editor, …). Each change is stored as blocks ("hunks") of changed lines with a
 * little context, so a single block can be found and reverted later — also after other edits
 * elsewhere in the file. The history is kept per workspace across restarts. The native
 * editor undo stays untouched.
 */

export interface Hunk {
  /** Offset of the block in the text right after the change. */
  offset: number;
  beforeSeg: string;
  afterSeg: string;
  ctxBefore: string;
  ctxAfter: string;
  /** 0-based line of the block in the text after the change (display). */
  line: number;
  /** A few unchanged lines around the block (display only). */
  linesBefore: string[];
  linesAfter: string[];
  reverted?: boolean;
}

export interface HistoryEntry {
  id: number;
  uri: string;
  label: string;
  time: number;
  hunks: Hunk[];
  /** Set on entries that revert blocks of another entry. */
  revertOf?: number;
}

export type HunkState = 'applied' | 'reverted' | 'changed';

const STATE_KEY = 'mtsEventManager.changeHistory';
const MAX_ENTRIES = 300;
/** Upper bound of stored text; the oldest entries go first. */
const MAX_CHARS = 2_000_000;
const CONTEXT = 40;
/** Line diffs above this size (lines per side) are stored as one block. */
const MAX_DIFF_LINES = 1500;
const DISPLAY_CONTEXT_LINES = 2;

let entries: HistoryEntry[] = [];
let nextId = 1;
let memento: vscode.Memento | undefined;
let saveTimer: NodeJS.Timeout | undefined;
const emitter = new vscode.EventEmitter<void>();

/** Fires whenever the history changes. */
export const onDidChangeHistory = emitter.event;

/** Load the workspace's history (call once on activation). */
export function initHistory(context: vscode.ExtensionContext): void {
  memento = context.workspaceState;
  const stored = memento.get<{ nextId: number; entries: HistoryEntry[] }>(STATE_KEY);
  if (stored && Array.isArray(stored.entries)) {
    entries = stored.entries;
    nextId = Math.max(stored.nextId ?? 1, ...entries.map((e) => e.id + 1), 1);
  }
}

function changed(): void {
  emitter.fire();
  if (!memento) {
    return;
  }
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    void memento!.update(STATE_KEY, { nextId, entries });
  }, 500);
}

function trim(): void {
  const size = (e: HistoryEntry) => e.hunks.reduce((n, h) => n + h.beforeSeg.length + h.afterSeg.length, 0);
  let total = entries.reduce((n, e) => n + size(e), 0);
  while (entries.length > MAX_ENTRIES || (total > MAX_CHARS && entries.length > 1)) {
    total -= size(entries[0]);
    entries.shift();
  }
}

export function getHistory(): readonly HistoryEntry[] {
  return entries;
}

export function getEntry(id: number): HistoryEntry | undefined {
  return entries.find((e) => e.id === id);
}

export function clearHistory(): void {
  entries = [];
  changed();
}

/** Record a change (before → after of one document). Returns the entry, if anything changed. */
export function recordChange(uri: vscode.Uri, label: string, before: string, after: string, revertOf?: number): HistoryEntry | undefined {
  if (after === before) {
    return undefined;
  }
  const entry: HistoryEntry = { id: nextId++, uri: uri.toString(), label, time: Date.now(), hunks: computeHunks(before, after), revertOf };
  entries.push(entry);
  trim();
  changed();
  return entry;
}

export async function applyReversibleEdit(uri: vscode.Uri, edit: vscode.WorkspaceEdit, label: string): Promise<boolean> {
  const before = (await vscode.workspace.openTextDocument(uri)).getText();
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    return false;
  }
  const after = (await vscode.workspace.openTextDocument(uri)).getText();
  recordChange(uri, pendingLabel?.label ?? label, before, after, pendingLabel?.revertOf);
  return true;
}

/**
 * Set by the revert operation around its (verified) write, so the recorded entry is marked
 * as a revert of the original one.
 */
let pendingLabel: { label: string; revertOf: number } | undefined;
export async function withRevertOf<T>(revertOf: number, label: string, fn: () => Promise<T>): Promise<T> {
  pendingLabel = { label, revertOf };
  try {
    return await fn();
  } finally {
    pendingLabel = undefined;
  }
}

export function markReverted(id: number, hunkIndexes: number[]): void {
  const e = getEntry(id);
  if (!e) {
    return;
  }
  for (const i of hunkIndexes) {
    if (e.hunks[i]) {
      e.hunks[i].reverted = true;
    }
  }
  changed();
}

/**
 * Undo a change that failed verification: put the old text back and drop the entry — the
 * change never happened as far as the history is concerned.
 */
export async function rollbackLast(): Promise<void> {
  const entry = entries.pop();
  if (!entry) {
    return;
  }
  changed();
  const uri = vscode.Uri.parse(entry.uri);
  const doc = await vscode.workspace.openTextDocument(uri);
  let cur = doc.getText();
  const edit = new vscode.WorkspaceEdit();
  // Last block first: earlier offsets stay valid.
  for (const h of [...entry.hunks].reverse()) {
    const at = locateRegion(cur, h);
    if (at === undefined) {
      continue;
    }
    edit.replace(uri, new vscode.Range(doc.positionAt(at), doc.positionAt(at + h.afterSeg.length)), h.beforeSeg);
    cur = cur.slice(0, at) + h.beforeSeg + cur.slice(at + h.afterSeg.length);
  }
  await vscode.workspace.applyEdit(edit);
}

/** Where each block stands in the current text of its file. */
export function hunkState(cur: string, h: Hunk): HunkState {
  // Read from the text alone: Ctrl+Z / redo in the editor are reflected too.
  if (locateRegion(cur, h) !== undefined) {
    return 'applied';
  }
  if (locateRegion(cur, { ...h, afterSeg: h.beforeSeg }) !== undefined) {
    return 'reverted';
  }
  return 'changed';
}

// ── Diff ──────────────────────────────────────────────────────────────────────

/** The changed region as one block (common prefix/suffix removed). */
export function diffRegion(before: string, after: string): Omit<Hunk, 'line' | 'linesBefore' | 'linesAfter'> {
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) {
    p++;
  }
  let s = 0;
  while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) {
    s++;
  }
  const afterEnd = after.length - s;
  return {
    offset: p,
    beforeSeg: before.slice(p, before.length - s),
    afterSeg: after.slice(p, afterEnd),
    ctxBefore: after.slice(Math.max(0, p - CONTEXT), p),
    ctxAfter: after.slice(afterEnd, afterEnd + CONTEXT),
  };
}

/**
 * Split a change into blocks of changed lines: common prefix/suffix lines are cut, the rest
 * is diffed line by line (LCS). Each block can be reverted on its own.
 */
export function computeHunks(before: string, after: string): Hunk[] {
  const b = before.split('\n');
  const a = after.split('\n');
  let pre = 0;
  while (pre < b.length && pre < a.length && b[pre] === a[pre]) {
    pre++;
  }
  let suf = 0;
  while (suf < b.length - pre && suf < a.length - pre && b[b.length - 1 - suf] === a[a.length - 1 - suf]) {
    suf++;
  }
  const bMid = b.slice(pre, b.length - suf);
  const aMid = a.slice(pre, a.length - suf);
  // Line index ranges [bFrom, bTo) / [aFrom, aTo) of each changed block.
  const blocks: { bFrom: number; bTo: number; aFrom: number; aTo: number }[] = [];
  if (bMid.length > MAX_DIFF_LINES || aMid.length > MAX_DIFF_LINES || bMid.length * aMid.length > 4_000_000) {
    blocks.push({ bFrom: pre, bTo: b.length - suf, aFrom: pre, aTo: a.length - suf });
  } else {
    const n = bMid.length;
    const m = aMid.length;
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = bMid[i] === aMid[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    let open: { bFrom: number; aFrom: number } | undefined;
    const close = () => {
      if (open) {
        blocks.push({ bFrom: pre + open.bFrom, bTo: pre + i, aFrom: pre + open.aFrom, aTo: pre + j });
        open = undefined;
      }
    };
    while (i < n || j < m) {
      if (i < n && j < m && bMid[i] === aMid[j]) {
        close();
        i++;
        j++;
      } else {
        open ??= { bFrom: i, aFrom: j };
        if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
          j++;
        } else {
          i++;
        }
      }
    }
    close();
  }
  const aStarts = lineStarts(after);
  const bStarts = lineStarts(before);
  const off = (starts: number[], text: string, line: number) => (line < starts.length ? starts[line] : text.length);
  return blocks.map((k) => {
    // Whole lines incl. their newline; a block at the very end has no trailing newline.
    const aStart = off(aStarts, after, k.aFrom);
    const aEnd = off(aStarts, after, k.aTo);
    const bStart = off(bStarts, before, k.bFrom);
    const bEnd = off(bStarts, before, k.bTo);
    return {
      offset: aStart,
      beforeSeg: before.slice(bStart, bEnd),
      afterSeg: after.slice(aStart, aEnd),
      ctxBefore: after.slice(Math.max(0, aStart - CONTEXT), aStart),
      ctxAfter: after.slice(aEnd, aEnd + CONTEXT),
      line: k.aFrom,
      linesBefore: a.slice(Math.max(0, k.aFrom - DISPLAY_CONTEXT_LINES), k.aFrom),
      linesAfter: a.slice(k.aTo, k.aTo + DISPLAY_CONTEXT_LINES),
    };
  });
}

function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      out.push(i + 1);
    }
  }
  return out;
}

/**
 * Where a block is in `cur`: at its recorded offset, or — if other edits shifted it — the
 * unique place of the block with its context.
 */
export function locateRegion(cur: string, e: Pick<Hunk, 'offset' | 'afterSeg' | 'ctxBefore' | 'ctxAfter'>): number | undefined {
  const matchesAt = (o: number) =>
    o >= e.ctxBefore.length &&
    cur.slice(o - e.ctxBefore.length, o) === e.ctxBefore &&
    cur.startsWith(e.afterSeg, o) &&
    cur.startsWith(e.ctxAfter, o + e.afterSeg.length);
  if (matchesAt(e.offset)) {
    return e.offset;
  }
  const unique = (needle: string, shift: number): number | undefined => {
    if (!needle) {
      return undefined;
    }
    const first = cur.indexOf(needle);
    if (first < 0 || cur.indexOf(needle, first + 1) >= 0) {
      return undefined;
    }
    return first + shift;
  };
  return unique(e.ctxBefore + e.afterSeg + e.ctxAfter, e.ctxBefore.length) ?? (e.afterSeg.length >= 8 ? unique(e.afterSeg, 0) : undefined);
}
