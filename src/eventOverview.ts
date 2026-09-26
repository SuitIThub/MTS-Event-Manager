import { lastColumn, trackColumn } from './panelPlacement';
import { jsonScript, newNonce, scriptSrc, scriptTag, webviewAssetRoots } from './webviewAssets';
import { webviewImageUri } from './webviewUri';
import { stringExprValue } from './stringExpr';
import * as vscode from 'vscode';
import { runEventCheck } from './eventCheck';
import { EventDefHeader, findEventDefs, itemKindOf } from './eventDef';
import { WorkspaceIndex } from './indexer';
import { parseLabelsInDocument } from './parseLabels';
import { getImageRoots } from './patternResolve';
import { PortraitStore } from './portraitStore';
import { showEventPreview } from './previewPanel';
import { decodeValue, PyCall } from './pyCall';
import { eventSelectorOutputs } from './selectorValues';
import { findUnderRoots } from './videoResolve';

/**
 * Overview of every event in the workspace (game + mods): grouped by pool, with
 * thumbnail, priority, a compact condition summary, the selector keys and — on demand —
 * the result of the event check. A click opens the event in the preview.
 */

interface OverviewRow {
  label: string;
  kind: string;
  priority: string;
  file: string;
  line: number;
  hasLabel: boolean;
  conditions: string;
  selectors: string;
  thumb: string;
}

let panel: vscode.WebviewPanel | undefined;

/** `TimeCondition(weekday="d", daytime="c")` → `Time weekday=d daytime=c`. */
function summarize(call: PyCall): string {
  const name = call.name.replace(/Condition$/, '');
  if (/^(AND|OR|NOT|NOR|XOR)$/.test(call.name)) {
    return `${call.name}(${call.args.filter((a) => a.call).map((a) => summarize(a.call!)).join(', ')})`;
  }
  const args = call.args
    .map((a) => {
      if (a.call) {
        return summarize(a.call);
      }
      const d = decodeValue(a.value);
      const v = d.kind === 'string' || d.kind === 'number' || d.kind === 'bool' ? d.value : a.value.trim();
      return a.name ? `${a.name}=${v}` : v;
    })
    .join(' ');
  return args ? `${name} ${args}` : name;
}

async function collectRows(index: WorkspaceIndex, webview: vscode.Webview): Promise<{ groups: { name: string; labels: string[] }[]; rows: Record<string, OverviewRow> }> {
  const roots = await getImageRoots();
  const schemaOf = (n: string) => index.getSchema(n);
  const rows: Record<string, OverviewRow> = {};
  const byUri = new Map<string, vscode.Uri>();
  for (const ev of index.getAllEvents()) {
    byUri.set(ev.uri.toString(), ev.uri);
  }
  for (const uri of byUri.values()) {
    const text = (await vscode.workspace.openTextDocument(uri)).getText();
    let headers: EventDefHeader[] = [];
    try {
      headers = findEventDefs(text);
    } catch {
      headers = [];
    }
    for (const h of headers) {
      const label = h.labelName!;
      if (rows[label]) {
        continue;
      }
      const conds = h.call.args.filter((a) => !a.name && !a.star && a.call && itemKindOf(a, schemaOf) === 'condition').map((a) => summarize(a.call!));
      const thumbArg = h.call.args.find((a) => a.name === 'thumbnail');
      // Literal or `base_path + "…"` (resolved statically; anything dynamic shows no thumbnail).
      const thumbRel = thumbArg ? stringExprValue(text, thumbArg.value, h.call.start) : undefined;
      const thumbFile = thumbRel ? findUnderRoots(thumbRel, roots) : undefined;
      const lab = index.getLabel(label);
      rows[label] = {
        label,
        kind: h.kind,
        priority: h.priority?.trim() ?? '',
        file: vscode.workspace.asRelativePath(lab?.uri ?? uri),
        line: lab ? lab.range.start.line : 0,
        hasLabel: !!lab,
        conditions: conds.join(' · '),
        selectors: [...new Set(eventSelectorOutputs(text, h.call).map((o) => o.key))].join(', '),
        thumb: webviewImageUri(webview, thumbFile),
      };
    }
  }
  const inPool = new Set<string>();
  const groups: { name: string; labels: string[] }[] = [];
  for (const [pool, labels] of [...index.getAllPools().entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const present = labels.filter((l) => rows[l]);
    present.forEach((l) => inPool.add(l));
    if (present.length) {
      groups.push({ name: pool, labels: present });
    }
  }
  const rest = Object.keys(rows).filter((l) => !inPool.has(l)).sort();
  if (rest.length) {
    groups.push({ name: '(not in a pool)', labels: rest });
  }
  return { groups, rows };
}

export async function showEventOverview(context: vscode.ExtensionContext, index: WorkspaceIndex, store: PortraitStore): Promise<void> {
  if (panel) {
    panel.reveal();
    await publish(index, panel);
    return;
  }
  const roots = [...(await getImageRoots()).map((r) => vscode.Uri.file(r)), ...webviewAssetRoots()];
  adoptOverview(context, index, store, vscode.window.createWebviewPanel('mtsEventOverview', 'MTS Events', lastColumn(context, 'overview', vscode.ViewColumn.Active), {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: roots,
  }));
}

/** Reopens the overview after a window reload. */
export function registerOverviewSerializer(context: vscode.ExtensionContext, index: WorkspaceIndex, store: PortraitStore): vscode.Disposable {
  return vscode.window.registerWebviewPanelSerializer('mtsEventOverview', {
    async deserializeWebviewPanel(restored: vscode.WebviewPanel) {
      if (panel) {
        restored.dispose();
        return;
      }
      restored.webview.options = { enableScripts: true, localResourceRoots: [...(await getImageRoots()).map((r) => vscode.Uri.file(r)), ...webviewAssetRoots()] };
      adoptOverview(context, index, store, restored);
    },
  });
}

function adoptOverview(context: vscode.ExtensionContext, index: WorkspaceIndex, store: PortraitStore, created: vscode.WebviewPanel): void {
  panel = created;
  trackColumn(context, 'overview', created);
  context.subscriptions.push(created);
  created.onDidDispose(() => {
    if (panel === created) {
      panel = undefined;
    }
  });
  created.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
    if (msg.type === 'open') {
      const lab = index.getLabel(String(msg.label ?? ''));
      if (lab) {
        await showEventPreview(context, index, store, lab.uri, lab.range.start.line);
      } else {
        void vscode.window.showWarningMessage(`The scene label ${String(msg.label)} does not exist.`);
      }
    } else if (msg.type === 'refresh') {
      await publish(index, created);
    } else if (msg.type === 'check') {
      await checkLabels(index, created, (msg.labels as string[]) ?? []);
    }
  });
  const idxSub = index.onDidChange(() => void publish(index, created));
  created.onDidDispose(() => idxSub.dispose());
  // Listener first, then the page: its 'refresh' on load fetches the rows.
  created.webview.html = overviewHtml(created.webview);
}

/** Latest refresh wins: a slower, older collection never overwrites a newer one. */
let publishGen = 0;

async function publish(index: WorkspaceIndex, target: vscode.WebviewPanel): Promise<void> {
  const gen = ++publishGen;
  const { groups, rows } = await collectRows(index, target.webview);
  if (gen !== publishGen) {
    return;
  }
  await target.webview.postMessage({ type: 'overview', groups, rows });
}

/** Run the event check per label and stream the counts back. */
async function checkLabels(index: WorkspaceIndex, target: vscode.WebviewPanel, labels: string[]): Promise<void> {
  const docs = new Map<string, { text: string; labels: ReturnType<typeof parseLabelsInDocument> }>();
  for (const name of labels) {
    const lab = index.getLabel(name);
    if (!lab) {
      await target.webview.postMessage({ type: 'status', label: name, error: 'no label' });
      continue;
    }
    const key = lab.uri.toString();
    let d = docs.get(key);
    if (!d) {
      const text = (await vscode.workspace.openTextDocument(lab.uri)).getText();
      d = { text, labels: parseLabelsInDocument(lab.uri, text) };
      docs.set(key, d);
    }
    try {
      const r = await runEventCheck(index, lab.uri, d.text, d.labels, lab.range.start.line);
      await target.webview.postMessage({
        type: 'status',
        label: name,
        errors: r.issues.filter((i) => i.severity === 'error').length,
        warnings: r.issues.filter((i) => i.severity === 'warning').length,
        missing: r.coverage.reduce((n, c) => n + c.missing, 0),
        paths: r.paths.length,
        first: r.issues.find((i) => i.severity !== 'info')?.message ?? '',
      });
    } catch (e) {
      await target.webview.postMessage({ type: 'status', label: name, error: String(e) });
    }
  }
  await target.webview.postMessage({ type: 'checkDone' });
}

export function renderOverviewHtml(webview: Pick<vscode.Webview, 'cspSource' | 'asWebviewUri'>): string {
  return overviewHtml(webview);
}

function overviewHtml(webview: Pick<vscode.Webview, 'cspSource' | 'asWebviewUri'>): string {
  const nonce = newNonce();
  const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline'; ${scriptSrc(nonce)};`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  body { margin: 0; padding: 8px 12px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 12px; }
  .bar { position: sticky; top: 0; z-index: 2; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 6px 0; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
  .bar input { flex: 1 1 220px; min-width: 0; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; border-radius: 3px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 3px 9px; cursor: pointer; border-radius: 3px; }
  button.alt { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .muted { color: var(--vscode-descriptionForeground); }
  .group { margin-top: 10px; }
  .group h3 { margin: 4px 0; font-size: 12px; cursor: pointer; font-family: var(--vscode-editor-font-family); }
  .rows { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 6px; }
  .row { display: flex; gap: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 5px; background: var(--vscode-editorWidget-background); cursor: pointer; min-width: 0; }
  .row:hover { border-color: var(--vscode-focusBorder); }
  .thumb { width: 96px; height: 54px; flex: 0 0 auto; object-fit: cover; border-radius: 3px; background: #161616; }
  .info { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
  .name { font-weight: 600; font-family: var(--vscode-editor-font-family); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta, .conds, .sels { font-size: 11px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status { font-size: 11px; }
  .status.bad { color: var(--vscode-errorForeground); }
  .status.warn { color: var(--vscode-editorWarning-foreground); }
  .status.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
</style>
</head>
<body>
<div class="bar">
  <input id="filter" placeholder="Filter by label, pool, condition, file…" />
  <button class="alt" id="onlybad" title="Show only events with problems (after a check)">⚠ only problems</button>
  <button id="checkall" title="Run the event check on every visible event">🩺 Check visible</button>
  <button class="alt" id="refresh" title="Reload">↻</button>
  <span class="muted" id="count"></span>
</div>
<div id="list"></div>
${scriptTag(webview, 'overview', nonce)}
</body>
</html>`;
}
