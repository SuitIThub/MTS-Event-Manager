import * as fs from 'fs';
import * as path from 'path';
import {
  applyEdits,
  hasPositionalAfterKeyword,
  insertArgEdit,
  parsePyCall,
  PyCall,
  removeArgEdit,
  replaceValueEdit,
} from '../src/pyCall';

const GAME = 'M:/MTS Project/Mind the School/game';
function walk(d: string, o: string[] = []): string[] {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, o);
    else if (e.name.endsWith('.rpy')) o.push(p);
  }
  return o;
}

const EVENT_RE = /\b(Event|EventFragment|EventComposite|EventSelect)\s*\(/g;
let calls = 0, argOps = 0, failures = 0;
const fail = (msg: string) => { failures++; if (failures <= 15) console.log('FAIL', msg); };

function values(c: PyCall): string[] { return c.args.map((a) => (a.name ? a.name + '=' : '') + a.value); }

for (const f of walk(GAME)) {
  const text = fs.readFileSync(f, 'utf8');
  let m: RegExpExecArray | null;
  EVENT_RE.lastIndex = 0;
  while ((m = EVENT_RE.exec(text)) !== null) {
    // skip comments / strings roughly: line must not start with '#'
    const ls = text.lastIndexOf('\n', m.index) + 1;
    if (text.slice(ls, m.index).includes('#')) continue;
    const call = parsePyCall(text, m.index);
    if (!call || call.args.length < 2) continue;
    calls++;
    const where = `${path.basename(f)}@${text.slice(0, m.index).split('\n').length}`;
    const before = values(call);
    for (let k = 0; k < call.args.length; k++) {
      if (call.args[k].value !== text.slice(call.args[k].valueStart, call.args[k].valueEnd)) fail(`${where} value slice mismatch`);
      // identity replace
      const same = applyEdits(text, [replaceValueEdit(call.args[k], call.args[k].value)]);
      if (same !== text) fail(`${where} identity replace changed text`);
      // remove
      argOps++;
      const removed = applyEdits(text, [removeArgEdit(text, call, k)]);
      const rc = parsePyCall(removed, m.index);
      const expect = before.filter((_, i) => i !== k);
      if (!rc) { fail(`${where} remove #${k}: unparsable`); continue; }
      const got = values(rc);
      if (JSON.stringify(got) !== JSON.stringify(expect)) fail(`${where} remove #${k}: ${JSON.stringify(got)} != ${JSON.stringify(expect)}`);
      if (hasPositionalAfterKeyword(rc)) fail(`${where} remove #${k}: positional after keyword`);
      // text outside the call must be unchanged
      if (removed.slice(0, call.start) !== text.slice(0, call.start)) fail(`${where} remove #${k}: prefix changed`);
    }
    // insert a positional condition at the default slot and after each positional
    const firstKw = call.args.findIndex((a) => !!a.name);
    const slots = [undefined, ...call.args.map((_, i) => i).filter((i) => firstKw < 0 || i < firstKw)];
    for (const slot of slots) {
      argOps++;
      const ins = applyEdits(text, [insertArgEdit(text, call, 'BoolCondition(True)', { afterIndex: slot })]);
      const ic = parsePyCall(ins, m.index);
      if (!ic) { fail(`${where} insert@${slot}: unparsable`); continue; }
      const got = values(ic);
      const at = got.indexOf('BoolCondition(True)');
      const rest = got.filter((_, i) => i !== at);
      if (at < 0 || JSON.stringify(rest) !== JSON.stringify(before)) fail(`${where} insert@${slot}: ${JSON.stringify(got)}`);
      if (hasPositionalAfterKeyword(ic)) fail(`${where} insert@${slot}: positional after keyword`);
      if (slot !== undefined && at !== slot + 1) fail(`${where} insert@${slot}: landed at ${at}`);
    }
    // insert a keyword
    argOps++;
    const kw = applyEdits(text, [insertArgEdit(text, call, 'thumbnail = "x.webp"', { keyword: true })]);
    const kc = parsePyCall(kw, m.index);
    if (!kc || values(kc)[values(kc).length - 1] !== 'thumbnail="x.webp"' || hasPositionalAfterKeyword(kc)) fail(`${where} keyword insert`);
  }
}
console.log(`event calls: ${calls}, arg operations: ${argOps}, failures: ${failures}`);
process.exitCode = failures ? 1 : 0;
