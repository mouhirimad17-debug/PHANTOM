import { CameraController } from '../camera/CameraController';
import { CameraError, type CameraFacing } from '../types/camera';
import { PoseVision } from '../vision/PoseVision';
import { VisionError, type RawPoseFrame } from '../types/vision';
import { VISIBILITY_THRESHOLD } from '../types/tracking';
import { TrackingManager } from '../tracking/TrackingManager';
import { TrackingHistory } from '../tracking/TrackingHistory';
import { SceneManager } from '../rendering/SceneManager';
import { DebugSkeleton } from '../rendering/DebugSkeleton';
import { Avatar } from '../avatar/Avatar';
import { IndependentShadowEffect } from '../effects/IndependentShadowEffect';
import { CloneEffect, type CloneCount, type CloneMode } from '../effects/CloneEffect';
import { GhostEffect } from '../effects/GhostEffect';
import { ReverseEffect, type ReversePreset } from '../effects/ReverseEffect';
import { LandingScreen } from '../ui/LandingScreen';
import { CameraScreen } from '../ui/CameraScreen';
import { FpsCounter } from '../utils/FpsCounter';
import { clamp } from '../utils/math';
import { isWebGLAvailable } from '../utils/webgl';

const NO_EFFECT_LABEL = 'None (base avatar)';
const INDEPENDENT_SHADOW_LABEL = 'Independent Shadow';
const GHOST_LABEL = 'Ghost';

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
  private avatar: Avatar | null = null;
  private independentShadowEffect: IndependentShadowEffect | null = null;
  private cloneEffect: CloneEffect | null = null;
  private ghostEffect: GhostEffect | null = null;
  private reverseEffect: ReverseEffect | null = null;

  private facing: CameraFacing = 'user';
  private lastDetectMs = -Infinity;
  private detectIntervalMs = MIN_DETECT_INTERVAL_MS;
  private avgDetectDurationMs = 0;
  private lastInferenceDurationMs: number | null = null;
  private lastEffectUpdateMs = -Infinity;
  private visionDetectionFailed = false;

  constructor() {
    this.cameraScreen = new CameraScreen({
      onBack: () => this.exitCamera(),
      onRetry: () => void this.enterCamera(),
      onDebugToggle: (visible) => this.debugSkeleton?.setVisible(visible),
      onIndependentShadowToggle: (active) => {
        if (active) this.independentShadowEffect?.enable();
        else this.independentShadowEffect?.disable();
      },
      onIndependentShadowSensitivity: (value) => this.independentShadowEffect?.configure({ followStrength: value }),
      onCloneToggle: (active) => {
        if (active) this.cloneEffect?.enable();
        else this.cloneEffect?.disable();
      },
      onCloneCountChange: (count: CloneCount) => this.cloneEffect?.configure({ count }),
      onCloneModeChange: (mode: CloneMode) => this.cloneEffect?.configure({ mode }),
      onCloneResetAll: () => this.cloneEffect?.reset(),
      onGhostToggle: (active) => {
        if (active) this.ghostEffect?.enable();
        else this.ghostEffect?.disable();
      },
      onGhostOpacityChange: (value) => this.ghostEffect?.configure({ opacity: value }),
      onGhostDelayChange: (value) => this.ghostEffect?.configure({ delayMilliseconds: value }),
      onGhostGlowChange: (value) => this.ghostEffect?.configure({ glowStrength: value }),
      onGhostTrailToggle: (trailEnabled) => this.ghostEffect?.configure({ trailEnabled }),
      onReverseToggle: (active) => {
        if (active) this.reverseEffect?.enable();
        else this.reverseEffect?.disable();
        this.cameraScreen.setReversePreviewLabel(this.reverseEffect?.getPreviewLabel() ?? '');
      },
      onReversePresetChange: (preset: ReversePreset) => {
        this.reverseEffect?.configure({ preset });
        this.cameraScreen.setReversePreviewLabel(this.reverseEffect?.getPreviewLabel() ?? '');
      },
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
      const avatar = new Avatar(sceneManager.scene);
      const independentShadowEffect = new IndependentShadowEffect(sceneManager.scene, sceneManager.floor.position.y);
      const cloneEffect = new CloneEffect(sceneManager.scene);
      const ghostEffect = new GhostEffect(sceneManager.scene);
      const reverseEffect = new ReverseEffect(sceneManager.scene);

      sceneManager.onFrame((delta) =>
        this.handleFrame(
          delta,
          trackingManager,
          debugSkeleton,
          avatar,
          independentShadowEffect,
          cloneEffect,
          ghostEffect,
          reverseEffect,
        ),
      );

      this.sceneManager = sceneManager;
      this.trackingManager = trackingManager;
      this.debugSkeleton = debugSkeleton;
      this.avatar = avatar;
      this.independentShadowEffect = independentShadowEffect;
      this.cloneEffect = cloneEffect;
      this.ghostEffect = ghostEffect;
      this.reverseEffect = reverseEffect;
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
    this.avatar?.reset();
    this.independentShadowEffect?.reset();
    this.cloneEffect?.reset();
    this.ghostEffect?.reset();
    this.reverseEffect?.reset();
    this.trackingHistory.clear();
    this.visionDetectionFailed = false;
    this.lastDetectMs = -Infinity;
    this.lastInferenceDurationMs = null;
    this.lastEffectUpdateMs = -Infinity;
    this.cameraScreen.hide();
    this.landingScreen.show();
  }

  private handleFrame(
    deltaSeconds: number,
    trackingManager: TrackingManager,
    debugSkeleton: DebugSkeleton,
    avatar: Avatar,
    independentShadowEffect: IndependentShadowEffect,
    cloneEffect: CloneEffect,
    ghostEffect: GhostEffect,
    reverseEffect: ReverseEffect,
  ): void {
    this.fpsCounter.update(deltaSeconds);

    if (this.camera.isActive() && this.poseVision.isReady() && !this.visionDetectionFailed) {
      const now = performance.now();
      if (now - this.lastDetectMs >= this.detectIntervalMs) {
        this.lastDetectMs = now;
        this.runDetection(
          now,
          trackingManager,
          debugSkeleton,
          avatar,
          independentShadowEffect,
          cloneEffect,
          ghostEffect,
          reverseEffect,
        );
      }
    }

    const frame = trackingManager.getFrame();
    const diagnostics = trackingManager.getMirrorDiagnostics();
    const landmarkCount = frame.present
      ? frame.landmarks.filter((joint) => joint.visibility > VISIBILITY_THRESHOLD).length
      : 0;

    const activeEffectLabels: string[] = [];
    if (independentShadowEffect.isEnabled()) activeEffectLabels.push(INDEPENDENT_SHADOW_LABEL);
    if (cloneEffect.isEnabled()) {
      const { count, mode } = cloneEffect.getParams();
      activeEffectLabels.push(`Clone (${mode} x${count})`);
    }
    if (ghostEffect.isEnabled()) activeEffectLabels.push(GHOST_LABEL);
    if (reverseEffect.isEnabled()) activeEffectLabels.push(`Reverse (${reverseEffect.getPreviewLabel()})`);

    this.cameraScreen.updateDebugStats({
      fps: this.fpsCounter.getFps(),
      visionStatus: this.poseVision.getStatus(),
      trackingState: this.visionDetectionFailed ? 'ERROR' : frame.state,
      confidence: frame.present ? frame.confidence : null,
      landmarkCount,
      landmarkTotal: frame.landmarks.length,
      currentEffect: activeEffectLabels.length > 0 ? activeEffectLabels.join(' + ') : NO_EFFECT_LABEL,
      inferenceTimeMs: this.lastInferenceDurationMs,
      mirrorDiagnostics: diagnostics
        ? { rawX: diagnostics.rawX, renderX: diagnostics.renderX, cameraMirrored: diagnostics.cameraMirrored }
        : null,
    });
  }

  private runDetection(
    nowMs: number,
    trackingManager: TrackingManager,
    debugSkeleton: DebugSkeleton,
    avatar: Avatar,
    independentShadowEffect: IndependentShadowEffect,
    cloneEffect: CloneEffect,
    ghostEffect: GhostEffect,
    reverseEffect: ReverseEffect,
  ): void {
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
    avatar.updateFromTracking(frame);
    this.trackingHistory.push(frame);

    // The effect's spring integrator needs real elapsed time, independent of
    // the (adaptively throttled) detection interval above.
    const effectDeltaSeconds = this.lastEffectUpdateMs === -Infinity ? 0 : (nowMs - this.lastEffectUpdateMs) / 1000;
    this.lastEffectUpdateMs = nowMs;
    independentShadowEffect.update(effectDeltaSeconds, frame);
    cloneEffect.update(effectDeltaSeconds, frame);
    ghostEffect.update(effectDeltaSeconds, frame);
    reverseEffect.update(effectDeltaSeconds, frame);
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
