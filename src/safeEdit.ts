import * as vscode from 'vscode';
import { applyReversibleEdit, undoLast } from './editHistory';
import { applyEdits, TextEdit } from './pyCall';

/**
 * Write edits that were planned and verified against `plannedText`.
 *
 * - Refuses if the document changed since planning (the verification would be stale).
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
