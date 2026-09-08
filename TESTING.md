# Testing

There is currently **no automated test suite** — the foundation stage was
verified with type-checking, a production build, and manual/scripted
browser verification. This document describes both what was checked and how
to re-check it by hand.

## Automated checks that exist

```bash
npx tsc --noEmit   # strict type-check, no `any`-shaped escape hatches
npm run build      # type-check + production bundle (fails on build errors)
```

Run both after any change. Neither currently runs as CI — there is no CI
configured yet.

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
- [ ] Move to the edge of frame / step out of frame — the skeleton should
      hold briefly (grace period) then disappear; stepping back in should
      resume tracking without a stale/frozen pose.
- [ ] Toggle DEBUG — FPS should read a sane number (not 0, not NaN); Pose
      status should read `tracking` while your body is visible.
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

## Mobile-specific checks

- [ ] Test on at least one iOS Safari and one Android Chrome device.
- [ ] Portrait orientation: the overlay should stay aligned with the video
      (this exercises the `object-fit: cover` crop compensation).
- [ ] Rotating the device mid-session should not misalign the overlay for
      more than one resize event.
