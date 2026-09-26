import * as vscode from 'vscode';
import { applyReversibleEdit, undoLast } from './editHistory';
import { applyEdits, TextEdit } from './pyCall';
import { checkStructure } from './codeStructure';

/**
 * Write edits that were planned and verified against `plannedText`.
 *
 * - Refuses if the document changed since planning (the verification would be stale).
 * - Refuses edits that would break the script's structure: opening/closing a string or
 *   bracket they don't own, or leaving an if/else/label/menu block without a statement.
 * - Normalizes inserted line breaks to the document's EOL.
 * - Records the change in the reversible history.
 * - Re-reads the document and rolls the change back if it is not exactly the text that
 *   was verified — so a file never ends up in a state the verifier did not approve.
 *
 * Returns an error message, or undefined on success.
 */
export async function applyVerifiedEdits(
  uri: vscode.Uri,
  plannedText: string,
  edits: readonly TextEdit[],
  label: string
): Promise<string | undefined> {
  const doc = await vscode.workspace.openTextDocument(uri);
  if (doc.getText() !== plannedText) {
    return 'The file changed while the edit was being prepared. Nothing was written — try again.';
  }
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const normalized = edits.map((e) => ({ ...e, text: e.text.replace(/\r?\n/g, eol) }));
  let expected: string;
  try {
    expected = applyEdits(plannedText, normalized);
  } catch {
    return 'The planned edits overlap. Nothing was written.';
  }
  const structural = checkStructure(plannedText, normalized);
  if (structural) {
    return structural;
  }
  const ws = new vscode.WorkspaceEdit();
  for (const e of normalized) {
    ws.replace(uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
  }
  const ok = await applyReversibleEdit(uri, ws, label);
  if (!ok) {
    return 'VS Code rejected the edit. Nothing was written.';
  }
  const after = (await vscode.workspace.openTextDocument(uri)).getText();
  if (after !== expected) {
    await undoLast();
    return 'The edit did not come out as verified and was rolled back.';
  }
  return undefined;
}

/**
 * The same checked path for code that builds a vscode.WorkspaceEdit on one document:
 * converts it to offset edits against the current text and writes it only if the
 * structure check passes. Shows the reason and returns false when refused.
 */
export async function applyCheckedWorkspaceEdit(doc: vscode.TextDocument, ws: vscode.WorkspaceEdit, label: string): Promise<boolean> {
  const text = doc.getText();
  const edits: TextEdit[] = [];
  for (const [uri, list] of ws.entries()) {
    if (uri.toString() !== doc.uri.toString()) {
      void vscode.window.showWarningMessage('An edit reached into another file — nothing was written.');
      return false;
    }
    for (const e of list) {
      edits.push({ start: doc.offsetAt(e.range.start), end: doc.offsetAt(e.range.end), text: e.newText });
    }
  }
  if (!edits.length) {
    return false;
  }
  const error = await applyVerifiedEdits(doc.uri, text, edits, label);
  if (error) {
    void vscode.window.showWarningMessage(error);
    return false;
  }
  return true;
}
