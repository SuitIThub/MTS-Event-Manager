import { parsePyCall } from './pyCall';

/**
 * Workspace-wide facts the event check, the trigger simulator and the event overview
 * need: event pools (`pool.add_event(ev1, ev2)`), Ren'Py characters (`define character.X`)
 * and store globals (`$ x = …`, `define` / `default`).
 */

export interface PoolFacts {
  /** Pool expression (e.g. `sd_events["peek_students"]`) → event variables added to it. */
  pools: Map<string, string[]>;
}

const ADD_EVENT_RE = /\.\s*add_event\s*\(/g;

/** `pool.add_event(a, b, …)` → pool → variable names. */
export function scanPools(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  ADD_EVENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ADD_EVENT_RE.exec(text)) !== null) {
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const receiver = text.slice(lineStart, m.index).replace(/^\s*\$?\s*/, '').trim();
    if (!receiver || receiver.includes('#') || /^def\b|^class\b/.test(receiver)) {
      continue;
    }
    const nameStart = text.indexOf('add_event', m.index);
    const call = parsePyCall(text, nameStart);
    if (!call) {
      continue;
    }
    const vars = call.args.filter((a) => !a.name && !a.star && /^[A-Za-z_][A-Za-z0-9_]*$/.test(a.value.trim())).map((a) => a.value.trim());
    if (!vars.length) {
      continue;
    }
    out.set(receiver, [...(out.get(receiver) ?? []), ...vars]);
  }
  return out;
}

const CHARACTER_RE = /^[ \t]*define[ \t]+(?:character\.)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:Character|DynamicCharacter)\s*\(/gm;
const CHARACTER_NS_RE = /^[ \t]*define[ \t]+character\.([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/gm;
const GLOBAL_RE = /^[ \t]*(?:\$[ \t]*|define[ \t]+|default[ \t]+)([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(?!=)/gm;

/** Speakers usable everywhere: `define character.X = …` / `define X = Character(…)`. */
export function scanCharacters(text: string): string[] {
  const out = new Set<string>();
  for (const re of [CHARACTER_RE, CHARACTER_NS_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      out.add(m[1]);
    }
  }
  return [...out];
}

/**
 * Starting levels per character: `set_level_for_char(5, "secretary", …)` / `secretary.set_level(5)`
 * (the secretary starts at 5, so secretary_level 1–4 never happens).
 */
export function scanStartLevels(text: string): [string, number][] {
  const out: [string, number][] = [];
  const a = /set_level_for_char\(\s*([0-9]+)\s*,\s*["']([A-Za-z_]+)["']/g;
  const b = /\b(school|teacher|parent|secretary)\.set_level\(\s*([0-9]+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = a.exec(text)) !== null) {
    out.push([m[2], Number(m[1])]);
  }
  while ((m = b.exec(text)) !== null) {
    out.push([m[1], Number(m[2])]);
  }
  return out;
}

/** Store variables assigned anywhere (for `[name]` interpolation checks). */
export function scanGlobals(text: string): string[] {
  const out = new Set<string>();
  GLOBAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GLOBAL_RE.exec(text)) !== null) {
    out.add(m[1]);
  }
  return [...out];
}
