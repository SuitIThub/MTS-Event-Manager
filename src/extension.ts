import * as vscode from 'vscode';
import { initWebviewAssets } from './webviewAssets';
import { CaptureBridge } from './captureBridge';
import { MtsCodeLensProvider } from './codeLens';
import { registerCommands } from './commands';
import { registerPreviewSerializer } from './previewPanel';
import { registerOverviewSerializer } from './eventOverview';
import { EventDiagnostics } from './diagnostics';
import { MtsImageHoverProvider } from './imageHover';
import { MtsPaperdollHoverProvider } from './paperdollHover';
import { WorkspaceIndex } from './indexer';
import { PortraitDecorator } from './portraitDecorations';
import { PortraitStore } from './portraitStore';

const RPY_SELECTOR: vscode.DocumentSelector = [
  { language: 'renpy', scheme: 'file' },
  { pattern: '**/*.rpy', scheme: 'file' },
];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initWebviewAssets(context.extensionUri);
  const index = new WorkspaceIndex();
  const diagnostics = new EventDiagnostics(index);
  const codeLens = new MtsCodeLensProvider(index);
  const imageHover = new MtsImageHoverProvider(index, context);
  const paperdollHover = new MtsPaperdollHoverProvider(index, context);
  const portraits = new PortraitStore(context);
  new PortraitDecorator(index, context, portraits);

  context.subscriptions.push(index, diagnostics, portraits);
  // StudioNeoV2 capture plugin: the event editor's event is exported as a JSON bridge file.
  context.subscriptions.push(new CaptureBridge(index));

  registerCommands(context, index, portraits);
  // Reopen the event preview / overview after a window reload, in their last state.
  context.subscriptions.push(registerPreviewSerializer(context, index, portraits), registerOverviewSerializer(context, index, portraits));

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(RPY_SELECTOR, codeLens),
    vscode.languages.registerHoverProvider(RPY_SELECTOR, imageHover),
    vscode.languages.registerHoverProvider(RPY_SELECTOR, paperdollHover)
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
        void diagnostics.refreshDocument(doc);
      }
    })
  );

  index.onDidChange(() => {
    codeLens.refresh();
    const enableDiag = vscode.workspace
      .getConfiguration('mtsEventManager')
      .get<boolean>('enableDiagnostics', true);
    diagnostics.setEnabled(enableDiag);
    void diagnostics.refreshAll();
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mtsEventManager')) {
        const cfg = vscode.workspace.getConfiguration('mtsEventManager');
        diagnostics.setEnabled(cfg.get('enableDiagnostics', true));
        codeLens.refresh();
        void diagnostics.refreshAll();
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
