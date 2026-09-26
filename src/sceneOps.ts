import { findEventDefs } from './eventDef';
import {
  applyEdits,
  encodeString,
  insertArgEdit,
  parsePyCall,
  PyCall,
  removeArgEdit,
  TextEdit,
} from './pyCall';
import { findMatching, positionToOffset, skipString, lineStartsOf } from './scan';

/**
 * Pure, verified scene-composition operations on Ren'Py label bodies: moving statements,
 * adding menu choices with their branch sublabels, and creating new events. Like the
 * definition editor, each planner simulates its edit and re-checks the result; callers
 * only ever write text that passed these checks.
 */

// ── Lines & labels ─────────────────────────────────────────────────────────

const LABEL_LINE = /^([ \t]*)label[ \t]+(\.?)([A-Za-z0-9_]+)/;

export interface LabelInfo {
  line: number;
  name: string;
  local: string;
  isSub: boolean;
}

/** Labels with fully-qualified names (sublabels become `parent.sub`). */
export function scanLabels(lines: readonly string[]): LabelInfo[] {
  const out: LabelInfo[] = [];
  let parent = '';
  lines.forEach((row, line) => {
    const m = LABEL_LINE.exec(row);
    if (!m) {
      return;
    }
    const isSub = m[2] === '.';
    if (!isSub) {
      parent = m[3];
    }
    out.push({ line, name: isSub ? `${parent}.${m[3]}` : m[3], local: m[3], isSub });
  });
  return out;
}

/** Line range [start, end) of the top-level label containing `line`, sublabels included. */
export function topLevelSpan(lines: readonly string[], line: number): { start: number; end: number; name: string } | undefined {
  const tops = scanLabels(lines).filter((l) => !l.isSub);
  let found: LabelInfo | undefined;
  let next = lines.length;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i].line <= line) {
      found = tops[i];
      next = i + 1 < tops.length ? tops[i + 1].line : lines.length;
    }
  }
  return found ? { start: found.line, end: next, name: found.name } : undefined;
}

function indentOf(row: string): number {
  return /^[ \t]*/.exec(row)?.[0].length ?? 0;
}

function isBlankOrComment(row: string): boolean {
  const t = row.trim();
  return t === '' || t.startsWith('#');
}

// ── Logical statements ─────────────────────────────────────────────────────

export interface Statement {
  /** First and last line (inclusive) of the logical line (bracket continuations joined). */
  start: number;
  end: number;
  indent: number;
}

/** Logical statements in [from, to), skipping blank and comment-only lines. */
export function logicalStatements(text: string, lines: readonly string[], from: number, to: number): Statement[] {
  const out: Statement[] = [];
  // Line offsets once per call (not a cache lookup per line — see lineStartsOf).
  const starts = lineStartsOf(text);
  let line = from;
  while (line < to) {
    if (isBlankOrComment(lines[line] ?? '')) {
      line++;
      continue;
    }
    const end = logicalEnd(text, line, line < starts.length ? starts[line] : text.length);
    out.push({ start: line, end: Math.min(end, to - 1), indent: indentOf(lines[line]) });
    line = Math.max(end, line) + 1;
  }
  return out;
}

/** Last line of the logical line starting at `line` (open brackets span lines). */
function logicalEnd(text: string, line: number, lineStart: number): number {
  let i = lineStart;
  let endLine = line;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\n') {
      return endLine;
    }
    if (c === '#') {
      while (i < n && text[i] !== '\n') {
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const e = skipString(text, i);
      endLine += countNewlines(text, i, e);
      i = e;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      const e = findMatching(text, i);
      if (e < 0) {
        return endLine;
      }
      endLine += countNewlines(text, i, e);
      i = e + 1;
      continue;
    }
    i++;
  }
  return endLine;
}

function countNewlines(text: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) {
    if (text.charCodeAt(i) === 10) {
      n++;
    }
  }
  return n;
}

/** A movable unit: a statement, its nested body, and comment lines directly above it. */
interface Unit {
  first: number; // first line incl. attached comments
  start: number; // statement line
  end: number; // last line incl. nested body
  indent: number;
}

function unitFor(lines: readonly string[], stmts: Statement[], idx: number): Unit {
  const s = stmts[idx];
  let end = s.end;
  for (let k = idx + 1; k < stmts.length && stmts[k].indent > s.indent; k++) {
    end = stmts[k].end;
  }
  let first = s.start;
  while (first - 1 >= 0 && /^[ \t]*#/.test(lines[first - 1] ?? '') && indentOf(lines[first - 1]) === s.indent) {
    first--;
  }
  return { first, start: s.start, end, indent: s.indent };
}

export type MoveResult = { edits: TextEdit[]; newText: string; newLine: number } | { error: string };

/**
 * Move the statement at `line` one sibling up (-1) or down (+1) within its block.
 * Never crosses a label, a dedent or a compound statement's body boundary.
 */
export function planMoveStatement(text: string, line: number, direction: -1 | 1): MoveResult {
  const lines = text.split('\n');
  const span = topLevelSpan(lines, line);
  if (!span) {
    return { error: 'That line is not inside a label.' };
  }
  const stmts = logicalStatements(text, lines, span.start, span.end);
  const idx = stmts.findIndex((s) => s.start <= line && line <= s.end);
  if (idx < 0) {
    return { error: 'No statement at that line.' };
  }
  if (LABEL_LINE.test(lines[stmts[idx].start])) {
    return { error: 'Labels cannot be moved.' };
  }
  const me = unitFor(lines, stmts, idx);
  // Find the sibling unit in the requested direction.
  let sibIdx = -1;
  if (direction < 0) {
    for (let k = idx - 1; k >= 0; k--) {
      if (stmts[k].indent < me.indent) {
        break;
      }
      if (stmts[k].indent === me.indent) {
        sibIdx = k;
        break;
      }
    }
  } else {
    let k = idx + 1;
    while (k < stmts.length && stmts[k].indent > me.indent) {
      k++;
    }
    if (k < stmts.length && stmts[k].indent === me.indent) {
      sibIdx = k;
    }
  }
  if (sibIdx < 0 || LABEL_LINE.test(lines[stmts[sibIdx].start])) {
    return { error: direction < 0 ? 'Already the first statement of its block.' : 'Already the last statement of its block.' };
  }
  const sib = unitFor(lines, stmts, sibIdx);
  const upper = direction < 0 ? sib : me;
  const lower = direction < 0 ? me : sib;
  const upperText = lines.slice(upper.first, upper.end + 1);
  const gap = lines.slice(upper.end + 1, lower.first);
  const lowerText = lines.slice(lower.first, lower.end + 1);
  const replaced = [...lowerText, ...gap, ...upperText];
  const start = positionToOffset(text, upper.first, 0);
  const endLine = lower.end;
  const end = endLine + 1 < lines.length ? positionToOffset(text, endLine + 1, 0) - 1 : text.length;
  const edits: TextEdit[] = [{ start, end, text: replaced.join('\n') }];
  const newText = applyEdits(text, edits);
  // Verify: everything outside the swapped region is identical, the region holds the same
  // multiset of lines, and no label moved (labels outside the region cannot have moved).
  const newLines = newText.split('\n');
  const regionFrom = upper.first;
  const regionTo = lower.end + 1;
  const sameOutside =
    newLines.length === lines.length &&
    newText.slice(0, start) === text.slice(0, start) &&
    newText.slice(newText.length - (text.length - end)) === text.slice(end);
  const regionBefore = lines.slice(regionFrom, regionTo);
  const regionAfter = newLines.slice(regionFrom, regionTo);
  if (!sameOutside || [...regionAfter].sort().join('\n') !== [...regionBefore].sort().join('\n')) {
    return { error: 'The move would change more than the order of statements.' };
  }
  const labelsIn = (rows: string[]) => scanLabels(rows).map((l) => `${l.line}:${l.name}`).join('|');
  if (labelsIn(regionBefore) !== labelsIn(regionAfter)) {
    return { error: 'The move would shift a label.' };
  }
  const offsetInUnit = line - me.first;
  const newFirst = direction < 0 ? upper.first : upper.first + lowerText.length + gap.length;
  return { edits, newText, newLine: newFirst + offsetInUnit };
}

// ── Menu choices ───────────────────────────────────────────────────────────

const MENU_NAMES = new Set(['call_custom_menu', 'call_custom_menu_with_text']);

/**
 * The content custom-menu call starting on `line`. Menus that build their choices at
 * runtime (`*elements` unpacking, as in the engine's own helpers) are not editable.
 */
export function menuCallAt(text: string, line: number): PyCall | undefined {
  const lines = text.split('\n');
  const row = lines[line] ?? '';
  const m = /call_custom_menu(?:_with_text)?\s*\(/.exec(row);
  if (!m) {
    return undefined;
  }
  const call = parsePyCall(text, positionToOffset(text, line, m.index));
  if (!call || !MENU_NAMES.has(call.name) || call.args.some((a) => a.star === '*')) {
    return undefined;
  }
  return call;
}

function decisionKeys(text: string, menu: PyCall): string[] {
  return menu.args
    .filter((a) => a.call?.name === 'MenuElement')
    .map((a) => {
      const first = a.call!.args.find((x) => !x.name && !x.star);
      return first ? first.value.replace(/^['"]|['"]$/g, '') : '';
    });
}

export type PlanResult = { edits: TextEdit[]; newText: string; notes: string[] } | { error: string };

/**
 * Add a choice to the custom menu on `menuLine`: `MenuElement("key", "title",
 * EventEffect("event.key"))`, plus a branch sublabel skeleton when it does not exist yet.
 */
export function planAddMenuChoice(text: string, menuLine: number, key: string, title: string): PlanResult {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return { error: 'The decision key must be an identifier (letters, digits, underscore).' };
  }
  const lines = text.split('\n');
  const menu = menuCallAt(text, menuLine);
  if (!menu) {
    return { error: 'No custom menu on that line anymore. Refresh and try again.' };
  }
  const span = topLevelSpan(lines, menuLine);
  if (!span) {
    return { error: 'The menu is not inside a label.' };
  }
  const keys = decisionKeys(text, menu);
  if (keys.includes(key)) {
    return { error: `The decision key "${key}" is already used in this menu (keys must be unique for replay).` };
  }
  const target = `${span.name}.${key}`;
  const element = `MenuElement(${encodeString(key)}, ${encodeString(title || key)}, EventEffect(${encodeString(target)}))`;
  const lastElement = menu.args.map((a, i) => (a.call?.name === 'MenuElement' ? i : -1)).filter((i) => i >= 0).pop();
  const edits: TextEdit[] = [insertArgEdit(text, menu, element, { afterIndex: lastElement })];
  const notes: string[] = [];
  const existing = scanLabels(lines).find((l) => l.name === target);
  if (!existing) {
    edits.push(sublabelEdit(text, lines, span, key, indentOf(lines[span.start])));
    notes.push(`Created branch label .${key}.`);
  }
  const newText = applyEdits(text, edits);
  // Verify: menu parses at the same place with exactly one more element; target exists once.
  const after = parsePyCall(newText, menu.start);
  if (!after || decisionKeys(newText, after).length !== keys.length + 1 || !decisionKeys(newText, after).includes(key)) {
    return { error: 'Adding the choice would not leave a valid menu.' };
  }
  const newLabels = scanLabels(newText.split('\n')).filter((l) => l.name === target);
  if (newLabels.length !== 1) {
    return { error: 'The branch label would not be unique.' };
  }
  return { edits, newText, notes };
}

/** Remove choice `index` (MenuElement order) from the menu. The branch label is kept. */
export function planRemoveMenuChoice(text: string, menuLine: number, index: number, expectKey: string): PlanResult {
  const menu = menuCallAt(text, menuLine);
  if (!menu) {
    return { error: 'No custom menu on that line anymore. Refresh and try again.' };
  }
  const elementIdx = menu.args.map((a, i) => (a.call?.name === 'MenuElement' ? i : -1)).filter((i) => i >= 0);
  const argIndex = elementIdx[index];
  const keys = decisionKeys(text, menu);
  if (argIndex === undefined || keys[index] !== expectKey) {
    return { error: 'The menu changed since the editor loaded it. Refresh and try again.' };
  }
  if (elementIdx.length <= 1) {
    return { error: 'A menu needs at least one choice.' };
  }
  const edits = [removeArgEdit(text, menu, argIndex)];
  const newText = applyEdits(text, edits);
  const after = parsePyCall(newText, menu.start);
  if (!after || decisionKeys(newText, after).length !== keys.length - 1) {
    return { error: 'Removing the choice would not leave a valid menu.' };
  }
  return { edits, newText, notes: [`The branch label for "${expectKey}" was kept — delete it in code if it is no longer needed.`] };
}

function sublabelEdit(text: string, lines: readonly string[], span: { start: number; end: number }, key: string, baseIndent: number): TextEdit {
  // After the last non-blank line of the event (before the next top-level label).
  let last = span.end - 1;
  while (last > span.start && (lines[last] ?? '').trim() === '') {
    last--;
  }
  const base = ' '.repeat(baseIndent);
  const body = '    ';
  const block = [
    '',
    `${base}label .${key}(**kwargs):`,
    `${base}${body}$ begin_event(**kwargs)`,
    '',
    `${base}${body}subtitles ""`,
    '',
    `${base}${body}$ end_event("new_daytime", **kwargs)`,
  ].join('\n');
  const at = positionToOffset(text, last, (lines[last] ?? '').replace(/\r$/, '').length);
  return { start: at, end: at, text: '\n' + block.replace(/^\n/, '') };
}

// ── New event ──────────────────────────────────────────────────────────────

export interface NewEventSpec {
  label: string;
  priority: 1 | 2 | 3;
  /** Pool expression, e.g. `cafeteria_events["order_food"]`. */
  pool: string;
  /** Pattern path template, e.g. `images/events/x/x <step>.webp`. Empty: no pattern. */
  patternPath: string;
  /** Extra definition items as code (conditions, selectors). */
  items: string[];
}

const INIT_LINE = /^([ \t]*)init\b[^:]*python\s*:/;

/**
 * Plan a new event: `<pool>.add_event(Event(...))` at the end of an `init python` block
 * in the file (a new `init 1 python:` block when there is none) and a scene label
 * skeleton at the end of the file.
 */
export function planNewEvent(text: string, spec: NewEventSpec): PlanResult {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.label)) {
    return { error: 'The label name must be an identifier (letters, digits, underscore).' };
  }
  const lines = text.split('\n');
  if (scanLabels(lines).some((l) => l.name === spec.label)) {
    return { error: `A label "${spec.label}" already exists in this file.` };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_.]*(\[[^\]]+\])*$/.test(spec.pool.trim())) {
    return { error: 'The pool must be a storage expression like cafeteria_events["order_food"].' };
  }
  const itemCodes = [...spec.items];
  if (spec.patternPath.trim()) {
    itemCodes.push(`Pattern("main", ${encodeString(spec.patternPath.trim())})`);
  }
  const edits: TextEdit[] = [];
  // Definition: end of the last init-python block that registers events, else the last init-python block.
  const inits = lines.map((row, i) => (INIT_LINE.test(row) ? i : -1)).filter((i) => i >= 0);
  const blockEnd = (start: number): number => {
    const base = indentOf(lines[start]);
    let last = start;
    for (let i = start + 1; i < lines.length; i++) {
      const row = lines[i];
      if (row.trim() === '') {
        continue;
      }
      if (indentOf(row) <= base) {
        break;
      }
      last = i;
    }
    return last;
  };
  const withEvents = inits.filter((s) => lines.slice(s, blockEnd(s) + 1).some((r) => /\.add_event\s*\(/.test(r)));
  const initStart = withEvents.length ? withEvents[withEvents.length - 1] : inits[inits.length - 1];
  let defLine: string;
  if (initStart !== undefined) {
    const end = blockEnd(initStart);
    const bodyIndent = ' '.repeat(indentOf(lines[initStart]) + 4);
    defLine = `${bodyIndent}${spec.pool.trim()}.add_event(${eventCall(spec, itemCodes, bodyIndent)})`;
    const at = positionToOffset(text, end, (lines[end] ?? '').replace(/\r$/, '').length);
    edits.push({ start: at, end: at, text: '\n' + defLine });
  } else {
    const modLine = /set_current_mod\(\s*['"][^'"]+['"]\s*\)/.exec(text)?.[0];
    const block = ['init 1 python:', ...(modLine ? [`    ${modLine}`] : []), `    ${spec.pool.trim()}.add_event(${eventCall(spec, itemCodes, '    ')})`, '', ''].join('\n');
    edits.push({ start: 0, end: 0, text: block });
  }
  // Scene label skeleton at the end of the file.
  const tail = text.endsWith('\n') ? '' : '\n';
  const scene = [
    '',
    `label ${spec.label}(**kwargs):`,
    '    $ begin_event(**kwargs)',
    '',
    ...(spec.patternPath.trim() ? ['    $ image = convert_pattern("main", **kwargs)', '    $ image.show(0)'] : []),
    '    subtitles ""',
    '',
    '    $ end_event("new_daytime", **kwargs)',
    '',
  ].join('\n');
  edits.push({ start: text.length, end: text.length, text: tail + scene });
  const newText = applyEdits(text, edits);
  // Verify: exactly one new definition and one new label with that name, nothing else touched.
  const defs = findEventDefs(newText, spec.label);
  if (defs.length !== 1) {
    return { error: 'The new definition would not parse as exactly one Event(...).' };
  }
  const newLabels = scanLabels(newText.split('\n'));
  if (newLabels.filter((l) => l.name === spec.label).length !== 1 || newLabels.length !== scanLabels(lines).length + 1) {
    return { error: 'The new label would not be unique.' };
  }
  const defCall = defs[0].call;
  const lineOfDef = newText.slice(0, defCall.start).split('\n').length - 1;
  const initOfDef = [...newText.split('\n').slice(0, lineOfDef + 1).entries()].reverse().find(([, r]) => INIT_LINE.test(r));
  if (!initOfDef) {
    return { error: 'The definition would land outside an init python block.' };
  }
  return { edits, newText, notes: [] };
}

function eventCall(spec: NewEventSpec, items: string[], indent: string): string {
  const args = [String(spec.priority), encodeString(spec.label), ...items];
  if (args.length <= 3) {
    return `Event(${args.join(', ')})`;
  }
  const inner = `${indent}    `;
  return `Event(\n${inner}${args.join(`,\n${inner}`)})`;
}
