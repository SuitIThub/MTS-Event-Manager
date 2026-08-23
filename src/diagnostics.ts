import * as vscode from 'vscode';
import { findCallsByName, walkCalls } from './callParser';
import { WorkspaceIndex } from './indexer';
import { ClassSchema, EVENT_KINDS, ParsedCall } from './types';

const EVENT_NAME_SET = new Set<string>(EVENT_KINDS);

export class EventDiagnostics {
  private readonly collection: vscode.DiagnosticCollection;
  private enabled = true;

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

  refreshAll(): void {
    if (!this.enabled || !this.index.hasEventSyntax) {
      this.collection.clear();
      return;
    }
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === 'file' && doc.fileName.endsWith('.rpy')) {
        this.refreshDocument(doc);
      }
    }
  }

  refreshDocument(doc: vscode.TextDocument): void {
    if (!this.enabled || !this.index.hasEventSyntax) {
      this.collection.delete(doc.uri);
      return;
    }
    if (doc.uri.scheme !== 'file' || !doc.fileName.endsWith('.rpy')) {
      return;
    }

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

    this.collection.set(doc.uri, diagnostics);
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

    if (labelArg) {
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
