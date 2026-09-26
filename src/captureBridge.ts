import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CoverageRow, fill, runEventCheck } from './eventCheck';
import { WorkspaceIndex } from './indexer';
import { parseLabelsInDocument } from './parseLabels';
import { getImageRoots, normalizePatternPath } from './patternResolve';

/**
 * Bridge to the StudioNeoV2 capture plugin (studio-capture/): the event open in the event
 * editor is written as a JSON file listing every image target with its absolute path.
 * The plugin only displays, sorts and copies — all game knowledge stays here.
 */

export const BRIDGE_VERSION = 1;
/** Upper bound of targets written (wildcard subsets can multiply). */
const MAX_TARGETS = 5000;

export type TargetStatus = 'exact' | 'wildcard' | 'missing';

export interface CaptureTarget {
  id: string;
  pattern: string;
  step: number | null;
  /** Placeholder values of the file, `step` included; `$` for a wildcard file. */
  values: Record<string, string>;
  /** exact: its own file exists · wildcard: only a `$` file serves it · missing. */
  status: TargetStatus;
  /** True when this target IS a `$` file (serves every value of those keys). */
  wildcard: boolean;
  /** Absolute path the capture is copied to (PNG). */
  path: string;
  /** Absolute path of the file serving it now, if any. */
  existing?: string;
  lines: number[];
}

export interface BridgeData {
  version: number;
  written: string;
  event: string | null;
  file?: string;
  /** Keys in the order of the pattern (step last); the plugin reorders them. */
  keys: string[];
  keyValues: Record<string, string[]>;
  /** Directories the plugin may write into (game/images, game/mods/<Mod>/images). */
  allowedRoots: string[];
  targets: CaptureTarget[];
  truncated?: boolean;
}

export function defaultBridgeFile(): string {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'MTS-Event-Manager', 'capture', 'active-event.json');
}

export function bridgeFile(): string {
  const configured = vscode.workspace.getConfiguration('mtsEventManager').get<string>('capture.bridgeFile', '').trim();
  return configured || defaultBridgeFile();
}

export function captureEnabled(): boolean {
  return vscode.workspace.getConfiguration('mtsEventManager').get<boolean>('capture.enabled', true);
}

/** Game (or mod) root a new file of this event belongs to: the longest root containing its definition. */
export function rootFor(roots: string[], definitionFile: string | undefined): string | undefined {
  const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  const def = definitionFile ? norm(definitionFile) : undefined;
  const sorted = [...roots].sort((a, b) => b.length - a.length);
  const hit = def ? sorted.find((r) => def.startsWith(norm(r) + '/')) : undefined;
  // A base-game event lives in game/scripts: the game root (not a mod root) serves it.
  return hit ?? sorted.find((r) => !/[\\/]mods[\\/][^\\/]+$/.test(r));
}

/** `images/a/b 3 0.webp` under `root` → absolute `…/b 3 0.png`. */
export function targetPath(root: string, relative: string): string {
  const rel = normalizePatternPath(relative).replace(/\.(webp|png|jpe?g)$/i, '');
  return path.join(root, ...rel.split('/')) + '.png';
}

/** Existing file for a relative path, any image extension. */
function existingFile(root: string, relative: string): string | undefined {
  const base = path.join(root, ...normalizePatternPath(relative).replace(/\.(webp|png|jpe?g)$/i, '').split('/'));
  for (const ext of ['.webp', '.png', '.jpg', '.jpeg']) {
    if (fs.existsSync(base + ext)) {
      return base + ext;
    }
  }
  return undefined;
}

/** Non-empty subsets of `keys` (for the `$` wildcard targets), smallest first. */
function subsets(keys: string[]): string[][] {
  const out: string[][] = [];
  for (let mask = 1; mask < 1 << keys.length; mask++) {
    out.push(keys.filter((_, i) => mask & (1 << i)));
  }
  return out.sort((a, b) => a.length - b.length);
}

/**
 * Targets of the coverage rows (videos excluded — a capture is a still). Every row's cells
 * become targets; for each cell also its `$` variants (one or more keys as `$`).
 */
export function buildTargets(
  coverage: CoverageRow[],
  root: string,
  gameRoots: string[]
): { targets: CaptureTarget[]; keys: string[]; keyValues: Record<string, string[]>; truncated: boolean } {
  const targets: CaptureTarget[] = [];
  const seen = new Set<string>();
  const keyOrder: string[] = [];
  const keyValues: Record<string, Set<string>> = {};
  let truncated = false;
  const find = (rel: string) => {
    for (const r of [root, ...gameRoots.filter((g) => g !== root)]) {
      const f = existingFile(r, rel);
      if (f) {
        return f;
      }
    }
    return undefined;
  };
  const push = (t: CaptureTarget) => {
    if (seen.has(t.path.toLowerCase())) {
      return;
    }
    if (targets.length >= MAX_TARGETS) {
      truncated = true;
      return;
    }
    seen.add(t.path.toLowerCase());
    targets.push(t);
  };
  for (const row of coverage) {
    if (row.video) {
      continue;
    }
    for (const k of row.keys) {
      if (!keyOrder.includes(k)) {
        keyOrder.push(k);
      }
    }
    for (const cell of row.cells) {
      const values: Record<string, string> = { ...cell.combo };
      if (row.step !== null) {
        values.step = String(row.step);
      }
      for (const [k, v] of Object.entries(values)) {
        (keyValues[k] ??= new Set()).add(v);
      }
      const id = `${row.patternKey}|${JSON.stringify(values)}`;
      push({
        id,
        pattern: row.patternKey,
        step: row.step,
        values,
        status: cell.status,
        wildcard: false,
        path: targetPath(root, cell.expected),
        existing: cell.file ? find(cell.file) : undefined,
        lines: row.lines,
      });
    }
    // `$` files: the engine falls back to them for any value of those keys (never for step).
    const wildKeys = row.keys.filter((k) => k !== 'step');
    for (const cell of row.cells) {
      for (const subset of subsets(wildKeys)) {
        const combo = { ...cell.combo };
        for (const k of subset) {
          combo[k] = '$';
        }
        if (!row.template) {
          break;
        }
        const rel = fill(row.template, combo, row.step);
        const values: Record<string, string> = { ...combo };
        if (row.step !== null) {
          values.step = String(row.step);
        }
        const existing = find(rel);
        push({
          id: `${row.patternKey}|${JSON.stringify(values)}`,
          pattern: row.patternKey,
          step: row.step,
          values,
          status: existing ? 'exact' : 'missing',
          wildcard: true,
          path: targetPath(root, rel),
          existing,
          lines: row.lines,
        });
      }
    }
  }
  for (const set of Object.values(keyValues)) {
    set.add('$');
  }
  const keys = [...keyOrder.filter((k) => k !== 'step'), ...(Object.keys(keyValues).includes('step') ? ['step'] : [])];
  const kv: Record<string, string[]> = {};
  for (const k of keys) {
    const vals = [...(keyValues[k] ?? [])].filter((v) => k !== 'step' || v !== '$');
    kv[k] = vals.sort((a, b) => (a === '$' ? -1 : b === '$' ? 1 : Number.isFinite(Number(a)) && Number.isFinite(Number(b)) ? Number(a) - Number(b) : a.localeCompare(b)));
  }
  return { targets, keys, keyValues: kv, truncated };
}

async function writeAtomic(file: string, data: BridgeData): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 1), 'utf8');
  await fs.promises.rename(tmp, file);
}

interface ActiveEvent {
  uri: vscode.Uri;
  line: number;
  /** Event label (navigating within one event does not rewrite the bridge). */
  event: string;
}

let instance: CaptureBridge | undefined;

/** Called by the event editor whenever it shows an event (undefined: nothing shown). */
export function notifyActiveEvent(active: ActiveEvent | undefined): void {
  instance?.setActive(active);
}

/**
 * Keeps the bridge file in sync with the event editor: rewritten (debounced) when the
 * active event changes, its file is saved, or images appear / disappear.
 */
export class CaptureBridge implements vscode.Disposable {
  private active: ActiveEvent | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> = Promise.resolve();
  private lastKey = '';
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly index: WorkspaceIndex) {
    instance = this;
    const watcher = vscode.workspace.createFileSystemWatcher('**/images/**/*.{png,webp,jpg,jpeg}');
    const onImages = () => this.schedule(true);
    this.subs.push(watcher, watcher.onDidCreate(onImages), watcher.onDidDelete(onImages));
    this.subs.push(
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (this.active && d.uri.toString() === this.active.uri.toString()) {
          this.schedule(true);
        }
      })
    );
  }

  /** The event editor shows the event at `line` of `uri` (undefined: panel closed). */
  setActive(active: ActiveEvent | undefined): void {
    const key = active ? `${active.uri.toString()}#${active.event}` : '';
    if (key === this.lastKey) {
      return;
    }
    this.lastKey = key;
    this.active = active;
    this.schedule(false);
  }

  private schedule(force: boolean): void {
    if (!captureEnabled()) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.running.then(() => this.write()).catch((e) => console.error('[MTS capture bridge]', e));
    }, force ? 400 : 250);
  }

  private async write(): Promise<void> {
    const file = bridgeFile();
    const active = this.active;
    if (!active) {
      await writeAtomic(file, { version: BRIDGE_VERSION, written: new Date().toISOString(), event: null, keys: [], keyValues: {}, allowedRoots: [], targets: [] });
      return;
    }
    const doc = await vscode.workspace.openTextDocument(active.uri);
    const text = doc.getText();
    const labels = parseLabelsInDocument(doc.uri, text);
    const result = await runEventCheck(this.index, doc.uri, text, labels, active.line);
    const eventLabel = result.eventLabel;
    const defs = [...this.index.getEventsForLabel(eventLabel), ...this.index.getFragmentParents(eventLabel).flatMap((p) => this.index.getEventsForLabel(p))];
    const roots = await getImageRoots();
    const root = rootFor(roots, defs[0]?.uri.fsPath ?? doc.uri.fsPath);
    if (!root) {
      return;
    }
    const built = buildTargets(result.coverage, root, roots);
    await writeAtomic(file, {
      version: BRIDGE_VERSION,
      written: new Date().toISOString(),
      event: eventLabel || null,
      file: vscode.workspace.asRelativePath(doc.uri),
      keys: built.keys,
      keyValues: built.keyValues,
      allowedRoots: roots.map((r) => path.join(r, 'images')),
      targets: built.targets,
      truncated: built.truncated || undefined,
    });
  }

  dispose(): void {
    if (instance === this) {
      instance = undefined;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.subs.forEach((s) => s.dispose());
  }
}
