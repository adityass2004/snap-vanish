const DEFAULTS = { enabled: true, sensitivity: 50, dust: 2.2, micConfirm: true, autoMute: true };
const $ = (id) => document.getElementById(id);
let cfg = { ...DEFAULTS };

async function save(patch) {
  cfg = { ...cfg, ...patch };
  await chrome.storage.local.set({ cfg });
  render();
}
function render() {
  $('enabled').checked = cfg.enabled; document.body.classList.toggle('off', !cfg.enabled);
  $('sens').value = cfg.sensitivity; $('sensOut').textContent = cfg.sensitivity < 34 ? 'Strict' : cfg.sensitivity > 66 ? 'Easy' : 'Balanced';
  $('dust').value = cfg.dust; $('dustOut').textContent = Number(cfg.dust).toFixed(1) + ' s';
  $('micConfirm').checked = cfg.micConfirm; $('autoMute').checked = cfg.autoMute;
}
async function tabMsg(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return undefined;
  try { return await chrome.tabs.sendMessage(tab.id, msg); } catch (e) { return undefined; }
}
function setStatus(cls, text) { $('status').className = 'status ' + cls; $('statusText').textContent = text; }

async function refresh() {
  const st = await tabMsg({ type: 'get-status' });
  $('snap').disabled = !st || st.models !== 'ready';
  if (!st) return setStatus('', 'No call camera in this tab yet. Open Meet, Teams or Zoom and join a call.');
  if (st.models === 'error') return setStatus('bad', 'Could not load the models: ' + (st.error || 'unknown error'));
  if (st.models !== 'ready') return setStatus('busy', 'Loading hand tracking…');
  const names = { visible: 'Watching for your snap', vanishing: 'Turning to dust…', gone: 'Gone. Snap again to return', returning: 'Reassembling…' };
  let t = names[st.state] || 'Ready';
  if (st.state === 'visible' && st.holes > 12) t += ` · learning the room (${100 - st.holes}%)`;
  else if (st.state === 'visible' && st.ai === 'filling') t += ' · filling in the room with AI';
  if (!st.hasMic && cfg.micConfirm) t += ' · mic not seen yet';
  setStatus(st.state === 'visible' ? 'ok' : 'busy', t);
}

(async () => {
  const { cfg: s } = await chrome.storage.local.get('cfg'); cfg = { ...DEFAULTS, ...(s || {}) }; render();
  $('enabled').onchange = (e) => save({ enabled: e.target.checked });
  $('sens').oninput = (e) => save({ sensitivity: +e.target.value });
  $('dust').oninput = (e) => save({ dust: +e.target.value });
  $('micConfirm').onchange = (e) => save({ micConfirm: e.target.checked });
  $('autoMute').onchange = (e) => save({ autoMute: e.target.checked });
  $('snap').onclick = async () => { await tabMsg({ type: 'snap-now' }); setTimeout(refresh, 300); };
  $('rescan').onclick = async (e) => { e.preventDefault(); await tabMsg({ type: 'rescan' }); refresh(); };
  $('changeKey').onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); };
  const cmds = await chrome.commands.getAll(); const c = cmds.find((x) => x.name === 'snap-now');
  $('shortcut').textContent = (c && c.shortcut) || 'not set';
  refresh(); setInterval(refresh, 1200);
})();
