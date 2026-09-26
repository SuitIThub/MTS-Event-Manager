import * as fs from 'fs';
import * as path from 'path';
import {
  buildPersonIndex,
  mergeSelectorValues,
  parseDefaultNames,
  parseDialoguePortraitSites,
  parsePersonsInDocument,
  resolveTokenToPersonKeys,
} from '../src/parsePersons';
import { parseEventsInDocument } from '../src/parseEvents';
import { parseLabelsInDocument } from '../src/parseLabels';
import { labelAtLine } from '../src/parseImageCalls';
import { buildSchemaRegistry, collectRawClasses } from '../src/parseSchema';
import { buildEventTimeline, stopIndexForLine } from '../src/eventTimeline';
import { parseConditionExpr } from '../src/paramConstraints';
import { isSayLine, locateLineIn } from '../src/lineTools';
import { diffRegion, locateRegion } from '../src/editHistory';
import { createPaperdollAnalyzer } from '../src/paperdollScript';
import { findEventDefs, placeholderHints, planDefOp } from '../src/eventDef';
import { parsePyCall } from '../src/pyCall';
import { catalogForRoots, resolveLayers } from '../src/paperdollResolve';
import { analyzePaperdoll, findRegisterInsert, optimizePaperdollEvent, planCursorInsert } from '../src/paperdollScript';
import { PersonInfo } from '../src/types';
import { GAME, SCRIPTS, WS_ROOT, requireGame } from './testEnv';
import * as vscode from 'vscode';

requireGame('verify', 'full');

const MTS = SCRIPTS;

function applyTextEdits(text: string, edits: { start: number; end: number; text: string }[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  for (const edit of ordered) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

function read(rel: string): { uri: vscode.Uri; text: string } {
  const full = path.join(MTS, rel);
  const text = fs.readFileSync(full, 'utf8');
  return { uri: vscode.Uri.file(full), text };
}

function walkRpy(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkRpy(p, out);
    } else if (ent.name.endsWith('.rpy')) {
      out.push(p);
    }
  }
  return out;
}

async function main() {
  const yoga = read('events/new_yoga_outfits.rpy');
  const events = parseEventsInDocument(yoga.uri, yoga.text);
  const labels = parseLabelsInDocument(yoga.uri, yoga.text);

  const e2 = events.find((e) => e.labelName === 'new_yoga_outfit_2');
  const l2 = labels.find((l) => l.name === 'new_yoga_outfit_2');
  console.log('yoga events:', events.length, 'labels:', labels.length);
  console.log('new_yoga_outfit_2 event:', !!e2, 'label:', !!l2);
  if (!e2 || !l2) {
    process.exitCode = 1;
  }

  const office = read('buildings/office_building.rpy');
  const officeEvents = parseEventsInDocument(office.uri, office.text);
  const inline = officeEvents.filter((e) => e.labelName === 'learn_office_event_1');
  console.log('learn_office_event_1 count:', inline.length);
  if (inline.length < 2) {
    process.exitCode = 1;
  }

  // Sublabel in office: fallback Event(..., "office_building.after_general_check")
  const subEv = officeEvents.find((e) => e.labelName === 'office_building.after_general_check');
  console.log('sublabel event:', !!subEv, subEv?.labelName);

  // Portraits: persons, aliases, selector-backed dialogue
  const charFile = read('character.rpy');
  const valuesFile = read('values.rpy');
  const persons: PersonInfo[] = parsePersonsInDocument(charFile.text);
  const personIndex = buildPersonIndex(persons, parseDefaultNames(valuesFile.text));
  console.log('persons:', persons.length, 'has sakura_mori:', personIndex.byKey.has('sakura_mori'));
  console.log(
    'headmaster →',
    resolveTokenToPersonKeys('headmaster', personIndex).join(','),
    'secretary →',
    resolveTokenToPersonKeys('secretary', personIndex).join(','),
    'teacher1 →',
    resolveTokenToPersonKeys('teacher1', personIndex).join(',')
  );
  if (!personIndex.byKey.has('sakura_mori') || !personIndex.byKey.has('emiko_langley')) {
    console.error('missing core persons');
    process.exitCode = 1;
  }
  const emikoDefaults = personIndex.byKey.get('emiko_langley')?.paperdollDefaults;
  console.log('emiko paperdollDefaults', emikoDefaults);
  if (emikoDefaults?.level !== '5') {
    console.error('expected emiko paperdoll default level 5');
    process.exitCode = 1;
  }

  const pdFile = read('events/new_management.rpy');
  const pdLabels = parseLabelsInDocument(pdFile.uri, pdFile.text);
  const poseLine = pdFile.text.split('\n').findIndex((l) => l.includes('pose = "10"') && l.includes('shining'));
  const paper = analyzePaperdoll(pdFile.text, pdLabels, poseLine, 8, personIndex);
  const emikoDoll = paper.scene.dolls.find((d) => d.variable === 'emiko');
  console.log(
    'paperdoll emiko',
    emikoDoll?.values.pose,
    emikoDoll?.values.mood,
    emikoDoll?.values.level,
    emikoDoll?.config.alignX,
    emikoDoll?.config.zoom,
    'bg',
    paper.scene.background.kind,
    paper.scene.background.step
  );
  if (
    !emikoDoll ||
    emikoDoll.personKey !== 'emiko_langley' ||
    emikoDoll.values.pose !== '10' ||
    emikoDoll.values.mood !== 'shining' ||
    emikoDoll.values.level !== '5' ||
    Math.abs(emikoDoll.config.alignX - 0.5) > 0.001 ||
    Math.abs(emikoDoll.config.zoom - 2) > 0.001 ||
    Math.abs(emikoDoll.config.alignY - -0.1) > 0.001
  ) {
    console.error('paperdoll simulation mismatch');
    process.exitCode = 1;
  }
  const catalog = catalogForRoots([path.join(MTS, '..')]);
  const layers = emikoDoll ? resolveLayers(catalog, emikoDoll.personKey, emikoDoll.values, emikoDoll.altKeys) : {};
  console.log('paperdoll files', layers.body && path.basename(layers.body), layers.head && path.basename(layers.head));
  if (!layers.body || !layers.head || !layers.body.includes('uniform') || !layers.head.includes('shining')) {
    console.error('paperdoll resolve mismatch');
    process.exitCode = 1;
  }
  const fixLine = pdFile.text.split('\n').findIndex((l) => l.includes('pose = "2",') && l.includes('shining'));
  const fix = analyzePaperdoll(pdFile.text, pdLabels, fixLine, 8, personIndex);
  const fixDoll = fix.scene.dolls.find((d) => d.variable === 'emiko');
  console.log('sublabel emiko pose', fixDoll?.values.pose, 'zoom', fixDoll?.config.zoom);
  if (!fixDoll || fixDoll.values.pose !== '2' || Math.abs(fixDoll.config.zoom - 2) > 0.001) {
    console.error('paperdoll sublabel did not keep parent framing');
    process.exitCode = 1;
  }
  const nurse = catalog.characters.get('linh_nguyen')?.bottoms.find((b) => b.outfit.startsWith('Nurse'));
  console.log('spaced outfit', nurse?.outfit, nurse?.level);
  if (!nurse || nurse.outfit !== 'Nurse 01' || nurse.level !== '$') {
    console.error('spaced paperdoll outfit was not parsed');
    process.exitCode = 1;
  }
  const registerSample = [
    'label sample (**kwargs):',
    '    $ begin_event(**kwargs)',
    '    $ other = 1',
    '',
    'label other:',
    '    $ begin_event(**kwargs)',
    '',
    '    $ emiko.register_paperdoll()',
    '    $ image.show(0)',
    '    if guided:',
    '        $ aona.register_paperdoll(',
    '            mood = "happy")',
  ].join('\n');
  const registerLabels = parseLabelsInDocument(vscode.Uri.file('sample.rpy'), registerSample);
  const underBegin = findRegisterInsert(registerSample, registerLabels, 0, 'lily');
  const appended = findRegisterInsert(registerSample, registerLabels, 5, 'lily');
  const duplicate = findRegisterInsert(registerSample, registerLabels, 5, 'aona');
  if (
    !underBegin ||
    underBegin.duplicate ||
    underBegin.mode !== 'before-line' ||
    underBegin.line !== 2 ||
    !underBegin.blankBefore ||
    !appended ||
    appended.duplicate ||
    appended.mode !== 'after-line' ||
    appended.line !== 7 ||
    !duplicate?.duplicate
  ) {
    console.error('register insert plan mismatch', underBegin, appended, duplicate);
    process.exitCode = 1;
  }
  const cursorSample = [
    'label sample:',
    '    $ begin_event(**kwargs)',
    '    $ emiko.display(PDAImage(pose = "1"))',
    '    emiko.say "Hi"',
    '',
  ].join('\n');
  const displayRow = '    $ emiko.display(PDAImage(pose = "1"))';
  const inside = planCursorInsert(
    cursorSample,
    2,
    displayRow.lastIndexOf(')'),
    ['PDAPreset("close_body")'],
    'emiko.display(PDAPreset("close_body"))'
  );
  const outside = planCursorInsert(
    cursorSample,
    4,
    0,
    ['PDAImage(mood = "happy")'],
    'emiko.display(PDAImage(mood = "happy"))'
  );
  if (
    !inside?.insideDisplay ||
    inside.insertion !== ', PDAPreset("close_body")' ||
    !outside ||
    outside.insideDisplay ||
    outside.insertion !== '    $ emiko.display(PDAImage(mood = "happy"))'
  ) {
    console.error('cursor insert plan mismatch', inside, outside);
    process.exitCode = 1;
  }
  const optSample = [
    'label sample (**kwargs):',
    '    $ begin_event(**kwargs)',
    '    $ emiko.display(PDAImage(pose = "12", mood = "happy"))',
    '    $ emiko.display(PDAImage(pose = "12", mouth = "open"))',
    '    if cond:',
    '        $ emiko.display(PDAImage(pose = "1"))',
    '    $ emiko.display(PDAImage(pose = "12"))',
    '',
    'label .later:',
    '    $ emiko.display(PDAImage(pose = "12", mood = "happy"))',
    '    $ emiko.display(PDAImage(pose = "3", mood = "happy"))',
  ].join('\n');
  const optLabels = parseLabelsInDocument(vscode.Uri.file('opt.rpy'), optSample);
  const optimized = optimizePaperdollEvent(optSample, optLabels, 0);
  const optText = applyTextEdits(optSample, optimized.edits);
  const optLines = optText.split('\n');
  if (
    optimized.calls !== 1 ||
    !optLines.some((row) => row.includes('PDAImage(mouth = "open")')) ||
    !optLines.some((row) => row.includes('PDAImage(pose = "1")')) ||
    !optLines.some((row) => row.includes('PDAImage(pose = "12")')) ||
    optLines.filter((row) => row.includes('mood = "happy"')).length !== 1 ||
    !optLines.some((row) => row.includes('PDAImage(pose = "3")'))
  ) {
    console.error('paperdoll optimize mismatch', optimized.fields, optimized.calls, optText);
    process.exitCode = 1;
  }
  if (resolveTokenToPersonKeys('headmaster', personIndex)[0] !== 'headmaster') {
    console.error('headmaster alias wrong');
    process.exitCode = 1;
  }
  if (resolveTokenToPersonKeys('secretary', personIndex)[0] !== 'emiko_langley') {
    console.error('secretary should map to emiko_langley');
    process.exitCode = 1;
  }
  if (resolveTokenToPersonKeys('teacher1', personIndex)[0] !== 'lily_anderson') {
    console.error('teacher1 should map to lily_anderson');
    process.exitCode = 1;
  }

  const teach = read('events/teaching_lessons.rpy');
  const teachEvents = parseEventsInDocument(teach.uri, teach.text);
  const teachLabels = parseLabelsInDocument(teach.uri, teach.text);
  const ld2 = teachEvents.find((e) => e.labelName === 'sb_teach_math_ld_2');
  console.log('ld_girl_name selector:', ld2?.selectorValues.ld_girl_name);
  const teachSites = parseDialoguePortraitSites(teach.text, teachLabels, personIndex, (line) => {
    const lab = labelAtLine(teachLabels, line);
    if (!lab) {
      return {};
    }
    const names = [lab.name];
    const dot = lab.name.indexOf('.');
    if (dot > 0) {
      names.push(lab.name.slice(0, dot));
    }
    return mergeSelectorValues(names.flatMap((n) => teachEvents.filter((e) => e.labelName === n)));
  });
  const girlSite = teachSites.find(
    (s) =>
      s.personKeys.includes('seraphina_clark') &&
      s.personKeys.includes('hatano_miwa') &&
      s.personKeys.includes('soyoon_yamamoto')
  );
  console.log(
    'girl dialogue portraits:',
    girlSite?.personKeys,
    'line',
    girlSite ? girlSite.range.start.line + 1 : '-'
  );
  const expectedGirls = ['hatano_miwa', 'seraphina_clark', 'soyoon_yamamoto'];
  if (!girlSite || expectedGirls.some((k) => !girlSite.personKeys.includes(k))) {
    console.error('expected selector portraits on girl in sb_teach_math_ld_2');
    process.exitCode = 1;
  }

  const cafe = read('buildings/cafeteria.rpy');
  const cafeEvents = parseEventsInDocument(cafe.uri, cafe.text);
  const cafeEv = cafeEvents.find((e) => e.labelName === 'cafeteria_event_2');
  console.log('cafeteria girl_name:', cafeEv?.selectorValues.girl_name);
  if (
    !cafeEv?.selectorValues.girl_name?.includes('adelaide_hall') ||
    !cafeEv.selectorValues.girl_name.includes('miwa_igarashi')
  ) {
    console.error('nested RandomListSelector persons missing on cafeteria_event_2');
    process.exitCode = 1;
  }

  const nm = read('events/new_management.rpy');
  const nmEvents = parseEventsInDocument(nm.uri, nm.text);
  const nmLabels = parseLabelsInDocument(nm.uri, nm.text);
  const rumors = nmEvents.find((e) => e.labelName === 'nm_rumors_in_bloom_kiosk');
  console.log('bystander selector:', rumors?.selectorValues.bystander);
  const nmSites = parseDialoguePortraitSites(nm.text, nmLabels, personIndex, (line) => {
    const lab = labelAtLine(nmLabels, line);
    if (!lab) {
      return {};
    }
    const names = [lab.name];
    const dot = lab.name.indexOf('.');
    if (dot > 0) {
      names.push(lab.name.slice(0, dot));
    }
    return mergeSelectorValues(names.flatMap((n) => nmEvents.filter((e) => e.labelName === n)));
  });
  const bystanderSite = nmSites.find((s) => s.personKeys.includes('ikushi_ito') && s.personKeys.length >= 3);
  const emikoSite = nmSites.find((s) => s.personKeys.length === 1 && s.personKeys[0] === 'emiko_langley');
  console.log('bystander portraits:', bystanderSite?.personKeys, 'emiko site:', !!emikoSite);
  if (!bystanderSite) {
    console.error('expected bystander selector portraits');
    process.exitCode = 1;
  }

  // Event timeline: stops, subtitles, menu branching into sublabels, governing image
  const sb = read('buildings/school_building.rpy');
  const sbLabels = parseLabelsInDocument(sb.uri, sb.text);
  const sbEvent = sbLabels.find((l) => l.name === 'sb_event_3');
  const timeline = buildEventTimeline(sb.text, sbLabels, personIndex, sbEvent!.range.start.line, () => ({}));
  const menuBranches = timeline.branches.filter((b) => b.kind === 'menu');
  const hasSubtitleStop = timeline.stops.some((s) => s.kind === 'dialog' && s.speaker === 'subtitles' && s.personKeys.length === 0);
  const hasMiwaStop = timeline.stops.some((s) => s.personKeys.includes('miwa_igarashi'));
  const hasGoverningImage = timeline.stops.every((s) => s.kind !== 'dialog' || !!s.image);
  const firstMenu = menuBranches[0];
  const firstMenuMarker = timeline.markers.find((m) => m.kind === 'menu');
  const branchTargets = firstMenuMarker?.choices?.map((c) => c.target) ?? [];
  console.log(
    'timeline sb_event_3 stops:', timeline.stops.length,
    'markers:', timeline.markers.length,
    'menuBranches:', menuBranches.length,
    'subtitleStop:', hasSubtitleStop,
    'miwaStop:', hasMiwaStop,
    'firstMenu targets:', branchTargets.join(',')
  );
  if (
    timeline.stops.length < 10 ||
    menuBranches.length < 2 ||
    !hasSubtitleStop ||
    !hasMiwaStop ||
    !hasGoverningImage ||
    !branchTargets.includes('sb_event_3.what')
  ) {
    console.error('event timeline mismatch');
    process.exitCode = 1;
  }
  const altPath = buildEventTimeline(sb.text, sbLabels, personIndex, sbEvent!.range.start.line, () => ({}), {
    selections: firstMenu ? { [firstMenu.id]: 1 } : {},
  });
  console.log('timeline alt-branch stops:', altPath.stops.length, 'default stops:', timeline.stops.length);
  if (altPath.stops.length === timeline.stops.length && firstMenu) {
    console.error('menu branch switching had no effect');
    process.exitCode = 1;
  }
  // Nested branches: a menu inside a menu branch, and an if-chain inside a menu branch.
  const nestedMenu = timeline.branches.find((b) => b.kind === 'menu' && b.depth === 1);
  console.log('nested menu:', nestedMenu?.id, 'parent:', nestedMenu?.parent);
  if (!nestedMenu || nestedMenu.parent !== firstMenu?.id || firstMenu?.depth !== 0) {
    console.error('nested menu branch not linked to its parent');
    process.exitCode = 1;
  }
  const kiosk = read('buildings/kiosk.rpy');
  const kioskLabels = parseLabelsInDocument(kiosk.uri, kiosk.text);
  const k3 = kioskLabels.find((l) => l.name === 'kiosk_event_3');
  if (k3) {
    const kTl = buildEventTimeline(kiosk.text, kioskLabels, personIndex, k3.range.start.line, () => ({}));
    const kMenu = kTl.branches.find((b) => b.kind === 'menu' && b.depth === 0);
    const kIf = kTl.branches.find((b) => b.kind === 'if' && b.parent === kMenu?.id);
    console.log('kiosk_event_3 menu:', kMenu?.id, kMenu?.title, 'nested if:', kIf?.id, 'depth', kIf?.depth);
    if (!kMenu || kMenu.title !== 'What do you do?' || !kIf || kIf.depth !== 1) {
      console.error('if-chain nested in a menu branch not detected');
      process.exitCode = 1;
    }
  }
  if (stopIndexForLine(timeline, sbEvent!.range.start.line + 12) < 0) {
    console.error('stopIndexForLine failed');
    process.exitCode = 1;
  }

  // Selector values are evaluated like the engine: condition-gated tuples, weights and
  // nested selectors contribute their values only — never the keys/operators of the gating
  // conditions (sd_event_2 once listed topic_set / "==" / location under topic).
  {
    const dormSv = read('buildings/school_dormitory.rpy');
    const sd2 = parseEventsInDocument(dormSv.uri, dormSv.text).find((e) => e.labelName === 'sd_event_2')!;
    const sv = sd2.selectorValues;
    const want: Record<string, string> = {
      topic: 'ah,ahhh,oh,eeek,panties,breasts,guys_stop,huh,reason,dressing,blush',
      location: 'dorm_room,shower',
      topic_set: '1,2',
      girl_name: 'aona_komuro,lin_kato,gloria_goto,sakura_mori,elsie_johnson,ishimaru_maki',
    };
    for (const [k, v] of Object.entries(want)) {
      if ((sv[k] ?? []).join(',') !== v) {
        console.error('selector values', k, '→', sv[k], 'expected', v);
        process.exitCode = 1;
      }
    }
    if ('inhibition' in sv) {
      console.error('StatSelector (game state) must not offer values');
      process.exitCode = 1;
    }
    console.log('sd_event_2 selector values:', Object.keys(sv).join(', '));
  }

  // Numeric level conditions: comparisons, chains, and/or; non-level literals ignored.
  {
    const vals = (e: string) => JSON.stringify(parseConditionExpr(e).map((b) => [b.variable, b.values.join(','), !!b.numeric]));
    const cases: [string, string][] = [
      ['school_level >= 8', '[["school_level","8,9,10",true]]'],
      ['level < 3', '[["level","0,1,2",true]]'],
      ['3 <= level < 5', '[["level","3,4",true]]'],
      ['level == 2 or level == 7', '[["level","2,7",true]]'],
      ['level >= 2 and level <= 4', '[["level","2,3,4",true]]'],
      ['inhibition >= 50', '[]'],
      ['not level >= 5', '[]'],
      ['topic == "ah" or level >= 9', '[["topic","ah",false]]'],
    ];
    for (const [expr, want] of cases) {
      const got = vals(expr);
      if (got !== want) {
        console.error('numeric condition', expr, '→', got, 'expected', want);
        process.exitCode = 1;
      }
    }
    console.log('numeric level conditions:', cases.length, 'cases');
  }

  // Show_image pause semantics + bare/renpy pause become stops
  const gym = read('buildings/gym.rpy');
  const gymLabels = parseLabelsInDocument(gym.uri, gym.text);
  const gymEv = gymLabels.find((l) => l.name === 'gym_event_3');
  if (gymEv) {
    const gymTl = buildEventTimeline(gym.text, gymLabels, personIndex, gymEv.range.start.line, () => ({}));
    const pauseStops = gymTl.stops.filter((s) => s.kind === 'pause' || s.kind === 'image' || s.kind === 'video');
    console.log('gym_event_3 stops:', gymTl.stops.length, 'pause/image/video stops:', pauseStops.length);
  }

  // Regression: a speaker change must never hit a non-dialogue line (the `call` line
  // above a dialogue was rewritten when the preview's line numbers were stale).
  const callLine = '    call Image_Series.show_image(image, 0, 1) from _call_x';
  const sayChecks: [string, boolean][] = [
    [callLine, false],
    ['    $ image.show(0)', false],
    ['    jump somewhere', false],
    ['    miwa "Hi."', true],
    ['    emiko.think "Hmm."', true],
    ['    subtitles"No space."', true],
  ];
  for (const [row, expected] of sayChecks) {
    if (isSayLine(row) !== expected) {
      console.error('isSayLine mismatch for', JSON.stringify(row), 'expected', expected);
      process.exitCode = 1;
    }
  }
  // Stale line: the preview saw the dialogue at line 5, then a line was typed above it.
  const staleBefore = ['label a:', '    $ begin_event()', '', '    $ image = convert_pattern("main")', callLine, '    miwa "Hi."'];
  const staleNow = [...staleBefore.slice(0, 2), '    # new unsaved line', ...staleBefore.slice(2)];
  const located = locateLineIn(staleNow, 5, 'miwa "Hi."');
  console.log('stale line relocated: 5 ->', located, '(line 5 is now:', JSON.stringify(staleNow[5].trim()) + ')');
  if (located !== 6) {
    console.error('stale line relocation failed');
    process.exitCode = 1;
  }

  // Regression: undo must survive unrelated edits elsewhere in the file.
  const undoBefore = ['label a:  ', '    $ begin_event()', '    subtitles "One."', '    miwa "Two."', '    subtitles "Three."'].join('\n');
  const undoAfter = undoBefore.replace('    miwa "Two."', '    sakura "Two."');
  const region = diffRegion(undoBefore, undoAfter);
  // Unrelated changes after our edit: trailing whitespace trimmed on line 1 and a line added at the top.
  const drifted = '# header\n' + undoAfter.replace('label a:  ', 'label a:');
  const at = locateRegion(drifted, region);
  const reverted = at === undefined ? '' : drifted.slice(0, at) + region.beforeSeg + drifted.slice(at + region.afterSeg.length);
  const expectedRevert = '# header\n' + undoBefore.replace('label a:  ', 'label a:');
  console.log('undo after unrelated edits:', reverted === expectedRevert ? 'reverted cleanly' : 'FAILED');
  if (reverted !== expectedRevert) {
    process.exitCode = 1;
  }
  if (locateRegion(expectedRevert, region) !== undefined) {
    console.error('undo region should not be found once already reverted');
    process.exitCode = 1;
  }

  // Performance guard: simulating every stop of a paperdoll-heavy event used to take
  // ~12 s (the file was re-parsed per stop, quadratically). It must stay fast.
  const nmPerf = read('events/new_management.rpy');
  const nmPerfLabels = parseLabelsInDocument(nmPerf.uri, nmPerf.text);
  const hangover = nmPerfLabels.find((l) => l.name === 'nm_potion_hangover_miwa');
  if (hangover) {
    const t0 = Date.now();
    const perfTl = buildEventTimeline(nmPerf.text, nmPerfLabels, personIndex, hangover.range.start.line, () => ({}));
    const analyze = createPaperdollAnalyzer(nmPerf.text, nmPerfLabels, personIndex);
    for (const s of perfTl.stops) {
      analyze(s.line, 0);
    }
    const ms = Date.now() - t0;
    console.log('nm_potion_hangover_miwa full map:', perfTl.stops.length, 'stops in', ms, 'ms');
    if (ms > 2000) {
      console.error('paperdoll event mapping regressed (>2s)');
      process.exitCode = 1;
    }
  }

  // random_say stops and selector-driven branches (school_dormitory sd_event_2).
  const dorm = read('buildings/school_dormitory.rpy');
  const dormLabels = parseLabelsInDocument(dorm.uri, dorm.text);
  const sd2 = dormLabels.find((l) => l.name === 'sd_event_2')!;
  const dormDefault = buildEventTimeline(dorm.text, dormLabels, personIndex, sd2.range.start.line, () => ({}));
  const rsStop = dormDefault.stops.find((s) => s.alternatives);
  console.log('random_say alternatives:', rsStop?.alternatives?.length, 'default topic:', dormDefault.values.topic);
  if (!rsStop || rsStop.alternatives!.length !== 7 || !rsStop.alternatives!.some((a) => a.image?.steps[0] === 1) || dormDefault.values.topic !== 'ah') {
    console.error('random_say / default branch values mismatch');
    process.exitCode = 1;
  }
  const dormPanties = buildEventTimeline(dorm.text, dormLabels, personIndex, sd2.range.start.line, () => ({}), { values: { topic: 'panties' } });
  const topicChain = dormPanties.branches.find((b) => b.kind === 'if' && b.bindings?.some((x) => 'topic' in x));
  const pantiesStop = dormPanties.stops.find((s) => s.alternatives?.length === 3);
  console.log('topic=panties picks:', topicChain?.options[topicChain.selected], `(${topicChain?.via})`);
  if (!topicChain || topicChain.via !== 'value' || !topicChain.options[topicChain.selected].includes('panties') || !pantiesStop) {
    console.error('selector value did not pick the matching branch');
    process.exitCode = 1;
  }

  // Definition semantics: no false placeholder hints on real content, and removing a
  // selector whose key a pattern uses produces one.
  const cafeDefs = findEventDefs(cafe.text, 'cafeteria_event_2');
  if (cafeDefs.length !== 1 || placeholderHints(cafeDefs[0].call).length !== 0) {
    console.error('placeholder hints on intact cafeteria_event_2', cafeDefs.length && placeholderHints(cafeDefs[0].call));
    process.exitCode = 1;
  } else {
    const call = cafeDefs[0].call;
    // `girl_name` feeds <girl_name> in the pattern (the first selector, `time`, does not).
    const selIdx = call.args.findIndex((a) => a.call?.name?.endsWith('Selector') && a.call.args[0]?.value === '"girl_name"');
    const removed = planDefOp(cafe.text, call.start, { op: 'remove', path: [selIdx] }, call.args[selIdx].value, () => undefined);
    const newCall = 'error' in removed ? undefined : parsePyCall(removed.newText, call.start);
    const hints = newCall ? placeholderHints(newCall) : [];
    console.log('removing a used selector ->', hints.length ? hints[0] : 'no hint');
    if (!hints.length) {
      console.error('expected a placeholder hint after removing a used selector');
      process.exitCode = 1;
    }
  }

  // Schema discovery across all scripts (sample subset for speed: conditions + selector + images + yoga)
  const files = [
    'conditions.rpy',
    'selector.rpy',
    'option.rpy',
    'images.rpy',
    'event.rpy',
    'events/new_yoga_outfits.rpy',
  ];
  const allRaw = [];
  const texts = new Map<string, string>();
  for (const rel of files) {
    const { uri, text } = read(rel);
    texts.set(uri.toString(), text);
    allRaw.push(...collectRawClasses(uri, text));
  }
  const { schemas } = buildSchemaRegistry(allRaw, texts);
  const conditions = [...schemas.values()].filter((s) => s.kind === 'condition');
  const selectors = [...schemas.values()].filter((s) => s.kind === 'selector');
  console.log('schemas total:', schemas.size, 'conditions:', conditions.length, 'selectors:', selectors.length);
  console.log('has TimeCondition:', schemas.has('TimeCondition'));
  console.log('has ProgressCondition:', schemas.has('ProgressCondition'));
  console.log('has Pattern:', schemas.has('Pattern'));
  console.log('has RandomListSelector:', schemas.has('RandomListSelector'));
  console.log(
    'TimeCondition inferredKwargs:',
    schemas.get('TimeCondition')?.inferredKwargs.join(',')
  );

  if (!schemas.has('TimeCondition') || conditions.length < 10) {
    process.exitCode = 1;
  }

  // Full walk inheritance count
  const allFiles = walkRpy(MTS);
  const allRaw2 = [];
  const texts2 = new Map<string, string>();
  for (const full of allFiles) {
    const text = fs.readFileSync(full, 'utf8');
    const uri = vscode.Uri.file(full);
    texts2.set(uri.toString(), text);
    allRaw2.push(...collectRawClasses(uri, text));
  }
  const full = buildSchemaRegistry(allRaw2, texts2);
  console.log(
    'full workspace classes:',
    allRaw2.length,
    'registry:',
    full.schemas.size,
    'conditions:',
    [...full.schemas.values()].filter((s) => s.kind === 'condition').length,
    'selectors:',
    [...full.schemas.values()].filter((s) => s.kind === 'selector').length
  );

  // Fake new subclass discovery
  const fakeText = `
init python:
    class MyNewCondition(Condition):
        def __init__(self, key: str, *options):
            pass
`;
  const fakeUri = vscode.Uri.file(path.join(MTS, '_fake_test.rpy'));
  texts2.set(fakeUri.toString(), fakeText);
  allRaw2.push(...collectRawClasses(fakeUri, fakeText));
  const withFake = buildSchemaRegistry(allRaw2, texts2);
  console.log('MyNewCondition discovered:', withFake.schemas.has('MyNewCondition'));
  if (!withFake.schemas.has('MyNewCondition')) {
    process.exitCode = 1;
  }

  console.log(process.exitCode ? 'VERIFY FAILED' : 'VERIFY OK');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
