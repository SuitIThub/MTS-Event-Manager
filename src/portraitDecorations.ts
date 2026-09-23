import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { loadSharp } from './sharpRuntime';
import { WorkspaceIndex } from './indexer';
import { labelAtLine } from './parseImageCalls';
import { parseDialoguePortraitSites, personDisplayName, withExtraPersonKeys } from './parsePersons';
import { PortraitStore } from './portraitStore';
import { collectPortraitFiles } from './portraitResolve';

/** Native pixel size. VS Code does not scale `contentIconPath`; the bitmap must fit a text line. */
const ICON = 18;
const GAP = 2;

export class PortraitDecorator {
  private readonly decorationType: vscode.TextEditorDecorationType;
  private readonly portraits = new Map<string, vscode.Uri>();
  private readonly stripCache = new Map<string, vscode.Uri>();
  private debounceTimer: NodeJS.Timeout | undefined;
  private cacheDir: string | undefined;

  constructor(
    private readonly index: WorkspaceIndex,
    private readonly context: vscode.ExtensionContext,
    private readonly store: PortraitStore
  ) {
    this.decorationType = vscode.window.createTextEditorDecorationType({});
    this.context.subscriptions.push(this.decorationType);
    this.reloadPortraitFiles();

    this.context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleRefresh()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.fileName.endsWith('.rpy')) {
          this.scheduleRefresh(120);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('mtsEventManager.enablePortraits')) {
          this.scheduleRefresh(0);
        }
      }),
      this.store.onDidChange(() => {
        this.reloadPortraitFiles();
        this.scheduleRefresh(0);
      })
    );

    this.index.onDidChange(() => this.scheduleRefresh(0));
    this.scheduleRefresh(0);
  }

  reloadPortraitFiles(): void {
    this.portraits.clear();
    this.stripCache.clear();
    for (const [key, file] of collectPortraitFiles(this.context, this.store)) {
      this.portraits.set(key, vscode.Uri.file(file));
    }
  }

  scheduleRefresh(delayMs = 80): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.refreshVisible();
    }, delayMs);
  }

  private async refreshVisible(): Promise<void> {
    const enabled = vscode.workspace
      .getConfiguration('mtsEventManager')
      .get<boolean>('enablePortraits', true);
    for (const editor of vscode.window.visibleTextEditors) {
      if (!enabled || !editor.document.fileName.endsWith('.rpy')) {
        editor.setDecorations(this.decorationType, []);
        continue;
      }
      await this.apply(editor);
    }
  }

  private async apply(editor: vscode.TextEditor): Promise<void> {
    const doc = editor.document;
    const personIndex = withExtraPersonKeys(this.index.getPersonIndex(), this.portraits.keys());
    if (personIndex.byKey.size === 0 || this.portraits.size === 0) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    const labels = this.index.getLabelsForUri(doc.uri);
    const sites = parseDialoguePortraitSites(doc.getText(), labels, personIndex, (line) => {
      const lab = labelAtLine(labels, line);
      return lab ? this.index.getSelectorValuesForLabel(lab.name) : {};
    });

    const options: vscode.DecorationOptions[] = [];
    for (const site of sites) {
      const keys = site.personKeys.filter((k) => this.portraits.has(k));
      if (keys.length === 0) {
        continue;
      }
      const icon = await this.iconFor(keys);
      if (!icon) {
        continue;
      }
      const names = keys.map((k) => personDisplayName(k, personIndex)).join(' · ');
      const pxWidth = keys.length * ICON + Math.max(0, keys.length - 1) * GAP;
      options.push({
        range: site.range,
        hoverMessage: names,
        renderOptions: {
          before: {
            contentIconPath: icon,
            width: `${pxWidth}px`,
            height: `${ICON}px`,
            margin: '0 4px 0 0',
          },
        },
      });
    }
    editor.setDecorations(this.decorationType, options);
  }

  private async iconFor(keys: string[]): Promise<vscode.Uri | undefined> {
    const files = keys.map((k) => this.portraits.get(k)).filter((u): u is vscode.Uri => !!u);
    if (files.length === 0) {
      return undefined;
    }
    const stamp = files.map((u) => `${u.fsPath}:${safeMtime(u.fsPath)}`).join('|');
    const cacheKey = `${ICON}|${stamp}`;
    const cached = this.stripCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    try {
      const uri = await this.buildStrip(keys, files, stamp);
      this.stripCache.set(cacheKey, uri);
      return uri;
    } catch (e) {
      console.error('[MTS Event Manager] portrait strip failed', e);
      return undefined;
    }
  }

  private async buildStrip(keys: string[], files: vscode.Uri[], stamp: string): Promise<vscode.Uri> {
    if (!this.cacheDir) {
      await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
      this.cacheDir = path.join(this.context.globalStorageUri.fsPath, `portraits-${ICON}`);
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
    const hash = hashId(stamp);
    const out = path.join(this.cacheDir, `${keys.join('__')}-${hash}.png`);
    if (fs.existsSync(out)) {
      return vscode.Uri.file(out);
    }
    const sharp = await loadSharp();
    if (!sharp) {
      throw new Error('sharp unavailable');
    }
    if (files.length === 1) {
      await sharp(files[0].fsPath)
        .resize(ICON, ICON, { fit: 'cover' })
        .png()
        .toFile(out);
      return vscode.Uri.file(out);
    }
    const width = files.length * ICON + (files.length - 1) * GAP;
    const overlays: { input: Buffer; left: number; top: number }[] = [];
    for (let i = 0; i < files.length; i++) {
      const buf = await sharp(files[i].fsPath)
        .resize(ICON, ICON, { fit: 'cover' })
        .png()
        .toBuffer();
      overlays.push({ input: buf, left: i * (ICON + GAP), top: 0 });
    }
    await sharp({
      create: {
        width,
        height: ICON,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite(overlays)
      .png()
      .toFile(out);
    return vscode.Uri.file(out);
  }
}

function safeMtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function hashId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}
