import { alignCrlfEdits } from '../src/codeStructure';
import { applyEdits, TextEdit } from '../src/pyCall';

/**
 * What VS Code makes of offset edits: offsets become (line, character) positions, and a
 * position between `\r` and `\n` does not exist — it is clamped to the line's end (before
 * `\r`). `applyInEditor` applies edits the way the verified write path does (line breaks in
 * the file's style, CRLF-safe boundaries) through that conversion.
 */
export function editorOffset(text: string, offset: number): number {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const nl = text.indexOf('\n', lineStart);
  const lineEnd = nl < 0 ? text.length : nl;
  const contentEnd = lineEnd > lineStart && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
  return Math.min(offset, contentEnd < offset && offset <= lineEnd ? contentEnd : offset);
}

export function applyInEditor(text: string, edits: readonly TextEdit[], align = true): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const normalized = edits.map((e) => ({ ...e, text: e.text.replace(/\r?\n/g, eol) }));
  const ready = align ? alignCrlfEdits(text, normalized) : normalized;
  return applyEdits(text, ready.map((e) => ({ ...e, start: editorOffset(text, e.start), end: editorOffset(text, e.end) })));
}

/** The text the planner meant (same normalisation, no position clamping). */
export function applyPlanned(text: string, edits: readonly TextEdit[]): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return applyEdits(text, edits.map((e) => ({ ...e, text: e.text.replace(/\r?\n/g, eol) })));
}
