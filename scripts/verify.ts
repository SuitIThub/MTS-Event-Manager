import * as fs from 'fs';
import * as path from 'path';
import { parseEventsInDocument } from '../src/parseEvents';
import { parseLabelsInDocument } from '../src/parseLabels';
import { labelAtLine } from '../src/parseImageCalls';
import {
  buildPersonIndex,
  mergeSelectorValues,
  parseDefaultNames,
  parseDialoguePortraitSites,
  parsePersonsInDocument,
  resolveTokenToPersonKeys,
} from '../src/parsePersons';
import { buildSchemaRegistry, collectRawClasses } from '../src/parseSchema';
import { PersonInfo } from '../src/types';
import * as vscode from 'vscode';

const MTS = 'M:\\MTS Project\\Mind the School\\game\\scripts';

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
