import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { renderPreviewHtml } from '../src/previewPanel';

/**
 * Render the real preview webview HTML, then check its script: it must parse, and it
 * must not contain regexes that lost their backslashes inside the TypeScript template
 * literal (`\d` in a template literal silently becomes `d`).
 */
const html = renderPreviewHtml({ cspSource: 'vscode-resource:' });
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let problems = 0;
scripts.forEach((js, i) => {
  const file = path.join(__dirname, `_webview_${i}.js`);
  fs.writeFileSync(file, js);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    problems++;
    console.log(`script ${i}: syntax error\n${String((e as { stderr?: Buffer }).stderr ?? e)}`);
  }
  fs.unlinkSync(file);
  // Regex literals whose escapes were eaten: /d+/, /s*/, /w+/ …
  const eaten = js.match(/\/\(?[dsw][+*?]/g);
  if (eaten) {
    problems++;
    console.log(`script ${i}: regex lost its backslash:`, eaten.join(' '));
  }
});
console.log(`webview scripts: ${scripts.length}, problems: ${problems}`);
process.exitCode = problems ? 1 : 0;
