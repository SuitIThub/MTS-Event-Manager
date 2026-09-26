import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  buildCallCode,
  buildEventDefModel,
  findEventDefs,
  insertSlotFor,
  planDefOp,
  schemaErrors,
} from '../src/eventDef';
import { buildSchemaRegistry, collectRawClasses } from '../src/parseSchema';
import { GAME, SCRIPTS, WS_ROOT, requireGame } from './testEnv';

requireGame('fuzz-eventdef', 'scripts');

function walk(d: string, o: string[] = []): string[] {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, o);
    else if (e.name.endsWith('.rpy')) o.push(p);
  }
  return o;
}
const files = walk(GAME);
const texts = new Map<string, string>();
const raw = [];
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  const uri = vscode.Uri.file(f);
  texts.set(uri.toString(), t);
  raw.push(...collectRawClasses(uri, t));
}
const { schemas } = buildSchemaRegistry(raw, texts);
const schemaOf = (n: string) => schemas.get(n);

let defs = 0, ops = 0, refused = 0, failures = 0;
const kinds: Record<string, number> = {};
const refusals: Record<string, number> = {};
const fail = (m: string) => { failures++; if (failures <= 12) console.log('FAIL', m); };

for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  for (const header of findEventDefs(text)) {
    defs++;
    const model = buildEventDefModel(text, header, schemaOf);
    for (const it of model.items) kinds[it.kind] = (kinds[it.kind] ?? 0) + 1;
    const where = `${path.basename(f)}:${header.labelName}`;
    const start = header.call.start;
    // 1) identity setValue on every item and every nested field
    const visit = (p: number[], code: string) => {
      ops++;
      const r = planDefOp(text, start, { op: 'setValue', path: p, code }, code, schemaOf);
      if ('error' in r) {
        refused++; refusals[r.error.slice(0, 60)] = (refusals[r.error.slice(0, 60)] ?? 0) + 1;
        if (!r.error.startsWith('The label name') && !r.error.startsWith('Not a single')) fail(`${where} identity ${JSON.stringify(p)}: ${r.error}`);
      } else if (r.newText !== text) fail(`${where} identity ${JSON.stringify(p)} changed text`);
    };
    for (const it of model.items) {
      visit([it.argIndex], it.code);
      for (const fld of it.node?.fields ?? []) visit([it.argIndex, fld.argIndex], fld.code);
    }
    // 2) remove every item; must succeed and verify
    for (const it of model.items) {
      ops++;
      const r = planDefOp(text, start, { op: 'remove', path: [it.argIndex] }, it.code, schemaOf);
      if ('error' in r) fail(`${where} remove item ${it.argIndex}: ${r.error}`);
    }
    // 3) add a condition via schema template at the right slot
    ops++;
    const code = buildCallCode('BoolCondition', ['True'], []);
    if (typeof code !== 'string') { fail('template'); continue; }
    const slot = insertSlotFor(model, 'condition');
    const r = planDefOp(text, start, { op: 'insert', parent: [], code, afterIndex: slot }, model.code, schemaOf);
    if ('error' in r) fail(`${where} add condition: ${r.error}`);
    // 4) a stale expectation must be refused
    ops++;
    if (model.items[0]) {
      const stale = planDefOp(text, start, { op: 'remove', path: [model.items[0].argIndex] }, model.items[0].code + ' ', schemaOf);
      if (!('error' in stale)) fail(`${where} stale op was not refused`);
    }
    // 5) edits that would break things must be refused
    ops++;
    const bad = planDefOp(text, start, { op: 'insert', parent: [], code: 'foo(' }, model.code, schemaOf);
    if (!('error' in bad)) fail(`${where} broken code accepted`);
    if (model.items[0]) {
      ops++;
      const two = planDefOp(text, start, { op: 'setValue', path: [model.items[0].argIndex], code: 'a, b' }, model.items[0].code, schemaOf);
      if (!('error' in two)) fail(`${where} tuple-ish value accepted`);
    }
    ops++;
    const lbl = planDefOp(text, start, { op: 'remove', path: [1] }, header.call.args[1].value, schemaOf);
    if (!('error' in lbl)) fail(`${where} label removal accepted`);
    void schemaErrors;
  }
}
console.log(`definitions: ${defs}, operations: ${ops}, refused(identity): ${refused}, failures: ${failures}`);
console.log('item kinds:', kinds);
console.log('identity refusals:', refusals);
process.exitCode = failures ? 1 : 0;
