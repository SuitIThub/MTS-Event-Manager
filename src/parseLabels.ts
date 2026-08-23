import * as vscode from 'vscode';
import { LabelDefinition } from './types';

const LABEL_RE = /^([ \t]*)label[ \t]+(\.?)([A-Za-z0-9_]+)\b/gm;

export function parseLabelsInDocument(uri: vscode.Uri, text: string): LabelDefinition[] {
  const results: LabelDefinition[] = [];
  let parent: string | undefined;
  let match: RegExpExecArray | null;
  LABEL_RE.lastIndex = 0;

  while ((match = LABEL_RE.exec(text)) !== null) {
    const isSub = match[2] === '.';
    const localName = match[3];
    const start = match.index;
    // Compute line/char
    const before = text.slice(0, start);
    const line = before.split('\n').length - 1;
    const lastNl = before.lastIndexOf('\n');
    const character = start - lastNl - 1;
    const endChar = character + match[0].length;

    let name: string;
    if (isSub) {
      if (!parent) {
        // Orphan sublabel — still record as `.local` unlikely; skip or use local only
        name = localName;
      } else {
        name = `${parent}.${localName}`;
      }
    } else {
      name = localName;
      parent = localName;
    }

    results.push({
      name,
      localName,
      isSub,
      uri,
      range: new vscode.Range(line, character, line, endChar),
    });
  }

  return results;
}
