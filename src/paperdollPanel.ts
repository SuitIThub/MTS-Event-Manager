import * as vscode from 'vscode';
import { WorkspaceIndex } from './indexer';
import { PersonIndexData } from './parsePersons';
import { labelAtLine } from './parseImageCalls';
import { getImageRoots, resolveImagesForCall } from './patternResolve';
import {
  applyMoves,
  BUILTIN_PRESETS,
  clearPaperdollCatalog,
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
  optimizePaperdollEvent,
  planCursorInsert,
  includeForCall,
  PaperdollAnalysis,
  PaperdollCallSite,
  renderCallText,
  renderRegisterText,
  SceneState,
} from './paperdollScript';
import { offsetToPosition } from './scan';

let panel: vscode.WebviewPanel | undefined;
let session: { uri: vscode.Uri; line: number; character: number } | undefined;
let cursor: { line: number; character: number } | undefined;
let cursorWatch: vscode.Disposable | undefined;
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
let latest: {
  analysis: PaperdollAnalysis;
  catalog: PaperdollCatalog;
  persons: PersonIndexData;
} | undefined;

export async function showPaperdollEditor(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  uri?: vscode.Uri,
  line?: number,
  character?: number
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const targetUri = uri ?? editor?.document.uri;
  if (!targetUri) {
    void vscode.window.showWarningMessage('Open an event script first.');
    return;
  }
  session = {
    uri: targetUri,
    line: line ?? editor?.selection.active.line ?? 0,
    character: character ?? editor?.selection.active.character ?? 0,
  };
  if (editor && editor.document.uri.toString() === targetUri.toString()) {
    cursor = { line: editor.selection.active.line, character: editor.selection.active.character };
  } else {
    cursor = { line: session.line, character: session.character };
  }
  ensureDiffProvider(context);
  if (!cursorWatch) {
    cursorWatch = vscode.window.onDidChangeTextEditorSelection((event) => {
      if (!session || event.textEditor.document.uri.toString() !== session.uri.toString()) {
        return;
      }
      const pos = event.selections[0]?.active;
      if (pos) {
        cursor = { line: pos.line, character: pos.character };
      }
    });
    context.subscriptions.push(cursorWatch);
  }

  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
    await publish(panel, index);
    return;
  }

  const roots = (await getImageRoots()).map((r) => vscode.Uri.file(r));
  panel = vscode.window.createWebviewPanel('mtsPaperdoll', 'MTS Paperdoll', vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: roots,
  });
  const created = panel;
  context.subscriptions.push(created);
  created.onDidDispose(() => {
    if (panel === created) {
      panel = undefined;
      latest = undefined;
    }
  });
  created.webview.onDidReceiveMessage((msg) => {
    void onMessage(created, index, msg);
  });
  created.webview.html = html(created.webview);
  await publish(created, index);
}

async function onMessage(
  target: vscode.WebviewPanel,
  index: WorkspaceIndex,
  msg: Record<string, unknown>
): Promise<void> {
  if (!session || !latest) {
    return;
  }
  if (msg.type === 'refreshAssets') {
    clearPaperdollCatalog();
    await publish(target, index);
    return;
  }
  if (msg.type === 'draft') {
    const draft = readDraft(msg);
    if (draft) {
      const snippet = snippetFor(draft);
      await target.webview.postMessage({ type: 'snippet', snippet: snippet.text, note: snippet.note });
    }
    return;
  }
  if (msg.type === 'change') {
    await replyDraft(target, msg);
    return;
  }
  if (msg.type === 'character') {
    await replyCharacter(target, String(msg.personKey ?? ''));
    return;
  }
  if (
    msg.type === 'apply' ||
    msg.type === 'insertDisplay' ||
    msg.type === 'insertRegister' ||
    msg.type === 'insertAtCursor' ||
    msg.type === 'optimize'
  ) {
    await writeDraft(index, msg);
    return;
  }
  if (msg.type === 'copy') {
    const text = String(msg.text ?? '');
    await vscode.env.clipboard.writeText(text.startsWith('$') ? text : `$ ${text}`);
  }
}

async function publish(target: vscode.WebviewPanel, index: WorkspaceIndex): Promise<void> {
  if (!session) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  const persons = index.getPersonIndex();
  const analysis = analyzePaperdoll(
    doc.getText(),
    index.getLabelsForUri(doc.uri),
    session.line,
    session.character,
    persons
  );
  const catalog = await loadPaperdollCatalog();
  latest = { analysis, catalog, persons };
  const call = analysis.call;
  const active =
    (call && analysis.scene.dolls.find((d) => d.variable === call.variable)) ||
    analysis.scene.dolls.find((d) => !d.hidden) ||
    analysis.scene.dolls[0];
  const personKey = active?.personKey ?? [...catalog.characters.keys()].sort()[0] ?? '';
  const values = { ...(active?.values ?? mergedValues(persons.byKey.get(personKey)?.paperdollDefaults, undefined)) };
  const options = cascade(catalog, personKey, values).options;
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
  const payload = await scenePayload(target, index, doc, analysis, catalog, {
    personKey,
    variable,
    values,
    include,
    config,
    duration: call ? durationOf(call.actions) : 0,
    before,
  });
  await target.webview.postMessage({ type: 'scene', ...payload });
}

async function replyDraft(target: vscode.WebviewPanel, msg: Record<string, unknown>): Promise<void> {
  if (!latest || !session) {
    return;
  }
  const draft = readDraft(msg);
  if (!draft) {
    return;
  }
  const field = typeof msg.field === 'string' ? (msg.field as ImageField) : undefined;
  const cascaded = cascade(latest.catalog, draft.personKey, draft.values, field);
  draft.values = cascaded.values;
  const layers = resolveLayers(
    latest.catalog,
    draft.personKey,
    draft.values,
    altFor(latest.analysis, draft.variable, draft.personKey)
  );
  const snippet = snippetFor(draft);
  await target.webview.postMessage({
    type: msg.type === 'draft' ? 'snippet' : 'patch',
    values: draft.values,
    options: cascaded.options,
    body: uriOf(target, layers.body),
    head: uriOf(target, layers.head),
    snippet: snippet.text,
    note: snippet.note,
    bodyName: layers.body ? fileName(layers.body) : '',
    headName: layers.head ? fileName(layers.head) : '',
  });
}

async function replyCharacter(target: vscode.WebviewPanel, personKey: string): Promise<void> {
  if (!latest || !session) {
    return;
  }
  const persons = latest.persons;
  const onStage = latest.analysis.scene.dolls.find((d) => d.personKey === personKey && !d.hidden);
  const defaults = mergedValues(persons.byKey.get(personKey)?.paperdollDefaults, undefined);
  const sourceValues = onStage ? { ...onStage.values } : defaults;
  const cascaded = cascade(latest.catalog, personKey, sourceValues);
  const variable = onStage?.variable ?? guessVariable(personKey, latest.analysis.bindings, persons);
  const bound = latest.analysis.call;
  const before =
    bound && onStage && onStage.variable === bound.variable
      ? latest.analysis.beforeDoll?.config ?? onStage.config
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
  const layers = resolveLayers(latest.catalog, personKey, draft.values, HOUSE_ALT_KEYS);
  const snippet = snippetFor(draft);
  await target.webview.postMessage({
    type: 'patch',
    values: draft.values,
    options: cascaded.options,
    include: draft.include,
    variable: draft.variable,
    config: draft.config,
    before: draft.before,
    duration: draft.duration,
    body: uriOf(target, layers.body),
    head: uriOf(target, layers.head),
    snippet: snippet.text,
    note: snippet.note,
    bodyName: layers.body ? fileName(layers.body) : '',
    headName: layers.head ? fileName(layers.head) : '',
    resetControls: true,
  });
}

async function writeDraft(index: WorkspaceIndex, msg: Record<string, unknown>): Promise<void> {
  if (!session || !latest) {
    return;
  }
  const draft = readDraft(msg);
  if (!draft) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  const text = doc.getText();
  const indent = latest.analysis.call?.indent || indentOf(text, session.line);
  const persons = index.getPersonIndex();
  const defaults = persons.byKey.get(draft.personKey)?.paperdollDefaults;
  const edit = new vscode.WorkspaceEdit();
  if (msg.type === 'apply' && latest.analysis.call) {
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
    const start = offsetToPosition(text, latest.analysis.call.start);
    const end = offsetToPosition(text, latest.analysis.call.end);
    edit.replace(doc.uri, new vscode.Range(start.line, start.character, end.line, end.character), rendered.text);
    const ok = await vscode.workspace.applyEdit(edit);
    if (ok && rendered.framingSkipped) {
      void vscode.window.showInformationMessage(
        'Updated the image. The existing timed moves were left in place.'
      );
    }
  } else if (msg.type === 'insertDisplay') {
    const rendered = renderCallText(
      displayShell(latest.analysis.call, draft.variable),
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
    const line = doc.lineAt(Math.min(session.line, doc.lineCount - 1));
    const pad = line.text.match(/^[ \t]*/)?.[0] ?? indent;
    const block = rendered.text
      .split('\n')
      .map((row, i) => (i === 0 ? `${pad}$ ${row}` : row))
      .join('\n');
    edit.insert(doc.uri, line.range.end, `\n${block}`);
    session = { ...session, line: session.line + 1, character: pad.length };
    await vscode.workspace.applyEdit(edit);
  } else if (msg.type === 'insertRegister') {
    const labels = index.getLabelsForUri(doc.uri);
    const plan = findRegisterInsert(text, labels, session.line, draft.variable);
    if (!plan) {
      void vscode.window.showWarningMessage('No begin_event in this event.');
      return;
    }
    if (plan.duplicate) {
      void vscode.window.showInformationMessage(`${draft.variable} is already registered in this event.`);
      return;
    }
    const pad = indentOf(text, plan.indentLine) || indent;
    const rendered = renderRegisterText(
      undefined,
      draft.variable,
      draft.include,
      draft.values,
      defaults,
      pad
    );
    const call = `${pad}$ ${rendered}`;
    if (plan.mode === 'after-line') {
      const line = doc.lineAt(Math.min(plan.line, doc.lineCount - 1));
      edit.insert(doc.uri, line.range.end, `\n${call}`);
    } else if (plan.line >= doc.lineCount) {
      const line = doc.lineAt(doc.lineCount - 1);
      edit.insert(doc.uri, line.range.end, plan.blankBefore ? `\n\n${call}` : `\n${call}`);
    } else {
      edit.insert(
        doc.uri,
        new vscode.Position(plan.line, 0),
        `${plan.blankBefore ? '\n' : ''}${call}\n`
      );
    }
    await vscode.workspace.applyEdit(edit);
  } else if (msg.type === 'insertAtCursor') {
    const at = cursor ?? { line: session.line, character: session.character };
    const built = buildDisplayArgs(
      [],
      draft.include,
      draft.values,
      draft.config,
      draft.duration,
      draft.before,
      latest.analysis.scene.presets
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
      latest.analysis.scene.presets,
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
      edit.replace(
        doc.uri,
        new vscode.Range(start.line, start.character, end.line, end.character),
        plan.insertion
      );
    }
    session = { ...session, line: plan.anchorLine, character: plan.anchorCharacter };
    cursor = { line: plan.anchorLine, character: plan.anchorCharacter };
    await vscode.workspace.applyEdit(edit);
  } else if (msg.type === 'optimize') {
    const labels = index.getLabelsForUri(doc.uri);
    const result = optimizePaperdollEvent(text, labels, session.line);
    if (result.fields === 0) {
      void vscode.window.showInformationMessage('No repeated display fields.');
      return;
    }
    let shift = 0;
    for (const change of result.edits) {
      const start = offsetToPosition(text, change.start);
      const end = offsetToPosition(text, change.end);
      edit.replace(doc.uri, new vscode.Range(start.line, start.character, end.line, end.character), change.text);
      if (start.line < session.line && end.line <= session.line) {
        const added = change.text.length === 0 ? 0 : change.text.split('\n').length - 1;
        shift += added - (end.line - start.line);
      }
    }
    session = { ...session, line: Math.max(0, session.line + shift) };
    const before = text;
    const ok = await vscode.workspace.applyEdit(edit);
    if (ok) {
      const fieldText = result.fields === 1 ? '1 repeated field' : `${result.fields} repeated fields`;
      const callText =
        result.calls === 0
          ? ''
          : result.calls === 1
            ? ' and 1 empty display'
            : ` and ${result.calls} empty displays`;
      diffSeq++;
      const name = doc.fileName.split(/[/\\]/).pop() || 'event.rpy';
      const beforeUri = storeDiff('before', name, before);
      const afterUri = storeDiff('after', name, doc.getText());
      void vscode.window.showInformationMessage(`Removed ${fieldText}${callText}.`, 'Show diff').then((choice) => {
        if (choice === 'Show diff') {
          void openOptimizeDiff(beforeUri, afterUri, name);
        }
      });
    }
  }
  if (panel) {
    await publish(panel, index);
  }
}

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

function snippetFor(draft: Draft): { text: string; note: string } {
  if (!latest) {
    return { text: '', note: '' };
  }
  const defaults = latest?.persons.byKey.get(draft.personKey)?.paperdollDefaults;
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
  target: vscode.WebviewPanel,
  index: WorkspaceIndex,
  doc: vscode.TextDocument,
  analysis: PaperdollAnalysis,
  catalog: PaperdollCatalog,
  draft: Draft
): Promise<Record<string, unknown>> {
  const persons = index.getPersonIndex();
  const characters = [...catalog.characters.keys()].sort().map((key) => ({
    key,
    label: labelFor(key, persons),
  }));
  const options = optionsFor(catalog, draft.personKey, draft.values);
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
      body: uriOf(target, layers.body),
      head: uriOf(target, layers.head),
    });
  }
  if (dolls.length === 0 && draft.personKey) {
    const layers = resolveLayers(catalog, draft.personKey, draft.values, HOUSE_ALT_KEYS);
    dolls.push({
      variable: draft.variable,
      personKey: draft.personKey,
      config: channels(draft.config),
      body: uriOf(target, layers.body),
      head: uriOf(target, layers.head),
    });
  }
  const anchorLine = analysis.call?.line ?? session?.line ?? 0;
  const eventLab = labelAtLine(index.getLabelsForUri(doc.uri), anchorLine);
  const eventLabel = eventLab ? (eventLab.isSub ? eventLab.name.split('.')[0] : eventLab.name) : '';
  const bg = await resolveBackground(target, index, doc, analysis.scene, anchorLine);
  const snippet = snippetFor(draft);
  const activeLayers = resolveLayers(
    catalog,
    draft.personKey,
    draft.values,
    altFor(analysis, draft.variable, draft.personKey)
  );
  return {
    characters,
    personKey: draft.personKey,
    variable: draft.variable,
    values: draft.values,
    include: draft.include,
    options,
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
  target: vscode.WebviewPanel,
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
    const left = bg.left ? await oneBackground(target, index, doc, bg.left, line) : undefined;
    const right = bg.right ? await oneBackground(target, index, doc, bg.right, line) : undefined;
    return { src: left, src2: right, blur: bg.blur, split: true };
  }
  return { src: await oneBackground(target, index, doc, bg, line), blur: bg.blur, split: false };
}

async function oneBackground(
  target: vscode.WebviewPanel,
  index: WorkspaceIndex,
  doc: vscode.TextDocument,
  bg: BackgroundRef,
  line: number
): Promise<string | undefined> {
  const labels = index.getLabelsForUri(doc.uri);
  const label = labelAtLine(labels, line);
  if (bg.kind === 'path' && bg.path) {
    const infos = await resolveImagesForCall(
      {
        kind: 'set_background_path',
        range: new vscode.Range(line, 0, line, 1),
        steps: [],
        literalPath: bg.path,
      },
      []
    );
    return infos[0] ? uriOf(target, infos[0].fsPath) : undefined;
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
    return infos[0] ? uriOf(target, infos[0].fsPath) : undefined;
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

function uriOf(target: vscode.WebviewPanel, fsPath: string | undefined): string {
  if (!fsPath) {
    return '';
  }
  return target.webview.asWebviewUri(vscode.Uri.file(fsPath)).toString();
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

interface Draft {
  personKey: string;
  variable: string;
  values: Record<string, string>;
  include: Record<string, boolean>;
  config: PdConfig;
  duration: number;
  before: PdConfig;
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
  return Math.abs(a.alignX - b.alignX) < 0.0005 && Math.abs(a.alignY - b.alignY) < 0.0005 && Math.abs(a.zoom - b.zoom) < 0.0005;
}

function html(webview: vscode.Webview): string {
  const fields = IMAGE_FIELDS.map((field) => {
    const group = field === 'mood' || field === 'mouth' || field === 'look' || field === 'extra2' ? 'head' : 'body';
    return { field, label: FIELD_LABELS[field], group };
  });
  const fieldJson = JSON.stringify(fields).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
  body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 12px; }
  .wrap { display: flex; flex-direction: column; height: 100vh; min-height: 0; }
  .stage-col { flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; flex-direction: column; padding: 8px 10px 0; gap: 4px; }
  .stage-frame { flex: 1 1 auto; min-height: 0; container-type: size; display: flex; align-items: center; justify-content: center; }
  .stage { position: relative; width: min(100%, calc(100cqh * 16 / 9)); aspect-ratio: 16/9; max-height: 100%; overflow: hidden; background: #161616;
    background-image: linear-gradient(45deg, #222 25%, transparent 25%), linear-gradient(-45deg, #222 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #222 75%), linear-gradient(-45deg, transparent 75%, #222 75%);
    background-size: 24px 24px; background-position: 0 0, 0 12px, 12px -12px, -12px 0; }
  .stage img.bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .doll { position: absolute; }
  .doll canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
  #files { flex: 0 0 1.4em; height: 1.4em; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .doll.active { outline: 1px solid var(--vscode-focusBorder); }
  .controls { container-type: inline-size; flex: 0 1 auto; max-height: 62%; min-height: 0; overflow: auto; border-top: 1px solid var(--vscode-panel-border); padding: 6px 10px 8px; box-sizing: border-box; }
  .sections { display: grid; grid-template-columns: 1fr; gap: 8px 14px; align-items: start; }
  h2 { font-size: 12px; margin: 0 0 4px; font-weight: 600; }
  label.row { display: flex; flex-direction: column; gap: 2px; margin: 0; min-width: 0; }
  .identity-fields { display: contents; }
  .grid, #body, #head { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 4px 8px; }
  .frame-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); gap: 4px 10px; }
  .block { min-width: 0; }
  .cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .cell .top { display: flex; align-items: center; gap: 4px; color: var(--vscode-descriptionForeground); }
  select, input[type="text"], input[type="number"] { width: 100%; min-width: 0; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 4px; }
  .slider { display: flex; gap: 6px; align-items: center; min-width: 0; }
  .slider input[type="range"] { flex: 1; min-width: 0; }
  .slider input[type="number"] { width: 58px; flex: 0 0 auto; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 5px 8px; cursor: pointer; }
  button.alt { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .buttons { display: flex; flex-wrap: wrap; gap: 6px; align-content: flex-start; }
  pre { max-height: 4.8em; overflow: auto; white-space: pre-wrap; word-break: break-word; background: var(--vscode-textCodeBlock-background); padding: 6px 8px; margin: 0; font-family: var(--vscode-editor-font-family); font-size: 11px; }
  .note { color: var(--vscode-descriptionForeground); }
  .note:empty { display: none; }
  #note { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .presets { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
  .presets button { font-size: 11px; padding: 3px 6px; }
  .warn { color: var(--vscode-editorWarning-foreground); }
  .zone-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; color: var(--vscode-descriptionForeground); margin: 0 0 4px; }
  .event-zone { border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 8px; padding-bottom: 6px; }
  .event-row { display: grid; grid-template-columns: minmax(140px, 220px) minmax(96px, 150px) auto; justify-content: start; align-items: end; gap: 6px 10px; }
  .event-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  #heading { margin-bottom: 4px; }
  @container (max-width: 560px) {
    .event-row { grid-template-columns: 1fr 1fr; }
    .event-actions { grid-column: 1 / -1; }
  }
  @container (min-width: 760px) {
    .sections { grid-template-columns: 1fr 1fr; }
    .block-body, .block-actions { grid-column: 1 / -1; }
    .block-actions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(160px, 240px); grid-template-areas: "snippet buttons" "note buttons"; gap: 4px 12px; align-items: start; }
    #snippet { grid-area: snippet; }
    #note { grid-area: note; }
    .block-actions .buttons { grid-area: buttons; }
  }
  @container (min-width: 1080px) {
    .sections { grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.25fr); }
    .block-head { grid-column: 1; }
    .block-frame { grid-column: 2; }
    .block-actions { grid-template-columns: minmax(0, 1fr) auto; }
    .block-actions .buttons { max-width: 340px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="stage-col">
    <div class="stage-frame"><div id="stage" class="stage"></div></div>
    <div class="note" id="files"></div>
  </div>
  <div class="controls">
    <section class="zone event-zone">
      <div class="zone-title" id="eventTitle">Event</div>
      <div class="event-row">
        <div class="identity-fields">
          <label class="row">Character<select id="character"></select></label>
          <label class="row">Variable<input id="variable" type="text" spellcheck="false" /></label>
        </div>
        <div class="event-actions">
          <button id="insertRegister" type="button">Insert register</button>
          <button id="optimize" class="alt" type="button" title="Remove image fields repeated by the next display of the same doll">Optimize</button>
          <button id="reload" class="alt" type="button">Rescan assets</button>
        </div>
      </div>
      <p class="note" id="missing"></p>
    </section>
    <section class="zone call-zone">
      <div class="zone-title">Call</div>
      <div class="sections">
        <div class="block block-body">
          <div id="heading"></div>
          <h2>Body</h2>
          <div class="grid" id="body"></div>
        </div>
        <div class="block block-head">
          <h2>Head</h2>
          <div class="grid" id="head"></div>
        </div>
        <div class="block block-frame">
          <h2>Framing</h2>
          <div class="presets" id="presets"></div>
          <div class="frame-fields">
            <label class="row">alignX<span class="slider"><input id="alignX" type="range" min="-1.5" max="2.5" step="0.01" /><input id="alignXn" type="number" step="0.01" /></span></label>
            <label class="row">alignY<span class="slider"><input id="alignY" type="range" min="-0.6" max="0.6" step="0.01" /><input id="alignYn" type="number" step="0.01" /></span></label>
            <label class="row">zoom<span class="slider"><input id="zoom" type="range" min="0.4" max="4" step="0.01" /><input id="zoomn" type="number" step="0.01" /></span></label>
            <label class="row">duration<span class="slider"><input id="duration" type="range" min="0" max="2" step="0.1" /><input id="durationn" type="number" step="0.1" /></span></label>
          </div>
          <label class="row"><span><input id="flip" type="checkbox" /> Flip horizontally</span></label>
        </div>
        <div class="block block-actions">
          <pre id="snippet"></pre>
          <div class="note" id="note"></div>
          <div class="buttons">
            <button id="apply" type="button">Update call</button>
            <button id="insertDisplay" class="alt" type="button">Insert display</button>
            <button id="insertAtCursor" class="alt" type="button">Insert at cursor</button>
            <button id="copy" class="alt" type="button">Copy</button>
          </div>
        </div>
      </div>
    </section>
  </div>
</div>
<script>
const vscode = acquireVsCodeApi();
const FIELDS = ${fieldJson};
const images = new Map();
let state = null;
let presets = [];

let resizeRedraw;
window.addEventListener('resize', () => {
  clearTimeout(resizeRedraw);
  resizeRedraw = setTimeout(() => { if (state) void renderStage(); }, 80);
});

function img(url) {
  if (!url) return Promise.resolve(null);
  const hit = images.get(url);
  if (hit) return hit;
  const pending = new Promise((resolve) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => resolve(null);
    el.src = url;
  });
  images.set(url, pending);
  return pending;
}

function draft() {
  const values = {};
  const include = {};
  for (const field of FIELDS) {
    values[field.field] = document.getElementById('v-' + field.field).value;
    include[field.field] = document.getElementById('c-' + field.field).checked;
  }
  return {
    personKey: document.getElementById('character').value,
    variable: document.getElementById('variable').value.trim(),
    values, include,
    config: {
      alignX: Number(document.getElementById('alignX').value),
      alignY: Number(document.getElementById('alignY').value),
      zoom: Number(document.getElementById('zoom').value),
      flip: document.getElementById('flip').checked ? -1 : 1,
      blur: state?.config?.blur || 0,
      bw: !!state?.config?.bw,
      color: state?.config?.color || '#00000000',
    },
    duration: Number(document.getElementById('duration').value) || 0,
    before: state?.before || { alignX: -0.5, alignY: 0, zoom: 1, flip: 1, blur: 0, bw: false, color: '#00000000' },
  };
}

function buildFields() {
  for (const field of FIELDS) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.innerHTML = '<label class="top"><input type="checkbox" id="c-' + field.field + '" />' + field.label + '</label><select id="v-' + field.field + '"></select>';
    document.getElementById(field.group).appendChild(cell);
    document.getElementById('v-' + field.field).addEventListener('change', () => {
      vscode.postMessage({ type: 'change', field: field.field, ...draft() });
    });
  }
}

function fillSelect(id, options, value) {
  const el = document.getElementById(id);
  const opts = options && options.length ? options : (value ? [value] : []);
  el.innerHTML = '';
  for (const opt of opts) {
    const node = document.createElement('option');
    node.value = opt;
    node.textContent = opt === '$' ? '$' : opt;
    el.appendChild(node);
  }
  if (value && [...el.options].some((o) => o.value === value)) el.value = value;
}

function setSliders(config, duration) {
  bindNum('alignX', config.alignX);
  bindNum('alignY', config.alignY);
  bindNum('zoom', config.zoom);
  bindNum('duration', duration || 0);
  document.getElementById('flip').checked = config.flip < 0;
}

function bindNum(id, value) {
  document.getElementById(id).value = String(value);
  document.getElementById(id + 'n').value = String(Math.round(value * 1000) / 1000);
}

function place(config) {
  const w = 600 * config.zoom;
  const h = 1080 * config.zoom;
  const anchor = Math.min(1, Math.max(0, config.alignX));
  const left = config.alignX * 1920 - anchor * w;
  return { left: (left / 1920) * 100, top: config.alignY * 100, width: (w / 1920) * 100, height: (h / 1080) * 100 };
}

async function drawDoll(canvas, doll) {
  const body = await img(doll.body);
  const head = await img(doll.head);
  const srcW = Math.max(body ? body.naturalWidth : 0, head ? head.naturalWidth : 0) || 1200;
  const srcH = Math.max(body ? body.naturalHeight : 0, head ? head.naturalHeight : 0) || 2160;
  const box = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  let scale = 1;
  if (box.width > 2 && box.height > 2) {
    scale = Math.min(1, (box.width * dpr) / srcW, (box.height * dpr) / srcH);
  }
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  if (doll.config.flip < 0) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  if (doll.config.bw) ctx.filter = 'grayscale(1)';
  if (body) ctx.drawImage(body, 0, 0, w, h);
  if (head) ctx.drawImage(head, 0, 0, w, h);
  ctx.filter = 'none';
  const tint = doll.config.tint;
  if (tint && tint.a > 0.004) {
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = 'rgba(' + tint.r + ',' + tint.g + ',' + tint.b + ',' + tint.a + ')';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();
}

async function renderStage() {
  const stage = document.getElementById('stage');
  stage.innerHTML = '';
  const bg = state.background || {};
  if (bg.split) {
    if (bg.src) addBg(stage, bg.src, '0', '50%', bg.blur);
    if (bg.src2) addBg(stage, bg.src2, '50%', '50%', bg.blur);
  } else if (bg.src) {
    addBg(stage, bg.src, '0', '100%', bg.blur);
  }
  const d = draft();
  const dolls = (state.dolls || []).map((doll) => {
    if (doll.variable === d.variable) {
      return { ...doll, body: state.activeBody ?? doll.body, head: state.activeHead ?? doll.head, config: { ...doll.config, ...d.config, tint: doll.config.tint } };
    }
    return doll;
  });
  for (const doll of dolls) {
    const box = place(doll.variable === d.variable ? d.config : doll.config);
    const el = document.createElement('div');
    el.className = 'doll' + (doll.variable === d.variable ? ' active' : '');
    el.style.left = box.left + '%';
    el.style.top = box.top + '%';
    el.style.width = box.width + '%';
    el.style.height = box.height + '%';
    const canvas = document.createElement('canvas');
    el.appendChild(canvas);
    el.addEventListener('click', () => {
      document.getElementById('character').value = doll.personKey;
      vscode.postMessage({ type: 'character', personKey: doll.personKey });
    });
    stage.appendChild(el);
    void drawDoll(canvas, doll.variable === d.variable ? { ...doll, config: { ...doll.config, ...d.config, tint: doll.config.tint } } : doll);
  }
}

function addBg(stage, src, left, width, blur) {
  const imgEl = document.createElement('img');
  imgEl.className = 'bg';
  imgEl.src = src;
  imgEl.style.left = left;
  imgEl.style.width = width;
  imgEl.style.objectFit = 'cover';
  if (blur) imgEl.style.filter = 'blur(8px)';
  stage.appendChild(imgEl);
}

function applyScene(msg) {
  state = msg;
  presets = msg.presets || [];
  const character = document.getElementById('character');
  character.innerHTML = '';
  const onStage = new Set((msg.dolls || []).map((d) => d.personKey));
  const groups = [
    ['On stage', (msg.characters || []).filter((c) => onStage.has(c.key))],
    ['All', (msg.characters || []).filter((c) => !onStage.has(c.key))],
  ];
  for (const [label, list] of groups) {
    if (!list.length) continue;
    const group = document.createElement('optgroup');
    group.label = label;
    for (const item of list) {
      const opt = document.createElement('option');
      opt.value = item.key;
      opt.textContent = item.label;
      group.appendChild(opt);
    }
    character.appendChild(group);
  }
  character.value = msg.personKey;
  document.getElementById('variable').value = msg.variable;
  for (const field of FIELDS) {
    fillSelect('v-' + field.field, (msg.options || {})[field.field], (msg.values || {})[field.field]);
    document.getElementById('c-' + field.field).checked = !!(msg.include || {})[field.field];
  }
  setSliders(msg.config, msg.duration);
  document.getElementById('snippet').textContent = msg.snippet || '';
  document.getElementById('note').textContent = msg.note || '';
  document.getElementById('files').textContent = [msg.bodyName, msg.headName].filter(Boolean).join('  ·  ');
  document.getElementById('eventTitle').textContent = msg.eventLabel ? 'Event · ' + msg.eventLabel : 'Event';
  document.getElementById('heading').textContent = msg.bound === 'insert'
    ? 'Insert at line ' + (msg.line + 1)
    : (msg.bound === 'register' ? 'Register' : 'Display') + ' · line ' + (msg.line + 1);
  document.getElementById('apply').style.display = msg.bound === 'insert' ? 'none' : '';
  document.getElementById('missing').textContent = msg.missingCatalog
    ? 'No paperdoll folder found. Open the game workspace or set mtsEventManager.imageRoots.'
    : '';
  const presetBox = document.getElementById('presets');
  presetBox.innerHTML = '';
  for (const preset of presets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'alt';
    btn.textContent = preset.name;
    btn.addEventListener('click', () => {
      const before = state.before || draft().before;
      const next = { ...before };
      for (const move of preset.moves) {
        if (move.alignX !== undefined) next.alignX = move.alignX;
        if (move.alignY !== undefined) next.alignY = move.alignY;
        if (move.zoom !== undefined) next.zoom = move.zoom;
      }
      setSliders(next, Number(document.getElementById('duration').value) || 0);
      state.config = { ...state.config, ...next };
      void renderStage();
      vscode.postMessage({ type: 'draft', ...draft() });
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
    state.config = msg.config;
    state.before = msg.before || state.before;
    setSliders(msg.config, msg.duration || 0);
    if (msg.variable) document.getElementById('variable').value = msg.variable;
    if (msg.include) {
      for (const field of FIELDS) document.getElementById('c-' + field.field).checked = !!msg.include[field.field];
    }
  }
  for (const field of FIELDS) {
    if (msg.options) fillSelect('v-' + field.field, msg.options[field.field], (msg.values || {})[field.field]);
  }
  const variable = document.getElementById('variable').value.trim();
  let active = (state.dolls || []).find((d) => d.variable === variable);
  if (!active && msg.resetControls) {
    active = { variable, personKey: document.getElementById('character').value, config: Object.assign({ tint: { r: 0, g: 0, b: 0, a: 0 } }, msg.config || {}), body: '', head: '' };
    state.dolls = (state.dolls || []).concat([active]);
  }
  if (active) {
    active.body = msg.body || '';
    active.head = msg.head || '';
    if (msg.config) active.config = Object.assign({}, active.config, msg.config);
  }
  state.activeBody = msg.body || '';
  state.activeHead = msg.head || '';
  if (msg.snippet !== undefined) document.getElementById('snippet').textContent = msg.snippet;
  if (msg.note !== undefined) document.getElementById('note').textContent = msg.note;
  document.getElementById('files').textContent = [msg.bodyName, msg.headName].filter(Boolean).join('  ·  ');
  void renderStage();
}

for (const id of ['alignX', 'alignY', 'zoom', 'duration']) {
  document.getElementById(id).addEventListener('input', () => {
    document.getElementById(id + 'n').value = document.getElementById(id).value;
    if (state) state.config = { ...state.config, ...draft().config };
    void renderStage();
    vscode.postMessage({ type: 'draft', ...draft() });
  });
  document.getElementById(id + 'n').addEventListener('change', () => {
    document.getElementById(id).value = document.getElementById(id + 'n').value;
    if (state) state.config = { ...state.config, ...draft().config };
    void renderStage();
    vscode.postMessage({ type: 'draft', ...draft() });
  });
}
document.getElementById('flip').addEventListener('change', () => {
  if (state) state.config = { ...state.config, ...draft().config };
  void renderStage();
  vscode.postMessage({ type: 'draft', ...draft() });
});
document.getElementById('character').addEventListener('change', () => {
  vscode.postMessage({ type: 'character', personKey: document.getElementById('character').value });
});
document.getElementById('variable').addEventListener('change', () => vscode.postMessage({ type: 'draft', ...draft() }));
document.getElementById('apply').addEventListener('click', () => vscode.postMessage({ type: 'apply', ...draft() }));
document.getElementById('insertDisplay').addEventListener('click', () => vscode.postMessage({ type: 'insertDisplay', ...draft() }));
document.getElementById('insertRegister').addEventListener('click', () => vscode.postMessage({ type: 'insertRegister', ...draft() }));
document.getElementById('optimize').addEventListener('click', () => vscode.postMessage({ type: 'optimize', ...draft() }));
document.getElementById('insertAtCursor').addEventListener('click', () => vscode.postMessage({ type: 'insertAtCursor', ...draft() }));
document.getElementById('copy').addEventListener('click', () => vscode.postMessage({ type: 'copy', text: document.getElementById('snippet').textContent }));
document.getElementById('reload').addEventListener('click', () => vscode.postMessage({ type: 'refreshAssets' }));

buildFields();
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'scene') applyScene(msg);
  if (msg.type === 'patch') applyPatch(msg);
  if (msg.type === 'snippet') {
    document.getElementById('snippet').textContent = msg.snippet || '';
    document.getElementById('note').textContent = msg.note || '';
  }
});
</script>
</body>
</html>`;
}

