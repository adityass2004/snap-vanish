# Snap Vanish

Snap your fingers on a Meet / Teams / Zoom (web) call: you turn to dust and blow away, the room behind you is
filled in, and your mic mutes. Snap again: the dust flies back, you reappear, mic unmutes.

## Install
1. Chrome → `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the `ext/` folder (or unzip `snap-vanish.zip` and select that).
3. Join a call. Open the popup: it shows "Watching for your snap" once models are loaded (a few seconds).

Tips: for the best empty room, step out of frame for ~2 s after joining (or press **Re-scan room** and step out).
Anything you never uncover is filled in by the AI (MI-GAN) instead.

## Controls
Popup: on/off, **Snap now**, sensitivity, dust duration, mic-confirm, auto-mute, re-scan.
Shortcuts (change at `chrome://extensions/shortcuts`): **Alt+Shift+S** snap now, **Alt+Shift+V** on/off.

## How it works (all local)
- `inject.js` (page world) wraps `getUserMedia`; camera frames go to an extension iframe, processed frames come back.
- Snap = hand tracking (MediaPipe Hands) sees thumb–finger pinch → fast release, AND the mic hears a click within
  ~0.3–0.5 s. Typing/clapping alone, or slow hand movement alone, won't trigger it.
- Person mask: MediaPipe selfie segmentation. Room: learned from pixels where you aren't, holes filled by diffusion
  then MI-GAN inpainting (ONNX, WASM) in a worker.
- Mic: a gain gate on the raw mic goes to 0, and the app's own mute button is clicked (best effort) so its UI agrees.
- No network requests are made; all models/wasm ship inside the extension.

Source: `src/` (bundled with `node build.mjs`), `test-snap.mjs` unit-tests the snap logic.

## AI room fill model
`migan.onnx` (26 MB) is sent separately because of upload limits. Put it at `ext/models/migan.onnx` before
loading the extension. Without it everything still works, but never-seen areas use a smoother diffusion fill.
