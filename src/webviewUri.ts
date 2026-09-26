import * as fs from 'fs';
import * as vscode from 'vscode';

/**
 * Webview URI of a local image with its modification time as a version (`?v=…`). A file
 * replaced on disk (a new capture, a re-conversion) gets a new URL, so neither the
 * webview's own image cache nor the browser cache keeps showing the old picture.
 */
export function webviewImageUri(webview: Pick<vscode.Webview, 'asWebviewUri'>, fsPath: string | undefined): string {
  if (!fsPath) {
    return '';
  }
  const base = webview.asWebviewUri(vscode.Uri.file(fsPath)).toString();
  try {
    return `${base}?v=${Math.round(fs.statSync(fsPath).mtimeMs).toString(36)}`;
  } catch {
    return base;
  }
}

/**
 * The same image as PNG and WEBP (a new capture next to the converted file). The engine
 * loads the pattern's extension first (`image_extension_candidates`) — usually WEBP — so
 * until the PNG is converted, the game still shows the WEBP.
 */
export interface FormatVariants {
  png: string;
  webp: string;
  /** Which file is more recent. */
  newer: 'png' | 'webp';
  /** Which one the game loads (the pattern's extension). */
  engine: 'png' | 'webp';
  /** Which one the preview resolved (the newer one). */
  shown: 'png' | 'webp';
}

export function formatVariantsOf(
  fsPath: string | undefined,
  pathTemplate: string | undefined,
  toUri: (fsPath: string) => string
): FormatVariants | undefined {
  if (!fsPath) {
    return undefined;
  }
  const m = /\.(png|webp)$/i.exec(fsPath);
  if (!m) {
    return undefined;
  }
  const stem = fsPath.slice(0, -m[0].length);
  const png = stem + '.png';
  const webp = stem + '.webp';
  let pngTime: number;
  let webpTime: number;
  try {
    pngTime = fs.statSync(png).mtimeMs;
    webpTime = fs.statSync(webp).mtimeMs;
  } catch {
    return undefined;
  }
  return {
    png: toUri(png),
    webp: toUri(webp),
    newer: pngTime >= webpTime ? 'png' : 'webp',
    engine: /\.png$/i.test(pathTemplate ?? '') ? 'png' : 'webp',
    shown: m[1].toLowerCase() as 'png' | 'webp',
  };
}
