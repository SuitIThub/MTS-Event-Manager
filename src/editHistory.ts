import * as vscode from 'vscode';

/**
 * A shared undo stack for edits made through the event timeline and the paperdoll
 * editor. Each entry stores only the changed region (plus a little surrounding context),
 * so undo still works after unrelated edits elsewhere in the file — e.g. whitespace
 * trimmed on save or a manual fix a few lines away. The native editor undo stays intact.
 */
interface Entry {
  uri: string;
  label: string;
  /** Offset of the changed region in the post-edit text. */
  offset: number;
  beforeSeg: string;
  afterSeg: string;
  ctxBefore: string;
  ctxAfter: string;
}

const stack: Entry[] = [];
const MAX = 40;
const CONTEXT = 40;
const emitter = new vscode.EventEmitter<void>();

/** Fires whenever the undo stack changes (push or pop). */
export const onDidChangeHistory = emitter.event;

export async function applyReversibleEdit(
  uri: vscode.Uri,
  edit: vscode.WorkspaceEdit,
  label: string
): Promise<boolean> {
  const before = (await vscode.workspace.openTextDocument(uri)).getText();
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    return false;
  }
  const after = (await vscode.workspace.openTextDocument(uri)).getText();
  if (after === before) {
    return true;
  }
  stack.push({ uri: uri.toString(), label, ...diffRegion(before, after) });
  while (stack.length > MAX) {
    stack.shift();
  }
  emitter.fire();
  return true;
}

export function diffRegion(before: string, after: string): Omit<Entry, 'uri' | 'label'> {
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) {
    p++;
  }
  let s = 0;
  while (
    s < max - p &&
    before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)
  ) {
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

export function canUndo(): boolean {
  return stack.length > 0;
}

export function lastLabel(): string | undefined {
  return stack[stack.length - 1]?.label;
}

export type UndoResult =
  | { label: string; status: 'reverted' }
  | { label: string; status: 'already' }
  | { label: string; status: 'lost' };

/**
 * Revert the most recent recorded edit. Finds the changed region at its recorded offset,
 * or — if other edits shifted it — by searching for it with its context.
 */
export async function undoLast(): Promise<UndoResult | undefined> {
  const entry = stack.pop();
  if (!entry) {
    return undefined;
  }
  emitter.fire();
  const uri = vscode.Uri.parse(entry.uri);
  const doc = await vscode.workspace.openTextDocument(uri);
  const cur = doc.getText();
  const at = locateRegion(cur, entry);
  if (at === undefined) {
    // Already reverted (e.g. with Ctrl+Z)? Then the pre-edit text sits in its place.
    if (locateRegion(cur, { ...entry, afterSeg: entry.beforeSeg }) !== undefined) {
      return { label: entry.label, status: 'already' };
    }
    return { label: entry.label, status: 'lost' };
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(doc.positionAt(at), doc.positionAt(at + entry.afterSeg.length)), entry.beforeSeg);
  await vscode.workspace.applyEdit(edit);
  return { label: entry.label, status: 'reverted' };
}

export function locateRegion(cur: string, e: Pick<Entry, 'offset' | 'afterSeg' | 'ctxBefore' | 'ctxAfter'>): number | undefined {
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
  return (
    unique(e.ctxBefore + e.afterSeg + e.ctxAfter, e.ctxBefore.length) ??
    (e.afterSeg.length >= 8 ? unique(e.afterSeg, 0) : undefined)
  );
}
