export type RecordingErrorType =
  | 'unsupported'
  | 'camera-unavailable'
  | 'zero-size-canvas'
  | 'context-lost'
  | 'start-failed';

/**
 * Typed recording error, following the same pattern as CameraError/
 * VisionError: the `type` field lets the UI layer show a specific,
 * actionable message instead of a generic "recording failed" string.
 */
export class RecordingError extends Error {
  readonly type: RecordingErrorType;

  constructor(type: RecordingErrorType, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RecordingError';
    this.type = type;
  }
}

/**
 * 'idle'      -> nothing recorded yet, or the previous take was discarded
 *                (RETAKE) — ready to record.
 * 'recording' -> actively capturing.
 * 'stopped'   -> a finished recording is available for local preview/
 *                download, until RETAKE discards it or a new recording
 *                starts (which discards it implicitly).
 */
export type RecordingState = 'idle' | 'recording' | 'stopped';
