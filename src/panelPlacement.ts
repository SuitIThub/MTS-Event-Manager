import * as vscode from 'vscode';

/**
 * Remembers the editor group a panel was last in (also a group in a separate window) and
 * opens it there again next time — across restarts, per workspace.
 */
const KEY = 'mtsEventManager.panelColumns';

export function lastColumn(context: vscode.ExtensionContext, id: string, fallback: vscode.ViewColumn): vscode.ViewColumn {
  const saved = context.workspaceState.get<Record<string, number>>(KEY, {})[id];
  return typeof saved === 'number' && saved > 0 ? (saved as vscode.ViewColumn) : fallback;
}

/** Track where the panel lives; call once after creating it. */
export function trackColumn(context: vscode.ExtensionContext, id: string, panel: vscode.WebviewPanel): void {
  const save = () => {
    const col = panel.viewColumn;
    if (typeof col === 'number' && col > 0) {
      const all = { ...context.workspaceState.get<Record<string, number>>(KEY, {}), [id]: col };
      void context.workspaceState.update(KEY, all);
    }
  };
  save();
  context.subscriptions.push(panel.onDidChangeViewState(save));
}
