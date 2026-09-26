import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { renderPreviewHtml } from '../src/previewPanel';
import { renderOverviewHtml } from '../src/eventOverview';
import { fakeWebview, webviewBundle, webviewBundleNames } from './webviewTestUtil';

/**
 * Webview scripts: every bundle (webview/bundles.json) must parse, and the pages must load
 * them only as nonce'd files — no inline script, no 'unsafe-inline' for scripts in the CSP.
 */
let problems = 0;
const names = webviewBundleNames();
for (const name of names) {
  const file = path.join(__dirname, `_webview_${name}.js`);
  fs.writeFileSync(file, webviewBundle(name));
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    problems++;
    console.log(`bundle ${name}: syntax error\n${String((e as { stderr?: Buffer }).stderr ?? e)}`);
  }
  fs.unlinkSync(file);
}
for (const [page, html] of [['preview', renderPreviewHtml(fakeWebview)], ['overview', renderOverviewHtml(fakeWebview)]] as const) {
  const csp = /Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? '';
  const nonce = /script-src 'nonce-([A-Za-z0-9]+)'/.exec(csp)?.[1];
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="application\/json")[^>]*>/g)];
  const tags = [...html.matchAll(/<script [^>]*src="[^"]*"[^>]*>/g)].map((m) => m[0]);
  if (!nonce || /script-src[^;]*unsafe-inline/.test(csp) || inline.length || !tags.length || tags.some((t) => !t.includes(`nonce="${nonce}"`))) {
    problems++;
    console.log(`page ${page}: scripts must be nonce'd files (csp: ${csp}; inline: ${inline.length}; tags: ${tags.join(' ')})`);
  }
}
console.log(`webview bundles: ${names.length}, problems: ${problems}`);
process.exitCode = problems ? 1 : 0;
