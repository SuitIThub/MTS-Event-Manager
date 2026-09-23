import { decodeValue, parsePyCall, PyCall } from './pyCall';
import { ClassSchema } from './types';

/**
 * Literal values the workspace (game + mods) passes to each condition / selector / option
 * parameter — e.g. TimeCondition.daytime → d (51×), c (31×), f (36×) … — so the
 * definition editor can suggest what is actually used (progress keys, pools, buildings…).
 */
export type ParamUsage = Map<string, Map<string, number>>;

const CALL_RE = /\b([A-Z][A-Za-z0-9_]*(?:Condition|Selector|Option)|Pattern)\s*\(/g;

export function mineParamUsage(texts: Iterable<string>, schemaOf: (name: string) => ClassSchema | undefined): ParamUsage {
  const usage: ParamUsage = new Map();
  for (const text of texts) {
    CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALL_RE.exec(text)) !== null) {
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      const before = text.slice(lineStart, m.index);
      if (/\bclass\s+$/.test(before) || /\bdef\s+$/.test(before) || before.includes('#')) {
        continue;
      }
      if (m.index > 0 && /[A-Za-z0-9_.]/.test(text[m.index - 1])) {
        continue;
      }
      const schema = schemaOf(m[1]);
      if (!schema) {
        continue;
      }
      const call = parsePyCall(text, m.index);
      if (call) {
        record(usage, schema, call);
      }
    }
  }
  return usage;
}

function record(usage: ParamUsage, schema: ClassSchema, call: PyCall): void {
  const positional = schema.params.filter((p) => p.kind === 'positional');
  const vararg = schema.params.find((p) => p.kind === 'vararg');
  let i = 0;
  for (const arg of call.args) {
    if (arg.star) {
      continue;
    }
    let name: string | undefined;
    if (arg.name) {
      name = arg.name;
    } else if (i < positional.length) {
      name = positional[i++].name;
    } else {
      name = vararg?.name;
    }
    const d = decodeValue(arg.value);
    if (!name || (d.kind !== 'string' && d.kind !== 'number' && d.kind !== 'bool')) {
      continue;
    }
    if (d.value.length > 60 || d.value.includes('\n')) {
      continue;
    }
    const key = `${schema.name}.${name}`;
    const values = usage.get(key) ?? new Map<string, number>();
    values.set(d.value, (values.get(d.value) ?? 0) + 1);
    usage.set(key, values);
  }
}

/** Most used first. */
export function usageFor(usage: ParamUsage, className: string, param: string): { value: string; count: number }[] {
  const values = usage.get(`${className}.${param}`);
  if (!values) {
    return [];
  }
  return [...values.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}
