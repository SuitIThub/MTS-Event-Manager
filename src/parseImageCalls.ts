import * as vscode from 'vscode';
import { offsetToPosition } from './scan';
import { LabelDefinition, ImageCallSite } from './types';

const CONVERT_RE =
  /\$?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*convert_pattern(?:_with_data)?\s*\(\s*['"]([^'"]+)['"]/g;

const SHOW_RE = /\$?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*show\s*\(\s*(\d+)\s*[,)]/g;

const SHOW_IMAGE_RE =
  /call\s+Image_Series\s*\.\s*show_image\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*((?:\s*,\s*\d+)*)/g;

const SHOW_PATTERN_RE = /\$?\s*show_pattern\s*\(\s*['"]([^'"]+)['"]/g;

const SET_BG_INDEX_RE =
  /\.set_background(?:_split)?\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(\d+)\s*\]/g;

const SET_BG_PATH_RE =
  /\.set_background(?:_split)?\s*\(\s*['"]([^'"]+)['"]/g;

function lineRange(text: string, matchIndex: number, matchLength: number): vscode.Range {
  const { line, character } = offsetToPosition(text, matchIndex);
  return new vscode.Range(line, character, line, character + Math.min(matchLength, 80));
}

export function labelAtLine(labels: LabelDefinition[], line: number): LabelDefinition | undefined {
  let best: LabelDefinition | undefined;
  for (const lab of labels) {
    if (lab.range.start.line <= line) {
      if (!best || lab.range.start.line >= best.range.start.line) {
        best = lab;
      }
    }
  }
  return best;
}

/**
 * Map variable name → pattern key for the last convert_pattern assignment before `beforeLine`,
 * scoped to the same top-level label (so parent-label bindings apply inside sublabels).
 */
export function resolvePatternKeyForVariable(
  text: string,
  labels: LabelDefinition[],
  variableName: string,
  beforeLine: number
): string | undefined {
  const { startLine, endLine } = topLevelLabelSpan(labels, beforeLine);
  let lastKey: string | undefined;
  for (const c of convertSites(text)) {
    if (c.line < startLine || c.line >= beforeLine || c.line > endLine) {
      continue;
    }
    if (c.variable === variableName) {
      lastKey = c.key;
    }
  }
  return lastKey;
}

/**
 * `var = convert_pattern("key")` sites of a text, computed once per text. Resolving a
 * pattern key used to rescan the whole file for every `image.show` (quadratic — seconds
 * on big event files, on every edit).
 */
let convertCacheText: string | undefined;
let convertCache: { line: number; variable: string; key: string }[] = [];
function convertSites(text: string): { line: number; variable: string; key: string }[] {
  if (text === convertCacheText) {
    return convertCache;
  }
  const out: { line: number; variable: string; key: string }[] = [];
  CONVERT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CONVERT_RE.exec(text)) !== null) {
    out.push({ line: lineRange(text, m.index, m[0].length).start.line, variable: m[1], key: m[2] });
  }
  convertCacheText = text;
  convertCache = out;
  return out;
}

/** Top-level labels sorted by line, per labels array (labels are rebuilt per parse). */
const topsCache = new WeakMap<LabelDefinition[], LabelDefinition[]>();
function sortedTops(labels: LabelDefinition[]): LabelDefinition[] {
  let tops = topsCache.get(labels);
  if (!tops) {
    tops = [...labels].sort((a, b) => a.range.start.line - b.range.start.line).filter((l) => !l.isSub);
    topsCache.set(labels, tops);
  }
  return tops;
}

/** Line span of the top-level label that contains `line` (includes its sublabels). */
export function topLevelLabelSpan(
  labels: LabelDefinition[],
  line: number
): { startLine: number; endLine: number } {
  const tops = sortedTops(labels);
  let startLine = 0;
  let endLine = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i].range.start.line <= line) {
      startLine = tops[i].range.start.line;
      endLine =
        i + 1 < tops.length ? tops[i + 1].range.start.line - 1 : Number.MAX_SAFE_INTEGER;
    }
  }
  return { startLine, endLine };
}

export function parseImageCallsInDocument(
  text: string,
  labels: LabelDefinition[]
): ImageCallSite[] {
  const sites: ImageCallSite[] = [];

  const addShow = () => {
    SHOW_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SHOW_RE.exec(text)) !== null) {
      const range = lineRange(text, m.index, m[0].length);
      const variableName = m[1];
      const step = parseInt(m[2], 10);
      const patternKey = resolvePatternKeyForVariable(text, labels, variableName, range.start.line);
      sites.push({
        kind: 'show',
        range,
        variableName,
        patternKey,
        steps: [step],
      });
    }
  };

  const addShowImage = () => {
    SHOW_IMAGE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SHOW_IMAGE_RE.exec(text)) !== null) {
      const range = lineRange(text, m.index, m[0].length);
      const variableName = m[1];
      const steps = [...m[2].matchAll(/\d+/g)].map((x) => parseInt(x[0], 10));
      const patternKey = resolvePatternKeyForVariable(text, labels, variableName, range.start.line);
      sites.push({
        kind: 'show_image',
        range,
        variableName,
        patternKey,
        steps,
      });
    }
  };

  const addConvertPattern = () => {
    CONVERT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CONVERT_RE.exec(text)) !== null) {
      const range = lineRange(text, m.index, m[0].length);
      sites.push({
        kind: 'convert_pattern',
        range,
        variableName: m[1],
        patternKey: m[2],
        steps: [],
      });
    }
  };

  const addShowPattern = () => {
    SHOW_PATTERN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SHOW_PATTERN_RE.exec(text)) !== null) {
      const range = lineRange(text, m.index, m[0].length);
      sites.push({
        kind: 'show_pattern',
        range,
        patternKey: m[1],
        steps: [],
      });
    }
  };

  const addSetBgIndex = () => {
    SET_BG_INDEX_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SET_BG_INDEX_RE.exec(text)) !== null) {
      const range = lineRange(text, m.index, m[0].length);
      const variableName = m[1];
      const step = parseInt(m[2], 10);
      const patternKey = resolvePatternKeyForVariable(text, labels, variableName, range.start.line);
      sites.push({
        kind: 'set_background',
        range,
        variableName,
        patternKey,
        steps: [step],
      });
    }
  };

  const addSetBgPath = () => {
    SET_BG_PATH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SET_BG_PATH_RE.exec(text)) !== null) {
      const range = lineRange(text, m.index, m[0].length);
      sites.push({
        kind: 'set_background_path',
        range,
        literalPath: m[1].replace(/\\/g, '/'),
        steps: [],
      });
    }
  };

  addShow();
  addShowImage();
  addConvertPattern();
  addShowPattern();
  addSetBgIndex();
  addSetBgPath();

  return sites;
}

export function labelNameForImageCall(
  labels: LabelDefinition[],
  site: ImageCallSite
): string | undefined {
  return labelAtLine(labels, site.range.start.line)?.name;
}
