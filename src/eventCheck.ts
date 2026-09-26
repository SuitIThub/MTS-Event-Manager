import * as vscode from 'vscode';
import { buildEventTimeline, ImageRef, StatChange, Timeline } from './eventTimeline';
import { findEventDefs, placeholderHints } from './eventDef';
import { WorkspaceIndex } from './indexer';
import { labelAtLine, topLevelLabelSpan } from './parseImageCalls';
import { getImageRoots, normalizePatternPath, resolveImagesForCall } from './patternResolve';
import { isLevelKey } from './paramConstraints';
import { matchNumberPattern } from './conditionEval';
import { decodeValue, PyCall } from './pyCall';
import { eventSelectorOutputs, Gate } from './selectorValues';
import { findUnderRoots, movieNameFor, scanMovieDefs, siblingVideoPath, videoPrefixFor } from './videoResolve';
import { EventPatternInfo, ImageCallSite, LabelDefinition, ResolvedImageInfo } from './types';

/**
 * Whole-event check: walks every path (menu choices × if/elif branches), works out which
 * image files each path needs (placeholder combinations limited by the branch taken, the
 * selectors' own conditions and the event's LevelCondition) and reports what is missing
 * or inconsistent — images, Movie declarations, menu targets, event endings, speakers,
 * `[text]` variables, placeholders. The coverage rows double as the shot list.
 */

export type Severity = 'error' | 'warning' | 'info';

export interface CheckIssue {
  severity: Severity;
  code: string;
  message: string;
  line?: number;
  /** Selections that reach the problem (to show that path in the preview). */
  selections?: Record<string, number>;
}

export type CellStatus = 'exact' | 'wildcard' | 'missing';

export interface CoverageCell {
  combo: Record<string, string>;
  status: CellStatus;
  /** Game-relative file that serves the combination. */
  file?: string;
  /** File name the combination needs (the shot to take when missing). */
  expected: string;
}

export interface CoverageRow {
  patternKey: string;
  step: number | null;
  /** Placeholder keys the combinations vary over. */
  keys: string[];
  lines: number[];
  video: boolean;
  cells: CoverageCell[];
  exact: number;
  wildcard: number;
  missing: number;
  /** Too many combinations — only the first ones were checked. */
  truncated?: boolean;
  /** Path template the cells were filled from (the definition's pattern). */
  template?: string;
}

export interface PathSummary {
  description: string;
  selections: Record<string, number>;
  /** stat → changes in order (e.g. inhibition: [DEC_SMALL]). */
  effects: Record<string, string[]>;
  endType?: string;
}

export interface EventCheckResult {
  eventLabel: string;
  paths: PathSummary[];
  truncated: boolean;
  issues: CheckIssue[];
  coverage: CoverageRow[];
}

const MAX_PATHS = 96;
const MAX_COMBOS = 600;
const LEVELS = Array.from({ length: 10 }, (_, i) => String(i + 1));

type BuildFn = (selections: Record<string, number>) => Timeline;

/** Every path through the event's branches (depth first; capped). */
export function enumeratePaths(build: BuildFn, maxPaths = MAX_PATHS): { paths: { selections: Record<string, number>; timeline: Timeline }[]; truncated: boolean } {
  const out: { selections: Record<string, number>; timeline: Timeline }[] = [];
  const stack: Record<string, number>[] = [{}];
  let truncated = false;
  while (stack.length) {
    if (out.length >= maxPaths) {
      truncated = true;
      break;
    }
    const sel = stack.pop()!;
    const tl = build(sel);
    const open = tl.branches.find((b) => !(b.id in sel));
    if (!open) {
      out.push({ selections: sel, timeline: tl });
      continue;
    }
    const options = open.options.map((_, i) => i).filter((i) => open.enabled?.[i] !== false);
    for (const i of options.reverse()) {
      stack.push({ ...sel, [open.id]: i });
    }
    if (!options.length) {
      out.push({ selections: { ...sel, [open.id]: open.selected }, timeline: tl });
    }
  }
  return { paths: out, truncated };
}

/** first-match if/elif/else: what each key may be on this path (given known domains). */
function pathConstraints(tl: Timeline, domains: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const narrow = (k: string, vals: string[]) => {
    out[k] = out[k] ? out[k].filter((v) => vals.includes(v)) : [...vals];
  };
  for (const b of tl.branches) {
    if (b.kind !== 'if' || !b.bindings) {
      continue;
    }
    const keys = new Set(b.bindings.slice(0, b.selected + 1).flatMap((x) => Object.keys(x)));
    for (const k of keys) {
      const own = b.bindings[b.selected]?.[k];
      const base = own ?? domains[k];
      if (!base) {
        continue;
      }
      const taken = new Set(b.bindings.slice(0, b.selected).flatMap((x) => x[k] ?? []));
      narrow(k, base.filter((v) => !taken.has(v)));
    }
  }
  return out;
}

function placeholders(template: string): string[] {
  return [...normalizePatternPath(template).matchAll(/<([^>]+)>/g)].map((m) => m[1]);
}

export function fill(template: string, combo: Record<string, string>, step: number | null): string {
  let t = normalizePatternPath(template);
  for (const [k, v] of Object.entries(combo)) {
    t = t.split(`<${k}>`).join(v);
  }
  if (step !== null) {
    t = t.split('<step>').join(String(step));
  }
  return t;
}

function gatesAllow(combo: Record<string, string>, gates: Record<string, Record<string, Gate[]>>, constraints: Record<string, string[]>): boolean {
  for (const [k, v] of Object.entries(combo)) {
    const list = gates[k]?.[v];
    if (!list) {
      continue;
    }
    const ok = list.some((g) =>
      Object.entries(g).every(([gk, gv]) => (gk in combo ? gv.includes(combo[gk]) : constraints[gk] ? constraints[gk].some((x) => gv.includes(x)) : true))
    );
    if (!ok) {
      return false;
    }
  }
  return true;
}

function combosFor(keys: string[], domains: Record<string, string[]>, constraints: Record<string, string[]>, gates: Record<string, Record<string, Gate[]>>): { combos: Record<string, string>[]; truncated: boolean } {
  let combos: Record<string, string>[] = [{}];
  let truncated = false;
  for (const k of keys) {
    const vals = (domains[k] ?? []).filter((v) => !constraints[k] || constraints[k].includes(v));
    const next: Record<string, string>[] = [];
    for (const c of combos) {
      for (const v of vals) {
        if (next.length >= MAX_COMBOS) {
          truncated = true;
          break;
        }
        next.push({ ...c, [k]: v });
      }
    }
    combos = next;
  }
  return { combos: combos.filter((c) => gatesAllow(c, gates, constraints)), truncated };
}

interface RefEntry {
  ref: ImageRef;
  constraints: Record<string, string[]>;
  selections: Record<string, number>;
}

function refsOf(tl: Timeline): ImageRef[] {
  const out: ImageRef[] = [];
  for (const s of tl.stops) {
    if (s.image && !s.image.legacy) {
      out.push(s.image);
    }
    for (const a of s.alternatives ?? []) {
      if (a.image) {
        out.push(a.image);
      }
    }
  }
  for (const m of tl.markers) {
    if (m.kind === 'image' && m.image) {
      out.push(m.image);
    }
  }
  return out.filter((r) => r.kind === 'show' || r.kind === 'show_image' || r.kind === 'show_video' || r.kind === 'show_pattern');
}

function eventSpanText(text: string, labels: LabelDefinition[], line: number): string {
  const span = topLevelLabelSpan(labels, line);
  const rows = text.split('\n');
  return rows.slice(span.startLine, Math.min(span.endLine + 1, rows.length)).join('\n');
}

function effectsOf(tl: Timeline): { effects: Record<string, string[]>; endType?: string } {
  const effects: Record<string, string[]> = {};
  let endType: string | undefined;
  for (const m of tl.markers) {
    if (m.kind === 'stats') {
      for (const s of m.stats ?? ([] as StatChange[])) {
        (effects[s.stat] ??= []).push(s.value);
      }
    } else if (m.kind === 'end') {
      endType = m.endType;
    }
  }
  return { effects, endType };
}

export async function runEventCheck(
  index: WorkspaceIndex,
  uri: vscode.Uri,
  text: string,
  labels: LabelDefinition[],
  atLine: number
): Promise<EventCheckResult> {
  const span = topLevelLabelSpan(labels, atLine);
  const top = labels.find((l) => !l.isSub && l.range.start.line === span.startLine) ?? labelAtLine(labels, atLine);
  const eventLabel = top ? top.name.split('.')[0] : '';
  const persons = index.getPersonIndex();
  const build: BuildFn = (selections) =>
    buildEventTimeline(text, labels, persons, span.startLine, (line) => {
      const lab = labelAtLine(labels, line);
      return lab ? index.getSelectorValuesForLabel(lab.name) : {};
    }, { selections });
  const { paths, truncated } = enumeratePaths(build);
  const issues: CheckIssue[] = [];
  if (truncated) {
    issues.push({ severity: 'info', code: 'paths', message: `More than ${MAX_PATHS} paths — only the first ${MAX_PATHS} were checked.` });
  }

  // ── Definitions: selector domains, gates, level limits, placeholder hints ──
  const domains: Record<string, string[]> = {};
  const gates: Record<string, Record<string, Gate[]>> = {};
  const selectorKeys = new Set<string>();
  const levelLimits: Record<string, string[]> = {};
  /** Top-level conditions of the definition(s) — e.g. NumCompareCondition("level", 3, "<=") limits level. */
  const keyRestrictions: PyCall[] = [];
  // A fragment runs inside its EventComposite: the composite's selectors, conditions and
  // level limits apply too (its definition first, the fragment's own keys win).
  const defLabels = [...index.getFragmentParents(eventLabel), eventLabel];
  const defs: { uri: vscode.Uri; label: string }[] = [];
  for (const defLabel of defLabels) {
    const seenUri = new Set<string>();
    for (const ev of index.getEventsForLabel(defLabel)) {
      if (!seenUri.has(ev.uri.toString())) {
        seenUri.add(ev.uri.toString());
        defs.push({ uri: ev.uri, label: defLabel });
      }
    }
  }
  for (const { uri: du, label: defLabel } of defs) {
    const defText = du.toString() === uri.toString() ? text : (await vscode.workspace.openTextDocument(du)).getText();
    for (const header of findEventDefs(defText, defLabel)) {
      for (const o of eventSelectorOutputs(defText, header.call)) {
        selectorKeys.add(o.key);
        if (o.values.length) {
          domains[o.key] = [...new Set([...(domains[o.key] ?? []), ...o.values])];
        }
        if (o.when) {
          gates[o.key] = { ...(gates[o.key] ?? {}), ...o.when };
        }
      }
      for (const a of header.call.args) {
        if (a.call && !a.name) {
          keyRestrictions.push(a.call);
        }
        if (a.call?.name === 'LevelCondition') {
          const lc = a.call;
          const pos = lc.args.filter((x) => !x.name && !x.star);
          const pattern = decodeValue((lc.args.find((x) => x.name === 'value') ?? pos[0])?.value ?? '').value;
          const char = decodeValue((lc.args.find((x) => x.name === 'char_obj') ?? pos[1])?.value ?? '"school"').value || 'school';
          // Composite and fragment conditions must both hold.
          const allowed = LEVELS.filter((l) => matchNumberPattern(pattern, Number(l)));
          const lk = `${char}_level`;
          levelLimits[lk] = levelLimits[lk] ? levelLimits[lk].filter((l) => allowed.includes(l)) : allowed;
        }
      }
      for (const h of placeholderHints(header.call)) {
        issues.push({ severity: 'warning', code: 'placeholder', message: h });
      }
    }
  }
  for (const c of keyRestrictions) {
    const pos = c.args.filter((x) => !x.name && !x.star);
    const arg = (name: string, i: number) => c.args.find((x) => x.name === name) ?? pos[i];
    const key = decodeValue(arg('key', 0)?.value ?? '').value;
    const dom = domains[key];
    if (!dom) {
      continue;
    }
    const raw = decodeValue(arg('value', 1)?.value ?? '');
    let keep: ((v: string) => boolean) | undefined;
    if (c.name === 'NumCompareCondition' && raw.kind === 'number') {
      const op = decodeValue(arg('operation', 2)?.value ?? '').value;
      const n = Number(raw.value);
      const cmp: Record<string, (x: number) => boolean> = {
        '>': (x) => x > n, '>=': (x) => x >= n, '<': (x) => x < n, '<=': (x) => x <= n, '==': (x) => x === n, '!=': (x) => x !== n,
      };
      if (cmp[op]) {
        keep = (v) => cmp[op](Number(v));
      }
    } else if (c.name === 'NumValueCondition' && (raw.kind === 'string' || raw.kind === 'number')) {
      keep = (v) => matchNumberPattern(raw.value, Number(v));
    } else if ((c.name === 'ValueCondition' || c.name === 'CompareCondition') && (raw.kind === 'string' || raw.kind === 'number' || raw.kind === 'bool')) {
      keep = (v) => v === raw.value;
    }
    if (keep) {
      domains[key] = dom.filter(keep);
    }
  }
  const patternsByKey = new Map<string, EventPatternInfo[]>();
  for (const p of index.getPatternsForLabel(eventLabel)) {
    patternsByKey.set(p.patternKey, [...(patternsByKey.get(p.patternKey) ?? []), p]);
  }
  for (const k of new Set([...patternsByKey.values()].flat().flatMap((p) => placeholders(p.pathTemplate)))) {
    if (isLevelKey(k)) {
      // A character never goes below its starting level (secretary starts at 5).
      const start = k.endsWith('_level') ? index.getStartLevel(k.slice(0, -'_level'.length)) : 1;
      const base = (domains[k] ?? LEVELS).filter((v) => Number(v) >= start);
      domains[k] = levelLimits[k] ? base.filter((v) => levelLimits[k].includes(v)) : base;
    }
  }

  // ── Coverage ──
  const entries: RefEntry[] = [];
  for (const p of paths) {
    const constraints = pathConstraints(p.timeline, domains);
    for (const ref of refsOf(p.timeline)) {
      entries.push({ ref, constraints, selections: p.selections });
    }
  }
  const unbound = new Set<number>();
  const rows = new Map<string, CoverageRow & { combos: Map<string, Record<string, string>> }>();
  for (const e of entries) {
    if (!e.ref.patternKey) {
      if (!unbound.has(e.ref.line)) {
        unbound.add(e.ref.line);
        issues.push({
          severity: 'error',
          code: 'unbound',
          message: `\`${e.ref.variableName ?? 'image'}\` is not bound by convert_pattern(…) in this event — the image cannot resolve.`,
          line: e.ref.line,
          selections: e.selections,
        });
      }
      continue;
    }
    const pats = patternsByKey.get(e.ref.patternKey);
    if (!pats?.length) {
      if (!unbound.has(e.ref.line)) {
        unbound.add(e.ref.line);
        issues.push({ severity: 'error', code: 'pattern', message: `Pattern "${e.ref.patternKey}" is not defined for ${eventLabel}.`, line: e.ref.line });
      }
      continue;
    }
    const step = e.ref.kind === 'show_pattern' ? null : e.ref.steps[0] ?? null;
    // Values the binding call fixes (`convert_pattern("card", {"girls": "x"})`, with_values)
    // replace the selector's domain: only that one value is needed for this image.
    const fixed = e.ref.fixedValues ?? {};
    const fixedKeys = Object.keys(fixed);
    const dom = fixedKeys.length ? { ...domains, ...Object.fromEntries(fixedKeys.map((k) => [k, [fixed[k]]])) } : domains;
    const refConstraints = fixedKeys.length ? Object.fromEntries(Object.entries(e.constraints).filter(([k]) => !(k in fixed))) : e.constraints;
    const refGates = fixedKeys.length ? Object.fromEntries(Object.entries(gates).filter(([k]) => !(k in fixed))) : gates;
    const keys = [...new Set(pats.flatMap((p) => placeholders(p.pathTemplate)))].filter((k) => k !== 'step' && dom[k]?.length);
    const rowKey = `${e.ref.patternKey}|${step}|${e.ref.kind === 'show_video' ? 'video' : 'image'}`;
    let row = rows.get(rowKey);
    if (!row) {
      row = { patternKey: e.ref.patternKey, step, keys, lines: [], video: false, cells: [], exact: 0, wildcard: 0, missing: 0, combos: new Map() };
      rows.set(rowKey, row);
    }
    if (!row.lines.includes(e.ref.line)) {
      row.lines.push(e.ref.line);
    }
    for (const k of keys) {
      if (!row.keys.includes(k)) {
        row.keys.push(k);
      }
    }
    row.video = e.ref.kind === 'show_video';
    const { combos, truncated: t } = combosFor(keys, dom, refConstraints, refGates);
    row.truncated ||= t;
    for (const c of combos) {
      row.combos.set(JSON.stringify(c), c);
    }
  }

  const fileCache = new Map<string, ResolvedImageInfo[]>();
  const filesFor = async (key: string): Promise<ResolvedImageInfo[]> => {
    if (!fileCache.has(key)) {
      const site: ImageCallSite = { kind: 'show', range: new vscode.Range(0, 0, 0, 1), patternKey: key, steps: [], paramConstraints: {} };
      fileCache.set(key, await resolveImagesForCall(site, patternsByKey.get(key) ?? [], { maxResults: 5000 }).catch(() => []));
    }
    return fileCache.get(key)!;
  };
  const coverage: CoverageRow[] = [];
  for (const row of rows.values()) {
    const files = await filesFor(row.patternKey);
    const template = patternsByKey.get(row.patternKey)![0].pathTemplate;
    row.template = template;
    const hasStep = placeholders(template).includes('step');
    for (const combo of row.combos.values()) {
      const candidates = files.filter(
        (f) => (!hasStep || row.step === null || f.params.step === String(row.step)) && Object.entries(combo).every(([k, v]) => f.params[k] === v || f.params[k] === '$')
      );
      const exact = candidates.find((f) => Object.entries(combo).every(([k, v]) => f.params[k] === v));
      const wild = exact ? undefined : candidates[0];
      const hit = exact ?? wild;
      row.cells.push({ combo, status: exact ? 'exact' : wild ? 'wildcard' : 'missing', file: hit?.relativePath, expected: fill(template, combo, row.step) });
    }
    row.exact = row.cells.filter((c) => c.status === 'exact').length;
    row.wildcard = row.cells.filter((c) => c.status === 'wildcard').length;
    row.missing = row.cells.filter((c) => c.status === 'missing').length;
    const { combos: _drop, ...plain } = row;
    void _drop;
    coverage.push(plain);
    if (row.missing) {
      const sample = row.cells.filter((c) => c.status === 'missing').slice(0, 4).map((c) => Object.values(c.combo).join('/') || c.expected);
      issues.push({
        severity: 'error',
        code: 'image',
        message: `${row.patternKey}${row.step !== null ? ` ${row.video ? 'video' : 'step'} ${row.step}` : ''}: ${row.missing} of ${row.cells.length} image(s) missing${sample.length ? ` (${sample.join(', ')}${row.missing > sample.length ? ', …' : ''})` : ''}`,
        line: row.lines[0],
      });
    }
    if (row.truncated) {
      issues.push({ severity: 'info', code: 'combos', message: `${row.patternKey} step ${row.step}: more than ${MAX_COMBOS} combinations — the rest were not checked.`, line: row.lines[0] });
    }
  }
  coverage.sort((a, b) => a.patternKey.localeCompare(b.patternKey) || (a.step ?? -1) - (b.step ?? -1));

  // ── Videos: Movie declarations + .webm files ──
  const roots = await getImageRoots();
  const localMovies = new Map(scanMovieDefs(text).map((d) => [d.name, d]));
  const lines = text.split('\n');
  const seenMovie = new Set<string>();
  for (const e of entries.filter((x) => x.ref.kind === 'show_video' && x.ref.patternKey)) {
    const row = coverage.find((r) => r.video && r.patternKey === e.ref.patternKey && r.step === (e.ref.steps[0] ?? null));
    const prefix = videoPrefixFor(lines, e.ref.variableName, span.startLine, e.ref.line);
    for (const cell of row?.cells ?? []) {
      const base = cell.file ?? cell.expected;
      const name = movieNameFor(base, prefix);
      if (seenMovie.has(name)) {
        continue;
      }
      seenMovie.add(name);
      const indexed = index.getMovie(name);
      const def = localMovies.get(name) ?? (indexed && indexed.uri.toString() !== uri.toString() ? indexed.def : undefined);
      if (!def) {
        issues.push({ severity: 'error', code: 'movie', message: `No Movie declaration for ${name} (show_video ${e.ref.steps[0]}) — add it in the image module.`, line: e.ref.line, selections: e.selections });
        continue;
      }
      const play = def.play ?? siblingVideoPath(base);
      if (!findUnderRoots(play, roots)) {
        issues.push({ severity: 'error', code: 'webm', message: `${name} plays a missing file: ${play}`, line: def.line });
      }
    }
  }

  // ── Menus ──
  const labelNames = new Set(labels.map((l) => l.name));
  const seenMenu = new Set<number>();
  for (const p of paths) {
    for (const m of p.timeline.markers.filter((x) => x.kind === 'menu')) {
      if (seenMenu.has(m.line)) {
        continue;
      }
      seenMenu.add(m.line);
      for (const c of m.choices ?? []) {
        if (!c.target) {
          issues.push({ severity: 'warning', code: 'menu', message: `Menu choice "${c.title}" has no string EventEffect target — it cannot be previewed or checked.`, line: m.line });
        } else {
          const target = c.target.startsWith('.') ? `${eventLabel}${c.target}` : c.target;
          if (!labelNames.has(target) && !index.getLabel(target)) {
            issues.push({ severity: 'error', code: 'menu', message: `Menu choice "${c.title}" jumps to ${target}, which does not exist.`, line: m.line });
          }
        }
      }
    }
  }

  // ── Every event label must end the event (end_event / menu / jump / return) ──
  const sorted = [...labels].sort((a, b) => a.range.start.line - b.range.start.line);
  for (const lab of sorted.filter((l) => l.name === eventLabel || l.name.startsWith(eventLabel + '.'))) {
    const next = sorted.find((l) => l.range.start.line > lab.range.start.line);
    const bodyRows = lines.slice(lab.range.start.line + 1, next ? next.range.start.line : lines.length);
    const body = bodyRows.join('\n');
    // Handing off with a final `call other_label(…)` (e.g. start_sandbox) ends it too.
    const stmts = bodyRows.filter((r) => r.trim() && !r.trim().startsWith('#'));
    const baseIndent = stmts.length ? stmts[0].length - stmts[0].trimStart().length : 0;
    let endsWithCall = false;
    for (const r of stmts.filter((x) => x.length - x.trimStart().length === baseIndent)) {
      if (/^\s*call\s+[A-Za-z_]/.test(r)) {
        endsWithCall = true;
      } else if (!/^\s*(\*\*|\)|[^=]*\)\s*(from\s+[A-Za-z_][A-Za-z0-9_]*)?\s*$)/.test(r)) {
        // A real statement after the call (closing lines of a multi-line call don't count).
        endsWithCall = false;
      }
    }
    if (endsWithCall) {
      continue;
    }
    if (!/\bend_event\s*\(|call_custom_menu|^\s*jump\b|^\s*return\b|\brenpy\.(?:jump|call|call_screen)\s*\(|^\s*call\s+screen\b/m.test(body)) {
      issues.push({ severity: 'warning', code: 'end', message: `Label ${lab.name} never ends the event (no end_event / menu / jump / return / call screen).`, line: lab.range.start.line });
    }
  }

  // ── Speakers and [text] variables ──
  const spanText = eventSpanText(text, labels, span.startLine);
  const assigned = (name: string) => new RegExp(`^\\s*\\$?\\s*${name}\\s*=(?!=)`, 'm').test(spanText);
  const seenSpeaker = new Set<string>();
  const seenVar = new Set<string>();
  for (const p of paths) {
    for (const s of p.timeline.stops) {
      if (s.kind === 'dialog' && s.speaker && !seenSpeaker.has(s.speaker)) {
        seenSpeaker.add(s.speaker);
        const ok = s.speaker === 'subtitles' || s.speaker === 'character' || index.isGlobalCharacter(s.speaker) || assigned(s.speaker);
        if (!ok) {
          issues.push({ severity: 'warning', code: 'speaker', message: `Speaker "${s.speaker}" is never loaded in this event (add $ ${s.speaker} = Person["…"]).`, line: s.line, selections: p.selections });
        }
      }
      const texts = [s.text, ...(s.alternatives ?? []).map((a) => a.text)];
      for (const t of texts) {
        for (const m of t.matchAll(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g)) {
          const v = m[1];
          if (seenVar.has(v)) {
            continue;
          }
          seenVar.add(v);
          if (!selectorKeys.has(v) && !assigned(v) && !index.isGlobalName(v)) {
            issues.push({ severity: 'info', code: 'text', message: `[${v}] in the text is not set by this event's selectors or code.`, line: s.line });
          }
        }
      }
    }
  }

  // ── Path summaries (stat effects + how each path ends) ──
  const summaries: PathSummary[] = paths.map((p) => {
    const parts = p.timeline.branches.map((b) => b.options[b.selected] ?? '?');
    return { description: parts.join(' › ') || '(single path)', selections: p.selections, ...effectsOf(p.timeline) };
  });

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity] || (a.line ?? 0) - (b.line ?? 0));
  return { eventLabel, paths: summaries, truncated, issues, coverage };
}

/** Shot list (CSV) of every missing image, one row per file to shoot. */
export function shotListCsv(result: EventCheckResult): string {
  const rows = [['file', 'pattern', 'step', 'placeholders', 'script lines'].join(',')];
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  for (const r of result.coverage) {
    for (const c of r.cells.filter((x) => x.status === 'missing')) {
      rows.push(
        [
          q(c.expected),
          q(r.patternKey),
          r.step ?? '',
          q(Object.entries(c.combo).map(([k, v]) => `${k}=${v}`).join(' ')),
          q(r.lines.map((l) => l + 1).join(' ')),
        ].join(',')
      );
    }
  }
  return rows.join('\n') + '\n';
}

