/** Minimal vscode stub for offline parser verification. */
const fs = require('fs');
const nodePath = require('path');

function Position(line, character) {
  this.line = line;
  this.character = character;
}
function Range(a, b, c, d) {
  if (typeof a === 'number') {
    this.start = new Position(a, b);
    this.end = new Position(c, d);
  } else {
    this.start = a;
    this.end = b;
  }
}
function Uri(fsPath) {
  this.fsPath = fsPath;
  this.toString = function () {
    return this.fsPath;
  };
}
Uri.file = function (p) {
  return new Uri(p);
};
Uri.parse = function (p) {
  return new Uri(p);
};
function EventEmitter() {
  this.event = function () {};
  this.fire = function () {};
  this.dispose = function () {};
}

function walkRpy(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = nodePath.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'images' || e.name === 'audio' || e.name === 'node_modules' || e.name === '.git') continue;
      walkRpy(p, out);
    } else if (e.name.endsWith('.rpy')) {
      out.push(p);
    }
  }
  return out;
}

/** A read-only TextDocument over a file (enough for the checks). */
function fakeDocument(uri) {
  const text = fs.readFileSync(uri.fsPath, 'utf8');
  const lines = text.split('\n');
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return {
    uri,
    version: 1,
    lineCount: lines.length,
    eol: text.includes('\r\n') ? 2 : 1,
    getText: () => text,
    lineAt: (l) => ({ text: (lines[typeof l === 'number' ? l : l.line] || '').replace(/\r$/, ''), lineNumber: typeof l === 'number' ? l : l.line }),
    positionAt: (off) => {
      let lo = 0, hi = starts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
      return new Position(lo, off - starts[lo]);
    },
    offsetAt: (pos) => (starts[pos.line] || 0) + pos.character,
  };
}

// Minimal workspace for tests that resolve real image files / build the index: set
// MTS_WS_ROOT to the game root.
const workspace = {
  get workspaceFolders() {
    const root = process.env.MTS_WS_ROOT;
    return root ? [{ uri: { fsPath: root } }] : [];
  },
  getConfiguration() {
    return { get: (_key, fallback) => fallback };
  },
  textDocuments: [],
  async findFiles() {
    const root = process.env.MTS_WS_ROOT;
    return root ? walkRpy(root, []).map((p) => Uri.file(p)) : [];
  },
  fs: {
    async readFile(uri) {
      return fs.readFileSync(uri.fsPath);
    },
    async stat(uri) {
      return { mtime: fs.statSync(uri.fsPath).mtimeMs };
    },
  },
  async openTextDocument(uri) {
    return fakeDocument(uri);
  },
  asRelativePath(uri) {
    const root = process.env.MTS_WS_ROOT;
    const p = typeof uri === 'string' ? uri : uri.fsPath;
    return root ? nodePath.relative(root, p).replace(/\\/g, '/') : p;
  },
};

class Location {
  constructor(uri, range) {
    this.uri = uri;
    this.range = range;
  }
}

module.exports = { Position, Range, Location, Uri, EventEmitter, workspace };
