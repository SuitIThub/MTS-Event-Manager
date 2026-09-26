// Webview script (preview.js). Plain browser JavaScript, bundled by scripts/build-webview.js.
const vscode = acquireVsCodeApi();
const imgCache = new Map();
let state = null;
let current = 0;
let openMenuLine = null;
/** Stats / end_event editor open in #editor: { kind, line }. */
let openStmtEditor = null;
const STAT_NAMES = ['corruption', 'inhibition', 'happiness', 'education', 'charm', 'reputation', 'morale'];
const MODIFIERS = ['TINY', 'SMALL', 'MEDIUM', 'LARGE', 'GIANT', 'DEC_TINY', 'DEC_SMALL', 'DEC_MEDIUM', 'DEC_LARGE', 'DEC_GIANT'];
const END_TYPES = [['new_daytime', 'next daytime (default)'], ['new_day', 'next day'], ['map_entry', 'back to the map entry'], ['map_overview', 'map overview'], ['none', 'nothing']];
function modText(v) { return /^DEC_/.test(v) ? '−' + v.slice(4) : /^[A-Z]+$/.test(v) ? '+' + v : v; }
let checkState = null;
let checkTab = 'issues';
const covOpen = {};
let imgState = null;
let altIndex = 0;

/** The stop as shown: for random_say, with the current alternative's image. */
function withAlt(stop) {
  if (!stop || !stop.alternatives || !stop.alternatives.length) return stop;
  const a = stop.alternatives[altIndex % stop.alternatives.length];
  return a.cg ? Object.assign({}, stop, { cg: a.cg, cgVariants: undefined }) : stop;
}

function renderValues(msg) {
  const bar = document.getElementById('values');
  bar.innerHTML = '';
  const opts = msg.valueOptions || {};
  const keys = Object.keys(opts).sort();
  bar.style.display = keys.length ? '' : 'none';
  for (const k of keys) {
    const lab = document.createElement('label'); lab.textContent = k;
    const sel = document.createElement('select');
    const eff = (msg.values || {})[k];
    const auto = document.createElement('option'); auto.value = ''; auto.textContent = eff ? '(auto: ' + eff + ')' : '(any)'; sel.appendChild(auto);
    for (const v of opts[k]) { const o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); }
    const chosen = (msg.explicitValues || {})[k] || '';
    sel.value = chosen; if (chosen) sel.className = 'set';
    sel.title = 'Preview with this ' + k + ' — picks the matching branches and images';
    sel.addEventListener('change', () => vscode.postMessage({ type:'setValue', key: k, value: sel.value }));
    lab.appendChild(sel); bar.appendChild(lab);
  }
}

function renderAltCaption(stop) {
  const cap = document.getElementById('caption');
  cap.innerHTML = '';
  const alts = stop.alternatives;
  const a = alts[altIndex % alts.length];
  if (!a.who || a.who === stop.speaker) {
    for (const p of stop.portraits || []) { const im = document.createElement('img'); im.className='pic'; im.src=p; cap.appendChild(im); }
  }
  const who = document.createElement('span'); who.className='who';
  who.textContent = a.who && a.who !== stop.speaker ? a.who : (stop.names && stop.names.length ? stop.names.join(' · ') : (stop.speaker || 'Narration'));
  cap.appendChild(who);
  const nav = document.createElement('span'); nav.className = 'altnav';
  const step = (d) => { finishAnim(); altIndex = (altIndex + d + alts.length) % alts.length; renderStage(withAlt(stop)); renderAltCaption(stop); };
  const prev = document.createElement('button'); prev.className = 'alt'; prev.textContent = '◀'; prev.title = 'Previous alternative'; prev.addEventListener('click', () => step(-1));
  const count = document.createElement('span'); count.className = 'tag'; count.textContent = 'random ' + ((altIndex % alts.length) + 1) + '/' + alts.length; count.title = 'random_say picks one of these lines';
  const next = document.createElement('button'); next.className = 'alt'; next.textContent = '▶'; next.title = 'Next alternative'; next.addEventListener('click', () => step(1));
  nav.appendChild(prev); nav.appendChild(count); nav.appendChild(next); cap.appendChild(nav);
  if (a.condition) { const c = document.createElement('span'); c.className = 'tag'; c.textContent = 'if ' + a.condition; cap.appendChild(c); }
  const txt = document.createElement('span'); txt.className='txt'; txt.textContent = a.text; cap.appendChild(txt);
  if (a.argIndex != null) {
    // Edit this alternative's text in random_say(…) (raw text, [placeholders] kept).
    const edit = () => beginAltEdit(stop, a, txt);
    txt.title = 'Double-click to edit this alternative'; txt.style.cursor = 'text';
    txt.addEventListener('dblclick', edit);
    const pen = document.createElement('button'); pen.className = 'alt'; pen.textContent = '✏'; pen.title = 'Edit this alternative (Enter saves, Esc cancels)';
    pen.style.flex = '0 0 auto'; pen.style.marginLeft = 'auto';
    pen.addEventListener('click', edit);
    cap.appendChild(pen);
  }
}

function beginAltEdit(stop, a, span) {
  const raw = a.rawText != null ? a.rawText : a.text;
  const input = document.createElement('input'); input.type = 'text'; input.value = raw; input.placeholder = 'Alternative text…';
  input.style.flex = '1'; input.style.minWidth = '0';
  input.style.background = 'var(--vscode-input-background)'; input.style.color = 'var(--vscode-input-foreground)';
  input.style.border = '1px solid var(--vscode-focusBorder)';
  span.replaceWith(input); input.focus(); input.select();
  let done = false;
  const commit = () => { if (done) return; done = true; vscode.postMessage({ type: 'editAltText', line: stop.line, src: stop.src, argIndex: a.argIndex, text: input.value }); };
  const cancel = () => { if (done) return; done = true; renderAltCaption(stop); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { e.preventDefault(); cancel(); } });
  input.addEventListener('blur', () => { if (input.value !== raw) commit(); else cancel(); });
}

// View state survives the page reload VS Code does when the panel moves to another window.
let currentModule = null;
let restoreView = (typeof vscode.getState === 'function' && vscode.getState()) || null;
function saveView() {
  if (typeof vscode.setState !== 'function' || !state) return;
  vscode.setState({ session: state.session, eventLabel: state.eventLabel, current, module: currentModule === 'check' || currentModule === 'sim' || currentModule === 'def' ? currentModule : null });
}

function showModule(mod) {
  currentModule = mod;
  saveView();
  document.getElementById('checkhost').style.display = mod === 'check' ? '' : 'none';
  document.getElementById('simhost').style.display = mod === 'sim' ? '' : 'none';
  document.getElementById('pdhost').style.display = mod === 'pd' ? '' : 'none';
  document.getElementById('imghost').style.display = mod === 'img' ? '' : 'none';
  document.getElementById('bghost').style.display = mod === 'bg' ? '' : 'none';
  document.getElementById('defhost').style.display = mod === 'def' ? '' : 'none';
  document.getElementById('editor').style.display = mod ? 'none' : '';
}

function img(url) {
  if (!url) return Promise.resolve(null);
  const hit = imgCache.get(url);
  if (hit) return hit;
  const p = new Promise((res) => { const el = new Image(); el.onload = () => res(el); el.onerror = () => res(null); el.src = url; });
  imgCache.set(url, p);
  return p;
}

function place(config) {
  const w = 600 * config.zoom, h = 1080 * config.zoom;
  const anchor = Math.min(1, Math.max(0, config.alignX));
  const left = config.alignX * 1920 - anchor * w;
  return { left: (left / 1920) * 100, top: config.alignY * 100, width: (w / 1920) * 100, height: (h / 1080) * 100 };
}

// ── Stage: a live scene (background, scene image, paperdolls) ─────────────
// Paperdolls and the paperdoll background are rendered like the engine: position/zoom
// from the config, flip as xzoom, blur in game pixels (scaled to the stage), black-and-white
// as saturation, colour as a tint on the visible pixels. The same scene object is animated
// between stops by the player below.
function tintOf(t) { return t ? { r: t.r, g: t.g, b: t.b, a: t.a } : { r: 0, g: 0, b: 0, a: 0 }; }
function cfgOf(c) { return { alignX: c.alignX, alignY: c.alignY, zoom: c.zoom, flip: c.flip == null ? 1 : c.flip, blur: c.blur || 0, sat: c.bw ? 0 : 1, tint: tintOf(c.tint) }; }
function emptyBg() { return { src: '', src2: '', split: false, blur: 0, bw: false, bw2: false, sep: 8 }; }
function sceneOf(stop) {
  const s = { bg: { src: stop.bg || '', src2: stop.bg2 || '', split: !!stop.bgSplit, blur: Number(stop.bgBlur) || 0, bw: !!stop.bgBw, bw2: !!stop.bgBw2, sep: stop.bgSeparator || 8 }, dolls: [] };
  for (const d of stop.dolls || []) s.dolls.push({ key: d.key, body: d.body, head: d.head, cfg: cfgOf(d.config), sx: 0, sy: 0 });
  return s;
}
let live = null;

// PNG / WEBP of the same image (a new capture next to the converted file): which one to show.
// 'auto' = the newer one (what the extension resolved).
let fmtPref = 'auto';
function pickFormat(src, v) {
  if (!v || fmtPref === 'auto') return src;
  return fmtPref === 'png' ? v.png : v.webp;
}
function fmtHint(v) {
  const eng = v.engine.toUpperCase();
  const newer = v.newer.toUpperCase();
  return 'This image exists as PNG and as WEBP. The game loads the ' + eng + ' (the extension in the pattern)' +
    (v.newer !== v.engine ? '; the ' + newer + ' is newer, probably not converted yet, so the game still shows the older ' + eng + '.' : '.');
}
function fmtBar(v, onChange) {
  const bar = document.createElement('div'); bar.className = 'fmtbar'; bar.title = fmtHint(v);
  const cur = fmtPref === 'auto' ? v.shown : fmtPref;
  for (const f of ['png', 'webp']) {
    const b = document.createElement('button');
    b.className = 'fmtbtn' + (cur === f ? ' on' : '');
    b.textContent = f.toUpperCase() + (v.engine === f ? ' · in game' : '') + (v.newer === f && v.newer !== v.engine ? ' · newer' : '');
    b.title = fmtHint(v);
    b.addEventListener('click', (e) => { e.stopPropagation(); fmtPref = f; onChange(); });
    bar.appendChild(b);
  }
  const info = document.createElement('span'); info.className = 'fmtinfo'; info.textContent = 'ⓘ'; info.title = fmtHint(v);
  bar.appendChild(info);
  return bar;
}

function renderStage(stop, scene) {
  const stage = document.getElementById('stage');
  stage.innerHTML = '';
  live = null;
  if (!stop) return;
  if (stop.legacyScene) { const d = document.createElement('div'); d.className='legacy'; d.textContent='Legacy scene — not simulated'; stage.appendChild(d); return; }
  const bgLayer = document.createElement('div'); bgLayer.className = 'bglayer'; stage.appendChild(bgLayer);
  live = { scene: scene || sceneOf(stop), stop, bgLayer, bgEls: [] };
  mountBg(live.scene.bg);
  if (stop.cg) addImg(stage, pickFormat(stop.cg, stop.cgVariants), 'layer', '0', '100%');
  if (stop.video) addVideo(stage, stop.video);
  for (const d of live.scene.dolls) mountDoll(stage, d);
  if (stop.cg && stop.cgVariants && !stop.video) stage.appendChild(fmtBar(stop.cgVariants, () => renderStage(stop, scene)));
  applyStyles();
}

function mountBg(bg) {
  live.bgLayer.innerHTML = ''; live.bgEls = [];
  if (bg.split) {
    if (bg.src) live.bgEls.push({ el: addImg(live.bgLayer, bg.src, 'bg', '0', '50%'), bw: 'bw' });
    if (bg.src2) live.bgEls.push({ el: addImg(live.bgLayer, bg.src2, 'bg', '50%', '50%'), bw: 'bw2' });
    const sep = document.createElement('div'); sep.className = 'bgsep'; sep.style.width = ((bg.sep || 8) / 1920 * 100) + '%'; live.bgLayer.appendChild(sep);
  } else if (bg.src) {
    live.bgEls.push({ el: addImg(live.bgLayer, bg.src, 'bg', '0', '100%'), bw: 'bw' });
  }
}

function mountDoll(stage, d) {
  const el = document.createElement('div'); el.className = 'doll';
  const canvas = document.createElement('canvas'); el.appendChild(canvas); stage.appendChild(el);
  d.el = el; d.canvas = canvas; d.drawKey = '';
}

function filterOf(blur, gray, k) {
  const parts = [];
  if (blur > 0.05) parts.push('blur(' + (blur * k).toFixed(2) + 'px)');
  if (gray > 0.01) parts.push('grayscale(' + gray.toFixed(2) + ')');
  return parts.length ? parts.join(' ') : 'none';
}

function applyStyles() {
  if (!live) return;
  const stage = document.getElementById('stage');
  const w = (stage.getBoundingClientRect && stage.getBoundingClientRect().width) || 1920;
  const k = w / 1920;
  const bg = live.scene.bg;
  for (const b of live.bgEls) b.el.style.filter = filterOf(bg.blur, bg[b.bw] ? 1 : 0, k);
  for (const d of live.scene.dolls) {
    if (!d.el) continue;
    const box = place(d.cfg);
    d.el.style.left = box.left + '%'; d.el.style.top = box.top + '%'; d.el.style.width = box.width + '%'; d.el.style.height = box.height + '%';
    d.el.style.transform = (d.sx || d.sy) ? 'translate(' + (d.sx * k).toFixed(1) + 'px,' + (d.sy * k).toFixed(1) + 'px)' : '';
    d.el.style.filter = filterOf(d.cfg.blur, 1 - d.cfg.sat, k);
    d.canvas.style.transform = 'scaleX(' + d.cfg.flip.toFixed(3) + ')';
    const tn = d.cfg.tint;
    const key = d.body + '|' + d.head + '|' + Math.round(tn.r) + ',' + Math.round(tn.g) + ',' + Math.round(tn.b) + ',' + tn.a.toFixed(3);
    if (d.drawKey !== key) { d.drawKey = key; void drawLayers(d, key); }
  }
}

async function drawLayers(d, key) {
  const body = await img(d.body), head = await img(d.head);
  if (d.drawKey !== key || !d.canvas) return;
  const canvas = d.canvas;
  const srcW = Math.max(body?body.naturalWidth:0, head?head.naturalWidth:0) || 1200;
  const srcH = Math.max(body?body.naturalHeight:0, head?head.naturalHeight:0) || 2160;
  const box = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  let scale = 1;
  if (box.width > 2 && box.height > 2) scale = Math.min(1, (box.width*dpr)/srcW, (box.height*dpr)/srcH);
  const w = Math.max(1, Math.round(srcW*scale)), h = Math.max(1, Math.round(srcH*scale));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,w,h); ctx.save();
  if (body) ctx.drawImage(body,0,0,w,h);
  if (head) ctx.drawImage(head,0,0,w,h);
  const tint = d.cfg.tint;
  if (tint && tint.a > 0.004) { ctx.globalCompositeOperation='source-atop'; ctx.fillStyle='rgba('+Math.round(tint.r)+','+Math.round(tint.g)+','+Math.round(tint.b)+','+tint.a+')'; ctx.fillRect(0,0,w,h); }
  ctx.restore();
}

// ── Player: the paperdoll/background animation into a stop ─────────────────
// Ops come from the script in engine order: display() actions run one after another,
// PDAPause blocks (the stop's text waits), every other action eases (Ren'Py ease warper)
// over its duration while the script continues. Clicking on skips to the end.
let anim = null;
const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null;
function clockNow() { return typeof performance !== 'undefined' && performance && performance.now ? performance.now() : Date.now(); }
function easeP(p) { const q = Math.max(0, Math.min(1, p)); return 0.5 - Math.cos(Math.PI * q) / 2; }

function playInto(prevStop, stop) {
  finishAnim();
  if (!raf || !stop.anim || !stop.anim.ops.length || stop.legacyScene) { renderStage(withAlt(stop)); return; }
  renderStage(withAlt(stop), sceneOf(prevStop));
  anim = { stop, ops: stop.anim.ops, i: 0, tweens: [], t0: clockNow(), end: stop.anim.end, blocking: stop.anim.blocking, handle: 0 };
  setWaiting(anim.blocking > 0);
  tickAnim();
}

function finishAnim() {
  if (!anim) return;
  const s = anim.stop;
  if (caf && anim.handle) caf(anim.handle);
  anim = null;
  setWaiting(false);
  renderStage(withAlt(s));
}

function tickAnim() {
  const a = anim;
  if (!a || !live) return;
  const now = (clockNow() - a.t0) / 1000;
  while (a.i < a.ops.length && a.ops[a.i].at <= now + 0.0001) startOp(a, a.ops[a.i++]);
  stepTweens(a, now);
  applyStyles();
  if (now >= a.blocking) setWaiting(false);
  if (a.i >= a.ops.length && now >= a.end) { finishAnim(); return; }
  a.handle = raf(tickAnim);
}

function dollOf(key) { return live.scene.dolls.find((d) => d.key === key); }
function tweenTo(a, target, prop, to, op) {
  if (!(op.duration > 0)) { target[prop] = to; return; }
  a.tweens.push({ target, prop, from: target[prop], to, t0: op.at, dur: op.duration });
}

function startOp(a, op) {
  const sc = live.scene;
  const stage = document.getElementById('stage');
  if (op.kind === 'clear') {
    sc.dolls.forEach((d) => { if (d.el) d.el.remove(); });
    sc.dolls = []; sc.bg = emptyBg(); mountBg(sc.bg);
    return;
  }
  if (op.kind === 'bg') {
    const from = sc.bg.blur || 0;
    sc.bg = Object.assign(emptyBg(), op.bg || {});
    const to = sc.bg.blur;
    sc.bg.blur = op.duration > 0 ? from : to;
    mountBg(sc.bg);
    tweenTo(a, sc.bg, 'blur', to, op);
    return;
  }
  if (op.kind === 'show') {
    if (!dollOf(op.target)) {
      const d = { key: op.target, body: op.body, head: op.head, cfg: cfgOf(op.config), sx: 0, sy: 0 };
      sc.dolls.push(d); mountDoll(stage, d);
    }
    return;
  }
  const d = dollOf(op.target);
  if (!d) return;
  if (op.kind === 'hide') { if (d.el) d.el.remove(); sc.dolls = sc.dolls.filter((x) => x !== d); return; }
  if (op.kind === 'image') { d.body = op.body; d.head = op.head; return; }
  if (op.kind === 'shake') { a.tweens.push({ shake: d, dist: op.distance || 15, t0: op.at, dur: op.duration || 1 }); return; }
  const c = cfgOf(op.config);
  if (op.kind === 'move') { tweenTo(a, d.cfg, 'alignX', c.alignX, op); tweenTo(a, d.cfg, 'alignY', c.alignY, op); tweenTo(a, d.cfg, 'zoom', c.zoom, op); }
  else if (op.kind === 'flip') tweenTo(a, d.cfg, 'flip', c.flip, op);
  else if (op.kind === 'blur') tweenTo(a, d.cfg, 'blur', c.blur, op);
  else if (op.kind === 'bw') tweenTo(a, d.cfg, 'sat', c.sat, op);
  else if (op.kind === 'color') { ['r', 'g', 'b', 'a'].forEach((ch) => tweenTo(a, d.cfg.tint, ch, c.tint[ch], op)); }
}

function stepTweens(a, now) {
  a.tweens = a.tweens.filter((tw) => {
    const p = Math.max(0, Math.min(1, (now - tw.t0) / tw.dur));
    if (tw.shake) {
      const amp = p >= 1 ? 0 : tw.dist * (1 - p);
      tw.shake.sx = (Math.random() * 2 - 1) * amp; tw.shake.sy = (Math.random() * 2 - 1) * amp;
      return p < 1;
    }
    tw.target[tw.prop] = tw.from + (tw.to - tw.from) * easeP(p);
    return p < 1;
  });
}

/** The stop's text appears once the blocking pauses are over (like the engine). */
function setWaiting(on) {
  const cap = document.getElementById('caption');
  if (on) cap.classList.add('waiting'); else cap.classList.remove('waiting');
}

// show_video: the Movie plays over its start image (the poster stays underneath while it
// loads). The element is reused across re-renders of the same video so it keeps playing.
let stageVideo = null;
function addVideo(stage, v) {
  if (v.src) {
    let el = stageVideo;
    if (!el || el._src !== v.src) {
      el = document.createElement('video');
      el._src = v.src; el.src = v.src; el.muted = true; el.autoplay = true; el.playsInline = true;
      el.title = 'Click to pause / play';
      el.addEventListener('click', () => {
        if (el.paused || el.ended) { el._userPaused = false; if (el.ended) el.currentTime = 0; if (el.play) el.play().catch(() => {}); }
        else { el._userPaused = true; el.pause(); }
      });
      stageVideo = el;
    }
    el.loop = !!v.loop;
    el.className = 'layer';
    stage.appendChild(el);
    if (!el._userPaused && !el.ended && el.play) { const p = el.play(); if (p && p.catch) p.catch(() => {}); }
  }
  const badge = document.createElement('div');
  const problem = !v.src ? 'video file missing: ' + v.play : !v.defined ? 'no Movie definition — the game cannot show it' : '';
  badge.className = 'vbadge' + (problem ? ' warn' : '');
  badge.textContent = '🎬 ' + v.name + ' · ' + (v.loop ? 'loop' : 'once') + (problem ? ' · ⚠ ' + problem : '');
  badge.title = problem ? 'Open the image module (🖼 Edit / marker) to add the definition' : 'plays ' + v.play;
  stage.appendChild(badge);
}

function addImg(host, src, cls, left, width) {
  const el = document.createElement('img');
  el.className = 'layer ' + cls; el.src = src; el.style.left = left; el.style.width = width;
  host.appendChild(el);
  return el;
}

function renderCaption(stop) {
  const cap = document.getElementById('caption');
  cap.innerHTML = '';
  if (!stop) return;
  if (stop.alternatives && stop.alternatives.length) { renderAltCaption(stop); return; }
  for (const p of stop.portraits || []) { const im = document.createElement('img'); im.className='pic'; im.src=p; cap.appendChild(im); }
  const who = document.createElement('span'); who.className='who';
  who.textContent = stop.names && stop.names.length ? stop.names.join(' · ') : (stop.speaker || labelForKind(stop.kind));
  if (stop.kind === 'dialog') { who.title = 'Double-click to change speaker'; who.style.cursor = 'pointer'; who.addEventListener('dblclick', () => beginSpeakerEdit(stop, who)); }
  cap.appendChild(who);
  if (stop.kind === 'dialog' && stop.speaker !== 'subtitles') {
    const sel = document.createElement('select'); sel.className = 'type-sel';
    for (const t of ['say','think','shout','whisper']) { const o = document.createElement('option'); o.value = t; o.textContent = t; sel.appendChild(o); }
    sel.value = stop.speechType || 'say'; sel.title = 'Dialogue type';
    sel.addEventListener('change', () => vscode.postMessage({ type:'changeType', line: stop.line, src: stop.src, speechType: sel.value }));
    cap.appendChild(sel);
  }
  if (stop.partCount > 1) {
    const mono = document.createElement('span'); mono.className = 'mono-part';
    mono.textContent = (stop.part + 1) + '/' + stop.partCount;
    mono.title = 'Part ' + (stop.part + 1) + ' of ' + stop.partCount + ' of one triple-quoted text — Ren’Py shows each blank-line-separated block as its own line. Speaker and type apply to all parts.';
    cap.appendChild(mono);
  }
  const txt = document.createElement('span'); txt.className='txt'; txt.textContent = stop.text || '';
  if (stop.kind === 'dialog') {
    txt.title = 'Double-click to edit the text'; txt.style.cursor = 'text';
    txt.addEventListener('dblclick', () => beginEdit(stop, txt));
    if (!stop.text) {
      // A new/empty line: a visible placeholder, one click to write it.
      txt.textContent = '✎ Write the line…'; txt.className = 'txt placeholder';
      txt.addEventListener('click', () => beginEdit(stop, txt));
    }
  }
  cap.appendChild(txt);
  if (stop.kind === 'dialog') {
    const pen = document.createElement('button'); pen.className = 'alt'; pen.textContent = '✏'; pen.title = 'Edit the text (Enter saves, Esc cancels)';
    pen.style.flex = '0 0 auto'; pen.style.marginLeft = 'auto';
    pen.addEventListener('click', () => { const span = cap.querySelector('.txt'); if (span) beginEdit(stop, span); });
    cap.appendChild(pen);
  }
  if (stop.kind === 'dialog' || stop.kind === 'pause') {
    const del = document.createElement('button'); del.className = 'alt'; del.textContent = '🗑'; del.title = 'Delete this line';
    del.style.marginLeft = stop.kind === 'dialog' ? '4px' : 'auto'; del.style.flex = '0 0 auto';
    del.addEventListener('click', () => vscode.postMessage({ type:'deleteStop', line: stop.line, src: stop.src, part: stop.part, expect: stop.part != null ? stop.rawText : undefined }));
    cap.appendChild(del);
  }
  if ((stop.kind === 'image' || stop.kind === 'video') && stop.image) {
    const isVid = stop.image.kind === 'show_video';
    const ed = document.createElement('button'); ed.className = 'alt'; ed.textContent = isVid ? '🎬 Edit' : '🖼 Edit'; ed.title = isVid ? 'Edit video step / pause / Movie definition' : 'Edit image steps';
    ed.style.marginLeft = 'auto'; ed.style.flex = '0 0 auto';
    ed.addEventListener('click', () => openImageFor(stop.line, stop.src, stop.image));
    cap.appendChild(ed);
  }
}

function beginSpeakerEdit(stop, span) {
  const sel = document.createElement('select');
  const sub = document.createElement('option'); sub.value = 'subtitles'; sub.textContent = '(subtitles / narration)'; sel.appendChild(sub);
  for (const c of state.characters || []) { const o = document.createElement('option'); o.value = c.key; o.textContent = c.label; sel.appendChild(o); }
  sel.value = (stop.personKeys && stop.personKeys[0]) ? stop.personKeys[0] : 'subtitles';
  span.replaceWith(sel); sel.focus();
  let done = false;
  sel.addEventListener('change', () => { if (done) return; done = true; vscode.postMessage({ type:'changeSpeaker', line: stop.line, src: stop.src, personKey: sel.value }); });
  sel.addEventListener('blur', () => { if (done) return; done = true; renderCaption(stop); });
}

function beginEdit(stop, span) {
  const raw = stop.rawText != null ? stop.rawText : (stop.text || '');
  const input = document.createElement('input'); input.type = 'text'; input.value = raw;
  input.style.flex = '1'; input.style.minWidth = '0';
  input.style.background = 'var(--vscode-input-background)'; input.style.color = 'var(--vscode-input-foreground)';
  input.style.border = '1px solid var(--vscode-focusBorder)';
  span.replaceWith(input); input.focus(); input.select();
  let done = false;
  const commit = () => { if (done) return; done = true; vscode.postMessage({ type:'editText', line: stop.line, src: stop.src, text: input.value, part: stop.part, expect: stop.part != null ? stop.rawText : undefined }); };
  const cancel = () => { if (done) return; done = true; renderCaption(stop); };
  input.placeholder = 'Dialogue text…';
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { e.preventDefault(); cancel(); } });
  // Clicking elsewhere keeps what was typed (only Esc throws it away).
  input.addEventListener('blur', () => { if (input.value !== raw) commit(); else cancel(); });
}

function labelForKind(k){ return k==='pause'?'Pause':k==='image'?'Image':k==='video'?'Video':'Narration'; }

// Timeline: stops are cards; between them pin-shaped markers stand on the baseline. Their
// round heads carry the marker icon and step down to the right when several share a gap;
// hovering a head expands it to the right with the marker text (and move arrows).
const PIN_X = 14;
const PIN_Y = 18;
function lineOfItem(it) { return it.marker ? it.marker.line : it.split.line; }
function splitText(b) { return (b.kind === 'menu' ? (b.title || 'Menu') : 'if') + ' → ' + (b.options[b.selected] || '?'); }

function renderTimeline() {
  const box = document.getElementById('timeline');
  box.innerHTML = '';
  const strip = document.createElement('div'); strip.className = 'strip';
  const stops = state.stops || [];
  const byGap = new Map();
  const push = (g, item) => { if (!byGap.has(g)) byGap.set(g, []); byGap.get(g).push(item); };
  for (const m of state.markers || []) push(m.afterStop, { marker: m });
  // Branch points (splits): a menu marks its own pin, an if/elif chain gets a ⑂ pin.
  for (const b of state.branches || []) {
    const g = b.afterStop == null ? -1 : b.afterStop;
    const own = b.kind === 'menu' ? (byGap.get(g) || []).find((x) => x.marker && x.marker.kind === 'menu' && x.marker.line === b.line) : null;
    if (own) own.split = b; else push(g, { split: b });
  }
  let maxPins = 0;
  byGap.forEach((list) => { maxPins = Math.max(maxPins, list.length); });
  const top = maxPins ? (maxPins - 1) * PIN_Y + 30 : 6;
  addGap(strip, byGap.get(-1) || [], null, top);
  stops.forEach((stop, i) => {
    const card = document.createElement('div'); card.className = 'card' + (i === current ? ' active' : '');
    card.style.marginTop = top + 'px';
    const head = document.createElement('div'); head.className = 'head';
    for (const p of (stop.portraits || []).slice(0, 3)) { const im = document.createElement('img'); im.className = 'pic'; im.src = p; head.appendChild(im); }
    const who = document.createElement('span'); who.className = 'who';
    who.textContent = stop.names && stop.names.length ? stop.names[0] : (stop.speaker || labelForKind(stop.kind));
    head.appendChild(who);
    card.appendChild(head);
    const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = labelForKind(stop.kind); card.appendChild(kind);
    const txt = document.createElement('div'); txt.className = 'txt'; txt.textContent = stop.text || (stop.kind === 'dialog' ? '✎ (empty)' : ''); card.appendChild(txt);
    card.addEventListener('click', () => {
      goto(i);
      if ((stop.kind === 'image' || stop.kind === 'video') && stop.image) openImageFor(stop.line, stop.src, stop.image);
    });
    card.appendChild(moveTools(stop.line, stop.src));
    strip.appendChild(card);
    addGap(strip, byGap.get(i) || [], stop, top);
  });
  box.appendChild(strip);
}

function addGap(strip, items, stop, top) {
  if (!items.length && !stop) return;
  items.sort((a, b) => lineOfItem(a) - lineOfItem(b));
  const gap = document.createElement('div'); gap.className = 'gap';
  gap.style.width = Math.max(24, 16 + items.length * PIN_X) + 'px';
  items.forEach((it, i) => gap.appendChild(pinFor(it, i)));
  if (stop) {
    const plus = document.createElement('button'); plus.className = 'plus'; plus.textContent = '＋';
    plus.title = 'Insert a statement here';
    plus.addEventListener('click', () => renderInsertChooser(stop.line, stop.speaker, stop.src));
    gap.appendChild(plus);
  }
  strip.appendChild(gap);
}

function pinFor(it, i) {
  const m = it.marker;
  const pin = document.createElement('div'); pin.className = 'pin' + (it.split ? ' split' : '') + (m ? ' k-' + m.kind : '');
  pin.style.left = (10 + i * PIN_X) + 'px';
  pin.style.top = (i * PIN_Y) + 'px';
  const head = document.createElement('div'); head.className = 'phead';
  const ico = document.createElement('span'); ico.className = 'pico';
  ico.textContent = m ? (m.image && m.image.kind === 'show_video' ? '🎬' : markerIcon(m.kind)) : (it.split.kind === 'menu' ? '☰' : '⑂');
  head.appendChild(ico);
  const txt = document.createElement('span'); txt.className = 'ptxt';
  txt.textContent = m ? m.label + (it.split ? '  ⑂ ' + (it.split.options[it.split.selected] || '') : '') : splitText(it.split);
  head.appendChild(txt);
  head.title = m ? m.label : 'Branch point: ' + splitText(it.split) + ' — switch it in the branch bar';
  if (m) {
    const mv = moveTools(m.line, m.src); mv.className = 'pmv'; head.appendChild(mv);
    head.addEventListener('click', () => openMarker(m));
  } else {
    head.addEventListener('click', () => focusBranch(it.split));
  }
  pin.appendChild(head);
  return pin;
}

/** Point at a split's row in the branch bar. */
function focusBranch(b) {
  const idx = (state.branches || []).indexOf(b);
  const row = document.getElementById('branchbar').children[idx];
  if (!row) return;
  if (row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1200);
}

/** After a branch/value switch: stay on the stop when the path up to it is unchanged; else go to the last stop before the split. */
function keptIndex(oldStops, cur, newStops) {
  const same = (a, b) => a && b && a.line === b.line && a.kind === b.kind && a.text === b.text;
  let k = 0;
  while (k < oldStops.length && k < newStops.length && same(oldStops[k], newStops[k])) k++;
  if (cur < k) return cur;
  return Math.max(0, Math.min(newStops.length - 1, k - 1));
}

/** Hover arrows that move a statement one step earlier/later in its block. */
function moveTools(line, src) {
  const box = document.createElement('div'); box.className = 'mv';
  const mk = (label, dir, title) => {
    const b = document.createElement('button'); b.className = 'alt'; b.textContent = label; b.title = title;
    b.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type:'moveStatement', line, src, direction: dir }); });
    return b;
  };
  box.appendChild(mk('◀', -1, 'Move earlier'));
  box.appendChild(mk('▶', 1, 'Move later'));
  return box;
}

function markerIcon(k){ return k==='paperdoll'?'🎭':k==='image'?'🖼':k==='background'?'🌄':k==='menu'?'❓':k==='stats'?'📈':k==='end'?'⏹':'＋'; }
function renderInsertChooser(line, speaker, src) {
  openMenuLine = null;
  const ed = document.getElementById('editor');
  ed.innerHTML = '';
  const h = document.createElement('h3'); h.textContent = 'Insert after line ' + (line + 1); ed.appendChild(h);
  const row = document.createElement('div'); row.className = 'branch-row';
  const opts = [
    ['💬 Dialogue', () => vscode.postMessage({ type:'plusInsert', kind:'dialog', line, src, speaker })],
    ['🎭 Paperdoll', () => { showPaperdoll(true); vscode.postMessage({ type:'openMarker', kind:'paperdoll', line, src, character:0 }); }],
    ['🖼 Image', () => vscode.postMessage({ type:'plusInsert', kind:'image', line, src })],
    ['🎬 Video', () => { showModule('img'); vscode.postMessage({ type:'plusInsert', kind:'video', line, src }); }],
    ['❓ Menu', () => vscode.postMessage({ type:'plusInsert', kind:'menu', line, src })],
  ];
  for (const [label, fn] of opts) {
    const btn = document.createElement('button'); btn.className = 'alt'; btn.textContent = label;
    btn.addEventListener('click', fn); row.appendChild(btn);
  }
  ed.appendChild(row);
}

/** Image module for exactly this image (for a show_image series: this one step). */
function openImageFor(line, src, image) {
  if (image.kind === 'show' || image.kind === 'show_pattern' || image.kind === 'show_image' || image.kind === 'show_video') showModule('img');
  vscode.postMessage({ type:'openMarker', kind:'image', line, src, character: image.character || 0, image });
}

function openMarker(m) {
  if (m.kind === 'menu') { renderMenuEditor(m); return; }
  if (m.kind === 'stats') { showModule(null); renderStatsEditor(m); return; }
  if (m.kind === 'end') { showModule(null); renderEndEditor(m); return; }
  if (m.kind === 'paperdoll') { showPaperdoll(true); vscode.postMessage({ type:'openMarker', kind:'paperdoll', line:m.line, src:m.src, character:m.character }); return; }
  if (m.kind === 'background') {
    showModule('bg');
    vscode.postMessage({ type: 'bg:open', line: m.line, src: m.src });
    return;
  }
  if (m.kind === 'image') {
    if (!m.image) return;
    openImageFor(m.line, m.src, m.image);
    return;
  }
}

// ── Background module ──
let bgState = null;
function bgField(host, label, input, cls) { const l = document.createElement('label'); if (cls) l.className = cls; if (cls === 'chk') { l.appendChild(input); l.appendChild(textSpan(label)); } else { l.appendChild(textSpan(label)); l.appendChild(input); } host.appendChild(l); return input; }
function bgInput(type, value) { const i = document.createElement('input'); i.type = type; if (type === 'checkbox') i.checked = !!value; else i.value = String(value); return i; }
function applyBgEditor(msg) {
  const prev = document.getElementById('bgprev'); prev.innerHTML = '';
  const form = document.getElementById('bgform'); form.innerHTML = '';
  const note = document.getElementById('bgnote'); note.textContent = '';
  if (msg.missing) { note.textContent = 'No set_background(…) on that line anymore.'; bgState = null; return; }
  bgState = { line: msg.line, src: msg.src, spec: JSON.parse(JSON.stringify(msg.spec)), saved: msg.saved };
  const s = bgState.spec;
  // Preview like the stage: blur in game pixels, split halves, black-and-white.
  const w = (prev.getBoundingClientRect && prev.getBoundingClientRect().width) || 1920;
  const blurPx = (s.blur === true ? 10 : Number(s.blur) || 0) * w / 1920;
  const addPrev = (src, left, width, bw) => { if (!src) return; const im = document.createElement('img'); im.src = src; im.style.left = left; im.style.width = width; im.style.filter = filterOf(blurPx * 1920 / w, bw ? 1 : 0, w / 1920); prev.appendChild(im); };
  if (s.split) { addPrev(msg.previews[0], '0', '50%', s.bwLeft); addPrev(msg.previews[1], '50%', '50%', s.bwRight); const sep = document.createElement('div'); sep.className = 'bgsep'; sep.style.width = (s.separator / 1920 * 100) + '%'; prev.appendChild(sep); }
  else addPrev(msg.previews[0], '0', '100%', s.bw);
  const changed = () => vscode.postMessage({ type: 'bg:change', line: bgState.line, src: bgState.src, spec: bgState.spec });
  s.sources.forEach((src, i) => {
    const name = s.split ? (i === 0 ? 'Left' : 'Right') : 'Image';
    if (src.kind === 'series') {
      const inp = bgField(form, name + ' — ' + src.variable + '[step]', bgInput('number', src.step));
      inp.min = '0';
      inp.addEventListener('change', () => { src.step = Math.max(0, Math.round(Number(inp.value) || 0)); changed(); });
    } else if (src.kind === 'path') {
      const inp = bgField(form, name + ' — path', bgInput('text', src.path));
      inp.addEventListener('change', () => { src.path = inp.value; changed(); });
    } else {
      const inp = bgField(form, name + ' — code (edit in the script)', bgInput('text', src.code)); inp.disabled = true;
    }
  });
  const blurSel = document.createElement('select');
  [['off', 'off'], ['on', 'on (10)'], ['custom', 'custom']].forEach((x) => { const o = document.createElement('option'); o.value = x[0]; o.textContent = x[1]; blurSel.appendChild(o); });
  blurSel.value = s.blur === true ? 'on' : (s.blur === false || s.blur === 0) ? 'off' : 'custom';
  bgField(form, 'blur', blurSel);
  const amount = bgField(form, 'blur amount', bgInput('number', typeof s.blur === 'number' ? s.blur : s.blur ? 10 : 0));
  amount.step = '0.5'; amount.min = '0'; amount.disabled = blurSel.value !== 'custom';
  blurSel.addEventListener('change', () => { s.blur = blurSel.value === 'on' ? true : blurSel.value === 'off' ? false : (Number(amount.value) || 5); changed(); });
  amount.addEventListener('change', () => { s.blur = Number(amount.value) || 0; changed(); });
  const dur = bgField(form, 'blur_duration (s)', bgInput('number', s.blurDuration)); dur.step = '0.1'; dur.min = '0';
  dur.addEventListener('change', () => { s.blurDuration = Math.max(0, Number(dur.value) || 0); changed(); });
  if (s.split) {
    const bl = bgField(form, 'left black-and-white', bgInput('checkbox', s.bwLeft), 'chk'); bl.addEventListener('change', () => { s.bwLeft = bl.checked; changed(); });
    const br = bgField(form, 'right black-and-white', bgInput('checkbox', s.bwRight), 'chk'); br.addEventListener('change', () => { s.bwRight = br.checked; changed(); });
    const sepIn = bgField(form, 'separator width (px)', bgInput('number', s.separator)); sepIn.min = '0';
    sepIn.addEventListener('change', () => { s.separator = Math.max(0, Math.round(Number(sepIn.value) || 0)); changed(); });
  } else {
    const b = bgField(form, 'black-and-white', bgInput('checkbox', s.bw), 'chk'); b.addEventListener('change', () => { s.bw = b.checked; changed(); });
  }
  const dirty = JSON.stringify(s) !== JSON.stringify(msg.saved);
  note.textContent = msg.positionalOptions ? 'Options are passed positionally — edit them in the code.' : dirty ? 'Preview — not applied yet' : '';
  document.getElementById('bgapply').disabled = !dirty || !!msg.positionalOptions;
  showModule('bg');
}
document.getElementById('bgapply').addEventListener('click', () => { if (bgState) vscode.postMessage({ type: 'bg:apply', line: bgState.line, src: bgState.src, spec: bgState.spec }); });
document.getElementById('bgclose').addEventListener('click', () => showModule(null));

function renderStatsEditor(m) {
  openMenuLine = null; openStmtEditor = { kind: 'stats', line: m.line };
  const ed = document.getElementById('editor'); ed.innerHTML = '';
  const h = document.createElement('h3'); h.className = 'pdhost-head'; h.textContent = 'Stat changes · L' + (m.line + 1);
  const close = document.createElement('button'); close.className = 'alt'; close.textContent = '✕';
  close.addEventListener('click', () => { openStmtEditor = null; ed.innerHTML = ''; });
  h.appendChild(close); ed.appendChild(h);
  const post = (extra) => vscode.postMessage(Object.assign({ type: 'statOp', line: m.line, src: m.src }, extra));
  (m.stats || []).forEach((s) => {
    const row = document.createElement('div'); row.className = 'branch-row';
    const lbl = document.createElement('span'); lbl.textContent = s.stat; lbl.style.minWidth = '80px'; row.appendChild(lbl);
    const sel = document.createElement('select');
    const vals = MODIFIERS.indexOf(s.value) < 0 ? [s.value].concat(MODIFIERS) : MODIFIERS;
    vals.forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = modText(v) + '  (' + v + ')'; sel.appendChild(o); });
    sel.value = s.value;
    sel.addEventListener('change', () => post({ op: 'set', stat: s.stat, value: sel.value }));
    row.appendChild(sel);
    const rm = document.createElement('button'); rm.className = 'alt'; rm.textContent = '✕'; rm.title = 'Remove this stat change';
    rm.addEventListener('click', () => post({ op: 'remove', stat: s.stat }));
    row.appendChild(rm);
    ed.appendChild(row);
  });
  const add = document.createElement('div'); add.className = 'branch-row';
  const stat = document.createElement('select');
  STAT_NAMES.filter((n) => !(m.stats || []).some((s) => s.stat === n)).forEach((n) => { const o = document.createElement('option'); o.value = n; o.textContent = n; stat.appendChild(o); });
  const val = document.createElement('select');
  MODIFIERS.forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = modText(v) + '  (' + v + ')'; val.appendChild(o); });
  val.value = 'SMALL';
  const go = document.createElement('button'); go.textContent = '+ Stat';
  go.addEventListener('click', () => { if (stat.value) post({ op: 'add', stat: stat.value, value: val.value }); });
  add.appendChild(stat); add.appendChild(val); add.appendChild(go);
  ed.appendChild(add);
}

function renderEndEditor(m) {
  openMenuLine = null; openStmtEditor = { kind: 'end', line: m.line };
  const ed = document.getElementById('editor'); ed.innerHTML = '';
  const h = document.createElement('h3'); h.className = 'pdhost-head'; h.textContent = 'Event end · L' + (m.line + 1);
  const close = document.createElement('button'); close.className = 'alt'; close.textContent = '✕';
  close.addEventListener('click', () => { openStmtEditor = null; ed.innerHTML = ''; });
  h.appendChild(close); ed.appendChild(h);
  const row = document.createElement('div'); row.className = 'branch-row';
  const sel = document.createElement('select');
  const known = END_TYPES.map((x) => x[0]);
  (known.indexOf(m.endType) < 0 ? [[m.endType, 'custom']].concat(END_TYPES) : END_TYPES).forEach((x) => { const o = document.createElement('option'); o.value = x[0]; o.textContent = x[0] + ' — ' + x[1]; sel.appendChild(o); });
  sel.value = m.endType;
  sel.addEventListener('change', () => vscode.postMessage({ type: 'endOp', line: m.line, src: m.src, endType: sel.value }));
  row.appendChild(sel); ed.appendChild(row);
}

/** Stat effects + ending of the path shown in the timeline (for balancing). */
function textSpan(s) { const e = document.createElement('span'); e.textContent = s; return e; }
function renderEffects() {
  const box = document.getElementById('effects'); box.innerHTML = '';
  const totals = {}; let end = '';
  (state.markers || []).forEach((m) => {
    if (m.kind === 'stats') (m.stats || []).forEach((s) => { (totals[s.stat] = totals[s.stat] || []).push(s.value); });
    if (m.kind === 'end') end = m.endType;
  });
  const keys = Object.keys(totals);
  if (!keys.length && !end) return;
  box.appendChild(textSpan('Effects on this path: '));
  keys.forEach((k, i) => {
    const sp = document.createElement('span');
    const vals = totals[k].map(modText).join(' ');
    sp.className = totals[k].every((v) => /^DEC_/.test(v)) ? 'down' : 'up';
    sp.textContent = (i ? ' · ' : '') + k + ' ' + vals;
    box.appendChild(sp);
  });
  if (end) box.appendChild(textSpan('  →  end: ' + end));
}

// ── Event check module ──
function openCheck() { showModule('check'); checkState = null; renderCheck(); vscode.postMessage({ type: 'check:run' }); }
function fmtEffects(effects) {
  return Object.keys(effects || {}).map((k) => k + ' ' + effects[k].map(modText).join(' ')).join(' · ');
}
function renderCheck() {
  const box = document.getElementById('checkbody'); box.innerHTML = '';
  if (!checkState) { const p = document.createElement('div'); p.className = 'muted'; p.textContent = 'Checking every path…'; box.appendChild(p); return; }
  if (checkState.error) { const p = document.createElement('div'); p.className = 'err'; p.textContent = checkState.error; box.appendChild(p); return; }
  const r = checkState;
  const missing = r.coverage.reduce((n, c) => n + c.missing, 0);
  const tabs = document.createElement('div'); tabs.className = 'tabs';
  [['issues', 'Issues (' + r.issues.length + ')'], ['coverage', 'Images' + (missing ? ' (' + missing + ' missing)' : '')], ['paths', 'Paths (' + r.paths.length + ')']].forEach((x) => {
    const b = document.createElement('button'); b.className = checkTab === x[0] ? '' : 'alt'; b.textContent = x[1];
    b.addEventListener('click', () => { checkTab = x[0]; renderCheck(); }); tabs.appendChild(b);
  });
  const rerun = document.createElement('button'); rerun.className = 'alt'; rerun.textContent = '↻'; rerun.title = 'Run again';
  rerun.addEventListener('click', openCheck); tabs.appendChild(rerun);
  box.appendChild(tabs);
  if (checkTab === 'issues') {
    const n = { error: 0, warning: 0, info: 0 }; r.issues.forEach((i) => { n[i.severity]++; });
    if (!n.error && !n.warning) { const ok = document.createElement('div'); ok.className = 'okline'; ok.textContent = '✅ No problems on ' + r.paths.length + ' path(s)' + (n.info ? ' (' + n.info + ' note(s))' : '') + '.'; box.appendChild(ok); }
    r.issues.forEach((i) => {
      const row = document.createElement('div'); row.className = 'issue ' + i.severity;
      const ico = document.createElement('span'); ico.className = 'ico'; ico.textContent = i.severity === 'error' ? '⛔' : i.severity === 'warning' ? '⚠' : 'ℹ'; row.appendChild(ico);
      const msg = document.createElement('span'); msg.className = 'msg'; msg.textContent = i.message; row.appendChild(msg);
      if (i.line != null) { const a = document.createElement('a'); a.textContent = 'L' + (i.line + 1); a.title = 'Show in code'; a.addEventListener('click', () => vscode.postMessage({ type: 'reveal', line: i.line })); row.appendChild(a); }
      if (i.selections) { const b = document.createElement('button'); b.className = 'alt'; b.textContent = '▶ path'; b.title = 'Show this path in the timeline'; b.addEventListener('click', () => vscode.postMessage({ type: 'check:showPath', selections: i.selections })); row.appendChild(b); }
      box.appendChild(row);
    });
  } else if (checkTab === 'coverage') {
    const head = document.createElement('div'); head.className = 'covhead';
    const exact = r.coverage.reduce((n, c) => n + c.exact, 0), wild = r.coverage.reduce((n, c) => n + c.wildcard, 0);
    head.appendChild(textSpan(exact + ' exact · ' + wild + ' via $ · ' + missing + ' missing'));
    const shot = document.createElement('button'); shot.textContent = '📋 Shot list'; shot.disabled = !missing;
    shot.title = 'Copy the file names of all missing images (CSV) — the shots to take';
    shot.addEventListener('click', () => vscode.postMessage({ type: 'check:shotlist' }));
    head.appendChild(shot); box.appendChild(head);
    if (!r.coverage.length) { const p = document.createElement('div'); p.className = 'muted'; p.textContent = 'No pattern images in this event.'; box.appendChild(p); }
    r.coverage.forEach((c, idx) => {
      const row = document.createElement('div'); row.className = 'covrow';
      const tl = document.createElement('div'); tl.className = 't';
      const name = document.createElement('span'); name.textContent = c.patternKey + (c.step !== null ? (c.video ? ' · video ' : ' · step ') + c.step : '') + (c.keys.length ? '  [' + c.keys.join(' × ') + ']' : '');
      tl.appendChild(name);
      [['exact', c.exact + ' ✓'], ['wildcard', c.wildcard + ' $'], ['missing', c.missing + ' missing']].forEach((x) => { if (x[0] === 'exact' || Number(x[1].split(' ')[0])) { const b = document.createElement('span'); b.className = 'badge ' + x[0]; b.textContent = x[1]; tl.appendChild(b); } });
      const a = document.createElement('a'); a.textContent = 'L' + (c.lines[0] + 1); a.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'reveal', line: c.lines[0] }); }); tl.appendChild(a);
      const key = c.patternKey + '|' + c.step + '|' + c.video;
      if (covOpen[key] === undefined) covOpen[key] = c.missing > 0 && r.coverage.length <= 6;
      tl.addEventListener('click', () => { covOpen[key] = !covOpen[key]; renderCheck(); });
      row.appendChild(tl);
      if (covOpen[key]) {
        if (c.keys.length === 1 && c.cells.length <= 40) {
          const cells = document.createElement('div'); cells.className = 'cells';
          c.cells.forEach((cell) => { const s = document.createElement('span'); s.className = 'cell ' + cell.status; s.textContent = cell.combo[c.keys[0]]; s.title = cell.status === 'missing' ? 'missing: ' + cell.expected : cell.file; cells.appendChild(s); });
          row.appendChild(cells);
        }
        const miss = c.cells.filter((x) => x.status === 'missing');
        if (miss.length) {
          const ul = document.createElement('ul'); ul.className = 'missinglist';
          miss.slice(0, 40).forEach((x) => { const li = document.createElement('li'); li.textContent = x.expected.split('/').pop(); li.title = x.expected; ul.appendChild(li); });
          if (miss.length > 40) { const li = document.createElement('li'); li.textContent = '… ' + (miss.length - 40) + ' more (see shot list)'; ul.appendChild(li); }
          row.appendChild(ul);
        }
      }
      box.appendChild(row);
    });
  } else {
    r.paths.forEach((pth) => {
      const row = document.createElement('div'); row.className = 'pathrow';
      const d = document.createElement('span'); d.className = 'd'; d.textContent = pth.description; row.appendChild(d);
      const e = document.createElement('span'); e.textContent = fmtEffects(pth.effects) || 'no stat changes'; row.appendChild(e);
      if (pth.endType) { const en = document.createElement('span'); en.className = 'muted'; en.textContent = '→ ' + pth.endType; row.appendChild(en); }
      const b = document.createElement('button'); b.className = 'alt'; b.textContent = '▶'; b.title = 'Show this path';
      b.addEventListener('click', () => vscode.postMessage({ type: 'check:showPath', selections: pth.selections }));
      row.appendChild(b);
      box.appendChild(row);
    });
  }
}

// ── Trigger simulator ──
let simDefaults = null;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAYTIMES = ['Morning', 'Early Noon', 'Noon', 'Early Afternoon', 'Afternoon', 'Evening', 'Night'];
function openSim() { showModule('sim'); if (!simDefaults) vscode.postMessage({ type: 'sim:init' }); else postSim(); }
function simField(label, input) { const l = document.createElement('label'); l.textContent = label; l.appendChild(input); return l; }
const simInputs = {};
function numInput(id, value, min, max) { const i = document.createElement('input'); simInputs[id] = i; i.type = 'number'; i.id = id; i.value = String(value); i.min = String(min); i.max = String(max); i.addEventListener('change', postSim); return i; }
function selInput(id, names, value) { const s = document.createElement('select'); simInputs[id] = s; s.id = id; names.forEach((n, i) => { const o = document.createElement('option'); o.value = String(i + 1); o.textContent = (i + 1) + ' · ' + n; s.appendChild(o); }); s.value = String(value); s.addEventListener('change', postSim); return s; }
function renderSimForm(st) {
  const f = document.getElementById('simform'); f.innerHTML = '';
  f.appendChild(simField('Weekday', selInput('sim_weekday', WEEKDAYS, st.weekday)));
  f.appendChild(simField('Daytime', selInput('sim_daytime', DAYTIMES, st.daytime)));
  Object.keys(st.levels).forEach((k) => f.appendChild(simField(k + ' level', numInput('sim_lvl_' + k, st.levels[k], 0, 10))));
  Object.keys(st.stats).forEach((k) => f.appendChild(simField(k, numInput('sim_stat_' + k, st.stats[k], 0, 100))));
  f.appendChild(simField('money', numInput('sim_money', st.money, 0, 1000000)));
  const intro = document.createElement('input'); simInputs.sim_intro = intro; intro.type = 'checkbox'; intro.id = 'sim_intro'; intro.checked = !!st.intro; intro.addEventListener('change', postSim);
  f.appendChild(simField('intro running', intro));
}
function readSim() {
  const v = (id) => simInputs[id].value;
  const st = { weekday: Number(v('sim_weekday')), daytime: Number(v('sim_daytime')), levels: {}, stats: {}, money: Number(v('sim_money')), intro: simInputs.sim_intro.checked };
  Object.keys(simDefaults.levels).forEach((k) => { st.levels[k] = Number(v('sim_lvl_' + k)); });
  Object.keys(simDefaults.stats).forEach((k) => { st.stats[k] = Number(v('sim_stat_' + k)); });
  return st;
}
function postSim() { if (simDefaults) vscode.postMessage({ type: 'sim:eval', state: readSim() }); }
function verdictText(row) {
  if (!row) return 'No Event(...) definition found.';
  const ch = row.chance < 1 ? ' (' + Math.round(row.chance * 100) + ' % random chance)' : '';
  return row.result === 'yes' ? '✅ Can fire' + ch : row.result === 'no' ? '⛔ Cannot fire' : '❓ Depends on game progress' + ch;
}
function condList(nodes, host) {
  nodes.forEach((n) => {
    const d = document.createElement('div'); d.className = 'cond';
    d.textContent = (n.result === 'yes' ? '✓ ' : n.result === 'no' ? '✗ ' : '? ') + n.label;
    if (n.detail) { const s = document.createElement('span'); s.className = 'd'; s.textContent = ' — ' + n.detail; d.appendChild(s); }
    host.appendChild(d);
    if (n.children && n.children.length) condList(n.children, d);
  });
}
function renderSim(msg) {
  const box = document.getElementById('simresult'); box.innerHTML = '';
  const r = msg.result;
  const v = document.createElement('div'); v.className = 'verdict'; v.textContent = verdictText(r.event); box.appendChild(v);
  if (r.event) condList(r.event.conditions, box);
  if (!r.pools.length) { const p = document.createElement('div'); p.className = 'muted'; p.textContent = 'Not added to a pool (pool.add_event) in the workspace.'; box.appendChild(p); }
  r.pools.forEach((pool) => {
    const d = document.createElement('div'); d.className = 'pool';
    const h = document.createElement('h4'); h.textContent = 'Pool ' + pool.pool + ' (' + pool.rows.length + ' events)'; d.appendChild(h);
    const s = document.createElement('div'); s.className = 'sum'; s.textContent = pool.summary; d.appendChild(s);
    pool.rows.forEach((row) => {
      const pr = document.createElement('div'); pr.className = 'prow' + (row.label === msg.label ? ' self' : '');
      const ico = document.createElement('span'); ico.textContent = row.result === 'yes' ? '✅' : row.result === 'no' ? '⛔' : '❓'; pr.appendChild(ico);
      const pp = document.createElement('span'); pp.className = 'muted'; pp.textContent = 'p' + row.priority; pr.appendChild(pp);
      const a = document.createElement('a'); a.textContent = row.label; a.title = 'Open this event';
      a.addEventListener('click', () => vscode.postMessage({ type: 'openLabel', label: row.label })); pr.appendChild(a);
      const why = document.createElement('span'); why.className = 'why'; why.textContent = row.reasons.join(' · '); why.title = row.reasons.join(String.fromCharCode(10)); pr.appendChild(why);
      d.appendChild(pr);
    });
    box.appendChild(d);
  });
}

function refreshEditor() {
  if (openStmtEditor) {
    const m = (state.markers || []).find((x) => x.kind === openStmtEditor.kind && x.line === openStmtEditor.line);
    if (m) { if (m.kind === 'stats') renderStatsEditor(m); else renderEndEditor(m); return; }
    openStmtEditor = null;
  }
  if (openMenuLine != null) {
    const m = (state.markers||[]).find((x) => x.kind==='menu' && x.line===openMenuLine);
    if (m) { renderMenuEditor(m); return; }
    openMenuLine = null;
  }
  document.getElementById('editor').innerHTML = '';
}

function renderMenuEditor(marker) {
  openMenuLine = marker.line;
  const ed = document.getElementById('editor');
  ed.innerHTML = '';
  const h = document.createElement('h3'); h.className = 'pdhost-head'; h.textContent = 'Menu choices · L' + (marker.line+1);
  const close = document.createElement('button'); close.className = 'alt'; close.textContent = '✕'; close.title = 'Close';
  close.addEventListener('click', () => { openMenuLine = null; ed.innerHTML = ''; });
  h.appendChild(close); ed.appendChild(h);
  const branch = (state.branches||[]).find((b) => b.kind==='menu' && b.line===marker.line);
  (marker.choices||[]).forEach((c, i) => {
    const row = document.createElement('div'); row.className='branch-row';
    const btn = document.createElement('button');
    btn.className = (branch && branch.selected===i) ? '' : 'alt';
    btn.textContent = c.title + (c.target ? '' : ' (unresolved)');
    btn.disabled = !c.target;
    if (branch && c.target) btn.addEventListener('click', () => vscode.postMessage({ type:'selectBranch', id: branch.id, choice: i }));
    row.appendChild(btn);
    const editBtn = document.createElement('button'); editBtn.className='alt'; editBtn.textContent='✏'; editBtn.title='Edit title / target';
    editBtn.addEventListener('click', () => beginMenuChoiceEdit(marker, i, c, row));
    row.appendChild(editBtn);
    const rm = document.createElement('button'); rm.className='alt'; rm.textContent='✕'; rm.title='Remove this choice (its branch label is kept)';
    rm.addEventListener('click', () => vscode.postMessage({ type:'removeMenuChoice', line: marker.line, src: marker.src, index: i, key: c.key }));
    row.appendChild(rm);
    ed.appendChild(row);
  });
  const add = document.createElement('div'); add.className='branch-row';
  const key = document.createElement('input'); key.placeholder = 'decision key'; key.size = 14;
  const title = document.createElement('input'); title.placeholder = 'choice title'; title.style.flex = '1';
  const go = document.createElement('button'); go.textContent = '+ Choice'; go.title = 'Add a choice and create its branch label';
  go.addEventListener('click', () => {
    const k = key.value.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) { key.focus(); return; }
    vscode.postMessage({ type:'addMenuChoice', line: marker.line, src: marker.src, key: k, title: title.value.trim() || k });
  });
  add.appendChild(key); add.appendChild(title); add.appendChild(go);
  ed.appendChild(add);
}

function beginMenuChoiceEdit(marker, i, choice, row) {
  row.innerHTML = '';
  const title = document.createElement('input'); title.type='text'; title.value = choice.title || ''; title.placeholder='Title'; title.style.flex='1'; title.style.minWidth='0';
  const target = document.createElement('input'); target.type='text'; target.value = choice.target || ''; target.placeholder='label.sub target'; target.style.flex='1'; target.style.minWidth='0';
  const save = document.createElement('button'); save.textContent='Save';
  save.addEventListener('click', () => vscode.postMessage({ type:'editMenuChoice', line: marker.line, src: marker.src, choice: i, title: title.value, target: target.value }));
  const cancel = document.createElement('button'); cancel.className='alt'; cancel.textContent='Cancel';
  cancel.addEventListener('click', () => renderMenuEditor(marker));
  row.appendChild(title); row.appendChild(target); row.appendChild(save); row.appendChild(cancel);
  title.focus();
}

// Branch switcher under the timeline: one row per branch point on the previewed path, in walk
// order, indented by nesting depth (if/elif chains and custom menus, nested in each other).
function renderBranchBar() {
  const bar = document.getElementById('branchbar');
  bar.innerHTML = '';
  for (const b of (state.branches||[])) {
    const row = document.createElement('div'); row.className = 'bb-row';
    row.style.paddingLeft = ((b.depth||0) * 14) + 'px';
    if (b.depth) { const t = document.createElement('span'); t.className = 'bb-tree'; t.textContent = '└'; row.appendChild(t); }
    const lbl = document.createElement('span'); lbl.className = 'bb-lbl';
    lbl.textContent = (b.kind === 'menu' ? '☰ ' + (b.title || 'Menu') : '⑂ if') + ' · L' + (b.line+1);
    lbl.title = 'Show in code (line ' + (b.line+1) + ')';
    lbl.addEventListener('click', () => vscode.postMessage({ type:'reveal', line:b.line }));
    row.appendChild(lbl);
    b.options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = 'bb-opt' + (b.selected === i ? '' : ' alt');
      btn.textContent = opt;
      btn.title = opt;
      const off = !!(b.enabled && b.enabled[i] === false);
      btn.disabled = off;
      if (off) btn.title = opt + ' (branch label not found)';
      if (!off && b.selected !== i) btn.addEventListener('click', () => vscode.postMessage({ type:'selectBranch', id:b.id, choice:i }));
      row.appendChild(btn);
    });
    if (b.via && b.via !== 'explicit') {
      const tag = document.createElement('span'); tag.className = 'bb-tag';
      tag.textContent = b.via === 'value' ? 'by value' : 'auto';
      row.appendChild(tag);
    }
    if (b.kind === 'menu') {
      const m = (state.markers||[]).find((x) => x.kind==='menu' && x.line===b.line);
      if (m) {
        const ed = document.createElement('button'); ed.className = 'alt bb-edit'; ed.textContent = '✏'; ed.title = 'Edit menu choices';
        ed.addEventListener('click', () => { showModule(null); renderMenuEditor(m); });
        row.appendChild(ed);
      }
    }
    bar.appendChild(row);
  }
}

function goto(i, animate) {
  const stops = state.stops || [];
  if (!stops.length) return;
  const from = current;
  current = Math.max(0, Math.min(stops.length-1, i));
  const stop = stops[current];
  altIndex = 0;
  renderCaption(stop);
  if (animate && current === from + 1) playInto(stops[from], stop);
  else { finishAnim(); renderStage(withAlt(stop)); }
  document.getElementById('counter').textContent = (current+1)+' / '+stops.length;
  saveView();
  document.getElementById('prev').disabled = current<=0;
  document.getElementById('first').disabled = current<=0;
  document.getElementById('next').disabled = current>=stops.length-1;
  document.getElementById('last').disabled = current>=stops.length-1;
  for (const el of document.querySelectorAll('.card')) el.classList.remove('active');
  const cards = document.querySelectorAll('.card');
  if (cards[current]) { cards[current].classList.add('active'); cards[current].scrollIntoView({ inline:'center', block:'nearest' }); }
}

document.getElementById('first').addEventListener('click', () => goto(0));
// Mouse wheel scrolls the timeline sideways (a trackpad's own horizontal swipe still works).
document.getElementById('timeline').addEventListener('wheel', (e) => {
  const box = document.getElementById('timeline');
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || !e.deltaY) return;
  if (box.scrollWidth <= box.clientWidth) return;
  box.scrollLeft += e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
  e.preventDefault();
}, { passive: false });
document.getElementById('prev').addEventListener('click', () => goto(current-1));
document.getElementById('next').addEventListener('click', () => goto(current+1, true));
document.getElementById('last').addEventListener('click', () => goto((state.stops||[]).length-1));
document.getElementById('reveal').addEventListener('click', () => { const s=(state.stops||[])[current]; if (s) vscode.postMessage({ type:'reveal', line:s.line }); });
document.getElementById('undo').addEventListener('click', () => vscode.postMessage({ type:'undo' }));
document.getElementById('checkbtn').addEventListener('click', openCheck);
document.getElementById('checkclose').addEventListener('click', () => showModule(null));
document.getElementById('simbtn').addEventListener('click', openSim);
document.getElementById('simclose').addEventListener('click', () => showModule(null));
document.getElementById('overviewbtn').addEventListener('click', () => vscode.postMessage({ type: 'openOverview' }));
document.getElementById('optimize').addEventListener('click', () => vscode.postMessage({ type:'optimizeEvent' }));
document.getElementById('pdclose').addEventListener('click', () => showPaperdoll(false));

function showPaperdoll(show) { showModule(show ? 'pd' : null); }

function currentSteps() { return (document.getElementById('imgsteps').value.match(/[0-9]+/g) || []).map(Number); }

function renderImgFmt(msg, isVideo) {
  const host = document.getElementById('imgfmt');
  host.innerHTML = '';
  if (isVideo || !msg.preview || !msg.previewVariants) return;
  host.appendChild(fmtBar(msg.previewVariants, () => {
    document.getElementById('imgpreview').src = pickFormat(msg.preview, msg.previewVariants);
    renderImgFmt(msg, false);
    // The timeline follows the same choice.
    if (state && state.stops && state.stops[current]) { finishAnim(); renderStage(withAlt(state.stops[current])); }
  }));
}

function applyImageEditor(msg) {
  imgState = { line: msg.line, src: msg.src, single: msg.single || null };
  const single = msg.single;
  // One step of a show_image series: the pattern/variable belong to the whole call.
  document.getElementById('imgkey').disabled = !!single;
  document.getElementById('imgkey').title = single ? 'The pattern applies to the whole show_image call — change it in the code' : '';
  document.getElementById('imgscope').textContent = single ? 'Step ' + (single.index + 1) + ' of ' + single.count + ' in this show_image call' + (single.index === single.count - 1 ? ' (last — pause makes it a stop)' : ' (always a stop)') : '';
  const rmStep = document.getElementById('imgremovestep');
  rmStep.style.display = single && single.count > 1 ? '' : 'none';
  const key = document.getElementById('imgkey'); key.innerHTML = '';
  for (const k of msg.keys || []) { const o = document.createElement('option'); o.value = k; o.textContent = k; key.appendChild(o); }
  key.value = msg.patternKey;
  document.getElementById('imgsteps').value = (msg.steps || []).join(', ');
  document.getElementById('imgpause').checked = !!msg.pause;
  document.getElementById('imgsteprow').style.display = msg.hasStep ? '' : 'none';
  document.getElementById('imgvideorow').style.display = msg.hasStep ? '' : 'none';
  document.getElementById('imgisvideo').checked = !!msg.video;
  // A video is one step; pause = True makes it wait for a click (its own stop).
  document.getElementById('imgpauserow').style.display = single ? (single.index === single.count - 1 ? '' : 'none') : (msg.hasStep && (msg.video || (msg.steps || []).length > 1)) ? '' : 'none';
  document.getElementById('imgpausetxt').textContent = msg.video ? 'Pause (wait for click)' : single ? 'Pause after this last step' : 'Pause after last';
  document.getElementById('imgvideorow').style.display = msg.hasStep && !single ? '' : 'none';
  document.getElementById('imgsteps').placeholder = msg.video || single ? '0' : '0  or  0, 1, 2';
  const prev = document.getElementById('imgpreview');
  const vid = document.getElementById('imgvideo');
  const v = msg.video ? msg.videoView : null;
  if (v && v.src) {
    if (vid._src !== v.src) { vid._src = v.src; vid.src = v.src; }
    vid.loop = !!v.loop; vid.poster = msg.preview || '';
    vid.style.display = ''; prev.style.display = 'none';
    if (vid.play) { const p = vid.play(); if (p && p.catch) p.catch(() => {}); }
  } else {
    if (vid.pause) vid.pause();
    vid.style.display = 'none';
    prev.style.display = msg.preview ? '' : 'none'; prev.src = pickFormat(msg.preview || '', msg.previewVariants);
  }
  renderImgFmt(msg, !!(v && v.src));
  renderMoviePanel(msg);
  document.getElementById('imgcall').textContent = msg.call || '';
  document.getElementById('imgmissing').textContent = msg.missing ? 'No patterns found for this event.' : '';
  showModule('img');
}

// Movie declaration status of the video step + the actions to fix it.
function renderMoviePanel(msg) {
  const box = document.getElementById('imgmovie');
  box.innerHTML = '';
  if (!msg.video) return;
  const v = msg.videoView;
  if (!v) { const p = document.createElement('div'); p.className = 'bad'; p.textContent = 'No pattern image for this step — the video name cannot be derived.'; box.appendChild(p); return; }
  const head = document.createElement('div');
  const code = document.createElement('code'); code.textContent = v.name; head.appendChild(code);
  const st = document.createElement('span');
  st.className = v.defined ? 'ok' : 'bad';
  st.textContent = v.defined ? '  ✔ Movie defined' + (v.defFile ? ' in ' + v.defFile : '') : '  ⚠ no Movie definition — the game cannot show it';
  head.appendChild(st); box.appendChild(head);
  const path = document.createElement('div'); path.className = 'path';
  path.textContent = '▶ ' + v.play + (v.src ? '' : '  (file missing)');
  box.appendChild(path);
  const row = document.createElement('div'); row.className = 'branch-row';
  const lab = document.createElement('label');
  const loop = document.createElement('input'); loop.type = 'checkbox'; loop.id = 'imgloop'; loop.checked = !!v.loop;
  lab.appendChild(loop); const lt = document.createElement('span'); lt.textContent = ' Loop'; lab.appendChild(lt);
  lab.title = v.defined ? 'Edits loop = True on the Movie definition' : 'Loop setting for the definition to add';
  row.appendChild(lab);
  const payload = (extra) => Object.assign({ line: imgState.line, src: imgState.src, patternKey: document.getElementById('imgkey').value, steps: currentSteps(), pause: document.getElementById('imgpause').checked, loop: loop.checked }, extra);
  if (v.defined) {
    loop.addEventListener('change', () => vscode.postMessage(payload({ type:'movieLoop' })));
  } else {
    const add = document.createElement('button'); add.textContent = '＋ Movie definition';
    add.title = 'Add image ' + v.name + ' = Movie(play = …webm, start_image = …webp) next to the event';
    add.disabled = !v.src;
    add.addEventListener('click', () => vscode.postMessage(payload({ type:'movieAdd', all: false })));
    const all = document.createElement('button'); all.className = 'alt'; all.textContent = '＋ all variants';
    all.title = 'Add the definitions for every placeholder variant of this step that has a video file (e.g. each school_level)';
    all.addEventListener('click', () => vscode.postMessage(payload({ type:'movieAdd', all: true })));
    row.appendChild(add); row.appendChild(all);
  }
  box.appendChild(row);
}

function imgPayload(type) {
  const p = { type, line: imgState.line, src: imgState.src, patternKey: document.getElementById('imgkey').value, steps: currentSteps(), pause: document.getElementById('imgpause').checked, video: document.getElementById('imgisvideo').checked };
  if (imgState.single) { p.stepIndex = imgState.single.index; p.stepCount = imgState.single.count; p.steps = p.steps.slice(0, 1); p.video = false; }
  return p;
}
document.getElementById('imgremovestep').addEventListener('click', () => { if (imgState && imgState.single) vscode.postMessage(imgPayload('imgRemoveStep')); });
function imgChanged() {
  if (!imgState) return;
  vscode.postMessage(imgPayload('imgChange'));
}
document.getElementById('imgkey').addEventListener('change', imgChanged);
document.getElementById('imgsteps').addEventListener('change', imgChanged);
document.getElementById('imgpause').addEventListener('change', imgChanged);
document.getElementById('imgisvideo').addEventListener('change', imgChanged);
document.getElementById('imgapply').addEventListener('click', () => { if (imgState) vscode.postMessage(imgPayload('imgApply')); });
document.getElementById('imgclose').addEventListener('click', () => showModule(null));
document.getElementById('imgremove').addEventListener('click', () => { if (imgState) vscode.postMessage({ type: 'imgRemove', line: imgState.line, src: imgState.src }); });

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'imageEditor') { applyImageEditor(msg); return; }
  if (msg.type === 'imagesChanged') { if (currentModule === 'img' && imgState) vscode.postMessage(imgPayload('imgChange')); return; }
  if (msg.type === 'bgEditor') { applyBgEditor(msg); return; }
  if (msg.type === 'closeModule') { if (currentModule === msg.module) showModule(null); return; }
  if (msg.type === 'check:running') { checkState = null; renderCheck(); return; }
  if (msg.type === 'check:result') { checkState = msg.error ? { error: msg.error } : msg.result; renderCheck(); return; }
  if (msg.type === 'sim:init') { simDefaults = msg.state; renderSimForm(msg.state); postSim(); return; }
  if (msg.type === 'sim:result') { renderSim(msg); return; }
  if (msg.type !== 'timeline') return;
  const prev = state;
  const prevCurrent = current;
  state = msg;
  document.getElementById('title').textContent = msg.eventLabel ? 'Event · ' + msg.eventLabel : 'Event';
  const stage = document.getElementById('stage');
  if (msg.missing || !(msg.stops||[]).length) {
    stage.innerHTML=''; document.getElementById('timeline').innerHTML='<div class="empty">No dialogue stops found for this event.</div>';
    document.getElementById('caption').innerHTML=''; document.getElementById('editor').innerHTML='';
    state.branches = msg.branches || []; renderBranchBar();
    document.getElementById('counter').textContent='0 / 0';
    return;
  }
  current = msg.keep && prev && prev.stops && prev.stops.length
    ? keptIndex(prev.stops, prevCurrent, msg.stops)
    : Math.max(0, Math.min((msg.stops.length-1), msg.current||0));
  const restore = restoreView && restoreView.eventLabel === msg.eventLabel ? restoreView : null;
  restoreView = null;
  if (restore && typeof restore.current === 'number') current = Math.max(0, Math.min(msg.stops.length - 1, restore.current));
  if (restore && restore.module) setTimeout(() => reopenModule(restore.module), 0);
  renderTimeline();
  renderValues(msg);
  renderBranchBar();
  renderEffects();
  refreshEditor();
  goto(current);
  if (msg.editLine != null) {
    const st = (msg.stops || []).find((s) => s.line === msg.editLine && s.kind === 'dialog');
    if (st) {
      goto(st.index);
      const span = document.getElementById('caption').querySelector('.txt');
      if (span) beginEdit(st, span);
    }
  }
});
window.addEventListener('resize', () => { if (anim) applyStyles(); else if (state && state.stops && state.stops[current]) renderStage(withAlt(state.stops[current])); });
