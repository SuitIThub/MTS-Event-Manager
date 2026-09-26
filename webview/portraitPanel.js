// Webview script (portraitPanel.js). Plain browser JavaScript, bundled by scripts/build-webview.js.
  const vscode = acquireVsCodeApi();
  const data = JSON.parse(document.getElementById('payload').textContent);

  document.getElementById('hint').textContent = data.workspace
    ? 'Key is the Person name from load_person / Person["…"]. Saved for this workspace. A custom image for an existing key replaces the bundled one.'
    : 'Key is the Person name from load_person / Person["…"]. Saved for this user. A custom image for an existing key replaces the bundled one.';

  const dl = document.getElementById('keys');
  for (const k of data.knownKeys) {
    const opt = document.createElement('option');
    opt.value = k;
    dl.appendChild(opt);
  }

  const keyEl = document.getElementById('key');
  const pathEl = document.getElementById('path');
  document.getElementById('browse').addEventListener('click', () => vscode.postMessage({ type: 'pick' }));
  document.getElementById('form').addEventListener('submit', (e) => {
    e.preventDefault();
    vscode.postMessage({ type: 'save', key: keyEl.value, path: pathEl.value });
  });
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'picked') pathEl.value = e.data.path;
  });

  function thumb(src) {
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      return img;
    }
    const ph = document.createElement('div');
    ph.className = 'ph';
    return ph;
  }

  const custom = document.getElementById('custom');
  if (data.custom.length === 0) {
    custom.innerHTML = '<p class="empty">None yet.</p>';
  } else {
    for (const row of data.custom) {
      const wrap = document.createElement('div');
      wrap.className = 'row';
      wrap.appendChild(thumb(row.thumb));
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = '<div class="key"></div><div class="name"></div><div class="path"></div>';
      meta.querySelector('.key').textContent = row.key;
      meta.querySelector('.name').textContent = row.name !== row.key ? row.name : '';
      meta.querySelector('.path').textContent = row.missing ? 'File missing: ' + row.path : row.path;
      if (row.missing) meta.querySelector('.path').classList.add('missing');
      wrap.appendChild(meta);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Remove';
      btn.addEventListener('click', () => vscode.postMessage({ type: 'remove', key: row.key }));
      wrap.appendChild(btn);
      custom.appendChild(wrap);
    }
  }

  const bundled = document.getElementById('bundled');
  if (data.bundled.length === 0) {
    bundled.innerHTML = '<p class="empty">No bundled portraits (or all overridden).</p>';
  } else {
    for (const row of data.bundled) {
      const wrap = document.createElement('div');
      wrap.className = 'row';
      wrap.appendChild(thumb(row.thumb));
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = '<div class="key"></div><div class="name"></div>';
      meta.querySelector('.key').textContent = row.key;
      meta.querySelector('.name').textContent = row.name !== row.key ? row.name : '';
      wrap.appendChild(meta);
      bundled.appendChild(wrap);
    }
  }
