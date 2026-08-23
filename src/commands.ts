import * as vscode from 'vscode';
import { WorkspaceIndex } from './indexer';
import { pickAndInsertSchema } from './snippets';
import { SchemaKind } from './types';

interface RawPos {
  line: number;
  character: number;
}
interface RawRange {
  start: RawPos;
  end: RawPos;
}
interface RawLocation {
  uri: string;
  range: RawRange;
}

function mkPosition(p: RawPos): vscode.Position {
  return new vscode.Position(p.line, p.character);
}

function mkRange(r: RawRange): vscode.Range {
  return new vscode.Range(mkPosition(r.start), mkPosition(r.end));
}

function mkLocation(loc: RawLocation): vscode.Location {
  return new vscode.Location(vscode.Uri.parse(loc.uri), mkRange(loc.range));
}

export function registerCommands(
  context: vscode.ExtensionContext,
  index: WorkspaceIndex
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'mtsEventManager.peekEventDefs',
      async (rawUri: string, rawPos: RawPos, rawLocations: RawLocation[]) => {
        const uri = vscode.Uri.parse(rawUri);
        const pos = mkPosition(rawPos);
        const locations = (rawLocations ?? []).map(mkLocation);
        if (locations.length === 0) {
          void vscode.window.showInformationMessage('No event definitions found.');
          return;
        }
        await vscode.commands.executeCommand(
          'editor.action.peekLocations',
          uri,
          pos,
          locations,
          'peek'
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'mtsEventManager.gotoLabel',
      async (labelName: string, _fromUri?: string) => {
        const label = index.getLabel(labelName);
        if (!label) {
          void vscode.window.showWarningMessage(`Label "${labelName}" not found.`);
          return;
        }
        const active = vscode.window.activeTextEditor;
        const fromUri = active?.document.uri ?? label.uri;
        const fromPos = active?.selection.active ?? label.range.start;
        await vscode.commands.executeCommand(
          'editor.action.goToLocations',
          fromUri,
          fromPos,
          [new vscode.Location(label.uri, label.range)],
          'goto',
          `Label "${labelName}" not found.`
        );
      }
    )
  );

  const insert =
    (kind: SchemaKind) =>
    async (uriStr: string, rawRange: RawRange) => {
      const uri = vscode.Uri.parse(uriStr);
      const range = mkRange(rawRange);
      await pickAndInsertSchema(index, kind, uri, range);
    };

  context.subscriptions.push(
    vscode.commands.registerCommand('mtsEventManager.insertCondition', insert('condition')),
    vscode.commands.registerCommand('mtsEventManager.insertSelector', insert('selector')),
    vscode.commands.registerCommand('mtsEventManager.insertPattern', insert('pattern')),
    vscode.commands.registerCommand('mtsEventManager.insertOption', insert('option')),
    vscode.commands.registerCommand('mtsEventManager.reindex', async () => {
      await index.reindex();
      void vscode.window.showInformationMessage(
        `MTS Event Manager: indexed ${index.getAllEvents().length} events, schemas ready.`
      );
    })
  );
}
