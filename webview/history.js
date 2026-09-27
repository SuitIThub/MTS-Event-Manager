// Webview script (history.js): the change history — every code change of the event manager as
// a diff per block, with "Revert block" / "Revert change" / "Show in code".
const vscode = acquireVsCodeApi();
let entries = [];
let collapsed = new Set();
const saved = (typeof vscode.getState === 'function' && vscode.getState()) || {};
let fileFilter = saved.file || '';
let hideReverted = !!saved.hideReverted;
if (Array.isArray(saved.collapsed)) collapsed = new Set(saved.collapsed);

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const save = () => {
  if (typeof vscode.setState === 'function') vscode.setState({ file: fileFilter, hideReverted, collapsed: [...collapsed] });
};
const when = (t) => {
  const d = new Date(t);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? time : d.toLocaleDateString() + ' ' + time;
};
const STATE_TEXT = { applied: '', reverted: 'reverted', changed: 'edited since' };

function renderFilter() {
  const sel = document.getElementById('file');
  const files = [...new Set(entries.map((e) => e.file))].sort();
  sel.innerHTML = '';
  const all = el('option', '', 'All files');
  all.value = '';
  sel.appendChild(all);
  for (const f of files) {
    const o = el('option', '', f);
    o.value = f;
    sel.appendChild(o);
  }
  if (fileFilter && !files.includes(fileFilter)) fileFilter = '';
  sel.value = fileFilter;
}

function diffBlock(h) {
  const pre = el('pre');
  const add = (cls, prefix, text) => pre.appendChild(el('span', 'ln ' + cls, prefix + ' ' + text));
  for (const l of h.before) add('ctx', ' ', l);
  for (const l of h.removed) add('del', '-', l);
  for (const l of h.added) add('add', '+', l);
  for (const l of h.after) add('ctx', ' ', l);
  if (!h.removed.length && !h.added.length) add('ctx', ' ', '(whitespace only)');
  return pre;
}

function render() {
  renderFilter();
  const list = document.getElementById('list');
  list.innerHTML = '';
  const shown = entries.filter((e) => (!fileFilter || e.file === fileFilter) && (!hideReverted || e.hunks.some((h) => h.state === 'applied')));
  document.getElementById('count').textContent = shown.length + ' of ' + entries.length + ' changes';
  if (!shown.length) {
    list.appendChild(el('div', 'empty', entries.length ? 'No changes match the filter.' : 'No changes recorded yet. Every code change made through the event manager appears here.'));
    return;
  }
  for (const e of shown) {
    const card = el('div', 'entry' + (collapsed.has(e.id) ? ' collapsed' : ''));
    const head = el('div', 'head');
    head.appendChild(el('span', 'label', e.label));
    head.appendChild(el('span', 'meta', when(e.time) + ' · ' + e.file));
    if (e.revertOf != null) head.appendChild(el('span', 'badge', 'revert of #' + e.revertOf));
    const applied = e.hunks.filter((h) => h.state === 'applied').length;
    if (applied === 0) {
      const any = e.hunks.some((h) => h.state === 'changed');
      head.appendChild(el('span', 'badge ' + (any ? 'changed' : 'reverted'), any ? 'edited since' : 'reverted'));
    }
    head.appendChild(el('span', 'grow'));
    head.lastChild.style.flex = '1';
    head.appendChild(el('span', 'meta', '#' + e.id + ' · ' + e.hunks.length + (e.hunks.length === 1 ? ' block' : ' blocks')));
    const all = el('button', 'primary', e.hunks.length > 1 ? 'Revert change' : 'Revert');
    all.title = 'Revert every block of this change that is still in the code';
    all.disabled = applied === 0;
    all.addEventListener('click', (ev) => { ev.stopPropagation(); vscode.postMessage({ type: 'revert', id: e.id }); });
    head.appendChild(all);
    head.addEventListener('click', () => {
      if (collapsed.has(e.id)) collapsed.delete(e.id); else collapsed.add(e.id);
      card.classList.toggle('collapsed');
      save();
    });
    card.appendChild(head);
    const body = el('div', 'body');
    for (const h of e.hunks) {
      const block = el('div', 'hunk state-' + h.state);
      const bar = el('div', 'hunkbar');
      bar.appendChild(el('span', 'where', 'Block ' + (h.index + 1) + ' · line ' + (h.line + 1)));
      if (STATE_TEXT[h.state]) bar.appendChild(el('span', 'badge ' + h.state, STATE_TEXT[h.state]));
      if (e.hunks.length > 1) {
        const rb = el('button', '', 'Revert block');
        rb.title = 'Revert only this block';
        rb.disabled = h.state !== 'applied';
        rb.addEventListener('click', () => vscode.postMessage({ type: 'revert', id: e.id, hunks: [h.index] }));
        bar.appendChild(rb);
      }
      const show = el('button', '', 'Show in code');
      show.addEventListener('click', () => vscode.postMessage({ type: 'reveal', id: e.id, hunk: h.index }));
      bar.appendChild(show);
      block.appendChild(bar);
      block.appendChild(diffBlock(h));
      body.appendChild(block);
    }
    card.appendChild(body);
    list.appendChild(card);
  }
}

document.getElementById('file').addEventListener('change', (ev) => { fileFilter = ev.target.value; save(); render(); });
const hide = document.getElementById('hideReverted');
hide.checked = hideReverted;
hide.addEventListener('change', () => { hideReverted = hide.checked; save(); render(); });
document.getElementById('clear').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));

window.addEventListener('message', (event) => {
  const m = event.data;
  if (m && m.type === 'history') {
    entries = m.entries || [];
    if (m.focusFile) {
      const hit = entries.find((e) => e.uri === m.focusFile);
      if (hit) fileFilter = hit.file;
    }
    render();
  }
});
// Keep a state from the start: VS Code restores only panels that have one (reload, move to another window).
save();
vscode.postMessage({ type: 'ready' });
