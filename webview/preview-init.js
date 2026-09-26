// Webview script (preview-init.js). Plain browser JavaScript, bundled by scripts/build-webview.js.
mountPaperdollEditor(vscode);

const defApi = mountEventDefEditor(vscode);
document.getElementById('defbtn').addEventListener('click', () => { showModule('def'); defApi.refresh(); });
document.getElementById('defclose').addEventListener('click', () => showModule(null));
document.getElementById('newevent').addEventListener('click', () => vscode.postMessage({ type:'newEvent' }));
window.addEventListener('message', (event) => { const m = event.data; if (m && m.type === 'openModule' && m.module === 'def') { showModule('def'); defApi.refresh(); } });
function reopenModule(mod) {
  if (mod === 'def') { showModule('def'); defApi.refresh(); }
  else if (mod === 'check') openCheck();
  else if (mod === 'sim') openSim();
}
vscode.postMessage({ type: 'ready' });
