import { CameraError, type CameraFacing, type CameraStartOptions, type CameraStatus } from '../types/camera';

/**
 * Owns the MediaStream lifecycle for a single <video> element.
 * Does not touch the DOM beyond that element, and does not know about
 * rendering, vision, or UI — it only exposes the video element and status.
 */
export class CameraController {
  private readonly videoEl: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private facing: CameraFacing | null = null;

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

  async start(options: CameraStartOptions): Promise<void> {
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

    await this.waitForVideoReady();
  }

  private waitForVideoReady(): Promise<void> {
    if (this.videoEl.videoWidth > 0 && this.videoEl.videoHeight > 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const onLoaded = (): void => {
        this.videoEl.removeEventListener('loadedmetadata', onLoaded);
        resolve();
      };
      this.videoEl.addEventListener('loadedmetadata', onLoaded);
    });
  }

  async switchFacing(): Promise<void> {
    const next: CameraFacing = this.facing === 'user' ? 'environment' : 'user';
    await this.start({ facing: next });
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
