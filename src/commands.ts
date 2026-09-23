import * as vscode from 'vscode';
import { resolveSiteImages } from './codeLens';
import { showImagePreviewCarousel } from './imagePreview';
import { WorkspaceIndex } from './indexer';
import { showPaperdollEditor } from './paperdollPanel';
import { showEventPreview } from './previewPanel';
import { createNewEvent } from './newEvent';
import { showEventOverview } from './eventOverview';
import { revealInEventTimeline } from './previewPanel';
import { showPortraitPanel } from './portraitPanel';
import { PortraitStore } from './portraitStore';
import { pickAndInsertSchema } from './snippets';
import { ImageCallSite, SchemaKind } from './types';

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

interface RawImageCall {
  kind: ImageCallSite['kind'];
  line: number;
  character: number;
  variableName?: string;
  patternKey?: string;
  steps: number[];
  literalPath?: string;
  eventLabelName?: string;
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
  index: WorkspaceIndex,
  store: PortraitStore
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'mtsEventManager.peekEventDefs',
      async (rawUri: string, rawPos: RawPos, rawLocations: RawLocation[]) => {
        const uri = vscode.Uri.parse(rawUri);
        const pos = mkPosition(rawPos);
        const locations = (rawLocations ?? []).map(mkLocation);
        if (locations.length === 0) {
          void vscode.window.showInformationMessage('No definitions found.');
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
    }),
    vscode.commands.registerCommand(
      'mtsEventManager.previewImages',
      async (uriStr: string, raw: RawImageCall) => {
        const uri = vscode.Uri.parse(uriStr);
        const doc = await vscode.workspace.openTextDocument(uri);
        const site: ImageCallSite = {
          kind: raw.kind,
          range: new vscode.Range(raw.line, raw.character, raw.line, raw.character + 1),
          variableName: raw.variableName,
          patternKey: raw.patternKey,
          steps: raw.steps ?? [],
          literalPath: raw.literalPath,
          eventLabelName: raw.eventLabelName,
        };
        const infos = await resolveSiteImages(index, doc, site);
        const title =
          site.patternKey != null
            ? `Preview: ${site.patternKey}${site.steps.length ? ' @ ' + site.steps.join(',') : ''}`
            : site.literalPath
              ? `Preview: ${site.literalPath}`
              : 'Image Preview';
        showImagePreviewCarousel(title, infos, context);
      }
    ),
    vscode.commands.registerCommand('mtsEventManager.customPortraits', () => {
      showPortraitPanel(context, index, store);
    }),
    vscode.commands.registerCommand(
      'mtsEventManager.editPaperdoll',
      async (uriStr?: string, line?: number, character?: number) => {
        const uri = uriStr ? vscode.Uri.parse(uriStr) : undefined;
        await showPaperdollEditor(context, index, uri, line, character);
      }
    ),
    vscode.commands.registerCommand('mtsEventManager.newEvent', async (uri?: string) => {
      await createNewEvent(context, index, store, uri);
    }),
    vscode.commands.registerCommand('mtsEventManager.editEventDefinition', async (labelName?: string) => {
      const label = labelName ? index.getLabel(labelName) : undefined;
      if (!label) {
        void vscode.window.showWarningMessage(
          `The scene label "${labelName ?? ''}" does not exist yet — create it first, then edit the definition from its preview.`
        );
        return;
      }
      await showEventPreview(context, index, store, label.uri, label.range.start.line, 'def');
    }),
    vscode.commands.registerCommand('mtsEventManager.showInTimeline', async (uri?: vscode.Uri) => {
      const editor = vscode.window.activeTextEditor;
      const target = uri instanceof vscode.Uri ? uri : editor?.document.uri;
      if (!target || !editor) {
        return;
      }
      await revealInEventTimeline(context, index, store, target, editor.selection.active.line);
    }),
    vscode.commands.registerCommand('mtsEventManager.eventOverview', async () => {
      await showEventOverview(context, index, store);
    }),
    vscode.commands.registerCommand(
      'mtsEventManager.previewEvent',
      async (uriStr?: string, line?: number) => {
        const uri = uriStr ? vscode.Uri.parse(uriStr) : undefined;
        await showEventPreview(context, index, store, uri, line);
      }
    ),
  );
}
