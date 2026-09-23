import { decodeValue, parsePyCall, PyArg, PyCall } from './pyCall';
import { skipString } from './scan';

/**
 * What the selectors of an `Event(...)` can put into the event kwargs — evaluated like
 * the engine does (selector.rpy / helper.get_random_choice), not by collecting every
 * string literal in the arguments. So in
 *
 *   RandomListSelector('topic',
 *       (RandomListSelector('', "ah", "oh", (0.05, "panties")), NumCompareCondition("topic_set", 1, "==")),
 *       …)
 *
 * `topic` can be ah / oh / panties — never `topic_set` or `==`, which belong to the
 * condition gating that choice.
 */

export interface SelectorOutput {
  key: string;
  /** Selector class that provides the key. */
  className: string;
  /** Statically known values (strings/numbers/True/False), in source order. */
  values: string[];
  /** The value comes from game state (stats, progress, game data…) — not enumerable. */
  dynamic: boolean;
  /** Integer range (RandomValueSelector) when it is too large to enumerate. */
  range?: { min: number; max: number };
  /** Values are levels (LevelSelector / BuildingLevelSelector). */
  level?: boolean;
  /**
   * Values that are only chosen under a condition on another kwargs key, e.g.
   * girl_name "aona_komuro" only when location == "dorm_room" → { aona_komuro: [{ location: ["dorm_room"] }] }.
   * Several gates mean "any of them"; values not listed are unconditional.
   */
  when?: Record<string, Gate[]>;
}

/** key → allowed values (all must hold). */
export type Gate = Record<string, string[]>;

const MAX_ENUM = 40;

/** Selectors of an Event call (top-level arguments only; nested ones feed their parent). */
export function eventSelectorOutputs(text: string, eventCall: PyCall): SelectorOutput[] {
  const out: SelectorOutput[] = [];
  for (const arg of eventCall.args) {
    if (arg.name || !arg.call || !/Selector$/.test(arg.call.name)) {
      continue;
    }
    out.push(...selectorOutputs(text, arg.call));
  }
  return out;
}

/** key → values for all selectors of an Event call (merged per key). */
export function selectorValueMap(text: string, eventCall: PyCall): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const o of eventSelectorOutputs(text, eventCall)) {
    if (!o.values.length) {
      // Game-state values (stats, progress…) have nothing to offer as preview choices.
      continue;
    }
    const list = (map[o.key] ??= []);
    for (const v of o.values) {
      if (!list.includes(v)) {
        list.push(v);
      }
    }
  }
  return map;
}

function positionals(call: PyCall): PyArg[] {
  return call.args.filter((a) => !a.name && !a.star);
}

function keyword(call: PyCall, name: string): PyArg | undefined {
  return call.args.find((a) => a.name === name);
}

function literal(code: string): string | undefined {
  const d = decodeValue(code);
  if (d.kind === 'string' || d.kind === 'number' || d.kind === 'bool') {
    return d.value;
  }
  return undefined;
}

/** Outputs of one selector call (KwargsSelector can provide several keys). */
export function selectorOutputs(text: string, call: PyCall): SelectorOutput[] {
  if (call.name === 'KwargsSelector') {
    return call.args
      .filter((a) => !!a.name)
      .map((a) => {
        const v = literal(a.value);
        return { key: a.name!, className: call.name, values: v !== undefined ? [v] : [], dynamic: v === undefined };
      });
  }
  const pos = positionals(call);
  const keyArg = keyword(call, 'key') ?? pos[0];
  const key = keyArg ? literal(keyArg.value) : undefined;
  if (key === undefined || key === '') {
    return [];
  }
  const values = possibleValues(text, call);
  const base: SelectorOutput = { key, className: call.name, values: values?.values ?? [], dynamic: !values || values.dynamic };
  const when: Record<string, Gate[]> = {};
  for (const [v, g] of Object.entries(values?.gates ?? {})) {
    if (g !== 'always') {
      when[v] = g;
    }
  }
  if (Object.keys(when).length) {
    base.when = when;
  }
  if (values?.range) {
    base.range = values.range;
  }
  if (call.name === 'LevelSelector' || call.name === 'BuildingLevelSelector') {
    base.level = true;
  }
  return [base];
}

interface Possible {
  values: string[];
  /** Some branch yields a runtime value that cannot be listed. */
  dynamic: boolean;
  range?: { min: number; max: number };
  /** Per value: the gates under which it can be chosen ('always' = unconditional). */
  gates?: Record<string, Gate[] | 'always'>;
}

/** Values a selector can roll. Undefined when it depends entirely on game state. */
function possibleValues(text: string, call: PyCall): Possible | undefined {
  const pos = positionals(call);
  switch (call.name) {
    case 'RandomListSelector':
    case 'IterativeListSelector': {
      const acc: Possible = { values: [], dynamic: false };
      pos.slice(1).forEach((a) => merge(acc, choiceValues(text, a.value, a.call)));
      const alt = keyword(call, 'alt');
      if (alt) {
        merge(acc, valueOf(text, alt.value, alt.call));
      }
      return acc;
    }
    case 'ConditionSelector': {
      const acc: Possible = { values: [], dynamic: false };
      const t = keyword(call, 'true_value') ?? pos[2];
      const f = keyword(call, 'false_value') ?? pos[3];
      for (const a of [t, f]) {
        if (a) {
          merge(acc, valueOf(text, a.value, a.call));
        }
      }
      return acc;
    }
    case 'ValueSelector': {
      const v = keyword(call, 'value') ?? pos[1];
      return v ? valueOf(text, v.value, v.call) : undefined;
    }
    case 'RandomValueSelector': {
      const lo = Number(literal((keyword(call, 'min_value') ?? pos[1])?.value ?? ''));
      const hi = Number(literal((keyword(call, 'max_value') ?? pos[2])?.value ?? ''));
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo) {
        return undefined;
      }
      if (hi - lo + 1 > MAX_ENUM) {
        return { values: [], dynamic: false, range: { min: lo, max: hi } };
      }
      return { values: Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i)), dynamic: false };
    }
    case 'TimeSelector': {
      const type = literal((keyword(call, 'time_type') ?? pos[1])?.value ?? '');
      if (type === 'daytime') {
        return { values: ['1', '2', '3', '4', '5', '6', '7'], dynamic: false };
      }
      if (type === 'weekday') {
        return { values: ['1', '2', '3', '4', '5', '6', '7'], dynamic: false };
      }
      if (type === 'month') {
        return { values: Array.from({ length: 12 }, (_, i) => String(i + 1)), dynamic: false };
      }
      return undefined;
    }
    case 'BuildingUnlockedSelector':
    case 'RuleUnlockedSelector':
    case 'ClubUnlockedSelector':
      return { values: ['True', 'False'], dynamic: false };
    case 'LevelSelector':
    case 'BuildingLevelSelector':
      return { values: Array.from({ length: 10 }, (_, i) => String(i + 1)), dynamic: false };
    case 'DictSelector': {
      const d = keyword(call, 'dict') ?? pos[2];
      return d ? dictValues(text, d.value) : undefined;
    }
    case 'GameDataSelector': {
      const alt = keyword(call, 'alt') ?? pos[2];
      const v = alt ? literal(alt.value) : undefined;
      return { values: v !== undefined && v !== 'None' ? [v] : [], dynamic: true };
    }
    default:
      // StatSelector, ProgressSelector, KwargsValueSelector, CharacterSelector, … read game state.
      return undefined;
  }
}

function merge(acc: Possible, p: Possible | undefined): void {
  if (!p) {
    acc.dynamic = true;
    return;
  }
  for (const v of p.values) {
    const incoming = p.gates?.[v] ?? 'always';
    const known = acc.gates?.[v];
    acc.gates ??= {};
    if (!acc.values.includes(v)) {
      acc.values.push(v);
      acc.gates[v] = incoming;
    } else if (known === 'always' || incoming === 'always' || known === undefined) {
      acc.gates[v] = 'always';
    } else {
      acc.gates[v] = [...known, ...incoming];
    }
  }
  acc.dynamic ||= p.dynamic;
  if (p.range) {
    acc.range = acc.range ? { min: Math.min(acc.range.min, p.range.min), max: Math.max(acc.range.max, p.range.max) } : p.range;
  }
}

/** A plain value or a nested selector. */
function valueOf(text: string, code: string, call?: PyCall): Possible | undefined {
  if (call) {
    return /Selector$/.test(call.name) ? possibleValues(text, call) : undefined;
  }
  const v = literal(code);
  if (v !== undefined) {
    return { values: v === 'None' ? [] : [v], dynamic: false };
  }
  return undefined;
}

/**
 * One entry of a random choice list (helper.get_random_choice):
 *   value | (weight, value) | (value, bool|Condition) | (weight, value, bool|Condition)
 */
function choiceValues(text: string, code: string, call?: PyCall): Possible | undefined {
  const trimmed = code.trim();
  if (!call && trimmed.startsWith('(')) {
    const parts = splitTopLevel(trimmed, '(', ')');
    if (parts && parts.length >= 2) {
      const first = decodeValue(parts[0]);
      const weighted = first.kind === 'number';
      const valueCode = weighted ? parts[1] : parts[0];
      const inner = valueOf(text, valueCode, callIn(valueCode));
      const condCode = weighted ? parts[2] : parts[1];
      const gate = condCode ? gateOf(condCode) : undefined;
      if (inner && gate) {
        const gates: Record<string, Gate[] | 'always'> = {};
        for (const v of inner.values) {
          const own = inner.gates?.[v];
          // A value nested in a gated entry needs the outer gate AND its own.
          gates[v] = !own || own === 'always' ? [gate] : own.map((g) => ({ ...g, ...gate }));
        }
        return { ...inner, gates };
      }
      return inner;
    }
    if (parts && parts.length === 1) {
      return valueOf(text, parts[0], callIn(parts[0]));
    }
  }
  return valueOf(text, code, call);
}

/** `ValueCondition("location", "dorm_room")` / CompareCondition / NumCompareCondition(k, n, "==") → { location: ["dorm_room"] }. */
function gateOf(code: string): Gate | undefined {
  const call = callIn(code);
  if (!call) {
    return undefined;
  }
  const pos = call.args.filter((a) => !a.name && !a.star);
  const key = literal((call.args.find((a) => a.name === 'key') ?? pos[0])?.value ?? '');
  const value = literal((call.args.find((a) => a.name === 'value') ?? pos[1])?.value ?? '');
  if (!key || value === undefined) {
    return undefined;
  }
  if (call.name === 'ValueCondition' || call.name === 'CompareCondition') {
    return { [key]: [value] };
  }
  if (call.name === 'NumCompareCondition') {
    const op = literal((call.args.find((a) => a.name === 'operation') ?? pos[2])?.value ?? '');
    return op === '==' ? { [key]: [value] } : undefined;
  }
  return undefined;
}

function callIn(code: string): PyCall | undefined {
  const t = code.trim();
  const m = /^[A-Za-z_][A-Za-z0-9_.]*\s*\(/.exec(t);
  if (!m) {
    return undefined;
  }
  const call = parsePyCall(t, 0);
  return call && call.close === t.length - 1 ? call : undefined;
}

/** Values of a `{k: v, …}` dict literal. */
function dictValues(text: string, code: string): Possible | undefined {
  const parts = splitTopLevel(code.trim(), '{', '}');
  if (!parts) {
    return undefined;
  }
  const acc: Possible = { values: [], dynamic: false };
  for (const entry of parts) {
    const colon = topLevelIndex(entry, ':');
    if (colon < 0) {
      return undefined;
    }
    const v = entry.slice(colon + 1).trim();
    merge(acc, valueOf(text, v, callIn(v)));
  }
  return acc;
}

/** Top-level comma-separated items of `open … close` (strings and nesting respected). */
export function splitTopLevel(code: string, open: string, close: string): string[] | undefined {
  if (!code.startsWith(open)) {
    return undefined;
  }
  const items: string[] = [];
  let depth = 0;
  let start = 1;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'") {
      i = skipString(code, i) - 1;
      continue;
    }
    if (c === '#') {
      while (i < code.length && code[i] !== '\n') {
        i++;
      }
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        if (i !== code.length - 1 || c !== close) {
          return undefined;
        }
        const last = code.slice(start, i).trim();
        if (last) {
          items.push(last);
        }
        return items;
      }
    } else if (c === ',' && depth === 1) {
      items.push(code.slice(start, i).trim());
      start = i + 1;
    }
  }
  return undefined;
}

function topLevelIndex(code: string, ch: string): number {
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'") {
      i = skipString(code, i) - 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
    } else if (c === ch && depth === 0) {
      return i;
    }
  }
  return -1;
}
