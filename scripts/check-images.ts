import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseEventsInDocument } from '../src/parseEvents';
import { parseLabelsInDocument } from '../src/parseLabels';
import { resolveImagesForCall } from '../src/patternResolve';
import { paramConstraintsForLine } from '../src/paramConstraints';
import { buildPersonIndex } from '../src/parsePersons';
import { buildEventTimeline } from '../src/eventTimeline';
import { ImageCallSite } from '../src/types';
import { GAME, SCRIPTS, WS_ROOT, requireGame } from './testEnv';

requireGame('check-images', 'full');

/**
 * Images follow the previewed branch: the same `image.show(0)` resolves to a different
 * file for topic = ah and topic = panties (real files from the game). Run with
 * MTS_WS_ROOT pointing at the game root.
 */
async function main() {
  const f = `${SCRIPTS}/buildings/school_dormitory.rpy`;
  const text = fs.readFileSync(f, 'utf8');
  const uri = vscode.Uri.file(f);
  const labels = parseLabelsInDocument(uri, text);
  const patterns = parseEventsInDocument(uri, text).find((e) => e.labelName === 'sd_event_2')!.patterns;
  const lab = labels.find((l) => l.name === 'sd_event_2')!;
  let problems = 0;
  const files: Record<string, string> = {};
  for (const topic of ['ah', 'panties']) {
    const tl = buildEventTimeline(text, labels, buildPersonIndex([], []), lab.range.start.line, () => ({}), { values: { topic } });
    const stop = tl.stops.find((s) => s.image && s.image.kind === 'show')!;
    // Same constraint building as the preview: branch conditions, overridden by path values.
    const constraints = paramConstraintsForLine(text, labels, stop.image!.line);
    for (const [k, v] of Object.entries(tl.values)) constraints[k] = [v];
    const site: ImageCallSite = {
      kind: 'show', range: new vscode.Range(stop.image!.line, 0, stop.image!.line, 1), variableName: stop.image!.variableName,
      patternKey: stop.image!.patternKey, steps: stop.image!.steps, paramConstraints: constraints,
    };
    const infos = await resolveImagesForCall(site, patterns, { maxResults: 1 });
    files[topic] = infos[0] ? path.basename(infos[0].fsPath) : '(none)';
    console.log(`topic=${topic}: line ${stop.line + 1} "${stop.text.slice(0, 30)}" -> ${files[topic]}`);
    if (!files[topic].includes(` ${topic} `)) { problems++; console.log('FAIL image does not match the topic'); }
  }
  if (files.ah === files.panties) { problems++; console.log('FAIL both topics resolved to the same image'); }
  console.log(`image problems: ${problems}`);
  process.exitCode = problems ? 1 : 0;
}
void main();
