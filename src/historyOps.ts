import * as vscode from 'vscode';
import { getEntry, getHistory, hunkState, locateRegion, markReverted, withRevertOf } from './editHistory';
import { TextEdit } from './pyCall';
import { applyVerifiedEdits } from './safeEdit';

/**
 * Reverting recorded changes block by block. A revert is a normal verified edit (structure
 * check included) and is itself recorded — so it can be reverted again.
 */

/** Revert blocks of a history entry (all when `hunkIndexes` is omitted). Returns an error text or undefined. */
export async function revertBlocks(id: number, hunkIndexes?: number[]): Promise<string | undefined> {
  const entry = getEntry(id);
  if (!entry) {
    return 'That change is no longer in the history.';
  }
  const uri = vscode.Uri.parse(entry.uri);
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    return 'The file of that change cannot be opened anymore.';
  }
  const cur = doc.getText();
  const wanted = hunkIndexes ?? entry.hunks.map((_, i) => i);
  const indexes = wanted.filter((i) => entry.hunks[i] && hunkState(cur, entry.hunks[i]) === 'applied');
  if (!indexes.length) {
    return wanted.some((i) => entry.hunks[i] && hunkState(cur, entry.hunks[i]) === 'reverted')
      ? 'Already reverted.'
      : 'The changed lines were edited since — this block cannot be reverted automatically.';
  }
  const edits: TextEdit[] = [];
  for (const i of indexes) {
    const h = entry.hunks[i];
    const at = locateRegion(cur, h)!;
    edits.push({ start: at, end: at + h.afterSeg.length, text: h.beforeSeg });
  }
  edits.sort((a, b) => a.start - b.start);
  for (let k = 1; k < edits.length; k++) {
    if (edits[k].start < edits[k - 1].end) {
      return 'These blocks overlap in the current text — revert them one by one.';
    }
  }
  const what = indexes.length === entry.hunks.length ? entry.label : `${entry.label} (${indexes.length} of ${entry.hunks.length} blocks)`;
  const error = await withRevertOf(id, `Revert: ${what}`, () => applyVerifiedEdits(uri, cur, edits, `Revert: ${what}`));
  if (!error) {
    markReverted(id, indexes);
  }
  return error;
}

export type UndoResult = { label: string; status: 'reverted' } | { label: string; status: 'lost'; reason: string };

/**
 * The timeline's ↩ Undo: revert the newest change (not itself a revert) that still has
 * applied blocks.
 */
export async function undoLastChange(): Promise<UndoResult | undefined> {
  const history = getHistory();
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    if (e.revertOf !== undefined) {
      continue;
    }
    let cur: string;
    try {
      cur = (await vscode.workspace.openTextDocument(vscode.Uri.parse(e.uri))).getText();
    } catch {
      continue;
    }
    const states = e.hunks.map((h) => hunkState(cur, h));
    if (states.every((s) => s === 'reverted')) {
      continue;
    }
    const error = await revertBlocks(e.id);
    return error ? { label: e.label, status: 'lost', reason: error } : { label: e.label, status: 'reverted' };
  }
  return undefined;
}
