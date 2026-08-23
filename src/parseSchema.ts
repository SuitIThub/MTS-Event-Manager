import * as vscode from 'vscode';
import {
  findMatching,
  offsetToPosition,
  readIdentifier,
  skipString,
} from './scan';
import {
  ClassSchema,
  SchemaKind,
  SchemaParam,
  TYPE_ROOTS,
} from './types';

interface RawClass {
  name: string;
  bases: string[];
  classBodyStart: number; // after `:`
  classBodyEnd: number;
  uri: string;
  range: vscode.Range;
}

const CLASS_RE = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^)]*)\))?\s*:/g;

function toRange(text: string, start: number, end: number): vscode.Range {
  const s = offsetToPosition(text, start);
  const e = offsetToPosition(text, end);
  return new vscode.Range(s.line, s.character, e.line, e.character);
}

/** Approximate class body end by indentation (Ren'Py/Python). */
function findClassBodyEnd(text: string, colonIndex: number): number {
  // After `:`, find next non-empty line; capture its indent as body indent minimum
  let i = colonIndex + 1;
  if (text[i] === '\r') {
    i++;
  }
  if (text[i] === '\n') {
    i++;
  }

  // Find first content line indent
  let bodyIndent: number | undefined;
  const n = text.length;
  let lineStart = i;
  while (i <= n) {
    if (i === n || text[i] === '\n') {
      const line = text.slice(lineStart, i);
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) {
        // skip
      } else {
        const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
        if (bodyIndent === undefined) {
          bodyIndent = indent;
        } else if (indent <= 0 || (bodyIndent !== undefined && indent < bodyIndent && !trimmed.startsWith('#'))) {
          // Dedented past class body — but class might be inside init python with indent > 0
          // End when indent is strictly less than bodyIndent
          if (indent < bodyIndent) {
            return lineStart;
          }
        }
      }
      if (i === n) {
        break;
      }
      i++;
      lineStart = i;
      continue;
    }
    i++;
  }
  return n;
}

function parseBases(basesRaw: string | undefined): string[] {
  if (!basesRaw || !basesRaw.trim()) {
    return [];
  }
  // Split on commas at depth 0
  const bases: string[] = [];
  let depth = 0;
  let start = 0;
  const s = basesRaw;
  for (let i = 0; i <= s.length; i++) {
    const c = i < s.length ? s[i] : ',';
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
    } else if ((c === ',' || i === s.length) && depth === 0) {
      const part = s.slice(start, i).trim();
      if (part) {
        // Take first identifier (ignore generics-ish)
        const m = part.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
        if (m) {
          bases.push(m[1]);
        }
      }
      start = i + 1;
    }
  }
  return bases;
}

export function collectRawClasses(uri: vscode.Uri, text: string): RawClass[] {
  const results: RawClass[] = [];
  CLASS_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CLASS_RE.exec(text)) !== null) {
    const name = match[1];
    const bases = parseBases(match[2]);
    const colonIndex = match.index + match[0].length - 1;
    const bodyEnd = findClassBodyEnd(text, colonIndex);
    results.push({
      name,
      bases,
      classBodyStart: colonIndex + 1,
      classBodyEnd: bodyEnd,
      uri: uri.toString(),
      range: toRange(text, match.index, match.index + match[0].length),
    });
  }
  return results;
}

function parseInitParams(sig: string): SchemaParam[] {
  // sig is inside parentheses of def __init__(...)
  const params: SchemaParam[] = [];
  let i = 0;
  const n = sig.length;
  let seenVararg = false;
  let bareStarSeen = false;

  const skipWs = () => {
    while (i < n && /\s/.test(sig[i])) {
      i++;
    }
  };

  const skipUntilComma = () => {
    while (i < n && sig[i] !== ',') {
      if (sig[i] === '(' || sig[i] === '[' || sig[i] === '{') {
        const end = findMatching(sig, i);
        i = end < 0 ? n : end + 1;
      } else if (sig[i] === '"' || sig[i] === "'") {
        i = skipString(sig, i);
      } else {
        i++;
      }
    }
  };

  while (i < n) {
    skipWs();
    if (i >= n) {
      break;
    }
    if (sig[i] === ',') {
      i++;
      continue;
    }
    if (sig[i] === '*') {
      if (sig[i + 1] === '*') {
        i += 2;
        const id = readIdentifier(sig, i);
        params.push({
          name: id?.name ?? 'kwargs',
          kind: 'kwargs',
          required: false,
        });
        i = id?.end ?? i;
        skipUntilComma();
        continue;
      }
      i++;
      skipWs();
      const id = readIdentifier(sig, i);
      if (id) {
        params.push({ name: id.name, kind: 'vararg', required: false });
        i = id.end;
        seenVararg = true;
      } else {
        bareStarSeen = true;
      }
      skipUntilComma();
      continue;
    }

    const id = readIdentifier(sig, i);
    if (!id) {
      i++;
      continue;
    }
    i = id.end;
    if (id.name === 'self') {
      skipWs();
      if (i < n && sig[i] === ':') {
        i++;
        skipUntilComma();
      }
      continue;
    }

    let typeHint: string | undefined;
    let defaultVal: string | undefined;

    skipWs();
    if (i < n && sig[i] === ':') {
      i++;
      skipWs();
      const typeStart = i;
      while (i < n && sig[i] !== ',' && sig[i] !== '=') {
        if (sig[i] === '(' || sig[i] === '[' || sig[i] === '{') {
          const end = findMatching(sig, i);
          i = end < 0 ? n : end + 1;
        } else if (sig[i] === '"' || sig[i] === "'") {
          i = skipString(sig, i);
        } else {
          i++;
        }
      }
      typeHint = sig.slice(typeStart, i).trim();
    }
    skipWs();
    if (i < n && sig[i] === '=') {
      i++;
      skipWs();
      const defStart = i;
      skipUntilComma();
      defaultVal = sig.slice(defStart, i).trim();
    }

    const kind =
      seenVararg || bareStarSeen ? ('kwonly' as const) : ('positional' as const);
    params.push({
      name: id.name,
      kind,
      required: defaultVal === undefined,
      typeHint,
      default: defaultVal,
    });
  }

  return params;
}

function extractInitFromBody(text: string, bodyStart: number, bodyEnd: number): {
  params: SchemaParam[];
  initBody: string;
} | undefined {
  const body = text.slice(bodyStart, bodyEnd);
  // Find def __init__
  const initRe = /\bdef\s+__init__\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = initRe.exec(body)) !== null) {
    const openInBody = m.index + m[0].length - 1;
    const openAbs = bodyStart + openInBody;
    const closeAbs = findMatching(text, openAbs);
    if (closeAbs < 0) {
      continue;
    }
    const sig = text.slice(openAbs + 1, closeAbs);
    const params = parseInitParams(sig);
    // Init body: after `):` until next def at same/less indent — approximate rest of class used for kwargs
    const afterClose = closeAbs + 1;
    let j = afterClose;
    while (j < bodyEnd && text[j] !== ':') {
      j++;
    }
    const initBody = text.slice(j + 1, bodyEnd);
    return { params, initBody };
  }
  return undefined;
}

function inferKwargsFromBody(initBody: string): string[] {
  const keys = new Set<string>();
  const re = /kwargs\s*(?:\.\s*get\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]|\s*\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(initBody)) !== null) {
    keys.add(m[1] || m[2]);
  }
  // also: 'key' in kwargs / kwargs.keys() patterns — 'day' in kwargs.keys()
  const inRe = /['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s+in\s+kwargs/g;
  while ((m = inRe.exec(initBody)) !== null) {
    keys.add(m[1]);
  }
  return [...keys].sort();
}

function resolveKind(
  name: string,
  bases: string[],
  baseOf: Map<string, string[]>,
  memo: Map<string, SchemaKind | null>
): SchemaKind | null {
  if (memo.has(name)) {
    return memo.get(name)!;
  }
  if (TYPE_ROOTS[name]) {
    memo.set(name, TYPE_ROOTS[name]);
    return TYPE_ROOTS[name];
  }
  memo.set(name, null); // cycle guard
  for (const b of bases) {
    if (TYPE_ROOTS[b]) {
      memo.set(name, TYPE_ROOTS[b]);
      return TYPE_ROOTS[b];
    }
    const parentBases = baseOf.get(b) ?? [];
    const k = resolveKind(b, parentBases, baseOf, memo);
    if (k) {
      memo.set(name, k);
      return k;
    }
  }
  return null;
}

export interface SchemaBuildResult {
  schemas: Map<string, ClassSchema>;
  /** Root types themselves */
  roots: Map<string, ClassSchema>;
}

/**
 * Build schema registry from all raw classes across the workspace.
 * Texts: map uriString -> text for init extraction.
 */
export function buildSchemaRegistry(
  allClasses: RawClass[],
  texts: Map<string, string>
): SchemaBuildResult {
  const baseOf = new Map<string, string[]>();
  const byName = new Map<string, RawClass>();

  for (const c of allClasses) {
    // Later definitions overwrite (mod override) — acceptable
    byName.set(c.name, c);
    baseOf.set(c.name, c.bases);
  }

  const memo = new Map<string, SchemaKind | null>();
  const schemas = new Map<string, ClassSchema>();
  const roots = new Map<string, ClassSchema>();

  // Ensure roots exist as schemas even without scanning (minimal)
  for (const [rootName, kind] of Object.entries(TYPE_ROOTS)) {
    const raw = byName.get(rootName);
    const text = raw ? texts.get(raw.uri) : undefined;
    let params: SchemaParam[] = [];
    let inferredKwargs: string[] = [];
    if (raw && text) {
      const init = extractInitFromBody(text, raw.classBodyStart, raw.classBodyEnd);
      if (init) {
        params = init.params;
        if (params.some((p) => p.kind === 'kwargs')) {
          inferredKwargs = inferKwargsFromBody(init.initBody);
        }
      }
    }
    const schema: ClassSchema = {
      name: rootName,
      kind,
      bases: raw?.bases ?? [],
      params,
      inferredKwargs,
      uri: raw?.uri,
      classRange: raw?.range,
    };
    roots.set(rootName, schema);
    schemas.set(rootName, schema);
  }

  for (const c of allClasses) {
    if (TYPE_ROOTS[c.name]) {
      continue; // already added
    }
    const kind = resolveKind(c.name, c.bases, baseOf, memo);
    if (!kind) {
      continue;
    }
    const text = texts.get(c.uri);
    let params: SchemaParam[] | undefined;
    let inferredKwargs: string[] = [];
    if (text) {
      const init = extractInitFromBody(text, c.classBodyStart, c.classBodyEnd);
      if (init) {
        params = init.params;
        if (params.some((p) => p.kind === 'kwargs')) {
          inferredKwargs = inferKwargsFromBody(init.initBody);
        }
      }
    }
    // Inherit params from nearest ancestor with params
    if (!params) {
      params = inheritParams(c.name, baseOf, schemas, byName, texts) ?? [];
    }

    schemas.set(c.name, {
      name: c.name,
      kind,
      bases: c.bases,
      params,
      inferredKwargs,
      uri: c.uri,
      classRange: c.range,
    });
  }

  return { schemas, roots };
}

function inheritParams(
  name: string,
  baseOf: Map<string, string[]>,
  schemas: Map<string, ClassSchema>,
  byName: Map<string, RawClass>,
  texts: Map<string, string>
): SchemaParam[] | undefined {
  const visited = new Set<string>();
  const queue = [...(baseOf.get(name) ?? [])];
  while (queue.length) {
    const b = queue.shift()!;
    if (visited.has(b)) {
      continue;
    }
    visited.add(b);
    const existing = schemas.get(b);
    if (existing && existing.params.length > 0) {
      return existing.params.map((p) => ({ ...p }));
    }
    const raw = byName.get(b);
    if (raw) {
      const text = texts.get(raw.uri);
      if (text) {
        const init = extractInitFromBody(text, raw.classBodyStart, raw.classBodyEnd);
        if (init && init.params.length > 0) {
          return init.params;
        }
      }
      queue.push(...raw.bases);
    }
  }
  return undefined;
}

export function formatSignature(schema: ClassSchema): string {
  const parts: string[] = [];
  for (const p of schema.params) {
    if (p.kind === 'kwargs') {
      parts.push(`**${p.name}`);
      continue;
    }
    if (p.kind === 'vararg') {
      parts.push(`*${p.name}`);
      continue;
    }
    let s = p.name;
    if (p.typeHint) {
      s += `: ${p.typeHint}`;
    }
    if (p.default !== undefined) {
      s += `=${p.default}`;
    }
    parts.push(s);
  }
  if (schema.inferredKwargs.length && schema.params.some((p) => p.kind === 'kwargs')) {
    parts.push(`[${schema.inferredKwargs.join('|')}=…]`);
  }
  return `${schema.name}(${parts.join(', ')})`;
}
