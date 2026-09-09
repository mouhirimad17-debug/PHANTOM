# Privacy

PHANTOM is designed so that your camera feed and body-pose data never leave
your device. This document explains exactly what the app processes, where
that processing happens, and what — if anything — ever crosses the network.
It describes PHANTOM's actual, current behavior; it is not a legal privacy
policy or a compliance certification.

## Summary

- Your camera video is processed **entirely on your device**. No video
  frame, pose landmark, or derived measurement is ever sent to a server —
  PHANTOM has no server to send it to.
- The only network requests PHANTOM's own code makes are one-time,
  unauthenticated downloads of MediaPipe's public pose-detection model and
  WASM runtime (see "What is fetched from the network" below) — a static
  asset download, not a data upload, and not an API call that sends any of
  your data anywhere.
- PHANTOM never requests microphone access, for any reason.
- Recording is entirely local. A recorded clip is never uploaded; it only
  leaves your device if and when you explicitly tap SAVE, using your
  browser's own normal file-download mechanism.
- PHANTOM has no accounts, no login, no analytics, no telemetry, no
  cookies, and no third-party tracking scripts of any kind.

## What PHANTOM processes, and where

| Data | Where it's processed | Ever leaves the device? |
|---|---|---|
| Live camera video frames | In-browser, via MediaPipe Tasks Vision (WASM, with an optional WebGL/GPU delegate) | No |
| Detected body-pose landmarks (the tracked skeleton) | In-browser, in the same page | No |
| The rendered 3D avatar/effects | In-browser, via Three.js/WebGL | No |
| A recorded clip (camera + effects, composited) | Held in-browser as an in-memory `Blob` until discarded or saved | Only if you tap SAVE — see "Recording" below |

There is no server component anywhere in PHANTOM. The entire application —
camera capture, pose detection, 3D rendering, and recording — runs as
client-side JavaScript/WASM in your browser tab. Closing the tab discards
everything except a clip you've already saved to your device.

## What is fetched from the network

On first use, PHANTOM downloads two static assets it needs to run pose
detection:

- MediaPipe's WASM vision runtime, from `cdn.jsdelivr.net`
- The pose-detection model file, from `storage.googleapis.com`

Both are public, unauthenticated static files — the same kind of request as
loading a font or an image from a CDN. No API key is required, no account
is involved, and nothing about your session, your device, or your camera is
sent as part of these requests beyond what any static HTTP request
includes (e.g. your IP address, handled entirely by the CDN operators, not
by PHANTOM). These are one-time downloads per browser cache lifetime, not
recurring calls — after the first load, pose detection runs from what's
already been downloaded.

A network connection is required once to fetch these assets; after that,
all actual pose processing happens locally regardless of network state.

## Camera permission

PHANTOM requests camera access only when you tap **ENTER CAMERA**, and only
ever requests **video** — never audio/microphone, for any feature,
including recording. The permission prompt itself is your browser's own
native UI, governed entirely by your browser's permission model; PHANTOM
cannot see, store, or influence your permission decision beyond reacting to
it (showing a clear in-app message if you deny it). You can revoke camera
access at any time through your browser's site settings, which immediately
stops PHANTOM from being able to access it.

## Recording

Recording captures a composite of your camera feed and the active 3D
effect(s) — exactly what's already visible on screen — using the browser's
native `MediaRecorder` API. Specifically:

- A recording exists only as an in-memory `Blob` in your browser tab.
  Nothing is written to disk and nothing is uploaded automatically.
- **RETAKE** discards it immediately; closing the tab discards it too.
- **SAVE** is the only action that moves a recording out of the browser
  tab — it triggers your browser's own normal download flow (the same as
  saving any file from any website), writing the clip to wherever your
  browser saves downloads. PHANTOM has no involvement in that transfer
  beyond initiating the standard browser download.
- No audio track is ever recorded (PHANTOM never requests microphone
  access), so a saved clip is video-only.

## Third parties

PHANTOM's own code does not integrate any analytics, advertising, error-
reporting, or tracking service. The only third-party involvement is the
static-asset hosts named above (MediaPipe's CDN, operated by Google), used
solely to download the pose model and WASM runtime described above. If you
deploy PHANTOM yourself (see [README.md](./README.md#deploying)), your
hosting provider will of course have its own standard web-server access
logs for serving the static site itself — that is a property of whatever
host you choose, not of PHANTOM's own code.

## Children's use

PHANTOM does not collect, store, or transmit any personal data, and has no
accounts or sign-up flow of any kind. That said, it has not been reviewed
against any specific children's-privacy regulation (e.g. COPPA), and this
document makes no compliance claim in that regard.

## Questions or concerns

PHANTOM is an open, fully client-side prototype — you can verify every
claim in this document by reading the source in `src/` (in particular
`src/camera/`, `src/vision/`, and `src/recording/`) or by inspecting your
browser's network tab while using the app: you will see the one-time model/
WASM download and nothing else.
