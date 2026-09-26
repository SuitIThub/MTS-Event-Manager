import * as crypto from 'crypto';
import * as vscode from 'vscode';

/**
 * Webview scripts live in webview/*.js and are bundled to out/webview/<bundle>.js
 * (scripts/build-webview.js). Pages load them with a per-render nonce — the CSP allows no
 * inline scripts. Data a script needs at start comes as a JSON block (not executed).
 */
let assetRoot: vscode.Uri | undefined;

export function initWebviewAssets(extensionUri: vscode.Uri): void {
  assetRoot = vscode.Uri.joinPath(extensionUri, 'out', 'webview');
}

/** For a panel's localResourceRoots. */
export function webviewAssetRoots(): vscode.Uri[] {
  return assetRoot ? [assetRoot] : [];
}

export function newNonce(): string {
  return crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

/** CSP for script loading: only our bundles, marked with the page's nonce. */
export function scriptSrc(nonce: string): string {
  return `script-src 'nonce-${nonce}'`;
}

export function scriptTag(webview: Pick<vscode.Webview, 'asWebviewUri'>, bundle: string, nonce: string): string {
  const src = assetRoot ? webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, `${bundle}.js`)).toString() : `webview/${bundle}.js`;
  return `<script nonce="${nonce}" src="${src}"></script>`;
}

/** Data for a script: `JSON.parse(document.getElementById(id).textContent)`. */
export function jsonScript(id: string, value: unknown): string {
  return `<script type="application/json" id="${id}">${JSON.stringify(value).replace(/</g, '\\u003c')}</script>`;
}
