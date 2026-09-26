// Webview script (paperdollEditor.js). Plain browser JavaScript, bundled by scripts/build-webview.js.
// Field list (labels, head/body group) is passed by the extension as JSON.
const PD_FIELDS = JSON.parse(document.getElementById('pd-fields').textContent);

function mountPaperdollEditor(vscode) {
  const FIELDS = PD_FIELDS;
  const $ = (id) => document.getElementById('pd' + id);
  const images = new Map();
  let state = null;
  let presets = [];
  let resizeRedraw;
  window.addEventListener('resize', () => { clearTimeout(resizeRedraw); resizeRedraw = setTimeout(() => { if (state) void renderStage(); }, 80); });

  function img(url) {
    if (!url) return Promise.resolve(null);
    const hit = images.get(url); if (hit) return hit;
    const pending = new Promise((resolve) => { const el = new Image(); el.onload = () => resolve(el); el.onerror = () => resolve(null); el.src = url; });
    images.set(url, pending); return pending;
  }
  function draft() {
    const values = {}, include = {};
    for (const f of FIELDS) { values[f.field] = $('v-' + f.field).value; include[f.field] = $('c-' + f.field).checked; }
    return { personKey: $('character').value, variable: $('variable').value.trim(), values, include,
      config: { alignX: Number($('alignX').value), alignY: Number($('alignY').value), zoom: Number($('zoom').value),
        flip: $('flip').checked ? -1 : 1, blur: state?.config?.blur || 0, bw: !!state?.config?.bw, color: state?.config?.color || '#00000000' },
      duration: Number($('duration').value) || 0,
      before: state?.before || { alignX: -0.5, alignY: 0, zoom: 1, flip: 1, blur: 0, bw: false, color: '#00000000' } };
  }
  function buildFields() {
    for (const f of FIELDS) {
      const cell = document.createElement('div'); cell.className = 'cell';
      cell.innerHTML = '<label class="top"><input type="checkbox" id="pdc-' + f.field + '" />' + f.label + '</label><select id="pdv-' + f.field + '"></select>';
      $(f.group).appendChild(cell);
      $('v-' + f.field).addEventListener('change', () => vscode.postMessage({ type: 'pd:change', field: f.field, ...draft() }));
    }
  }
  function fillSelect(id, options, value) {
    const el = $(id); const opts = options && options.length ? options : (value ? [value] : []); el.innerHTML = '';
    for (const opt of opts) { const n = document.createElement('option'); n.value = opt; n.textContent = opt; el.appendChild(n); }
    if (value && [...el.options].some((o) => o.value === value)) el.value = value;
  }
  function setSliders(config, duration) { bindNum('alignX', config.alignX); bindNum('alignY', config.alignY); bindNum('zoom', config.zoom); bindNum('duration', duration || 0); $('flip').checked = config.flip < 0; }
  function bindNum(id, value) { $(id).value = String(value); $(id + 'n').value = String(Math.round(value * 1000) / 1000); }
  function place(config) { const w = 600 * config.zoom, h = 1080 * config.zoom; const anchor = Math.min(1, Math.max(0, config.alignX)); const left = config.alignX * 1920 - anchor * w; return { left: (left / 1920) * 100, top: config.alignY * 100, width: (w / 1920) * 100, height: (h / 1080) * 100 }; }
  async function drawDoll(canvas, doll) {
    const body = await img(doll.body), head = await img(doll.head);
    const srcW = Math.max(body ? body.naturalWidth : 0, head ? head.naturalWidth : 0) || 1200;
    const srcH = Math.max(body ? body.naturalHeight : 0, head ? head.naturalHeight : 0) || 2160;
    const box = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1; let scale = 1;
    if (box.width > 2 && box.height > 2) scale = Math.min(1, (box.width * dpr) / srcW, (box.height * dpr) / srcH);
    const w = Math.max(1, Math.round(srcW * scale)), h = Math.max(1, Math.round(srcH * scale));
    canvas.width = w; canvas.height = h; const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.clearRect(0, 0, w, h); ctx.save();
    if (doll.config.flip < 0) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    if (doll.config.bw) ctx.filter = 'grayscale(1)';
    if (body) ctx.drawImage(body, 0, 0, w, h); if (head) ctx.drawImage(head, 0, 0, w, h); ctx.filter = 'none';
    const tint = doll.config.tint;
    if (tint && tint.a > 0.004) { ctx.globalCompositeOperation = 'source-atop'; ctx.fillStyle = 'rgba(' + tint.r + ',' + tint.g + ',' + tint.b + ',' + tint.a + ')'; ctx.fillRect(0, 0, w, h); }
    ctx.restore();
  }
  async function renderStage() {
    const stage = $('stage'); stage.innerHTML = ''; const bg = state.background || {};
    if (bg.split) { if (bg.src) addBg(stage, bg.src, '0', '50%', bg.blur); if (bg.src2) addBg(stage, bg.src2, '50%', '50%', bg.blur); }
    else if (bg.src) addBg(stage, bg.src, '0', '100%', bg.blur);
    const d = draft();
    const dolls = (state.dolls || []).map((doll) => doll.variable === d.variable
      ? { ...doll, body: state.activeBody ?? doll.body, head: state.activeHead ?? doll.head, config: { ...doll.config, ...d.config, tint: doll.config.tint } } : doll);
    for (const doll of dolls) {
      const box = place(doll.variable === d.variable ? d.config : doll.config);
      const el = document.createElement('div'); el.className = 'pd-doll' + (doll.variable === d.variable ? ' active' : '');
      el.style.left = box.left + '%'; el.style.top = box.top + '%'; el.style.width = box.width + '%'; el.style.height = box.height + '%';
      const canvas = document.createElement('canvas'); el.appendChild(canvas);
      el.addEventListener('click', () => { $('character').value = doll.personKey; vscode.postMessage({ type: 'pd:character', personKey: doll.personKey }); });
      stage.appendChild(el);
      void drawDoll(canvas, doll.variable === d.variable ? { ...doll, config: { ...doll.config, ...d.config, tint: doll.config.tint } } : doll);
    }
  }
  function addBg(stage, src, left, width, blur) { const el = document.createElement('img'); el.className = 'bg'; el.src = src; el.style.left = left; el.style.width = width; el.style.objectFit = 'cover'; if (blur) el.style.filter = 'blur(8px)'; stage.appendChild(el); }
  function applyScene(msg) {
    state = msg; presets = msg.presets || [];
    const character = $('character'); character.innerHTML = '';
    const onStage = new Set((msg.dolls || []).map((d) => d.personKey));
    const groups = [['On stage', (msg.characters || []).filter((c) => onStage.has(c.key))], ['All', (msg.characters || []).filter((c) => !onStage.has(c.key))]];
    for (const [label, list] of groups) { if (!list.length) continue; const g = document.createElement('optgroup'); g.label = label; for (const item of list) { const o = document.createElement('option'); o.value = item.key; o.textContent = item.label; g.appendChild(o); } character.appendChild(g); }
    character.value = msg.personKey; $('variable').value = msg.variable;
    for (const f of FIELDS) { fillSelect('v-' + f.field, (msg.options || {})[f.field], (msg.values || {})[f.field]); $('c-' + f.field).checked = !!(msg.include || {})[f.field]; }
    setSliders(msg.config, msg.duration);
    $('snippet').textContent = msg.snippet || ''; $('note').textContent = msg.note || '';
    $('files').textContent = [msg.bodyName, msg.headName].filter(Boolean).join('  ·  ');
    $('eventTitle').textContent = msg.eventLabel ? 'Event · ' + msg.eventLabel : 'Event';
    $('heading').textContent = msg.bound === 'insert' ? 'Insert at line ' + (msg.line + 1) : (msg.bound === 'register' ? 'Register' : 'Display') + ' · line ' + (msg.line + 1);
    $('apply').style.display = msg.bound === 'insert' ? 'none' : '';
    $('missing').textContent = msg.missingCatalog ? 'No paperdoll folder found. Open the game workspace or set mtsEventManager.imageRoots.' : '';
    const presetBox = $('presets'); presetBox.innerHTML = '';
    for (const preset of presets) {
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'alt'; btn.textContent = preset.name;
      btn.addEventListener('click', () => {
        const before = state.before || draft().before; const next = { ...before };
        for (const move of preset.moves) { if (move.alignX !== undefined) next.alignX = move.alignX; if (move.alignY !== undefined) next.alignY = move.alignY; if (move.zoom !== undefined) next.zoom = move.zoom; }
        setSliders(next, Number($('duration').value) || 0); state.config = { ...state.config, ...next }; void renderStage(); vscode.postMessage({ type: 'pd:draft', ...draft() });
      });
      presetBox.appendChild(btn);
    }
    state.activeBody = (msg.dolls || []).find((d) => d.variable === msg.variable)?.body || '';
    state.activeHead = (msg.dolls || []).find((d) => d.variable === msg.variable)?.head || '';
    void renderStage();
  }
  function applyPatch(msg) {
    if (!state) return;
    if (msg.resetControls && msg.config) {
      state.config = msg.config; state.before = msg.before || state.before; setSliders(msg.config, msg.duration || 0);
      if (msg.variable) $('variable').value = msg.variable;
      if (msg.include) for (const f of FIELDS) $('c-' + f.field).checked = !!msg.include[f.field];
    }
    for (const f of FIELDS) if (msg.options) fillSelect('v-' + f.field, msg.options[f.field], (msg.values || {})[f.field]);
    const variable = $('variable').value.trim();
    let active = (state.dolls || []).find((d) => d.variable === variable);
    if (!active && msg.resetControls) { active = { variable, personKey: $('character').value, config: Object.assign({ tint: { r: 0, g: 0, b: 0, a: 0 } }, msg.config || {}), body: '', head: '' }; state.dolls = (state.dolls || []).concat([active]); }
    if (active) { active.body = msg.body || ''; active.head = msg.head || ''; if (msg.config) active.config = Object.assign({}, active.config, msg.config); }
    state.activeBody = msg.body || ''; state.activeHead = msg.head || '';
    if (msg.snippet !== undefined) $('snippet').textContent = msg.snippet;
    if (msg.note !== undefined) $('note').textContent = msg.note;
    $('files').textContent = [msg.bodyName, msg.headName].filter(Boolean).join('  ·  ');
    void renderStage();
  }
  for (const id of ['alignX', 'alignY', 'zoom', 'duration']) {
    $(id).addEventListener('input', () => { $(id + 'n').value = $(id).value; if (state) state.config = { ...state.config, ...draft().config }; void renderStage(); vscode.postMessage({ type: 'pd:draft', ...draft() }); });
    $(id + 'n').addEventListener('change', () => { $(id).value = $(id + 'n').value; if (state) state.config = { ...state.config, ...draft().config }; void renderStage(); vscode.postMessage({ type: 'pd:draft', ...draft() }); });
  }
  $('flip').addEventListener('change', () => { if (state) state.config = { ...state.config, ...draft().config }; void renderStage(); vscode.postMessage({ type: 'pd:draft', ...draft() }); });
  $('character').addEventListener('change', () => vscode.postMessage({ type: 'pd:character', personKey: $('character').value }));
  $('variable').addEventListener('change', () => vscode.postMessage({ type: 'pd:draft', ...draft() }));
  $('apply').addEventListener('click', () => vscode.postMessage({ type: 'pd:apply', ...draft() }));
  $('insertDisplay').addEventListener('click', () => vscode.postMessage({ type: 'pd:insertDisplay', ...draft() }));
  $('insertRegister').addEventListener('click', () => vscode.postMessage({ type: 'pd:insertRegister', ...draft() }));
  $('optimize').addEventListener('click', () => vscode.postMessage({ type: 'pd:optimize', ...draft() }));
  $('insertAtCursor').addEventListener('click', () => vscode.postMessage({ type: 'pd:insertAtCursor', ...draft() }));
  $('copy').addEventListener('click', () => vscode.postMessage({ type: 'pd:copy', text: $('snippet').textContent }));
  $('reload').addEventListener('click', () => vscode.postMessage({ type: 'pd:refreshAssets' }));
  buildFields();
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'pd:scene') applyScene(msg);
    else if (msg.type === 'pd:patch') applyPatch(msg);
    else if (msg.type === 'pd:snippet') { $('snippet').textContent = msg.snippet || ''; $('note').textContent = msg.note || ''; }
  });
}
