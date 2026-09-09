import { requireElement } from '../utils/dom';
import type { TrackingState } from '../types/tracking';
import type { RecordingState } from '../types/recording';
import type { CloneCount, CloneMode } from '../effects/CloneEffect';
import type { ReversePreset } from '../effects/ReverseEffect';

export interface CameraScreenCallbacks {
  onBack: () => void;
  onRetry: () => void;
  onCameraSwitch: () => void;
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

/** A single effect's top-level enable/disable chip in the bottom effect rail. */
interface EffectChip {
  button: HTMLButtonElement;
  onToggle: (active: boolean) => void;
}

const DEFAULT_CLONE_COUNT = '3';
const DEFAULT_CLONE_MODE = 'SPREAD';
const DEFAULT_REVERSE_PRESET = 'MIRROR';
const DEFAULT_REVERSE_LABEL = 'Mirror';
const DEFAULT_GHOST_OPACITY = '0.4';
const DEFAULT_GHOST_DELAY = '90';
const DEFAULT_GHOST_GLOW = '1';
const DEFAULT_SHADOW_SENSITIVITY = '6';
const TOAST_DURATION_MS = 4000;

export class CameraScreen {
  readonly videoElement = requireElement<HTMLVideoElement>('camera-video');
  readonly canvasElement = requireElement<HTMLCanvasElement>('scene-canvas');

  private readonly root = requireElement<HTMLElement>('camera-screen');
  private readonly loadingOverlay = requireElement<HTMLElement>('camera-loading');
  private readonly errorOverlay = requireElement<HTMLElement>('camera-error');
  private readonly errorMessageEl = requireElement<HTMLElement>('camera-error-message');

  private readonly statusDotEl = requireElement<HTMLElement>('status-dot');
  private readonly statusTextEl = requireElement<HTMLElement>('status-text');

  /** The whole "Display" settings section — diagnostics only, hidden unless debug mode is enabled (see utils/debugMode.ts). */
  private readonly debugSettingsSection = requireElement<HTMLElement>('debug-settings-section');
  private readonly skeletonToggleBtn = requireElement<HTMLButtonElement>('skeleton-toggle-btn');
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

  private readonly shadowToggleBtn = requireElement<HTMLButtonElement>('shadow-toggle-btn');
  private readonly sensitivitySlider = requireElement<HTMLInputElement>('shadow-sensitivity-slider');

  private readonly cloneToggleBtn = requireElement<HTMLButtonElement>('clone-toggle-btn');
  private readonly cloneCountBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-clone-count]'));
  private readonly cloneModeBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-clone-mode]'));

  private readonly ghostToggleBtn = requireElement<HTMLButtonElement>('ghost-toggle-btn');
  private readonly ghostOpacitySlider = requireElement<HTMLInputElement>('ghost-opacity-slider');
  private readonly ghostDelaySlider = requireElement<HTMLInputElement>('ghost-delay-slider');
  private readonly ghostGlowSlider = requireElement<HTMLInputElement>('ghost-glow-slider');
  private readonly ghostTrailToggleBtn = requireElement<HTMLButtonElement>('ghost-trail-toggle-btn');

  private readonly reverseToggleBtn = requireElement<HTMLButtonElement>('reverse-toggle-btn');
  private readonly reversePresetBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-reverse-preset]'));
  private readonly reversePreviewLabelEl = requireElement<HTMLElement>('reverse-preview-label-value');

  private readonly cameraSwitchBtn = requireElement<HTMLButtonElement>('camera-switch-btn');

  private readonly settingsToggleBtn = requireElement<HTMLButtonElement>('settings-toggle-btn');
  private readonly settingsCloseBtn = requireElement<HTMLButtonElement>('settings-close-btn');
  private readonly settingsPanel = requireElement<HTMLElement>('settings-panel');
  private readonly settingsScrim = requireElement<HTMLElement>('settings-scrim');

  private readonly toastNote = requireElement<HTMLElement>('toast-note');
  private readonly recordUnsupportedNote = requireElement<HTMLElement>('record-unsupported-note');

  private readonly recordControls: HTMLElement;
  private readonly recordToggleBtn = requireElement<HTMLButtonElement>('record-toggle-btn');
  private readonly recordIndicator = requireElement<HTMLElement>('record-indicator');
  private readonly recordingPreviewOverlay = requireElement<HTMLElement>('recording-preview');
  private readonly recordingPreviewVideo = requireElement<HTMLVideoElement>('recording-preview-video');

  private readonly ghostTrailBtnLabel = { on: 'TRAIL: ON', off: 'TRAIL: OFF' } as const;
  private readonly skeletonBtnLabel = { on: 'SKELETON OVERLAY: ON', off: 'SKELETON OVERLAY: OFF' } as const;

  private readonly effectChips: EffectChip[];

  private settingsOpen = false;
  private recordingState: RecordingState = 'idle';
  private toastTimeout: number | null = null;

  /**
   * @param debugModeEnabled Whether developer/debug mode is on for this
   * session (see utils/debugMode.ts) — gates the "Display" settings section
   * (live FPS/tracking diagnostics and the skeleton overlay toggle), which
   * is diagnostic tooling, not a production-facing feature. Effect controls
   * (Shadow/Clone/Ghost/Reverse) are unaffected and always shown.
   */
  constructor(callbacks: CameraScreenCallbacks, debugModeEnabled: boolean) {
    const backBtn = requireElement<HTMLButtonElement>('back-btn');
    const retryBtn = requireElement<HTMLButtonElement>('camera-error-retry-btn');
    const errorBackBtn = requireElement<HTMLButtonElement>('camera-error-back-btn');
    const cloneResetAllBtn = requireElement<HTMLButtonElement>('clone-reset-all-btn');
    const recordingSaveBtn = requireElement<HTMLButtonElement>('recording-save-btn');
    const recordingRetakeBtn = requireElement<HTMLButtonElement>('recording-retake-btn');
    // The bottom control bar containing RECORD is hidden while a finished
    // take is being previewed — its parent <footer> is what actually holds
    // layout, so grab it via the button already required above.
    this.recordControls = this.recordToggleBtn.parentElement as HTMLElement;

    this.debugSettingsSection.classList.toggle('hidden', !debugModeEnabled);

    backBtn.addEventListener('click', () => callbacks.onBack());
    errorBackBtn.addEventListener('click', () => callbacks.onBack());
    retryBtn.addEventListener('click', () => callbacks.onRetry());
    this.cameraSwitchBtn.addEventListener('click', () => callbacks.onCameraSwitch());

    this.skeletonToggleBtn.addEventListener('click', () => {
      const active = this.skeletonToggleBtn.getAttribute('aria-pressed') !== 'true';
      this.setSkeletonActive(active);
      callbacks.onDebugToggle(active);
    });
    this.sensitivitySlider.addEventListener('input', () => {
      callbacks.onIndependentShadowSensitivity(Number(this.sensitivitySlider.value));
    });

    this.effectChips = [
      { button: this.shadowToggleBtn, onToggle: callbacks.onIndependentShadowToggle },
      { button: this.cloneToggleBtn, onToggle: callbacks.onCloneToggle },
      { button: this.ghostToggleBtn, onToggle: callbacks.onGhostToggle },
      {
        button: this.reverseToggleBtn,
        onToggle: (active) => {
          callbacks.onReverseToggle(active);
          if (!active) this.setReversePreviewLabel(DEFAULT_REVERSE_LABEL);
        },
      },
    ];
    for (const chip of this.effectChips) {
      chip.button.addEventListener('click', () => {
        const active = chip.button.getAttribute('aria-pressed') !== 'true';
        chip.button.setAttribute('aria-pressed', String(active));
        chip.onToggle(active);
      });
    }

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
      this.setChipActive(this.cloneToggleBtn, false);
      this.setSegmentedPressed(
        this.cloneCountBtns,
        this.cloneCountBtns.find((b) => b.dataset['cloneCount'] === DEFAULT_CLONE_COUNT),
      );
      this.setSegmentedPressed(
        this.cloneModeBtns,
        this.cloneModeBtns.find((b) => b.dataset['cloneMode'] === DEFAULT_CLONE_MODE),
      );
    });

    this.ghostOpacitySlider.addEventListener('input', () => {
      callbacks.onGhostOpacityChange(Number(this.ghostOpacitySlider.value));
    });
    this.ghostDelaySlider.addEventListener('input', () => {
      callbacks.onGhostDelayChange(Number(this.ghostDelaySlider.value));
    });
    this.ghostGlowSlider.addEventListener('input', () => {
      callbacks.onGhostGlowChange(Number(this.ghostGlowSlider.value));
    });
    this.ghostTrailToggleBtn.addEventListener('click', () => {
      const active = this.ghostTrailToggleBtn.getAttribute('aria-pressed') !== 'true';
      this.setGhostTrailActive(active);
      callbacks.onGhostTrailToggle(active);
    });

    for (const btn of this.reversePresetBtns) {
      btn.addEventListener('click', () => {
        this.setSegmentedPressed(this.reversePresetBtns, btn);
        callbacks.onReversePresetChange(btn.dataset['reversePreset'] as ReversePreset);
      });
    }

    this.settingsToggleBtn.addEventListener('click', () => {
      if (this.settingsOpen) this.closeSettings();
      else this.openSettings();
    });
    this.settingsCloseBtn.addEventListener('click', () => this.closeSettings());
    this.settingsScrim.addEventListener('click', () => this.closeSettings());

    this.recordToggleBtn.addEventListener('click', () => {
      if (this.recordingState === 'recording') callbacks.onRecordStop();
      else callbacks.onRecordStart();
    });
    recordingSaveBtn.addEventListener('click', () => callbacks.onRecordDownload());
    recordingRetakeBtn.addEventListener('click', () => callbacks.onRecordRetake());
  }

  // ---------- Effect chips / segmented controls ----------

  private setChipActive(button: HTMLButtonElement, active: boolean): void {
    button.setAttribute('aria-pressed', String(active));
  }

  private setSegmentedPressed(group: HTMLButtonElement[], selected: HTMLButtonElement | undefined): void {
    for (const btn of group) {
      btn.setAttribute('aria-pressed', String(btn === selected));
    }
  }

  private setSkeletonActive(active: boolean): void {
    this.skeletonToggleBtn.setAttribute('aria-pressed', String(active));
    this.skeletonToggleBtn.textContent = active ? this.skeletonBtnLabel.on : this.skeletonBtnLabel.off;
  }

  private setGhostTrailActive(active: boolean): void {
    this.ghostTrailToggleBtn.setAttribute('aria-pressed', String(active));
    this.ghostTrailToggleBtn.textContent = active ? this.ghostTrailBtnLabel.on : this.ghostTrailBtnLabel.off;
  }

  /** Reflects ReverseEffect's currently selected preset in the panel's preview label — see App.ts's onReverseToggle/onReversePresetChange. */
  setReversePreviewLabel(label: string): void {
    this.reversePreviewLabelEl.textContent = label;
  }

  // ---------- Settings drawer ----------

  private openSettings(): void {
    this.settingsOpen = true;
    this.settingsPanel.classList.remove('hidden');
    this.settingsScrim.classList.remove('hidden');
    this.settingsToggleBtn.setAttribute('aria-pressed', 'true');
    this.settingsToggleBtn.setAttribute('aria-expanded', 'true');
    this.settingsCloseBtn.focus();
    document.addEventListener('keydown', this.handleSettingsKeydown);
  }

  private closeSettings(): void {
    this.settingsOpen = false;
    this.settingsPanel.classList.add('hidden');
    this.settingsScrim.classList.add('hidden');
    this.settingsToggleBtn.setAttribute('aria-pressed', 'false');
    this.settingsToggleBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', this.handleSettingsKeydown);
    this.settingsToggleBtn.focus();
  }

  private readonly handleSettingsKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.closeSettings();
  };

  // ---------- Camera switch ----------

  /** Shows/hides the camera-switch control — called once the camera is active and CameraController reports whether more than one facing mode exists. */
  setCameraSwitchAvailable(available: boolean): void {
    this.cameraSwitchBtn.classList.toggle('hidden', !available);
  }

  /** Disables the camera-switch control while a switch is in flight, to prevent overlapping switches. */
  setCameraSwitchBusy(busy: boolean): void {
    this.cameraSwitchBtn.disabled = busy;
  }

  // ---------- Recording ----------

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

  // ---------- Transient inline notes ----------

  /** Shows a short-lived inline message (auto-hides) for a non-fatal failure — recording errors, a failed camera switch — none of which should block the rest of the camera experience the way a fatal camera/vision error does. Never a native alert(). */
  showNote(message: string): void {
    this.toastNote.textContent = message;
    this.toastNote.classList.remove('hidden');
    if (this.toastTimeout !== null) window.clearTimeout(this.toastTimeout);
    this.toastTimeout = window.setTimeout(() => {
      this.toastNote.classList.add('hidden');
      this.toastTimeout = null;
    }, TOAST_DURATION_MS);
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
    // Keep every control's visual state in sync with App.exitCamera()
    // resetting the underlying effects — otherwise re-entering the camera
    // would show a control as "active" while its effect actually starts
    // disabled, or a slider at a stale position after its effect reset.
    for (const chip of this.effectChips) this.setChipActive(chip.button, false);
    this.setSkeletonActive(false);
    this.sensitivitySlider.value = DEFAULT_SHADOW_SENSITIVITY;
    this.setSegmentedPressed(
      this.cloneCountBtns,
      this.cloneCountBtns.find((b) => b.dataset['cloneCount'] === DEFAULT_CLONE_COUNT),
    );
    this.setSegmentedPressed(
      this.cloneModeBtns,
      this.cloneModeBtns.find((b) => b.dataset['cloneMode'] === DEFAULT_CLONE_MODE),
    );
    this.ghostOpacitySlider.value = DEFAULT_GHOST_OPACITY;
    this.ghostDelaySlider.value = DEFAULT_GHOST_DELAY;
    this.ghostGlowSlider.value = DEFAULT_GHOST_GLOW;
    this.setGhostTrailActive(true); // matches DEFAULT_GHOST_PARAMS.trailEnabled
    this.setSegmentedPressed(
      this.reversePresetBtns,
      this.reversePresetBtns.find((b) => b.dataset['reversePreset'] === DEFAULT_REVERSE_PRESET),
    );
    this.setReversePreviewLabel(DEFAULT_REVERSE_LABEL);
    this.updateRecordingState('idle', null);
    this.setCameraSwitchAvailable(false);
    if (this.toastTimeout !== null) {
      window.clearTimeout(this.toastTimeout);
      this.toastTimeout = null;
    }
    this.toastNote.classList.add('hidden');
    if (this.settingsOpen) {
      this.settingsOpen = false;
      this.settingsPanel.classList.add('hidden');
      this.settingsScrim.classList.add('hidden');
      this.settingsToggleBtn.setAttribute('aria-pressed', 'false');
      this.settingsToggleBtn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('keydown', this.handleSettingsKeydown);
    }
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
    this.updateStatusIndicator(stats);

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

  /**
   * Drives the always-visible top-bar status pill from the same stats
   * already computed for the (optional, opt-in) detailed stats panel —
   * this is the first-class "tracking lost" signal a normal user sees,
   * not just a DEBUG-only readout.
   */
  private updateStatusIndicator(stats: DebugStats): void {
    let label: string;
    let tone: 'live' | 'searching' | 'lost' | 'error';
    switch (stats.trackingState) {
      case 'ERROR':
        label = 'ERROR';
        tone = 'error';
        break;
      case 'TRACKING':
        label = 'LIVE';
        tone = 'live';
        break;
      case 'LOST':
        label = 'NO BODY';
        tone = 'lost';
        break;
      default: // INITIALIZING or RECOVERING
        label = 'SEARCHING';
        tone = 'searching';
    }
    this.statusTextEl.textContent = label;
    this.statusDotEl.dataset['tone'] = tone;
  }
}
