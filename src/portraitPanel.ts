import * as fs from 'fs';
import { jsonScript, newNonce, scriptSrc, scriptTag, webviewAssetRoots } from './webviewAssets';
import * as path from 'path';
import * as vscode from 'vscode';
import { loadSharp } from './sharpRuntime';
import { WorkspaceIndex } from './indexer';
import { personDisplayName } from './parsePersons';
import { PortraitStore } from './portraitStore';

let panel: vscode.WebviewPanel | undefined;

export function showPortraitPanel(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore
): void {
  if (panel) {
    panel.reveal(undefined, false);
    void refresh(panel, context, index, store);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'mtsCustomPortraits',
    'MTS Portraits',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: webviewAssetRoots(),
    }
  );
  const idxSub = index.onDidChange(() => {
    if (panel) {
      void refresh(panel, context, index, store);
    }
  });
  panel.onDidDispose(() => {
    panel = undefined;
    idxSub.dispose();
  });
  context.subscriptions.push(panel);

  const sub = panel.webview.onDidReceiveMessage(async (msg) => {
    if (!panel) {
      return;
    }
    if (msg?.type === 'pick') {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { Images: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
        title: 'Select portrait image',
      });
      const file = picked?.[0];
      if (file) {
        await panel.webview.postMessage({ type: 'picked', path: file.fsPath });
      }
      return;
    }
    if (msg?.type === 'save' && typeof msg.key === 'string' && typeof msg.path === 'string') {
      const err = await store.upsert(msg.key, msg.path);
      if (err) {
        void vscode.window.showErrorMessage(err);
        return;
      }
      await refresh(panel, context, index, store);
      return;
    }
    if (msg?.type === 'remove' && typeof msg.key === 'string') {
      await store.remove(msg.key);
      await refresh(panel, context, index, store);
    }
  });
  context.subscriptions.push(sub);

  void refresh(panel, context, index, store);
}

async function refresh(
  target: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore
): Promise<void> {
  const personIndex = index.getPersonIndex();
  const knownKeys = [...personIndex.byKey.keys()].sort();
  const custom = store.list();
  const customKeys = new Set(custom.map((c) => c.key));

  const customRows = await Promise.all(
    custom.map(async (c) => ({
      key: c.key,
      path: c.path,
      name: personDisplayName(c.key, personIndex),
      thumb: await thumbDataUri(c.path),
      missing: !fs.existsSync(c.path),
    }))
  );

  const bundledDir = context.asAbsolutePath('assets');
  const bundled: { key: string; name: string; thumb: string }[] = [];
  if (fs.existsSync(bundledDir)) {
    for (const name of fs.readdirSync(bundledDir).sort()) {
      const ext = path.extname(name).toLowerCase();
      if (ext !== '.png' && ext !== '.jpg' && ext !== '.jpeg' && ext !== '.webp') {
        continue;
      }
      const key = path.basename(name, ext);
      if (customKeys.has(key)) {
        continue;
      }
      bundled.push({
        key,
        name: personDisplayName(key, personIndex),
        thumb: await thumbDataUri(path.join(bundledDir, name)),
      });
    }
  }

  target.webview.html = buildHtml(target.webview, {
    knownKeys,
    custom: customRows,
    bundled,
    workspace: !!vscode.workspace.workspaceFolders?.length,
  });
}

async function thumbDataUri(fsPath: string): Promise<string> {
  try {
    if (!fs.existsSync(fsPath)) {
      return '';
    }
    const sharp = await loadSharp();
    if (!sharp) {
      return '';
    }
    const buf = await sharp(fsPath).resize(40, 40, { fit: 'cover' }).png().toBuffer();
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

function buildHtml(webview: vscode.Webview, data: {
    knownKeys: string[];
    custom: { key: string; path: string; name: string; thumb: string; missing: boolean }[];
    bundled: { key: string; name: string; thumb: string }[];
    workspace: boolean;
  }
): string {
  const nonce = newNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; ${scriptSrc(nonce)};" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 16px; }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 6px; }
  .hint { opacity: 0.75; font-size: 12px; margin-bottom: 16px; line-height: 1.4; }
  form { display: grid; grid-template-columns: 1fr 1fr auto auto; gap: 8px; align-items: end; margin-bottom: 20px; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
  input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 6px 8px; font-family: var(--vscode-editor-font-family); }
  button { cursor: pointer; padding: 6px 12px; }
  h2 { font-size: 13px; margin: 18px 0 8px; }
  .row { display: grid; grid-template-columns: 40px 1fr auto; gap: 10px; align-items: center; padding: 8px 0; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25)); }
  .row img { width: 40px; height: 40px; object-fit: cover; border-radius: 3px; background: rgba(0,0,0,0.25); }
  .ph { width: 40px; height: 40px; border-radius: 3px; background: rgba(128,128,128,0.25); }
  .meta { min-width: 0; }
  .key { font-family: var(--vscode-editor-font-family); font-weight: 600; }
  .path, .name { font-size: 11px; opacity: 0.75; word-break: break-all; }
  .missing { color: var(--vscode-errorForeground); }
  .empty { opacity: 0.6; font-size: 12px; }
</style>
</head>
<body>
  <h1>Custom portraits</h1>
  <p class="hint" id="hint"></p>
  <form id="form">
    <label>Character key
      <input id="key" list="keys" placeholder="sakura_mori" autocomplete="off" />
    </label>
    <label>Image path
      <input id="path" placeholder="C:\\images\\sakura.png" />
    </label>
    <button type="button" id="browse">Browse…</button>
    <button type="submit">Save</button>
  </form>
  <datalist id="keys"></datalist>
  <h2>Your portraits</h2>
  <div id="custom"></div>
  <h2>Bundled</h2>
  <div id="bundled"></div>
${jsonScript('payload', data)}
${scriptTag(webview, 'portraitPanel', nonce)}
</body>
</html>`;
}
