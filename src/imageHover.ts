import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { loadSharp } from './sharpRuntime';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { collectDocumentImageSites, resolveSiteImages } from './codeLens';
import { formatPatternParams } from './patternResolve';
import { WorkspaceIndex } from './indexer';
import { ResolvedImageInfo } from './types';

const MAX_HOVER_FRAMES = 8;
const HOVER_WIDTH = 520;
const HOVER_HEIGHT = 320;
const TEXT_WIDTH = 280;
const TOTAL_WIDTH = HOVER_WIDTH + TEXT_WIDTH;

export class MtsImageHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly index: WorkspaceIndex,
    private readonly context: vscode.ExtensionContext
  ) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    if (!this.index.hasEventSyntax || !document.fileName.endsWith('.rpy')) {
      return undefined;
    }
    const cfg = vscode.workspace.getConfiguration('mtsEventManager');
    if (!cfg.get<boolean>('enableImagePreview', true)) {
      return undefined;
    }

    const sites = collectDocumentImageSites(document, this.index);

    const match =
      sites.find((s) => s.range.contains(position) || s.range.start.line === position.line) ??
      sites.find((s) => s.range.start.line === position.line + 1);
    if (!match || token.isCancellationRequested) {
      return undefined;
    }

    const infos = await resolveSiteImages(this.index, document, match);
    if (infos.length === 0 || token.isCancellationRequested) {
      return undefined;
    }

    const frames = infos.slice(0, MAX_HOVER_FRAMES);
    const delaySec = secondsPerFrame();

    let cacheDir: string;
    let previewFile: string;
    try {
      const built = await buildHoverPreview(this.context, frames, infos.length, delaySec);
      cacheDir = built.cacheDir;
      previewFile = built.file;
    } catch (e) {
      console.error('[MTS Event Manager] hover preview failed', e);
      return undefined;
    }
    if (token.isCancellationRequested) {
      return undefined;
    }

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.supportHtml = true;
    md.supportThemeIcons = true;
    md.baseUri = vscode.Uri.file(cacheDir.endsWith(path.sep) ? cacheDir : cacheDir + path.sep);

    // Only <img> (+ simple tags) survive the hover HTML sanitizer — no <svg>.
    md.appendMarkdown(
      `<img src="${escapeHtml(previewFile)}" width="${TOTAL_WIDTH}" height="${HOVER_HEIGHT}" alt="preview" />` +
        `<br/><i>Click 🖼 for full panel</i>`
    );

    const hoverRange = new vscode.Range(
      Math.max(0, match.range.start.line - 1),
      0,
      match.range.start.line,
      Number.MAX_SAFE_INTEGER
    );
    return new vscode.Hover(md, hoverRange);
  }
}

function secondsPerFrame(): number {
  const v = vscode.workspace
    .getConfiguration('mtsEventManager')
    .get<number>('imageHoverSecondsPerFrame', 2);
  return Math.min(10, Math.max(0.5, v || 2));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeXml(s: string): string {
  return escapeHtml(s).replace(/'/g, '&apos;');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  return s.slice(0, max - 1) + '…';
}

async function buildHoverPreview(
  context: vscode.ExtensionContext,
  frames: ResolvedImageInfo[],
  totalCount: number,
  delaySec: number
): Promise<{ cacheDir: string; file: string }> {
  const sharp = await loadSharp();
  if (!sharp) {
    throw new Error('sharp unavailable');
  }
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  const cacheDir = path.join(context.globalStorageUri.fsPath, 'hover-preview');
  fs.mkdirSync(cacheDir, { recursive: true });

  const key = frames
    .map((f) => `${f.fsPath}:${safeMtime(f.fsPath)}:${formatPatternParams(f.params)}`)
    .join('|');
  const hash = crypto
    .createHash('sha1')
    .update(`${key}|${TOTAL_WIDTH}|${HOVER_HEIGHT}|${delaySec}|${totalCount}`)
    .digest('hex')
    .slice(0, 16);

  if (frames.length === 1) {
    const outName = `${hash}.jpg`;
    const out = path.join(cacheDir, outName);
    if (!fs.existsSync(out)) {
      const rgba = await renderSlide(frames[0], 0, 1, totalCount, delaySec);
      await sharp(rgba, {
        raw: { width: TOTAL_WIDTH, height: HOVER_HEIGHT, channels: 4 },
      })
        .jpeg({ quality: 82 })
        .toFile(out);
    }
    return { cacheDir, file: outName };
  }

  const outName = `${hash}.gif`;
  const out = path.join(cacheDir, outName);
  if (!fs.existsSync(out)) {
    const delayMs = Math.round(delaySec * 1000);
    const gif = GIFEncoder();
    for (let i = 0; i < frames.length; i++) {
      const rgba = await renderSlide(frames[i], i, frames.length, totalCount, delaySec);
      const palette = quantize(rgba, 256);
      const index = applyPalette(rgba, palette);
      gif.writeFrame(index, TOTAL_WIDTH, HOVER_HEIGHT, {
        palette,
        delay: delayMs,
        repeat: 0,
      });
    }
    gif.finish();
    fs.writeFileSync(out, Buffer.from(gif.bytes()));
  }
  return { cacheDir, file: outName };
}

/** Image on the left + only this slide's meta on the right (baked into pixels). */
async function renderSlide(
  info: ResolvedImageInfo,
  index: number,
  shownCount: number,
  totalCount: number,
  delaySec: number
): Promise<Uint8Array> {
  const sharp = await loadSharp();
  if (!sharp) {
    throw new Error('sharp unavailable');
  }
  const left = await sharp(info.fsPath)
    .resize(HOVER_WIDTH, HOVER_HEIGHT, {
      fit: 'contain',
      background: { r: 24, g: 24, b: 24, alpha: 1 },
    })
    .ensureAlpha()
    .raw()
    .toBuffer();

  const paramLines = Object.keys(info.params)
    .sort()
    .map((k) => `${k}=${info.params[k]}`);
  const counter =
    shownCount > 1
      ? `${index + 1}/${shownCount}${totalCount > shownCount ? ` of ${totalCount}` : ''} · ${delaySec}s`
      : totalCount > 1
        ? `${totalCount} variants`
        : '';

  let paramY = 126;
  const paramTexts = paramLines
    .map((line) => {
      const y = paramY;
      paramY += 18;
      return `<text x="14" y="${y}" font-family="Consolas, monospace" font-size="11" fill="#9cdcfe">${escapeXml(
        truncate(line, 34)
      )}</text>`;
    })
    .join('\n');

  const textSvg = `
<svg width="${TEXT_WIDTH}" height="${HOVER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#1e1e1e"/>
  <text x="14" y="28" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#e8e8e8">Image preview</text>
  ${
    counter
      ? `<text x="14" y="48" font-family="Segoe UI, sans-serif" font-size="11" fill="#a0a0a0">${escapeXml(counter)}</text>`
      : ''
  }
  <text x="14" y="78" font-family="Segoe UI, sans-serif" font-size="12" font-weight="700" fill="#f0f0f0">${escapeXml(
    truncate(info.fileName, 34)
  )}</text>
  <text x="14" y="100" font-family="Consolas, monospace" font-size="10" fill="#b0b0b0">${escapeXml(
    truncate(info.relativePath || info.fsPath, 38)
  )}</text>
  ${paramTexts}
</svg>`;

  const right = await sharp(Buffer.from(textSvg)).ensureAlpha().raw().toBuffer();

  const out = Buffer.alloc(TOTAL_WIDTH * HOVER_HEIGHT * 4);
  for (let y = 0; y < HOVER_HEIGHT; y++) {
    const row = y * TOTAL_WIDTH * 4;
    left.copy(out, row, y * HOVER_WIDTH * 4, (y + 1) * HOVER_WIDTH * 4);
    right.copy(
      out,
      row + HOVER_WIDTH * 4,
      y * TEXT_WIDTH * 4,
      (y + 1) * TEXT_WIDTH * 4
    );
  }
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

function safeMtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
