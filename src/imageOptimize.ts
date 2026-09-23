import { topLevelLabelSpan } from './parseImageCalls';
import { positionToOffset } from './scan';
import { LabelDefinition } from './types';

export interface OptimizeEdit {
  start: number;
  end: number;
  text: string;
}

export interface ImageOptimizeResult {
  edits: OptimizeEdit[];
  /** Number of consecutive `image.show` runs merged into a `show_image`. */
  merged: number;
}

/** Whole-line `$ <var>.show(N)` with optional trailing comment. */
const SHOW_LINE = /^([ \t]*)\$[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*\.[ \t]*show[ \t]*\([ \t]*(\d+)[ \t]*\)[ \t]*(#.*)?$/;

/**
 * Merge runs of directly-consecutive `$ <var>.show(N)` lines (same variable, nothing
 * between them) into a single `call Image_Series.show_image(<var>, …)`. Without a pause
 * between them only the last image is ever visible, so a run is either a sequence that
 * belongs in `show_image` or dead shows — either way `show_image` is the correct form.
 * Trailing comments are preserved (joined). Single shows are left untouched.
 */
export function optimizeImageShows(
  text: string,
  labels: LabelDefinition[],
  line: number
): ImageOptimizeResult {
  const span = topLevelLabelSpan(labels, line);
  const lines = text.split('\n');
  const last = Math.min(span.endLine, lines.length - 1);
  const edits: OptimizeEdit[] = [];
  let merged = 0;

  let i = span.startLine;
  while (i <= last) {
    const m = SHOW_LINE.exec(lines[i] ?? '');
    if (!m) {
      i++;
      continue;
    }
    const indent = m[1];
    const variable = m[2];
    const run: { step: string; comment: string }[] = [{ step: m[3], comment: (m[4] ?? '').replace(/^#\s*/, '').trim() }];
    let j = i + 1;
    while (j <= last) {
      const n = SHOW_LINE.exec(lines[j] ?? '');
      if (!n || n[2] !== variable) {
        break;
      }
      run.push({ step: n[3], comment: (n[4] ?? '').replace(/^#\s*/, '').trim() });
      j++;
    }
    if (run.length >= 2) {
      const steps = run.map((r) => r.step).join(', ');
      const comments = run.map((r) => r.comment).filter(Boolean);
      const tail = comments.length ? ` # ${comments.join(' | ')}` : '';
      const startOffset = positionToOffset(text, i, 0);
      const endOffset = positionToOffset(text, j - 1, (lines[j - 1] ?? '').length);
      edits.push({
        start: startOffset,
        end: endOffset,
        text: `${indent}call Image_Series.show_image(${variable}, ${steps})${tail}`,
      });
      merged++;
    }
    i = j;
  }

  return { edits, merged };
}
