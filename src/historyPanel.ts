import * as vscode from 'vscode';
import { clearHistory, getEntry, getHistory, hunkState, locateRegion, onDidChangeHistory } from './editHistory';
import { revertBlocks } from './historyOps';
import { lastColumn, trackColumn } from './panelPlacement';
import { newNonce, scriptSrc, scriptTag, webviewAssetRoots } from './webviewAssets';

/**
 * "MTS: Change History": every code change the extension made, newest first, as a diff per
 * block — each block (or a whole change) can be reverted, or shown in the code.
 */

let panel: vscode.WebviewPanel | undefined;
const MAX_LINES_SHOWN = 120;
const VIEW_TYPE = 'mtsChangeHistory';

export function showHistoryPanel(context: vscode.ExtensionContext, focusFile?: vscode.Uri): void {
  if (panel) {
    panel.reveal(undefined, false);
    void publish(panel, focusFile);
    return;
  }
  const created = vscode.window.createWebviewPanel(VIEW_TYPE, 'MTS Change History', lastColumn(context, 'history', vscode.ViewColumn.Beside), {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: webviewAssetRoots(),
  });
  adoptHistory(context, created, focusFile);
}

/**
 * Moving the panel into another window (or reloading VS Code) rebuilds the webview: VS Code
 * hands it back through this serializer, and the page asks for its data again ('ready').
 */
export function registerHistorySerializer(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
    async deserializeWebviewPanel(restored: vscode.WebviewPanel) {
      if (panel && panel !== restored) {
        restored.dispose();
        panel.reveal(undefined, false);
        return;
      }
      restored.webview.options = { enableScripts: true, localResourceRoots: webviewAssetRoots() };
      adoptHistory(context, restored);
    },
  });
}

function adoptHistory(context: vscode.ExtensionContext, created: vscode.WebviewPanel, focusFile?: vscode.Uri): void {
  panel = created;
  trackColumn(context, 'history', created);
  context.subscriptions.push(created);
  let timer: NodeJS.Timeout | undefined;
  const refresh = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => void publish(created), 300);
  };
  const subs = [
    onDidChangeHistory(refresh),
    // Block states follow the files (Ctrl+Z, manual edits).
    vscode.workspace.onDidChangeTextDocument((e) => {
      const key = e.document.uri.toString();
      if (getHistory().some((h) => h.uri === key)) {
        refresh();
      }
    }),
  ];
  created.onDidDispose(() => {
    subs.forEach((s) => s.dispose());
    if (timer) {
      clearTimeout(timer);
    }
    if (panel === created) {
      panel = undefined;
    }
  });
  created.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type === 'ready' || msg?.type === 'refresh') {
      await publish(created, focusFile);
    } else if (msg?.type === 'revert') {
      const hunks = Array.isArray(msg.hunks) ? (msg.hunks as unknown[]).map(Number).filter((n) => Number.isInteger(n)) : undefined;
      const error = await revertBlocks(Number(msg.id), hunks);
      if (error) {
        void vscode.window.showWarningMessage(error);
      }
      await publish(created);
    } else if (msg?.type === 'reveal') {
      await reveal(Number(msg.id), Number(msg.hunk ?? 0));
    } else if (msg?.type === 'clear') {
      const ok = await vscode.window.showWarningMessage('Clear the change history of this workspace? The code stays as it is.', { modal: true }, 'Clear');
      if (ok === 'Clear') {
        clearHistory();
      }
    }
  });
  // Listener first, then the page: its 'ready' on load fetches the entries.
  created.webview.html = html(created.webview);
}

async function reveal(id: number, hunk: number): Promise<void> {
  const entry = getEntry(id);
  const h = entry?.hunks[hunk];
  if (!entry || !h) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri));
  const cur = doc.getText();
  const at = locateRegion(cur, h) ?? locateRegion(cur, { ...h, afterSeg: h.beforeSeg });
  const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
  const start = doc.positionAt(at ?? Math.min(h.offset, cur.length));
  const end = at !== undefined ? doc.positionAt(at + (locateRegion(cur, h) !== undefined ? h.afterSeg.length : h.beforeSeg.length)) : start;
  editor.selection = new vscode.Selection(start, end);
  editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
}

const lines = (seg: string): string[] => {
  if (!seg) {
    return [];
  }
  const out = seg.replace(/\r/g, '').split('\n');
  if (out[out.length - 1] === '') {
    out.pop();
  }
  return out;
};

async function publish(target: vscode.WebviewPanel, focusFile?: vscode.Uri): Promise<void> {
  const texts = new Map<string, string | undefined>();
  const textOf = async (uri: string) => {
    if (!texts.has(uri)) {
      try {
        texts.set(uri, (await vscode.workspace.openTextDocument(vscode.Uri.parse(uri))).getText());
      } catch {
        texts.set(uri, undefined);
      }
    }
    return texts.get(uri);
  };
  const history = getHistory();
  const view = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    const cur = await textOf(e.uri);
    const clip = (l: string[]) => (l.length > MAX_LINES_SHOWN ? [...l.slice(0, MAX_LINES_SHOWN), `… ${l.length - MAX_LINES_SHOWN} more lines`] : l);
    view.push({
      id: e.id,
      label: e.label,
      time: e.time,
      file: vscode.workspace.asRelativePath(vscode.Uri.parse(e.uri)),
      uri: e.uri,
      revertOf: e.revertOf,
      hunks: e.hunks.map((h, index) => ({
        index,
        line: h.line,
        state: cur === undefined ? 'changed' : hunkState(cur, h),
        removed: clip(lines(h.beforeSeg)),
        added: clip(lines(h.afterSeg)),
        before: h.linesBefore.map((l) => l.replace(/\r$/, '')),
        after: h.linesAfter.map((l) => l.replace(/\r$/, '')),
      })),
    });
  }
  await target.webview.postMessage({ type: 'history', entries: view, focusFile: focusFile ? focusFile.toString() : undefined });
}

function html(webview: vscode.Webview): string {
  const nonce = newNonce();
  const csp = `default-src 'none'; style-src 'unsafe-inline'; ${scriptSrc(nonce)};`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 10px 14px; }
  .bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; position: sticky; top: 0; padding: 6px 0 8px; background: var(--vscode-editor-background); z-index: 2; }
  .bar .grow { flex: 1; }
  select, button { font: inherit; color: var(--vscode-foreground); }
  select { background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, transparent); padding: 2px 4px; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 3px 9px; border-radius: 2px; cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:disabled { opacity: .45; cursor: default; }
  .empty { opacity: .7; margin-top: 30px; text-align: center; }
  .entry { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); border-radius: 4px; margin: 10px 0; }
  .head { display: flex; gap: 8px; align-items: center; padding: 6px 8px; background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,.08)); cursor: pointer; }
  .head .label { font-weight: 600; }
  .head .meta { opacity: .75; font-size: 12px; }
  .badge { font-size: 11px; padding: 0 6px; border-radius: 8px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4)); opacity: .9; }
  .badge.reverted { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
  .badge.changed { color: var(--vscode-editorWarning-foreground, #cca700); }
  .body { padding: 4px 8px 8px; }
  .collapsed .body { display: none; }
  .hunk { margin-top: 8px; }
  .hunkbar { display: flex; gap: 8px; align-items: center; margin-bottom: 3px; font-size: 12px; }
  .hunkbar .where { opacity: .8; }
  pre { margin: 0; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size, 12px); overflow-x: auto; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); }
  .ln { display: block; white-space: pre; padding: 0 6px; }
  .ln.ctx { opacity: .6; }
  .ln.del { background: var(--vscode-diffEditor-removedLineBackground, var(--vscode-diffEditor-removedTextBackground, rgba(255,0,0,.18))); }
  .ln.add { background: var(--vscode-diffEditor-insertedLineBackground, var(--vscode-diffEditor-insertedTextBackground, rgba(0,200,0,.16))); }
  .hunk.state-reverted pre, .hunk.state-changed pre { opacity: .55; }
</style>
</head>
<body>
<div class="bar">
  <label>File <select id="file"></select></label>
  <label><input type="checkbox" id="hideReverted" /> Hide reverted</label>
  <span class="grow"></span>
  <span id="count" class="meta"></span>
  <button id="clear" title="Forget the recorded changes (the code is not touched)">Clear history</button>
</div>
<div id="list"></div>
${scriptTag(webview, 'history', nonce)}
</body>
</html>`;
}
