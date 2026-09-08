export type CameraFacing = 'user' | 'environment';

export type CameraErrorType =
  | 'permission-denied'
  | 'not-found'
  | 'not-readable'
  | 'overconstrained'
  | 'insecure-context'
  | 'unsupported'
  | 'unknown';

/**
 * Typed camera error. The `type` field lets the UI layer show a specific,
 * actionable message instead of a generic "camera failed" string.
 */
export class CameraError extends Error {
  readonly type: CameraErrorType;

  constructor(type: CameraErrorType, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CameraError';
    this.type = type;
  }
}

export interface CameraStartOptions {
  facing: CameraFacing;
  /** Ideal capture resolution; the browser will pick the closest match. */
  idealWidth?: number;
  idealHeight?: number;
}

export interface CameraStatus {
  active: boolean;
  facing: CameraFacing | null;
  canSwitchFacing: boolean;
  videoWidth: number;
  videoHeight: number;
}
