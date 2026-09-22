import { parseCallAt } from './callParser';
import { labelAtLine, topLevelLabelSpan } from './parseImageCalls';
import { PersonIndexData } from './parsePersons';
import {
  applyMoves,
  DEFAULT_CONFIG,
  DEFAULT_INCLUDE,
  expandPresetMoves,
  formatNum,
  HOUSE_ALT_KEYS,
  HOUSE_VALUES,
  IMAGE_FIELDS,
  ImageField,
  mergedValues,
  MoveSpec,
  near,
  parsePaperdollColor,
  PdConfig,
  presetMatching,
  PresetDef,
} from './paperdollResolve';
import { findMatching, offsetToPosition, readStringLiteral } from './scan';
import { LabelDefinition, ParsedArg, ParsedCall } from './types';

export interface DollRuntime {
  variable: string;
  personKey: string;
  values: Record<string, string>;
  config: PdConfig;
  altKeys: string[];
  hidden: boolean;
}

export interface BackgroundRef {
  kind: 'none' | 'path' | 'series' | 'split';
  path?: string;
  variable?: string;
  step?: number;
  patternKey?: string;
  blur: boolean;
  left?: BackgroundRef;
  right?: BackgroundRef;
}

export interface SceneState {
  dolls: DollRuntime[];
  background: BackgroundRef;
  presets: Map<string, PresetDef>;
  bindings: Map<string, string>;
}

export type PdAction =
  | { kind: 'image'; fields: Record<string, string>; raw: string }
  | { kind: 'move'; alignX?: string; alignY?: string; zoom?: string; duration?: string; raw: string }
  | { kind: 'preset'; name: string; duration?: string; alignX?: string; alignY?: string; zoom?: string; raw: string }
  | { kind: 'flip'; flipped: boolean; raw: string }
  | { kind: 'blur'; blur: string; raw: string }
  | { kind: 'bw'; bw: boolean; raw: string }
  | { kind: 'color'; color: string; raw: string }
  | { kind: 'shake'; raw: string }
  | { kind: 'pause'; raw: string }
  | { kind: 'other'; raw: string };

export interface PaperdollCallSite {
  kind: 'display' | 'register';
  start: number;
  end: number;
  line: number;
  indent: string;
  /** `emiko.display` or `paperdoll_manager.display`. */
  form: 'method' | 'manager';
  variable: string;
  actions: PdAction[];
  /** Positional args kept on register (PaperdollOverride, …). */
  preserved: string[];
  /** Raw first argument of `paperdoll_manager.display`, usually a string key. */
  managerKey?: string;
}

export interface PaperdollAnalysis {
  scene: SceneState;
  beforeDoll?: DollRuntime;
  call?: PaperdollCallSite;
  bindings: Map<string, string>;
}

interface StmtBase {
  start: number;
  end: number;
  line: number;
}

type Stmt =
  | (StmtBase & { type: 'assign'; variable: string; personKey: string })
  | (StmtBase & { type: 'register'; site: PaperdollCallSite; kwargs: Record<string, string> })
  | (StmtBase & { type: 'display'; site: PaperdollCallSite })
  | (StmtBase & { type: 'clear' })
  | (StmtBase & { type: 'unload' })
  | (StmtBase & { type: 'hide'; ref: string })
  | (StmtBase & { type: 'background'; background: BackgroundRef })
  | (StmtBase & { type: 'preset'; name: string; def: PresetDef });

const NONE_BG: BackgroundRef = { kind: 'none', blur: false };

export function analyzePaperdoll(
  text: string,
  labels: LabelDefinition[],
  line: number,
  character: number,
  persons: PersonIndexData
): PaperdollAnalysis {
  const offset = positionToOffset(text, line, character);
  const stmts = parsePaperdollStatements(text, labels);
  const call = stmts
    .map((s) => (s.type === 'display' || s.type === 'register' ? s.site : undefined))
    .filter((s): s is PaperdollCallSite => !!s)
    .find((s) => offset >= s.start && offset < s.end) ??
    stmts
      .map((s) => (s.type === 'display' || s.type === 'register' ? s.site : undefined))
      .filter((s): s is PaperdollCallSite => !!s)
      .find((s) => s.line === line);

  const region = regionFor(labels, line);
  const exclusive = call ? call.end : offset;
  const scene = emptyScene();
  let beforeDoll: DollRuntime | undefined;

  const run = (startLine: number, endLine: number, branchTarget: number, until: number) => {
    const inactive = inactiveLines(text, startLine, endLine, branchTarget);
    for (const stmt of stmts) {
      if (stmt.line < startLine || stmt.line >= endLine) {
        continue;
      }
      if (stmt.end > until) {
        continue;
      }
      if (inactive.has(stmt.line)) {
        continue;
      }
      if (call && stmt.start === call.start && (stmt.type === 'display' || stmt.type === 'register')) {
        beforeDoll = dollBefore(scene, stmt, persons);
      }
      applyStmt(scene, stmt, persons);
    }
  };

  if (region.sub) {
    const parentTarget = Math.max(region.parentStart, region.parentEnd - 1);
    run(region.parentStart, region.parentEnd, parentTarget, Number.MAX_SAFE_INTEGER);
    run(region.sub.start, region.sub.end, line, exclusive);
  } else {
    run(region.parentStart, region.parentEnd, line, exclusive);
  }

  return { scene, beforeDoll, call, bindings: scene.bindings };
}

export function paperdollLensSites(text: string): PaperdollCallSite[] {
  return parsePaperdollStatements(text, []).flatMap((s) =>
    s.type === 'display' || s.type === 'register' ? [s.site] : []
  );
}

export interface RegisterInsertPlan {
  duplicate: boolean;
  /** Line whose indent the new call copies. */
  indentLine: number;
  /** Insert at column 0 of `line`, or at the end of `line`. */
  mode: 'before-line' | 'after-line';
  line: number;
  /** Put a blank line between `begin_event` and the first register. */
  blankBefore: boolean;
}

const BEGIN_EVENT_RE = /^[ \t]*\$?[ \t]*begin_event\s*\(/;
const REGISTER_CALL_RE = /^[ \t]*\$?[ \t]*([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*register_paperdoll\s*\(/;

/**
 * Registers belong in one block directly under the event's `begin_event`:
 * one blank line, then each register on its own line. A variable that already
 * has a register anywhere in the label is left alone.
 */
export function findRegisterInsert(
  text: string,
  labels: LabelDefinition[],
  cursorLine: number,
  variable: string
): RegisterInsertPlan | undefined {
  const lines = text.split('\n');
  const span = topLevelLabelSpan(labels, cursorLine);
  const last = Math.min(span.endLine, lines.length - 1);
  for (let i = span.startLine; i <= last; i++) {
    const match = REGISTER_CALL_RE.exec(lines[i] ?? '');
    if (match && match[1] === variable) {
      return { duplicate: true, indentLine: i, mode: 'after-line', line: i, blankBefore: false };
    }
  }
  let begin = -1;
  let firstAfter = -1;
  for (let i = span.startLine; i <= last; i++) {
    if (!BEGIN_EVENT_RE.test(lines[i] ?? '')) {
      continue;
    }
    if (i <= cursorLine) {
      begin = i;
    } else if (firstAfter < 0) {
      firstAfter = i;
    }
  }
  if (begin < 0) {
    begin = firstAfter;
  }
  if (begin < 0) {
    return undefined;
  }
  const indent = /^[ \t]*/.exec(lines[begin] ?? '')?.[0] ?? '';
  let lastRegister = -1;
  let i = begin + 1;
  while (i <= last) {
    const row = lines[i] ?? '';
    if (row.trim() === '') {
      if (lastRegister < 0) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j <= last && (lines[j] ?? '').trim() === '') {
        j++;
      }
      if (j <= last && isHeaderRegister(lines[j] ?? '', indent)) {
        i = j;
        continue;
      }
      break;
    }
    if (!isHeaderRegister(row, indent)) {
      break;
    }
    lastRegister = statementEndLine(lines, i, last);
    i = lastRegister + 1;
  }
  if (lastRegister >= 0) {
    return { duplicate: false, indentLine: begin, mode: 'after-line', line: lastRegister, blankBefore: false };
  }
  const next = begin + 1;
  if (next <= last && (lines[next] ?? '').trim() === '') {
    return { duplicate: false, indentLine: begin, mode: 'before-line', line: next + 1, blankBefore: false };
  }
  return { duplicate: false, indentLine: begin, mode: 'before-line', line: next, blankBefore: true };
}

function isHeaderRegister(row: string, indent: string): boolean {
  const match = REGISTER_CALL_RE.exec(row);
  if (!match) {
    return false;
  }
  return (/^[ \t]*/.exec(row)?.[0] ?? '') === indent;
}

function statementEndLine(lines: string[], start: number, end: number): number {
  let depth = 0;
  let started = false;
  for (let i = start; i <= end; i++) {
    for (const ch of lines[i] ?? '') {
      if (ch === '(') {
        depth++;
        started = true;
      } else if (ch === ')') {
        depth--;
      }
    }
    if (started && depth <= 0) {
      return i;
    }
  }
  return start;
}

export interface CursorInsertPlan {
  insideDisplay: boolean;
  start: number;
  end: number;
  insertion: string;
  anchorLine: number;
  anchorCharacter: number;
}

/** Inside a display call, insert only the actions. Otherwise insert a full display statement. */
export function planCursorInsert(
  text: string,
  line: number,
  character: number,
  args: string[],
  statement: string
): CursorInsertPlan | undefined {
  if (args.length === 0) {
    return undefined;
  }
  const offset = positionToOffset(text, line, character);
  const call = paperdollLensSites(text).find(
    (site) => site.kind === 'display' && offset >= site.start && offset < site.end
  );
  if (call) {
    return {
      insideDisplay: true,
      start: offset,
      end: offset,
      insertion: spliceCallArgs(text, offset, args.join(', ')),
      anchorLine: call.line,
      anchorCharacter: 0,
    };
  }
  const lines = text.split('\n');
  const row = lines[line] ?? '';
  const indent = (/^[ \t]*/.exec(row)?.[0] || nearbyIndent(lines, line));
  const lineStart = positionToOffset(text, line, 0);
  if (row.trim() === '') {
    const lineEnd = positionToOffset(text, line, row.length);
    return {
      insideDisplay: false,
      start: lineStart,
      end: lineEnd,
      insertion: `${indent}$ ${statement}`,
      anchorLine: line,
      anchorCharacter: indent.length + 2,
    };
  }
  if (character >= row.trimEnd().length) {
    return {
      insideDisplay: false,
      start: positionToOffset(text, line, row.length),
      end: positionToOffset(text, line, row.length),
      insertion: `\n${indent}$ ${statement}`,
      anchorLine: line + 1,
      anchorCharacter: indent.length + 2,
    };
  }
  return {
    insideDisplay: false,
    start: offset,
    end: offset,
    insertion: `\n${indent}$ ${statement}\n`,
    anchorLine: line + 1,
    anchorCharacter: indent.length + 2,
  };
}

function spliceCallArgs(text: string, offset: number, args: string): string {
  let i = offset - 1;
  while (i >= 0 && /\s/.test(text[i])) {
    i--;
  }
  const prev = i >= 0 ? text[i] : '';
  let j = offset;
  while (j < text.length && /\s/.test(text[j])) {
    j++;
  }
  const next = j < text.length ? text[j] : '';
  const lead = prev && prev !== '(' && prev !== ',' ? ', ' : '';
  const trail = next && next !== ')' && next !== ',' ? ', ' : '';
  return `${lead}${args}${trail}`;
}

function nearbyIndent(lines: string[], line: number): string {
  for (let i = line - 1; i >= 0; i--) {
    const row = lines[i] ?? '';
    if (row.trim()) {
      return /^[ \t]*/.exec(row)?.[0] ?? '    ';
    }
  }
  for (let i = line + 1; i < lines.length; i++) {
    const row = lines[i] ?? '';
    if (row.trim()) {
      return /^[ \t]*/.exec(row)?.[0] ?? '    ';
    }
  }
  return '    ';
}

export function includeForCall(call: PaperdollCallSite | undefined): Record<ImageField, boolean> {
  if (!call) {
    return { ...DEFAULT_INCLUDE };
  }
  if (call.kind === 'register') {
    const out = Object.fromEntries(IMAGE_FIELDS.map((f) => [f, false])) as Record<ImageField, boolean>;
    const imageKeys = new Set(IMAGE_FIELDS as readonly string[]);
    for (const action of call.actions) {
      if (action.kind === 'image') {
        for (const key of Object.keys(action.fields)) {
          if (imageKeys.has(key)) {
            out[key as ImageField] = true;
          }
        }
      }
    }
    return out;
  }
  const image = call.actions.find((a) => a.kind === 'image');
  if (!image || image.kind !== 'image') {
    return Object.fromEntries(IMAGE_FIELDS.map((f) => [f, false])) as Record<ImageField, boolean>;
  }
  const out = Object.fromEntries(IMAGE_FIELDS.map((f) => [f, false])) as Record<ImageField, boolean>;
  for (const key of Object.keys(image.fields)) {
    if ((IMAGE_FIELDS as readonly string[]).includes(key)) {
      out[key as ImageField] = true;
    }
  }
  return out;
}

export function durationOf(actions: PdAction[]): number {
  for (const action of actions) {
    if ((action.kind === 'move' || action.kind === 'preset') && action.duration) {
      const n = Number(stripQuotes(action.duration));
      if (Number.isFinite(n) && n >= 0 && n < 30) {
        return n;
      }
    }
  }
  return 0;
}

export function formatPyValue(key: string, value: string): string {
  if ((key === 'level' || key === 'char_var') && /^-?\d+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function formatImageAction(
  include: Record<string, boolean>,
  values: Record<string, string>
): string | undefined {
  const parts: string[] = [];
  for (const key of IMAGE_FIELDS) {
    if (!include[key]) {
      continue;
    }
    parts.push(`${key} = ${formatPyValue(key, values[key] ?? '')}`);
  }
  return parts.length > 0 ? `PDAImage(${parts.join(', ')})` : undefined;
}

export function formatFraming(
  before: PdConfig,
  desired: PdConfig,
  duration: number,
  presets?: Map<string, PresetDef>
): string | undefined {
  if (
    near(before.alignX, desired.alignX) &&
    near(before.alignY, desired.alignY) &&
    near(before.zoom, desired.zoom)
  ) {
    return undefined;
  }
  const preset = presetMatching(before, desired, presets);
  if (preset) {
    return duration > 0
      ? `PDAPreset("${preset}", duration = ${formatNum(duration)})`
      : `"${preset}"`;
  }
  const parts: string[] = [];
  if (!near(before.alignX, desired.alignX)) {
    parts.push(`alignX = ${formatNum(desired.alignX)}`);
  }
  if (!near(before.alignY, desired.alignY)) {
    parts.push(`alignY = ${formatNum(desired.alignY)}`);
  }
  if (!near(before.zoom, desired.zoom)) {
    parts.push(`zoom = ${formatNum(desired.zoom)}`);
  }
  if (duration > 0) {
    parts.push(`duration = ${formatNum(duration)}`);
  }
  return parts.length > 0 ? `PDAMove(${parts.join(', ')})` : undefined;
}

export function renderRegisterText(
  call: PaperdollCallSite | undefined,
  variable: string,
  include: Record<string, boolean>,
  values: Record<string, string>,
  personDefaults: Record<string, string> | undefined,
  indent: string
): string {
  const args = registerArgs(call, include, values, personDefaults);
  return joinCall(variable, 'register_paperdoll', args, indent);
}

export function renderCallText(
  call: PaperdollCallSite | undefined,
  variable: string,
  include: Record<string, boolean>,
  values: Record<string, string>,
  config: PdConfig,
  duration: number,
  before: PdConfig | undefined,
  presets: Map<string, PresetDef> | undefined,
  indent: string,
  personDefaults?: Record<string, string>
): { text: string; framingSkipped: boolean } {
  const prior = before ?? { ...DEFAULT_CONFIG };
  if (!call || call.kind === 'register') {
    return {
      text: renderRegisterText(call, variable, include, values, personDefaults, indent),
      framingSkipped: false,
    };
  }
  const built = buildDisplayArgs(call.actions, include, values, config, duration, prior, presets);
  if (call.form === 'manager') {
    const key = call.managerKey ?? `"${variable}"`;
    return {
      text: joinCall('paperdoll_manager', 'display', [key, ...built.args], indent),
      framingSkipped: built.framingSkipped,
    };
  }
  return {
    text: joinCall(variable, 'display', built.args, indent),
    framingSkipped: built.framingSkipped,
  };
}

function registerArgs(
  call: PaperdollCallSite | undefined,
  include: Record<string, boolean>,
  values: Record<string, string>,
  baseline: Record<string, string> | undefined
): string[] {
  const preserved = call?.kind === 'register' ? call.preserved : [];
  const parts = [...preserved];
  const base = { ...HOUSE_VALUES, ...(baseline ?? {}) };
  for (const key of IMAGE_FIELDS) {
    if (!include[key]) {
      continue;
    }
    if (String(values[key] ?? '') === String(base[key] ?? '')) {
      continue;
    }
    parts.push(`${key} = ${formatPyValue(key, values[key] ?? '')}`);
  }
  return parts;
}

export function buildDisplayArgs(
  actions: PdAction[],
  include: Record<string, boolean>,
  values: Record<string, string>,
  config: PdConfig,
  duration: number,
  before: PdConfig,
  presets?: Map<string, PresetDef>
): { args: string[]; framingSkipped: boolean } {
  const framingCount = actions.filter((a) => a.kind === 'move' || a.kind === 'preset').length;
  const simple = framingCount <= 1 && !actions.some((a) => a.kind === 'pause');
  const image = formatImageAction(include, values);
  const flipText = near(before.flip, config.flip)
    ? undefined
    : `PDAFlip(${config.flip < 0 ? 'True' : 'False'})`;
  const framing = simple ? formatFraming(before, config, duration, presets) : undefined;
  const framingSkipped = !simple && !!formatFraming(before, config, duration, presets);
  const args: string[] = [];
  let imageDone = false;
  let flipDone = false;
  let frameDone = false;
  for (const action of actions) {
    if (action.kind === 'image') {
      if (image) {
        args.push(image);
      }
      imageDone = true;
      continue;
    }
    if (action.kind === 'flip') {
      if (flipText) {
        args.push(flipText);
      }
      flipDone = true;
      continue;
    }
    if (action.kind === 'move' || action.kind === 'preset') {
      if (!simple) {
        args.push(action.raw);
      } else if (!frameDone) {
        if (framing) {
          args.push(framing);
        }
        frameDone = true;
      }
      continue;
    }
    args.push(action.raw);
  }
  if (!imageDone && image) {
    args.unshift(image);
  }
  if (!flipDone && flipText) {
    const at = args.findIndex((a) => a.startsWith('PDAImage'));
    args.splice(at >= 0 ? at + 1 : 0, 0, flipText);
  }
  if (simple && !frameDone && framing) {
    args.push(framing);
  }
  return { args, framingSkipped };
}

export function joinCall(receiver: string, method: string, args: string[], indent: string): string {
  return joinArgs(`${receiver}.${method}(`, args, indent);
}

function joinArgs(head: string, args: string[], indent: string): string {
  const one = `${head}${args.join(', ')})`;
  if (args.length <= 1 || one.length <= 110) {
    return one;
  }
  const cont = `${indent}    `;
  return `${head}${args.join(',\n' + cont)})`;
}

export function guessVariable(
  personKey: string,
  bindings: Map<string, string>,
  persons: PersonIndexData
): string {
  for (const [variable, key] of bindings) {
    if (key === personKey) {
      return variable;
    }
  }
  if (personKey === 'emiko_langley') {
    return 'emiko';
  }
  const person = persons.byKey.get(personKey);
  if (person?.firstName && /^[A-Za-z_][A-Za-z0-9_]*$/.test(person.firstName)) {
    const lower = person.firstName.toLowerCase();
    const taken = bindings.get(lower);
    if (!taken || taken === personKey) {
      return lower;
    }
  }
  return personKey;
}

export function resolveVariablePerson(
  variable: string,
  bindings: Map<string, string>,
  persons: PersonIndexData
): string | undefined {
  const bound = bindings.get(variable);
  if (bound) {
    return bound;
  }
  if (variable === 'emiko' || variable === 'secretary' || variable === 'default_secretary') {
    return 'emiko_langley';
  }
  const alias = persons.aliases.get(variable);
  if (alias) {
    return alias;
  }
  if (persons.byKey.has(variable)) {
    return variable;
  }
  const hits = [...persons.byKey.values()].filter(
    (p) => p.firstName.toLowerCase() === variable.toLowerCase()
  );
  return hits.length === 1 ? hits[0].key : undefined;
}

function emptyScene(): SceneState {
  return {
    dolls: [],
    background: { ...NONE_BG },
    presets: new Map(),
    bindings: new Map(),
  };
}

function dollBefore(scene: SceneState, stmt: Stmt, persons: PersonIndexData): DollRuntime | undefined {
  if (stmt.type !== 'display' && stmt.type !== 'register') {
    return undefined;
  }
  const ref = stmt.site.form === 'manager' ? stripQuotes(stmt.site.managerKey ?? stmt.site.variable) : stmt.site.variable;
  const existing = findDoll(scene, ref, persons);
  if (existing) {
    return cloneDoll(existing);
  }
  const personKey = resolveVariablePerson(ref, scene.bindings, persons) ?? ref;
  const defaults = persons.byKey.get(personKey)?.paperdollDefaults;
  return {
    variable: ref,
    personKey,
    values: mergedValues(defaults, undefined),
    config: { ...DEFAULT_CONFIG },
    altKeys: [...HOUSE_ALT_KEYS],
    hidden: true,
  };
}

function cloneDoll(doll: DollRuntime): DollRuntime {
  return {
    ...doll,
    values: { ...doll.values },
    config: { ...doll.config },
    altKeys: [...doll.altKeys],
  };
}

function applyStmt(scene: SceneState, stmt: Stmt, persons: PersonIndexData): void {
  switch (stmt.type) {
    case 'assign':
      scene.bindings.set(stmt.variable, stmt.personKey);
      return;
    case 'preset':
      scene.presets.set(stmt.name, stmt.def);
      return;
    case 'clear':
      for (const doll of scene.dolls) {
        doll.hidden = true;
      }
      scene.background = { ...NONE_BG };
      return;
    case 'unload':
      scene.dolls = [];
      scene.background = { ...NONE_BG };
      scene.presets.clear();
      return;
    case 'hide': {
      const doll = findDoll(scene, stmt.ref, persons);
      if (doll) {
        doll.hidden = true;
      }
      return;
    }
    case 'background':
      scene.background = stmt.background;
      return;
    case 'register': {
      const personKey =
        resolveVariablePerson(stmt.site.variable, scene.bindings, persons) ?? stmt.site.variable;
      const defaults = persons.byKey.get(personKey)?.paperdollDefaults;
      const clean: Record<string, string> = {};
      for (const [key, value] of Object.entries(stmt.kwargs)) {
        if (key === 'alt_keys' || key === 'color') {
          continue;
        }
        clean[key] = stripQuotes(value);
      }
      const values = mergedValues(defaults, clean);
      const color = stmt.kwargs.color ? parsePaperdollColor(stmt.kwargs.color) : DEFAULT_CONFIG.color;
      const alt = splitAlt(stmt.kwargs.alt_keys) ?? [...HOUSE_ALT_KEYS];
      const config = { ...DEFAULT_CONFIG, color };
      const existing = scene.dolls.find((d) => d.variable === stmt.site.variable);
      const doll: DollRuntime = {
        variable: stmt.site.variable,
        personKey,
        values,
        config,
        altKeys: alt,
        hidden: true,
      };
      if (existing) {
        Object.assign(existing, doll);
      } else {
        scene.dolls.push(doll);
      }
      scene.bindings.set(stmt.site.variable, personKey);
      return;
    }
    case 'display': {
      const ref = stmt.site.form === 'manager' ? stripQuotes(stmt.site.managerKey ?? stmt.site.variable) : stmt.site.variable;
      let doll = findDoll(scene, ref, persons);
      if (!doll) {
        const personKey = resolveVariablePerson(ref, scene.bindings, persons) ?? ref;
        const defaults = persons.byKey.get(personKey)?.paperdollDefaults;
        doll = {
          variable: ref,
          personKey,
          values: mergedValues(defaults, undefined),
          config: { ...DEFAULT_CONFIG },
          altKeys: [...HOUSE_ALT_KEYS],
          hidden: true,
        };
        scene.dolls.push(doll);
        scene.bindings.set(ref, personKey);
      }
      applyActions(doll, stmt.site.actions, scene.presets);
      doll.hidden = false;
      return;
    }
    default:
      return;
  }
}

function findDoll(scene: SceneState, ref: string, persons: PersonIndexData): DollRuntime | undefined {
  const direct = scene.dolls.find((d) => d.variable === ref || d.personKey === ref);
  if (direct) {
    return direct;
  }
  const key = resolveVariablePerson(ref, scene.bindings, persons);
  if (!key) {
    return undefined;
  }
  return scene.dolls.find((d) => d.personKey === key || d.variable === key);
}

function applyActions(doll: DollRuntime, actions: PdAction[], presets: Map<string, PresetDef>): void {
  for (const action of actions) {
    if (action.kind === 'image') {
      Object.assign(doll.values, action.fields);
    } else if (action.kind === 'move') {
      doll.config = {
        ...doll.config,
        alignX: applyNumeric(doll.config.alignX, action.alignX),
        alignY: applyNumeric(doll.config.alignY, action.alignY),
        zoom: applyNumeric(doll.config.zoom, action.zoom),
      };
    } else if (action.kind === 'preset') {
      const moves = expandPresetMoves(action.name, presets);
      if (!moves) {
        continue;
      }
      const patched = moves.map((move) => patchMove(move, action));
      doll.config = applyMoves(doll.config, patched);
    } else if (action.kind === 'flip') {
      doll.config = { ...doll.config, flip: action.flipped ? -1 : 1 };
    } else if (action.kind === 'blur') {
      doll.config = { ...doll.config, blur: applyNumeric(doll.config.blur, action.blur) };
    } else if (action.kind === 'bw') {
      doll.config = { ...doll.config, bw: action.bw };
    } else if (action.kind === 'color') {
      doll.config = { ...doll.config, color: parsePaperdollColor(action.color) };
    }
  }
}

function patchMove(
  move: MoveSpec,
  action: Extract<PdAction, { kind: 'preset' }>
): MoveSpec {
  const next = { ...move };
  if (action.alignX !== undefined) {
    next.alignX = applyNumeric(move.alignX ?? 0, action.alignX);
  }
  if (action.alignY !== undefined) {
    next.alignY = applyNumeric(move.alignY ?? 0, action.alignY);
  }
  if (action.zoom !== undefined) {
    next.zoom = applyNumeric(move.zoom ?? 1, action.zoom);
  }
  return next;
}

function applyNumeric(current: number, raw: string | undefined): number {
  if (raw === undefined) {
    return current;
  }
  const text = raw.trim();
  const quoted =
    (text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"));
  const body = quoted ? text.slice(1, -1) : text;
  if (body === '') {
    return current;
  }
  const n = Number(body);
  if (!quoted && Number.isFinite(n) && n < -10) {
    return current;
  }
  if (quoted && (body.startsWith('+') || body.startsWith('-'))) {
    const delta = Number(body);
    return Number.isFinite(delta) ? current + delta : current;
  }
  return Number.isFinite(n) ? n : current;
}

function parsePaperdollStatements(text: string, labels: LabelDefinition[]): Stmt[] {
  const stmts: Stmt[] = [];
  const methodRe =
    /([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*(register_paperdoll|display|clear_display)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = methodRe.exec(text)) !== null) {
    const receiver = match[1];
    const method = match[2];
    if (receiver === 'paperdoll_manager') {
      continue;
    }
    const methodAt = match.index + match[0].lastIndexOf(method);
    const call = parseCallAt(text, methodAt);
    if (!call) {
      continue;
    }
    const end = callEnd(text, methodAt);
    if (end < 0) {
      continue;
    }
    const start = match.index;
    const line = offsetToPosition(text, start).line;
    const indent = indentAt(text, line);
    if (method === 'clear_display') {
      stmts.push({ type: 'clear', start, end, line });
      continue;
    }
    if (method === 'register_paperdoll') {
      const kwargs = kwargsOf(call);
      const site: PaperdollCallSite = {
        kind: 'register',
        start,
        end,
        line,
        indent,
        form: 'method',
        variable: receiver,
        actions: [{ kind: 'image', fields: imageFields(kwargs), raw: '' }],
        preserved: call.args
          .filter((a) => !a.name && a.call?.name === 'PaperdollOverride')
          .map((a) => a.text.trim()),
      };
      stmts.push({ type: 'register', start, end, line, site, kwargs });
      continue;
    }
    const actions = actionsOf(call);
    if (!isPaperdollDisplay(call, actions)) {
      continue;
    }
    const site: PaperdollCallSite = {
      kind: 'display',
      start,
      end,
      line,
      indent,
      form: 'method',
      variable: receiver,
      actions,
      preserved: [],
    };
    stmts.push({ type: 'display', start, end, line, site });
  }

  const mgrRe =
    /paperdoll_manager\s*\.\s*(set_background_split|set_background|hide_background|clear|register_obj|display)\s*\(/g;
  while ((match = mgrRe.exec(text)) !== null) {
    const method = match[1];
    const methodAt = match.index + match[0].lastIndexOf(method);
    const call = parseCallAt(text, methodAt);
    if (!call) {
      continue;
    }
    const end = callEnd(text, methodAt);
    if (end < 0) {
      continue;
    }
    const start = match.index;
    const line = offsetToPosition(text, start).line;
    const indent = indentAt(text, line);
    if (method === 'clear') {
      stmts.push({ type: 'clear', start, end, line });
      continue;
    }
    if (method === 'hide_background') {
      stmts.push({ type: 'background', start, end, line, background: { ...NONE_BG } });
      continue;
    }
    if (method === 'set_background' || method === 'set_background_split') {
      const background = backgroundOf(text, labels, line, call, method === 'set_background_split');
      stmts.push({ type: 'background', start, end, line, background });
      continue;
    }
    if (method === 'display') {
      const keyArg = call.args.find((a) => !a.name);
      const actions = actionsOf(call, true);
      const site: PaperdollCallSite = {
        kind: 'display',
        start,
        end,
        line,
        indent,
        form: 'manager',
        variable: stripQuotes(keyArg?.text ?? ''),
        managerKey: keyArg?.text.trim(),
        actions,
        preserved: [],
      };
      stmts.push({ type: 'display', start, end, line, site });
      continue;
    }
    if (method === 'register_obj') {
      const keyArg = call.args.find((a) => !a.name);
      const key = stripQuotes(keyArg?.text ?? '');
      if (!key) {
        continue;
      }
      const kwargs = kwargsOf(call);
      const site: PaperdollCallSite = {
        kind: 'register',
        start,
        end,
        line,
        indent,
        form: 'manager',
        variable: key,
        managerKey: keyArg?.text.trim(),
        actions: [{ kind: 'image', fields: imageFields(kwargs), raw: '' }],
        preserved: [],
      };
      stmts.push({ type: 'register', start, end, line, site, kwargs });
    }
  }

  const hideRe =
    /get_obj\s*\(\s*(?:(['"])([^'"]+)\1|([A-Za-z_][A-Za-z0-9_]*))\s*\)\s*\.\s*hide_all_images\s*\(/g;
  while ((match = hideRe.exec(text)) !== null) {
    const ref = match[2] || match[3] || '';
    const line = offsetToPosition(text, match.index).line;
    stmts.push({
      type: 'hide',
      start: match.index,
      end: match.index + match[0].length,
      line,
      ref,
    });
  }

  const showRe = /\$?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*show\s*\(\s*\d+\s*[,)]/g;
  while ((match = showRe.exec(text)) !== null) {
    const line = offsetToPosition(text, match.index).line;
    stmts.push({ type: 'clear', start: match.index, end: match.index + match[0].length, line });
  }

  const endRe = /\$?\s*end_event\s*\(/g;
  while ((match = endRe.exec(text)) !== null) {
    const line = offsetToPosition(text, match.index).line;
    stmts.push({ type: 'unload', start: match.index, end: match.index + match[0].length, line });
  }

  const presetRe = /register_temp_preset\s*\(/g;
  while ((match = presetRe.exec(text)) !== null) {
    const call = parseCallAt(text, match.index);
    if (!call) {
      continue;
    }
    const end = callEnd(text, match.index);
    const nameArg = call.args.find((a) => !a.name);
    const name = nameArg ? readStringLiteral(nameArg.text, 0)?.value : undefined;
    if (!name || end < 0) {
      continue;
    }
    const steps: PresetDef['steps'] = [];
    for (const arg of call.args) {
      if (!arg.name && arg === nameArg) {
        continue;
      }
      const action = actionOf(arg);
      if (action.kind === 'move') {
        const move: MoveSpec = {};
        if (action.alignX !== undefined) {
          move.alignX = applyNumeric(0, action.alignX);
        }
        if (action.alignY !== undefined) {
          move.alignY = applyNumeric(0, action.alignY);
        }
        if (action.zoom !== undefined) {
          move.zoom = applyNumeric(1, action.zoom);
        }
        steps.push({ move });
      } else if (action.kind === 'preset') {
        steps.push({ preset: action.name });
      }
    }
    const line = offsetToPosition(text, match.index).line;
    stmts.push({
      type: 'preset',
      start: match.index,
      end,
      line,
      name,
      def: { name, steps },
    });
  }

  const assignRe = /^[ \t]*\$[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.+)$/gm;
  while ((match = assignRe.exec(text)) !== null) {
    const rhs = match[2];
    if (/\.get_renpy_char\s*\(/.test(rhs)) {
      continue;
    }
    const person = /Person\s*\[\s*['"]([^'"]+)['"]/.exec(rhs);
    const got = /get_person(?:_char_with_key)?\s*\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]/.exec(rhs);
    const key = person?.[1] || got?.[1];
    if (!key) {
      continue;
    }
    const line = offsetToPosition(text, match.index).line;
    stmts.push({
      type: 'assign',
      start: match.index,
      end: match.index + match[0].length,
      line,
      variable: match[1],
      personKey: key,
    });
  }

  stmts.sort((a, b) => a.start - b.start || a.end - b.end);
  return stmts;
}

function backgroundOf(
  text: string,
  labels: LabelDefinition[],
  line: number,
  call: ParsedCall,
  split: boolean
): BackgroundRef {
  const blur = truthy(kwargsOf(call).blur);
  const positionals = call.args.filter((a) => !a.name);
  const one = (arg: ParsedArg | undefined): BackgroundRef => {
    if (!arg) {
      return { kind: 'none', blur };
    }
    const raw = arg.text.trim();
    const lit = readStringLiteral(raw, 0);
    if (lit && raw.slice(lit.end).trim() === '') {
      return { kind: 'path', path: lit.value, blur };
    }
    const indexed = /([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(\d+)\s*\]/.exec(raw);
    if (indexed) {
      const patternKey = labels.length
        ? resolveSeriesKey(text, labels, indexed[1], line)
        : undefined;
      return {
        kind: 'series',
        variable: indexed[1],
        step: parseInt(indexed[2], 10),
        patternKey,
        blur,
      };
    }
    return { kind: 'none', blur };
  };
  if (!split) {
    return one(positionals[0]);
  }
  const left = one(positionals[0]);
  const right = one(positionals[1]);
  return { kind: 'split', blur, left, right };
}

function resolveSeriesKey(
  text: string,
  labels: LabelDefinition[],
  variable: string,
  beforeLine: number
): string | undefined {
  const span = topLevelLabelSpan(labels, beforeLine);
  const re = /\$?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*convert_pattern(?:_with_data)?\s*\(\s*['"]([^'"]+)['"]/g;
  let last: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const line = offsetToPosition(text, match.index).line;
    if (line < span.startLine || line >= beforeLine) {
      continue;
    }
    if (match[1] === variable) {
      last = match[2];
    }
  }
  return last;
}

function isPaperdollDisplay(call: ParsedCall, actions: PdAction[]): boolean {
  if (actions.some((a) => a.kind !== 'other')) {
    return true;
  }
  return call.args.length === 0;
}

function actionsOf(call: ParsedCall, skipFirst = false): PdAction[] {
  const args = skipFirst ? call.args.filter((a) => a.name || a !== call.args.find((x) => !x.name)) : call.args;
  return args.map(actionOf);
}

function actionOf(arg: ParsedArg): PdAction {
  const raw = arg.text.trim();
  if (arg.call) {
    const kw = kwargsOf(arg.call);
    switch (arg.call.name) {
      case 'PDAImage':
        return { kind: 'image', fields: imageFields(kw), raw };
      case 'PDAMove':
        return {
          kind: 'move',
          alignX: kw.alignX,
          alignY: kw.alignY,
          zoom: kw.zoom,
          duration: kw.duration,
          raw,
        };
      case 'PDAPreset': {
        const name = firstString(arg.call) ?? stripQuotes(kw.preset ?? '');
        return {
          kind: 'preset',
          name,
          duration: kw.duration,
          alignX: kw.alignX,
          alignY: kw.alignY,
          zoom: kw.zoom,
          raw,
        };
      }
      case 'PDAFlip': {
        const flag = firstPositional(arg.call) ?? 'False';
        return { kind: 'flip', flipped: truthy(flag), raw };
      }
      case 'PDABlur':
        return { kind: 'blur', blur: firstPositional(arg.call) ?? kw.blur ?? '0', raw };
      case 'PDABw':
        return { kind: 'bw', bw: truthy(firstPositional(arg.call) ?? kw.bw ?? 'True'), raw };
      case 'PDAColor':
        return { kind: 'color', color: firstPositional(arg.call) ?? kw.color ?? '#00000000', raw };
      case 'PDAShake':
        return { kind: 'shake', raw };
      case 'PDAPause':
        return { kind: 'pause', raw };
      default:
        break;
    }
  }
  if (argIsString(raw)) {
    return { kind: 'preset', name: readStringLiteral(raw, 0)?.value ?? '', raw };
  }
  return { kind: 'other', raw };
}

function imageFields(kwargs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of IMAGE_FIELDS) {
    if (kwargs[key] !== undefined) {
      out[key] = stripQuotes(kwargs[key]);
    }
  }
  return out;
}

function kwargsOf(call: ParsedCall): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of call.args) {
    if (arg.name) {
      out[arg.name] = arg.text.trim();
    }
  }
  return out;
}

function firstString(call: ParsedCall): string | undefined {
  const pos = call.args.find((a) => !a.name);
  if (!pos) {
    return undefined;
  }
  return readStringLiteral(pos.text, 0)?.value;
}

function firstPositional(call: ParsedCall): string | undefined {
  return call.args.find((a) => !a.name)?.text.trim();
}

function argIsString(raw: string): boolean {
  const lit = readStringLiteral(raw, 0);
  return !!lit && raw.slice(lit.end).trim() === '';
}

function truthy(raw: string | undefined): boolean {
  const text = stripQuotes(raw ?? '').trim();
  return text === 'True' || text === 'true' || text === '1';
}

function stripQuotes(raw: string): string {
  const text = raw.trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function splitAlt(raw: string | undefined): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const keys = [...raw.matchAll(/['"]([A-Za-z0-9_]+)['"]/g)].map((m) => m[1]);
  return keys.length > 0 ? keys : undefined;
}

function callEnd(text: string, nameStart: number): number {
  const call = parseCallAt(text, nameStart);
  if (!call) {
    return -1;
  }
  const open = text.indexOf('(', nameStart);
  if (open < 0) {
    return -1;
  }
  const close = findMatching(text, open);
  return close < 0 ? -1 : close + 1;
}

function indentAt(text: string, line: number): string {
  const start = positionToOffset(text, line, 0);
  const nl = text.indexOf('\n', start);
  const body = text.slice(start, nl < 0 ? text.length : nl);
  return /^[ \t]*/.exec(body)?.[0] ?? '';
}

function positionToOffset(text: string, line: number, character: number): number {
  let offset = 0;
  let current = 0;
  while (current < line && offset < text.length) {
    const nl = text.indexOf('\n', offset);
    if (nl < 0) {
      return text.length;
    }
    offset = nl + 1;
    current++;
  }
  return Math.min(text.length, offset + character);
}

interface Region {
  parentStart: number;
  parentEnd: number;
  sub?: { start: number; end: number };
}

function regionFor(labels: LabelDefinition[], line: number): Region {
  if (labels.length === 0) {
    const lines = line + 1;
    return { parentStart: 0, parentEnd: lines + 1 };
  }
  const span = topLevelLabelSpan(labels, line);
  const subs = labels
    .filter((l) => l.isSub && l.range.start.line > span.startLine && l.range.start.line <= span.endLine)
    .sort((a, b) => a.range.start.line - b.range.start.line);
  const parentEnd = subs.length > 0 ? subs[0].range.start.line : span.endLine + 1;
  const sub = subs.find((s, i) => {
    const end = i + 1 < subs.length ? subs[i + 1].range.start.line : span.endLine + 1;
    return line >= s.range.start.line && line < end;
  });
  if (!sub) {
    return { parentStart: span.startLine, parentEnd };
  }
  const index = subs.indexOf(sub);
  const end = index + 1 < subs.length ? subs[index + 1].range.start.line : span.endLine + 1;
  return { parentStart: span.startLine, parentEnd, sub: { start: sub.range.start.line, end } };
}

function inactiveLines(text: string, start: number, end: number, target: number): Set<number> {
  const lines = text.split('\n');
  const inactive = new Set<number>();
  const headers: { line: number; indent: number; kind: string }[] = [];
  const last = Math.min(end, lines.length);
  for (let i = start; i < last; i++) {
    const match = /^([ \t]*)(if|elif|else)\b/.exec(lines[i] ?? '');
    if (match) {
      headers.push({ line: i, indent: match[1].length, kind: match[2] });
    }
  }
  const used = new Set<number>();
  for (let h = 0; h < headers.length; h++) {
    if (used.has(h) || headers[h].kind !== 'if') {
      continue;
    }
    const indent = headers[h].indent;
    const group = [h];
    used.add(h);
    for (let k = h + 1; k < headers.length; k++) {
      const next = headers[k];
      if (next.indent < indent) {
        break;
      }
      if (next.indent > indent) {
        continue;
      }
      if (next.kind !== 'elif' && next.kind !== 'else') {
        break;
      }
      const prev = headers[group[group.length - 1]].line;
      let broken = false;
      for (let line = prev + 1; line < next.line; line++) {
        const row = lines[line] ?? '';
        if (row.trim() === '' || row.trim().startsWith('#')) {
          continue;
        }
        const rowIndent = /^[ \t]*/.exec(row)?.[0].length ?? 0;
        if (rowIndent <= indent) {
          broken = true;
          break;
        }
      }
      if (broken) {
        break;
      }
      group.push(k);
      used.add(k);
      if (next.kind === 'else') {
        break;
      }
    }
    const branches = group.map((idx, gi) => {
      const header = headers[idx];
      const bodyEnd =
        gi + 1 < group.length ? headers[group[gi + 1]].line : chainEnd(lines, header.line, indent, last);
      return { header: header.line, kind: header.kind, bodyEnd };
    });
    let active = branches.findIndex((b) => target >= b.header && target < b.bodyEnd);
    if (active < 0) {
      active = branches.findIndex((b) => b.kind === 'else');
    }
    for (let i = 0; i < branches.length; i++) {
      if (i === active) {
        continue;
      }
      const branch = branches[i];
      inactive.add(branch.header);
      for (let line = branch.header + 1; line < branch.bodyEnd; line++) {
        inactive.add(line);
      }
    }
  }
  return inactive;
}

function chainEnd(lines: string[], header: number, indent: number, limit: number): number {
  for (let line = header + 1; line < limit && line < lines.length; line++) {
    const row = lines[line] ?? '';
    if (row.trim() === '' || row.trim().startsWith('#')) {
      continue;
    }
    const rowIndent = /^[ \t]*/.exec(row)?.[0].length ?? 0;
    if (rowIndent <= indent) {
      return line;
    }
  }
  return limit;
}

export function labelOf(labels: LabelDefinition[], line: number): LabelDefinition | undefined {
  return labelAtLine(labels, line);
}

export interface PaperdollEdit {
  start: number;
  end: number;
  text: string;
}

export interface PaperdollOptimizeResult {
  edits: PaperdollEdit[];
  /** Image fields dropped because the previous display of that doll already set them. */
  fields: number;
  /** Display statements removed because every argument was a repeated field. */
  calls: number;
}

type DollFields = Map<string, Map<string, string>>;

/**
 * Drop image fields that repeat the value already set by the previous display of the
 * same doll. Sublabels inherit the parent label's state. Across if/else, a value is
 * only treated as known when every branch leaves it the same.
 */
export function optimizePaperdollEvent(
  text: string,
  labels: LabelDefinition[],
  line: number
): PaperdollOptimizeResult {
  const edits: PaperdollEdit[] = [];
  let fields = 0;
  let calls = 0;
  const stmts = parsePaperdollStatements(text, labels);
  const span = topLevelLabelSpan(labels, line);
  const subs = labels
    .filter((l) => l.isSub && l.range.start.line > span.startLine && l.range.start.line <= span.endLine)
    .sort((a, b) => a.range.start.line - b.range.start.line);
  const parentEnd = subs.length > 0 ? subs[0].range.start.line : Math.min(span.endLine + 1, text.split('\n').length);
  const counts = { fields, calls };
  const state: DollFields = new Map();
  walkRegion(text, stmts, span.startLine, parentEnd, state, edits, counts);
  for (let i = 0; i < subs.length; i++) {
    const subEnd = i + 1 < subs.length ? subs[i + 1].range.start.line : Math.min(span.endLine + 1, text.split('\n').length);
    walkRegion(text, stmts, subs[i].range.start.line, subEnd, cloneDolls(state), edits, counts);
  }
  return { edits, fields: counts.fields, calls: counts.calls };
}

function walkRegion(
  text: string,
  stmts: Stmt[],
  start: number,
  end: number,
  state: DollFields,
  edits: PaperdollEdit[],
  counts: { fields: number; calls: number }
): void {
  const chains = directChains(ifChains(text, start, end));
  let cursor = start;
  for (const chain of chains) {
    walkStraight(text, stmts, cursor, chain.header, state, edits, counts);
    const incoming = cloneDolls(state);
    const outs: DollFields[] = [];
    for (const branch of chain.branches) {
      const branchState = cloneDolls(incoming);
      walkRegion(text, stmts, branch.bodyStart, branch.bodyEnd, branchState, edits, counts);
      outs.push(branchState);
    }
    if (!chain.hasElse) {
      outs.push(incoming);
    }
    replaceDolls(state, mergeDolls(outs));
    cursor = chain.end;
  }
  walkStraight(text, stmts, cursor, end, state, edits, counts);
}

function walkStraight(
  text: string,
  stmts: Stmt[],
  start: number,
  end: number,
  state: DollFields,
  edits: PaperdollEdit[],
  counts: { fields: number; calls: number }
): void {
  const marks: { line: number; stmt?: Stmt; reset?: boolean }[] = [];
  for (const stmt of stmts) {
    if (stmt.line >= start && stmt.line < end && (stmt.type === 'display' || stmt.type === 'clear')) {
      marks.push({ line: stmt.line, stmt });
    }
  }
  const lines = text.split('\n');
  const last = Math.min(end, lines.length);
  for (let i = start; i < last; i++) {
    if (/^[ \t]*\$?[ \t]*end_event\s*\(/.test(lines[i] ?? '')) {
      marks.push({ line: i, reset: true });
    }
  }
  marks.sort((a, b) => a.line - b.line || (a.reset ? 1 : 0) - (b.reset ? 1 : 0));
  for (const mark of marks) {
    if (mark.reset) {
      state.clear();
      continue;
    }
    const stmt = mark.stmt;
    if (stmt?.type === 'display') {
      optimizeDisplay(text, stmt.site, state, edits, counts);
    }
  }
}

function optimizeDisplay(
  text: string,
  site: PaperdollCallSite,
  state: DollFields,
  edits: PaperdollEdit[],
  counts: { fields: number; calls: number }
): void {
  const call = displayCallAt(text, site);
  if (!call) {
    return;
  }
  const id = site.form === 'manager' ? stripQuotes(site.managerKey ?? site.variable) : site.variable;
  const doll = state.get(id) ?? new Map<string, string>();
  state.set(id, doll);
  const imageKeys = new Set<string>(IMAGE_FIELDS);
  let remaining = 0;
  const inner: PaperdollEdit[] = [];
  let dropped = 0;
  for (const arg of call.args) {
    if (arg.call?.name !== 'PDAImage') {
      remaining++;
      continue;
    }
    const drop = new Set<string>();
    for (const kw of arg.call.args) {
      if (!kw.name || !imageKeys.has(kw.name)) {
        continue;
      }
      const value = stripQuotes(kw.text);
      if (doll.get(kw.name) === value) {
        drop.add(kw.name);
      }
      doll.set(kw.name, value);
    }
    if (drop.size === 0) {
      remaining++;
      continue;
    }
    dropped += drop.size;
    const kept = arg.call.args.filter((kw) => !kw.name || !drop.has(kw.name));
    const argPos = offsetsOf(text, arg.range);
    if (kept.length === 0) {
      inner.push({ ...withoutArg(text, argPos.start, argPos.end), text: '' });
      continue;
    }
    remaining++;
    const body = kept
      .map((kw) => (kw.name ? `${kw.name} = ${kw.text.trim()}` : kw.text.trim()))
      .join(', ');
    inner.push({ start: argPos.start, end: argPos.end, text: `PDAImage(${body})` });
  }
  counts.fields += dropped;
  if (dropped === 0) {
    return;
  }
  if (remaining === 0) {
    const whole = statementExtent(text, site.start, site.end);
    if (whole) {
      edits.push({ start: whole.start, end: whole.end, text: '' });
      counts.calls++;
      return;
    }
  }
  edits.push(...inner);
}

function displayCallAt(text: string, site: PaperdollCallSite): ParsedCall | undefined {
  const slice = text.slice(site.start, site.end);
  const match = /\bdisplay\s*\(/.exec(slice);
  if (!match) {
    return undefined;
  }
  const at = site.start + match.index + match[0].lastIndexOf('display');
  return parseCallAt(text, at);
}

function offsetsOf(
  text: string,
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
): { start: number; end: number } {
  return {
    start: positionToOffset(text, range.start.line, range.start.character),
    end: positionToOffset(text, range.end.line, range.end.character),
  };
}

function withoutArg(text: string, argStart: number, argEnd: number): { start: number; end: number } {
  let end = argEnd;
  while (end < text.length && (text[end] === ' ' || text[end] === '\t')) {
    end++;
  }
  if (text[end] === ',') {
    return { start: argStart, end: end + 1 };
  }
  let start = argStart;
  let j = argStart - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) {
    j--;
  }
  if (text[j] === ',') {
    start = j;
  }
  return { start, end: argEnd };
}

function statementExtent(text: string, start: number, end: number): { start: number; end: number } | undefined {
  const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const prefix = text.slice(lineStart, start);
  if (!/^[ \t]*\$[ \t]*$/.test(prefix)) {
    return undefined;
  }
  let i = end;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
    i++;
  }
  if (text[i] === ',') {
    i++;
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
      i++;
    }
  }
  if (text[i] === '\r') {
    i++;
  }
  if (text[i] !== '\n' && i < text.length) {
    return undefined;
  }
  if (text[i] === '\n') {
    i++;
  }
  return { start: lineStart, end: i };
}

function cloneDolls(src: DollFields): DollFields {
  const out: DollFields = new Map();
  for (const [id, fields] of src) {
    out.set(id, new Map(fields));
  }
  return out;
}

function replaceDolls(target: DollFields, next: DollFields): void {
  target.clear();
  for (const [id, fields] of next) {
    target.set(id, fields);
  }
}

function mergeDolls(states: DollFields[]): DollFields {
  const out: DollFields = new Map();
  const ids = new Set<string>();
  for (const state of states) {
    for (const id of state.keys()) {
      ids.add(id);
    }
  }
  for (const id of ids) {
    const keys = new Set<string>();
    for (const state of states) {
      for (const key of state.get(id)?.keys() ?? []) {
        keys.add(key);
      }
    }
    const fields = new Map<string, string>();
    for (const key of keys) {
      const values = states.map((state) => state.get(id)?.get(key));
      if (values.every((value) => value !== undefined && value === values[0])) {
        fields.set(key, values[0] as string);
      }
    }
    if (fields.size > 0) {
      out.set(id, fields);
    }
  }
  return out;
}

interface OptBranch {
  header: number;
  kind: string;
  bodyStart: number;
  bodyEnd: number;
}

interface OptChain {
  header: number;
  end: number;
  hasElse: boolean;
  branches: OptBranch[];
}

function ifChains(text: string, start: number, end: number): OptChain[] {
  const lines = text.split('\n');
  const last = Math.min(end, lines.length);
  const headers: { line: number; indent: number; kind: string }[] = [];
  for (let i = start; i < last; i++) {
    const match = /^([ \t]*)(if|elif|else)\b/.exec(lines[i] ?? '');
    if (match) {
      headers.push({ line: i, indent: match[1].length, kind: match[2] });
    }
  }
  const chains: OptChain[] = [];
  const used = new Set<number>();
  for (let h = 0; h < headers.length; h++) {
    if (used.has(h) || headers[h].kind !== 'if') {
      continue;
    }
    const indent = headers[h].indent;
    const group = [h];
    used.add(h);
    for (let k = h + 1; k < headers.length; k++) {
      const next = headers[k];
      if (next.indent < indent) {
        break;
      }
      if (next.indent > indent) {
        continue;
      }
      if (next.kind !== 'elif' && next.kind !== 'else') {
        break;
      }
      const prev = headers[group[group.length - 1]].line;
      let broken = false;
      for (let line = prev + 1; line < next.line; line++) {
        const row = lines[line] ?? '';
        if (row.trim() === '' || row.trim().startsWith('#')) {
          continue;
        }
        const rowIndent = /^[ \t]*/.exec(row)?.[0].length ?? 0;
        if (rowIndent <= indent) {
          broken = true;
          break;
        }
      }
      if (broken) {
        break;
      }
      group.push(k);
      used.add(k);
      if (next.kind === 'else') {
        break;
      }
    }
    const branches = group.map((idx, gi) => {
      const header = headers[idx];
      const bodyEnd = gi + 1 < group.length ? headers[group[gi + 1]].line : chainEnd(lines, header.line, indent, last);
      return { header: header.line, kind: header.kind, bodyStart: header.line + 1, bodyEnd };
    });
    chains.push({
      header: headers[h].line,
      end: branches[branches.length - 1].bodyEnd,
      hasElse: branches.some((b) => b.kind === 'else'),
      branches,
    });
  }
  return chains;
}

function directChains(chains: OptChain[]): OptChain[] {
  return chains.filter(
    (chain) =>
      !chains.some((other) =>
        other !== chain && other.branches.some((b) => chain.header >= b.bodyStart && chain.header < b.bodyEnd)
      )
  );
}
