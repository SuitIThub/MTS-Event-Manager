import * as vscode from 'vscode';
import { WorkspaceIndex } from './indexer';
import { parseLabelsInDocument } from './parseLabels';
import { PortraitStore } from './portraitStore';
import { showEventPreview } from './previewPanel';
import { applyVerifiedEdits } from './safeEdit';
import { planNewEvent } from './sceneOps';

const RECEIVER_RE = /([A-Za-z_][A-Za-z0-9_.]*(?:\[[^\]\n]+\])*)\s*\.\s*add_event\s*\(/g;
const STORAGE_RE = /add_storage\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*EventStorage\s*\(\s*(['"])([^'"]+)\2/g;
const STORAGE_VAR_RE = /^[ \t]*\$?[ \t]*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*EventStorage\s*\(/gm;

/** Event pools: ones this file already adds to first, then every storage in the workspace. */
export async function discoverPools(text: string): Promise<string[]> {
  const local = new Map<string, number>();
  for (const m of text.matchAll(RECEIVER_RE)) {
    local.set(m[1], (local.get(m[1]) ?? 0) + 1);
  }
  const global = new Set<string>();
  const files = await vscode.workspace.findFiles('**/*.rpy', '**/{node_modules,out,.git}/**');
  for (const uri of files) {
    let body: string;
    try {
      body = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      continue;
    }
    for (const m of body.matchAll(STORAGE_RE)) {
      global.add(`${m[1]}["${m[3]}"]`);
    }
    for (const m of body.matchAll(STORAGE_VAR_RE)) {
      global.add(m[1]);
    }
  }
  const ranked = [...local.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  return [...ranked, ...[...global].filter((p) => !local.has(p)).sort()];
}

/** Suggest `images/…/<label>/<label> <step>.webp` from the file's existing patterns. */
export function suggestPatternPath(text: string, label: string): string {
  const bases = new Map<string, number>();
  for (const m of text.matchAll(/Pattern\s*\(\s*['"][^'"]+['"]\s*,\s*(['"])([^'"]+)\1/g)) {
    const segs = m[2].replace(/^\/+/, '').split('/');
    if (segs.length >= 3) {
      const base = segs.slice(0, -2).join('/') + '/';
      bases.set(base, (bases.get(base) ?? 0) + 1);
    }
  }
  const base = [...bases.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'images/events/';
  return `${base}${label}/${label} <step>.webp`;
}

/**
 * Create a new event: definition in the file's init block (registered in a pool) plus a
 * scene label skeleton — planned, verified and written as one reversible change, then
 * opened in the event preview with the definition editor.
 */
export async function createNewEvent(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex,
  store: PortraitStore,
  uriArg?: string
): Promise<void> {
  const active = vscode.window.activeTextEditor?.document;
  let uri = uriArg ? vscode.Uri.parse(uriArg) : active?.fileName.endsWith('.rpy') ? active.uri : undefined;
  if (!uri) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'Ren\'Py scripts': ['rpy'] },
      openLabel: 'Create the event in this file',
    });
    uri = picked?.[0];
  }
  if (!uri) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  const text = doc.getText();

  const label = await vscode.window.showInputBox({
    title: 'New event (1/4) — label name',
    prompt: 'The scene label and event name, e.g. cafeteria_snack_chat',
    validateInput: (v) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) {
        return 'Use letters, digits and underscores; start with a letter.';
      }
      return index.getLabel(v) ? `A label "${v}" already exists in the workspace.` : undefined;
    },
  });
  if (!label) {
    return;
  }

  const pools = await discoverPools(text);
  const OTHER = '$(edit) Other pool expression…';
  const poolPick = await vscode.window.showQuickPick([...pools, OTHER], {
    title: 'New event (2/4) — which pool should offer it?',
    placeHolder: 'Pools used in this file come first',
  });
  if (!poolPick) {
    return;
  }
  const pool =
    poolPick === OTHER
      ? await vscode.window.showInputBox({ title: 'Pool expression', prompt: 'e.g. cafeteria_events["order_food"]' })
      : poolPick;
  if (!pool) {
    return;
  }

  const prio = await vscode.window.showQuickPick(
    [
      { label: '3', description: 'random ambient (default)' },
      { label: '2', description: 'always runs' },
      { label: '1', description: 'blocking story beat' },
    ],
    { title: 'New event (3/4) — priority' }
  );
  if (!prio) {
    return;
  }

  const patternPath = await vscode.window.showInputBox({
    title: 'New event (4/4) — main image pattern',
    prompt: 'Path template for Pattern("main", …). Leave empty for an event without images.',
    value: suggestPatternPath(text, label),
  });
  if (patternPath === undefined) {
    return;
  }

  const plan = planNewEvent(text, {
    label,
    priority: Number(prio.label) as 1 | 2 | 3,
    pool,
    patternPath,
    items: [],
  });
  if ('error' in plan) {
    void vscode.window.showWarningMessage(plan.error);
    return;
  }
  const error = await applyVerifiedEdits(uri, text, plan.edits, `Create event ${label}`);
  if (error) {
    void vscode.window.showWarningMessage(error);
    return;
  }
  await index.reindex();
  const created = (await vscode.workspace.openTextDocument(uri)).getText();
  const lab = parseLabelsInDocument(uri, created).find((l) => l.name === label);
  void vscode.window.showInformationMessage(`Created event ${label}. Add conditions and selectors in the definition editor.`);
  await showEventPreview(context, index, store, uri, lab?.range.start.line ?? 0, 'def');
}
