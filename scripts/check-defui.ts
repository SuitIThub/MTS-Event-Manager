import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildSchemaRegistry, collectRawClasses, formatSignature } from '../src/parseSchema';
import { buildCallCode, buildEventDefModel, findEventDefs, insertSlotFor, planDefOp } from '../src/eventDef';
import { encodeValue, parsePyCall } from '../src/pyCall';
import { buildDefDomains, EventDefEditor } from '../src/eventDefEditor';
import { mineParamUsage, usageFor } from '../src/paramUsage';
import { GAME, SCRIPTS, WS_ROOT, requireGame } from './testEnv';

requireGame('check-defui', 'full');

/**
 * Drive the definition editor's webview client against a tiny fake DOM with a real model,
 * to catch runtime errors and check the messages its main interactions post.
 */

// ── Minimal fake DOM ──
type Listener = (e: any) => void;
class FakeEl {
  tagName: string;
  children: FakeEl[] = [];
  parent?: FakeEl;
  className = '';
  _text = '';
  value = '';
  type = '';
  title = '';
  placeholder = '';
  size = 0;
  rows = 0;
  disabled = false;
  checked = false;
  style: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  id = '';
  label = '';
  attrs: Record<string, string> = {};
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getAttribute(k: string) { return this.attrs[k]; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  set textContent(v: string) { this._text = String(v ?? ''); this.children = []; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(_v: string) { this.children = []; this._text = ''; }
  appendChild(c: FakeEl) { c.parent = this; this.children.push(c); if (this.tagName === 'SELECT' && c.tagName === 'OPTION' && this.value === '') this.value = c.value; return c; }
  addEventListener(t: string, fn: Listener) { (this.listeners[t] ??= []).push(fn); }
  dispatch(t: string) { for (const fn of this.listeners[t] ?? []) fn({ key: '', stopPropagation() {} }); }
  click() { this.dispatch('click'); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  blur() { this.dispatch('blur'); }
  focus() {}
  all(): FakeEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  querySelector(sel: string): FakeEl | undefined { const cls = sel.replace(/^\./, ''); return this.all().slice(1).find((e) => e.className.split(' ').includes(cls)); }
  get options() { return this.children.filter((c) => c.tagName === 'OPTION'); }
}
const root = new FakeEl('div');
const windowListeners: Listener[] = [];
const posted: any[] = [];
const postedLog: any[] = [];
const fakeDocument = { createElement: (t: string) => new FakeEl(t), getElementById: (id: string) => (id === 'defroot' ? root : undefined) };
const fakeWindow = { addEventListener: (_t: string, fn: Listener) => windowListeners.push(fn) };
const fakeVscode = { postMessage: (m: any) => { posted.push(m); if (m.type === 'def:op' || m.type === 'def:add') postedLog.push(m); } };

// ── Real model ──
function walk(d: string, o: string[] = []): string[] { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, o); else if (e.name.endsWith('.rpy')) o.push(p); } return o; }
const texts = new Map<string, string>(); const raw = [];
for (const f of walk(GAME)) { const t = fs.readFileSync(f, 'utf8'); const u = vscode.Uri.file(f); texts.set(u.toString(), t); raw.push(...collectRawClasses(u, t)); }
const { schemas } = buildSchemaRegistry(raw, texts);
const schemaOf = (n: string) => schemas.get(n);
const file = path.join(GAME, 'scripts/events/new_management.rpy');
const text = fs.readFileSync(file, 'utf8');
const header = findEventDefs(text, 'nm_potion_hangover_miwa')[0];
const model = buildEventDefModel(text, header, schemaOf);
const classes: Record<string, unknown[]> = {};
for (const kind of ['condition', 'selector', 'option', 'pattern']) {
  classes[kind] = [...schemas.values()].filter((s) => s.kind === kind).map((s) => ({ name: s.name, signature: formatSignature(s), params: s.params, inferredKwargs: s.inferredKwargs }));
}
const usage = mineParamUsage(texts.values(), schemaOf);
const classNames = Object.values(classes).flatMap((l) => (l as { name: string }[]).map((c) => c.name));
const domainsOf = (tx: string, h: any, m: any) => buildDefDomains(tx, h, m, classNames, schemaOf, (c, p) => usageFor(usage, c, p));
const dom0 = domainsOf(text, header, model);

// ── Mount & drive ──
let problems = 0;
const check = (ok: boolean, msg: string) => { if (!ok) { problems++; console.log('FAIL', msg); } else console.log('ok  ', msg); };
const mount = new Function('document', 'window', 'vscode', fs.readFileSync(path.join(__dirname, '..', 'webview', 'eventDefEditor.js'), 'utf8') + '\nreturn mountEventDefEditor(vscode);');
const api = mount(fakeDocument, fakeWindow, fakeVscode);
const send = (m: any) => windowListeners.forEach((fn) => fn({ data: m }));
send({ type: 'def:model', labelName: 'nm_potion_hangover_miwa', defs: [{ uri: 'file:///x.rpy', file: 'x.rpy', line: 80, start: header.call.start, model, ...dom0 }], classes });

const everything = () => root.all();
const byText = (t: string) => everything().find((e) => e.tagName === 'BUTTON' && e._text === t);
check(everything().length > 50, `rendered ${everything().length} elements`);
check(everything().some((e) => e._text === 'TimeCondition'), 'TimeCondition card shown');
check(everything().some((e) => e._text.startsWith('Selectors (')), 'Selectors section shown');

// 1) edit a string field (weekday of TimeCondition)
const input = everything().find((e) => e.tagName === 'INPUT' && e.value === 'd');
check(!!input, 'found the weekday "d" input');
if (input) {
  input.value = 'w';
  input.dispatch('change');
  const m = posted.pop();
  check(m?.type === 'def:op' && m.op.op === 'setValue' && m.typed?.kind === 'string' && m.typed.value === 'w' && m.expect === '"d"' && Array.isArray(m.op.path) && m.op.path.length === 2, `setValue message ${JSON.stringify(m)}`);
}

// 2) remove a whole item
const trash = everything().find((e) => e.tagName === 'BUTTON' && e._text === '🗑');
trash?.click();
const rm = posted.pop();
check(rm?.type === 'def:op' && rm.op.op === 'remove' && rm.op.path.length === 1, `remove message ${JSON.stringify(rm)}`);

// 3) add a condition through the form
byText('+ Add')?.click();
const sel = everything().find((e) => e.tagName === 'SELECT' && e.options.some((o) => o._text === 'ProgressCondition'));
check(!!sel, 'add form lists ProgressCondition');
if (sel) {
  sel.value = 'ProgressCondition';
  sel.dispatch('change');
  const vals = everything().filter((e) => e.tagName === 'INPUT' && e.className.includes('val'));
  const keyInput = vals[vals.length - 1] && everything().find((e) => e.tagName === 'INPUT' && e.placeholder !== undefined && e.parent?.children.some((c) => c._text?.startsWith('key')));
  (keyInput ?? vals[0]).value = 'truth_or_dare';
  byText('Insert')?.click();
  const add = posted.pop();
  check(add?.type === 'def:add' && add.className === 'ProgressCondition' && add.kind === 'condition' && add.positionals?.[0]?.value === 'truth_or_dare', `add message ${JSON.stringify(add)}`);
}

// 4) add a keyword to the event (thumbnail)
send({ type: 'def:model', labelName: 'x', defs: [{ uri: 'file:///x.rpy', file: 'x.rpy', line: 80, start: header.call.start, model }], classes });
const kwSelect = everything().filter((e) => e.tagName === 'SELECT' && e.options.some((o) => o._text === 'thumbnail')).pop();
check(!!kwSelect, 'event keyword picker offers thumbnail');
if (kwSelect) {
  kwSelect.value = 'thumbnail';
  kwSelect.dispatch('change');
  const row = kwSelect.parent!;
  const val = row.children.find((c) => c.tagName === 'INPUT' && c.className.includes('val'))!;
  val.value = 'images/x.webp';
  row.children.find((c) => c.tagName === 'BUTTON' && c._text === 'Add')!.click();
  const kw = posted.pop();
  check(kw?.type === 'def:op' && kw.op.op === 'insert' && kw.op.keyword === 'thumbnail' && kw.typed?.value === 'images/x.webp' && kw.op.parent.length === 0, `keyword message ${JSON.stringify(kw)}`);
}

// ── End to end: feed the posted messages to the server-side planner on the real file ──
const all = [...postedLog];
for (const m of all) {
  let op: any;
  let expect = m.expect;
  if (m.type === 'def:add') {
    const code = buildCallCode(m.className, m.positionals.map((t: any) => encodeValue(t.kind, t.value, t.quote)), []);
    if (typeof code !== 'string') { check(false, `template: ${code.error}`); continue; }
    op = { op: 'insert', parent: [], code, afterIndex: insertSlotFor(model, m.kind) };
    expect = model.code;
  } else if (m.op.op === 'setValue') {
    op = { op: 'setValue', path: m.op.path, code: encodeValue(m.typed.kind, m.typed.value, m.typed.quote) };
  } else if (m.op.op === 'insert') {
    op = { op: 'insert', parent: m.op.parent, keyword: m.op.keyword, code: encodeValue(m.typed.kind, m.typed.value, m.typed.quote) };
  } else {
    op = m.op;
  }
  const r = planDefOp(text, header.call.start, op, expect, schemaOf);
  if ('error' in r) { check(false, `server refused ${m.type}/${op.op}: ${r.error}`); continue; }
  const after = parsePyCall(r.newText, header.call.start)!;
  const summary = after.args.map((a) => (a.name ? a.name + '=' : '') + a.value.replace(/\s+/g, ' ')).join(' | ');
  const expectText =
    op.op === 'setValue' ? 'weekday="w"' : op.op === 'remove' ? '!TimeCondition' : op.keyword ? 'thumbnail="images/x.webp"' : 'ProgressCondition("truth_or_dare")';
  const ok = expectText.startsWith('!') ? !summary.includes(expectText.slice(1)) : summary.includes(expectText);
  check(ok, `server applied ${op.op}${op.keyword ? ' ' + op.keyword : ''} -> ${expectText}`);
}

// 6) Compact combinators: OR(...) children render as chips in one wrapping row; a click expands one.
const cafeFile = path.join(GAME, 'scripts/buildings/cafeteria.rpy');
const cafeText = fs.readFileSync(cafeFile, 'utf8');
const cafeHeader = findEventDefs(cafeText, 'cafeteria_event_4')[0];
const cafeModel = buildEventDefModel(cafeText, cafeHeader, schemaOf);
send({ type: 'def:model', labelName: 'cafeteria_event_4', defs: [{ uri: 'file:///c.rpy', file: 'c.rpy', line: 76, start: cafeHeader.call.start, model: cafeModel }], classes });
const combi = everything().find((e) => e.className === 'combi');
const chips = combi ? combi.children.filter((c) => c.className === 'chip') : [];
check(!!combi && chips.length === 2, `OR renders its ${chips.length} conditions as chips in one row`);
check(chips[0]?.textContent.includes('TimeCondition') && chips[0]?.textContent.includes('weekday=d') && chips[0]?.textContent.includes('daytime=1,6'), `chip summary: ${chips[0]?.textContent}`);
chips[0]?.click();
const expandedCard = everything().find((e) => e.className === 'combi')?.children.find((c) => c.className === 'card');
check(!!expandedCard && expandedCard.all().some((e) => e.tagName === 'INPUT' && e.value === '1,6'), 'clicking a chip expands it into editable fields');
const orGrid = everything().filter((e) => e.className === 'fields');
check(orGrid.length > 0, `field grids used (${orGrid.length})`);

// 7) Value domains: meanings, suggestions, strict vocabularies, selector values.
{
  const daytimeUse = usageFor(usage, 'TimeCondition', 'daytime').map((u) => u.value);
  check(['d', 'c', 'f'].every((v) => daytimeUse.includes(v)), `mined TimeCondition.daytime usage: ${daytimeUse.slice(0, 6).join(', ')}`);
  send({ type: 'def:model', labelName: 'nm_potion_hangover_miwa', defs: [{ uri: 'file:///x.rpy', file: 'x.rpy', line: 80, start: header.call.start, model, ...dom0 }], classes });
  const helps = everything().filter((e) => e.className === 'fhelp').map((e) => e._text);
  check(helps.includes('class time (2, 4, 5)'), `daytime "c" explained: ${helps.join(' | ')}`);
  check(helps.includes('work days (Mon–Fri)'), 'weekday "d" explained');
  check(helps.includes('level 1 or lower'), 'LevelCondition "1-" explained');
  const daytimeInput = everything().find((e) => e.tagName === 'INPUT' && e.value === 'c');
  const list = daytimeInput && everything().find((e) => e.tagName === 'DATALIST' && e.id === daytimeInput.attrs.list);
  const listVals = list ? list.children.map((o) => o.value) : [];
  check(!!list && ['x', 'd', 'c', 'f', 'n', '1', '7'].every((v) => listVals.includes(v)), `daytime suggestions: ${listVals.join(',')}`);
  check(everything().some((e) => e.className === 'cdoc' && e._text.startsWith('Game time window')), 'TimeCondition card explains itself');

  // sd_event_2: the topic selector holds only its real values; conditions offer operators.
  const dormFile = path.join(GAME, 'scripts/buildings/school_dormitory.rpy');
  const dormText = fs.readFileSync(dormFile, 'utf8');
  const dormHeader = findEventDefs(dormText, 'sd_event_2')[0];
  const dormModel = buildEventDefModel(dormText, dormHeader, schemaOf);
  const dd = domainsOf(dormText, dormHeader, dormModel);
  const topic = dd.selectorValues.topic ?? [];
  check(topic.join(',') === 'ah,ahhh,oh,eeek,panties,breasts,guys_stop,huh,reason,dressing,blush', `sd_event_2 topic values: ${topic.join(',')}`);
  check(!topic.some((v) => ['topic_set', '==', 'location', 'shower', 'dorm_room'].includes(v)), 'no condition keys/operators leak into topic');
  check((dd.selectorValues.girl_name ?? []).length === 6 && (dd.selectorValues.location ?? []).join(',') === 'dorm_room,shower', 'girl_name / location values');
  const keyOpts = dd.domains.ValueCondition?.params.key?.options.map((o) => o.value) ?? [];
  check(['topic', 'location', 'girl_name'].every((k) => keyOpts.includes(k)), `ValueCondition.key offers the event's selector keys: ${keyOpts.slice(0, 8).join(',')}`);
  send({ type: 'def:model', labelName: 'sd_event_2', defs: [{ uri: 'file:///d.rpy', file: 'd.rpy', line: 60, start: dormHeader.call.start, model: dormModel, ...dd }], classes });
  // ConditionSelector's KeyCompareCondition: expand its chip → operator dropdown.
  const kcChip = everything().find((e) => e.className === 'chip' && e.textContent.startsWith('KeyCompareCondition'));
  kcChip?.click();
  const opSel = everything().find((e) => e.tagName === 'SELECT' && e.value === '>=');
  check(!!opSel && opSel.options.length === 6 && opSel.options.some((o) => o._text === '>= — greater or equal'), 'operation is a dropdown of the six operators');
  if (opSel) {
    posted.length = 0;
    opSel.value = '<';
    opSel.dispatch('change');
    const m = posted.pop();
    check(m?.type === 'def:op' && m.op.op === 'setValue' && m.typed?.value === '<' && m.expect === '">="', `operator change posts setValue ${JSON.stringify(m)}`);
  }
  // StatCondition offers the stat names as keywords.
  const statKw = dd.domains.StatCondition?.keywords ?? [];
  check(['inhibition', 'corruption', 'charm'].every((k) => statKw.includes(k)), 'StatCondition keywords are the stats');
}

// 8) Sections stack vertically, fold on click, and grid their cards.
{
  send({ type: 'def:model', labelName: 'nm_potion_hangover_miwa', defs: [{ uri: 'file:///x.rpy', file: 'x.rpy', line: 80, start: header.call.start, model, ...dom0 }], classes });
  const secs = everything().find((e) => e.className === 'secs')!;
  const heads = () => everything().filter((e) => e.className === 'def-sec-h');
  check(!!secs && heads().length === 5, `${heads().length} stacked sections`);
  check(everything().some((e) => e.className === 'cardgrid' && e.children.length >= 2), 'conditions are laid out in a card grid');
  const cond = heads().find((h) => h.textContent.includes('Conditions'))!;
  cond.click();
  check(heads().find((h) => h.textContent.includes('Conditions'))!.textContent.startsWith('▸') && !everything().some((e) => e._text === 'TimeCondition'), 'clicking a section header folds it');
  heads().find((h) => h.textContent.includes('Conditions'))!.click();
  check(everything().some((e) => e._text === 'TimeCondition'), 'and unfolds it again');
  const opts = heads().find((h) => h.textContent.includes('Options'))!;
  check(opts.textContent.startsWith('▸'), 'empty sections start folded');
  opts.children.find((c) => c.tagName === 'BUTTON' && c._text === '+ Add')!.click();
  check(heads().find((h) => h.textContent.includes('Options'))!.textContent.startsWith('▾') && everything().some((e) => e.className === 'addform'), '+ Add opens a folded section with the add form');
}

// 5) error display
send({ type: 'def:error', message: 'Nope' });
check(everything().some((e) => e.className === 'err' && e._text === 'Nope'), 'error is displayed');
void api;
console.log(`definition UI problems: ${problems}`);
process.exitCode = problems ? 1 : 0;
