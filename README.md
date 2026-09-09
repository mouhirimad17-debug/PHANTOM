# PHANTOM

**Make the impossible appear on camera.**

PHANTOM is a browser-based AR/3D camera experience. It opens your camera,
detects your body's pose entirely **on your device** (no server, no
account, no upload), and renders a virtual 3D representation of your body
into the live camera view in real time. Four effects — **Shadow**,
**Clone**, **Ghost**, and **Reverse** — reinterpret that tracked pose in
different ways, and you can record a short local clip of the result.

This is PHANTOM's first public prototype: the core experience (camera,
tracking, avatar, all four effects, recording) is implemented and has been
through a dedicated QA/production-readiness pass — see
[QA_REPORT.md](./QA_REPORT.md) for exactly what was checked and what's
still known to be missing.

## What PHANTOM is (and isn't)

- It **is** a fully client-side web app: TypeScript + Vite + Three.js +
  MediaPipe Tasks Vision, with no backend, no database, and no accounts.
- It **is** a visual toy/prototype — every effect (Shadow, Clone, Ghost,
  Reverse) is a rendering illusion built from your tracked pose, not a
  physical simulation or a claim of any kind of real detection beyond body
  pose landmarks.
- It does **not** upload, store remotely, or analyze your camera feed
  anywhere — see [PRIVACY.md](./PRIVACY.md) for the full explanation of
  what data is processed and where.
- It does **not** require any API key, account, or paid service to run,
  build, or deploy.

## Prerequisites

- Node.js 18.19+ (Node 20/22 recommended)
- A modern browser with camera + WebGL support (recent Chrome, Edge,
  Safari, or Firefox)
- A device with a camera, and permission to use it

## Install

```bash
npm install
```

This installs everything needed to run, build, and test PHANTOM — there
are no additional accounts, API keys, or secrets to configure (see
"Secrets and API keys" below).

## Run locally

```bash
npm run dev
```

Opens on `http://localhost:5173`. Click **ENTER CAMERA**, grant camera
permission, and you should see your live camera feed with a procedural 3D
avatar tracking your body, a live status pill at the top, and an effect
rail along the bottom (SHADOW, CLONE, GHOST, REVERSE — DELAY is shown but
disabled; see [QA_REPORT.md](./QA_REPORT.md#known-limitations)). Tap the
round button at the bottom to record a short local clip (see **Recording**
below), and the settings icon next to it to fine-tune an active effect.

## Build

```bash
npm run build    # type-checks with tsc, then builds a static bundle to dist/
npm run preview  # serve that production build locally, to sanity-check it before deploying
```

`npm run build` is what CI/deployment should run — it fails the build on
any TypeScript error rather than emitting a broken bundle. The output in
`dist/` is a fully static site: any static file host works (see
"Deploying" below).

## Camera permission requirements

The browser will prompt for camera access the first time you tap **ENTER
CAMERA**. PHANTOM:

- only ever requests **video**, never audio/microphone (not for tracking,
  not for recording — recording captures what's already drawn on screen);
- asks once per browser/site (per the browser's own permission model, not
  anything PHANTOM controls) — if you deny it, PHANTOM shows a clear
  in-app error explaining how to re-enable it in your browser's site
  settings, rather than failing silently or retrying invisibly;
- never accesses the camera outside the camera screen — leaving it (the
  BACK button, or a fatal error) always stops the active camera stream
  (see [QA_REPORT.md](./QA_REPORT.md) for how this is verified).

## Secure-context requirement for deployed camera access

Browsers only allow camera access (`getUserMedia`) on:

- `http://localhost` (or `http://127.0.0.1`) — works out of the box with
  `npm run dev`;
- any origin served over `https://`.

A plain `http://` deployment (anything other than localhost) will **not**
be able to access the camera — this is a browser platform restriction, not
a PHANTOM limitation, and there is no way to bypass it. If you deploy
PHANTOM, deploy it over HTTPS.

**Testing on a phone over your local network** will *not* work over plain
`http://<your-lan-ip>:5173` for the same reason. To test on a real mobile
device, do one of:

- Tunnel the dev server through an HTTPS tunnel (e.g. `ngrok http 5173`,
  Cloudflare Tunnel) and open the HTTPS URL on your phone.
- Serve the dev server with a local TLS certificate (e.g. via `mkcert` + a
  Vite HTTPS server config).
- Deploy the production build to any static HTTPS host (Vercel, Netlify,
  GitHub Pages, etc.) — PHANTOM is a fully static app with no backend, so
  any of these work with no server-side configuration.

## Secrets and API keys

**None are required.** PHANTOM has no server component, no third-party API
that needs authentication, and no environment variables to set to run,
build, test, or deploy it. The only network calls the app itself ever
makes are unauthenticated, public, static-asset downloads of MediaPipe's
pose model and WASM runtime (see [PRIVACY.md](./PRIVACY.md)) — there is no
API key, token, or account behind them. The included GitHub Pages deploy
workflow (`.github/workflows/deploy.yml`) also needs no repository secrets;
it uses GitHub's own built-in Pages deployment permissions.

## Supported / expected browser behavior

| Capability | Expected support |
|---|---|
| Camera + pose tracking | Recent Chrome, Edge, Safari, Firefox (desktop and mobile) with WebGL and `getUserMedia` |
| Front/back camera switching | Any device that exposes more than one camera via `facingMode` — desktop browsers typically report only one and hide the switch control |
| Recording | Browsers with `MediaRecorder` + `HTMLCanvasElement.captureStream()` — most current browsers. Older Safari/Firefox versions lack this; PHANTOM detects it and hides the record button with an explanatory note instead of failing |
| GPU-accelerated pose inference | Used when available; PHANTOM automatically falls back to a CPU delegate if the GPU delegate is rejected (some devices/drivers reject it) |
| WebGL context loss recovery | PHANTOM listens for both context loss and restoration and resumes rendering automatically if the browser restores the context while the camera screen is active |

PHANTOM does not claim to support browsers without WebGL or `getUserMedia`
support at all — it detects both up front on the landing screen and
disables **ENTER CAMERA** with an explanatory note rather than letting you
hit a dead end.

## Developer / debug mode

A diagnostics panel (live FPS, vision/tracking state, inference timing, a
mirroring diagnostic, and a wireframe skeleton overlay toggle) exists for
development and QA, but is **hidden by default** in normal use — it isn't
something an end user of the prototype needs to see.

To enable it:

```
http://localhost:5173/?debug=1
```

This also persists to `localStorage`, so it stays on across reloads
without needing to keep the query parameter. Turn it off again with
`?debug=0`, or by clearing `localStorage` for the site. See
`src/utils/debugMode.ts` for the implementation — it's a plain boolean
flag with no other effect on the app's behavior; it only changes what's
visible in the settings panel.

## Recording

Tap the round button at the bottom of the camera screen to record a short
local clip of the composed scene — your camera feed plus whatever effect(s)
are currently active, exactly as shown on screen. Recording is entirely
on-device:

- **RECORD** starts capturing; the button turns into a stop icon and a
  pulsing "REC" indicator appears.
- **STOP** ends the capture and opens a local preview with playback
  controls.
- **RETAKE** discards the preview and returns you to the live camera,
  ready to record again.
- **SAVE** triggers your browser's normal download/save flow for the clip
  (a `.webm` file on most browsers, `.mp4` on Safari).

Recording uses the browser's native `MediaRecorder` API — no server, no
upload, nothing kept after you close the tab beyond whatever you explicitly
save. If your browser doesn't support it, the record button is hidden and
a short note explains why; everything else in the app keeps working
normally. See [ARCHITECTURE.md](./ARCHITECTURE.md) for how the camera feed
and the 3D effect are composited into the recording, and
[PRIVACY.md](./PRIVACY.md) for exactly what happens (and doesn't happen) to
a recorded clip.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| "Camera access requires HTTPS" | You're on a non-localhost `http://` origin. See "Secure-context requirement" above. |
| "Camera permission was denied" | Re-enable camera permission for this site in your browser's site settings, then reload. |
| "No camera was found on this device" | No camera hardware detected, or the browser can't enumerate one. |
| "The camera is already in use by another application" | Close other apps/tabs using the camera (video calls, other camera tabs). |
| "This browser or device does not support WebGL" | Update your browser/GPU drivers, or try a different browser. PHANTOM requires WebGL for its 3D overlay. |
| "Failed to load the pose detection model" | Check your internet connection. A corporate firewall, VPN, or ad-blocker may be blocking `storage.googleapis.com` or `cdn.jsdelivr.net` — the model/runtime can't be fetched from behind such a block. |
| Camera screen is stuck on the loading spinner | If this persists beyond ~10 seconds, the camera stream likely never became ready (a real device/driver issue); PHANTOM times this out and shows an error rather than hanging forever — try again, or try a different camera/browser. |
| Switching cameras shows an error and the view goes dark | The device only has one usable camera, or the second one failed to start; PHANTOM tries to restore the camera you were already using — if that also fails, use RETRY on the error screen. |
| Skeleton overlay is misaligned with your body | Make sure the tab is fully visible/foregrounded, and try reloading — the overlay maps to the video's displayed (`object-fit: cover`) region, not its raw resolution. (This overlay is a debug-mode-only diagnostic — see "Developer / debug mode" above.) |
| Low frame rate on an older phone | Expected on weak devices — pose inference automatically throttles itself (see `src/app/App.ts`) to avoid blocking the render loop. |
| No record button / "Recording isn't supported in this browser" | Your browser lacks `MediaRecorder` or `HTMLCanvasElement.captureStream()` support (older Safari/Firefox). Everything else in the app still works. |
| "The camera is not currently active — cannot start recording" | The camera stream isn't ready yet — wait a moment after entering the camera screen and try again. |
| Recorded video looks cropped/zoomed differently than the live view | Try again after the window has finished resizing/rotating — the recording captures the camera view's size at the moment RECORD was tapped. |
| The 3D overlay freezes but the camera feed is still live | A rare WebGL context loss; PHANTOM listens for the browser restoring the context and resumes automatically. If it doesn't recover, reload the page. |

## Architecture overview

PHANTOM is organized into small, single-purpose modules under `src/`:
camera capture, on-device pose vision, tracking/smoothing, a procedural
avatar, four effects built on top of it, Three.js rendering, local
recording, and the UI shell — each with one clear owner and no circular
dependencies between layers. See [ARCHITECTURE.md](./ARCHITECTURE.md) for
the full module map, the per-frame data flow, and the key design decisions
(coordinate mapping and mirroring, the tracking state machine, adaptive
inference throttling, and the recording pipeline).

## Deploying

`npm run build` produces a fully static `dist/` folder — deploy it to any
static HTTPS host (GitHub Pages, Netlify, Vercel, S3+CloudFront, etc.) with
no server-side configuration. `.github/workflows/deploy.yml` shows a
working GitHub Pages setup as a reference. Whatever host you choose, it
must serve over HTTPS for camera access to work (see "Secure-context
requirement" above).

## Tech stack

TypeScript, Vite, Three.js, MediaPipe Tasks Vision, plain HTML/CSS. No
backend, no database, no authentication, no paid APIs — a fully static,
client-only application.

## More documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — module boundaries, data flow, and
  key design decisions.
- [TESTING.md](./TESTING.md) — what's automated, what's manual-only and
  why, and the manual verification checklist.
- [PRIVACY.md](./PRIVACY.md) — exactly what data PHANTOM processes, where,
  and what (if anything) ever leaves your device.
- [QA_REPORT.md](./QA_REPORT.md) — the production-readiness audit: what was
  checked, what was fixed, current known limitations, and recommended next
  engineering steps.
