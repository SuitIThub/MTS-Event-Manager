import { applyEdits, decodeValue, encodeString, parsePyCall, PyCall, TextEdit } from './pyCall';
import { readStringLiteral } from './scan';
import { lineInsideString, sayParts, SayPart } from './codeStructure';
import { chainBounds, isSayLine } from './lineTools';

/**
 * Edits the spoken text of ONE alternative of `random_say(…)` — a plain string, a tuple
 * (text, condition, step, speaker…) or a weighted `(0.7, …)` entry. Only that string
 * literal changes (same quote style); conditions, weights, steps, speakers and the other
 * alternatives stay byte-identical. Verified by re-parsing.
 */

function lineStart(text: string, line: number): number {
  let off = 0;
  for (let i = 0; i < line; i++) {
    const nl = text.indexOf('\n', off);
    if (nl < 0) {
      return -1;
    }
    off = nl + 1;
  }
  return off;
}

function randomSayAt(text: string, line: number): PyCall | undefined {
  const start = lineStart(text, line);
  if (start < 0) {
    return undefined;
  }
  const nl = text.indexOf('\n', start);
  const row = text.slice(start, nl < 0 ? text.length : nl);
  const m = /\brandom_say\s*\(/.exec(row);
  if (!m || /^\s*#/.test(row)) {
    return undefined;
  }
  return parsePyCall(text, start + m.index);
}

/** Absolute [start, end) of the alternative's text literal inside `code` placed at `base`. */
function textLiteral(code: string, base: number): { start: number; end: number; quote: '"' | "'" } | undefined {
  const trimmedLead = code.length - code.trimStart().length;
  const t = code.trim();
  const d = decodeValue(t);
  if (d.kind === 'string') {
    if (/^[rbuf]/i.test(t) || t.startsWith('"""') || t.startsWith("'''")) {
      return undefined;
    }
    return { start: base + trimmedLead, end: base + trimmedLead + t.length, quote: t[0] === "'" ? "'" : '"' };
  }
  if (!t.startsWith('(')) {
    return undefined;
  }
  // Parse the tuple as the arguments of a synthetic call "f(...)".
  const tuple = parsePyCall('f' + t, 0);
  if (!tuple) {
    return undefined;
  }
  const elems = tuple.args;
  const at = (i: number) => base + trimmedLead + elems[i].valueStart - 1;
  if (elems.length === 2 && /^[0-9]*\.[0-9]+$/.test(elems[0].value.trim())) {
    return textLiteral(elems[1].value, at(1)); // weighted: (0.7, alternative)
  }
  const strings = elems.map((e, i) => ({ e, i })).filter(({ e }) => decodeValue(e.value.trim()).kind === 'string');
  if (strings.length !== 1) {
    return undefined;
  }
  return textLiteral(strings[0].e.value, at(strings[0].i));
}

function texts(text: string, call: PyCall): string[] {
  return call.args.map((a) => {
    const lit = textLiteral(a.value, a.valueStart);
    return lit ? decodeValue(text.slice(lit.start, lit.end)).value : '';
  });
}

export function planRandomSayText(text: string, line: number, argIndex: number, newText: string): { edits: TextEdit[]; text: string } | { error: string } {
  const call = randomSayAt(text, line);
  if (!call) {
    return { error: 'No random_say(…) on that line anymore — nothing was changed.' };
  }
  const arg = call.args[argIndex];
  if (!arg || arg.name || arg.star) {
    return { error: 'That alternative no longer exists — the view was out of date.' };
  }
  const lit = textLiteral(arg.value, arg.valueStart);
  if (!lit) {
    return { error: 'This alternative is not a plain text (or has several strings) — edit it in the code.' };
  }
  if (newText.includes('\n')) {
    return { error: 'Dialogue text is one line.' };
  }
  const edit: TextEdit = { start: lit.start, end: lit.end, text: encodeString(newText, lit.quote) };
  const planned = applyEdits(text, [edit]);
  const after = parsePyCall(planned, call.start);
  if (!after || after.args.length !== call.args.length) {
    return { error: 'Verification failed — random_say would no longer parse. Nothing was written.' };
  }
  const before = texts(text, call);
  const now = texts(planned, after);
  const expected = before.map((t, i) => (i === argIndex ? newText : t));
  const others = (c: PyCall, src: string) => c.args.map((a, i) => (i === argIndex ? '' : src.slice(a.start, a.valueEnd))).join('|');
  if (now.join('\u0000') !== expected.join('\u0000') || others(after, planned) !== others(call, text) || planned.slice(0, call.start) !== text.slice(0, call.start) || planned.slice(after.close) !== text.slice(call.close)) {
    return { error: 'Verification failed — random_say would change otherwise. Nothing was written.' };
  }
  return { edits: [edit], text: planned };
}

/** The say statement's text literal on `line` (speaker line or bare narration). */
function sayLiteralAt(text: string, line: number): { start: number; end: number; parts?: SayPart[] } | { error: string } {
  const start0 = lineStart(text, line);
  if (start0 < 0 || lineInsideString(text, line)) {
    return { error: 'That line is not a dialogue statement — nothing was changed.' };
  }
  const nl = text.indexOf('\n', start0);
  const row = text.slice(start0, nl < 0 ? text.length : nl).replace(/\r$/, '');
  let rel: number;
  if (/^[ \t]*["']/.test(row)) {
    rel = row.search(/["']/);
  } else {
    if (!isSayLine(row)) {
      return { error: 'That line is not a dialogue statement — nothing was changed.' };
    }
    const bounds = chainBounds(row);
    const r = bounds ? row.slice(bounds.end).search(/["']/) : -1;
    if (!bounds || r < 0) {
      return { error: 'No dialogue text found on that line.' };
    }
    rel = bounds.end + r;
  }
  const start = start0 + rel;
  const lit = readStringLiteral(text, start);
  if (!lit) {
    return { error: 'The dialogue text could not be read — change it in the code.' };
  }
  return { start, end: lit.end, parts: sayParts(text, start) };
}

const decodeRaw = (raw: string) => raw.replace(/\\([\s\S])/g, '$1');

/**
 * Replace the spoken text of the say statement on `line` (`luna.say "…"`), keeping its quote
 * style. A triple-quoted string is several say statements in Ren'Py (monologue mode, split
 * at blank lines): then only part `part` is replaced and the others stay byte-identical.
 * `expect` (the part's current text) guards against a stale view.
 */
export function planSayText(
  text: string,
  line: number,
  newText: string,
  part?: number,
  expect?: string
): { edits: TextEdit[]; text: string } | { error: string } {
  const at = sayLiteralAt(text, line);
  if ('error' in at) {
    return at;
  }
  const { start } = at;
  const quote = text[start] as '"' | "'";
  if (at.parts && at.parts.length) {
    const parts = at.parts;
    const idx = part ?? 0;
    if ((part === undefined && parts.length > 1) || idx < 0 || idx >= parts.length) {
      return { error: 'This monologue changed — reopen the line and try again. Nothing was written.' };
    }
    const p = parts[idx];
    if (expect !== undefined && p.text !== expect) {
      return { error: 'The text changed in the meantime — nothing was written.' };
    }
    // One part stays one part: line breaks become spaces (as Ren'Py shows them anyway).
    const want = newText.replace(/\s*\n\s*/g, ' ').trim();
    if (!want) {
      return { error: 'Empty text — use 🗑 to delete the line instead.' };
    }
    let body = want.split('\\').join('\\\\').split(quote.repeat(3)).join('\\' + quote.repeat(3));
    // A quote at either edge could merge with the string's own quotes.
    if (body.endsWith(quote)) {
      body = body.slice(0, -1) + '\\' + quote;
    }
    if (body.startsWith(quote)) {
      body = '\\' + body;
    }
    const edit: TextEdit = { start: p.start, end: p.end, text: body };
    const planned = applyEdits(text, [edit]);
    const lit = readStringLiteral(planned, start);
    const after = sayParts(planned, start);
    const delta = body.length - (p.end - p.start);
    const ok =
      !!lit && lit.end === at.end + delta && !!after && after.length === parts.length &&
      after.every((q, i) => (i === idx ? decodeRaw(q.text) === want : q.text === parts[i].text));
    if (!ok) {
      return { error: 'Verification failed — the monologue would change otherwise. Nothing was written.' };
    }
    return { edits: [edit], text: planned };
  }
  if (part !== undefined && part > 0) {
    return { error: 'This line is no longer a monologue — nothing was written.' };
  }
  // Every backslash and every closing-quote hazard is escaped; decoding must give the text back.
  const body = newText.split('\\').join('\\\\').split(quote).join('\\' + quote);
  const code = quote + body + quote;
  const edit: TextEdit = { start, end: at.end, text: code };
  const planned = applyEdits(text, [edit]);
  const check = readStringLiteral(planned, start);
  const got = check && check.end === start + code.length ? decodeRaw(check.value) : undefined;
  if (got !== newText || planned.slice(0, start) !== text.slice(0, start) || planned.slice(start + code.length) !== text.slice(at.end)) {
    return { error: 'Verification failed — the dialogue would change otherwise. Nothing was written.' };
  }
  return { edits: [edit], text: planned };
}

/**
 * Delete one part of a multi-part monologue (with the blank line that separates it); the
 * statement and the other parts stay. Undefined when the statement has fewer than two
 * parts — then the whole statement is deleted as usual.
 */
export function planDeleteSayPart(
  text: string,
  line: number,
  part: number,
  expect?: string
): { edits: TextEdit[]; text: string } | { error: string } | undefined {
  const at = sayLiteralAt(text, line);
  if ('error' in at) {
    return at;
  }
  const parts = at.parts;
  if (!parts || parts.length < 2) {
    return undefined;
  }
  const p = parts[part];
  if (!p || (expect !== undefined && p.text !== expect)) {
    return { error: 'The text changed in the meantime — nothing was deleted.' };
  }
  // From this part to the next one's first character (or from the previous part's end).
  const edit: TextEdit = part < parts.length - 1 ? { start: p.start, end: parts[part + 1].start, text: '' } : { start: parts[part - 1].end, end: p.end, text: '' };
  const planned = applyEdits(text, [edit]);
  const after = sayParts(planned, at.start);
  const want = parts.filter((_, i) => i !== part).map((q) => q.text);
  if (!after || after.map((q) => q.text).join('\u0000') !== want.join('\u0000') || readStringLiteral(planned, at.start)?.end !== at.end - (edit.end - edit.start)) {
    return { error: 'Verification failed — the monologue would change otherwise. Nothing was deleted.' };
  }
  return { edits: [edit], text: planned };
}
