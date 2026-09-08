export interface NormalizedLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/**
 * One detection result from the pose model for a single video frame.
 * `landmarks` are normalized to the input image ([0,1], origin top-left) and
 * carry no reliable depth. `worldLandmarks` are metric, hip-relative 3D
 * positions used for the actual body shape/pose.
 */
export interface RawPoseFrame {
  landmarks: NormalizedLandmark[];
  worldLandmarks: NormalizedLandmark[];
  timestampMs: number;
}

export type VisionStatus = 'idle' | 'loading' | 'ready' | 'error';

export type VisionErrorType = 'webgl-unavailable' | 'model-load-failed' | 'unsupported' | 'unknown';

export class VisionError extends Error {
  readonly type: VisionErrorType;

  constructor(type: VisionErrorType, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'VisionError';
    this.type = type;
  }
}
