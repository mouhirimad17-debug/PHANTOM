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
              CloneEffect (Ghost/Reverse/Delay not yet implemented)
  recording/  (not yet implemented — canvas capture -> video file)
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

- **Display modes**: `setDisplayMode('mannequin' | 'skeleton' | 'shadow')`
  swaps which of three pre-built materials each mesh uses (dark/neutral +
  soft emissive for mannequin; brighter, thinner for skeleton; near-black,
  transparent, barely-emissive for shadow — see
  `effects/IndependentShadowEffect.ts`) and toggles head-mesh/joint-marker
  visibility — it never creates or destroys meshes. 'shadow' reuses the
  full-bodied mannequin radius (only the material differs); flattening is
  the driving effect's job, not a thinner geometry.
- **Reuse**: `avatar/avatarGeometry.ts` holds ONE shared capsule geometry
  (used by all 15 limbs, differentiated only by each mesh's own
  position/quaternion/scale) and ONE shared sphere geometry (head + joint
  markers + a driving effect's own contact-shadow blobs), as module-level
  singletons shared by every `Avatar` instance. Materials are the one
  exception — each `Avatar` builds its own trio, because `setOpacity()`
  must affect one instance without bleeding into every other instance
  sharing the scene (exactly what happens once `IndependentShadowEffect`'s
  own `Avatar` needs a different opacity than the live one).
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
