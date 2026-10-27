// Isolated-world bridge: hosts the engine iframe (extension origin, own CSP, own process),
// connects it to the page-world hook with MessageChannels, relays settings/commands, and
// keeps the call app's own mic button in sync with the mute.
(() => {
  const DEFAULTS = { enabled: true, sensitivity: 50, dust: 2.2, micConfirm: true, autoMute: true };
  let ctl = null, iframe = null, status = null, mutedByUs = false;
  const waiters = new Map();

  function mount() {
    if (iframe) return;
    iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('engine.html');
    iframe.setAttribute('aria-hidden', 'true'); iframe.tabIndex = -1;
    iframe.style.cssText = 'position:fixed;left:-20px;bottom:-20px;width:4px;height:4px;border:0;opacity:0.01;pointer-events:none;z-index:-1;';
    iframe.allow = '';
    (document.documentElement || document).appendChild(iframe);
    const dataCh = new MessageChannel(), ctlCh = new MessageChannel();
    ctl = ctlCh.port1;
    ctl.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'status') { status = m; if (m.reply && waiters.has(m.reply)) { waiters.get(m.reply)(m); waiters.delete(m.reply); } }
      else if (m.type === 'mute-ui') setAppMute(m.muted);
    };
    const origin = new URL(chrome.runtime.getURL('')).origin;
    const send = () => {
      iframe.contentWindow.postMessage({ __sv: 'init', dataPort: dataCh.port2, ctlPort: ctlCh.port2 }, origin, [dataCh.port2, ctlCh.port2]);
      window.postMessage({ __sv: 'port' }, '*', [dataCh.port1]);
      chrome.storage.local.get('cfg').then(({ cfg }) => ctl.postMessage({ type: 'cfg', cfg: { ...DEFAULTS, ...(cfg || {}) } }));
    };
    iframe.addEventListener('load', send, { once: true });
  }

  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.__sv === 'hello') mount();
  });

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.cfg && ctl) ctl.postMessage({ type: 'cfg', cfg: { ...DEFAULTS, ...(ch.cfg.newValue || {}) } });
  });

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (!ctl) return; // no call in this frame
    if (msg.type === 'snap-now') { ctl.postMessage({ type: 'snap-now' }); reply({ ok: true }); }
    else if (msg.type === 'rescan') { ctl.postMessage({ type: 'rescan' }); reply({ ok: true }); }
    else if (msg.type === 'get-status') {
      const id = Math.random().toString(36).slice(2);
      waiters.set(id, reply);
      ctl.postMessage({ type: 'get-status', id });
      setTimeout(() => { if (waiters.delete(id)) reply(status || { models: 'loading' }); }, 1500);
      return true;
    }
  });

  // ---- keep the app's own mute button in sync (best effort; the audio gate already guarantees silence) ----
  const LABEL = /(mute|unmute|microphone|\bmic\b)/i;
  const SKIP = /(all|everyone|participants|speaker|audio settings|more|options|arrow|settings|device|chat|raise|camera|video)/i;
  function findMicButton() {
    const meet = document.querySelector('button[data-is-muted][aria-label*="icrophone" i]');
    if (meet) return meet;
    for (const b of document.querySelectorAll('button,[role="button"]')) {
      const label = (b.getAttribute('aria-label') || b.getAttribute('title') || '') + ' ' + (b.getAttribute('data-tid') || '');
      if (LABEL.test(label) && !SKIP.test(label.replace(/\bmute (my )?(mic|microphone)\b/i, ''))) return b;
    }
    return null;
  }
  function isMuted(b) {
    if (b.dataset && b.dataset.isMuted) return b.dataset.isMuted === 'true';
    const l = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).toLowerCase();
    if (/(unmute|turn on (your )?(mic|microphone)|microphone is off|is muted)/.test(l)) return true;
    if (b.getAttribute('aria-pressed') === 'true' && /mute/.test(l)) return true;
    return false;
  }
  function setAppMute(wantMuted, tries = 3) {
    const b = findMicButton();
    if (!b) { if (tries > 0) setTimeout(() => setAppMute(wantMuted, tries - 1), 400); return; }
    const muted = isMuted(b);
    if (wantMuted) { if (!muted) { b.click(); mutedByUs = true; } }
    else if (mutedByUs) { if (muted) b.click(); mutedByUs = false; } // only undo a mute we did ourselves
  }
})();
