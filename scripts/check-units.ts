import * as fs from 'fs';
import { computeHunks, hunkState, locateRegion } from '../src/editHistory';
import { webviewBundle } from './webviewTestUtil';
import { scanInlineAddedEvents } from '../src/workspaceFacts';
import { isNewer, releaseFromJson } from '../src/updateCheck';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { planDeleteStatement } from '../src/backgroundOps';
import { checkStructure, emptyBlocks } from '../src/codeStructure';
import { parsePatternOverrides } from '../src/parseEvents';
import { imageCallValues } from '../src/parseImageCalls';
import { scanSayStatements } from '../src/parsePersons';
import { expandPresetMoves, setWorkspacePresets } from '../src/paperdollResolve';
import { scanRegisteredPresets } from '../src/paperdollScript';
import { planSayText } from '../src/randomSayOps';
import { stringExprValue } from '../src/stringExpr';
import { formatVariantsOf, webviewImageUri } from '../src/webviewUri';
import { renderOverviewHtml } from '../src/eventOverview';
import { fakeWebview } from './webviewTestUtil';

/**
 * Game-independent unit checks (synthetic sources, temp files). They run everywhere —
 * also in CI, where the game with its images is not available.
 */
let problems = 0;
const check = (ok: boolean, m: string) => {
  if (!ok) {
    problems++;
    console.log('FAIL', m);
  } else {
    console.log('ok  ', m);
  }
};

// ── Ren'Py monologue mode ──
{
  const modes = ['label m:', '    e """', '        one', '        two', '', '        three', '    """', ''].join('\n');
  const partsOf = (src: string) => scanSayStatements(src).find((s) => s.firstIdent === 'e')?.parts?.map((q) => q.text).join('|');
  check(partsOf(modes) === 'one two|three', 'monologue double (default): blank lines split');
  check(partsOf('rpy monologue single\n' + modes) === 'one|two|three', 'rpy monologue single: every line splits');
  check(partsOf('rpy monologue none\n' + modes) === 'one two three', 'rpy monologue none: no split');
  const edited = planSayText(modes, 1, 'deux "quoted"\\', 1, 'three');
  const after = 'error' in edited ? undefined : scanSayStatements(edited.text).find((s) => s.firstIdent === 'e')?.parts?.map((q) => q.text);
  check(!!after && after[0] === 'one two' && after[1].replace(/\\([\s\S])/g, '$1') === 'deux "quoted"\\' && checkStructure(modes, 'error' in edited ? [] : edited.edits) === undefined,
    'edit one monologue part: quotes and backslashes escaped, other part untouched');
  check('error' in planSayText(modes, 3, 'x'), 'editing a line inside a string is refused');
}

// ── Structure guard and statement deletion ──
{
  const src = ['label x:', '    if a:', '        "one"', '    else:', '        "two"', '        "three"', '    return', ''].join('\n');
  const d1 = planDeleteStatement(src, 2);
  check(d1.replacedWithPass && d1.text.includes('    if a:\n        pass\n') && emptyBlocks(d1.text).length === 0, 'deleting the only statement of a block leaves pass');
  const d2 = planDeleteStatement(src, 4);
  check(!d2.replacedWithPass && !d2.text.includes('"two"') && d2.text.includes('"three"'), 'deleting one of several statements removes it');
  const multi = ['label y:', '    $ f(1,', '        2)', '    "after"', ''].join('\n');
  const d3 = planDeleteStatement(multi, 1);
  check(d3.text === ['label y:', '    "after"', ''].join('\n'), 'deleting a multi-line statement removes all of its lines');

  const lineOf = (s: string, n: number) => s.split('\n').slice(0, n).join('\n').length + 1;
  check(checkStructure(src, [{ start: lineOf(src, 2) + 8, end: lineOf(src, 2) + 9, text: '' }]) !== undefined, 'checkStructure refuses an edit that opens a string');
  check(checkStructure(multi, [{ start: lineOf(multi, 2), end: lineOf(multi, 2) + 10, text: '' }]) !== undefined, 'checkStructure refuses an edit that breaks brackets');
  check(checkStructure(src, [{ start: lineOf(src, 2), end: lineOf(src, 3), text: '' }]) !== undefined, 'checkStructure refuses an edit that empties a block');
  check(checkStructure(src, [{ start: lineOf(src, 2) + 9, end: lineOf(src, 2) + 12, text: 'uno' }]) === undefined, 'checkStructure accepts a text change');
  check(checkStructure(src, [{ start: lineOf(src, 3), end: lineOf(src, 3), text: '        "zero"\n' }]) === undefined, 'checkStructure accepts an inserted statement');
}

// ── Values fixed by convert_pattern data / with_values ──
{
  const at = (src: string, name: string) => src.indexOf(name);
  const a = 'x = convert_pattern("card", {"girls": "ikushi_ito", \'lvl\': 3, "dyn": some_var}, **kwargs)';
  check(JSON.stringify(imageCallValues(a, at(a, 'convert_pattern'))) === JSON.stringify({ girls: 'ikushi_ito', lvl: '3' }), 'data dict: literal values taken, dynamic ones left out');
  const b = 'x = convert_pattern("main", data = {"skimpy": True}, **kwargs)';
  check(JSON.stringify(imageCallValues(b, at(b, 'convert_pattern'))) === JSON.stringify({ skimpy: 'True' }), 'data = {…} keyword');
  const c = '$ show_pattern("main", **with_values(kwargs, girls = "lin_kato", n = 2))';
  check(JSON.stringify(imageCallValues(c, at(c, 'show_pattern'))) === JSON.stringify({ girls: 'lin_kato', n: '2' }), 'show_pattern(**with_values(kwargs, …))');
  const d = 'x = convert_pattern("main", video_prefix = "anim_", **kwargs)';
  check(imageCallValues(d, at(d, 'convert_pattern')) === undefined, 'named top-level parameters are not image values');
}

// ── Webview image URLs change when the file on disk changes; PNG/WEBP variants ──
{
  const tmpFile = path.join(os.tmpdir(), `mts-uri-test-${process.pid}.png`);
  fs.writeFileSync(tmpFile, 'a');
  const wv = { asWebviewUri: (u: vscode.Uri) => u };
  fs.utimesSync(tmpFile, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  const u1 = webviewImageUri(wv, tmpFile);
  fs.utimesSync(tmpFile, new Date(1_700_000_100_000), new Date(1_700_000_100_000));
  const u2 = webviewImageUri(wv, tmpFile);
  fs.unlinkSync(tmpFile);
  check(u1.includes('?v=') && u1 !== u2 && u1.split('?')[0] === u2.split('?')[0], 'a replaced image gets a new webview URL (cache-busting)');
  const stem = path.join(os.tmpdir(), `mts-fmt-test-${process.pid}`);
  fs.writeFileSync(stem + '.webp', 'w');
  fs.utimesSync(stem + '.webp', new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  check(formatVariantsOf(stem + '.webp', 'images/x <step>.webp', (f) => f) === undefined, 'format variants: none with only one file');
  fs.writeFileSync(stem + '.png', 'p');
  const fv = formatVariantsOf(stem + '.png', 'images/x <step>.webp', (f) => f);
  check(!!fv && fv.png === stem + '.png' && fv.webp === stem + '.webp' && fv.newer === 'png' && fv.engine === 'webp' && fv.shown === 'png',
    `format variants: newer PNG, game loads the WEBP (${JSON.stringify(fv && { newer: fv.newer, engine: fv.engine, shown: fv.shown })})`);
  check(formatVariantsOf(stem + '.png', 'images/x <step>.png', (f) => f)?.engine === 'png', 'format variants: a .png pattern loads the PNG in game');
  fs.unlinkSync(stem + '.png');
  fs.unlinkSync(stem + '.webp');
}

// ── Paperdoll presets registered anywhere (a mod) are known; built-ins are the fallback ──
{
  setWorkspacePresets(scanRegisteredPresets('init python:\n    register_preset("mod_far", PDAPreset("outside"), PDAMove(zoom = 0.5))\n'));
  check(JSON.stringify(expandPresetMoves('mod_far')) === JSON.stringify([{ alignX: -1.5 }, { zoom: 0.5 }]), 'a registered preset expands (nested built-in included)');
  check(JSON.stringify(expandPresetMoves('upper_body_left')) === JSON.stringify([{ alignY: -0.1, zoom: 3 }, { alignX: 0 }]), 'built-in presets stay the fallback');
  setWorkspacePresets([]);
}

// ── Static string expressions and mod pattern overrides ──
{
  const src = ['init 1 python:', '    base = "images/a/"', '    sub = base + "b/"', '    dyn = f"x{y}"', '    x = sub + "c <step>.webp"  # comment', ''].join('\n');
  const end = src.length;
  check(stringExprValue(src, 'sub + "c <step>.webp"', end) === 'images/a/b/c <step>.webp', 'string expression: chained variables');
  check(stringExprValue(src, '"a" + "b"  # note', end) === 'ab', 'string expression: literals + trailing comment');
  check(stringExprValue(src, 'dyn + "x"', end) === undefined && stringExprValue(src, 'unknown + "x"', end) === undefined && stringExprValue(src, 'base + str(1)', end) === undefined,
    'string expression: dynamic parts are not guessed');
  check(stringExprValue(src, 'base', src.indexOf('    base =')) === undefined, 'string expression: only assignments before the use count');

  const mod = ['init 1 python:', '    set_current_mod("mymod")', '    alt = "images/snack_alt/"', '    overwrite_event_image(', '        "snack_chat",', '        "main",', '        Pattern("main", alt + "<topic> <step>.webp"))', '    # overwrite_event_image("x", "main", Pattern("main", "y"))', ''].join('\n');
  const ov = parsePatternOverrides(vscode.Uri.file(path.join(os.tmpdir(), 'mods', 'x', 'mod.rpy')), mod);
  check(ov.length === 1 && ov[0].label === 'snack_chat' && ov[0].pattern.patternKey === 'main' && ov[0].pattern.pathTemplate === 'images/snack_alt/<topic> <step>.webp' && ov[0].pattern.override?.mod === 'mymod' && ov[0].pattern.range.start.line === 6,
    `overwrite_event_image parsed as a mod pattern for its event (${JSON.stringify(ov.map((o) => [o.label, o.pattern.pathTemplate, o.pattern.override?.mod]))})`);
}

// ── Events added to a pool inline: pool.add_event(Event(…), EventFragment(…)) ──
{
  const src = ['init 1 python:', '    office_events["look"].add_event(', '        Event(3, "ev_a", TimeCondition(daytime = "f")),', '        EventSelect(2, "ev_b"),', '    )', '    storage.add_event(EventFragment(2, "frag_a"))', '    # other.add_event(Event(3, "commented"))', ''].join('\n');
  const inline = scanInlineAddedEvents(src);
  const look = inline.get('office_events["look"]') ?? [];
  check(look.map((e) => e.label + ':' + e.kind).join() === 'ev_a:Event,ev_b:EventSelect' && inline.get('storage')?.[0]?.kind === 'EventFragment' && !inline.has('other'),
    `inline add_event entries keep label and kind (${JSON.stringify([...inline])})`);
}

// ── Update check: version comparison and release parsing ──
{
  check(isNewer('v0.7.0', '0.6.0') && isNewer('0.6.1', '0.6.0') && isNewer('1.0.0', '0.99.99') && isNewer('0.10.0', '0.9.9'), 'newer versions are recognised (numeric, not text order)');
  check(!isNewer('0.6.0', '0.6.0') && !isNewer('v0.5.9', '0.6.0') && !isNewer('garbage', '0.6.0') && !isNewer('0.7.0', 'dev'), 'same, older and malformed versions are not updates');
  const rel = releaseFromJson({ tag_name: 'v0.7.0', html_url: 'https://github.com/SuitIThub/MTS-Event-Manager/releases/tag/v0.7.0', draft: false, prerelease: false });
  check(rel?.version === '0.7.0' && rel.url.endsWith('/releases/tag/v0.7.0'), 'release post link and version read from the GitHub response');
  check(!releaseFromJson({ tag_name: 'v0.8.0', html_url: 'https://github.com/x', prerelease: true }) && !releaseFromJson({ tag_name: 'v0.8.0', html_url: 'https://evil.example/x' }) && !releaseFromJson({ message: 'Not Found' }),
    'pre-releases, foreign links and error responses are ignored');
}

// ── Change history: blocks, reverting one block, finding blocks after other edits ──
{
  const before = ['label a:', '    e "one"', '    e "two"', '    e "three"', '    e "four"', '    e "five"', '    return', ''].join('\n');
  // Two separate changes (line 2 edited, a line inserted after "four") + a deletion ("five").
  const after = ['label a:', '    e "ONE"', '    e "two"', '    e "three"', '    e "four"', '    e "new"', '    return', ''].join('\n');
  const hunks = computeHunks(before, after);
  check(hunks.length === 2 && hunks[0].beforeSeg === '    e "one"\n' && hunks[0].afterSeg === '    e "ONE"\n' && hunks[1].beforeSeg === '    e "five"\n' && hunks[1].afterSeg === '    e "new"\n',
    `a change splits into blocks of changed lines (${hunks.map((h) => JSON.stringify([h.beforeSeg, h.afterSeg])).join(' ')})`);
  check(hunks[0].line === 1 && hunks[1].line === 5 && hunks[1].linesBefore.join('|') === '    e "three"|    e "four"', 'blocks know their line and context lines');
  const revertOne = (cur: string, h: (typeof hunks)[number]) => {
    const at = locateRegion(cur, h);
    return at === undefined ? undefined : cur.slice(0, at) + h.beforeSeg + cur.slice(at + h.afterSeg.length);
  };
  // Revert only block 2, after an unrelated edit shifted everything by one line.
  const drifted = '# note\n' + after;
  const r2 = revertOne(drifted, hunks[1]);
  check(r2 === '# note\n' + ['label a:', '    e "ONE"', '    e "two"', '    e "three"', '    e "four"', '    e "five"', '    return', ''].join('\n'), 'one block reverts on its own, also after the file shifted');
  check(hunkState(r2!, hunks[1]) === 'reverted' && hunkState(r2!, hunks[0]) === 'applied', 'block states follow the text (reverted / applied)');
  const r1 = revertOne(r2!, hunks[0]);
  check(r1 === '# note\n' + before, 'reverting both blocks restores the original');
  const edited = after.replace('    e "ONE"', '    e "ONE!!"');
  check(hunkState(edited, hunks[0]) === 'changed' && locateRegion(edited, hunks[0]) === undefined, 'a block edited since is reported, not reverted blindly');
  const ins = computeHunks('a\nb\n', 'a\nX\nb\n');
  const del = computeHunks('a\nX\nb\n', 'a\nb\n');
  check(ins.length === 1 && ins[0].beforeSeg === '' && ins[0].afterSeg === 'X\n' && del.length === 1 && del[0].beforeSeg === 'X\n' && del[0].afterSeg === '',
    'pure insertions and deletions are blocks too');
  check(revertOne('a\nX\nb\n', ins[0]) === 'a\nb\n' && revertOne('a\nb\n', del[0]) === 'a\nX\nb\n', 'insertions and deletions revert');
  const crlfB = 'x\r\ny\r\nz\r\n';
  const crlfA = 'x\r\nY\r\nz\r\n';
  const ch = computeHunks(crlfB, crlfA);
  check(ch.length === 1 && ch[0].beforeSeg === 'y\r\n' && ch[0].afterSeg === 'Y\r\n', 'CRLF files keep their line endings in blocks');
}

// ── Change history panel script: renders entries, posts revert / reveal ──
{
  type L = (e: any) => void;
  class N {
    children: N[] = []; className = ''; _t = ''; value = ''; title = ''; disabled = false; checked = false; style: Record<string, string> = {}; ls: Record<string, L[]> = {};
    constructor(public tagName: string, public id = '') {}
    set textContent(v: string) { this._t = String(v); this.children = []; }
    get textContent(): string { return this._t + this.children.map((c) => c.textContent).join(''); }
    set innerHTML(_v: string) { this.children = []; this._t = ''; }
    appendChild(c: N) { this.children.push(c); return c; }
    get lastChild() { return this.children[this.children.length - 1]; }
    addEventListener(t: string, f: L) { (this.ls[t] ??= []).push(f); }
    click() { (this.ls.click ?? []).forEach((f) => f({ stopPropagation() {} })); }
    classList = { toggle: (c: string) => { this.className = this.className.includes(c) ? this.className.replace(' ' + c, '') : this.className + ' ' + c; } };
    all(): N[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  }
  const ids = new Map(['file', 'hideReverted', 'clear', 'count', 'list'].map((id) => [id, new N('div', id)]));
  const posted: any[] = [];
  const winLs: L[] = [];
  const doc = { getElementById: (id: string) => ids.get(id), createElement: (tag: string) => new N(tag) };
  const vsc = { postMessage: (m: any) => posted.push(m), getState: () => undefined, setState: () => undefined };
  new Function('document', 'window', 'acquireVsCodeApi', webviewBundle('history'))(doc, { addEventListener: (t: string, f: L) => t === 'message' && winLs.push(f) }, () => vsc);
  check(posted[0]?.type === 'ready', 'history page asks for its data');
  const entry = { id: 7, label: 'Timeline: edit dialogue', time: Date.now(), file: 'game/x.rpy', uri: 'file:///x.rpy', hunks: [
    { index: 0, line: 3, state: 'applied', removed: ['    e "a"'], added: ['    e "b"'], before: ['label x:'], after: [] },
    { index: 1, line: 9, state: 'reverted', removed: [], added: ['    pass'], before: [], after: [] },
  ] };
  winLs.forEach((f) => f({ data: { type: 'history', entries: [entry, { ...entry, id: 8, label: 'Revert: x', revertOf: 7, hunks: [{ ...entry.hunks[0], state: 'changed' }] }] } }));
  const list = ids.get('list')!;
  const text = list.textContent;
  check(text.includes('Timeline: edit dialogue') && text.includes('-     e "a"') && text.includes('+     e "b"') && text.includes('revert of #7') && text.includes('edited since'),
    'history page shows labels, diff lines and block states');
  const buttons = list.all().filter((n) => n.tagName === 'button');
  const revertBlock = buttons.filter((b) => b._t === 'Revert block');
  check(revertBlock.length === 2 && !revertBlock[0].disabled && revertBlock[1].disabled, 'only applied blocks can be reverted');
  posted.length = 0;
  revertBlock[0].click();
  buttons.find((b) => b._t === 'Show in code')!.click();
  buttons.find((b) => b._t === 'Revert change')!.click();
  check(JSON.stringify(posted) === JSON.stringify([{ type: 'revert', id: 7, hunks: [0] }, { type: 'reveal', id: 7, hunk: 0 }, { type: 'revert', id: 7 }]),
    `history buttons post revert block / reveal / revert change (${JSON.stringify(posted)})`);
}

// ── Every webview panel survives a move to another window (serializer + activation event) ──
{
  const srcDir = path.join(__dirname, '..', 'src');
  const all = fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts')).map((f) => fs.readFileSync(path.join(srcDir, f), 'utf8')).join('\n');
  const consts = new Map([...all.matchAll(/const ([A-Z_]+) = '(mts[A-Za-z]+)'/g)].map((m) => [m[1], m[2]]));
  const resolve = (arg: string) => (arg.startsWith("'") ? arg.slice(1, -1) : consts.get(arg) ?? arg);
  const created = new Set([...all.matchAll(/createWebviewPanel\(\s*([A-Z_]+|'[^']+')/g)].map((m) => resolve(m[1])));
  const restored = new Set([...all.matchAll(/registerWebviewPanelSerializer\(\s*([A-Z_]+|'[^']+')/g)].map((m) => resolve(m[1])));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const missing = [...created].filter((v) => !restored.has(v) || !pkg.activationEvents.includes('onWebviewPanel:' + v));
  check(created.size >= 6 && missing.length === 0, `every panel has a serializer and an activation event (${[...created].join(', ')}${missing.length ? '; missing: ' + missing.join(', ') : ''})`);
}

// ── Overview webview renders ──
{
  const html = renderOverviewHtml(fakeWebview);
  check(html.includes('<html') || html.includes('<!DOCTYPE'), 'overview page renders');
}

console.log(`unit problems: ${problems}`);
process.exitCode = problems ? 1 : 0;
