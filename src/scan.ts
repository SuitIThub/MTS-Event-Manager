/**
 * Find matching closing paren/bracket/brace. `openIndex` points at the opening char.
 */
export function findMatching(text: string, openIndex: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const open = text[openIndex];
  const close = pairs[open];
  if (!close) {
    return -1;
  }
  const stack: string[] = [close];
  let i = openIndex + 1;
  const n = text.length;
  while (i < n && stack.length > 0) {
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
    if (c in pairs) {
      stack.push(pairs[c]);
      i++;
      continue;
    }
    if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) {
        return i;
      }
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

export function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

export function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

export function skipWhitespaceAndComments(text: string, i: number): number {
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < n && text[i] !== '\n') {
        i++;
      }
      continue;
    }
    break;
  }
  return i;
}

/** Advance past a Python string starting at i (must point at quote). */
export function skipString(text: string, i: number): number {
  const n = text.length;
  const quote = text[i];
  if (quote !== '"' && quote !== "'") {
    return i;
  }
  if (text.slice(i, i + 3) === quote.repeat(3)) {
    i += 3;
    while (i < n) {
      if (text.slice(i, i + 3) === quote.repeat(3)) {
        return i + 3;
      }
      if (text[i] === '\\') {
        i += 2;
        continue;
      }
      i++;
    }
    return n;
  }
  i++;
  while (i < n) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) {
      return i + 1;
    }
    i++;
  }
  return n;
}

export function offsetToPosition(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lastNl = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      lastNl = i;
    }
  }
  return { line, character: offset - lastNl - 1 };
}

export function positionToOffset(text: string, line: number, character: number): number {
  let currentLine = 0;
  let i = 0;
  while (i < text.length && currentLine < line) {
    if (text[i] === '\n') {
      currentLine++;
    }
    i++;
  }
  return Math.min(i + character, text.length);
}

export function readIdentifier(text: string, i: number): { name: string; end: number } | undefined {
  if (i >= text.length || !isIdentStart(text[i])) {
    return undefined;
  }
  let j = i + 1;
  while (j < text.length && isIdentChar(text[j])) {
    j++;
  }
  return { name: text.slice(i, j), end: j };
}

export function readStringLiteral(
  text: string,
  i: number
): { value: string; end: number } | undefined {
  i = skipWhitespaceAndComments(text, i);
  if (i >= text.length) {
    return undefined;
  }
  const quote = text[i];
  if (quote !== '"' && quote !== "'") {
    return undefined;
  }
  const start = i;
  const end = skipString(text, i);
  if (end <= start + 1) {
    return undefined;
  }
  if (text.slice(start, start + 3) === quote.repeat(3)) {
    return { value: text.slice(start + 3, end - 3), end };
  }
  return { value: text.slice(start + 1, end - 1), end };
}
