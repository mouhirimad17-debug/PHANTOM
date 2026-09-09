# Testing

This document covers what's automated (`npm test`), what's deliberately
manual-only and why, and the manual verification checklist to run before
shipping a change. See [QA_REPORT.md](./QA_REPORT.md) for the record of
what was actually run and found during the production-readiness pass.

## Automated checks

```bash
npx tsc --noEmit   # type check — also runs as part of `npm run build`
npm test           # vitest run — the unit suite below
npm run build      # type-checks, then produces the production bundle
```

There is no separate lint step: this project relies on `tsc`'s strict mode
(`strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`)
as its static check rather than a dedicated ESLint config. If a lint tool
is added later, wire it into `package.json`'s `scripts` and this doc.

### What the unit suite covers

12 test files, all pure/deterministic — no real camera, GPU, or network
access needed, which is exactly why these particular modules were chosen
for automated coverage:

| File | Covers |
|---|---|
| `tracking/transformLandmarkForRender.test.ts` | The single mirroring flip point — mirrored vs. unmirrored, edge values |
| `tracking/CoordinateMapper.test.ts` | Cover-crop math + mirroring compensation end to end |
| `tracking/OneEuroFilter.test.ts` | Adaptive smoothing behavior (still vs. fast motion, cutoff behavior) |
| `tracking/TrackingManager.test.ts` | The INITIALIZING/TRACKING/RECOVERING/LOST state machine, including the grace-period boundary |
| `tracking/TrackingHistory.test.ts` | Ring-buffer push/getLatest/getAtOffset/clear, including wraparound and out-of-window lookups |
| `avatar/limbMath.test.ts` | Segment position/orientation/length math, including the degenerate (coincident-endpoint) case |
| `avatar/Avatar.test.ts` | Display-mode swapping, visibility/opacity, zero-allocation update contract |
| `effects/IndependentShadowEffect.test.ts` | Spring settle behavior, drift factors, enable/disable/reset lifecycle |
| `effects/CloneEffect.test.ts` | Count/mode changes, pool reuse (no avatar recreation), SAME/DELAYED/SPREAD arrangements |
| `effects/GhostEffect.test.ts` | Breathing/drift determinism, trail step behavior, enable/disable/reset |
| `effects/reverseTransforms.test.ts` | The three pure transform functions in isolation (mirror, rotation, limb-motion inversion) |
| `effects/ReverseEffect.test.ts` | Preset switching, the enable/disable visibility-restore fix, DELAYED_MIRROR history sampling |

Run `npm test` for full output; as of this pass, all 122 tests across these
12 files pass.

### Why some modules have no automated test

`CameraController`, `PoseVision`, `SceneManager`, and `RecordingManager`
each depend on a real browser API this project's Node-based vitest
environment cannot provide meaningfully: `getUserMedia`, a real MediaPipe
model + WASM/GPU delegate, a real `WebGLRenderingContext`, and
`HTMLCanvasElement.captureStream()`/`MediaRecorder` respectively. Mocking
all of these deeply enough to catch real bugs (the kind this project has
actually hit — see QA_REPORT.md's race-condition findings) would mostly
test the mocks, not the code. These are covered by the manual/scripted
checklist below instead, and by code-trace verification where even that
isn't reachable in a sandboxed environment (documented per-finding in
QA_REPORT.md).

## Manual verification checklist

Run this in a real browser with a real camera before shipping a change
that touches camera, vision, tracking, effects, recording, or the UI shell.

### Core flow

- [ ] Landing screen loads with no console errors; **ENTER CAMERA** and
      **HOW IT WORKS** both work.
- [ ] **ENTER CAMERA** prompts for camera permission, then shows a live
      feed with the avatar tracking your body within a couple of seconds.
- [ ] The top-bar status pill reads LIVE while tracked, and SEARCHING/NO
      BODY appropriately when you step out of frame.
- [ ] **BACK** returns to the landing screen and visibly stops the camera
      (the OS/browser camera-in-use indicator turns off).
- [ ] Re-entering after BACK works repeatedly without degradation (try 5+
      cycles) — no growing memory use, no slowdown, no duplicate error
      overlays.

### Camera behavior

- [ ] Deny camera permission → a clear, specific error message appears
      (not a generic failure), with a working RETRY.
- [ ] Grant permission, then revoke it in browser settings mid-session →
      next camera-dependent action fails gracefully, not silently.
- [ ] On a device with more than one camera: the camera-switch button
      appears and works; mirroring flips correctly for front vs. back.
- [ ] On a device with only one camera: the camera-switch button stays
      hidden (no dead button).
- [ ] Double-tap/rapid-click **ENTER CAMERA**: exactly one camera session
      starts — no duplicate permission prompts, no console errors, no
      leftover "camera in use" indicator after leaving.
- [ ] Rapid-click **RETRY** on an error overlay: same — no duplicate
      attempts, no crash.

### Tracking quality

- [ ] Step fully out of frame, then back in: status goes LIVE → NO BODY →
      (briefly SEARCHING) → LIVE again, with the avatar's last pose held
      steady during the brief dropout rather than snapping to a default
      pose.
- [ ] Move at a normal pace: the avatar tracks smoothly with no visible
      jitter and no perceptible lag.
- [ ] Turn side-on to the camera: the avatar's proportions stay plausible
      (no limb stretching or collapsing).

### Effects

For each of SHADOW, CLONE, GHOST, REVERSE:

- [ ] Toggling it on shows the effect immediately; toggling off then back
      on shows it again (not permanently invisible — this was a real,
      fixed bug).
- [ ] Every slider/segmented control in its settings-panel section visibly
      changes its behavior.
- [ ] Switching effects while tracking is live doesn't cause a visible
      glitch or console error.
- [ ] Multiple effects enabled simultaneously behave sensibly together
      (the debug-mode "Effect" stat lists all active effects — see
      "Developer / debug mode" below).

### Recording

- [ ] RECORD starts a capture (REC indicator pulses); STOP opens a preview
      with working playback.
- [ ] RETAKE discards the preview and returns to a live, still-working
      camera view, ready to record again.
- [ ] SAVE triggers a real file download; the saved file plays back
      correctly and matches what was on screen (correct mirroring, correct
      crop, effects visible).
- [ ] Repeat record → retake at least 3 times in a row: no degradation, no
      leftover object URLs accumulating (check the browser's memory tab if
      unsure), no stale preview video.
- [ ] On a browser without recording support: the record button is hidden
      and a note explains why; nothing else in the app breaks.

### Resize / orientation

- [ ] Resize the browser window: the 3D overlay and the video crop both
      adjust immediately, staying aligned with each other.
- [ ] Rotate a mobile device between portrait and landscape: same — no
      misalignment, no layout overlap (effect rail, bottom bar, and any
      open toast should never visually collide).

### Errors

- [ ] Simulate WebGL being unavailable (or test on a device/browser that
      lacks it): the landing screen proactively disables ENTER CAMERA with
      an explanatory note, rather than letting the user hit a dead end.
- [ ] Block network access to `storage.googleapis.com`/`cdn.jsdelivr.net`
      (or use a real network failure): a clear "failed to load the pose
      model" error appears, with working RETRY/BACK.
- [ ] Force a WebGL context loss if your browser supports it (e.g. via the
      `WEBGL_lose_context` extension in devtools): rendering stops
      gracefully; if the context is restored, rendering resumes on its own.

### Developer / debug mode

- [ ] Load the app normally (no query param): the settings panel does
      **not** show a "Display" section with FPS/tracking diagnostics — only
      the per-effect sections (Shadow/Clone/Ghost/Reverse).
- [ ] Load with `?debug=1`: the "Display" section appears, showing live
      FPS, vision status, tracking state, confidence, landmark count,
      inference time, active effect(s), and the raw/render/mirrored
      diagnostic — and a working skeleton-overlay toggle.
- [ ] Reload without the query param after having enabled it once: debug
      mode stays on (persisted via `localStorage`).
- [ ] Load with `?debug=0`: debug mode turns off and stays off on reload.

### Mobile-specific checks

- [ ] Safe-area insets are respected on a notched device (top HUD and
      bottom bar don't sit under a notch/home indicator) in both
      orientations.
- [ ] All interactive controls meet a 44px-minimum touch target.
- [ ] The page never scrolls (no rubber-banding, no visible page-level
      scrollbar) — the camera experience fills the viewport using `100dvh`,
      not the classic mobile-Safari-buggy `100vh`.
- [ ] Backgrounding the browser tab (switching apps) and returning does not
      leave the app in a broken state — camera resumes or a clear error is
      shown.

## Sandboxed/CI verification limitations

Some checks above genuinely cannot be automated or run in a headless/
sandboxed CI environment: real camera hardware, real GPU context loss, and
reachability of MediaPipe's CDN from a network-restricted sandbox. Where
this project's own QA passes couldn't reach a real camera or the MediaPipe
CDN, findings were verified by one of two methods, and each is labeled as
such in QA_REPORT.md:

- **Live scripted verification**: headless Chromium with
  `--use-fake-device-for-media-stream`, which exercises the real
  `getUserMedia`/`MediaRecorder`/DOM code paths against a synthetic camera
  feed — this catches real crashes, unhandled rejections, and console
  errors, just not visual/tracking correctness (there's no real body to
  track).
- **Code-trace verification**: for failure modes needing real hardware
  (a driver rejecting a facing mode, actual GPU context loss), the async
  control flow was traced by hand against the exact updated source, with
  the reasoning documented per finding.

Anyone testing on a real device should still work through the manual
checklist above — it's the authoritative check for anything visual or
hardware-dependent.
