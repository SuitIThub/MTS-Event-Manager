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
import { stringExprValue } from '../src/stringExpr';
import { buildTargets, rootFor } from '../src/captureBridge';
import { formatVariantsOf, webviewImageUri } from '../src/webviewUri';
import { scanRegisteredPresets } from '../src/paperdollScript';
import { expandPresetMoves, setWorkspacePresets } from '../src/paperdollResolve';
import { parsePatternOverrides } from '../src/parseEvents';
import { webviewBundle } from './webviewTestUtil';
import { makeIndex } from './testIndex';
import { createPaperdollTracer } from '../src/paperdollScript';
import { parseBackgroundCall, planBackgroundEdit, planRemoveLine } from '../src/backgroundOps';
import { imageCallValues, parseImageCallsInDocument } from '../src/parseImageCalls';
import { planDeleteSayPart, planRandomSayText, planSayText } from '../src/randomSayOps';
import { planDeleteStatement } from '../src/backgroundOps';
import { checkStructure, codeMap, emptyBlocks, lineInsideString, statementEndLine } from '../src/codeStructure';
import { scanSayStatements } from '../src/parsePersons';
import { GAME, SCRIPTS, WS_ROOT, requireGame } from './testEnv';

requireGame('check-events', 'full');

/**
 * Event check, trigger simulator, stat/end edits and the overview against the real game
 * (the actual workspace index over MTS_WS_ROOT).
 */
const GAME_SCRIPTS = SCRIPTS;
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
  const f = path.join(GAME_SCRIPTS, rel);
  const text = fs.readFileSync(f, 'utf8');
  const uri = vscode.Uri.file(f);
  return { f, text, uri, labels: parseLabelsInDocument(uri, text) };
};

async function main() {
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

  // ── random_say: editing one alternative's text round-trips over the whole game ──
  {
    let alts = 0;
    let altFail = 0;
    for (const f of walk(GAME)) {
      const text = fs.readFileSync(f, 'utf8');
      const labs = parseLabelsInDocument(vscode.Uri.file(f), text);
      text.split('\n').forEach((row, ln) => {
        if (!/\brandom_say\s*\(/.test(row) || /^\s*(#|def\b)/.test(row)) return;
        const tlAt = buildEventTimeline(text, labs, index.getPersonIndex(), ln, () => ({}));
        const stop = tlAt.stops.find((s) => s.line === ln && s.alternatives);
        for (const a of stop?.alternatives ?? []) {
          if (a.argIndex === undefined) continue;
          const edited = planRandomSayText(text, ln, a.argIndex, a.text + ' — "edited"');
          const back = 'error' in edited ? edited : planRandomSayText(edited.text, ln, a.argIndex, a.text);
          if ('error' in back || back.text !== text) { altFail++; console.log('FAIL random_say', path.basename(f), ln + 1, a.argIndex, 'error' in back ? back.error : 'differs'); }
          alts++;
        }
      });
    }
    check(alts >= 3 && altFail === 0, `${alts} random_say alternatives: edit + revert byte-identical, ${altFail} failures`);
    const demo = '        $ random_say(\n            "one [topic]",\n            ("two", topic_set == 1),\n            (0.2, ("three", 2)),\n            person = character.sgirl)\n';
    const e2 = planRandomSayText(demo, 0, 2, 'drei');
    check(!('error' in e2) && e2.text.includes('(0.2, ("drei", 2))') && e2.text.includes('"one [topic]"') && e2.text.includes('("two", topic_set == 1)'), 'a weighted tuple alternative changes only its text');
    check('error' in planRandomSayText(demo, 0, 3, 'x'), 'the person= keyword is not an alternative');
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

  // ── Truth or Dare: base_path + "…" patterns, fragments inherit from their composite ──
  {
    const tod = load('events/truth_or_dare.rpy');
    const own = index.getPatternsForLabel('truth_or_dare_1');
    check(own.length === 1 && own[0].pathTemplate === 'images/events/truth_or_dare/truth_or_dare_1/truth_or_dare_1 <school_level> <step>.webp',
      `base_path + "…" pattern resolved: ${own.map((q) => q.pathTemplate).join(', ')}`);
    check(index.getFragmentParents('truth_or_dare_truth_1').join() === 'truth_or_dare_4' && index.getFragmentParents('truth_or_dare_end').join() === 'truth_or_dare_4',
      `fragments know their composite (${index.getFragmentParents('truth_or_dare_truth_1').join()})`);
    const frag = index.getPatternsForLabel('truth_or_dare_truth_1');
    const keys = frag.map((q) => q.patternKey).sort().join(',');
    check(keys === 'base,card,end,main' && frag.find((q) => q.patternKey === 'main')!.pathTemplate.includes('/truth_1/'),
      `fragment: own main + the composite's base/card/end (${keys})`);
    check(index.getPatternLocations('truth_or_dare_truth_1', 'card').length === 1 && index.getPatternLocations('truth_or_dare_truth_1', 'main').every((l) => l.range.start.line >= 49),
      'pattern locations: own key stays own, inherited key points at the composite');
    const vals = index.getSelectorValuesForLabel('truth_or_dare_truth_1');
    check((vals.girls ?? []).includes('ikushi_ito'), `fragment sees the composite's selector values (girls: ${(vals.girls ?? []).join(', ')})`);
    const tr1 = await runEventCheck(index, tod.uri, tod.text, tod.labels, at(tod, 'truth_or_dare_truth_1'));
    const noPattern = tr1.issues.filter((x) => /pattern/i.test(x.message) && /not (found|defined)|unknown|no pattern/i.test(x.message));
    check(noPattern.length === 0 && tr1.coverage.length > 0, `truth_or_dare_truth_1 check: ${tr1.coverage.length} image rows, pattern issues: ${noPattern.map((x) => x.message).join(' | ')}`);
    // convert_pattern("card", {"girls": "ikushi_ito"}, **kwargs): only Ikushi's card is needed.
    const cardRows = tr1.coverage.filter((r) => r.patternKey === 'card');
    check(cardRows.length > 0 && cardRows.every((r) => r.cells.length === 9 && r.cells.every((c) => c.combo.girls === 'ikushi_ito')),
      `data values fix the placeholder: card rows need ${cardRows.map((r) => r.cells.length).join('/')} cells, girls = ${[...new Set(cardRows.flatMap((r) => r.cells.map((c) => c.combo.girls)))].join(',')}`);
    // ── Capture bridge targets (StudioNeoV2 plugin) ──
    {
      const gameRoot = GAME;
      const modRoot = path.join(gameRoot, 'mods', 'CheatMod');
      check(rootFor([gameRoot, modRoot], tod.f) === gameRoot && rootFor([gameRoot, modRoot], path.join(modRoot, 'cheat_mod.rpy')) === modRoot,
        'capture: base events write under game/, mod events under their mod folder');
      const built = buildTargets(tr1.coverage, gameRoot, [gameRoot, modRoot]);
      const plain = built.targets.filter((x) => !x.wildcard);
      const cells = tr1.coverage.filter((r) => !r.video).reduce((n, r) => n + r.cells.length, 0);
      check(plain.length === cells && plain.every((x) => x.path.endsWith('.png') && x.path.startsWith(path.join(gameRoot, 'images'))),
        `capture: one PNG target per cell under game/images (${plain.length}/${cells})`);
      const card = plain.find((x) => x.pattern === 'card' && x.values.school_level === '4' && x.values.step === '0')!;
      check(!!card && card.status === 'exact' && !!card.existing && fs.existsSync(card.existing) && /truth_or_dare_4_card ikushi_ito 4 0\.png$/.test(card.path),
        `capture: target path + existing file (${card ? path.basename(card.path) + ' ← ' + path.basename(card.existing ?? '-') : 'none'})`);
      const wild = built.targets.filter((x) => x.wildcard && x.pattern === 'card');
      check(wild.length > 0 && wild.every((x) => Object.values(x.values).includes('$') && x.values.step !== '$') && wild.some((x) => /truth_or_dare_4_card \$ \$ 0\.png$/.test(x.path)),
        `capture: $ variants per key (${wild.length} for card, e.g. ${path.basename(wild[wild.length - 1]?.path ?? '')})`);
      check(built.keys[built.keys.length - 1] === 'step' && built.keyValues.school_level?.[0] === '$' && !built.keyValues.step.includes('$'),
        `capture: keys ${built.keys.join(',')} — "$" offered first, never for step`);
    }
    const levels = new Set(tr1.coverage.flatMap((r) => r.cells.map((c) => c.combo.school_level)).filter(Boolean));
    check([...levels].every((l) => Number(l) >= 2), `fragment level limits apply (${[...levels].join(',')})`);
  }

  // ── Paperdoll presets come from the game's register_preset table ──
  {
    const game = scanRegisteredPresets(fs.readFileSync(path.join(GAME_SCRIPTS, 'paperdoll.rpy'), 'utf8'));
    check(game.length >= 9 && JSON.stringify(expandPresetMoves('upper_body_left')) === JSON.stringify([{ alignY: -0.1, zoom: 3 }, { alignX: 0 }]),
      `register_preset table read (${game.length} presets), nested presets expand`);
    setWorkspacePresets([...game, ...scanRegisteredPresets('init python:\n    register_preset("mod_far", PDAPreset("outside"), PDAMove(zoom = 0.5))\n')]);
    check(JSON.stringify(expandPresetMoves('mod_far')) === JSON.stringify([{ alignX: -1.5 }, { zoom: 0.5 }]), 'a preset registered elsewhere (mod) is known to the simulation');
    setWorkspacePresets(game);
  }

  // ── Code structure: multi-line strings and statements ──
  {
    const pta = load('pta.rpy');
    const rows = pta.text.split('\n');
    const inner = rows.findIndex((r) => r.includes("I'm aware that many of you"));
    check(inner > 0 && lineInsideString(pta.text, inner), 'triple-quoted dialogue continuation line is inside a string');
    const says = scanSayStatements(pta.text);
    const bogus = says.filter((s) => ['I', 'Here', 'That', 'The', 'We'].includes(s.firstIdent));
    check(bogus.length === 0, `no bogus speakers from triple-quoted text (${bogus.map((s) => s.firstIdent + '@' + (s.line + 1)).join(', ')})`);
    const sayLine = says.find((s) => s.text.includes("I'm aware that many of you"));
    check(!!sayLine && !lineInsideString(pta.text, sayLine.line) && !!sayLine.parts && sayLine.parts.length > 1 && sayLine.parts.some((q) => q.text.startsWith("I'm aware that many of you")),
      `a triple-quoted say is one statement, split into Ren'Py monologue parts (${sayLine?.parts?.length})`);
    if (sayLine) {
      const inside = planSayText(pta.text, inner, 'x');
      check('error' in inside, 'editing a line inside a string is refused');
      check('error' in planSayText(pta.text, sayLine.line, 'x'), 'editing a multi-part monologue without a part is refused');
    }

    // Monologue parts (intro_events: emiko """ … """ with three blank-line separated blocks).
    const intro = load('events/intro_events.rpy');
    const introSays = scanSayStatements(intro.text);
    const mono = introSays.find((s) => s.parts?.[0]?.text.startsWith('Unfortunately, the last headmaster'));
    check(!!mono && mono.parts!.length === 3 && mono.parts![2].text === "This wasn't only bad for the students' education, but also for the school's reputation.",
      `monologue split at blank lines: ${mono?.parts?.map((q) => q.text.slice(0, 20)).join(' | ')}`);
    const joined = introSays.find((s) => s.parts?.[0]?.text.startsWith("You won't be handling"));
    check(!!joined && joined.parts!.length === 2 && joined.parts![1].text.endsWith('and occasionally teach a class or two.') && !joined.parts![1].text.includes('  '),
      'lines of one block are joined with single spaces');
    if (mono) {
      // Timeline: the PTA speech (reached by the default walk) — one stop per part.
      const ptaSay = sayLine!;
      let monoStops: ReturnType<typeof buildEventTimeline>['stops'] = [];
      for (const lab of pta.labels) {
        const found = buildEventTimeline(pta.text, pta.labels, index.getPersonIndex(), lab.range.start.line, () => ({})).stops.filter((s) => s.line === ptaSay.line);
        if (found.length) {
          monoStops = found;
          break;
        }
      }
      const n = ptaSay.parts!.length;
      check(monoStops.length === n && monoStops.every((s, i) => s.part === i && s.partCount === n && s.text === ptaSay.parts![i].text && s.speaker === ptaSay.firstIdent),
        `timeline: one stop per monologue part (${monoStops.map((s) => (s.part ?? 0) + 1 + '/' + s.partCount).join(', ')})`);
      check(monoStops[1]?.partLine === ptaSay.parts![1].line && monoStops[1].partLine! > ptaSay.line, 'a part knows the line its text starts on');

      const newText = 'New "quoted" text\\ ok"';
      const ed = planSayText(intro.text, mono.line, newText, 1, mono.parts![1].text);
      const edParts = 'error' in ed ? undefined : scanSayStatements(ed.text).find((s) => s.line === mono.line)?.parts;
      check(!('error' in ed) && checkStructure(intro.text, ed.edits) === undefined && !!edParts && edParts.length === 3 &&
        edParts[0].text === mono.parts![0].text && edParts[2].text === mono.parts![2].text && edParts[1].text.replace(/\\([\s\S])/g, '$1') === newText,
        `edit one monologue part: others byte-identical (${'error' in ed ? ed.error : ''})`);
      check('error' in planSayText(intro.text, mono.line, 'x', 1, 'stale text'), 'a stale part edit is refused');
      const edLast = planSayText(intro.text, mono.line, 'ends with a quote "', 2, mono.parts![2].text);
      check(!('error' in edLast) && checkStructure(intro.text, edLast.edits) === undefined, `last part may end with a quote (${'error' in edLast ? edLast.error : ''})`);

      for (const k of [0, 1, 2]) {
        const del = planDeleteSayPart(intro.text, mono.line, k, mono.parts![k].text);
        const left = del && !('error' in del) ? scanSayStatements(del.text).find((s) => s.line === mono.line)?.parts?.map((q) => q.text) : undefined;
        const want = mono.parts!.filter((_, i) => i !== k).map((q) => q.text);
        check(!!del && !('error' in del) && checkStructure(intro.text, del.edits) === undefined && JSON.stringify(left) === JSON.stringify(want),
          `delete monologue part ${k + 1}/3 keeps the others`);
      }
      check(planDeleteSayPart(intro.text, introSays.find((s) => !s.parts)!.line, 0) === undefined, 'a plain say has no parts to delete (the whole line goes)');
    }

    let tl = 0;
    let bad = 0;
    for (const lab of pta.labels) {
      const t2 = buildEventTimeline(pta.text, pta.labels, index.getPersonIndex(), lab.range.start.line, () => ({}));
      for (const s of t2.stops) {
        tl++;
        if (lineInsideString(pta.text, s.line)) {
          bad++;
        }
      }
    }
    check(tl > 0 && bad === 0, `pta.rpy timelines: ${tl} stops, ${bad} inside strings`);

    const dorm = load('buildings/school_dormitory.rpy');
    const dr = dorm.text.split('\n');
    const rs = dr.findIndex((r) => r.includes('$ random_say('));
    const re = statementEndLine(dorm.text, rs);
    check(rs > 0 && re > rs && dr[re].trim().endsWith(')'), `random_say spans lines ${rs + 1}–${re + 1}`);

  }

  // ── Overview webview script parses ──
  const script = webviewBundle('overview');
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
