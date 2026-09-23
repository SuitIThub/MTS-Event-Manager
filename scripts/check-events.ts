import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseLabelsInDocument } from '../src/parseLabels';
import { runEventCheck, shotListCsv } from '../src/eventCheck';
import { simulate } from '../src/eventSimulator';
import { DEFAULT_STATE, evalCondition, matchNumberPattern } from '../src/conditionEval';
import { planEndType, planStatOp } from '../src/statsOps';
import { buildEventTimeline } from '../src/eventTimeline';
import { parsePyCall } from '../src/pyCall';
import { renderOverviewHtml } from '../src/eventOverview';
import { makeIndex } from './testIndex';
import { createPaperdollTracer } from '../src/paperdollScript';
import { parseBackgroundCall, planBackgroundEdit, planRemoveLine } from '../src/backgroundOps';
import { parseImageCallsInDocument } from '../src/parseImageCalls';

/**
 * Event check, trigger simulator, stat/end edits and the overview against the real game
 * (the actual workspace index over MTS_WS_ROOT).
 */
const GAME = 'M:/MTS Project/Mind the School/game/scripts';
let problems = 0;
const check = (ok: boolean, m: string) => {
  if (!ok) {
    problems++;
    console.log('FAIL', m);
  } else {
    console.log('ok  ', m);
  }
};
const load = (rel: string) => {
  const f = path.join(GAME, rel);
  const text = fs.readFileSync(f, 'utf8');
  const uri = vscode.Uri.file(f);
  return { f, text, uri, labels: parseLabelsInDocument(uri, text) };
};

async function main() {
  process.env.MTS_WS_ROOT ??= 'M:/MTS Project/Mind the School';
  const index = await makeIndex();
  const dorm = load('buildings/school_dormitory.rpy');
  const at = (d: typeof dorm, label: string) => d.labels.find((l) => l.name === label)!.range.start.line;

  // ── Workspace facts ──
  check(index.getStartLevel('secretary') === 5 && index.getStartLevel('school') === 1, 'start levels: secretary 5, school 1');
  check(index.isGlobalCharacter('headmaster') && index.isGlobalCharacter('subtitles') === index.isGlobalCharacter('subtitles'), 'define character.headmaster is a global speaker');
  const pools = index.getPoolsOfLabel('sd_event_5');
  check(pools.length === 1 && index.getPoolLabels(pools[0]).includes('sd_event_2'), `sd_event_5 pool: ${pools.join(', ')} → ${index.getPoolLabels(pools[0] ?? '').join(', ')}`);

  // ── Event check: clean events stay clean ──
  const sd5 = await runEventCheck(index, dorm.uri, dorm.text, dorm.labels, at(dorm, 'sd_event_5'));
  check(sd5.issues.filter((i) => i.severity !== 'info').length === 0, `sd_event_5 has no problems (${sd5.issues.map((i) => i.message).join(' | ')})`);
  check(sd5.paths.length === 6 && sd5.coverage.length === 14, `sd_event_5: ${sd5.paths.length} paths, ${sd5.coverage.length} image rows`);
  const step0 = sd5.coverage.find((c) => c.step === 0)!;
  check(step0.wildcard === 10 && step0.missing === 0, 'step 0 is served by the $ file for all 10 levels');
  const leave = sd5.paths.find((p) => p.description === 'Leave')!;
  const top = sd5.paths.find((p) => p.description.includes('>= 8'))!;
  check(leave.effects.inhibition?.join() === 'DEC_TINY' && leave.endType === 'new_daytime', `Leave path effects ${JSON.stringify(leave.effects)}`);
  check(top.effects.corruption?.join() === 'SMALL' && top.effects.inhibition?.join() === 'DEC_SMALL', `>= 8 path effects ${JSON.stringify(top.effects)}`);
  const video7 = sd5.coverage.find((c) => c.video && c.step === 7)!;
  check(video7.cells.length === 4 && video7.cells.every((c) => ['7', '8', '9', '10'].includes(c.combo.school_level)), 'video 7 is only needed for levels 7–10 (its branches)');

  const sd2 = await runEventCheck(index, dorm.uri, dorm.text, dorm.labels, at(dorm, 'sd_event_2'));
  check(sd2.issues.filter((i) => i.severity === 'error').length === 0, `sd_event_2: no errors (${sd2.issues.filter((i) => i.severity === 'error').map((i) => i.message).join(' | ')})`);
  const girlRow = sd2.coverage.find((c) => c.keys.includes('girl_name') && c.keys.includes('location'));
  check(!girlRow || girlRow.cells.every((c) => (['aona_komuro', 'lin_kato', 'gloria_goto'].includes(c.combo.girl_name) ? c.combo.location === 'dorm_room' : c.combo.location === 'shower')), 'girl_name follows its location gate');

  const cafe = load('buildings/cafeteria.rpy');
  const c2 = await runEventCheck(index, cafe.uri, cafe.text, cafe.labels, at(cafe, 'cafeteria_event_2'));
  check(c2.coverage.every((r) => r.cells.every((c) => Number(c.combo.level) <= 3)), 'NumCompareCondition("level", 3, "<=") limits the levels checked');

  const office = load('buildings/office_building.rpy');
  const o4 = await runEventCheck(index, office.uri, office.text, office.labels, at(office, 'office_event_4'));
  check(o4.issues.filter((i) => i.code === 'image').length === 0, 'secretary_level starts at 5: office_event_4 is complete');

  const nm = load('events/new_management.rpy');
  const miwa = await runEventCheck(index, nm.uri, nm.text, nm.labels, at(nm, 'nm_potion_hangover_miwa'));
  const csv = shotListCsv(miwa);
  check(miwa.issues.some((i) => i.code === 'image') && csv.includes('nm_potion_hangover_miwa 1.webp'), 'missing image reported + in the shot list');

  // ── Event check: seeded faults are found ──
  const rows = dorm.text.split('\n');
  const movieLine = rows.findIndex((r) => r.startsWith('image anim_sd_event_5_9_7 '));
  const broken = [...rows.slice(0, movieLine), ...rows.slice(movieLine + 1)]
    .join('\n')
    .replace('EventEffect("sd_event_5.leave")', 'EventEffect("sd_event_5.leav")')
    .replace(/(label \.stay \(\*\*kwargs\):[\s\S]*?)luna "Oh Mr\./, '$1ghost "Oh Mr.');
  const bLabels = parseLabelsInDocument(dorm.uri, broken);
  const bad = await runEventCheck(index, dorm.uri, broken, bLabels, bLabels.find((l) => l.name === 'sd_event_5')!.range.start.line);
  const codes = bad.issues.map((i) => i.code);
  check(bad.issues.some((i) => i.code === 'movie' && i.message.includes('anim_sd_event_5_9_7')), 'removed Movie declaration is reported');
  check(bad.issues.some((i) => i.code === 'menu' && i.message.includes('sd_event_5.leav')), 'menu target to a missing label is reported');
  check(bad.issues.some((i) => i.code === 'speaker' && i.message.includes('ghost')), `unloaded speaker is reported (${codes.join(',')})`);

  // ── Timeline: stat + end markers ──
  const tl = buildEventTimeline(dorm.text, dorm.labels, index.getPersonIndex(), at(dorm, 'sd_event_5'), () => ({}));
  check(tl.markers.some((m) => m.kind === 'stats' && m.stats?.[0]?.stat === 'inhibition') && tl.markers.some((m) => m.kind === 'end' && m.endType === 'new_daytime'), 'stats and end_event markers on the path');

  // ── Stat / end edits: verified round trips over the whole game ──
  let statOps = 0;
  let endOps = 0;
  let editFailures = 0;
  const walk = (d: string, o: string[] = []): string[] => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, o);
      else if (e.name.endsWith('.rpy')) o.push(p);
    }
    return o;
  };
  for (const f of walk(GAME)) {
    const text = fs.readFileSync(f, 'utf8');
    const lines = text.split('\n');
    lines.forEach((row, ln) => {
      if (/\bchange_stats_with_modifier\s*\(/.test(row) && !/^\s*(#|label\b)/.test(row)) {
        const off = text.split('\n').slice(0, ln).join('\n').length + (ln ? 1 : 0) + row.indexOf('change_stats_with_modifier');
        const call = parsePyCall(text, off);
        const first = call?.args.find((a) => a.name && a.name !== 'collection');
        if (!first) return;
        const orig = first.value.trim();
        const other = orig === 'GIANT' ? 'TINY' : 'GIANT';
        const a = planStatOp(text, ln, { op: 'set', stat: first.name!, value: other });
        const b = 'error' in a ? a : planStatOp(a.text, ln, { op: 'set', stat: first.name!, value: orig });
        if ('error' in b || b.text !== text) { editFailures++; console.log('FAIL stat round trip', path.basename(f), ln + 1, 'error' in b ? b.error : ''); return; }
        const add = planStatOp(text, ln, { op: 'add', stat: 'morale_x', value: 'SMALL' });
        const rm = 'error' in add ? add : planStatOp(add.text, ln, { op: 'remove', stat: 'morale_x' });
        if ('error' in rm) { editFailures++; console.log('FAIL stat add/remove', path.basename(f), ln + 1, rm.error); return; }
        statOps++;
      }
      if (/\bend_event\s*\(\s*["']/.test(row) && !/^\s*#/.test(row) && !/\bdef\b/.test(row)) {
        const m = /end_event\s*\(\s*["']([A-Za-z_]+)/.exec(row)!;
        const a = planEndType(text, ln, m[1] === 'none' ? 'new_day' : 'none');
        const b = 'error' in a ? a : planEndType(a.text, ln, m[1]);
        if ('error' in b || b.text !== text) { editFailures++; console.log('FAIL end round trip', path.basename(f), ln + 1, 'error' in b ? b.error : ''); return; }
        endOps++;
      }
    });
  }
  check(editFailures === 0 && statOps > 50 && endOps > 50, `${statOps} stat calls and ${endOps} end_event calls: verified round trips, ${editFailures} failures`);

  // ── Trigger simulator ──
  check(matchNumberPattern('3+', 5) && !matchNumberPattern('5-', 6) && matchNumberPattern('1,3,7+', 8) && matchNumberPattern('2-4', 3), 'number pattern (check_in_value)');
  const tc = parsePyCall('TimeCondition(weekday = "d", daytime = "c")', 0)!;
  check(evalCondition(tc, { ...DEFAULT_STATE, weekday: 2, daytime: 4 }).result === 'yes' && evalCondition(tc, { ...DEFAULT_STATE, weekday: 6, daytime: 4 }).result === 'no', 'TimeCondition codes d / c');
  const noon = await simulate(index, 'sd_event_5', { ...DEFAULT_STATE, daytime: 3 });
  const morning = await simulate(index, 'sd_event_5', { ...DEFAULT_STATE, daytime: 1 });
  check(noon.event?.result === 'no' && morning.event?.result === 'yes', `sd_event_5 (daytime 1,6,7): noon ${noon.event?.result}, morning ${morning.event?.result}`);
  check(morning.pools.length === 1 && morning.pools[0].rows.length >= 4 && /prio 3/.test(morning.pools[0].summary), `pool competition: ${morning.pools[0]?.summary}`);

  // ── Paperdoll trace: timing like the engine (nm_ghost_office_janitor) ──
  {
    const nmText = nm.text;
    const nmLines = nmText.split('\n');
    const tracer = createPaperdollTracer(nmText, nm.labels, index.getPersonIndex());
    const from = nmLines.findIndex((l) => l.includes('headmaster "Corner office'));
    const to = nmLines.findIndex((l, i) => i > from && l.includes('subtitles "Her friend'));
    const tr = tracer(from, to);
    const sig = tr.trace.ops.map((o) => `${o.at.toFixed(1)}:${o.kind}:${o.target}:${o.duration}`).join(' ');
    check(tr.trace.blocking === 4.2, `blocking pauses 0.2 + 1 + 3 × 1 = 4.2 s (${tr.trace.blocking})`);
    check(sig === '0.0:flip:ikushi:0.2 0.2:move:ikushi:1 1.2:image:aona:0 2.2:image:aona:0 3.2:image:aona:0 4.2:flip:ikushi:0 4.2:image:ikushi:0 4.2:move:ikushi:1', `op sequence ${sig}`);
    check(tr.scene.background.blurAmount === 10 && tr.scene.background.kind === 'series', 'set_background(image[1], blur = True) → blur 10');
    const moods = tr.trace.ops.filter((o) => o.kind === 'image' && o.target === 'aona').map((o) => o.doll?.values.mood).join(',');
    check(moods === 'sad,happy,sad', `aona's expressions in order: ${moods}`);
    // image.show clears the paperdolls (Image_Series.show → paperdoll_manager.clear()).
    const firstSay = nmLines.findIndex((l) => l.includes('subtitles "By the courtyard path'));
    const atFirst = tracer(undefined, firstSay);
    check(atFirst.scene.dolls.every((d) => d.hidden), 'image.show(0) hides the paperdolls displayed before it');
  }

  // ── Paperdoll background edits: verified round trips over every call in the game ──
  {
    let bgCalls = 0;
    let bgFail = 0;
    for (const f of walk(GAME)) {
      const text = fs.readFileSync(f, 'utf8');
      text.split('\n').forEach((row, ln) => {
        if (!/set_background(_split)?\s*\(/.test(row) || /^\s*(#|def\b)/.test(row) || /def set_background/.test(row)) return;
        const p = parseBackgroundCall(text, ln);
        if (!p || p.positionalOptions) return;
        const want = JSON.parse(JSON.stringify(p.spec));
        want.blur = p.spec.blur === true ? 4.5 : true;
        want.blurDuration = 0.3;
        if (p.split) { want.bwLeft = !p.spec.bwLeft; want.separator = 12; } else want.bw = !p.spec.bw;
        if (want.sources[0].kind === 'series') want.sources[0].step += 1;
        const a = planBackgroundEdit(text, ln, want);
        const aSpec = 'error' in a ? undefined : parseBackgroundCall(a.text, ln)?.spec;
        const b = 'error' in a ? a : planBackgroundEdit(a.text, ln, p.spec);
        const ok = !('error' in a) && aSpec && aSpec.blurDuration === 0.3 && !('error' in b) && parseBackgroundCall(b.text, ln) && JSON.stringify(parseBackgroundCall(b.text, ln)!.spec) === JSON.stringify(p.spec);
        if (!ok) { bgFail++; console.log('FAIL bg', path.basename(f), ln + 1, 'error' in a ? a.error : 'error' in b ? b.error : 'spec differs'); }
        bgCalls++;
      });
    }
    check(bgCalls >= 8 && bgFail === 0, `${bgCalls} set_background calls: edit + revert verified, ${bgFail} failures`);
    const demo = '    $ image.show(3)\n    luna "Hi"\n';
    const rm = planRemoveLine(demo, 0, (r) => /\.show\(/.test(r));
    check(!('error' in rm) && rm.text === '    luna "Hi"\n', 'image statement removal deletes exactly its line');
    check('error' in planRemoveLine(demo, 1, (r) => /\.show\(/.test(r)), 'refuses to remove a line that is not an image statement');
  }

  // ── Performance guards (these once blocked the extension host for seconds per edit) ──
  {
    const t0 = Date.now();
    parseImageCallsInDocument(nm.text, nm.labels);
    const parseMs = Date.now() - t0;
    const t1 = Date.now();
    await index.reindex();
    const reindexMs = Date.now() - t1;
    check(parseMs < 400, `image call scan of new_management.rpy: ${parseMs} ms`);
    check(reindexMs < 800, `re-index with unchanged files: ${reindexMs} ms`);
  }

  // ── Overview webview script parses ──
  const html = renderOverviewHtml({ cspSource: 'x' });
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
  let parses = true;
  try {
    new Function(script);
  } catch (e) {
    parses = false;
    console.log(String(e));
  }
  check(parses, 'overview script parses');

  console.log(`event tools problems: ${problems}`);
  process.exitCode = problems ? 1 : 0;
}
void main();
