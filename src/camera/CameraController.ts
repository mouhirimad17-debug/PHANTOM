import { CameraError, type CameraFacing, type CameraStartOptions, type CameraStatus } from '../types/camera';

/** waitForVideoReady() gives up after this long — a permission-granted stream that never actually delivers a frame (a real device/driver failure mode) must not hang start() forever. */
const VIDEO_READY_TIMEOUT_MS = 10000;

/**
 * Owns the MediaStream lifecycle for a single <video> element.
 * Does not touch the DOM beyond that element, and does not know about
 * rendering, vision, or UI — it only exposes the video element and status.
 */
export class CameraController {
  private readonly videoEl: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private facing: CameraFacing | null = null;
  /**
   * The in-flight start() attempt, if any. A second concurrent call (e.g. a
   * double-tap on ENTER CAMERA, or overlapping enterCamera()/switchFacing()
   * calls) awaits this same attempt instead of racing its own
   * getUserMedia() call against it — two overlapping starts would otherwise
   * both succeed independently, and whichever finished last would silently
   * replace `this.stream` while the other's tracks (already live, already
   * holding the camera hardware) leaked forever with no reference left to
   * stop them.
   */
  private startPromise: Promise<void> | null = null;

  constructor(videoEl: HTMLVideoElement) {
    this.videoEl = videoEl;
  }

  getVideoElement(): HTMLVideoElement {
    return this.videoEl;
  }

  isActive(): boolean {
    return this.stream !== null;
  }

  getStatus(): CameraStatus {
    return {
      active: this.isActive(),
      facing: this.facing,
      canSwitchFacing: this.hasMultipleFacingModes(),
      videoWidth: this.videoEl.videoWidth,
      videoHeight: this.videoEl.videoHeight,
    };
  }

  /** Best-effort check; browsers do not reliably expose camera count before permission is granted. */
  private hasMultipleFacingModes(): boolean {
    if (!this.stream) return false;
    const track = this.stream.getVideoTracks()[0];
    if (!track) return false;
    const capabilities = track.getCapabilities?.();
    const modes = capabilities?.facingMode;
    return Array.isArray(modes) && modes.length > 1;
  }

  /** Starts a new camera stream, replacing any existing one. Concurrent calls share a single in-flight attempt — see `startPromise`. */
  async start(options: CameraStartOptions): Promise<void> {
    if (this.startPromise) return this.startPromise;
    const promise = this.doStart(options);
    this.startPromise = promise;
    try {
      await promise;
    } finally {
      if (this.startPromise === promise) this.startPromise = null;
    }
  }

  private async doStart(options: CameraStartOptions): Promise<void> {
    if (!window.isSecureContext) {
      throw new CameraError(
        'insecure-context',
        'Camera access requires HTTPS (or localhost). Load this page over a secure connection.',
      );
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError('unsupported', 'This browser does not support camera access (getUserMedia).');
    }

    this.stop();

    const constraints: MediaStreamConstraints = {
      audio: false,
      video: {
        facingMode: { ideal: options.facing },
        width: { ideal: options.idealWidth ?? 1280 },
        height: { ideal: options.idealHeight ?? 720 },
      },
    };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      throw this.toCameraError(err);
    }

    this.stream = stream;
    this.facing = options.facing;
    this.videoEl.srcObject = stream;

    try {
      await this.videoEl.play();
    } catch (err) {
      this.stop();
      throw new CameraError('unknown', 'Camera stream could not be played.', { cause: err });
    }

    try {
      await this.waitForVideoReady();
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  private waitForVideoReady(): Promise<void> {
    if (this.videoEl.videoWidth > 0 && this.videoEl.videoHeight > 0) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        this.videoEl.removeEventListener('loadedmetadata', onLoaded);
        window.clearTimeout(timeoutId);
      };
      const onLoaded = (): void => {
        cleanup();
        resolve();
      };
      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new CameraError('unknown', 'The camera stream never became ready (no video frames were received).'));
      }, VIDEO_READY_TIMEOUT_MS);
      this.videoEl.addEventListener('loadedmetadata', onLoaded);
    });
  }

  /**
   * Switches to the other facing mode. If the new facing mode fails to
   * start, falls back to restoring the facing mode that was active before
   * the switch was attempted, so a failed switch degrades to "camera keeps
   * working as it did before" rather than leaving the camera stopped
   * entirely. The original error is always thrown either way, so the
   * caller still learns the switch itself failed.
   */
  async switchFacing(): Promise<void> {
    const previous = this.facing;
    const next: CameraFacing = this.facing === 'user' ? 'environment' : 'user';
    try {
      await this.start({ facing: next });
    } catch (err) {
      if (previous) {
        try {
          await this.start({ facing: previous });
        } catch {
          // Fall through with the original error — both facings failed, so
          // the camera is genuinely stopped and the caller must handle that.
        }
      }
      throw err;
    }
  }

  stop(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
    }
    this.stream = null;
    this.videoEl.srcObject = null;
  }

  private toCameraError(err: unknown): CameraError {
    if (err instanceof DOMException) {
      switch (err.name) {
        case 'NotAllowedError':
        case 'SecurityError':
          return new CameraError('permission-denied', 'Camera permission was denied.', { cause: err });
        case 'NotFoundError':
        case 'DevicesNotFoundError':
          return new CameraError('not-found', 'No camera device was found.', { cause: err });
        case 'NotReadableError':
        case 'TrackStartError':
          return new CameraError('not-readable', 'The camera is already in use by another application.', {
            cause: err,
          });
        case 'OverconstrainedError':
          return new CameraError('overconstrained', 'No camera matches the requested constraints.', {
            cause: err,
          });
        default:
          return new CameraError('unknown', `Camera error: ${err.name}`, { cause: err });
      }
    }
    return new CameraError('unknown', 'An unknown camera error occurred.', { cause: err });
  }
}
