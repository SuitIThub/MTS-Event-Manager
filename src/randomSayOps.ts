import { applyEdits, decodeValue, encodeString, parsePyCall, PyCall, TextEdit } from './pyCall';

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
