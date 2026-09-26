// Webview script (imagePreview.js). Plain browser JavaScript, bundled by scripts/build-webview.js.

    const items = JSON.parse(document.getElementById('payload').textContent);
    const vscode = acquireVsCodeApi();
    let i = 0;
    const img = document.getElementById('img');
    const counter = document.getElementById('counter');
    function render() {
      if (!items.length) return;
      const it = items[i];
      img.src = it.src;
      counter.textContent = (i + 1) + ' / ' + items.length;
      document.getElementById('name').textContent = it.name || '—';
      document.getElementById('rel').textContent = it.relativePath || '—';
      document.getElementById('full').textContent = it.path || '—';
      document.getElementById('params').textContent = it.params || '(none)';
      document.getElementById('pattern').textContent = it.patternKey || '—';
    }
    document.getElementById('prev').onclick = () => { i = (i - 1 + items.length) % items.length; render(); };
    document.getElementById('next').onclick = () => { i = (i + 1) % items.length; render(); };
    document.getElementById('open').onclick = () => {
      if (items[i]) vscode.postMessage({ type: 'open', path: items[i].path });
    };
    window.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') document.getElementById('prev').click();
      if (e.key === 'ArrowRight') document.getElementById('next').click();
    });
    render();
