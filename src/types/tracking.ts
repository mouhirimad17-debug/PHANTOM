import type { Vector3 } from 'three';

export const POSE_LANDMARK_COUNT = 33;

/**
 * Threshold above which a landmark is counted as "visible" for display
 * purposes (debug overlay landmark count) and for JOINT_VISIBILITY_THRESHOLD
 * consumers like DebugSkeleton.
 */
export const VISIBILITY_THRESHOLD = 0.4;

export interface TrackedJoint {
  /** Position in Three.js scene units. */
  position: Vector3;
  /** Per-joint detection confidence, 0..1. */
  visibility: number;
}

/**
 * The tracking lifecycle for a body in view.
 *
 *   INITIALIZING -> no body has been detected yet this session.
 *   TRACKING     -> a body was detected this frame (or the model's most
 *                   recent frame — inference is throttled independently of
 *                   the render loop).
 *   RECOVERING   -> detection dropped out very recently; the last known
 *                   smoothed pose is still being held (grace period) rather
 *                   than immediately treated as lost, to absorb one-frame
 *                   dropouts without visible flicker.
 *   LOST         -> detection has been missing for longer than the grace
 *                   period. Joint positions are stale and should not be
 *                   trusted/rendered.
 */
export type TrackingState = 'INITIALIZING' | 'TRACKING' | 'RECOVERING' | 'LOST';

/**
 * Stable, smoothed, scene-space representation of a single tracked body for
 * one frame. This is what the avatar/effects/rendering modules consume —
 * they never touch raw MediaPipe output directly.
 *
 * Identity note: a TrackingFrame's nested objects (each `landmarks[i]`, and
 * the `bodyCenter`/`shoulderCenter`/`hipCenter` vectors) are allocated once
 * by `createTrackingFrame()` and mutated in place thereafter — never
 * reassigned. This lets `TrackingManager` reuse a single instance every
 * frame, and lets `TrackingHistory` store independent snapshots via
 * `copyTrackingFrame()` without any per-frame heap allocation. Do not hold
 * onto a `TrackingFrame` reference across frames expecting its contents to
 * stay unchanged (except frames returned by `TrackingHistory`, which are
 * frozen snapshots).
 */
export interface TrackingFrame {
  timestampMs: number;

  /** All POSE_LANDMARK_COUNT landmarks, indexed by PoseLandmark.* (see utils/poseLandmarks.ts). */
  landmarks: TrackedJoint[];

  /** Current lifecycle state — see TrackingState. */
  state: TrackingState;
  /** Derived from state: true while TRACKING or RECOVERING (safe to render). */
  present: boolean;
  /** Derived from state: true only when LOST (detection missing past the grace period). */
  lost: boolean;
  /** Overall pose confidence estimate, 0..1 (mean landmark visibility). 0 when not present. */
  confidence: number;

  // Named convenience accessors. Each is the SAME TrackedJoint object as the
  // corresponding entry in `landmarks` (aliased once at construction, never
  // reassigned) — reading `.position`/`.visibility` off these is equivalent
  // to indexing `landmarks` directly, just self-documenting at call sites.
  leftShoulder: TrackedJoint;
  rightShoulder: TrackedJoint;
  leftElbow: TrackedJoint;
  rightElbow: TrackedJoint;
  leftWrist: TrackedJoint;
  rightWrist: TrackedJoint;
  leftHip: TrackedJoint;
  rightHip: TrackedJoint;
  leftKnee: TrackedJoint;
  rightKnee: TrackedJoint;
  leftAnkle: TrackedJoint;
  rightAnkle: TrackedJoint;

  // Derived spatial values, recomputed from the smoothed landmarks each time
  // `present` is true (see TrackingManager.updateDerivedFields). Vector
  // fields are pre-allocated and mutated via `.set()`/`.copy()`, never
  // reassigned — safe to hold a reference to `frame.bodyCenter` etc. as long
  // as you re-read it every frame rather than caching its value.
  /** Midpoint of shoulderCenter and hipCenter — an approximate torso center. */
  bodyCenter: Vector3;
  /** Midpoint of leftShoulder and rightShoulder. */
  shoulderCenter: Vector3;
  /** Midpoint of leftHip and rightHip. */
  hipCenter: Vector3;
  /**
   * Approximate torso yaw around the vertical axis, in radians, derived from
   * the shoulder line's orientation in scene space. 0 when shoulders are
   * square to the camera; increases as the body turns. This is an
   * approximation (see the module doc on CoordinateMapper for why per-joint
   * positions aren't a fully rigid 3D skeleton) — good enough to drive an
   * avatar's facing direction, not precise biomechanics.
   */
  torsoRotation: number;
  /**
   * Approximate scale of the body in scene units, taken as the shoulder-to-
   * shoulder distance (stable across most poses, unlike e.g. wrist-to-wrist
   * which varies wildly with arm movement). Larger = closer to the camera.
   */
  bodyScale: number;
}

/**
 * Developer-only snapshot of the mirroring pipeline for one selected
 * landmark, for the temporary DEBUG-panel diagnostic. Not used by any
 * production rendering path.
 */
export interface MirrorDiagnostics {
  /** Which landmark index this snapshot is for (see utils/poseLandmarks.ts). */
  landmarkIndex: number;
  /** Raw MediaPipe x, unmirrored, straight from the model. */
  rawX: number;
  /** x after transformLandmarkForRender — what the skeleton actually uses. */
  renderX: number;
  cameraMirrored: boolean;
}
