# PHANTOM — QA & Performance Audit Report

**Scope:** full-codebase audit against the categories and test scenarios below.
No new features were added — every change is a bug fix or hardening of
existing behavior. All fixes are on `claude/project-requirements-review-p93qwl`.

**Method:** every source file in `src/` was read against each bug category
below, with the async control-flow of every camera/vision/recording call
path traced by hand. Where the sandbox permits (no real camera or MediaPipe
CDN access here — outbound requests to `storage.googleapis.com` /
`cdn.jsdelivr.net` are blocked), findings were also verified live via a
scripted Chromium session (`--use-fake-device-for-media-stream`). Findings
that require real hardware (an actual camera driver misbehaving, real GPU
context loss, a real MediaPipe load) are marked **verified by code trace**
rather than **verified live**, with the reasoning for why the trace is
conclusive spelled out per finding.

---

## Findings

### 1. Camera stream leak + pose-model load race on overlapping `enterCamera()` calls

- **Severity:** Critical
- **Cause:** `App.enterCamera()` had no reentrancy guard. It checked
  `camera.isActive()` / `poseVision.isReady()` and, if either was false,
  called `camera.start()` / `poseVision.init()` — but a second call arriving
  before the first resolved (a double-tap on **ENTER CAMERA**, or rapid
  clicks on the error overlay's **RETRY** while a previous attempt was still
  loading) would see the same "not active / not ready" state and kick off a
  **second**, fully independent `getUserMedia()` call and a **second**,
  fully independent MediaPipe `PoseLandmarker` load, concurrently with the
  first. Whichever attempt's promise resolved last silently overwrote
  `CameraController.stream` / `PoseVision.landmarker` — the loser's
  `MediaStream` tracks were never `.stop()`'d (camera hardware held forever,
  the OS camera indicator staying lit) and its `PoseLandmarker` was never
  `.close()`'d (a second WASM/GPU model instance resident in memory for the
  rest of the session). This directly matches the **camera stream leaks**
  and **model loading race conditions** categories, and is triggerable via
  test scenarios **#5** (permission granted then stopped, if the user
  double-taps), **#9/#10** (rapid RETRY while a slow model load is in
  flight), and **#16** (repeated camera start/stop cycles).
- **Fix:**
  - `App.ts`: `enterCamera()` is now a thin guard around a new
    `doEnterCamera()` — a second call while one is in flight returns the
    *same* promise instead of re-running the body at all
    (`enteringCameraPromise`).
  - `PoseVision.init()` and `CameraController.start()` were each also given
    their own internal in-flight guard (`initPromise` / `startPromise`), so
    concurrent calls from *any* caller — not just this one call site — share
    one attempt instead of racing. This is defense-in-depth: it makes both
    classes correct on their own terms, independent of caller discipline.
- **Verification:** verified live — a scripted double-click on **ENTER
  CAMERA** (Playwright, fake camera device) produces exactly one
  camera/vision attempt with no uncaught exceptions or unhandled promise
  rejections (checked via `page.on('pageerror')`). The leak itself (two
  independent `MediaStream`s / `PoseLandmarker`s) cannot be directly
  observed without a real camera + reachable MediaPipe CDN, both unavailable
  in this sandbox, but the fix is structural: with the guard in place there
  is no code path left that can start a second concurrent attempt, so the
  leak is eliminated by construction, not by making it less likely.
  `tsc --noEmit`, `vitest run` (122/122), and `npm run build` all pass
  after the change.

### 2. A failed camera switch left the camera fully stopped with only a misleading toast

- **Severity:** High
- **Cause:** `CameraController.switchFacing()` called `this.start({facing:
  next})`, and `start()` unconditionally calls `this.stop()` on the
  *current* stream before requesting the new one. If the new facing's
  `getUserMedia()` then failed (device has no second camera despite
  `canSwitchFacing` reporting true, a transient driver error, the camera
  taken by another app mid-switch), the old stream was already gone and
  nothing tried to bring it back — the camera ended up completely off.
  `App.switchCamera()`'s `catch` block only showed a 4-second auto-dismissing
  toast ("Failed to switch camera"), which reads as a minor, recoverable
  hiccup, not "the live camera view is now dead." The user was left staring
  at a blank/frozen feed with tracking silently reporting `LOST` forever,
  with no error overlay and no obvious way to recover short of guessing to
  hit BACK and re-enter. Matches **camera switching bugs** directly, and is
  test scenario **#6** (camera switched) combined with **#7** (camera
  unavailable).
- **Fix:**
  - `CameraController.switchFacing()` now remembers the facing mode active
    before the switch and, if the new facing fails to start, attempts to
    restart that previous facing before rethrowing the original error — a
    failed switch now degrades to "keeps working as it did before" instead
    of "camera is off," in the common case where the old facing mode still
    works.
  - `App.switchCamera()`'s `catch` now checks `camera.isActive()` after a
    failure: if the fallback above succeeded, the existing toast is enough
    (the live view is fine). If both facings failed and the camera really is
    stopped, it now escalates to the same fatal-error overlay
    `enterCamera()` uses (`handleFatalError`), whose **RETRY** button
    correctly restarts the camera (since `camera.isActive()` is now false,
    `enterCamera()` calls `camera.start()` again on retry).
- **Verification:** verified by code trace — reproducing a real second-camera
  failure needs a device with a driver that rejects the second facing mode,
  which isn't available in this sandbox. The trace is conclusive because the
  fix only changes what happens after `switchFacing()` rejects (an already-
  exercised, existing error path) and after `camera.isActive()` returns
  false (a deterministic function of `CameraController.stream`) — both
  branches were manually walked against the updated source. `tsc`, `vitest`,
  and `build` all pass.

### 3. `waitForVideoReady()` could hang forever, freezing the app on the loading screen

- **Severity:** Medium
- **Cause:** After `getUserMedia()` and `video.play()` succeeded,
  `CameraController.start()` awaited `waitForVideoReady()`, which resolved
  only on the video element's `loadedmetadata` event — with no timeout. A
  stream that is granted but never actually delivers a frame (a real,
  documented device/driver failure mode, and one shape of test scenario
  **#7**, "camera unavailable") left this promise pending indefinitely,
  which in turn left `enterCamera()`'s `await Promise.all(...)` pending
  forever: the user would be stuck on the loading spinner permanently, with
  no error, no timeout, and no way out except reloading the page.
- **Fix:** `waitForVideoReady()` now races the `loadedmetadata` listener
  against a 10-second timeout; on timeout it rejects with a `CameraError`
  (cleaning up the listener either way), which `start()` now catches to
  `stop()` the half-opened stream before rethrowing — so a stuck stream now
  surfaces as a normal, actionable error instead of an infinite spinner.
- **Verification:** verified by code trace (this failure mode needs a real
  camera stream that grants permission but never emits `loadedmetadata`,
  which cannot be simulated with Chromium's fake-device flag — the fake
  device does emit metadata normally). The fix is a bounded, deterministic
  timeout with a single rejection path, verified by inspection to always
  settle and to always clean up both the listener and the pending timer.
  `tsc`, `vitest`, and `build` all pass.

### 4. `SceneManager`'s WebGL context-loss handling was unrecoverable, and its listener couldn't be removed

- **Severity:** Low
- **Cause:** Two related issues in `SceneManager`'s constructor:
  1. The `webglcontextlost` listener was registered as an inline arrow
     function with no stored reference, so `dispose()` had no way to ever
     remove it — a latent event-listener leak, currently unreachable only
     because nothing calls `dispose()` today (see the note under "Areas
     audited, no issues found" below).
  2. There was no `webglcontextrestored` handling at all. A context loss
     (a real, if infrequent, occurrence — GPU driver reset, some mobile
     browsers reclaiming GPU memory when backgrounded) called `this.stop()`
     and stopped the render loop permanently. Even if the browser later
     fired `webglcontextrestored` and Three.js recovered its internal GL
     state, nothing in this codebase ever called `start()` again — the 3D
     overlay would stay frozen/blank for the rest of the session with no
     error shown, since `stop()` alone doesn't surface a user-facing error.
     Matches **WebGL context issues** directly.
- **Fix:** Both handlers are now named class fields (`handleContextLost` /
  `handleContextRestored`) instead of anonymous closures, so `dispose()` can
  actually remove them. A new `resumeOnContextRestore` flag records whether
  the render loop was actually running at the moment the context was lost;
  `handleContextRestored` resumes the loop only in that case, so a context
  loss that happens (or is restored) while the user isn't even on the camera
  screen doesn't resurrect a loop nobody asked for.
- **Verification:** verified by code trace — forcing a real
  `webglcontextlost`/`webglcontextrestored` pair requires either a GPU-level
  fault or a debug extension (`WEBGL_lose_context`) that behaves differently
  across browsers; the logic itself (flag set exactly when the loop was
  running, read-and-cleared exactly once on restore) was verified by
  inspection to have no path that double-starts the loop or resumes a loop
  the user had already stopped via `exitCamera()`. `tsc`, `vitest`, and
  `build` all pass.

---

## Areas audited, no issues found

For each bug category and test scenario in the original request, here is
what was specifically checked and confirmed clean, beyond the four findings
above:

- **TypeScript errors:** `tsc --noEmit` is clean (strict mode, plus
  `noUnusedLocals`/`noUnusedParameters`/`noFallthroughCasesInSwitch`/
  `erasableSyntaxOnly`) both before and after every fix in this pass.
- **Runtime errors / unhandled promises:** every `void this.someAsyncMethod()`
  fire-and-forget call site (`onRetry`, `onEnterCamera`, `onCameraSwitch`)
  routes into a method with its own top-level `try/catch` that never rethrows,
  so none can produce an unhandled rejection. `Promise.all([cameraPromise,
  visionPromise])` in `enterCamera()` does not create an unhandled-rejection
  risk either: `Promise.all` attaches handlers to *every* promise passed to
  it internally, even though it only surfaces the first rejection — a common
  misconception worth ruling out explicitly. Verified live: the Playwright
  smoke pass (landing screen, double-click entry, three repeated enter/exit
  cycles, two resize events) produced zero `pageerror` events (which fire for
  both uncaught exceptions and unhandled promise rejections) across every
  scenario.
- **Memory leaks / unnecessary allocations in animation loops:** `Avatar`,
  `IndependentShadowEffect`, `CloneEffect`, `GhostEffect`, `ReverseEffect`,
  `DebugSkeleton`, `CoordinateMapper`, `LandmarkSmoother`, and `OneEuroFilter`
  all pre-allocate every `Vector3`/`Quaternion`/`Object3D` scratch value and
  every geometry/material exactly once (in a constructor or module scope) and
  only ever mutate them in `update()`/`updateFromTracking()`. `CloneEffect`
  and the `IndependentShadowEffect`'s spring integrator use fixed-size pools
  (5 clones max, one `Vector3` velocity per landmark) rather than allocating
  per frame. `GhostEffect`'s motion trail renders through `InstancedMesh` (one
  draw call per trail step covering every echoed joint) rather than one mesh
  per joint — an already-documented, already-profiled optimization.
  `TrackingHistory` is a true fixed-capacity ring buffer; `push()` copies into
  an existing slot rather than allocating a new frame object.
- **Event listener leaks:** every listener attached with an inline closure in
  a component that's constructed once for the app's lifetime (`CameraScreen`,
  `LandingScreen`, `App`'s own `resize` listener) is intentionally never
  removed, since these objects are never torn down — this is a deliberate,
  consistent single-page-app pattern, not a leak. The two listeners that
  genuinely toggle (the settings-drawer and "how it works" panel's `Escape`
  keydown handlers on `document`) are correctly paired: both are added on
  open and removed on every close path, including `CameraScreen.hide()`'s
  defensive cleanup if the drawer happened to be open when the user backs
  out. The one real gap found (`SceneManager`'s anonymous
  `webglcontextlost` listener) is Finding #4, fixed above.
- **Camera stream leaks / camera switching bugs / model loading race
  conditions:** the root cause (Finding #1) and the switch-specific failure
  mode (Finding #2) are fixed above; no further concurrency gaps were found
  in `CameraController` or `PoseVision` after the fix (both now serialize
  their own concurrent callers).
- **Resize bugs / orientation bugs:** `SceneManager` resizes via
  `ResizeObserver` on the actual container element (not `window`), clamps
  `devicePixelRatio` to 2, and recomputes the camera's aspect/projection
  matrix on every resize — verified live across two simulated
  orientation flips (844×390 ↔ 390×844) with no console errors.
  `TrackingManager.notifyViewportChanged()` is wired to `window`'s `resize`
  event and recomputes the `object-fit: cover` crop math independently of
  the camera's own aspect ratio. `index.html` uses `100dvh` (not the classic
  mobile-Safari-buggy `100vh`) plus `viewport-fit=cover`, and `styles.css`
  applies `env(safe-area-inset-*)` on every edge — this was already fixed in
  the prior UI-polish phase and remains correct.
- **Mirrored-camera bugs:** the mirroring pipeline has exactly one flip point
  (`transformLandmarkForRender`), driven by a single `cameraMirrored` boolean
  threaded through `TrackingManager`, `CameraScreen.setMirrored` (CSS-only,
  video element only), and `RecordingManager`'s composite draw (which
  reproduces the same CSS flip in software, since `drawImage()` ignores CSS
  transforms). `App.switchCamera()` correctly re-derives `cameraMirrored`
  from the *new* facing mode after every switch, including the fallback path
  added in Finding #2.
- **Recording bugs:** `RecordingManager.reset()`/`dispose()`'s
  `discardOnStop` flag correctly guards against the async `onstop` handler
  resurrecting a discarded recording after a mid-recording reset (e.g. the
  user backs out of the camera screen while recording). `start()` is a
  synchronous no-op while already recording (test scenario **#15**, repeated
  record/re-record cycles, cannot double-start). Every pre-flight failure
  (`unsupported`, `camera-unavailable`, `zero-size-canvas`) throws
  synchronously and is caught at the one call site in `App.ts`; every
  post-start failure (`context-lost`, `start-failed`) reports through the
  `onError` callback instead — no unhandled path either way.
- **WebGL context issues:** see Finding #4. `RecordingManager` already
  correctly stores its own `contextLostHandler` as a named field and removes
  it in `dispose()` — it was the reference implementation this report's
  fix for `SceneManager` was modeled on.
- **Mobile layout problems:** see "Resize bugs / orientation bugs" above;
  also confirmed 44px-minimum touch targets remain intact (`min-height: 44px`
  present throughout `styles.css`) and the effect rail / bottom bar don't
  overlap at the simulated 390×844 mobile viewport used in the live smoke
  pass.
- **Tracking-loss instability:** `TrackingManager`'s state machine
  (`INITIALIZING → TRACKING → RECOVERING → LOST`, `LOSS_GRACE_MS = 600`) and
  every effect's own "hide/freeze on `!trackingFrame.present`" branch were
  re-checked; each effect leaves its own avatar's last pose frozen (not
  reset) during a brief dropout so a one-frame miss doesn't visibly glitch,
  matching test scenarios **#11/#12** (user leaves/returns frame).
  `OneEuroFilter.reset()` is called on `LOST`/re-`INITIALIZING` but
  deliberately not on `RECOVERING`, so a brief dropout doesn't restart the
  smoothing filter's adaptation from cold.
- **Performance goals:**
  - *Stable animation loop:* `SceneManager.start()` already had (and still
    has) a correct reentrancy guard (`if (this.rafHandle !== null) return;`)
    — the positive counter-example that made Finding #1's missing guard in
    `App.enterCamera()` stand out during this audit.
  - *No obvious memory growth during long sessions:* confirmed via the
    allocation audit above — no per-frame heap allocation was found in any
    hot path (detection, tracking, effects, rendering, recording composite
    draw).
  - *Reasonable inference cadence:* `App`'s adaptive `detectIntervalMs`
    (derived from a rolling average of actual inference duration ×
    `DETECT_INTERVAL_SAFETY_FACTOR`, clamped to `[1000/30, 250]` ms) is
    unchanged and unaffected by this pass's fixes — still decoupled from the
    render loop's own frame rate.
  - *Low unnecessary GPU work:* no additional draw calls, render targets, or
    post-processing were introduced by any fix; `GhostEffect`'s trail
    remains one draw call per step as already optimized.

---

## Test scenario coverage

| # | Scenario | Coverage |
|---|---|---|
| 1 | Desktop camera | Code trace + live smoke pass (fake device) |
| 2 | Mobile front camera | Code trace + live smoke pass at mobile viewport |
| 3 | Mobile rear camera | Code trace (facing logic identical to #2; `canSwitchFacing` requires real hardware) |
| 4 | Permission denied | Code trace (`CameraError('permission-denied')` path, existing + unchanged) |
| 5 | Permission granted then stopped | Code trace — Finding #1's guard directly targets this |
| 6 | Camera switched | Code trace — Finding #2 |
| 7 | Camera unavailable | Code trace — Finding #3 |
| 8 | WebGL unsupported | Code trace (existing `isWebGLAvailable()` proactive check, unchanged, still correct) |
| 9 | MediaPipe initialization failure | **Verified live** — this sandbox's blocked CDN reproduces this scenario naturally; confirmed graceful error handling with zero uncaught exceptions |
| 10 | Model loading failure | **Verified live** (same as #9) |
| 11 | User leaves the frame | Code trace (tracking-loss instability, above) |
| 12 | User returns | Code trace (RECOVERING grace period, above) |
| 13 | Effect switched during tracking | Code trace (each effect's `enable()`/`disable()` visibility symmetry, already fixed in a prior phase, re-verified intact) |
| 14 | Recording started and stopped | Code trace (RecordingManager state machine, above) |
| 15 | Repeated record/re-record cycles | Code trace (`start()`'s no-op guard, `discardOnStop`) |
| 16 | Repeated camera start/stop cycles | **Verified live** (3 scripted enter/exit cycles, zero errors) |
| 17 | Browser window resized | **Verified live** (2 scripted resize events, zero errors) |
| 18 | Portrait/landscape changes | **Verified live** (same resize test, 844×390 ↔ 390×844) |

---

## Verification checklist

- [x] **Type checks:** `npx tsc --noEmit` — clean, no errors.
- [x] **Production build:** `npm run build` — succeeds
  (`tsc && vite build`); output unchanged in shape from before this pass
  (one pre-existing, unrelated chunk-size warning — see note below).
- [x] **Lint:** no lint tool is configured in this project (`package.json`
  has no `eslint`/`lint` script or config file) — `tsc --noEmit` in strict
  mode is the only static check this repository runs, and it is clean.
- [x] **No console errors in normal operation:** verified via a scripted
  Playwright session (Chromium, `--use-fake-device-for-media-stream`)
  covering the landing screen, a double-click on ENTER CAMERA, three
  repeated enter/exit cycles, and two resize events. Zero `pageerror`
  events (uncaught exceptions or unhandled promise rejections) across every
  scenario. The only `console.error` output observed is this sandbox's
  expected, already-handled CDN-blocked failure (`net::ERR_TUNNEL_CONNECTION_FAILED`
  loading MediaPipe's WASM/model from `storage.googleapis.com`/
  `cdn.jsdelivr.net`), which the app already turns into a proper
  user-facing error overlay rather than crashing — this is expected sandbox
  behavior, not a defect.
- [x] **Automated test suite:** `npx vitest run` — 122/122 tests pass across
  12 files, unchanged from before this pass (no test needed updating, since
  no fix changed any function's observable contract — only internal
  concurrency guards and failure-path behavior that wasn't under test).

**Note on the build's chunk-size warning:** `npm run build` prints an
existing, pre-audit warning that the main JS chunk is >500 kB
(MediaPipe + Three.js are both large). This is already tracked in
`TODO.md` ("Bundle-size optimization: lazy-load MediaPipe Tasks Vision...")
as a known, deliberate future improvement, not a regression from this pass
and not a "major new feature" this audit should undertake.

---

## Summary

One critical bug (concurrent camera/vision initialization, causing real
resource leaks) and three related lower-severity bugs (a camera switch that
could kill the camera with no recovery path, an unbounded hang in the camera
startup sequence, and unrecoverable WebGL context loss) were found and
fixed, all within the four explicit categories most exposed to timing/race
conditions: **camera stream leaks**, **camera switching bugs**, **model
loading race conditions**, and **WebGL context issues**. The remaining
twelve bug categories and all eighteen test scenarios were audited against
the current codebase and found already correctly handled, per the detail
above — no other code changes were made. No existing tests needed
modification, and no new features were added.
