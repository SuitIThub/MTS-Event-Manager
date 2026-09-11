import * as path from 'path';
import * as vscode from 'vscode';
import { formatPatternParams } from './patternResolve';
import { ResolvedImageInfo } from './types';

let panel: vscode.WebviewPanel | undefined;

export function showImagePreviewCarousel(
  title: string,
  images: ResolvedImageInfo[],
  context: vscode.ExtensionContext
): void {
  if (images.length === 0) {
    void vscode.window.showWarningMessage('No matching images found for this call.');
    return;
  }

  const roots = rootsForImages(images.map((i) => i.uri));

  if (panel) {
    panel.dispose();
    panel = undefined;
  }

  panel = vscode.window.createWebviewPanel(
    'mtsImagePreview',
    title,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: roots,
    }
  );
  panel.onDidDispose(() => {
    panel = undefined;
  });
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type === 'open' && typeof msg.path === 'string') {
      const uri = vscode.Uri.file(msg.path);
      await vscode.commands.executeCommand('revealInExplorer', uri);
    }
  });
  context.subscriptions.push(panel);

  const webview = panel.webview;
  const items = images.map((info) => ({
    src: webview.asWebviewUri(info.uri).toString(),
    name: info.fileName,
    path: info.fsPath,
    relativePath: info.relativePath,
    params: formatPatternParams(info.params),
    patternKey: info.patternKey ?? '',
  }));

  panel.webview.html = buildHtml(webview, title, items);
}

function rootsForImages(uris: vscode.Uri[]): vscode.Uri[] {
  const map = new Map<string, vscode.Uri>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    map.set(folder.uri.fsPath, folder.uri);
  }
  for (const u of uris) {
    let dir = path.dirname(u.fsPath);
    for (let i = 0; i < 12; i++) {
      if (path.basename(dir).toLowerCase() === 'game') {
        map.set(dir, vscode.Uri.file(dir));
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        map.set(dir, vscode.Uri.file(dir));
        break;
      }
      dir = parent;
    }
  }
  return [...map.values()];
}

function buildHtml(
  webview: vscode.Webview,
  title: string,
  items: {
    src: string;
    name: string;
    path: string;
    relativePath: string;
    params: string;
    patternKey: string;
  }[]
): string {
  const payload = JSON.stringify(items).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 12px; }
  .layout { display: flex; gap: 16px; align-items: flex-start; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  button { cursor: pointer; padding: 4px 10px; }
  #side { min-width: 220px; max-width: 340px; font-size: 12px; line-height: 1.45; word-break: break-word; }
  #side .label { opacity: 0.7; font-size: 11px; margin-top: 10px; }
  #side .value { font-family: var(--vscode-editor-font-family); }
  #params { white-space: pre-line; }
  #frame { flex: 1; display: flex; justify-content: center; align-items: center; min-height: 60vh; background: rgba(0,0,0,0.2); border-radius: 4px; padding: 8px; }
  img { max-width: 100%; max-height: 75vh; object-fit: contain; }
</style>
</head>
<body>
  <div class="toolbar">
    <strong>${escapeHtml(title)}</strong>
    <button id="prev" type="button">Prev</button>
    <button id="next" type="button">Next</button>
    <span id="counter"></span>
    <button id="open" type="button">Reveal in Explorer</button>
  </div>
  <div class="layout">
    <div id="frame"><img id="img" alt="preview" /></div>
    <div id="side">
      <div class="label">File</div>
      <div class="value" id="name"></div>
      <div class="label">Path</div>
      <div class="value" id="rel"></div>
      <div class="label">Full path</div>
      <div class="value" id="full"></div>
      <div class="label">Parameters</div>
      <div class="value" id="params"></div>
      <div class="label">Pattern</div>
      <div class="value" id="pattern"></div>
    </div>
  </div>
  <script>
    const items = ${payload};
    const vscode = acquireVsCodeApi();
    let i = 0;
    const img = document.getElementById('img');
    const counter = document.getElementById('counter');
    function render() {
      if (!items.length) return;
      const it = items[i];
      img.src = it.src;
      counter.textContent = (i + 1) + ' / ' + items.length;
      document.getElementById('name').textContent = it.name || '—';
      document.getElementById('rel').textContent = it.relativePath || '—';
      document.getElementById('full').textContent = it.path || '—';
      document.getElementById('params').textContent = it.params || '(none)';
      document.getElementById('pattern').textContent = it.patternKey || '—';
    }
    document.getElementById('prev').onclick = () => { i = (i - 1 + items.length) % items.length; render(); };
    document.getElementById('next').onclick = () => { i = (i + 1) % items.length; render(); };
    document.getElementById('open').onclick = () => {
      if (items[i]) vscode.postMessage({ type: 'open', path: items[i].path });
    };
    window.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') document.getElementById('prev').click();
      if (e.key === 'ArrowRight') document.getElementById('next').click();
    });
    render();
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
