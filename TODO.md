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
- [x] Tracking module: per-joint EMA smoothing, loss grace period,
      normalized-landmark -> Three.js scene-space coordinate mapping
      (with `object-fit: cover` crop + mirroring compensation)
- [x] Live debug skeleton overlay (joints + bones) rendered in the 3D scene
- [x] Landing screen + camera screen UI, debug stats panel (FPS/vision/pose/confidence)
- [x] Error states: permission denied, camera not found/in use, insecure
      context, unsupported browser, WebGL unavailable, model load failure,
      mid-session detection failure
- [x] Adaptive pose-inference throttling based on measured inference duration
- [x] README / ARCHITECTURE / TODO / TESTING docs

## Not yet implemented

- [ ] **Avatar module** — stylized humanoid/mannequin (procedural, low-poly),
      with position/rotation/scale/visibility/animation-state API. The debug
      skeleton is a placeholder for verifying tracking, not the real avatar.
- [ ] **Detach/independence behavior** — letting the virtual representation
      become independent from the user's live movement (core MVP requirement).
- [ ] **Shadow system** — soft virtual shadow under the avatar that responds
      to avatar position and a virtual light direction (the floor plane and
      lighting already exist in `rendering/SceneManager`; the shadow-casting
      avatar geometry does not yet).
- [ ] **Effect interface** (`enable/disable/update/reset`) in `effects/`.
- [ ] **ShadowEffect** — normal avatar + virtual shadow.
- [ ] **CloneEffect** — 2+ synchronized copies of the avatar.
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
- [ ] Automated tests (see TESTING.md — currently manual-only).
- [ ] Bundle-size optimization: lazy-load MediaPipe Tasks Vision (and
      possibly Three.js) on first "ENTER CAMERA" click instead of eagerly on
      page load, to keep the landing screen light on mobile.
