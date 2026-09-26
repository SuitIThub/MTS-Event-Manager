import { skipString } from './scan';

/**
 * How a Ren'Py/Python script is laid out beyond single lines: which lines lie inside a
 * multi-line string (`headmaster """ … """`, strings spanning lines), where a statement
 * really ends (open brackets, strings, backslash continuations), and which block openers
 * (`if …:`, `label …:`, `menu:`) have no body.
 *
 * Every write of the editor is checked against this before it touches a file: an edit
 * must not open or close a string or bracket it did not own, and must not leave a block
 * empty — both would stop Ren'Py from loading the script.
 */

export interface CodeMap {
  /** Offset where each line starts. */
  lineStarts: number[];
  /** The line starts inside a string that opened on an earlier line. */
  inString: boolean[];
}

let mapText: string | undefined;
let mapCache: CodeMap | undefined;

export function codeMap(text: string): CodeMap {
  if (text === mapText && mapCache) {
    return mapCache;
  }
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lineStarts.push(i + 1);
    }
  }
  const inString = new Array<boolean>(lineStarts.length).fill(false);
  let line = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === '#') {
      while (i < n && text[i] !== '\n') {
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const end = skipString(text, i);
      // Every line that starts before the closing quote lies inside the string.
      while (line + 1 < lineStarts.length && lineStarts[line + 1] < end) {
        line++;
        inString[line] = true;
      }
      i = end;
      continue;
    }
    i++;
  }
  mapText = text;
  mapCache = { lineStarts, inString };
  return mapCache;
}

export function lineInsideString(text: string, line: number): boolean {
  return !!codeMap(text).inString[line];
}

/**
 * Last line of the statement that starts on `line`: follows open brackets, strings that
 * span lines and backslash continuations.
 */
export function statementEndLine(text: string, line: number): number {
  const { lineStarts } = codeMap(text);
  if (line < 0 || line >= lineStarts.length) {
    return line;
  }
  let i = lineStarts[line];
  let cur = line;
  let depth = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = skipString(text, i);
      while (cur + 1 < lineStarts.length && lineStarts[cur + 1] <= end - 1) {
        cur++;
      }
      i = end;
      continue;
    }
    if (c === '#') {
      while (i < n && text[i] !== '\n') {
        i++;
      }
      continue;
    }
    if (c === '\\' && (text[i + 1] === '\n' || (text[i + 1] === '\r' && text[i + 2] === '\n'))) {
      i += text[i + 1] === '\r' ? 3 : 2;
      cur++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth = Math.max(0, depth - 1);
    } else if (c === '\n') {
      if (depth === 0) {
        return cur;
      }
      cur++;
    }
    i++;
  }
  return cur;
}

function indentOf(row: string): number {
  let n = 0;
  for (const ch of row) {
    if (ch === ' ') {
      n++;
    } else if (ch === '\t') {
      n += 4;
    } else {
      break;
    }
  }
  return n;
}

interface Stmt {
  start: number;
  end: number;
  indent: number;
  opener: boolean;
}

/** Statements of the text (start/end line, indent, whether it opens a block with `:`). */
export function statements(text: string): Stmt[] {
  const { lineStarts, inString } = codeMap(text);
  const rows = text.split('\n');
  const out: Stmt[] = [];
  let line = 0;
  while (line < rows.length) {
    const row = rows[line];
    const t = row.trim();
    if (inString[line] || !t || t.startsWith('#')) {
      line++;
      continue;
    }
    const end = Math.max(line, statementEndLine(text, line));
    // Opens a block when its last code character (comments stripped) is ':'.
    const endRow = rows[end] ?? '';
    const code = stripTrailingComment(text, lineStarts[end] ?? 0, endRow).trimEnd();
    out.push({ start: line, end, indent: indentOf(row), opener: code.endsWith(':') && !code.endsWith('::') });
    line = end + 1;
  }
  return out;
}

/** The line without a trailing `# comment` (strings respected). */
function stripTrailingComment(text: string, start: number, row: string): string {
  let i = 0;
  while (i < row.length) {
    const c = row[i];
    if (c === '"' || c === "'") {
      const end = skipString(text, start + i) - start;
      if (end > row.length) {
        return row;
      }
      i = end;
      continue;
    }
    if (c === '#') {
      return row.slice(0, i);
    }
    i++;
  }
  return row;
}

/** Block openers (`if …:`, `label …:`, `menu:` …) without a single statement in their body. */
export function emptyBlocks(text: string): number[] {
  const stmts = statements(text);
  const out: number[] = [];
  stmts.forEach((s, k) => {
    if (!s.opener) {
      return;
    }
    const next = stmts[k + 1];
    if (!next || next.indent <= s.indent) {
      out.push(s.start);
    }
  });
  return out;
}

interface LexState {
  inString: boolean;
  depth: number;
}

/** String/bracket state of the text at `offset`. */
function stateAt(text: string, offset: number): LexState {
  let i = 0;
  let depth = 0;
  while (i < offset) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = skipString(text, i);
      if (end > offset) {
        return { inString: true, depth };
      }
      i = end;
      continue;
    }
    if (c === '#') {
      while (i < offset && text[i] !== '\n') {
        i++;
      }
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth = Math.max(0, depth - 1);
    }
    i++;
  }
  return { inString: false, depth };
}

export interface PlainEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * Structural safety of an edit set on `before`: every edit must leave the string/bracket
 * state after it exactly as it was (it may not open or close strings/brackets it didn't
 * own), and the edit may not leave any block without a body. Returns a reason or undefined.
 */
export function checkStructure(before: string, edits: readonly PlainEdit[]): string | undefined {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let after = before;
  for (const e of [...sorted].reverse()) {
    after = after.slice(0, e.start) + e.text + after.slice(e.end);
  }
  let delta = 0;
  for (const e of sorted) {
    const oldEnd = stateAt(before, e.end);
    const newEnd = stateAt(after, e.start + delta + e.text.length);
    if (oldEnd.inString !== newEnd.inString || oldEnd.depth !== newEnd.depth) {
      return 'The change would open or close a string or bracket — nothing was written.';
    }
    delta += e.text.length - (e.end - e.start);
  }
  const emptyBefore = emptyBlocks(before).length;
  const emptyAfter = emptyBlocks(after).length;
  if (emptyAfter > emptyBefore) {
    return 'The change would leave a block (if/else/label/menu) without any statement — nothing was written.';
  }
  return undefined;
}

// ── Ren'Py monologue mode ──────────────────────────────────────────────────────────────

export type MonologueMode = 'double' | 'single' | 'none';

/** One say statement the engine makes out of a triple-quoted string. */
export interface SayPart {
  /** Offsets of the part's text in the document (first to last non-blank character). */
  start: number;
  end: number;
  /** Line the part starts on. */
  line: number;
  /** As spoken: line breaks and their indentation collapsed to single spaces. */
  text: string;
}

const MONOLOGUE_RE = /^[ \t]*rpy[ \t]+monologue[ \t]+(double|single|none)\b/;

/** `rpy monologue double|single|none` in effect at `line` (the engine default is double). */
export function monologueMode(text: string, line: number): MonologueMode {
  const map = codeMap(text);
  let mode: MonologueMode = 'double';
  for (let l = 0; l < line && l < map.lineStarts.length; l++) {
    if (map.inString[l]) {
      continue;
    }
    const next = l + 1 < map.lineStarts.length ? map.lineStarts[l + 1] : text.length;
    const m = MONOLOGUE_RE.exec(text.slice(map.lineStarts[l], next));
    if (m) {
      mode = m[1] as MonologueMode;
    }
  }
  return mode;
}

/**
 * The say statements a triple-quoted dialogue string becomes (Ren'Py monologue mode): the
 * text is split at blank lines ("double", the default) or at every line break ("single");
 * "none" keeps one statement. Parts are stripped; empty parts are dropped. Returns
 * undefined when the literal at `quoteAt` is not triple-quoted.
 */
export function sayParts(text: string, quoteAt: number, mode?: MonologueMode): SayPart[] | undefined {
  const q = text[quoteAt];
  if ((q !== '"' && q !== "'") || text.slice(quoteAt, quoteAt + 3) !== q.repeat(3)) {
    return undefined;
  }
  // A raw string (r"""…""") is never split.
  const raw = quoteAt > 0 && /[rR]/.test(text[quoteAt - 1]) && !/[A-Za-z0-9_]/.test(text[quoteAt - 2] ?? '');
  const map = codeMap(text);
  const lineOf = (off: number): number => {
    let lo = 0;
    let hi = map.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (map.lineStarts[mid] <= off) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  };
  const mode2 = raw ? 'none' : mode ?? monologueMode(text, lineOf(quoteAt));
  const bodyStart = quoteAt + 3;
  const bodyEnd = skipString(text, quoteAt) - 3;
  // Lines of the body; a separator is a line holding nothing but whitespace.
  const rows: { start: number; end: number }[] = [];
  let s = bodyStart;
  for (let i = bodyStart; i <= bodyEnd; i++) {
    if (i === bodyEnd || text[i] === '\n') {
      rows.push({ start: s, end: i });
      s = i + 1;
    }
  }
  const groups: { start: number; end: number }[][] = [];
  let cur: { start: number; end: number }[] = [];
  for (const r of rows) {
    const blank = text.slice(r.start, r.end).trim() === '';
    if (mode2 === 'single' || (mode2 === 'double' && blank)) {
      if (cur.length) {
        groups.push(cur);
      }
      cur = [];
    }
    if (!blank) {
      cur.push(r);
    }
  }
  if (cur.length) {
    groups.push(cur);
  }
  return groups.map((g) => {
    let start = g[0].start;
    let end = g[g.length - 1].end;
    while (start < end && /\s/.test(text[start])) {
      start++;
    }
    while (end > start && /\s/.test(text[end - 1])) {
      end--;
    }
    return { start, end, line: lineOf(start), text: text.slice(start, end).replace(/\s*\n\s*/g, ' ') };
  });
}
