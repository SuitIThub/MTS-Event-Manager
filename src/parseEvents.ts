import * as vscode from 'vscode';
import { findCallsByName, secondPositionalString } from './callParser';
import { EVENT_KINDS, EventDefinition, EventKind } from './types';

const EVENT_NAME_SET = new Set<string>(EVENT_KINDS);

function precedingAssignmentName(text: string, callStartOffset: number): string | undefined {
  // Look back on same logical statement for `name = Event(`
  let i = callStartOffset - 1;
  while (i >= 0 && /[ \t]/.test(text[i])) {
    i--;
  }
  if (i < 0 || text[i] !== '=') {
    return undefined;
  }
  i--;
  while (i >= 0 && /[ \t]/.test(text[i])) {
    i--;
  }
  let end = i + 1;
  while (i >= 0 && /[A-Za-z0-9_]/.test(text[i])) {
    i--;
  }
  const name = text.slice(i + 1, end);
  return name.length > 0 ? name : undefined;
}

export function parseEventsInDocument(uri: vscode.Uri, text: string): EventDefinition[] {
  const calls = findCallsByName(text, EVENT_NAME_SET);
  const results: EventDefinition[] = [];

  for (const call of calls) {
    const labelName = secondPositionalString(call);
    if (!labelName) {
      continue;
    }
    const kind = call.name as EventKind;
    const startOff = (() => {
      let line = 0;
      let last = -1;
      const targetLine = call.range.start.line;
      const targetChar = call.range.start.character;
      for (let i = 0; i < text.length; i++) {
        if (line === targetLine) {
          return i + targetChar;
        }
        if (text[i] === '\n') {
          line++;
          last = i;
        }
      }
      return text.length;
    })();

    const variableName = precedingAssignmentName(text, startOff);
    const startLine = call.range.start.line;
    const startRange = new vscode.Range(startLine, 0, startLine, Math.max(call.range.start.character + call.name.length, 1));

    results.push({
      kind,
      labelName,
      uri,
      fullRange: call.range,
      startRange,
      variableName,
    });
  }

  return results;
}
