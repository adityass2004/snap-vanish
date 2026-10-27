(() => {
  // src/snap.js
  var dist = (a, b, w, h) => Math.hypot((a.x - b.x) * w, (a.y - b.y) * h);
  var FINGERS = [12, 8, 16];
  var PALM = [0, 5, 9, 13, 17];
  var SnapDetector = class {
    constructor() {
      this.micConfirm = true;
      this.hasMic = false;
      this.setSensitivity(50);
      this.reset();
    }
    setSensitivity(s) {
      const k = Math.min(100, Math.max(0, s)) / 100;
      this.pinchOn = 0.2 + 0.22 * k;
      this.releaseAt = this.pinchOn + 0.22;
      this.window = 0.3 + 0.25 * k;
      this.micRatio = 9 - 5 * k;
      this.maxWristSpeed = 3 + 3 * k;
    }
    reset() {
      this.pinchSince = null;
      this.lastPinchT = -1;
      this.lastSeen = -1;
      this.releaseT = null;
      this.releaseStrong = false;
      this.releaseDur = 0;
      this.clickT = null;
      this.blockUntil = 0;
      this.prevWrist = null;
      this.wristSpeed = 0;
    }
    block(until) {
      this.blockUntil = Math.max(this.blockUntil, until);
    }
    // hands: array of 21-landmark arrays (normalised), w/h: pixel size of the image they refer to.
    // t: seconds. Returns true when a snap is recognised.
    update(t, hands, w, h) {
      let best = null;
      for (const lm of hands || []) {
        const size = dist(lm[0], lm[9], w, h);
        if (size < 8) continue;
        let palm = { x: 0, y: 0 };
        for (const i of PALM) {
          palm.x += lm[i].x / PALM.length;
          palm.y += lm[i].y / PALM.length;
        }
        let bd = Infinity, bf = 12;
        for (const f of FINGERS) {
          const d = dist(lm[4], lm[f], w, h) / size;
          if (d < bd) {
            bd = d;
            bf = f;
          }
        }
        const strike = dist(lm[bf], palm, w, h) / size;
        if (!best || bd < best.d) best = { d: bd, strike, wrist: lm[0], size };
      }
      if (best) {
        if (this.prevWrist && t > this.prevWrist.t) {
          const v = dist(best.wrist, this.prevWrist.p, w, h) / best.size / (t - this.prevWrist.t);
          this.wristSpeed = 0.6 * this.wristSpeed + 0.4 * v;
        }
        this.prevWrist = { p: best.wrist, t };
        this.lastSeen = t;
        if (best.d <= this.pinchOn) {
          if (this.pinchSince === null) this.pinchSince = t;
          this.lastPinchT = t;
        } else if (this.pinchSince !== null) {
          const sinceLast = t - this.lastPinchT;
          if (best.d >= this.releaseAt && sinceLast <= 0.22) {
            if (this.wristSpeed <= this.maxWristSpeed) {
              this.releaseT = t;
              this.releaseDur = t - this.pinchSince;
              this.releaseStrong = best.strike < 0.75;
            }
          }
          this.pinchSince = null;
        }
      } else if (this.pinchSince !== null && t - this.lastSeen > 0.12) {
        if (this.lastSeen - this.lastPinchT < 0.1) {
          this.releaseT = this.lastPinchT + 0.06;
          this.releaseStrong = false;
          this.releaseDur = this.lastPinchT - this.pinchSince;
        }
        this.pinchSince = null;
      }
      return this.evaluate(t);
    }
    // ratio: how many times louder the high-frequency transient was than the running baseline
    feedClick(t, ratio) {
      if (ratio >= this.micRatio) this.clickT = t;
      return this.evaluate(t);
    }
    evaluate(t) {
      const W2 = this.window;
      if (this.releaseT !== null && t - this.releaseT > W2 + 0.1) this.releaseT = null;
      if (this.clickT !== null && t - this.clickT > W2 + 0.1) this.clickT = null;
      if (t < this.blockUntil || this.releaseT === null) return false;
      let ok;
      if (this.micConfirm && this.hasMic) ok = this.clickT !== null && Math.abs(this.clickT - this.releaseT) <= W2;
      else ok = this.releaseStrong && this.releaseDur >= 0 && this.releaseDur <= 0.35;
      if (!ok) return false;
      this.releaseT = null;
      this.clickT = null;
      this.blockUntil = t + 1;
      return true;
    }
  };

  // src/dust.js
  var SPAN = 0.34;
  function mulberry(seed) {
    return () => {
      seed |= 0;
      seed = seed + 1831565813 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function noiseGrid(rand, n) {
    const g = new Float32Array((n + 1) * (n + 1));
    for (let i = 0; i < g.length; i++) g[i] = rand();
    return g;
  }
  function sampleGrid(g, n, u, v) {
    const x = Math.min(0.9999, Math.max(0, u)) * n, y = Math.min(0.9999, Math.max(0, v)) * n;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, s = n + 1;
    const a = g[y0 * s + x0], b = g[y0 * s + x0 + 1], c = g[(y0 + 1) * s + x0], d = g[(y0 + 1) * s + x0 + 1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  var Dust = class {
    constructor() {
      this.n = 0;
      this.T = null;
    }
    // prob: person probability (MW*MH). frame: RGBA ImageData at dust resolution (DW*DH).
    spawn(prob, MW2, MH2, frame, DW, DH, seed = Math.random() * 1e9 | 0) {
      const rand = mulberry(seed);
      let minx = MW2, miny = MH2, maxx = 0, maxy = 0;
      const idx = [];
      for (let y = 0; y < MH2; y++) for (let x = 0; x < MW2; x++) if (prob[y * MW2 + x] > 0.5) {
        idx.push(y * MW2 + x);
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
      this.wind = { x: Math.cos(-0.45), y: Math.sin(-0.45) };
      const bw = Math.max(1, maxx - minx), bh = Math.max(1, maxy - miny);
      const g1 = noiseGrid(rand, 6), g2 = noiseGrid(rand, 18);
      const T2 = new Float32Array(MW2 * MH2);
      let umin = Infinity, umax = -Infinity;
      const U = new Float32Array(MW2 * MH2);
      for (let y = 0; y < MH2; y++) for (let x = 0; x < MW2; x++) {
        const u = (x - minx) / bw * this.wind.x * 1 + (y - miny) / bh * this.wind.y * 0.6;
        U[y * MW2 + x] = u;
        if (u < umin) umin = u;
        if (u > umax) umax = u;
      }
      for (let i = 0; i < T2.length; i++) {
        const x = i % MW2 / MW2, y = (i / MW2 | 0) / MH2;
        const sweep = 1 - (U[i] - umin) / Math.max(1e-6, umax - umin);
        const nz = 0.65 * sampleGrid(g1, 6, x, y) + 0.35 * sampleGrid(g2, 18, x, y);
        T2[i] = Math.min(1, Math.max(0, 0.55 * sweep + 0.45 * nz));
      }
      this.T = T2;
      const area = idx.length * (DW / MW2) * (DH / MH2);
      const N = this.n = Math.max(0, Math.min(15e3, Math.round(area / 5)));
      const size = Math.max(1.5, Math.min(5, Math.sqrt(area / Math.max(1, N)) * 1.1));
      this.DW = DW;
      this.DH = DH;
      this.size = size;
      this.px = new Float32Array(N);
      this.py = new Float32Array(N);
      this.t = new Float32Array(N);
      this.r1 = new Float32Array(N);
      this.r2 = new Float32Array(N);
      this.ph = new Float32Array(N);
      this.rgb = new Uint8Array(N * 3);
      for (let i = 0; i < N; i++) {
        const k = idx[rand() * idx.length | 0];
        const mx = k % MW2 + rand(), my = (k / MW2 | 0) + rand();
        const x = Math.min(DW - 1, mx / MW2 * DW), y = Math.min(DH - 1, my / MH2 * DH);
        this.px[i] = x;
        this.py[i] = y;
        this.t[i] = T2[k] * (1 - SPAN);
        this.r1[i] = rand();
        this.r2[i] = rand() * 2 - 1;
        this.ph[i] = rand() * 6.283;
        const o = ((y | 0) * DW + (x | 0)) * 4, j = 0.9 + rand() * 0.2;
        this.rgb[i * 3] = Math.min(255, frame.data[o] * j);
        this.rgb[i * 3 + 1] = Math.min(255, frame.data[o + 1] * j);
        this.rgb[i * 3 + 2] = Math.min(255, frame.data[o + 2] * j);
      }
    }
    // per-pixel "already gone" amount at mask resolution (0..1) for a progress value
    consumed(progress, out) {
      const T2 = this.T, k = 1 - SPAN;
      for (let i = 0; i < out.length; i++) {
        const v = (progress - T2[i] * k) / 0.035;
        out[i] = v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v);
      }
    }
    // draws all airborne particles into an RGBA buffer (premultiplied-ish, cleared first)
    render(progress, buf, time) {
      buf.fill(0);
      if (!this.n) return 0;
      const DW = this.DW, DH = this.DH, k = 1 - SPAN, wx = this.wind.x, wy = this.wind.y, Dm = 0.5 * DW;
      let drawn = 0;
      for (let i = 0; i < this.n; i++) {
        const tau = (progress - this.t[i]) / SPAN;
        if (tau <= 0 || tau >= 1) continue;
        const e = Math.pow(tau, 1.45), r1 = this.r1[i], ph = this.ph[i];
        const sw = (Math.sin(tau * 7 + ph) * 0.03 + this.r2[i] * 0.04 * tau) * DW;
        const sh = (Math.cos(tau * 5 + ph) * 0.03 - 0.05 * tau) * DH;
        const x = this.px[i] + wx * Dm * e * (0.3 + 0.9 * r1) + sw;
        const y = this.py[i] + wy * Dm * e * (0.3 + 0.9 * r1) + sh + 0.12 * DH * tau * tau * this.r2[i];
        const a = Math.pow(1 - tau, 1.3);
        const s = this.size * (1 - 0.55 * tau);
        const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0), x1 = Math.min(DW, Math.ceil(x + s)), y1 = Math.min(DH, Math.ceil(y + s));
        if (x1 <= x0 || y1 <= y0) continue;
        const r = this.rgb[i * 3], g = this.rgb[i * 3 + 1], b = this.rgb[i * 3 + 2], ia = 1 - a, A = a * 255;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
          const o = (yy * DW + xx) * 4;
          buf[o] = r * a + buf[o] * ia;
          buf[o + 1] = g * a + buf[o + 1] * ia;
          buf[o + 2] = b * a + buf[o + 2] * ia;
          buf[o + 3] = A + buf[o + 3] * ia;
        }
        drawn++;
      }
      return drawn;
    }
  };

  // src/plate.js
  var mk = (w, h) => {
    const c = new OffscreenCanvas(w, h);
    return [c, c.getContext("2d")];
  };
  var RoomPlate = class {
    constructor(W2, H2, MW2, MH2) {
      Object.assign(this, { W: W2, H: H2, MW: MW2, MH: MH2 });
      [this.plate, this.pctx] = mk(W2, H2);
      [this.ai, this.actx] = mk(W2, H2);
      [this.fb, this.fctx] = mk(W2, H2);
      [this.bg, this.bctx] = mk(W2, H2);
      [this.layer, this.lctx] = mk(W2, H2);
      [this.wC, this.wctx] = mk(MW2, MH2);
      [this.small, this.sctx] = mk(MW2, MH2);
      this.sctx = this.small.getContext("2d", { willReadFrequently: true });
      [this.sq, this.sqctx] = mk(512, 512);
      this.sqctx = this.sq.getContext("2d", { willReadFrequently: true });
      this.wImg = new ImageData(MW2, MH2);
      for (let i = 0; i < MW2 * MH2; i++) {
        this.wImg.data[i * 4] = this.wImg.data[i * 4 + 1] = this.wImg.data[i * 4 + 2] = 255;
      }
      this.cov = new Float32Array(MW2 * MH2);
      this.fbImg = new ImageData(MW2, MH2);
      this.hasFb = false;
      this.hasAi = false;
      this.dirty = true;
      this.fbDirty = true;
      this.aiHoleCount = -1;
    }
    reset() {
      this.cov.fill(0);
      for (const c of [this.pctx, this.actx, this.fctx, this.bctx]) c.clearRect(0, 0, this.W, this.H);
      this.hasFb = this.hasAi = false;
      this.dirty = this.fbDirty = true;
      this.aiHoleCount = -1;
    }
    // frameC: canvas with the live frame; bgConf: per mask-pixel confidence that it's empty background (0..1)
    learn(frameC2, bgConf2, alpha) {
      const a = this.wImg.data, cov = this.cov;
      for (let i = 0; i < cov.length; i++) {
        const c = cov[i], b = bgConf2[i];
        a[i * 4 + 3] = b * (1 - c + c * alpha) * 255;
        if (b > c) cov[i] = b;
      }
      this.wctx.putImageData(this.wImg, 0, 0);
      const l = this.lctx;
      l.globalCompositeOperation = "copy";
      l.drawImage(frameC2, 0, 0, this.W, this.H);
      l.globalCompositeOperation = "destination-in";
      l.imageSmoothingEnabled = true;
      l.drawImage(this.wC, 0, 0, this.W, this.H);
      this.pctx.globalCompositeOperation = "source-over";
      this.pctx.drawImage(this.layer, 0, 0);
      this.dirty = true;
      this.fbDirty = true;
    }
    holeFraction() {
      let n = 0;
      for (let i = 0; i < this.cov.length; i++) if (this.cov[i] < 0.5) n++;
      return n / this.cov.length;
    }
    // Diffusion ("push-pull") fill for anything not yet known: instant, smooth, never blank.
    rebuildFallback() {
      const { MW: MW2, MH: MH2 } = this;
      this.sctx.clearRect(0, 0, MW2, MH2);
      this.sctx.drawImage(this.plate, 0, 0, MW2, MH2);
      const d = this.sctx.getImageData(0, 0, MW2, MH2).data;
      let w = new Float32Array(MW2 * MH2), c = new Float32Array(MW2 * MH2 * 3);
      for (let i = 0; i < MW2 * MH2; i++) {
        w[i] = d[i * 4 + 3] / 255;
        for (let k = 0; k < 3; k++) c[i * 3 + k] = d[i * 4 + k] * w[i];
      }
      const levels = [{ w, c, W: MW2, H: MH2 }];
      while (levels[levels.length - 1].W > 2 && levels[levels.length - 1].H > 2) {
        const p = levels[levels.length - 1], nW = p.W + 1 >> 1, nH = p.H + 1 >> 1;
        const nw = new Float32Array(nW * nH), nc = new Float32Array(nW * nH * 3);
        for (let y = 0; y < p.H; y++) for (let x = 0; x < p.W; x++) {
          const s = y * p.W + x, t = (y >> 1) * nW + (x >> 1);
          nw[t] += p.w[s] * 0.25;
          for (let k = 0; k < 3; k++) nc[t * 3 + k] += p.c[s * 3 + k] * 0.25;
        }
        levels.push({ w: nw, c: nc, W: nW, H: nH });
      }
      for (let L = levels.length - 2; L >= 0; L--) {
        const f2 = levels[L], g = levels[L + 1];
        for (let y = 0; y < f2.H; y++) for (let x = 0; x < f2.W; x++) {
          const s = y * f2.W + x;
          const gx = Math.min(g.W - 1, x >> 1), gy = Math.min(g.H - 1, y >> 1);
          const t = gy * g.W + gx, gw = g.w[t];
          const miss = 1 - Math.min(1, f2.w[s]);
          if (gw > 1e-6 && miss > 0) {
            for (let k = 0; k < 3; k++) f2.c[s * 3 + k] += miss * (g.c[t * 3 + k] / gw);
            f2.w[s] += miss;
          }
        }
      }
      const f = levels[0], o = this.fbImg.data;
      for (let i = 0; i < MW2 * MH2; i++) {
        const ww = f.w[i] > 1e-6 ? f.w[i] : 1;
        for (let k = 0; k < 3; k++) o[i * 4 + k] = f.w[i] > 1e-6 ? f.c[i * 3 + k] / ww : 128;
        o[i * 4 + 3] = 255;
      }
      this.sctx.putImageData(this.fbImg, 0, 0);
      this.fctx.imageSmoothingEnabled = true;
      this.fctx.imageSmoothingQuality = "high";
      this.fctx.drawImage(this.small, 0, 0, this.W, this.H);
      this.hasFb = true;
      this.fbDirty = false;
      this.dirty = true;
    }
    compose() {
      if (!this.dirty) return;
      const b = this.bctx;
      b.globalCompositeOperation = "source-over";
      b.clearRect(0, 0, this.W, this.H);
      if (this.hasFb) b.drawImage(this.fb, 0, 0);
      if (this.hasAi) b.drawImage(this.ai, 0, 0);
      b.drawImage(this.plate, 0, 0);
      this.dirty = false;
    }
    // ---- AI inpainting hand-off ----
    aiNeeded() {
      let n = 0;
      for (let i = 0; i < this.cov.length; i++) if (this.cov[i] < 0.5) n++;
      if (n < this.cov.length * 4e-3) return false;
      return this.aiHoleCount < 0 || Math.abs(n - this.aiHoleCount) > this.cov.length * 0.01;
    }
    aiPrepare() {
      const { MW: MW2, MH: MH2, W: W2, H: H2, cov } = this;
      let minx = MW2, miny = MH2, maxx = -1, maxy = -1, n = 0;
      for (let y = 0; y < MH2; y++) for (let x = 0; x < MW2; x++) if (cov[y * MW2 + x] < 0.5) {
        n++;
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
      this.aiHoleCount = n;
      const S2 = Math.min(W2, H2);
      const hw = (maxx - minx + 1) / MW2 * W2, cx = (minx + maxx + 1) / 2 / MW2 * W2;
      let crop;
      if (hw <= S2 * 0.92 && W2 >= H2) crop = { x: Math.round(Math.min(W2 - S2, Math.max(0, cx - S2 / 2))), y: 0, w: S2, h: S2 };
      else crop = { x: 0, y: 0, w: W2, h: H2 };
      this.sqctx.globalCompositeOperation = "copy";
      this.sqctx.imageSmoothingEnabled = true;
      this.sqctx.drawImage(this.plate, crop.x, crop.y, crop.w, crop.h, 0, 0, 512, 512);
      const px = this.sqctx.getImageData(0, 0, 512, 512).data;
      const mask = new Uint8Array(512 * 512), rgba = new Uint8ClampedArray(512 * 512 * 4);
      for (let i = 0; i < 512 * 512; i++) {
        mask[i] = px[i * 4 + 3] < 250 ? 1 : 0;
        rgba[i * 4] = px[i * 4];
        rgba[i * 4 + 1] = px[i * 4 + 1];
        rgba[i * 4 + 2] = px[i * 4 + 2];
        rgba[i * 4 + 3] = 255;
      }
      let cur = mask;
      for (let pass = 0; pass < 3; pass++) {
        const nxt = new Uint8Array(cur);
        for (let y = 1; y < 511; y++) for (let x = 1; x < 511; x++) {
          const i = y * 512 + x;
          if (!cur[i] && (cur[i - 1] || cur[i + 1] || cur[i - 512] || cur[i + 512])) nxt[i] = 1;
        }
        cur = nxt;
      }
      const tmp = cur;
      return { rgba, mask: tmp, crop };
    }
    aiApply(rgba, crop) {
      this.sqctx.globalCompositeOperation = "copy";
      this.sqctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), 512, 512), 0, 0);
      this.actx.imageSmoothingEnabled = true;
      this.actx.imageSmoothingQuality = "high";
      this.actx.clearRect(0, 0, this.W, this.H);
      this.actx.drawImage(this.sq, 0, 0, 512, 512, crop.x, crop.y, crop.w, crop.h);
      this.hasAi = true;
      this.dirty = true;
    }
  };

  // src/engine.js
  var BASE = new URL("./", location.href).href;
  var MAX_W = 1280;
  var MW = 256;
  var HAND_W = 320;
  var DEFAULTS = { enabled: true, sensitivity: 50, dust: 2.2, micConfirm: true, autoMute: true };
  var nowSec = () => (performance.timeOrigin + performance.now()) / 1e3;
  var mk2 = (w, h, opts) => {
    const c = new OffscreenCanvas(w, h);
    return [c, c.getContext("2d", opts)];
  };
  var dataPort = null;
  var ctlPort = null;
  var cfg = { ...DEFAULTS };
  var detector = new SnapDetector();
  var T = { hand: 0, seg: 0, comp: 0, learn: 0 };
  var S = { models: "loading", error: "", progress: 0, dir: 0, lastT: 0, frames: 0, fps: 0, procMs: 0, aiState: "idle", aiMs: 0, lastSnapAt: 0, snapSource: "", cooldownUntil: 0, handSkip: 0 };
  var hand = null;
  var seg = null;
  var worker = null;
  var workerReady = false;
  var aiBusy = false;
  var lastAiAt = 0;
  var W = 0;
  var H = 0;
  var MH = 0;
  var HH = 0;
  var frameC;
  var fctx;
  var handC;
  var hctx;
  var segC;
  var sctx;
  var outC;
  var octx;
  var patchC;
  var pctx;
  var maskC;
  var mctx;
  var dustC;
  var dctx;
  var plate = null;
  var dust = new Dust();
  var pS;
  var pHold;
  var pTmp;
  var bgConf;
  var consumed;
  var patchA;
  var maskImg;
  var dustImg;
  var lastSegN = 0;
  var lastFbAt = 0;
  var vanishDur = 2.2;
  var lastHands = [];
  var hasMask = false;
  var lastSegResult = null;
  var segReadC = null;
  var segReadCtx = null;
  var withTimeout = (p, ms, name) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(name + " timed out")), ms))]);
  var post = (port, msg, tr) => {
    try {
      port && port.postMessage(msg, tr || []);
    } catch (e) {
    }
  };
  async function loadModels() {
    try {
      hand = new window.Hands({ locateFile: (f) => BASE + "hands/" + f });
      hand.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5, selfieMode: false });
      hand.onResults((r) => {
        lastHands = r.multiHandLandmarks || [];
      });
      await hand.initialize();
      seg = new window.SelfieSegmentation({ locateFile: (f) => BASE + "seg/" + f });
      seg.setOptions({ modelSelection: 1, selfieMode: false });
      seg.onResults((r) => {
        lastSegResult = r.segmentationMask;
      });
      await seg.initialize();
      S.models = "ready";
      post(dataPort, { type: "ready" });
    } catch (e) {
      S.models = "error";
      S.error = String(e && e.message || e);
      console.error("[Snap Vanish] model load failed", e);
    }
    try {
      worker = new Worker(BASE + "inpaint-worker.js", { type: "module" });
      worker.onmessage = (e) => {
        const d = e.data;
        if (d.type === "ready") {
          workerReady = true;
          S.aiState = "ready";
        } else if (d.type === "result") {
          aiBusy = false;
          S.aiMs = Math.round(d.ms);
          if (plate && pendingCrop) {
            plate.aiApply(d.rgba, pendingCrop);
            S.aiState = "filled";
          }
        } else if (d.type === "error") {
          aiBusy = false;
          S.aiState = "error";
          console.warn("[Snap Vanish] inpaint error", d.message);
        }
      };
      worker.onerror = (e) => {
        S.aiState = "error";
        console.warn("[Snap Vanish] inpaint worker", e.message);
      };
      worker.postMessage({ type: "init", base: BASE });
    } catch (e) {
      S.aiState = "error";
    }
  }
  var pendingCrop = null;
  function ensureSize(w, h) {
    const sc = Math.min(1, MAX_W / w);
    const nw = Math.round(w * sc), nh = Math.round(h * sc);
    if (nw === W && nh === H) return;
    W = nw;
    H = nh;
    MH = Math.max(8, Math.round(MW * H / W));
    HH = Math.round(HAND_W * H / W);
    [frameC, fctx] = mk2(W, H);
    [handC, hctx] = mk2(HAND_W, HH);
    [segC, sctx] = mk2(MW, MH);
    [outC, octx] = mk2(W, H);
    [patchC, pctx] = mk2(W, H);
    [maskC, mctx] = mk2(MW, MH);
    const dw = Math.min(W, 960), dh = Math.round(dw * H / W);
    [dustC, dctx] = mk2(dw, dh);
    dustImg = new ImageData(dw, dh);
    const n = MW * MH;
    pS = new Float32Array(n);
    pHold = new Float32Array(n);
    pTmp = new Float32Array(n);
    bgConf = new Float32Array(n);
    consumed = new Float32Array(n);
    patchA = new Float32Array(n);
    maskImg = new ImageData(MW, MH);
    for (let i = 0; i < n; i++) {
      maskImg.data[i * 4] = maskImg.data[i * 4 + 1] = maskImg.data[i * 4 + 2] = 255;
    }
    plate = new RoomPlate(W, H, MW, MH);
    hasMask = false;
  }
  function dilate(src, dst, r) {
    const tmp = pTmp;
    for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
      let m = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < MW) {
          const v = src[y * MW + xx];
          if (v > m) m = v;
        }
      }
      tmp[y * MW + x] = m;
    }
    for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
      let m = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < MH) {
          const v = tmp[yy * MW + x];
          if (v > m) m = v;
        }
      }
      dst[y * MW + x] = m;
    }
  }
  async function runSegmentation() {
    sctx.drawImage(frameC, 0, 0, MW, MH);
    lastSegResult = null;
    await withTimeout(seg.send({ image: segC }), 4e3, "seg.send");
    const m = lastSegResult;
    if (!m) return;
    if (!segReadC || segReadC.width !== MW || segReadC.height !== MH) {
      [segReadC] = mk2(MW, MH);
      segReadCtx = segReadC.getContext("2d", { willReadFrequently: true });
    }
    segReadCtx.clearRect(0, 0, MW, MH);
    segReadCtx.drawImage(m, 0, 0, MW, MH);
    const d = segReadCtx.getImageData(0, 0, MW, MH).data, k = hasMask ? 0.65 : 1;
    for (let i = 0; i < pS.length; i++) pS[i] = k * (d[i * 4] / 255) + (1 - k) * pS[i];
    hasMask = true;
    for (let i = 0; i < pS.length; i++) pHold[i] = Math.max(pS[i], pHold[i] * 0.8);
  }
  function handleSnap(source) {
    const t = nowSec();
    if (t < S.cooldownUntil) return;
    S.cooldownUntil = t + 0.35;
    const away = S.dir > 0 || S.dir === 0 && S.progress >= 1;
    if (!hasMask && !away) return;
    if (!away) {
      S.dir = 1;
      spawnDust();
      if (cfg.autoMute) {
        post(dataPort, { type: "gate", muted: true });
        post(ctlPort, { type: "mute-ui", muted: true });
      }
    } else {
      S.dir = -1;
      spawnDust();
      if (cfg.autoMute) {
        post(dataPort, { type: "gate", muted: false });
        post(ctlPort, { type: "mute-ui", muted: false });
      }
    }
    S.lastSnapAt = Date.now();
    S.snapSource = source;
    detector.block(t + 1);
  }
  function spawnDust() {
    const dw = dustC.width, dh = dustC.height;
    dctx.clearRect(0, 0, dw, dh);
    dctx.drawImage(frameC, 0, 0, dw, dh);
    const img = dctx.getImageData(0, 0, dw, dh);
    dust.spawn(pHold, MW, MH, img, dw, dh);
  }
  function updateCfg(c) {
    cfg = { ...DEFAULTS, ...c };
    detector.setSensitivity(cfg.sensitivity);
    detector.micConfirm = cfg.micConfirm;
    vanishDur = cfg.dust;
    post(dataPort, { type: "cfg", enabled: cfg.enabled });
    if (!cfg.enabled && (S.progress > 0 || S.dir > 0)) {
      S.dir = -1;
      if (cfg.autoMute) {
        post(dataPort, { type: "gate", muted: false });
        post(ctlPort, { type: "mute-ui", muted: false });
      }
    }
  }
  async function processFrame(frame, tsMs) {
    const t0 = performance.now();
    ensureSize(frame.width, frame.height);
    const now = nowSec();
    const dt = S.lastT ? Math.min(0.25, now - S.lastT) : 0.033;
    S.lastT = now;
    S.fps = S.fps * 0.9 + 0.1 * (1 / Math.max(dt, 1e-3));
    fctx.drawImage(frame, 0, 0, W, H);
    const animating = S.dir !== 0 || S.progress > 0;
    let snapped = false;
    S.handSkip = animating ? (S.handSkip + 1) % 2 : 0;
    if (cfg.enabled && hand && S.models === "ready" && !S.handSkip) {
      hctx.drawImage(frameC, 0, 0, HAND_W, HH);
      let hands = [];
      const th = performance.now();
      try {
        lastHands = [];
        await withTimeout(hand.send({ image: handC }), 4e3, "hands.send");
        hands = lastHands;
      } catch (e) {
        console.warn("[Snap Vanish] hands", e.message);
      }
      T.hand = T.hand * 0.8 + 0.2 * (performance.now() - th);
      if (detector.update(now - 0.04, hands, HAND_W, HH)) {
        handleSnap("hand");
        snapped = true;
      }
    }
    const needSeg = seg && S.models === "ready" && (cfg.enabled || animating);
    const interval = animating ? 2 : 4;
    if (needSeg && (S.frames - lastSegN >= interval || !hasMask)) {
      lastSegN = S.frames;
      const ts0 = performance.now();
      try {
        await runSegmentation();
      } catch (e) {
        console.warn("[Snap Vanish] seg", e);
      }
      T.seg = T.seg * 0.8 + 0.2 * (performance.now() - ts0);
      if (!animating && hasMask) {
        const tl = performance.now();
        dilate(pS, patchA, 4);
        let area = 0;
        for (let i = 0; i < pS.length; i++) if (pS[i] > 0.5) area++;
        const frac = area / pS.length;
        if (frac < 0.85) {
          for (let i = 0; i < bgConf.length; i++) {
            const v = 1 - patchA[i] * 2.2;
            bgConf[i] = v < 0 ? 0 : v > 1 ? 1 : v;
          }
          plate.learn(frameC, bgConf, 0.04);
        }
        T.learn = T.learn * 0.8 + 0.2 * (performance.now() - tl);
      }
    }
    S.frames++;
    if (!animating && plate && hasMask) {
      if (plate.fbDirty && now - lastFbAt > 0.8) {
        plate.rebuildFallback();
        lastFbAt = now;
      }
      if (workerReady && !aiBusy && S.aiState !== "error" && now - lastAiAt > 4 && plate.aiNeeded()) {
        const job = plate.aiPrepare();
        pendingCrop = job.crop;
        aiBusy = true;
        lastAiAt = now;
        S.aiState = "filling";
        worker.postMessage({ type: "run", id: 1, rgba: job.rgba, mask: job.mask }, [job.rgba.buffer, job.mask.buffer]);
      }
    }
    if (S.dir !== 0) {
      const dur = S.dir > 0 ? vanishDur : vanishDur * 0.85;
      S.progress += S.dir * dt / dur;
      if (S.progress >= 1) {
        S.progress = 1;
        S.dir = 0;
      }
      if (S.progress <= 0) {
        S.progress = 0;
        S.dir = 0;
      }
    }
    const active = S.dir !== 0 || S.progress > 0;
    const tc = performance.now();
    if (!active) {
      S.procMs = S.procMs * 0.9 + 0.1 * (performance.now() - t0);
      return null;
    }
    if (!plate.hasFb) plate.rebuildFallback();
    plate.compose();
    dilate(pHold, patchA, 2);
    if (dust.n === 0 && !dust.T) spawnDust();
    dust.consumed(S.progress, consumed);
    const a = maskImg.data;
    for (let i = 0; i < patchA.length; i++) {
      let v = patchA[i] * 2.4 - 0.5;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      a[i * 4 + 3] = v * consumed[i] * 255;
    }
    mctx.putImageData(maskImg, 0, 0);
    pctx.globalCompositeOperation = "copy";
    pctx.drawImage(plate.bg, 0, 0);
    pctx.globalCompositeOperation = "destination-in";
    pctx.imageSmoothingEnabled = true;
    pctx.drawImage(maskC, 0, 0, W, H);
    octx.globalCompositeOperation = "copy";
    octx.drawImage(frameC, 0, 0);
    octx.globalCompositeOperation = "source-over";
    octx.drawImage(patchC, 0, 0);
    const drawn = dust.render(S.progress, dustImg.data);
    if (drawn) {
      dctx.putImageData(dustImg, 0, 0);
      octx.drawImage(dustC, 0, 0, W, H);
    }
    T.comp = T.comp * 0.8 + 0.2 * (performance.now() - tc);
    frame.close();
    S.procMs = S.procMs * 0.9 + 0.1 * (performance.now() - t0);
    return outC.transferToImageBitmap();
  }
  async function onFrameMsg(d) {
    let out = null;
    try {
      out = await processFrame(d.bitmap, d.ts / 1e3);
    } catch (e) {
      console.warn("[Snap Vanish] frame error", e);
      try {
        d.bitmap.close();
      } catch (_) {
      }
    }
    if (out) post(dataPort, { type: "out", bitmap: out, ts: d.ts, active: true }, [out]);
    else {
      try {
        d.bitmap.close();
      } catch (_) {
      }
      post(dataPort, { type: "pass", ts: d.ts, active: S.dir !== 0 || S.progress > 0 });
    }
  }
  function status() {
    return {
      type: "status",
      models: S.models,
      error: S.error,
      ai: S.aiState,
      aiMs: S.aiMs,
      state: S.dir > 0 ? "vanishing" : S.dir < 0 ? "returning" : S.progress >= 1 ? "gone" : "visible",
      holes: plate ? Math.round(plate.holeFraction() * 100) : 100,
      fps: Math.round(S.fps),
      procMs: Math.round(S.procMs),
      timing: { hand: Math.round(T.hand), seg: Math.round(T.seg), learn: Math.round(T.learn), comp: Math.round(T.comp) },
      lastSnapAt: S.lastSnapAt,
      snapSource: S.snapSource,
      hasMic: detector.hasMic
    };
  }
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.__sv !== "init" || dataPort) return;
    dataPort = d.dataPort;
    ctlPort = d.ctlPort;
    dataPort.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "frame") onFrameMsg(m);
      else if (m.type === "click") {
        detector.hasMic = true;
        if (detector.feedClick(m.ts, m.ratio)) handleSnap("hand+mic");
      } else if (m.type === "mic") detector.hasMic = !!m.present;
    };
    ctlPort.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "cfg") updateCfg(m.cfg);
      else if (m.type === "snap-now") handleSnap("manual");
      else if (m.type === "rescan") {
        if (plate) plate.reset();
        lastAiAt = 0;
        S.aiState = workerReady ? "ready" : S.aiState;
      } else if (m.type === "get-status") post(ctlPort, { ...status(), reply: m.id });
    };
    setInterval(() => post(ctlPort, status()), 1e3);
    loadModels();
  });
})();
