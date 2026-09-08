import { requireElement } from '../utils/dom';
import type { TrackingState } from '../types/tracking';
import type { RecordingState } from '../types/recording';
import type { CloneCount, CloneMode } from '../effects/CloneEffect';
import type { ReversePreset } from '../effects/ReverseEffect';

export interface CameraScreenCallbacks {
  onBack: () => void;
  onRetry: () => void;
  onDebugToggle: (visible: boolean) => void;
  onIndependentShadowToggle: (active: boolean) => void;
  /** Fires as the advanced-panel sensitivity slider is dragged; maps to the effect's followStrength. */
  onIndependentShadowSensitivity: (value: number) => void;
  onCloneToggle: (active: boolean) => void;
  onCloneCountChange: (count: CloneCount) => void;
  onCloneModeChange: (mode: CloneMode) => void;
  onCloneResetAll: () => void;
  onGhostToggle: (active: boolean) => void;
  onGhostOpacityChange: (value: number) => void;
  onGhostDelayChange: (value: number) => void;
  onGhostGlowChange: (value: number) => void;
  onGhostTrailToggle: (trailEnabled: boolean) => void;
  onReverseToggle: (active: boolean) => void;
  onReversePresetChange: (preset: ReversePreset) => void;
  onRecordStart: () => void;
  onRecordStop: () => void;
  onRecordRetake: () => void;
  onRecordDownload: () => void;
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
  /** Name of the currently-enabled effect, or a "none" placeholder — see App.ts. */
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

  private readonly independentToggleBtn = requireElement<HTMLButtonElement>('independent-toggle-btn');
  private readonly cloneToggleBtn = requireElement<HTMLButtonElement>('clone-toggle-btn');
  private readonly clonePanel = requireElement<HTMLElement>('clone-panel');
  private readonly cloneCountBtns = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-clone-count]'),
  );
  private readonly cloneModeBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-clone-mode]'));

  private readonly ghostToggleBtn = requireElement<HTMLButtonElement>('ghost-toggle-btn');
  private readonly ghostPanel = requireElement<HTMLElement>('ghost-panel');
  private readonly ghostTrailToggleBtn = requireElement<HTMLButtonElement>('ghost-trail-toggle-btn');

  private readonly reverseToggleBtn = requireElement<HTMLButtonElement>('reverse-toggle-btn');
  private readonly reversePanel = requireElement<HTMLElement>('reverse-panel');
  private readonly reversePresetBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-reverse-preset]'));
  private readonly reversePreviewLabelEl = requireElement<HTMLElement>('reverse-preview-label-value');

  private readonly recordControls = requireElement<HTMLElement>('record-controls');
  private readonly recordToggleBtn = requireElement<HTMLButtonElement>('record-toggle-btn');
  private readonly recordIndicator = requireElement<HTMLElement>('record-indicator');
  private readonly recordErrorNote = requireElement<HTMLElement>('record-error-note');
  private readonly recordUnsupportedNote = requireElement<HTMLElement>('record-unsupported-note');
  private readonly recordingPreviewOverlay = requireElement<HTMLElement>('recording-preview');
  private readonly recordingPreviewVideo = requireElement<HTMLVideoElement>('recording-preview-video');

  private debugVisible = false;
  private independentActive = false;
  private cloneActive = false;
  private ghostActive = false;
  private ghostTrailActive = true;
  private reverseActive = false;
  private recordingState: RecordingState = 'idle';
  private recordErrorTimeout: number | null = null;

  constructor(callbacks: CameraScreenCallbacks) {
    const backBtn = requireElement<HTMLButtonElement>('back-btn');
    const debugToggleBtn = requireElement<HTMLButtonElement>('debug-toggle-btn');
    const retryBtn = requireElement<HTMLButtonElement>('camera-error-retry-btn');
    const errorBackBtn = requireElement<HTMLButtonElement>('camera-error-back-btn');
    const sensitivitySlider = requireElement<HTMLInputElement>('shadow-sensitivity-slider');
    const cloneResetAllBtn = requireElement<HTMLButtonElement>('clone-reset-all-btn');
    const ghostOpacitySlider = requireElement<HTMLInputElement>('ghost-opacity-slider');
    const ghostDelaySlider = requireElement<HTMLInputElement>('ghost-delay-slider');
    const ghostGlowSlider = requireElement<HTMLInputElement>('ghost-glow-slider');
    const recordingSaveBtn = requireElement<HTMLButtonElement>('recording-save-btn');
    const recordingRetakeBtn = requireElement<HTMLButtonElement>('recording-retake-btn');

    backBtn.addEventListener('click', () => callbacks.onBack());
    errorBackBtn.addEventListener('click', () => callbacks.onBack());
    retryBtn.addEventListener('click', () => callbacks.onRetry());
    debugToggleBtn.addEventListener('click', () => {
      this.debugVisible = !this.debugVisible;
      this.debugPanel.classList.toggle('hidden', !this.debugVisible);
      callbacks.onDebugToggle(this.debugVisible);
    });
    this.independentToggleBtn.addEventListener('click', () => {
      this.independentActive = !this.independentActive;
      this.independentToggleBtn.classList.toggle('active', this.independentActive);
      this.independentToggleBtn.setAttribute('aria-pressed', String(this.independentActive));
      callbacks.onIndependentShadowToggle(this.independentActive);
    });
    sensitivitySlider.addEventListener('input', () => {
      callbacks.onIndependentShadowSensitivity(Number(sensitivitySlider.value));
    });

    this.cloneToggleBtn.addEventListener('click', () => {
      this.setCloneActive(!this.cloneActive);
      callbacks.onCloneToggle(this.cloneActive);
    });
    for (const btn of this.cloneCountBtns) {
      btn.addEventListener('click', () => {
        this.setSegmentedPressed(this.cloneCountBtns, btn);
        callbacks.onCloneCountChange(Number(btn.dataset['cloneCount']) as CloneCount);
      });
    }
    for (const btn of this.cloneModeBtns) {
      btn.addEventListener('click', () => {
        this.setSegmentedPressed(this.cloneModeBtns, btn);
        callbacks.onCloneModeChange(btn.dataset['cloneMode'] as CloneMode);
      });
    }
    cloneResetAllBtn.addEventListener('click', () => {
      callbacks.onCloneResetAll();
      // Reflect CloneEffect.reset()'s restored defaults (disabled, count=3, mode=SPREAD) in the UI.
      this.setCloneActive(false);
      this.setSegmentedPressed(this.cloneCountBtns, this.cloneCountBtns.find((b) => b.dataset['cloneCount'] === '3'));
      this.setSegmentedPressed(this.cloneModeBtns, this.cloneModeBtns.find((b) => b.dataset['cloneMode'] === 'SPREAD'));
    });

    this.ghostToggleBtn.addEventListener('click', () => {
      this.setGhostActive(!this.ghostActive);
      callbacks.onGhostToggle(this.ghostActive);
    });
    ghostOpacitySlider.addEventListener('input', () => {
      callbacks.onGhostOpacityChange(Number(ghostOpacitySlider.value));
    });
    ghostDelaySlider.addEventListener('input', () => {
      callbacks.onGhostDelayChange(Number(ghostDelaySlider.value));
    });
    ghostGlowSlider.addEventListener('input', () => {
      callbacks.onGhostGlowChange(Number(ghostGlowSlider.value));
    });
    this.ghostTrailToggleBtn.addEventListener('click', () => {
      this.setGhostTrailActive(!this.ghostTrailActive);
      callbacks.onGhostTrailToggle(this.ghostTrailActive);
    });

    this.reverseToggleBtn.addEventListener('click', () => {
      this.setReverseActive(!this.reverseActive);
      callbacks.onReverseToggle(this.reverseActive);
    });
    for (const btn of this.reversePresetBtns) {
      btn.addEventListener('click', () => {
        this.setSegmentedPressed(this.reversePresetBtns, btn);
        callbacks.onReversePresetChange(btn.dataset['reversePreset'] as ReversePreset);
      });
    }

    this.recordToggleBtn.addEventListener('click', () => {
      if (this.recordingState === 'recording') callbacks.onRecordStop();
      else callbacks.onRecordStart();
    });
    recordingSaveBtn.addEventListener('click', () => callbacks.onRecordDownload());
    recordingRetakeBtn.addEventListener('click', () => callbacks.onRecordRetake());
  }

  private setCloneActive(active: boolean): void {
    this.cloneActive = active;
    this.cloneToggleBtn.classList.toggle('active', active);
    this.cloneToggleBtn.setAttribute('aria-pressed', String(active));
    this.clonePanel.classList.toggle('hidden', !active);
  }

  private setSegmentedPressed(group: HTMLButtonElement[], selected: HTMLButtonElement | undefined): void {
    for (const btn of group) {
      btn.setAttribute('aria-pressed', String(btn === selected));
    }
  }

  private setGhostActive(active: boolean): void {
    this.ghostActive = active;
    this.ghostToggleBtn.classList.toggle('active', active);
    this.ghostToggleBtn.setAttribute('aria-pressed', String(active));
    this.ghostPanel.classList.toggle('hidden', !active);
  }

  private setGhostTrailActive(active: boolean): void {
    this.ghostTrailActive = active;
    this.ghostTrailToggleBtn.setAttribute('aria-pressed', String(active));
    this.ghostTrailToggleBtn.textContent = active ? 'TRAIL: ON' : 'TRAIL: OFF';
  }

  private setReverseActive(active: boolean): void {
    this.reverseActive = active;
    this.reverseToggleBtn.classList.toggle('active', active);
    this.reverseToggleBtn.setAttribute('aria-pressed', String(active));
    this.reversePanel.classList.toggle('hidden', !active);
  }

  /** Reflects ReverseEffect's currently selected preset in the panel's preview label — see App.ts's onReverseToggle/onReversePresetChange. */
  setReversePreviewLabel(label: string): void {
    this.reversePreviewLabelEl.textContent = label;
  }

  /** Hides the RECORD button entirely and shows a short explanatory note instead — called once, at startup, from RecordingManager.isSupported(). */
  setRecordingSupported(supported: boolean): void {
    this.recordToggleBtn.classList.toggle('hidden', !supported);
    this.recordUnsupportedNote.classList.toggle('hidden', supported);
  }

  /**
   * Reflects RecordingManager's current state in the UI: the record
   * button's icon/label, the pulsing REC indicator, and the local preview
   * overlay (shown with `previewUrl` once `state === 'stopped'`, hidden
   * otherwise). `previewUrl` is ignored unless `state === 'stopped'`.
   */
  updateRecordingState(state: RecordingState, previewUrl: string | null): void {
    this.recordingState = state;
    this.recordIndicator.classList.toggle('hidden', state !== 'recording');
    this.recordToggleBtn.setAttribute('aria-pressed', String(state === 'recording'));
    this.recordToggleBtn.setAttribute('aria-label', state === 'recording' ? 'Stop recording' : 'Start recording');
    this.recordControls.classList.toggle('hidden', state === 'stopped');

    if (state === 'stopped' && previewUrl) {
      this.recordingPreviewVideo.src = previewUrl;
      this.recordingPreviewOverlay.classList.remove('hidden');
    } else {
      this.recordingPreviewOverlay.classList.add('hidden');
      this.recordingPreviewVideo.removeAttribute('src');
      this.recordingPreviewVideo.load(); // release the previous source cleanly
    }
  }

  /** Shows a short-lived inline error note near the record button (auto-hides — recording failures aren't fatal to the rest of the camera experience, unlike camera/vision errors). */
  showRecordingError(message: string): void {
    this.recordErrorNote.textContent = message;
    this.recordErrorNote.classList.remove('hidden');
    if (this.recordErrorTimeout !== null) window.clearTimeout(this.recordErrorTimeout);
    this.recordErrorTimeout = window.setTimeout(() => {
      this.recordErrorNote.classList.add('hidden');
      this.recordErrorTimeout = null;
    }, 4000);
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
    // Keep the toggle's visual state in sync with App.exitCamera() resetting
    // the underlying effect — otherwise re-entering the camera would show
    // the button as "active" while the effect actually starts disabled.
    this.independentActive = false;
    this.independentToggleBtn.classList.remove('active');
    this.independentToggleBtn.setAttribute('aria-pressed', 'false');
    this.setCloneActive(false);
    this.setGhostActive(false);
    this.setGhostTrailActive(true); // matches DEFAULT_GHOST_PARAMS.trailEnabled
    this.setReverseActive(false);
    this.setSegmentedPressed(this.reversePresetBtns, this.reversePresetBtns.find((b) => b.dataset['reversePreset'] === 'MIRROR'));
    this.setReversePreviewLabel('Mirror'); // matches DEFAULT_REVERSE_PARAMS.preset
    this.updateRecordingState('idle', null);
    if (this.recordErrorTimeout !== null) {
      window.clearTimeout(this.recordErrorTimeout);
      this.recordErrorTimeout = null;
    }
    this.recordErrorNote.classList.add('hidden');
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
