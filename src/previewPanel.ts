import { lastColumn, trackColumn } from './panelPlacement';
import { jsonScript, newNonce, scriptSrc, scriptTag, webviewAssetRoots } from './webviewAssets';
import * as vscode from 'vscode';
import { resolveSiteImages } from './codeLens';
import { BranchPoint, buildEventTimeline, ImageRef, stopIndexForLine, TimelineMarker, videoPauseFlag } from './eventTimeline';
import { isLevelKey, paramConstraintsForLine } from './paramConstraints';
import { WorkspaceIndex } from './indexer';
import { imageCallValues, labelAtLine, resolveConvertForVariable, resolvePatternKeyForVariable, topLevelLabelSpan } from './parseImageCalls';
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
import { undoLast } from './editHistory';
import { offsetToPosition, readStringLiteral } from './scan';
import { chainBounds, isSayLine, locateLineIn, PAUSE_LINE_RE } from './lineTools';
import { ImageCallSite, LabelDefinition } from './types';
import { parseLabelsInDocument } from './parseLabels';
import { planAddMenuChoice, planMoveStatement, planRemoveMenuChoice } from './sceneOps';
import { TextEdit } from './pyCall';
import { applyCheckedWorkspaceEdit, applyVerifiedEdits } from './safeEdit';
import { notifyActiveEvent } from './captureBridge';
import { FormatVariants, formatVariantsOf, webviewImageUri } from './webviewUri';
import { lineInsideString, statementEndLine } from './codeStructure';
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
import { BgSpec, parseBackgroundCall, planBackgroundEdit, planDeleteStatement, planRemoveLine } from './backgroundOps';
import { planDeleteSayPart, planRandomSayText, planSayText } from './randomSayOps';

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
  return [...imageRoots, ...portraitRoots(context, store), ...webviewAssetRoots()];
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
  // Images added / replaced / removed on disk (e.g. by the StudioNeoV2 capture plugin):
  // forget what was resolved and redraw — the versioned URLs make the webview reload them.
  const imageWatcher = vscode.workspace.createFileSystemWatcher('**/images/**/*.{png,webp,jpg,jpeg,gif,webm}');
  let imageTimer: NodeJS.Timeout | undefined;
  const onImages = () => {
    if (imageTimer) {
      clearTimeout(imageTimer);
    }
    imageTimer = setTimeout(() => {
      imageTimer = undefined;
      imgCache.clear();
      patternValueCache.clear();
      if (panel === created) {
        void publish(context, index, store, true).then(() => created.webview.postMessage({ type: 'imagesChanged' }));
      }
    }, 300);
  };
  const imageSubs = [imageWatcher, imageWatcher.onDidCreate(onImages), imageWatcher.onDidChange(onImages), imageWatcher.onDidDelete(onImages)];
  created.onDidDispose(() => {
    saveSub.dispose();
    idxSub.dispose();
    imageSubs.forEach((s) => s.dispose());
    if (imageTimer) {
      clearTimeout(imageTimer);
    }
    if (panel === created) {
      panel = undefined;
      notifyActiveEvent(undefined);
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
    await editDialogueText(context, index, store, Number(msg.line ?? 0), String(msg.text ?? ''), msg.part === undefined || msg.part === null ? undefined : Number(msg.part), typeof msg.expect === 'string' ? msg.expect : undefined);
    return;
  }
  if (msg.type === 'deleteStop') {
    await deleteStopLine(context, index, store, Number(msg.line ?? 0), msg.part === undefined || msg.part === null ? undefined : Number(msg.part), typeof msg.expect === 'string' ? msg.expect : undefined);
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
  ref.fixedValues = fixedValuesAt(doc, labels, line, hasStep ? variable : undefined);
  let preview: string | undefined;
  let previewVariants: FormatVariants | undefined;
  let videoView: VideoView | undefined;
  if (isVideo) {
    const r = await resolveVideo(index, doc, labels, { ...ref, kind: 'show_video', variableName: variable }, eventLabel, lastValues);
    preview = r.poster;
    videoView = r.video;
  } else {
    const info = await resolveImageInfo(index, doc, labels, ref, eventLabel, lastValues);
    preview = info ? uriOfPath(info.fsPath) : undefined;
    previewVariants = formatVariantsOf(info?.fsPath, info?.pathTemplate, uriOfPath);
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
    previewVariants,
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
  if (lineInsideString(text, line) || statementEndLine(text, line) !== line) {
    void vscode.window.showWarningMessage('This image statement spans several lines — change it in the code.');
    return;
  }
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
  const ok = await applyCheckedWorkspaceEdit(doc, edit, 'Timeline: update image');
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
  for (const [k, v] of Object.entries(fixedValuesAt(doc, labels, line, variable) ?? {})) {
    constraints[k] = [v];
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
  const anchorStart = Math.min(line, doc.lineCount - 1);
  if (lineInsideString(doc.getText(), anchorStart)) {
    void vscode.window.showWarningMessage('That position is inside a text — nothing was inserted.');
    return;
  }
  const indent = doc.lineAt(anchorStart).text.match(/^[ \t]*/)?.[0] ?? '    ';
  // After the END of the anchor statement (it may span several lines, e.g. random_say).
  const anchor = doc.lineAt(Math.min(statementEndLine(doc.getText(), anchorStart), doc.lineCount - 1));
  const bound = findConvertVar(doc.getText(), labels, key, anchor.lineNumber + 1);
  const rows = [`${indent}$ ${bound ?? 'image'}.show_video(0)`];
  if (!bound) {
    rows.unshift(`${indent}$ image = convert_pattern("${key}", **kwargs)`);
  }
  const edit = new vscode.WorkspaceEdit();
  edit.insert(doc.uri, anchor.range.end, `\n${rows.join('\n')}`);
  const ok = await applyCheckedWorkspaceEdit(doc, edit, 'Timeline: insert video');
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
  const anchorStart = Math.min(line, doc.lineCount - 1);
  if (lineInsideString(doc.getText(), anchorStart)) {
    void vscode.window.showWarningMessage('That position is inside a text — nothing was inserted.');
    return;
  }
  const indent = doc.lineAt(anchorStart).text.match(/^[ \t]*/)?.[0] ?? '    ';
  // Insert after the END of the statement: a stop can start a multi-line statement
  // (`$ random_say(` … `)`), and a new line inside it would break the script.
  const anchor = doc.lineAt(Math.min(statementEndLine(doc.getText(), anchorStart), doc.lineCount - 1));
  const snippet = insertSnippet(kind, indent, speaker);
  if (!snippet) {
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.insert(doc.uri, anchor.range.end, `\n${snippet.text}`);
  const ok = await applyCheckedWorkspaceEdit(doc, edit, `Timeline: insert ${snippet.label}`);
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
  newText: string,
  part?: number,
  expect?: string
): Promise<void> {
  if (!session) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  const text = doc.getText();
  const plan = planSayText(text, line, newText, part, expect);
  const error = 'error' in plan ? plan.error : await applyVerifiedEdits(doc.uri, text, plan.edits, 'Timeline: edit dialogue');
  if (error) {
    void vscode.window.showWarningMessage(error);
    return;
  }
  session.line = line;
  await publish(context, index, store);
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
  const ok = await applyCheckedWorkspaceEdit(doc, edit, 'Timeline: optimize event');
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
  line: number,
  part?: number,
  expect?: string
): Promise<void> {
  if (!session) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(session.uri);
  if (line >= doc.lineCount) {
    return;
  }
  if (part !== undefined) {
    // One say statement of a monologue ("""…""" split at blank lines): only that part goes.
    const partPlan = planDeleteSayPart(doc.getText(), line, part, expect);
    if (partPlan) {
      const err = 'error' in partPlan ? partPlan.error : await applyVerifiedEdits(doc.uri, doc.getText(), partPlan.edits, 'Timeline: delete line');
      if (err) {
        void vscode.window.showWarningMessage(err);
        return;
      }
      session.line = line;
      await publish(context, index, store);
      return;
    }
  }
  const row = doc.lineAt(line).text;
  if (!isDialogueAt(doc, line) && (lineInsideString(doc.getText(), line) || !PAUSE_LINE_RE.test(row))) {
    void vscode.window.showWarningMessage('Only dialogue and pause lines can be deleted here — nothing was changed.');
    return;
  }
  const plan = planDeleteStatement(doc.getText(), line);
  const error = await applyVerifiedEdits(doc.uri, doc.getText(), plan.edits, 'Timeline: delete line');
  if (error) {
    void vscode.window.showWarningMessage(error);
    return;
  }
  if (plan.replacedWithPass) {
    void vscode.window.showInformationMessage('That was the only statement of its block — it was replaced with `pass` so the script stays valid.');
  }
  session.line = Math.max(0, line - 1);
  await publish(context, index, store);
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
  // Inside a monologue (""" … """ split into several say statements): the part the line belongs to.
  const within = inLabel.filter((s) => s.partLine !== undefined && s.line <= line && s.partLine <= line);
  const owner = within.length ? within[within.length - 1] : undefined;
  if (owner && !inLabel.some((s) => s.line > owner.line && s.line <= line)) {
    return owner.index;
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
  'movieAdd',
  'movieLoop',
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

/** A real dialogue statement (not a text line inside a multi-line """ string). */
function isDialogueAt(doc: vscode.TextDocument, line: number): boolean {
  return line < doc.lineCount && !lineInsideString(doc.getText(), line) && isSayLine(doc.lineAt(line).text);
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
  if (!isDialogueAt(doc, line)) {
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
  const ok = await applyCheckedWorkspaceEdit(doc, edit, 'Timeline: change speaker');
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
  if (!isDialogueAt(doc, line)) {
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
  const ok = await applyCheckedWorkspaceEdit(doc, edit, 'Timeline: change dialogue type');
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
  const ok = await applyCheckedWorkspaceEdit(doc, edit, 'Timeline: edit menu choice');
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
  /** The CG exists as PNG and WEBP: both URLs, which is newer, which the game loads. */
  cgVariants?: FormatVariants;
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
  /** Monologue part (one of several say statements of a triple-quoted text). */
  part?: number;
  partCount?: number;
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
/**
 * Publishes run one at a time: a request while one is running is queued, and further
 * requests merge into that queued run (it reads the latest document and session). So an
 * older, slower run can never post its timeline after a newer one.
 */
let publishChain: Promise<void> = Promise.resolve();
let publishQueued: { keep: boolean; done: Promise<void> } | undefined;

function publish(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore,
  keepPosition = false
): Promise<void> {
  if (publishQueued) {
    // Any request that moves the position wins over "keep".
    publishQueued.keep = publishQueued.keep && keepPosition;
    return publishQueued.done;
  }
  const queued: { keep: boolean; done: Promise<void> } = { keep: keepPosition, done: Promise.resolve() };
  queued.done = publishChain.then(() => {
    if (publishQueued === queued) {
      publishQueued = undefined;
    }
    return publishNow(context, index, store, queued.keep);
  });
  publishQueued = queued;
  publishChain = queued.done.catch(() => undefined);
  return queued.done;
}

async function publishNow(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore,
  keepPosition: boolean
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
  notifyActiveEvent(timeline.eventLabel ? { uri: session.uri, line: session.line, event: timeline.eventLabel } : undefined);
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
    let cgVariants: FormatVariants | undefined;
    let video: VideoView | undefined;
    if (stop.image?.kind === 'show_video') {
      const r = await resolveVideo(index, doc, labels, stop.image, timeline.eventLabel, timeline.values);
      cg = r.poster;
      video = r.video;
    } else if (stop.image && !stop.image.legacy) {
      const info = await resolveImageInfo(index, doc, labels, stop.image, timeline.eventLabel, timeline.values);
      cg = info ? uriOfPath(info.fsPath) : undefined;
      cgVariants = formatVariantsOf(info?.fsPath, info?.pathTemplate, uriOfPath);
    }
    if (pdBg) {
      // image.show clears the paperdoll scene, so a paperdoll background at this stop was
      // set after the last scene image — it is what the stop shows (blurred, split, bw).
      cg = undefined;
      cgVariants = undefined;
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
      part: stop.part,
      partCount: stop.partCount,
      alternatives,
      names,
      portraits,
      cg,
      cgVariants,
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

/**
 * Values the image at `line` is fixed to by its binding call: `variable = convert_pattern(…,
 * {"girls": "x"})` before the line, or a `show_pattern(…, **with_values(…))` on it.
 */
function fixedValuesAt(doc: vscode.TextDocument, labels: ReturnType<WorkspaceIndex['getLabelsForUri']>, line: number, variable?: string): Record<string, string> | undefined {
  const text = doc.getText();
  if (variable) {
    return resolveConvertForVariable(text, labels, variable, line)?.values;
  }
  const row = line < doc.lineCount ? doc.lineAt(line).text : '';
  const at = row.indexOf('show_pattern');
  return at >= 0 && !lineInsideString(text, line) ? imageCallValues(text, doc.offsetAt(new vscode.Position(line, at))) : undefined;
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
  // Values the binding call fixes (convert_pattern data / with_values) win over everything.
  for (const [k, v] of Object.entries({ ...values, ...(ref.fixedValues ?? {}) })) {
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
  return webviewImageUri(panel.webview, fsPath);
}

/** Exported for the verify script, which checks the generated webview script. */
export function renderPreviewHtml(webview: Pick<vscode.Webview, 'cspSource' | 'asWebviewUri'>): string {
  return html(webview);
}

function html(webview: Pick<vscode.Webview, 'cspSource' | 'asWebviewUri'>): string {
  const nonce = newNonce();
  const csp = `default-src 'none'; img-src ${webview.cspSource} data:; media-src ${webview.cspSource}; style-src 'unsafe-inline'; ${scriptSrc(nonce)};`;
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
  .fmtbar { position: absolute; top: 6px; right: 6px; z-index: 6; display: flex; gap: 4px; align-items: center; padding: 3px 5px; border-radius: 4px; background: rgba(0,0,0,.6); font-size: 11px; }
  .fmtbtn { font-size: 11px; padding: 1px 6px; color: #ddd; background: transparent; border: 1px solid rgba(255,255,255,.35); border-radius: 3px; cursor: pointer; }
  .fmtbtn.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  .fmtinfo { color: #ddd; cursor: help; padding: 0 2px; }
  #imgfmt .fmtbar { position: static; display: inline-flex; margin-top: 4px; }
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
  .caption .mono-part { flex: 0 0 auto; font-size: 10px; padding: 0 5px; border-radius: 8px; opacity: 0.8; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4)); cursor: help; }
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
        <div class="img-frame"><img id="imgpreview" /><video id="imgvideo" muted autoplay playsinline style="display:none"></video></div><div id="imgfmt"></div>
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
${jsonScript('pd-fields', PaperdollEditor.clientFields())}
${scriptTag(webview, 'preview', nonce)}
</body>
</html>`;
}
