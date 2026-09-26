// Webview script (eventDefEditor.js). Plain browser JavaScript, bundled by scripts/build-webview.js.
function mountEventDefEditor(vscode) {
  var root = document.getElementById('defroot');
  var state = null;
  var sel = 0;
  var openAdd = null;
  var rawOpen = {};
  var lastError = '';

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(text, cls, fn, title) { var b = el('button', cls || '', text); if (title) b.title = title; b.addEventListener('click', fn); return b; }
  function post(type, extra) { var m = { type: type }; for (var k in extra) m[k] = extra[k]; vscode.postMessage(m); }
  function cur() { return state && state.defs[sel]; }
  function op(o, expect, typed) { var d = cur(); lastError = ''; post('def:op', { uri: d.uri, start: d.start, op: o, expect: expect, typed: typed }); }

  window.addEventListener('message', function (ev) {
    var msg = ev.data;
    if (msg.type === 'def:model') { state = msg; if (sel >= state.defs.length) sel = 0; render(); }
    else if (msg.type === 'def:error') { lastError = msg.message; render(); }
  });

  function typedEditor(decoded, onCommit) {
    var k = decoded.kind;
    if (k === 'bool') {
      var s = el('select');
      ['True', 'False'].forEach(function (v) { var o = el('option', '', v); o.value = v; s.appendChild(o); });
      s.value = decoded.value;
      s.addEventListener('change', function () { onCommit({ kind: 'bool', value: s.value }); });
      return s;
    }
    var i = el('input', k === 'string' ? 'val' : 'val code');
    i.type = k === 'number' ? 'number' : 'text';
    i.value = decoded.value;
    if (k === 'expr' || k === 'none') i.title = 'Python expression';
    i.addEventListener('change', function () {
      if (k === 'string') onCommit({ kind: 'string', value: i.value, quote: decoded.quote || '"' });
      else if (k === 'number') onCommit({ kind: 'number', value: i.value });
      else onCommit({ kind: 'expr', value: i.value });
    });
    i.addEventListener('keydown', function (e) { if (e.key === 'Enter') i.blur(); });
    return i;
  }

  function typeTag(decoded) { return el('span', 't', decoded.kind === 'expr' ? 'code' : decoded.kind); }

  var expanded = {};
  var COMBI = { AND: 'all of', OR: 'any of', NOR: 'none of', XOR: 'one of', NOT: 'not' };
  function exKey(path) { return cur().start + ':' + path.join('.'); }
  function isOpen(path, dflt) { var k = exKey(path); return expanded[k] !== undefined ? expanded[k] : dflt; }
  function toggle(path, open) { expanded[exKey(path)] = open; render(); }

  /** One-line summary of a call's arguments: weekday=d · daytime=c */
  function summaryOf(node) {
    return node.fields.map(function (f) {
      var v = f.node ? f.node.name + '(' + (f.node.fields.length ? '…' : '') + ')' : (f.decoded.kind === 'string' ? f.decoded.value : f.code);
      if (v.length > 28) v = v.slice(0, 27) + '…';
      return f.role === 'positional' || f.role === 'vararg' ? v : f.label + '=' + v;
    }).join(' · ');
  }

  /** Collapsed call: a compact chip with its summary. Click to expand in place. */
  function chip(node, path, code, removable) {
    var c = el('span', 'chip');
    c.appendChild(el('span', 'nm', node.name));
    var s = summaryOf(node); if (s) c.appendChild(el('span', 'sum', s));
    c.title = code;
    c.addEventListener('click', function () { toggle(path, true); });
    if (removable) {
      var x = btn('✕', 'x', function (e) { if (e && e.stopPropagation) e.stopPropagation(); op({ op: 'remove', path: path }, code); }, 'Remove');
      c.appendChild(x);
    }
    return c;
  }

  /** A plain value field: small label on top, editor below. Laid out in a grid. */
  // ── Value domains: what a parameter means and which values make sense ──
  var dlSeq = 0;
  function classDomOf(cls) { var d = cur(); return d && d.domains && cls ? d.domains[cls] || null : null; }
  function domOf(cls, label) {
    var c = classDomOf(cls); if (!c) return null;
    var name = String(label).replace(/[[][0-9]+[]]$/, '');
    return c.params[name] || null;
  }
  function docOf(cls) { var c = classDomOf(cls); return c && c.doc ? c.doc : ''; }
  /** Curated + used values; for e.g. ValueCondition.value also the values of the chosen selector key. */
  function optionsFor(dom, node) {
    if (!dom) return [];
    var extra = [];
    if (dom.valuesOfParam && node) {
      var sib = node.fields.find(function (x) { return x.label === dom.valuesOfParam; });
      var key = sib && sib.decoded ? sib.decoded.value : '';
      var vals = key && cur().selectorValues ? cur().selectorValues[key] : null;
      (vals || []).forEach(function (v) { extra.push({ value: v, label: 'from ' + key }); });
    }
    var out = extra.slice();
    (dom.options || []).forEach(function (o) { if (!out.some(function (x) { return x.value === o.value; })) out.push(o); });
    return out;
  }
  function attachList(input, opts, host) {
    var list = opts.filter(function (o) { return o.value !== ''; });
    if (!list.length) return;
    var id = 'dl' + (++dlSeq);
    var dl = el('datalist'); dl.id = id;
    list.forEach(function (o) { var oo = el('option'); oo.value = o.value; if (o.label) oo.label = o.label; dl.appendChild(oo); });
    input.setAttribute('list', id);
    input.title = (input.title ? input.title + ' · ' : '') + 'Suggestions: ' + list.slice(0, 8).map(function (o) { return o.value; }).join(', ') + (list.length > 8 ? ' …' : '');
    host.appendChild(dl);
  }
  function meaningOf(opts, value) {
    var o = opts.find(function (x) { return x.value === value; });
    return o && o.label && o.label.indexOf('used ') !== 0 ? o.label : '';
  }

  function fieldCell(f, p, node) {
    var cell = el('div', 'fcell');
    var top = el('div', 'ftop');
    var lbl = el('span', 'flbl', f.label);
    top.appendChild(lbl);
    top.appendChild(typeTag(f.decoded));
    if (f.role !== 'positional') top.appendChild(btn('✕', 'x', function () { op({ op: 'remove', path: p }, f.code); }, 'Remove'));
    cell.appendChild(top);
    var commit = function (t) { op({ op: 'setValue', path: p }, f.code, t); };
    var dom = node ? domOf(node.name, f.label) : null;
    if (dom && dom.help) lbl.title = dom.help;
    var opts = optionsFor(dom, node);
    if (dom && dom.strict && f.decoded.kind === 'string') {
      // Fixed vocabulary (e.g. comparison operators): a dropdown, current value kept.
      var s = el('select');
      if (!opts.some(function (o) { return o.value === f.decoded.value; })) opts = [{ value: f.decoded.value }].concat(opts);
      opts.forEach(function (o) { var oo = el('option', '', o.value + (o.label ? ' — ' + o.label : '')); oo.value = o.value; s.appendChild(oo); });
      s.value = f.decoded.value;
      s.addEventListener('change', function () { commit({ kind: 'string', value: s.value, quote: f.decoded.quote || '"' }); });
      cell.appendChild(s);
    } else {
      var ed = typedEditor(f.decoded, commit);
      cell.appendChild(ed);
      if (ed.tagName === 'INPUT' && (f.decoded.kind === 'string' || f.decoded.kind === 'number')) attachList(ed, opts, cell);
    }
    var mean = meaningOf(opts, f.decoded.value);
    if (mean) cell.appendChild(el('span', 'fhelp', mean));
    return cell;
  }

  /** Arguments of a call: combinators as a wrapping row of chips, others as a field grid. */
  function callBody(node, path) {
    var body = el('div', 'body');
    if (node.missing && node.missing.length) body.appendChild(el('div', 'warn', 'Missing: ' + node.missing.join(', ')));
    if (COMBI[node.name]) {
      var row = el('div', 'combi');
      row.appendChild(el('span', 't', COMBI[node.name] + ':'));
      node.fields.forEach(function (f) {
        var p = path.concat([f.argIndex]);
        var removable = node.fields.length > 1;
        if (!f.node) row.appendChild(fieldCell(f, p, node));
        else if (isOpen(p, false)) row.appendChild(callCard(f.node, p, f.code, removable));
        else row.appendChild(chip(f.node, p, f.code, removable));
      });
      body.appendChild(row);
      body.appendChild(addValueRow({ varargName: node.name === 'NOT' ? null : 'condition' }, path, node.code, 'expr'));
      return body;
    }
    var grid = el('div', 'fields');
    node.fields.forEach(function (f) {
      var p = path.concat([f.argIndex]);
      if (f.node) {
        var wide = el('div', 'fcell wide');
        wide.appendChild(el('span', 'flbl', f.label));
        wide.appendChild(isOpen(p, false) ? callCard(f.node, p, f.code, f.role !== 'positional') : chip(f.node, p, f.code, f.role !== 'positional'));
        grid.appendChild(wide);
      } else {
        grid.appendChild(fieldCell(f, p, node));
      }
    });
    body.appendChild(grid);
    var extras = el('div', 'extras');
    if (node.varargName) extras.appendChild(addValueRow(node, path, node.code));
    if ((node.addableKeywords && node.addableKeywords.length) || node.schemaKnown) extras.appendChild(addKeywordRow(node, path, node.code));
    body.appendChild(extras);
    return body;
  }

  function addKeywordRow(node, path, parentCode) {
    var row = el('div', 'def-row');
    var s = el('select');
    var first = el('option', '', '+ keyword…'); first.value = ''; s.appendChild(first);
    var cdom = node.name ? classDomOf(node.name) : null;
    var kws = (node.addableKeywords || []).slice();
    ((cdom && cdom.keywords) || []).forEach(function (k) {
      if (kws.indexOf(k) < 0 && !(node.fields || []).some(function (f) { return f.label === k; })) kws.push(k);
    });
    kws.forEach(function (k) { var o = el('option', '', k); o.value = k; s.appendChild(o); });
    var custom = el('option', '', 'custom…'); custom.value = '__custom'; s.appendChild(custom);
    var name = el('input', 'code'); name.placeholder = 'name'; name.style.display = 'none'; name.size = 10;
    var val = el('input', 'val'); val.placeholder = 'value (text)';
    var asCode = el('select');
    [['string', 'text'], ['number', 'number'], ['bool', 'True/False'], ['expr', 'code']].forEach(function (x) { var o = el('option', '', x[1]); o.value = x[0]; asCode.appendChild(o); });
    var kwHelp = el('span', 'fhelp');
    s.addEventListener('change', function () {
      name.style.display = s.value === '__custom' ? '' : 'none';
      var old = row.querySelector('datalist'); if (old) old.remove();
      val.removeAttribute && val.removeAttribute('list');
      var dom = node.name ? domOf(node.name, s.value) : null;
      if (dom) attachList(val, optionsFor(dom, node), row);
      kwHelp.textContent = dom && dom.help ? dom.help : '';
    });
    row.appendChild(s); row.appendChild(name); row.appendChild(val); row.appendChild(asCode);
    row.appendChild(btn('Add', 'primary', function () {
      var kw = s.value === '__custom' ? name.value.trim() : s.value;
      if (!kw) return;
      op({ op: 'insert', parent: path, keyword: kw }, parentCode, { kind: asCode.value, value: val.value, quote: '"' });
    }));
    row.appendChild(kwHelp);
    return row;
  }

  function addValueRow(node, path, parentCode, defaultKind) {
    var row = el('div', 'def-row');
    if (!node.varargName) return row;
    row.appendChild(el('span', 'lbl', '+ ' + node.varargName));
    var val = el('input', 'val'); val.placeholder = defaultKind === 'expr' ? 'e.g. LevelCondition("2+")' : 'value';
    var vdom = node.name ? domOf(node.name, node.varargName) : null;
    if (vdom) { attachList(val, optionsFor(vdom, node), row); if (vdom.help) row.title = vdom.help; }
    var asCode = el('select');
    [['string', 'text'], ['number', 'number'], ['expr', 'code']].forEach(function (x) { var o = el('option', '', x[1]); o.value = x[0]; asCode.appendChild(o); });
    if (defaultKind) asCode.value = defaultKind;
    row.appendChild(val); row.appendChild(asCode);
    row.appendChild(btn('Add', 'primary', function () {
      op({ op: 'insert', parent: path }, parentCode, { kind: asCode.value, value: val.value, quote: '"' });
    }));
    return row;
  }

  /** An expanded nested call (e.g. a condition inside OR) with collapse/remove. */
  function callCard(node, path, code, removable) {
    var card = el('div', 'card');
    var h = el('div', 'card-h');
    var nm = el('span', 'nm', node.name); nm.title = [docOf(node.name), node.signature || ''].filter(Boolean).join(' — ');
    h.appendChild(nm);
    if (!node.schemaKnown) h.appendChild(el('span', 't', '(unknown class)'));
    h.appendChild(el('span', 'grow'));
    h.appendChild(btn('–', '', function () { toggle(path, false); }, 'Collapse'));
    if (removable) h.appendChild(btn('✕', '', function () { op({ op: 'remove', path: path }, code); }, 'Remove'));
    card.appendChild(h);
    if (docOf(node.name)) card.appendChild(el('div', 'cdoc', docOf(node.name)));
    card.appendChild(callBody(node, path));
    return card;
  }

  /** Top-level item (a condition, selector, …): header with summary, body on demand. */
  function itemCard(item) {
    var path = [item.argIndex];
    var key = exKey(path);
    var open = item.node ? isOpen(path, true) : true;
    var wrap = el('div', 'card item');
    var h = el('div', 'card-h');
    var nm = el('span', 'nm', item.node ? item.node.name : 'expression');
    if (item.node) nm.title = [docOf(item.node.name), item.node.signature || ''].filter(Boolean).join(' — ');
    h.appendChild(nm);
    if (item.node && !open) h.appendChild(el('span', 'sum', summaryOf(item.node)));
    h.appendChild(el('span', 'grow'));
    if (item.node) h.appendChild(btn(open ? '–' : '✏', '', function () { toggle(path, !open); }, open ? 'Collapse' : 'Edit'));
    h.appendChild(btn('</>', '', function () { rawOpen[key] = !rawOpen[key]; render(); }, 'Edit as code'));
    h.appendChild(btn('🗑', '', function () { op({ op: 'remove', path: path }, item.code); }, 'Remove'));
    wrap.appendChild(h);
    if (rawOpen[key] || !item.node) {
      var ta = el('textarea', 'code'); ta.value = item.code; ta.rows = Math.min(6, item.code.split('\n').length + 1); ta.style.width = '100%';
      wrap.appendChild(ta);
      wrap.appendChild(btn('Apply code', 'primary', function () { op({ op: 'setValue', path: path, code: ta.value }, item.code); }));
    } else if (open) {
      if (docOf(item.node.name)) wrap.appendChild(el('div', 'cdoc', docOf(item.node.name)));
      wrap.appendChild(callBody(item.node, path));
    }
    return wrap;
  }

  function paramInput(p, cls) {
    var hint = (p.typeHint || '').toLowerCase();
    var kind = hint.indexOf('bool') >= 0 ? 'bool' : (hint.indexOf('int') >= 0 || hint.indexOf('float') >= 0) ? 'number' : (hint.indexOf('str') >= 0 || !hint) ? 'string' : 'expr';
    var row = el('div', 'def-row');
    row.appendChild(el('span', 'lbl', p.name + (p.required ? ' *' : '')));
    var val = el('input', 'val'); val.placeholder = p.default != null ? 'default ' + p.default : (p.typeHint || '');
    var t = el('select');
    [['string', 'text'], ['number', 'number'], ['bool', 'True/False'], ['expr', 'code']].forEach(function (x) { var o = el('option', '', x[1]); o.value = x[0]; t.appendChild(o); });
    t.value = kind;
    row.appendChild(val); row.appendChild(t);
    var dom = cls ? domOf(cls, p.name) : null;
    if (dom) {
      attachList(val, optionsFor(dom, null), row);
      if (dom.help) { row.title = dom.help; val.placeholder = dom.help.length < 48 ? dom.help : val.placeholder; }
      if (dom.options && dom.options.length && kind === 'string' && dom.options.every(function (o) { return /^[0-9]+$/.test(o.value); })) t.value = 'number';
    }
    return { row: row, get: function () { return val.value === '' ? null : { kind: t.value, value: val.value, quote: '"' }; }, param: p };
  }

  function addForm(kind) {
    var box = el('div', 'addform');
    var classes = (state.classes[kind] || []).slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    var s = el('select');
    var none = el('option', '', 'Choose a ' + kind + '…'); none.value = ''; s.appendChild(none);
    classes.forEach(function (c) { var o = el('option', '', c.name); o.value = c.name; o.title = c.signature; s.appendChild(o); });
    box.appendChild(s);
    var sig = el('div', 't'); box.appendChild(sig);
    var fieldsBox = el('div'); box.appendChild(fieldsBox);
    var inputs = []; var kwInputs = []; var varInputs = [];
    s.addEventListener('change', function () {
      fieldsBox.innerHTML = ''; inputs = []; kwInputs = []; varInputs = [];
      var c = classes.find(function (x) { return x.name === s.value; });
      sig.textContent = c ? c.signature + (docOf(c.name) ? ' — ' + docOf(c.name) : '') : '';
      if (!c) return;
      c.params.forEach(function (p) {
        if (p.kind === 'positional') { var pi = paramInput(p, c.name); inputs.push(pi); fieldsBox.appendChild(pi.row); }
        else if (p.kind === 'kwonly') { var ki = paramInput(p, c.name); kwInputs.push(ki); fieldsBox.appendChild(ki.row); }
        else if (p.kind === 'vararg') {
          var vr = el('div', 'def-row'); vr.appendChild(el('span', 'lbl', '*' + p.name));
          var ta = el('input', 'val'); ta.placeholder = 'values, one per comma'; vr.appendChild(ta);
          var vt = el('select'); [['string', 'text'], ['number', 'number'], ['expr', 'code']].forEach(function (x) { var o = el('option', '', x[1]); o.value = x[0]; vt.appendChild(o); });
          vr.appendChild(vt); fieldsBox.appendChild(vr);
          varInputs.push(function () { return ta.value.split(',').map(function (v) { return v.trim(); }).filter(function (v) { return v; }).map(function (v) { return { kind: vt.value, value: v, quote: '"' }; }); });
        }
      });
      var cd = classDomOf(c.name);
      (c.inferredKwargs || []).concat((cd && cd.keywords) || []).forEach(function (k) {
        if (kwInputs.some(function (x) { return x.param.name === k; })) return;
        var ki = paramInput({ name: k, required: false }, c.name); kwInputs.push(ki); fieldsBox.appendChild(ki.row);
      });
    });
    box.appendChild(btn('Insert', 'primary', function () {
      if (!s.value) return;
      var positionals = [];
      for (var i = 0; i < inputs.length; i++) {
        var v = inputs[i].get();
        if (v == null) { if (inputs[i].param.required) { lastError = inputs[i].param.name + ' is required.'; render(); return; } break; }
        positionals.push(v);
      }
      if (positionals.length === inputs.length) varInputs.forEach(function (f) { positionals = positionals.concat(f()); });
      var keywords = [];
      kwInputs.forEach(function (ki) { var v = ki.get(); if (v != null) keywords.push([ki.param.name, v]); });
      var d = cur(); lastError = ''; openAdd = null;
      post('def:add', { uri: d.uri, start: d.start, kind: kind, className: s.value, positionals: positionals, keywords: keywords });
    }));
    box.appendChild(btn('Cancel', '', function () { openAdd = null; render(); }));
    return box;
  }

  // Sections stack vertically and fold; their cards flow in a responsive grid.
  var secOpen = {};
  function isSecOpen(kind, count) { return secOpen[kind] !== undefined ? secOpen[kind] : count > 0; }
  function sectionShell(title, kind, count, extraHead) {
    var sec = el('div', 'def-sec');
    var h = el('div', 'def-sec-h');
    var open = isSecOpen(kind, count);
    h.appendChild(el('span', 'arrow', open ? '▾' : '▸'));
    h.appendChild(el('span', '', title + ' (' + count + ')'));
    h.appendChild(el('span', 'grow'));
    if (extraHead) h.appendChild(extraHead);
    h.addEventListener('click', function () { secOpen[kind] = !isSecOpen(kind, count); render(); });
    sec.appendChild(h);
    return { sec: sec, open: open };
  }
  function section(title, kind, items) {
    var add = null;
    if (kind !== 'other') {
      add = btn('+ Add', '', function (e) { if (e && e.stopPropagation) e.stopPropagation(); openAdd = openAdd === kind ? null : kind; secOpen[kind] = true; render(); });
    }
    var s = sectionShell(title, kind, items.length, add);
    if (!s.open) return s.sec;
    if (openAdd === kind) s.sec.appendChild(addForm(kind));
    var grid = el('div', 'cardgrid');
    items.forEach(function (it) { grid.appendChild(itemCard(it)); });
    s.sec.appendChild(grid);
    return s.sec;
  }

  function render() {
    root.innerHTML = '';
    if (!state) return;
    if (lastError) root.appendChild(el('div', 'err', lastError));
    if (!state.defs.length) {
      root.appendChild(el('p', 'muted', 'No Event(...) definition with the label "' + state.labelName + '" was found in the workspace index.'));
      return;
    }
    var d = cur(); var m = d.model;
    var head = el('div', 'def-head');
    if (state.defs.length > 1) {
      var pick = el('select');
      state.defs.forEach(function (x, i) { var o = el('option', '', x.file + ':' + (x.line + 1)); o.value = String(i); pick.appendChild(o); });
      pick.value = String(sel);
      pick.addEventListener('change', function () { sel = Number(pick.value); render(); });
      head.appendChild(pick);
    }
    head.appendChild(el('span', 'nm', m.kind + ' "' + (m.labelName || '') + '"'));
    if (m.priority) {
      var ps = el('select'); ps.title = 'Priority';
      [['1', 'prio 1 · blocking'], ['2', 'prio 2 · always runs'], ['3', 'prio 3 · random']].forEach(function (x) { var o = el('option', '', x[1]); o.value = x[0]; ps.appendChild(o); });
      if (['1', '2', '3'].indexOf(m.priority.code) < 0) { var oc = el('option', '', m.priority.code); oc.value = m.priority.code; ps.appendChild(oc); }
      ps.value = m.priority.code;
      ps.addEventListener('change', function () { op({ op: 'setValue', path: [m.priority.argIndex], code: ps.value }, m.priority.code); });
      head.appendChild(ps);
    }
    head.appendChild(el('span', 'grow'));
    head.appendChild(el('span', 'def-loc', d.file + ':' + (d.line + 1)));
    head.appendChild(btn('↪ Code', '', function () { post('def:reveal', { uri: d.uri, start: d.start }); }));
    root.appendChild(head);
    (m.hints || []).forEach(function (h) { root.appendChild(el('div', 'warn', '⚠ ' + h)); });
    m.fixed.forEach(function (f) {
      var r = el('div', 'def-row'); r.appendChild(el('span', 'lbl', f.name));
      var i = el('input', 'val code'); i.value = f.code;
      i.addEventListener('change', function () { op({ op: 'setValue', path: [f.argIndex], code: i.value }, f.code); });
      r.appendChild(i); root.appendChild(r);
    });

    // Sections stack; each folds and lays its cards out in a grid.
    var secs = el('div', 'secs');
    secs.appendChild(section('Conditions', 'condition', m.items.filter(function (i) { return i.kind === 'condition'; })));
    secs.appendChild(section('Selectors', 'selector', m.items.filter(function (i) { return i.kind === 'selector'; })));
    secs.appendChild(section('Patterns', 'pattern', m.items.filter(function (i) { return i.kind === 'pattern'; })));
    secs.appendChild(section('Options', 'option', m.items.filter(function (i) { return i.kind === 'option'; })));
    var others = m.items.filter(function (i) { return i.kind === 'other'; });
    if (others.length) secs.appendChild(section('Other', 'other', others));

    var ksh = sectionShell('Keywords', 'keywords', m.keywords.length || 1, null);
    if (ksh.open) {
      var kg = el('div', 'fields');
      m.keywords.forEach(function (f) { kg.appendChild(fieldCell(Object.assign({}, f, { role: 'keyword' }), [f.argIndex])); });
      ksh.sec.appendChild(kg);
      ksh.sec.appendChild(addKeywordRow({ addableKeywords: m.addableKeywords, schemaKnown: true }, [], m.code));
    }
    secs.appendChild(ksh.sec);
    root.appendChild(secs);
  }

  return { refresh: function () { post('def:refresh', {}); } };
}
