# Testing

There is a small, targeted **vitest** suite covering the coordinate/mirroring
math (the one area that has already had a real, non-obvious bug — see
`ARCHITECTURE.md`'s mirroring section). Everything else is still verified
with type-checking, a production build, and manual/scripted browser
verification. This document describes both what's automated and how to
verify the rest by hand.

## Automated checks that exist

```bash
npx tsc --noEmit   # strict type-check, no `any`-shaped escape hatches
npm test           # vitest run — coordinate/mirroring transform tests
npm run build      # type-check + production bundle (fails on build errors)
```

Run all three after any change to the tracking/coordinate-mapping code in
particular. None of these currently run as CI — there is no CI configured
yet.

### What the unit tests cover

- `src/tracking/transformLandmarkForRender.test.ts` — the pure mirror
  function in isolation, at x = 0, 0.25, 0.5, 0.75, 1, for both mirrored and
  non-mirrored, plus a center-invariance and involution check.
- `src/tracking/CoordinateMapper.test.ts` — the same behavior integrated
  through `mapJoint()`'s full pipeline (crop + mirror + perspective
  projection), confirming a raw landmark lands on the opposite side of
  center when mirrored, that the vertical axis is never affected, and that
  `computeRenderX()` (used by the debug diagnostic) agrees with the value
  `mapJoint()` actually renders with.
- `src/tracking/OneEuroFilter.test.ts` — the adaptive smoothing filter in
  isolation: instant first-sample seeding, convergence on a held constant,
  jitter suppression on a noisy-but-stable signal, catching up after a step
  change (not permanently lagging), `reset()` reseeding instantly instead of
  lerping from stale state, and `configure()` actually changing behavior.
- `src/tracking/TrackingHistory.test.ts` — `push`/`getLatest`/`getAtOffset`/
  `clear`, capacity wraparound, the configured max-duration window, and —
  critically — that `push()` stores an **independent snapshot**: mutating
  the live frame after pushing it must not change what history returns
  (this is the exact bug class a naive "store the reference" implementation
  would hit, since `TrackingManager` reuses one mutable frame object).
- `src/tracking/TrackingManager.test.ts` — the state machine
  (`INITIALIZING -> TRACKING -> RECOVERING -> LOST` and back), and
  specifically that recovering from `LOST` snaps instantly to the new
  position (smoother reset) while a short `RECOVERING` gap does **not**
  snap (continuity preserved) — the two "don't lag" vs. "don't jump"
  requirements exercised as a real regression test, not just asserted in
  prose. Also covers the derived fields (`bodyCenter`, `shoulderCenter`,
  `hipCenter`, `bodyScale`, `torsoRotation`) for internal consistency with
  the joint positions that actually produced them, and the named joint
  accessors' aliasing (`frame.leftShoulder === frame.landmarks[11]`).

- `src/avatar/limbMath.test.ts` — `computeSegmentTransform()` in isolation:
  the output position is the true midpoint, the returned length is the true
  distance, the orientation quaternion rotates the shared up-axis to
  *exactly* the start->end direction (checked for several different
  directions, not just the trivial already-aligned case), and a degenerate
  (coincident-point) input neither produces `NaN` nor disturbs a
  previously-set orientation.
- `src/avatar/Avatar.test.ts` — the assembled avatar: it attaches to the
  scene hidden, becomes visible and positions a real segment (checked
  against the actual joint positions, not just "some value") once a body is
  tracked, **freezes** (does not reset) its pose and hides when tracking is
  lost, `setVisible(false)` overrides tracking presence, `setDisplayMode()`
  swaps material/visibility without recreating any mesh or geometry,
  `reset()` returns to identity/hidden/opaque, every limb shares the one
  `SEGMENT_GEOMETRY` instance (no per-segment duplication), and limbs
  `castShadow`.
- `src/effects/IndependentShadowEffect.test.ts` — the signature effect's
  full behavior, numerically: it lags further behind a moving target with a
  larger `delayMilliseconds`; with an underdamped `recoverySpeed` it visibly
  overshoots a stopped target before settling back onto it (not just
  reaching it monotonically); a core joint (hip) converges further than an
  extremity (wrist) given the identical step change with `driftAmount > 0`
  (the deterministic "doesn't perfectly copy" mechanism); running the exact
  same input sequence through two fresh instances produces **bit-identical**
  output (proof there is no `Math.random()` anywhere in the path);
  `verticalFlatten` pulls a joint's Y to the floor in proportion to its
  value (0 = untouched, 1 = pinned exactly to floor Y); `horizontalOffset`/
  `rotationOffset` land on the shadow avatar's root transform; and
  `configure()` clamps out-of-range values instead of accepting them
  verbatim. This suite caught a real bug during development — the
  `verticalFlatten` parameter's clamp range topped out at 0.95 while its own
  doc comment promised "1 = pinned flat to the floor"; the test asserting
  the documented behavior failed until the range was fixed to `[0, 1]`.
- `src/effects/CloneEffect.test.ts` — the pool is exactly 5 `Avatar`s,
  created once and never recreated across repeated `configure()`/`update()`
  calls (checked via object-reference identity, `toBe`); exactly `count`
  clones are visible and the rest stay hidden; SAME reproduces the current
  frame exactly on every visible clone; DELAYED clones lag progressively
  more the higher their pool index; SPREAD's offset scales up with
  `spreadDistance`, and SAME/DELAYED's baseline offset is smaller than
  SPREAD's for the same slot; every clone's offset stays within a small,
  bounded multiple of `bodyScale` (never an arbitrary floating position);
  opacity strictly decreases across the clone lineup (the "slight visual
  variation" requirement, checked numerically via each clone's own head
  material); tracking loss hides every clone and regaining tracking resumes
  correctly; `reset()` restores defaults and hides everything; and an
  invalid `count`/`mode`/`opacity`/`delayStepMilliseconds`/`spreadDistance`
  passed to `configure()` is clamped or ignored rather than accepted
  verbatim.
- `src/avatar/Avatar.test.ts` (ghost-mode additions) — `setDisplayMode('ghost')`
  swaps in a transparent material; `setGlowIntensity()` scales that
  material's `emissiveIntensity` up and down (including to exactly 0) and
  has no effect on the other three display modes' materials.
- `src/effects/GhostEffect.test.ts` — the ghost avatar shows/hides correctly
  across enable/disable and tracking loss/recovery, including hiding every
  trail step on loss; running an identical input sequence through two fresh
  instances produces bit-identical output (position, breathing scale, and
  drift Y) — proof there is no `Math.random()` anywhere in the path;
  `configure({ opacity })`/`configure({ glowStrength })` are reflected
  exactly in the ghost material's `opacity`/`emissiveIntensity`; a larger
  `delayMilliseconds` reads further behind a moving target, and `0` matches
  the live frame exactly; breathing scale stays within a small bounded range
  around 1 (but actually varies, not frozen); vertical drift is nonzero but
  stays under a small fraction of `bodyScale`; trail echoes become visible
  once enough history exists when `trailEnabled`, stay fully hidden when
  not, and a higher `trailStrength` produces a more opaque first-step
  material; `reset()` restores defaults and hides everything; and invalid
  `opacity`/`delayMilliseconds`/`glowStrength`/`trailStrength` values are
  clamped to their documented ranges.
- `src/effects/reverseTransforms.test.ts` — the three pure transform
  functions in isolation: `transformPosition()` reflects X and leaves Y/Z
  untouched, reflects correctly about a non-zero plane, leaves a point on
  the mirror plane unchanged, is its own inverse (reflecting twice restores
  the original), and preserves the distance between two points reflected
  about the same plane (proof it can never stretch a body); `transformRotation()`
  correctly reflects several known angles (0 -> π, π/2 unchanged since it
  points along the mirror plane, π/4 -> 3π/4), always returns a value in
  `(-π, π]`, and is its own inverse; `transformLimbMotion()` inverts only
  the horizontal displacement from an anchor, is a safe no-op when the
  joint sits exactly on its anchor (no `NaN`), preserves the anchor-to-
  joint distance exactly, and turns an outward move into an inward one of
  the same magnitude.
- `src/effects/ReverseEffect.test.ts` — lifecycle (shows/hides across
  enable/disable/tracking-loss, including a disable-then-re-enable cycle —
  see the cross-cutting bug note in ARCHITECTURE.md); the preview label for
  each preset and default; an invalid preset string is ignored; **MIRROR**:
  a hand moved outward mirrors to the same absolute offset on the other
  side of the body's own center, arm segment lengths are preserved exactly
  (rigid reflection), and a turned body's reported `torsoRotation` reflects
  consistently with the mirrored shoulder positions; **REVERSE_HORIZONTAL**:
  the core (shoulders/hips/nose) matches the live user exactly, an outward
  hand move becomes an inward move of the *same* hand (not swapped to the
  other side) with the exact same magnitude, limb reach (anchor-to-joint
  distance) is preserved exactly, and body rotation passes through
  unreversed while the limb inversion still applies; **DELAYED_MIRROR**:
  lags behind a moving target compared to plain MIRROR, and reduces to
  identical output to MIRROR once the pose has been static long enough for
  history and live frame to agree; a "walking-in-place-like" alternating
  knee-lift sequence and a "camera movement" sideways body drift are each
  exercised frame-by-frame to confirm no discontinuities and that the
  mirror plane re-centers on the *current* frame's `bodyCenter` every
  frame, never a stale one; `reset()` restores the default preset and hides
  the effect.
- `src/effects/IndependentShadowEffect.test.ts`, `CloneEffect.test.ts`,
  `GhostEffect.test.ts` (regression additions) — each now also asserts that
  a `disable()` -> `enable()` cycle followed by a present frame actually
  shows the effect again, locking in the cross-cutting visibility fix
  described in ARCHITECTURE.md's ReverseEffect section (writing
  `ReverseEffect`'s own version of this test is what surfaced the bug in
  the first place).

These do **not** cover the CSS layer (`#camera-video` / `#scene-canvas`
transforms) — that must still be checked in a real/scripted browser, since
it's DOM/CSS state, not application logic. They also can't cover *how good*
the smoothing feels on a real, noisy camera signal, or whether the mannequin
actually *looks* like a coherent body — those are inherently
manual/visual checks, see below.

### Why RecordingManager has no vitest suite

Every other browser-API-heavy leaf module in this codebase —
`CameraController`, `PoseVision`, `CameraScreen`, `LandingScreen`, `App`
itself — has never had a vitest unit test either, for the same reason:
they're thin, mostly-untestable-in-isolation wrappers around real browser
APIs (`getUserMedia`, MediaPipe's WASM runtime, `document`/DOM), verified
instead by driving the real thing in a real browser (this project's vitest
setup runs in plain Node, with no jsdom/happy-dom — deliberately not added
just for this, to stay consistent with that existing precedent).
`RecordingManager` follows the same pattern: it's built entirely on
`HTMLCanvasElement`, `HTMLVideoElement`, `MediaRecorder`, and `Blob`/`URL`,
none of which exist outside a real browser. It's verified instead by the
scripted Chromium run below (using Chromium's built-in fake camera device,
`--use-fake-device-for-media-stream`, so it needs no real webcam and no
network) and the manual checklist further down.

## What was verified for the foundation stage

Using a headless Chromium instance with a fake camera device
(`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`), the
following flow was scripted and confirmed to work with **zero uncaught
exceptions**:

1. Landing screen renders (`PHANTOM` brand, tagline, ENTER CAMERA / HOW IT
   WORKS buttons).
2. HOW IT WORKS panel opens and closes.
3. ENTER CAMERA requests camera permission, camera screen becomes visible,
   video stream starts (confirmed via `videoWidth`/`videoHeight`/`readyState`
   on the `<video>` element).
4. DEBUG toggle shows/hides the FPS/vision/pose/confidence panel.
5. BACK returns cleanly to the landing screen and stops the camera stream.
6. A model-load failure (see caveat below) is caught and shown in a clear,
   specific error overlay rather than crashing the app.

**Caveat:** the sandbox this was built in blocks outbound network access to
the MediaPipe CDN hosts (`cdn.jsdelivr.net`, `storage.googleapis.com`) at
the infrastructure level, so the actual pose-detection loop (model loaded,
skeleton tracking a real/fake body) could not be exercised end-to-end in
that environment. The failure path was confirmed instead (network blocked ->
`VisionError` -> error overlay shown, no crash). **This must be manually
verified in a normal, unrestricted environment before considering the
foundation stage done** — see the checklist below.

## What was verified for the Avatar (this phase)

Same sandbox network restriction as before (see the caveat above) meant the
avatar could not be exercised through the real camera + MediaPipe pipeline
here either. Instead, `SceneManager`, `TrackingManager`, and `Avatar` — the
real, unmodified app modules — were driven directly in a real Chromium/WebGL
context (bypassing only `PoseVision`, which needs the blocked CDN) with
synthetic pose data, and the actual rendered canvas was captured:

1. A standing pose renders as a recognizable, correctly-proportioned
   humanoid (head/neck/torso/arms/legs), with a visible soft shadow cast
   onto the floor.
2. Feeding an "arms raised" pose moves the shoulder/elbow/wrist segments to
   the new angles correctly — confirming the quaternion orientation math
   reacts correctly to a real pose change, not just the one pose it was
   written against.
3. `setDisplayMode('skeleton')` visibly swaps to thin limbs, a brighter
   accent color, and visible joint-marker spheres at each joint — distinct
   from mannequin mode, using the same underlying data.
4. Setting `frame.present = false` (simulating `LOST`) makes the avatar
   fully disappear (confirmed both via `root.visible === false` and an
   empty rendered frame).
5. Tracking "recovering" back to the standing pose makes the avatar
   reappear correctly, matching the original standing render.

Zero console/page errors across all of the above. **This is not a
substitute for testing against a real body** — it proves the geometry,
hierarchy, and state transitions render correctly for the specific poses
tested, not that a real, continuously-noisy MediaPipe feed drives it
smoothly. See the checklist below for that.

## What was verified for Independent Shadow (this phase)

Same approach and same sandbox caveat as the Avatar section above:
`SceneManager`, `TrackingManager`, `Avatar`, and `IndependentShadowEffect` —
the real, unmodified modules — driven directly with a synthetic pose
sequence, rendering to a real canvas:

1. Walking sideways for ~0.65s renders the live avatar and a visibly
   distinct second duplicate: dark/semi-transparent, flattened toward the
   floor, offset to the side, lagging behind the live position.
2. Stopping and holding position lets the shadow catch up.
3. Raising both arms from a settled stop shows the shadow's arms visibly
   **not** matching the live avatar's fully-raised angle in the first few
   frames after the pose change — the "doesn't perfectly copy" requirement,
   visible on screen, not just asserted in a unit test.
4. Soft ground-shadow blobs are visible beneath the character throughout.

Zero console/page errors. The rendered duplicate reads as light gray rather
than near-black in these captures — that's this test harness's plain white
page background showing through a semi-transparent dark material (standard
alpha blending against a light backdrop), not the actual material color;
over the real live camera feed (rarely pure white) it reads darker. The
duplicate also lands partially outside this particular 900x700 test
viewport at this test's specific `horizontalOffset` and pose framing — a
framing artifact of the synthetic test, not a rendering bug (the offset/
rotation/flatten math is separately verified exactly, numerically, in
`IndependentShadowEffect.test.ts`). **Neither of these substitutes for
looking at it against a real body on a real screen** — see the checklist
below.

## What was verified for Clone (this phase)

Same sandbox network restriction as before (see the foundation-stage caveat
above), and the same approach as the Avatar/Independent Shadow phases: the
real, unmodified `SceneManager`, `TrackingManager`, `Avatar`, and
`CloneEffect` modules were driven directly in a real Chromium/WebGL context
with a synthetic pose sequence (arms slowly rising, then held), rendering to
a real canvas and reading it back via `canvas.toDataURL()`:

1. **SPREAD, 5 clones**: the live avatar plus 5 clearly separated clones
   render in a fanned-out arrangement around it, each with a visible floor
   shadow and a visibly-fading opacity across the lineup — no two bodies
   fully overlap. (The initial capture caught the 3- and 5-clone patterns'
   center slot sitting almost exactly where the live avatar stands, making
   it read as one overlapping figure rather than a distinct clone; the
   `CLONE_SLOT_PATTERNS` center-slot offsets were increased and the capture
   re-run to confirm clear separation — see the CloneEffect section of
   ARCHITECTURE.md.)
2. **DELAYED, 3 clones**: after continuing to raise arms, the clones show a
   visible "motion echo" — their arms lag behind the live avatar's fully-
   raised pose by a visibly increasing amount, matching `delayStepMilliseconds`
   scaling with pool index.
3. **SAME, 2 clones**: both clones stay synchronized with the live avatar's
   current pose, offset by only the small SAME/DELAYED baseline spacing
   (visibly tighter than the SPREAD arrangement above).
4. **Tracking lost**: setting `present: false` hides every pooled clone
   (`root.visible === false` confirmed for all 5 pool slots, including the
   3 not currently selected by `count`).

Zero console/page errors across all of the above. As with the Avatar and
Independent Shadow phases, this proves the pooling, arrangement math, and
mode behavior render correctly for the poses tested — it is not a
substitute for judging how the effect feels against a real, continuously
noisy camera feed. See the checklist below for that.

## What was verified for Ghost (this phase)

Same sandbox network restriction and approach as the Clone/Independent
Shadow phases: the real, unmodified `SceneManager`, `TrackingManager`,
`Avatar`, and `GhostEffect` modules driven directly with synthetic pose
data in a real Chromium/WebGL context, rendering to a real canvas:

1. **Readability over bright and dark backgrounds** (the explicit
   requirement): the same ghost pose was rendered with the WebGL renderer's
   own clear color set to pure white and then near-black (not just the
   page's CSS background — `canvas.toDataURL()` only captures the canvas's
   own pixel buffer, so the test paints an opaque color directly into the
   render target to actually exercise this). The ghost's translucent
   silhouette and glow accents are both clearly visible against either
   background — normal blending keeps the body readable on white, and the
   emissive glow reads clearly against black, confirming the material
   design decision documented in ARCHITECTURE.md.
2. **High glow, trail off**: `glowStrength: 2, trailEnabled: false` against
   a dark background shows a brighter emissive accent with no trail
   markers — confirms the trail toggle actually removes the trail rather
   than just dimming it, and that a strong glow alone doesn't read as
   "noisy" (no stray artifacts, just a brighter silhouette).
3. **Trail on, bright background**: small glowing echo markers are visible
   trailing the wrists/ankles/head without overwhelming the frame — a
   restrained accent, not clutter.
4. **Tracking lost**: setting `present: false` hides the ghost avatar and
   every trail step; a `getObjectByName`-style internal check confirmed
   `ghostAvatar.root.visible` flips from `true` to `false`.

Zero console/page errors across all of the above.

### Mobile performance check (this phase)

Per the explicit "Test mobile performance" requirement, a synthetic
benchmark (`Emulation.setCPUThrottlingRate` at 6x, via the Chrome DevTools
Protocol, in a 400x800 viewport approximating a phone) compared 240 frames
of the base avatar alone against the base avatar with Ghost enabled
(`glowStrength: 1.5`, `trailEnabled: true`, `trailStrength: 1` — the
heaviest configuration):

- Before optimizing the trail (one `Mesh` per echoed joint): Ghost added
  roughly 3x the baseline's per-frame render time.
- After switching the trail to one `InstancedMesh` per step (see
  ARCHITECTURE.md's performance section): total draw calls for the scene
  dropped from 48 to 36, and per-frame time measurably improved, for
  pixel-identical visual output (confirmed by re-running the visual check
  above before and after and comparing the renders).

This is a synthetic, software-rendered (headless Chromium/SwiftShader)
measurement — the absolute millisecond figures are not representative of a
real device's GPU-accelerated performance, but the *relative* comparison
(baseline vs. Ghost, before vs. after the trail optimization) is meaningful
and is what drove the InstancedMesh change. **This does not substitute for
testing on a real phone** — see the manual checklist below.

## What was verified for Reverse (this phase)

Same sandbox network restriction and approach as the previous effect
phases: the real, unmodified `SceneManager`, `TrackingManager`, `Avatar`,
and `ReverseEffect` modules driven directly with synthetic pose data in a
real Chromium/WebGL context, rendering to a real canvas, for all three
presets across the four required scenarios (arms, body rotation,
walking-in-place-like movement, camera movement):

1. **Arms — MIRROR**: raising one arm outward produces a reverse figure
   whose corresponding raised arm points outward on the *opposite* side —
   the two figures read as true mirror images of each other, standing
   side by side, arms reaching away from one another exactly as two people
   facing a real mirror would.
2. **Arms — REVERSE_HORIZONTAL**: the same outward-raised arm produces a
   reverse figure whose arm visibly crosses *inward*, toward its own body
   — clearly, visibly different from MIRROR's outward reflection, and a
   direct visual match for the spec's literal example ("moves its hand
   inward").
3. **Body rotation**: turning the torso while holding the arm raised keeps
   both MIRROR and REVERSE_HORIZONTAL geometrically coherent through the
   turn — no limb detaches, stretches, or snaps to an unrelated position at
   any point in the rotation sequence.
4. **Walking-in-place-like movement**: an alternating knee-lift sequence
   renders smoothly frame to frame under all three presets, with no visible
   jumps or frozen limbs.
5. **Camera movement**: sweeping the whole body sideways (simulating the
   user or camera moving) keeps the reverse figure correctly mirrored about
   the *current* frame's body center at every step — it never lags behind
   or reflects about a stale position, for MIRROR/REVERSE_HORIZONTAL (no
   delay); DELAYED_MIRROR shows the same sweep with a visible, bounded lag,
   as expected.

Zero console/page errors across all fifteen (3 presets × 5 scenario/preset
combinations plus the arms comparison) captures. As with every previous
effect phase, this proves the transform math and preset wiring render
correctly for the poses tested — it is not a substitute for judging how
the effect feels against a real, continuously noisy camera feed. See the
checklist below for that.

## What was verified for Recording (this phase)

Unlike every previous phase, this one doesn't bypass `PoseVision` with
synthetic pose data — recording doesn't depend on pose tracking at all, so
the sandbox's blocked-CDN issue is irrelevant here. Instead, Chromium was
launched with `--use-fake-device-for-media-stream` and
`--use-fake-ui-for-media-stream`, giving `getUserMedia({ video: true })` a
real (synthetic-pattern) camera stream with no network dependency and no
manual permission prompt to click through. The real, unmodified
`SceneManager`, `Avatar`, and `RecordingManager` were then driven directly
against that real video element and a real WebGL canvas. All 16 scripted
checks passed with zero console/page errors:

1. **The fake camera stream is genuinely active** (`videoWidth`/`videoHeight > 0`)
   before recording is attempted.
2. **`isSupported()` is `true`** in this Chromium build.
3. **`start()` immediately reports `'recording'`.**
4. **The composited output actually contains both sources**: a screenshot
   of the *private* composite canvas, taken mid-recording, was saved and
   visually inspected — it clearly shows the fake camera's test pattern
   (background color, corner markers, moving wedge, timestamp text)
   **and** the 3D avatar rendered on top, confirming the compositing
   pipeline works end-to-end, not just in theory.
5. **Stopping produces a non-empty `Blob`** with a `video/webm;codecs=vp9`
   MIME type (this Chromium's top preference), and **`getPreviewUrl()`
   returns a `blob:` URL.**
6. **The state sequence is exactly `recording -> stopped`** for a normal
   take (confirmed via the `onStateChange` callback's log, not just the
   final `getState()` read).
7. **`retake()` returns to `'idle'`** and clears both `getBlob()` and
   `getPreviewUrl()` back to `null`.
8. **A second take, recorded with `cameraMirrored: true`** (exercising the
   manual-mirror draw path), stops cleanly and **`download()` does not
   throw** (it triggers a native `<a download>` click — verifying an actual
   browser save dialog/file requires a real, non-headless run, see the
   manual checklist).
9. **`reset()` called mid-recording** moves to `'idle'` *immediately*
   (synchronously) and — checked again after waiting for the recorder's
   asynchronous `onstop` to have fired — **stays `'idle'` with no blob**,
   confirming the `discardOnStop` race guard described in ARCHITECTURE.md
   actually prevents the late `onstop` from resurrecting a `'stopped'`
   state.
10. **A forced zero-size scene canvas makes `start()` throw
    `RecordingError('zero-size-canvas')`.**
11. **A video element with no active stream makes `start()` throw
    `RecordingError('camera-unavailable')`.**
12. **Temporarily removing `window.MediaRecorder`** makes `isSupported()`
    return `false` and `start()` throw `RecordingError('unsupported')`.
13. **Forcing WebGL context loss mid-recording** (via the real
    `WEBGL_lose_context` extension, not a mock) makes `RecordingManager`
    stop the recording and report a `RecordingError('context-lost')`
    through `onError` — confirmed both that the error fired and that
    `getState()` settled on `'stopped'` afterward (whatever was captured
    before the loss is still available), not stuck or crashed.

No microphone permission was requested at any point — `RecordingManager`
never calls `getUserMedia` itself (see ARCHITECTURE.md); this is a
structural guarantee from reading the source, not something that needs a
runtime check.

## Manual verification checklist (run this in a real browser with a real camera)

Run `npm run dev`, open `http://localhost:5173` in a real desktop browser
with a webcam attached (or a phone browser over an HTTPS tunnel — see
README's HTTPS note):

- [ ] Landing screen looks correct; ENTER CAMERA and HOW IT WORKS both work.
- [ ] ENTER CAMERA prompts for camera permission.
- [ ] After granting permission, the live camera feed appears full-screen.
- [ ] Within a couple of seconds, a cyan skeleton (dots + lines) appears
      overlaid on your body and tracks your movement in real time.
- [ ] Move toward/away from the camera — the skeleton should scale/shift
      plausibly with you, not float independently.
- [ ] **Mirroring (regression check):** raise your right hand — the
      skeleton's corresponding hand (on the mirrored, "selfie" video) must
      move the same direction as your visible hand, not the opposite one.
      Move your whole body left/right — the skeleton must move the same
      screen-direction as your visible body. If it moves opposite, the
      canvas has picked up a CSS mirror again — check `#scene-canvas` in
      `ui/styles.css` has no `transform`.
- [ ] If a rear-camera device is available, switch to it (once a UI trigger
      exists — see TODO.md) and repeat the mirroring check: the rear camera
      is *not* mirrored, and the skeleton must still track in the same
      direction as the (unmirrored) visible body.
- [ ] Move to the edge of frame / step out of frame — the skeleton should
      hold briefly (grace period) then disappear; stepping back in should
      resume tracking without a stale/frozen pose.
- [ ] Toggle DEBUG — FPS should read a sane number (not 0, not NaN); State
      should read `TRACKING` while your body is visible, `RECOVERING`
      briefly if you duck out of frame for under ~600ms, and `LOST` if you
      stay out longer. Landmarks should read close to `33/33` when your
      whole body is in frame, lower when only part of you is visible.
      Inference should show a number of milliseconds, not `-`, once a body
      has been detected at least once.
- [ ] BACK returns to the landing screen; the camera's hardware indicator
      light (if your device has one) turns off, confirming the stream was
      actually stopped.
- [ ] Deny camera permission (or revoke it in browser settings and retry) —
      a clear "permission was denied" message should appear, with a working
      Try Again / Back.
- [ ] Reload on a plain `http://<lan-ip>:5173` (not localhost) — should show
      the "requires HTTPS" message instead of a crash.
- [ ] Throttle CPU (e.g. Chrome DevTools Performance > CPU throttling 6x) —
      FPS should stay reasonable and the app should not freeze; pose
      inference should visibly slow down rather than blocking the UI.

## Manual verification: tracking quality (this phase)

The unit tests prove the state machine and math are wired correctly, but
whether the smoothing actually *feels* right — responsive without jitter —
can only be judged against a real, noisy camera signal. Run through each of
these with DEBUG on, watching the skeleton against your visible body and the
State/Landmarks/Confidence rows:

- [ ] **Standing still.** The skeleton should hold steady — no visible
      micro-jitter/vibration in the joints or bones. State: `TRACKING`.
- [ ] **Moving left/right.** The skeleton should track your position with
      the video, without a noticeable delay ("swimming" behind you) and
      without overshooting past where you stopped.
- [ ] **Raising arms.** Wrist/elbow joints should follow promptly — this is
      the fastest-moving part of the body and the best test of "does the
      filter lag."
- [ ] **Turning your body (rotating in place).** The skeleton should stay
      roughly attached to your torso as you turn; landmark count may drop
      as parts of you turn away from the camera (expected — MediaPipe's
      confidence legitimately drops on partially-occluded/edge-on limbs).
- [ ] **Moving closer/farther from the camera.** Confidence and Landmarks
      should stay high as you get closer; the skeleton should scale
      plausibly with distance, not jump in size.
- [ ] **Temporarily leaving the frame** (walk fully out of shot for ~1-2
      seconds). State should go `TRACKING` -> `RECOVERING` (briefly, holding
      the last pose without visibly freezing mid-air oddly) -> `LOST`.
      Landmarks/Confidence should drop to 0 once `LOST`.
- [ ] **Returning to frame** after being `LOST`. The skeleton should
      reappear directly at your new position — it must **not** visibly
      slide/crawl in from wherever it was last seen before you left. This
      is the smoother-reset behavior covered by
      `TrackingManager.test.ts`'s "recovers from LOST" test; this step
      confirms it also *looks* right on a real body, not just in the math.
- [ ] **Brief occlusion** (quickly duck below frame and back within well
      under a second). Should stay in `RECOVERING` and resume smoothly with
      no visible snap/jump — this is the complementary case to the one
      above (short gap: stay smooth; long gap: snap fast).

## Manual verification: Avatar (this phase)

The debug skeleton overlay is still there (toggle DEBUG), but the mannequin
is now the primary visible character — it should render always (not only in
DEBUG mode) whenever a body is tracked. Check it against your real body:

- [ ] **Shape.** You should see a coherent humanoid: head, neck, torso,
      two arms, two legs, all connected with no visible gaps or segments
      flying off to strange positions.
- [ ] **Arm movement.** Raise one arm, then the other, then both. The
      corresponding upper-arm/forearm/hand segments should bend at the
      elbow/wrist convincingly and follow your real arm's angle.
- [ ] **Leg movement.** Step/lift a knee, shift your stance. Thigh/shin/foot
      segments should follow, and both legs should stay attached to the
      hips area, not drift apart.
- [ ] **Turning your body.** The torso and shoulder line should visibly
      rotate as you turn (this is `torsoRotation` at work, indirectly, via
      the shoulder joints' own positions) rather than staying frozen facing
      the camera.
- [ ] **Moving relative to the camera** (closer/farther, left/right). The
      whole mannequin should scale and translate with you as one coherent
      body — no limb should visibly "swim" independently of the rest, and
      no limb should snap to an unrelated position.
- [ ] **Tracking loss.** Step out of frame — the mannequin should disappear
      entirely (not collapse into a pile at the origin, not leave a
      stray limb behind).
- [ ] **Recovery.** Step back into frame — the mannequin should reappear
      directly in your current pose, not slide in from its last-seen
      position (same underlying guarantee as the skeleton's recovery
      behavior, now visible on the actual character).
- [ ] **Ground shadow.** With reasonable lighting/light-facing in your
      scene setup, a soft shadow should be visible on the virtual floor
      beneath the character (may be subtle depending on camera angle/FOV —
      the floor is below the visible frame in a typical selfie framing, so
      this is easiest to see if you lean back or the camera is angled
      downward).
- [ ] **No red flags in DEBUG.** FPS should not measurably drop compared to
      before the avatar existed — the whole character is ~17 draw calls
      with two shared geometries, so it should be effectively free on any
      device that could already run the debug skeleton.

`setDisplayMode('skeleton')`, `setPosition`/`setRotation`/`setScale`, and
`setOpacity` have no UI control yet (no button wires them up) — they're
verified by `Avatar.test.ts` and the scripted visual check above, but if you
want to eyeball them yourself, drive them from the browser console via
`import('/src/avatar/Avatar.ts')` against a live `Avatar` instance, or wait
for the future Effect system to actually use them.

## Manual verification: Independent Shadow effect (this phase)

Open the camera, tap DEBUG to reveal the advanced panel (the sensitivity
slider lives there — see below), then tap **INDEPENDENT** to enable the
effect. Recall the concept: this is a visual illusion, not a physics
simulation — you're checking that it reads as *intentional*, not broken.

**Basic toggle**

- [ ] Tapping INDEPENDENT shows a dark, flattened, offset duplicate of
      your body near your feet/to one side; the button visibly indicates
      it's active (accent-colored).
- [ ] Tapping it again hides the duplicate immediately; the live avatar is
      completely unaffected either way.
- [ ] The sensitivity slider (inside the DEBUG panel) visibly changes how
      snappy vs. laggy the shadow feels while you move — low end feels
      heavier/slower to catch up, high end feels tighter/more immediate.

**Signature behavior — the actual point of this effect**

- [ ] **Slow movement.** Walk/shift slowly. The shadow should trail behind
      smoothly, staying recognizably body-shaped the whole time — no
      jitter, no snapping.
- [ ] **Fast movement.** Move quickly side to side. The shadow should lag
      more noticeably (this is expected — see delayMilliseconds/
      followStrength) but must still track a plausible, non-random path.
      It must **not** teleport, flicker, or leave a visible limb behind.
- [ ] **Stopping.** Move, then stop abruptly. The shadow should continue
      moving for a brief moment before settling into place — not stop
      dead the instant you do, and not endlessly wobble either.
- [ ] **Arm movement.** Raise one arm quickly. The shadow's corresponding
      arm should noticeably lag and not trace the exact same path/angle in
      real time — it should look like it's "catching up" rather than
      mirroring you, while the torso/hip area of the shadow stays close to
      its expected position throughout (the illusion never fully
      detaches).
- [ ] **Turning.** Turn your body left/right. The shadow should turn too,
      with its own slight lag/settle, not stay facing a fixed direction.
- [ ] **Jumping motion.** A small hop should be handled gracefully — the
      shadow reacts with extra lag/overshoot (it's the most dramatic,
      fastest motion you can make) but must recover and settle within a
      second or two, not spiral, invert, or get stuck off-screen. (Please
      only attempt small, safe hops in place with clear surroundings —
      this checklist is about verifying the visual effect, not about
      performing any physically risky movement.)
- [ ] **Camera motion** (if on a device where you can move the camera
      itself, e.g. a laptop you tilt, or by changing your distance to a
      fixed camera): moving closer/farther or changing the framing should
      not cause the shadow to jump discontinuously or detach further than
      usual — it should scale/reposition with the (also-updating) live
      avatar smoothly.

**Guardrails (things that must never happen)**

- [ ] The shadow never looks like a random/glitchy flicker — no
      teleporting, no strobing, no inverted limbs.
- [ ] The shadow never drifts so far from the live avatar that it stops
      reading as "your shadow" (e.g. wandering off to the side of the
      frame independent of your position). The core (torso/hip area)
      should always stay recognizably attached to the live position.
- [ ] Contact darkening is visible near the shadow's feet against the
      floor, not floating disconnected from it.
- [ ] Tracking loss (step out of frame) hides the shadow along with the
      live avatar; stepping back in brings both back without the shadow
      snapping across the whole scene.

## Manual verification: Clone effect (this phase)

Open the camera and tap **CLONE** to enable the effect — a count selector
(2/3/5) and mode selector (SAME/DELAYED/SPREAD) panel appears; a **RESET
ALL** button returns everything to defaults (disabled, count 3, SPREAD).

**Basic toggle and controls**

- [ ] Tapping CLONE shows the selected count of virtual copies arranged
      around you; the button visibly indicates it's active.
- [ ] Tapping it again hides all clones immediately; the live avatar is
      unaffected.
- [ ] Switching the count selector (2/3/5) changes how many clones are
      visible without any visible pop/flicker in the ones that stay shown.
- [ ] Switching the mode selector (SAME/DELAYED/SPREAD) changes the
      clones' behavior immediately, without hiding/reshowing them.
- [ ] **RESET ALL** turns the effect off, and the count/mode selectors
      visibly return to their defaults (3, SPREAD).

**Different body positions / turning**

- [ ] Stand in different positions in frame (left, right, center, closer,
      farther) — clones should stay arranged around your current position
      and scale with your `bodyScale`, not stay pinned to a fixed screen
      location.
- [ ] Turn your body left/right — every visible clone should turn with you
      (they read the same tracked pose, just offset/delayed).

**Mode-specific behavior**

- [ ] **SAME**: all clones mirror your current pose in real time, with only
      a small, fixed spatial offset between them — no lag.
- [ ] **DELAYED**: clones visibly echo your movement with increasing delay
      the further a clone is in the lineup — raise an arm quickly and watch
      each clone raise its arm slightly later than the previous one.
- [ ] **SPREAD**: clones fan out further from your position than in SAME/
      DELAYED, each still following your current pose.

**Entering/leaving frame and weak tracking**

- [ ] Step out of frame — all clones disappear along with the live avatar;
      none are left behind floating at a stale position.
- [ ] Step back into frame — clones reappear at your new position/pose
      without sliding in from anywhere.
- [ ] In poor tracking conditions (partial occlusion, low light, edge of
      frame), clones should never appear detached, frozen mid-air, or
      visibly "stuck" independent of your tracked body — if tracking drops,
      they should hide rather than show a stale pose.

**Guardrails (things that must never happen)**

- [ ] No clone ever appears at an arbitrary/unrelated position — every
      clone's offset should visibly scale with your distance from the
      camera (via `bodyScale`), never stay a fixed pixel offset regardless
      of your size on screen.
- [ ] No clone flickers, teleports, or appears without a visible relation
      (pose-wise) to your live movement.
- [ ] Enabling the maximum count (5, SPREAD) should not cause a dramatic
      frame-rate drop on a modern desktop/phone — check the DEBUG panel's
      FPS reading before and after enabling; see ARCHITECTURE.md's
      performance-considerations section for what to do if it does drop on
      a weaker device.

## Manual verification: Ghost effect (this phase)

Open the camera and tap **GHOST** to enable the effect — a panel with
Opacity/Delay/Glow sliders and a TRAIL toggle appears.

**Basic toggle and controls**

- [ ] Tapping GHOST shows a translucent, glowing duplicate of your body; the
      button visibly indicates it's active.
- [ ] Tapping it again hides it immediately; the live avatar is unaffected.
- [ ] Dragging the Opacity slider changes how translucent the ghost looks,
      live.
- [ ] Dragging the Delay slider changes how far behind your live movement
      the ghost's pose sits — at 0 it should track your current pose
      exactly (no lag); higher values should show a visible, fixed lag
      (not a spring/chase — it reads as "sampling a moment ago," not
      "catching up").
- [ ] Dragging the Glow slider changes how bright the emissive accent looks,
      from barely visible near 0 to a clearly brighter glow near the top
      of the range.
- [ ] Tapping TRAIL toggles the motion-trail echoes on/off; the button
      label reflects the current state (TRAIL: ON / TRAIL: OFF).

**Readability over different backgrounds**

- [ ] Point the camera at a bright/white background (a wall, a window, a
      piece of paper) — the ghost's silhouette should stay clearly visible,
      not wash out or disappear.
- [ ] Point the camera at a dark background (a shadowed room, dark
      clothing/wall) — the ghost should still read clearly, with its glow
      accent visible against the dark.
- [ ] In both cases, the effect should look intentional — a "spectral"
      duplicate — not garish, flickery, or distracting.

**Signature behavior**

- [ ] **Scale breathing.** While holding still, look closely — the ghost
      should very subtly grow and shrink in a slow, calm rhythm. It should
      read as "alive," not as an obvious pulsing animation.
- [ ] **Vertical drift.** The ghost should drift up and down very slightly
      over a few seconds, independent of your own movement — subtle enough
      that you have to watch for it, not a bounce.
- [ ] **Delayed pose** (with Delay above 0). Move steadily, then stop. The
      ghost should visibly be a few pose-samples behind you the whole time
      it's moving, then also stop — matching your position from a moment
      ago, not chasing you.
- [ ] **Trail** (with TRAIL on). Move an arm or a leg — small glowing echo
      markers should trail briefly behind your wrists/ankles/head, fading
      out further back. They should read as a subtle motion accent, not
      clutter.
- [ ] **Turning.** Turn your body left/right — the ghost should turn with
      you (on the same delay setting), staying recognizably attached to
      your position.

**Guardrails (things that must never happen)**

- [ ] The ghost never flickers, strobes, or looks glitchy — all motion
      (breathing, drift, trail fade) should look smooth and deliberate.
- [ ] The ghost never becomes fully invisible against either a bright or a
      dark background at the default settings.
- [ ] The effect never looks "noisy" — no overwhelming glow, no excessive
      trail clutter, even with Glow and the trail both at their maximum.
- [ ] Tracking loss (step out of frame) hides the ghost and its trail
      completely; stepping back in resumes correctly without a stale pose
      flash.

**Mobile performance**

- [ ] With DEBUG open, compare the FPS reading with GHOST off vs. on
      (default settings, then with TRAIL on and Glow near maximum) on the
      actual mobile device being tested — it should stay smooth
      (comparable to CLONE at a similar body count, per ARCHITECTURE.md's
      draw-call budget).
- [ ] If FPS drops noticeably on a given device with GHOST + TRAIL both on,
      turn TRAIL off first (the documented cheapest lever) and confirm FPS
      recovers before concluding the device can't handle the effect at all.

## Manual verification: Reverse effect (this phase)

Open the camera and tap **REVERSE** to enable the effect — a Mode selector
(MIRROR / REVERSE H. / DELAYED) and a "Mode: <label>" preview line appear.

**Basic toggle and controls**

- [ ] Tapping REVERSE shows a second figure, offset to the side, whose
      movement responds differently from your own; the button visibly
      indicates it's active.
- [ ] Tapping it again hides the phantom immediately; the live avatar is
      unaffected.
- [ ] Switching between MIRROR / REVERSE H. / DELAYED changes the
      phantom's behavior immediately, without hiding/reshowing it.
- [ ] The preview label always shows the currently selected mode's name
      ("Mirror" / "Reverse Horizontal" / "Delayed Mirror"), updating the
      instant you pick a different one.

**Arms**

- [ ] **MIRROR**: raise one arm outward — the phantom's corresponding arm
      raises outward on the *opposite* side, reading as a true mirror
      image standing beside you (like looking at your reflection).
- [ ] **REVERSE_HORIZONTAL**: raise the same arm outward — the phantom's
      *same-side* arm should visibly move inward, toward its own body,
      clearly different from MIRROR's outward reflection. This is the
      literal "move a hand outward, the phantom moves it inward" behavior.
- [ ] In both modes, the phantom's arm never looks stretched, snapped to a
      strange position, or disconnected from its shoulder.

**Body rotation**

- [ ] **MIRROR**: turning your body left/right should make the phantom
      appear to turn the opposite way, consistent with a real mirror.
- [ ] **REVERSE_HORIZONTAL**: turning your body should turn the phantom
      the *same* way you turned (not reversed) — only the limbs respond
      differently in this mode, not the overall stance/facing.

**Walking-in-place-like movement**

- [ ] March in place (alternating knee lifts). The phantom should track
      the motion smoothly under every preset, with no jitter, freezing, or
      limbs snapping between frames.

**Camera movement**

- [ ] Move side to side, or step closer/farther from the camera. The
      phantom should stay correctly mirrored/inverted relative to your
      *current* position at all times — MIRROR and REVERSE_HORIZONTAL
      should never look like they're reflecting about a stale, earlier
      position.
- [ ] **DELAYED_MIRROR**: the same movement should show a clear, bounded
      lag (the phantom mirrors where you were a fraction of a second ago),
      distinct from the immediate response of plain MIRROR.

**Guardrails (things that must never happen)**

- [ ] The phantom's proportions never look stretched, twisted, or
      disconnected — every preset is a rigid reflection or a same-length
      limb inversion, so nothing here should ever distort body shape.
- [ ] Movement never looks erratic, jittery, or random — everything is a
      deterministic transform of your own tracked movement; if it ever
      looks chaotic, that's a bug, not the intended "mirror"/"reverse"
      character.
- [ ] The output should read as **intentionally designed** — a coherent
      second figure with a clear, describable relationship to your
      movement — never like broken or lagging tracking.
- [ ] Tracking loss (step out of frame) hides the phantom; stepping back
      in resumes correctly without a stale pose flash.

## Manual verification: Recording (this phase)

Open the camera (any effect(s) on or off — recording should work either
way) and locate the round record button at the bottom of the screen.

**Basic record/stop/retake cycle**

- [ ] Tapping the record button starts recording: it turns into a square
      "stop" icon, and a pulsing "● REC" indicator appears near the top of
      the screen.
- [ ] Tapping it again (now showing STOP) ends the recording and opens a
      local preview overlay with a playable video, a SAVE button, and a
      RETAKE button.
- [ ] The preview video shows **both** your live camera feed **and**
      whatever effect(s) were active while recording — not just the 3D
      overlay on a black/transparent background, and not just the raw
      camera feed with no effect.
- [ ] The preview plays back with standard `<video>` controls (play/pause/
      scrub).
- [ ] Tapping RETAKE closes the preview and returns to the live camera
      view with the record button ready to record again.
- [ ] Tapping SAVE triggers your browser's normal file-save/download
      behavior for the recorded video (a downloads-folder save, or a
      "Save As" prompt, depending on your browser/OS) — check the saved
      file actually plays in a normal video player.

**What the recording should match**

- [ ] The mirroring in the recording matches what you saw live while
      recording (front camera: mirrored selfie view; if you have a rear-
      camera device to test, unmirrored).
- [ ] The recorded framing matches the live on-screen framing (not
      stretched, squashed, or showing extra video outside what was
      visible on screen) — this exercises the same `object-fit: cover`
      crop math as the skeleton/avatar overlay.
- [ ] Recording, stopping, then immediately starting a new recording
      (without tapping RETAKE first) works cleanly and discards the
      previous take.

**Guardrails and edge cases**

- [ ] No microphone permission prompt ever appears, before, during, or
      after recording.
- [ ] Leaving the camera screen (BACK) while a recording is in progress
      does not crash or leave the app in a broken state; re-entering the
      camera screen shows the record button ready to go, with no leftover
      preview from the previous session.
- [ ] If your browser doesn't support recording (older Safari/Firefox
      versions are the most likely candidates), the record button doesn't
      appear at all, and a short "Recording isn't supported in this
      browser" note is shown instead — the rest of the app (camera,
      effects) still works normally.
- [ ] Resize the browser window (or rotate a mobile device) right as you
      tap record — the recording should either start normally against the
      new size or show a brief inline error, never silently produce a
      corrupt/empty file.
- [ ] (If you can force it — e.g. via `chrome://gpu` "Reset" while
      recording, or unplugging an external GPU) losing the WebGL context
      mid-recording stops the recording gracefully rather than crashing
      the tab; whatever was captured up to that point should still be
      available in the preview.

## Mobile-specific checks

- [ ] Test on at least one iOS Safari and one Android Chrome device.
- [ ] Portrait orientation: the overlay should stay aligned with the video
      (this exercises the `object-fit: cover` crop compensation).
- [ ] Rotating the device mid-session should not misalign the overlay for
      more than one resize event.
