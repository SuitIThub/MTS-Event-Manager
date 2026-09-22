import * as vscode from 'vscode';
import { findCallsByName } from './callParser';
import { topLevelLabelSpan } from './parseImageCalls';
import { readIdentifier, readStringLiteral } from './scan';
import { DialoguePortraitSite, LabelDefinition, ParsedCall, PersonInfo } from './types';

const SPEECH_METHODS = new Set(['say', 'think', 'whisper', 'shout']);

const SKIP_SPEAKERS = new Set([
  'subtitles',
  'subtitles_Empty',
  'nv_text',
  'extend',
  'nvl',
  'if',
  'elif',
  'else',
  'while',
  'for',
  'return',
  'jump',
  'call',
  'show',
  'hide',
  'scene',
  'play',
  'stop',
  'queue',
  'pause',
  'define',
  'default',
  'label',
  'menu',
  'python',
  'init',
  'image',
  'translate',
  'voice',
  'window',
  'with',
  'style',
  'screen',
  'True',
  'False',
  'None',
]);

const SPEAKER_SUFFIXES = [
  '_whispering',
  '_shouting',
  '_thinking',
  '_whisper',
  '_shout',
  '_thought',
];

const ASSIGN_RE = /^[ \t]*\$[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.+?)\s*$/gm;

const PERSON_INDEX_RE = /Person\s*\[\s*(?:['"]([^'"]+)['"]|([A-Za-z_][A-Za-z0-9_]*)|get_value\s*\(\s*['"]([^'"]+)['"])/;
const GET_PERSON_RE =
  /get_person(?:_char_with_key)?\s*\(\s*['"]([^'"]+)['"]\s*,\s*(?:['"]([^'"]+)['"]|([A-Za-z_][A-Za-z0-9_]*))/;
const GET_PERSON_VALUE_RE = /get_person_(?:value|char)\s*\(\s*['"]([^'"]+)['"]/;
const GET_VALUE_RE = /get_value\s*\(\s*['"]([^'"]+)['"]/;

export interface PersonIndexData {
  byKey: Map<string, PersonInfo>;
  byGroup: Map<string, string[]>;
  aliases: Map<string, string>;
}

type RhsKind = 'person' | 'group' | 'var' | 'selector';

interface AssignmentRhs {
  kind: RhsKind;
  value: string;
}

export function parsePersonsInDocument(text: string): PersonInfo[] {
  const results: PersonInfo[] = [];
  for (const call of findCallsByName(text, new Set(['load_person']))) {
    const positionals = call.args.filter((a) => !a.name);
    if (positionals.length < 2) {
      continue;
    }
    const group = readStringLiteral(positionals[0].text, 0)?.value;
    const personCall = positionals[1].call;
    if (!group || !personCall || personCall.name !== 'Person') {
      continue;
    }
    const personPos = personCall.args.filter((a) => !a.name);
    const key = personPos[0] ? readStringLiteral(personPos[0].text, 0)?.value : undefined;
    const firstName = personPos[1] ? readStringLiteral(personPos[1].text, 0)?.value ?? '' : '';
    const lastName = personPos[2] ? readStringLiteral(personPos[2].text, 0)?.value ?? '' : '';
    if (!key) {
      continue;
    }
    results.push({
      key,
      firstName,
      lastName,
      group,
      paperdollDefaults: readPaperdollDefaults(personCall),
    });
  }
  return results;
}

function readPaperdollDefaults(call: ParsedCall): Record<string, string> | undefined {
  const arg = call.args.find((a) => a.name === 'paperdollDefaults');
  if (!arg) {
    return undefined;
  }
  const out: Record<string, string> = {};
  const re =
    /['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*:\s*(?:(['"])([^'"]*)\2|(-?\d+(?:\.\d+)?))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(arg.text)) !== null) {
    out[m[1]] = m[3] !== undefined ? m[3] : m[4];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseDefaultNames(
  text: string
): { key: string; first: string; last: string }[] {
  const marker = text.indexOf('default_names');
  if (marker < 0) {
    return [];
  }
  const brace = text.indexOf('{', marker);
  if (brace < 0) {
    return [];
  }
  let depth = 0;
  let end = brace;
  for (let i = brace; i < text.length; i++) {
    if (text[i] === '{') {
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const block = text.slice(brace, end + 1);
  const out: { key: string; first: string; last: string }[] = [];
  const re = /['"]([A-Za-z0-9_]+)['"]\s*:\s*\(\s*['"]([^'"]*)['"]\s*,\s*['"]([^'"]*)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    out.push({ key: m[1], first: m[2], last: m[3] });
  }
  return out;
}

export function buildPersonIndex(
  persons: PersonInfo[],
  defaultNames: { key: string; first: string; last: string }[]
): PersonIndexData {
  const byKey = new Map<string, PersonInfo>();
  const byGroup = new Map<string, string[]>();
  for (const p of persons) {
    byKey.set(p.key, p);
    const list = byGroup.get(p.group) ?? [];
    list.push(p.key);
    byGroup.set(p.group, list);
  }

  const aliases = new Map<string, string>();
  aliases.set('headmaster', 'headmaster');
  aliases.set('secretary', 'emiko_langley');
  aliases.set('default_secretary', 'emiko_langley');

  const byFullName = new Map<string, string>();
  for (const p of persons) {
    const k = `${p.firstName.toLowerCase()}|${p.lastName.toLowerCase()}`;
    if (p.firstName && !p.firstName.includes('[')) {
      byFullName.set(k, p.key);
    }
  }
  for (const dn of defaultNames) {
    if (dn.key === 'headmaster') {
      continue;
    }
    if (dn.key === 'secretary') {
      aliases.set('secretary', 'emiko_langley');
      continue;
    }
    const hit = byFullName.get(`${dn.first.toLowerCase()}|${dn.last.toLowerCase()}`);
    if (hit) {
      aliases.set(dn.key, hit);
    }
  }
  return { byKey, byGroup, aliases };
}

export function normalizeSpeakerToken(raw: string): string {
  let s = raw;
  if (s.startsWith('character.')) {
    s = s.slice('character.'.length);
  }
  const dot = s.lastIndexOf('.');
  if (dot > 0 && SPEECH_METHODS.has(s.slice(dot + 1))) {
    s = s.slice(0, dot);
    if (s.startsWith('character.')) {
      s = s.slice('character.'.length);
    }
  }
  for (const suf of SPEAKER_SUFFIXES) {
    if (s.endsWith(suf)) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  return s;
}

export function resolveTokenToPersonKeys(token: string, index: PersonIndexData): string[] {
  const name = normalizeSpeakerToken(token);
  if (!name || SKIP_SPEAKERS.has(name)) {
    return [];
  }
  const aliased = index.aliases.get(name);
  if (aliased && index.byKey.has(aliased)) {
    return [aliased];
  }
  if (index.byKey.has(name)) {
    return [name];
  }
  const group = index.byGroup.get(name);
  if (group && group.length > 0) {
    return [...group];
  }
  return [];
}

export function withExtraPersonKeys(
  index: PersonIndexData,
  keys: Iterable<string>
): PersonIndexData {
  const byKey = new Map(index.byKey);
  let changed = false;
  for (const key of keys) {
    if (!key || byKey.has(key)) {
      continue;
    }
    byKey.set(key, { key, firstName: key, lastName: '', group: 'custom' });
    changed = true;
  }
  return changed ? { byKey, byGroup: index.byGroup, aliases: index.aliases } : index;
}

export function personDisplayName(key: string, index: PersonIndexData): string {
  if (key === 'headmaster') {
    return 'Headmaster';
  }
  const p = index.byKey.get(key);
  if (!p) {
    return key;
  }
  if (p.firstName.includes('[')) {
    return key === 'headmaster' ? 'Headmaster' : key;
  }
  return `${p.firstName} ${p.lastName}`.trim() || key;
}

export function mergeSelectorValues(
  events: { selectorValues: Record<string, string[]> }[]
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const ev of events) {
    for (const [key, values] of Object.entries(ev.selectorValues ?? {})) {
      const set = new Set(out[key] ?? []);
      for (const v of values) {
        set.add(v);
      }
      out[key] = [...set];
    }
  }
  return out;
}

function parseRhs(rhs: string): AssignmentRhs | undefined {
  const person = PERSON_INDEX_RE.exec(rhs);
  if (person) {
    if (person[1]) {
      return { kind: 'person', value: person[1] };
    }
    if (person[3]) {
      return { kind: 'selector', value: person[3] };
    }
    if (person[2]) {
      return { kind: 'var', value: person[2] };
    }
  }
  const getPerson = GET_PERSON_RE.exec(rhs);
  if (getPerson) {
    if (getPerson[2]) {
      return { kind: 'person', value: getPerson[2] };
    }
    if (getPerson[3]) {
      return { kind: 'var', value: getPerson[3] };
    }
  }
  const getPersonVal = GET_PERSON_VALUE_RE.exec(rhs);
  if (getPersonVal) {
    return { kind: 'selector', value: getPersonVal[1] };
  }
  const getValue = GET_VALUE_RE.exec(rhs);
  if (getValue) {
    return { kind: 'selector', value: getValue[1] };
  }
  return undefined;
}

function assignmentsInSpan(
  text: string,
  startLine: number,
  endLine: number
): Map<string, { line: number; rhs: AssignmentRhs }[]> {
  const out = new Map<string, { line: number; rhs: AssignmentRhs }[]>();
  const lines = text.split('\n');
  const last = Math.min(endLine, lines.length - 1);
  for (let line = startLine; line <= last; line++) {
    ASSIGN_RE.lastIndex = 0;
    const m = ASSIGN_RE.exec(lines[line]);
    if (!m) {
      continue;
    }
    const rhs = parseRhs(m[2]);
    if (!rhs) {
      continue;
    }
    const list = out.get(m[1]) ?? [];
    list.push({ line, rhs });
    out.set(m[1], list);
  }
  return out;
}

function unique(keys: string[]): string[] {
  return [...new Set(keys)];
}

function resolveName(
  name: string,
  ctx: {
    index: PersonIndexData;
    assignments: Map<string, { line: number; rhs: AssignmentRhs }[]>;
    selectorValues: Record<string, string[]>;
    beforeLine: number;
  },
  visiting: Set<string>
): string[] {
  if (!name || visiting.has(name)) {
    return [];
  }
  visiting.add(name);

  const direct = resolveTokenToPersonKeys(name, ctx.index);
  if (direct.length > 0) {
    return direct;
  }

  const fromAssign: string[] = [];
  for (const entry of ctx.assignments.get(name) ?? []) {
    if (entry.line > ctx.beforeLine) {
      continue;
    }
    fromAssign.push(...resolveRhs(entry.rhs, ctx, visiting));
  }
  if (fromAssign.length > 0) {
    return unique(fromAssign);
  }

  return unique(
    (ctx.selectorValues[name] ?? []).flatMap((v) => resolveTokenToPersonKeys(v, ctx.index))
  );
}

function resolveRhs(
  rhs: AssignmentRhs,
  ctx: {
    index: PersonIndexData;
    assignments: Map<string, { line: number; rhs: AssignmentRhs }[]>;
    selectorValues: Record<string, string[]>;
    beforeLine: number;
  },
  visiting: Set<string>
): string[] {
  if (rhs.kind === 'person' || rhs.kind === 'group') {
    return resolveTokenToPersonKeys(rhs.value, ctx.index);
  }
  if (rhs.kind === 'selector') {
    const fromSel = (ctx.selectorValues[rhs.value] ?? []).flatMap((v) =>
      resolveTokenToPersonKeys(v, ctx.index)
    );
    if (fromSel.length > 0) {
      return unique(fromSel);
    }
    return resolveName(rhs.value, ctx, visiting);
  }
  return resolveName(rhs.value, ctx, visiting);
}

export function parseDialoguePortraitSites(
  text: string,
  labels: LabelDefinition[],
  personIndex: PersonIndexData,
  selectorValuesForLine: (line: number) => Record<string, string[]>
): DialoguePortraitSite[] {
  const sites: DialoguePortraitSite[] = [];
  const lines = text.split('\n');
  const assignCache = new Map<string, Map<string, { line: number; rhs: AssignmentRhs }[]>>();

  for (let line = 0; line < lines.length; line++) {
    const raw = lines[line];
    const trimmedStart = raw.match(/^[ \t]*/)?.[0].length ?? 0;
    const body = raw.slice(trimmedStart);
    if (!body || body.startsWith('#') || body.startsWith('$')) {
      continue;
    }
    const ident = readIdentifier(body, 0);
    if (!ident) {
      continue;
    }
    let end = ident.end;
    let chain = ident.name;
    while (end < body.length && body[end] === '.') {
      const next = readIdentifier(body, end + 1);
      if (!next) {
        break;
      }
      chain += '.' + next.name;
      end = next.end;
    }
    let i = end;
    while (i < body.length && (body[i] === ' ' || body[i] === '\t')) {
      i++;
    }
    const quote = body[i];
    if (quote !== '"' && quote !== "'") {
      continue;
    }

    const firstName = ident.name;
    if (SKIP_SPEAKERS.has(firstName)) {
      continue;
    }
    const token = normalizeSpeakerToken(chain);
    if (!token || SKIP_SPEAKERS.has(token)) {
      continue;
    }

    const span = topLevelLabelSpan(labels, line);
    const cacheKey = `${span.startLine}:${span.endLine}`;
    let assignments = assignCache.get(cacheKey);
    if (!assignments) {
      assignments = assignmentsInSpan(text, span.startLine, span.endLine);
      assignCache.set(cacheKey, assignments);
    }

    const personKeys = resolveName(
      token,
      {
        index: personIndex,
        assignments,
        selectorValues: selectorValuesForLine(line),
        beforeLine: line,
      },
      new Set()
    );

    const resolved = unique(
      personKeys.flatMap((k) => {
        const mapped = personIndex.aliases.get(k);
        return mapped ? [mapped] : [k];
      })
    )
      .filter((k) => personIndex.byKey.has(k))
      .sort();

    if (resolved.length === 0) {
      continue;
    }

    const startChar = trimmedStart;
    sites.push({
      range: new vscode.Range(line, startChar, line, startChar + ident.name.length),
      personKeys: resolved,
    });
  }
  return sites;
}
