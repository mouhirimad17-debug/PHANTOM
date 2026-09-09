import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { RawPoseFrame, VisionStatus } from '../types/vision';
import { VisionError } from '../types/vision';

// Pinned to the installed @mediapipe/tasks-vision version so the wasm runtime
// and the JS API never drift apart.
const WASM_BASE_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';

// "lite" variant: smallest/fastest model, chosen for mobile-first performance
// over the "full"/"heavy" variants. Free, unauthenticated static asset.
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';

/**
 * Wraps MediaPipe Tasks Vision's PoseLandmarker. Runs entirely in-browser
 * (WASM + optional WebGL delegate) — no frames or data ever leave the device.
 */
export class PoseVision {
  private landmarker: PoseLandmarker | null = null;
  private status: VisionStatus = 'idle';
  /**
   * The in-flight init() attempt, if any. A second concurrent call (e.g.
   * overlapping enterCamera() attempts) awaits this same attempt instead of
   * starting its own model load — two overlapping loads would otherwise
   * both eventually resolve, and whichever finished last would silently
   * replace `this.landmarker`, leaking the other's (already GPU/CPU-resident)
   * PoseLandmarker instance since nothing else ever held a reference to it
   * to call `.close()`.
   */
  private initPromise: Promise<void> | null = null;

  getStatus(): VisionStatus {
    return this.status;
  }

  isReady(): boolean {
    return this.status === 'ready';
  }

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    const promise = this.doInit();
    this.initPromise = promise;
    try {
      await promise;
    } finally {
      if (this.initPromise === promise) this.initPromise = null;
    }
  }

  private async doInit(): Promise<void> {
    this.status = 'loading';

    let fileset;
    try {
      fileset = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
    } catch (err) {
      this.status = 'error';
      throw new VisionError('model-load-failed', 'Failed to load the vision runtime (WASM).', { cause: err });
    }

    try {
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numPoses: 1,
      });
    } catch (gpuErr) {
      // Graceful degradation: some browsers/devices reject the GPU delegate
      // (no WebGL2 compute support, driver blocklist, etc). Retry on CPU
      // before giving up entirely.
      try {
        this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
          runningMode: 'VIDEO',
          numPoses: 1,
        });
      } catch (cpuErr) {
        this.status = 'error';
        throw new VisionError('model-load-failed', 'Failed to load the pose model on GPU or CPU.', {
          cause: cpuErr ?? gpuErr,
        });
      }
    }

    this.status = 'ready';
  }

  /**
   * Runs detection on the current video frame. Must be called with a
   * monotonically increasing timestamp (VIDEO running mode requirement).
   * Returns null when no body is detected in this frame.
   */
  detect(video: HTMLVideoElement, timestampMs: number): RawPoseFrame | null {
    if (!this.landmarker) {
      throw new VisionError('unknown', 'detect() called before init() completed.');
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return null;
    }

    const result = this.landmarker.detectForVideo(video, timestampMs);
    const landmarks = result.landmarks[0];
    const worldLandmarks = result.worldLandmarks[0];
    if (!landmarks || !worldLandmarks) {
      return null;
    }
    return { landmarks, worldLandmarks, timestampMs };
  }

  dispose(): void {
    this.landmarker?.close();
    this.landmarker = null;
    this.status = 'idle';
  }
}
