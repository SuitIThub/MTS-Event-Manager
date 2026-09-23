import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { PORTRAIT_IMAGE_EXTS, PortraitStore } from './portraitStore';

/**
 * Map person key → portrait image path, from the bundled `assets/` portraits plus the
 * user's custom `PortraitStore` entries (custom wins). Shared by the inline decorator
 * and the event-preview panel so both draw the same portraits — mod characters without
 * a bundled portrait simply have no entry and callers fall back to a name/initial.
 */
export function collectPortraitFiles(
  context: vscode.ExtensionContext,
  store: PortraitStore
): Map<string, string> {
  const out = new Map<string, string>();
  const dir = context.asAbsolutePath('assets');
  try {
    for (const name of fs.readdirSync(dir)) {
      const ext = path.extname(name).toLowerCase();
      if (!PORTRAIT_IMAGE_EXTS.has(ext)) {
        continue;
      }
      out.set(path.basename(name, ext), path.join(dir, name));
    }
  } catch {
    /* no assets dir */
  }
  for (const custom of store.list()) {
    if (fs.existsSync(custom.path)) {
      out.set(custom.key, custom.path);
    }
  }
  return out;
}

/** Directories that hold portrait files, for the webview's localResourceRoots. */
export function portraitRoots(
  context: vscode.ExtensionContext,
  store: PortraitStore
): vscode.Uri[] {
  const roots = new Set<string>();
  roots.add(context.asAbsolutePath('assets'));
  for (const custom of store.list()) {
    roots.add(path.dirname(custom.path));
  }
  return [...roots].map((r) => vscode.Uri.file(r));
}
