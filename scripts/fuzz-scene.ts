import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  logicalStatements,
  menuCallAt,
  planAddMenuChoice,
  planMoveStatement,
  planNewEvent,
  planRemoveMenuChoice,
  scanLabels,
  topLevelSpan,
} from '../src/sceneOps';
import { checkStructure } from '../src/codeStructure';
import { parseLabelsInDocument } from '../src/parseLabels';
import { buildPersonIndex } from '../src/parsePersons';
import { buildEventTimeline } from '../src/eventTimeline';
import { findEventDefs } from '../src/eventDef';
import { parseSeriesLine, planSeriesStepEdit } from '../src/imageSeries';
import { GAME, SCRIPTS, WS_ROOT, requireGame } from './testEnv';

requireGame('fuzz-scene', 'scripts');

function walk(d: string, o: string[] = []): string[] {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, o);
    else if (e.name.endsWith('.rpy')) o.push(p);
  }
  return o;
}
const idx = buildPersonIndex([], []);
let moves = 0, moveOk = 0, moveRefused = 0, menus = 0, newEvents = 0, failures = 0;
const fail = (m: string) => { failures++; if (failures <= 15) console.log('FAIL', m); };

const sceneFiles = walk(GAME);
let fileNo = 0;
for (const f of sceneFiles) {
  const text = fs.readFileSync(f, 'utf8');
  const lines = text.split('\n');
  const name = path.basename(f);
  // Progress, so a CI log never looks finished while this still runs.
  if (++fileNo % 25 === 0 || fileNo === sceneFiles.length) console.log(`  … ${fileNo}/${sceneFiles.length} files, ${moves} moves`);
  // 1) Move every statement of the first few events up and down; up+down must round-trip.
  const tops = scanLabels(lines).filter((l) => !l.isSub).slice(0, 6);
  for (const top of tops) {
    const span = topLevelSpan(lines, top.line)!;
    for (const st of logicalStatements(text, lines, span.start + 1, span.end)) {
      for (const dir of [-1, 1] as const) {
        moves++;
        const r = planMoveStatement(text, st.start, dir);
        if ('error' in r) { moveRefused++; continue; }
        moveOk++;
        const sc = checkStructure(text, r.edits);
        if (sc) fail(`${name}:${st.start + 1} move ${dir} refused by the structure guard: ${sc}`);
        const back = planMoveStatement(r.newText, r.newLine, dir === -1 ? 1 : -1);
        if ('error' in back) { fail(`${name}:${st.start + 1} move ${dir} could not move back: ${back.error}`); continue; }
        if (back.newText !== text) fail(`${name}:${st.start + 1} move ${dir} + back did not round-trip`);
        const moved = r.newText.split('\n')[r.newLine]?.trim();
        if (moved !== lines[st.start].trim()) fail(`${name}:${st.start + 1} newLine points at "${moved}"`);
      }
    }
  }
  // 2) Add a choice to every custom menu; the timeline must see the new branch.
  lines.forEach((row, line) => {
    if (!/call_custom_menu(?:_with_text)?\s*\(/.test(row) || row.trim().startsWith('#') || /def\s/.test(row)) return;
    const menu = menuCallAt(text, line);
    if (!menu) return;
    menus++;
    const r = planAddMenuChoice(text, line, 'fuzz_choice', 'Fuzz choice');
    if ('error' in r) { fail(`${name}:${line + 1} add choice: ${r.error}`); return; }
    const sc = checkStructure(text, r.edits);
    if (sc) fail(`${name}:${line + 1} add choice refused by the structure guard: ${sc}`);
    const labels = parseLabelsInDocument(vscode.Uri.file(f), r.newText);
    const span = topLevelSpan(r.newText.split('\n'), line)!;
    if (!labels.some((l) => l.name === `${span.name}.fuzz_choice`)) fail(`${name}:${line + 1} branch label missing`);
    const tl = buildEventTimeline(r.newText, labels, idx, span.start, () => ({}), { selections: {} });
    // Only menus on the default path are visible to a default walk.
    const origLabels = parseLabelsInDocument(vscode.Uri.file(f), text);
    const onPath = buildEventTimeline(text, origLabels, idx, span.start, () => ({})).markers.some((mk) => mk.kind === 'menu' && mk.line === line);
    const m = tl.markers.find((mk) => mk.kind === 'menu' && mk.line === line);
    if (onPath && (!m || !m.choices?.some((c) => c.target === `${span.name}.fuzz_choice`))) fail(`${name}:${line + 1} timeline does not see the new choice`);
    // select the new choice: its branch must be walked
    const br = tl.branches.find((b) => b.kind === 'menu' && b.line === line);
    if (br) {
      const choiceIdx = br.options.length - 1;
      const tl2 = buildEventTimeline(r.newText, labels, idx, span.start, () => ({}), { selections: { [br.id]: choiceIdx } });
      if (!tl2.stops.some((s) => s.speaker === 'subtitles' && s.text === '')) fail(`${name}:${line + 1} new branch stop not reachable`);
    }
    // duplicate key refused; removal of the added choice restores the menu
    const dup = planAddMenuChoice(r.newText, line, 'fuzz_choice', 'x');
    if (!('error' in dup)) fail(`${name}:${line + 1} duplicate key accepted`);
    const count = (menuCallAt(r.newText, line)?.args.filter((a) => a.call?.name === 'MenuElement').length ?? 0);
    const rem = planRemoveMenuChoice(r.newText, line, count - 1, 'fuzz_choice');
    if ('error' in rem) fail(`${name}:${line + 1} remove choice: ${rem.error}`);
    else if (checkStructure(r.newText, rem.edits)) fail(`${name}:${line + 1} remove choice refused by the structure guard: ${checkStructure(r.newText, rem.edits)}`);
  });
  // 3) New event in every file that already defines events.
  if (findEventDefs(text).length) {
    newEvents++;
    const r = planNewEvent(text, { label: 'fuzz_new_event', priority: 3, pool: 'cafeteria_events["order_food"]', patternPath: 'images/events/fuzz/fuzz <step>.webp', items: ['TimeCondition(daytime = "d")'] });
    if ('error' in r) { fail(`${name} new event: ${r.error}`); continue; }
    const scn = 'edits' in r ? checkStructure(text, (r as { edits: Parameters<typeof checkStructure>[1] }).edits) : undefined;
    if (scn) fail(`${name} new event refused by the structure guard: ${scn}`);
    const labels = parseLabelsInDocument(vscode.Uri.file(f), r.newText);
    const lab = labels.find((l) => l.name === 'fuzz_new_event');
    if (!lab) { fail(`${name} new label missing`); continue; }
    const tl = buildEventTimeline(r.newText, labels, idx, lab.range.start.line, () => ({}));
    if (tl.stops.length !== 1 || tl.eventLabel !== 'fuzz_new_event') fail(`${name} new event timeline: ${tl.stops.length} stops, label ${tl.eventLabel}`);
    const again = planNewEvent(r.newText, { label: 'fuzz_new_event', priority: 3, pool: 'x', patternPath: '', items: [] });
    if (!('error' in again)) fail(`${name} duplicate new event accepted`);
  }
}
// 4) show_image single-step edits: every step of every call in the game — change and
// change back (byte-identical), remove (one step fewer, rest intact), pause toggles on
// the last step (round trip).
let seriesOps = 0;
for (const f of walk(GAME)) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  for (const [ln, row] of lines.entries()) {
    const s = parseSeriesLine(row);
    if (!s) continue;
    const steps = s.steps.map((a) => a.value.trim());
    if (!steps.every((v) => /^[0-9]+$/.test(v))) continue;
    steps.forEach((v, i) => {
      const where = `${path.basename(f)}:${ln + 1} step ${i}`;
      const up = planSeriesStepEdit(row, i, { step: Number(v) + 7 });
      if ('error' in up) { fail(`${where} change: ${up.error}`); return; }
      const back = planSeriesStepEdit(up.text, i, { step: Number(v) });
      if ('error' in back || back.text !== row) { fail(`${where} change round trip`); return; }
      if (steps.length > 1) {
        const rm = planSeriesStepEdit(row, i, { remove: true });
        const after = 'error' in rm ? undefined : parseSeriesLine(rm.text);
        const want = steps.filter((_, j) => j !== i).join(',');
        if (!after || after.steps.map((a) => a.value.trim()).join(',') !== want) { fail(`${where} remove: ${'error' in rm ? rm.error : rm.text}`); return; }
      }
      if (i === steps.length - 1) {
        const tg = planSeriesStepEdit(row, i, { pause: !s.pause });
        const tb = 'error' in tg ? tg : planSeriesStepEdit(tg.text, i, { pause: s.pause });
        // An explicit pause argument round-trips byte for byte; a missing one comes back as
        // an explicit pause = False (same meaning, nothing else touched).
        const hadArg = s.call.args.some((x) => x.name === 'pause');
        const back2 = 'error' in tb ? undefined : parseSeriesLine(tb.text);
        const same = hadArg
          ? !('error' in tb) && tb.text === row
          : !!back2 && back2.pause === s.pause && back2.steps.map((x) => x.value.trim()).join(',') === steps.join(',') &&
            !('error' in tb) && tb.text.replace(/,\s*pause\s*=\s*False/, '') === row;
        if (!same) { fail(`${where} pause round trip: ${'error' in tb ? tb.error : tb.text}`); return; }
      }
      seriesOps++;
    });
  }
}
console.log(`show_image step edits: ${seriesOps} steps verified`);
console.log(`moves: ${moves} (ok ${moveOk}, refused ${moveRefused}), menus: ${menus}, new events: ${newEvents}, failures: ${failures}`);
process.exitCode = failures ? 1 : 0;
