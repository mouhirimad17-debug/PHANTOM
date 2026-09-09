# Architecture

This document describes PHANTOM's current architecture: the module map, the
per-frame data flow, and the key design decisions behind the trickier parts
of the system (mirroring, coordinate mapping, the tracking state machine,
adaptive inference throttling, and the recording pipeline). It reflects the
codebase as of the production-readiness pass — see
[QA_REPORT.md](./QA_REPORT.md) for the audit history and
[TESTING.md](./TESTING.md) for how each piece is verified.

## Module map

```
src/
  app/          App.ts — top-level orchestrator; owns screen transitions
                 and translates module errors into user-facing messages.
                 Contains no rendering or detection logic itself.
  camera/       CameraController — MediaStream lifecycle for one <video>.
  vision/       PoseVision — wraps MediaPipe Tasks Vision's PoseLandmarker.
  tracking/     TrackingManager, CoordinateMapper, LandmarkSmoother,
                OneEuroFilter, TrackingHistory, trackingFrame,
                transformLandmarkForRender — turns raw model output into a
                stable, mirrored, scene-space TrackingFrame.
  avatar/       Avatar, limbMath, avatarGeometry — the procedural 3D
                humanoid every effect renders.
  effects/      Effect interface + IndependentShadowEffect, CloneEffect,
                GhostEffect, ReverseEffect, reverseTransforms.
  rendering/    SceneManager (Three.js scene/camera/renderer/render loop),
                DebugSkeleton (debug-mode-only diagnostic overlay).
  recording/    RecordingManager — composites and records the visible scene
                locally via MediaRecorder.
  ui/           CameraScreen, LandingScreen, styles.css — the DOM shell;
                owns no tracking/effect/recording logic itself, only
                callbacks into App.
  utils/        Small, dependency-free helpers (math, WebGL detection,
                FPS counting, DOM lookup, debug-mode flag, pose landmark
                indices/connections).
  types/        Shared type/error definitions per domain (camera, vision,
                tracking, recording).
```

Dependencies flow one way: `ui` and `app` depend on everything else, but
`camera`, `vision`, `tracking`, `avatar`, `effects`, `rendering`, and
`recording` never depend on `app` or `ui`. Each of those modules is
independently testable (see TESTING.md) and knows nothing about screens,
buttons, or user-facing copy.

## Data flow (per rendered frame)

1. `SceneManager` runs a `requestAnimationFrame` loop and fires its
   `onFrame` listeners every frame with the real elapsed delta time.
2. `App.handleFrame()` (the one `onFrame` listener) checks whether enough
   time has passed since the last pose-detection call (see "Adaptive
   inference throttling" below) — if so, it runs detection.
3. `PoseVision.detect()` runs the model synchronously on the current video
   frame and returns raw, normalized MediaPipe landmarks, or `null` if
   nothing was detected this call.
4. `TrackingManager.update()` takes that raw result and produces a
   `TrackingFrame`: it advances the tracking state machine
   (INITIALIZING → TRACKING → RECOVERING → LOST), applies per-joint One
   Euro Filter smoothing, and maps each landmark into Three.js scene space
   via `CoordinateMapper` — which is also where the app's single mirroring
   flip happens (see "Mirroring" below).
5. `Avatar.updateFromTracking()` and every enabled `Effect.update()` read
   that same `TrackingFrame` and update their own Three.js objects'
   transforms/materials in place — nothing is created or destroyed per
   frame (see "Object pooling" below).
6. `SceneManager` calls `renderer.render()`.
7. `SceneManager`'s `onAfterRender` listeners fire — this is where
   `RecordingManager`, if actively recording, draws the just-rendered frame
   into its private composite canvas (see "Recording" below). This runs
   *after* render deliberately, so it captures this frame's pixels, not the
   previous one's.

## Key design decisions

### Mirroring

There is exactly **one** place in the entire codebase where a coordinate is
ever flipped for mirroring: `transformLandmarkForRender()`. Everything else
— `CameraScreen`'s CSS mirror on the `<video>` element, `CoordinateMapper`,
and `RecordingManager`'s composite draw — reads a single `cameraMirrored`
boolean (derived from which camera is active: the front/"user" camera is
mirrored, the rear/"environment" camera is not) and either applies or
doesn't apply the *same* transform. This was a deliberate fix for an early
bug where the skeleton moved opposite to the body because two separate
layers were each mirroring independently. The canvas holding the 3D
overlay is never CSS-mirrored — only the `<video>` element is — because the
overlay's mirroring is baked into its coordinates in software instead;
mirroring both would double-flip it.

### Coordinate mapping

MediaPipe's normalized landmarks (`[0,1]`, origin top-left, relative to the
raw camera frame) are not what's displayed — the `<video>` element uses
CSS `object-fit: cover`, which crops the frame to fill its container.
`computeCoverCrop()` computes exactly which fraction of the raw frame is
actually visible for the current video/container aspect ratio, and
`CoordinateMapper` uses that crop rectangle (plus the mirroring flip above)
to convert each landmark into the same space the user actually sees, then
into Three.js world coordinates. Getting this wrong is what causes a
skeleton that "looks right at some aspect ratios and drifts at others" —
this is why `notifyViewportChanged()` is wired to `window`'s `resize`
event, so a resize or orientation change recomputes the crop immediately
rather than leaving it stale.

### Smoothing: One Euro Filter

Raw per-frame landmark positions are noisy enough to look jittery if
rendered directly. `LandmarkSmoother` runs a per-axis, per-joint
[One Euro Filter](https://cristal.univ-lille.fr/~casiez/1euro/) (Casiez,
Roussel & Vogel 2012) — an adaptive filter that smooths more when a joint
is nearly still (to kill jitter) and less when it's moving fast (to avoid
visible lag on deliberate motion), which is a better trade-off for this use
case than a fixed-window moving average. Filters reset when tracking is
lost or reinitializing, but deliberately **not** during a brief
`RECOVERING` dropout, so a one-frame miss doesn't restart smoothing from
cold and cause a visible jump.

### Tracking state machine

```
INITIALIZING -> (detection) -> TRACKING -> (dropout) -> RECOVERING -> (grace period elapses) -> LOST
                                    ^                         |
                                    +---- (detection) --------+
```

`RECOVERING` exists so a single missed detection (the model occasionally
returns nothing for one frame even with a body in view) doesn't
immediately hide the avatar or reset smoothing — it's treated as "probably
still there" for a short grace period (`LOSS_GRACE_MS`) before formally
declaring `LOST`. `TrackingFrame.present` is true for both `TRACKING` and
`RECOVERING` (safe to render); `TrackingFrame.lost` is true only for `LOST`.

### Adaptive inference throttling

Pose inference is decoupled from the render loop's frame rate: the render
loop always runs at display refresh rate, but `App` only calls
`PoseVision.detect()` at most every `detectIntervalMs`, which is derived
from a rolling average of how long inference has actually been taking on
this device (`avgDetectDurationMs * DETECT_INTERVAL_SAFETY_FACTOR`),
clamped to a sane range. This means a slow device automatically infers less
often instead of blocking rendering or accumulating a backlog — the render
loop, UI, and effect animation stay smooth even when the model itself is
slow.

### Reentrancy guards

Three async entry points guard against being invoked while already in
flight, sharing the same in-flight `Promise` instead of racing a second
attempt: `App.enterCamera()`, `CameraController.start()`, and
`PoseVision.init()`. This was a real, fixed bug (see QA_REPORT.md) — a
double-tap on ENTER CAMERA used to start two concurrent camera streams and
two concurrent model loads, silently leaking whichever one didn't win.
`SceneManager.start()` has the same kind of guard (`rafHandle !== null`)
against double-starting the render loop.

### Object pooling / zero-allocation hot paths

Every per-frame code path — tracking, smoothing, coordinate mapping, avatar
updates, and every effect's `update()` — is designed to allocate nothing.
Scratch `Vector3`/`Quaternion`/`Object3D` values are created once (in a
constructor or module scope) and mutated in place; `TrackingFrame` objects
are likewise allocated once and mutated, never reconstructed per frame;
`TrackingHistory` is a fixed-capacity ring buffer that copies into existing
slots. `CloneEffect` pre-allocates a fixed pool of `Avatar` instances (sized
to the largest selectable clone count) rather than creating/destroying
avatars as the count changes. `GhostEffect`'s motion trail renders through
one `InstancedMesh` per trail step (covering every echoed joint in a single
draw call) rather than one mesh per joint, after profiling showed the
naive version costing roughly 3x the base avatar's render time under CPU
throttling.

## Camera (`camera/CameraController.ts`)

Owns the `MediaStream` lifecycle for one `<video>` element: `start()`,
`stop()`, `switchFacing()`, capability detection (`canSwitchFacing`, from
`MediaStreamTrack.getCapabilities().facingMode`), and typed `CameraError`s
covering permission denial, no camera found, camera already in use,
insecure context, and unsupported browsers. `stop()` always stops every
track on the current stream before clearing it — this is the single place
camera hardware is ever released, and it runs unconditionally whenever the
app leaves the camera experience (`App.exitCamera()`) or starts a new
stream (`start()` calls `stop()` first). `switchFacing()` falls back to
restoring the previously-active facing mode if the new one fails to start,
so a failed camera switch degrades to "camera keeps working as before"
rather than leaving the camera stopped with no live view.

## Vision (`vision/PoseVision.ts`)

Wraps MediaPipe Tasks Vision's `PoseLandmarker`: loads the WASM runtime and
model (GPU delegate first, falling back to CPU if the GPU delegate is
rejected by the device/browser), then runs synchronous per-frame detection
in `VIDEO` running mode. `dispose()` closes the landmarker and is the
counterpart to `init()`, provided for completeness even though the current
app architecture treats the loaded model as a single, page-lifetime
resource (see "What is never torn down" below).

## Avatar (`avatar/Avatar.ts`)

A procedural, low-poly humanoid built entirely from Three.js primitives —
no external 3D assets. Every limb is a single capsule mesh stretched and
oriented between two tracked joint positions each frame
(`limbMath.computeSegmentTransform`, via quaternions — never Euler angles,
which would need an arbitrary rotation-order choice and can gimbal-lock).
Because each segment reads its own two endpoint positions directly from the
`TrackingFrame` rather than a forward-kinematic chain of parent rotations,
one noisy joint can only ever perturb the one or two segments touching it,
never propagate instability down a chain. Four display modes
(`mannequin`/`skeleton`/`shadow`/`ghost`) swap materials only — geometry is
shared and never recreated.

## Effects (`effects/`)

Every effect implements the same small `Effect` interface
(`enable`/`disable`/`update`/`reset`) and owns its own `Avatar` (or, for
`CloneEffect`, a fixed pool of them), driven entirely by the live
`TrackingFrame` — effects never touch camera or vision internals directly.

- **IndependentShadowEffect** — a dark, flattened duplicate that trails the
  live avatar with a deterministic delay and a damped-spring settle (never
  `Math.random()`), with per-joint drift so extremities lag the core
  convincingly (an animation "follow-through" technique).
- **CloneEffect** — 2/3/5 selectable copies of the user in SAME/DELAYED/
  SPREAD arrangements, each driven directly from a stored `TrackingFrame`
  with no spring/smoothing (contrast Shadow) — copies are meant to read as
  faithful duplicates, just offset in space and/or time.
- **GhostEffect** — a translucent, glow-accented duplicate using normal
  (not additive) alpha blending, so it stays readable over both bright and
  dark backgrounds. Deterministic scale "breathing" and vertical drift, an
  optional single-sample historical delay, and a fixed-size fading motion
  trail.
- **ReverseEffect** — "the Phantom responds differently from the user," via
  three pure, deterministic transforms (`reverseTransforms.ts`): MIRROR
  (rigid reflection about the body's own centerline), REVERSE_HORIZONTAL
  (limb extremities' horizontal displacement inverted from their proximal
  joint; core joints pass through unchanged), and DELAYED_MIRROR (MIRROR
  sourced from a short historical sample).

All four effects share one fixed cross-cutting behavior: `enable()`
restores visibility that `disable()` turned off, so a toggle-off-then-on
cycle doesn't leave an effect permanently invisible.

## Recording (`recording/RecordingManager.ts`)

Records the composed camera + Three.js output entirely on-device. Since
neither `videoElement.captureStream()` alone (misses the 3D effect) nor
`sceneCanvas.captureStream()` alone (transparent, misses the camera image)
captures what the user actually sees, and browsers have no API to merge two
independent capture streams, `RecordingManager` composites every rendered
frame into a private, off-DOM 2D canvas — camera frame first (cropped/
mirrored to match what's displayed, reusing the same `computeCoverCrop()`
and `cameraMirrored` used by tracking), then the transparent scene canvas
on top — and records *that* composite canvas via
`HTMLCanvasElement.captureStream()` into a native `MediaRecorder`. This is
real browser-native video encoding, not a JS/WASM software encoder.

Typed `RecordingError`s cover unsupported browsers, an inactive camera, a
zero-size canvas, and WebGL context loss. `retake()`/`reset()` guard
against a race where the recorder's async `onstop` callback could
resurrect a discarded recording after the UI had already moved on.
`discardRecording()` revokes the previous preview's object URL before
creating a new one, and `dispose()` also removes its own
`webglcontextlost` listener — nothing here leaks across repeated record/
retake cycles. See PRIVACY.md for what happens to a recorded clip.

## Rendering (`rendering/SceneManager.ts`)

Owns the Three.js scene, camera, renderer, lighting, virtual floor, and the
render/animation loop, rendered on a transparent canvas layered over the
camera `<video>`. Resizes via a `ResizeObserver` on its actual container
(not `window`), clamping device pixel ratio to 2 to bound GPU cost on
high-DPI displays. `start()` guards against double-starting the render
loop; `onFrame`/`onAfterRender` are two deliberately separate hook points
(see "Data flow" above) so effects update the scene graph in time to be
rendered the same frame, while consumers needing the just-rendered pixel
buffer (recording) use the after-render hook instead.

**WebGL context loss**: both `webglcontextlost` and `webglcontextrestored`
are handled. On loss, the render loop stops (and `event.preventDefault()`
is called, per the WebGL spec, to allow restoration at all). On restore,
rendering resumes automatically — but only if the loop was actually
running at the moment of loss, so a context event that fires after the
user has already left the camera screen doesn't resurrect a loop nobody
asked for.

## UI (`ui/CameraScreen.ts`, `ui/LandingScreen.ts`, `ui/styles.css`)

Owns the DOM only — every user action is reported to `App` via a callbacks
object; `CameraScreen`/`LandingScreen` hold no tracking, effect, or
recording logic themselves. Camera screen structure: a top HUD (brand +
live status pill — the first user-facing "tracking lost" indicator), a
persistent effect rail (SHADOW/CLONE/GHOST/REVERSE, plus a genuinely
`disabled` DELAY chip — listed honestly, not faked), a three-control bottom
bar (camera-switch/RECORD/settings), and one on-demand settings drawer
(native `<details>`/`<summary>` sections) rather than several always-on
floating panels. A generic, auto-dismissing inline `showNote()` toast
handles non-fatal failures (a failed camera switch, a recording error) —
never a native `alert()`. Global `:focus-visible` styling, `aria-label`s on
every icon button, `role="status"`/`role="alert"` on live regions, 44px-
minimum touch targets, and `env(safe-area-inset-*)` on every edge
(including left/right for landscape) are applied throughout.

**Developer/debug mode** (`utils/debugMode.ts`): a boolean flag, set via
`?debug=1` in the URL and persisted to `localStorage`, gates the settings
panel's "Display" section — live FPS/vision/tracking-state/confidence/
landmark-count/inference-time/mirroring diagnostics, and the wireframe
`DebugSkeleton` overlay toggle. These are diagnostic tools, not
production-facing features, so they're hidden by default; the flag changes
nothing else about the app's behavior. See README.md for the user-facing
documentation of the flag.

## Error handling model

Every module that can fail in a well-understood way throws (or reports via
callback) a typed error with a `type` discriminant: `CameraError`,
`VisionError`, `RecordingError`. `App.describeError()`/
`describeRecordingError()` are the single place these are translated into
user-facing copy — no module below `App` ever constructs user-facing
strings itself. Fatal failures (can't enter the camera experience at all)
show a full-screen error overlay with RETRY/BACK; non-fatal failures (a
failed camera switch that successfully fell back, a recording error) show
the auto-dismissing toast instead, so a transient problem doesn't need a
full-screen interruption to recover from.

## What is never torn down (and why that's intentional)

`SceneManager`, `PoseVision`, `RecordingManager`, `DebugSkeleton`, and every
effect are constructed once, in `App`'s constructor, and live for the
whole page session — `App.exitCamera()` calls each one's `reset()` (return
to a clean, hidden, default-parameter state) but never `dispose()`
(release underlying GPU/WASM resources permanently). This is deliberate:
re-entering the camera screen should not have to re-download or re-
initialize the pose model, recreate the WebGL renderer, or rebuild every
effect's geometry — those are the genuinely expensive one-time costs, and
the whole point of `reset()` existing separately from `dispose()` is to
make repeated enter/exit cycles cheap. Each class's `dispose()` method
still exists and is exercised by its own unit tests, for the (currently
unused) case of a future full application teardown. The one thing that
*is* always fully released on every exit is the camera stream itself
(`CameraController.stop()`), since holding a live camera stream while the
user isn't even looking at the camera screen would be a real, user-visible
problem (the OS camera indicator staying lit) — not just an internal
efficiency question.

## Known architectural limitations

See [QA_REPORT.md](./QA_REPORT.md#known-limitations) for the current list
(e.g. MediaPipe and Three.js are loaded eagerly at page load rather than
lazily on first camera entry, which is the main lever left for reducing
landing-page bundle weight on slow mobile connections).
