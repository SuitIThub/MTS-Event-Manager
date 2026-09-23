import {
  applyEdits,
  decodeValue,
  DecodedValue,
  hasPositionalAfterKeyword,
  insertArgEdit,
  isSingleExpression,
  parsePyCall,
  PyArg,
  PyCall,
  removeArgEdit,
  replaceValueEdit,
  TextEdit,
  walkPyCalls,
} from './pyCall';
import { skipString } from './scan';
import { ClassSchema, EventKind, SchemaKind } from './types';

/**
 * Structured model of `Event(...)` definitions plus safe, verified edit operations.
 * Pure (no VS Code dependency): the extension feeds it document text and a schema
 * lookup; every operation returns text edits that have already been simulated,
 * re-parsed and checked, or a reason why the edit was refused.
 */

export type SchemaLookup = (className: string) => ClassSchema | undefined;

export type ItemKind = 'condition' | 'selector' | 'option' | 'pattern' | 'other';

const EVENT_KINDS = new Set(['Event', 'EventFragment', 'EventComposite', 'EventSelect']);

/** Number of fixed leading positional arguments per event class. */
const FIXED_POSITIONALS: Record<string, string[]> = {
  Event: ['select_type', 'event'],
  EventFragment: ['select_type', 'event'],
  EventComposite: ['priority', 'event', 'fragments'],
  EventSelect: ['priority', 'event', 'text', 'event_list'],
};

const KNOWN_EVENT_KEYWORDS: Record<string, string[]> = {
  Event: ['thumbnail', 'register_self', 'override_intro', 'override_location'],
  EventFragment: ['thumbnail'],
  EventComposite: ['thumbnail'],
  EventSelect: ['thumbnail', 'override_menu_exit', 'fallback', 'person'],
};

/** Offsets of every Event-class call in `text`, skipping comments and strings. */
export function findEventCallOffsets(text: string): number[] {
  const out: number[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '#') {
      while (i < n && text[i] !== '\n') {
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(text, i);
      continue;
    }
    if (/[A-Za-z_]/.test(c) && (i === 0 || !/[A-Za-z0-9_.]/.test(text[i - 1]))) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(text[j])) {
        j++;
      }
      const word = text.slice(i, j);
      if (EVENT_KINDS.has(word)) {
        let k = j;
        while (k < n && (text[k] === ' ' || text[k] === '\t')) {
          k++;
        }
        if (text[k] === '(') {
          out.push(i);
        }
      }
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

export interface EventDefHeader {
  kind: EventKind;
  call: PyCall;
  labelName?: string;
  priority?: string;
}

export function readEventHeader(call: PyCall): EventDefHeader | undefined {
  if (!EVENT_KINDS.has(call.name)) {
    return undefined;
  }
  const positionals = call.args.filter((a) => !a.name && !a.star);
  const label = positionals[1] ? decodeValue(positionals[1].value) : undefined;
  return {
    kind: call.name as EventKind,
    call,
    labelName: label?.kind === 'string' ? label.value : undefined,
    priority: positionals[0]?.value,
  };
}

/**
 * Content event definitions in a text (optionally only those for `labelName`). A real
 * definition names its scene label with a string literal; engine code that constructs
 * events from variables (`Event(self.priority, self.event, …)`) is never editable here.
 */
export function findEventDefs(text: string, labelName?: string): EventDefHeader[] {
  const out: EventDefHeader[] = [];
  for (const offset of findEventCallOffsets(text)) {
    const call = parsePyCall(text, offset);
    const header = call && readEventHeader(call);
    if (!header || !header.labelName) {
      continue;
    }
    if (!labelName || header.labelName === labelName) {
      out.push(header);
    }
  }
  return out;
}

// ── Model for the UI ───────────────────────────────────────────────────────

export interface FieldModel {
  /** Parameter name, or `name[i]` for vararg entries. */
  label: string;
  role: 'positional' | 'vararg' | 'keyword' | 'kwarg' | 'unknown';
  argIndex: number;
  code: string;
  decoded: DecodedValue;
  typeHint?: string;
  /** Nested call model when the value is itself a call (e.g. NOT(ProgressCondition(...))). */
  node?: CallModel;
}

export interface CallModel {
  name: string;
  code: string;
  kind?: SchemaKind;
  schemaKnown: boolean;
  signature?: string;
  fields: FieldModel[];
  /** Required positional parameters that are not given. */
  missing: string[];
  /** Keyword parameters that could still be added. */
  addableKeywords: string[];
  /** Name of the *vararg bucket, when more positional values may be appended. */
  varargName?: string;
}

export interface ItemModel {
  argIndex: number;
  kind: ItemKind;
  code: string;
  node?: CallModel;
}

export interface EventDefModel {
  kind: EventKind;
  /** Soft semantic hints (e.g. a pattern placeholder no selector provides). */
  hints: string[];
  labelName?: string;
  priority?: { argIndex: number; code: string };
  /** Other fixed positionals (fragments, text, event_list). */
  fixed: { name: string; argIndex: number; code: string }[];
  items: ItemModel[];
  keywords: FieldModel[];
  addableKeywords: string[];
  code: string;
}

export function itemKindOf(arg: PyArg, schemaOf: SchemaLookup): ItemKind {
  if (!arg.call) {
    return 'other';
  }
  if (arg.call.name === 'Pattern') {
    return 'pattern';
  }
  const kind = schemaOf(arg.call.name)?.kind;
  if (kind === 'condition' || kind === 'selector' || kind === 'option' || kind === 'pattern') {
    return kind;
  }
  if (/^(AND|OR|NOT|NOR|XOR)$/.test(arg.call.name) || /Condition$/.test(arg.call.name)) {
    return 'condition';
  }
  if (/Selector$/.test(arg.call.name)) {
    return 'selector';
  }
  if (/Option$/.test(arg.call.name)) {
    return 'option';
  }
  return 'other';
}

export function buildCallModel(text: string, call: PyCall, schemaOf: SchemaLookup): CallModel {
  const schema = schemaOf(call.name);
  const positionalParams = schema?.params.filter((p) => p.kind === 'positional') ?? [];
  const vararg = schema?.params.find((p) => p.kind === 'vararg');
  const hasKwargs = !!schema?.params.some((p) => p.kind === 'kwargs');
  const byName = new Map((schema?.params ?? []).filter((p) => p.kind === 'positional' || p.kind === 'kwonly').map((p) => [p.name, p]));
  const fields: FieldModel[] = [];
  const given = new Set<string>();
  let positional = 0;
  let varargCount = 0;
  call.args.forEach((arg, argIndex) => {
    const base = {
      argIndex,
      code: arg.value,
      decoded: decodeValue(arg.value),
      node: arg.call ? buildCallModel(text, arg.call, schemaOf) : undefined,
    };
    if (arg.star) {
      fields.push({ ...base, label: `${arg.star}${arg.value}`, role: 'unknown' });
    } else if (arg.name) {
      const p = byName.get(arg.name);
      given.add(arg.name);
      fields.push({
        ...base,
        label: arg.name,
        role: p ? 'keyword' : hasKwargs ? 'kwarg' : 'unknown',
        typeHint: p?.typeHint,
      });
    } else if (positional < positionalParams.length) {
      const p = positionalParams[positional++];
      given.add(p.name);
      fields.push({ ...base, label: p.name, role: 'positional', typeHint: p.typeHint });
    } else if (vararg) {
      fields.push({ ...base, label: `${vararg.name}[${varargCount++}]`, role: 'vararg' });
    } else {
      fields.push({ ...base, label: `#${argIndex}`, role: 'unknown' });
    }
  });
  const kwCandidates = [
    ...(schema?.params.filter((p) => p.kind === 'kwonly').map((p) => p.name) ?? []),
    ...(hasKwargs ? schema?.inferredKwargs ?? [] : []),
  ];
  return {
    name: call.name,
    code: text.slice(call.start, call.close + 1),
    kind: schema?.kind,
    schemaKnown: !!schema,
    signature: schema ? formatSig(schema) : undefined,
    fields,
    missing: positionalParams.filter((p) => p.required && !given.has(p.name)).map((p) => p.name),
    addableKeywords: [...new Set(kwCandidates)].filter((k) => !given.has(k)),
    varargName: vararg?.name,
  };
}

function formatSig(schema: ClassSchema): string {
  return `${schema.name}(${schema.params
    .map((p) =>
      p.kind === 'kwargs' ? `**${p.name}` : p.kind === 'vararg' ? `*${p.name}` : p.default !== undefined ? `${p.name}=${p.default}` : p.name
    )
    .join(', ')})`;
}

export function buildEventDefModel(text: string, header: EventDefHeader, schemaOf: SchemaLookup): EventDefModel {
  const { call } = header;
  const fixedNames = FIXED_POSITIONALS[header.kind] ?? ['select_type', 'event'];
  const items: ItemModel[] = [];
  const keywords: FieldModel[] = [];
  const fixed: EventDefModel['fixed'] = [];
  let priority: EventDefModel['priority'];
  let positional = 0;
  call.args.forEach((arg, argIndex) => {
    if (arg.name || arg.star === '**') {
      keywords.push({
        label: arg.name ?? `**${arg.value}`,
        role: 'keyword',
        argIndex,
        code: arg.value,
        decoded: decodeValue(arg.value),
      });
      return;
    }
    const p = positional++;
    if (p < fixedNames.length) {
      if (p === 0) {
        priority = { argIndex, code: arg.value };
      } else if (p > 1) {
        fixed.push({ name: fixedNames[p], argIndex, code: arg.value });
      }
      return;
    }
    items.push({
      argIndex,
      kind: itemKindOf(arg, schemaOf),
      code: arg.value,
      node: arg.call ? buildCallModel(text, arg.call, schemaOf) : undefined,
    });
  });
  const known = KNOWN_EVENT_KEYWORDS[header.kind] ?? [];
  return {
    kind: header.kind,
    hints: header.kind === 'Event' || header.kind === 'EventComposite' ? placeholderHints(call) : [],
    labelName: header.labelName,
    priority,
    fixed,
    items,
    keywords,
    addableKeywords: known.filter((k) => !keywords.some((kw) => kw.label === k)),
    code: text.slice(call.start, call.close + 1),
  };
}

/** Placeholders the image system fills itself (images.rpy replaces these directly). */
const BUILTIN_PLACEHOLDERS = new Set([
  'step',
  'variant',
  'nude',
  'level',
  'school_level',
  'teacher_level',
  'parent_level',
  'secretary_level',
]);

/** Keys the definition's selectors provide. */
export function selectorKeys(call: PyCall): Set<string> {
  const keys = new Set<string>();
  for (const a of call.args) {
    const c = a.call;
    if (!c || a.name || !/Selector$/.test(c.name)) {
      continue;
    }
    if (c.name === 'KwargsSelector') {
      c.args.filter((x) => x.name).forEach((x) => keys.add(x.name!));
      continue;
    }
    const first = c.args.find((x) => !x.name && !x.star);
    const key = first ? decodeValue(first.value) : undefined;
    if (key?.kind === 'string' && key.value) {
      keys.add(key.value);
      if (c.name === 'StatSelector') {
        keys.add(`${key.value}_range`);
      }
    }
  }
  return keys;
}

/** `Pattern "main" uses <topic>, which no selector here provides.` */
export function placeholderHints(call: PyCall): string[] {
  const keys = selectorKeys(call);
  const hints: string[] = [];
  for (const a of call.args) {
    if (a.call?.name !== 'Pattern') {
      continue;
    }
    const pos = a.call.args.filter((x) => !x.name && !x.star);
    const name = pos[0] ? decodeValue(pos[0].value) : undefined;
    const path = pos[1] ? decodeValue(pos[1].value) : undefined;
    if (path?.kind !== 'string') {
      continue;
    }
    const missing = [...path.value.matchAll(/<([A-Za-z_][A-Za-z0-9_]*)>/g)]
      .map((m) => m[1])
      .filter((k) => !BUILTIN_PLACEHOLDERS.has(k) && !keys.has(k));
    for (const k of [...new Set(missing)]) {
      hints.push(`Pattern "${name?.value ?? '?'}" uses <${k}>, which no selector of this definition provides.`);
    }
  }
  return hints;
}

// ── Addressing ─────────────────────────────────────────────────────────────

/** Path of argument indices from the Event call down to a nested argument. */
export type ArgPath = number[];

export function resolveCallAt(call: PyCall, path: ArgPath): PyCall | undefined {
  let cur: PyCall | undefined = call;
  for (const i of path) {
    cur = cur?.args[i]?.call;
  }
  return cur;
}

// ── Operations ─────────────────────────────────────────────────────────────

export type DefOp =
  | { op: 'setValue'; path: ArgPath; code: string }
  | { op: 'remove'; path: ArgPath }
  | { op: 'insert'; parent: ArgPath; code: string; keyword?: string; afterIndex?: number };

export interface OpResult {
  edits: TextEdit[];
  newText: string;
  /** Non-blocking notes (e.g. pre-existing schema issues). */
  notes: string[];
}

/**
 * Plan an operation on the definition at `callStart`. `expect` is the code the UI last
 * saw for the target (argument value or parent call) — if the file changed underneath,
 * the operation is refused instead of guessing. Returns the verified result or an error.
 */
export function planDefOp(
  text: string,
  callStart: number,
  op: DefOp,
  expect: string,
  schemaOf: SchemaLookup
): OpResult | { error: string } {
  const call = parsePyCall(text, callStart);
  if (!call || !EVENT_KINDS.has(call.name)) {
    return { error: 'The event definition could not be found anymore. Refresh and try again.' };
  }
  let edits: TextEdit[];
  let check: (newCall: PyCall) => string | undefined;

  if (op.op === 'setValue' || op.op === 'remove') {
    const parent = resolveCallAt(call, op.path.slice(0, -1));
    const index = op.path[op.path.length - 1];
    const arg = parent?.args[index];
    if (!parent || !arg) {
      return { error: 'That argument does not exist anymore. Refresh and try again.' };
    }
    if (arg.value !== expect) {
      return { error: 'The code changed since the editor loaded it. Refresh and try again.' };
    }
    if (op.op === 'setValue') {
      const code = op.code.trim();
      if (!isSingleExpression(code)) {
        return { error: `Not a single valid Python expression: ${code || '(empty)'}` };
      }
      if (op.path.length === 1 && !call.args[index].name && positionalIndex(call, index) === 1) {
        return { error: 'The label name is linked to the scene label; rename both in code instead.' };
      }
      edits = [replaceValueEdit(arg, code)];
      check = (nc) => {
        const target = resolveCallAt(nc, op.path.slice(0, -1))?.args[index];
        return target?.value === code ? undefined : 'The value did not land where expected.';
      };
    } else {
      if (op.path.length === 1 && isFixedPositional(call, index)) {
        return { error: 'Priority and label are required and cannot be removed.' };
      }
      const before = parent.args.length;
      edits = [removeArgEdit(text, parent, index)];
      check = (nc) => {
        const p = resolveCallAt(nc, op.path.slice(0, -1));
        return p && p.args.length === before - 1 ? undefined : 'Removing the argument changed more than intended.';
      };
    }
  } else {
    const parent = resolveCallAt(call, op.parent);
    if (!parent) {
      return { error: 'That call does not exist anymore. Refresh and try again.' };
    }
    if (text.slice(parent.start, parent.close + 1) !== expect) {
      return { error: 'The code changed since the editor loaded it. Refresh and try again.' };
    }
    const valueCode = op.code.trim();
    if (!isSingleExpression(valueCode)) {
      return { error: `Not a single valid Python expression: ${valueCode || '(empty)'}` };
    }
    if (op.keyword !== undefined) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(op.keyword)) {
        return { error: `Invalid keyword name: ${op.keyword}` };
      }
      if (parent.args.some((a) => a.name === op.keyword)) {
        return { error: `${op.keyword} is already set.` };
      }
    }
    const code = op.keyword !== undefined ? `${op.keyword} = ${valueCode}` : valueCode;
    const before = parent.args.length;
    edits = [insertArgEdit(text, parent, code, { keyword: op.keyword !== undefined, afterIndex: op.afterIndex })];
    check = (nc) => {
      const p = resolveCallAt(nc, op.parent);
      if (!p || p.args.length !== before + 1) {
        return 'Inserting changed more than intended.';
      }
      const found = p.args.some((a) => (op.keyword !== undefined ? a.name === op.keyword && a.value === valueCode : !a.name && a.value === valueCode));
      return found ? undefined : 'The new argument did not land where expected.';
    };
  }

  const newText = applyEdits(text, edits);
  const verdict = verifyDefinition(text, newText, call, schemaOf, check);
  if (typeof verdict === 'string') {
    return { error: verdict };
  }
  return { edits, newText, notes: verdict.notes };
}

function positionalIndex(call: PyCall, argIndex: number): number {
  let p = -1;
  for (let i = 0; i <= argIndex; i++) {
    if (!call.args[i].name && !call.args[i].star) {
      p++;
    }
  }
  return p;
}

function isFixedPositional(call: PyCall, argIndex: number): boolean {
  if (call.args[argIndex].name || call.args[argIndex].star) {
    return false;
  }
  return positionalIndex(call, argIndex) < (FIXED_POSITIONALS[call.name]?.length ?? 2);
}

/**
 * The safety net every definition edit passes before it touches a file: the edited
 * call must still parse at the same place with the same class and label, text outside
 * the call must be identical, argument order must stay valid Python, the operation must
 * have done exactly what it claimed, and no new schema errors may appear.
 */
export function verifyDefinition(
  oldText: string,
  newText: string,
  oldCall: PyCall,
  schemaOf: SchemaLookup,
  check: (newCall: PyCall) => string | undefined
): { notes: string[] } | string {
  const newCall = parsePyCall(newText, oldCall.start);
  if (!newCall || newCall.name !== oldCall.name) {
    return 'The edit would break the definition (it no longer parses).';
  }
  const tailOld = oldText.slice(oldCall.close + 1);
  const tailNew = newText.slice(newCall.close + 1);
  if (oldText.slice(0, oldCall.start) !== newText.slice(0, newCall.start) || tailOld !== tailNew) {
    return 'The edit would change code outside the definition.';
  }
  if (readEventHeader(newCall)?.labelName !== readEventHeader(oldCall)?.labelName) {
    return 'The edit would change the event label.';
  }
  let orderBroken = false;
  walkPyCalls(newCall, (c) => {
    if (hasPositionalAfterKeyword(c)) {
      orderBroken = true;
    }
  });
  if (orderBroken) {
    return 'The edit would put a positional argument after a keyword argument.';
  }
  const specific = check(newCall);
  if (specific) {
    return specific;
  }
  const before = schemaErrors(oldCall, schemaOf);
  const after = schemaErrors(newCall, schemaOf);
  const fresh = after.filter((e) => !before.includes(e));
  if (fresh.length) {
    return `The edit would introduce: ${fresh.join('; ')}`;
  }
  return { notes: after };
}

/** Schema errors in a call tree (missing required positionals, unknown keywords). */
export function schemaErrors(call: PyCall, schemaOf: SchemaLookup): string[] {
  const out: string[] = [];
  walkPyCalls(call, (c) => {
    const schema = schemaOf(c.name);
    if (!schema || schema.params.length === 0) {
      return; // unknown constructor: nothing reliable to check against
    }
    const required = schema.params.filter((p) => p.kind === 'positional' && p.required);
    const names = new Set(c.args.filter((a) => a.name).map((a) => a.name!));
    const positionals = c.args.filter((a) => !a.name && !a.star).length;
    const unpacks = c.args.some((a) => a.star);
    const missing = required.filter((p, i) => i >= positionals && !names.has(p.name));
    if (!unpacks && missing.length) {
      out.push(`${c.name} is missing ${missing.map((p) => p.name).join(', ')}`);
    }
    const hasKwargs = schema.params.some((p) => p.kind === 'kwargs');
    const known = new Set(schema.params.filter((p) => p.kind === 'positional' || p.kind === 'kwonly').map((p) => p.name));
    for (const n of names) {
      if (!known.has(n) && !hasKwargs) {
        out.push(`${c.name} has no keyword "${n}"`);
      }
    }
  });
  return out;
}

/** Build the code for a new schema-driven call from field values (already encoded). */
export function buildCallCode(name: string, positionals: string[], keywords: [string, string][]): string | { error: string } {
  for (const code of positionals) {
    if (!isSingleExpression(code)) {
      return { error: `Not a valid value: ${code || '(empty)'}` };
    }
  }
  for (const [k, code] of keywords) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || !isSingleExpression(code)) {
      return { error: `Not a valid keyword value: ${k} = ${code || '(empty)'}` };
    }
  }
  const parts = [...positionals.map((c) => c.trim()), ...keywords.map(([k, c]) => `${k} = ${c.trim()}`)];
  return `${name}(${parts.join(', ')})`;
}

/** Where a new item of `kind` should go: after the last existing item of that kind. */
export function insertSlotFor(model: EventDefModel, kind: ItemKind): number | undefined {
  const order: ItemKind[] = ['condition', 'selector', 'option', 'pattern', 'other'];
  const same = model.items.filter((i) => i.kind === kind);
  if (same.length) {
    return same[same.length - 1].argIndex;
  }
  // No item of this kind yet: after the last item of an earlier kind, else after the label.
  const rank = order.indexOf(kind);
  const earlier = model.items.filter((i) => order.indexOf(i.kind) < rank);
  if (earlier.length) {
    return earlier[earlier.length - 1].argIndex;
  }
  const lastFixed = [model.priority?.argIndex ?? -1, ...model.fixed.map((f) => f.argIndex)];
  const labelIdx = model.items.length ? model.items[0].argIndex - 1 : undefined;
  return labelIdx ?? Math.max(...lastFixed, 1);
}

export { applyEdits };
