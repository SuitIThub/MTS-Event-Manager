import { lastColumn, trackColumn } from './panelPlacement';
import { jsonScript, newNonce, scriptSrc, scriptTag, webviewAssetRoots } from './webviewAssets';
import * as vscode from 'vscode';
import { WorkspaceIndex } from './indexer';
import { PaperdollEditor } from './paperdollEditor';
import { getImageRoots } from './patternResolve';

let panel: vscode.WebviewPanel | undefined;
let editor: PaperdollEditor | undefined;
let cursorWatch: vscode.Disposable | undefined;

/**
 * Standalone paperdoll call editor. A thin webview host around {@link PaperdollEditor},
 * which also powers the paperdoll marker inside the event preview.
 */
export async function showPaperdollEditor(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  uri?: vscode.Uri,
  line?: number,
  character?: number
): Promise<void> {
  const active = vscode.window.activeTextEditor;
  const targetUri = uri ?? active?.document.uri;
  if (!targetUri) {
    void vscode.window.showWarningMessage('Open an event script first.');
    return;
  }
  const anchorLine = line ?? active?.selection.active.line ?? 0;
  const anchorChar = character ?? active?.selection.active.character ?? 0;

  if (!editor) {
    editor = new PaperdollEditor(context);
  }
  editor.setAnchor(targetUri, anchorLine, anchorChar);

  if (!cursorWatch) {
    cursorWatch = vscode.window.onDidChangeTextEditorSelection((event) => {
      const pos = event.selections[0]?.active;
      if (pos && editor) {
        editor.setCursor(event.textEditor.document.uri, pos.line, pos.character);
      }
    });
    context.subscriptions.push(cursorWatch);
  }

  if (panel) {
    panel.reveal(undefined, false);
    await editor.publish(panel.webview, index);
    return;
  }

  const roots = [...(await getImageRoots()).map((r) => vscode.Uri.file(r)), ...webviewAssetRoots()];
  panel = vscode.window.createWebviewPanel('mtsPaperdoll', 'MTS Paperdoll', { viewColumn: lastColumn(context, 'paperdoll', vscode.ViewColumn.Beside), preserveFocus: false }, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: roots,
  });
  const created = panel;
  trackColumn(context, 'paperdoll', created);
  context.subscriptions.push(created);
  created.onDidDispose(() => {
    if (panel === created) {
      panel = undefined;
    }
  });
  created.webview.onDidReceiveMessage((msg) => {
    if (msg && msg.type === 'ready') {
      // Page (re)loaded — e.g. after moving the panel into another window.
      if (editor) {
        void editor.publish(created.webview, index);
      }
      return;
    }
    if (editor) {
      void editor.handleMessage(created.webview, index, msg);
    }
  });
  created.webview.html = html(created.webview);
  await editor.publish(created.webview, index);
}

function html(webview: vscode.Webview): string {
  const nonce = newNonce();
  const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline'; ${scriptSrc(nonce)};`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 12px; }
  .host { display: flex; flex-direction: column; height: 100vh; min-height: 0; }
  .host .pd-root { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; padding: 8px 10px; overflow: auto; }
  .host .pd-stage-frame { flex: 1 1 auto; height: auto; min-height: 160px; }
  ${PaperdollEditor.styles()}
</style>
</head>
<body>
<div class="host">
  ${PaperdollEditor.controlsHtml()}
</div>
${jsonScript('pd-fields', PaperdollEditor.clientFields())}
${scriptTag(webview, 'paperdollPanel', nonce)}
</body>
</html>`;
}
