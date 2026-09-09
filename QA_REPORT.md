# QA Report — Production-Readiness Pass

PHANTOM is feature-complete for its first public prototype (camera capture,
on-device pose tracking, the procedural avatar, all four effects, and local
recording). This report covers the production-readiness pass performed on
top of that: repository cleanliness, dead code/dependency removal, hiding
debug tooling from normal use, resource-cleanup verification, privacy/
secrets verification, and build/test/runtime verification. It supersedes
the previous QA_REPORT.md, whose findings (a camera/vision race condition
and related hardening) are summarized under "Prior audit" below since they
remain fixed and in effect.

Every item below maps to one of the 15 tasks in the production-readiness
request. Each states what was checked, what (if anything) was changed, and
how it was verified.

## Prior audit (already fixed, summarized)

An earlier QA pass found and fixed a critical bug: `App.enterCamera()` had
no reentrancy guard, so a double-tap on ENTER CAMERA (or rapid RETRY
clicks) could race two concurrent camera-start and pose-model-load
attempts, leaking whichever one lost the race. That pass also fixed a
failed camera switch leaving the camera fully stopped with a misleading
toast, an unbounded hang if the camera stream never became ready, and
unrecoverable WebGL context loss. All four fixes remain in place and were
re-verified (still passing `tsc`/`vitest`/`build`, still no console errors
under the same scripted double-click/repeated-cycle/resize tests) as part
of this pass. Full original detail is preserved in git history; this
report focuses on what's new in the production-readiness pass.

## 1. Clean the repository

- Removed `TODO.md`, a chronological, phase-by-phase build log left over
  from initial development. Its one still-relevant section ("Not yet
  implemented") is folded into "Known Limitations" below; the rest was a
  build diary that had already been superseded by ARCHITECTURE.md's
  current-state module documentation.
- Rewrote `ARCHITECTURE.md` and `TESTING.md` from phase-narrated build logs
  ("What was verified for Ghost (this phase)", repeated per feature added
  over time) into clean, current-state reference documents describing the
  app as it exists now, not the order it was built in.
- Removed a stray, git-ignored `dist/` directory left over from a previous
  manual build (it was never tracked by git — confirmed via
  `git check-ignore -v dist` — so this is a local-workspace cleanup, not a
  repository change).
- Verified `.gitignore` already correctly excludes `node_modules`, `dist`,
  logs, and editor files; no changes needed there.

## 2. Remove dead code

One genuinely dead code path was found and removed: `App.ts` held its own
`private readonly trackingHistory = new TrackingHistory()`, pushed every
tracking frame into it (`this.trackingHistory.push(frame)` in
`runDetection()`) and cleared it on exit, but **nothing ever read from it**
— no `.getAtOffset()`/`.getLatest()` call existed anywhere against that
specific instance. Each effect that actually needs historical lookback
(`IndependentShadowEffect`, `CloneEffect`'s DELAYED mode, `GhostEffect`,
`ReverseEffect`'s DELAYED_MIRROR) already owns and manages its own private
`TrackingHistory`; the app-level one was write-only leftover
infrastructure from before those effects existed. Removed the field, its
import, and both call sites; also corrected `TrackingHistory.ts`'s own
class doc, which still described the (now-removed) app-level instance as
the way this class gets exercised.

No other dead exports, unused files, or unreachable branches were found —
checked by cross-referencing every top-level `export` in `src/` (via
`grep -rn "^export "`) against its usages elsewhere in the codebase and in
tests; everything else exported is consumed by production code, tests, or
both.

**Note on `dispose()` methods**: `SceneManager.dispose()`,
`PoseVision.dispose()`, `RecordingManager.dispose()`,
`DebugSkeleton.dispose()`, `Avatar.dispose()`, and each effect's
`dispose()` are never called by the running app today. This is
**intentional, not dead code** — see ARCHITECTURE.md's "What is never torn
down" section for why (these are page-lifetime singletons; re-entering the
camera screen must not re-download the pose model or rebuild the renderer).
Each `dispose()` is still exercised by its own unit test and remains
available for a future full-teardown scenario, which is why they were kept
rather than deleted.

## 3. Remove unused dependencies

None found. Checked two ways:

- Manually cross-referenced every `dependencies`/`devDependencies` entry
  in `package.json` (`@mediapipe/tasks-vision`, `three`, `@types/three`,
  `typescript`, `vite`, `vitest`) against actual imports in `src/` — all
  six are used.
- Ran `npx depcheck`, which independently reported no unused dependencies
  and no missing ones.

`package.json` is unchanged from this pass.

## 4. Remove debugging UI from normal production mode

Before this pass, the settings panel's "Display" section — live FPS,
vision status, tracking state, confidence, landmark count, inference time,
active-effect summary, and a raw/render/mirrored coordinate diagnostic,
plus a wireframe skeleton-overlay toggle — was visible to every user,
always. None of this is a production-facing feature; it's development/QA
tooling (the skeleton overlay was already documented elsewhere in the
codebase as a "diagnostic overlay").

This section (`#debug-settings-section` in `index.html`) is now hidden by
default and only shown when developer/debug mode is enabled (see task 5).
Effect controls (Shadow/Clone/Ghost/Reverse sections) are unaffected — they
are real user-facing features, not debug tooling, and remain always
visible. The settings panel's default-open section changed from "Display"
to "Shadow" accordingly, since "Display" is now usually hidden.

## 5. Developer/debug mode, accessible through a documented flag

Added `src/utils/debugMode.ts`: a small, dependency-free flag reader.
Enable it by loading the app with `?debug=1` in the URL — this also
persists the choice to `localStorage` so it survives reloads without
keeping the query parameter; disable again with `?debug=0`. Documented in
README.md under "Developer / debug mode" (user-facing) and
ARCHITECTURE.md's UI section (implementation). `App.ts` reads this flag
once at startup and passes it into `CameraScreen`'s constructor, which
hides/shows `#debug-settings-section` accordingly — this is the flag's
only effect; it changes no other app behavior.

**Verified live** (scripted Chromium, see QA verification section below):
debug mode off by default, section hidden; `?debug=1` shows it; the choice
persists across a reload with no query parameter (via `localStorage`);
`?debug=0` turns it back off.

## 6. Ensure production build works

`npm run build` (`tsc && vite build`) succeeds from a clean install (see
verification section) with zero TypeScript errors and a valid static
bundle in `dist/`. The build's only output warning — the main JS chunk
exceeding 500kB (MediaPipe + Three.js are both sizeable) — is pre-existing,
unrelated to this pass's changes, and already tracked as a known next step
(see "Known Limitations").

## 7. Ensure the application starts cleanly

Verified both entry points:

- `npm run dev` serves the app at `http://localhost:5173` with no build
  errors and no console errors on load.
- `npm run preview` (serving the actual production `dist/` bundle, at its
  configured `/PHANTOM/` base path) also serves successfully with no
  errors.

A scripted browser load of both the landing screen and a full ENTER CAMERA
attempt produced zero uncaught exceptions and zero unhandled promise
rejections (`page.on('pageerror')`) in either mode.

## 8. Ensure all camera streams are properly stopped when leaving the camera experience

Re-verified (no code change needed here beyond what the prior audit already
fixed): `App.exitCamera()` unconditionally calls `this.camera.stop()`,
which is `CameraController.stop()` — it iterates every track on the
current `MediaStream` and calls `.stop()` on each before clearing
`this.stream` and the `<video>` element's `srcObject`. This runs on every
path out of the camera experience: the BACK button, and (since
`exitCamera()` is also reachable after a fatal error's BACK button) the
error-recovery path too. The previously-fixed reentrancy guards on
`enterCamera()`/`CameraController.start()` mean there is no longer a way to
end up with a second, untracked stream that this cleanup wouldn't reach.

**Verified**: code trace of every call path into `exitCamera()`, plus the
scripted repeated-enter-exit test (3 cycles) showing no accumulating
console errors or state corruption.

## 9. Ensure model resources are cleaned up when appropriate

The pose model (`PoseVision`'s `PoseLandmarker`) is a page-lifetime
resource by design (see ARCHITECTURE.md's "What is never torn down") — it
is loaded once and reused across every camera enter/exit cycle within the
same page load, since reloading it (a real network fetch + WASM/GPU
initialization) on every re-entry would make repeated use of the app
noticeably slower for no benefit. "Cleaned up when appropriate" for this
resource means: cleaned up when the page itself is torn down (closing the
tab releases all WASM/GPU memory the browser process held for it — no
explicit action needed, this is standard browser behavior), and available
to be released early via `PoseVision.dispose()` (calls `.close()` on the
underlying `PoseLandmarker`) should a future full-app-teardown flow need
it. This is unchanged from before this pass; verified by re-reading
`PoseVision.ts` and confirming `dispose()` correctly nulls the landmarker
reference after closing it (no partial state left behind).

## 10. Ensure recording object URLs are released

Verified `RecordingManager`'s object URL lifecycle end to end:
`discardRecording()` calls `URL.revokeObjectURL(this.previewUrl)` before
clearing the reference, and is called from all four places a recording's
preview can become obsolete: `start()` (discarding any previous take before
recording a new one), `retake()`, `reset()` (e.g. leaving the camera screen
mid-preview), and `dispose()`. There is no path that creates a new preview
URL (`URL.createObjectURL`, called once in `onstop`) without a prior
`discardRecording()` call having already revoked the previous one, so
repeated record/retake cycles cannot accumulate un-revoked blob URLs.
Unsaved recordings that are simply abandoned by closing the tab are
released automatically by the browser (blob URLs are scoped to the
document that created them) — not a leak.

## 11. Ensure no secret/API key is required

Confirmed by inspection — no code, config, or CI file in this repository
references an API key, token, or secret of any kind:

- `grep -rniE "API_KEY|apiKey|SECRET|token|import\.meta\.env|process\.env"`
  across `src/` returned no matches.
- `.github/workflows/deploy.yml` (the GitHub Pages deploy workflow) uses
  only GitHub's built-in `id-token`/`pages` permissions — no repository
  secrets configured or needed.
- The only network calls the app itself makes are unauthenticated, public
  static-asset downloads (MediaPipe's WASM runtime and model file) — see
  PRIVACY.md.

## 12. Verify privacy messaging

Created `PRIVACY.md` — a standalone, thorough explanation of what data
PHANTOM processes, where (100% on-device), what (if anything) is fetched
from the network (only the one-time, unauthenticated MediaPipe model/WASM
download), and exactly what happens to a recording (never uploaded; leaves
the device only if you explicitly tap SAVE, via the browser's own download
mechanism). Cross-checked this document's claims against the actual
in-app copy (the landing screen's "Processing happens locally on this
device" note and "How it works" panel, and the settings panel's matching
footer note) — consistent, no contradictions, no claim in either place
that the code doesn't actually do.

## 13. Verify mobile viewport behavior

Confirmed already correct from a prior UI pass, re-verified in this one:

- `index.html`'s viewport meta uses `viewport-fit=cover` (for safe-area
  support) with `user-scalable=no` intentional for this fixed-chrome camera
  UI.
- `styles.css` sizes the app to `100dvh` (dynamic viewport height), not the
  classic mobile-Safari-buggy `100vh` that leaves a stale gap when browser
  chrome shows/hides.
- `env(safe-area-inset-*)` is applied on every edge, including left/right
  (for landscape with a notch), across the top HUD, bottom bar, and
  overlays.
- Every interactive control maintains a 44px-minimum touch target
  (grep-verified: `min-height: 44px` present on every button class).

**Verified live**: scripted resize between 390×844 and 844×390 (simulating
a portrait/landscape rotation) produced no console errors and no visible
layout assertion failures in either orientation.

## 14. Verify graceful errors

Re-confirmed the existing typed-error model covers every failure this app
can encounter (camera permission/hardware, vision/model load, recording),
each translated to a specific, actionable, non-technical message — never a
raw stack trace or a native `alert()`. Specifically exercised in this pass:

- MediaPipe's CDN being unreachable (true in this sandboxed environment)
  correctly surfaces as "Failed to load the pose detection model..." with
  working RETRY/BACK, not a blank screen or an unhandled rejection —
  confirmed live, repeatedly, across every scripted scenario in this pass.
- A double-click on ENTER CAMERA while an attempt is already failing
  produces exactly one error, not a duplicate or conflicting one (the
  reentrancy guard from the prior audit still holds).
- Zero uncaught exceptions or unhandled promise rejections
  (`page.on('pageerror')`) were observed across landing-screen load,
  double-click entry, three repeated enter/exit cycles, two resize events,
  and all four debug-mode scenarios in this pass's scripted verification.

## 15. Improve the loading experience

The loading overlay ("Initializing camera & pose model…") was static text
on a translucent backdrop with no motion and no indication of how long to
expect. Added:

- A small indeterminate CSS spinner (respects `prefers-reduced-motion` by
  slowing rather than removing its animation) — honestly indeterminate,
  since neither `getUserMedia()` nor the MediaPipe model load exposes a
  real progress fraction to build a real progress bar from.
- Clearer two-line copy: "Starting camera & loading the pose model…" plus
  a secondary hint, "First load can take a few seconds while the model
  downloads," so a multi-second wait on a slower connection reads as
  expected rather than possibly-broken.

**Verified live**: the spinner element is present and rendered in the
loading overlay during a real ENTER CAMERA attempt.

## Verification results

Run from a clean install (`rm -rf node_modules dist && npm ci`), matching
what CI/a new contributor would actually do:

```
$ npm ci
added 49 packages, and audited 50 packages in 5s
found 0 vulnerabilities

$ npx tsc --noEmit
(no output — zero errors)

$ npm test
 Test Files  12 passed (12)
      Tests  122 passed (122)

$ npm run build
✓ 42 modules transformed.
dist/index.html                  15.19 kB │ gzip:   3.40 kB
dist/assets/index-*.css          11.84 kB │ gzip:   3.02 kB
dist/assets/index-*.js          742.67 kB │ gzip: 193.71 kB
✓ built in 996ms
```

Live verification (headless Chromium, `--use-fake-device-for-media-stream`,
mobile 390×844 viewport, both `npm run dev` and `npm run preview` against
the real production build):

| Check | Result |
|---|---|
| Landing screen loads, no console errors | Pass |
| `npm run preview` production bundle serves and loads at its configured base path | Pass |
| Debug mode hidden by default | Pass |
| `?debug=1` reveals debug settings section | Pass |
| Debug choice persists across reload via `localStorage` | Pass |
| `?debug=0` turns it back off | Pass |
| Loading overlay shows the new spinner | Pass |
| Double-click ENTER CAMERA: no duplicate attempts, no errors | Pass |
| 3x repeated enter/exit cycles: no accumulating errors | Pass |
| 2x simulated orientation resize: no errors | Pass |
| Uncaught exceptions / unhandled rejections across all of the above | Zero |

The only console output observed anywhere in this sandbox's live testing
is the expected, already-handled `net::ERR_TUNNEL_CONNECTION_FAILED` when
fetching MediaPipe's model from `storage.googleapis.com`/
`cdn.jsdelivr.net` (this sandbox has no route to those hosts) and the
resulting, correctly-caught `[PHANTOM] Fatal error entering camera
experience: VisionError` log — this is the app behaving correctly under a
real network failure, not a defect. A real camera and reachable MediaPipe
CDN are required to verify actual tracking/effect/recording *quality*
(vs. crash-freedom) — see TESTING.md's manual checklist for what a
developer with real hardware should still run before shipping a
camera/tracking/effect change.

## Known limitations

Carried forward from the project's own tracked "not yet implemented" list
(previously `TODO.md`, folded in here since that file was removed as part
of repository cleanup):

- **No standalone "Delay" effect yet.** The effect rail shows a genuinely
  `disabled` DELAY chip (labeled honestly, not hidden or faked) reserved
  for it. The underlying pattern (`TrackingHistory` + a delayed-target
  read) already exists and is exercised by `IndependentShadowEffect`,
  `CloneEffect`'s DELAYED mode, and `ReverseEffect`'s DELAYED_MIRROR — a
  dedicated Delay effect would reuse that pattern without the spring/
  drift/flatten Shadow adds on top.
- **No UI trigger for `Avatar.setDisplayMode('skeleton')`.** The capability
  exists and is unit-tested, but nothing in the current UI calls it (not
  to be confused with the debug-mode-only `DebugSkeleton` overlay toggle,
  which is a separate, already-wired diagnostic).
- **No global "reset everything" button** beyond `CloneEffect`'s own RESET
  ALL — would only be worth adding once more per-effect state exists that
  users are likely to want to reset all at once.
- **MediaPipe Tasks Vision (and Three.js) load eagerly at page load**, not
  lazily on first ENTER CAMERA click. This is the main lever left for
  reducing landing-page bundle weight, especially on slow mobile
  connections — reflected in the build's own chunk-size warning (main JS
  bundle ~743kB / ~194kB gzipped). Not addressed in this pass since it
  would be a structural loading-order change rather than a bug fix or
  cleanup, and this pass's brief was explicitly not to redesign the core
  product.
- **No dedicated lint tool** (ESLint or similar) is configured — `tsc`'s
  strict-mode compiler flags are this project's only static check. This
  has been sufficient so far (strict mode plus `noUnusedLocals`/
  `noUnusedParameters` catches most of what a basic lint config would),
  but doesn't cover style/consistency rules a linter would.
- **Only a single browser/device matrix could be exercised directly** in
  this environment (headless Chromium via Playwright, no real camera, no
  reachable MediaPipe CDN). Cross-browser behavior (Safari's `.mp4`
  recording path in particular, and real GPU context-loss recovery) is
  verified by code trace, not live execution — see TESTING.md.

## Recommended next engineering steps

In rough priority order for taking this from "audited prototype" toward a
wider release:

1. **Lazy-load MediaPipe Tasks Vision (and consider Three.js) on first
   ENTER CAMERA click** rather than at page load, to shrink the landing
   page's initial bundle — the single highest-leverage remaining
   performance item, and the main open item from the build's own
   chunk-size warning.
2. **Real-device QA pass**, specifically: Safari on iOS (recording codec
   path, WebGL behavior, `dvh`/safe-area support on an actual notch), a
   mid/low-end Android device (adaptive inference throttling under real
   thermal/CPU constraints), and a real front/back camera switch on a
   phone with two cameras (the switch-failure fallback logic has only been
   code-traced, never exercised against a real second camera failing).
   Contributes findings back into TESTING.md's manual checklist.
3. **Decide the Delay effect's fate**: implement it (the pattern already
   exists elsewhere in the codebase) or remove its reserved, disabled chip
   from the effect rail — leaving a permanently-disabled chip is fine for
   a prototype but should be resolved before a wider release.
4. **Add a lint config** (ESLint with a TypeScript-aware ruleset) once the
   team/contributor base grows past what strict `tsc` alone comfortably
   enforces — not urgent today, but cheap to add early before style drift
   accumulates.
5. **Consider basic crash/error telemetry** (opt-in, and consistent with
   PRIVACY.md's no-tracking stance) if this moves beyond a prototype — right
   now, a failure in the wild is only visible to the user who hit it,
   with no way for maintainers to learn about it unless reported manually.
