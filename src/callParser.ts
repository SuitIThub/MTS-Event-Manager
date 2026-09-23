import * as vscode from 'vscode';
import {
  findMatching,
  offsetToPosition,
  positionToOffset,
  readIdentifier,
  readStringLiteral,
  skipString,
  skipWhitespaceAndComments,
} from './scan';
import { ParsedArg, ParsedCall } from './types';

function toRange(text: string, start: number, end: number): vscode.Range {
  const s = offsetToPosition(text, start);
  const e = offsetToPosition(text, end);
  return new vscode.Range(s.line, s.character, e.line, e.character);
}

/**
 * Parse a function/class call starting at `nameStart` where an identifier begins,
 * followed by `(`. Returns undefined if not a call.
 */
export function parseCallAt(text: string, nameStart: number): ParsedCall | undefined {
  const id = readIdentifier(text, nameStart);
  if (!id) {
    return undefined;
  }
  let i = skipWhitespaceAndComments(text, id.end);
  if (i >= text.length || text[i] !== '(') {
    return undefined;
  }
  const open = i;
  const close = findMatching(text, open);
  if (close < 0) {
    return undefined;
  }
  const args = parseArgList(text, open + 1, close);
  return {
    name: id.name,
    range: toRange(text, nameStart, close + 1),
    nameRange: toRange(text, nameStart, id.end),
    args,
  };
}

/**
 * Split arguments between `start` (after `(`) and `end` (at `)`), respecting nesting/strings.
 */
export function parseArgList(text: string, start: number, end: number): ParsedArg[] {
  const args: ParsedArg[] = [];
  let i = skipWhitespaceAndComments(text, start);
  while (i < end) {
    const argStart = i;
    // Detect keyword: ident = (not ==)
    let keyword: string | undefined;
    const maybeId = readIdentifier(text, i);
    if (maybeId) {
      const after = skipWhitespaceAndComments(text, maybeId.end);
      if (after < end && text[after] === '=' && text[after + 1] !== '=') {
        keyword = maybeId.name;
        i = skipWhitespaceAndComments(text, after + 1);
      }
    }

    const valueStart = i;
    // Scan until comma at depth 0 or end
    let depthParen = 0;
    let depthBracket = 0;
    let depthBrace = 0;
    while (i < end) {
      const c = text[i];
      if (c === '"' || c === "'") {
        i = skipString(text, i);
        continue;
      }
      if (c === '#') {
        while (i < end && text[i] !== '\n') {
          i++;
        }
        continue;
      }
      if (c === '(') {
        depthParen++;
        i++;
        continue;
      }
      if (c === ')') {
        if (depthParen === 0) {
          break;
        }
        depthParen--;
        i++;
        continue;
      }
      if (c === '[') {
        depthBracket++;
        i++;
        continue;
      }
      if (c === ']') {
        depthBracket--;
        i++;
        continue;
      }
      if (c === '{') {
        depthBrace++;
        i++;
        continue;
      }
      if (c === '}') {
        depthBrace--;
        i++;
        continue;
      }
      if (c === ',' && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
        break;
      }
      i++;
    }

    const valueEnd = i;
    const valueText = text.slice(valueStart, valueEnd).trim();
    if (valueText.length > 0 || keyword) {
      const trimmedStart =
        valueStart + (text.slice(valueStart, valueEnd).match(/^\s*/)?.[0].length ?? 0);
      const nested = parseCallAt(text, trimmedStart);
      args.push({
        name: keyword,
        text: valueText,
        range: toRange(text, argStart, valueEnd),
        call: nested,
      });
    }

    if (i < end && text[i] === ',') {
      i++;
    }
    i = skipWhitespaceAndComments(text, i);
  }
  return args;
}

function positionToOffsetApprox(text: string, pos: vscode.Position): number {
  return positionToOffset(text, pos.line, pos.character);
}

function nameMatches(name: string, names: Set<string> | ((name: string) => boolean)): boolean {
  return typeof names === 'function' ? names(name) : names.has(name);
}

function scanCalls(
  text: string,
  names: Set<string> | ((name: string) => boolean),
  from: number,
  to: number,
  skipNested: boolean
): ParsedCall[] {
  const results: ParsedCall[] = [];
  const n = Math.min(to, text.length);
  let i = Math.max(0, from);
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'") {
      i = skipString(text, i);
      continue;
    }
    if (c === '#') {
      while (i < n && text[i] !== '\n') {
        i++;
      }
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const id = readIdentifier(text, i);
      if (id && nameMatches(id.name, names)) {
        const after = skipWhitespaceAndComments(text, id.end);
        if (after < n && text[after] === '(') {
          const call = parseCallAt(text, i);
          if (call) {
            results.push(call);
            i = skipNested ? positionToOffsetApprox(text, call.range.end) : id.end;
            continue;
          }
        }
      }
      i = id ? id.end : i + 1;
      continue;
    }
    i++;
  }
  return results;
}

/** Find all top-level-ish calls of given names in text. */
export function findCallsByName(text: string, names: Set<string>): ParsedCall[] {
  return scanCalls(text, names, 0, text.length, true);
}

/**
 * Find calls including nested ones (e.g. RandomListSelector inside another selector).
 * `names` may be a set or a predicate. Optional `[from, to)` limits the scan.
 */
export function findAllCallsByName(
  text: string,
  names: Set<string> | ((name: string) => boolean),
  from = 0,
  to = text.length
): ParsedCall[] {
  return scanCalls(text, names, from, to, false);
}

/** Extract second positional string argument from a call (event label name). */
export function secondPositionalString(call: ParsedCall): string | undefined {
  let positionalIndex = 0;
  for (const arg of call.args) {
    if (arg.name) {
      continue;
    }
    if (positionalIndex === 1) {
      const lit = readStringLiteral(arg.text, 0);
      return lit?.value;
    }
    positionalIndex++;
  }
  return undefined;
}

/** Walk all nested calls under a call tree. */
export function walkCalls(call: ParsedCall, visit: (c: ParsedCall) => void): void {
  visit(call);
  for (const arg of call.args) {
    if (arg.call) {
      walkCalls(arg.call, visit);
    }
  }
}
