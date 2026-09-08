# Architecture

PHANTOM is a static, client-only TypeScript app (no backend/database/auth).
Modules are organized by responsibility under `src/`, with narrow interfaces
between them so effects/avatar work can be added without touching camera,
vision, or rendering internals.

```
src/
  app/        top-level orchestrator (App.ts): wires everything, owns screen
              transitions and error handling
  camera/     MediaStream lifecycle (permissions, start/stop, facing switch)
  vision/     MediaPipe Tasks Vision wrapper (pose model load + per-frame detect)
  tracking/   raw landmarks -> smoothed, scene-space TrackingFrame
  rendering/  Three.js scene/camera/renderer/lighting/floor + render loop
  avatar/     procedural humanoid mannequin (capsule-primitive limbs,
              quaternion-oriented from tracked joint positions each frame)
  effects/    Effect interface + implementations: IndependentShadowEffect,
              CloneEffect, GhostEffect, ReverseEffect (Delay not yet implemented)
  recording/  RecordingManager — composites the camera frame + Three.js
              render into one canvas and records it locally via MediaRecorder
  ui/         DOM screen controllers (LandingScreen, CameraScreen) + styles.css
  utils/      shared, dependency-free helpers (math, DOM, FPS, pose landmark constants)
  types/      shared TypeScript types/errors, no runtime logic
```

## Data flow (current, per rendered frame)

```
CameraController --(HTMLVideoElement)--> PoseVision.detect()
                                              |
                                              v
                                     RawPoseFrame (landmarks +
                                     worldLandmarks, normalized/metric)
                                              |
                                              v
                                     TrackingManager.update()
                          (per-axis OneEuroFilter smoothing, state machine,
                           normalized coords -> Three.js scene space,
                           derived fields: bodyCenter/torsoRotation/bodyScale)
                                              |
                                              v
                                       TrackingFrame (stable, scene-space)
                                        |                          |
                                        v                          v
                               DebugSkeleton.update()      TrackingHistory.push()
                          (renders joints/bones in the      (ring-buffer snapshot,
                           Three.js scene, dev-only)          for future Delay/Reverse)
                                        |
                                        v
                               Avatar.updateFromTracking()
                          (procedural mannequin: 15 capsule limb
                           segments + head, quaternion-oriented
                           between joint pairs each frame)
                                              |
                                              v
                                    SceneManager renders on a transparent
                                    <canvas> composited over the <video>
```

`SceneManager` drives one `requestAnimationFrame` loop and calls registered
frame listeners every render frame. Pose *inference* is throttled
independently (see `App.handleFrame`) so a slow model never blocks
rendering — the skeleton simply updates less often on weak devices.

## Key design decisions

- **Coordinate mapping (`tracking/CoordinateMapper.ts`)**: MediaPipe's
  normalized `landmarks` (per-joint 2D, image-space) are projected onto a
  plane in front of the Three.js `PerspectiveCamera`, at a depth derived
  from that joint's `worldLandmarks` z (metric, hip-relative). This keeps
  every joint's on-screen (x, y) pixel-accurate against the displayed video
  while still giving real perspective depth behavior — a hand pushed toward
  the camera visibly grows/moves outward, exactly as a real object would.
- **`object-fit: cover` crop compensation**: the video element is displayed
  cropped-to-fill (`utils/math.ts: computeCoverCrop`). Landmark coordinates
  are re-normalized against the visible crop rect, not the raw video frame,
  so the overlay stays aligned regardless of the camera's native aspect
  ratio vs. the viewport's.
- **Mirroring (single source of truth: `cameraMirrored: boolean`)**: the
  front camera is mirrored via CSS (`transform: scaleX(-1)`) on the
  `<video>` element **only**. The overlay `<canvas>` is deliberately never
  CSS-mirrored (see the comment on `#scene-canvas` in `ui/styles.css`) —
  instead, `transformLandmarkForRender()` (`tracking/transformLandmarkForRender.ts`)
  applies the equivalent flip in software, once, inside
  `CoordinateMapper.mapJoint()`, before the coordinate is ever turned into a
  Three.js world position. `App.enterCamera()` computes `cameraMirrored`
  once (`facing === 'user'`) and passes it to both
  `TrackingManager.setCameraMirrored()` (software mirror, for the canvas)
  and `CameraScreen.setMirrored()` (CSS mirror, for the video) — the two
  must never both mirror the same element, or the skeleton moves opposite
  to the visible body. A `DEBUG`-panel diagnostic (RAW X / RENDER X /
  MIRRORED for the right wrist) makes this pipeline inspectable at runtime.
- **Smoothing (`tracking/OneEuroFilter.ts`, `tracking/LandmarkSmoother.ts`)**:
  each joint's x/y/z is filtered by its own One Euro Filter (Casiez, Roussel
  & Vogel 2012) rather than a fixed-alpha average — a fixed alpha can't
  suppress jitter on a still body *and* avoid lag on a fast-moving one at
  the same time, since those pull the single knob in opposite directions.
  The One Euro Filter widens its cutoff with estimated speed instead, so it
  stays smooth when still and responsive when moving.
  `LandmarkSmoother.setSmoothingStrength(0..1)` exposes this as one
  normalized knob.
- **Tracking state machine (`types/tracking.ts: TrackingState`)**:
  `INITIALIZING -> TRACKING -> RECOVERING -> LOST`, driven by
  `TrackingManager`. A short dropout (< 600ms) is `RECOVERING` — the last
  smoothed pose is held, and the filters' continuity is *preserved* across
  the gap so tracking resumes smoothly. A dropout past that grace period
  becomes `LOST`; when detection resumes from `LOST` (or the very first
  detection, from `INITIALIZING`), `LandmarkSmoother.reset()` is called so
  the pose snaps immediately to the new detection instead of dragging in
  from a stale, possibly very old, filter state — "recover quickly" and
  "don't jump on a one-frame dropout" are different requirements handled by
  different code paths on purpose.
- **Derived spatial fields**: `TrackingManager` computes `bodyCenter`,
  `shoulderCenter`, `hipCenter`, `torsoRotation` (approximate yaw from the
  shoulder line), and `bodyScale` (shoulder width) from the already-smoothed
  joint positions every time a body is present — see
  `TrackingManager.updateDerivedFields()`. These, plus the named joint
  accessors (`frame.leftWrist`, etc. — the same objects as
  `frame.landmarks[PoseLandmark.LEFT_WRIST]`, just self-documenting), are
  what avatar/effect code should read instead of raw landmark indices.
- **TrackingHistory (`tracking/TrackingHistory.ts`)**: a fixed-capacity ring
  buffer of `TrackingFrame` snapshots (`push`/`getLatest`/`getAtOffset`/
  `clear`, configurable logical duration), for effects that need to look
  backward in time. `App.ts` owns one top-level instance it pushes into
  after every tracking update (still unread, reserved for a future Reverse
  effect or debug tooling); `IndependentShadowEffect` owns a separate,
  private instance of the same class for its own delay — effects that need
  history are expected to own their instance rather than share App's, so
  each effect's delay window is independent.
- **No per-frame allocation**: `TrackingFrame`'s object graph — landmarks,
  named joint aliases, derived-center vectors — is built exactly once by
  `tracking/trackingFrame.ts: createTrackingFrame()` and mutated in place
  forever after (`copyTrackingFrame()` for taking an independent snapshot,
  used by `TrackingHistory`). `DebugSkeleton`'s `InstancedMesh`/
  `BufferAttribute` follow the same one-allocation-then-mutate pattern (see
  also the "reused scratch vector" pattern in `tracking/CoordinateMapper.ts`).
- **Graceful degradation**: `PoseVision` retries model init on CPU if the
  GPU delegate fails; `App` adaptively widens the pose-inference interval
  based on a rolling average of actual inference duration, so a slow device
  falls back to a lower detection rate instead of janking the render loop.
- **Typed errors** (`types/camera.ts: CameraError`, `types/vision.ts:
  VisionError`) carry a machine-readable `type` so the UI layer
  (`App.describeError`) can show a specific, actionable message instead of
  a generic failure string.

## Avatar (`avatar/Avatar.ts`)

A lightweight procedural humanoid — no external 3D assets, every part is a
Three.js primitive built once and reused. Structure:

```
root
├─ torso group: head, neck, upper torso, lower torso, left arm, right arm
└─ hips group: left leg, right leg
```

Each of the 15 limb segments (neck, torso halves, upper-arm/forearm/hand ×2,
thigh/shin/foot ×2) is one capsule `Mesh` stretched and oriented between two
tracked joint positions every frame — see `avatar/limbMath.ts:
computeSegmentTransform()`. This is deliberately **not** a forward-kinematic
chain (no segment's rotation is derived from its parent's rotation): each
segment reads its own two endpoint positions straight from the
already-computed `TrackingFrame`, which are independent per-joint scene
positions (see the coordinate-mapping note above), not a rigid rig. That
means one noisy joint can only ever perturb the one or two segments
touching it, never propagate instability down a chain — directly serving
"stay visually coherent while the user moves." Orientation is always a
`Quaternion.setFromUnitVectors` (never Euler angles), which has no
rotation-order ambiguity or gimbal lock for a single direction-align like
this; `Avatar.setRotation()` (the whole-avatar override) uses Euler angles
instead, which is fine there because it's one independent transform, not a
chained sequence.

- **Display modes**: `setDisplayMode('mannequin' | 'skeleton' | 'shadow' |
  'ghost')` swaps which of four pre-built materials each mesh uses
  (dark/neutral + soft emissive for mannequin; brighter, thinner for
  skeleton; near-black, transparent, barely-emissive for shadow — see
  `effects/IndependentShadowEffect.ts`; translucent, glow-accented for ghost
  — see `effects/GhostEffect.ts`) and toggles head-mesh/joint-marker
  visibility — it never creates or destroys meshes. 'shadow' and 'ghost'
  both reuse the full-bodied mannequin radius (only the material differs);
  flattening/glow/breathing are the driving effect's job, not a different
  geometry.
- **Reuse**: `avatar/avatarGeometry.ts` holds ONE shared capsule geometry
  (used by all 15 limbs, differentiated only by each mesh's own
  position/quaternion/scale) and ONE shared sphere geometry (head + joint
  markers + a driving effect's own contact-shadow/trail blobs), as
  module-level singletons shared by every `Avatar` instance. Materials are
  the one exception — each `Avatar` builds its own set of four, because
  `setOpacity()` must affect one instance without bleeding into every other
  instance sharing the scene (exactly what happens once
  `IndependentShadowEffect`'s or `GhostEffect`'s own `Avatar` needs a
  different opacity than the live one). `setGlowIntensity()` follows the
  same per-instance-material logic, but only ever touches the ghost
  material — the other three display modes keep their own fixed emissive
  levels regardless of how a ghost's `glowStrength` is set.
- **Shadow**: every limb mesh sets `castShadow`/`receiveShadow`, so the
  floor/light/shadow-map already set up in `rendering/SceneManager.ts`
  render a real soft shadow under the character — no new lighting was
  needed for this.
- **Visibility**: `updateFromTracking()` shows the avatar only when
  `frame.present` is true, and otherwise freezes (does not reset) the last
  pose — `setVisible()` is a separate, composable override (avatar hidden
  = `visibleOverride && lastPresent`), independent of tracking state.

## Effects (`effects/`)

`effects/Effect.ts` defines the contract every effect implements:
`enable()/disable()/update(deltaTimeSeconds, trackingFrame)/reset()`. An
effect owns whatever it renders — typically its own `Avatar` instance(s) —
and never touches camera/vision internals directly. `App.ts` constructs
effects alongside the base `Avatar`/`DebugSkeleton`, and calls `update()`
once per detection frame with the live `TrackingFrame` and the real elapsed
time since the previous call.

### IndependentShadowEffect (`effects/IndependentShadowEffect.ts`)

The first implemented effect, and the pattern future ones should follow: it
owns a second `Avatar` (in `'shadow'` display mode) and feeds it a
synthetic `TrackingFrame` this effect computes itself each frame —
reusing 100% of `Avatar`'s existing quaternion/geometry machinery rather
than rendering anything bespoke. Per update:

1. Push the live frame into a private `TrackingHistory` and look up the
   pose from `delayMilliseconds` ago as the spring's *target* — the visual
   "shadow follows with a delay."
2. For every joint, pull the target's Y toward the floor by
   `verticalFlatten` (0 = untouched, 1 = pinned to floor Y) — done on the
   target itself, not via a non-uniform mesh scale, so it flows through
   `Avatar`'s existing per-limb orientation math unchanged.
3. Integrate a small deterministic damped-spring per joint
   (`followStrength` = stiffness, `recoverySpeed` = damping) toward that
   flattened, delayed target — **never `Math.random()`**. An underdamped
   spring naturally overshoots and settles, which is exactly "the shadow
   continues a tiny amount before settling" without any special-cased
   logic for it.
4. Scale each joint's effective stiffness/damping by a fixed, per-landmark
   `DRIFT_FACTOR_BY_LANDMARK` table (shoulders/hips ~0.05, wrists/
   fingertips ~0.75-1.0) before integrating, controlled by one
   `driftAmount` knob. This is the "raises an arm and the shadow doesn't
   perfectly copy it" requirement, modeled on the animation principle of
   follow-through/overlapping action — extremities lag and settle later
   than the core, deterministically, so the core never detaches far enough
   to break the illusion.
5. Apply `horizontalOffset`/`rotationOffset` via `Avatar.setPosition()`/
   `setRotation()` — exactly what those root-transform methods exist for —
   and `opacity` via `Avatar.setOpacity()`.
6. Position two small flattened, semi-transparent spheres (reusing the
   avatar system's shared sphere geometry) at the ankles, parented under
   the shadow avatar's own root, for contact darkening — they inherit its
   visibility and offset for free.

A cheap stand-in for "blurred, without expensive GPU effects": the shadow
material sets `depthWrite: false` so overlapping semi-transparent limbs
blend instead of clipping into hard seams — no shader, no render target.

Every numeric parameter is clamped (see `PARAM_RANGES`) so the illusion
can't be driven into instability or full detachment regardless of how a
control (like the sensitivity slider) is set.

`DebugSkeleton` remains a separate, dev-only diagnostic, unrelated to any
effect — it is not, and was never meant to become, the final avatar.

### CloneEffect (`effects/CloneEffect.ts`)

Multiple virtual copies of the user, each a direct read of a stored
`TrackingFrame` — unlike IndependentShadowEffect, there is deliberately **no**
spring/smoothing here: a clone is meant to read as a faithful duplicate, just
offset in space and/or time, not a settling illusion.

- **Pool**: a fixed array of `MAX_CLONES` (5) `Avatar` instances (in
  `'mannequin'` mode, so clones look like real duplicates, not shadows) is
  constructed once, in the constructor, and never resized. Enabling the
  effect, or changing `count`/`mode`, only changes which pool slots are
  `setVisible(true)` and what frame drives them each `update()` — no
  `Avatar` is ever constructed or destroyed after startup. This mirrors the
  IndependentShadowEffect's "own an Avatar, reuse it forever" pattern, just
  with N instances instead of one.
- **Arrangement pattern**: `CLONE_SLOT_PATTERNS` is a fixed, deterministic
  table of small (x, z) offsets per selectable `count` (2/3/5), scaled by a
  base spacing and the tracked `bodyScale` at render time. Every clone's
  position is therefore always a small, bounded function of the live body —
  never a zero offset (which would make clones invisibly stack) and never an
  arbitrary/unrelated position — directly satisfying "do not create
  arbitrary floating copies without relation to the user." The pattern is
  keyed by `count` (not just sliced from the 5-clone table) so 2 clones are
  always a clean symmetric left/right pair rather than an arbitrary subset
  of the 5-clone layout.
- **Modes**: SAME and DELAYED use a small `BASE_SPACING`; SPREAD multiplies
  that same base pattern by a configurable `spreadDistance`, so all three
  modes share one arrangement table and differ only in scale and time
  source:
  - **SAME** — every visible clone reads the current live `TrackingFrame`
    directly (`copyTrackingFrame`).
  - **DELAYED** — clone `i` reads its own private `TrackingHistory` at
    `i * delayStepMilliseconds` ago (falling back to the live frame if the
    history doesn't go back far enough yet, e.g. right after enabling), so
    later clones lag progressively further behind — a visible "motion echo"
    with no smoothing math needed, since the history buffer already holds
    exact past frames.
  - **SPREAD** — every visible clone reads the current live frame, like
    SAME, but at the wider `spreadDistance`-scaled offset.
- **Visual variation**: each clone's opacity is the configured base opacity
  times a fixed per-index fade (`1 - i * OPACITY_FADE_PER_INDEX`, floored at
  `MIN_OPACITY_FACTOR`), via `Avatar.setOpacity()` — deterministic, not
  randomized, and enough to make the lineup readable as distinct copies at a
  glance.
- **Weak tracking / entering-leaving frame**: when `trackingFrame.present`
  is `false`, every pooled clone is marked `LOST` and hidden — clones never
  hold a stale position with no visible live user to relate to. Regaining
  tracking resumes normally on the next present frame.
- **Independent transform roots**: each pool slot's `Avatar` has its own
  `root` `Object3D` (created inside `Avatar`'s own constructor, same as the
  live avatar), so `setPosition()`/`setOpacity()` on one clone never affects
  any other — no shared transform state between slots.

#### Performance considerations

- **Pool, never allocate per frame**: the 5-`Avatar` pool is built once at
  effect-construction time. `update()` only mutates existing meshes'
  transforms/materials and toggles `visible` — no `Mesh`, `Geometry`, or
  `Material` is ever created or disposed while the effect is running. This
  is the single most important cost control here: the expensive part of an
  `Avatar` (allocating 15+ meshes and their materials) happens at most 5
  times, ever, for this effect, not once per clone per frame.
- **Draw-call budget**: each `Avatar` costs roughly the same ~17 draw calls
  as the live avatar (15 limb-segment capsules + head + joint markers, per
  `ARCHITECTURE.md`'s Avatar section), plus one shadow-map pass per shadow-
  casting light if shadows are enabled. With the effect at its maximum of 5
  clones, that's on the order of 5x the live avatar's own render cost
  **in addition to** the live avatar and any other enabled effect (e.g.
  IndependentShadowEffect) — roughly 6 full bodies on screen at once at the
  `count: 5` cap. All 15 limb segments across all clones still share the
  same two module-level geometries (`avatarGeometry.ts`), so the added cost
  is draw calls and per-clone materials, not geometry memory.
- **Why the count is hard-capped at 5**: `CloneCount` is a `2 | 3 | 5` union
  (compile-time enforced) and the pool is sized to `MAX_CLONES = 5` — there
  is no path, UI or otherwise, to request more. 5 extra bodies (plus the
  live one) is already a meaningful draw-call and shadow-map load on a
  mid-range mobile GPU; going higher would risk the same frame-rate cliff
  that motivated `App.ts`'s adaptive pose-inference throttling elsewhere in
  this codebase, for a mode whose whole point is a fixed, small, "photo
  booth" style copy count rather than a crowd effect.
- **Recommendation for weaker devices**: on a device where the base avatar
  or IndependentShadowEffect already show a low DEBUG-panel FPS, prefer
  `count: 2` (and `mannequin`-only, no other effect layered on top) over the
  5-clone SPREAD arrangement — 2 extra bodies is a much smaller draw-call
  and shadow increment than 5, and no shading/quality options need to change
  to get there since it's just a UI selection. There is deliberately no
  automatic device-tier detection here (consistent with the rest of this
  codebase not guessing device capability up front) — the DEBUG panel's FPS
  reading is the existing, already-documented way to judge whether an
  effect combination is too heavy for a given device.

### GhostEffect (`effects/GhostEffect.ts`)

A translucent, glow-accented duplicate meant to read as "spectral" rather
than the dark, grounded IndependentShadowEffect or the faithful,
photo-booth-style CloneEffect. Unlike IndependentShadowEffect, there is no
spring/follow physics — the ghost's pose is either the live frame or a
single fixed historical sample (`delayMilliseconds`), which is enough to
feel detached from time without a physics simulation, and considerably
cheaper to compute.

- **Material and readability over any background**: `Avatar` gained a
  fourth display mode, `'ghost'`, backed by `createGhostMaterial()`
  (`avatar/avatarGeometry.ts`) — translucent, with an emissive accent, using
  **normal** alpha blending rather than `AdditiveBlending`. This is a
  deliberate response to the explicit "must remain readable over bright and
  dark backgrounds" requirement: additive blending adds light on top of
  whatever is behind it, which reads as a strong highlight over a dark scene
  but nearly disappears over a bright one (there's little headroom left to
  add to). Normal blending's opacity-based compositing keeps the
  silhouette's visibility consistent regardless of background brightness —
  confirmed visually by rendering the same pose against both a pure-white
  and a near-black clear color (see TESTING.md). The "additive/emissive
  accent" look is instead produced by driving the material's
  `emissiveIntensity` (via the new `Avatar.setGlowIntensity()`, scaled by
  `glowStrength`) rather than by changing the GPU blend mode.
- **Delayed pose**: `GhostEffect` owns a private `TrackingHistory` (same
  pattern as `IndependentShadowEffect` and `CloneEffect` — effects that need
  history own their own instance). When `delayMilliseconds > 0`, the ghost's
  frame is `copyTrackingFrame()`'d from `history.getAtOffset(delayMilliseconds)`
  instead of the live frame; at `0` (its default-adjacent, "optional" state)
  it reads the live frame directly. No spring — a direct copy, like
  CloneEffect's DELAYED mode, since the ghost isn't meant to visibly *chase*
  a target the way the shadow does.
- **Breathing and drift**: both are deterministic sinusoids over an
  effect-owned elapsed-time accumulator (`elapsedSeconds`, advanced only
  while a body is tracked) — never `Math.random()`. Breathing scales the
  whole ghost avatar's root uniformly (`Avatar.setScale()`) by a few percent
  around 1; vertical drift offsets the root's Y (`Avatar.setPosition()`) by
  a small fraction of the tracked `bodyScale`, on a different frequency and
  phase than breathing so the two don't visually sync into one obvious
  pulse. Both are small enough to read as "alive," not as a distracting
  animation — see the "do not make it visually noisy" requirement.
- **Trail**: a fixed number of trail "steps" (`TRAIL_STEP_COUNT = 3`), each
  echoing a handful of extremity joints (nose, both wrists, both ankles —
  the joints where a trail actually reads, unlike a core joint like the
  hips) from `history.getAtOffset()` at increasing lookback, with opacity
  and size fading further back in the lineup. `trailEnabled` (the UI
  toggle) hides every step outright; `trailStrength` (0..1, not currently a
  UI slider — configurable via `configure()` like CloneEffect's
  `spreadDistance`) scales each step's opacity/size continuously. Each
  step's joints are drawn as ONE `InstancedMesh` (not one `Mesh` per joint)
  — see Performance below for why.
- **Independent transform root, own material set**: the ghost's `Avatar` is
  a fully separate instance from the live avatar (its own root, its own
  ghost material), exactly like every other effect in this codebase — no
  effect ever mutates the live avatar's own state.

#### Performance considerations

- **No post-processing**: the "glow" is entirely a material property
  (`emissiveIntensity`), not a render-target bloom/blur pass. This was a
  deliberate choice per the explicit "avoid heavy post-processing if it
  causes mobile performance issues" requirement — a bloom pass costs at
  least one extra full-screen render target and blur pass every frame
  regardless of scene complexity, which is a poor tradeoff for a subtle
  accent glow on a small part of the frame.
- **Trail draw-call optimization (measured, not guessed)**: the first
  implementation rendered each trail-echo joint as its own `Mesh` (5 joints
  × 3 steps = 15 extra draw calls). A CPU-throttled (6x, via Chrome DevTools
  Protocol's `Emulation.setCPUThrottlingRate`) synthetic benchmark showed
  Ghost (glow + trail enabled) costing roughly 3x the base avatar's own
  per-frame render time — high enough to be worth optimizing before calling
  the effect "done." Rewriting the trail as one `InstancedMesh` per step
  (covering all 5 joints in a single draw call, 3 draws total instead of
  15) cut the effect's total draw calls from 48 to 36 for the same visual
  output (confirmed via a pixel-identical scripted render before/after) and
  measurably reduced per-frame cost in the same benchmark. This is the same
  instancing technique `Avatar`'s own skeleton-mode joint markers already
  use.
- **Draw-call budget**: with Ghost enabled, the scene renders the live
  avatar (~17 draws), the ghost avatar (~17 draws, same geometry budget),
  and up to 3 trail `InstancedMesh` draws (only the steps with enough
  history to show) — about 34-37 draws total, comparable to
  IndependentShadowEffect (~19) or a 2-clone CloneEffect (~34). Disabling
  `trailEnabled` removes the 3 trail draws entirely at no cost (the meshes
  are simply hidden, never destroyed).
- **No per-frame allocation**: the ghost `Avatar`, its `TrackingHistory`,
  and all `InstancedMesh`/material trail state are created exactly once, in
  the constructor; `update()` only mutates existing transforms and
  material properties (opacity, emissiveIntensity, per-instance matrices).
- **Mobile guidance**: on a device where the DEBUG panel's FPS reading drops
  with Ghost enabled, turning `trailEnabled` off is the cheapest single
  lever (removes the 3 trail draw calls and their per-joint matrix updates
  entirely) before reaching for a lower `glowStrength` or disabling Ghost
  altogether — glow strength only affects a material property, not draw
  calls, so it has no measurable performance cost on its own.

### ReverseEffect (`effects/ReverseEffect.ts`, `effects/reverseTransforms.ts`)

"The Phantom responds differently from the user" — a second `Avatar` (plain
`'mannequin'` mode, offset a small fixed amount from the live avatar so the
two never fully overlap) driven by one of three presets, each built from
three small, pure, deterministic transform functions kept in their own
module (`reverseTransforms.ts`, the same separation-of-concerns pattern as
`avatar/limbMath.ts` next to `Avatar.ts`):

- **`transformPosition(out, position, mirrorX)`** — reflects a joint across
  a vertical mirror plane at `mirrorX`. Only X changes; it's a pure
  reflection (an isometry), so reflecting every joint of a body about the
  *same* plane preserves every limb length and body proportion exactly —
  the mirrored figure is never stretched or distorted, whatever pose it's
  copying.
- **`transformRotation(rotation)`** — reflects a yaw angle (the same
  `atan2(dz, dx)` convention as `TrackingFrame.torsoRotation`) the way
  `transformPosition` reflects a coordinate, via `atan2` of the reflected
  direction vector (not a plain subtraction) so it stays correctly wrapped
  for every input angle.
- **`transformLimbMotion(out, jointPosition, anchorPosition)`** — inverts
  only the horizontal component of a joint's displacement from a fixed
  anchor (e.g. a wrist from its shoulder). Negating one vector component
  never changes the vector's magnitude, so the anchor-to-joint distance
  (reach/limb length) is preserved exactly — this can never stretch a limb
  or produce `NaN`, even when the joint sits exactly on its anchor.

All three are pure functions with no effect state, no Three.js scene
access, and — per the explicit "do not make the behavior mathematically
chaotic" requirement — no randomness of any kind; each is independently
unit-tested (reflection involution, rotation wraparound/involution,
displacement-magnitude preservation) in `reverseTransforms.test.ts`.

**Presets** (`ReversePreset`), each mapped to a distinct combination of the
above rather than its own bespoke math:

- **MIRROR** — `transformPosition()` applied to *every* joint about the
  source frame's own `bodyCenter.x`, producing a full, rigid mirror-image
  duplicate. Because reflecting a body about its own centerline leaves that
  centerline fixed, the reported `torsoRotation` is explicitly re-derived
  via `transformRotation()` afterward so it stays consistent with the
  mirrored joint positions (see the class doc for why this is applied to
  the frame's data rather than via `Avatar.setRotation()`'s root-level
  Euler override — `Avatar` positions every limb with absolute scene
  coordinates, so rotating the root would swing the whole body through a
  wide arc around the world origin instead of spinning it in place, which
  would look broken for anything but a very small angle).
- **REVERSE_HORIZONTAL** — the literal "move a hand outward, the phantom
  moves the same hand inward" behavior. Core joints (nose, shoulders, hips)
  are copied through unchanged — the phantom's stance and turning still
  read as faithful to the user — while each limb extremity
  (elbow/wrist/index finger; knee/ankle/foot-index) is passed through
  `transformLimbMotion()` relative to its own shoulder/hip anchor
  (`LIMB_ANCHORS`). This deliberately does *not* touch `torsoRotation` —
  body turning passes straight through, only the limbs respond differently
  — see TESTING.md's "body rotation" case for this preset.
- **DELAYED_MIRROR** — exactly the MIRROR transform, just sourced from
  `history.getAtOffset(DELAYED_MIRROR_DELAY_MS)` (the effect's own private
  `TrackingHistory`, same "effects that need history own their instance"
  pattern as every other effect here) instead of the live frame — the
  "optional delayed response." The delay is a fixed internal constant, not
  a UI-exposed slider, matching how `CloneEffect`'s `BASE_SPACING` and
  `GhostEffect`'s breathing constants are also fixed, non-UI knobs baked
  into a preset rather than a general-purpose parameter.

**Preview label**: `getPreviewLabel()` returns a short, human string for
the active preset ("Mirror" / "Reverse Horizontal" / "Delayed Mirror"),
which the REVERSE panel displays directly and `App.ts` also folds into the
DEBUG panel's "Effect" row (`Reverse (<label>)`) — the same one-directional
"App queries the effect, UI just reflects it" flow used for Clone's
`Clone (<mode> x<count>)` label.

**A cross-cutting bug found and fixed during this effect's tests**: writing
`ReverseEffect`'s lifecycle tests surfaced that `enable()` on
`IndependentShadowEffect`, `CloneEffect`, and `GhostEffect` (and the first
draft of `ReverseEffect` itself) never undid `disable()`'s
`avatar.setVisible(false)` — `Avatar.updateFromTracking()` only *reads* the
visibility override, it never resets it, so a real disable-then-re-enable
UI cycle (exactly what tapping a toggle button off and back on does) would
leave that effect permanently invisible for the rest of the session. Fixed
by having each `enable()` call `setVisible(true)` on its own avatar(s) (all
pool slots, for `CloneEffect`) before the first `update()` re-derives the
correct per-slot visibility. Covered by a new regression test in each of
the four effects' suites.

## Recording (`recording/RecordingManager.ts`)

Lets the user save a short local video of the camera scene with whatever
effect is currently visible — entirely on-device, nothing ever uploaded.

**Why compositing is unavoidable, not just a fallback**: what the user sees
is never one element. The live `<video>` is CSS-mirrored/cropped
(`object-fit: cover`), and `#scene-canvas` is a *separate*, deliberately
transparent WebGL canvas layered on top by the page (see the mirroring
note above). `videoElement.captureStream()` alone would miss the 3D effect
entirely; `sceneCanvas.captureStream()` alone would capture only a
transparent overlay with no camera image. Browsers also have no API to
merge two independent `MediaStream`s into one recorded frame — there is no
"direct capture of both" path to prefer over compositing here, today. So
`RecordingManager` always composites: a private, off-DOM 2D `<canvas>` is
redrawn every rendered frame —

```
camera <video> frame (cropped + mirrored to match what's on screen)
                            +
transparent #scene-canvas (the just-rendered Three.js output)
                            v
                  composite 2D <canvas>
                            v
         composite.captureStream(30) -> MediaRecorder
```

— and *that* composite canvas feeds a native `MediaRecorder` via
`HTMLCanvasElement.captureStream()`. This is the "browser-native recording
pipeline" this module prefers, in the sense that matters: real, hardware-
backed encoding through `MediaRecorder`, never a JS/WASM software encoder.

- **Frame timing correctness**: `SceneManager.onFrame()` listeners (used by
  every effect) run *before* `renderer.render()` for that tick — on
  purpose, so effects can update the scene graph in time to be rendered
  that same frame. Reading the canvas from an `onFrame` listener would
  therefore capture the *previous* frame's pixels. `SceneManager` gained a
  second, purely additive hook, `onAfterRender()`, firing immediately after
  `render()`, which `RecordingManager` uses instead — the only reason this
  hook exists.
- **Crop/mirror reuse**: the composite draw reuses `utils/math.ts`'s
  existing `computeCoverCrop()` (the same function `CoordinateMapper`
  already uses to keep the skeleton aligned with the displayed video) to
  crop the source video frame identically to what `object-fit: cover`
  shows on screen, then applies the same horizontal flip as `#camera-video`'s
  CSS `scaleX(-1)` manually (`drawImage()` always draws a video's raw,
  unmirrored pixels regardless of any CSS transform on the element, so the
  mirror has to be reproduced in the 2D context). `cameraMirrored` is
  passed into `start()` from `App.ts`'s existing single source of truth
  (the same boolean already fed to `TrackingManager.setCameraMirrored()`
  and `CameraScreen.setMirrored()`) rather than recomputed — one flag,
  three consumers, never allowed to disagree.
- **Support detection**: `isSupported()` checks for
  `HTMLCanvasElement.prototype.captureStream` and a `MediaRecorder`-
  supported mime type (`MediaRecorder.isTypeSupported()`, checked against a
  preference list — VP9-in-WebM, then VP8-in-WebM, then plain WebM, then
  `video/mp4` for Safari) once at construction. The UI hides the RECORD
  button entirely and shows a short note instead when this is false,
  rather than letting the user tap a control that can only fail.
- **No microphone, ever**: `RecordingManager` never calls `getUserMedia`
  itself — it only reads the already-active camera `<video>` element and
  `canvas.captureStream()`, neither of which needs (or triggers) any
  browser permission prompt. There is structurally no code path here that
  could request microphone access.
- **Typed errors** (`types/recording.ts: RecordingError`, following the
  exact `CameraError`/`VisionError` pattern): pre-flight failures —
  `unsupported`, `camera-unavailable` (the camera video has no current
  frame — e.g. called before the camera finished starting), `zero-size-canvas`
  (the scene canvas has no visible pixels yet, e.g. mid-layout) —
  are thrown synchronously from `start()`, exactly like
  `CameraController.start()` throwing `CameraError`. Failures that can only
  happen *after* `start()` has already returned — a `MediaRecorder` runtime
  error, or losing the WebGL context mid-recording (`context-lost`, via a
  `webglcontextlost` listener `RecordingManager` adds directly to the scene
  canvas, independent of `SceneManager`'s own listener on the same
  element) — are reported through an `onError` callback instead, since
  there's no caller left to throw to.
- **State machine** (`RecordingState`): `'idle' -> 'recording' -> 'stopped'`,
  with `retake()` returning `'stopped' -> 'idle'` and starting a new
  recording implicitly discarding whatever was previously `'stopped'`.
  `reset()` (called from `App.exitCamera()`, matching every effect's own
  `reset()`) can be invoked mid-recording — a `discardOnStop` flag ensures
  the recorder's asynchronous `onstop` (which fires *after* `reset()` has
  already synchronously moved the state back to `'idle'`) discards its
  result instead of resurrecting a `'stopped'` state and leaking an object
  URL nobody will ever revoke. `dispose()` uses the same guard.
- **Local-only outputs, explicitly released**: the only outputs are an
  in-memory `Blob` and a `URL.createObjectURL()` object URL for local
  `<video>` preview/download — never anything sent over the network. The
  object URL is revoked (`URL.revokeObjectURL()`) on `retake()`, at the
  start of every new recording, and in `dispose()`, so a session that
  records several times never accumulates unreleased blob URLs.
- **Download**: a plain `<a download>` anchor, clicked programmatically —
  the standard, broadly-supported local-save mechanism, requiring no extra
  permission and no heavier API (like File System Access, which Safari
  doesn't implement).
- **No per-frame allocation beyond the unavoidable**: the composite canvas,
  its 2D context, and the `webglcontextlost` listener are all created once,
  in the constructor. Each `onAfterRender` tick only calls `drawImage()`
  twice and, once per finished take, allocates one `Blob` — there is no
  steady-state growth from repeated start/stop cycles.
- **Default frame rate**: `captureStream(30)` — a reasonable default for a
  short clip; not currently exposed as a setting (no requirement asked for
  one).
