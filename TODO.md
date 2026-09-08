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

## Not yet implemented

- [ ] **Detach/independence behavior** — letting the virtual representation
      become independent from the user's live movement (core MVP
      requirement). The Avatar's `setPosition`/`setRotation`/`setScale` give
      an effect a way to offset a copy from the live-tracked pose, but no
      effect exists yet to actually drive that independence.
- [ ] **Effect interface** (`enable/disable/update/reset`) in `effects/`.
- [ ] **ShadowEffect** — mostly already the default look (the base Avatar
      always casts a soft shadow — see ARCHITECTURE.md), just needs
      wrapping in the formal Effect interface once it exists.
- [ ] **CloneEffect** — 2+ synchronized copies of the avatar. `Avatar`
      already supports multiple independent instances (per-instance
      materials, notably `setOpacity`), so this is mostly "construct N
      Avatars, feed them offset copies of the same TrackingFrame."
- [ ] **GhostEffect** — reduced opacity + visual separation from the live avatar.
- [ ] **ReverseEffect** — avatar driven by mirrored/altered movement.
- [ ] **DelayEffect** — avatar driven by a short historical pose buffer.
- [ ] **Effect selector UI** on the camera screen.
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
