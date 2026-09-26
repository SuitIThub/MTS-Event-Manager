import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { constraintsForTemplate, expandConstraintCombos } from './paramConstraints';
import { EventPatternInfo, ImageCallSite, ResolvedImageInfo } from './types';

const IMAGE_EXTS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif', '.webm']);
const MAX_RESULTS = 50;

export async function getImageRoots(): Promise<string[]> {
  const roots = new Set<string>();
  const folders = vscode.workspace.workspaceFolders ?? [];

  for (const folder of folders) {
    await collectGameDirs(folder.uri.fsPath, roots, 0);
    // Workspace is the `game/` folder itself (no nested `game/` to discover).
    addModImageRoots(folder.uri.fsPath, roots);
    // Standalone mod folder opened as workspace: images/… lives at the folder root.
    const imagesDir = path.join(folder.uri.fsPath, 'images');
    if (fs.existsSync(imagesDir) && fs.statSync(imagesDir).isDirectory()) {
      roots.add(folder.uri.fsPath);
    }
  }

  const extra = vscode.workspace
    .getConfiguration('mtsEventManager')
    .get<string[]>('imageRoots', []);
  for (const e of extra) {
    if (e && fs.existsSync(e)) {
      roots.add(path.resolve(e));
    } else if (e) {
      for (const folder of folders) {
        const abs = path.resolve(folder.uri.fsPath, e);
        if (fs.existsSync(abs)) {
          roots.add(abs);
        }
      }
    }
  }

  return [...roots];
}

async function collectGameDirs(dir: string, out: Set<string>, depth: number): Promise<void> {
  if (depth > 6) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) {
      continue;
    }
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'out') {
      continue;
    }
    const full = path.join(dir, ent.name);
    if (ent.name === 'game') {
      out.add(full);
      addModImageRoots(full, out);
    } else {
      await collectGameDirs(full, out, depth + 1);
    }
  }
}

/**
 * Wiki (Images §4 / Modding §2): Pattern paths stay `images/…`; files live under
 * `game/mods/<ModFolder>/images/…`. Each mod folder is its own root so the same
 * relative path matches.
 */
function addModImageRoots(gameDir: string, out: Set<string>): void {
  const modsDir = path.join(gameDir, 'mods');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(modsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) {
      continue;
    }
    out.add(path.join(modsDir, ent.name));
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strip leading slashes so `/images/…` matches files under `images/…`. */
export function normalizePatternPath(pathTemplate: string): string {
  return pathTemplate.replace(/\\/g, '/').replace(/^\/+/, '');
}
const IMAGE_EXT_ALT = '(?:webp|png|jpe?g|gif|webm)';

function escapeRegExpFlexibleExt(s: string): string {
  return escapeRegExp(s).replace(/\\\.(webp|png|jpe?g|gif|webm)/gi, `\\.${IMAGE_EXT_ALT}`);
}

/**
 * Regex for a pattern template with some placeholders fixed. A fixed value also accepts
 * the engine's `$` wildcard file (`sd_event_5 $ 0.webp` serves every school_level) —
 * `refine_image_with_alternatives` falls back to `$` when the exact file is missing.
 * Steps are never wildcards. Callers rank exact matches first (see wildcardCount).
 */
export function templateToRegex(
  pathTemplate: string,
  fixed: Record<string, string>
): RegExp {
  const t = normalizePatternPath(pathTemplate);
  const ph = /<([^>]+)>/g;
  let re = '^';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = ph.exec(t)) !== null) {
    re += escapeRegExpFlexibleExt(t.slice(last, m.index));
    const value = fixed[m[1]];
    if (value === undefined) {
      re += '[^/\\\\]+';
    } else if (m[1] === 'step' || value === '$') {
      re += escapeRegExp(value);
    } else {
      re += `(?:${escapeRegExp(value)}|\\$)`;
    }
    last = m.index + m[0].length;
  }
  re += escapeRegExpFlexibleExt(t.slice(last)) + '$';
  return new RegExp(re, 'i');
}

/** `$` wildcards in a file name — fewer means a more specific match (engine order). */
export function wildcardCount(relativePath: string): number {
  return (path.basename(relativePath).match(/\$/g) ?? []).length;
}

/**
 * Extract `<placeholder>` values by matching a relative path against the pattern template.
 */
export function extractPatternParams(
  pathTemplate: string,
  relativePath: string,
  fixed: Record<string, string> = {}
): Record<string, string> {
  const template = normalizePatternPath(pathTemplate);
  const rel = normalizePatternPath(relativePath);
  const placeholderRe = /<([^>]+)>/g;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = placeholderRe.exec(template)) !== null) {
    names.push(m[1]);
  }

  let patternSrc = '^';
  let lastIndex = 0;
  placeholderRe.lastIndex = 0;
  while ((m = placeholderRe.exec(template)) !== null) {
    patternSrc += escapeRegExpFlexibleExt(template.slice(lastIndex, m.index));
    if (fixed[m[1]] !== undefined) {
      patternSrc += escapeRegExp(fixed[m[1]]);
    } else {
      patternSrc += '([^/\\\\]+)';
    }
    lastIndex = m.index + m[0].length;
  }
  patternSrc += escapeRegExpFlexibleExt(template.slice(lastIndex)) + '$';

  const match = new RegExp(patternSrc, 'i').exec(rel);
  const params: Record<string, string> = { ...fixed };
  if (!match) {
    return params;
  }
  let capture = 1;
  for (const name of names) {
    if (fixed[name] !== undefined) {
      params[name] = fixed[name];
      continue;
    }
    if (match[capture] !== undefined) {
      params[name] = match[capture];
    }
    capture++;
  }
  return params;
}

function listFilesRecursive(dir: string, acc: string[], depth: number): void {
  if (depth > 12 || acc.length > 5000) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      listFilesRecursive(full, acc, depth + 1);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (IMAGE_EXTS.has(ext)) {
        acc.push(full);
      }
    }
  }
}

function toInfo(
  file: string,
  rel: string,
  pat: EventPatternInfo | undefined,
  fixed: Record<string, string>
): ResolvedImageInfo {
  const params = pat ? extractPatternParams(pat.pathTemplate, rel, fixed) : { ...fixed };
  return {
    uri: vscode.Uri.file(file),
    fileName: path.basename(file),
    fsPath: file,
    relativePath: rel,
    params,
    patternKey: pat?.patternKey,
    pathTemplate: pat?.pathTemplate,
  };
}

export async function resolveImagesForCall(
  site: ImageCallSite,
  patterns: EventPatternInfo[],
  options?: { maxResults?: number }
): Promise<ResolvedImageInfo[]> {
  const limit = options?.maxResults ?? MAX_RESULTS;
  const roots = await getImageRoots();
  if (roots.length === 0) {
    return [];
  }

  if (site.kind === 'set_background_path' && site.literalPath) {
    return resolveLiteral(site.literalPath, roots);
  }

  const key = site.patternKey ?? 'main';
  const matching = patterns.filter((p) => p.patternKey === key);
  if (matching.length === 0) {
    return [];
  }

  const results: ResolvedImageInfo[] = [];
  const seen = new Set<string>();
  const steps = site.steps.length > 0 ? site.steps : [undefined];
  const baseConstraints = site.paramConstraints ?? {};

  for (const pat of matching) {
    const constraints = constraintsForTemplate(pat.pathTemplate, baseConstraints);
    const combos = expandConstraintCombos(constraints);
    for (const step of steps) {
      for (const combo of combos) {
        const fixed: Record<string, string> = { ...combo };
        if (step !== undefined) {
          fixed.step = String(step);
        }
        const regex = templateToRegex(pat.pathTemplate, fixed);
        const dirHint = pathTemplateDirHint(pat.pathTemplate, fixed);

        for (const root of roots) {
          const searchDir = dirHint ? path.join(root, dirHint) : root;
          if (!fs.existsSync(searchDir)) {
            continue;
          }
          const files: string[] = [];
          listFilesRecursive(searchDir, files, 0);
          const hits: [string, string][] = [];
          for (const file of files) {
            const rel = path.relative(root, file).replace(/\\/g, '/');
            if (regex.test(rel) && !seen.has(file)) {
              hits.push([file, rel]);
            }
          }
          // Exact files before `$` wildcard files, like the engine. The same name in two
          // formats (a new PNG capture next to the old WEBP, before conversion): newest first.
          const stem = (rel: string) => rel.replace(/\.[^./]+$/, '');
          const mtime = (file: string) => {
            try {
              return fs.statSync(file).mtimeMs;
            } catch {
              return 0;
            }
          };
          hits.sort((a, b) => wildcardCount(a[1]) - wildcardCount(b[1]) || (stem(a[1]) === stem(b[1]) ? mtime(b[0]) - mtime(a[0]) : stem(a[1]) < stem(b[1]) ? -1 : 1));
          for (const [file, rel] of hits) {
            seen.add(file);
            results.push(toInfo(file, rel, pat, fixed));
            if (results.length >= limit) {
              return results;
            }
          }
        }
      }
    }
  }

  return results;
}

function pathTemplateDirHint(template: string, fixed: Record<string, string>): string | undefined {
  let t = normalizePatternPath(template);
  for (const [key, value] of Object.entries(fixed)) {
    t = t.split(`<${key}>`).join(value);
  }
  const idx = t.search(/<[^>]+>/);
  const prefix = idx >= 0 ? t.slice(0, idx) : t;
  const lastSlash = prefix.lastIndexOf('/');
  if (lastSlash <= 0) {
    return undefined;
  }
  return prefix.slice(0, lastSlash);
}

function resolveLiteral(rel: string, roots: string[]): ResolvedImageInfo[] {
  const normalized = normalizePatternPath(rel);
  for (const root of roots) {
    const candidates = [
      path.join(root, normalized),
      path.join(root, normalized + '.webp'),
      path.join(root, normalized + '.png'),
      path.join(root, normalized + '.jpg'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        const fileRel = path.relative(root, c).replace(/\\/g, '/');
        return [toInfo(c, fileRel, undefined, {})];
      }
    }
    const dir = path.dirname(path.join(root, normalized));
    const base = path.basename(normalized);
    if (fs.existsSync(dir)) {
      try {
        for (const name of fs.readdirSync(dir)) {
          if (name === base || name.startsWith(base + '.')) {
            const full = path.join(dir, name);
            if (IMAGE_EXTS.has(path.extname(name).toLowerCase())) {
              const fileRel = path.relative(root, full).replace(/\\/g, '/');
              return [toInfo(full, fileRel, undefined, {})];
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  return [];
}

export function formatPatternParams(params: Record<string, string>): string {
  const keys = Object.keys(params).sort();
  if (keys.length === 0) {
    return '';
  }
  return keys.map((k) => `${k}=${params[k]}`).join('\n');
}
