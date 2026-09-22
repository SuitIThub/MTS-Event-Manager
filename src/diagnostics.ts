import * as vscode from 'vscode';
import { findCallsByName, walkCalls } from './callParser';
import { resolveSiteImages } from './codeLens';
import { parseEventsInDocument } from './parseEvents';
import { parseImageCallsInDocument } from './parseImageCalls';
import { parseLabelsInDocument } from './parseLabels';
import { getImageRoots, resolveImagesForCall } from './patternResolve';
import { WorkspaceIndex } from './indexer';
import { ClassSchema, EVENT_KINDS, ImageCallSite, ParsedCall } from './types';

const EVENT_NAME_SET = new Set<string>(EVENT_KINDS);

export class EventDiagnostics {
  private readonly collection: vscode.DiagnosticCollection;
  private enabled = true;
  private readonly refreshGen = new Map<string, number>();

  constructor(private readonly index: WorkspaceIndex) {
    this.collection = vscode.languages.createDiagnosticCollection('mtsEventManager');
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.collection.clear();
    }
  }

  dispose(): void {
    this.collection.dispose();
  }

  async refreshAll(): Promise<void> {
    if (!this.enabled || !this.index.hasEventSyntax) {
      this.collection.clear();
      return;
    }
    await Promise.all(
      vscode.workspace.textDocuments
        .filter((doc) => doc.uri.scheme === 'file' && doc.fileName.endsWith('.rpy'))
        .map((doc) => this.refreshDocument(doc))
    );
  }

  async refreshDocument(doc: vscode.TextDocument): Promise<void> {
    const key = doc.uri.toString();
    if (!this.enabled || !this.index.hasEventSyntax) {
      this.collection.delete(doc.uri);
      return;
    }
    if (doc.uri.scheme !== 'file' || !doc.fileName.endsWith('.rpy')) {
      return;
    }

    const gen = (this.refreshGen.get(key) ?? 0) + 1;
    this.refreshGen.set(key, gen);

    const text = doc.getText();
    const diagnostics: vscode.Diagnostic[] = [];
    const eventCalls = findCallsByName(text, EVENT_NAME_SET);

    for (const eventCall of eventCalls) {
      this.validateEventCall(eventCall, diagnostics);
      walkCalls(eventCall, (call) => {
        if (call === eventCall) {
          return;
        }
        this.validateRegisteredCall(call, diagnostics);
      });
    }

    await this.addMissingPatternImageWarnings(doc, text, diagnostics);
    await this.addMissingCallImageWarnings(doc, text, diagnostics);
    if (this.refreshGen.get(key) !== gen) {
      return;
    }
    this.collection.set(doc.uri, diagnostics);
  }

  private async addMissingPatternImageWarnings(
    doc: vscode.TextDocument,
    text: string,
    diagnostics: vscode.Diagnostic[]
  ): Promise<void> {
    const roots = await getImageRoots();
    if (roots.length === 0) {
      return;
    }
    const events = parseEventsInDocument(doc.uri, text);
    for (const ev of events) {
      for (const pat of ev.patterns) {
        const site: ImageCallSite = {
          kind: 'pattern_def',
          range: pat.range,
          patternKey: pat.patternKey,
          steps: [],
          eventLabelName: ev.labelName,
        };
        const images = await resolveImagesForCall(site, [pat], { maxResults: 1 });
        if (images.length > 0) {
          continue;
        }
        const diag = new vscode.Diagnostic(
          pat.range,
          `No images found for Pattern "${pat.patternKey}" (${pat.pathTemplate}).`,
          vscode.DiagnosticSeverity.Warning
        );
        diag.source = 'MTS Event Manager';
        diagnostics.push(diag);
      }
    }
  }

  private async addMissingCallImageWarnings(
    doc: vscode.TextDocument,
    text: string,
    diagnostics: vscode.Diagnostic[]
  ): Promise<void> {
    const roots = await getImageRoots();
    if (roots.length === 0) {
      return;
    }
    const labels = parseLabelsInDocument(doc.uri, text);
    const sites = parseImageCallsInDocument(text, labels);
    for (const site of sites) {
      if (site.kind === 'convert_pattern') {
        continue;
      }
      const missingSteps: number[] = [];
      if (site.steps.length > 1) {
        for (const step of site.steps) {
          const images = await resolveSiteImages(
            this.index,
            doc,
            { ...site, steps: [step] },
            labels,
            { maxResults: 1 }
          );
          if (images.length === 0) {
            missingSteps.push(step);
          }
        }
        if (missingSteps.length === 0) {
          continue;
        }
      } else {
        const images = await resolveSiteImages(this.index, doc, site, labels, { maxResults: 1 });
        if (images.length > 0) {
          continue;
        }
        if (site.steps.length === 1) {
          missingSteps.push(site.steps[0]);
        }
      }
      const diag = new vscode.Diagnostic(
        site.range,
        missingImageMessage(site, missingSteps),
        vscode.DiagnosticSeverity.Warning
      );
      diag.source = 'MTS Event Manager';
      diagnostics.push(diag);
    }
  }

  private validateEventCall(call: ParsedCall, diagnostics: vscode.Diagnostic[]): void {
    let positional = 0;
    let labelArg: { text: string; range: vscode.Range } | undefined;
    const schema = this.index.getSchema(call.name);

    for (const arg of call.args) {
      if (arg.name) {
        if (schema) {
          this.checkKeyword(arg.name, schema, arg.range, diagnostics);
        }
        continue;
      }
      if (positional === 1) {
        labelArg = { text: arg.text, range: arg.range };
      }
      positional++;
    }

    if (labelArg && call.name !== 'EventSelect') {
      const m = labelArg.text.trim().match(/^['"]([\s\S]*)['"]$/);
      const labelName = m ? m[1] : undefined;
      if (labelName && !this.index.getLabel(labelName)) {
        diagnostics.push(
          new vscode.Diagnostic(
            labelArg.range,
            `Label "${labelName}" not found in workspace.`,
            vscode.DiagnosticSeverity.Warning
          )
        );
      }
    }

    if (schema) {
      this.validateArity(call, schema, diagnostics);
    }
  }

  private validateRegisteredCall(call: ParsedCall, diagnostics: vscode.Diagnostic[]): void {
    const schema = this.index.getSchema(call.name);
    if (!schema) {
      if (
        /Condition$|Selector$/.test(call.name) &&
        call.name !== 'Condition' &&
        call.name !== 'Selector'
      ) {
        diagnostics.push(
          new vscode.Diagnostic(
            call.nameRange,
            `Class "${call.name}" not in schema index (save the defining .rpy or run MTS: Reindex Workspace).`,
            vscode.DiagnosticSeverity.Warning
          )
        );
      }
      return;
    }
    this.validateArity(call, schema, diagnostics);
    for (const arg of call.args) {
      if (arg.name) {
        this.checkKeyword(arg.name, schema, arg.range, diagnostics);
      }
    }
  }

  private validateArity(call: ParsedCall, schema: ClassSchema, diagnostics: vscode.Diagnostic[]): void {
    const requiredPositionals = schema.params.filter((p) => p.kind === 'positional' && p.required);
    const hasVararg = schema.params.some((p) => p.kind === 'vararg');
    let positionalCount = 0;
    for (const arg of call.args) {
      if (!arg.name) {
        positionalCount++;
      }
    }
    if (!hasVararg && positionalCount < requiredPositionals.length) {
      diagnostics.push(
        new vscode.Diagnostic(
          call.nameRange,
          `${call.name} expects at least ${requiredPositionals.length} positional argument(s), got ${positionalCount}.`,
          vscode.DiagnosticSeverity.Error
        )
      );
    }
  }

  private checkKeyword(
    name: string,
    schema: ClassSchema,
    range: vscode.Range,
    diagnostics: vscode.Diagnostic[]
  ): void {
    const hasKwargs = schema.params.some((p) => p.kind === 'kwargs');
    const knownNames = new Set(
      schema.params
        .filter((p) => p.kind === 'positional' || p.kind === 'kwonly')
        .map((p) => p.name)
    );
    if (knownNames.has(name)) {
      return;
    }
    if (hasKwargs) {
      if (schema.inferredKwargs.length > 0 && !schema.inferredKwargs.includes(name)) {
        diagnostics.push(
          new vscode.Diagnostic(
            range,
            `Unknown keyword "${name}" for ${schema.name}; expected one of: ${schema.inferredKwargs.join(', ')}.`,
            vscode.DiagnosticSeverity.Warning
          )
        );
      }
      return;
    }
    diagnostics.push(
      new vscode.Diagnostic(
        range,
        `Unknown keyword argument "${name}" for ${schema.name}.`,
        vscode.DiagnosticSeverity.Warning
      )
    );
  }
}

function missingImageMessage(site: ImageCallSite, missingSteps: number[]): string {
  const stepsLabel =
    missingSteps.length === 1
      ? `step ${missingSteps[0]}`
      : missingSteps.length > 1
        ? `steps ${missingSteps.join(', ')}`
        : undefined;
  switch (site.kind) {
    case 'show':
      return stepsLabel
        ? `No images found for ${site.variableName ?? 'image'}.show(${missingSteps[0]}).`
        : `No images found for ${site.variableName ?? 'image'}.show().`;
    case 'show_image':
      return stepsLabel
        ? `No images found for Image_Series.show_image ${stepsLabel}.`
        : 'No images found for Image_Series.show_image.';
    case 'show_pattern':
      return site.patternKey
        ? `No images found for show_pattern("${site.patternKey}").`
        : 'No images found for show_pattern.';
    case 'set_background':
      return stepsLabel
        ? `No images found for set_background ${stepsLabel}.`
        : 'No images found for set_background.';
    case 'set_background_path':
      return site.literalPath
        ? `No images found for "${site.literalPath}".`
        : 'No images found for set_background path.';
    default:
      return site.patternKey
        ? `No images found for Pattern "${site.patternKey}".`
        : 'No images found.';
  }
}
