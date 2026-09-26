import * as https from 'https';
import * as vscode from 'vscode';

/**
 * Update check: asks GitHub for the latest release of this repository and, when it is newer
 * than the installed extension, offers to open the release post. At most once a day,
 * never for a version the user chose to skip; silent when offline or when there is no
 * release yet.
 */

export const RELEASES_API = 'https://api.github.com/repos/SuitIThub/MTS-Event-Manager/releases/latest';
const LAST_CHECK_KEY = 'mtsEventManager.update.lastCheck';
const SKIPPED_KEY = 'mtsEventManager.update.skippedVersion';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReleaseInfo {
  version: string;
  url: string;
}

/** `v1.2.3` / `1.2.3` → [1, 2, 3]; undefined for anything else. */
export function parseVersion(v: string | undefined): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) {
    return false;
  }
  return (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) > 0;
}

/** The release from a `releases/latest` response (drafts and pre-releases never count). */
export function releaseFromJson(json: unknown): ReleaseInfo | undefined {
  const r = json as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean };
  if (!r || r.draft || r.prerelease || !parseVersion(r.tag_name) || typeof r.html_url !== 'string' || !r.html_url.startsWith('https://github.com/')) {
    return undefined;
  }
  return { version: r.tag_name!.replace(/^v/, ''), url: r.html_url };
}

function fetchLatest(): Promise<ReleaseInfo | undefined> {
  return new Promise((resolve) => {
    const req = https.get(
      RELEASES_API,
      { headers: { 'User-Agent': 'mts-event-manager', Accept: 'application/vnd.github+json' }, timeout: 10000 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(undefined);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          body += c;
          if (body.length > 1_000_000) {
            req.destroy();
            resolve(undefined);
          }
        });
        res.on('end', () => {
          try {
            resolve(releaseFromJson(JSON.parse(body)));
          } catch {
            resolve(undefined);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(undefined));
  });
}

/**
 * Check and notify. `manual`: from the command — ignores the daily limit and the skipped
 * version, and also reports "up to date" / "could not check".
 */
export async function checkForUpdates(context: vscode.ExtensionContext, manual = false): Promise<void> {
  const current = String(context.extension.packageJSON.version ?? '');
  if (!manual) {
    if (!vscode.workspace.getConfiguration('mtsEventManager').get<boolean>('checkForUpdates', true)) {
      return;
    }
    const last = context.globalState.get<number>(LAST_CHECK_KEY, 0);
    if (Date.now() - last < DAY_MS) {
      return;
    }
  }
  const latest = await fetchLatest();
  await context.globalState.update(LAST_CHECK_KEY, Date.now());
  if (!latest) {
    if (manual) {
      void vscode.window.showWarningMessage('MTS Event Manager: could not reach GitHub to check for updates.');
    }
    return;
  }
  if (!isNewer(latest.version, current)) {
    if (manual) {
      void vscode.window.showInformationMessage(`MTS Event Manager ${current} is up to date.`);
    }
    return;
  }
  if (!manual && context.globalState.get<string>(SKIPPED_KEY) === latest.version) {
    return;
  }
  const open = 'Open release';
  const skip = 'Skip this version';
  const choice = await vscode.window.showInformationMessage(
    `MTS Event Manager ${latest.version} is available (installed: ${current}). The release also contains the matching MTS Capture plugin.`,
    open,
    skip
  );
  if (choice === open) {
    void vscode.env.openExternal(vscode.Uri.parse(latest.url));
  } else if (choice === skip) {
    await context.globalState.update(SKIPPED_KEY, latest.version);
  }
}

export function registerUpdateCheck(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('mtsEventManager.checkForUpdates', () => checkForUpdates(context, true)));
  // A little after startup, so it never competes with indexing.
  const timer = setTimeout(() => void checkForUpdates(context).catch(() => undefined), 15000);
  context.subscriptions.push({ dispose: () => clearTimeout(timer) });
}
