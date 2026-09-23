import * as vscode from 'vscode';
import { applyReversibleEdit } from './editHistory';
import { WorkspaceIndex } from './indexer';
import { labelAtLine } from './parseImageCalls';
import { PersonIndexData } from './parsePersons';
import { resolveImagesForCall } from './patternResolve';
import {
  applyMoves,
  BUILTIN_PRESETS,
  clampValues,
  colorChannels,
  DEFAULT_CONFIG,
  DEFAULT_INCLUDE,
  expandPresetMoves,
  FIELD_LABELS,
  HOUSE_ALT_KEYS,
  IMAGE_FIELDS,
  ImageField,
  loadPaperdollCatalog,
  clearPaperdollCatalog,
  mergedValues,
  optionsFor,
  PaperdollCatalog,
  PdConfig,
  resolveLayers,
} from './paperdollResolve';
import {
  analyzePaperdoll,
  BackgroundRef,
  buildDisplayArgs,
  durationOf,
  findRegisterInsert,
  guessVariable,
  includeForCall,
  optimizePaperdollEvent,
  PaperdollAnalysis,
  PaperdollCallSite,
  planCursorInsert,
  renderCallText,
  renderRegisterText,
  SceneState,
} from './paperdollScript';
import { offsetToPosition } from './scan';

// ── Shared optimize-diff provider (used by both host panels) ───────────────
const DIFF_SCHEME = 'mts-paperdoll-diff';
const diffBodies = new Map<string, string>();
const diffOrder: string[] = [];
let diffSeq = 0;
let diffProvider: vscode.Disposable | undefined;

function ensureDiffProvider(context: vscode.ExtensionContext): void {
  if (diffProvider) {
    return;
  }
  diffProvider = vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
    provideTextDocumentContent(uri) {
      return diffBodies.get(uri.toString()) ?? '';
    },
  });
  context.subscriptions.push(diffProvider);
}

function storeDiff(kind: 'before' | 'after', name: string, body: string): vscode.Uri {
  const uri = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${diffSeq}/${kind}/${name}` });
  const key = uri.toString();
  diffBodies.set(key, body);
  diffOrder.push(key);
  while (diffOrder.length > 16) {
    const oldest = diffOrder.shift();
    if (oldest) {
      diffBodies.delete(oldest);
    }
  }
  return uri;
}

async function openOptimizeDiff(before: vscode.Uri, after: vscode.Uri, name: string): Promise<void> {
  await vscode.commands.executeCommand('vscode.diff', before, after, `Paperdoll optimize · ${name}`, {
    preview: true,
  });
}

interface Draft {
  personKey: string;
  variable: string;
  values: Record<string, string>;
  include: Record<string, boolean>;
  config: PdConfig;
  duration: number;
  before: PdConfig;
}

/**
 * The paperdoll call editor, decoupled from any single webview panel. A host embeds
 * `controlsHtml()` / `styles()` / `clientScript()` into its page and forwards `pd:`
 * messages to `handleMessage`; the editor posts `pd:scene` / `pd:patch` / `pd:snippet`
 * back. Anchored at a document position via `setAnchor`. All document writes flow
 * through the shared reversible edit history.
 */
export class PaperdollEditor {
  private session?: { uri: vscode.Uri; line: number; character: number };
  private cursor?: { line: number; character: number };
  private latest?: { analysis: PaperdollAnalysis; catalog: PaperdollCatalog; persons: PersonIndexData };

  constructor(private readonly context: vscode.ExtensionContext) {
    ensureDiffProvider(context);
  }

  hasSession(): boolean {
    return !!this.session;
  }

  setAnchor(uri: vscode.Uri, line: number, character: number): void {
    this.session = { uri, line, character };
    this.cursor = { line, character };
  }

  setCursor(uri: vscode.Uri, line: number, character: number): void {
    if (this.session && this.session.uri.toString() === uri.toString()) {
      this.cursor = { line, character };
    }
  }

  /** Handle a `pd:` message. Returns true if it was a paperdoll-editor message. */
  async handleMessage(
    webview: vscode.Webview,
    index: WorkspaceIndex,
    msg: Record<string, unknown>
  ): Promise<boolean> {
    const type = String(msg.type ?? '');
    if (!type.startsWith('pd:')) {
      return false;
    }
    if (!this.session) {
      return true;
    }
    if (type === 'pd:refreshAssets') {
      clearPaperdollCatalog();
      await this.publish(webview, index);
      return true;
    }
    if (type === 'pd:draft') {
      const draft = readDraft(msg);
      if (draft && this.latest) {
        const snippet = snippetFor(this.latest, draft);
        await webview.postMessage({ type: 'pd:snippet', snippet: snippet.text, note: snippet.note });
      }
      return true;
    }
    if (type === 'pd:change') {
      await this.replyDraft(webview, msg);
      return true;
    }
    if (type === 'pd:character') {
      await this.replyCharacter(webview, String(msg.personKey ?? ''));
      return true;
    }
    if (
      type === 'pd:apply' ||
      type === 'pd:insertDisplay' ||
      type === 'pd:insertRegister' ||
      type === 'pd:insertAtCursor' ||
      type === 'pd:optimize'
    ) {
      await this.writeDraft(webview, index, type, msg);
      return true;
    }
    if (type === 'pd:copy') {
      const text = String(msg.text ?? '');
      await vscode.env.clipboard.writeText(text.startsWith('$') ? text : `$ ${text}`);
      return true;
    }
    return true;
  }

  async publish(webview: vscode.Webview, index: WorkspaceIndex): Promise<void> {
    if (!this.session) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(this.session.uri);
    const persons = index.getPersonIndex();
    const analysis = analyzePaperdoll(
      doc.getText(),
      index.getLabelsForUri(doc.uri),
      this.session.line,
      this.session.character,
      persons
    );
    const catalog = await loadPaperdollCatalog();
    this.latest = { analysis, catalog, persons };
    const call = analysis.call;
    const active =
      (call && analysis.scene.dolls.find((d) => d.variable === call.variable)) ||
      analysis.scene.dolls.find((d) => !d.hidden) ||
      analysis.scene.dolls[0];
    const personKey = active?.personKey ?? [...catalog.characters.keys()].sort()[0] ?? '';
    const values = { ...(active?.values ?? mergedValues(persons.byKey.get(personKey)?.paperdollDefaults, undefined)) };
    const include = call ? includeForCall(call) : { ...DEFAULT_INCLUDE };
    const before = analysis.beforeDoll?.config ?? active?.config ?? { ...DEFAULT_CONFIG };
    let config = active?.config ?? { ...DEFAULT_CONFIG };
    if (!call || call.kind === 'register') {
      const placed = applyMoves(before, expandPresetMoves('close_body_center') ?? []);
      if (samePlace(config, DEFAULT_CONFIG)) {
        config = placed;
      }
    }
    const variable = call?.variable || guessVariable(personKey, analysis.bindings, persons);
    const payload = await scenePayload(webview, index, doc, analysis, catalog, this.session, {
      personKey,
      variable,
      values,
      include,
      config,
      duration: call ? durationOf(call.actions) : 0,
      before,
    });
    await webview.postMessage({ type: 'pd:scene', ...payload });
  }

  private async replyDraft(webview: vscode.Webview, msg: Record<string, unknown>): Promise<void> {
    if (!this.latest || !this.session) {
      return;
    }
    const draft = readDraft(msg);
    if (!draft) {
      return;
    }
    const field = typeof msg.field === 'string' ? (msg.field as ImageField) : undefined;
    const cascaded = cascade(this.latest.catalog, draft.personKey, draft.values, field);
    draft.values = cascaded.values;
    const layers = resolveLayers(
      this.latest.catalog,
      draft.personKey,
      draft.values,
      altFor(this.latest.analysis, draft.variable, draft.personKey)
    );
    const snippet = snippetFor(this.latest, draft);
    await webview.postMessage({
      type: 'pd:patch',
      values: draft.values,
      options: cascaded.options,
      body: uriOf(webview, layers.body),
      head: uriOf(webview, layers.head),
      snippet: snippet.text,
      note: snippet.note,
      bodyName: layers.body ? fileName(layers.body) : '',
      headName: layers.head ? fileName(layers.head) : '',
    });
  }

  private async replyCharacter(webview: vscode.Webview, personKey: string): Promise<void> {
    if (!this.latest || !this.session) {
      return;
    }
    const persons = this.latest.persons;
    const onStage = this.latest.analysis.scene.dolls.find((d) => d.personKey === personKey && !d.hidden);
    const defaults = mergedValues(persons.byKey.get(personKey)?.paperdollDefaults, undefined);
    const sourceValues = onStage ? { ...onStage.values } : defaults;
    const cascaded = cascade(this.latest.catalog, personKey, sourceValues);
    const variable = onStage?.variable ?? guessVariable(personKey, this.latest.analysis.bindings, persons);
    const bound = this.latest.analysis.call;
    const before =
      bound && onStage && onStage.variable === bound.variable
        ? this.latest.analysis.beforeDoll?.config ?? onStage.config
        : onStage?.config ?? { ...DEFAULT_CONFIG };
    const draft = {
      personKey,
      variable,
      values: cascaded.values,
      include: bound && variable === bound.variable ? includeForCall(bound) : { ...DEFAULT_INCLUDE },
      config: onStage ? { ...onStage.config } : applyMoves(before, expandPresetMoves('close_body_center') ?? []),
      duration: bound && variable === bound.variable ? durationOf(bound.actions) : 0,
      before,
    };
    const layers = resolveLayers(this.latest.catalog, personKey, draft.values, HOUSE_ALT_KEYS);
    const snippet = snippetFor(this.latest, draft);
    await webview.postMessage({
      type: 'pd:patch',
      values: draft.values,
      options: cascaded.options,
      include: draft.include,
      variable: draft.variable,
      config: draft.config,
      before: draft.before,
      duration: draft.duration,
      body: uriOf(webview, layers.body),
      head: uriOf(webview, layers.head),
      snippet: snippet.text,
      note: snippet.note,
      bodyName: layers.body ? fileName(layers.body) : '',
      headName: layers.head ? fileName(layers.head) : '',
      resetControls: true,
    });
  }

  private async writeDraft(
    webview: vscode.Webview,
    index: WorkspaceIndex,
    type: string,
    msg: Record<string, unknown>
  ): Promise<void> {
    if (!this.session || !this.latest) {
      return;
    }
    const draft = readDraft(msg);
    if (!draft) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(this.session.uri);
    const text = doc.getText();
    const indent = this.latest.analysis.call?.indent || indentOf(text, this.session.line);
    const persons = index.getPersonIndex();
    const defaults = persons.byKey.get(draft.personKey)?.paperdollDefaults;
    const edit = new vscode.WorkspaceEdit();
    if (type === 'pd:apply' && this.latest.analysis.call) {
      const rendered = renderCallText(
        this.latest.analysis.call,
        draft.variable,
        draft.include,
        draft.values,
        draft.config,
        draft.duration,
        draft.before,
        this.latest.analysis.scene.presets,
        indent,
        defaults
      );
      const start = offsetToPosition(text, this.latest.analysis.call.start);
      const end = offsetToPosition(text, this.latest.analysis.call.end);
      edit.replace(doc.uri, new vscode.Range(start.line, start.character, end.line, end.character), rendered.text);
      const ok = await applyReversibleEdit(doc.uri, edit, 'Paperdoll: update call');
      if (ok && rendered.framingSkipped) {
        void vscode.window.showInformationMessage('Updated the image. The existing timed moves were left in place.');
      }
    } else if (type === 'pd:insertDisplay') {
      const rendered = renderCallText(
        displayShell(this.latest.analysis.call, draft.variable),
        draft.variable,
        draft.include,
        draft.values,
        draft.config,
        draft.duration,
        draft.before,
        this.latest.analysis.scene.presets,
        indent,
        defaults
      );
      const line = doc.lineAt(Math.min(this.session.line, doc.lineCount - 1));
      const pad = line.text.match(/^[ \t]*/)?.[0] ?? indent;
      const block = rendered.text
        .split('\n')
        .map((row, i) => (i === 0 ? `${pad}$ ${row}` : row))
        .join('\n');
      edit.insert(doc.uri, line.range.end, `\n${block}`);
      this.session = { ...this.session, line: this.session.line + 1, character: pad.length };
      await applyReversibleEdit(doc.uri, edit, 'Paperdoll: insert display');
    } else if (type === 'pd:insertRegister') {
      const labels = index.getLabelsForUri(doc.uri);
      const plan = findRegisterInsert(text, labels, this.session.line, draft.variable);
      if (!plan) {
        void vscode.window.showWarningMessage('No begin_event in this event.');
        return;
      }
      if (plan.duplicate) {
        void vscode.window.showInformationMessage(`${draft.variable} is already registered in this event.`);
        return;
      }
      const pad = indentOf(text, plan.indentLine) || indent;
      const rendered = renderRegisterText(undefined, draft.variable, draft.include, draft.values, defaults, pad);
      const call = `${pad}$ ${rendered}`;
      if (plan.mode === 'after-line') {
        const line = doc.lineAt(Math.min(plan.line, doc.lineCount - 1));
        edit.insert(doc.uri, line.range.end, `\n${call}`);
      } else if (plan.line >= doc.lineCount) {
        const line = doc.lineAt(doc.lineCount - 1);
        edit.insert(doc.uri, line.range.end, plan.blankBefore ? `\n\n${call}` : `\n${call}`);
      } else {
        edit.insert(doc.uri, new vscode.Position(plan.line, 0), `${plan.blankBefore ? '\n' : ''}${call}\n`);
      }
      await applyReversibleEdit(doc.uri, edit, 'Paperdoll: insert register');
    } else if (type === 'pd:insertAtCursor') {
      const at = this.cursor ?? { line: this.session.line, character: this.session.character };
      const built = buildDisplayArgs(
        [],
        draft.include,
        draft.values,
        draft.config,
        draft.duration,
        draft.before,
        this.latest.analysis.scene.presets
      );
      const pad = indentOf(text, at.line) || indent;
      const rendered = renderCallText(
        displayShell(undefined, draft.variable),
        draft.variable,
        draft.include,
        draft.values,
        draft.config,
        draft.duration,
        draft.before,
        this.latest.analysis.scene.presets,
        pad,
        defaults
      );
      const plan = planCursorInsert(text, at.line, at.character, built.args, rendered.text);
      if (!plan) {
        void vscode.window.showInformationMessage('Nothing to insert. Choose an image field or change the framing.');
        return;
      }
      const start = offsetToPosition(text, plan.start);
      const end = offsetToPosition(text, plan.end);
      if (plan.start === plan.end) {
        edit.insert(doc.uri, new vscode.Position(start.line, start.character), plan.insertion);
      } else {
        edit.replace(doc.uri, new vscode.Range(start.line, start.character, end.line, end.character), plan.insertion);
      }
      this.session = { ...this.session, line: plan.anchorLine, character: plan.anchorCharacter };
      this.cursor = { line: plan.anchorLine, character: plan.anchorCharacter };
      await applyReversibleEdit(doc.uri, edit, 'Paperdoll: insert at cursor');
    } else if (type === 'pd:optimize') {
      const labels = index.getLabelsForUri(doc.uri);
      const result = optimizePaperdollEvent(text, labels, this.session.line);
      if (result.fields === 0) {
        void vscode.window.showInformationMessage('No repeated display fields.');
        return;
      }
      let shift = 0;
      for (const change of result.edits) {
        const start = offsetToPosition(text, change.start);
        const end = offsetToPosition(text, change.end);
        edit.replace(doc.uri, new vscode.Range(start.line, start.character, end.line, end.character), change.text);
        if (start.line < this.session.line && end.line <= this.session.line) {
          const added = change.text.length === 0 ? 0 : change.text.split('\n').length - 1;
          shift += added - (end.line - start.line);
        }
      }
      this.session = { ...this.session, line: Math.max(0, this.session.line + shift) };
      const beforeText = text;
      const ok = await applyReversibleEdit(doc.uri, edit, 'Paperdoll: optimize');
      if (ok) {
        const fieldText = result.fields === 1 ? '1 repeated field' : `${result.fields} repeated fields`;
        const callText =
          result.calls === 0 ? '' : result.calls === 1 ? ' and 1 empty display' : ` and ${result.calls} empty displays`;
        diffSeq++;
        const name = doc.fileName.split(/[/\\]/).pop() || 'event.rpy';
        const beforeUri = storeDiff('before', name, beforeText);
        const afterUri = storeDiff('after', name, doc.getText());
        void vscode.window.showInformationMessage(`Removed ${fieldText}${callText}.`, 'Show diff').then((choice) => {
          if (choice === 'Show diff') {
            void openOptimizeDiff(beforeUri, afterUri, name);
          }
        });
      }
    }
    await this.publish(webview, index);
  }

  // ── Static markup: hosts embed these into their page ────────────────────

  static styles(): string {
    return PD_STYLES;
  }

  static controlsHtml(): string {
    return PD_CONTROLS_HTML;
  }

  static clientScript(): string {
    const fields = IMAGE_FIELDS.map((field) => {
      const group = field === 'mood' || field === 'mouth' || field === 'look' || field === 'extra2' ? 'head' : 'body';
      return { field, label: FIELD_LABELS[field], group };
    });
    const fieldJson = JSON.stringify(fields).replace(/</g, '\\u003c');
    return `const PD_FIELDS = ${fieldJson};\n${PD_CLIENT_SCRIPT}`;
  }
}

// ── Pure helpers (ported from the original panel) ──────────────────────────

function displayShell(call: PaperdollCallSite | undefined, variable: string): PaperdollCallSite {
  if (call?.kind === 'display') {
    return { ...call, variable, form: 'method', actions: [] };
  }
  return {
    kind: 'display',
    start: 0,
    end: 0,
    line: 0,
    indent: '',
    form: 'method',
    variable,
    actions: [],
    preserved: [],
  };
}

function snippetFor(
  latest: { analysis: PaperdollAnalysis; persons: PersonIndexData },
  draft: Draft
): { text: string; note: string } {
  const defaults = latest.persons.byKey.get(draft.personKey)?.paperdollDefaults;
  const indent = latest.analysis.call?.indent ?? '    ';
  const display = renderCallText(
    displayShell(undefined, draft.variable),
    draft.variable,
    draft.include,
    draft.values,
    draft.config,
    draft.duration,
    draft.before,
    latest.analysis.scene.presets,
    indent,
    defaults
  );
  if (latest.analysis.call?.kind === 'register') {
    const register = renderRegisterText(
      latest.analysis.call,
      draft.variable,
      draft.include,
      draft.values,
      defaults,
      indent
    );
    return { text: `$ ${register}`, note: `Insert display writes: $ ${display.text}` };
  }
  if (!latest.analysis.call) {
    return { text: `$ ${display.text}`, note: 'Insert writes this display line.' };
  }
  const rendered = renderCallText(
    latest.analysis.call,
    draft.variable,
    draft.include,
    draft.values,
    draft.config,
    draft.duration,
    draft.before,
    latest.analysis.scene.presets,
    indent,
    defaults
  );
  return {
    text: `$ ${rendered.text}`,
    note: rendered.framingSkipped ? 'Timed moves stay; Update changes the image only.' : '',
  };
}

async function scenePayload(
  webview: vscode.Webview,
  index: WorkspaceIndex,
  doc: vscode.TextDocument,
  analysis: PaperdollAnalysis,
  catalog: PaperdollCatalog,
  session: { line: number; character: number },
  draft: Draft
): Promise<Record<string, unknown>> {
  const persons = index.getPersonIndex();
  const characters = [...catalog.characters.keys()].sort().map((key) => ({ key, label: labelFor(key, persons) }));
  const dolls = [];
  for (const doll of analysis.scene.dolls) {
    if (doll.hidden && doll.variable !== draft.variable) {
      continue;
    }
    const values = doll.variable === draft.variable ? draft.values : doll.values;
    const config = doll.variable === draft.variable ? draft.config : doll.config;
    const layers = resolveLayers(catalog, doll.personKey, values, doll.altKeys);
    dolls.push({
      variable: doll.variable,
      personKey: doll.personKey,
      config: channels(config),
      body: uriOf(webview, layers.body),
      head: uriOf(webview, layers.head),
    });
  }
  if (dolls.length === 0 && draft.personKey) {
    const layers = resolveLayers(catalog, draft.personKey, draft.values, HOUSE_ALT_KEYS);
    dolls.push({
      variable: draft.variable,
      personKey: draft.personKey,
      config: channels(draft.config),
      body: uriOf(webview, layers.body),
      head: uriOf(webview, layers.head),
    });
  }
  const anchorLine = analysis.call?.line ?? session.line ?? 0;
  const eventLab = labelAtLine(index.getLabelsForUri(doc.uri), anchorLine);
  const eventLabel = eventLab ? (eventLab.isSub ? eventLab.name.split('.')[0] : eventLab.name) : '';
  const bg = await resolveBackground(webview, index, doc, analysis.scene, anchorLine);
  const snippet = snippetFor({ analysis, persons }, draft);
  const activeLayers = resolveLayers(catalog, draft.personKey, draft.values, altFor(analysis, draft.variable, draft.personKey));
  return {
    characters,
    personKey: draft.personKey,
    variable: draft.variable,
    values: draft.values,
    include: draft.include,
    options: optionsFor(catalog, draft.personKey, draft.values),
    config: draft.config,
    before: draft.before,
    duration: draft.duration,
    presets: presetPayload(analysis.scene),
    dolls,
    background: bg,
    bound: analysis.call?.kind ?? 'insert',
    line: anchorLine,
    eventLabel,
    snippet: snippet.text,
    note: snippet.note,
    bodyName: activeLayers.body ? fileName(activeLayers.body) : '',
    headName: activeLayers.head ? fileName(activeLayers.head) : '',
    missingCatalog: catalog.characters.size === 0,
  };
}

function presetPayload(scene: SceneState): { name: string; moves: { alignX?: number; alignY?: number; zoom?: number }[] }[] {
  const defs = [...BUILTIN_PRESETS, ...scene.presets.values()];
  const out = [];
  for (const def of defs) {
    const moves = expandPresetMoves(def.name, scene.presets);
    if (moves) {
      out.push({ name: def.name, moves });
    }
  }
  return out;
}

function channels(config: PdConfig): PdConfig & { tint: { r: number; g: number; b: number; a: number } } {
  return { ...config, tint: colorChannels(config.color) };
}

async function resolveBackground(
  webview: vscode.Webview,
  index: WorkspaceIndex,
  doc: vscode.TextDocument,
  scene: SceneState,
  line: number
): Promise<{ src?: string; src2?: string; blur: boolean; split: boolean }> {
  const bg = scene.background;
  if (bg.kind === 'none') {
    return { blur: false, split: false };
  }
  if (bg.kind === 'split') {
    const left = bg.left ? await oneBackground(webview, index, doc, bg.left, line) : undefined;
    const right = bg.right ? await oneBackground(webview, index, doc, bg.right, line) : undefined;
    return { src: left, src2: right, blur: bg.blur, split: true };
  }
  return { src: await oneBackground(webview, index, doc, bg, line), blur: bg.blur, split: false };
}

async function oneBackground(
  webview: vscode.Webview,
  index: WorkspaceIndex,
  doc: vscode.TextDocument,
  bg: BackgroundRef,
  line: number
): Promise<string | undefined> {
  const labels = index.getLabelsForUri(doc.uri);
  const label = labelAtLine(labels, line);
  if (bg.kind === 'path' && bg.path) {
    const infos = await resolveImagesForCall(
      { kind: 'set_background_path', range: new vscode.Range(line, 0, line, 1), steps: [], literalPath: bg.path },
      []
    );
    return infos[0] ? uriOf(webview, infos[0].fsPath) : undefined;
  }
  if (bg.kind === 'series' && label && bg.patternKey) {
    const patterns = index.getPatternsForLabel(label.name, bg.patternKey);
    const infos = await resolveImagesForCall(
      {
        kind: 'set_background',
        range: new vscode.Range(line, 0, line, 1),
        steps: [bg.step ?? 0],
        patternKey: bg.patternKey,
        variableName: bg.variable,
      },
      patterns
    );
    return infos[0] ? uriOf(webview, infos[0].fsPath) : undefined;
  }
  return undefined;
}

function cascade(
  catalog: PaperdollCatalog,
  personKey: string,
  values: Record<string, string>,
  field?: ImageField
): { values: Record<string, string>; options: Record<ImageField, string[]> } {
  let current = { ...values };
  let options = optionsFor(catalog, personKey, current);
  current = clampValues(options, current, field);
  options = optionsFor(catalog, personKey, current);
  current = clampValues(options, current, field);
  options = optionsFor(catalog, personKey, current);
  return { values: current, options };
}

function altFor(analysis: PaperdollAnalysis, variable: string, personKey: string): string[] {
  const doll = analysis.scene.dolls.find((d) => d.variable === variable || d.personKey === personKey);
  return doll?.altKeys ?? HOUSE_ALT_KEYS;
}

function uriOf(webview: vscode.Webview, fsPath: string | undefined): string {
  if (!fsPath) {
    return '';
  }
  return webview.asWebviewUri(vscode.Uri.file(fsPath)).toString();
}

function fileName(fsPath: string): string {
  return fsPath.split(/[/\\]/).pop() ?? fsPath;
}

function indentOf(text: string, line: number): string {
  const row = text.split('\n')[line] ?? '';
  return /^[ \t]*/.exec(row)?.[0] ?? '';
}

function labelFor(key: string, persons: PersonIndexData): string {
  const person = persons.byKey.get(key);
  if (!person || person.firstName.includes('[')) {
    return key;
  }
  const name = `${person.firstName} ${person.lastName}`.trim();
  return name && name !== key ? `${name}` : key;
}

function readDraft(msg: Record<string, unknown>): Draft | undefined {
  const personKey = String(msg.personKey ?? '');
  const variable = String(msg.variable ?? '').trim();
  if (!personKey || !variable || !msg.values || !msg.config) {
    return undefined;
  }
  const values = msg.values as Record<string, string>;
  const includeIn = (msg.include ?? {}) as Record<string, boolean>;
  const include = { ...DEFAULT_INCLUDE };
  for (const field of IMAGE_FIELDS) {
    if (typeof includeIn[field] === 'boolean') {
      include[field] = includeIn[field];
    }
  }
  const raw = msg.config as Partial<PdConfig>;
  const beforeRaw = (msg.before ?? raw) as Partial<PdConfig>;
  return {
    personKey,
    variable,
    values: Object.fromEntries(IMAGE_FIELDS.map((f) => [f, String(values[f] ?? '')])),
    include,
    config: configFrom(raw),
    duration: Number(msg.duration ?? 0) || 0,
    before: configFrom(beforeRaw),
  };
}

function configFrom(raw: Partial<PdConfig>): PdConfig {
  return {
    alignX: num(raw.alignX, DEFAULT_CONFIG.alignX),
    alignY: num(raw.alignY, DEFAULT_CONFIG.alignY),
    zoom: num(raw.zoom, DEFAULT_CONFIG.zoom),
    flip: num(raw.flip, 1) < 0 ? -1 : 1,
    blur: num(raw.blur, 0),
    bw: !!raw.bw,
    color: typeof raw.color === 'string' ? raw.color : DEFAULT_CONFIG.color,
  };
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function samePlace(a: PdConfig, b: PdConfig): boolean {
  return (
    Math.abs(a.alignX - b.alignX) < 0.0005 &&
    Math.abs(a.alignY - b.alignY) < 0.0005 &&
    Math.abs(a.zoom - b.zoom) < 0.0005
  );
}

// ── Webview markup (scoped under .pd-root; stage id is `pdstage`) ───────────

const PD_STYLES = `
  .pd-root { container-type: inline-size; color: var(--vscode-foreground); font-size: 12px; }
  .pd-root .pd-stage-col { display: flex; flex-direction: column; gap: 4px; }
  .pd-root .pd-stage-frame { height: 32vh; min-height: 140px; container-type: size; display: flex; align-items: center; justify-content: center; }
  .pd-root #pdstage { position: relative; width: min(100%, calc(100cqh * 16 / 9)); aspect-ratio: 16/9; max-height: 100%; overflow: hidden; background: #161616;
    background-image: linear-gradient(45deg,#222 25%,transparent 25%),linear-gradient(-45deg,#222 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#222 75%),linear-gradient(-45deg,transparent 75%,#222 75%);
    background-size: 24px 24px; background-position: 0 0,0 12px,12px -12px,-12px 0; }
  .pd-root #pdstage img.bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .pd-root .pd-doll { position: absolute; }
  .pd-root .pd-doll canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
  .pd-root .pd-doll.active { outline: 1px solid var(--vscode-focusBorder); }
  .pd-root #pdfiles { height: 1.4em; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--vscode-descriptionForeground); }
  .pd-root .pd-sections { display: grid; grid-template-columns: 1fr; gap: 8px 14px; align-items: start; margin-top: 6px; }
  .pd-root h2 { font-size: 12px; margin: 0 0 4px; font-weight: 600; }
  .pd-root label.row { display: flex; flex-direction: column; gap: 2px; margin: 0; min-width: 0; }
  .pd-root .identity-fields { display: contents; }
  .pd-root .grid, .pd-root #pdbody, .pd-root #pdhead { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 4px 8px; }
  .pd-root .frame-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); gap: 4px 10px; }
  .pd-root .block { min-width: 0; }
  .pd-root .cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .pd-root .cell .top { display: flex; align-items: center; gap: 4px; color: var(--vscode-descriptionForeground); }
  .pd-root select, .pd-root input[type="text"], .pd-root input[type="number"] { width: 100%; min-width: 0; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 4px; }
  .pd-root .slider { display: flex; gap: 6px; align-items: center; min-width: 0; }
  .pd-root .slider input[type="range"] { flex: 1; min-width: 0; }
  .pd-root .slider input[type="number"] { width: 58px; flex: 0 0 auto; }
  .pd-root button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 5px 8px; cursor: pointer; border-radius: 3px; }
  .pd-root button.alt { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .pd-root .buttons { display: flex; flex-wrap: wrap; gap: 6px; align-content: flex-start; }
  .pd-root pre { max-height: 4.8em; overflow: auto; white-space: pre-wrap; word-break: break-word; background: var(--vscode-textCodeBlock-background); padding: 6px 8px; margin: 0; font-family: var(--vscode-editor-font-family); font-size: 11px; }
  .pd-root .note { color: var(--vscode-descriptionForeground); }
  .pd-root .note:empty { display: none; }
  .pd-root #pdnote { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pd-root .presets { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
  .pd-root .presets button { font-size: 11px; padding: 3px 6px; }
  .pd-root .zone-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; color: var(--vscode-descriptionForeground); margin: 0 0 4px; }
  .pd-root .event-zone { border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 8px; padding-bottom: 6px; }
  .pd-root .event-row { display: grid; grid-template-columns: minmax(140px, 220px) minmax(96px, 150px) auto; justify-content: start; align-items: end; gap: 6px 10px; }
  .pd-root .event-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .pd-root #pdheading { margin-bottom: 4px; }
  @container (max-width: 560px) { .pd-root .event-row { grid-template-columns: 1fr 1fr; } .pd-root .event-actions { grid-column: 1 / -1; } }
  @container (min-width: 760px) { .pd-root .pd-sections { grid-template-columns: 1fr 1fr; } .pd-root .block-body, .pd-root .block-actions { grid-column: 1 / -1; } }
`;

const PD_CONTROLS_HTML = `
<div class="pd-root">
  <div class="pd-stage-col">
    <div class="pd-stage-frame"><div id="pdstage"></div></div>
    <div class="note" id="pdfiles"></div>
  </div>
  <section class="zone event-zone">
    <div class="zone-title" id="pdeventTitle">Event</div>
    <div class="event-row">
      <div class="identity-fields">
        <label class="row">Character<select id="pdcharacter"></select></label>
        <label class="row">Variable<input id="pdvariable" type="text" spellcheck="false" /></label>
      </div>
      <div class="event-actions">
        <button id="pdinsertRegister" type="button">Insert register</button>
        <button id="pdoptimize" class="alt" type="button" title="Remove image fields repeated by the next display of the same doll">Optimize</button>
        <button id="pdreload" class="alt" type="button">Rescan assets</button>
      </div>
    </div>
    <p class="note" id="pdmissing"></p>
  </section>
  <section class="zone call-zone">
    <div class="zone-title">Call</div>
    <div class="pd-sections">
      <div class="block block-body">
        <div id="pdheading"></div>
        <h2>Body</h2>
        <div class="grid" id="pdbody"></div>
      </div>
      <div class="block block-head">
        <h2>Head</h2>
        <div class="grid" id="pdhead"></div>
      </div>
      <div class="block block-frame">
        <h2>Framing</h2>
        <div class="presets" id="pdpresets"></div>
        <div class="frame-fields">
          <label class="row">alignX<span class="slider"><input id="pdalignX" type="range" min="-1.5" max="2.5" step="0.01" /><input id="pdalignXn" type="number" step="0.01" /></span></label>
          <label class="row">alignY<span class="slider"><input id="pdalignY" type="range" min="-0.6" max="0.6" step="0.01" /><input id="pdalignYn" type="number" step="0.01" /></span></label>
          <label class="row">zoom<span class="slider"><input id="pdzoom" type="range" min="0.4" max="4" step="0.01" /><input id="pdzoomn" type="number" step="0.01" /></span></label>
          <label class="row">duration<span class="slider"><input id="pdduration" type="range" min="0" max="2" step="0.1" /><input id="pddurationn" type="number" step="0.1" /></span></label>
        </div>
        <label class="row"><span><input id="pdflip" type="checkbox" /> Flip horizontally</span></label>
      </div>
      <div class="block block-actions">
        <pre id="pdsnippet"></pre>
        <div class="note" id="pdnote"></div>
        <div class="buttons">
          <button id="pdapply" type="button">Update call</button>
          <button id="pdinsertDisplay" class="alt" type="button">Insert display</button>
          <button id="pdinsertAtCursor" class="alt" type="button">Insert at cursor</button>
          <button id="pdcopy" class="alt" type="button">Copy</button>
        </div>
      </div>
    </div>
  </section>
</div>
`;

const PD_CLIENT_SCRIPT = `
function mountPaperdollEditor(vscode) {
  const FIELDS = PD_FIELDS;
  const $ = (id) => document.getElementById('pd' + id);
  const images = new Map();
  let state = null;
  let presets = [];
  let resizeRedraw;
  window.addEventListener('resize', () => { clearTimeout(resizeRedraw); resizeRedraw = setTimeout(() => { if (state) void renderStage(); }, 80); });

  function img(url) {
    if (!url) return Promise.resolve(null);
    const hit = images.get(url); if (hit) return hit;
    const pending = new Promise((resolve) => { const el = new Image(); el.onload = () => resolve(el); el.onerror = () => resolve(null); el.src = url; });
    images.set(url, pending); return pending;
  }
  function draft() {
    const values = {}, include = {};
    for (const f of FIELDS) { values[f.field] = $('v-' + f.field).value; include[f.field] = $('c-' + f.field).checked; }
    return { personKey: $('character').value, variable: $('variable').value.trim(), values, include,
      config: { alignX: Number($('alignX').value), alignY: Number($('alignY').value), zoom: Number($('zoom').value),
        flip: $('flip').checked ? -1 : 1, blur: state?.config?.blur || 0, bw: !!state?.config?.bw, color: state?.config?.color || '#00000000' },
      duration: Number($('duration').value) || 0,
      before: state?.before || { alignX: -0.5, alignY: 0, zoom: 1, flip: 1, blur: 0, bw: false, color: '#00000000' } };
  }
  function buildFields() {
    for (const f of FIELDS) {
      const cell = document.createElement('div'); cell.className = 'cell';
      cell.innerHTML = '<label class="top"><input type="checkbox" id="pdc-' + f.field + '" />' + f.label + '</label><select id="pdv-' + f.field + '"></select>';
      $(f.group).appendChild(cell);
      $('v-' + f.field).addEventListener('change', () => vscode.postMessage({ type: 'pd:change', field: f.field, ...draft() }));
    }
  }
  function fillSelect(id, options, value) {
    const el = $(id); const opts = options && options.length ? options : (value ? [value] : []); el.innerHTML = '';
    for (const opt of opts) { const n = document.createElement('option'); n.value = opt; n.textContent = opt; el.appendChild(n); }
    if (value && [...el.options].some((o) => o.value === value)) el.value = value;
  }
  function setSliders(config, duration) { bindNum('alignX', config.alignX); bindNum('alignY', config.alignY); bindNum('zoom', config.zoom); bindNum('duration', duration || 0); $('flip').checked = config.flip < 0; }
  function bindNum(id, value) { $(id).value = String(value); $(id + 'n').value = String(Math.round(value * 1000) / 1000); }
  function place(config) { const w = 600 * config.zoom, h = 1080 * config.zoom; const anchor = Math.min(1, Math.max(0, config.alignX)); const left = config.alignX * 1920 - anchor * w; return { left: (left / 1920) * 100, top: config.alignY * 100, width: (w / 1920) * 100, height: (h / 1080) * 100 }; }
  async function drawDoll(canvas, doll) {
    const body = await img(doll.body), head = await img(doll.head);
    const srcW = Math.max(body ? body.naturalWidth : 0, head ? head.naturalWidth : 0) || 1200;
    const srcH = Math.max(body ? body.naturalHeight : 0, head ? head.naturalHeight : 0) || 2160;
    const box = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1; let scale = 1;
    if (box.width > 2 && box.height > 2) scale = Math.min(1, (box.width * dpr) / srcW, (box.height * dpr) / srcH);
    const w = Math.max(1, Math.round(srcW * scale)), h = Math.max(1, Math.round(srcH * scale));
    canvas.width = w; canvas.height = h; const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.clearRect(0, 0, w, h); ctx.save();
    if (doll.config.flip < 0) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    if (doll.config.bw) ctx.filter = 'grayscale(1)';
    if (body) ctx.drawImage(body, 0, 0, w, h); if (head) ctx.drawImage(head, 0, 0, w, h); ctx.filter = 'none';
    const tint = doll.config.tint;
    if (tint && tint.a > 0.004) { ctx.globalCompositeOperation = 'source-atop'; ctx.fillStyle = 'rgba(' + tint.r + ',' + tint.g + ',' + tint.b + ',' + tint.a + ')'; ctx.fillRect(0, 0, w, h); }
    ctx.restore();
  }
  async function renderStage() {
    const stage = $('stage'); stage.innerHTML = ''; const bg = state.background || {};
    if (bg.split) { if (bg.src) addBg(stage, bg.src, '0', '50%', bg.blur); if (bg.src2) addBg(stage, bg.src2, '50%', '50%', bg.blur); }
    else if (bg.src) addBg(stage, bg.src, '0', '100%', bg.blur);
    const d = draft();
    const dolls = (state.dolls || []).map((doll) => doll.variable === d.variable
      ? { ...doll, body: state.activeBody ?? doll.body, head: state.activeHead ?? doll.head, config: { ...doll.config, ...d.config, tint: doll.config.tint } } : doll);
    for (const doll of dolls) {
      const box = place(doll.variable === d.variable ? d.config : doll.config);
      const el = document.createElement('div'); el.className = 'pd-doll' + (doll.variable === d.variable ? ' active' : '');
      el.style.left = box.left + '%'; el.style.top = box.top + '%'; el.style.width = box.width + '%'; el.style.height = box.height + '%';
      const canvas = document.createElement('canvas'); el.appendChild(canvas);
      el.addEventListener('click', () => { $('character').value = doll.personKey; vscode.postMessage({ type: 'pd:character', personKey: doll.personKey }); });
      stage.appendChild(el);
      void drawDoll(canvas, doll.variable === d.variable ? { ...doll, config: { ...doll.config, ...d.config, tint: doll.config.tint } } : doll);
    }
  }
  function addBg(stage, src, left, width, blur) { const el = document.createElement('img'); el.className = 'bg'; el.src = src; el.style.left = left; el.style.width = width; el.style.objectFit = 'cover'; if (blur) el.style.filter = 'blur(8px)'; stage.appendChild(el); }
  function applyScene(msg) {
    state = msg; presets = msg.presets || [];
    const character = $('character'); character.innerHTML = '';
    const onStage = new Set((msg.dolls || []).map((d) => d.personKey));
    const groups = [['On stage', (msg.characters || []).filter((c) => onStage.has(c.key))], ['All', (msg.characters || []).filter((c) => !onStage.has(c.key))]];
    for (const [label, list] of groups) { if (!list.length) continue; const g = document.createElement('optgroup'); g.label = label; for (const item of list) { const o = document.createElement('option'); o.value = item.key; o.textContent = item.label; g.appendChild(o); } character.appendChild(g); }
    character.value = msg.personKey; $('variable').value = msg.variable;
    for (const f of FIELDS) { fillSelect('v-' + f.field, (msg.options || {})[f.field], (msg.values || {})[f.field]); $('c-' + f.field).checked = !!(msg.include || {})[f.field]; }
    setSliders(msg.config, msg.duration);
    $('snippet').textContent = msg.snippet || ''; $('note').textContent = msg.note || '';
    $('files').textContent = [msg.bodyName, msg.headName].filter(Boolean).join('  ·  ');
    $('eventTitle').textContent = msg.eventLabel ? 'Event · ' + msg.eventLabel : 'Event';
    $('heading').textContent = msg.bound === 'insert' ? 'Insert at line ' + (msg.line + 1) : (msg.bound === 'register' ? 'Register' : 'Display') + ' · line ' + (msg.line + 1);
    $('apply').style.display = msg.bound === 'insert' ? 'none' : '';
    $('missing').textContent = msg.missingCatalog ? 'No paperdoll folder found. Open the game workspace or set mtsEventManager.imageRoots.' : '';
    const presetBox = $('presets'); presetBox.innerHTML = '';
    for (const preset of presets) {
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'alt'; btn.textContent = preset.name;
      btn.addEventListener('click', () => {
        const before = state.before || draft().before; const next = { ...before };
        for (const move of preset.moves) { if (move.alignX !== undefined) next.alignX = move.alignX; if (move.alignY !== undefined) next.alignY = move.alignY; if (move.zoom !== undefined) next.zoom = move.zoom; }
        setSliders(next, Number($('duration').value) || 0); state.config = { ...state.config, ...next }; void renderStage(); vscode.postMessage({ type: 'pd:draft', ...draft() });
      });
      presetBox.appendChild(btn);
    }
    state.activeBody = (msg.dolls || []).find((d) => d.variable === msg.variable)?.body || '';
    state.activeHead = (msg.dolls || []).find((d) => d.variable === msg.variable)?.head || '';
    void renderStage();
  }
  function applyPatch(msg) {
    if (!state) return;
    if (msg.resetControls && msg.config) {
      state.config = msg.config; state.before = msg.before || state.before; setSliders(msg.config, msg.duration || 0);
      if (msg.variable) $('variable').value = msg.variable;
      if (msg.include) for (const f of FIELDS) $('c-' + f.field).checked = !!msg.include[f.field];
    }
    for (const f of FIELDS) if (msg.options) fillSelect('v-' + f.field, msg.options[f.field], (msg.values || {})[f.field]);
    const variable = $('variable').value.trim();
    let active = (state.dolls || []).find((d) => d.variable === variable);
    if (!active && msg.resetControls) { active = { variable, personKey: $('character').value, config: Object.assign({ tint: { r: 0, g: 0, b: 0, a: 0 } }, msg.config || {}), body: '', head: '' }; state.dolls = (state.dolls || []).concat([active]); }
    if (active) { active.body = msg.body || ''; active.head = msg.head || ''; if (msg.config) active.config = Object.assign({}, active.config, msg.config); }
    state.activeBody = msg.body || ''; state.activeHead = msg.head || '';
    if (msg.snippet !== undefined) $('snippet').textContent = msg.snippet;
    if (msg.note !== undefined) $('note').textContent = msg.note;
    $('files').textContent = [msg.bodyName, msg.headName].filter(Boolean).join('  ·  ');
    void renderStage();
  }
  for (const id of ['alignX', 'alignY', 'zoom', 'duration']) {
    $(id).addEventListener('input', () => { $(id + 'n').value = $(id).value; if (state) state.config = { ...state.config, ...draft().config }; void renderStage(); vscode.postMessage({ type: 'pd:draft', ...draft() }); });
    $(id + 'n').addEventListener('change', () => { $(id).value = $(id + 'n').value; if (state) state.config = { ...state.config, ...draft().config }; void renderStage(); vscode.postMessage({ type: 'pd:draft', ...draft() }); });
  }
  $('flip').addEventListener('change', () => { if (state) state.config = { ...state.config, ...draft().config }; void renderStage(); vscode.postMessage({ type: 'pd:draft', ...draft() }); });
  $('character').addEventListener('change', () => vscode.postMessage({ type: 'pd:character', personKey: $('character').value }));
  $('variable').addEventListener('change', () => vscode.postMessage({ type: 'pd:draft', ...draft() }));
  $('apply').addEventListener('click', () => vscode.postMessage({ type: 'pd:apply', ...draft() }));
  $('insertDisplay').addEventListener('click', () => vscode.postMessage({ type: 'pd:insertDisplay', ...draft() }));
  $('insertRegister').addEventListener('click', () => vscode.postMessage({ type: 'pd:insertRegister', ...draft() }));
  $('optimize').addEventListener('click', () => vscode.postMessage({ type: 'pd:optimize', ...draft() }));
  $('insertAtCursor').addEventListener('click', () => vscode.postMessage({ type: 'pd:insertAtCursor', ...draft() }));
  $('copy').addEventListener('click', () => vscode.postMessage({ type: 'pd:copy', text: $('snippet').textContent }));
  $('reload').addEventListener('click', () => vscode.postMessage({ type: 'pd:refreshAssets' }));
  buildFields();
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'pd:scene') applyScene(msg);
    else if (msg.type === 'pd:patch') applyPatch(msg);
    else if (msg.type === 'pd:snippet') { $('snippet').textContent = msg.snippet || ''; $('note').textContent = msg.note || ''; }
  });
}
`;
