// Webview script (paperdollPanel-init.js). Plain browser JavaScript, bundled by scripts/build-webview.js.
const vscode = acquireVsCodeApi();
// A saved state marks the page as restorable (window reload, move to another window).
if (typeof vscode.setState === 'function' && !vscode.getState()) vscode.setState({ restorable: true });
mountPaperdollEditor(vscode);
// Ask for the scene on (re)load — VS Code reloads the page when the panel moves windows.
vscode.postMessage({ type: 'ready' });
