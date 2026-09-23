import * as fs from 'fs';
import * as vscode from 'vscode';
import { renderPreviewHtml, stopAtScriptLine } from '../src/previewPanel';
import { enumeratePaths } from '../src/eventCheck';
import { parseLabelsInDocument } from '../src/parseLabels';
import { buildPersonIndex } from '../src/parsePersons';
import { buildEventTimeline, TimelineStop } from '../src/eventTimeline';

/**
 * Run the real event-preview webview script against a fake DOM with a real timeline
 * (school_dormitory sd_event_2) and drive the values bar, random_say alternatives and
 * branch editor. Catches runtime errors the syntax check cannot see.
 */
type Listener = (e: any) => void;
class El {
  tagName: string; id = ''; children: El[] = []; parent?: El; className = ''; _t = ''; value = ''; type = '';
  title = ''; placeholder = ''; src = ''; disabled = false; checked = false; size = 0; rows = 0;
  width = 0; height = 0; style: Record<string, string> = {}; listeners: Record<string, Listener[]> = {};
  classList = { add: (c: string) => { if (!this.className.split(' ').includes(c)) this.className = (this.className + ' ' + c).trim(); }, remove: (c: string) => { this.className = this.className.split(' ').filter((x) => x !== c).join(' '); }, contains: (c: string) => this.className.split(' ').includes(c) };
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  set textContent(v: string) { this._t = String(v ?? ''); this.children = []; }
  get textContent(): string { return this._t + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(_v: string) { this.children = []; this._t = ''; }
  appendChild(c: El) { c.parent = this; this.children.push(c); if (this.tagName === 'SELECT' && c.tagName === 'OPTION' && this.value === '' && this.children.length === 1) this.value = c.value; return c; }
  replaceWith(n: El) { if (this.parent) { const i = this.parent.children.indexOf(this); this.parent.children[i] = n; n.parent = this.parent; } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  addEventListener(t: string, fn: Listener) { (this.listeners[t] ??= []).push(fn); }
  dispatch(t: string) { for (const fn of this.listeners[t] ?? []) fn({ key: '', stopPropagation() {}, preventDefault() {} }); }
  click() { this.dispatch('click'); }
  focus() {} blur() {} select() {} scrollIntoView() {}
  getBoundingClientRect() { return { width: 100, height: 100 }; }
  getContext() { return new Proxy({}, { get: () => () => undefined, set: () => true }); }
  all(): El[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  querySelector(sel: string) { const c = sel.replace(/^\./, ''); return this.all().slice(1).find((e) => e.className.split(' ').includes(c)); }
  querySelectorAll(sel: string) { const c = sel.replace(/^\./, ''); return this.all().slice(1).filter((e) => e.className.split(' ').includes(c)); }
  get options() { return this.children.filter((c) => c.tagName === 'OPTION'); }
}
const html = renderPreviewHtml({ cspSource: 'vscode-resource:' });
const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
const byId = new Map<string, El>();
for (const m of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) { const e = new El(m[1]); e.id = m[2]; byId.set(m[2], e); }
const docRoot = new El('body');
byId.forEach((e) => docRoot.appendChild(e));
const posted: any[] = [];
const winListeners: Listener[] = [];
const fakeDocument = {
  // Ids created through innerHTML (paperdoll fields) are not parsed here: create on demand.
  getElementById: (id: string) => {
    if (!byId.has(id)) { const e = new El('div'); e.id = id; byId.set(id, e); }
    return byId.get(id);
  },
  createElement: (t: string) => new El(t),
  querySelectorAll: (sel: string) => docRoot.querySelectorAll(sel),
};
const fakeWindow = { addEventListener: (t: string, fn: Listener) => { if (t === 'message') winListeners.push(fn); }, devicePixelRatio: 1 };
class FakeImage { onload?: () => void; onerror?: () => void; naturalWidth = 0; naturalHeight = 0; set src(_v: string) {} }
// A controllable clock for the animation player.
let fakeNow = 0;
let rafQueue: (() => void)[] = [];
const advance = (ms: number) => {
  const end = fakeNow + ms;
  while (fakeNow < end) {
    fakeNow = Math.min(end, fakeNow + 16);
    const q = rafQueue; rafQueue = [];
    q.forEach((fn) => fn());
  }
};
new Function('document', 'window', 'acquireVsCodeApi', 'Image', 'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', script)(
  fakeDocument, fakeWindow, () => ({ postMessage: (m: any) => posted.push(m) }), FakeImage, () => 0, () => undefined,
  (fn: () => void) => { rafQueue.push(fn); return rafQueue.length; }, () => { rafQueue = []; }, { now: () => fakeNow }
);

// Build a timeline message like publish() does (without images/portraits).
const f = 'M:/MTS Project/Mind the School/game/scripts/buildings/school_dormitory.rpy';
const text = fs.readFileSync(f, 'utf8');
const labels = parseLabelsInDocument(vscode.Uri.file(f), text);
const lab = labels.find((l) => l.name === 'sd_event_2')!;
const tl = buildEventTimeline(text, labels, buildPersonIndex([], []), lab.range.start.line, () => ({}));
const lines = text.split('\n');
const view = (s: TimelineStop) => ({
  index: s.index, line: s.line, kind: s.kind, speaker: s.speaker ?? '', speechType: s.speechType ?? 'say', text: s.text,
  names: [], portraits: [], cg: 'cg-' + s.line, bg: '', bg2: undefined, bgSplit: false, bgBlur: false, legacyScene: false, dolls: [],
  src: (lines[s.line] ?? '').trim(),
  image: s.kind === 'image' || s.kind === 'video' ? s.image : undefined,
  alternatives: s.alternatives?.map((a, i) => ({ text: a.text, who: a.speaker?.replace(/^character\./, '') ?? '', condition: a.condition ?? '', cg: 'alt-' + i })),
});
const msg = {
  type: 'timeline', eventLabel: 'sd_event_2', stops: tl.stops.map(view),
  markers: tl.markers.map((m) => ({ ...m, src: (lines[m.line] ?? '').trim() })), branches: tl.branches, characters: [],
  values: tl.values, explicitValues: {}, valueOptions: { topic: ['ah', 'ahhh', 'eeek', 'panties', 'breasts', 'oh'] }, current: 0, missing: false,
};
let problems = 0;
const check = (ok: boolean, m: string) => { if (!ok) { problems++; console.log('FAIL', m); } else console.log('ok  ', m); };
winListeners.forEach((fn) => fn({ data: msg }));

const values = byId.get('values')!;
const topicSel = values.all().find((e) => e.tagName === 'SELECT');
check(!!topicSel && topicSel.options.length === 7, 'values bar offers topic (auto + 6 values)');
check(topicSel?.options[0]?._t === '(auto: ah)', `auto option shows the effective value: ${topicSel?.options[0]?._t}`);

const cards = docRoot.querySelectorAll('.card');
check(cards.length === tl.stops.length, `${cards.length} cards for ${tl.stops.length} stops`);
const rsIndex = tl.stops.findIndex((s) => s.alternatives);
cards[rsIndex]?.click();
const cap = byId.get('caption')!;
check(cap.textContent.includes('random 1/7'), `random_say caption: ${cap.textContent.slice(0, 80)}`);
const stage = byId.get('stage')!;
const bgImg = () => stage.all().find((e) => e.tagName === 'IMG')?.src;
check(bgImg() === 'alt-0', `stage shows alternative 1 image (${bgImg()})`);
cap.all().find((e) => e.tagName === 'BUTTON' && e._t === '▶')!.click();
check(cap.textContent.includes('random 2/7') && cap.textContent.includes("Sorry, I'm leaving!"), 'next alternative shown');
for (let i = 0; i < 4; i++) cap.all().find((e) => e.tagName === 'BUTTON' && e._t === '▶')!.click();
check(cap.textContent.includes('random 6/7') && cap.textContent.includes('if topic_set == 1'), `alternative 6 shows speaker/condition: ${cap.textContent.slice(0, 90)}`);
check(bgImg() === 'alt-5', `stage follows the alternative's image (${bgImg()})`);

topicSel!.value = 'panties';
topicSel!.dispatch('change');
const sv = posted.pop();
check(sv?.type === 'setValue' && sv.key === 'topic' && sv.value === 'panties', `setValue posted ${JSON.stringify(sv)}`);

const bar = byId.get('branchbar')!;
check(bar.textContent.includes('topic == "ah"') && bar.textContent.includes('topic in ["panties", "breasts"]'), 'branch bar shows readable if conditions');
check(byId.get('editor')!.textContent === '', 'editor stays free when no menu is open');

// Nested custom menus (school_building sb_event_3): rows follow the walk, indented by depth.
{
  const f2 = 'M:/MTS Project/Mind the School/game/scripts/buildings/school_building.rpy';
  const text2 = fs.readFileSync(f2, 'utf8');
  const labels2 = parseLabelsInDocument(vscode.Uri.file(f2), text2);
  const lab2 = labels2.find((l) => l.name === 'sb_event_3')!;
  const lines2 = text2.split(/\r?\n/);
  const tl2 = buildEventTimeline(text2, labels2, buildPersonIndex([], []), lab2.range.start.line, () => ({}));
  winListeners.forEach((fn) => fn({ data: {
    ...msg, eventLabel: 'sb_event_3', stops: tl2.stops.map((s) => ({ ...view(s), src: (lines2[s.line] ?? '').trim() })),
    markers: tl2.markers.map((m) => ({ ...m, src: (lines2[m.line] ?? '').trim() })), branches: tl2.branches, values: tl2.values, valueOptions: {},
  } }));
  const rows = bar.querySelectorAll('.bb-row');
  check(rows.length === tl2.branches.length && rows.length >= 2, `${rows.length} branch rows for ${tl2.branches.length} branch points`);
  const nested = tl2.branches.findIndex((b) => b.depth === 1);
  check(nested > 0 && rows[nested]?.style.paddingLeft === '14px' && rows[0]?.style.paddingLeft === '0px', 'nested menu row is indented');
  const other = rows[nested].querySelectorAll('bb-opt').find((b) => b.className.includes('alt') && !b.disabled);
  posted.length = 0;
  other?.click();
  const sb = posted.pop();
  check(sb?.type === 'selectBranch' && sb.id === tl2.branches[nested].id, `clicking a nested option posts selectBranch ${JSON.stringify(sb)}`);
  rows[0].all().find((e) => e.className.includes('bb-edit'))?.click();
  check(byId.get('editor')!.textContent.includes('+ Choice'), 'menu ✏ opens the menu choice editor');
}
// show_image series: an image stop card opens the module for exactly that step.
{
  const gf = 'M:/MTS Project/Mind the School/game/scripts/buildings/gym.rpy';
  const gtext = fs.readFileSync(gf, 'utf8');
  const glabels = parseLabelsInDocument(vscode.Uri.file(gf), gtext);
  const glab = glabels.find((l) => l.name === 'gym_event_3')!;
  const gtl = buildEventTimeline(gtext, glabels, buildPersonIndex([], []), glab.range.start.line, () => ({}));
  const glines = gtext.split('\n');
  const imgStop = gtl.stops.find((s) => s.kind === 'image' && s.image?.kind === 'show_image');
  check(!!imgStop && imgStop.image!.stepIndex !== undefined && imgStop.image!.stepCount! > 1, `image stop carries its step position ${imgStop?.image?.stepIndex}/${imgStop?.image?.stepCount}`);
  const lastMarker = gtl.markers.find((m) => m.image?.kind === 'show_image');
  check(!lastMarker || lastMarker.image!.stepIndex === lastMarker.image!.stepCount! - 1, 'the series marker is its last step only');
  winListeners.forEach((fn) => fn({ data: { ...msg, eventLabel: 'gym_event_3', stops: gtl.stops.map((s) => ({ ...view(s), src: (glines[s.line] ?? '').trim() })), markers: gtl.markers.map((m) => ({ ...m, src: (glines[m.line] ?? '').trim() })), branches: gtl.branches, values: gtl.values, valueOptions: {} } }));
  const gcards = docRoot.querySelectorAll('.card');
  posted.length = 0;
  gcards[imgStop!.index]?.click();
  const om = posted.find((m) => m.type === 'openMarker');
  check(om?.kind === 'image' && om.image?.stepIndex === imgStop!.image!.stepIndex && byId.get('imghost')!.style.display === '', `clicking an image stop opens the image module for that step ${JSON.stringify(om?.image)}`);
  winListeners.forEach((fn) => fn({ data: {
    type: 'imageEditor', line: imgStop!.line, src: 'call Image_Series.show_image(image, 3, 4)', patternKey: 'main', steps: [3], pause: false, hasStep: true,
    keys: ['main'], preview: 'p', video: false, call: 'call Image_Series.show_image(image, 3, 4)', single: { index: 0, count: 2 },
  } }));
  check(byId.get('imgkey')!.disabled === true && byId.get('imgremovestep')!.style.display === '', 'single step: pattern locked, remove-step offered');
  check(byId.get('imgpauserow')!.style.display === 'none' && byId.get('imgscope')!.textContent.includes('Step 1 of 2'), 'not the last step: no pause, scope shown');
  byId.get('imgsteps')!.value = '9';
  posted.length = 0;
  byId.get('imgapply')!.click();
  const ap = posted.pop();
  check(ap?.type === 'imgApply' && ap.stepIndex === 0 && ap.stepCount === 2 && ap.steps.join(',') === '9', `apply posts the single step ${JSON.stringify(ap)}`);
  byId.get('imgremovestep')!.click();
  const rs = posted.pop();
  check(rs?.type === 'imgRemoveStep' && rs.stepIndex === 0, 'remove step posts imgRemoveStep');
}

// Video: stage layer + badge, image module in video mode with the Movie actions.
{
  const video = { src: 'v.webm', name: 'anim_x_1_5', loop: true, defined: false, play: 'images/x 1 5.webm', imageRel: 'images/x 1 5.webp' };
  const vstop = { ...view(tl.stops[0]), kind: 'video', cg: 'poster', video };
  winListeners.forEach((fn) => fn({ data: { ...msg, stops: [vstop], markers: [], branches: [] } }));
  const vids = stage.all().filter((e) => e.tagName === 'VIDEO');
  check(vids.length === 1 && (vids[0] as any).loop === true && (vids[0] as any).src === 'v.webm', 'stage plays the video (loop)');
  check(stage.all().some((e) => e.tagName === 'IMG' && e.src === 'poster'), 'start image stays underneath as poster');
  check(stage.textContent.includes('no Movie definition'), 'badge warns about the missing Movie definition');
  winListeners.forEach((fn) => fn({ data: {
    type: 'imageEditor', line: 5, src: '$ image.show_video(5)', patternKey: 'main', steps: [5], pause: false, hasStep: true,
    keys: ['main'], preview: 'poster', video: true, videoView: video, call: '$ image.show_video(5)',
  } }));
  check(byId.get('imgisvideo')!.checked && byId.get('imgvideo')!.style.display === '', 'image module in video mode plays the video');
  check(byId.get('imgpausetxt')!.textContent === 'Pause (wait for click)', 'pause label explains the video stop');
  const addBtn = byId.get('imgmovie')!.all().find((e) => e.tagName === 'BUTTON' && e._t.includes('Movie definition'));
  posted.length = 0;
  addBtn?.click();
  const add = posted.pop();
  check(add?.type === 'movieAdd' && add.loop === true && add.all === false && add.line === 5, `add posts movieAdd ${JSON.stringify(add)}`);
  const iv = byId.get('imgisvideo')!;
  iv.checked = false;
  iv.dispatch('change');
  const ch = posted.pop();
  check(ch?.type === 'imgChange' && ch.video === false, 'unchecking video posts imgChange video=false');
  winListeners.forEach((fn) => fn({ data: {
    type: 'imageEditor', line: 5, src: '', patternKey: 'main', steps: [5], pause: true, hasStep: true, keys: ['main'], preview: 'poster',
    video: true, videoView: { ...video, defined: true, loop: false }, call: '',
  } }));
  const loop = byId.get('imgmovie')!.all().find((e) => e.id === 'imgloop')!;
  loop.checked = true;
  posted.length = 0;
  loop.dispatch('change');
  const lp = posted.pop();
  check(lp?.type === 'movieLoop' && lp.loop === true && lp.pause === true, `defined Movie: loop toggle posts movieLoop ${JSON.stringify(lp)}`);
}
// Stat changes, event end, path effects, event check and trigger simulator.
{
  const df = 'M:/MTS Project/Mind the School/game/scripts/buildings/school_dormitory.rpy';
  const dtext = fs.readFileSync(df, 'utf8');
  const dlabels = parseLabelsInDocument(vscode.Uri.file(df), dtext);
  const d5 = dlabels.find((l) => l.name === 'sd_event_5')!;
  const first5 = buildEventTimeline(dtext, dlabels, buildPersonIndex([], []), d5.range.start.line, () => ({}));
  const menu5 = first5.branches.find((b) => b.kind === 'menu')!;
  const tl5 = buildEventTimeline(dtext, dlabels, buildPersonIndex([], []), d5.range.start.line, () => ({}), { selections: { [menu5.id]: 1 }, values: { school_level: '8' } });
  const dl = dtext.split('\n');
  winListeners.forEach((fn) => fn({ data: { ...msg, eventLabel: 'sd_event_5', stops: tl5.stops.map((s) => ({ ...view(s), src: (dl[s.line] ?? '').trim() })), markers: tl5.markers.map((m) => ({ ...m, src: (dl[m.line] ?? '').trim() })), branches: tl5.branches, values: tl5.values, valueOptions: {} } }));
  const eff = byId.get('effects')!;
  check(eff.textContent.includes('corruption +SMALL') && eff.textContent.includes('inhibition −SMALL') && eff.textContent.includes('end: new_daytime'), `path effects line: ${eff.textContent}`);
  const heads = docRoot.all().filter((e) => e.className === 'phead');
  const statChip = heads.find((e) => e.textContent.startsWith('📈'));
  check(!!statChip && statChip.textContent.includes('inhibition −SMALL'), `stats marker pin: ${statChip?.textContent}`);
  statChip?.click();
  const ed = byId.get('editor')!;
  const selects = ed.all().filter((e) => e.tagName === 'SELECT');
  check(ed.textContent.includes('Stat changes') && selects.length >= 5, 'stats editor lists each stat with a modifier dropdown');
  posted.length = 0;
  selects[0].value = 'DEC_LARGE';
  selects[0].dispatch('change');
  const so = posted.pop();
  check(so?.type === 'statOp' && so.op === 'set' && so.stat === 'inhibition' && so.value === 'DEC_LARGE' && typeof so.src === 'string', `stat change posts statOp ${JSON.stringify(so)}`);
  const endChip = heads.find((e) => e.textContent.startsWith('⏹'));
  endChip?.click();
  const endSel = byId.get('editor')!.all().find((e) => e.tagName === 'SELECT');
  check(!!endSel && endSel.value === 'new_daytime', 'end editor shows the return type');
  if (endSel) { endSel.value = 'map_overview'; endSel.dispatch('change'); }
  const eo = posted.pop();
  check(eo?.type === 'endOp' && eo.endType === 'map_overview', `end change posts endOp ${JSON.stringify(eo)}`);

  // Event check module.
  posted.length = 0;
  byId.get('checkbtn')!.click();
  check(posted.some((m) => m.type === 'check:run') && byId.get('checkhost')!.style.display === '', 'Check opens the module and runs');
  winListeners.forEach((fn) => fn({ data: { type: 'check:result', result: {
    eventLabel: 'sd_event_5', truncated: false,
    issues: [{ severity: 'error', code: 'image', message: 'main step 3: 1 of 10 image(s) missing', line: 400, selections: { x: 1 } }],
    coverage: [{ patternKey: 'main', step: 3, keys: ['school_level'], lines: [400], video: false, exact: 9, wildcard: 0, missing: 1,
      cells: [{ combo: { school_level: '1' }, status: 'missing', expected: 'images/x/sd_event_5 1 3.webp' }, { combo: { school_level: '2' }, status: 'exact', file: 'images/x/sd_event_5 2 3.webp', expected: '' }] }],
    paths: [{ description: 'Leave', selections: { m: 0 }, effects: { inhibition: ['DEC_TINY'] }, endType: 'new_daytime' }],
  } } }));
  const cb = byId.get('checkbody')!;
  check(cb.textContent.includes('1 of 10 image(s) missing'), 'issues tab lists the problem');
  posted.length = 0;
  cb.all().find((e) => e.tagName === 'BUTTON' && e._t === '▶ path')?.click();
  check(posted.pop()?.type === 'check:showPath', '▶ path posts check:showPath');
  cb.all().find((e) => e.tagName === 'BUTTON' && e._t.startsWith('Images'))?.click();
  check(cb.textContent.includes('sd_event_5 1 3.webp') && cb.all().some((e) => e.className === 'cell missing'), 'coverage tab shows the missing file');
  cb.all().find((e) => e.tagName === 'BUTTON' && e._t === '📋 Shot list')?.click();
  check(posted.pop()?.type === 'check:shotlist', 'shot list button posts check:shotlist');
  cb.all().find((e) => e.tagName === 'BUTTON' && e._t.startsWith('Paths'))?.click();
  check(cb.textContent.includes('Leave') && cb.textContent.includes('inhibition −TINY'), 'paths tab shows the stat effects');

  // Trigger simulator.
  posted.length = 0;
  byId.get('simbtn')!.click();
  check(posted.some((m) => m.type === 'sim:init'), 'Trigger asks for the initial state');
  winListeners.forEach((fn) => fn({ data: { type: 'sim:init', state: { weekday: 1, daytime: 3, levels: { school: 5, secretary: 5 }, stats: { inhibition: 60 }, money: 100, intro: false } } }));
  const se = posted.pop();
  check(se?.type === 'sim:eval' && se.state.daytime === 3 && se.state.levels.secretary === 5, `form posts the state ${JSON.stringify(se)}`);
  winListeners.forEach((fn) => fn({ data: { type: 'sim:result', label: 'sd_event_5', result: {
    event: { label: 'sd_event_5', priority: '3', result: 'no', chance: 1, reasons: [], conditions: [{ label: 'TimeCondition(daytime=1,6,7)', result: 'no', detail: 'daytime 3 ∉ 1,6,7' }] },
    pools: [{ pool: 'sd_events["peek_students"]', summary: 'prio 3: 1 of 3 at random (~33 % each)', rows: [{ label: 'sd_event_2', priority: '3', result: 'yes', chance: 1, conditions: [], reasons: [] }] }],
  } } }));
  const sr = byId.get('simresult')!;
  check(sr.textContent.includes('Cannot fire') && sr.textContent.includes('daytime 3 ∉ 1,6,7') && sr.textContent.includes('1 of 3 at random'), 'simulator shows verdict, reasons and pool');
  posted.length = 0;
  sr.all().find((e) => e.tagName === 'A' && e._t === 'sd_event_2')?.click();
  check(posted.pop()?.type === 'openLabel', 'clicking a pool event opens it');
}

// Pin timeline: markers stand between the stop cards, heads step down, splits are marked.
{
  const df = 'M:/MTS Project/Mind the School/game/scripts/buildings/school_dormitory.rpy';
  const dtext = fs.readFileSync(df, 'utf8');
  const dlabels = parseLabelsInDocument(vscode.Uri.file(df), dtext);
  const d5 = dlabels.find((l) => l.name === 'sd_event_5')!;
  const dl = dtext.split('\n');
  const build = (sel: Record<string, number>, values: Record<string, string>) => buildEventTimeline(dtext, dlabels, buildPersonIndex([], []), d5.range.start.line, () => ({}), { selections: sel, values });
  const first = build({}, {});
  const menuB = first.branches.find((b) => b.kind === 'menu')!;
  const toMsg = (tl: ReturnType<typeof build>, keep: boolean) => ({ ...msg, eventLabel: 'sd_event_5', keep, current: 0,
    stops: tl.stops.map((s) => ({ ...view(s), src: (dl[s.line] ?? '').trim() })), markers: tl.markers.map((m) => ({ ...m, src: (dl[m.line] ?? '').trim() })), branches: tl.branches, values: tl.values, valueOptions: {} });
  const stay8 = build({ [menuB.id]: 1 }, { school_level: '8' });
  winListeners.forEach((fn) => fn({ data: toMsg(stay8, false) }));
  const gaps = docRoot.querySelectorAll('.gap');
  const multi = gaps.find((g) => g.children.filter((x) => x.className.startsWith('pin')).length >= 2);
  const pins = multi ? multi.children.filter((x) => x.className.startsWith('pin')) : [];
  check(pins.length >= 2 && pins[0].style.top === '0px' && pins[1].style.top === '18px' && pins[1].style.left === '24px', `pins in one gap step down and right (${pins.map((p) => p.style.top + '/' + p.style.left).join(' ')})`);
  const splitPins = docRoot.all().filter((e) => e.className.split(' ').includes('split'));
  check(splitPins.length === 2 && splitPins.some((p) => p.className.includes('k-menu')) && splitPins.some((p) => p.textContent.includes('⑂') && p.textContent.includes('school_level >= 8')), `splits marked: menu pin + ⑂ if pin (${splitPins.map((p) => p.textContent).join(' | ')})`);
  const cardsNow = docRoot.querySelectorAll('.card');
  check(cardsNow.length === stay8.stops.length && cardsNow.every((cd) => cd.style.marginTop === cardsNow[0].style.marginTop && parseInt(cardsNow[0].style.marginTop, 10) > 20), 'cards sit below the pin heads');

  // Keep position: before the split the stop stays; after it, jump to just before the split.
  const counter = byId.get('counter')!;
  cardsNow[1].click();
  winListeners.forEach((fn) => fn({ data: toMsg(build({ [menuB.id]: 1 }, { school_level: '7' }), true) }));
  check(counter.textContent.startsWith('2 /'), `switching the level branch keeps stop 2 (before the split): ${counter.textContent}`);
  const splitAt = stay8.branches.find((b) => b.kind === 'if')!.afterStop;
  winListeners.forEach((fn) => fn({ data: toMsg(stay8, true) }));
  docRoot.querySelectorAll('.card')[splitAt + 3].click();
  winListeners.forEach((fn) => fn({ data: toMsg(build({ [menuB.id]: 1 }, { school_level: '2' }), true) }));
  check(counter.textContent.startsWith((splitAt + 1) + ' /'), `after the split: back to the last stop before it (${splitAt + 1}): ${counter.textContent}`);
  winListeners.forEach((fn) => fn({ data: toMsg(stay8, false) }));
  check(counter.textContent.startsWith('1 /'), 'a normal update (edit) uses the server position');
}

// Paperdoll animation between stops (engine order: actions in sequence, PDAPause blocks,
// eases run on), background blur/split, skipping on click.
{
  const cfg = (alignX: number, flip: number, extra: Record<string, unknown> = {}) => ({ alignX, alignY: -0.1, zoom: 2, flip, blur: 0, bw: false, color: '#00000000', tint: { r: 0, g: 0, b: 0, a: 0 }, ...extra });
  const base = { index: 0, line: 0, kind: 'dialog', speaker: 'headmaster', speechType: 'say', names: [], portraits: [], cg: '', src: 'x', personKeys: [] };
  const a = { ...base, index: 0, line: 10, text: 'Corner office…', bg: 'bgA', bgSplit: false, bgBlur: 10, bgBw: false,
    dolls: [{ key: 'ikushi', body: 'b1', head: 'h1', config: cfg(1, -1) }, { key: 'aona', body: 'b2', head: 'h2', config: cfg(0, 1) }] };
  const b = { ...base, index: 1, line: 20, text: 'Her friend actually takes the dare…', speaker: 'subtitles', bg: 'bgL', bg2: 'bgR', bgSplit: true, bgBlur: 5, bgBw: false, bgBw2: true,
    dolls: [{ key: 'ikushi', body: 'b1', head: 'h3', config: cfg(1, -1) }, { key: 'aona', body: 'b2', head: 'h4', config: cfg(0, 1) }],
    anim: { blocking: 4.2, end: 5.2, ops: [
      { at: 0, duration: 0.2, kind: 'flip', target: 'ikushi', config: cfg(1, 1) },
      { at: 0.2, duration: 1, kind: 'move', target: 'ikushi', config: cfg(2.5, 1) },
      { at: 1.2, duration: 0, kind: 'image', target: 'aona', config: cfg(0, 1), body: 'b2', head: 'h-sad' },
      { at: 4.2, duration: 0, kind: 'flip', target: 'ikushi', config: cfg(2.5, -1) },
      { at: 4.2, duration: 1, kind: 'move', target: 'ikushi', config: cfg(1, -1) },
    ] } };
  winListeners.forEach((fn) => fn({ data: { ...msg, eventLabel: 'anim', stops: [a, b], markers: [], branches: [], values: {}, valueOptions: {}, current: 0, keep: false } }));
  const stageEl = byId.get('stage')!;
  const bgImgs = () => stageEl.all().filter((e) => e.tagName === 'IMG' && e.className.includes('bg'));
  check(bgImgs().length === 1 && /blur\(0\.52px\)/.test(bgImgs()[0].style.filter), `background blur 10 in game pixels, scaled (${bgImgs()[0]?.style.filter})`);
  const dollEl = (n: number) => stageEl.all().filter((e) => e.className === 'doll')[n];
  const canvasFlip = (n: number) => dollEl(n)?.children[0]?.style.transform;
  check(canvasFlip(0) === 'scaleX(-1.000)', 'flip is an xzoom on the doll');
  const cap = byId.get('caption')!;
  byId.get('next')!.click();
  check(cap.className.includes('waiting'), 'text waits during the blocking pauses');
  advance(100);
  const f = Number(/scaleX\((-?[0-9.]+)\)/.exec(canvasFlip(0) ?? '')?.[1]);
  check(f > -1 && f < 1, `PDAFlip(False, 0.2) is easing (xzoom ${f})`);
  advance(600);
  const left = parseFloat(dollEl(0).style.left);
  check(left > 37.5 && left < 187.5 && Math.abs(left - 112.5) < 20, `PDAMove(alignX=2.5, duration=1.0) is under way (left ${left.toFixed(1)}%)`);
  advance(700);
  const aonaHead = stageEl.all().filter((e) => e.className === 'doll')[1];
  check(!!aonaHead && cap.className.includes('waiting'), 'still paused (3 × PDAPause 1.0 of aona)');
  advance(3000);
  check(!cap.className.includes('waiting'), 'text appears after 4.2 s of pauses');
  advance(1200);
  const done = stageEl.all().filter((e) => e.tagName === 'IMG' && e.className.includes('bg'));
  check(done.length === 2 && stageEl.all().some((e) => e.className === 'bgsep') && /grayscale\(1/.test(done[1].style.filter) && /blur/.test(done[0].style.filter), 'end state: split background, blurred, right half black-and-white');
  // Skip: going on in the middle of an animation jumps to its end state at once.
  byId.get('first')!.click();
  byId.get('next')!.click();
  advance(300);
  byId.get('last')!.click();
  const lefts = stageEl.all().filter((e) => e.className === 'doll').map((e) => e.style.left);
  check(!cap.className.includes('waiting') && rafQueue.length === 0 && lefts.length === 2, 'clicking on skips the running animation to its end');
}

// Paperdoll background module + removing an image statement.
{
  winListeners.forEach((fn) => fn({ data: { ...msg, eventLabel: 'bgtest', stops: [{ ...view(tl.stops[0]), index: 0 }], branches: [], values: {}, valueOptions: {}, current: 0, keep: false,
    markers: [{ kind: 'background', line: 7, character: 4, afterStop: -1, label: 'set_background', src: '$ paperdoll_manager.set_background(image[1], blur = True)', image: { kind: 'set_background', line: 7, character: 4, steps: [1] } }] } }));
  const bgPin = docRoot.all().find((e) => e.className === 'phead' && e.textContent.startsWith('🌄'));
  posted.length = 0;
  bgPin?.click();
  const open = posted.pop();
  check(open?.type === 'bg:open' && open.line === 7 && byId.get('bghost')!.style.display === '', `background pin opens the background module (${JSON.stringify(open)})`);
  const spec = { split: false, sources: [{ kind: 'series', variable: 'image', step: 1 }], blur: true, blurDuration: 0, bw: false, bwLeft: false, bwRight: false, separator: 8 };
  winListeners.forEach((fn) => fn({ data: { type: 'bgEditor', line: 7, src: 'x', spec, saved: spec, previews: ['p1'], positionalOptions: false } }));
  const form = byId.get('bgform')!;
  const stepIn = form.all().find((e) => e.tagName === 'INPUT' && e.value === '1')!;
  check(!!stepIn && byId.get('bgprev')!.all().some((e) => e.tagName === 'IMG' && /blur/.test(e.style.filter)), 'module shows the step and a blurred preview');
  stepIn.value = '4';
  stepIn.dispatch('change');
  const ch = posted.pop();
  check(ch?.type === 'bg:change' && ch.spec.sources[0].step === 4, 'changing the step previews it (bg:change)');
  winListeners.forEach((fn) => fn({ data: { type: 'bgEditor', line: 7, src: 'x', spec: ch.spec, saved: spec, previews: ['p4'], positionalOptions: false } }));
  check(byId.get('bgapply')!.disabled === false && byId.get('bgnote')!.textContent.includes('not applied'), 'pending change can be applied');
  byId.get('bgapply')!.click();
  const ap = posted.pop();
  check(ap?.type === 'bg:apply' && ap.spec.sources[0].step === 4, 'Apply posts bg:apply');
  // Remove from the image module.
  winListeners.forEach((fn) => fn({ data: { type: 'imageEditor', line: 12, src: '$ image.show(3)', patternKey: 'main', steps: [3], pause: false, hasStep: true, keys: ['main'], preview: '', video: false, call: '' } }));
  byId.get('imgremove')!.click();
  const rm = posted.pop();
  check(rm?.type === 'imgRemove' && rm.line === 12, 'image module can remove the statement');
  winListeners.forEach((fn) => fn({ data: { type: 'closeModule', module: 'img' } }));
  check(byId.get('imghost')!.style.display === 'none', 'module closes after removal');
}

// "Show in Event Timeline": the stop for a script line, via another branch path when needed.
{
  const df = 'M:/MTS Project/Mind the School/game/scripts/buildings/school_dormitory.rpy';
  const dtext = fs.readFileSync(df, 'utf8');
  const dlabels = parseLabelsInDocument(vscode.Uri.file(df), dtext);
  const d5 = dlabels.find((l) => l.name === 'sd_event_5')!;
  const dl = dtext.split(/\r?\n/);
  const target = dl.findIndex((l) => l.includes('seraphina "Why not join us?"'));
  const build = (sel: Record<string, number>) => buildEventTimeline(dtext, dlabels, buildPersonIndex([], []), d5.range.start.line, () => ({}), { selections: sel });
  check(stopAtScriptLine(build({}), dlabels, target) === -1, "the default path (Leave) does not pass that line");
  const found = enumeratePaths(build).paths.find((p) => stopAtScriptLine(p.timeline, dlabels, target) >= 0)!;
  const idx = found ? stopAtScriptLine(found.timeline, dlabels, target) : -1;
  check(!!found && found.timeline.stops[idx].line === target, `a path through .stay / >= 8 reaches it: stop ${idx + 1} (${found?.timeline.stops[idx]?.text})`);
  const between = dl.findIndex((l, n) => n > target - 3 && n < target && l.includes('image.show(4)'));
  check(between < 0 || found.timeline.stops[stopAtScriptLine(found.timeline, dlabels, between)].line === target, "a statement line maps to the next stop after it");
}

console.log(`preview UI problems: ${problems}`);
process.exitCode = problems ? 1 : 0;
