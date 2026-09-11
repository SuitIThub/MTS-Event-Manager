import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export const PORTRAIT_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

export interface CustomPortrait {
  key: string;
  path: string;
}

const STATE_KEY = 'customPortraits';

export class PortraitStore {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private get memento(): vscode.Memento {
    return vscode.workspace.workspaceFolders?.length
      ? this.context.workspaceState
      : this.context.globalState;
  }

  list(): CustomPortrait[] {
    const raw = this.memento.get<CustomPortrait[]>(STATE_KEY, []);
    if (!Array.isArray(raw)) {
      return [];
    }
    const out: CustomPortrait[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (!item || typeof item.key !== 'string' || typeof item.path !== 'string') {
        continue;
      }
      const key = normalizePortraitKey(item.key);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({ key, path: item.path });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  async upsert(key: string, imagePath: string): Promise<string | undefined> {
    const normalized = normalizePortraitKey(key);
    if (!normalized) {
      return 'Character key must look like sakura_mori (letters, digits, underscore).';
    }
    const resolved = path.resolve(imagePath);
    const ext = path.extname(resolved).toLowerCase();
    if (!PORTRAIT_IMAGE_EXTS.has(ext)) {
      return 'Image must be png, jpg, jpeg, webp, or gif.';
    }
    if (!fs.existsSync(resolved)) {
      return 'Image file not found.';
    }
    const next = this.list().filter((p) => p.key !== normalized);
    next.push({ key: normalized, path: resolved });
    await this.memento.update(STATE_KEY, next.sort((a, b) => a.key.localeCompare(b.key)));
    this.onDidChangeEmitter.fire();
    return undefined;
  }

  async remove(key: string): Promise<void> {
    const normalized = normalizePortraitKey(key);
    const next = this.list().filter((p) => p.key !== normalized);
    await this.memento.update(STATE_KEY, next);
    this.onDidChangeEmitter.fire();
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

export function normalizePortraitKey(raw: string): string | undefined {
  const key = raw.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return undefined;
  }
  return key;
}
