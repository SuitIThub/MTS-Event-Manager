import { LabelDefinition } from './types';
import { topLevelLabelSpan } from './parseImageCalls';

const GET_VALUE_RE =
  /\$?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*get_value\s*\(\s*['"]([^'"]+)['"]/g;

/**
 * From enclosing if/elif branches (and get_value aliases), build pattern placeholder
 * constraints for the call site line — e.g. topic == "ah" → { topic: ["ah"] }.
 */
export function paramConstraintsForLine(
  text: string,
  labels: LabelDefinition[],
  line: number
): Record<string, string[]> {
  const { startLine, endLine } = topLevelLabelSpan(labels, line);
  const varToKey = parseGetValueMap(text, startLine, endLine);
  const conditions = enclosingIfConditions(text, line);
  const out: Record<string, string[]> = {};

  for (const cond of conditions) {
    const key = varToKey.get(cond.variable) ?? cond.variable;
    if (out[key]) {
      out[key] = intersect(out[key], cond.values);
    } else {
      out[key] = [...cond.values];
    }
  }

  for (const key of Object.keys(out)) {
    if (out[key].length === 0) {
      delete out[key];
    }
  }
  return out;
}

/** Keep only constraints that appear as `<key>` in the path template. */
export function constraintsForTemplate(
  pathTemplate: string,
  constraints: Record<string, string[]>
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(constraints)) {
    if (pathTemplate.includes(`<${key}>`) && values.length > 0) {
      out[key] = values;
    }
  }
  return out;
}

/** Cartesian product of constraint value lists (capped). */
export function expandConstraintCombos(
  constraints: Record<string, string[]>,
  maxCombos = 24
): Record<string, string>[] {
  const keys = Object.keys(constraints).sort();
  if (keys.length === 0) {
    return [{}];
  }
  let combos: Record<string, string>[] = [{}];
  for (const key of keys) {
    const vals = constraints[key];
    const next: Record<string, string>[] = [];
    for (const c of combos) {
      for (const v of vals) {
        next.push({ ...c, [key]: v });
        if (next.length >= maxCombos) {
          return next;
        }
      }
    }
    combos = next;
  }
  return combos;
}

function intersect(a: string[], b: string[]): string[] {
  const setB = new Set(b);
  return a.filter((x) => setB.has(x));
}

function parseGetValueMap(
  text: string,
  startLine: number,
  endLine: number
): Map<string, string> {
  const map = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  for (let i = startLine; i <= endLine && i < lines.length; i++) {
    GET_VALUE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    const line = lines[i];
    while ((m = GET_VALUE_RE.exec(line)) !== null) {
      map.set(m[1], m[2]);
    }
  }
  return map;
}

function lineIndent(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') {
      n++;
    } else if (ch === '\t') {
      n += 4;
    } else {
      break;
    }
  }
  return n;
}

interface CondBinding {
  variable: string;
  values: string[];
}

interface IfBlock {
  indent: number;
  conditions: CondBinding[];
}

function enclosingIfConditions(text: string, targetLine: number): CondBinding[] {
  const lines = text.split(/\r?\n/);
  if (targetLine < 0 || targetLine >= lines.length) {
    return [];
  }

  const stack: IfBlock[] = [];
  for (let i = 0; i < targetLine; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const indent = lineIndent(raw);
    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const ifMatch = /^(if|elif)\s+(.+):\s*(?:#.*)?$/.exec(trimmed);
    const elseMatch = /^else\s*:\s*(?:#.*)?$/.exec(trimmed);
    if (ifMatch) {
      stack.push({ indent, conditions: parseConditionExpr(ifMatch[2]) });
    } else if (elseMatch) {
      stack.push({ indent, conditions: [] });
    }
  }

  const targetIndent = lineIndent(lines[targetLine]);
  const targetTrim = lines[targetLine].trim();
  if (!targetTrim || targetTrim.startsWith('#')) {
    return [];
  }

  const result: CondBinding[] = [];
  for (const block of stack) {
    if (targetIndent > block.indent) {
      result.push(...block.conditions);
    }
  }
  return result;
}

/**
 * Extract simple equality / membership checks from an if/elif expression.
 * `topic == "ah" or topic == "oh"` → topic: [ah, oh]
 * `topic in ["panties", "breasts"]` → topic: [panties, breasts]
 */
export function parseConditionExpr(expr: string): CondBinding[] {
  const byVar = new Map<string, string[]>();

  const add = (variable: string, value: string) => {
    const list = byVar.get(variable) ?? [];
    if (!list.includes(value)) {
      list.push(value);
    }
    byVar.set(variable, list);
  };

  const eqRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*==\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = eqRe.exec(expr)) !== null) {
    add(m[1], m[2]);
  }

  const inRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s+in\s*[\[(]([^\])]+)[\])]/g;
  while ((m = inRe.exec(expr)) !== null) {
    const litRe = /["']([^"']+)["']/g;
    let lit: RegExpExecArray | null;
    while ((lit = litRe.exec(m[2])) !== null) {
      add(m[1], lit[1]);
    }
  }

  return [...byVar.entries()].map(([variable, values]) => ({ variable, values }));
}
