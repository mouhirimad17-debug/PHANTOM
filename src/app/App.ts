import { CameraController } from '../camera/CameraController';
import { CameraError, type CameraFacing } from '../types/camera';
import { PoseVision } from '../vision/PoseVision';
import { VisionError, type RawPoseFrame } from '../types/vision';
import { VISIBILITY_THRESHOLD } from '../types/tracking';
import { TrackingManager } from '../tracking/TrackingManager';
import { TrackingHistory } from '../tracking/TrackingHistory';
import { SceneManager } from '../rendering/SceneManager';
import { DebugSkeleton } from '../rendering/DebugSkeleton';
import { LandingScreen } from '../ui/LandingScreen';
import { CameraScreen } from '../ui/CameraScreen';
import { FpsCounter } from '../utils/FpsCounter';
import { clamp } from '../utils/math';
import { isWebGLAvailable } from '../utils/webgl';

// No visual effect exists yet (see TODO.md) — this is a placeholder label
// for the debug overlay's "current effect" row, to be replaced once the
// Effect interface and its implementations land.
const CURRENT_EFFECT_LABEL = 'None (debug skeleton only)';

// Pose inference is throttled independently of the render loop (which stays
// at display refresh rate) so a slow model never blocks rendering/UI input.
const MIN_DETECT_INTERVAL_MS = 1000 / 30;
const MAX_DETECT_INTERVAL_MS = 250;
const DETECT_DURATION_SMOOTHING = 0.2;
const DETECT_INTERVAL_SAFETY_FACTOR = 1.8;

/**
 * Top-level orchestrator: wires camera -> vision -> tracking -> rendering,
 * drives screen transitions, and translates module-level errors into
 * user-facing messages. Contains no rendering or detection logic itself.
 */
export class App {
  private readonly landingScreen: LandingScreen;
  private readonly cameraScreen: CameraScreen;
  private readonly camera: CameraController;
  private readonly poseVision = new PoseVision();
  private readonly fpsCounter = new FpsCounter();
  private readonly webglAvailable = isWebGLAvailable();
  private readonly trackingHistory = new TrackingHistory();

  private sceneManager: SceneManager | null = null;
  private trackingManager: TrackingManager | null = null;
  private debugSkeleton: DebugSkeleton | null = null;

  private facing: CameraFacing = 'user';
  private lastDetectMs = -Infinity;
  private detectIntervalMs = MIN_DETECT_INTERVAL_MS;
  private avgDetectDurationMs = 0;
  private lastInferenceDurationMs: number | null = null;
  private visionDetectionFailed = false;

  constructor() {
    this.cameraScreen = new CameraScreen({
      onBack: () => this.exitCamera(),
      onRetry: () => void this.enterCamera(),
      onDebugToggle: (visible) => this.debugSkeleton?.setVisible(visible),
    });
    this.landingScreen = new LandingScreen({
      onEnterCamera: () => void this.enterCamera(),
    });

    this.camera = new CameraController(this.cameraScreen.videoElement);

    if (this.webglAvailable) {
      const sceneManager = new SceneManager(this.cameraScreen.canvasElement);
      sceneManager.attach(this.cameraScreen.getContainer());
      const trackingManager = new TrackingManager(sceneManager.camera);
      const debugSkeleton = new DebugSkeleton(sceneManager.scene);

      sceneManager.onFrame((delta) => this.handleFrame(delta, trackingManager, debugSkeleton));

      this.sceneManager = sceneManager;
      this.trackingManager = trackingManager;
      this.debugSkeleton = debugSkeleton;
    }

    window.addEventListener('resize', () => this.trackingManager?.notifyViewportChanged());
  }

  start(): void {
    this.landingScreen.show();
  }

  private async enterCamera(): Promise<void> {
    const sceneManager = this.sceneManager;
    const trackingManager = this.trackingManager;

    this.landingScreen.hide();
    this.cameraScreen.show();
    this.cameraScreen.hideError();

    if (!this.webglAvailable || !sceneManager || !trackingManager) {
      this.cameraScreen.showError(
        'This browser or device does not support WebGL, which PHANTOM requires for its 3D overlay.',
      );
      return;
    }

    this.cameraScreen.showLoading();

    try {
      const cameraPromise = this.camera.isActive() ? Promise.resolve() : this.camera.start({ facing: this.facing });
      const visionPromise = this.poseVision.isReady() ? Promise.resolve() : this.poseVision.init();
      await Promise.all([cameraPromise, visionPromise]);

      const video = this.cameraScreen.videoElement;
      trackingManager.setVideoAspect(video.videoWidth / video.videoHeight);
      // Single source of truth for mirroring: the front camera is displayed
      // mirrored (CSS, on <video> only — see CameraScreen.setMirrored), and
      // the skeleton's coordinate math is told the same boolean so it
      // applies the matching software mirror exactly once (see
      // transformLandmarkForRender). Never mirror both the CSS layer and
      // the canvas — see the comment on #scene-canvas in styles.css.
      const cameraMirrored = this.facing === 'user';
      trackingManager.setCameraMirrored(cameraMirrored);
      this.cameraScreen.setMirrored(cameraMirrored);

      this.cameraScreen.hideLoading();
      sceneManager.start();
    } catch (err) {
      this.handleFatalError(err);
    }
  }

  private exitCamera(): void {
    this.sceneManager?.stop();
    this.camera.stop();
    this.trackingManager?.reset();
    this.trackingHistory.clear();
    this.visionDetectionFailed = false;
    this.lastDetectMs = -Infinity;
    this.lastInferenceDurationMs = null;
    this.cameraScreen.hide();
    this.landingScreen.show();
  }

  private handleFrame(deltaSeconds: number, trackingManager: TrackingManager, debugSkeleton: DebugSkeleton): void {
    this.fpsCounter.update(deltaSeconds);

    if (this.camera.isActive() && this.poseVision.isReady() && !this.visionDetectionFailed) {
      const now = performance.now();
      if (now - this.lastDetectMs >= this.detectIntervalMs) {
        this.lastDetectMs = now;
        this.runDetection(now, trackingManager, debugSkeleton);
      }
    }

    const frame = trackingManager.getFrame();
    const diagnostics = trackingManager.getMirrorDiagnostics();
    const landmarkCount = frame.present
      ? frame.landmarks.filter((joint) => joint.visibility > VISIBILITY_THRESHOLD).length
      : 0;

    this.cameraScreen.updateDebugStats({
      fps: this.fpsCounter.getFps(),
      visionStatus: this.poseVision.getStatus(),
      trackingState: this.visionDetectionFailed ? 'ERROR' : frame.state,
      confidence: frame.present ? frame.confidence : null,
      landmarkCount,
      landmarkTotal: frame.landmarks.length,
      currentEffect: CURRENT_EFFECT_LABEL,
      inferenceTimeMs: this.lastInferenceDurationMs,
      mirrorDiagnostics: diagnostics
        ? { rawX: diagnostics.rawX, renderX: diagnostics.renderX, cameraMirrored: diagnostics.cameraMirrored }
        : null,
    });
  }

  private runDetection(nowMs: number, trackingManager: TrackingManager, debugSkeleton: DebugSkeleton): void {
    const video = this.cameraScreen.videoElement;
    let raw: RawPoseFrame | null;
    try {
      raw = this.poseVision.detect(video, nowMs);
    } catch (err) {
      console.error('[PHANTOM] Pose detection failed; disabling further detection this session.', err);
      this.visionDetectionFailed = true;
      return;
    }

    const durationMs = performance.now() - nowMs;
    this.lastInferenceDurationMs = durationMs;
    this.avgDetectDurationMs =
      this.avgDetectDurationMs === 0
        ? durationMs
        : this.avgDetectDurationMs + (durationMs - this.avgDetectDurationMs) * DETECT_DURATION_SMOOTHING;
    this.detectIntervalMs = clamp(
      this.avgDetectDurationMs * DETECT_INTERVAL_SAFETY_FACTOR,
      MIN_DETECT_INTERVAL_MS,
      MAX_DETECT_INTERVAL_MS,
    );

    const frame = trackingManager.update(raw, nowMs);
    debugSkeleton.update(frame);
    this.trackingHistory.push(frame);
  }

  private handleFatalError(err: unknown): void {
    console.error('[PHANTOM] Fatal error entering camera experience:', err);
    this.cameraScreen.showError(this.describeError(err));
  }

  private describeError(err: unknown): string {
    if (err instanceof CameraError) {
      switch (err.type) {
        case 'permission-denied':
          return 'Camera permission was denied. Allow camera access in your browser settings, then try again.';
        case 'not-found':
          return 'No camera was found on this device.';
        case 'not-readable':
          return 'The camera is already in use by another application.';
        case 'overconstrained':
          return 'No camera on this device matches the required constraints.';
        case 'insecure-context':
          return 'Camera access requires HTTPS (or localhost).';
        case 'unsupported':
          return 'This browser does not support camera access.';
        default:
          return 'An unknown camera error occurred.';
      }
    }
    if (err instanceof VisionError) {
      switch (err.type) {
        case 'model-load-failed':
          return 'Failed to load the pose detection model. Check your connection and try again.';
        case 'webgl-unavailable':
          return 'This device or browser does not support WebGL, which PHANTOM requires.';
        case 'unsupported':
          return 'Pose detection is not supported in this browser.';
        default:
          return 'An unknown error occurred while initializing pose detection.';
      }
    }
    if (err instanceof Error) {
      return err.message;
    }
    return 'An unknown error occurred.';
  }
}
