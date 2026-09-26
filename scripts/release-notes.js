#!/usr/bin/env node
// Release notes from CHANGELOG.md.
//
//   node scripts/release-notes.js --check 0.6.0
//       fails (exit 1) when CHANGELOG.md has no section for that version
//   node scripts/release-notes.js --version 0.6.0 [--previous 0.5.7] [--out notes.md]
//       newest first: every version of the same minor line as --version (x.y.0 … x.y.z),
//       plus every version newer than --previous (the last release) if that is older
//
// Sections: `## [x.y.z] - date` (date optional).
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const parse = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? m.slice(1).map(Number) : undefined;
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function sections(text) {
  const out = [];
  const re = /^## \[(\d+\.\d+\.\d+)\][^\n]*$/gm;
  const heads = [...text.matchAll(re)];
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
    out.push({ version: h[1], body: text.slice(h.index, end).trim() });
  });
  return out;
}

function main() {
  const file = arg('--changelog') || path.join(__dirname, '..', 'CHANGELOG.md');
  const all = sections(fs.readFileSync(file, 'utf8'));
  const check = arg('--check');
  if (check) {
    if (!all.some((s) => s.version === check.replace(/^v/, ''))) {
      console.error(`CHANGELOG.md has no "## [${check}]" section — add the changes of this version before releasing.`);
      process.exit(1);
    }
    console.log(`CHANGELOG.md has a section for ${check}.`);
    return;
  }
  const version = parse(arg('--version'));
  if (!version) {
    console.error('Usage: --version x.y.z [--previous x.y.z] [--out file] | --check x.y.z');
    process.exit(2);
  }
  const previous = parse(arg('--previous'));
  // Every version of the same minor line (0.6.0 … 0.6.x) up to this one, plus anything newer
  // than the previous release (versions of an older line that were never released).
  const picked = all
    .filter((s) => {
      const v = parse(s.version);
      const sameMinor = v[0] === version[0] && v[1] === version[1];
      return cmp(v, version) <= 0 && (sameMinor || (previous && cmp(v, previous) > 0));
    })
    .sort((a, b) => cmp(parse(b.version), parse(a.version)));
  if (!picked.some((s) => cmp(parse(s.version), version) === 0)) {
    console.error(`CHANGELOG.md has no section for ${version.join('.')}.`);
    process.exit(1);
  }
  // In the release body the version headings become ### (the release title is the version).
  const notes = picked.map((s) => s.body.replace(/^## /, '### ').replace(/^### (Added|Changed|Fixed|Removed|Security|Deprecated)$/gm, '#### $1')).join('\n\n');
  const out = arg('--out');
  if (out) fs.writeFileSync(out, notes + '\n');
  else process.stdout.write(notes + '\n');
}

main();
