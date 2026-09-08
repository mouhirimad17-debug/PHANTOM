# TODO

## Done (foundation stage)

- [x] Project scaffold (Vite + TypeScript, strict mode)
- [x] Modular folder architecture
- [x] Camera module: permission request, front/back facing option, start/stop,
      capability detection, typed errors
- [x] Three.js rendering module: scene, perspective camera, renderer,
      lighting, virtual floor, resize handling, DPR clamp, animation loop
- [x] MediaPipe Tasks Vision integration: model load with GPU->CPU fallback,
      per-frame pose + world landmark detection, typed errors
- [x] Tracking module: per-axis One Euro Filter smoothing (configurable
      strength), a formal INITIALIZING/TRACKING/RECOVERING/LOST state
      machine, normalized-landmark -> Three.js scene-space coordinate
      mapping (with `object-fit: cover` crop + mirroring compensation),
      derived bodyCenter/shoulderCenter/hipCenter/torsoRotation/bodyScale,
      and a TrackingHistory ring buffer (push/getLatest/getAtOffset/clear)
      ready for future Delay/Reverse effects
- [x] Live debug skeleton overlay (joints + bones) rendered in the 3D scene
- [x] **Avatar module** — procedural, low-poly humanoid mannequin (capsule
      primitives, quaternion-oriented limb segments, hierarchical
      root/torso/hips grouping), with
      updateFromTracking/setPosition/setRotation/setScale/setVisible/
      setOpacity/reset, plus a skeleton/mannequin display-mode toggle.
      Casts/receives shadows on the existing virtual floor.
- [x] Landing screen + camera screen UI, debug stats panel (FPS/vision/state/
      confidence/landmarks/inference/effect + mirroring diagnostic)
- [x] Error states: permission denied, camera not found/in use, insecure
      context, unsupported browser, WebGL unavailable, model load failure,
      mid-session detection failure
- [x] Adaptive pose-inference throttling based on measured inference duration
- [x] Automated vitest suite (coordinate/mirroring math, tracking state
      machine, One Euro filter, TrackingHistory, avatar limb math and
      hierarchy) — see TESTING.md for exactly what's covered vs. still
      manual-only
- [x] README / ARCHITECTURE / TODO / TESTING docs
- [x] **Effect interface** (`enable/disable/update/reset`) in `effects/Effect.ts`.
- [x] **Detach/independence behavior**, first realized as **IndependentShadowEffect**
      — a dark, flattened, offset duplicate that trails the live avatar with
      a deterministic delay + damped-spring settle (no `Math.random()`
      anywhere), with per-joint drift so extremities lag the core
      convincingly. Owns its own `Avatar` (new `'shadow'` display mode) and
      its own `TrackingHistory`. UI: an INDEPENDENT toggle button, and a
      sensitivity slider tucked inside the existing DEBUG panel. See
      ARCHITECTURE.md and TESTING.md for the full design and manual test
      checklist.
- [x] **CloneEffect** — 2/3/5 selectable virtual copies of the user, each
      driven directly from a stored `TrackingFrame` (no spring/smoothing —
      contrast IndependentShadowEffect). Three modes: SAME (all clones on
      the current frame), DELAYED (each clone reads a different offset into
      its own `TrackingHistory`), SPREAD (current frame + a scaled spatial
      offset). A fixed pool of 5 `Avatar` instances is created once and
      reused for the whole session (never destroyed/recreated); each clone
      gets a deterministic, bounded position from a fixed arrangement
      pattern (never an arbitrary floating copy) and a slightly-fading
      opacity for visual variation. UI: a CLONE toggle, count/mode segmented
      selectors, and RESET ALL. See ARCHITECTURE.md (design + performance
      considerations) and TESTING.md for the full test checklist.
- [x] **GhostEffect** — a translucent, glow-accented duplicate. `Avatar`
      gained a fourth display mode (`'ghost'`) using normal (not additive)
      alpha blending so the effect stays readable over both bright and dark
      backgrounds, plus a new `setGlowIntensity()` for the emissive "glow
      strength" knob. Deterministic scale breathing and vertical drift (both
      sinusoids, no `Math.random()`), an optional single-sample historical
      delay (own `TrackingHistory`, no spring), and a fixed-size fading
      motion trail at a handful of extremity joints, rendered as one
      `InstancedMesh` per trail step rather than one mesh per joint after a
      CPU-throttled benchmark showed the naive version costing ~3x the base
      avatar's render time. UI: a GHOST toggle plus Opacity/Delay/Glow
      sliders and a TRAIL toggle. See ARCHITECTURE.md (design + performance
      considerations, including the measured trail optimization) and
      TESTING.md (including the mobile-performance check) for details.
- [x] **ReverseEffect** — "the Phantom responds differently from the user,"
      via three pure, deterministic transform functions
      (`transformPosition`/`transformRotation`/`transformLimbMotion`, in
      their own `reverseTransforms.ts`) and three presets: MIRROR (every
      joint reflected about the body's own centerline — a rigid, distortion-
      free mirror image), REVERSE_HORIZONTAL (core joints copied through
      unchanged; each limb extremity's horizontal displacement from its
      shoulder/hip anchor inverted — "move a hand outward, the phantom
      moves the same hand inward"), and DELAYED_MIRROR (the MIRROR
      transform sourced from a short historical sample via the effect's own
      `TrackingHistory`). UI: a REVERSE toggle, a Mode segmented selector,
      and a live preview label showing the selected preset's name. While
      writing this effect's lifecycle tests, found and fixed a
      cross-cutting bug shared by IndependentShadowEffect/CloneEffect/
      GhostEffect: `enable()` never undid `disable()`'s
      `avatar.setVisible(false)`, so a real toggle-off-then-on cycle would
      leave an effect permanently invisible — see ARCHITECTURE.md's
      ReverseEffect section and TESTING.md for the full writeup.

## Not yet implemented

- [ ] **ShadowEffect** as its own named mode — arguably already covered:
      the base Avatar always casts a soft shadow (see ARCHITECTURE.md), and
      IndependentShadowEffect is a distinct, more dramatic take on the same
      idea. Revisit whether a separate, simpler "just a shadow" mode is
      still wanted once more effects exist.
- [ ] **DelayEffect** — avatar driven by a short historical pose buffer (the
      `TrackingHistory` + delayed-target pattern already exists in
      `IndependentShadowEffect`; this would be that pattern without the
      spring/drift/flatten on top).
- [ ] **Effect selector UI** on the camera screen (currently only
      IndependentShadowEffect exists, with its own dedicated toggle button
      rather than a general selector — revisit once there's more than one
      effect to choose between).
- [ ] **Recording module** — composed canvas capture -> downloadable video
      file (`recording/`), record/stop UI, never uploaded anywhere.
- [ ] **Reset button** UI (once there's per-session state worth resetting —
      e.g. clone count, effect parameters).
- [ ] Back/front camera switch button UI (the `CameraController.switchFacing()`
      capability already exists; no UI trigger yet).
- [ ] UI trigger for `Avatar.setDisplayMode()` (skeleton/mannequin) — the
      capability exists and is tested, nothing in the UI calls it yet.
- [ ] Bundle-size optimization: lazy-load MediaPipe Tasks Vision (and
      possibly Three.js) on first "ENTER CAMERA" click instead of eagerly on
      page load, to keep the landing screen light on mobile.
