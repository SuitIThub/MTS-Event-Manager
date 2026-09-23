import * as fs from 'fs';
import * as path from 'path';
import { applyEdits, insertArgEdit, parsePyCall, PyCall, removeArgEdit, replaceValueEdit, TextEdit } from './pyCall';
import { readStringLiteral } from './scan';

/**
 * Videos in MTS: `image.show_video(step, pause = …)` resolves the pattern image for the
 * step, derives the displayable name `<video_prefix><basename>` (default prefix `anim_`,
 * spaces → `_`) and shows it with `scene expression name`. That name must be declared
 * as `image anim_… = Movie(play = "….webm", start_image = "….webp", loop = True)`.
 */

export interface MovieDef {
  name: string;
  /** 0-based line of the `image` statement. */
  line: number;
  /** Resolved `play` path (game-relative), when it is a static string expression. */
  play?: string;
  startImage?: string;
  loop: boolean;
  /** Offset of `Movie` in the file text (for surgical edits). */
  callStart: number;
}

export const DEFAULT_VIDEO_PREFIX = 'anim_';

/** Same derivation as `Image_Series.show_video`: prefix + basename up to the first dot. */
export function movieNameFor(imagePath: string, prefix = DEFAULT_VIDEO_PREFIX): string {
  const base = imagePath.replace(/\\/g, '/').split('/').pop() ?? '';
  return prefix + base.split('.')[0].replace(/ /g, '_');
}

const DEFINE_RE = /^define[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/;
const MOVIE_RE = /^image[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(Movie)[ \t]*\(/;

/** `define NAME = "string"` constants of a file (used to build Movie paths). */
export function scanStringDefines(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let offset = 0;
  for (const row of text.split('\n')) {
    const m = DEFINE_RE.exec(row);
    if (m) {
      const lit = readStringLiteral(text, offset + m[0].length);
      const rest = lit ? text.slice(lit.end, offset + row.length).trim() : '';
      if (lit && (rest === '' || rest.startsWith('#'))) {
        out.set(m[1], lit.value);
      }
    }
    offset += row.length + 1;
  }
  return out;
}

/** Evaluate `a + "b" + 'c'` made of string literals and known string constants. */
export function evalStringExpr(code: string, defines: Map<string, string>): string | undefined {
  let out = '';
  let i = 0;
  const n = code.length;
  const skip = () => {
    while (i < n && /[ \t\r\n]/.test(code[i])) {
      i++;
    }
  };
  skip();
  for (;;) {
    if (code[i] === '"' || code[i] === "'") {
      const lit = readStringLiteral(code, i);
      if (!lit) {
        return undefined;
      }
      out += lit.value;
      i = lit.end;
    } else {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(code.slice(i));
      if (!m || !defines.has(m[0])) {
        return undefined;
      }
      out += defines.get(m[0]);
      i += m[0].length;
    }
    skip();
    if (i >= n) {
      return out;
    }
    if (code[i] !== '+') {
      return undefined;
    }
    i++;
    skip();
  }
}

/** Every `image NAME = Movie(...)` of a file. */
export function scanMovieDefs(text: string, defines = scanStringDefines(text)): MovieDef[] {
  const out: MovieDef[] = [];
  let offset = 0;
  const rows = text.split('\n');
  for (let line = 0; line < rows.length; line++) {
    const row = rows[line];
    const m = MOVIE_RE.exec(row);
    if (m) {
      const callStart = offset + m[0].lastIndexOf('Movie');
      const call = parsePyCall(text, callStart);
      if (call) {
        out.push({ name: m[1], line, callStart, ...movieArgs(call, defines) });
      }
    }
    offset += row.length + 1;
  }
  return out;
}

function movieArgs(call: PyCall, defines: Map<string, string>): { play?: string; startImage?: string; loop: boolean } {
  const kw = (name: string) => call.args.find((a) => a.name === name)?.value;
  const play = kw('play') ?? call.args.find((a) => !a.name && !a.star)?.value;
  const start = kw('start_image');
  return {
    play: play ? evalStringExpr(play, defines) : undefined,
    startImage: start ? evalStringExpr(start, defines) : undefined,
    loop: (kw('loop') ?? '').trim() === 'True',
  };
}

/**
 * `video_prefix` passed to the `convert_pattern` that bound `variable` (last binding
 * before `beforeLine`), else the engine default.
 */
export function videoPrefixFor(lines: string[], variable: string | undefined, fromLine: number, beforeLine: number): string {
  if (!variable) {
    return DEFAULT_VIDEO_PREFIX;
  }
  const re = new RegExp(`^\\s*\\$?\\s*${variable}\\s*=\\s*convert_pattern(?:_with_data)?\\s*\\((.*)$`);
  let prefix = DEFAULT_VIDEO_PREFIX;
  for (let i = Math.max(0, fromLine); i < Math.min(beforeLine, lines.length); i++) {
    const m = re.exec(lines[i]);
    if (m) {
      const p = /\bvideo_prefix\s*=\s*(['"])([^'"]*)\1/.exec(m[1]);
      prefix = p ? p[2] : DEFAULT_VIDEO_PREFIX;
    }
  }
  return prefix;
}

/** Existing file for a game-relative path under any of the image roots. */
export function findUnderRoots(rel: string, roots: string[]): string | undefined {
  for (const root of roots) {
    const abs = path.join(root, rel);
    try {
      if (fs.statSync(abs).isFile()) {
        return abs;
      }
    } catch {
      /* not under this root */
    }
  }
  return undefined;
}

/** `images/…/x 7 5.webp` → `images/…/x 7 5.webm` (the engine's sibling-file convention). */
export function siblingVideoPath(imageRel: string): string {
  return imageRel.replace(/\.[A-Za-z0-9]+$/, '') + '.webm';
}

/**
 * Source for a new `image NAME = Movie(...)` line in the style of the file: when a
 * `define X = "prefix"` covers the path (e.g. `anim_sde5_path`), paths are written as
 * `X + "rest"`, otherwise as plain literals.
 */
export function buildMovieDefLine(
  name: string,
  imageRel: string,
  loop: boolean,
  defines: Map<string, string>
): string {
  const videoRel = siblingVideoPath(imageRel);
  let best: [string, string] | undefined;
  for (const [k, v] of defines) {
    if (v && imageRel.startsWith(v) && videoRel.startsWith(v) && (!best || v.length > best[1].length)) {
      best = [k, v];
    }
  }
  const lit = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const expr = (p: string) => (best ? `${best[0]} + ${lit(p.slice(best[1].length))}` : lit(p));
  return `image ${name} = Movie(play = ${expr(videoRel)}, start_image = ${expr(imageRel)}${loop ? ', loop = True' : ''})`;
}

/**
 * Where a new Movie line goes: after the last Movie line playing from the same folder
 * (keeps the game's grouped blocks), else directly above the event's top-level label.
 */
export function movieInsertLine(defs: MovieDef[], imageRel: string, labelLine: number): number {
  const dir = imageRel.slice(0, imageRel.lastIndexOf('/') + 1);
  const related = defs.filter((d) => !!d.play && d.play.slice(0, d.play.lastIndexOf('/') + 1) === dir);
  if (related.length) {
    return Math.max(...related.map((d) => d.line)) + 1;
  }
  return labelLine;
}

// ── Verified edit plans ───────────────────────────────────────────────────

export type VideoPlan = { edits: TextEdit[]; text: string; notes?: string[] } | { error: string };

export interface NewMovie {
  name: string;
  /** Game-relative start image (the pattern file); the video is its `.webm` sibling. */
  imageRel: string;
  loop: boolean;
}

/**
 * Add `image NAME = Movie(...)` lines (one block, sorted naturally) next to the existing
 * Movie lines of the same folder, else directly above the event label at `labelLine`.
 * Verified by re-scanning: exactly the new names appear, each playing its sibling video,
 * and every other line of the file is untouched.
 */
export function planAddMovieDefs(text: string, movies: NewMovie[], labelLine: number): VideoPlan {
  const defines = scanStringDefines(text);
  const before = scanMovieDefs(text, defines);
  const existing = new Set(before.map((d) => d.name));
  const fresh = movies
    .filter((m, i) => !existing.has(m.name) && movies.findIndex((x) => x.name === m.name) === i)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!fresh.length) {
    return { error: 'All Movie definitions already exist — nothing to add.' };
  }
  const rows = text.split('\n');
  const at = Math.min(movieInsertLine(before, fresh[0].imageRel, labelLine), rows.length);
  const block = fresh.map((m) => buildMovieDefLine(m.name, m.imageRel, m.loop, defines));
  // Above a label, keep a blank line between the previous block and the new one.
  const prevRow = (rows[at - 1] ?? '').trim();
  const lead = at === labelLine && prevRow !== '' && !MOVIE_RE.test(prevRow) && !DEFINE_RE.test(prevRow) ? '\n' : '';
  let offset = 0;
  for (let i = 0; i < at; i++) {
    offset += rows[i].length + 1;
  }
  const edit: TextEdit = { start: offset, end: offset, text: lead + block.join('\n') + '\n' };
  const planned = applyEdits(text, [edit]);

  // Verify.
  const after = scanMovieDefs(planned, scanStringDefines(planned));
  const added = after.filter((d) => !existing.has(d.name));
  if (added.length !== fresh.length) {
    return { error: 'Verification failed: the new Movie lines did not parse. Nothing was written.' };
  }
  for (const m of fresh) {
    const d = added.find((x) => x.name === m.name);
    if (!d || d.play !== siblingVideoPath(m.imageRel) || d.startImage !== m.imageRel || d.loop !== m.loop) {
      return { error: `Verification failed for ${m.name}. Nothing was written.` };
    }
  }
  const plannedRows = planned.split('\n');
  const insertedRows = (lead ? 1 : 0) + block.length;
  const untouched =
    plannedRows.slice(0, at).join('\n') === rows.slice(0, at).join('\n') &&
    plannedRows.slice(at + insertedRows).join('\n') === rows.slice(at).join('\n');
  if (!untouched) {
    return { error: 'Verification failed: other lines would change. Nothing was written.' };
  }
  return { edits: [edit], text: planned };
}

/** Toggle `loop = True` on an existing Movie definition (surgical, verified). */
export function planSetMovieLoop(text: string, name: string, loop: boolean): VideoPlan {
  const defs = scanMovieDefs(text);
  const def = defs.find((d) => d.name === name);
  if (!def) {
    return { error: `Movie ${name} is not defined in this file.` };
  }
  if (def.loop === loop) {
    return { error: `Movie ${name} already ${loop ? 'loops' : 'plays once'}.` };
  }
  const call = parsePyCall(text, def.callStart);
  if (!call) {
    return { error: `Could not parse the Movie(...) of ${name}.` };
  }
  const idx = call.args.findIndex((a) => a.name === 'loop');
  let edit: TextEdit;
  if (loop) {
    edit = idx >= 0 ? replaceValueEdit(call.args[idx], 'True') : insertArgEdit(text, call, 'loop = True', { keyword: true });
  } else {
    if (idx < 0) {
      return { error: `Movie ${name} has no loop argument.` };
    }
    edit = removeArgEdit(text, call, idx);
  }
  const planned = applyEdits(text, [edit]);
  const after = scanMovieDefs(planned).find((d) => d.name === name);
  if (!after || after.loop !== loop || after.play !== def.play || after.startImage !== def.startImage || after.line !== def.line) {
    return { error: 'Verification failed: the Movie definition would change otherwise. Nothing was written.' };
  }
  const newCall = parsePyCall(planned, def.callStart);
  if (!newCall || planned.slice(0, def.callStart) !== text.slice(0, def.callStart) || planned.slice(newCall.close) !== text.slice(call.close)) {
    return { error: 'Verification failed: text outside the Movie call would change. Nothing was written.' };
  }
  return { edits: [edit], text: planned };
}
