import * as vscode from 'vscode';
import { parseEventsInDocument } from './parseEvents';
import { parseLabelsInDocument } from './parseLabels';
import { buildSchemaRegistry, collectRawClasses } from './parseSchema';
import {
  ClassSchema,
  EventDefinition,
  LabelDefinition,
  SchemaKind,
} from './types';

export class WorkspaceIndex {
  private events: EventDefinition[] = [];
  private labels = new Map<string, LabelDefinition[]>();
  private schemas = new Map<string, ClassSchema>();
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
    const allRaw = [];
    const texts = new Map<string, string>();
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
      for (const lab of parseLabelsInDocument(uri, text)) {
        const list = labels.get(lab.name) ?? [];
        list.push(lab);
        labels.set(lab.name, list);
      }
      allRaw.push(...collectRawClasses(uri, text));
    }

    const { schemas } = buildSchemaRegistry(allRaw, texts);

    this.events = events;
    this.labels = labels;
    this.schemas = schemas;
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
