/**
 * Offline checks for image call parsing + pattern glob resolution against MTS.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseEventsInDocument } from '../src/parseEvents';
import { parseLabelsInDocument } from '../src/parseLabels';
import { parseImageCallsInDocument, labelNameForImageCall } from '../src/parseImageCalls';
import { paramConstraintsForLine, parseConditionExpr } from '../src/paramConstraints';
import { templateToRegex } from '../src/patternResolve';
import * as vscode from 'vscode';

const MTS = 'M:\\MTS Project\\Mind the School\\game\\scripts';
const GAME = 'M:\\MTS Project\\Mind the School\\game';

function read(rel: string) {
  const full = path.join(MTS, rel);
  const text = fs.readFileSync(full, 'utf8');
  return { uri: vscode.Uri.file(full), text };
}

function listWebp(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) {
    return acc;
  }
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      listWebp(full, acc);
    } else if (ent.name.endsWith('.webp')) {
      acc.push(full);
    }
  }
  return acc;
}

function main() {
  const yoga = read('events/new_yoga_outfits.rpy');
  const events = parseEventsInDocument(yoga.uri, yoga.text);
  const labels = parseLabelsInDocument(yoga.uri, yoga.text);
  const e2 = events.find((e) => e.labelName === 'new_yoga_outfit_2');
  console.log('yoga event patterns:', e2?.patterns);
  if (!e2?.patterns.some((p) => p.patternKey === 'main' && p.pathTemplate.includes('<step>'))) {
    console.error('missing Pattern on new_yoga_outfit_2');
    process.exitCode = 1;
  }

  const sites = parseImageCallsInDocument(yoga.text, labels);
  const show0 = sites.find((s) => s.kind === 'show' && s.steps[0] === 0 && s.variableName === 'image');
  console.log('first image.show(0):', show0);
  if (!show0?.patternKey) {
    console.error('show(0) missing patternKey');
    process.exitCode = 1;
  }

  const showImage = sites.find((s) => s.kind === 'show_image');
  console.log('show_image site:', showImage);

  const pat = e2!.patterns.find((p) => p.patternKey === 'main')!;
  const re = templateToRegex(pat.pathTemplate, { step: '0' });
  console.log('regex:', re);
  const dir = path.join(
    GAME,
    'images/events/new_yoga_outfits/new_yoga_outfit_2'
  );
  const files = listWebp(dir);
  const matched = files.filter((f) => re.test(path.relative(GAME, f).replace(/\\/g, '/')));
  console.log('matched step 0 variants:', matched.length, matched.slice(0, 5).map((f) => path.basename(f)));
  if (matched.length < 1) {
    console.error('expected filesystem matches for yoga step 0');
    process.exitCode = 1;
  }

  const lab = read('events/lab_intro.rpy');
  const labLabels = parseLabelsInDocument(lab.uri, lab.text);
  const labSites = parseImageCallsInDocument(lab.text, labLabels);
  const bgPath = labSites.find((s) => s.kind === 'set_background_path');
  const bgIdx = labSites.find((s) => s.kind === 'set_background');
  const showPat = labSites.find((s) => s.kind === 'show_pattern');
  console.log('lab set_background path:', !!bgPath, 'index:', !!bgIdx, 'show_pattern:', !!showPat);
  console.log(
    'label for show0:',
    show0 && labelNameForImageCall(labels, show0)
  );

  // webp-in-pattern / png-on-disk + parent binding used in sublabel
  const nm = read('events/new_management.rpy');
  const nmEvents = parseEventsInDocument(nm.uri, nm.text);
  const nmLabels = parseLabelsInDocument(nm.uri, nm.text);
  const janitor = nmEvents.find((e) => e.labelName === 'nm_ghost_office_janitor');
  const janPat = janitor?.patterns.find((p) => p.patternKey === 'main');
  if (!janPat) {
    console.error('missing Pattern on nm_ghost_office_janitor');
    process.exitCode = 1;
  } else {
    const janRe = templateToRegex(janPat.pathTemplate, { step: '0' });
    const janDir = path.join(GAME, 'images/events/new_management/nm_ghost_office_janitor');
    const janFiles = fs.existsSync(janDir)
      ? fs.readdirSync(janDir).map((n) => path.join(janDir, n))
      : [];
    const janMatched = janFiles.filter((f) =>
      janRe.test(path.relative(GAME, f).replace(/\\/g, '/'))
    );
    console.log('janitor step0 matches:', janMatched.map((f) => path.basename(f)));
    if (janMatched.length < 1) {
      console.error('expected png match for janitor webp pattern');
      process.exitCode = 1;
    }
  }

  const nmSites = parseImageCallsInDocument(nm.text, nmLabels);
  const subBg = nmSites.find(
    (s) =>
      s.kind === 'set_background' &&
      s.variableName === 'image' &&
      labelNameForImageCall(nmLabels, s)?.startsWith('nm_ghost_office_janitor.')
  );
  console.log('janitor sublabel set_background:', subBg);
  if (!subBg?.patternKey) {
    console.error('sublabel set_background missing patternKey from parent convert_pattern');
    process.exitCode = 1;
  }

  // if/elif topic constraints for sd_event_2
  const dorm = read('buildings/school_dormitory.rpy');
  const dormLabels = parseLabelsInDocument(dorm.uri, dorm.text);
  const dormSites = parseImageCallsInDocument(dorm.text, dormLabels);
  const ahShow = dormSites.find(
    (s) =>
      s.kind === 'show' &&
      s.steps[0] === 0 &&
      labelNameForImageCall(dormLabels, s) === 'sd_event_2' &&
      s.range.start.line >= 186 &&
      s.range.start.line <= 190
  );
  const pantiesShow = dormSites.find(
    (s) =>
      s.kind === 'show' &&
      labelNameForImageCall(dormLabels, s) === 'sd_event_2' &&
      s.range.start.line >= 202 &&
      s.range.start.line <= 205
  );
  const ahC = ahShow
    ? paramConstraintsForLine(dorm.text, dormLabels, ahShow.range.start.line)
    : {};
  const panC = pantiesShow
    ? paramConstraintsForLine(dorm.text, dormLabels, pantiesShow.range.start.line)
    : {};
  console.log('sd_event_2 ah constraints:', ahC);
  console.log('sd_event_2 panties/breasts constraints:', panC);
  if (ahC.topic?.join(',') !== 'ah') {
    console.error('expected topic=[ah] for first branch show');
    process.exitCode = 1;
  }
  if (
    !panC.topic ||
    !panC.topic.includes('panties') ||
    !panC.topic.includes('breasts')
  ) {
    console.error('expected topic in [panties, breasts] for in-list branch');
    process.exitCode = 1;
  }
  const parsedIn = parseConditionExpr('topic in ["panties", "breasts"]');
  console.log('parseConditionExpr in-list:', parsedIn);

  console.log(process.exitCode ? 'IMAGE VERIFY FAILED' : 'IMAGE VERIFY OK');
}

main();
