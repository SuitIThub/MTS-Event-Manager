import * as vscode from 'vscode';
import { findCallsByName } from './callParser';
import { topLevelLabelSpan } from './parseImageCalls';
import { readIdentifier, readStringLiteral } from './scan';
import { DialoguePortraitSite, LabelDefinition, ParsedCall, PersonInfo } from './types';

const SPEECH_METHODS = new Set(['say', 'think', 'whisper', 'shout']);

/**
 * Statement/control-flow keywords that can look like `ident "..."` but are never a
 * speaker. Unlike SKIP_SPEAKERS this keeps narrator-ish speakers (subtitles, nvl, …)
 * so the timeline can show them as dialogue; the portrait pass drops them separately
 * because they resolve to no person.
 */
const STRUCTURAL_KEYWORDS = new Set([
  'if', 'elif', 'else', 'while', 'for', 'return', 'jump', 'call', 'show', 'hide',
  'scene', 'play', 'stop', 'queue', 'pause', 'define', 'default', 'label', 'menu',
  'python', 'init', 'image', 'translate', 'voice', 'window', 'with', 'style',
  'screen', 'True', 'False', 'None',
]);

export interface SayStatement {
  line: number;
  /** Column where the speaker identifier starts. */
  startChar: number;
  /** First identifier (before any `.method`), e.g. `emiko`, `subtitles`. */
  firstIdent: string;
  /** Full speaker chain, e.g. `emiko.say` or `character.subtitles`. */
  chain: string;
  /** The spoken text (first string literal on the line). */
  text: string;
}

/**
 * Scan every `speaker "text"` say-statement in the document. Shared by the portrait
 * decorator and the event timeline. Skips comments, `$`-lines and structural keywords;
 * keeps narrator speakers like `subtitles`.
 */
export function scanSayStatements(
  text: string,
  range?: { start: number; end: number }
): SayStatement[] {
  const out: SayStatement[] = [];
  const lines = text.split('\n');
  const from = range ? Math.max(0, range.start) : 0;
  const to = range ? Math.min(lines.length, range.end) : lines.length;
  for (let line = from; line < to; line++) {
    const raw = lines[line];
    const indent = raw.match(/^[ \t]*/)?.[0].length ?? 0;
    const body = raw.slice(indent);
    if (!body || body.startsWith('#') || body.startsWith('$')) {
      continue;
    }
    const ident = readIdentifier(body, 0);
    if (!ident) {
      continue;
    }
    if (STRUCTURAL_KEYWORDS.has(ident.name)) {
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
    if (body[i] !== '"' && body[i] !== "'") {
      continue;
    }
    const lit = readStringLiteral(body, i);
    out.push({
      line,
      startChar: indent,
      firstIdent: ident.name,
      chain,
      text: lit?.value ?? '',
    });
  }
  return out;
}

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

export const SPEECH_TYPES = ['say', 'think', 'shout', 'whisper'] as const;
export type SpeechType = (typeof SPEECH_TYPES)[number];

const SUFFIX_TYPE: Record<string, SpeechType> = {
  _whispering: 'whisper',
  _whisper: 'whisper',
  _shouting: 'shout',
  _shout: 'shout',
  _thinking: 'think',
  _thought: 'think',
};

/** Split a speaker chain into its bare speaker variable and its dialogue type. */
export function parseSpeakerChain(chain: string): { speaker: string; type: SpeechType } {
  let s = chain;
  if (s.startsWith('character.')) {
    s = s.slice('character.'.length);
  }
  const dot = s.lastIndexOf('.');
  if (dot > 0 && SPEECH_METHODS.has(s.slice(dot + 1))) {
    return { speaker: s.slice(0, dot), type: s.slice(dot + 1) as SpeechType };
  }
  for (const suf of SPEAKER_SUFFIXES) {
    if (s.endsWith(suf)) {
      return { speaker: s.slice(0, -suf.length), type: SUFFIX_TYPE[suf] };
    }
  }
  return { speaker: s, type: 'say' };
}

/** Rebuild a speaker chain from a variable and a dialogue type (method form). */
export function buildSpeakerChain(variable: string, type: SpeechType): string {
  if (variable === 'subtitles' || variable === 'subtitles_Empty' || variable === 'nv_text') {
    return variable;
  }
  return type === 'say' ? variable : `${variable}.${type}`;
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

/** Last span's assignments; the timeline asks for the same span once per dialogue line. */
let assignMemo: { text: string; start: number; end: number; result: Map<string, { line: number; rhs: AssignmentRhs }[]> } | undefined;

function assignmentsInSpan(
  text: string,
  startLine: number,
  endLine: number
): Map<string, { line: number; rhs: AssignmentRhs }[]> {
  if (assignMemo && assignMemo.text === text && assignMemo.start === startLine && assignMemo.end === endLine) {
    return assignMemo.result;
  }
  const result = computeAssignmentsInSpan(text, startLine, endLine);
  assignMemo = { text, start: startLine, end: endLine, result };
  return result;
}

function computeAssignmentsInSpan(
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
  const assignCache = new Map<string, Map<string, { line: number; rhs: AssignmentRhs }[]>>();

  for (const say of scanSayStatements(text)) {
    if (SKIP_SPEAKERS.has(say.firstIdent)) {
      continue;
    }
    const token = normalizeSpeakerToken(say.chain);
    if (!token || SKIP_SPEAKERS.has(token)) {
      continue;
    }

    const span = topLevelLabelSpan(labels, say.line);
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
        selectorValues: selectorValuesForLine(say.line),
        beforeLine: say.line,
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

    sites.push({
      range: new vscode.Range(say.line, say.startChar, say.line, say.startChar + say.firstIdent.length),
      personKeys: resolved,
    });
  }
  return sites;
}

/** variable → personKey for direct `Person[...]` / `get_person(...)` loads in the event label. */
export function eventCharacterBindings(
  text: string,
  labels: LabelDefinition[],
  index: PersonIndexData,
  line: number
): Map<string, string> {
  const span = topLevelLabelSpan(labels, line);
  const assigns = assignmentsInSpan(text, span.startLine, span.endLine);
  const out = new Map<string, string>();
  for (const [variable, entries] of assigns) {
    const rhs = entries[entries.length - 1]?.rhs;
    if (!rhs || rhs.kind !== 'person') {
      continue;
    }
    const key = index.byKey.has(rhs.value) ? rhs.value : resolveTokenToPersonKeys(rhs.value, index)[0];
    if (key) {
      out.set(variable, key);
    }
  }
  return out;
}

const BEGIN_EVENT_LINE_RE = /^[ \t]*\$?[ \t]*begin_event\s*\(/;
const CHAR_LOAD_LINE_RE =
  /^[ \t]*\$[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*.*(?:Person\s*\[|get_person(?:_char_with_key)?\s*\()/;

/**
 * Where to add a new `$ x = Person[...]` character load: after the last existing load in
 * the block below `begin_event`, else right after `begin_event`.
 */
export function findCharacterLoadInsert(
  text: string,
  labels: LabelDefinition[],
  line: number
): { line: number; blankBefore: boolean; indent: string } {
  const span = topLevelLabelSpan(labels, line);
  const lines = text.split('\n');
  const last = Math.min(span.endLine, lines.length - 1);
  let beginLine = -1;
  for (let i = span.startLine; i <= last; i++) {
    if (BEGIN_EVENT_LINE_RE.test(lines[i] ?? '')) {
      beginLine = i;
      break;
    }
  }
  const from = beginLine >= 0 ? beginLine + 1 : span.startLine;
  let lastLoad = -1;
  for (let i = from; i <= last; i++) {
    const row = lines[i] ?? '';
    if (row.trim() === '' || row.trim().startsWith('#')) {
      continue;
    }
    if (CHAR_LOAD_LINE_RE.test(row)) {
      lastLoad = i;
      continue;
    }
    break;
  }
  const anchor = lastLoad >= 0 ? lastLoad : beginLine >= 0 ? beginLine : span.startLine;
  const indent = /^[ \t]*/.exec(lines[anchor] ?? '')?.[0] ?? '    ';
  return { line: anchor, blankBefore: lastLoad < 0, indent };
}

/** Resolve a speaker chain on a specific line to person keys (for the timeline). */
export function resolveSpeakerPersonKeys(
  text: string,
  labels: LabelDefinition[],
  personIndex: PersonIndexData,
  chain: string,
  line: number,
  selectorValues: Record<string, string[]>
): string[] {
  const token = normalizeSpeakerToken(chain);
  if (!token) {
    return [];
  }
  const span = topLevelLabelSpan(labels, line);
  const assignments = assignmentsInSpan(text, span.startLine, span.endLine);
  const personKeys = resolveName(
    token,
    { index: personIndex, assignments, selectorValues, beforeLine: line },
    new Set()
  );
  return unique(
    personKeys.flatMap((k) => {
      const mapped = personIndex.aliases.get(k);
      return mapped ? [mapped] : [k];
    })
  )
    .filter((k) => personIndex.byKey.has(k))
    .sort();
}
