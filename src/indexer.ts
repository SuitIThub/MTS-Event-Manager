import { MovieDef, scanMovieDefs } from './videoResolve';
import { mineParamUsage, ParamUsage, usageFor } from './paramUsage';
import { compositeStorages, scanCharacters, scanGlobals, scanInlineAddedEvents, scanPools, scanStartLevels } from './workspaceFacts';
import { positionToOffset } from './scan';
import * as vscode from 'vscode';
import { parseEventsInDocument, parsePatternOverrides } from './parseEvents';
import { scanRegisteredPresets } from './paperdollScript';
import { PresetDef, setWorkspacePresets } from './paperdollResolve';
import { parseLabelsInDocument } from './parseLabels';
import {
  labelNameForImageCall,
  parseImageCallsInDocument,
} from './parseImageCalls';
import {
  buildPersonIndex,
  mergeSelectorValues,
  parseDefaultNames,
  parsePersonsInDocument,
  PersonIndexData,
} from './parsePersons';
import { buildSchemaRegistry, collectRawClasses } from './parseSchema';
import {
  ClassSchema,
  EventDefinition,
  EventPatternInfo,
  LabelDefinition,
  PatternUsage,
  PersonInfo,
  SchemaKind,
} from './types';

/** Everything the index derives from one file — reused while the file's text is unchanged. */
interface FileFacts {
  text: string;
  /** Disk modification time the text was read at (-1: from an open buffer). */
  mtime?: number;
  events: EventDefinition[];
  movies: MovieDef[];
  persons: PersonInfo[];
  defaultNames: { key: string; first: string; last: string }[];
  labels: LabelDefinition[];
  usages: PatternUsage[];
  raw: ReturnType<typeof collectRawClasses>;
  hasEventSyntax: boolean;
  /** `overwrite_event_image(…)` calls of this file. */
  overrides: { label: string; pattern: EventPatternInfo }[];
  /** `register_preset(…)` paperdoll presets of this file. */
  presets: PresetDef[];
}

function fileFacts(uri: vscode.Uri, text: string): FileFacts {
  const labels = parseLabelsInDocument(uri, text);
  const usages: PatternUsage[] = [];
  for (const site of parseImageCallsInDocument(text, labels)) {
    if (site.kind !== 'convert_pattern' && site.kind !== 'show_pattern') {
      continue;
    }
    if (!site.patternKey) {
      continue;
    }
    const labelName = labelNameForImageCall(labels, site);
    if (!labelName) {
      continue;
    }
    usages.push({ kind: site.kind, patternKey: site.patternKey, labelName, uri, range: site.range });
  }
  return {
    text,
    events: parseEventsInDocument(uri, text),
    movies: text.includes('Movie(') ? scanMovieDefs(text) : [],
    persons: parsePersonsInDocument(text),
    defaultNames: parseDefaultNames(text),
    labels,
    usages,
    raw: collectRawClasses(uri, text),
    hasEventSyntax: /\bEvent(?:Fragment|Composite|Select)?\s*\(/.test(text),
    overrides: parsePatternOverrides(uri, text),
    presets: scanRegisteredPresets(text),
  };
}

export class WorkspaceIndex {
  /** Per-file parse results; a reindex only re-parses files whose text changed. */
  private fileCache = new Map<string, FileFacts>();
  private events: EventDefinition[] = [];
  private labels = new Map<string, LabelDefinition[]>();
  private patternUsages: PatternUsage[] = [];
  private schemas = new Map<string, ClassSchema>();
  /** `image NAME = Movie(...)` declarations across the workspace (incl. mods). */
  private movies = new Map<string, { uri: vscode.Uri; def: MovieDef }>();
  /** Literal values used per `Class.param` across the workspace (for editor suggestions). */
  private paramUsage: ParamUsage = new Map();
  /** Pool expression → event labels added to it (`pool.add_event(ev1, …)`). */
  private pools = new Map<string, string[]>();
  /** Fragment label → the EventComposite label(s) whose storages it is added to. */
  private fragmentParents = new Map<string, string[]>();
  /** Event label → mod replacement patterns (`overwrite_event_image`). */
  private patternOverrides = new Map<string, EventPatternInfo[]>();
  /** Speakers defined globally (`define character.X`). */
  private characters = new Set<string>();
  /** Store variables assigned anywhere (`$ x =`, define, default). */
  private globals = new Set<string>();
  /** Lowest level a character is ever set to (its starting level). */
  private startLevels = new Map<string, number>();
  private persons: PersonIndexData = buildPersonIndex([], []);
  private _hasEventSyntax = false;
  private _version = 0;

  private debounceTimer: NodeJS.Timeout | undefined;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  get version(): number {
    return this._version;
  }

  get hasEventSyntax(): boolean {
    return this._hasEventSyntax;
  }

  getAllEvents(): readonly EventDefinition[] {
    return this.events;
  }

  getEventsForLabel(labelName: string): EventDefinition[] {
    return this.events.filter((e) => e.labelName === labelName);
  }

  getLabel(labelName: string): LabelDefinition | undefined {
    return this.labels.get(labelName)?.[0];
  }

  getLabelsForUri(uri: vscode.Uri): LabelDefinition[] {
    const out: LabelDefinition[] = [];
    for (const list of this.labels.values()) {
      for (const l of list) {
        if (l.uri.toString() === uri.toString()) {
          out.push(l);
        }
      }
    }
    return out;
  }

  getEventsForUri(uri: vscode.Uri): EventDefinition[] {
    return this.events.filter((e) => e.uri.toString() === uri.toString());
  }

  /**
   * All Pattern infos from events targeting this label (optionally filtered by key).
   * Sublabels (`parent.sub`) inherit patterns from the parent event label.
   */
  getParamUsage(className: string, param: string): { value: string; count: number }[] {
    return usageFor(this.paramUsage, className, param);
  }

  /** Pools the label's event is added to. */
  getPoolsOfLabel(labelName: string): string[] {
    return [...this.pools.entries()].filter(([, labels]) => labels.includes(labelName)).map(([pool]) => pool);
  }

  getPoolLabels(pool: string): string[] {
    return this.pools.get(pool) ?? [];
  }

  getAllPools(): ReadonlyMap<string, string[]> {
    return this.pools;
  }

  isGlobalCharacter(name: string): boolean {
    return this.characters.has(name);
  }

  /** Starting level of a character key (school, teacher, parent, secretary), default 1. */
  getStartLevel(char: string): number {
    return this.startLevels.get(char) ?? 1;
  }

  isGlobalName(name: string): boolean {
    return this.globals.has(name);
  }

  getMovie(name: string): { uri: vscode.Uri; def: MovieDef } | undefined {
    return this.movies.get(name);
  }

  getPersonIndex(): PersonIndexData {
    return this.persons;
  }

  /** EventComposite label(s) a fragment label (or its sublabel) belongs to. */
  getFragmentParents(labelName: string): string[] {
    return this.fragmentParents.get(labelName.split('.')[0]) ?? [];
  }

  getSelectorValuesForLabel(labelName: string): Record<string, string[]> {
    const names = [labelName];
    const dot = labelName.indexOf('.');
    if (dot > 0) {
      names.push(labelName.slice(0, dot));
    }
    const events = names.flatMap((n) => this.getEventsForLabel(n));
    const parents = this.getFragmentParents(labelName);
    if (!parents.length) {
      return mergeSelectorValues(events);
    }
    // The composite's values are passed to the fragment; the fragment's own keys win.
    return { ...mergeSelectorValues(parents.flatMap((n) => this.getEventsForLabel(n))), ...mergeSelectorValues(events) };
  }

  getPatternsForLabel(labelName: string, patternKey?: string): EventPatternInfo[] {
    const out: EventPatternInfo[] = [];
    const seen = new Set<string>();
    const names = [labelName];
    const dot = labelName.indexOf('.');
    if (dot > 0) {
      names.push(labelName.slice(0, dot));
    }
    const own = new Set(names.flatMap((n) => this.getEventsForLabel(n)).flatMap((e) => e.patterns.map((p) => p.patternKey)));
    const parents = this.getFragmentParents(labelName);
    for (const name of [...names, ...parents]) {
      const inherited = parents.includes(name);
      for (const ev of this.getEventsForLabel(name)) {
        for (const p of ev.patterns) {
          if (patternKey && p.patternKey !== patternKey) {
            continue;
          }
          if (inherited && own.has(p.patternKey)) {
            continue;
          }
          const id = `${p.patternKey}|${p.pathTemplate}`;
          if (seen.has(id)) {
            continue;
          }
          seen.add(id);
          out.push(p);
        }
      }
    }
    // Mod replacements (overwrite_event_image): while the mod is on, its files are used —
    // either set satisfies the key, so they are listed after the definition's own.
    for (const name of [...names, ...parents]) {
      for (const p of this.patternOverrides.get(name) ?? []) {
        if (patternKey && p.patternKey !== patternKey) {
          continue;
        }
        const id = `${p.patternKey}|${p.pathTemplate}`;
        if (!seen.has(id)) {
          seen.add(id);
          out.push(p);
        }
      }
    }
    return out;
  }

  getPatternLocations(labelName: string, patternKey: string): vscode.Location[] {
    const out: vscode.Location[] = [];
    const seen = new Set<string>();
    const names = [labelName];
    const dot = labelName.indexOf('.');
    if (dot > 0) {
      names.push(labelName.slice(0, dot));
    }
    const ownKey = names.some((n) => this.getEventsForLabel(n).some((e) => e.patterns.some((p) => p.patternKey === patternKey)));
    for (const name of ownKey ? names : [...names, ...this.getFragmentParents(labelName)]) {
      for (const ev of this.getEventsForLabel(name)) {
        for (const p of ev.patterns) {
          if (p.patternKey !== patternKey) {
            continue;
          }
          const id = `${ev.uri.toString()}::${p.range.start.line}::${p.range.start.character}`;
          if (seen.has(id)) {
            continue;
          }
          seen.add(id);
          out.push(new vscode.Location(ev.uri, p.range));
        }
      }
    }
    for (const name of [...names, ...this.getFragmentParents(labelName)]) {
      for (const p of this.patternOverrides.get(name) ?? []) {
        if (p.patternKey === patternKey && p.override) {
          out.push(new vscode.Location(p.override.uri, p.range));
        }
      }
    }
    return out;
  }

  getPatternUsages(eventLabelName: string, patternKey: string): PatternUsage[] {
    return this.patternUsages.filter((u) => {
      if (u.patternKey !== patternKey) {
        return false;
      }
      return u.labelName === eventLabelName || u.labelName.startsWith(eventLabelName + '.');
    });
  }

  getSchema(name: string): ClassSchema | undefined {
    return this.schemas.get(name);
  }

  getSchemasByKind(kind: SchemaKind): ClassSchema[] {
    return [...this.schemas.values()]
      .filter((s) => s.kind === kind && !isRootOnlyName(s.name, kind))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Insertable schemas: concrete subclasses; Pattern root is insertable. */
  getInsertableSchemas(kind: SchemaKind): ClassSchema[] {
    const exclude = new Set(['Condition', 'Selector', 'Option', 'Event']);
    return [...this.schemas.values()]
      .filter((s) => s.kind === kind && !exclude.has(s.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  scheduleReindex(delayMs = 300): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.reindex();
    }, delayMs);
  }

  async reindex(): Promise<void> {
    const files = await vscode.workspace.findFiles('**/*.rpy', '**/{node_modules,out,.git}/**');
    const events: EventDefinition[] = [];
    const labels = new Map<string, LabelDefinition[]>();
    const patternUsages: PatternUsage[] = [];
    const allRaw = [];
    const texts = new Map<string, string>();
    const allPersons: PersonInfo[] = [];
    const movies = new Map<string, { uri: vscode.Uri; def: MovieDef }>();
    const allDefaultNames: { key: string; first: string; last: string }[] = [];
    let hasEventSyntax = false;
    const seen = new Set<string>();
    const openDocs = new Map(vscode.workspace.textDocuments.map((d) => [d.uri.toString(), d]));
    const mtimes = new Map<string, number>();

    for (const uri of files) {
      let text: string;
      try {
        const doc = openDocs.get(uri.toString());
        if (doc) {
          text = doc.getText();
        } else {
          // Closed file: re-read only when it changed on disk.
          const cached = this.fileCache.get(uri.toString());
          const mtime = await vscode.workspace.fs.stat(uri).then((s) => s.mtime, () => -1);
          if (cached && cached.mtime === mtime && mtime >= 0) {
            text = cached.text;
          } else {
            const bytes = await vscode.workspace.fs.readFile(uri);
            text = Buffer.from(bytes).toString('utf8');
            mtimes.set(uri.toString(), mtime);
          }
        }
      } catch {
        continue;
      }

      const key = uri.toString();
      texts.set(key, text);
      let facts = this.fileCache.get(key);
      if (!facts || facts.text !== text) {
        facts = fileFacts(uri, text);
        this.fileCache.set(key, facts);
      }
      if (mtimes.has(key)) {
        facts.mtime = mtimes.get(key)!;
      } else if (openDocs.has(key)) {
        // Open buffer may differ from disk: force a re-read once it is closed.
        facts.mtime = -1;
      }
      seen.add(key);
      hasEventSyntax ||= facts.hasEventSyntax;
      events.push(...facts.events);
      for (const def of facts.movies) {
        movies.set(def.name, { uri, def });
      }
      allPersons.push(...facts.persons);
      allDefaultNames.push(...facts.defaultNames);
      for (const lab of facts.labels) {
        const list = labels.get(lab.name) ?? [];
        list.push(lab);
        labels.set(lab.name, list);
      }
      patternUsages.push(...facts.usages);
      allRaw.push(...facts.raw);
    }
    for (const key of [...this.fileCache.keys()]) {
      if (!seen.has(key)) {
        this.fileCache.delete(key);
      }
    }

    const { schemas } = buildSchemaRegistry(allRaw, texts);

    this.events = events;
    this.labels = labels;
    this.patternUsages = patternUsages;
    this.schemas = schemas;
    this.movies = movies;
    const pools = new Map<string, string[]>();
    const characters = new Set<string>();
    const globals = new Set<string>();
    const startLevels = new Map<string, number>();
    /** Receiver of add_event → event labels (variables and inline EventFragment(…)). */
    const added = new Map<string, string[]>();
    for (const [uriKey, text] of texts) {
      for (const [char, lvl] of scanStartLevels(text)) {
        startLevels.set(char, Math.min(startLevels.get(char) ?? lvl, lvl));
      }
      scanCharacters(text).forEach((c) => characters.add(c));
      scanGlobals(text).forEach((g) => globals.add(g));
      if (!text.includes('add_event')) {
        continue;
      }
      // Event variables resolve within the file first, then workspace-wide.
      const local = new Map(events.filter((e) => e.uri.toString() === uriKey && e.variableName).map((e) => [e.variableName!, e.labelName]));
      for (const [pool, vars] of scanPools(text)) {
        const labels = vars
          .map((v) => local.get(v) ?? events.find((e) => e.variableName === v)?.labelName)
          .filter((l): l is string => !!l);
        if (labels.length) {
          pools.set(pool, [...new Set([...(pools.get(pool) ?? []), ...labels])]);
          added.set(pool, [...new Set([...(added.get(pool) ?? []), ...labels])]);
        }
      }
      for (const [recv, labels] of scanInlineAddedEvents(text)) {
        added.set(recv, [...new Set([...(added.get(recv) ?? []), ...labels])]);
      }
    }
    // Fragments inherit from their composite (engine: frag_image_patterns first, then the
    // composite's image_patterns; the composite's selector values are passed along).
    const patternOverrides = new Map<string, EventPatternInfo[]>();
    for (const key of texts.keys()) {
      for (const o of this.fileCache.get(key)?.overrides ?? []) {
        patternOverrides.set(o.label, [...(patternOverrides.get(o.label) ?? []), o.pattern]);
      }
    }
    this.patternOverrides = patternOverrides;
    // The paperdoll simulation reads the game's own preset table (mods may add presets).
    setWorkspacePresets([...texts.keys()].flatMap((key) => this.fileCache.get(key)?.presets ?? []));
    const fragmentParents = new Map<string, string[]>();
    for (const ev of events) {
      if (ev.kind !== 'EventComposite') {
        continue;
      }
      const text = texts.get(ev.uri.toString());
      if (!text) {
        continue;
      }
      const start = positionToOffset(text, ev.fullRange.start.line, ev.fullRange.start.character);
      for (const storage of compositeStorages(text, start)) {
        for (const frag of added.get(storage) ?? []) {
          if (frag !== ev.labelName) {
            fragmentParents.set(frag, [...new Set([...(fragmentParents.get(frag) ?? []), ev.labelName])]);
          }
        }
      }
    }
    this.fragmentParents = fragmentParents;
    this.pools = pools;
    this.characters = characters;
    this.globals = globals;
    this.startLevels = startLevels;
    this.paramUsage = mineParamUsage(texts.values(), (name) => schemas.get(name));
    this.persons = buildPersonIndex(allPersons, allDefaultNames);
    this._hasEventSyntax = hasEventSyntax;
    this._version++;
    this.onDidChangeEmitter.fire();
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.onDidChangeEmitter.dispose();
  }
}

function isRootOnlyName(name: string, kind: SchemaKind): boolean {
  const map: Record<SchemaKind, string> = {
    condition: 'Condition',
    selector: 'Selector',
    option: 'Option',
    pattern: 'Pattern',
    event: 'Event',
  };
  return name === map[kind];
}
