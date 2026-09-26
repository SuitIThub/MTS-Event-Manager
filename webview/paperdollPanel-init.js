// Webview script (paperdollPanel-init.js). Plain browser JavaScript, bundled by scripts/build-webview.js.
const vscode = acquireVsCodeApi();
mountPaperdollEditor(vscode);
// Ask for the scene on (re)load — VS Code reloads the page when the panel moves windows.
vscode.postMessage({ type: 'ready' });
