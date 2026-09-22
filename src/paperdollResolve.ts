import * as fs from 'fs';
import * as path from 'path';
import { getImageRoots } from './patternResolve';

/** House seeds from `Person.register_paperdoll` in character.rpy. */
export const HOUSE_VALUES: Record<string, string> = {
  mood: 'neutral',
  pose: '1',
  outfit: 'uniform',
  level: '1',
  mouth: 'closed',
  state: '',
  char_var: '1',
  look: 'follow',
  extra1: '',
  extra2: '',
};

export const HOUSE_ALT_KEYS = ['level', 'mouth', 'state', 'char_var', 'extra1', 'extra2'];

export const IMAGE_FIELDS = [
  'char_var',
  'pose',
  'outfit',
  'level',
  'state',
  'extra1',
  'mood',
  'mouth',
  'look',
  'extra2',
] as const;

export type ImageField = (typeof IMAGE_FIELDS)[number];

export const FIELD_LABELS: Record<ImageField, string> = {
  char_var: 'Variant',
  pose: 'Pose',
  outfit: 'Outfit',
  level: 'Level',
  state: 'State',
  extra1: 'Extra body',
  mood: 'Mood',
  mouth: 'Mouth',
  look: 'Gaze',
  extra2: 'Extra head',
};

/** Checkbox defaults match the house PDAImage style (pose/outfit/level/mood/mouth). */
export const DEFAULT_INCLUDE: Record<ImageField, boolean> = {
  char_var: false,
  pose: true,
  outfit: true,
  level: true,
  state: false,
  extra1: false,
  mood: true,
  mouth: true,
  look: false,
  extra2: false,
};

export const SCREEN_W = 1920;
export const SCREEN_H = 1080;
export const DISPLAY_W = 600;
export const DISPLAY_H = 1080;

export interface PdConfig {
  alignX: number;
  alignY: number;
  zoom: number;
  /** 1 unflipped, -1 mirrored. */
  flip: number;
  blur: number;
  bw: boolean;
  /** #rrggbbaa, alpha is the mix amount. */
  color: string;
}

export const DEFAULT_CONFIG: PdConfig = {
  alignX: -0.5,
  alignY: 0,
  zoom: 1,
  flip: 1,
  blur: 0,
  bw: false,
  color: '#00000000',
};

export interface MoveSpec {
  alignX?: number;
  alignY?: number;
  zoom?: number;
}

export interface PresetDef {
  name: string;
  steps: ({ preset: string } | { move: MoveSpec })[];
}

export const BUILTIN_PRESETS: PresetDef[] = [
  { name: 'outside', steps: [{ move: { alignX: -1.5 } }] },
  { name: 'close_body', steps: [{ move: { alignY: -0.1, zoom: 2 } }] },
  {
    name: 'close_body_center',
    steps: [{ preset: 'close_body' }, { move: { alignX: 0.5 } }],
  },
  {
    name: 'close_body_right',
    steps: [{ preset: 'close_body' }, { move: { alignX: 1 } }],
  },
  {
    name: 'close_body_left',
    steps: [{ preset: 'close_body' }, { move: { alignX: 0 } }],
  },
  { name: 'upper_body', steps: [{ move: { alignY: -0.1, zoom: 3 } }] },
  {
    name: 'upper_body_center',
    steps: [{ preset: 'upper_body' }, { move: { alignX: 0.5 } }],
  },
  {
    name: 'upper_body_right',
    steps: [{ preset: 'upper_body' }, { move: { alignX: 1 } }],
  },
  {
    name: 'upper_body_left',
    steps: [{ preset: 'upper_body' }, { move: { alignX: 0 } }],
  },
];

const PRESET_MATCH_ORDER = [
  'upper_body_center',
  'upper_body_left',
  'upper_body_right',
  'close_body_center',
  'close_body_left',
  'close_body_right',
  'upper_body',
  'close_body',
  'outside',
];

export interface BottomFile {
  charVar: string;
  pose: string;
  outfit: string;
  level: string;
  state: string;
  extra1: string;
  fsPath: string;
}

export interface TopFile {
  charVar: string;
  pose: string;
  mood: string;
  mouth: string;
  look: string;
  extra2: string;
  fsPath: string;
}

export interface PaperdollCharacter {
  name: string;
  bottoms: BottomFile[];
  tops: TopFile[];
}

export interface PaperdollCatalog {
  characters: Map<string, PaperdollCharacter>;
}

const IMAGE_EXTS = new Set(['.png', '.webp']);

let catalogCache: { key: string; catalog: PaperdollCatalog } | undefined;

export function clearPaperdollCatalog(): void {
  catalogCache = undefined;
}

export async function loadPaperdollCatalog(): Promise<PaperdollCatalog> {
  const roots = await getImageRoots();
  return catalogForRoots(roots);
}

export function catalogForRoots(roots: string[]): PaperdollCatalog {
  const key = roots.join('|');
  if (catalogCache?.key === key) {
    return catalogCache.catalog;
  }
  const catalog = scanPaperdollRoots(roots);
  catalogCache = { key, catalog };
  return catalog;
}

export function scanPaperdollRoots(roots: string[]): PaperdollCatalog {
  const characters = new Map<string, PaperdollCharacter>();
  for (const root of roots) {
    const dir = path.join(root, 'images', 'paperdoll');
    if (!fs.existsSync(dir)) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) {
        continue;
      }
      const name = ent.name;
      const charDir = path.join(dir, name);
      const existing = characters.get(name) ?? { name, bottoms: [], tops: [] };
      mergeFiles(existing.bottoms, readBottoms(charDir, name));
      mergeFiles(existing.tops, readTops(charDir, name));
      if (existing.bottoms.length > 0 || existing.tops.length > 0) {
        characters.set(name, existing);
      }
    }
  }
  return { characters };
}

function mergeFiles<T extends { fsPath: string }>(into: T[], extra: T[]): void {
  const byKey = new Map<string, T>();
  for (const file of into) {
    byKey.set(tokenKey(file), file);
  }
  for (const file of extra) {
    const key = tokenKey(file);
    const prev = byKey.get(key);
    if (!prev || preferPng(file.fsPath, prev.fsPath)) {
      byKey.set(key, file);
    }
  }
  into.length = 0;
  into.push(...byKey.values());
}

function tokenKey(file: object): string {
  return Object.entries(file)
    .filter(([k]) => k !== 'fsPath')
    .map(([, v]) => String(v))
    .join('\u0001');
}

/** Pattern paths end in `.png`, so a png wins over webp when both exist. */
function preferPng(next: string, prev: string): boolean {
  return path.extname(next).toLowerCase() === '.png' && path.extname(prev).toLowerCase() !== '.png';
}

function readBottoms(charDir: string, name: string): BottomFile[] {
  const out: BottomFile[] = [];
  for (const file of listImages(path.join(charDir, 'bottom'))) {
    const parts = tokensAfterName(file.stem, name);
    if (!parts) {
      continue;
    }
    const parsed = parseBottomTokens(parts);
    if (!parsed) {
      continue;
    }
    out.push({ ...parsed, fsPath: file.fsPath });
  }
  return out;
}

function readTops(charDir: string, name: string): TopFile[] {
  const out: TopFile[] = [];
  for (const file of listImages(path.join(charDir, 'top'))) {
    const parts = tokensAfterName(file.stem, name);
    if (!parts || parts.length < 4) {
      continue;
    }
    const look = parts.length >= 5 ? parts[4] : 'follow';
    const extra2 = parts.length >= 6 ? parts.slice(5).join(' ') : '$';
    out.push({
      charVar: parts[0],
      pose: parts[1],
      mood: parts[2],
      mouth: parts[3],
      look,
      extra2: extra2 || '$',
      fsPath: file.fsPath,
    });
  }
  return out;
}

/**
 * Bottoms are `<char_var> <pose> <outfit> <level> <state> <extra1>`.
 * A few outfits carry a space (`Nurse 01`) and then only a trailing `$`.
 */
function parseBottomTokens(
  parts: string[]
): Omit<BottomFile, 'fsPath'> | undefined {
  if (parts.length >= 6) {
    return {
      charVar: parts[0],
      pose: parts[1],
      outfit: parts[2],
      level: parts[3],
      state: parts.slice(4, -1).join(' ') || '$',
      extra1: parts[parts.length - 1] || '$',
    };
  }
  if (parts.length === 5 && parts[4] === '$' && /^\d{2}$/.test(parts[3])) {
    return {
      charVar: parts[0],
      pose: parts[1],
      outfit: `${parts[2]} ${parts[3]}`,
      level: '$',
      state: '$',
      extra1: '$',
    };
  }
  if (parts.length === 5) {
    return {
      charVar: parts[0],
      pose: parts[1],
      outfit: parts[2],
      level: parts[3],
      state: parts[4] || '$',
      extra1: '$',
    };
  }
  if (parts.length === 4) {
    return {
      charVar: parts[0],
      pose: parts[1],
      outfit: parts[2],
      level: parts[3],
      state: '$',
      extra1: '$',
    };
  }
  return undefined;
}

function tokensAfterName(stem: string, name: string): string[] | undefined {
  const prefix = name + ' ';
  if (!stem.startsWith(prefix)) {
    return undefined;
  }
  return stem.slice(prefix.length).split(' ').filter((p) => p.length > 0);
}

function listImages(dir: string): { stem: string; fsPath: string }[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out: { stem: string; fsPath: string }[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    const ext = path.extname(name).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) {
      continue;
    }
    out.push({
      stem: path.basename(name, ext),
      fsPath: path.join(dir, name),
    });
  }
  return out;
}

export function mergedValues(
  personDefaults: Record<string, string> | undefined,
  kwargs: Record<string, string> | undefined
): Record<string, string> {
  return { ...HOUSE_VALUES, ...(personDefaults ?? {}), ...(kwargs ?? {}) };
}

function isUnspecified(value: string | undefined): boolean {
  return value === undefined || value.trim() === '' || value === 'None';
}

function tokenValue(key: string, values: Record<string, string>, altKeys: string[]): string {
  const raw = values[key];
  if (altKeys.includes(key) && isUnspecified(raw)) {
    return '$';
  }
  if (raw === undefined || raw.trim() === '') {
    return '$';
  }
  return String(raw).trim();
}

function combinations(keys: string[]): string[][] {
  const out: string[][] = [[]];
  const rec = (start: number, acc: string[], r: number) => {
    if (acc.length === r) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < keys.length; i++) {
      acc.push(keys[i]);
      rec(i + 1, acc, r);
      acc.pop();
    }
  };
  for (let r = 1; r <= keys.length; r++) {
    rec(0, [], r);
  }
  return out;
}

const BOTTOM_FIELDS = ['char_var', 'pose', 'outfit', 'level', 'state', 'extra1'] as const;
const TOP_FIELDS = ['char_var', 'pose', 'mood', 'mouth', 'look', 'extra2'] as const;

export function resolveLayers(
  catalog: PaperdollCatalog,
  personKey: string,
  values: Record<string, string>,
  altKeys: string[] = HOUSE_ALT_KEYS
): { body?: string; head?: string } {
  const char = catalog.characters.get(personKey);
  if (!char) {
    return {};
  }
  return {
    body: resolveBottom(char.bottoms, values, altKeys)?.fsPath,
    head: resolveTop(char.tops, values, altKeys)?.fsPath,
  };
}

function resolveBottom(
  files: BottomFile[],
  values: Record<string, string>,
  altKeys: string[]
): BottomFile | undefined {
  return resolveGeneric(files, values, altKeys, BOTTOM_FIELDS, (file, tokens) => {
    return (
      file.charVar === tokens.char_var &&
      file.pose === tokens.pose &&
      file.outfit === tokens.outfit &&
      file.level === tokens.level &&
      file.state === tokens.state &&
      file.extra1 === tokens.extra1
    );
  }, true);
}

function resolveTop(
  files: TopFile[],
  values: Record<string, string>,
  altKeys: string[]
): TopFile | undefined {
  return resolveGeneric(files, values, altKeys, TOP_FIELDS, (file, tokens) => {
    return (
      file.charVar === tokens.char_var &&
      file.pose === tokens.pose &&
      file.mood === tokens.mood &&
      file.mouth === tokens.mouth &&
      file.look === tokens.look &&
      file.extra2 === tokens.extra2
    );
  }, false);
}

function resolveGeneric<T>(
  files: T[],
  values: Record<string, string>,
  altKeys: string[],
  fields: readonly string[],
  matches: (file: T, tokens: Record<string, string>) => boolean,
  levelFallback: boolean
): T | undefined {
  const presentAlt = altKeys.filter((k) => fields.includes(k));
  const forced = presentAlt.filter((k) => isUnspecified(values[k]));
  const combinable = presentAlt.filter((k) => !isUnspecified(values[k]));
  let best: { file: T; dollars: number } | undefined;
  for (const wild of combinations(combinable)) {
    const tokens: Record<string, string> = {};
    for (const field of fields) {
      if (forced.includes(field) || wild.includes(field)) {
        tokens[field] = '$';
      } else {
        tokens[field] = tokenValue(field, values, altKeys);
      }
    }
    let file = files.find((f) => matches(f, tokens));
    if (!file && levelFallback && tokens.level !== '$') {
      const leveled = nearestLevel(files as unknown as BottomFile[], tokens);
      if (leveled) {
        file = leveled as unknown as T;
      }
    }
    if (!file) {
      continue;
    }
    const dollars = Object.values(tokens).reduce((n, v) => n + (v === '$' ? 1 : 0), 0);
    if (!best || dollars < best.dollars) {
      best = { file, dollars };
    }
  }
  return best?.file;
}

function nearestLevel(files: BottomFile[], tokens: Record<string, string>): BottomFile | undefined {
  const requested = Number(tokens.level);
  if (!Number.isFinite(requested)) {
    return undefined;
  }
  const same = files.filter(
    (f) =>
      f.charVar === tokens.char_var &&
      f.pose === tokens.pose &&
      f.outfit === tokens.outfit &&
      f.state === tokens.state &&
      f.extra1 === tokens.extra1 &&
      f.level !== '$' &&
      Number.isFinite(Number(f.level))
  );
  const have = new Set(same.map((f) => Number(f.level)));
  const pick = (n: number) => same.find((f) => Number(f.level) === n);
  for (let i = Math.floor(requested); i >= 0; i--) {
    if (have.has(i)) {
      return pick(i);
    }
  }
  for (let i = Math.floor(requested) + 1; i <= 12; i++) {
    if (have.has(i)) {
      return pick(i);
    }
  }
  return undefined;
}

function altMatch(fileToken: string, selected: string | undefined): boolean {
  if (!selected || selected === '$') {
    return true;
  }
  return fileToken === selected || fileToken === '$';
}

export function optionsFor(
  catalog: PaperdollCatalog,
  personKey: string,
  values: Record<string, string>
): Record<ImageField, string[]> {
  const empty = Object.fromEntries(IMAGE_FIELDS.map((f) => [f, [] as string[]])) as Record<
    ImageField,
    string[]
  >;
  const char = catalog.characters.get(personKey);
  if (!char) {
    for (const field of IMAGE_FIELDS) {
      const current = values[field];
      empty[field] = current ? [current] : [];
    }
    return empty;
  }
  const bottoms = char.bottoms.filter((f) => altMatch(f.charVar, values.char_var));
  const poseFiles = bottoms.filter((f) => f.pose === values.pose || !values.pose);
  const outfitFiles = poseFiles.filter((f) => f.outfit === values.outfit || !values.outfit);
  const levelFiles = outfitFiles.filter((f) => altMatch(f.level, values.level));
  const stateFiles = levelFiles.filter((f) => altMatch(f.state, values.state));

  empty.char_var = uniqueSorted(char.bottoms.map((f) => f.charVar), true);
  empty.pose = uniqueSorted(
    char.bottoms.filter((f) => altMatch(f.charVar, values.char_var)).map((f) => f.pose),
    true
  );
  empty.outfit = uniqueSorted(
    char.bottoms
      .filter((f) => altMatch(f.charVar, values.char_var) && (f.pose === values.pose || !values.pose))
      .map((f) => f.outfit),
    false
  );
  empty.level = uniqueSorted(poseFiles.filter((f) => f.outfit === values.outfit).map((f) => f.level), true);
  empty.state = uniqueSorted(outfitFiles.filter((f) => altMatch(f.level, values.level)).map((f) => f.state), false);
  empty.extra1 = uniqueSorted(stateFiles.map((f) => f.extra1), false);

  const tops = char.tops.filter(
    (f) => altMatch(f.charVar, values.char_var) && (f.pose === values.pose || f.pose === '$')
  );
  const moodTops = tops.filter((f) => f.mood === values.mood);
  const mouthTops = moodTops.filter((f) => altMatch(f.mouth, values.mouth));
  const lookTops = mouthTops.filter((f) => f.look === values.look);
  empty.mood = uniqueSorted(tops.map((f) => f.mood), false);
  empty.mouth = uniqueSorted(moodTops.map((f) => f.mouth), false);
  empty.look = uniqueSorted(mouthTops.map((f) => f.look), false);
  empty.extra2 = uniqueSorted(lookTops.map((f) => f.extra2), false);

  for (const field of IMAGE_FIELDS) {
    const current = values[field];
    if (current && !empty[field].includes(current)) {
      empty[field] = sortTokens([current, ...empty[field]], field === 'char_var' || field === 'pose' || field === 'level');
    }
    if (empty[field].length === 0 && current) {
      empty[field] = [current];
    }
  }
  return empty;
}

export function clampValues(
  options: Record<ImageField, string[]>,
  values: Record<string, string>,
  fromField?: ImageField
): Record<string, string> {
  const next = { ...values };
  let clamping = !fromField;
  for (const field of IMAGE_FIELDS) {
    if (field === fromField) {
      clamping = true;
      continue;
    }
    if (!clamping) {
      continue;
    }
    const opts = options[field];
    if (!opts || opts.length === 0) {
      continue;
    }
    if (!opts.includes(next[field] ?? '')) {
      const concrete = opts.find((o) => o !== '$') ?? opts[0];
      next[field] = concrete;
    }
  }
  return next;
}

function uniqueSorted(values: string[], numeric: boolean): string[] {
  return sortTokens([...new Set(values)], numeric);
}

function sortTokens(values: string[], numeric: boolean): string[] {
  return [...values].sort((a, b) => {
    if (a === '$' && b !== '$') {
      return 1;
    }
    if (b === '$' && a !== '$') {
      return -1;
    }
    if (numeric) {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) {
        return na - nb;
      }
    }
    return a.localeCompare(b);
  });
}

export function expandPresetMoves(
  name: string,
  extra?: Map<string, PresetDef>,
  seen = new Set<string>()
): MoveSpec[] | undefined {
  if (seen.has(name)) {
    return [];
  }
  seen.add(name);
  const def = extra?.get(name) ?? BUILTIN_PRESETS.find((p) => p.name === name);
  if (!def) {
    return undefined;
  }
  const moves: MoveSpec[] = [];
  for (const step of def.steps) {
    if ('preset' in step) {
      const nested = expandPresetMoves(step.preset, extra, seen);
      if (!nested) {
        return undefined;
      }
      moves.push(...nested);
    } else {
      moves.push(step.move);
    }
  }
  return moves;
}

export function applyMoves(config: PdConfig, moves: MoveSpec[]): PdConfig {
  const next = { ...config };
  for (const move of moves) {
    if (move.alignX !== undefined) {
      next.alignX = move.alignX;
    }
    if (move.alignY !== undefined) {
      next.alignY = move.alignY;
    }
    if (move.zoom !== undefined) {
      next.zoom = move.zoom;
    }
  }
  return next;
}

export function presetMatching(
  before: PdConfig,
  desired: PdConfig,
  extra?: Map<string, PresetDef>
): string | undefined {
  for (const name of PRESET_MATCH_ORDER) {
    const moves = expandPresetMoves(name, extra);
    if (!moves) {
      continue;
    }
    const end = applyMoves(before, moves);
    if (
      near(end.alignX, desired.alignX) &&
      near(end.alignY, desired.alignY) &&
      near(end.zoom, desired.zoom)
    ) {
      return name;
    }
  }
  return undefined;
}

export function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.0005;
}

export function formatNum(n: number): string {
  const rounded = Math.round(n * 10000) / 10000;
  return String(rounded);
}

const NAMED_COLORS: Record<string, string> = {
  black: '000000',
  white: 'ffffff',
  gray: '808080',
  grey: '808080',
  silver: 'c0c0c0',
  lightgray: 'd3d3d3',
  lightgrey: 'd3d3d3',
  red: 'ff0000',
  darkred: '8b0000',
  maroon: '800000',
  crimson: 'dc143c',
  salmon: 'fa8072',
  coral: 'ff7f50',
  tomato: 'ff6347',
  pink: 'ffc0cb',
  hotpink: 'ff69b4',
  orange: 'ffa500',
  orangered: 'ff4500',
  gold: 'ffd700',
  yellow: 'ffff00',
  khaki: 'f0e68c',
  brown: 'a52a2a',
  chocolate: 'd2691e',
  tan: 'd2b48c',
  beige: 'f5f5dc',
  green: '00ff00',
  lime: '00ff00',
  darkgreen: '006400',
  olive: '808000',
  teal: '008080',
  cyan: '00ffff',
  aqua: '00ffff',
  turquoise: '40e0d0',
  blue: '0000ff',
  navy: '000080',
  darkblue: '00008b',
  indigo: '4b0082',
  azure: 'f0ffff',
  purple: '800080',
  violet: 'ee82ee',
  magenta: 'ff00ff',
  fuchsia: 'ff00ff',
  ivory: 'fffff0',
  transparent: '000000',
};

/** Normalize a paperdoll tint to `#rrggbbaa`. Unknown values become fully transparent. */
export function parsePaperdollColor(raw: string | undefined): string {
  if (!raw) {
    return '#00000000';
  }
  let text = raw.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  if (!text || text === 'None' || text === 'transparent') {
    return '#00000000';
  }
  let mix = 1;
  const colon = text.indexOf(':');
  if (colon > 0) {
    const amount = text.slice(colon + 1).trim();
    text = text.slice(0, colon).trim();
    if (amount.endsWith('%')) {
      mix = Number(amount.slice(0, -1)) / 100;
    } else {
      mix = Number(amount);
    }
    if (!Number.isFinite(mix)) {
      mix = 1;
    }
  }
  let hex = '';
  if (text.startsWith('#')) {
    const body = text.slice(1);
    if (body.length === 3 || body.length === 4) {
      hex = body
        .split('')
        .map((c) => c + c)
        .join('');
    } else if (body.length === 6 || body.length === 8) {
      hex = body;
    }
  } else {
    const named = NAMED_COLORS[text.toLowerCase()];
    if (named) {
      hex = named;
      if (text.toLowerCase() === 'transparent') {
        mix = 0;
      }
    }
  }
  if (hex.length === 6) {
    hex += 'ff';
  }
  if (hex.length !== 8) {
    return '#00000000';
  }
  const rgb = hex.slice(0, 6);
  const alpha = Math.round(clamp01(mix) * (parseInt(hex.slice(6, 8), 16) / 255) * 255);
  return `#${rgb}${alpha.toString(16).padStart(2, '0')}`;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export function colorChannels(hex: string): { r: number; g: number; b: number; a: number } {
  const h = parsePaperdollColor(hex).slice(1);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: parseInt(h.slice(6, 8), 16) / 255,
  };
}
