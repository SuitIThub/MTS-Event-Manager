import { applyEdits, decodeValue, encodeString, insertArgEdit, isSingleExpression, parsePyCall, PyCall, removeArgEdit, replaceValueEdit, TextEdit } from './pyCall';
import { readStringLiteral } from './scan';

/**
 * Surgical, verified edits of `call change_stats_with_modifier(stat = VALUE, …)` and
 * `$ end_event("type", **kwargs)`: one keyword / the return type changes, nothing else —
 * not the `collection`, not a trailing `from _call_…`, not the layout of the other stats.
 */

export const MODIFIERS = ['TINY', 'SMALL', 'MEDIUM', 'LARGE', 'GIANT', 'DEC_TINY', 'DEC_SMALL', 'DEC_MEDIUM', 'DEC_LARGE', 'DEC_GIANT'];
export const END_TYPES = ['new_daytime', 'new_day', 'map_entry', 'map_overview', 'none'];

export type StatOp =
  | { op: 'set'; stat: string; value: string }
  | { op: 'add'; stat: string; value: string }
  | { op: 'remove'; stat: string };

export type Plan = { edits: TextEdit[]; text: string } | { error: string };

function lineOffset(text: string, line: number): number {
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

function callOnLine(text: string, line: number, name: string): PyCall | undefined {
  const start = lineOffset(text, line);
  if (start < 0) {
    return undefined;
  }
  const end = text.indexOf('\n', start);
  const row = text.slice(start, end < 0 ? text.length : end);
  const m = new RegExp(`\\b${name}\\s*\\(`).exec(row);
  if (!m || /^\s*#/.test(row)) {
    return undefined;
  }
  return parsePyCall(text, start + m.index);
}

function statsOf(call: PyCall): string {
  return call.args.filter((a) => a.name && a.name !== 'collection').map((a) => `${a.name}=${a.value.trim()}`).join('|');
}

/** Check the edit: re-parse, expected stats, same collection, text outside the call unchanged. */
function verify(text: string, call: PyCall, planned: string, name: string, expectStats: string): string | undefined {
  const after = parsePyCall(planned, call.start);
  if (!after || after.name !== name) {
    return 'Verification failed: the call no longer parses. Nothing was written.';
  }
  if (statsOf(after) !== expectStats) {
    return 'Verification failed: unexpected stat arguments. Nothing was written.';
  }
  const coll = (c: PyCall) => c.args.find((a) => a.name === 'collection')?.value.trim() ?? '';
  if (coll(after) !== coll(call)) {
    return 'Verification failed: the collection would change. Nothing was written.';
  }
  if (planned.slice(0, call.start) !== text.slice(0, call.start) || planned.slice(after.close) !== text.slice(call.close)) {
    return 'Verification failed: text outside the call would change. Nothing was written.';
  }
  return undefined;
}

export function planStatOp(text: string, line: number, op: StatOp): Plan {
  const name = 'change_stats_with_modifier';
  const call = callOnLine(text, line, name);
  if (!call) {
    return { error: 'No change_stats_with_modifier(…) call on that line anymore — nothing was changed.' };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(op.stat) || op.stat === 'collection') {
    return { error: `"${op.stat}" is not a valid stat name.` };
  }
  if (op.op !== 'remove' && (!op.value.trim() || !isSingleExpression(op.value.trim()))) {
    return { error: 'The value must be a modifier (SMALL, DEC_TINY, …) or a single expression.' };
  }
  const stats = call.args.filter((a) => a.name && a.name !== 'collection');
  const idx = call.args.findIndex((a) => a.name === op.stat);
  const expected = stats.map((a) => ({ stat: a.name!, value: a.value.trim() }));
  let edit: TextEdit;
  if (op.op === 'set') {
    if (idx < 0) {
      return { error: `${op.stat} is not part of this call.` };
    }
    edit = replaceValueEdit(call.args[idx], op.value.trim());
    expected.find((s) => s.stat === op.stat)!.value = op.value.trim();
  } else if (op.op === 'add') {
    if (idx >= 0) {
      return { error: `${op.stat} is already changed by this call.` };
    }
    edit = insertArgEdit(text, call, `${op.stat} = ${op.value.trim()}`, { keyword: true });
    expected.push({ stat: op.stat, value: op.value.trim() });
  } else {
    if (idx < 0) {
      return { error: `${op.stat} is not part of this call.` };
    }
    if (stats.length <= 1) {
      return { error: 'This is the only stat of the call — remove the whole statement instead.' };
    }
    edit = removeArgEdit(text, call, idx);
    expected.splice(expected.findIndex((s) => s.stat === op.stat), 1);
  }
  const planned = applyEdits(text, [edit]);
  const err = verify(text, call, planned, name, expected.map((s) => `${s.stat}=${s.value}`).join('|'));
  return err ? { error: err } : { edits: [edit], text: planned };
}

/** Set the return type of `end_event(...)` (inserted before **kwargs when absent). */
export function planEndType(text: string, line: number, endType: string): Plan {
  const call = callOnLine(text, line, 'end_event');
  if (!call) {
    return { error: 'No end_event(…) on that line anymore — nothing was changed.' };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(endType)) {
    return { error: `"${endType}" is not a valid return type.` };
  }
  const first = call.args.find((a) => !a.name && !a.star);
  // Keep the file's quote style ('new_daytime' stays single-quoted).
  const quote = first ? decodeValue(first.value).quote : undefined;
  const code = encodeString(endType, quote === "'" ? "'" : '"');
  const edit = first ? replaceValueEdit(first, code) : insertArgEdit(text, call, code);
  const planned = applyEdits(text, [edit]);
  const after = parsePyCall(planned, call.start);
  const got = after?.args.find((a) => !a.name && !a.star);
  const value = got ? readStringLiteral(got.value, 0)?.value : undefined;
  const others = (c: PyCall) => c.args.filter((a) => a !== c.args.find((x) => !x.name && !x.star)).map((a) => (a.star ?? '') + (a.name ?? '') + '=' + a.value.trim()).join('|');
  if (!after || value !== endType || others(after) !== others(call) || planned.slice(0, call.start) !== text.slice(0, call.start) || planned.slice(after.close) !== text.slice(call.close)) {
    return { error: 'Verification failed: end_event would change otherwise. Nothing was written.' };
  }
  return { edits: [edit], text: planned };
}
