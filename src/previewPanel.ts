import { lastColumn, trackColumn } from './panelPlacement';
import * as vscode from 'vscode';
import { resolveSiteImages } from './codeLens';
import { BranchPoint, buildEventTimeline, ImageRef, stopIndexForLine, TimelineMarker, videoPauseFlag } from './eventTimeline';
import { isLevelKey, paramConstraintsForLine } from './paramConstraints';
import { WorkspaceIndex } from './indexer';
import { labelAtLine, resolvePatternKeyForVariable, topLevelLabelSpan } from './parseImageCalls';
import { colorChannels, PdConfig, resolveLayers, loadPaperdollCatalog } from './paperdollResolve';
import { BackgroundRef, createPaperdollTracer, DollRuntime, PaperdollAnalysis, PdTrace } from './paperdollScript';
import { getImageRoots, resolveImagesForCall } from './patternResolve';
import {
  buildSpeakerChain,
  eventCharacterBindings,
  findCharacterLoadInsert,
  normalizeSpeakerToken,
  parseSpeakerChain,
  personDisplayName,
  SpeechType,
  withExtraPersonKeys,
} from './parsePersons';
import { guessVariable, optimizePaperdollEvent } from './paperdollScript';
import { optimizeImageShows } from './imageOptimize';
import { parseCallAt, walkCalls } from './callParser';
import { collectPortraitFiles, portraitRoots } from './portraitResolve';
import { PortraitStore } from './portraitStore';
import { PaperdollEditor } from './paperdollEditor';
import { EventDefEditor } from './eventDefEditor';
import { applyReversibleEdit, undoLast } from './editHistory';
import { offsetToPosition, readStringLiteral } from './scan';
import { chainBounds, isSayLine, locateLineIn, PAUSE_LINE_RE } from './lineTools';
import { ImageCallSite, LabelDefinition } from './types';
import { parseLabelsInDocument } from './parseLabels';
import { planAddMenuChoice, planMoveStatement, planRemoveMenuChoice } from './sceneOps';
import { TextEdit } from './pyCall';
import { applyVerifiedEdits } from './safeEdit';
import {
  findUnderRoots,
  MovieDef,
  movieNameFor,
  NewMovie,
  planAddMovieDefs,
  planSetMovieLoop,
  scanMovieDefs,
  siblingVideoPath,
  videoPrefixFor,
} from './videoResolve';
import { ResolvedImageInfo } from './types';
import { parseSeriesLine, planSeriesStepEdit, SeriesChange } from './imageSeries';
import { enumeratePaths, EventCheckResult, runEventCheck, shotListCsv } from './eventCheck';
import { initialState, simulate } from './eventSimulator';
import { DEFAULT_STATE, GameState } from './conditionEval';
import { planEndType, planStatOp, StatOp } from './statsOps';
import { BgSpec, parseBackgroundCall, planBackgroundEdit, planRemoveLine } from './backgroundOps';
import { planRandomSayText } from './randomSayOps';

interface Session {
  uri: vscode.Uri;
  line: number;
  selections: Record<string, number>;
  /** Selector values chosen in the values bar or implied by a picked if/elif branch. */
  values: Record<string, string>;
}

let panel: vscode.WebviewPanel | undefined;
let session: Session | undefined;
let pdEditor: PaperdollEditor | undefined;
let defEditor: EventDefEditor | undefined;
/** Module to open once the next publish lands (e.g. 'def' from the definition CodeLens). */
let pendingOpenModule: 'def' | undefined;
let cursorWatch: vscode.Disposable | undefined;
/** Set when the session file is saved; the next index refresh triggers one remap. */
let pendingSaveRemap = false;
/** Branch points and effective selector values of the last published timeline. */
let lastBranches: BranchPoint[] = [];
let lastValues: Record<string, string> = {};
/** Event label of the last published timeline. */
let lastEventLabel = '';

export async function showEventPreview(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore,
  uri?: vscode.Uri,
  line?: number,
  openModule?: 'def'
): Promise<void> {
  pendingOpenModule = openModule;
  const editor = vscode.window.activeTextEditor;
  const targetUri = uri ?? editor?.document.uri;
  if (!targetUri) {
    void vscode.window.showWarningMessage('Open an event script first.');
    return;
  }
  session = {
    uri: targetUri,
    line: line ?? editor?.selection.active.line ?? 0,
    selections: {},
    values: {},
  };
  ensureHelpers(context, index);

  if (panel) {
    // Stay where the user put the panel (another group, or a separate window).
    panel.reveal(undefined, false);
    await publish(context, index, store);
    return;
  }

  const created = vscode.window.createWebviewPanel(
    'mtsEventPreview',
    'MTS Event Preview',
    { viewColumn: lastColumn(context, 'preview', vscode.ViewColumn.Beside), preserveFocus: false },
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: await previewRoots(context, store) }
  );
  adoptPanel(context, index, store, created);
}

async function previewRoots(context: vscode.ExtensionContext, store: PortraitStore): Promise<vscode.Uri[]> {
  const imageRoots = (await getImageRoots()).map((r) => vscode.Uri.file(r));
  return [...imageRoots, ...portraitRoots(context, store)];
}

/**
 * Restores the event preview after VS Code reloads the window: the page stored its session
 * (file, event line, branch choices, values, stop, open module) in the webview state.
 */
export function registerPreviewSerializer(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore
): vscode.Disposable {
  return vscode.window.registerWebviewPanelSerializer('mtsEventPreview', {
    async deserializeWebviewPanel(restored: vscode.WebviewPanel, saved: unknown) {
      const s = (saved ?? {}) as { session?: { uri?: string; line?: number; selections?: Record<string, number>; values?: Record<string, string> } };
      if (!s.session?.uri || panel) {
        restored.dispose();
        return;
      }
      session = {
        uri: vscode.Uri.parse(s.session.uri),
        line: Number(s.session.line ?? 0),
        selections: s.session.selections ?? {},
        values: s.session.values ?? {},
      };
      ensureHelpers(context, index);
      restored.webview.options = { enableScripts: true, localResourceRoots: await previewRoots(context, store) };
      adoptPanel(context, index, store, restored);
      // The index is usually still building after a reload: map again once it is ready.
      pendingSaveRemap = true;
    },
  });
}

function ensureHelpers(context: vscode.ExtensionContext, index: WorkspaceIndex): void {
  if (!pdEditor) {
    pdEditor = new PaperdollEditor(context);
  }
  if (!defEditor) {
    defEditor = new EventDefEditor(index);
    // Definition edits change patterns/selectors: re-map once the index has caught up.
    defEditor.onDidEdit = () => {
      pendingSaveRemap = true;
    };
  }
  if (!cursorWatch) {
    cursorWatch = vscode.window.onDidChangeTextEditorSelection((event) => {
      const pos = event.selections[0]?.active;
      if (pos && pdEditor) {
        pdEditor.setCursor(event.textEditor.document.uri, pos.line, pos.character);
      }
    });
    context.subscriptions.push(cursorWatch);
  }
}

/** Wire a (new or restored) preview panel: placement memory, re-mapping, messages, page. */
function adoptPanel(context: vscode.ExtensionContext, index: WorkspaceIndex, store: PortraitStore, created: vscode.WebviewPanel): void {
  panel = created;
  trackColumn(context, 'preview', created);
  context.subscriptions.push(created);
  // Only re-map on a saved change to the session file — never on every keystroke.
  const saveSub = vscode.workspace.onDidSaveTextDocument((d) => {
    if (session && d.uri.toString() === session.uri.toString()) {
      pendingSaveRemap = true;
    }
  });
  const idxSub = index.onDidChange(() => {
    if (pendingSaveRemap) {
      pendingSaveRemap = false;
      void publish(context, index, store);
    }
  });
  created.onDidDispose(() => {
    saveSub.dispose();
    idxSub.dispose();
    if (panel === created) {
      panel = undefined;
    }
  });
  created.webview.onDidReceiveMessage((msg) => {
    void onMessage(context, index, store, created, msg);
  });
  // The page asks for its data with 'ready' once loaded — also when VS Code reloads it
  // after the panel was moved into another window.
  created.webview.html = html(created.webview);
}

async function onMessage(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore,
  target: vscode.WebviewPanel,
  msg: Record<string, unknown>
): Promise<void> {
  if (!session) {
    return;
  }
  // Lines in the webview can be stale (the preview only re-maps on save). Every action
  // that targets a line carries that line's text; re-locate it before touching the file.
  if (LINE_ACTIONS.has(String(msg.type)) && typeof msg.src === 'string' && msg.src) {
    const doc = await vscode.workspace.openTextDocument(session.uri);
    const at = locateLine(doc, Number(msg.line ?? 0), msg.src);
    if (at === undefined) {
      void vscode.window.showWarningMessage(
        'That line changed since the preview was built. The preview was refreshed — please try again.'
      );
      await publish(context, index, store);
      return;
    }
    msg = { ...msg, line: at };
  }
  if (String(msg.type ?? '').startsWith('def:')) {
    if (defEditor) {
      await defEditor.handleMessage(target.webview, msg);
    }
    return;
  }
  if (String(msg.type ?? '').startsWith('pd:')) {
    if (pdEditor) {
      await pdEditor.handleMessage(target.webview, index, msg);
    }
    return;
  }
  if (msg.type === 'undo') {
    const result = await undoLast();
    if (!result) {
      void vscode.window.showInformationMessage('Nothing to undo.');
    } else if (result.status === 'already') {
      void vscode.window.showInformationMessage(`"${result.label}" was already reverted.`);
    } else if (result.status === 'lost') {
      void vscode.window.showWarningMessage(
        `"${result.label}" can't be found anymore (the lines were edited since) — use the editor's undo (Ctrl+Z).`
      );
    } else {
      void vscode.window.showInformationMessage(`Reverted: ${result.label}`);
    }
    await publish(context, index, store);
    return;
  }
  if (msg.type === 'moveStatement') {
    const line = Number(msg.line ?? 0);
    const direction = Number(msg.direction) < 0 ? -1 : 1;
    await runScenePlan(context, index, store, 'Timeline: move statement', (text) => planMoveStatement(text, line, direction));
    return;
  }
  if (msg.type === 'addMenuChoice') {
    const line = Number(msg.line ?? 0);
    const key = String(msg.key ?? '').trim();
    const title = String(msg.title ?? '').trim();
    await runScenePlan(context, index, store, 'Timeline: add menu choice', (text) => planAddMenuChoice(text, line, key, title));
    return;
  }
  if (msg.type === 'removeMenuChoice') {
    const line = Number(msg.line ?? 0);
    await runScenePlan(context, index, store, 'Timeline: remove menu choice', (text) =>
      planRemoveMenuChoice(text, line, Number(msg.index ?? -1), String(msg.key ?? ''))
    );
    return;
  }
  if (msg.type === 'newEvent') {
    await vscode.commands.executeCommand('mtsEventManager.newEvent', session.uri.toString());
    return;
  }
  if (msg.type === 'optimizeEvent') {
    await optimizeEvent(context, index, store);
    return;
  }
  if (msg.type === 'setValue') {
    // A value decides every if/elif chain that tests it: drop explicit picks for those.
    const key = String(msg.key ?? '');
    const value = String(msg.value ?? '');
    if (key) {
      const values = { ...session.values };
      if (value) {
        values[key] = value;
      } else {
        delete values[key];
      }
      const selections = { ...session.selections };
      for (const b of lastBranches) {
        if (b.kind === 'if' && b.bindings?.some((x) => key in x)) {
          delete selections[b.id];
        }
      }
      session.values = values;
      session.selections = selections;
      await publish(context, index, store, true);
    }
    return;
  }
  if (msg.type === 'selectBranch') {
    const id = String(msg.id ?? '');
    const choice = Number(msg.choice ?? 0);
    if (id) {
      session.selections = { ...session.selections, [id]: choice };
      const b = lastBranches.find((x) => x.id === id);
      if (b?.kind === 'if' && b.bindings) {
        const values = { ...session.values };
        const chosen = b.bindings[choice] ?? {};
        for (const key of new Set(b.bindings.flatMap((x) => Object.keys(x)))) {
          if (chosen[key]?.length) {
            values[key] = pickBranchValue(key, chosen[key], (await patternValuesFor(index, lastEventLabel))[key]);
          } else {
            delete values[key];
          }
        }
        session.values = values;
      }
      await publish(context, index, store, true);
    }
    return;
  }
  if (msg.type === 'ready') {
    await publish(context, index, store);
    return;
  }
  if (msg.type === 'check:run') {
    await runCheck(target, index);
    return;
  }
  if (msg.type === 'check:showPath') {
    const sel = (msg.selections ?? {}) as Record<string, number>;
    session.selections = { ...sel };
    session.values = await valuesForSelections(index, session.selections);
    await publish(context, index, store);
    return;
  }
  if (msg.type === 'check:shotlist') {
    await exportShotList();
    return;
  }
  if (msg.type === 'sim:init') {
    await target.webview.postMessage({ type: 'sim:init', state: initialState(index, DEFAULT_STATE) });
    return;
  }
  if (msg.type === 'sim:eval') {
    const state = { ...DEFAULT_STATE, ...(msg.state as Partial<GameState>) } as GameState;
    await target.webview.postMessage({ type: 'sim:result', label: lastEventLabel, result: await simulate(index, lastEventLabel, state) });
    return;
  }
  if (msg.type === 'openLabel') {
    const lab = index.getLabel(String(msg.label ?? ''));
    if (lab) {
      await showEventPreview(context, index, store, lab.uri, lab.range.start.line);
    }
    return;
  }
  if (msg.type === 'openOverview') {
    await vscode.commands.executeCommand('mtsEventManager.eventOverview');
    return;
  }
  if (msg.type === 'statOp') {
    const op = msg.op === 'remove'
      ? ({ op: 'remove', stat: String(msg.stat ?? '') } as StatOp)
      : ({ op: msg.op === 'add' ? 'add' : 'set', stat: String(msg.stat ?? ''), value: String(msg.value ?? '') } as StatOp);
    await runLinePlan(context, index, store, Number(msg.line ?? 0), String(msg.src ?? ''), 'Timeline: stat change', (text, l) => planStatOp(text, l, op));
    return;
  }
  if (msg.type === 'endOp') {
    await runLinePlan(context, index, store, Number(msg.line ?? 0), String(msg.src ?? ''), 'Timeline: end_event type', (text, l) => planEndType(text, l, String(msg.endType ?? '')));
    return;
  }
  if (msg.type === 'reveal') {
    const line = Number(msg.line ?? 0);
    const doc = await vscode.workspace.openTextDocument(session.uri);
    const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true });
    const pos = new vscode.Position(line, 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    return;
  }
  if (msg.type === 'plusInsert' && msg.kind === 'video') {
    await insertVideo(context, index, store, Number(msg.line ?? 0));
    return;
  }
  if (msg.type === 'plusInsert') {
    await plusInsert(
      context,
      index,
      store,
      String(msg.kind ?? 'dialog'),
      Number(msg.line ?? 0),
      msg.speaker ? String(msg.speaker) : undefined
    );
    return;
  }
  if (msg.type === 'editText') {
    await editDialogueText(context, index, store, Number(msg.line ?? 0), String(msg.text ?? ''));
    return;
  }
  if (msg.type === 'deleteStop') {
    await deleteStopLine(context, index, store, Number(msg.line ?? 0));
    return;
  }
  if (msg.type === 'changeSpeaker') {
    await changeSpeaker(context, index, store, Number(msg.line ?? 0), String(msg.personKey ?? ''));
    return;
  }
  if (msg.type === 'changeType') {
    await changeType(context, index, store, Number(msg.line ?? 0), String(msg.speechType ?? 'say'));
    return;
  }
  if (msg.type === 'editMenuChoice') {
    await editMenuChoice(
      context,
      index,
      store,
      Number(msg.line ?? 0),
      Number(msg.choice ?? 0),
      String(msg.title ?? ''),
      String(msg.target ?? '')
    );
    return;
  }
  if (msg.type === 'openMarker') {
    const kind = String(msg.kind ?? '');
    const line = Number(msg.line ?? 0);
    const character = Number(msg.character ?? 0);
    if (kind === 'paperdoll' && pdEditor) {
      pdEditor.setAnchor(session.uri, line, character);
      await pdEditor.publish(target.webview, index);
    } else if (kind === 'image') {
      const ref = msg.image as ImageRef | undefined;
      if (ref && (ref.kind === 'show' || ref.kind === 'show_pattern' || ref.kind === 'show_image' || ref.kind === 'show_video')) {
        await openImageEditor(index, target, line, ref);
      } else {
        await openImagePreview(index, msg);
      }
    }
    return;
  }
  if (msg.type === 'imgChange') {
    await sendImageEditor(index, target, Number(msg.line ?? 0), String(msg.patternKey ?? 'main'), parseSteps(msg.steps), !!msg.pause, !!msg.video, singleOf(msg));
    return;
  }
  if (msg.type === 'imgApply' && singleOf(msg)) {
    const single = singleOf(msg)!;
    await seriesApply(context, index, store, Number(msg.line ?? 0), String(msg.src ?? ''), String(msg.patternKey ?? 'main'), single.index, {
      step: parseSteps(msg.steps)[0],
      pause: !!msg.pause,
    });
    return;
  }
  if (msg.type === 'editAltText') {
    await runLinePlan(context, index, store, Number(msg.line ?? 0), String(msg.src ?? ''), 'Timeline: edit random_say line', (text, l) =>
      planRandomSayText(text, l, Number(msg.argIndex ?? -1), String(msg.text ?? ''))
    );
    return;
  }
  if (msg.type === 'imgRemove') {
    await runLinePlan(context, index, store, Number(msg.line ?? 0), String(msg.src ?? ''), 'Timeline: remove image', (text, l) =>
      planRemoveLine(text, l, (row) => parseImageLine(row).form !== null)
    );
    await target.webview.postMessage({ type: 'closeModule', module: 'img' });
    return;
  }
  if (msg.type === 'bg:open' || msg.type === 'bg:change') {
    await sendBgEditor(index, target, Number(msg.line ?? 0), String(msg.src ?? ''), msg.type === 'bg:change' ? (msg.spec as BgSpec) : undefined);
    return;
  }
  if (msg.type === 'bg:apply') {
    const spec = msg.spec as BgSpec;
    await runLinePlan(context, index, store, Number(msg.line ?? 0), String(msg.src ?? ''), 'Timeline: edit background', (text, l) => planBackgroundEdit(text, l, spec));
    await sendBgEditor(index, target, Number(msg.line ?? 0), String(msg.src ?? ''));
    return;
  }
  if (msg.type === 'imgRemoveStep' && singleOf(msg)) {
    await seriesApply(context, index, store, Number(msg.line ?? 0), String(msg.src ?? ''), String(msg.patternKey ?? 'main'), singleOf(msg)!.index, { remove: true });
    return;
  }
  if (msg.type === 'imgApply') {
    await imgApply(context, index, store, Number(msg.line ?? 0), String(msg.patternKey ?? 'main'), parseSteps(msg.steps), !!msg.pause, !!msg.video);
    return;
  }
  if (msg.type === 'movieAdd') {
    await movieAdd(context, index, store, Number(msg.line ?? 0), String(msg.patternKey ?? 'main'), parseSteps(msg.steps), !!msg.loop, !!msg.all, !!msg.pause);
    return;
  }
  if (msg.type === 'movieLoop') {
    await movieLoop(context, index, store, Number(msg.line ?? 0), String(msg.patternKey ?? 'main'), parseSteps(msg.steps), !!msg.loop, !!msg.pause);
    return;
  }
}

function parseSteps(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0);
  }
  if (typeof raw === 'string') {
    return [...raw.matchAll(/\d+/g)].map((m) => parseInt(m[0], 10));
  }
  return [];
}

interface ParsedImageLine {
  form: 'show' | 'show_image' | 'show_pattern' | 'show_video' | null;
  /** show_video arguments the module does not model (e.g. `variant = 2`) — rewriting would drop them. */
  extraArgs?: boolean;
  variable?: string;
  steps: number[];
  pause: boolean;
  patternKey?: string;
}

/** Arguments after `step` other than a positional `True`/`False` or `pause = …`. */
function videoExtraArgs(tail: string): boolean {
  const rest = tail.replace(/^\s*,/, '').split(',').map((s) => s.trim()).filter(Boolean);
  return rest.some((a, i) => !(i === 0 && /^(True|False)$/.test(a)) && !/^pause\s*=\s*(True|False)$/.test(a));
}

/** Read an existing image statement so the module can preload its steps/pause. */
function parseImageLine(lineText: string): ParsedImageLine {
  let m: RegExpExecArray | null;
  if ((m = /call\s+Image_Series\s*\.\s*show_image\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)([^)]*)\)/.exec(lineText))) {
    const kw = m[2].search(/[A-Za-z_]\w*\s*=/);
    const positional = kw >= 0 ? m[2].slice(0, kw) : m[2];
    const steps = [...positional.matchAll(/(\d+)/g)].map((x) => parseInt(x[1], 10));
    return { form: 'show_image', variable: m[1], steps, pause: /\bpause\s*=\s*True\b/.test(m[2]) };
  }
  if ((m = /\$?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*show_video\s*\(\s*(\d+)([^)]*)\)/.exec(lineText))) {
    return { form: 'show_video', variable: m[1], steps: [parseInt(m[2], 10)], pause: videoPauseFlag(m[3]), extraArgs: videoExtraArgs(m[3]) };
  }
  if ((m = /\$?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*show\s*\(\s*(\d+)\s*\)/.exec(lineText))) {
    return { form: 'show', variable: m[1], steps: [parseInt(m[2], 10)], pause: false };
  }
  if ((m = /show_pattern\s*\(\s*['"]([^'"]+)['"]/.exec(lineText))) {
    return { form: 'show_pattern', steps: [], pause: false, patternKey: m[1] };
  }
  return { form: null, steps: [], pause: false };
}

/**
 * One step → `image.show(N)`; several → `call Image_Series.show_image(var, …)`;
 * video → `image.show_video(N)` (one step, `pause = True` makes it a stop).
 */
function buildImageCallText(patternKey: string, steps: number[], pause: boolean, hasStep: boolean, variable = 'image', video = false): string {
  if (!hasStep) {
    return `$ show_pattern("${patternKey}", **kwargs)`;
  }
  if (video) {
    return `$ ${variable}.show_video(${steps[0] ?? 0}${pause ? ', pause = True' : ''})`;
  }
  if (steps.length <= 1) {
    return `$ ${variable}.show(${steps[0] ?? 0})`;
  }
  return `call Image_Series.show_image(${variable}, ${steps.join(', ')}${pause ? ', pause = True' : ''})`;
}

async function openImageEditor(
  index: WorkspaceIndex,
  target: vscode.WebviewPanel,
  line: number,
  ref: ImageRef
): Promise<void> {
  if (!session) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  const labels = labelsOf(doc);
  const parsed = parseImageLine(doc.lineAt(Math.min(line, doc.lineCount - 1)).text);
  let patternKey = parsed.patternKey ?? ref.patternKey ?? 'main';
  if (!parsed.patternKey && parsed.variable) {
    patternKey = resolvePatternKeyForVariable(doc.getText(), labels, parsed.variable, line) ?? patternKey;
  }
  if (parsed.form === 'show_image' && ref.kind === 'show_image' && ref.stepIndex !== undefined) {
    // One step of a series: edit just that image (its number; pause only on the last one).
    const i = Math.min(ref.stepIndex, parsed.steps.length - 1);
    await sendImageEditor(index, target, line, patternKey, [parsed.steps[i] ?? ref.steps[0] ?? 0], parsed.pause, false, {
      index: i,
      count: parsed.steps.length,
    });
    return;
  }
  const steps = parsed.steps.length ? parsed.steps : ref.steps.length ? ref.steps : [0];
  await sendImageEditor(index, target, line, patternKey, steps, parsed.pause, parsed.form === 'show_video');
}

function seriesPreview(doc: vscode.TextDocument, line: number, single: SingleStep, step: number | undefined, pause: boolean): string {
  const lineText = line < doc.lineCount ? doc.lineAt(line).text : '';
  const plan = planSeriesStepEdit(lineText, single.index, { step, pause });
  return 'error' in plan ? plan.error : plan.text.trim();
}

interface SingleStep {
  /** Position of the step in the show_image call. */
  index: number;
  count: number;
}

function singleOf(msg: Record<string, unknown>): SingleStep | undefined {
  const i = Number(msg.stepIndex);
  const n = Number(msg.stepCount);
  return Number.isInteger(i) && i >= 0 && Number.isInteger(n) && n > 0 ? { index: i, count: n } : undefined;
}

/**
 * Change / remove ONE step of a `call Image_Series.show_image(…)` (or toggle pause on its
 * last step). Surgical and verified (imageSeries.planSeriesStepEdit), undoable.
 */
async function seriesApply(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore,
  line: number,
  src: string,
  patternKey: string,
  stepIndex: number,
  change: SeriesChange
): Promise<void> {
  if (!session) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  const l = src ? locateLine(doc, line, src) : line;
  if (l === undefined || l >= doc.lineCount) {
    void vscode.window.showWarningMessage('The show_image line moved or changed — nothing was written.');
    return;
  }
  const lineText = doc.lineAt(l).text;
  const plan = planSeriesStepEdit(lineText, stepIndex, change);
  if ('error' in plan) {
    void vscode.window.showWarningMessage(plan.error);
    return;
  }
  if (!plan.edits.length) {
    return;
  }
  const text = doc.getText();
  const base = doc.offsetAt(new vscode.Position(l, 0));
  const edits = plan.edits.map((e) => ({ start: base + e.start, end: base + e.end, text: e.text }));
  const error = await applyVerifiedEdits(doc.uri, text, edits, change.remove ? 'Timeline: remove image step' : 'Timeline: edit image step');
  if (error) {
    void vscode.window.showWarningMessage(error);
    return;
  }
  session.line = l;
  await publish(context, index, store);
  if (panel) {
    const after = parseSeriesLine((await vscode.workspace.openTextDocument(session.uri)).lineAt(l).text);
    if (after) {
      const count = after.steps.length;
      const i = Math.min(stepIndex, count - 1);
      const step = Number(after.steps[i].value);
      await sendImageEditor(index, panel, l, patternKey, [step], after.pause, false, { index: i, count });
    }
  }
}

async function sendImageEditor(
  index: WorkspaceIndex,
  target: vscode.WebviewPanel,
  line: number,
  patternKey: string,
  steps: number[],
  pause: boolean,
  video = false,
  single?: SingleStep
): Promise<void> {
  if (!session) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  const labels = labelsOf(doc);
  const lab = labelAtLine(labels, line);
  const labelName = lab?.name ?? '';
  const keys = [...new Set(index.getPatternsForLabel(labelName).map((p) => p.patternKey))].sort();
  if (!keys.includes(patternKey) && patternKey) {
    keys.unshift(patternKey);
  }
  const forKey = index.getPatternsForLabel(labelName, patternKey);
  const hasStep = forKey.some((p) => p.pathTemplate.includes('<step>'));
  const eventLabel = lab ? (lab.isSub ? lab.name.split('.')[0] : lab.name) : '';
  const step0 = steps[0] ?? 0;
  const ref: ImageRef = hasStep
    ? { kind: 'show', line, character: 0, patternKey, steps: [step0] }
    : { kind: 'show_pattern', line, character: 0, patternKey, steps: [] };
  const isVideo = video && hasStep;
  const parsed = parseImageLine(line < doc.lineCount ? doc.lineAt(line).text : '');
  const variable = (hasStep && findConvertVar(doc.getText(), labels, patternKey, line)) || parsed.variable || 'image';
  let preview: string | undefined;
  let videoView: VideoView | undefined;
  if (isVideo) {
    const r = await resolveVideo(index, doc, labels, { ...ref, kind: 'show_video', variableName: variable }, eventLabel, lastValues);
    preview = r.poster;
    videoView = r.video;
  } else {
    preview = await resolveImageRef(index, doc, labels, ref, eventLabel, lastValues);
  }
  await target.webview.postMessage({
    type: 'imageEditor',
    line,
    src: line < doc.lineCount ? doc.lineAt(line).text.trim() : '',
    patternKey,
    steps: hasStep ? (steps.length ? (isVideo ? steps.slice(0, 1) : steps) : [0]) : [],
    pause,
    hasStep,
    keys,
    preview: preview ?? '',
    video: isVideo,
    videoView,
    call: single ? seriesPreview(doc, line, single, steps[0], pause) : buildImageCallText(patternKey, steps, pause, hasStep, variable, isVideo),
    single,
    missing: keys.length === 0,
  });
}

async function imgApply(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore,
  line: number,
  patternKey: string,
  steps: number[],
  pause: boolean,
  video = false
): Promise<void> {
  if (!session) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  if (line >= doc.lineCount) {
    return;
  }
  const text = doc.getText();
  const labels = labelsOf(doc);
  const labelName = labelAtLine(labels, line)?.name ?? '';
  const forKey = index.getPatternsForLabel(labelName, patternKey);
  const hasStep = forKey.some((p) => p.pathTemplate.includes('<step>'));
  const lineText = doc.lineAt(line).text;
  const current = parseImageLine(lineText);
  if (!current.form) {
    void vscode.window.showWarningMessage('The target line is not an image statement — nothing was changed.');
    return;
  }
  if (current.extraArgs) {
    void vscode.window.showWarningMessage('This show_video call has arguments the module does not edit (e.g. variant) — change it in the code.');
    return;
  }
  const indent = lineText.match(/^[ \t]*/)?.[0] ?? '    ';
  const comment = /\s+#.*$/.exec(lineText)?.[0] ?? '';
  const edit = new vscode.WorkspaceEdit();
  let shift = 0;
  let variable = 'image';
  if (hasStep) {
    const bound = findConvertVar(text, labels, patternKey, line);
    if (bound) {
      variable = bound;
    } else {
      edit.insert(doc.uri, new vscode.Position(line, 0), `${indent}$ ${variable} = convert_pattern("${patternKey}", **kwargs)\n`);
      shift = 1;
    }
  }
  const statement = buildImageCallText(patternKey, steps, pause, hasStep, variable, video && hasStep);
  edit.replace(doc.uri, doc.lineAt(line).range, `${indent}${statement}${comment}`);
  const ok = await applyReversibleEdit(doc.uri, edit, 'Timeline: update image');
  if (ok) {
    session.line = line + shift;
    await publish(context, index, store);
    if (panel) {
      await sendImageEditor(index, panel, line + shift, patternKey, steps, pause, video && hasStep);
    }
  }
}

/** Latest variable bound to `patternKey` via convert_pattern before `beforeLine`. */
function findConvertVar(
  text: string,
  labels: ReturnType<WorkspaceIndex['getLabelsForUri']>,
  patternKey: string,
  beforeLine: number
): string | undefined {
  const span = topLevelLabelSpan(labels, beforeLine);
  const lines = text.split('\n');
  const re = /\$?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*convert_pattern(?:_with_data)?\s*\(\s*['"]([^'"]+)['"]/;
  let found: string | undefined;
  const last = Math.min(beforeLine, lines.length);
  for (let i = span.startLine; i < last; i++) {
    const m = re.exec(lines[i] ?? '');
    if (m && m[2] === patternKey) {
      found = m[1];
    }
  }
  return found;
}

/** The Movie that `show_video(step)` at `line` would play (for the module's add/loop actions). */
async function videoAtLine(
  index: WorkspaceIndex,
  doc: vscode.TextDocument,
  labels: LabelDefinition[],
  line: number,
  patternKey: string,
  step: number
): Promise<VideoView | undefined> {
  const lab = labelAtLine(labels, line);
  const eventLabel = lab ? (lab.isSub ? lab.name.split('.')[0] : lab.name) : '';
  const variable = findConvertVar(doc.getText(), labels, patternKey, line) ?? 'image';
  const ref: ImageRef = { kind: 'show_video', line, character: 0, variableName: variable, patternKey, steps: [step] };
  return (await resolveVideo(index, doc, labels, ref, eventLabel, lastValues)).video;
}

/**
 * Declare the Movie(s) for a `show_video` step: `image anim_… = Movie(play = ….webm,
 * start_image = ….webp[, loop = True])`, next to the event's other Movie lines. With
 * `all`, every placeholder variant of the step (e.g. each school_level) that has a video
 * file and no declaration yet. Verified before writing, undoable.
 */
async function movieAdd(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore,
  line: number,
  patternKey: string,
  steps: number[],
  loop: boolean,
  all: boolean,
  pause = false
): Promise<void> {
  if (!session) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  const text = doc.getText();
  const labels = labelsOf(doc);
  const span = topLevelLabelSpan(labels, line);
  const variable = findConvertVar(text, labels, patternKey, line) ?? 'image';
  const prefix = videoPrefixFor(text.split('\n'), variable, span.startLine, line);
  const constraints = paramConstraintsForLine(text, labels, line);
  if (!all) {
    for (const [k, v] of Object.entries(lastValues)) {
      constraints[k] = [v];
    }
  }
  const site: ImageCallSite = {
    kind: 'show',
    range: new vscode.Range(line, 0, line, 1),
    variableName: variable,
    patternKey,
    steps: [steps[0] ?? 0],
    paramConstraints: constraints,
  };
  const infos = await resolveSiteImages(index, doc, site, labels, { maxResults: all ? 200 : 1 });
  imageRootsCache ??= await getImageRoots();
  const local = new Set(movieDefsOf(doc).map((d) => d.name));
  const movies: NewMovie[] = [];
  const noVideo: string[] = [];
  for (const info of infos) {
    const name = movieNameFor(info.relativePath, prefix);
    const elsewhere = index.getMovie(name);
    if (local.has(name) || (elsewhere && elsewhere.uri.toString() !== doc.uri.toString())) {
      continue;
    }
    const videoRel = siblingVideoPath(info.relativePath);
    if (!findUnderRoots(videoRel, imageRootsCache)) {
      noVideo.push(videoRel);
      continue;
    }
    movies.push({ name, imageRel: info.relativePath, loop });
  }
  if (!movies.length) {
    void vscode.window.showWarningMessage(
      !infos.length
        ? 'No pattern image found for this step — nothing was added.'
        : noVideo.length
          ? `No video file next to the image: ${noVideo[0]} — nothing was added.`
          : 'The Movie definition already exists.'
    );
    return;
  }
  const plan = planAddMovieDefs(text, movies, span.startLine);
  if ('error' in plan) {
    void vscode.window.showWarningMessage(plan.error);
    return;
  }
  const error = await applyVerifiedEdits(doc.uri, text, plan.edits, 'Timeline: add Movie definition');
  if (error) {
    void vscode.window.showWarningMessage(error);
    return;
  }
  const insertedAt = text.slice(0, plan.edits[0].start).split('\n').length - 1;
  const shift = (l: number) => (l >= insertedAt ? plan.text.split('\n').length - text.split('\n').length : 0);
  session.line += shift(session.line);
  const skipped = noVideo.length ? ` (${noVideo.length} variant(s) without a .webm skipped)` : '';
  void vscode.window.showInformationMessage(`Added ${movies.length} Movie definition(s): ${movies.map((m) => m.name).join(', ')}${skipped}`);
  await publish(context, index, store);
  if (panel) {
    await sendImageEditor(index, panel, line + shift(line), patternKey, steps, pause, true);
  }
}

/** Switch `loop = True` on the Movie declaration the step plays (wherever it is declared). */
async function movieLoop(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore,
  line: number,
  patternKey: string,
  steps: number[],
  loop: boolean,
  pause = false
): Promise<void> {
  if (!session) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  const labels = labelsOf(doc);
  const view = await videoAtLine(index, doc, labels, line, patternKey, steps[0] ?? 0);
  if (!view?.defined) {
    return;
  }
  const local = movieDefsOf(doc).some((d) => d.name === view.name);
  const target = local ? doc : await vscode.workspace.openTextDocument(index.getMovie(view.name)!.uri);
  const text = target.getText();
  const plan = planSetMovieLoop(text, view.name, loop);
  if ('error' in plan) {
    void vscode.window.showWarningMessage(plan.error);
    return;
  }
  const error = await applyVerifiedEdits(target.uri, text, plan.edits, 'Timeline: Movie loop');
  if (error) {
    void vscode.window.showWarningMessage(error);
    return;
  }
  if (!local) {
    // Declared in another file: the index must see the change.
    index.scheduleReindex(0);
  }
  await publish(context, index, store);
  if (panel) {
    await sendImageEditor(index, panel, line, patternKey, steps, pause, true);
  }
}

/**
 * Insert `$ image.show_video(0)` after `line` (binding `image` with convert_pattern first
 * when the event has none for a stepped pattern) and open the module in video mode.
 */
async function insertVideo(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore,
  line: number
): Promise<void> {
  if (!session) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  const labels = labelsOf(doc);
  const lab = labelAtLine(labels, line);
  const eventLabel = lab ? (lab.isSub ? lab.name.split('.')[0] : lab.name) : '';
  const stepped = index.getPatternsForLabel(eventLabel).filter((p) => p.pathTemplate.includes('<step>'));
  const key = stepped.some((p) => p.patternKey === 'main') ? 'main' : stepped[0]?.patternKey;
  if (!key) {
    void vscode.window.showWarningMessage('Videos need a Pattern with a <step> placeholder in the event definition — none found.');
    return;
  }
  const anchor = doc.lineAt(Math.min(line, doc.lineCount - 1));
  const indent = anchor.text.match(/^[ \t]*/)?.[0] ?? '    ';
  const bound = findConvertVar(doc.getText(), labels, key, anchor.lineNumber + 1);
  const rows = [`${indent}$ ${bound ?? 'image'}.show_video(0)`];
  if (!bound) {
    rows.unshift(`${indent}$ image = convert_pattern("${key}", **kwargs)`);
  }
  const edit = new vscode.WorkspaceEdit();
  edit.insert(doc.uri, anchor.range.end, `\n${rows.join('\n')}`);
  const ok = await applyReversibleEdit(doc.uri, edit, 'Timeline: insert video');
  if (ok) {
    const videoLine = anchor.lineNumber + rows.length;
    session.line = videoLine;
    await publish(context, index, store);
    if (panel) {
      await sendImageEditor(index, panel, videoLine, key, [0], false, true);
    }
  }
}

/**
 * Insert a new statement after `line`, matching its indent, then re-anchor the preview
 * on it. Dialogue/image/menu write a starter snippet; paperdoll is handled client-side
 * by opening the embedded paperdoll editor at the gap (its Insert buttons do the write).
 */
async function plusInsert(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore,
  kind: string,
  line: number,
  speaker?: string
): Promise<void> {
  if (!session) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  const anchor = doc.lineAt(Math.min(line, doc.lineCount - 1));
  const indent = anchor.text.match(/^[ \t]*/)?.[0] ?? '    ';
  const snippet = insertSnippet(kind, indent, speaker);
  if (!snippet) {
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.insert(doc.uri, anchor.range.end, `\n${snippet.text}`);
  const ok = await applyReversibleEdit(doc.uri, edit, `Timeline: insert ${snippet.label}`);
  if (ok) {
    session.line = anchor.lineNumber + snippet.anchorOffset;
    if (kind === 'dialog') {
      pendingEditLine = session.line;
    }
    await publish(context, index, store);
    const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true });
    if (snippet.cursor) {
      const pos = new vscode.Position(anchor.lineNumber + snippet.cursor.line, snippet.cursor.character);
      ed.selection = new vscode.Selection(pos, pos);
      ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  }
}

/** Replace the spoken string on a dialogue line with new (properly escaped) text. */
async function editDialogueText(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore,
  line: number,
  newText: string
): Promise<void> {
  if (!session) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  if (line >= doc.lineCount) {
    return;
  }
  const lineText = doc.lineAt(line).text;
  if (!isSayLine(lineText)) {
    await refuseNotDialogue();
    return;
  }
  const q = lineText.search(/["']/);
  if (q < 0) {
    return;
  }
  const lit = readStringLiteral(lineText, q);
  if (!lit) {
    return;
  }
  const quote = lineText[q];
  const escaped = newText.replace(/\\/g, '\\\\').split(quote).join('\\' + quote);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(line, q, line, lit.end), `${quote}${escaped}${quote}`);
  const ok = await applyReversibleEdit(doc.uri, edit, 'Timeline: edit dialogue');
  if (ok) {
    session.line = line;
    await publish(context, index, store);
  }
}

/**
 * Optimize the whole event: paperdoll display de-duplication plus merging consecutive
 * `image.show` runs into `show_image`. Both edit sets target different lines, so they
 * apply together as one reversible change.
 */
async function optimizeEvent(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore
): Promise<void> {
  if (!session) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  const text = doc.getText();
  const labels = labelsOf(doc);
  const pd = optimizePaperdollEvent(text, labels, session.line);
  const img = optimizeImageShows(text, labels, session.line);
  const all = [...pd.edits, ...img.edits];
  if (all.length === 0) {
    void vscode.window.showInformationMessage('Nothing to optimize in this event.');
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  for (const e of all) {
    const s = offsetToPosition(text, e.start);
    const en = offsetToPosition(text, e.end);
    edit.replace(doc.uri, new vscode.Range(s.line, s.character, en.line, en.character), e.text);
  }
  const ok = await applyReversibleEdit(doc.uri, edit, 'Timeline: optimize event');
  if (ok) {
    await publish(context, index, store);
    const parts: string[] = [];
    if (pd.fields > 0) {
      parts.push(`${pd.fields} paperdoll field${pd.fields === 1 ? '' : 's'}`);
    }
    if (img.merged > 0) {
      parts.push(`${img.merged} image sequence${img.merged === 1 ? '' : 's'}`);
    }
    void vscode.window.showInformationMessage(
      parts.length ? `Optimized: ${parts.join(', ')}.` : 'Nothing to optimize.'
    );
  }
}

/** Delete a single-line stop (dialogue / pause) and re-anchor on the previous stop. */
async function deleteStopLine(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore,
  line: number
): Promise<void> {
  if (!session) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  if (line >= doc.lineCount) {
    return;
  }
  const row = doc.lineAt(line).text;
  if (!isSayLine(row) && !PAUSE_LINE_RE.test(row)) {
    void vscode.window.showWarningMessage('Only dialogue and pause lines can be deleted here — nothing was changed.');
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.delete(doc.uri, doc.lineAt(line).rangeIncludingLineBreak);
  const ok = await applyReversibleEdit(doc.uri, edit, 'Timeline: delete line');
  if (ok) {
    session.line = Math.max(0, line - 1);
    await publish(context, index, store);
  }
}

/**
 * Labels of the document as it is right now. The workspace index re-scans on a debounce,
 * so right after a composition edit (e.g. a new branch sublabel) it can lag behind.
 */
/**
 * Background module: the set_background(_split) call at `line` (or a draft spec while the
 * user edits), with previews of its image(s).
 */
async function sendBgEditor(index: WorkspaceIndex, target: vscode.WebviewPanel, line: number, src: string, draft?: BgSpec): Promise<void> {
  if (!session) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  const l = (src ? locateLine(doc, line, src) : line) ?? line;
  const text = doc.getText();
  const parsed = parseBackgroundCall(text, l);
  if (!parsed) {
    await target.webview.postMessage({ type: 'bgEditor', line: l, missing: true });
    return;
  }
  const spec = draft ?? parsed.spec;
  const labels = labelsOf(doc);
  const lab = labelAtLine(labels, l);
  const eventLabel = lab ? lab.name.split('.')[0] : '';
  const previews: (string | undefined)[] = [];
  for (const s of spec.sources) {
    let ref: ImageRef | undefined;
    if (s.kind === 'series') {
      ref = { kind: 'set_background', line: l, character: 0, steps: [s.step], variableName: s.variable, patternKey: resolvePatternKeyForVariable(text, labels, s.variable, l) };
    } else if (s.kind === 'path') {
      ref = { kind: 'set_background_path', line: l, character: 0, steps: [], literalPath: s.path };
    }
    previews.push(ref ? await resolveImageRef(index, doc, labels, ref, eventLabel, lastValues) : undefined);
  }
  await target.webview.postMessage({
    type: 'bgEditor',
    line: l,
    src: doc.lineAt(l).text.trim(),
    spec,
    saved: parsed.spec,
    previews,
    positionalOptions: parsed.positionalOptions,
  });
}

/** Dialogue line whose text the next publish opens for editing (a new "＋ Dialogue"). */
let pendingEditLine: number | undefined;

/** Stop the next publish should show (set by revealInEventTimeline). */
let pendingFocusStop: number | undefined;

/**
 * A path picked by its branch choices fixes its if/elif values too (a level branch picks
 * a level that has images).
 */
async function valuesForSelections(index: WorkspaceIndex, selections: Record<string, number>): Promise<Record<string, string>> {
  if (!session) {
    return {};
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  const labels = labelsOf(doc);
  const tl = buildEventTimeline(doc.getText(), labels, index.getPersonIndex(), session.line, () => ({}), { selections });
  const fileValues = await patternValuesFor(index, tl.eventLabel);
  const values: Record<string, string> = {};
  for (const b of tl.branches) {
    if (b.kind === 'if' && b.bindings) {
      for (const [k, vals] of Object.entries(b.bindings[b.selected] ?? {})) {
        if (vals.length && values[k] === undefined) {
          values[k] = pickBranchValue(k, vals, fileValues[k]);
        }
      }
    }
  }
  return values;
}

/**
 * The stop that shows the script at `line`: the stop on that line or the next one in the
 * same label (what the player sees after that statement); -1 when the path doesn't pass there.
 */
export function stopAtScriptLine(timeline: ReturnType<typeof buildEventTimeline>, labels: LabelDefinition[], line: number): number {
  const lab = labelAtLine(labels, line);
  const sorted = [...labels].sort((a, b) => a.range.start.line - b.range.start.line);
  const start = lab ? lab.range.start.line : 0;
  const next = sorted.find((l) => l.range.start.line > start);
  const end = next ? next.range.start.line : Number.MAX_SAFE_INTEGER;
  const inLabel = timeline.stops.filter((s) => s.line >= start && s.line < end);
  if (!inLabel.length) {
    return -1;
  }
  return (inLabel.find((s) => s.line >= line) ?? inLabel[inLabel.length - 1]).index;
}

/**
 * "Show in Event Timeline": open the event of `line` in the preview (if it isn't already)
 * and jump to that place — switching to a branch path that reaches it when needed.
 */
export async function revealInEventTimeline(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore,
  uri: vscode.Uri,
  line: number
): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const labels = labelsOf(doc);
  const span = topLevelLabelSpan(labels, line);
  const top = labels.find((l) => !l.isSub && l.range.start.line === span.startLine);
  if (!top || !index.getEventsForLabel(top.name).length) {
    void vscode.window.showInformationMessage('This line is not inside an event label.');
    return;
  }
  const sameEvent = !!panel && !!session && session.uri.toString() === uri.toString() && topLevelLabelSpan(labels, session.line).startLine === span.startLine;
  const text = doc.getText();
  const persons = index.getPersonIndex();
  const selectorValues = (l: number) => {
    const lab = labelAtLine(labels, l);
    return lab ? index.getSelectorValuesForLabel(lab.name) : {};
  };
  const build = (selections: Record<string, number>, values: Record<string, string> = {}) =>
    buildEventTimeline(text, labels, persons, span.startLine, selectorValues, { selections, values });
  let selections = sameEvent ? session!.selections : {};
  let values = sameEvent ? session!.values : {};
  let stop = stopAtScriptLine(build(selections, values), labels, line);
  if (stop < 0) {
    // Not on the shown path: take the first path that passes this label.
    const found = enumeratePaths((sel) => build(sel)).paths.find((p) => stopAtScriptLine(p.timeline, labels, line) >= 0);
    if (found) {
      selections = found.selections;
      stop = stopAtScriptLine(found.timeline, labels, line);
      values = {};
    }
  }
  if (!sameEvent) {
    await showEventPreview(context, index, store, uri, span.startLine);
  }
  if (!session) {
    return;
  }
  session.line = line;
  session.selections = { ...selections };
  session.values = Object.keys(values).length ? values : await valuesForSelections(index, session.selections);
  pendingFocusStop = stop >= 0 ? stop : undefined;
  panel?.reveal(undefined, false);
  await publish(context, index, store);
}

/** Last check result (for the shot list export). */
let lastCheck: EventCheckResult | undefined;

async function runCheck(target: vscode.WebviewPanel, index: WorkspaceIndex): Promise<void> {
  if (!session) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  await target.webview.postMessage({ type: 'check:running' });
  try {
    lastCheck = await runEventCheck(index, doc.uri, doc.getText(), labelsOf(doc), session.line);
    await target.webview.postMessage({ type: 'check:result', result: lastCheck });
  } catch (e) {
    await target.webview.postMessage({ type: 'check:result', error: String(e) });
  }
}

async function exportShotList(): Promise<void> {
  if (!lastCheck) {
    return;
  }
  const csv = shotListCsv(lastCheck);
  const count = csv.trim().split('\n').length - 1;
  await vscode.env.clipboard.writeText(csv);
  const pick = await vscode.window.showInformationMessage(`Shot list (${count} missing image${count === 1 ? '' : 's'}) copied to the clipboard.`, 'Save as CSV…');
  if (pick) {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const dest = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder, `${lastCheck.eventLabel}_shotlist.csv`) : undefined,
      filters: { CSV: ['csv'] },
    });
    if (dest) {
      await vscode.workspace.fs.writeFile(dest, Buffer.from(csv, 'utf8'));
    }
  }
}

/** Apply a verified single-statement plan on the (fingerprint-relocated) line. */
async function runLinePlan(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore,
  line: number,
  src: string,
  label: string,
  plan: (text: string, line: number) => { edits: TextEdit[]; text: string } | { error: string }
): Promise<void> {
  if (!session) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  const l = src ? locateLine(doc, line, src) : line;
  if (l === undefined) {
    void vscode.window.showWarningMessage('The statement moved or changed — nothing was written.');
    return;
  }
  const text = doc.getText();
  const r = plan(text, l);
  if ('error' in r) {
    void vscode.window.showWarningMessage(r.error);
    return;
  }
  const error = await applyVerifiedEdits(doc.uri, text, r.edits, label);
  if (error) {
    void vscode.window.showWarningMessage(error);
  }
  await publish(context, index, store);
}

function labelsOf(doc: vscode.TextDocument): LabelDefinition[] {
  return parseLabelsInDocument(doc.uri, doc.getText());
}

const LINE_ACTIONS = new Set([
  'moveStatement',
  'addMenuChoice',
  'removeMenuChoice',
  'plusInsert',
  'editText',
  'deleteStop',
  'changeSpeaker',
  'changeType',
  'editMenuChoice',
  'openMarker',
  'imgApply',
]);

type ScenePlan =
  | { edits: TextEdit[]; newText: string; newLine?: number; notes?: string[] }
  | { error: string };

/** Plan against the current text, write only if verified, then re-map the preview. */
async function runScenePlan(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore,
  label: string,
  plan: (text: string) => ScenePlan
): Promise<void> {
  if (!session) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  const text = doc.getText();
  const result = plan(text);
  if ('error' in result) {
    void vscode.window.showWarningMessage(result.error);
  } else {
    const error = await applyVerifiedEdits(doc.uri, text, result.edits, label);
    if (error) {
      void vscode.window.showWarningMessage(error);
    } else {
      if (result.newLine !== undefined) {
        session.line = result.newLine;
      }
      for (const note of result.notes ?? []) {
        void vscode.window.showInformationMessage(note);
      }
    }
  }
  await publish(context, index, store);
}

function locateLine(doc: vscode.TextDocument, line: number, src: string): number | undefined {
  return locateLineIn(doc.getText().split('\n'), line, src);
}

async function refuseNotDialogue(): Promise<void> {
  void vscode.window.showWarningMessage('The target line is not a dialogue line — nothing was changed.');
}

/**
 * Change the speaker of a dialogue line. If the chosen character isn't loaded in the
 * event yet, a `$ var = Person["key"].get_renpy_char()` load is inserted at the top,
 * beside the other character loads. The dialogue type (say/think/…) is preserved.
 */
async function changeSpeaker(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore,
  line: number,
  personKey: string
): Promise<void> {
  if (!session || !personKey) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  if (line >= doc.lineCount) {
    return;
  }
  const text = doc.getText();
  const labels = labelsOf(doc);
  const lineText = doc.lineAt(line).text;
  if (!isSayLine(lineText)) {
    await refuseNotDialogue();
    return;
  }
  const bounds = chainBounds(lineText);
  if (!bounds) {
    return;
  }
  const current = parseSpeakerChain(lineText.slice(bounds.start, bounds.end));
  const edit = new vscode.WorkspaceEdit();
  let shift = 0;

  if (personKey === 'subtitles') {
    edit.replace(doc.uri, new vscode.Range(line, bounds.start, line, bounds.end), 'subtitles');
  } else {
    const base = index.getPersonIndex();
    const bindings = eventCharacterBindings(text, labels, base, line);
    const already = [...bindings.values()].includes(personKey);
    const variable = guessVariable(personKey, bindings, base);
    edit.replace(
      doc.uri,
      new vscode.Range(line, bounds.start, line, bounds.end),
      buildSpeakerChain(variable, current.type)
    );
    if (!already) {
      const at = findCharacterLoadInsert(text, labels, line);
      const load = `${at.indent}$ ${variable} = Person["${personKey}"]`;
      const anchorEnd = doc.lineAt(at.line).range.end;
      edit.insert(doc.uri, anchorEnd, `${at.blankBefore ? '\n' : ''}\n${load}`);
      if (at.line < line) {
        shift = 1;
      }
    }
  }
  const ok = await applyReversibleEdit(doc.uri, edit, 'Timeline: change speaker');
  if (ok) {
    session.line = line + shift;
    await publish(context, index, store);
  }
}

/** Change the dialogue type (say/think/shout/whisper), keeping the same speaker. */
async function changeType(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore,
  line: number,
  speechType: string
): Promise<void> {
  if (!session) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  if (line >= doc.lineCount) {
    return;
  }
  const lineText = doc.lineAt(line).text;
  if (!isSayLine(lineText)) {
    await refuseNotDialogue();
    return;
  }
  const bounds = chainBounds(lineText);
  if (!bounds) {
    return;
  }
  const current = parseSpeakerChain(lineText.slice(bounds.start, bounds.end));
  const chain = buildSpeakerChain(current.speaker, speechType as SpeechType);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(line, bounds.start, line, bounds.end), chain);
  const ok = await applyReversibleEdit(doc.uri, edit, 'Timeline: change dialogue type');
  if (ok) {
    session.line = line;
    await publish(context, index, store);
  }
}

/** Edit a menu choice's title and (when it targets a label) its EventEffect target. */
async function editMenuChoice(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore,
  menuLine: number,
  choiceIndex: number,
  title: string,
  target: string
): Promise<void> {
  if (!session) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  const text = doc.getText();
  const lineStart = doc.lineAt(Math.min(menuLine, doc.lineCount - 1)).range.start;
  const startOffset = doc.offsetAt(lineStart);
  const nameMatch = /call_custom_menu(?:_with_text)?/.exec(text.slice(startOffset));
  if (!nameMatch) {
    return;
  }
  const call = parseCallAt(text, startOffset + nameMatch.index);
  if (!call) {
    return;
  }
  const elements = call.args.filter((a) => a.call?.name === 'MenuElement');
  const element = elements[choiceIndex];
  if (!element?.call) {
    return;
  }
  const positionals = element.call.args.filter((a) => !a.name);
  const edit = new vscode.WorkspaceEdit();
  if (positionals[1]) {
    edit.replace(doc.uri, positionals[1].range, quoteLiteral(title));
  }
  let effectArg: import('./types').ParsedArg | undefined;
  walkCalls(element.call, (c) => {
    if (!effectArg && c.name === 'EventEffect') {
      effectArg = c.args.find((a) => !a.name);
    }
  });
  if (effectArg && target) {
    edit.replace(doc.uri, effectArg.range, quoteLiteral(target));
  }
  const ok = await applyReversibleEdit(doc.uri, edit, 'Timeline: edit menu choice');
  if (ok) {
    await publish(context, index, store);
  }
}

function quoteLiteral(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

interface InsertSnippet {
  text: string;
  label: string;
  /** Stops this many lines below the anchor land the preview on the new statement. */
  anchorOffset: number;
  /** Optional cursor placement (line offset + column) to land inside a placeholder. */
  cursor?: { line: number; character: number };
}

function insertSnippet(kind: string, indent: string, speaker?: string): InsertSnippet | undefined {
  if (kind === 'dialog') {
    const who = speaker && speaker !== 'subtitles' ? speaker : 'subtitles';
    return {
      text: `${indent}${who} ""`,
      label: 'dialogue',
      anchorOffset: 1,
      cursor: { line: 1, character: indent.length + who.length + 2 },
    };
  }
  if (kind === 'image') {
    return {
      text: `${indent}$ image.show(0)`,
      label: 'image',
      anchorOffset: 1,
      cursor: { line: 1, character: indent.length + `$ image.show(`.length },
    };
  }
  if (kind === 'menu') {
    const body = [
      `${indent}$ call_custom_menu_with_text("", character.subtitles, False,`,
      `${indent}    MenuElement("Option", "Option", EventEffect("")),`,
      `${indent}**kwargs)`,
    ].join('\n');
    return {
      text: body,
      label: 'menu',
      anchorOffset: 1,
      cursor: { line: 1, character: indent.length + `    MenuElement("`.length },
    };
  }
  return undefined;
}

async function openImagePreview(index: WorkspaceIndex, msg: Record<string, unknown>): Promise<void> {
  if (!session) {
    return;
  }
  const ref = msg.image as ImageRef | undefined;
  if (!ref) {
    return;
  }
  await vscode.commands.executeCommand('mtsEventManager.previewImages', session.uri.toString(), {
    kind: ref.kind,
    line: ref.line,
    character: ref.character,
    variableName: ref.variableName,
    patternKey: ref.patternKey,
    steps: ref.steps,
    literalPath: ref.literalPath,
  });
}

interface DollView {
  /** Doll variable — identifies the doll across stops and animation ops. */
  key: string;
  config: PdConfig & { tint: { r: number; g: number; b: number; a: number } };
  body: string;
  head: string;
}

/** Paperdoll background as the engine shows it (blur radius in game pixels). */
interface BgView {
  src?: string;
  src2?: string;
  split: boolean;
  blur: number;
  bw: boolean;
  bw2?: boolean;
  separator?: number;
}

/** One timed change of the animation into a stop (see paperdollScript.PdTimedOp). */
interface AnimOpView {
  at: number;
  duration: number;
  kind: string;
  target?: string;
  config?: DollView['config'];
  body?: string;
  head?: string;
  distance?: number;
  bg?: BgView;
}

interface AnimView {
  ops: AnimOpView[];
  /** Blocking pause time before the stop's text appears. */
  blocking: number;
  /** When every ease has finished. */
  end: number;
}

interface StopView {
  index: number;
  line: number;
  kind: string;
  speaker: string;
  speechType: string;
  names: string[];
  text: string;
  portraits: string[];
  cg?: string;
  /** `show_video`: the Movie that plays over the poster (`cg`). */
  video?: VideoView;
  bg?: string;
  bg2?: string;
  bgSplit: boolean;
  /** Background blur radius in game pixels (True → 10). */
  bgBlur: number;
  bgBw: boolean;
  bgBw2: boolean;
  bgSeparator: number;
  /** Paperdoll/background animation from the previous stop into this one. */
  anim?: AnimView;
  legacyScene: boolean;
  /** The image an image/video stop shows (with its show_image step position). */
  image?: ImageRef;
  /** The spoken text as written (`[topic]` not filled in) — what the text editor edits. */
  rawText: string;
  /** random_say alternatives, with their own speaker and image. */
  alternatives?: { text: string; rawText: string; argIndex?: number; who: string; condition: string; cg?: string }[];
  /** Trimmed source line — fingerprint used to re-locate the line after unsaved edits. */
  src: string;
  dolls: DollView[];
}

// Session resolution caches. Image resolution depends only on patterns/files (the index),
// not on dialogue text, so it survives text edits and is keyed by pattern inputs — a
// subtitle insert never re-walks the filesystem. Paperdoll simulation depends on text,
// so its cache clears whenever the document changes.
let imgCacheVersion = -1;
let analyzeStamp = '';
const imgCache = new Map<string, ResolvedImageInfo | undefined>();
/** Paperdoll scene + timed trace per stop, keyed "previousStopLine|line". */
const analyzeCache = new Map<string, PaperdollAnalysis & { trace: PdTrace }>();

function ensureCaches(indexVersion: number, docStamp: string): void {
  if (indexVersion !== imgCacheVersion) {
    imgCacheVersion = indexVersion;
    imgCache.clear();
    imageRootsCache = undefined;
    patternValueCache.clear();
  }
  if (docStamp !== analyzeStamp) {
    analyzeStamp = docStamp;
    analyzeCache.clear();
  }
}

/**
 * Map the session and send the timeline. `keepPosition`: the view only switched a branch or
 * value — the webview keeps its stop when the path up to it is unchanged.
 */
async function publish(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore,
  keepPosition = false
): Promise<void> {
  if (!session || !panel) {
    return;
  }
  const target = panel;
  const doc = await vscode.workspace.openTextDocument(session.uri);
  ensureCaches(index.version, `${doc.uri.toString()}@${doc.version}`);
  const text = doc.getText();
  const srcLines = text.split('\n');
  const labels = labelsOf(doc);
  const portraitFiles = collectPortraitFiles(context, store);
  const persons = withExtraPersonKeys(index.getPersonIndex(), portraitFiles.keys());
  const timeline = buildEventTimeline(text, labels, persons, session.line, (line) => {
    const lab = labelAtLine(labels, line);
    return lab ? index.getSelectorValuesForLabel(lab.name) : {};
  }, { selections: session.selections, values: { ...(await levelDefaults(index, labels, session.line)), ...session.values } });
  lastBranches = timeline.branches;
  lastValues = timeline.values;
  lastEventLabel = timeline.eventLabel;
  defEditor?.setLabel(timeline.eventLabel);

  // Paperdoll simulation is the only whole-file parse; skip it entirely for the common
  // CG events that have no paperdoll at all.
  const hasPaperdoll = timeline.markers.some((m) => m.kind === 'paperdoll' || m.kind === 'background');
  const catalog = hasPaperdoll ? await loadPaperdollCatalog() : undefined;
  const dollView = (doll: DollRuntime): DollView => {
    const layers = catalog ? resolveLayers(catalog, doll.personKey, doll.values, doll.altKeys) : { body: undefined, head: undefined };
    return {
      key: doll.variable,
      config: { ...doll.config, tint: colorChannels(doll.config.color) },
      body: uriOfPath(layers.body),
      head: uriOfPath(layers.head),
    };
  };
  const bgCache = new Map<string, BgView>();
  const bgView = async (ref: BackgroundRef, atLine: number): Promise<BgView> => {
    const key = JSON.stringify(ref);
    const hit = bgCache.get(key);
    if (hit) {
      return hit;
    }
    const one = async (r: BackgroundRef | undefined): Promise<string | undefined> => {
      if (!r || r.kind === 'none') {
        return undefined;
      }
      const img: ImageRef = r.kind === 'path'
        ? { kind: 'set_background_path', line: 0, character: 0, steps: [], literalPath: r.path }
        : { kind: 'set_background', line: atLine, character: 0, steps: [r.step ?? 0], patternKey: r.patternKey, variableName: r.variable };
      return resolveImageRef(index, doc, labels, img, timeline.eventLabel, timeline.values);
    };
    const view: BgView = ref.kind === 'split'
      ? { src: await one(ref.left), src2: await one(ref.right), split: true, blur: ref.blurAmount ?? (ref.blur ? 10 : 0), bw: !!ref.left?.bw, bw2: !!ref.right?.bw, separator: ref.separator ?? 8 }
      : { src: await one(ref), split: false, blur: ref.blurAmount ?? (ref.blur ? 10 : 0), bw: !!ref.bw };
    bgCache.set(key, view);
    return view;
  };

  // Parse the paperdoll statements once per publish, then simulate each stop — its scene
  // and the timed animation since the previous stop (display actions, pauses, eases).
  let trace: ReturnType<typeof createPaperdollTracer> | undefined;
  const stops: StopView[] = [];
  let prevLine: number | undefined;
  for (const stop of timeline.stops) {
    const dolls: DollView[] = [];
    let anim: AnimView | undefined;
    let pdBg: BgView | undefined;
    if (hasPaperdoll && catalog) {
      const cacheKey = `${prevLine ?? ''}|${stop.line}`;
      let analysis = analyzeCache.get(cacheKey);
      if (!analysis) {
        trace ??= createPaperdollTracer(text, labels, persons);
        analysis = trace(prevLine, stop.line);
        analyzeCache.set(cacheKey, analysis);
      }
      for (const doll of analysis.scene.dolls) {
        if (!doll.hidden) {
          dolls.push(dollView(doll));
        }
      }
      if (analysis.scene.background.kind !== 'none') {
        pdBg = await bgView(analysis.scene.background, stop.line);
      }
      if (analysis.trace.ops.length) {
        const ops: AnimOpView[] = [];
        for (const op of analysis.trace.ops) {
          const v: AnimOpView = { at: op.at, duration: op.duration, kind: op.kind, target: op.target };
          if (op.doll) {
            const dv = dollView(op.doll);
            v.config = dv.config;
            if (op.kind === 'show' || op.kind === 'image') {
              v.body = dv.body;
              v.head = dv.head;
            }
          }
          if (op.kind === 'shake') {
            v.distance = op.distance;
          }
          if (op.kind === 'bg' && op.background) {
            v.bg = op.background.kind === 'none' ? { split: false, blur: 0, bw: false } : await bgView(op.background, stop.line);
          }
          ops.push(v);
        }
        const end = Math.max(analysis.trace.blocking, ...ops.map((o) => o.at + o.duration));
        anim = { ops, blocking: analysis.trace.blocking, end };
      }
    }
    prevLine = stop.line;
    let cg: string | undefined;
    let video: VideoView | undefined;
    if (stop.image?.kind === 'show_video') {
      const r = await resolveVideo(index, doc, labels, stop.image, timeline.eventLabel, timeline.values);
      cg = r.poster;
      video = r.video;
    } else if (stop.image && !stop.image.legacy) {
      cg = await resolveImageRef(index, doc, labels, stop.image, timeline.eventLabel, timeline.values);
    }
    if (pdBg) {
      // image.show clears the paperdoll scene, so a paperdoll background at this stop was
      // set after the last scene image — it is what the stop shows (blurred, split, bw).
      cg = undefined;
      video = undefined;
    }
    const bg = pdBg ? pdBg.src : stop.background ? await resolveImageRef(index, doc, labels, stop.background, timeline.eventLabel, timeline.values) : undefined;
    const alternatives = stop.alternatives
      ? await Promise.all(
          stop.alternatives.map(async (a) => ({
            text: interpolate(a.text, timeline.values),
            rawText: a.text,
            argIndex: a.argIndex,
            who: a.speaker ? normalizeSpeakerToken(a.speaker) : '',
            condition: a.condition ?? '',
            cg: a.image ? await resolveImageRef(index, doc, labels, a.image, timeline.eventLabel, timeline.values) : undefined,
          }))
        )
      : undefined;
    const names = stop.personKeys.map((k) => personDisplayName(k, persons));
    const portraits = stop.personKeys
      .map((k) => portraitFiles.get(k))
      .filter((p): p is string => !!p)
      .map((p) => uriOfPath(p));
    stops.push({
      index: stop.index,
      line: stop.line,
      kind: stop.kind,
      speaker: stop.speaker ?? '',
      speechType: stop.speechType ?? 'say',
      text: interpolate(stop.text, timeline.values),
      rawText: stop.text,
      alternatives,
      names,
      portraits,
      cg,
      video,
      bg,
      bg2: pdBg?.src2,
      bgSplit: !!pdBg?.split,
      bgBlur: pdBg?.blur ?? 0,
      bgBw: !!pdBg?.bw,
      bgBw2: !!pdBg?.bw2,
      bgSeparator: pdBg?.separator ?? 8,
      anim,
      legacyScene: !!(stop.image && stop.image.legacy),
      // Image/video stops open the image module for exactly this image (series step).
      image: stop.kind === 'image' || stop.kind === 'video' ? stop.image : undefined,
      src: (srcLines[stop.line] ?? '').trim(),
      dolls,
    });
  }

  const markers = timeline.markers.map((m) => markerView(m, srcLines));
  const current = pendingFocusStop ?? stopIndexForLine(timeline, session.line);
  pendingFocusStop = undefined;
  const editLineNow = pendingEditLine;
  pendingEditLine = undefined;
  const base = index.getPersonIndex();
  const characters = [...base.byKey.keys()]
    .map((k) => ({ key: k, label: personDisplayName(k, base) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  await target.webview.postMessage({
    type: 'timeline',
    eventLabel: timeline.eventLabel,
    stops,
    markers,
    branches: timeline.branches,
    characters,
    values: timeline.values,
    explicitValues: session.values,
    valueOptions: valueOptionsFor(index, timeline.eventLabel, timeline.branches, timeline.values, await patternValuesFor(index, timeline.eventLabel)),
    current: Math.max(0, current),
    keep: keepPosition,
    editLine: editLineNow,
    session: { uri: session.uri.toString(), line: session.line, selections: session.selections, values: session.values },
    missing: stops.length === 0,
  });
  if (pendingOpenModule) {
    await target.webview.postMessage({ type: 'openModule', module: pendingOpenModule });
    pendingOpenModule = undefined;
  }
}

function markerView(m: TimelineMarker, srcLines: string[]): Record<string, unknown> {
  return {
    kind: m.kind,
    line: m.line,
    character: m.character,
    afterStop: m.afterStop,
    label: m.label,
    image: m.image,
    src: (srcLines[m.line] ?? '').trim(),
    choices: m.choices,
    stats: m.stats,
    endType: m.endType,
  };
}

async function resolveImageRef(
  index: WorkspaceIndex,
  doc: vscode.TextDocument,
  labels: ReturnType<WorkspaceIndex['getLabelsForUri']>,
  ref: ImageRef,
  eventLabel: string,
  values: Record<string, string> = {}
): Promise<string | undefined> {
  const info = await resolveImageInfo(index, doc, labels, ref, eventLabel, values);
  return info ? uriOfPath(info.fsPath) : undefined;
}

async function resolveImageInfo(
  index: WorkspaceIndex,
  doc: vscode.TextDocument,
  labels: ReturnType<WorkspaceIndex['getLabelsForUri']>,
  ref: ImageRef,
  eventLabel: string,
  values: Record<string, string> = {}
): Promise<ResolvedImageInfo | undefined> {
  // Placeholder values: the if/elif branches around the call, overridden by the values in
  // effect for the previewed path (so `<topic>` follows the chosen branch everywhere).
  const constraints = paramConstraintsForLine(doc.getText(), labels, ref.line);
  for (const [k, v] of Object.entries(values)) {
    constraints[k] = [v];
  }
  const constraintKey = Object.keys(constraints)
    .sort()
    .map((k) => `${k}=${constraints[k].join('/')}`)
    .join(';');
  // Line-independent key (inserts/undos keep hitting the cache), but it must include the
  // placeholder values — the same step shows a different image for another topic.
  const key = `${eventLabel}|${ref.kind}|${ref.patternKey ?? ''}|${ref.steps.join(',')}|${ref.literalPath ?? ''}|${constraintKey}`;
  if (imgCache.has(key)) {
    return imgCache.get(key);
  }
  const site: ImageCallSite = {
    kind: ref.kind,
    range: new vscode.Range(ref.line, ref.character, ref.line, ref.character + 1),
    variableName: ref.variableName,
    patternKey: ref.patternKey,
    steps: ref.steps,
    literalPath: ref.literalPath,
    paramConstraints: constraints,
  };
  let info: ResolvedImageInfo | undefined;
  try {
    info = (await resolveSiteImages(index, doc, site, labels, { maxResults: 1 }))[0];
  } catch {
    info = undefined;
  }
  imgCache.set(key, info);
  return info;
}

interface VideoView {
  /** Webview URI of the video file ('' when it does not exist). */
  src: string;
  /** Displayable name the engine shows (`anim_…`). */
  name: string;
  loop: boolean;
  /** An `image NAME = Movie(...)` declaration exists (in this file or anywhere indexed). */
  defined: boolean;
  /** Game-relative path of the video that plays. */
  play: string;
  /** Game-relative start image (pattern file) — the base for a new Movie line. */
  imageRel: string;
  /** Where the definition lives, when it is in another file. */
  defFile?: string;
}

/** Movie lines of the session document (live, unsaved edits included), per doc version. */
let movieDocStamp = '';
let movieDocDefs: MovieDef[] = [];
let imageRootsCache: string[] | undefined;

function movieDefsOf(doc: vscode.TextDocument): MovieDef[] {
  const stamp = `${doc.uri.toString()}@${doc.version}`;
  if (stamp !== movieDocStamp) {
    movieDocStamp = stamp;
    movieDocDefs = scanMovieDefs(doc.getText());
  }
  return movieDocDefs;
}

/**
 * What `image.show_video(step)` plays: the pattern file for the step → `anim_<name>` →
 * its Movie declaration (this file first, then the index) → the `play` file.
 */
async function resolveVideo(
  index: WorkspaceIndex,
  doc: vscode.TextDocument,
  labels: ReturnType<WorkspaceIndex['getLabelsForUri']>,
  ref: ImageRef,
  eventLabel: string,
  values: Record<string, string>
): Promise<{ poster?: string; video?: VideoView }> {
  const info = await resolveImageInfo(index, doc, labels, { ...ref, kind: 'show' }, eventLabel, values);
  if (!info) {
    return {};
  }
  const span = topLevelLabelSpan(labels, ref.line);
  const prefix = videoPrefixFor(doc.getText().split('\n'), ref.variableName, span.startLine, ref.line);
  return { poster: uriOfPath(info.fsPath), video: await videoViewFor(index, doc, info.relativePath, prefix) };
}

async function videoViewFor(index: WorkspaceIndex, doc: vscode.TextDocument, imageRel: string, prefix: string): Promise<VideoView> {
  const name = movieNameFor(imageRel, prefix);
  const local = movieDefsOf(doc).find((d) => d.name === name);
  // An indexed hit in this very file that the live scan no longer sees was just removed.
  const hit = local ? undefined : index.getMovie(name);
  const indexed = hit && hit.uri.toString() !== doc.uri.toString() ? hit : undefined;
  const def = local ?? indexed?.def;
  const play = def?.play ?? siblingVideoPath(imageRel);
  imageRootsCache ??= await getImageRoots();
  const file = findUnderRoots(play, imageRootsCache);
  return {
    src: file ? uriOfPath(file) : '',
    name,
    loop: def?.loop ?? true,
    defined: !!def,
    play,
    imageRel,
    defFile: indexed && indexed.uri.toString() !== doc.uri.toString() ? vscode.workspace.asRelativePath(indexed.uri) : undefined,
  };
}

/** Fill `[key]` in dialogue with the previewed selector value (display only). */
function interpolate(text: string, values: Record<string, string>): string {
  return text.replace(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g, (m, key: string) => values[key] ?? m);
}

/**
 * Choices for the values bar: every selector key of the event with its known values, plus
 * the values its if/elif branches test (e.g. topic → ah, ahhh, eeek, panties, breasts, oh).
 */
function valueOptionsFor(
  index: WorkspaceIndex,
  eventLabel: string,
  branches: BranchPoint[],
  values: Record<string, string>,
  fileValues: Record<string, string[]> = {}
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (key: string, v: string) => {
    const list = (out[key] ??= []);
    if (!list.includes(v)) {
      list.push(v);
    }
  };
  // Placeholder values that actually have image files (e.g. school_level 1–10).
  for (const [key, vals] of Object.entries(fileValues)) {
    vals.forEach((v) => add(key, v));
  }
  for (const b of branches) {
    for (const binding of b.bindings ?? []) {
      for (const [key, vals] of Object.entries(binding)) {
        // Level ranges from comparisons span the whole domain; offer the levels with images.
        if (isLevelKey(key) && fileValues[key]) {
          continue;
        }
        vals.forEach((v) => add(key, v));
      }
    }
  }
  if (eventLabel) {
    for (const [key, vals] of Object.entries(index.getSelectorValuesForLabel(eventLabel))) {
      vals.forEach((v) => add(key, v));
    }
  }
  for (const [key, v] of Object.entries(values)) {
    add(key, v);
  }
  for (const key of Object.keys(out)) {
    out[key] = sortValues(out[key]);
  }
  return out;
}

function sortValues(vals: string[]): string[] {
  return vals.every((v) => /^-?[0-9]+$/.test(v)) ? [...vals].sort((a, b) => Number(a) - Number(b)) : vals;
}

/** Placeholder → values present in the event's image files (per index version). */
const patternValueCache = new Map<string, Record<string, string[]>>();

async function patternValuesFor(index: WorkspaceIndex, eventLabel: string): Promise<Record<string, string[]>> {
  if (!eventLabel) {
    return {};
  }
  const hit = patternValueCache.get(eventLabel);
  if (hit) {
    return hit;
  }
  const patterns = index.getPatternsForLabel(eventLabel);
  const found: Record<string, Set<string>> = {};
  for (const key of new Set(patterns.map((p) => p.patternKey))) {
    const site: ImageCallSite = { kind: 'show', range: new vscode.Range(0, 0, 0, 1), patternKey: key, steps: [], paramConstraints: {} };
    let infos: ResolvedImageInfo[] = [];
    try {
      infos = await resolveImagesForCall(site, patterns, { maxResults: 5000 });
    } catch {
      infos = [];
    }
    for (const info of infos) {
      for (const [k, v] of Object.entries(info.params)) {
        // `$` is the engine's wildcard file (serves every value), not a value to pick.
        if (k !== 'step' && v !== '' && v !== '$') {
          (found[k] ??= new Set()).add(v);
        }
      }
    }
  }
  const out: Record<string, string[]> = {};
  for (const [k, set] of Object.entries(found)) {
    out[k] = sortValues([...set]);
  }
  patternValueCache.set(eventLabel, out);
  return out;
}

/**
 * One consistent level for the whole event when none is chosen: the highest level that has
 * images. Without it every image picked its own (first found) level — step 0 at level 1,
 * a video at level 10 — and level-gated if/elif branches ignored the images shown.
 */
async function levelDefaults(index: WorkspaceIndex, labels: LabelDefinition[], line: number): Promise<Record<string, string>> {
  const lab = labelAtLine(labels, line);
  const eventLabel = lab ? lab.name.split('.')[0] : '';
  const out: Record<string, string> = {};
  for (const [key, vals] of Object.entries(await patternValuesFor(index, eventLabel))) {
    const nums = vals.filter((v) => /^[0-9]+$/.test(v));
    if (isLevelKey(key) && nums.length) {
      out[key] = nums[nums.length - 1];
    }
  }
  return out;
}

/** Value for a picked branch: one that has images; for levels the highest such. */
function pickBranchValue(key: string, vals: string[], available?: string[]): string {
  const ok = available ? vals.filter((v) => available.includes(v)) : [];
  const list = ok.length ? ok : vals;
  return isLevelKey(key) ? list[list.length - 1] : list[0];
}

function uriOfPath(fsPath: string | undefined): string {
  if (!fsPath || !panel) {
    return '';
  }
  return panel.webview.asWebviewUri(vscode.Uri.file(fsPath)).toString();
}

/** Exported for the verify script, which checks the generated webview script. */
export function renderPreviewHtml(webview: Pick<vscode.Webview, 'cspSource'>): string {
  return html(webview);
}

function html(webview: Pick<vscode.Webview, 'cspSource'>): string {
  const csp = `default-src 'none'; img-src ${webview.cspSource} data:; media-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'unsafe-inline';`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  :root { --gap: 8px; }
  * { box-sizing: border-box; }
  body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 12px; }
  .wrap { display: flex; height: 100vh; min-height: 0; container-type: size; }
  /* Default (narrow/portrait): single column stacked. */
  .layout { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; }
  .stage-col { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; }
  .stage-frame { flex: 1 1 auto; min-height: 120px; container-type: size; display: flex; align-items: center; justify-content: center; padding: 6px; }
  .stage { position: relative; width: min(100%, calc(100cqh * 16 / 9)); aspect-ratio: 16/9; max-height: 100%; overflow: hidden; background: #161616;
    background-image: linear-gradient(45deg,#222 25%,transparent 25%),linear-gradient(-45deg,#222 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#222 75%),linear-gradient(-45deg,transparent 75%,#222 75%);
    background-size: 24px 24px; background-position: 0 0,0 12px,12px -12px,-12px 0; }
  .stage img.layer { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  .stage img.bg { object-fit: cover; }
  .doll { position: absolute; }
  .doll canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
  .bglayer { position: absolute; inset: 0; overflow: hidden; }
  .bgprev { position: relative; width: 100%; aspect-ratio: 16/9; max-height: 36vh; overflow: hidden; background: #161616; margin-bottom: 6px; }
  .bgprev img { position: absolute; top: 0; height: 100%; object-fit: cover; }
  .bgform { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 4px 10px; margin-bottom: 6px; }
  .bgform label { display: flex; flex-direction: column; gap: 1px; font-size: 10px; color: var(--vscode-descriptionForeground); }
  .bgform label.chk { flex-direction: row; align-items: center; gap: 4px; font-size: 11px; color: var(--vscode-foreground); }
  .bgform input, .bgform select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); font-size: 11px; padding: 1px 3px; border-radius: 3px; }
  .bglayer img.bg { position: absolute; top: 0; height: 100%; object-fit: cover; }
  .bgsep { position: absolute; top: 0; bottom: 0; left: 50%; transform: translateX(-50%); background: #fff; }
  .caption.waiting .txt, .caption.waiting .who, .caption.waiting .pic { opacity: .2; transition: opacity .15s; }
  .legacy { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); font-style: italic; }
  .caption { flex: 0 0 auto; display: flex; gap: 8px; align-items: center; padding: 4px 10px; min-height: 2.4em; border-top: 1px solid var(--vscode-panel-border); }
  .caption .pic { width: 34px; height: 34px; border-radius: 4px; object-fit: cover; flex: 0 0 auto; }
  .caption .who { font-weight: 600; white-space: nowrap; }
  .caption .txt { color: var(--vscode-foreground); overflow: hidden; text-overflow: ellipsis; }
  .caption .txt.placeholder { color: var(--vscode-descriptionForeground); font-style: italic; cursor: pointer; border-bottom: 1px dashed var(--vscode-descriptionForeground); }
  .values { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; padding: 4px 10px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 11px; }
  .values label { display: flex; gap: 4px; align-items: center; color: var(--vscode-descriptionForeground); }
  .values select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); font-size: 11px; max-width: 160px; }
  .values select.set { border-color: var(--vscode-focusBorder); }
  .caption .tag { font-size: 10px; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 0 5px; flex: 0 0 auto; }
  .caption .altnav { display: flex; gap: 2px; align-items: center; flex: 0 0 auto; }
  .caption .altnav button { padding: 0 5px; }
  .nav { position: sticky; top: 0; z-index: 3; display: flex; gap: 6px; align-items: center; padding: 6px 10px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
  .nav .title { font-weight: 600; margin-right: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 4px 9px; cursor: pointer; border-radius: 3px; }
  button.alt { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:disabled { opacity: .4; cursor: default; }
  .timeline { flex: 0 0 auto; overflow-x: auto; overflow-y: hidden; white-space: nowrap; padding: 8px 10px; border-top: 1px solid var(--vscode-panel-border); }
  .strip { display: inline-flex; gap: 0; align-items: stretch; }
  .strip > .card { align-self: flex-end; }
  .gap { position: relative; flex: 0 0 auto; }
  .gap .plus { position: absolute; bottom: 0; left: 50%; transform: translateX(-50%); width: 18px; height: 18px; padding: 0; line-height: 16px; font-size: 11px; border-radius: 9px; opacity: .35; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); z-index: 1; }
  .gap:hover .plus { opacity: 1; }
  .pin { position: absolute; bottom: 20px; width: 2px; background: var(--vscode-descriptionForeground); opacity: .9; }
  .pin.split { background: var(--vscode-focusBorder); width: 3px; }
  .pin.k-menu { background: var(--vscode-button-background); }
  .phead { position: absolute; top: 0; left: -11px; height: 22px; min-width: 22px; box-sizing: border-box; display: flex; align-items: center; justify-content: center; gap: 4px;
    border: 2px solid var(--vscode-descriptionForeground); border-radius: 11px; background: var(--vscode-editor-background); cursor: pointer; white-space: nowrap; font-size: 11px; overflow: hidden; z-index: 2; }
  .pin.split .phead { border-color: var(--vscode-focusBorder); }
  .pin.k-menu .phead { border-color: var(--vscode-button-background); }
  .phead .pico { font-size: 11px; line-height: 1; width: 16px; text-align: center; }
  .phead .ptxt, .phead .pmv { display: none; }
  .phead:hover { justify-content: flex-start; padding: 0 6px 0 2px; z-index: 20; box-shadow: 0 2px 8px rgba(0,0,0,.35); }
  .phead:hover .ptxt { display: inline; color: var(--vscode-foreground); }
  .phead:hover .pmv { display: inline-flex; gap: 2px; }
  .pmv button { padding: 0 4px; font-size: 10px; line-height: 14px; }
  .bb-row.flash { outline: 2px solid var(--vscode-focusBorder); border-radius: 3px; }
  .card { display: inline-flex; flex-direction: column; gap: 3px; min-width: 128px; max-width: 200px; padding: 6px 8px; border: 1px solid var(--vscode-panel-border); border-radius: 5px; background: var(--vscode-editorWidget-background); cursor: pointer; vertical-align: top; white-space: normal; }
  .card.active { outline: 2px solid var(--vscode-focusBorder); }
  .card .head { display: flex; gap: 5px; align-items: center; }
  .card .pic { width: 22px; height: 22px; border-radius: 3px; object-fit: cover; }
  .card .kind { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); }
  .card .who { font-weight: 600; font-size: 11px; }
  .card .txt { font-size: 11px; color: var(--vscode-descriptionForeground); max-height: 3.2em; overflow: hidden; }
  .marker { display: inline-flex; flex-direction: column; justify-content: center; gap: 4px; align-self: center; }
  .chip { font-size: 10px; padding: 2px 6px; border-radius: 10px; border: 1px dashed var(--vscode-panel-border); color: var(--vscode-descriptionForeground); background: transparent; cursor: pointer; white-space: nowrap; }
  .chip.menu { border-style: solid; }
  /* Move arrows float over the card's top-right corner: fading in on hover never changes
     the card's size, so nothing around it reflows. */
  .card { position: relative; }
  .card .mv { position: absolute; top: 3px; right: 3px; display: flex; gap: 2px; opacity: 0; pointer-events: none; transition: opacity .12s; z-index: 3; }
  .card:hover .mv { opacity: 1; pointer-events: auto; }
  .mv button { padding: 0 5px; font-size: 10px; line-height: 16px; box-shadow: 0 1px 4px rgba(0,0,0,.35); }
  .editor { flex: 0 0 auto; max-height: 42%; overflow: auto; padding: 8px 10px; border-top: 1px solid var(--vscode-panel-border); }
  .editor:empty { display: none; padding: 0; border: 0; }
  .editor h3 { margin: 0 0 6px; font-size: 12px; }
  .branch-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 4px 0; }
  .branchbar { flex: 0 0 auto; max-height: 30%; overflow: auto; padding: 4px 10px; border-top: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; gap: 3px; }
  .branchbar:empty { display: none; }
  .bb-row { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; min-width: 0; }
  .bb-row .bb-tree { color: var(--vscode-descriptionForeground); font-size: 11px; flex: 0 0 auto; }
  .bb-row .bb-lbl { font-size: 11px; color: var(--vscode-descriptionForeground); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40%; flex: 0 1 auto; }
  .bb-row .bb-lbl:hover { text-decoration: underline; }
  .bb-opt { font-size: 11px; padding: 1px 8px; border-radius: 10px; line-height: 18px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bb-opt.alt { background: transparent; border: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground); }
  .bb-opt:disabled { opacity: .45; cursor: default; }
  .bb-tag { font-size: 9px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); }
  .bb-edit { padding: 0 5px; font-size: 10px; line-height: 16px; }
  .nav { flex-wrap: wrap; }
  .effects { flex: 0 0 auto; padding: 3px 10px; font-size: 11px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); }
  .effects:empty { display: none; }
  .effects .up { color: var(--vscode-testing-iconPassed, #3fb950); }
  .effects .down { color: var(--vscode-errorForeground); }
  .tabs { display: flex; gap: 4px; margin-bottom: 6px; flex-wrap: wrap; align-items: center; }
  .issue { display: flex; gap: 6px; align-items: baseline; padding: 2px 0; border-bottom: 1px solid var(--vscode-panel-border); font-size: 11px; }
  .issue .msg { flex: 1 1 auto; min-width: 0; }
  .issue a, .covrow a { color: var(--vscode-textLink-foreground); cursor: pointer; white-space: nowrap; }
  .issue.error .ico { color: var(--vscode-errorForeground); }
  .issue.warning .ico { color: var(--vscode-editorWarning-foreground); }
  .issue button, .covhead button, .pathrow button { padding: 0 6px; font-size: 10px; line-height: 16px; }
  .okline { color: var(--vscode-testing-iconPassed, #3fb950); margin: 4px 0; }
  .covhead { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 4px; font-size: 11px; }
  .covrow { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 3px 6px; margin: 3px 0; font-size: 11px; }
  .covrow .t { cursor: pointer; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .badge { font-size: 10px; border-radius: 8px; padding: 0 6px; border: 1px solid var(--vscode-panel-border); }
  .badge.missing { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
  .badge.wildcard { color: var(--vscode-editorWarning-foreground); }
  .cells { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 3px; }
  .cell { font-size: 10px; padding: 0 5px; border-radius: 3px; border: 1px solid var(--vscode-panel-border); }
  .cell.exact { background: rgba(63,185,80,.18); }
  .cell.wildcard { background: rgba(210,153,34,.18); }
  .cell.missing { background: rgba(248,81,73,.22); }
  .missinglist { margin: 3px 0 0 0; padding-left: 16px; font-family: var(--vscode-editor-font-family); font-size: 10px; word-break: break-all; }
  .pathrow { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; padding: 2px 0; border-bottom: 1px solid var(--vscode-panel-border); font-size: 11px; }
  .pathrow .d { font-weight: 600; }
  .simform { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 4px 8px; margin-bottom: 8px; }
  .simform label { display: flex; flex-direction: column; gap: 1px; font-size: 10px; color: var(--vscode-descriptionForeground); }
  .simform input, .simform select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); font-size: 11px; padding: 1px 3px; border-radius: 3px; }
  .verdict { font-weight: 600; margin: 4px 0; }
  .cond { font-size: 11px; margin-left: 10px; }
  .cond .d { color: var(--vscode-descriptionForeground); }
  .pool { margin-top: 8px; }
  .pool h4 { margin: 2px 0; font-size: 11px; }
  .pool .sum { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 3px; }
  .prow { display: flex; gap: 6px; font-size: 11px; align-items: baseline; }
  .prow.self { font-weight: 600; }
  .prow a { cursor: pointer; color: var(--vscode-textLink-foreground); }
  .prow .why { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1 1 auto; }
  .empty { padding: 20px; color: var(--vscode-descriptionForeground); }
  /* Wide (landscape): two columns — stage+timeline left, editor right. */
  @container (min-aspect-ratio: 4/3) and (min-width: 720px) {
    .layout { flex-direction: row; }
    .stage-col { flex: 1 1 60%; border-right: 1px solid var(--vscode-panel-border); }
    .side { flex: 1 1 40%; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
    .editor { max-height: none; flex: 1 1 auto; }
  }
  @container (max-aspect-ratio: 4/3) {
    .side { display: contents; }
  }
  .pdhost { flex: 1 1 auto; min-height: 0; overflow: auto; border-top: 1px solid var(--vscode-panel-border); padding: 6px 10px; }
  .pdhost-head { display: flex; align-items: center; justify-content: space-between; font-weight: 600; margin-bottom: 4px; }
  .caption select, .caption input, .editor select, .editor input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 2px 4px; border-radius: 3px; font-size: 11px; }
  .caption select, .caption .type-sel { flex: 0 0 auto; }
  .caption select { max-width: 45%; }
  .img-frame { display: flex; justify-content: center; background: #161616; max-height: 40vh; overflow: hidden; margin-bottom: 6px; }
  .img-frame img, .img-frame video { max-width: 100%; max-height: 40vh; object-fit: contain; }
  .stage video.layer { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; cursor: pointer; }
  .vbadge { position: absolute; left: 6px; top: 6px; z-index: 2; font-size: 10px; padding: 1px 7px; border-radius: 8px; background: rgba(0,0,0,.62); color: #fff; max-width: 90%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vbadge.warn { background: rgba(170,40,40,.88); }
  .movie { display: flex; flex-direction: column; gap: 4px; margin: 4px 0 6px; font-size: 11px; }
  .movie:empty { display: none; }
  .movie code { font-family: var(--vscode-editor-font-family); }
  .movie .ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  .movie .bad { color: var(--vscode-errorForeground); }
  .movie .path { color: var(--vscode-descriptionForeground); word-break: break-all; }
  .img-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; margin-bottom: 6px; }
  .img-fields .row { display: flex; flex-direction: column; gap: 2px; }
  ${PaperdollEditor.styles()}
  ${EventDefEditor.styles()}
</style>
</head>
<body>
<div class="wrap">
  <div class="layout">
    <div class="stage-col">
      <div class="nav" id="nav">
        <span class="title" id="title">Event</span>
        <button class="alt" id="first" title="First">⏮</button>
        <button class="alt" id="prev" title="Previous">◀</button>
        <span id="counter">0 / 0</span>
        <button class="alt" id="next" title="Next">▶</button>
        <button class="alt" id="last" title="Last">⏭</button>
        <button class="alt" id="reveal" title="Reveal in editor">↪ Code</button>
        <button class="alt" id="defbtn" title="Edit the Event(...) definition: conditions, selectors, patterns, options">📋 Definition</button>
        <button class="alt" id="newevent" title="Create a new event (definition + scene label)">🆕</button>
        <button class="alt" id="optimize" title="Optimize event: paperdoll displays + merge consecutive image.show into show_image">✨ Optimize</button>
        <button class="alt" id="checkbtn" title="Check the whole event: images per path and value, Movie declarations, menu targets, endings, speakers — plus the shot list">🩺 Check</button>
        <button class="alt" id="simbtn" title="When does this event fire? Simulate time, levels and stats against its conditions and its pool">🎯 Trigger</button>
        <button class="alt" id="overviewbtn" title="Overview of all events">🗂</button>
        <button class="alt" id="undo" title="Undo last timeline change">↩ Undo</button>
      </div>
      <div class="values" id="values" style="display:none"></div>
      <div class="stage-frame"><div id="stage" class="stage"></div></div>
      <div class="caption" id="caption"></div>
    </div>
    <div class="side">
      <div class="timeline" id="timeline"></div>
      <div class="branchbar" id="branchbar"></div>
      <div class="effects" id="effects"></div>
      <div class="editor" id="editor"></div>
      <div class="pdhost" id="pdhost" style="display:none">
        <div class="pdhost-head"><span>Paperdoll</span><button class="alt" id="pdclose" title="Close">✕</button></div>
        ${PaperdollEditor.controlsHtml()}
      </div>
      <div class="pdhost" id="defhost" style="display:none">
        <div class="pdhost-head"><span>Definition</span><button class="alt" id="defclose" title="Close">✕</button></div>
        ${EventDefEditor.html()}
      </div>
      <div class="pdhost" id="checkhost" style="display:none">
        <div class="pdhost-head"><span>Event check</span><button class="alt" id="checkclose" title="Close">✕</button></div>
        <div id="checkbody"></div>
      </div>
      <div class="pdhost" id="simhost" style="display:none">
        <div class="pdhost-head"><span>When does it fire?</span><button class="alt" id="simclose" title="Close">✕</button></div>
        <div class="simform" id="simform"></div>
        <div id="simresult"></div>
      </div>
      <div class="pdhost" id="bghost" style="display:none">
        <div class="pdhost-head"><span>Paperdoll background</span><button class="alt" id="bgclose" title="Close">✕</button></div>
        <div class="bgprev" id="bgprev"></div>
        <div class="bgform" id="bgform"></div>
        <div class="branch-row"><button id="bgapply">Apply</button><span class="muted" id="bgnote"></span></div>
      </div>
      <div class="pdhost" id="imghost" style="display:none">
        <div class="pdhost-head"><span>Image</span><button class="alt" id="imgclose" title="Close">✕</button></div>
        <div class="img-frame"><img id="imgpreview" /><video id="imgvideo" muted autoplay playsinline style="display:none"></video></div>
        <div class="img-fields">
          <label class="row">Pattern<select id="imgkey"></select></label>
          <label class="row" id="imgsteprow">Steps<input id="imgsteps" type="text" placeholder="0  or  0, 1, 2" /></label>
          <label class="row" id="imgvideorow"><span><input id="imgisvideo" type="checkbox" /> 🎬 Video (show_video)</span></label>
          <label class="row" id="imgpauserow"><span><input id="imgpause" type="checkbox" /> <span id="imgpausetxt">Pause after last</span></span></label>
        </div>
        <div class="movie" id="imgmovie"></div>
        <div class="t" id="imgscope"></div>
        <pre id="imgcall"></pre>
        <p class="note" id="imgmissing"></p>
        <div class="branch-row"><button id="imgapply">Apply</button><button id="imgremove" class="alt" title="Delete this image statement from the script (undoable)">🗑 Remove</button><button id="imgremovestep" class="alt" style="display:none" title="Remove this step from the show_image call">Remove this step</button></div>
      </div>
    </div>
  </div>
</div>
<script>
const vscode = acquireVsCodeApi();
const imgCache = new Map();
let state = null;
let current = 0;
let openMenuLine = null;
/** Stats / end_event editor open in #editor: { kind, line }. */
let openStmtEditor = null;
const STAT_NAMES = ['corruption', 'inhibition', 'happiness', 'education', 'charm', 'reputation', 'morale'];
const MODIFIERS = ['TINY', 'SMALL', 'MEDIUM', 'LARGE', 'GIANT', 'DEC_TINY', 'DEC_SMALL', 'DEC_MEDIUM', 'DEC_LARGE', 'DEC_GIANT'];
const END_TYPES = [['new_daytime', 'next daytime (default)'], ['new_day', 'next day'], ['map_entry', 'back to the map entry'], ['map_overview', 'map overview'], ['none', 'nothing']];
function modText(v) { return /^DEC_/.test(v) ? '−' + v.slice(4) : /^[A-Z]+$/.test(v) ? '+' + v : v; }
let checkState = null;
let checkTab = 'issues';
const covOpen = {};
let imgState = null;
let altIndex = 0;

/** The stop as shown: for random_say, with the current alternative's image. */
function withAlt(stop) {
  if (!stop || !stop.alternatives || !stop.alternatives.length) return stop;
  const a = stop.alternatives[altIndex % stop.alternatives.length];
  return a.cg ? Object.assign({}, stop, { cg: a.cg }) : stop;
}

function renderValues(msg) {
  const bar = document.getElementById('values');
  bar.innerHTML = '';
  const opts = msg.valueOptions || {};
  const keys = Object.keys(opts).sort();
  bar.style.display = keys.length ? '' : 'none';
  for (const k of keys) {
    const lab = document.createElement('label'); lab.textContent = k;
    const sel = document.createElement('select');
    const eff = (msg.values || {})[k];
    const auto = document.createElement('option'); auto.value = ''; auto.textContent = eff ? '(auto: ' + eff + ')' : '(any)'; sel.appendChild(auto);
    for (const v of opts[k]) { const o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); }
    const chosen = (msg.explicitValues || {})[k] || '';
    sel.value = chosen; if (chosen) sel.className = 'set';
    sel.title = 'Preview with this ' + k + ' — picks the matching branches and images';
    sel.addEventListener('change', () => vscode.postMessage({ type:'setValue', key: k, value: sel.value }));
    lab.appendChild(sel); bar.appendChild(lab);
  }
}

function renderAltCaption(stop) {
  const cap = document.getElementById('caption');
  cap.innerHTML = '';
  const alts = stop.alternatives;
  const a = alts[altIndex % alts.length];
  if (!a.who || a.who === stop.speaker) {
    for (const p of stop.portraits || []) { const im = document.createElement('img'); im.className='pic'; im.src=p; cap.appendChild(im); }
  }
  const who = document.createElement('span'); who.className='who';
  who.textContent = a.who && a.who !== stop.speaker ? a.who : (stop.names && stop.names.length ? stop.names.join(' · ') : (stop.speaker || 'Narration'));
  cap.appendChild(who);
  const nav = document.createElement('span'); nav.className = 'altnav';
  const step = (d) => { finishAnim(); altIndex = (altIndex + d + alts.length) % alts.length; renderStage(withAlt(stop)); renderAltCaption(stop); };
  const prev = document.createElement('button'); prev.className = 'alt'; prev.textContent = '◀'; prev.title = 'Previous alternative'; prev.addEventListener('click', () => step(-1));
  const count = document.createElement('span'); count.className = 'tag'; count.textContent = 'random ' + ((altIndex % alts.length) + 1) + '/' + alts.length; count.title = 'random_say picks one of these lines';
  const next = document.createElement('button'); next.className = 'alt'; next.textContent = '▶'; next.title = 'Next alternative'; next.addEventListener('click', () => step(1));
  nav.appendChild(prev); nav.appendChild(count); nav.appendChild(next); cap.appendChild(nav);
  if (a.condition) { const c = document.createElement('span'); c.className = 'tag'; c.textContent = 'if ' + a.condition; cap.appendChild(c); }
  const txt = document.createElement('span'); txt.className='txt'; txt.textContent = a.text; cap.appendChild(txt);
  if (a.argIndex != null) {
    // Edit this alternative's text in random_say(…) (raw text, [placeholders] kept).
    const edit = () => beginAltEdit(stop, a, txt);
    txt.title = 'Double-click to edit this alternative'; txt.style.cursor = 'text';
    txt.addEventListener('dblclick', edit);
    const pen = document.createElement('button'); pen.className = 'alt'; pen.textContent = '✏'; pen.title = 'Edit this alternative (Enter saves, Esc cancels)';
    pen.style.flex = '0 0 auto'; pen.style.marginLeft = 'auto';
    pen.addEventListener('click', edit);
    cap.appendChild(pen);
  }
}

function beginAltEdit(stop, a, span) {
  const raw = a.rawText != null ? a.rawText : a.text;
  const input = document.createElement('input'); input.type = 'text'; input.value = raw; input.placeholder = 'Alternative text…';
  input.style.flex = '1'; input.style.minWidth = '0';
  input.style.background = 'var(--vscode-input-background)'; input.style.color = 'var(--vscode-input-foreground)';
  input.style.border = '1px solid var(--vscode-focusBorder)';
  span.replaceWith(input); input.focus(); input.select();
  let done = false;
  const commit = () => { if (done) return; done = true; vscode.postMessage({ type: 'editAltText', line: stop.line, src: stop.src, argIndex: a.argIndex, text: input.value }); };
  const cancel = () => { if (done) return; done = true; renderAltCaption(stop); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { e.preventDefault(); cancel(); } });
  input.addEventListener('blur', () => { if (input.value !== raw) commit(); else cancel(); });
}

// View state survives the page reload VS Code does when the panel moves to another window.
let currentModule = null;
let restoreView = (typeof vscode.getState === 'function' && vscode.getState()) || null;
function saveView() {
  if (typeof vscode.setState !== 'function' || !state) return;
  vscode.setState({ session: state.session, eventLabel: state.eventLabel, current, module: currentModule === 'check' || currentModule === 'sim' || currentModule === 'def' ? currentModule : null });
}

function showModule(mod) {
  currentModule = mod;
  saveView();
  document.getElementById('checkhost').style.display = mod === 'check' ? '' : 'none';
  document.getElementById('simhost').style.display = mod === 'sim' ? '' : 'none';
  document.getElementById('pdhost').style.display = mod === 'pd' ? '' : 'none';
  document.getElementById('imghost').style.display = mod === 'img' ? '' : 'none';
  document.getElementById('bghost').style.display = mod === 'bg' ? '' : 'none';
  document.getElementById('defhost').style.display = mod === 'def' ? '' : 'none';
  document.getElementById('editor').style.display = mod ? 'none' : '';
}

function img(url) {
  if (!url) return Promise.resolve(null);
  const hit = imgCache.get(url);
  if (hit) return hit;
  const p = new Promise((res) => { const el = new Image(); el.onload = () => res(el); el.onerror = () => res(null); el.src = url; });
  imgCache.set(url, p);
  return p;
}

function place(config) {
  const w = 600 * config.zoom, h = 1080 * config.zoom;
  const anchor = Math.min(1, Math.max(0, config.alignX));
  const left = config.alignX * 1920 - anchor * w;
  return { left: (left / 1920) * 100, top: config.alignY * 100, width: (w / 1920) * 100, height: (h / 1080) * 100 };
}

// ── Stage: a live scene (background, scene image, paperdolls) ─────────────
// Paperdolls and the paperdoll background are rendered like the engine: position/zoom
// from the config, flip as xzoom, blur in game pixels (scaled to the stage), black-and-white
// as saturation, colour as a tint on the visible pixels. The same scene object is animated
// between stops by the player below.
function tintOf(t) { return t ? { r: t.r, g: t.g, b: t.b, a: t.a } : { r: 0, g: 0, b: 0, a: 0 }; }
function cfgOf(c) { return { alignX: c.alignX, alignY: c.alignY, zoom: c.zoom, flip: c.flip == null ? 1 : c.flip, blur: c.blur || 0, sat: c.bw ? 0 : 1, tint: tintOf(c.tint) }; }
function emptyBg() { return { src: '', src2: '', split: false, blur: 0, bw: false, bw2: false, sep: 8 }; }
function sceneOf(stop) {
  const s = { bg: { src: stop.bg || '', src2: stop.bg2 || '', split: !!stop.bgSplit, blur: Number(stop.bgBlur) || 0, bw: !!stop.bgBw, bw2: !!stop.bgBw2, sep: stop.bgSeparator || 8 }, dolls: [] };
  for (const d of stop.dolls || []) s.dolls.push({ key: d.key, body: d.body, head: d.head, cfg: cfgOf(d.config), sx: 0, sy: 0 });
  return s;
}
let live = null;

function renderStage(stop, scene) {
  const stage = document.getElementById('stage');
  stage.innerHTML = '';
  live = null;
  if (!stop) return;
  if (stop.legacyScene) { const d = document.createElement('div'); d.className='legacy'; d.textContent='Legacy scene — not simulated'; stage.appendChild(d); return; }
  const bgLayer = document.createElement('div'); bgLayer.className = 'bglayer'; stage.appendChild(bgLayer);
  live = { scene: scene || sceneOf(stop), stop, bgLayer, bgEls: [] };
  mountBg(live.scene.bg);
  if (stop.cg) addImg(stage, stop.cg, 'layer', '0', '100%');
  if (stop.video) addVideo(stage, stop.video);
  for (const d of live.scene.dolls) mountDoll(stage, d);
  applyStyles();
}

function mountBg(bg) {
  live.bgLayer.innerHTML = ''; live.bgEls = [];
  if (bg.split) {
    if (bg.src) live.bgEls.push({ el: addImg(live.bgLayer, bg.src, 'bg', '0', '50%'), bw: 'bw' });
    if (bg.src2) live.bgEls.push({ el: addImg(live.bgLayer, bg.src2, 'bg', '50%', '50%'), bw: 'bw2' });
    const sep = document.createElement('div'); sep.className = 'bgsep'; sep.style.width = ((bg.sep || 8) / 1920 * 100) + '%'; live.bgLayer.appendChild(sep);
  } else if (bg.src) {
    live.bgEls.push({ el: addImg(live.bgLayer, bg.src, 'bg', '0', '100%'), bw: 'bw' });
  }
}

function mountDoll(stage, d) {
  const el = document.createElement('div'); el.className = 'doll';
  const canvas = document.createElement('canvas'); el.appendChild(canvas); stage.appendChild(el);
  d.el = el; d.canvas = canvas; d.drawKey = '';
}

function filterOf(blur, gray, k) {
  const parts = [];
  if (blur > 0.05) parts.push('blur(' + (blur * k).toFixed(2) + 'px)');
  if (gray > 0.01) parts.push('grayscale(' + gray.toFixed(2) + ')');
  return parts.length ? parts.join(' ') : 'none';
}

function applyStyles() {
  if (!live) return;
  const stage = document.getElementById('stage');
  const w = (stage.getBoundingClientRect && stage.getBoundingClientRect().width) || 1920;
  const k = w / 1920;
  const bg = live.scene.bg;
  for (const b of live.bgEls) b.el.style.filter = filterOf(bg.blur, bg[b.bw] ? 1 : 0, k);
  for (const d of live.scene.dolls) {
    if (!d.el) continue;
    const box = place(d.cfg);
    d.el.style.left = box.left + '%'; d.el.style.top = box.top + '%'; d.el.style.width = box.width + '%'; d.el.style.height = box.height + '%';
    d.el.style.transform = (d.sx || d.sy) ? 'translate(' + (d.sx * k).toFixed(1) + 'px,' + (d.sy * k).toFixed(1) + 'px)' : '';
    d.el.style.filter = filterOf(d.cfg.blur, 1 - d.cfg.sat, k);
    d.canvas.style.transform = 'scaleX(' + d.cfg.flip.toFixed(3) + ')';
    const tn = d.cfg.tint;
    const key = d.body + '|' + d.head + '|' + Math.round(tn.r) + ',' + Math.round(tn.g) + ',' + Math.round(tn.b) + ',' + tn.a.toFixed(3);
    if (d.drawKey !== key) { d.drawKey = key; void drawLayers(d, key); }
  }
}

async function drawLayers(d, key) {
  const body = await img(d.body), head = await img(d.head);
  if (d.drawKey !== key || !d.canvas) return;
  const canvas = d.canvas;
  const srcW = Math.max(body?body.naturalWidth:0, head?head.naturalWidth:0) || 1200;
  const srcH = Math.max(body?body.naturalHeight:0, head?head.naturalHeight:0) || 2160;
  const box = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  let scale = 1;
  if (box.width > 2 && box.height > 2) scale = Math.min(1, (box.width*dpr)/srcW, (box.height*dpr)/srcH);
  const w = Math.max(1, Math.round(srcW*scale)), h = Math.max(1, Math.round(srcH*scale));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,w,h); ctx.save();
  if (body) ctx.drawImage(body,0,0,w,h);
  if (head) ctx.drawImage(head,0,0,w,h);
  const tint = d.cfg.tint;
  if (tint && tint.a > 0.004) { ctx.globalCompositeOperation='source-atop'; ctx.fillStyle='rgba('+Math.round(tint.r)+','+Math.round(tint.g)+','+Math.round(tint.b)+','+tint.a+')'; ctx.fillRect(0,0,w,h); }
  ctx.restore();
}

// ── Player: the paperdoll/background animation into a stop ─────────────────
// Ops come from the script in engine order: display() actions run one after another,
// PDAPause blocks (the stop's text waits), every other action eases (Ren'Py ease warper)
// over its duration while the script continues. Clicking on skips to the end.
let anim = null;
const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null;
function clockNow() { return typeof performance !== 'undefined' && performance && performance.now ? performance.now() : Date.now(); }
function easeP(p) { const q = Math.max(0, Math.min(1, p)); return 0.5 - Math.cos(Math.PI * q) / 2; }

function playInto(prevStop, stop) {
  finishAnim();
  if (!raf || !stop.anim || !stop.anim.ops.length || stop.legacyScene) { renderStage(withAlt(stop)); return; }
  renderStage(withAlt(stop), sceneOf(prevStop));
  anim = { stop, ops: stop.anim.ops, i: 0, tweens: [], t0: clockNow(), end: stop.anim.end, blocking: stop.anim.blocking, handle: 0 };
  setWaiting(anim.blocking > 0);
  tickAnim();
}

function finishAnim() {
  if (!anim) return;
  const s = anim.stop;
  if (caf && anim.handle) caf(anim.handle);
  anim = null;
  setWaiting(false);
  renderStage(withAlt(s));
}

function tickAnim() {
  const a = anim;
  if (!a || !live) return;
  const now = (clockNow() - a.t0) / 1000;
  while (a.i < a.ops.length && a.ops[a.i].at <= now + 0.0001) startOp(a, a.ops[a.i++]);
  stepTweens(a, now);
  applyStyles();
  if (now >= a.blocking) setWaiting(false);
  if (a.i >= a.ops.length && now >= a.end) { finishAnim(); return; }
  a.handle = raf(tickAnim);
}

function dollOf(key) { return live.scene.dolls.find((d) => d.key === key); }
function tweenTo(a, target, prop, to, op) {
  if (!(op.duration > 0)) { target[prop] = to; return; }
  a.tweens.push({ target, prop, from: target[prop], to, t0: op.at, dur: op.duration });
}

function startOp(a, op) {
  const sc = live.scene;
  const stage = document.getElementById('stage');
  if (op.kind === 'clear') {
    sc.dolls.forEach((d) => { if (d.el) d.el.remove(); });
    sc.dolls = []; sc.bg = emptyBg(); mountBg(sc.bg);
    return;
  }
  if (op.kind === 'bg') {
    const from = sc.bg.blur || 0;
    sc.bg = Object.assign(emptyBg(), op.bg || {});
    const to = sc.bg.blur;
    sc.bg.blur = op.duration > 0 ? from : to;
    mountBg(sc.bg);
    tweenTo(a, sc.bg, 'blur', to, op);
    return;
  }
  if (op.kind === 'show') {
    if (!dollOf(op.target)) {
      const d = { key: op.target, body: op.body, head: op.head, cfg: cfgOf(op.config), sx: 0, sy: 0 };
      sc.dolls.push(d); mountDoll(stage, d);
    }
    return;
  }
  const d = dollOf(op.target);
  if (!d) return;
  if (op.kind === 'hide') { if (d.el) d.el.remove(); sc.dolls = sc.dolls.filter((x) => x !== d); return; }
  if (op.kind === 'image') { d.body = op.body; d.head = op.head; return; }
  if (op.kind === 'shake') { a.tweens.push({ shake: d, dist: op.distance || 15, t0: op.at, dur: op.duration || 1 }); return; }
  const c = cfgOf(op.config);
  if (op.kind === 'move') { tweenTo(a, d.cfg, 'alignX', c.alignX, op); tweenTo(a, d.cfg, 'alignY', c.alignY, op); tweenTo(a, d.cfg, 'zoom', c.zoom, op); }
  else if (op.kind === 'flip') tweenTo(a, d.cfg, 'flip', c.flip, op);
  else if (op.kind === 'blur') tweenTo(a, d.cfg, 'blur', c.blur, op);
  else if (op.kind === 'bw') tweenTo(a, d.cfg, 'sat', c.sat, op);
  else if (op.kind === 'color') { ['r', 'g', 'b', 'a'].forEach((ch) => tweenTo(a, d.cfg.tint, ch, c.tint[ch], op)); }
}

function stepTweens(a, now) {
  a.tweens = a.tweens.filter((tw) => {
    const p = Math.max(0, Math.min(1, (now - tw.t0) / tw.dur));
    if (tw.shake) {
      const amp = p >= 1 ? 0 : tw.dist * (1 - p);
      tw.shake.sx = (Math.random() * 2 - 1) * amp; tw.shake.sy = (Math.random() * 2 - 1) * amp;
      return p < 1;
    }
    tw.target[tw.prop] = tw.from + (tw.to - tw.from) * easeP(p);
    return p < 1;
  });
}

/** The stop's text appears once the blocking pauses are over (like the engine). */
function setWaiting(on) {
  const cap = document.getElementById('caption');
  if (on) cap.classList.add('waiting'); else cap.classList.remove('waiting');
}

// show_video: the Movie plays over its start image (the poster stays underneath while it
// loads). The element is reused across re-renders of the same video so it keeps playing.
let stageVideo = null;
function addVideo(stage, v) {
  if (v.src) {
    let el = stageVideo;
    if (!el || el._src !== v.src) {
      el = document.createElement('video');
      el._src = v.src; el.src = v.src; el.muted = true; el.autoplay = true; el.playsInline = true;
      el.title = 'Click to pause / play';
      el.addEventListener('click', () => {
        if (el.paused || el.ended) { el._userPaused = false; if (el.ended) el.currentTime = 0; if (el.play) el.play().catch(() => {}); }
        else { el._userPaused = true; el.pause(); }
      });
      stageVideo = el;
    }
    el.loop = !!v.loop;
    el.className = 'layer';
    stage.appendChild(el);
    if (!el._userPaused && !el.ended && el.play) { const p = el.play(); if (p && p.catch) p.catch(() => {}); }
  }
  const badge = document.createElement('div');
  const problem = !v.src ? 'video file missing: ' + v.play : !v.defined ? 'no Movie definition — the game cannot show it' : '';
  badge.className = 'vbadge' + (problem ? ' warn' : '');
  badge.textContent = '🎬 ' + v.name + ' · ' + (v.loop ? 'loop' : 'once') + (problem ? ' · ⚠ ' + problem : '');
  badge.title = problem ? 'Open the image module (🖼 Edit / marker) to add the definition' : 'plays ' + v.play;
  stage.appendChild(badge);
}

function addImg(host, src, cls, left, width) {
  const el = document.createElement('img');
  el.className = 'layer ' + cls; el.src = src; el.style.left = left; el.style.width = width;
  host.appendChild(el);
  return el;
}

function renderCaption(stop) {
  const cap = document.getElementById('caption');
  cap.innerHTML = '';
  if (!stop) return;
  if (stop.alternatives && stop.alternatives.length) { renderAltCaption(stop); return; }
  for (const p of stop.portraits || []) { const im = document.createElement('img'); im.className='pic'; im.src=p; cap.appendChild(im); }
  const who = document.createElement('span'); who.className='who';
  who.textContent = stop.names && stop.names.length ? stop.names.join(' · ') : (stop.speaker || labelForKind(stop.kind));
  if (stop.kind === 'dialog') { who.title = 'Double-click to change speaker'; who.style.cursor = 'pointer'; who.addEventListener('dblclick', () => beginSpeakerEdit(stop, who)); }
  cap.appendChild(who);
  if (stop.kind === 'dialog' && stop.speaker !== 'subtitles') {
    const sel = document.createElement('select'); sel.className = 'type-sel';
    for (const t of ['say','think','shout','whisper']) { const o = document.createElement('option'); o.value = t; o.textContent = t; sel.appendChild(o); }
    sel.value = stop.speechType || 'say'; sel.title = 'Dialogue type';
    sel.addEventListener('change', () => vscode.postMessage({ type:'changeType', line: stop.line, src: stop.src, speechType: sel.value }));
    cap.appendChild(sel);
  }
  const txt = document.createElement('span'); txt.className='txt'; txt.textContent = stop.text || '';
  if (stop.kind === 'dialog') {
    txt.title = 'Double-click to edit the text'; txt.style.cursor = 'text';
    txt.addEventListener('dblclick', () => beginEdit(stop, txt));
    if (!stop.text) {
      // A new/empty line: a visible placeholder, one click to write it.
      txt.textContent = '✎ Write the line…'; txt.className = 'txt placeholder';
      txt.addEventListener('click', () => beginEdit(stop, txt));
    }
  }
  cap.appendChild(txt);
  if (stop.kind === 'dialog') {
    const pen = document.createElement('button'); pen.className = 'alt'; pen.textContent = '✏'; pen.title = 'Edit the text (Enter saves, Esc cancels)';
    pen.style.flex = '0 0 auto'; pen.style.marginLeft = 'auto';
    pen.addEventListener('click', () => { const span = cap.querySelector('.txt'); if (span) beginEdit(stop, span); });
    cap.appendChild(pen);
  }
  if (stop.kind === 'dialog' || stop.kind === 'pause') {
    const del = document.createElement('button'); del.className = 'alt'; del.textContent = '🗑'; del.title = 'Delete this line';
    del.style.marginLeft = stop.kind === 'dialog' ? '4px' : 'auto'; del.style.flex = '0 0 auto';
    del.addEventListener('click', () => vscode.postMessage({ type:'deleteStop', line: stop.line, src: stop.src }));
    cap.appendChild(del);
  }
  if ((stop.kind === 'image' || stop.kind === 'video') && stop.image) {
    const isVid = stop.image.kind === 'show_video';
    const ed = document.createElement('button'); ed.className = 'alt'; ed.textContent = isVid ? '🎬 Edit' : '🖼 Edit'; ed.title = isVid ? 'Edit video step / pause / Movie definition' : 'Edit image steps';
    ed.style.marginLeft = 'auto'; ed.style.flex = '0 0 auto';
    ed.addEventListener('click', () => openImageFor(stop.line, stop.src, stop.image));
    cap.appendChild(ed);
  }
}

function beginSpeakerEdit(stop, span) {
  const sel = document.createElement('select');
  const sub = document.createElement('option'); sub.value = 'subtitles'; sub.textContent = '(subtitles / narration)'; sel.appendChild(sub);
  for (const c of state.characters || []) { const o = document.createElement('option'); o.value = c.key; o.textContent = c.label; sel.appendChild(o); }
  sel.value = (stop.personKeys && stop.personKeys[0]) ? stop.personKeys[0] : 'subtitles';
  span.replaceWith(sel); sel.focus();
  let done = false;
  sel.addEventListener('change', () => { if (done) return; done = true; vscode.postMessage({ type:'changeSpeaker', line: stop.line, src: stop.src, personKey: sel.value }); });
  sel.addEventListener('blur', () => { if (done) return; done = true; renderCaption(stop); });
}

function beginEdit(stop, span) {
  const raw = stop.rawText != null ? stop.rawText : (stop.text || '');
  const input = document.createElement('input'); input.type = 'text'; input.value = raw;
  input.style.flex = '1'; input.style.minWidth = '0';
  input.style.background = 'var(--vscode-input-background)'; input.style.color = 'var(--vscode-input-foreground)';
  input.style.border = '1px solid var(--vscode-focusBorder)';
  span.replaceWith(input); input.focus(); input.select();
  let done = false;
  const commit = () => { if (done) return; done = true; vscode.postMessage({ type:'editText', line: stop.line, src: stop.src, text: input.value }); };
  const cancel = () => { if (done) return; done = true; renderCaption(stop); };
  input.placeholder = 'Dialogue text…';
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { e.preventDefault(); cancel(); } });
  // Clicking elsewhere keeps what was typed (only Esc throws it away).
  input.addEventListener('blur', () => { if (input.value !== raw) commit(); else cancel(); });
}

function labelForKind(k){ return k==='pause'?'Pause':k==='image'?'Image':k==='video'?'Video':'Narration'; }

// Timeline: stops are cards; between them pin-shaped markers stand on the baseline. Their
// round heads carry the marker icon and step down to the right when several share a gap;
// hovering a head expands it to the right with the marker text (and move arrows).
const PIN_X = 14;
const PIN_Y = 18;
function lineOfItem(it) { return it.marker ? it.marker.line : it.split.line; }
function splitText(b) { return (b.kind === 'menu' ? (b.title || 'Menu') : 'if') + ' → ' + (b.options[b.selected] || '?'); }

function renderTimeline() {
  const box = document.getElementById('timeline');
  box.innerHTML = '';
  const strip = document.createElement('div'); strip.className = 'strip';
  const stops = state.stops || [];
  const byGap = new Map();
  const push = (g, item) => { if (!byGap.has(g)) byGap.set(g, []); byGap.get(g).push(item); };
  for (const m of state.markers || []) push(m.afterStop, { marker: m });
  // Branch points (splits): a menu marks its own pin, an if/elif chain gets a ⑂ pin.
  for (const b of state.branches || []) {
    const g = b.afterStop == null ? -1 : b.afterStop;
    const own = b.kind === 'menu' ? (byGap.get(g) || []).find((x) => x.marker && x.marker.kind === 'menu' && x.marker.line === b.line) : null;
    if (own) own.split = b; else push(g, { split: b });
  }
  let maxPins = 0;
  byGap.forEach((list) => { maxPins = Math.max(maxPins, list.length); });
  const top = maxPins ? (maxPins - 1) * PIN_Y + 30 : 6;
  addGap(strip, byGap.get(-1) || [], null, top);
  stops.forEach((stop, i) => {
    const card = document.createElement('div'); card.className = 'card' + (i === current ? ' active' : '');
    card.style.marginTop = top + 'px';
    const head = document.createElement('div'); head.className = 'head';
    for (const p of (stop.portraits || []).slice(0, 3)) { const im = document.createElement('img'); im.className = 'pic'; im.src = p; head.appendChild(im); }
    const who = document.createElement('span'); who.className = 'who';
    who.textContent = stop.names && stop.names.length ? stop.names[0] : (stop.speaker || labelForKind(stop.kind));
    head.appendChild(who);
    card.appendChild(head);
    const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = labelForKind(stop.kind); card.appendChild(kind);
    const txt = document.createElement('div'); txt.className = 'txt'; txt.textContent = stop.text || (stop.kind === 'dialog' ? '✎ (empty)' : ''); card.appendChild(txt);
    card.addEventListener('click', () => {
      goto(i);
      if ((stop.kind === 'image' || stop.kind === 'video') && stop.image) openImageFor(stop.line, stop.src, stop.image);
    });
    card.appendChild(moveTools(stop.line, stop.src));
    strip.appendChild(card);
    addGap(strip, byGap.get(i) || [], stop, top);
  });
  box.appendChild(strip);
}

function addGap(strip, items, stop, top) {
  if (!items.length && !stop) return;
  items.sort((a, b) => lineOfItem(a) - lineOfItem(b));
  const gap = document.createElement('div'); gap.className = 'gap';
  gap.style.width = Math.max(24, 16 + items.length * PIN_X) + 'px';
  items.forEach((it, i) => gap.appendChild(pinFor(it, i)));
  if (stop) {
    const plus = document.createElement('button'); plus.className = 'plus'; plus.textContent = '＋';
    plus.title = 'Insert a statement here';
    plus.addEventListener('click', () => renderInsertChooser(stop.line, stop.speaker, stop.src));
    gap.appendChild(plus);
  }
  strip.appendChild(gap);
}

function pinFor(it, i) {
  const m = it.marker;
  const pin = document.createElement('div'); pin.className = 'pin' + (it.split ? ' split' : '') + (m ? ' k-' + m.kind : '');
  pin.style.left = (10 + i * PIN_X) + 'px';
  pin.style.top = (i * PIN_Y) + 'px';
  const head = document.createElement('div'); head.className = 'phead';
  const ico = document.createElement('span'); ico.className = 'pico';
  ico.textContent = m ? (m.image && m.image.kind === 'show_video' ? '🎬' : markerIcon(m.kind)) : (it.split.kind === 'menu' ? '☰' : '⑂');
  head.appendChild(ico);
  const txt = document.createElement('span'); txt.className = 'ptxt';
  txt.textContent = m ? m.label + (it.split ? '  ⑂ ' + (it.split.options[it.split.selected] || '') : '') : splitText(it.split);
  head.appendChild(txt);
  head.title = m ? m.label : 'Branch point: ' + splitText(it.split) + ' — switch it in the branch bar';
  if (m) {
    const mv = moveTools(m.line, m.src); mv.className = 'pmv'; head.appendChild(mv);
    head.addEventListener('click', () => openMarker(m));
  } else {
    head.addEventListener('click', () => focusBranch(it.split));
  }
  pin.appendChild(head);
  return pin;
}

/** Point at a split's row in the branch bar. */
function focusBranch(b) {
  const idx = (state.branches || []).indexOf(b);
  const row = document.getElementById('branchbar').children[idx];
  if (!row) return;
  if (row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1200);
}

/** After a branch/value switch: stay on the stop when the path up to it is unchanged; else go to the last stop before the split. */
function keptIndex(oldStops, cur, newStops) {
  const same = (a, b) => a && b && a.line === b.line && a.kind === b.kind && a.text === b.text;
  let k = 0;
  while (k < oldStops.length && k < newStops.length && same(oldStops[k], newStops[k])) k++;
  if (cur < k) return cur;
  return Math.max(0, Math.min(newStops.length - 1, k - 1));
}

/** Hover arrows that move a statement one step earlier/later in its block. */
function moveTools(line, src) {
  const box = document.createElement('div'); box.className = 'mv';
  const mk = (label, dir, title) => {
    const b = document.createElement('button'); b.className = 'alt'; b.textContent = label; b.title = title;
    b.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type:'moveStatement', line, src, direction: dir }); });
    return b;
  };
  box.appendChild(mk('◀', -1, 'Move earlier'));
  box.appendChild(mk('▶', 1, 'Move later'));
  return box;
}

function markerIcon(k){ return k==='paperdoll'?'🎭':k==='image'?'🖼':k==='background'?'🌄':k==='menu'?'❓':k==='stats'?'📈':k==='end'?'⏹':'＋'; }
function renderInsertChooser(line, speaker, src) {
  openMenuLine = null;
  const ed = document.getElementById('editor');
  ed.innerHTML = '';
  const h = document.createElement('h3'); h.textContent = 'Insert after line ' + (line + 1); ed.appendChild(h);
  const row = document.createElement('div'); row.className = 'branch-row';
  const opts = [
    ['💬 Dialogue', () => vscode.postMessage({ type:'plusInsert', kind:'dialog', line, src, speaker })],
    ['🎭 Paperdoll', () => { showPaperdoll(true); vscode.postMessage({ type:'openMarker', kind:'paperdoll', line, src, character:0 }); }],
    ['🖼 Image', () => vscode.postMessage({ type:'plusInsert', kind:'image', line, src })],
    ['🎬 Video', () => { showModule('img'); vscode.postMessage({ type:'plusInsert', kind:'video', line, src }); }],
    ['❓ Menu', () => vscode.postMessage({ type:'plusInsert', kind:'menu', line, src })],
  ];
  for (const [label, fn] of opts) {
    const btn = document.createElement('button'); btn.className = 'alt'; btn.textContent = label;
    btn.addEventListener('click', fn); row.appendChild(btn);
  }
  ed.appendChild(row);
}

/** Image module for exactly this image (for a show_image series: this one step). */
function openImageFor(line, src, image) {
  if (image.kind === 'show' || image.kind === 'show_pattern' || image.kind === 'show_image' || image.kind === 'show_video') showModule('img');
  vscode.postMessage({ type:'openMarker', kind:'image', line, src, character: image.character || 0, image });
}

function openMarker(m) {
  if (m.kind === 'menu') { renderMenuEditor(m); return; }
  if (m.kind === 'stats') { showModule(null); renderStatsEditor(m); return; }
  if (m.kind === 'end') { showModule(null); renderEndEditor(m); return; }
  if (m.kind === 'paperdoll') { showPaperdoll(true); vscode.postMessage({ type:'openMarker', kind:'paperdoll', line:m.line, src:m.src, character:m.character }); return; }
  if (m.kind === 'background') {
    showModule('bg');
    vscode.postMessage({ type: 'bg:open', line: m.line, src: m.src });
    return;
  }
  if (m.kind === 'image') {
    if (!m.image) return;
    openImageFor(m.line, m.src, m.image);
    return;
  }
}

// ── Background module ──
let bgState = null;
function bgField(host, label, input, cls) { const l = document.createElement('label'); if (cls) l.className = cls; if (cls === 'chk') { l.appendChild(input); l.appendChild(textSpan(label)); } else { l.appendChild(textSpan(label)); l.appendChild(input); } host.appendChild(l); return input; }
function bgInput(type, value) { const i = document.createElement('input'); i.type = type; if (type === 'checkbox') i.checked = !!value; else i.value = String(value); return i; }
function applyBgEditor(msg) {
  const prev = document.getElementById('bgprev'); prev.innerHTML = '';
  const form = document.getElementById('bgform'); form.innerHTML = '';
  const note = document.getElementById('bgnote'); note.textContent = '';
  if (msg.missing) { note.textContent = 'No set_background(…) on that line anymore.'; bgState = null; return; }
  bgState = { line: msg.line, src: msg.src, spec: JSON.parse(JSON.stringify(msg.spec)), saved: msg.saved };
  const s = bgState.spec;
  // Preview like the stage: blur in game pixels, split halves, black-and-white.
  const w = (prev.getBoundingClientRect && prev.getBoundingClientRect().width) || 1920;
  const blurPx = (s.blur === true ? 10 : Number(s.blur) || 0) * w / 1920;
  const addPrev = (src, left, width, bw) => { if (!src) return; const im = document.createElement('img'); im.src = src; im.style.left = left; im.style.width = width; im.style.filter = filterOf(blurPx * 1920 / w, bw ? 1 : 0, w / 1920); prev.appendChild(im); };
  if (s.split) { addPrev(msg.previews[0], '0', '50%', s.bwLeft); addPrev(msg.previews[1], '50%', '50%', s.bwRight); const sep = document.createElement('div'); sep.className = 'bgsep'; sep.style.width = (s.separator / 1920 * 100) + '%'; prev.appendChild(sep); }
  else addPrev(msg.previews[0], '0', '100%', s.bw);
  const changed = () => vscode.postMessage({ type: 'bg:change', line: bgState.line, src: bgState.src, spec: bgState.spec });
  s.sources.forEach((src, i) => {
    const name = s.split ? (i === 0 ? 'Left' : 'Right') : 'Image';
    if (src.kind === 'series') {
      const inp = bgField(form, name + ' — ' + src.variable + '[step]', bgInput('number', src.step));
      inp.min = '0';
      inp.addEventListener('change', () => { src.step = Math.max(0, Math.round(Number(inp.value) || 0)); changed(); });
    } else if (src.kind === 'path') {
      const inp = bgField(form, name + ' — path', bgInput('text', src.path));
      inp.addEventListener('change', () => { src.path = inp.value; changed(); });
    } else {
      const inp = bgField(form, name + ' — code (edit in the script)', bgInput('text', src.code)); inp.disabled = true;
    }
  });
  const blurSel = document.createElement('select');
  [['off', 'off'], ['on', 'on (10)'], ['custom', 'custom']].forEach((x) => { const o = document.createElement('option'); o.value = x[0]; o.textContent = x[1]; blurSel.appendChild(o); });
  blurSel.value = s.blur === true ? 'on' : (s.blur === false || s.blur === 0) ? 'off' : 'custom';
  bgField(form, 'blur', blurSel);
  const amount = bgField(form, 'blur amount', bgInput('number', typeof s.blur === 'number' ? s.blur : s.blur ? 10 : 0));
  amount.step = '0.5'; amount.min = '0'; amount.disabled = blurSel.value !== 'custom';
  blurSel.addEventListener('change', () => { s.blur = blurSel.value === 'on' ? true : blurSel.value === 'off' ? false : (Number(amount.value) || 5); changed(); });
  amount.addEventListener('change', () => { s.blur = Number(amount.value) || 0; changed(); });
  const dur = bgField(form, 'blur_duration (s)', bgInput('number', s.blurDuration)); dur.step = '0.1'; dur.min = '0';
  dur.addEventListener('change', () => { s.blurDuration = Math.max(0, Number(dur.value) || 0); changed(); });
  if (s.split) {
    const bl = bgField(form, 'left black-and-white', bgInput('checkbox', s.bwLeft), 'chk'); bl.addEventListener('change', () => { s.bwLeft = bl.checked; changed(); });
    const br = bgField(form, 'right black-and-white', bgInput('checkbox', s.bwRight), 'chk'); br.addEventListener('change', () => { s.bwRight = br.checked; changed(); });
    const sepIn = bgField(form, 'separator width (px)', bgInput('number', s.separator)); sepIn.min = '0';
    sepIn.addEventListener('change', () => { s.separator = Math.max(0, Math.round(Number(sepIn.value) || 0)); changed(); });
  } else {
    const b = bgField(form, 'black-and-white', bgInput('checkbox', s.bw), 'chk'); b.addEventListener('change', () => { s.bw = b.checked; changed(); });
  }
  const dirty = JSON.stringify(s) !== JSON.stringify(msg.saved);
  note.textContent = msg.positionalOptions ? 'Options are passed positionally — edit them in the code.' : dirty ? 'Preview — not applied yet' : '';
  document.getElementById('bgapply').disabled = !dirty || !!msg.positionalOptions;
  showModule('bg');
}
document.getElementById('bgapply').addEventListener('click', () => { if (bgState) vscode.postMessage({ type: 'bg:apply', line: bgState.line, src: bgState.src, spec: bgState.spec }); });
document.getElementById('bgclose').addEventListener('click', () => showModule(null));

function renderStatsEditor(m) {
  openMenuLine = null; openStmtEditor = { kind: 'stats', line: m.line };
  const ed = document.getElementById('editor'); ed.innerHTML = '';
  const h = document.createElement('h3'); h.className = 'pdhost-head'; h.textContent = 'Stat changes · L' + (m.line + 1);
  const close = document.createElement('button'); close.className = 'alt'; close.textContent = '✕';
  close.addEventListener('click', () => { openStmtEditor = null; ed.innerHTML = ''; });
  h.appendChild(close); ed.appendChild(h);
  const post = (extra) => vscode.postMessage(Object.assign({ type: 'statOp', line: m.line, src: m.src }, extra));
  (m.stats || []).forEach((s) => {
    const row = document.createElement('div'); row.className = 'branch-row';
    const lbl = document.createElement('span'); lbl.textContent = s.stat; lbl.style.minWidth = '80px'; row.appendChild(lbl);
    const sel = document.createElement('select');
    const vals = MODIFIERS.indexOf(s.value) < 0 ? [s.value].concat(MODIFIERS) : MODIFIERS;
    vals.forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = modText(v) + '  (' + v + ')'; sel.appendChild(o); });
    sel.value = s.value;
    sel.addEventListener('change', () => post({ op: 'set', stat: s.stat, value: sel.value }));
    row.appendChild(sel);
    const rm = document.createElement('button'); rm.className = 'alt'; rm.textContent = '✕'; rm.title = 'Remove this stat change';
    rm.addEventListener('click', () => post({ op: 'remove', stat: s.stat }));
    row.appendChild(rm);
    ed.appendChild(row);
  });
  const add = document.createElement('div'); add.className = 'branch-row';
  const stat = document.createElement('select');
  STAT_NAMES.filter((n) => !(m.stats || []).some((s) => s.stat === n)).forEach((n) => { const o = document.createElement('option'); o.value = n; o.textContent = n; stat.appendChild(o); });
  const val = document.createElement('select');
  MODIFIERS.forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = modText(v) + '  (' + v + ')'; val.appendChild(o); });
  val.value = 'SMALL';
  const go = document.createElement('button'); go.textContent = '+ Stat';
  go.addEventListener('click', () => { if (stat.value) post({ op: 'add', stat: stat.value, value: val.value }); });
  add.appendChild(stat); add.appendChild(val); add.appendChild(go);
  ed.appendChild(add);
}

function renderEndEditor(m) {
  openMenuLine = null; openStmtEditor = { kind: 'end', line: m.line };
  const ed = document.getElementById('editor'); ed.innerHTML = '';
  const h = document.createElement('h3'); h.className = 'pdhost-head'; h.textContent = 'Event end · L' + (m.line + 1);
  const close = document.createElement('button'); close.className = 'alt'; close.textContent = '✕';
  close.addEventListener('click', () => { openStmtEditor = null; ed.innerHTML = ''; });
  h.appendChild(close); ed.appendChild(h);
  const row = document.createElement('div'); row.className = 'branch-row';
  const sel = document.createElement('select');
  const known = END_TYPES.map((x) => x[0]);
  (known.indexOf(m.endType) < 0 ? [[m.endType, 'custom']].concat(END_TYPES) : END_TYPES).forEach((x) => { const o = document.createElement('option'); o.value = x[0]; o.textContent = x[0] + ' — ' + x[1]; sel.appendChild(o); });
  sel.value = m.endType;
  sel.addEventListener('change', () => vscode.postMessage({ type: 'endOp', line: m.line, src: m.src, endType: sel.value }));
  row.appendChild(sel); ed.appendChild(row);
}

/** Stat effects + ending of the path shown in the timeline (for balancing). */
function textSpan(s) { const e = document.createElement('span'); e.textContent = s; return e; }
function renderEffects() {
  const box = document.getElementById('effects'); box.innerHTML = '';
  const totals = {}; let end = '';
  (state.markers || []).forEach((m) => {
    if (m.kind === 'stats') (m.stats || []).forEach((s) => { (totals[s.stat] = totals[s.stat] || []).push(s.value); });
    if (m.kind === 'end') end = m.endType;
  });
  const keys = Object.keys(totals);
  if (!keys.length && !end) return;
  box.appendChild(textSpan('Effects on this path: '));
  keys.forEach((k, i) => {
    const sp = document.createElement('span');
    const vals = totals[k].map(modText).join(' ');
    sp.className = totals[k].every((v) => /^DEC_/.test(v)) ? 'down' : 'up';
    sp.textContent = (i ? ' · ' : '') + k + ' ' + vals;
    box.appendChild(sp);
  });
  if (end) box.appendChild(textSpan('  →  end: ' + end));
}

// ── Event check module ──
function openCheck() { showModule('check'); checkState = null; renderCheck(); vscode.postMessage({ type: 'check:run' }); }
function fmtEffects(effects) {
  return Object.keys(effects || {}).map((k) => k + ' ' + effects[k].map(modText).join(' ')).join(' · ');
}
function renderCheck() {
  const box = document.getElementById('checkbody'); box.innerHTML = '';
  if (!checkState) { const p = document.createElement('div'); p.className = 'muted'; p.textContent = 'Checking every path…'; box.appendChild(p); return; }
  if (checkState.error) { const p = document.createElement('div'); p.className = 'err'; p.textContent = checkState.error; box.appendChild(p); return; }
  const r = checkState;
  const missing = r.coverage.reduce((n, c) => n + c.missing, 0);
  const tabs = document.createElement('div'); tabs.className = 'tabs';
  [['issues', 'Issues (' + r.issues.length + ')'], ['coverage', 'Images' + (missing ? ' (' + missing + ' missing)' : '')], ['paths', 'Paths (' + r.paths.length + ')']].forEach((x) => {
    const b = document.createElement('button'); b.className = checkTab === x[0] ? '' : 'alt'; b.textContent = x[1];
    b.addEventListener('click', () => { checkTab = x[0]; renderCheck(); }); tabs.appendChild(b);
  });
  const rerun = document.createElement('button'); rerun.className = 'alt'; rerun.textContent = '↻'; rerun.title = 'Run again';
  rerun.addEventListener('click', openCheck); tabs.appendChild(rerun);
  box.appendChild(tabs);
  if (checkTab === 'issues') {
    const n = { error: 0, warning: 0, info: 0 }; r.issues.forEach((i) => { n[i.severity]++; });
    if (!n.error && !n.warning) { const ok = document.createElement('div'); ok.className = 'okline'; ok.textContent = '✅ No problems on ' + r.paths.length + ' path(s)' + (n.info ? ' (' + n.info + ' note(s))' : '') + '.'; box.appendChild(ok); }
    r.issues.forEach((i) => {
      const row = document.createElement('div'); row.className = 'issue ' + i.severity;
      const ico = document.createElement('span'); ico.className = 'ico'; ico.textContent = i.severity === 'error' ? '⛔' : i.severity === 'warning' ? '⚠' : 'ℹ'; row.appendChild(ico);
      const msg = document.createElement('span'); msg.className = 'msg'; msg.textContent = i.message; row.appendChild(msg);
      if (i.line != null) { const a = document.createElement('a'); a.textContent = 'L' + (i.line + 1); a.title = 'Show in code'; a.addEventListener('click', () => vscode.postMessage({ type: 'reveal', line: i.line })); row.appendChild(a); }
      if (i.selections) { const b = document.createElement('button'); b.className = 'alt'; b.textContent = '▶ path'; b.title = 'Show this path in the timeline'; b.addEventListener('click', () => vscode.postMessage({ type: 'check:showPath', selections: i.selections })); row.appendChild(b); }
      box.appendChild(row);
    });
  } else if (checkTab === 'coverage') {
    const head = document.createElement('div'); head.className = 'covhead';
    const exact = r.coverage.reduce((n, c) => n + c.exact, 0), wild = r.coverage.reduce((n, c) => n + c.wildcard, 0);
    head.appendChild(textSpan(exact + ' exact · ' + wild + ' via $ · ' + missing + ' missing'));
    const shot = document.createElement('button'); shot.textContent = '📋 Shot list'; shot.disabled = !missing;
    shot.title = 'Copy the file names of all missing images (CSV) — the shots to take';
    shot.addEventListener('click', () => vscode.postMessage({ type: 'check:shotlist' }));
    head.appendChild(shot); box.appendChild(head);
    if (!r.coverage.length) { const p = document.createElement('div'); p.className = 'muted'; p.textContent = 'No pattern images in this event.'; box.appendChild(p); }
    r.coverage.forEach((c, idx) => {
      const row = document.createElement('div'); row.className = 'covrow';
      const tl = document.createElement('div'); tl.className = 't';
      const name = document.createElement('span'); name.textContent = c.patternKey + (c.step !== null ? (c.video ? ' · video ' : ' · step ') + c.step : '') + (c.keys.length ? '  [' + c.keys.join(' × ') + ']' : '');
      tl.appendChild(name);
      [['exact', c.exact + ' ✓'], ['wildcard', c.wildcard + ' $'], ['missing', c.missing + ' missing']].forEach((x) => { if (x[0] === 'exact' || Number(x[1].split(' ')[0])) { const b = document.createElement('span'); b.className = 'badge ' + x[0]; b.textContent = x[1]; tl.appendChild(b); } });
      const a = document.createElement('a'); a.textContent = 'L' + (c.lines[0] + 1); a.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'reveal', line: c.lines[0] }); }); tl.appendChild(a);
      const key = c.patternKey + '|' + c.step + '|' + c.video;
      if (covOpen[key] === undefined) covOpen[key] = c.missing > 0 && r.coverage.length <= 6;
      tl.addEventListener('click', () => { covOpen[key] = !covOpen[key]; renderCheck(); });
      row.appendChild(tl);
      if (covOpen[key]) {
        if (c.keys.length === 1 && c.cells.length <= 40) {
          const cells = document.createElement('div'); cells.className = 'cells';
          c.cells.forEach((cell) => { const s = document.createElement('span'); s.className = 'cell ' + cell.status; s.textContent = cell.combo[c.keys[0]]; s.title = cell.status === 'missing' ? 'missing: ' + cell.expected : cell.file; cells.appendChild(s); });
          row.appendChild(cells);
        }
        const miss = c.cells.filter((x) => x.status === 'missing');
        if (miss.length) {
          const ul = document.createElement('ul'); ul.className = 'missinglist';
          miss.slice(0, 40).forEach((x) => { const li = document.createElement('li'); li.textContent = x.expected.split('/').pop(); li.title = x.expected; ul.appendChild(li); });
          if (miss.length > 40) { const li = document.createElement('li'); li.textContent = '… ' + (miss.length - 40) + ' more (see shot list)'; ul.appendChild(li); }
          row.appendChild(ul);
        }
      }
      box.appendChild(row);
    });
  } else {
    r.paths.forEach((pth) => {
      const row = document.createElement('div'); row.className = 'pathrow';
      const d = document.createElement('span'); d.className = 'd'; d.textContent = pth.description; row.appendChild(d);
      const e = document.createElement('span'); e.textContent = fmtEffects(pth.effects) || 'no stat changes'; row.appendChild(e);
      if (pth.endType) { const en = document.createElement('span'); en.className = 'muted'; en.textContent = '→ ' + pth.endType; row.appendChild(en); }
      const b = document.createElement('button'); b.className = 'alt'; b.textContent = '▶'; b.title = 'Show this path';
      b.addEventListener('click', () => vscode.postMessage({ type: 'check:showPath', selections: pth.selections }));
      row.appendChild(b);
      box.appendChild(row);
    });
  }
}

// ── Trigger simulator ──
let simDefaults = null;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAYTIMES = ['Morning', 'Early Noon', 'Noon', 'Early Afternoon', 'Afternoon', 'Evening', 'Night'];
function openSim() { showModule('sim'); if (!simDefaults) vscode.postMessage({ type: 'sim:init' }); else postSim(); }
function simField(label, input) { const l = document.createElement('label'); l.textContent = label; l.appendChild(input); return l; }
const simInputs = {};
function numInput(id, value, min, max) { const i = document.createElement('input'); simInputs[id] = i; i.type = 'number'; i.id = id; i.value = String(value); i.min = String(min); i.max = String(max); i.addEventListener('change', postSim); return i; }
function selInput(id, names, value) { const s = document.createElement('select'); simInputs[id] = s; s.id = id; names.forEach((n, i) => { const o = document.createElement('option'); o.value = String(i + 1); o.textContent = (i + 1) + ' · ' + n; s.appendChild(o); }); s.value = String(value); s.addEventListener('change', postSim); return s; }
function renderSimForm(st) {
  const f = document.getElementById('simform'); f.innerHTML = '';
  f.appendChild(simField('Weekday', selInput('sim_weekday', WEEKDAYS, st.weekday)));
  f.appendChild(simField('Daytime', selInput('sim_daytime', DAYTIMES, st.daytime)));
  Object.keys(st.levels).forEach((k) => f.appendChild(simField(k + ' level', numInput('sim_lvl_' + k, st.levels[k], 0, 10))));
  Object.keys(st.stats).forEach((k) => f.appendChild(simField(k, numInput('sim_stat_' + k, st.stats[k], 0, 100))));
  f.appendChild(simField('money', numInput('sim_money', st.money, 0, 1000000)));
  const intro = document.createElement('input'); simInputs.sim_intro = intro; intro.type = 'checkbox'; intro.id = 'sim_intro'; intro.checked = !!st.intro; intro.addEventListener('change', postSim);
  f.appendChild(simField('intro running', intro));
}
function readSim() {
  const v = (id) => simInputs[id].value;
  const st = { weekday: Number(v('sim_weekday')), daytime: Number(v('sim_daytime')), levels: {}, stats: {}, money: Number(v('sim_money')), intro: simInputs.sim_intro.checked };
  Object.keys(simDefaults.levels).forEach((k) => { st.levels[k] = Number(v('sim_lvl_' + k)); });
  Object.keys(simDefaults.stats).forEach((k) => { st.stats[k] = Number(v('sim_stat_' + k)); });
  return st;
}
function postSim() { if (simDefaults) vscode.postMessage({ type: 'sim:eval', state: readSim() }); }
function verdictText(row) {
  if (!row) return 'No Event(...) definition found.';
  const ch = row.chance < 1 ? ' (' + Math.round(row.chance * 100) + ' % random chance)' : '';
  return row.result === 'yes' ? '✅ Can fire' + ch : row.result === 'no' ? '⛔ Cannot fire' : '❓ Depends on game progress' + ch;
}
function condList(nodes, host) {
  nodes.forEach((n) => {
    const d = document.createElement('div'); d.className = 'cond';
    d.textContent = (n.result === 'yes' ? '✓ ' : n.result === 'no' ? '✗ ' : '? ') + n.label;
    if (n.detail) { const s = document.createElement('span'); s.className = 'd'; s.textContent = ' — ' + n.detail; d.appendChild(s); }
    host.appendChild(d);
    if (n.children && n.children.length) condList(n.children, d);
  });
}
function renderSim(msg) {
  const box = document.getElementById('simresult'); box.innerHTML = '';
  const r = msg.result;
  const v = document.createElement('div'); v.className = 'verdict'; v.textContent = verdictText(r.event); box.appendChild(v);
  if (r.event) condList(r.event.conditions, box);
  if (!r.pools.length) { const p = document.createElement('div'); p.className = 'muted'; p.textContent = 'Not added to a pool (pool.add_event) in the workspace.'; box.appendChild(p); }
  r.pools.forEach((pool) => {
    const d = document.createElement('div'); d.className = 'pool';
    const h = document.createElement('h4'); h.textContent = 'Pool ' + pool.pool + ' (' + pool.rows.length + ' events)'; d.appendChild(h);
    const s = document.createElement('div'); s.className = 'sum'; s.textContent = pool.summary; d.appendChild(s);
    pool.rows.forEach((row) => {
      const pr = document.createElement('div'); pr.className = 'prow' + (row.label === msg.label ? ' self' : '');
      const ico = document.createElement('span'); ico.textContent = row.result === 'yes' ? '✅' : row.result === 'no' ? '⛔' : '❓'; pr.appendChild(ico);
      const pp = document.createElement('span'); pp.className = 'muted'; pp.textContent = 'p' + row.priority; pr.appendChild(pp);
      const a = document.createElement('a'); a.textContent = row.label; a.title = 'Open this event';
      a.addEventListener('click', () => vscode.postMessage({ type: 'openLabel', label: row.label })); pr.appendChild(a);
      const why = document.createElement('span'); why.className = 'why'; why.textContent = row.reasons.join(' · '); why.title = row.reasons.join(String.fromCharCode(10)); pr.appendChild(why);
      d.appendChild(pr);
    });
    box.appendChild(d);
  });
}

function refreshEditor() {
  if (openStmtEditor) {
    const m = (state.markers || []).find((x) => x.kind === openStmtEditor.kind && x.line === openStmtEditor.line);
    if (m) { if (m.kind === 'stats') renderStatsEditor(m); else renderEndEditor(m); return; }
    openStmtEditor = null;
  }
  if (openMenuLine != null) {
    const m = (state.markers||[]).find((x) => x.kind==='menu' && x.line===openMenuLine);
    if (m) { renderMenuEditor(m); return; }
    openMenuLine = null;
  }
  document.getElementById('editor').innerHTML = '';
}

function renderMenuEditor(marker) {
  openMenuLine = marker.line;
  const ed = document.getElementById('editor');
  ed.innerHTML = '';
  const h = document.createElement('h3'); h.className = 'pdhost-head'; h.textContent = 'Menu choices · L' + (marker.line+1);
  const close = document.createElement('button'); close.className = 'alt'; close.textContent = '✕'; close.title = 'Close';
  close.addEventListener('click', () => { openMenuLine = null; ed.innerHTML = ''; });
  h.appendChild(close); ed.appendChild(h);
  const branch = (state.branches||[]).find((b) => b.kind==='menu' && b.line===marker.line);
  (marker.choices||[]).forEach((c, i) => {
    const row = document.createElement('div'); row.className='branch-row';
    const btn = document.createElement('button');
    btn.className = (branch && branch.selected===i) ? '' : 'alt';
    btn.textContent = c.title + (c.target ? '' : ' (unresolved)');
    btn.disabled = !c.target;
    if (branch && c.target) btn.addEventListener('click', () => vscode.postMessage({ type:'selectBranch', id: branch.id, choice: i }));
    row.appendChild(btn);
    const editBtn = document.createElement('button'); editBtn.className='alt'; editBtn.textContent='✏'; editBtn.title='Edit title / target';
    editBtn.addEventListener('click', () => beginMenuChoiceEdit(marker, i, c, row));
    row.appendChild(editBtn);
    const rm = document.createElement('button'); rm.className='alt'; rm.textContent='✕'; rm.title='Remove this choice (its branch label is kept)';
    rm.addEventListener('click', () => vscode.postMessage({ type:'removeMenuChoice', line: marker.line, src: marker.src, index: i, key: c.key }));
    row.appendChild(rm);
    ed.appendChild(row);
  });
  const add = document.createElement('div'); add.className='branch-row';
  const key = document.createElement('input'); key.placeholder = 'decision key'; key.size = 14;
  const title = document.createElement('input'); title.placeholder = 'choice title'; title.style.flex = '1';
  const go = document.createElement('button'); go.textContent = '+ Choice'; go.title = 'Add a choice and create its branch label';
  go.addEventListener('click', () => {
    const k = key.value.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) { key.focus(); return; }
    vscode.postMessage({ type:'addMenuChoice', line: marker.line, src: marker.src, key: k, title: title.value.trim() || k });
  });
  add.appendChild(key); add.appendChild(title); add.appendChild(go);
  ed.appendChild(add);
}

function beginMenuChoiceEdit(marker, i, choice, row) {
  row.innerHTML = '';
  const title = document.createElement('input'); title.type='text'; title.value = choice.title || ''; title.placeholder='Title'; title.style.flex='1'; title.style.minWidth='0';
  const target = document.createElement('input'); target.type='text'; target.value = choice.target || ''; target.placeholder='label.sub target'; target.style.flex='1'; target.style.minWidth='0';
  const save = document.createElement('button'); save.textContent='Save';
  save.addEventListener('click', () => vscode.postMessage({ type:'editMenuChoice', line: marker.line, src: marker.src, choice: i, title: title.value, target: target.value }));
  const cancel = document.createElement('button'); cancel.className='alt'; cancel.textContent='Cancel';
  cancel.addEventListener('click', () => renderMenuEditor(marker));
  row.appendChild(title); row.appendChild(target); row.appendChild(save); row.appendChild(cancel);
  title.focus();
}

// Branch switcher under the timeline: one row per branch point on the previewed path, in walk
// order, indented by nesting depth (if/elif chains and custom menus, nested in each other).
function renderBranchBar() {
  const bar = document.getElementById('branchbar');
  bar.innerHTML = '';
  for (const b of (state.branches||[])) {
    const row = document.createElement('div'); row.className = 'bb-row';
    row.style.paddingLeft = ((b.depth||0) * 14) + 'px';
    if (b.depth) { const t = document.createElement('span'); t.className = 'bb-tree'; t.textContent = '└'; row.appendChild(t); }
    const lbl = document.createElement('span'); lbl.className = 'bb-lbl';
    lbl.textContent = (b.kind === 'menu' ? '☰ ' + (b.title || 'Menu') : '⑂ if') + ' · L' + (b.line+1);
    lbl.title = 'Show in code (line ' + (b.line+1) + ')';
    lbl.addEventListener('click', () => vscode.postMessage({ type:'reveal', line:b.line }));
    row.appendChild(lbl);
    b.options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = 'bb-opt' + (b.selected === i ? '' : ' alt');
      btn.textContent = opt;
      btn.title = opt;
      const off = !!(b.enabled && b.enabled[i] === false);
      btn.disabled = off;
      if (off) btn.title = opt + ' (branch label not found)';
      if (!off && b.selected !== i) btn.addEventListener('click', () => vscode.postMessage({ type:'selectBranch', id:b.id, choice:i }));
      row.appendChild(btn);
    });
    if (b.via && b.via !== 'explicit') {
      const tag = document.createElement('span'); tag.className = 'bb-tag';
      tag.textContent = b.via === 'value' ? 'by value' : 'auto';
      row.appendChild(tag);
    }
    if (b.kind === 'menu') {
      const m = (state.markers||[]).find((x) => x.kind==='menu' && x.line===b.line);
      if (m) {
        const ed = document.createElement('button'); ed.className = 'alt bb-edit'; ed.textContent = '✏'; ed.title = 'Edit menu choices';
        ed.addEventListener('click', () => { showModule(null); renderMenuEditor(m); });
        row.appendChild(ed);
      }
    }
    bar.appendChild(row);
  }
}

function goto(i, animate) {
  const stops = state.stops || [];
  if (!stops.length) return;
  const from = current;
  current = Math.max(0, Math.min(stops.length-1, i));
  const stop = stops[current];
  altIndex = 0;
  renderCaption(stop);
  if (animate && current === from + 1) playInto(stops[from], stop);
  else { finishAnim(); renderStage(withAlt(stop)); }
  document.getElementById('counter').textContent = (current+1)+' / '+stops.length;
  saveView();
  document.getElementById('prev').disabled = current<=0;
  document.getElementById('first').disabled = current<=0;
  document.getElementById('next').disabled = current>=stops.length-1;
  document.getElementById('last').disabled = current>=stops.length-1;
  for (const el of document.querySelectorAll('.card')) el.classList.remove('active');
  const cards = document.querySelectorAll('.card');
  if (cards[current]) { cards[current].classList.add('active'); cards[current].scrollIntoView({ inline:'center', block:'nearest' }); }
}

document.getElementById('first').addEventListener('click', () => goto(0));
// Mouse wheel scrolls the timeline sideways (a trackpad's own horizontal swipe still works).
document.getElementById('timeline').addEventListener('wheel', (e) => {
  const box = document.getElementById('timeline');
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || !e.deltaY) return;
  if (box.scrollWidth <= box.clientWidth) return;
  box.scrollLeft += e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
  e.preventDefault();
}, { passive: false });
document.getElementById('prev').addEventListener('click', () => goto(current-1));
document.getElementById('next').addEventListener('click', () => goto(current+1, true));
document.getElementById('last').addEventListener('click', () => goto((state.stops||[]).length-1));
document.getElementById('reveal').addEventListener('click', () => { const s=(state.stops||[])[current]; if (s) vscode.postMessage({ type:'reveal', line:s.line }); });
document.getElementById('undo').addEventListener('click', () => vscode.postMessage({ type:'undo' }));
document.getElementById('checkbtn').addEventListener('click', openCheck);
document.getElementById('checkclose').addEventListener('click', () => showModule(null));
document.getElementById('simbtn').addEventListener('click', openSim);
document.getElementById('simclose').addEventListener('click', () => showModule(null));
document.getElementById('overviewbtn').addEventListener('click', () => vscode.postMessage({ type: 'openOverview' }));
document.getElementById('optimize').addEventListener('click', () => vscode.postMessage({ type:'optimizeEvent' }));
document.getElementById('pdclose').addEventListener('click', () => showPaperdoll(false));

function showPaperdoll(show) { showModule(show ? 'pd' : null); }

function currentSteps() { return (document.getElementById('imgsteps').value.match(/[0-9]+/g) || []).map(Number); }

function applyImageEditor(msg) {
  imgState = { line: msg.line, src: msg.src, single: msg.single || null };
  const single = msg.single;
  // One step of a show_image series: the pattern/variable belong to the whole call.
  document.getElementById('imgkey').disabled = !!single;
  document.getElementById('imgkey').title = single ? 'The pattern applies to the whole show_image call — change it in the code' : '';
  document.getElementById('imgscope').textContent = single ? 'Step ' + (single.index + 1) + ' of ' + single.count + ' in this show_image call' + (single.index === single.count - 1 ? ' (last — pause makes it a stop)' : ' (always a stop)') : '';
  const rmStep = document.getElementById('imgremovestep');
  rmStep.style.display = single && single.count > 1 ? '' : 'none';
  const key = document.getElementById('imgkey'); key.innerHTML = '';
  for (const k of msg.keys || []) { const o = document.createElement('option'); o.value = k; o.textContent = k; key.appendChild(o); }
  key.value = msg.patternKey;
  document.getElementById('imgsteps').value = (msg.steps || []).join(', ');
  document.getElementById('imgpause').checked = !!msg.pause;
  document.getElementById('imgsteprow').style.display = msg.hasStep ? '' : 'none';
  document.getElementById('imgvideorow').style.display = msg.hasStep ? '' : 'none';
  document.getElementById('imgisvideo').checked = !!msg.video;
  // A video is one step; pause = True makes it wait for a click (its own stop).
  document.getElementById('imgpauserow').style.display = single ? (single.index === single.count - 1 ? '' : 'none') : (msg.hasStep && (msg.video || (msg.steps || []).length > 1)) ? '' : 'none';
  document.getElementById('imgpausetxt').textContent = msg.video ? 'Pause (wait for click)' : single ? 'Pause after this last step' : 'Pause after last';
  document.getElementById('imgvideorow').style.display = msg.hasStep && !single ? '' : 'none';
  document.getElementById('imgsteps').placeholder = msg.video || single ? '0' : '0  or  0, 1, 2';
  const prev = document.getElementById('imgpreview');
  const vid = document.getElementById('imgvideo');
  const v = msg.video ? msg.videoView : null;
  if (v && v.src) {
    if (vid._src !== v.src) { vid._src = v.src; vid.src = v.src; }
    vid.loop = !!v.loop; vid.poster = msg.preview || '';
    vid.style.display = ''; prev.style.display = 'none';
    if (vid.play) { const p = vid.play(); if (p && p.catch) p.catch(() => {}); }
  } else {
    if (vid.pause) vid.pause();
    vid.style.display = 'none';
    prev.style.display = msg.preview ? '' : 'none'; prev.src = msg.preview || '';
  }
  renderMoviePanel(msg);
  document.getElementById('imgcall').textContent = msg.call || '';
  document.getElementById('imgmissing').textContent = msg.missing ? 'No patterns found for this event.' : '';
  showModule('img');
}

// Movie declaration status of the video step + the actions to fix it.
function renderMoviePanel(msg) {
  const box = document.getElementById('imgmovie');
  box.innerHTML = '';
  if (!msg.video) return;
  const v = msg.videoView;
  if (!v) { const p = document.createElement('div'); p.className = 'bad'; p.textContent = 'No pattern image for this step — the video name cannot be derived.'; box.appendChild(p); return; }
  const head = document.createElement('div');
  const code = document.createElement('code'); code.textContent = v.name; head.appendChild(code);
  const st = document.createElement('span');
  st.className = v.defined ? 'ok' : 'bad';
  st.textContent = v.defined ? '  ✔ Movie defined' + (v.defFile ? ' in ' + v.defFile : '') : '  ⚠ no Movie definition — the game cannot show it';
  head.appendChild(st); box.appendChild(head);
  const path = document.createElement('div'); path.className = 'path';
  path.textContent = '▶ ' + v.play + (v.src ? '' : '  (file missing)');
  box.appendChild(path);
  const row = document.createElement('div'); row.className = 'branch-row';
  const lab = document.createElement('label');
  const loop = document.createElement('input'); loop.type = 'checkbox'; loop.id = 'imgloop'; loop.checked = !!v.loop;
  lab.appendChild(loop); const lt = document.createElement('span'); lt.textContent = ' Loop'; lab.appendChild(lt);
  lab.title = v.defined ? 'Edits loop = True on the Movie definition' : 'Loop setting for the definition to add';
  row.appendChild(lab);
  const payload = (extra) => Object.assign({ line: imgState.line, patternKey: document.getElementById('imgkey').value, steps: currentSteps(), pause: document.getElementById('imgpause').checked, loop: loop.checked }, extra);
  if (v.defined) {
    loop.addEventListener('change', () => vscode.postMessage(payload({ type:'movieLoop' })));
  } else {
    const add = document.createElement('button'); add.textContent = '＋ Movie definition';
    add.title = 'Add image ' + v.name + ' = Movie(play = …webm, start_image = …webp) next to the event';
    add.disabled = !v.src;
    add.addEventListener('click', () => vscode.postMessage(payload({ type:'movieAdd', all: false })));
    const all = document.createElement('button'); all.className = 'alt'; all.textContent = '＋ all variants';
    all.title = 'Add the definitions for every placeholder variant of this step that has a video file (e.g. each school_level)';
    all.addEventListener('click', () => vscode.postMessage(payload({ type:'movieAdd', all: true })));
    row.appendChild(add); row.appendChild(all);
  }
  box.appendChild(row);
}

function imgPayload(type) {
  const p = { type, line: imgState.line, src: imgState.src, patternKey: document.getElementById('imgkey').value, steps: currentSteps(), pause: document.getElementById('imgpause').checked, video: document.getElementById('imgisvideo').checked };
  if (imgState.single) { p.stepIndex = imgState.single.index; p.stepCount = imgState.single.count; p.steps = p.steps.slice(0, 1); p.video = false; }
  return p;
}
document.getElementById('imgremovestep').addEventListener('click', () => { if (imgState && imgState.single) vscode.postMessage(imgPayload('imgRemoveStep')); });
function imgChanged() {
  if (!imgState) return;
  vscode.postMessage(imgPayload('imgChange'));
}
document.getElementById('imgkey').addEventListener('change', imgChanged);
document.getElementById('imgsteps').addEventListener('change', imgChanged);
document.getElementById('imgpause').addEventListener('change', imgChanged);
document.getElementById('imgisvideo').addEventListener('change', imgChanged);
document.getElementById('imgapply').addEventListener('click', () => { if (imgState) vscode.postMessage(imgPayload('imgApply')); });
document.getElementById('imgclose').addEventListener('click', () => showModule(null));
document.getElementById('imgremove').addEventListener('click', () => { if (imgState) vscode.postMessage({ type: 'imgRemove', line: imgState.line, src: imgState.src }); });

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'imageEditor') { applyImageEditor(msg); return; }
  if (msg.type === 'bgEditor') { applyBgEditor(msg); return; }
  if (msg.type === 'closeModule') { if (currentModule === msg.module) showModule(null); return; }
  if (msg.type === 'check:running') { checkState = null; renderCheck(); return; }
  if (msg.type === 'check:result') { checkState = msg.error ? { error: msg.error } : msg.result; renderCheck(); return; }
  if (msg.type === 'sim:init') { simDefaults = msg.state; renderSimForm(msg.state); postSim(); return; }
  if (msg.type === 'sim:result') { renderSim(msg); return; }
  if (msg.type !== 'timeline') return;
  const prev = state;
  const prevCurrent = current;
  state = msg;
  document.getElementById('title').textContent = msg.eventLabel ? 'Event · ' + msg.eventLabel : 'Event';
  const stage = document.getElementById('stage');
  if (msg.missing || !(msg.stops||[]).length) {
    stage.innerHTML=''; document.getElementById('timeline').innerHTML='<div class="empty">No dialogue stops found for this event.</div>';
    document.getElementById('caption').innerHTML=''; document.getElementById('editor').innerHTML='';
    state.branches = msg.branches || []; renderBranchBar();
    document.getElementById('counter').textContent='0 / 0';
    return;
  }
  current = msg.keep && prev && prev.stops && prev.stops.length
    ? keptIndex(prev.stops, prevCurrent, msg.stops)
    : Math.max(0, Math.min((msg.stops.length-1), msg.current||0));
  const restore = restoreView && restoreView.eventLabel === msg.eventLabel ? restoreView : null;
  restoreView = null;
  if (restore && typeof restore.current === 'number') current = Math.max(0, Math.min(msg.stops.length - 1, restore.current));
  if (restore && restore.module) setTimeout(() => reopenModule(restore.module), 0);
  renderTimeline();
  renderValues(msg);
  renderBranchBar();
  renderEffects();
  refreshEditor();
  goto(current);
  if (msg.editLine != null) {
    const st = (msg.stops || []).find((s) => s.line === msg.editLine && s.kind === 'dialog');
    if (st) {
      goto(st.index);
      const span = document.getElementById('caption').querySelector('.txt');
      if (span) beginEdit(st, span);
    }
  }
});
window.addEventListener('resize', () => { if (anim) applyStyles(); else if (state && state.stops && state.stops[current]) renderStage(withAlt(state.stops[current])); });

${PaperdollEditor.clientScript()}
mountPaperdollEditor(vscode);
${EventDefEditor.clientScript()}
const defApi = mountEventDefEditor(vscode);
document.getElementById('defbtn').addEventListener('click', () => { showModule('def'); defApi.refresh(); });
document.getElementById('defclose').addEventListener('click', () => showModule(null));
document.getElementById('newevent').addEventListener('click', () => vscode.postMessage({ type:'newEvent' }));
window.addEventListener('message', (event) => { const m = event.data; if (m && m.type === 'openModule' && m.module === 'def') { showModule('def'); defApi.refresh(); } });
function reopenModule(mod) {
  if (mod === 'def') { showModule('def'); defApi.refresh(); }
  else if (mod === 'check') openCheck();
  else if (mod === 'sim') openSim();
}
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
