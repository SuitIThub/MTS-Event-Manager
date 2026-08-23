import * as vscode from 'vscode';
import { MtsCodeLensProvider } from './codeLens';
import { registerCommands } from './commands';
import { EventDiagnostics } from './diagnostics';
import { WorkspaceIndex } from './indexer';

const RPY_SELECTOR: vscode.DocumentSelector = [
  { language: 'renpy', scheme: 'file' },
  { pattern: '**/*.rpy', scheme: 'file' },
];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const index = new WorkspaceIndex();
  const diagnostics = new EventDiagnostics(index);
  const codeLens = new MtsCodeLensProvider(index);

  context.subscriptions.push(index, diagnostics);

  registerCommands(context, index);

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(RPY_SELECTOR, codeLens)
  );

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.rpy');
  watcher.onDidCreate(() => index.scheduleReindex());
  watcher.onDidChange(() => index.scheduleReindex());
  watcher.onDidDelete(() => index.scheduleReindex());
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.fileName.endsWith('.rpy')) {
        index.scheduleReindex(400);
        // Live diagnostics from buffer on next index refresh; also light refresh after debounce via onDidChange
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.fileName.endsWith('.rpy')) {
        index.scheduleReindex(100);
      }
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.fileName.endsWith('.rpy') && index.hasEventSyntax) {
        diagnostics.refreshDocument(doc);
      }
    })
  );

  index.onDidChange(() => {
    codeLens.refresh();
    const enableDiag = vscode.workspace
      .getConfiguration('mtsEventManager')
      .get<boolean>('enableDiagnostics', true);
    diagnostics.setEnabled(enableDiag);
    diagnostics.refreshAll();
    // Also refresh open docs from latest buffer
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.fileName.endsWith('.rpy')) {
        diagnostics.refreshDocument(doc);
      }
    }
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mtsEventManager')) {
        const cfg = vscode.workspace.getConfiguration('mtsEventManager');
        diagnostics.setEnabled(cfg.get('enableDiagnostics', true));
        codeLens.refresh();
        diagnostics.refreshAll();
      }
    })
  );

  await index.reindex();

  if (index.hasEventSyntax) {
    console.log(
      `[MTS Event Manager] Active — ${index.getAllEvents().length} events indexed.`
    );
  } else {
    console.log('[MTS Event Manager] No Event syntax detected yet; CodeLens idle.');
  }
}

export function deactivate(): void {}
