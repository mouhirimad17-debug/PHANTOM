import { requireElement } from '../utils/dom';

export interface CameraScreenCallbacks {
  onBack: () => void;
  onRetry: () => void;
  onDebugToggle: (visible: boolean) => void;
}

export interface DebugStats {
  fps: number;
  visionStatus: string;
  poseStatus: string;
  confidence: number | null;
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
  private readonly poseStatusEl = requireElement<HTMLElement>('pose-status-value');
  private readonly confidenceEl = requireElement<HTMLElement>('confidence-value');

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

  setMirrored(mirrored: boolean): void {
    this.videoElement.classList.toggle('unmirrored', !mirrored);
    this.canvasElement.classList.toggle('unmirrored', !mirrored);
  }

  updateDebugStats(stats: DebugStats): void {
    if (!this.debugVisible) return;
    this.fpsValueEl.textContent = stats.fps.toFixed(0);
    this.visionStatusEl.textContent = stats.visionStatus;
    this.poseStatusEl.textContent = stats.poseStatus;
    this.confidenceEl.textContent = stats.confidence === null ? '-' : `${Math.round(stats.confidence * 100)}%`;
  }
}
