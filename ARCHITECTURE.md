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
  avatar/     (not yet implemented — stylized humanoid representation)
  effects/    (not yet implemented — Shadow/Clone/Ghost/Reverse/Delay)
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
                              (per-joint EMA smoothing, loss grace period,
                               normalized coords -> Three.js scene space)
                                              |
                                              v
                                       TrackingFrame (stable, scene-space)
                                              |
                                              v
                                       DebugSkeleton.update()
                                    (renders joints/bones in the Three.js scene)
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
- **Mirroring**: the front camera is mirrored via CSS (`transform:
  scaleX(-1)`) on both the `<video>` and the overlay `<canvas>` for a
  natural "mirror" feel; `TrackingManager.setMirrored()` keeps the
  coordinate mapping in sync so the overlay never drifts from the video.
- **No per-frame allocation**: `TrackingFrame`'s 33 joints and `DebugSkeleton`'s
  `InstancedMesh`/`BufferAttribute` are allocated once and mutated in place
  every frame (see the "reused scratch vector" pattern in
  `tracking/CoordinateMapper.ts`).
- **Graceful degradation**: `PoseVision` retries model init on CPU if the
  GPU delegate fails; `App` adaptively widens the pose-inference interval
  based on a rolling average of actual inference duration, so a slow device
  falls back to a lower detection rate instead of janking the render loop.
- **Typed errors** (`types/camera.ts: CameraError`, `types/vision.ts:
  VisionError`) carry a machine-readable `type` so the UI layer
  (`App.describeError`) can show a specific, actionable message instead of
  a generic failure string.

## Extending with a new effect (future work)

The `effects/` module is intended to hold an `Effect` interface
(`enable()/disable()/update(deltaTime, trackingState)/reset()`), each
implementation consuming the same `TrackingFrame` that `DebugSkeleton`
consumes today. `DebugSkeleton` itself is a development/verification tool,
not the final avatar — the `avatar/` module (stylized humanoid/mannequin)
is what effects will actually manipulate and render.
