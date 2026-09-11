import * as vscode from 'vscode';
import { findAllCallsByName, findCallsByName, secondPositionalString, walkCalls } from './callParser';
import { positionToOffset, readStringLiteral } from './scan';
import { EVENT_KINDS, EventDefinition, EventKind, EventPatternInfo, ParsedCall } from './types';

const EVENT_NAME_SET = new Set<string>(EVENT_KINDS);

function extractPatternsFromEventCall(call: import('./types').ParsedCall): EventPatternInfo[] {
  const patterns: EventPatternInfo[] = [];
  walkCalls(call, (c) => {
    if (c.name !== 'Pattern') {
      return;
    }
    const positionals: string[] = [];
    for (const arg of c.args) {
      if (arg.name) {
        continue;
      }
      const lit = readStringLiteral(arg.text, 0);
      if (lit) {
        positionals.push(lit.value);
      }
    }
    if (positionals.length >= 2) {
      patterns.push({
        patternKey: positionals[0],
        pathTemplate: positionals[1],
        altKeys: positionals.slice(2),
      });
    }
  });
  return patterns;
}

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
      patterns: extractPatternsFromEventCall(call),
      selectorValues: extractSelectorValuesFromEventCall(text, call),
    });
  }

  return results;
}

function collectStringLiterals(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '#') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const lit = readStringLiteral(text, i);
      if (lit) {
        out.push(lit.value);
        i = lit.end;
        continue;
      }
    }
    i++;
  }
  return out;
}

function selectorKey(call: ParsedCall): string | undefined {
  for (const arg of call.args) {
    if (arg.name === 'key') {
      return readStringLiteral(arg.text, 0)?.value;
    }
  }
  for (const arg of call.args) {
    if (arg.name) {
      continue;
    }
    return readStringLiteral(arg.text, 0)?.value;
  }
  return undefined;
}

/** All string literals from selector args except the key (first positional / key=). */
export function extractSelectorValuesFromEventCall(
  text: string,
  call: ParsedCall
): Record<string, string[]> {
  const start = positionToOffset(text, call.range.start.line, call.range.start.character);
  const end = positionToOffset(text, call.range.end.line, call.range.end.character);
  const selectorCalls = findAllCallsByName(text, (name) => name.endsWith('Selector'), start, end);
  const out: Record<string, string[]> = {};

  for (const sel of selectorCalls) {
    const key = selectorKey(sel);
    if (!key) {
      continue;
    }
    const values: string[] = [];
    let positional = 0;
    for (const arg of sel.args) {
      if (!arg.name) {
        if (positional === 0) {
          positional++;
          continue;
        }
        positional++;
      } else if (arg.name === 'key') {
        continue;
      }
      values.push(...collectStringLiterals(arg.text));
    }
    if (values.length === 0) {
      continue;
    }
    const set = new Set(out[key] ?? []);
    for (const v of values) {
      if (v) {
        set.add(v);
      }
    }
    out[key] = [...set];
  }
  return out;
}
