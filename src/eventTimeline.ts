import { findAllCallsByName, walkCalls } from './callParser';
import { imageCallValues, labelAtLine, resolveConvertForVariable, resolvePatternKeyForVariable, topLevelLabelSpan } from './parseImageCalls';
import {
  normalizeSpeakerToken,
  parseSpeakerChain,
  PersonIndexData,
  resolveSpeakerPersonKeys,
  scanSayStatements,
  SpeechType,
} from './parsePersons';
import { offsetToPosition, positionToOffset, readStringLiteral } from './scan';
import { ImageCallKind, LabelDefinition } from './types';
import { getValueAliases, isLevelKey, LEVEL_DOMAIN, parseConditionExpr } from './paramConstraints';
import { parsePyCall, decodeValue, PyArg } from './pyCall';
import { codeMap, lineInsideString, statementEndLine, sayParts, SayPart } from './codeStructure';

/**
 * A resolvable image reference the panel turns into an ImageCallSite for
 * `resolveSiteImages`. `legacy` marks a raw `scene` the simulation can't resolve.
 */
export interface ImageRef {
  kind: ImageCallKind;
  line: number;
  character: number;
  variableName?: string;
  patternKey?: string;
  steps: number[];
  literalPath?: string;
  legacy?: boolean;
  /** show_image: position of this step among the call's steps (edited on its own). */
  stepIndex?: number;
  /**
   * Values the binding call fixes for this image (`convert_pattern("card", {"girls": "x"})`,
   * `**with_values(kwargs, girls = "x")`) — they override the selectors' values.
   */
  fixedValues?: Record<string, string>;
  stepCount?: number;
}

export type StopKind = 'dialog' | 'pause' | 'image' | 'video';

export interface TimelineStop {
  index: number;
  line: number;
  kind: StopKind;
  /** Speaker display token for dialogue (raw first identifier). */
  speaker?: string;
  /** Dialogue type for dialogue stops (say/think/shout/whisper). */
  speechType?: SpeechType;
  personKeys: string[];
  text: string;
  /** Governing CG/image shown at this stop, if any. */
  image?: ImageRef;
  /** Governing background at this stop, if any. */
  background?: ImageRef;
  /** Branch id (menu/if) whose selected path this stop belongs to; undefined at root. */
  branch?: string;
  /** `random_say(...)`: the alternative lines the game picks one of. */
  alternatives?: SayAlternative[];
  /**
   * Monologue mode: this stop is part `part` of `partCount` say statements Ren'Py makes of
   * one triple-quoted string (split at blank lines); `partLine` is where its text starts.
   */
  part?: number;
  partCount?: number;
  partLine?: number;
}

export interface SayAlternative {
  text: string;
  /** Speaker expression, e.g. `character.subtitles` (default: the call's `person=`). */
  speaker?: string;
  /** Condition that gates this alternative, e.g. `topic_set == 1`. */
  condition?: string;
  /** Image shown with this alternative (`image=` series + the alternative's step). */
  image?: ImageRef;
  /** Position of this alternative among the random_say call's arguments (for editing). */
  argIndex?: number;
}

export type MarkerKind = 'image' | 'paperdoll' | 'background' | 'menu' | 'plus' | 'stats' | 'end';

/** One stat change of `call change_stats_with_modifier(inhibition = DEC_SMALL, …)`. */
export interface StatChange {
  stat: string;
  /** Value as written: a modifier constant (SMALL, DEC_TINY…) or an expression. */
  value: string;
}

export interface MenuChoice {
  /** Decision key (first MenuElement argument) — recorded for replay, unique per menu. */
  key: string;
  title: string;
  /** Fully-qualified sublabel target, if it is a statically resolvable EventEffect(str). */
  target?: string;
}

export interface TimelineMarker {
  line: number;
  character: number;
  kind: MarkerKind;
  /** Chip renders after this stop index (−1 = before the first stop). */
  afterStop: number;
  label: string;
  image?: ImageRef;
  choices?: MenuChoice[];
  /** 'stats': the stat changes of the call. */
  stats?: StatChange[];
  /** 'end': the end_event return type (default new_daytime). */
  endType?: string;
}

export interface BranchPoint {
  id: string;
  kind: 'if' | 'menu';
  line: number;
  /** Option labels in order (the condition for if/elif, the title for menus). */
  options: string[];
  selected: number;
  /** Per option: the selector values it implies (`topic == "ah"` → { topic: ["ah"] }). */
  bindings?: Record<string, string[]>[];
  /** How the option was chosen: by the user, by a selector value, or by default. */
  via?: 'explicit' | 'value' | 'default';
  /** Branch point whose chosen option contains this one (undefined at the event's top level). */
  parent?: string;
  /** Nesting depth: 0 at top level, +1 per enclosing branch. */
  depth: number;
  /** Menu prompt (`call_custom_menu_with_text("What do you do?", …)`). */
  title?: string;
  /** Per option: whether it can be followed (menu choices need a string EventEffect target). */
  enabled?: boolean[];
  /** The split sits after this stop index on the walked path (−1 = before the first stop). */
  afterStop: number;
}

export interface Timeline {
  eventLabel: string;
  stops: TimelineStop[];
  markers: TimelineMarker[];
  branches: BranchPoint[];
  /**
   * Selector values in effect along the walked path: the ones passed in, plus those
   * implied by the chosen if/elif branches. Images and `[key]` text use these.
   */
  values: Record<string, string>;
}

export interface TimelineOptions {
  /** Branch id → selected option index (default 0 when absent). */
  selections?: Record<string, number>;
  /** Selector values to preview with (e.g. topic = "ahhh"); drive matching if/elif branches. */
  values?: Record<string, string>;
}

// ── Raw statement recognizers ─────────────────────────────────────────────

type Raw =
  | { t: 'say'; line: number; chain: string; firstIdent: string; text: string; part?: number; partCount?: number; partLine?: number }
  | { t: 'renpyPause'; line: number; duration?: string }
  | { t: 'barePause'; line: number; duration?: string }
  | { t: 'show'; line: number; character: number; variableName: string; patternKey?: string; fixedValues?: Record<string, string>; step: number }
  | {
      t: 'showImage';
      line: number;
      character: number;
      variableName: string;
      patternKey?: string;
      fixedValues?: Record<string, string>;
      steps: number[];
      pause: boolean;
    }
  | { t: 'showPattern'; line: number; character: number; patternKey: string; fixedValues?: Record<string, string> }
  | { t: 'showVideo'; line: number; character: number; variableName: string; patternKey?: string; fixedValues?: Record<string, string>; step: number; pause: boolean }
  | {
      t: 'background';
      line: number;
      character: number;
      kind: 'set_background' | 'set_background_path';
      variableName?: string;
      patternKey?: string;
      fixedValues?: Record<string, string>;
      step?: number;
      literalPath?: string;
    }
  | { t: 'paperdoll'; line: number; character: number }
  | { t: 'menu'; line: number; character: number; choices: MenuChoice[]; prompt?: string }
  | { t: 'scene'; line: number; character: number }
  | { t: 'stats'; line: number; character: number; stats: StatChange[] }
  | { t: 'end'; line: number; character: number; endType: string }
  | {
      t: 'randomSay';
      line: number;
      character: number;
      alternatives: { text: string; speaker?: string; step?: number; condition?: string; argIndex: number }[];
      person?: string;
      imageVar?: string;
      patternKey?: string;
    };

const RENPY_PAUSE_RE = /^[ \t]*\$[ \t]*renpy\.pause\s*\(\s*([^)]*)\)/;
const BARE_PAUSE_RE = /^[ \t]*pause\b[ \t]*([0-9.]+)?[ \t]*$/;
const SHOW_RE = /\$?[ \t]*([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*show\s*\(\s*(\d+)\s*[,)]/;
const SHOW_IMAGE_RE =
  /call[ \t]+Image_Series\s*\.\s*show_image\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)([^)]*)\)/;
const SHOW_PATTERN_RE = /\$?[ \t]*show_pattern\s*\(\s*['"]([^'"]+)['"]/;
const SHOW_VIDEO_RE =
  /\$?[ \t]*([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*show_video\s*\(\s*(\d+)([^)]*)\)/;
const SET_BG_INDEX_RE =
  /\.set_background(?:_split)?\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(\d+)\s*\]/;
const SET_BG_PATH_RE = /\.set_background(?:_split)?\s*\(\s*['"]([^'"]+)['"]/;
const SCENE_RE = /^[ \t]*scene\b(?![ \t]+expression\b)[ \t]+([A-Za-z_])/;

/** True when `raw` is exactly a single string literal (e.g. the arg of EventEffect("x")). */
function isStringLiteralArg(raw: string): boolean {
  const lit = readStringLiteral(raw, 0);
  return !!lit && raw.slice(lit.end).trim() === '';
}

function indentLen(row: string): number {
  return row.match(/^[ \t]*/)?.[0].length ?? 0;
}

function pauseFlag(tail: string): boolean {
  return /\bpause\s*=\s*True\b/.test(tail);
}

/** `show_video(step, pause = False, variant = -1)`: pause may also be passed positionally. */
export function videoPauseFlag(tail: string): boolean {
  return pauseFlag(tail) || /^\s*,\s*True\b/.test(tail);
}

/**
 * One raw say per say statement the engine runs: a triple-quoted string is split into
 * several (Ren'Py monologue mode), all on the statement's line.
 */
function pushSay(raws: Raw[], line: number, chain: string, firstIdent: string, text: string, parts: SayPart[] | undefined): void {
  if (!parts) {
    raws.push({ t: 'say', line, chain, firstIdent, text });
    return;
  }
  if (parts.length <= 1) {
    raws.push({ t: 'say', line, chain, firstIdent, text: parts[0]?.text ?? '', partLine: parts[0]?.line });
    return;
  }
  parts.forEach((p, i) => raws.push({ t: 'say', line, chain, firstIdent, text: p.text, part: i, partCount: parts.length, partLine: p.line }));
}

function scanRawStatements(
  text: string,
  labels: LabelDefinition[],
  startLine: number,
  endLine: number
): Raw[] {
  const raws: Raw[] = [];
  const lines = text.split('\n');
  const last = Math.min(endLine, lines.length);
  const fromOffset = positionToOffset(text, startLine, 0);
  const toOffset = positionToOffset(text, last, 0);

  // Dialogue via the shared say scanner (keeps subtitles, drops structural keywords).
  const sayLines = new Set<number>();
  for (const say of scanSayStatements(text, { start: startLine, end: last })) {
    pushSay(raws, say.line, say.chain, say.firstIdent, say.text, say.parts);
    sayLines.add(say.line);
  }

  // `var = convert_pattern("key", {…})` bound before `line`: its key and the values it fixes.
  const bindingOf = (variable: string, line: number) => {
    const c = resolveConvertForVariable(text, labels, variable, line);
    return { patternKey: c?.key, fixedValues: c?.values };
  };
  const inString = codeMap(text).inString;
  for (let line = startLine; line < last; line++) {
    const row = lines[line];
    const trimmed = row.trim();
    // Text inside a multi-line string is never a statement ("image.show(" in dialogue…).
    if (!trimmed || trimmed.startsWith('#') || sayLines.has(line) || inString[line]) {
      // Dialogue lines are handled above; skipping them keeps `.show(` etc. inside
      // spoken strings from being mistaken for image calls.
      continue;
    }
    const character = indentLen(row);

    let m: RegExpExecArray | null;
    if ((m = RENPY_PAUSE_RE.exec(row))) {
      raws.push({ t: 'renpyPause', line, duration: m[1]?.trim() || undefined });
      continue;
    }
    if ((m = BARE_PAUSE_RE.exec(row))) {
      raws.push({ t: 'barePause', line, duration: m[1]?.trim() || undefined });
      continue;
    }
    if ((m = SHOW_IMAGE_RE.exec(row))) {
      // Only positional args are steps; stop at the first keyword (pause=, variant=, …).
      const kwStart = m[2].search(/[A-Za-z_]\w*\s*=/);
      const positional = kwStart >= 0 ? m[2].slice(0, kwStart) : m[2];
      const steps = [...positional.matchAll(/(\d+)/g)].map((x) => parseInt(x[1], 10));
      raws.push({
        t: 'showImage',
        line,
        character,
        variableName: m[1],
        ...bindingOf(m[1], line),
        steps,
        pause: pauseFlag(m[2]),
      });
      continue;
    }
    if ((m = SHOW_VIDEO_RE.exec(row))) {
      raws.push({
        t: 'showVideo',
        line,
        character,
        variableName: m[1],
        ...bindingOf(m[1], line),
        step: parseInt(m[2], 10),
        pause: videoPauseFlag(m[3]),
      });
      continue;
    }
    if ((m = SHOW_RE.exec(row))) {
      raws.push({
        t: 'show',
        line,
        character,
        variableName: m[1],
        ...bindingOf(m[1], line),
        step: parseInt(m[2], 10),
      });
      continue;
    }
    if ((m = SHOW_PATTERN_RE.exec(row))) {
      const callee = positionToOffset(text, line, row.indexOf('show_pattern'));
      raws.push({ t: 'showPattern', line, character, patternKey: m[1], fixedValues: imageCallValues(text, callee) });
      continue;
    }
    if ((m = SET_BG_INDEX_RE.exec(row))) {
      raws.push({
        t: 'background',
        line,
        character,
        kind: 'set_background',
        variableName: m[1],
        ...bindingOf(m[1], line),
        step: parseInt(m[2], 10),
      });
      continue;
    }
    if ((m = SET_BG_PATH_RE.exec(row))) {
      raws.push({
        t: 'background',
        line,
        character,
        kind: 'set_background_path',
        literalPath: m[1].replace(/\\/g, '/'),
      });
      continue;
    }
    if (SCENE_RE.test(row)) {
      raws.push({ t: 'scene', line, character });
      continue;
    }
  }

  // Paperdoll displays (may span lines) — line-anchored is enough for a marker.
  const pdRe = /([A-Za-z_][A-Za-z0-9_]*|paperdoll_manager)\s*\.\s*display\s*\(/g;
  pdRe.lastIndex = fromOffset;
  let pm: RegExpExecArray | null;
  while ((pm = pdRe.exec(text)) !== null && pm.index < toOffset) {
    const pos = offsetToPosition(text, pm.index);
    raws.push({ t: 'paperdoll', line: pos.line, character: pos.character });
  }

  // Stat changes (`call change_stats_with_modifier(…)`, often multi-line) and end_event.
  const statRe = /\bchange_stats_with_modifier\s*\(/g;
  statRe.lastIndex = fromOffset;
  let sm: RegExpExecArray | null;
  while ((sm = statRe.exec(text)) !== null && sm.index < toOffset) {
    const pos = offsetToPosition(text, sm.index);
    const lineText = lines[pos.line] ?? '';
    if (/^\s*#/.test(lineText) || sayLines.has(pos.line)) {
      continue;
    }
    const call = parsePyCall(text, sm.index);
    if (!call) {
      continue;
    }
    const stats = call.args.filter((a) => a.name && a.name !== 'collection').map((a) => ({ stat: a.name!, value: a.value.trim() }));
    raws.push({ t: 'stats', line: pos.line, character: indentLen(lineText), stats });
  }
  const endRe = /\bend_event\s*\(/g;
  endRe.lastIndex = fromOffset;
  while ((sm = endRe.exec(text)) !== null && sm.index < toOffset) {
    const pos = offsetToPosition(text, sm.index);
    const lineText = lines[pos.line] ?? '';
    if (/^\s*#/.test(lineText) || sayLines.has(pos.line) || /\bdef\s+end_event/.test(lineText)) {
      continue;
    }
    const call = parsePyCall(text, sm.index);
    const first = call?.args.find((a) => !a.name && !a.star);
    const lit = first ? readStringLiteral(first.value, 0) : undefined;
    raws.push({ t: 'end', line: pos.line, character: indentLen(lineText), endType: lit?.value ?? (first ? first.value.trim() : 'new_daytime') });
  }

  // Custom menus (may span lines) via the call parser, bounded to the event region.
  const menuCalls = findAllCallsByName(
    text,
    (name) => name === 'call_custom_menu' || name === 'call_custom_menu_with_text',
    fromOffset,
    toOffset
  );
  for (const call of menuCalls) {
    const choices: MenuChoice[] = [];
    for (const arg of call.args) {
      if (!arg.call || arg.call.name !== 'MenuElement') {
        continue;
      }
      const positionals = arg.call.args.filter((a) => !a.name);
      const title =
        readStringLiteral(positionals[1]?.text ?? '', 0)?.value ??
        readStringLiteral(positionals[0]?.text ?? '', 0)?.value ??
        '(choice)';
      let target: string | undefined;
      walkCalls(arg.call, (c) => {
        if (target || c.name !== 'EventEffect') {
          return;
        }
        const first = c.args.find((a) => !a.name);
        if (first && isStringLiteralArg(first.text)) {
          target = readStringLiteral(first.text, 0)?.value;
        }
      });
      choices.push({ key: readStringLiteral(positionals[0]?.text ?? '', 0)?.value ?? '', title, target });
    }
    const firstPositional = call.args.find((a) => !a.name);
    const prompt =
      call.name === 'call_custom_menu_with_text' && firstPositional && isStringLiteralArg(firstPositional.text)
        ? readStringLiteral(firstPositional.text, 0)?.value
        : undefined;
    raws.push({
      t: 'menu',
      line: call.range.start.line,
      character: call.range.start.character,
      choices,
      prompt,
    });
  }

  // random_say(...): one dialogue stop whose line the game picks from alternatives.
  for (const rs of findAllCallsByName(text, (name) => name === 'random_say', fromOffset, toOffset)) {
    const call = parsePyCall(text, positionToOffset(text, rs.range.start.line, rs.range.start.character));
    if (!call) {
      continue;
    }
    const parsed = parseRandomSay(text, labels, call, rs.range.start.line);
    if (parsed.alternatives.length) {
      raws.push({ t: 'randomSay', line: rs.range.start.line, character: rs.range.start.character, ...parsed });
    }
  }

  // Narration: a statement that is only a string literal (`"She sips her tea."`). Only
  // statement starts count — strings inside a multi-line call are arguments, not lines.
  for (const line of statementStarts(text, lines, startLine, last)) {
    const row = lines[line];
    if (sayLines.has(line) || !/^[ \t]*["']/.test(row)) {
      continue;
    }
    // The literal may continue on later lines (""" … """): read it in the full text.
    const at = positionToOffset(text, line, indentLen(row));
    const lit = readStringLiteral(text, at);
    const nl = lit ? text.indexOf('\n', lit.end) : -1;
    if (lit && /^\s*(#.*)?\r?$/.test(text.slice(lit.end, nl < 0 ? text.length : nl))) {
      const parts = sayParts(text, at);
      pushSay(raws, line, '', '', parts ? '' : lit.value.replace(/[ \t]*\r?\n[ \t]*/g, ' '), parts);
    }
  }

  raws.sort((a, b) => a.line - b.line);
  return raws;
}

/** Lines in [from, to) where a new statement starts (not inside an open bracket). */
function statementStarts(text: string, lines: readonly string[], from: number, to: number): number[] {
  // Statement starts in [from, to): not inside a multi-line string, not a continuation of
  // an open bracket or a backslash line (codeStructure follows strings across lines).
  const out: number[] = [];
  let line = from;
  while (line < to) {
    const row = lines[line] ?? '';
    if (lineInsideString(text, line) || !row.trim() || row.trim().startsWith('#')) {
      line++;
      continue;
    }
    out.push(line);
    line = Math.max(line, statementEndLine(text, line)) + 1;
  }
  return out;
}

/**
 * `random_say("a", ("b", character.subtitles, cond, 1), person = …, image = image2)`:
 * each positional is an alternative — a string, or a tuple holding the text plus an
 * optional speaker (dotted name), step (int, shown on the `image=` series), conditions
 * (anything else) and weighted form `(0.7, (...))`.
 */
function parseRandomSay(
  text: string,
  labels: LabelDefinition[],
  call: import('./pyCall').PyCall,
  line: number
): { alternatives: { text: string; speaker?: string; step?: number; condition?: string; argIndex: number }[]; person?: string; imageVar?: string; patternKey?: string } {
  const person = call.args.find((a) => a.name === 'person')?.value.trim();
  const imageVar = call.args.find((a) => a.name === 'image')?.value.trim();
  const alternatives: { text: string; speaker?: string; step?: number; condition?: string; argIndex: number }[] = [];
  call.args.forEach((a: PyArg, argIndex) => {
    if (a.name || a.star) {
      return;
    }
    const alt = parseAlternative(a.value);
    if (alt) {
      alternatives.push({ ...alt, argIndex });
    }
  });
  const patternKey =
    imageVar && /^[A-Za-z_][A-Za-z0-9_]*$/.test(imageVar) ? resolvePatternKeyForVariable(text, labels, imageVar, line) : undefined;
  return { alternatives, person, imageVar: imageVar && /^[A-Za-z_][A-Za-z0-9_]*$/.test(imageVar) ? imageVar : undefined, patternKey };
}

function parseAlternative(code: string): { text: string; speaker?: string; step?: number; condition?: string } | undefined {
  const decoded = decodeValue(code);
  if (decoded.kind === 'string') {
    return { text: decoded.value };
  }
  const t = code.trim();
  if (!t.startsWith('(')) {
    return undefined;
  }
  const tuple = parsePyCall('f' + t, 0);
  if (!tuple) {
    return undefined;
  }
  const elems = tuple.args.map((a) => a.value.trim());
  if (elems.length === 2 && /^\d*\.\d+$/.test(elems[0])) {
    return parseAlternative(elems[1]); // weighted: (0.7, alternative)
  }
  const alt: { text: string; speaker?: string; step?: number; condition?: string } = { text: '' };
  const conditions: string[] = [];
  for (const e of elems) {
    const d = decodeValue(e);
    if (d.kind === 'string') {
      alt.text = d.value;
    } else if (d.kind === 'number' && /^\d+$/.test(d.value)) {
      alt.step = parseInt(d.value, 10);
    } else if (/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(e)) {
      alt.speaker = e;
    } else if (e.startsWith('(')) {
      const pair = parsePyCall('f' + e, 0);
      if (pair?.args[0]) {
        alt.speaker = pair.args[0].value.trim();
      }
    } else {
      conditions.push(e);
    }
  }
  if (conditions.length) {
    alt.condition = conditions.join(' and ');
  }
  return alt.text ? alt : undefined;
}

// ── if/elif/else chain detection (default-first path) ─────────────────────

interface Branch {
  header: number;
  kind: string;
  bodyStart: number;
  bodyEnd: number;
}
interface Chain {
  header: number;
  end: number;
  branches: Branch[];
}

function chainEnd(lines: string[], header: number, indent: number, limit: number): number {
  for (let line = header + 1; line < limit && line < lines.length; line++) {
    const row = lines[line] ?? '';
    if (row.trim() === '' || row.trim().startsWith('#')) {
      continue;
    }
    if (indentLen(row) <= indent) {
      return line;
    }
  }
  return limit;
}

function ifChains(lines: string[], start: number, end: number): Chain[] {
  const last = Math.min(end, lines.length);
  const headers: { line: number; indent: number; kind: string }[] = [];
  for (let i = start; i < last; i++) {
    const match = /^([ \t]*)(if|elif|else)\b/.exec(lines[i] ?? '');
    if (match) {
      headers.push({ line: i, indent: match[1].length, kind: match[2] });
    }
  }
  const chains: Chain[] = [];
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
      group.push(k);
      used.add(k);
      if (next.kind === 'else') {
        break;
      }
    }
    const branches: Branch[] = group.map((idx, gi) => {
      const header = headers[idx];
      const bodyEnd =
        gi + 1 < group.length ? headers[group[gi + 1]].line : chainEnd(lines, header.line, indent, last);
      return { header: header.line, kind: header.kind, bodyStart: header.line + 1, bodyEnd };
    });
    chains.push({ header: headers[h].line, end: branches[branches.length - 1].bodyEnd, branches });
  }
  // Only top-level chains for this region; nested ones handled by recursion.
  return chains.filter(
    (chain) =>
      !chains.some(
        (other) =>
          other !== chain &&
          other.branches.some((b) => chain.header >= b.bodyStart && chain.header < b.bodyEnd)
      )
  );
}

// ── Timeline assembly ─────────────────────────────────────────────────────

interface WalkState {
  text: string;
  labels: LabelDefinition[];
  persons: PersonIndexData;
  selectorValues: (line: number) => Record<string, string[]>;
  raws: Raw[];
  lines: string[];
  selections: Record<string, number>;
  branches: BranchPoint[];
  stops: TimelineStop[];
  markers: TimelineMarker[];
  currentImage?: ImageRef;
  currentBg?: ImageRef;
  visited: Set<string>;
  /** Name of the event's top-level label (resolves relative `.sub` targets). */
  topLabel: string;
  /** Selector values requested by the caller. */
  values: Record<string, string>;
  /** Values in effect so far: requested ones plus those implied by chosen branches. */
  effective: Record<string, string>;
  /** `$ var = get_value("key")` aliases: variable → selector key. */
  aliases: Map<string, string>;
  /** Enclosing branch points while walking a chosen option (for nesting). */
  parents: { id: string }[];
}

/** The condition text of an `if`/`elif` header line (`topic == "ah"`), '' for `else`. */
function conditionOf(line: string): string {
  const m = /^\s*(?:if|elif)\s+(.+?)\s*:\s*(?:#.*)?\r?$/.exec(line);
  return m ? m[1] : '';
}

/** Selector values a branch condition implies, keyed by selector key (via get_value aliases). */
function bindingsOf(expr: string, aliases: Map<string, string>): { values: Record<string, string[]>; numeric: Set<string> } {
  const values: Record<string, string[]> = {};
  const numeric = new Set<string>();
  for (const b of parseConditionExpr(expr)) {
    const key = aliases.get(b.variable) ?? b.variable;
    if (b.numeric) {
      // Integer comparisons are modelled for levels only (not stats like inhibition).
      if (!isLevelKey(key)) {
        continue;
      }
      numeric.add(key);
    }
    values[key] = [...new Set([...(values[key] ?? []), ...b.values])];
  }
  return { values, numeric };
}

/**
 * if/elif/else is first-match: `if level >= 8 / elif level >= 7 / else` really means
 * 8–10 / 7 / 0–6. For level keys, each option keeps only the values no earlier option
 * takes; `else` (or an option that tests nothing) gets the rest of the domain.
 */
function exclusiveBindings(parsed: { values: Record<string, string[]>; numeric: Set<string> }[]): Record<string, string[]>[] {
  const out = parsed.map((p) => ({ ...p.values }));
  const keys = new Set(parsed.flatMap((p) => [...p.numeric]));
  const domain = LEVEL_DOMAIN.map(String);
  for (const key of keys) {
    const taken = new Set<string>();
    parsed.forEach((p, i) => {
      const own = p.numeric.has(key) ? p.values[key] : undefined;
      if (!own && Object.keys(p.values).length > 0) {
        // Tests something else (e.g. topic): says nothing about the level.
        return;
      }
      const eff = (own ?? domain).filter((v) => !taken.has(v));
      out[i][key] = eff;
      (own ?? domain).forEach((v) => taken.add(v));
    });
  }
  return out;
}

function rawsInRange(raws: Raw[], start: number, end: number): Raw[] {
  return raws.filter((r) => r.line >= start && r.line < end);
}

function pushStop(state: WalkState, stop: Omit<TimelineStop, 'index'>): void {
  state.stops.push({ ...stop, index: state.stops.length });
}

function pushMarker(state: WalkState, marker: Omit<TimelineMarker, 'afterStop'>): void {
  state.markers.push({ ...marker, afterStop: state.stops.length - 1 });
}

function handleRaw(state: WalkState, raw: Raw, branch?: string): void {
  switch (raw.t) {
    case 'say': {
      const personKeys = resolveSpeakerPersonKeys(
        state.text,
        state.labels,
        state.persons,
        raw.chain,
        raw.line,
        state.selectorValues(raw.line)
      );
      pushStop(state, {
        line: raw.line,
        kind: 'dialog',
        speaker: raw.firstIdent,
        speechType: parseSpeakerChain(raw.chain).type,
        personKeys,
        text: raw.text,
        image: state.currentImage,
        background: state.currentBg,
        branch,
        part: raw.part,
        partCount: raw.partCount,
        partLine: raw.partLine,
      });
      return;
    }
    case 'renpyPause':
    case 'barePause': {
      pushStop(state, {
        line: raw.line,
        kind: 'pause',
        personKeys: [],
        text: raw.duration ? `Pause ${raw.duration}` : 'Pause',
        image: state.currentImage,
        background: state.currentBg,
        branch,
      });
      return;
    }
    case 'show': {
      state.currentImage = {
        kind: 'show',
        line: raw.line,
        character: raw.character,
        variableName: raw.variableName,
        patternKey: raw.patternKey,
        fixedValues: raw.fixedValues,
        steps: [raw.step],
      };
      pushMarker(state, {
        line: raw.line,
        character: raw.character,
        kind: 'image',
        label: `show(${raw.step})`,
        image: state.currentImage,
      });
      return;
    }
    case 'showImage': {
      const last = raw.steps.length - 1;
      raw.steps.forEach((step, i) => {
        const image: ImageRef = {
          kind: 'show_image',
          line: raw.line,
          character: raw.character,
          variableName: raw.variableName,
          patternKey: raw.patternKey,
          fixedValues: raw.fixedValues,
          steps: [step],
          stepIndex: i,
          stepCount: raw.steps.length,
        };
        state.currentImage = image;
        const isStop = i < last || raw.pause;
        if (isStop) {
          pushStop(state, {
            line: raw.line,
            kind: 'image',
            personKeys: [],
            text: `Image ${step}`,
            image,
            background: state.currentBg,
            branch,
          });
        } else {
          pushMarker(state, {
            line: raw.line,
            character: raw.character,
            kind: 'image',
            label: `show_image(${step})`,
            image,
          });
        }
      });
      return;
    }
    case 'showPattern': {
      state.currentImage = {
        kind: 'show_pattern',
        line: raw.line,
        character: raw.character,
        patternKey: raw.patternKey,
        fixedValues: raw.fixedValues,
        steps: [],
      };
      pushMarker(state, {
        line: raw.line,
        character: raw.character,
        kind: 'image',
        label: `show_pattern("${raw.patternKey}")`,
        image: state.currentImage,
      });
      return;
    }
    case 'showVideo': {
      // show_video replaces the scene with the step's Movie (`scene expression anim_…`):
      // it stays on screen for the following lines like any CG. With pause=True the
      // engine waits for a click, so it is a navigation stop of its own.
      const image: ImageRef = {
        kind: 'show_video',
        line: raw.line,
        character: raw.character,
        variableName: raw.variableName,
        patternKey: raw.patternKey,
        fixedValues: raw.fixedValues,
        steps: [raw.step],
      };
      state.currentImage = image;
      if (raw.pause) {
        pushStop(state, {
          line: raw.line,
          kind: 'video',
          personKeys: [],
          text: `Video ${raw.step}`,
          image,
          background: state.currentBg,
          branch,
        });
      } else {
        pushMarker(state, {
          line: raw.line,
          character: raw.character,
          kind: 'image',
          label: `show_video(${raw.step})`,
          image,
        });
      }
      return;
    }
    case 'background': {
      state.currentBg = {
        kind: raw.kind,
        line: raw.line,
        character: raw.character,
        variableName: raw.variableName,
        patternKey: raw.patternKey,
        fixedValues: raw.fixedValues,
        steps: raw.step !== undefined ? [raw.step] : [],
        literalPath: raw.literalPath,
      };
      pushMarker(state, {
        line: raw.line,
        character: raw.character,
        kind: 'background',
        label: raw.literalPath ? `background "${raw.literalPath}"` : 'set_background',
        image: state.currentBg,
      });
      return;
    }
    case 'stats': {
      const sign = (v: string) => (/^DEC_/.test(v) ? '−' + v.slice(4) : /^[A-Z]+$/.test(v) ? '+' + v : v);
      pushMarker(state, {
        line: raw.line,
        character: raw.character,
        kind: 'stats',
        label: raw.stats.map((s) => `${s.stat} ${sign(s.value)}`).join(', ') || 'change_stats',
        stats: raw.stats,
      });
      return;
    }
    case 'end': {
      pushMarker(state, {
        line: raw.line,
        character: raw.character,
        kind: 'end',
        label: `end_event(${raw.endType})`,
        endType: raw.endType,
      });
      return;
    }
    case 'paperdoll': {
      pushMarker(state, {
        line: raw.line,
        character: raw.character,
        kind: 'paperdoll',
        label: 'paperdoll.display',
      });
      return;
    }
    case 'randomSay': {
      const toImage = (step: number | undefined): ImageRef | undefined =>
        raw.imageVar && step !== undefined
          ? { kind: 'show', line: raw.line, character: raw.character, variableName: raw.imageVar, patternKey: raw.patternKey, steps: [step] }
          : undefined;
      const first = raw.alternatives[0];
      const chain = first.speaker ?? raw.person ?? 'character.subtitles';
      const firstImage = toImage(first.step);
      if (firstImage) {
        state.currentImage = firstImage;
      }
      pushStop(state, {
        line: raw.line,
        kind: 'dialog',
        speaker: normalizeSpeakerToken(chain),
        speechType: 'say',
        personKeys: resolveSpeakerPersonKeys(state.text, state.labels, state.persons, chain, raw.line, state.selectorValues(raw.line)),
        text: first.text,
        image: state.currentImage,
        background: state.currentBg,
        branch,
        alternatives: raw.alternatives.map((a) => ({
          text: a.text,
          speaker: a.speaker ?? raw.person,
          condition: a.condition,
          image: toImage(a.step),
          argIndex: a.argIndex,
        })),
      });
      return;
    }
    case 'scene': {
      // Legacy raw scene: mark the stage as not simulated until the next image call.
      state.currentImage = { kind: 'show', line: raw.line, character: raw.character, steps: [], legacy: true };
      pushMarker(state, {
        line: raw.line,
        character: raw.character,
        kind: 'background',
        label: 'scene (legacy)',
      });
      return;
    }
    case 'menu': {
      const id = `menu@${raw.line}`;
      const enabled = raw.choices.map((c) => !!c.target);
      const explicit = state.selections[id];
      let selected = explicit !== undefined ? Math.min(explicit, raw.choices.length - 1) : enabled.indexOf(true);
      if (selected < 0) {
        selected = 0;
      }
      const parent = state.parents[state.parents.length - 1];
      state.branches.push({
        id,
        kind: 'menu',
        line: raw.line,
        afterStop: state.stops.length - 1,
        options: raw.choices.map((c) => c.title),
        selected,
        via: explicit !== undefined ? 'explicit' : 'default',
        parent: parent?.id,
        depth: state.parents.length,
        title: raw.prompt,
        enabled,
      });
      pushMarker(state, {
        line: raw.line,
        character: raw.character,
        kind: 'menu',
        label: 'menu',
        choices: raw.choices,
      });
      const choice = raw.choices[selected];
      if (choice?.target) {
        state.parents.push({ id });
        followSublabel(state, choice.target, id);
        state.parents.pop();
      }
      return;
    }
  }
}

function walkStraight(state: WalkState, start: number, end: number, branch?: string): void {
  const chains = ifChains(state.lines, start, end);
  let cursor = start;
  for (const chain of chains) {
    for (const raw of rawsInRange(state.raws, cursor, chain.header)) {
      handleRaw(state, raw, branch);
    }
    const id = `if@${chain.header}`;
    const exprs = chain.branches.map((b) => (b.kind === 'else' ? '' : conditionOf(state.lines[b.header] ?? '')));
    const bindings = exclusiveBindings(
      exprs.map((e) => (e ? bindingsOf(e, state.aliases) : { values: {}, numeric: new Set<string>() }))
    );
    let selected: number;
    let via: BranchPoint['via'];
    const explicit = state.selections[id];
    if (explicit !== undefined) {
      selected = Math.min(explicit, chain.branches.length - 1);
      via = 'explicit';
    } else {
      // A selector value already in effect picks the matching branch (else when none match).
      const tested = [...new Set(bindings.flatMap((b) => Object.keys(b)))];
      const key = tested.find((k) => state.effective[k] !== undefined);
      if (key) {
        const value = state.effective[key];
        let i = bindings.findIndex((b) => b[key]?.includes(value));
        if (i < 0) {
          i = chain.branches.findIndex((b) => b.kind === 'else');
        }
        selected = i < 0 ? 0 : i;
        via = 'value';
      } else {
        selected = 0;
        via = 'default';
      }
    }
    // The chosen branch fixes the values it tests for the rest of the event.
    for (const [key, vals] of Object.entries(bindings[selected] ?? {})) {
      if (state.effective[key] === undefined && vals.length) {
        state.effective[key] = vals[0];
      }
    }
    state.branches.push({
      id,
      kind: 'if',
      line: chain.header,
      afterStop: state.stops.length - 1,
      options: exprs.map((e, i) => e || (chain.branches[i].kind === 'else' ? 'else' : `${chain.branches[i].kind} @${chain.branches[i].header + 1}`)),
      selected,
      bindings,
      via,
      parent: state.parents[state.parents.length - 1]?.id,
      depth: state.parents.length,
    });
    const pick = chain.branches[selected];
    if (pick) {
      state.parents.push({ id });
      walkStraight(state, pick.bodyStart, pick.bodyEnd, branch);
      state.parents.pop();
    }
    cursor = chain.end;
  }
  for (const raw of rawsInRange(state.raws, cursor, end)) {
    handleRaw(state, raw, branch);
  }
}

function followSublabel(state: WalkState, rawTarget: string, branchId: string): void {
  // `EventEffect(".branch")` is relative to the event's top-level label.
  const target = rawTarget.startsWith('.') ? `${state.topLabel}${rawTarget}` : rawTarget;
  if (state.visited.has(target)) {
    return;
  }
  state.visited.add(target);
  const label = state.labels.find((l) => l.name === target);
  if (!label) {
    return;
  }
  const start = label.range.start.line + 1;
  const sorted = [...state.labels].sort((a, b) => a.range.start.line - b.range.start.line);
  const nextLabel = sorted.find((l) => l.range.start.line > label.range.start.line);
  const end = nextLabel ? nextLabel.range.start.line : state.lines.length;
  walkStraight(state, start, end, branchId);
}

/**
 * Build the event timeline anchored at `atLine`: an ordered list of navigation stops
 * plus the markers between them, following a single control-flow path (default-first
 * for if/else, the selected choice for menus).
 */
export function buildEventTimeline(
  text: string,
  labels: LabelDefinition[],
  persons: PersonIndexData,
  atLine: number,
  selectorValues: (line: number) => Record<string, string[]>,
  options: TimelineOptions = {}
): Timeline {
  const lines = text.split('\n');
  const span = topLevelLabelSpan(labels, atLine);
  const eventEnd = Math.min(span.endLine + 1, lines.length);
  const sorted = [...labels].sort((a, b) => a.range.start.line - b.range.start.line);
  const firstSub = sorted.find(
    (l) => l.isSub && l.range.start.line > span.startLine && l.range.start.line <= span.endLine
  );
  const parentEnd = firstSub ? firstSub.range.start.line : eventEnd;

  const state: WalkState = {
    text,
    labels,
    persons,
    selectorValues,
    raws: scanRawStatements(text, labels, span.startLine, eventEnd),
    lines,
    selections: options.selections ?? {},
    branches: [],
    stops: [],
    markers: [],
    visited: new Set(),
    topLabel: labels.find((l) => !l.isSub && l.range.start.line === span.startLine)?.name ?? '',
    currentImage: undefined,
    currentBg: undefined,
    values: { ...(options.values ?? {}) },
    effective: { ...(options.values ?? {}) },
    aliases: getValueAliases(text, span.startLine, Math.min(span.endLine, lines.length - 1)),
    parents: [],
  };

  walkStraight(state, span.startLine, parentEnd);

  const lab = labelAtLine(labels, atLine);
  const eventLabel = lab ? (lab.isSub ? lab.name.split('.')[0] : lab.name) : '';

  return { eventLabel, stops: state.stops, markers: state.markers, branches: state.branches, values: state.effective };
}

/** Nearest stop index at or after `line`, else the last stop. */
export function stopIndexForLine(timeline: Timeline, line: number): number {
  let best = -1;
  for (const stop of timeline.stops) {
    if (stop.line <= line) {
      best = stop.index;
    } else {
      break;
    }
  }
  if (best < 0) {
    return timeline.stops.length ? 0 : -1;
  }
  return best;
}
