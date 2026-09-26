import { applyEdits, decodeValue, encodeString, insertArgEdit, parsePyCall, PyArg, PyCall, removeArgEdit, replaceValueEdit, TextEdit } from './pyCall';
import { emptyBlocks, lineInsideString, statementEndLine } from './codeStructure';

/**
 * Reads and surgically edits `paperdoll_manager.set_background(…)` /
 * `set_background_split(…)`: the image source(s) (`image[N]` step or a path), blur
 * (True / amount), blur_duration, black-and-white and the split separator. Only the
 * touched arguments change; every plan is re-parsed and verified.
 */

export type BgSource =
  | { kind: 'series'; variable: string; step: number }
  | { kind: 'path'; path: string }
  | { kind: 'other'; code: string };

export interface BgSpec {
  split: boolean;
  sources: BgSource[];
  /** False / True / amount — as written (True is the engine's 10.0). */
  blur: boolean | number;
  blurDuration: number;
  bw: boolean;
  bwLeft: boolean;
  bwRight: boolean;
  separator: number;
}

interface Parsed {
  call: PyCall;
  split: boolean;
  srcArgs: PyArg[];
  spec: BgSpec;
  /** Options passed positionally (not editable here). */
  positionalOptions: boolean;
}

const RE = /\bset_background(_split)?\s*\(/;

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

function sourceOf(arg: PyArg | undefined): BgSource {
  if (!arg) {
    return { kind: 'other', code: 'None' };
  }
  const v = arg.value.trim();
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*([0-9]+)\s*\]$/.exec(v);
  if (m) {
    return { kind: 'series', variable: m[1], step: Number(m[2]) };
  }
  const d = decodeValue(v);
  if (d.kind === 'string') {
    return { kind: 'path', path: d.value };
  }
  return { kind: 'other', code: v };
}

function num(arg: PyArg | undefined, fallback: number): number {
  if (!arg) {
    return fallback;
  }
  const n = Number(arg.value.trim());
  return Number.isFinite(n) ? n : fallback;
}

function flag(arg: PyArg | undefined): boolean {
  return arg?.value.trim() === 'True';
}

export function parseBackgroundCall(text: string, line: number): Parsed | undefined {
  const start = lineStart(text, line);
  if (start < 0) {
    return undefined;
  }
  const end = text.indexOf('\n', start);
  const row = text.slice(start, end < 0 ? text.length : end);
  const m = RE.exec(row);
  if (!m || /^\s*#/.test(row)) {
    return undefined;
  }
  const call = parsePyCall(text, start + m.index);
  if (!call) {
    return undefined;
  }
  const split = !!m[1];
  const pos = call.args.filter((a) => !a.name && !a.star);
  const nSrc = split ? 2 : 1;
  const kw = (n: string) => call.args.find((a) => a.name === n);
  const blurArg = kw('blur');
  const blurVal = blurArg ? blurArg.value.trim() : 'False';
  const blur: boolean | number = blurVal === 'True' ? true : blurVal === 'False' ? false : Number.isFinite(Number(blurVal)) ? Number(blurVal) : false;
  return {
    call,
    split,
    srcArgs: pos.slice(0, nSrc),
    positionalOptions: pos.length > nSrc,
    spec: {
      split,
      sources: Array.from({ length: nSrc }, (_, i) => sourceOf(pos[i])),
      blur,
      blurDuration: num(kw('blur_duration'), 0),
      bw: flag(kw('bw')),
      bwLeft: flag(kw('bw_left')),
      bwRight: flag(kw('bw_right')),
      separator: num(kw('separator_width'), 8),
    },
  };
}

function sourceCode(s: BgSource): string | undefined {
  if (s.kind === 'series') {
    return Number.isInteger(s.step) && s.step >= 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s.variable) ? `${s.variable}[${s.step}]` : undefined;
  }
  if (s.kind === 'path') {
    return encodeString(s.path);
  }
  return undefined;
}

function sameSpec(a: BgSpec, b: BgSpec): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Edit one set_background(_split) call towards `want` (unchanged parts stay byte-identical). */
export function planBackgroundEdit(text: string, line: number, want: BgSpec): { edits: TextEdit[]; text: string } | { error: string } {
  const p = parseBackgroundCall(text, line);
  if (!p) {
    return { error: 'No set_background(…) on that line anymore — nothing was changed.' };
  }
  if (want.split !== p.split || want.sources.length !== p.srcArgs.length) {
    return { error: 'Switching between a single and a split background is done in the code.' };
  }
  const blurCode = (b: boolean | number) => (b === true ? 'True' : b === false || b === 0 ? undefined : String(b));
  const optionTargets = (spec: BgSpec): [string, string | undefined][] =>
    p.split
      ? [
          ['blur', blurCode(spec.blur)],
          ['blur_duration', spec.blurDuration > 0 ? String(spec.blurDuration) : undefined],
          ['bw_left', spec.bwLeft ? 'True' : undefined],
          ['bw_right', spec.bwRight ? 'True' : undefined],
          ['separator_width', Math.round(spec.separator) !== 8 ? String(Math.round(spec.separator)) : undefined],
        ]
      : [
          ['blur', blurCode(spec.blur)],
          ['blur_duration', spec.blurDuration > 0 ? String(spec.blurDuration) : undefined],
          ['bw', spec.bw ? 'True' : undefined],
        ];
  const before = new Map(optionTargets(p.spec));
  const changed = optionTargets(want).filter(([name, v]) => before.get(name) !== v);
  if (changed.length && p.positionalOptions) {
    return { error: 'This call passes blur/options positionally — edit those in the code.' };
  }
  // One change at a time, re-parsing in between: neighbouring edits never overlap.
  let cur = text;
  const step = (fn: (c: Parsed) => TextEdit | undefined): string | undefined => {
    const c = parseBackgroundCall(cur, line);
    if (!c) {
      return 'The call stopped parsing while editing — nothing was written.';
    }
    const e = fn(c);
    if (e) {
      cur = applyEdits(cur, [e]);
    }
    return undefined;
  };
  for (let i = 0; i < want.sources.length; i++) {
    const s = want.sources[i];
    if (JSON.stringify(s) === JSON.stringify(p.spec.sources[i])) {
      continue;
    }
    const code = sourceCode(s);
    if (!code) {
      return { error: 'That image source cannot be written (a step is a whole number, a path a text).' };
    }
    const err = step((c) => replaceValueEdit(c.srcArgs[i], code));
    if (err) {
      return { error: err };
    }
  }
  for (const [name, value] of changed) {
    const err = step((c) => {
      const idx = c.call.args.findIndex((a) => a.name === name);
      if (idx >= 0) {
        // Switching blur off keeps an explicit `blur = False`; other defaults are removed.
        if (value === undefined) {
          return name === 'blur' ? replaceValueEdit(c.call.args[idx], 'False') : removeArgEdit(cur, c.call, idx);
        }
        return replaceValueEdit(c.call.args[idx], value);
      }
      if (value === undefined) {
        return undefined;
      }
      const star = c.call.args.findIndex((a) => a.star === '**');
      return insertArgEdit(cur, c.call, `${name} = ${value}`, star > 0 ? { keyword: true, afterIndex: star - 1 } : { keyword: true });
    });
    if (err) {
      return { error: err };
    }
  }
  if (cur === text) {
    return { edits: [], text };
  }
  const after = parseBackgroundCall(cur, line);
  const expected: BgSpec = {
    ...want,
    blur: want.blur === 0 ? false : want.blur,
    bw: p.split ? p.spec.bw : want.bw,
    bwLeft: p.split ? want.bwLeft : p.spec.bwLeft,
    bwRight: p.split ? want.bwRight : p.spec.bwRight,
    separator: p.split ? Math.round(want.separator) : p.spec.separator,
    blurDuration: want.blurDuration > 0 ? want.blurDuration : 0,
  };
  if (!after || !sameSpec(after.spec, expected) || cur.slice(0, p.call.start) !== text.slice(0, p.call.start) || cur.slice(after.call.close) !== text.slice(p.call.close)) {
    return { error: 'Verification failed — the background call would change otherwise. Nothing was written.' };
  }
  // One edit: the call's text (everything outside it is verified unchanged).
  const edit: TextEdit = { start: p.call.start, end: p.call.close + 1, text: cur.slice(p.call.start, after.call.close + 1) };
  return { edits: [edit], text: cur };
}

/**
 * Delete the statement that starts on `line` — all of its lines when it spans several.
 * If it is the only statement of its block (if/else/label/menu body), it is replaced by
 * `pass` at the same indent instead, so the script stays loadable.
 */
export function planDeleteStatement(text: string, line: number): { edits: TextEdit[]; text: string; replacedWithPass: boolean } {
  const first = lineStart(text, line);
  const endLine = statementEndLine(text, line);
  const after = lineStart(text, endLine + 1);
  const end = after < 0 ? text.length : after;
  const del: TextEdit = { start: first, end, text: '' };
  const deleted = applyEdits(text, [del]);
  if (emptyBlocks(deleted).length <= emptyBlocks(text).length) {
    return { edits: [del], text: deleted, replacedWithPass: false };
  }
  const indent = /^[ \t]*/.exec(text.slice(first))?.[0] ?? '';
  const eolMatch = /\r?\n$/.exec(text.slice(first, end));
  const pass: TextEdit = { start: first, end, text: indent + 'pass' + (eolMatch ? eolMatch[0] : '') };
  return { edits: [pass], text: applyEdits(text, [pass]), replacedWithPass: true };
}

/** Delete an image statement (image.show / show_image / show_video / show_pattern), all of its lines. */
export function planRemoveLine(text: string, line: number, isImageLine: (row: string) => boolean): { edits: TextEdit[]; text: string; replacedWithPass?: boolean } | { error: string } {
  const start = lineStart(text, line);
  if (start < 0) {
    return { error: 'The line no longer exists.' };
  }
  const nl = text.indexOf('\n', start);
  const row = text.slice(start, nl < 0 ? text.length : nl);
  if (lineInsideString(text, line) || !isImageLine(row)) {
    return { error: 'That line is not an image statement anymore — nothing was removed.' };
  }
  return planDeleteStatement(text, line);
}
