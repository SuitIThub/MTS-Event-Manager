import { findMatching, skipString } from './scan';

/**
 * Exact, offset-based parser for Python call expressions, used for surgical edits.
 * Unlike callParser (ranges for navigation), every argument records where its keyword
 * name, its value and its trimmed end sit, so an edit can replace exactly one value,
 * or insert/remove one argument, and leave everything else — formatting, comments,
 * unrelated arguments — byte for byte untouched.
 */

export interface PyArg {
  /** Keyword name for `name = value` arguments. */
  name?: string;
  /** `*` / `**` unpacking prefix. */
  star?: '*' | '**';
  /** Start of the argument (keyword name, star or value). */
  start: number;
  valueStart: number;
  /** Exclusive end of the value, trimmed of whitespace and comments. */
  valueEnd: number;
  value: string;
  /** Set when the whole value is exactly one call expression. */
  call?: PyCall;
}

export interface PyCall {
  /** Callee as written, e.g. `Event` or `Person.get`. */
  callee: string;
  /** Last identifier of the callee (`Event`, `get`). */
  name: string;
  start: number;
  open: number;
  close: number;
  args: PyArg[];
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;

function readIdent(text: string, i: number): { name: string; end: number } | undefined {
  IDENT.lastIndex = i;
  const m = IDENT.exec(text);
  return m ? { name: m[0], end: i + m[0].length } : undefined;
}

function skipSpace(text: string, i: number, end: number): number {
  while (i < end) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
    } else if (c === '\\' && (text[i + 1] === '\n' || text[i + 1] === '\r')) {
      i += 2;
    } else if (c === '#') {
      while (i < end && text[i] !== '\n') {
        i++;
      }
    } else {
      break;
    }
  }
  return i;
}

/** Parse the call whose callee starts at `calleeStart`. Undefined if it isn't a call. */
export function parsePyCall(text: string, calleeStart: number): PyCall | undefined {
  let id = readIdent(text, calleeStart);
  if (!id) {
    return undefined;
  }
  let name = id.name;
  let i = id.end;
  while (text[i] === '.') {
    const next = readIdent(text, i + 1);
    if (!next) {
      break;
    }
    name = next.name;
    i = next.end;
    id = next;
  }
  const callee = text.slice(calleeStart, i);
  const open = skipSpace(text, i, text.length);
  if (text[open] !== '(') {
    return undefined;
  }
  const close = findMatching(text, open);
  if (close < 0) {
    return undefined;
  }
  return { callee, name, start: calleeStart, open, close, args: parseArgs(text, open + 1, close) };
}

function parseArgs(text: string, from: number, to: number): PyArg[] {
  const args: PyArg[] = [];
  let i = skipSpace(text, from, to);
  while (i < to) {
    const start = i;
    let star: PyArg['star'];
    if (text.startsWith('**', i)) {
      star = '**';
      i += 2;
    } else if (text[i] === '*') {
      star = '*';
      i += 1;
    }
    let name: string | undefined;
    if (!star) {
      const id = readIdent(text, i);
      if (id) {
        const after = skipSpace(text, id.end, to);
        if (text[after] === '=' && text[after + 1] !== '=') {
          name = id.name;
          i = skipSpace(text, after + 1, to);
        }
      }
    }
    const valueStart = skipSpace(text, i, to);
    // Scan the value up to the next top-level comma, tracking its last significant char.
    let j = valueStart;
    let last = valueStart - 1;
    while (j < to) {
      const c = text[j];
      if (c === ',') {
        break;
      }
      if (c === '#') {
        while (j < to && text[j] !== '\n') {
          j++;
        }
        continue;
      }
      if (c === '"' || c === "'") {
        const e = skipString(text, j);
        last = e - 1;
        j = e;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') {
        const e = findMatching(text, j);
        if (e < 0 || e >= to) {
          j = to;
          last = to - 1;
          break;
        }
        last = e;
        j = e + 1;
        continue;
      }
      if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n') {
        last = j;
      }
      j++;
    }
    const valueEnd = last + 1;
    const value = text.slice(valueStart, valueEnd);
    const arg: PyArg = { name, star, start, valueStart, valueEnd, value };
    if (!star) {
      const nested = parsePyCall(text, valueStart);
      if (nested && nested.close + 1 === valueEnd) {
        arg.call = nested;
      }
    }
    if (valueEnd > valueStart || name) {
      args.push(arg);
    }
    i = j < to && text[j] === ',' ? skipSpace(text, j + 1, to) : to;
  }
  return args;
}

// ── Value codec ────────────────────────────────────────────────────────────

export type ValueKind = 'string' | 'number' | 'bool' | 'none' | 'expr';

export interface DecodedValue {
  kind: ValueKind;
  /** Plain value for string/number/bool; the code itself for expr. */
  value: string;
  /** Quote character of a string literal. */
  quote?: '"' | "'";
}

/** Recognize simple literals; anything else is treated as a raw expression. */
export function decodeValue(code: string): DecodedValue {
  const t = code.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    return { kind: 'number', value: t };
  }
  if (t === 'True' || t === 'False') {
    return { kind: 'bool', value: t };
  }
  if (t === 'None') {
    return { kind: 'none', value: t };
  }
  const q = t[0];
  if ((q === '"' || q === "'") && t.length >= 2 && !t.startsWith(q.repeat(3)) && skipString(t, 0) === t.length) {
    return { kind: 'string', value: unescapeString(t.slice(1, -1)), quote: q };
  }
  return { kind: 'expr', value: t };
}

function unescapeString(body: string): string {
  return body.replace(/\\(["'\\n])/g, (_m, c: string) => (c === 'n' ? '\n' : c));
}

export function encodeString(value: string, quote: '"' | "'" = '"'): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .split(quote)
    .join('\\' + quote);
  return quote + escaped + quote;
}

/** Encode a typed field value back to Python code. */
export function encodeValue(kind: ValueKind, value: string, quote: '"' | "'" = '"'): string {
  switch (kind) {
    case 'string':
      return encodeString(value, quote);
    case 'number':
      return value.trim();
    case 'bool':
      return value.trim() === 'True' ? 'True' : 'False';
    case 'none':
      return 'None';
    default:
      return value.trim();
  }
}

/**
 * True when `code` is exactly one Python expression — balanced, closed strings, no
 * top-level comma, no keyword assignment. Guards every raw-code field the editor writes.
 */
export function isSingleExpression(code: string): boolean {
  const t = code.trim();
  if (!t || t.includes('\n#') || /^#/.test(t)) {
    return false;
  }
  const wrapped = `f(${t})`;
  const call = parsePyCall(wrapped, 0);
  if (!call || call.close !== wrapped.length - 1 || call.args.length !== 1) {
    return false;
  }
  const arg = call.args[0];
  return !arg.name && !arg.star && arg.value === t;
}

// ── Surgical edits ─────────────────────────────────────────────────────────

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k].end > sorted[k - 1].start) {
      throw new Error('Overlapping edits');
    }
  }
  let out = text;
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

function lineStartOf(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

function lineEndOf(text: string, offset: number): number {
  const nl = text.indexOf('\n', offset);
  return nl < 0 ? text.length : nl;
}

/** True when only whitespace precedes `offset` on its line. */
function startsLine(text: string, offset: number): boolean {
  return /^[ \t]*$/.test(text.slice(lineStartOf(text, offset), offset));
}

/** Arguments laid out one-per-line (vs. inline). */
export function isMultiline(text: string, call: PyCall): boolean {
  return call.args.some((a) => startsLine(text, a.start)) || text.slice(call.open, call.close).includes('\n');
}

function argIndent(text: string, call: PyCall): string {
  for (const a of call.args) {
    if (startsLine(text, a.start)) {
      return text.slice(lineStartOf(text, a.start), a.start);
    }
  }
  const base = /^[ \t]*/.exec(text.slice(lineStartOf(text, call.start)))?.[0] ?? '';
  return base + '    ';
}

/** Replace one argument's value (keeps its keyword name and surrounding layout). */
export function replaceValueEdit(arg: PyArg, code: string): TextEdit {
  return { start: arg.valueStart, end: arg.valueEnd, text: code };
}

/**
 * Remove argument `index` with its separating comma. In one-per-line layouts the whole
 * line goes, together with comment lines directly above it (they describe the argument).
 */
export function removeArgEdit(text: string, call: PyCall, index: number): TextEdit {
  const arg = call.args[index];
  const prev = call.args[index - 1];
  const next = call.args[index + 1];
  if (startsLine(text, arg.start)) {
    let from = lineStartOf(text, arg.start);
    // Attached comment lines directly above (no blank line in between).
    for (;;) {
      if (from === 0) {
        break;
      }
      const prevLineStart = lineStartOf(text, from - 1);
      const prevLine = text.slice(prevLineStart, from - 1);
      if (
        !/^[ \t]*#/.test(prevLine) ||
        prevLineStart <= call.open ||
        (prev && prevLineStart <= prev.valueEnd)
      ) {
        break;
      }
      from = prevLineStart;
    }
    // Through this argument's own line, including its trailing comma.
    let to = arg.valueEnd;
    const afterValue = skipInlineSpace(text, to);
    if (text[afterValue] === ',') {
      to = afterValue + 1;
    }
    const restOfLine = text.slice(to, lineEndOf(text, to));
    if (/^[ \t]*(#.*)?$/.test(restOfLine.replace(/\r$/, ''))) {
      to = Math.min(text.length, lineEndOf(text, to) + 1);
      return { start: from, end: to, text: '' };
    }
    // Something else follows on the same line (e.g. the closing paren): keep the line
    // break layout, only cut the argument and the comma that joined it to the previous one.
    if (!next && prev) {
      return { start: prev.valueEnd, end: arg.valueEnd, text: '' };
    }
    return { start: from, end: next ? next.start : to, text: '' };
  }
  if (next) {
    return { start: arg.start, end: next.start, text: '' };
  }
  if (prev) {
    return { start: prev.valueEnd, end: arg.valueEnd, text: '' };
  }
  return { start: call.open + 1, end: call.close, text: '' };
}

function skipInlineSpace(text: string, i: number): number {
  while (text[i] === ' ' || text[i] === '\t') {
    i++;
  }
  return i;
}

/**
 * Insert `code` as a new argument. Positional arguments always go before the first
 * keyword argument (Python requires it); `afterIndex` picks the exact slot among them.
 */
export function insertArgEdit(
  text: string,
  call: PyCall,
  code: string,
  opts: { keyword?: boolean; afterIndex?: number } = {}
): TextEdit {
  const multi = isMultiline(text, call);
  const indent = argIndent(text, call);
  const sep = multi ? `,\n${indent}` : ', ';
  const firstKeyword = call.args.findIndex((a) => !!a.name || a.star === '**');
  let anchor: number;
  if (opts.afterIndex !== undefined) {
    anchor = opts.afterIndex;
    if (!opts.keyword && firstKeyword >= 0 && anchor >= firstKeyword) {
      anchor = firstKeyword - 1;
    }
  } else if (opts.keyword || firstKeyword < 0) {
    anchor = call.args.length - 1;
  } else {
    anchor = firstKeyword - 1;
  }
  anchor = Math.min(anchor, call.args.length - 1);
  if (anchor < 0) {
    if (call.args.length === 0) {
      return { start: call.open + 1, end: call.open + 1, text: multi ? `\n${indent}${code}` : code };
    }
    const first = call.args[0];
    return { start: first.start, end: first.start, text: `${code}${sep}` };
  }
  const a = call.args[anchor];
  if (multi) {
    // Anchor ends its line with a comma (and maybe a comment): add a whole new line
    // below it, so a trailing comment stays with the argument it belongs to.
    const after = skipInlineSpace(text, a.valueEnd);
    if (text[after] === ',') {
      const eol = lineEndOf(text, after);
      if (/^[ \t]*(#.*)?\r?$/.test(text.slice(after + 1, eol)) && eol < call.close) {
        const pos = eol + 1;
        return { start: pos, end: pos, text: `${indent}${code},\n` };
      }
    }
  }
  return { start: a.valueEnd, end: a.valueEnd, text: `${sep}${code}` };
}

/** Python forbids positional arguments after keyword arguments. */
export function hasPositionalAfterKeyword(call: PyCall): boolean {
  let seenKeyword = false;
  for (const a of call.args) {
    if (a.name || a.star === '**') {
      seenKeyword = true;
    } else if (seenKeyword && a.star !== '*') {
      return true;
    }
  }
  return false;
}

/** Walk a call tree depth-first. */
export function walkPyCalls(call: PyCall, visit: (c: PyCall) => void): void {
  visit(call);
  for (const a of call.args) {
    if (a.call) {
      walkPyCalls(a.call, visit);
    }
  }
}
