import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseEventsInDocument } from '../src/parseEvents';
import { parseLabelsInDocument } from '../src/parseLabels';
import { resolveImagesForCall, getImageRoots } from '../src/patternResolve';
import { paramConstraintsForLine } from '../src/paramConstraints';
import { buildPersonIndex } from '../src/parsePersons';
import { buildEventTimeline } from '../src/eventTimeline';
import { applyEdits } from '../src/pyCall';
import {
  findUnderRoots,
  movieNameFor,
  planAddMovieDefs,
  planSetMovieLoop,
  scanMovieDefs,
  siblingVideoPath,
  videoPrefixFor,
} from '../src/videoResolve';
import { ImageCallSite } from '../src/types';

/**
 * Video support against the real game (MTS_WS_ROOT = game root):
 * - sd_event_5 timeline: show_video is the current scene, pause=True / positional True are stops.
 * - step → pattern file → anim_<name> → Movie(play=…) → the .webm exists.
 * - Movie edits: add (style of the file, grouped placement) and loop toggles round-trip
 *   byte-for-byte over every Movie declaration in the game.
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

async function main() {
  process.env.MTS_WS_ROOT ??= 'M:/MTS Project/Mind the School';
  const roots = await getImageRoots();
  const f = path.join(GAME, 'buildings/school_dormitory.rpy');
  const text = fs.readFileSync(f, 'utf8');
  const uri = vscode.Uri.file(f);
  const labels = parseLabelsInDocument(uri, text);
  const lab = labels.find((l) => l.name === 'sd_event_5')!;
  const patterns = parseEventsInDocument(uri, text).find((e) => e.labelName === 'sd_event_5')!.patterns;

  // Timeline: pick "Stay watching" and school_level 8.
  const first = buildEventTimeline(text, labels, buildPersonIndex([], []), lab.range.start.line, () => ({}));
  const menu = first.branches.find((b) => b.kind === 'menu')!;
  const tl = buildEventTimeline(text, labels, buildPersonIndex([], []), lab.range.start.line, () => ({}), {
    selections: { [menu.id]: 1 },
    values: { school_level: '8' },
  });
  const videoStops = tl.stops.filter((s) => s.kind === 'video');
  check(videoStops.map((s) => s.image?.steps[0]).join(',') === '6,7,8,9,10', `pause=True videos are stops: ${videoStops.map((s) => s.text).join(', ')}`);
  const v5Marker = tl.markers.find((m) => m.image?.kind === 'show_video' && m.image.steps[0] === 5);
  check(!!v5Marker, 'show_video(5) without pause is a marker');
  const afterV5 = tl.stops.find((s) => s.kind === 'dialog' && s.image?.kind === 'show_video' && s.image.steps[0] === 5);
  check(!!afterV5 && afterV5.text.includes("you're so big"), `the next line plays video 5: ${afterV5?.text}`);
  const pause11 = tl.stops.find((s) => s.kind === 'pause' && s.image?.steps[0] === 11);
  check(!!pause11 && pause11.image?.kind === 'show_video', 'renpy.pause after show_video(11) shows video 11');
  check(videoStops.every((s) => s.image?.patternKey === 'main' && s.image.variableName === 'image'), 'video refs carry pattern key + variable');

  // Resolution chain for step 5 and 11 (loop / once).
  const defs = scanMovieDefs(text);
  check(defs.length >= 30, `${defs.length} Movie declarations parsed in school_dormitory`);
  for (const [step, loop] of [[5, true], [11, false]] as const) {
    const s = tl.stops.find((x) => x.image?.kind === 'show_video' && x.image.steps[0] === step)!;
    const constraints = paramConstraintsForLine(text, labels, s.image!.line);
    constraints.school_level = ['8'];
    const site: ImageCallSite = {
      kind: 'show', range: new vscode.Range(s.image!.line, 0, s.image!.line, 1), variableName: 'image',
      patternKey: 'main', steps: [step], paramConstraints: constraints,
    };
    const info = (await resolveImagesForCall(site, patterns, { maxResults: 1 }))[0];
    const prefix = videoPrefixFor(text.split('\n'), 'image', lab.range.start.line, s.image!.line);
    const name = info ? movieNameFor(info.relativePath, prefix) : '(none)';
    const def = defs.find((d) => d.name === name);
    check(name === `anim_sd_event_5_8_${step}`, `step ${step} → ${name}`);
    check(!!def && def.play === `images/events/school dormitory/sd_event_5/sd_event_5 8 ${step}.webm` && def.loop === loop, `Movie play=${def?.play} loop=${def?.loop}`);
    check(!!def?.play && !!findUnderRoots(def.play, roots), 'the .webm exists');
  }

  // Levels: `if school_level >= 8 / elif >= 7 / … / else` are first-match ranges; the level
  // picks the branch, and every image + video of the path uses that one level.
  const ifChain = tl.branches.find((b) => b.kind === 'if')!;
  check(
    JSON.stringify(ifChain.bindings?.map((b) => b.school_level?.join(','))) === '["8,9,10","7","5,6","3,4","0,1,2"]',
    `exclusive level ranges: ${JSON.stringify(ifChain.bindings?.map((b) => b.school_level))}`
  );
  const allFiles = await resolveImagesForCall(
    { kind: 'show', range: new vscode.Range(0, 0, 0, 1), patternKey: 'main', steps: [], paramConstraints: {} },
    patterns,
    { maxResults: 5000 }
  );
  const levels = [...new Set(allFiles.map((i) => i.params.school_level).filter((v) => v !== '$'))].sort((a, b) => Number(a) - Number(b));
  check(levels.join(',') === '1,2,3,4,5,6,7,8,9,10', `levels with images: ${levels.join(',')}`);
  for (const [level, branch] of [['10', 0], ['7', 1], ['6', 2], ['2', 4]] as const) {
    const lt = buildEventTimeline(text, labels, buildPersonIndex([], []), lab.range.start.line, () => ({}), {
      selections: { [menu.id]: 1 },
      values: { school_level: level },
    });
    const chain = lt.branches.find((b) => b.kind === 'if')!;
    const used = new Set<string>();
    let missing = 0;
    for (const s of lt.stops.filter((x) => x.image)) {
      const c = paramConstraintsForLine(text, labels, s.image!.line);
      for (const [k, v] of Object.entries(lt.values)) {
        c[k] = [v];
      }
      const info = (await resolveImagesForCall(
        { kind: 'show', range: new vscode.Range(s.image!.line, 0, s.image!.line, 1), patternKey: 'main', steps: s.image!.steps, paramConstraints: c },
        patterns,
        { maxResults: 1 }
      ))[0];
      if (info) {
        used.add(info.params.school_level);
      } else {
        missing++;
      }
    }
    check(chain.selected === branch && chain.via === 'value', `school_level ${level} picks "${chain.options[chain.selected]}"`);
    check(used.size === 1 && used.has(level) && missing === 0, `school_level ${level}: all images of the path use level ${[...used].join('/')} (${missing} missing)`);
  }

  // Positional pause (office) + video_prefix kwarg (gym).
  const office = fs.readFileSync(path.join(GAME, 'buildings/office_building.rpy'), 'utf8');
  const oLabels = parseLabelsInDocument(vscode.Uri.file('office.rpy'), office);
  const oLine = office.split('\n').findIndex((l) => l.includes('show_video(16, True)'));
  const oTop = oLabels.filter((l) => !l.isSub && l.range.start.line <= oLine).pop()!;
  const oTl = buildEventTimeline(office, oLabels, buildPersonIndex([], []), oLine, () => ({}));
  check(oTl.stops.some((s) => s.kind === 'video' && s.line === oLine), `show_video(16, True) is a stop (${oTop.name})`);
  const oDefs = scanMovieDefs(office);
  check(oDefs.some((d) => d.name === 'anim_office_event_first_naughty_0_16' && d.play?.endsWith('office_event_first_naughty 0 16.webm')), 'office Movie resolved through anim_oefn_path');
  const gym = fs.readFileSync(path.join(GAME, 'buildings/gym.rpy'), 'utf8');
  const gLines = gym.split('\n');
  const gVideo = gLines.findIndex((l) => l.includes('show_video('));
  check(videoPrefixFor(gLines, 'image', 0, gVideo) === 'anim_', 'video_prefix read from convert_pattern(…, video_prefix = "anim_")');
  check(movieNameFor('images/x/office_event_first_naughty 0 16.webp') === 'anim_office_event_first_naughty_0_16', 'name derivation matches the engine');

  // Add: remove one declaration, plan it back.
  const rows = text.split('\n');
  const d85 = defs.find((d) => d.name === 'anim_sd_event_5_8_5')!;
  const without = [...rows.slice(0, d85.line), ...rows.slice(d85.line + 1)].join('\n');
  const plan = planAddMovieDefs(without, [{ name: d85.name, imageRel: 'images/events/school dormitory/sd_event_5/sd_event_5 8 5.webp', loop: true }], lab.range.start.line - 1);
  if ('error' in plan) {
    check(false, `add plan: ${plan.error}`);
  } else {
    const added = plan.text.split('\n').find((l) => l.startsWith('image anim_sd_event_5_8_5'))!;
    const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
    check(squash(added) === squash(rows[d85.line]), `re-added in the file's style: ${added.trim()}`);
    const at = plan.text.split('\n').indexOf(added);
    const lastGroup = Math.max(...scanMovieDefs(without).filter((d) => d.play?.includes('/sd_event_5/')).map((d) => d.line));
    check(at === lastGroup + 1, `placed after the event's Movie block (line ${at + 1})`);
    check('error' in planAddMovieDefs(text, [{ name: d85.name, imageRel: 'x.webp', loop: true }], 0), 'existing definition is refused');
  }
  // Add into a file without Movie lines: goes above the label, literal paths.
  const bare = 'label ev_a (**kwargs):\n    $ begin_event(**kwargs)\n\nlabel ev_b (**kwargs):\n    $ begin_event(**kwargs)\n';
  const bPlan = planAddMovieDefs(bare, [{ name: 'anim_ev_b_1_2', imageRel: 'images/events/ev_b/ev_b 1 2.webp', loop: false }], 3);
  check(!('error' in bPlan) && bPlan.text.includes('\nimage anim_ev_b_1_2 = Movie(play = "images/events/ev_b/ev_b 1 2.webm", start_image = "images/events/ev_b/ev_b 1 2.webp")\nlabel ev_b'), 'new block above the label with literal paths');

  // Loop toggles round-trip on every Movie declaration of the game.
  let toggles = 0;
  let failures = 0;
  for (const rel of ['buildings/school_dormitory.rpy', 'buildings/gym.rpy', 'buildings/office_building.rpy']) {
    const src = fs.readFileSync(path.join(GAME, rel), 'utf8');
    for (const d of scanMovieDefs(src)) {
      const on = planSetMovieLoop(src, d.name, !d.loop);
      if ('error' in on) {
        failures++;
        console.log('FAIL toggle', rel, d.name, on.error);
        continue;
      }
      const back = planSetMovieLoop(on.text, d.name, d.loop);
      if ('error' in back || back.text !== src) {
        failures++;
        console.log('FAIL round trip', rel, d.name, 'error' in back ? back.error : '(text differs)');
      }
      // Removing + re-adding each declaration verifies too.
      const r = src.split('\n');
      const cut = [...r.slice(0, d.line), ...r.slice(d.line + 1)].join('\n');
      if (d.play && d.startImage && d.play === siblingVideoPath(d.startImage)) {
        const re = planAddMovieDefs(cut, [{ name: d.name, imageRel: d.startImage, loop: d.loop }], 0);
        if ('error' in re) {
          failures++;
          console.log('FAIL re-add', rel, d.name, re.error);
        }
      }
      toggles++;
    }
  }
  check(failures === 0, `${toggles} Movie declarations: loop toggles + re-adds verified, ${failures} failures`);
  check(applyEdits('abc', []) === 'abc', 'sanity');

  console.log(`video problems: ${problems}`);
  process.exitCode = problems ? 1 : 0;
}
void main();
