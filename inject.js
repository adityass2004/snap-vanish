// Runs in the page's own JS world at document_start. Wraps getUserMedia so the call app receives
// the *processed* camera track (and a gate-able mic track). Frames only travel to the extension's own
// engine frame, which runs the models locally. Nothing is sent over the network.
(() => {
  if (window.__snapVanishInstalled) return;
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia || typeof MediaStreamTrackGenerator === 'undefined' || typeof MediaStreamTrackProcessor === 'undefined') return;
  window.__snapVanishInstalled = true;

  const origGUM = md.getUserMedia.bind(md);
  const epoch = () => (performance.timeOrigin + performance.now()) / 1000;
  const dbg = window.__svDebug = { sent: 0, got: 0, err: '', ready: false };
  let link = null;            // { port, ready, enabled }
  let linkPromise = null;
  let audioCtx = null;
  const gates = new Set();
  let muted = false;

  function connect() {
    if (linkPromise) return linkPromise;
    linkPromise = new Promise((resolve) => {
      const onMsg = (e) => {
        const d = e.data;
        if (e.source !== window || !d || d.__sv !== 'port' || !e.ports[0]) return;
        window.removeEventListener('message', onMsg, true);
        const L = link = { port: e.ports[0], ready: false, enabled: true, onReply: null, active: false };
        L.port.onmessage = (ev) => {
          const m = ev.data;
          if (m.type === 'ready') { L.ready = true; dbg.ready = true; }
          else if (m.type === 'cfg') L.enabled = m.enabled;
          else if (m.type === 'gate') setMuted(m.muted);
          else if (m.type === 'out' || m.type === 'pass') L.onReply && L.onReply(m);
        };
        resolve(L);
      };
      window.addEventListener('message', onMsg, true);
      window.postMessage({ __sv: 'hello' }, '*');
      setTimeout(() => resolve(null), 4000); // no bridge (e.g. unsupported frame): stay out of the way
    });
    return linkPromise;
  }

  function setMuted(m) {
    muted = m;
    for (const g of gates) g.gain.setTargetAtTime(m ? 0 : 1, g.context.currentTime, 0.012);
  }

  // ---------- video ----------
  function wrapVideo(vt, L) {
    const gen = new MediaStreamTrackGenerator({ kind: 'video' });
    const writer = gen.writable.getWriter();
    const reader = new MediaStreamTrackProcessor({ track: vt }).readable.getReader();
    let busy = false, pending = null, dead = false, held = null, timer = 0, sentAt = 0, lat = 400;

    const write = (f) => writer.write(f).catch(() => { try { f.close(); } catch (e) {} });
    const release = (f, raw) => {           // frame the engine did not answer in time
      // While vanished (or mid-effect) the raw camera frame must never leak out: freeze instead of passing it through.
      if (raw && !L.active) write(f); else f.close();
    };
    // The engine lives in another process, so VideoFrames can't be sent there; ImageBitmaps can.
    L.onReply = (m) => {
      busy = false; dbg.got++; L.active = !!m.active;
      lat = 0.8 * lat + 0.2 * (performance.now() - sentAt);
      const f = held; held = null; clearTimeout(timer);
      if (m.type === 'out' && m.bitmap) {
        if (f) { try { write(new VideoFrame(m.bitmap, { timestamp: f.timestamp, duration: f.duration || undefined })); f.close(); } catch (e) { dbg.err = String(e); release(f, true); } }
        m.bitmap.close();
      } else if (f) write(f);
      if (pending) { const p = pending; pending = null; send(p); }
    };
    async function send(f) {
      busy = true; held = f; dbg.sent++; sentAt = performance.now();
      timer = setTimeout(() => { if (held === f) { dbg.timeouts = (dbg.timeouts || 0) + 1; held = null; release(f, true); } }, Math.max(1200, 4 * lat));
      try {
        const bmp = await createImageBitmap(f);
        if (held !== f) { bmp.close(); return; }
        L.port.postMessage({ type: 'frame', bitmap: bmp, ts: f.timestamp }, [bmp]);
      } catch (e) { dbg.err = String(e); busy = false; if (held === f) { held = null; clearTimeout(timer); release(f, true); } }
    }

    (async () => {
      try {
        for (;;) {
          const { value: f, done } = await reader.read();
          if (done || dead) break;
          if (!gen.enabled) { f.close(); continue; }
          if (!L.ready || !L.enabled) { write(f); continue; }  // models still loading / switched off: untouched camera
          if (!busy) send(f);
          else if (!L.active) write(f);           // engine is busy but nothing is being drawn: keep the camera at full frame rate
          else { if (pending) pending.close(); pending = f; }
        }
      } catch (e) { /* stream ended */ }
    })();

    const stop = gen.stop.bind(gen);
    gen.stop = () => { dead = true; try { vt.stop(); } catch (e) {} try { reader.cancel(); } catch (e) {} stop(); };
    vt.addEventListener('ended', () => gen.stop());
    const settings = () => ({ ...vt.getSettings() });
    gen.getSettings = settings;
    gen.getCapabilities = () => (vt.getCapabilities ? vt.getCapabilities() : {});
    gen.applyConstraints = (c) => vt.applyConstraints(c);
    Object.defineProperty(gen, 'label', { get: () => vt.label });
    return gen;
  }

  // ---------- audio ----------
  async function getCtx() {
    if (!audioCtx) audioCtx = new AudioContext({ latencyHint: 'interactive' });
    if (audioCtx.state !== 'running') await Promise.race([audioCtx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 250))]);
    return audioCtx.state === 'running' ? audioCtx : null;
  }

  async function wrapAudio(at, L) {
    const ctx = await getCtx();
    if (!ctx) return null; // can't run the audio graph (autoplay policy): leave the mic alone, UI mute still works
    const src = ctx.createMediaStreamSource(new MediaStream([at]));
    const gate = ctx.createGain(); gate.gain.value = muted ? 0 : 1;
    const dest = ctx.createMediaStreamDestination();
    src.connect(gate); gate.connect(dest);
    gates.add(gate);
    // click detector on the *raw* mic (before the gate, so snapping back while muted still works)
    const tap = ctx.createScriptProcessor(512, 1, 1), sink = ctx.createGain(); sink.gain.value = 0;
    let base = 1e-7, last = 0;
    tap.onaudioprocess = (e) => {
      const x = e.inputBuffer.getChannelData(0); let en = 0, prev = x[0];
      for (let i = 1; i < x.length; i++) { const d = x[i] - prev; en += d * d; prev = x[i]; }
      en /= x.length;
      const ratio = en / base;
      if (ratio > 3 && en > 2e-6) { const t = epoch(); if (t - last > 0.08) { last = t; L && L.port.postMessage({ type: 'click', ts: t, ratio }); } }
      else base = base * 0.97 + Math.max(en, 1e-9) * 0.03;
    };
    src.connect(tap); tap.connect(sink); sink.connect(ctx.destination);
    L && L.port.postMessage({ type: 'mic', present: true });
    const track = dest.stream.getAudioTracks()[0];
    const stop = track.stop.bind(track);
    track.stop = () => { try { at.stop(); } catch (e) {} gates.delete(gate); try { src.disconnect(); tap.disconnect(); } catch (e) {} stop(); };
    at.addEventListener('ended', () => track.stop());
    const orig = track.getSettings.bind(track);
    track.getSettings = () => ({ ...orig(), ...at.getSettings() });
    Object.defineProperty(track, 'label', { get: () => at.label });
    return track;
  }

  md.getUserMedia = async function (constraints) {
    const stream = await origGUM(constraints);
    try {
      const vts = stream.getVideoTracks(), ats = stream.getAudioTracks();
      if (!vts.length && !ats.length) return stream;
      if (vts.length && vts[0].getSettings().displaySurface) return stream; // screen share, not a camera
      const L = await connect();
      if (!L) return stream;
      const out = new MediaStream();
      for (const t of vts) out.addTrack(wrapVideo(t, L));
      for (const t of ats) { const w = await wrapAudio(t, L); out.addTrack(w || t); }
      return out;
    } catch (e) {
      console.warn('[Snap Vanish] falling back to the plain camera:', e);
      return stream;
    }
  };
})();
