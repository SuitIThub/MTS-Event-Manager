import { codeMap } from './codeStructure';
import { readStringLiteral, skipString } from './scan';

/**
 * Static value of a simple string expression as the game writes image paths:
 * `"images/…"`, `base_path + "x/<step>.webp"`, where `base_path` is a string (or such an
 * expression) assigned earlier in the same file (`base_path = "images/events/…/"`).
 * Anything dynamic — f-strings, `%`, calls, unknown names — gives undefined, so callers
 * never guess a path.
 */
export function stringExprValue(text: string, expr: string, at: number, depth = 0): string | undefined {
  const parts = splitPlus(expr);
  if (!parts) {
    return undefined;
  }
  let out = '';
  for (const raw of parts) {
    const s = raw.trim();
    if (s.startsWith('"') || s.startsWith("'")) {
      const lit = readStringLiteral(s, 0);
      if (!lit || s.slice(lit.end).trim()) {
        return undefined;
      }
      out += lit.value;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && depth < 4) {
      const rhs = assignmentBefore(text, s, at);
      const v = rhs ? stringExprValue(text, rhs.expr, rhs.at, depth + 1) : undefined;
      if (v === undefined) {
        return undefined;
      }
      out += v;
      continue;
    }
    return undefined;
  }
  return out;
}

/** Top-level `a + b + c` operands (outside strings and brackets); undefined if malformed. */
function splitPlus(expr: string): string[] | undefined {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === '"' || c === "'") {
      i = skipString(expr, i);
      continue;
    }
    if (c === '#') {
      break;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
    } else if (c === '+' && depth === 0) {
      out.push(expr.slice(from, i));
      from = i + 1;
    }
    i++;
  }
  out.push(expr.slice(from, i));
  return depth === 0 && out.every((p) => p.trim()) ? out : undefined;
}

/** The last `name = …` (also `$ name = …`, `define`/`default`) before offset `at`. */
function assignmentBefore(text: string, name: string, at: number): { expr: string; at: number } | undefined {
  const map = codeMap(text);
  const re = new RegExp(`^[ \\t]*(?:\\$[ \\t]*|define[ \\t]+|default[ \\t]+)?${name}[ \\t]*=(?!=)`, 'gm');
  let best: { expr: string; at: number } | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && m.index < at) {
    const line = lineOf(map.lineStarts, m.index);
    if (map.inString[line]) {
      continue;
    }
    const nl = text.indexOf('\n', m.index);
    best = { expr: text.slice(m.index + m[0].length, nl < 0 ? text.length : nl).replace(/\r$/, ''), at: m.index };
  }
  return best;
}

function lineOf(starts: number[], off: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= off) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}
