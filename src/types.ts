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

export interface EventPatternInfo {
  patternKey: string;
  pathTemplate: string;
  altKeys: string[];
  range: vscode.Range;
}

/** convert_pattern / show_pattern usage of a named Pattern. */
export interface PatternUsage {
  kind: 'convert_pattern' | 'show_pattern';
  patternKey: string;
  /** Scene label containing the call (sublabels included). */
  labelName: string;
  uri: vscode.Uri;
  range: vscode.Range;
}

export interface EventDefinition {
  kind: EventKind;
  labelName: string;
  uri: vscode.Uri;
  /** Full Event(...) call range */
  fullRange: vscode.Range;
  /** First line / start of call for CodeLens */
  startRange: vscode.Range;
  variableName?: string;
  patterns: EventPatternInfo[];
  /** Selector key → possible string values (person keys, topics, …) */
  selectorValues: Record<string, string[]>;
}

export type ImageCallKind =
  | 'show'
  | 'show_image'
  | 'show_pattern'
  | 'show_video'
  | 'convert_pattern'
  | 'pattern_def'
  | 'set_background'
  | 'set_background_path';

export interface ImageCallSite {
  kind: ImageCallKind;
  range: vscode.Range;
  /** Variable holding Image_Series, if any */
  variableName?: string;
  /** Pattern key from convert_pattern / show_pattern */
  patternKey?: string;
  /** Fixed steps from show(n) / show_image(..., steps) / var[n] */
  steps: number[];
  /**
   * Pattern placeholder constraints from enclosing if/elif (e.g. topic → ["ah"]).
   * Multiple values mean "any of these".
   */
  paramConstraints?: Record<string, string[]>;
  /** Literal relative path for set_background("images/...") */
  literalPath?: string;
  /**
   * Event label that owns this Pattern. Used for `pattern_def` sites, which live
   * in `init python` Event() constructors rather than a scene label.
   */
  eventLabelName?: string;
}

/** One resolved image file with pattern placeholder values. */
export interface ResolvedImageInfo {
  uri: vscode.Uri;
  fileName: string;
  fsPath: string;
  /** Path relative to game/ root when known */
  relativePath: string;
  /** Placeholder values extracted from the path, e.g. { school_level: "2", step: "0" } */
  params: Record<string, string>;
  patternKey?: string;
  pathTemplate?: string;
}

export interface PersonInfo {
  key: string;
  firstName: string;
  lastName: string;
  group: string;
  /** Values merged over the house paperdoll seeds, from `paperdollDefaults`. */
  paperdollDefaults?: Record<string, string>;
}

export interface DialoguePortraitSite {
  range: vscode.Range;
  personKeys: string[];
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
