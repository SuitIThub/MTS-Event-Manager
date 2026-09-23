/**
 * Pure line helpers for timeline edits (no VS Code dependency, so they are testable).
 */

/** Bounds of the leading identifier chain (`speaker` / `speaker.method`) on a line. */
export function chainBounds(lineText: string): { start: number; end: number } | undefined {
  const indent = lineText.match(/^[ \t]*/)?.[0].length ?? 0;
  const idm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(lineText.slice(indent));
  if (!idm) {
    return undefined;
  }
  let end = indent + idm[0].length;
  while (lineText[end] === '.') {
    const nm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(lineText.slice(end + 1));
    if (!nm) {
      break;
    }
    end = end + 1 + nm[0].length;
  }
  return { start: indent, end };
}

const NOT_SPEAKERS =
  /^(call|jump|show|hide|scene|pause|return|if|elif|else|while|for|menu|label|python|init|with|play|stop|queue|voice|window)$/;

/** True when the line is a say statement: `speaker[.method] "…"` (never `call …`, `$ …`). */
export function isSayLine(lineText: string): boolean {
  const bounds = chainBounds(lineText);
  if (!bounds) {
    return false;
  }
  const first = lineText.slice(bounds.start, bounds.end).split('.')[0];
  if (NOT_SPEAKERS.test(first)) {
    return false;
  }
  return /^[ \t]*["']/.test(lineText.slice(bounds.end));
}

export const PAUSE_LINE_RE = /^[ \t]*(\$[ \t]*renpy\.pause\s*\(|pause\b)/;

/**
 * Re-locate a target line whose number may be stale: keep `line` while its trimmed text
 * still equals the fingerprint, otherwise take the nearest line with that text.
 */
export function locateLineIn(lines: readonly string[], line: number, src: string): number | undefined {
  if (line >= 0 && line < lines.length && lines[line].trim() === src) {
    return line;
  }
  let best: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === src && (best === undefined || Math.abs(i - line) < Math.abs(best - line))) {
      best = i;
    }
  }
  return best;
}
