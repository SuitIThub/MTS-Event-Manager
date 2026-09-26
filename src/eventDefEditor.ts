import * as vscode from 'vscode';
import {
  buildCallCode,
  buildEventDefModel,
  CallModel,
  DefOp,
  EventDefModel,
  EventDefHeader,
  findEventDefs,
  insertSlotFor,
  ItemKind,
  placeholderHints,
  planDefOp,
  SchemaLookup,
} from './eventDef';
import { WorkspaceIndex } from './indexer';
import { formatSignature } from './parseSchema';
import { encodeValue, parsePyCall, ValueKind } from './pyCall';
import { applyVerifiedEdits } from './safeEdit';
import { ClassDomains, classDomains, DomainContext } from './paramDomains';
import { eventSelectorOutputs } from './selectorValues';

interface Typed {
  kind: ValueKind;
  value: string;
  quote?: '"' | "'";
}

function codeOf(t: Typed | undefined, raw?: unknown): string {
  if (t && typeof t === 'object' && typeof t.kind === 'string') {
    return encodeValue(t.kind, String(t.value ?? ''), t.quote === "'" ? "'" : '"');
  }
  return String(raw ?? '');
}

/**
 * Visual editor for an event's `Event(...)` definition(s): conditions, selectors,
 * options, patterns and keywords. Hosted inside the event preview; messages use the
 * `def:` prefix. Every change is planned and verified by eventDef.planDefOp and written
 * by applyVerifiedEdits — the editor never regenerates a definition, it only performs
 * surgical, checked edits.
 */
export class EventDefEditor {
  private labelName?: string;
  /** Called after a successful write so the host can refresh derived views. */
  onDidEdit?: () => void;

  constructor(private readonly index: WorkspaceIndex) {}

  setLabel(labelName: string | undefined): void {
    this.labelName = labelName;
  }

  private schemaOf = (name: string) => this.index.getSchema(name);

  private async collectDefs(): Promise<{ uri: vscode.Uri; text: string; doc: vscode.TextDocument; header: EventDefHeader }[]> {
    if (!this.labelName) {
      return [];
    }
    const uris = new Map<string, vscode.Uri>();
    for (const ev of this.index.getEventsForLabel(this.labelName)) {
      uris.set(ev.uri.toString(), ev.uri);
    }
    const out: { uri: vscode.Uri; text: string; doc: vscode.TextDocument; header: EventDefHeader }[] = [];
    for (const uri of uris.values()) {
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      for (const header of findEventDefs(text, this.labelName)) {
        out.push({ uri, text, doc, header });
      }
    }
    return out;
  }

  async publish(webview: vscode.Webview): Promise<void> {
    const defs = await this.collectDefs();
    const classes: Record<string, unknown[]> = {};
    for (const kind of ['condition', 'selector', 'option', 'pattern'] as const) {
      classes[kind] = this.index.getInsertableSchemas(kind).map((s) => ({
        name: s.name,
        signature: formatSignature(s),
        params: s.params,
        inferredKwargs: s.inferredKwargs,
      }));
    }
    await webview.postMessage({
      type: 'def:model',
      labelName: this.labelName ?? '',
      defs: defs.map((d) => {
        const model = buildEventDefModel(d.text, d.header, this.schemaOf);
        const { domains, selectorValues } = this.domainsFor(d.text, d.header, model, classes);
        return {
          uri: d.uri.toString(),
          file: vscode.workspace.asRelativePath(d.uri),
          line: d.doc.positionAt(d.header.call.start).line,
          start: d.header.call.start,
          model,
          domains,
          selectorValues,
        };
      }),
      classes,
    });
  }

  private domainsFor(
    text: string,
    header: EventDefHeader,
    model: EventDefModel,
    classes: Record<string, unknown[]>
  ): { domains: Record<string, ClassDomains>; selectorValues: Record<string, string[]> } {
    const names = Object.values(classes).flatMap((list) => (list as { name: string }[]).map((c) => c.name));
    return buildDefDomains(text, header, model, names, this.schemaOf, (c, p) => this.index.getParamUsage(c, p));
  }

  async handleMessage(webview: vscode.Webview, msg: Record<string, unknown>): Promise<boolean> {
    const type = String(msg.type ?? '');
    if (!type.startsWith('def:')) {
      return false;
    }
    if (type === 'def:refresh') {
      await this.publish(webview);
      return true;
    }
    if (type === 'def:reveal') {
      const uri = vscode.Uri.parse(String(msg.uri));
      const doc = await vscode.workspace.openTextDocument(uri);
      const pos = doc.positionAt(Number(msg.start ?? 0));
      const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true });
      ed.selection = new vscode.Selection(pos, pos);
      ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      return true;
    }
    if (type === 'def:op' || type === 'def:add') {
      const error = await this.runEdit(msg);
      if (error) {
        await webview.postMessage({ type: 'def:error', message: error });
      }
      await this.publish(webview);
      if (!error) {
        this.onDidEdit?.();
      }
      return true;
    }
    return true;
  }

  private async runEdit(msg: Record<string, unknown>): Promise<string | undefined> {
    const uri = vscode.Uri.parse(String(msg.uri));
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    const start = Number(msg.start ?? -1);
    const header = findEventDefs(text, this.labelName).find((h) => h.call.start === start);
    if (!header) {
      return 'The definition moved or changed since the editor loaded it. The view was refreshed — try again.';
    }
    let op: DefOp;
    let expect: string;
    let label: string;
    if (msg.type === 'def:add') {
      const kind = String(msg.kind) as ItemKind;
      const positionals = (Array.isArray(msg.positionals) ? msg.positionals : []).map((t) => codeOf(t as Typed));
      const keywords = (Array.isArray(msg.keywords) ? msg.keywords : []).map(
        (pair) => [String((pair as unknown[])[0]), codeOf((pair as unknown[])[1] as Typed)] as [string, string]
      );
      const code = buildCallCode(String(msg.className), positionals, keywords);
      if (typeof code !== 'string') {
        return code.error;
      }
      const model = buildEventDefModel(text, header, this.schemaOf);
      op = { op: 'insert', parent: [], code, afterIndex: insertSlotFor(model, kind) };
      expect = model.code;
      label = `Definition: add ${msg.className}`;
    } else {
      const raw = msg.op as DefOp;
      const typed = msg.typed as Typed | undefined;
      if (raw.op === 'setValue') {
        op = { op: 'setValue', path: raw.path, code: typed ? codeOf(typed) : String(raw.code ?? '') };
        label = 'Definition: edit value';
      } else if (raw.op === 'remove') {
        op = { op: 'remove', path: raw.path };
        label = 'Definition: remove argument';
      } else {
        op = {
          op: 'insert',
          parent: raw.parent,
          code: typed ? codeOf(typed) : String(raw.code ?? ''),
          keyword: raw.keyword,
          afterIndex: raw.afterIndex,
        };
        label = raw.keyword ? `Definition: add ${raw.keyword}` : 'Definition: add value';
      }
      expect = String(msg.expect ?? '');
    }
    const plan = planDefOp(text, header.call.start, op, expect, this.schemaOf);
    if ('error' in plan) {
      return plan.error;
    }
    const error = await applyVerifiedEdits(uri, text, plan.edits, label);
    if (!error) {
      // Semantic heads-up: did this edit leave a pattern placeholder without a selector?
      const before = new Set(placeholderHints(header.call));
      const after = parsePyCall(plan.newText, header.call.start);
      const fresh = after ? placeholderHints(after).filter((h) => !before.has(h)) : [];
      if (fresh.length) {
        void vscode.window.showWarningMessage(`Heads-up: ${fresh.join(' ')}`);
      }
    }
    return error;
  }

  static styles(): string {
    return DEF_STYLES;
  }

  static html(): string {
    return '<div class="def-root" id="defroot"></div>';
  }

}

/**
 * Value suggestions for every class the card UI can show: curated engine knowledge
 * (daytime codes, operators, number patterns…), values the workspace uses for the same
 * parameter, and this event's own selector keys / values.
 */
export function buildDefDomains(
  text: string,
  header: EventDefHeader,
  model: EventDefModel,
  classNames: string[],
  schemaOf: SchemaLookup,
  usage: DomainContext['usage']
): { domains: Record<string, ClassDomains>; selectorValues: Record<string, string[]> } {
  const outputs = eventSelectorOutputs(text, header.call);
  const selectorValues: Record<string, string[]> = {};
  for (const o of outputs) {
    selectorValues[o.key] = [...new Set([...(selectorValues[o.key] ?? []), ...o.values])];
  }
  const ctx: DomainContext = {
    selectorKeys: outputs.map((o) => ({
      value: o.key,
      label: o.className + (o.values.length ? ': ' + o.values.slice(0, 4).join(', ') + (o.values.length > 4 ? ' …' : '') : ''),
    })),
    usage,
  };
  const names = new Set<string>(classNames);
  const visit = (node?: CallModel) => {
    if (!node) {
      return;
    }
    names.add(node.name);
    node.fields.forEach((f) => visit(f.node));
  };
  model.items.forEach((i) => visit(i.node));
  const domains: Record<string, ClassDomains> = {};
  for (const name of names) {
    const s = schemaOf(name);
    const params = s ? [...s.params.map((p) => p.name), ...s.inferredKwargs] : [];
    const cd = classDomains(name, params, ctx);
    if (cd.doc || cd.keywords || Object.keys(cd.params).length) {
      domains[name] = cd;
    }
  }
  return { domains, selectorValues };
}

const DEF_STYLES = `
  .def-root { font-size: 12px; }
  .def-root .def-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 6px; }
  .def-root .def-loc { color: var(--vscode-descriptionForeground); }
  .def-root .def-row { display: flex; gap: 6px; align-items: center; margin: 3px 0; flex-wrap: wrap; }
  .def-root .def-row > .lbl { min-width: 88px; color: var(--vscode-descriptionForeground); }
  .def-root .def-sec { margin-top: 10px; }
  .def-root .def-sec-h { display: flex; align-items: center; gap: 6px; font-weight: 600; text-transform: uppercase; font-size: 10px; letter-spacing: .05em; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 2px; margin-bottom: 4px; }
  .def-root .def-sec-h .grow { flex: 1; }
  .def-root .card { border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 5px 7px; margin: 4px 0; background: var(--vscode-editorWidget-background); }
  .def-root .card .card-h { display: flex; gap: 6px; align-items: center; }
  .def-root .card .card-h .nm { font-weight: 600; font-family: var(--vscode-editor-font-family); }
  .def-root .card .card-h .grow { flex: 1; }
  .def-root .card .card { margin-left: 10px; }
  .def-root input, .def-root select, .def-root textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 2px 4px; border-radius: 3px; font-size: 11px; min-width: 0; }
  .def-root input.code, .def-root textarea.code { font-family: var(--vscode-editor-font-family); }
  .def-root input.val { flex: 1 1 140px; }
  .def-root button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; padding: 2px 7px; border-radius: 3px; cursor: pointer; font-size: 11px; }
  .def-root button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .def-root .warn { color: var(--vscode-editorWarning-foreground); }
  .def-root .err { color: var(--vscode-errorForeground); margin: 4px 0; }
  .def-root .muted { color: var(--vscode-descriptionForeground); }
  .def-root .t { font-size: 10px; color: var(--vscode-descriptionForeground); }
  .def-root .addform { border: 1px dashed var(--vscode-panel-border); border-radius: 5px; padding: 6px; margin: 4px 0; }
  .def-root .def-head .grow, .def-root .card-h .grow { flex: 1; }
  .def-root .secs { display: flex; flex-direction: column; gap: 2px; }
  .def-root .def-sec-h { cursor: pointer; user-select: none; }
  .def-root .def-sec-h .arrow { width: 10px; display: inline-block; }
  .def-root .cardgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 4px 8px; align-items: start; }
  .def-root .cardgrid > .card { margin: 0; min-width: 0; }
  .def-root .def-sec { margin-top: 8px; min-width: 0; }
  .def-root .card { padding: 3px 6px; margin: 3px 0; }
  .def-root .card-h { min-width: 0; }
  .def-root .card-h .sum { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .def-root .body { margin-top: 3px; }
  .def-root .fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 3px 8px; }
  .def-root .fcell { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .def-root .fcell.wide { grid-column: 1 / -1; }
  .def-root .ftop { display: flex; gap: 4px; align-items: center; min-width: 0; }
  .def-root .flbl { font-size: 10px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .def-root .ftop .x, .def-root .chip .x { padding: 0 4px; margin-left: auto; line-height: 14px; }
  .def-root .fcell input.val, .def-root .fcell select { width: 100%; box-sizing: border-box; }
  /* .fcell is a column: the row rule's flex-basis (140px) would become the input's height. */
  .def-root .fcell > input, .def-root .fcell > select { flex: 0 0 auto; height: auto; }
  .def-root datalist { display: none; }
  .def-root .combi { display: flex; flex-wrap: wrap; align-items: center; gap: 3px; }
  .def-root .combi > .card { flex: 1 1 100%; }
  .def-root .chip { display: inline-flex; gap: 5px; align-items: center; max-width: 100%; border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 1px 4px 1px 7px; cursor: pointer; background: var(--vscode-editor-background); }
  .def-root .chip:hover { border-color: var(--vscode-focusBorder); }
  .def-root .chip .sum { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .def-root .extras { display: flex; flex-wrap: wrap; gap: 0 12px; }
  .def-root .extras .def-row { margin: 2px 0; }
  .def-root .fhelp:empty { display: none; }
  .def-root .fhelp { font-size: 10px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .def-root .cdoc { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 1px 0 3px; }
`;

// Webview client. Plain ES5-ish JS inside a string: no backticks, no template ${}.
