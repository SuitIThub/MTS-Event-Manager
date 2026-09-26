// eslint-disable-next-line @typescript-eslint/no-var-requires
const builder = require('./build-webview.js') as { bundleSources(name: string): string; bundleNames(): string[] };

/** The script a webview page loads (webview/*.js concatenated as in out/webview/<name>.js). */
export const webviewBundle = (name: string): string => builder.bundleSources(name);
export const webviewBundleNames = (): string[] => builder.bundleNames();

/** `<script type="application/json" id="…">` data blocks of a page: id → JSON text. */
export function jsonBlocks(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<script type="application\/json" id="([^"]+)">([\s\S]*?)<\/script>/g)) {
    out.set(m[1], m[2]);
  }
  return out;
}

/** A webview stand-in for rendering pages in tests. */
export const fakeWebview = { cspSource: 'vscode-resource:', asWebviewUri: <T>(u: T): T => u };
