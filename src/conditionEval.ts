import { decodeValue, PyArg, PyCall } from './pyCall';

/**
 * Evaluates an event's conditions against a simulated game state, following the engine
 * (conditions.rpy, time.rpy, helper.check_in_value). Conditions that depend on state the
 * simulator does not model (progress, game data, unlockables, situations…) evaluate to
 * 'unknown' instead of guessing; RandomCondition yields a chance.
 */

export type Tri = 'yes' | 'no' | 'unknown';

export interface GameState {
  /** 1 = Monday … 7 = Sunday */
  weekday: number;
  /** 1 = Morning … 7 = Night */
  daytime: number;
  /** Level per character key: school, teacher, parent, secretary. */
  levels: Record<string, number>;
  /** School stats (corruption, inhibition, happiness, education, charm, reputation). */
  stats: Record<string, number>;
  money: number;
  /** The intro is still running. */
  intro: boolean;
}

export interface EvalNode {
  label: string;
  result: Tri;
  /** Why (e.g. "daytime 3 not in c (2,4,5)"). */
  detail?: string;
  /** RandomCondition: probability 0–1 that it holds. */
  chance?: number;
  children?: EvalNode[];
}

export const DEFAULT_STATE: GameState = {
  weekday: 1,
  daytime: 3,
  levels: { school: 5, teacher: 5, parent: 5, secretary: 5 },
  stats: { corruption: 20, inhibition: 60, happiness: 50, education: 50, charm: 50, reputation: 50 },
  money: 1000,
  intro: false,
};

/** helper.check_in_value: "5" · "3+" · "5-" · "2-4" · "1,3,7+" (true when any part matches). */
export function matchNumberPattern(pattern: string, n: number): boolean {
  const s = String(pattern).trim();
  if (s === '' || s === 'x') {
    return true;
  }
  return s.split(',').some((raw) => {
    const part = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^(-?[0-9.]+)\s*-\s*(-?[0-9.]+)$/.exec(part))) {
      return n >= Number(m[1]) && n <= Number(m[2]);
    }
    if ((m = /^(-?[0-9.]+)\s*\+$/.exec(part))) {
      return n >= Number(m[1]);
    }
    if ((m = /^(-?[0-9.]+)\s*-$/.exec(part))) {
      return n <= Number(m[1]);
    }
    return part !== '' && Number(part) === n;
  });
}

const DAYTIME_CODES: Record<string, number[]> = { c: [2, 4, 5], f: [1, 3, 6], d: [1, 2, 3, 4, 5, 6], n: [7] };
const WEEKDAY_CODES: Record<string, number[]> = { d: [1, 2, 3, 4, 5], w: [6, 7] };

function lit(arg: PyArg | undefined): string | undefined {
  if (!arg) {
    return undefined;
  }
  const d = decodeValue(arg.value);
  return d.kind === 'string' || d.kind === 'number' || d.kind === 'bool' ? d.value : undefined;
}

function pos(call: PyCall): PyArg[] {
  return call.args.filter((a) => !a.name && !a.star);
}

function kw(call: PyCall, name: string): PyArg | undefined {
  return call.args.find((a) => a.name === name);
}

function short(call: PyCall): string {
  const body = call.args
    .filter((a) => !a.call)
    .map((a) => (a.name ? `${a.name}=` : '') + a.value.trim())
    .join(', ');
  return `${call.name}(${body.length > 40 ? body.slice(0, 39) + '…' : body})`;
}

function combine(op: string, children: EvalNode[]): Tri {
  const rs = children.map((c) => c.result);
  const yes = rs.filter((r) => r === 'yes').length;
  const no = rs.filter((r) => r === 'no').length;
  const unk = rs.length - yes - no;
  switch (op) {
    case 'AND':
      return no ? 'no' : unk ? 'unknown' : 'yes';
    case 'OR':
      return yes ? 'yes' : unk ? 'unknown' : 'no';
    case 'NOR':
      return yes ? 'no' : unk ? 'unknown' : 'yes';
    case 'NOT':
      return rs[0] === 'yes' ? 'no' : rs[0] === 'no' ? 'yes' : 'unknown';
    case 'XOR':
      return unk ? 'unknown' : yes === 1 ? 'yes' : 'no';
  }
  return 'unknown';
}

export function evalCondition(call: PyCall, s: GameState): EvalNode {
  const label = short(call);
  if (/^(AND|OR|NOT|NOR|XOR)$/.test(call.name)) {
    const children = call.args.filter((a) => a.call).map((a) => evalCondition(a.call!, s));
    return { label: call.name, result: combine(call.name, children), children };
  }
  switch (call.name) {
    case 'TimeCondition': {
      const parts: string[] = [];
      let result: Tri = 'yes';
      const daytime = lit(kw(call, 'daytime'));
      if (daytime !== undefined && daytime !== 'x') {
        const ok = DAYTIME_CODES[daytime] ? DAYTIME_CODES[daytime].includes(s.daytime) : matchNumberPattern(daytime, s.daytime);
        parts.push(`daytime ${s.daytime} ${ok ? '∈' : '∉'} ${daytime}${DAYTIME_CODES[daytime] ? ` (${DAYTIME_CODES[daytime].join(',')})` : ''}`);
        if (!ok) {
          result = 'no';
        }
      }
      const weekday = lit(kw(call, 'weekday'));
      if (weekday !== undefined && weekday !== 'x') {
        const ok = WEEKDAY_CODES[weekday] ? WEEKDAY_CODES[weekday].includes(s.weekday) : matchNumberPattern(weekday, s.weekday);
        parts.push(`weekday ${s.weekday} ${ok ? '∈' : '∉'} ${weekday}`);
        if (!ok) {
          result = 'no';
        }
      }
      for (const k of ['day', 'week', 'month', 'year']) {
        const v = lit(kw(call, k));
        if (v !== undefined && v !== 'x' && result !== 'no') {
          result = 'unknown';
          parts.push(`${k}=${v} not simulated`);
        }
      }
      return { label, result, detail: parts.join(' · ') };
    }
    case 'LevelCondition': {
      const value = lit(kw(call, 'value') ?? pos(call)[0]) ?? '';
      const char = lit(kw(call, 'char_obj') ?? pos(call)[1]) ?? 'school';
      const level = s.levels[char];
      if (level === undefined) {
        return { label, result: 'unknown', detail: `level of ${char} not simulated` };
      }
      const ok = matchNumberPattern(value, level);
      return { label, result: ok ? 'yes' : 'no', detail: `${char} level ${level} ${ok ? 'matches' : 'does not match'} ${value}` };
    }
    case 'StatCondition': {
      const char = lit(kw(call, 'char_obj')) ?? 'school';
      if (char !== 'school') {
        return { label, result: 'unknown', detail: `stats of ${char} not simulated` };
      }
      const parts: string[] = [];
      let result: Tri = 'yes';
      for (const a of call.args.filter((x) => x.name && x.name !== 'char_obj')) {
        const v = lit(a) ?? '';
        const have = s.stats[a.name!];
        if (have === undefined) {
          result = result === 'no' ? 'no' : 'unknown';
          parts.push(`${a.name} not simulated`);
          continue;
        }
        const ok = matchNumberPattern(v, have);
        parts.push(`${a.name} ${have} ${ok ? '∈' : '∉'} ${v}`);
        if (!ok) {
          result = 'no';
        }
      }
      return { label, result, detail: parts.join(' · ') };
    }
    case 'MoneyCondition': {
      const v = Number(lit(pos(call)[0] ?? kw(call, 'value')));
      if (!Number.isFinite(v)) {
        return { label, result: 'unknown' };
      }
      return { label, result: s.money >= v ? 'yes' : 'no', detail: `money ${s.money} ${s.money >= v ? '≥' : '<'} ${v}` };
    }
    case 'RandomCondition': {
      const threshold = Number(lit(kw(call, 'threshold') ?? pos(call)[0]));
      const limit = Number(lit(kw(call, 'limit') ?? pos(call)[1]) ?? 100) || 100;
      if (!Number.isFinite(threshold)) {
        return { label, result: 'unknown' };
      }
      const chance = Math.max(0, Math.min(1, threshold / limit));
      return { label, result: chance >= 1 ? 'yes' : chance <= 0 ? 'no' : 'unknown', chance, detail: `${Math.round(chance * 100)} % chance` };
    }
    case 'BoolCondition':
    case 'ManualCondition': {
      const v = lit(pos(call)[0] ?? kw(call, 'value') ?? kw(call, 'is_fulfilled'));
      return { label, result: v === 'True' ? 'yes' : v === 'False' ? 'no' : 'unknown' };
    }
    case 'IntroCondition': {
      const v = lit(kw(call, 'is_intro') ?? pos(call)[0]) ?? 'True';
      const want = v === 'True';
      return { label, result: want === s.intro ? 'yes' : 'no', detail: s.intro ? 'intro running' : 'after the intro' };
    }
  }
  return { label, result: 'unknown', detail: 'depends on game progress / data (not simulated)' };
}

export interface EventEval {
  result: Tri;
  conditions: EvalNode[];
  /** Product of the RandomCondition chances of the (otherwise fulfilled) event. */
  chance: number;
}

/** All top-level conditions of an event must hold (Event conditions are ANDed). */
export function evalEvent(conditionCalls: PyCall[], s: GameState): EventEval {
  const conditions = conditionCalls.map((c) => evalCondition(c, s));
  let chance = 1;
  for (const c of conditions) {
    if (c.chance !== undefined) {
      chance *= c.chance;
    }
  }
  // A pure RandomCondition counts as satisfiable (its chance is reported separately).
  const effective = conditions.map((c) => (c.chance !== undefined && c.chance > 0 ? { ...c, result: 'yes' as Tri } : c));
  return { result: combine('AND', effective), conditions, chance };
}
