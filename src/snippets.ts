import * as vscode from 'vscode';
import { formatSignature } from './parseSchema';
import { ClassSchema, SchemaKind } from './types';
import { WorkspaceIndex } from './indexer';
import { findMatching, offsetToPosition, positionToOffset } from './scan';

function hintForParam(typeHint?: string): 'string' | 'number' | 'bool' | 'other' {
  if (!typeHint) {
    return 'other';
  }
  const t = typeHint.toLowerCase();
  if (t.includes('str')) {
    return 'string';
  }
  if (t.includes('bool')) {
    return 'bool';
  }
  if (t.includes('int') || t.includes('float') || t.includes('num')) {
    return 'number';
  }
  return 'other';
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function composeInsertSnippet(indent: string, schema: ClassSchema): vscode.SnippetString {
  const s = new vscode.SnippetString();
  s.appendText(',\n' + indent);
  s.appendText(`${schema.name}(`);
  let tab = 1;
  let wrote = false;

  const positionals = schema.params.filter((p) => p.kind === 'positional');
  const varargs = schema.params.filter((p) => p.kind === 'vararg');
  const hasKwargs = schema.params.some((p) => p.kind === 'kwargs');

  for (const p of positionals) {
    if (wrote) {
      s.appendText(', ');
    }
    wrote = true;
    const kind = hintForParam(p.typeHint);
    const placeholder = p.default !== undefined ? stripQuotes(p.default) : p.name;
    if (kind === 'string' || (p.required && kind === 'other')) {
      s.appendText('"');
      s.appendPlaceholder(String(placeholder), tab++);
      s.appendText('"');
    } else if (kind === 'bool') {
      s.appendPlaceholder(p.default ?? 'True', tab++);
    } else {
      s.appendPlaceholder(String(placeholder), tab++);
    }
  }

  if (varargs.length > 0) {
    if (wrote) {
      s.appendText(', ');
    }
    wrote = true;
    s.appendPlaceholder(varargs[0].name, tab++);
  }

  if (hasKwargs && schema.inferredKwargs.length > 0) {
    const keys =
      positionals.filter((p) => p.required).length === 0
        ? schema.inferredKwargs.slice(0, 3)
        : [];
    for (const key of keys) {
      if (wrote) {
        s.appendText(', ');
      }
      wrote = true;
      s.appendText(`${key} = "`);
      s.appendPlaceholder('x', tab++);
      s.appendText('"');
    }
  } else if (hasKwargs && !wrote) {
    s.appendPlaceholder('key = value', tab++);
  }

  s.appendText(')');
  return s;
}

export async function pickAndInsertSchema(
  index: WorkspaceIndex,
  kind: SchemaKind,
  eventUri: vscode.Uri,
  eventFullRange: vscode.Range
): Promise<void> {
  const items = index.getInsertableSchemas(kind);
  if (items.length === 0) {
    void vscode.window.showWarningMessage(
      `No ${kind} classes discovered yet. Open a Mind the School workspace with .rpy definitions.`
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    items.map((s) => ({
      label: s.name,
      description: s.kind,
      detail: formatSignature(s),
      schema: s,
    })),
    {
      placeHolder: `Insert ${kind}`,
      matchOnDetail: true,
      matchOnDescription: true,
    }
  );
  if (!picked) {
    return;
  }

  const editor = await ensureEditor(eventUri);
  if (!editor) {
    return;
  }

  const insertPos = findInsertPosition(editor.document, eventFullRange);
  if (!insertPos) {
    void vscode.window.showErrorMessage('Could not find Event call closing parenthesis.');
    return;
  }

  const indent = guessIndent(editor.document, eventFullRange);
  await editor.insertSnippet(composeInsertSnippet(indent, picked.schema), insertPos);
}

async function ensureEditor(uri: vscode.Uri): Promise<vscode.TextEditor | undefined> {
  const active = vscode.window.activeTextEditor;
  if (active && active.document.uri.toString() === uri.toString()) {
    return active;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  return vscode.window.showTextDocument(doc, { preserveFocus: false, preview: false });
}

function findInsertPosition(
  doc: vscode.TextDocument,
  eventFullRange: vscode.Range
): vscode.Position | undefined {
  const text = doc.getText();
  const startOff = positionToOffset(text, eventFullRange.start.line, eventFullRange.start.character);
  let open = -1;
  for (let i = startOff; i < text.length && i < startOff + 120; i++) {
    if (text[i] === '(') {
      open = i;
      break;
    }
  }
  if (open < 0) {
    return undefined;
  }
  const close = findMatching(text, open);
  if (close < 0) {
    return undefined;
  }
  let insertAt = close;
  while (insertAt > open + 1 && /[ \t\r\n]/.test(text[insertAt - 1])) {
    insertAt--;
  }
  const pos = offsetToPosition(text, insertAt);
  return new vscode.Position(pos.line, pos.character);
}

function guessIndent(doc: vscode.TextDocument, eventFullRange: vscode.Range): string {
  const startLine = eventFullRange.start.line;
  if (startLine + 1 < doc.lineCount) {
    const lineText = doc.lineAt(startLine + 1).text;
    const m = lineText.match(/^([ \t]+)/);
    if (m) {
      return m[1];
    }
  }
  const base = doc.lineAt(startLine).text.match(/^([ \t]*)/)?.[1] ?? '';
  return base + '    ';
}
