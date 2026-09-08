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

These do **not** cover the CSS layer (`#camera-video` / `#scene-canvas`
transforms) — that must still be checked in a real/scripted browser, since
it's DOM/CSS state, not application logic. They also can't cover *how good*
the smoothing feels on a real, noisy camera signal — that's inherently a
manual/subjective check, see below.

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

## Mobile-specific checks

- [ ] Test on at least one iOS Safari and one Android Chrome device.
- [ ] Portrait orientation: the overlay should stay aligned with the video
      (this exercises the `object-fit: cover` crop compensation).
- [ ] Rotating the device mid-session should not misalign the overlay for
      more than one resize event.
