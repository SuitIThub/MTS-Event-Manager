// Builds the webview scripts: webview/*.js → out/webview/<bundle>.js (see webview/bundles.json).
// Plain concatenation keeps the scripts' shared top-level scope exactly as before.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'webview');
const outDir = path.join(root, 'out', 'webview');

function bundleSources(name) {
  const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'bundles.json'), 'utf8'));
  const files = manifest[name];
  if (!Array.isArray(files)) throw new Error(`Unknown webview bundle: ${name}`);
  return files.map((f) => `// ── ${f} ──\n` + fs.readFileSync(path.join(srcDir, f), 'utf8')).join('\n');
}

function bundleNames() {
  return Object.keys(JSON.parse(fs.readFileSync(path.join(srcDir, 'bundles.json'), 'utf8'))).filter((k) => !k.startsWith('/'));
}

function build() {
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of bundleNames()) {
    const code = bundleSources(name);
    // Parse check: a syntax error must fail the build, not the webview at runtime.
    new Function(code);
    fs.writeFileSync(path.join(outDir, `${name}.js`), code);
  }
  console.log(`webview bundles: ${bundleNames().join(', ')}`);
}

module.exports = { bundleSources, bundleNames };
if (require.main === module) build();
