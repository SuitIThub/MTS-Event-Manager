import * as vscode from 'vscode';
import { EvalNode, evalEvent, GameState, Tri } from './conditionEval';
import { findEventDefs, itemKindOf } from './eventDef';
import { WorkspaceIndex } from './indexer';
import { PyCall } from './pyCall';

/**
 * "When does this event fire?" — evaluates the event and its pool competitors against a
 * simulated game state. Events in a pool compete by priority (1 = blocking, 2 = always
 * runs, 3 = one picked at random among the eligible ones).
 */

export interface SimEventRow {
  label: string;
  priority: string;
  result: Tri;
  /** RandomCondition chance of the event itself (1 when none). */
  chance: number;
  conditions: EvalNode[];
  /** One-line reasons it does not fire / is unknown. */
  reasons: string[];
}

export interface SimPool {
  pool: string;
  rows: SimEventRow[];
  summary: string;
}

export interface SimResult {
  event?: SimEventRow;
  pools: SimPool[];
}

async function conditionsOf(index: WorkspaceIndex, label: string): Promise<{ priority: string; conditions: PyCall[] } | undefined> {
  const ev = index.getEventsForLabel(label)[0];
  if (!ev) {
    return undefined;
  }
  const text = (await vscode.workspace.openTextDocument(ev.uri)).getText();
  const header = findEventDefs(text, label)[0];
  if (!header) {
    return undefined;
  }
  const schemaOf = (n: string) => index.getSchema(n);
  const conditions = header.call.args
    .filter((a) => !a.name && !a.star && a.call && itemKindOf(a, schemaOf) === 'condition')
    .map((a) => a.call!);
  return { priority: header.priority?.trim() ?? '3', conditions };
}

function reasonsOf(nodes: EvalNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.result === 'no' || n.result === 'unknown') {
      if (n.children && n.children.length && (n.label === 'AND' || n.label === 'NOT')) {
        out.push(...reasonsOf(n.children));
      } else {
        out.push(`${n.result === 'no' ? '✗' : '?'} ${n.label}${n.detail ? ' — ' + n.detail : ''}`);
      }
    }
  }
  return out;
}

async function evalLabel(index: WorkspaceIndex, label: string, state: GameState): Promise<SimEventRow | undefined> {
  const c = await conditionsOf(index, label);
  if (!c) {
    return undefined;
  }
  const r = evalEvent(c.conditions, state);
  return { label, priority: c.priority, result: r.result, chance: r.chance, conditions: r.conditions, reasons: reasonsOf(r.conditions) };
}

function poolSummary(rows: SimEventRow[]): string {
  const parts: string[] = [];
  for (const prio of ['1', '2', '3']) {
    const inPrio = rows.filter((r) => r.priority === prio);
    if (!inPrio.length) {
      continue;
    }
    const yes = inPrio.filter((r) => r.result === 'yes');
    const unk = inPrio.filter((r) => r.result === 'unknown');
    const extra = unk.length ? ` (+${unk.length} unknown)` : '';
    if (prio === '1') {
      parts.push(yes.length ? `prio 1: ${yes.map((r) => r.label).join(', ')} blocks the rest${extra}` : `prio 1: none eligible${extra}`);
    } else if (prio === '2') {
      parts.push(`prio 2: ${yes.length} eligible, all run${extra}`);
    } else {
      parts.push(yes.length ? `prio 3: 1 of ${yes.length} at random (~${Math.round(100 / yes.length)} % each)${extra}` : `prio 3: none eligible${extra}`);
    }
  }
  return parts.join(' · ');
}

export async function simulate(index: WorkspaceIndex, label: string, state: GameState): Promise<SimResult> {
  const event = await evalLabel(index, label, state);
  const pools: SimPool[] = [];
  for (const pool of index.getPoolsOfLabel(label)) {
    const rows: SimEventRow[] = [];
    for (const l of index.getPoolLabels(pool)) {
      const row = l === label ? event : await evalLabel(index, l, state);
      if (row) {
        rows.push(row);
      }
    }
    rows.sort((a, b) => a.priority.localeCompare(b.priority) || a.label.localeCompare(b.label));
    pools.push({ pool, rows, summary: poolSummary(rows) });
  }
  return { event, pools };
}

/** Defaults with each character at its starting level (secretary 5). */
export function initialState(index: WorkspaceIndex, base: GameState): GameState {
  const levels: Record<string, number> = {};
  for (const [k, v] of Object.entries(base.levels)) {
    levels[k] = Math.max(v, index.getStartLevel(k));
  }
  return { ...base, levels };
}
