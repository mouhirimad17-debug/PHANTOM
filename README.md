# PHANTOM

**Make the impossible appear on camera.**

A browser-based AR/3D camera experience. PHANTOM opens your camera, detects
your body's pose entirely on-device, and renders a virtual representation of
it into the live camera view in real time.

> **Status:** camera capture, on-device pose detection, the procedural
> avatar, and four effects — Independent Shadow, Clone, Ghost, and Reverse —
> are implemented and working, along with local video recording. A Delay
> effect and a couple of UI conveniences are **not yet implemented** — see
> [TODO.md](./TODO.md).

## Prerequisites

- Node.js 18.19+ (Node 20/22 recommended)
- A modern browser with camera + WebGL support (Chrome, Edge, Safari, Firefox — recent versions)
- A device with a camera, and permission to use it

## Installation

```bash
npm install
```

## Development

```bash
npm run dev
```

Opens on `http://localhost:5173`. Click **ENTER CAMERA**, grant camera
permission, and you should see your live camera feed with a procedural 3D
avatar tracking your body. Try the effect toggles in the top-right corner
(CLONE, INDEPENDENT, GHOST, REVERSE) and tap the round button at the bottom
of the screen to record a short local clip — see **Recording** below. Click
**DEBUG** (top right) to see FPS, model status, tracking status, and
confidence.

## Production build

```bash
npm run build   # type-checks then builds to dist/
npm run preview # serve the production build locally
```

## Camera access requires a secure context (HTTPS)

Browsers only allow camera access (`getUserMedia`) on:

- `http://localhost` (or `http://127.0.0.1`) — works out of the box with `npm run dev`
- Any origin served over `https://`

**Testing on a phone over your local network** will *not* work over plain
`http://<your-lan-ip>:5173` — the browser will refuse camera access because
it's not a secure context. To test on a real mobile device, do one of:

- Tunnel the dev server through an HTTPS tunnel (e.g. `ngrok http 5173`, Cloudflare Tunnel) and open the HTTPS URL on your phone.
- Serve the dev server with a local TLS certificate (e.g. via `mkcert` + a Vite HTTPS server config).
- Deploy the production build to any static HTTPS host (Vercel, Netlify, GitHub Pages, etc.) — PHANTOM is a fully static app with no backend.

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
and the 3D effect are composited into the recording.

## Privacy

- All camera frames and pose detection are processed **locally in the
  browser** (WASM/WebGL via MediaPipe Tasks Vision). No video frame or pose
  data is ever sent to a server.
- The pose model file and MediaPipe's WASM runtime are fetched once from
  MediaPipe's public CDN ([storage.googleapis.com](https://storage.googleapis.com), [cdn.jsdelivr.net](https://cdn.jsdelivr.net)) — this is a static
  asset download, not a processing API call, and requires no API key.
- The app never requests microphone access — not for pose tracking, and
  not for recording (recording captures video only, from what's already
  drawn on screen).
- Recordings are never uploaded anywhere. A recorded clip exists only as
  an in-memory blob in your browser tab until you tap SAVE, at which point
  it's written to your device via the browser's normal download mechanism
  — the same as any other file download. Closing the tab or hitting RETAKE
  discards it completely.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| "Camera access requires HTTPS" | You're on a non-localhost `http://` origin. See the HTTPS note above. |
| "Camera permission was denied" | Re-enable camera permission for this site in your browser's site settings, then reload. |
| "No camera was found on this device" | No camera hardware detected, or the browser can't enumerate one. |
| "The camera is already in use by another application" | Close other apps/tabs using the camera (video calls, other camera tabs). |
| "This browser or device does not support WebGL" | Update your browser/GPU drivers, or try a different browser. PHANTOM requires WebGL for its 3D overlay. |
| "Failed to load the pose detection model" | Check your internet connection. A corporate firewall, VPN, or ad-blocker may be blocking `storage.googleapis.com` or `cdn.jsdelivr.net` — the model/runtime can't be fetched from behind such a block. |
| Skeleton overlay is misaligned with your body | Make sure the tab is fully visible/foregrounded, and try reloading — the overlay maps to the video's displayed (`object-fit: cover`) region, not its raw resolution. |
| Low frame rate on an older phone | Expected on weak devices — pose inference automatically throttles itself (see `src/app/App.ts`) to avoid blocking the render loop. |
| No record button / "Recording isn't supported in this browser" | Your browser lacks `MediaRecorder` or `HTMLCanvasElement.captureStream()` support (older Safari/Firefox). Everything else in the app still works. |
| "The camera is not currently active — cannot start recording" | The camera stream isn't ready yet — wait a moment after entering the camera screen and try again. |
| Recorded video looks cropped/zoomed differently than the live view | Try again after the window has finished resizing/rotating — the recording captures the camera view's size at the moment RECORD was tapped. |

## Tech stack

TypeScript, Vite, Three.js, MediaPipe Tasks Vision, plain HTML/CSS. No
backend, no database, no authentication, no paid APIs — a fully static,
client-only application.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for module boundaries and
[TESTING.md](./TESTING.md) for how to manually verify the app.
