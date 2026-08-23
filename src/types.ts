import * as vscode from 'vscode';

export type SchemaKind = 'condition' | 'selector' | 'pattern' | 'option' | 'event';

export type ParamKind = 'positional' | 'vararg' | 'kwonly' | 'kwargs';

export interface SchemaParam {
  name: string;
  kind: ParamKind;
  required: boolean;
  typeHint?: string;
  default?: string;
}

export interface ClassSchema {
  name: string;
  kind: SchemaKind;
  bases: string[];
  params: SchemaParam[];
  inferredKwargs: string[];
  uri?: string;
  classRange?: vscode.Range;
}

export type EventKind = 'Event' | 'EventFragment' | 'EventComposite' | 'EventSelect';

export interface EventDefinition {
  kind: EventKind;
  labelName: string;
  uri: vscode.Uri;
  /** Full Event(...) call range */
  fullRange: vscode.Range;
  /** First line / start of call for CodeLens */
  startRange: vscode.Range;
  variableName?: string;
}

export interface LabelDefinition {
  /** Fully qualified name, e.g. main.sub */
  name: string;
  localName: string;
  isSub: boolean;
  uri: vscode.Uri;
  range: vscode.Range;
}

export interface ParsedArg {
  name?: string; // keyword name if keyword arg
  text: string;
  range: vscode.Range;
  /** Nested call at top of this arg, if any */
  call?: ParsedCall;
}

export interface ParsedCall {
  name: string;
  range: vscode.Range;
  nameRange: vscode.Range;
  args: ParsedArg[];
}

export const EVENT_KINDS: readonly EventKind[] = [
  'Event',
  'EventFragment',
  'EventComposite',
  'EventSelect',
] as const;

export const TYPE_ROOTS: Readonly<Record<string, SchemaKind>> = {
  Condition: 'condition',
  Selector: 'selector',
  Option: 'option',
  Pattern: 'pattern',
  Event: 'event',
};
