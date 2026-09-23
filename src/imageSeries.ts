import { applyEdits, decodeValue, insertArgEdit, parsePyCall, PyArg, PyCall, removeArgEdit, replaceValueEdit, TextEdit } from './pyCall';

/**
 * Surgical edits of ONE step inside `call Image_Series.show_image(image, 3, 4, 5, pause = True)`
 * — change its number, remove it, or (for the last step) toggle `pause` — leaving the
 * variable, the other steps, other keywords and a trailing `from _call_…` clause untouched.
 * Every plan is re-parsed and verified before it is returned.
 */

export interface SeriesCall {
  call: PyCall;
  /** Step arguments (positionals after the image variable). */
  steps: PyArg[];
  variable: PyArg;
  pause: boolean;
}

const SERIES_RE = /\bImage_Series\s*\.\s*show_image\s*\(/;

export function parseSeriesLine(lineText: string): SeriesCall | undefined {
  const m = SERIES_RE.exec(lineText);
  if (!m) {
    return undefined;
  }
  const call = parsePyCall(lineText, m.index);
  if (!call) {
    return undefined;
  }
  const pos = call.args.filter((a) => !a.name && !a.star);
  if (pos.length < 2) {
    return undefined;
  }
  const pauseArg = call.args.find((a) => a.name === 'pause');
  return { call, variable: pos[0], steps: pos.slice(1), pause: pauseArg?.value.trim() === 'True' };
}

export type SeriesChange = { step?: number; pause?: boolean; remove?: boolean };

export function planSeriesStepEdit(
  lineText: string,
  stepIndex: number,
  change: SeriesChange
): { text: string; edits: TextEdit[] } | { error: string } {
  const s = parseSeriesLine(lineText);
  if (!s) {
    return { error: 'The line is no longer a call Image_Series.show_image(…) — nothing was changed.' };
  }
  const values = s.steps.map((a) => decodeValue(a.value));
  if (values.some((v) => v.kind !== 'number' || !/^[0-9]+$/.test(v.value))) {
    return { error: 'The steps of this show_image call are not plain numbers — edit it in the code.' };
  }
  if (stepIndex < 0 || stepIndex >= s.steps.length) {
    return { error: 'That step no longer exists in the call — the view was out of date.' };
  }
  const isLast = stepIndex === s.steps.length - 1;
  const edits: TextEdit[] = [];
  const expected = values.map((v) => v.value);
  let expectPause = s.pause;
  if (change.remove) {
    if (s.steps.length <= 1) {
      return { error: 'A show_image call needs at least one step — remove the whole statement instead.' };
    }
    edits.push(removeArgEdit(lineText, s.call, s.call.args.indexOf(s.steps[stepIndex])));
    expected.splice(stepIndex, 1);
  } else {
    if (change.step !== undefined && String(change.step) !== expected[stepIndex]) {
      if (!Number.isInteger(change.step) || change.step < 0) {
        return { error: 'A step is a whole number ≥ 0.' };
      }
      edits.push(replaceValueEdit(s.steps[stepIndex], String(change.step)));
      expected[stepIndex] = String(change.step);
    }
    // pause = True belongs to the call but only concerns its last step.
    if (change.pause !== undefined && isLast && change.pause !== s.pause) {
      // An existing pause argument keeps its place (only its value flips); a new one is
      // added only to switch it on — the smallest change either way.
      const idx = s.call.args.findIndex((a) => a.name === 'pause');
      if (idx >= 0) {
        edits.push(replaceValueEdit(s.call.args[idx], change.pause ? 'True' : 'False'));
      } else if (change.pause) {
        edits.push(insertArgEdit(lineText, s.call, 'pause = True', { keyword: true }));
      }
      expectPause = change.pause;
    }
  }
  if (!edits.length) {
    return { text: lineText, edits: [] };
  }
  let text: string;
  try {
    text = applyEdits(lineText, edits);
  } catch {
    return { error: 'The planned edits overlap — nothing was changed.' };
  }
  // Verify: same variable, exactly the expected steps, pause as intended, other keywords
  // and everything outside the call unchanged.
  const after = parseSeriesLine(text);
  const kw = (c: PyCall) => c.args.filter((a) => a.name && a.name !== 'pause').map((a) => `${a.name}=${a.value}`).join('|');
  if (
    !after ||
    after.variable.value !== s.variable.value ||
    after.steps.map((a) => decodeValue(a.value).value).join(',') !== expected.join(',') ||
    after.pause !== expectPause ||
    kw(after.call) !== kw(s.call) ||
    text.slice(0, after.call.start) !== lineText.slice(0, s.call.start) ||
    text.slice(after.call.close) !== lineText.slice(s.call.close)
  ) {
    return { error: 'Verification failed — the show_image call would change otherwise. Nothing was written.' };
  }
  return { text, edits };
}
