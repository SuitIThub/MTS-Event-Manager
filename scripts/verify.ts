import * as fs from 'fs';
import * as path from 'path';
import { parseEventsInDocument } from '../src/parseEvents';
import { parseLabelsInDocument } from '../src/parseLabels';
import { buildSchemaRegistry, collectRawClasses } from '../src/parseSchema';
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
