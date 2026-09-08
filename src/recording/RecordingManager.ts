import type { SceneManager } from '../rendering/SceneManager';
import { RecordingError, type RecordingState } from '../types/recording';
import { computeCoverCrop } from '../utils/math';

/** A reasonable default output frame rate — smooth for a short clip without over-encoding. */
const DEFAULT_RECORDING_FPS = 30;

/**
 * Preference order for `MediaRecorder`'s output codec — the first the
 * browser supports (via `MediaRecorder.isTypeSupported`) wins. VP9/VP8 in a
 * WebM container cover Chrome/Firefox/Edge; the plain `video/mp4` entry is
 * for Safari, which supports MediaRecorder but not WebM.
 */
const MIME_TYPE_CANDIDATES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];

export interface RecordingManagerCallbacks {
  onStateChange?: (state: RecordingState) => void;
  /**
   * Fires for failures that happen asynchronously, after `start()` has
   * already returned successfully (WebGL context loss, a MediaRecorder
   * runtime error). Synchronous pre-flight failures (unsupported browser,
   * camera not active, zero-size canvas) are thrown directly from
   * `start()` instead, matching how CameraController/PoseVision report
   * their own startup failures.
   */
  onError?: (error: RecordingError) => void;
}

/**
 * Records the composed camera + Three.js output entirely on-device.
 *
 * The visible result is never a single element: the live `<video>` is
 * mirrored/cropped via CSS, and `#scene-canvas` is a separate, transparent
 * WebGL canvas layered on top by the page (see ARCHITECTURE.md's
 * mirroring note). Neither `videoElement.captureStream()` alone nor
 * `sceneCanvas.captureStream()` alone would capture what the user actually
 * sees — the first misses the 3D effect, the second is transparent and
 * misses the camera image entirely. Browsers also have no API to merge two
 * independent capture streams into one recorded frame. So this always
 * composites: a private, off-DOM 2D `<canvas>` is redrawn every rendered
 * frame — the camera frame first (cropped/mirrored to match what's
 * displayed, reusing the same `computeCoverCrop()` math the tracking
 * pipeline already uses), then the transparent scene canvas on top — and
 * *that* composite canvas is what's fed into a native `MediaRecorder` via
 * `HTMLCanvasElement.captureStream()`. This is the "browser-native
 * recording pipeline" this module prefers: real encoding via
 * `MediaRecorder`, not a JS/WASM software encoder.
 *
 * Nothing here is ever uploaded anywhere — the only outputs are an
 * in-memory `Blob` and a local object URL for preview/download, both
 * revoked once no longer needed. No audio track is ever requested or
 * attached, so recording never triggers a microphone permission prompt;
 * recording itself needs no browser permission at all (unlike
 * `getUserMedia`) — the only real dependency is that the camera stream
 * must already be active, which `start()` checks for explicitly.
 */
export class RecordingManager {
  private readonly sceneManager: SceneManager;
  private readonly videoElement: HTMLVideoElement;
  private readonly callbacks: RecordingManagerCallbacks;
  private readonly compositeCanvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly mimeType: string | null;
  private readonly contextLostHandler: () => void;

  private state: RecordingState = 'idle';
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private blob: Blob | null = null;
  private previewUrl: string | null = null;
  private cameraMirrored = false;
  private removeAfterRenderListener: (() => void) | null = null;
  /** Set by reset() when called mid-recording, so the async onstop handler (fired later by mediaRecorder.stop()) discards its result instead of resurrecting a 'stopped' state after reset() already moved to 'idle'. */
  private discardOnStop = false;

  constructor(sceneManager: SceneManager, videoElement: HTMLVideoElement, callbacks: RecordingManagerCallbacks = {}) {
    this.sceneManager = sceneManager;
    this.videoElement = videoElement;
    this.callbacks = callbacks;

    const ctx = this.compositeCanvas.getContext('2d');
    if (!ctx) {
      throw new Error('2D canvas context unavailable — required to compose the recording.');
    }
    this.ctx = ctx;

    this.mimeType = RecordingManager.pickSupportedMimeType();

    this.contextLostHandler = (): void => {
      if (this.state !== 'recording') return;
      this.stop();
      this.callbacks.onError?.(
        new RecordingError('context-lost', 'Recording stopped: the 3D renderer lost its WebGL context.'),
      );
    };
    this.sceneManager.renderer.domElement.addEventListener('webglcontextlost', this.contextLostHandler);
  }

  private static pickSupportedMimeType(): string | null {
    if (typeof MediaRecorder === 'undefined') return null;
    for (const candidate of MIME_TYPE_CANDIDATES) {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    }
    return null;
  }

  /** Whether this browser can record at all. Checked once at construction; drives whether the UI offers RECORD. */
  isSupported(): boolean {
    return typeof HTMLCanvasElement.prototype.captureStream === 'function' && this.mimeType !== null;
  }

  getState(): RecordingState {
    return this.state;
  }

  /** The local blob object URL for the finished recording, or null if there isn't one (state !== 'stopped'). */
  getPreviewUrl(): string | null {
    return this.previewUrl;
  }

  getBlob(): Blob | null {
    return this.blob;
  }

  /**
   * Starts recording the current composed scene. `cameraMirrored` must
   * match what's currently displayed (see CameraScreen.setMirrored/
   * App.enterCamera) so the recording matches what the user sees, not a
   * flipped version of it. Throws a `RecordingError` synchronously for any
   * pre-flight failure; a no-op if already recording.
   */
  start(cameraMirrored: boolean): void {
    if (this.state === 'recording') return;

    if (!this.isSupported() || !this.mimeType) {
      throw new RecordingError('unsupported', 'Recording is not supported in this browser.');
    }
    if (this.videoElement.readyState < this.videoElement.HAVE_CURRENT_DATA || this.videoElement.videoWidth === 0) {
      throw new RecordingError('camera-unavailable', 'The camera is not currently active — cannot start recording.');
    }

    const sceneCanvas = this.sceneManager.renderer.domElement;
    if (sceneCanvas.width === 0 || sceneCanvas.height === 0) {
      throw new RecordingError('zero-size-canvas', 'The camera view has no visible size yet — try again in a moment.');
    }

    this.discardRecording(); // clear any previous take before starting a new one

    this.cameraMirrored = cameraMirrored;
    this.compositeCanvas.width = sceneCanvas.width;
    this.compositeCanvas.height = sceneCanvas.height;

    const stream = this.compositeCanvas.captureStream(DEFAULT_RECORDING_FPS);
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: this.mimeType });
    } catch (err) {
      throw new RecordingError('start-failed', 'Could not start recording.', { cause: err });
    }

    this.chunks = [];
    recorder.ondataavailable = (event): void => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    recorder.onerror = (event): void => {
      const errorEvent = event as unknown as { error?: unknown };
      this.callbacks.onError?.(
        new RecordingError('start-failed', 'Recording stopped unexpectedly.', { cause: errorEvent.error }),
      );
      this.stop();
    };
    recorder.onstop = (): void => {
      const finishedBlob = new Blob(this.chunks, { type: this.mimeType ?? 'video/webm' });
      this.chunks = [];
      for (const track of stream.getTracks()) track.stop();

      if (this.discardOnStop) {
        // reset() already moved us to 'idle' synchronously — this result
        // was requested to be thrown away, not published.
        this.discardOnStop = false;
        return;
      }

      this.blob = finishedBlob;
      this.previewUrl = URL.createObjectURL(finishedBlob);
      this.setState('stopped');
    };

    this.mediaRecorder = recorder;
    recorder.start();

    this.removeAfterRenderListener = this.sceneManager.onAfterRender(() => this.drawCompositeFrame());
    this.drawCompositeFrame(); // seed a first frame immediately rather than waiting for the next render tick

    this.setState('recording');
  }

  private drawCompositeFrame(): void {
    const canvas = this.compositeCanvas;
    const sceneCanvas = this.sceneManager.renderer.domElement;
    const video = this.videoElement;

    if (video.videoWidth > 0 && video.videoHeight > 0) {
      const sourceAspect = video.videoWidth / video.videoHeight;
      const containerAspect = canvas.width / canvas.height;
      const crop = computeCoverCrop(sourceAspect, containerAspect);
      const sx = crop.xMin * video.videoWidth;
      const sy = crop.yMin * video.videoHeight;
      const sWidth = (crop.xMax - crop.xMin) * video.videoWidth;
      const sHeight = (crop.yMax - crop.yMin) * video.videoHeight;

      this.ctx.save();
      if (this.cameraMirrored) {
        // Matches the CSS `transform: scaleX(-1)` applied to #camera-video
        // — drawImage() always draws the raw, unmirrored video frame
        // regardless of any CSS transform on the element, so the mirror
        // has to be reproduced here explicitly for the recording to match
        // what's on screen.
        this.ctx.translate(canvas.width, 0);
        this.ctx.scale(-1, 1);
      }
      this.ctx.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, canvas.width, canvas.height);
      this.ctx.restore();
    } else {
      this.ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    // The scene canvas is transparent where nothing was rendered, so this
    // composites over the video frame just drawn above via normal alpha
    // blending — no extra work needed. Never CSS-mirrored (see styles.css),
    // so no mirroring is applied here either.
    this.ctx.drawImage(sceneCanvas, 0, 0, canvas.width, canvas.height);
  }

  /** Stops recording (if active) and finalizes the blob asynchronously. Safe to call when not recording, or more than once. */
  stop(): void {
    if (this.state !== 'recording' || !this.mediaRecorder) return;

    this.removeAfterRenderListener?.();
    this.removeAfterRenderListener = null;

    if (this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
  }

  /** Discards the current finished recording (if any) and returns to 'idle'. No-op unless a recording is available to discard. */
  retake(): void {
    if (this.state !== 'stopped') return;
    this.discardRecording();
    this.setState('idle');
  }

  private discardRecording(): void {
    if (this.previewUrl) {
      URL.revokeObjectURL(this.previewUrl);
      this.previewUrl = null;
    }
    this.blob = null;
  }

  /** Triggers a local browser download/save of the current recording. No-op if there's nothing to save. */
  download(filename?: string): void {
    if (!this.blob || !this.previewUrl) return;
    const anchor = document.createElement('a');
    anchor.href = this.previewUrl;
    anchor.download = filename ?? `phantom-recording-${Date.now()}.${this.fileExtension()}`;
    anchor.click();
  }

  private fileExtension(): string {
    return this.mimeType?.startsWith('video/mp4') ? 'mp4' : 'webm';
  }

  private setState(state: RecordingState): void {
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }

  /** Returns to a clean, just-constructed state: stops any active recording and discards it (no preview retained). */
  reset(): void {
    if (this.state === 'recording') {
      this.discardOnStop = true;
    }
    this.stop();
    this.discardRecording();
    this.setState('idle');
  }

  /** Releases all resources: stops any active recording, revokes the object URL, removes listeners. */
  dispose(): void {
    if (this.state === 'recording') {
      this.discardOnStop = true;
    }
    this.stop();
    this.discardRecording();
    this.sceneManager.renderer.domElement.removeEventListener('webglcontextlost', this.contextLostHandler);
  }
}
