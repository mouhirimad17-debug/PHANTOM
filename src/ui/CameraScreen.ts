import { requireElement } from '../utils/dom';
import type { TrackingState } from '../types/tracking';

export interface CameraScreenCallbacks {
  onBack: () => void;
  onRetry: () => void;
  onDebugToggle: (visible: boolean) => void;
}

export interface DebugStats {
  fps: number;
  visionStatus: string;
  /** TrackingManager's formal state, or 'ERROR' when detection itself failed (not a tracking-loss case). */
  trackingState: TrackingState | 'ERROR';
  confidence: number | null;
  /** Landmarks currently above the visibility threshold, out of landmarkTotal. */
  landmarkCount: number;
  landmarkTotal: number;
  /** Static placeholder until the Effect system exists — see TODO.md. */
  currentEffect: string;
  /** Last pose-inference call duration, or null before the first one completes. */
  inferenceTimeMs: number | null;
  /** Temporary mirroring diagnostic for one landmark; null when no body is tracked. */
  mirrorDiagnostics: { rawX: number; renderX: number; cameraMirrored: boolean } | null;
}

export class CameraScreen {
  readonly videoElement = requireElement<HTMLVideoElement>('camera-video');
  readonly canvasElement = requireElement<HTMLCanvasElement>('scene-canvas');

  private readonly root = requireElement<HTMLElement>('camera-screen');
  private readonly loadingOverlay = requireElement<HTMLElement>('camera-loading');
  private readonly errorOverlay = requireElement<HTMLElement>('camera-error');
  private readonly errorMessageEl = requireElement<HTMLElement>('camera-error-message');
  private readonly debugPanel = requireElement<HTMLElement>('debug-panel');
  private readonly fpsValueEl = requireElement<HTMLElement>('fps-value');
  private readonly visionStatusEl = requireElement<HTMLElement>('vision-status-value');
  private readonly trackingStateEl = requireElement<HTMLElement>('tracking-state-value');
  private readonly confidenceEl = requireElement<HTMLElement>('confidence-value');
  private readonly landmarkCountEl = requireElement<HTMLElement>('landmark-count-value');
  private readonly currentEffectEl = requireElement<HTMLElement>('current-effect-value');
  private readonly inferenceTimeEl = requireElement<HTMLElement>('inference-time-value');
  private readonly rawXEl = requireElement<HTMLElement>('raw-x-value');
  private readonly renderXEl = requireElement<HTMLElement>('render-x-value');
  private readonly mirroredEl = requireElement<HTMLElement>('mirrored-value');

  private debugVisible = false;

  constructor(callbacks: CameraScreenCallbacks) {
    const backBtn = requireElement<HTMLButtonElement>('back-btn');
    const debugToggleBtn = requireElement<HTMLButtonElement>('debug-toggle-btn');
    const retryBtn = requireElement<HTMLButtonElement>('camera-error-retry-btn');
    const errorBackBtn = requireElement<HTMLButtonElement>('camera-error-back-btn');

    backBtn.addEventListener('click', () => callbacks.onBack());
    errorBackBtn.addEventListener('click', () => callbacks.onBack());
    retryBtn.addEventListener('click', () => callbacks.onRetry());
    debugToggleBtn.addEventListener('click', () => {
      this.debugVisible = !this.debugVisible;
      this.debugPanel.classList.toggle('hidden', !this.debugVisible);
      callbacks.onDebugToggle(this.debugVisible);
    });
  }

  getContainer(): HTMLElement {
    return this.root;
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
    this.hideLoading();
    this.hideError();
  }

  showLoading(): void {
    this.loadingOverlay.classList.remove('hidden');
  }

  hideLoading(): void {
    this.loadingOverlay.classList.add('hidden');
  }

  showError(message: string): void {
    this.hideLoading();
    this.errorMessageEl.textContent = message;
    this.errorOverlay.classList.remove('hidden');
  }

  hideError(): void {
    this.errorOverlay.classList.add('hidden');
  }

  /**
   * Mirrors the <video> element for the front-camera "mirror" UX via CSS.
   * The <canvas> is deliberately left untouched here — its content
   * (the skeleton) is mirrored in software instead, in the coordinate
   * transform pipeline (see transformLandmarkForRender). Applying a CSS
   * mirror to both would double-flip the canvas and make the skeleton
   * move opposite to the visible body.
   */
  setMirrored(cameraMirrored: boolean): void {
    this.videoElement.classList.toggle('unmirrored', !cameraMirrored);
  }

  updateDebugStats(stats: DebugStats): void {
    if (!this.debugVisible) return;
    this.fpsValueEl.textContent = stats.fps.toFixed(0);
    this.visionStatusEl.textContent = stats.visionStatus;
    this.trackingStateEl.textContent = stats.trackingState;
    this.confidenceEl.textContent = stats.confidence === null ? '-' : `${Math.round(stats.confidence * 100)}%`;
    this.landmarkCountEl.textContent = `${stats.landmarkCount}/${stats.landmarkTotal}`;
    this.currentEffectEl.textContent = stats.currentEffect;
    this.inferenceTimeEl.textContent = stats.inferenceTimeMs === null ? '-' : `${stats.inferenceTimeMs.toFixed(1)} ms`;

    const diag = stats.mirrorDiagnostics;
    this.rawXEl.textContent = diag ? diag.rawX.toFixed(3) : '-';
    this.renderXEl.textContent = diag ? diag.renderX.toFixed(3) : '-';
    this.mirroredEl.textContent = diag ? String(diag.cameraMirrored) : '-';
  }
}
