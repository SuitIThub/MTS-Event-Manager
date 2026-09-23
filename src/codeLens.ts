import * as vscode from 'vscode';
import { resolveImagesForCall } from './patternResolve';
import { labelNameForImageCall, parseImageCallsInDocument } from './parseImageCalls';
import { paramConstraintsForLine } from './paramConstraints';
import { WorkspaceIndex } from './indexer';
import { ImageCallSite } from './types';

export function collectDocumentImageSites(
  document: vscode.TextDocument,
  index: WorkspaceIndex
): ImageCallSite[] {
  const labels = index.getLabelsForUri(document.uri);
  const sites = parseImageCallsInDocument(document.getText(), labels);
  for (const ev of index.getEventsForUri(document.uri)) {
    for (const p of ev.patterns) {
      sites.push({
        kind: 'pattern_def',
        range: p.range,
        patternKey: p.patternKey,
        steps: [],
        eventLabelName: ev.labelName,
      });
    }
  }
  return sites;
}

export class MtsCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  constructor(private readonly index: WorkspaceIndex) {
    index.onDidChange(() => {
      this.onDidChangeCodeLensesEmitter.fire();
    });
  }

  refresh(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
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
      const events = this.index
        .getEventsForLabel(label.name)
        .filter((e) => e.kind !== 'EventSelect');
      if (events.length === 0) {
        continue;
      }
      const title =
        events.length === 1
          ? '▶ 1 Event definition'
          : `▶ ${events.length} Event definitions`;
      if (!label.isSub) {
        lenses.push(
          new vscode.CodeLens(label.range, {
            title: '👁 Preview',
            command: 'mtsEventManager.previewEvent',
            arguments: [document.uri.toString(), label.range.start.line],
          })
        );
      }
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
      lenses.push(
        new vscode.CodeLens(ev.startRange, {
          title: '✏ Edit definition',
          command: 'mtsEventManager.editEventDefinition',
          arguments: [ev.labelName],
        })
      );
      if (ev.kind !== 'EventSelect') {
        const label = this.index.getLabel(ev.labelName);
        const gotoTitle = label ? '→ Label' : '⚠ Label missing';
        lenses.push(
          new vscode.CodeLens(ev.startRange, {
            title: gotoTitle,
            command: 'mtsEventManager.gotoLabel',
            arguments: [ev.labelName, ev.uri.toString()],
          })
        );
      }
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

    const labels = this.index.getLabelsForUri(document.uri);
    const callSites = parseImageCallsInDocument(document.getText(), labels);
    for (const site of callSites) {
      if (site.kind !== 'convert_pattern' && site.kind !== 'show_pattern') {
        continue;
      }
      if (!site.patternKey) {
        continue;
      }
      const labelName = labelNameForImageCall(labels, site);
      const lensRange = new vscode.Range(site.range.start.line, 0, site.range.start.line, 200);
      if (!labelName) {
        lenses.push(
          new vscode.CodeLens(lensRange, {
            title: '⚠ Pattern missing',
            command: 'mtsEventManager.peekEventDefs',
            arguments: [
              document.uri.toString(),
              { line: site.range.start.line, character: site.range.start.character },
              [],
            ],
          })
        );
        continue;
      }
      const locations = this.index.getPatternLocations(labelName, site.patternKey);
      const title =
        locations.length === 0
          ? '⚠ Pattern missing'
          : locations.length === 1
            ? '▶ 1 Pattern definition'
            : `▶ ${locations.length} Pattern definitions`;
      lenses.push(
        new vscode.CodeLens(lensRange, {
          title,
          command: 'mtsEventManager.peekEventDefs',
          arguments: [
            document.uri.toString(),
            { line: site.range.start.line, character: site.range.start.character },
            locations.map((loc) => ({
              uri: loc.uri.toString(),
              range: {
                start: { line: loc.range.start.line, character: loc.range.start.character },
                end: { line: loc.range.end.line, character: loc.range.end.character },
              },
            })),
          ],
        })
      );
    }

    for (const ev of this.index.getEventsForUri(document.uri)) {
      for (const p of ev.patterns) {
        const usages = this.index.getPatternUsages(ev.labelName, p.patternKey);
        if (usages.length === 0) {
          continue;
        }
        const title =
          usages.length === 1 ? '▶ 1 reference' : `▶ ${usages.length} references`;
        lenses.push(
          new vscode.CodeLens(
            new vscode.Range(p.range.start.line, 0, p.range.start.line, 200),
            {
              title,
              command: 'mtsEventManager.peekEventDefs',
              arguments: [
                document.uri.toString(),
                {
                  line: p.range.start.line,
                  character: p.range.start.character,
                },
                usages.map((u) => ({
                  uri: u.uri.toString(),
                  range: {
                    start: { line: u.range.start.line, character: u.range.start.character },
                    end: { line: u.range.end.line, character: u.range.end.character },
                  },
                })),
              ],
            }
          )
        );
      }
    }

    return lenses;
  }

}

export async function resolveSiteImages(
  index: WorkspaceIndex,
  document: vscode.TextDocument,
  site: ImageCallSite,
  labels?: ReturnType<WorkspaceIndex['getLabelsForUri']>,
  options?: { maxResults?: number }
): Promise<import('./types').ResolvedImageInfo[]> {
  const labs = labels ?? index.getLabelsForUri(document.uri);
  if (site.kind === 'set_background_path') {
    return resolveImagesForCall(site, [], options);
  }
  const labelName = site.eventLabelName ?? labelNameForImageCall(labs, site);
  if (!labelName) {
    return [];
  }
  const patterns = index.getPatternsForLabel(labelName, site.patternKey);
  const usePatterns =
    patterns.length > 0 ? patterns : index.getPatternsForLabel(labelName);
  const withConstraints: ImageCallSite = {
    ...site,
    paramConstraints:
      site.paramConstraints ??
      paramConstraintsForLine(document.getText(), labs, site.range.start.line),
  };
  return resolveImagesForCall(withConstraints, usePatterns, options);
}

function rangeToRaw(r: vscode.Range) {
  return {
    start: { line: r.start.line, character: r.start.character },
    end: { line: r.end.line, character: r.end.character },
  };
}
