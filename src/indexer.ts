import * as vscode from 'vscode';
import { parseEventsInDocument } from './parseEvents';
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

export class WorkspaceIndex {
  private events: EventDefinition[] = [];
  private labels = new Map<string, LabelDefinition[]>();
  private patternUsages: PatternUsage[] = [];
  private schemas = new Map<string, ClassSchema>();
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
  getPersonIndex(): PersonIndexData {
    return this.persons;
  }

  getSelectorValuesForLabel(labelName: string): Record<string, string[]> {
    const names = [labelName];
    const dot = labelName.indexOf('.');
    if (dot > 0) {
      names.push(labelName.slice(0, dot));
    }
    const events = names.flatMap((n) => this.getEventsForLabel(n));
    return mergeSelectorValues(events);
  }

  getPatternsForLabel(labelName: string, patternKey?: string): EventPatternInfo[] {
    const out: EventPatternInfo[] = [];
    const seen = new Set<string>();
    const names = [labelName];
    const dot = labelName.indexOf('.');
    if (dot > 0) {
      names.push(labelName.slice(0, dot));
    }
    for (const name of names) {
      for (const ev of this.getEventsForLabel(name)) {
        for (const p of ev.patterns) {
          if (patternKey && p.patternKey !== patternKey) {
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
    for (const name of names) {
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
    const allDefaultNames: { key: string; first: string; last: string }[] = [];
    let hasEventSyntax = false;

    for (const uri of files) {
      let text: string;
      try {
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        if (doc) {
          text = doc.getText();
        } else {
          const bytes = await vscode.workspace.fs.readFile(uri);
          text = Buffer.from(bytes).toString('utf8');
        }
      } catch {
        continue;
      }

      texts.set(uri.toString(), text);

      if (
        /\bEvent\s*\(/.test(text) ||
        /\bEventFragment\s*\(/.test(text) ||
        /\bEventComposite\s*\(/.test(text) ||
        /\bEventSelect\s*\(/.test(text)
      ) {
        hasEventSyntax = true;
      }

      events.push(...parseEventsInDocument(uri, text));
      allPersons.push(...parsePersonsInDocument(text));
      allDefaultNames.push(...parseDefaultNames(text));
      const fileLabels = parseLabelsInDocument(uri, text);
      for (const lab of fileLabels) {
        const list = labels.get(lab.name) ?? [];
        list.push(lab);
        labels.set(lab.name, list);
      }
      for (const site of parseImageCallsInDocument(text, fileLabels)) {
        if (site.kind !== 'convert_pattern' && site.kind !== 'show_pattern') {
          continue;
        }
        if (!site.patternKey) {
          continue;
        }
        const labelName = labelNameForImageCall(fileLabels, site);
        if (!labelName) {
          continue;
        }
        patternUsages.push({
          kind: site.kind,
          patternKey: site.patternKey,
          labelName,
          uri,
          range: site.range,
        });
      }
      allRaw.push(...collectRawClasses(uri, text));
    }

    const { schemas } = buildSchemaRegistry(allRaw, texts);

    this.events = events;
    this.labels = labels;
    this.patternUsages = patternUsages;
    this.schemas = schemas;
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
