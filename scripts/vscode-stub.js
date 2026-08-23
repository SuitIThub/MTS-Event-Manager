/** Minimal vscode stub for offline parser verification. */
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

module.exports = { Position, Range, Uri, EventEmitter };
