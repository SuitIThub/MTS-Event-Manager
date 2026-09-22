import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { WorkspaceIndex } from './indexer';
import { loadPaperdollCatalog, resolveLayers } from './paperdollResolve';
import { analyzePaperdoll, paperdollLensSites } from './paperdollScript';
import { loadSharp } from './sharpRuntime';

const PREVIEW_W = 220;
const PREVIEW_H = 396;

export class MtsPaperdollHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly index: WorkspaceIndex,
    private readonly context: vscode.ExtensionContext
  ) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    if (!document.fileName.endsWith('.rpy')) {
      return undefined;
    }
    const cfg = vscode.workspace.getConfiguration('mtsEventManager');
    if (!cfg.get<boolean>('enablePaperdoll', true)) {
      return undefined;
    }
    const site = paperdollLensSites(document.getText()).find(
      (s) => s.line === position.line || s.line === position.line + 1
    );
    if (!site || token.isCancellationRequested) {
      return undefined;
    }
    const analysis = analyzePaperdoll(
      document.getText(),
      this.index.getLabelsForUri(document.uri),
      site.line,
      site.end > site.start ? 1 : 0,
      this.index.getPersonIndex()
    );
    const doll =
      analysis.scene.dolls.find((d) => d.variable === site.variable && !d.hidden) ??
      analysis.scene.dolls.find((d) => d.variable === site.variable);
    if (!doll || token.isCancellationRequested) {
      return undefined;
    }
    let catalog;
    try {
      catalog = await loadPaperdollCatalog();
    } catch {
      return undefined;
    }
    const layers = resolveLayers(catalog, doll.personKey, doll.values, doll.altKeys);
    if (!layers.body && !layers.head) {
      return undefined;
    }
    const sharp = await loadSharp();
    if (!sharp || token.isCancellationRequested) {
      return undefined;
    }
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    const cacheDir = path.join(this.context.globalStorageUri.fsPath, 'paperdoll-preview');
    fs.mkdirSync(cacheDir, { recursive: true });
    const key = crypto
      .createHash('sha1')
      .update(`${layers.body ?? ''}|${layers.head ?? ''}|${doll.values.pose}|${doll.values.mood}|${doll.values.outfit}`)
      .digest('hex')
      .slice(0, 16);
    const file = `${key}.png`;
    const out = path.join(cacheDir, file);
    if (!fs.existsSync(out)) {
      const base = sharp({
        create: {
          width: PREVIEW_W,
          height: PREVIEW_H,
          channels: 4,
          background: { r: 22, g: 22, b: 22, alpha: 1 },
        },
      });
      const layersToDraw = [];
      for (const src of [layers.body, layers.head]) {
        if (!src) {
          continue;
        }
        layersToDraw.push({
          input: await sharp(src)
            .resize(PREVIEW_W, PREVIEW_H, { fit: 'fill' })
            .png()
            .toBuffer(),
        });
      }
      await base.composite(layersToDraw).png().toFile(out);
    }
    if (token.isCancellationRequested) {
      return undefined;
    }
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.supportHtml = true;
    md.baseUri = vscode.Uri.file(cacheDir.endsWith(path.sep) ? cacheDir : cacheDir + path.sep);
    const caption = [
      doll.personKey,
      `pose ${doll.values.pose}`,
      doll.values.outfit,
      `lv ${doll.values.level}`,
      doll.values.mood,
      doll.values.mouth,
    ]
      .filter(Boolean)
      .join(' · ');
    md.appendMarkdown(
      `<img src="${file}" width="${PREVIEW_W}" height="${PREVIEW_H}" alt="paperdoll" /><br/>${escapeHtml(caption)}<br/><i>Click 🎭 to edit</i>`
    );
    return new vscode.Hover(
      md,
      new vscode.Range(site.line, 0, site.line, Number.MAX_SAFE_INTEGER)
    );
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
