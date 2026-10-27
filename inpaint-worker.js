// MI-GAN (Picsart AI Research) running through onnxruntime-web (WASM, single thread) — fully local.
import * as ort from './wasm/ort.wasm.min.mjs';

let session = null;
async function init(base) {
  ort.env.wasm.wasmPaths = base + 'wasm/';
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  const buf = await (await fetch(base + 'models/migan.onnx')).arrayBuffer();
  session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
}

async function run(rgba, mask) {
  const N = 512 * 512, x = new Float32Array(4 * N);
  for (let i = 0; i < N; i++) {
    const m = mask[i], keep = 1 - m;
    x[i] = 0.5 - m;                                         // channel 0: known - 0.5
    x[N + i] = (rgba[i * 4] / 127.5 - 1) * keep;            // erased RGB in [-1, 1]
    x[2 * N + i] = (rgba[i * 4 + 1] / 127.5 - 1) * keep;
    x[3 * N + i] = (rgba[i * 4 + 2] / 127.5 - 1) * keep;
  }
  const out = (await session.run({ input: new ort.Tensor('float32', x, [1, 4, 512, 512]) })).output.data;
  const res = new Uint8ClampedArray(4 * N);
  for (let i = 0; i < N; i++) {
    res[i * 4] = out[i] * 127.5 + 127.5; res[i * 4 + 1] = out[N + i] * 127.5 + 127.5; res[i * 4 + 2] = out[2 * N + i] * 127.5 + 127.5; res[i * 4 + 3] = 255;
  }
  return res;
}

self.onmessage = async (e) => {
  const d = e.data;
  try {
    if (d.type === 'init') { await init(d.base); self.postMessage({ type: 'ready' }); }
    else if (d.type === 'run') {
      const t = performance.now();
      const res = await run(d.rgba, d.mask);
      self.postMessage({ type: 'result', id: d.id, rgba: res, ms: performance.now() - t }, [res.buffer]);
    }
  } catch (err) { self.postMessage({ type: 'error', id: d.id, message: String(err && err.message || err) }); }
};
