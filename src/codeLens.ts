import * as vscode from 'vscode';
import { WorkspaceIndex } from './indexer';

export class MtsCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  constructor(private readonly index: WorkspaceIndex) {
    index.onDidChange(() => this.onDidChangeCodeLensesEmitter.fire());
  }

  refresh(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.CodeLens[] {
    if (!this.index.hasEventSyntax) {
      return [];
    }
    const config = vscode.workspace.getConfiguration('mtsEventManager');
    if (!config.get<boolean>('enableCodeLens', true)) {
      return [];
    }
    if (!document.fileName.endsWith('.rpy')) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];

    for (const label of this.index.getLabelsForUri(document.uri)) {
      const events = this.index.getEventsForLabel(label.name);
      if (events.length === 0) {
        continue;
      }
      const title =
        events.length === 1
          ? '▶ 1 Event-Definition'
          : `▶ ${events.length} Event-Definitionen`;
      lenses.push(
        new vscode.CodeLens(label.range, {
          title,
          command: 'mtsEventManager.peekEventDefs',
          arguments: [
            document.uri.toString(),
            { line: label.range.start.line, character: label.range.start.character },
            events.map((e) => ({
              uri: e.uri.toString(),
              range: {
                start: { line: e.fullRange.start.line, character: e.fullRange.start.character },
                end: { line: e.fullRange.end.line, character: e.fullRange.end.character },
              },
            })),
          ],
        })
      );
    }

    for (const ev of this.index.getEventsForUri(document.uri)) {
      const label = this.index.getLabel(ev.labelName);
      const gotoTitle = label ? '→ Label' : '⚠ Label fehlt';
      lenses.push(
        new vscode.CodeLens(ev.startRange, {
          title: gotoTitle,
          command: 'mtsEventManager.gotoLabel',
          arguments: [ev.labelName, ev.uri.toString()],
        })
      );
      lenses.push(
        new vscode.CodeLens(ev.startRange, {
          title: '+ Condition',
          command: 'mtsEventManager.insertCondition',
          arguments: [ev.uri.toString(), rangeToRaw(ev.fullRange)],
        })
      );
      lenses.push(
        new vscode.CodeLens(ev.startRange, {
          title: '+ Selector',
          command: 'mtsEventManager.insertSelector',
          arguments: [ev.uri.toString(), rangeToRaw(ev.fullRange)],
        })
      );
      lenses.push(
        new vscode.CodeLens(ev.startRange, {
          title: '+ Pattern',
          command: 'mtsEventManager.insertPattern',
          arguments: [ev.uri.toString(), rangeToRaw(ev.fullRange)],
        })
      );
    }

    return lenses;
  }
}

function rangeToRaw(r: vscode.Range) {
  return {
    start: { line: r.start.line, character: r.start.character },
    end: { line: r.end.line, character: r.end.character },
  };
}
