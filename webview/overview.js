// Webview script (overview.js). Plain browser JavaScript, bundled by scripts/build-webview.js.
const vscode = acquireVsCodeApi();
let data = null;
const status = {};
let onlyBad = false;
const collapsed = {};
function matches(r, group, q) {
  if (onlyBad) { const s = status[r.label]; if (!s || (!s.errors && !s.warnings && !s.error)) return false; }
  if (!q) return true;
  const hay = (r.label + ' ' + group + ' ' + r.conditions + ' ' + r.selectors + ' ' + r.file).toLowerCase();
  return q.split(' ').every((w) => !w || hay.indexOf(w) >= 0);
}
function statusText(s) {
  if (!s) return { cls: 'muted', text: '' };
  if (s.pending) return { cls: 'muted', text: '… checking' };
  if (s.error) return { cls: 'bad', text: '⛔ ' + s.error };
  if (s.errors) return { cls: 'bad', text: '⛔ ' + s.errors + ' error(s)' + (s.missing ? ' · ' + s.missing + ' image(s) missing' : '') + (s.first ? ' — ' + s.first : '') };
  if (s.warnings) return { cls: 'warn', text: '⚠ ' + s.warnings + ' warning(s)' + (s.first ? ' — ' + s.first : '') };
  return { cls: 'ok', text: '✅ ok · ' + s.paths + ' path(s)' };
}
function visibleLabels() {
  const q = document.getElementById('filter').value.trim().toLowerCase();
  const out = [];
  (data ? data.groups : []).forEach((g) => g.labels.forEach((l) => { const r = data.rows[l]; if (r && matches(r, g.name, q) && out.indexOf(l) < 0) out.push(l); }));
  return out;
}
function render() {
  const list = document.getElementById('list'); list.innerHTML = '';
  if (!data) { list.textContent = 'Loading…'; return; }
  const q = document.getElementById('filter').value.trim().toLowerCase();
  let shown = 0;
  data.groups.forEach((g) => {
    const rows = g.labels.map((l) => data.rows[l]).filter((r) => r && matches(r, g.name, q));
    if (!rows.length) return;
    const box = document.createElement('div'); box.className = 'group';
    const h = document.createElement('h3'); h.textContent = (collapsed[g.name] ? '▸ ' : '▾ ') + g.name + '  (' + rows.length + ')';
    h.addEventListener('click', () => { collapsed[g.name] = !collapsed[g.name]; render(); });
    box.appendChild(h);
    if (!collapsed[g.name]) {
      const grid = document.createElement('div'); grid.className = 'rows';
      rows.forEach((r) => {
        shown++;
        const row = document.createElement('div'); row.className = 'row'; row.title = r.file + ':' + (r.line + 1);
        const img = document.createElement('img'); img.className = 'thumb'; if (r.thumb) img.src = r.thumb; row.appendChild(img);
        const info = document.createElement('div'); info.className = 'info';
        const n = document.createElement('div'); n.className = 'name'; n.textContent = r.label; info.appendChild(n);
        const m = document.createElement('div'); m.className = 'meta'; m.textContent = r.kind + (r.priority ? ' · prio ' + r.priority : '') + ' · ' + r.file + (r.hasLabel ? '' : ' · ⚠ no scene label'); info.appendChild(m);
        const c = document.createElement('div'); c.className = 'conds'; c.textContent = r.conditions || 'no conditions'; c.title = r.conditions; info.appendChild(c);
        if (r.selectors) { const s = document.createElement('div'); s.className = 'sels'; s.textContent = 'selectors: ' + r.selectors; info.appendChild(s); }
        const st = statusText(status[r.label]);
        const sd = document.createElement('div'); sd.className = 'status ' + st.cls; sd.textContent = st.text; sd.title = st.text; info.appendChild(sd);
        row.appendChild(info);
        row.addEventListener('click', () => vscode.postMessage({ type: 'open', label: r.label }));
        grid.appendChild(row);
      });
      box.appendChild(grid);
    }
    list.appendChild(box);
  });
  document.getElementById('count').textContent = shown + ' event(s)';
}
document.getElementById('filter').addEventListener('input', render);
document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
document.getElementById('onlybad').addEventListener('click', () => { onlyBad = !onlyBad; document.getElementById('onlybad').className = onlyBad ? '' : 'alt'; render(); });
document.getElementById('checkall').addEventListener('click', () => {
  const labels = visibleLabels();
  labels.forEach((l) => { status[l] = { pending: true }; });
  document.getElementById('checkall').disabled = true;
  render();
  vscode.postMessage({ type: 'check', labels });
});
window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'overview') { data = msg; render(); }
  else if (msg.type === 'status') { status[msg.label] = msg; render(); }
  else if (msg.type === 'checkDone') { document.getElementById('checkall').disabled = false; }
});
// Also after VS Code reloads the page (panel moved into another window).
vscode.postMessage({ type: 'refresh' });
