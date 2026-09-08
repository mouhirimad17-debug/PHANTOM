import { Vector3 } from 'three';
import { POSE_LANDMARK_COUNT, type TrackedJoint, type TrackingFrame } from '../types/tracking';
import { PoseLandmark } from '../utils/poseLandmarks';

/**
 * Allocates a fresh, empty TrackingFrame with all nested objects (landmark
 * positions, derived-center vectors) created up front and the named joint
 * accessors (leftShoulder, rightWrist, ...) aliased into `landmarks`. This
 * is the only place a TrackingFrame's object graph is ever constructed —
 * both `TrackingManager` (its one live frame) and `TrackingHistory` (its
 * pool of history slots) call this once each, then mutate the result in
 * place forever via `copyTrackingFrame()` (never re-allocate a frame in a
 * hot path).
 */
export function createTrackingFrame(): TrackingFrame {
  const landmarks: TrackedJoint[] = Array.from({ length: POSE_LANDMARK_COUNT }, () => ({
    position: new Vector3(),
    visibility: 0,
  }));

  return {
    timestampMs: 0,
    landmarks,
    state: 'INITIALIZING',
    present: false,
    lost: false,
    confidence: 0,

    leftShoulder: landmarks[PoseLandmark.LEFT_SHOULDER]!,
    rightShoulder: landmarks[PoseLandmark.RIGHT_SHOULDER]!,
    leftElbow: landmarks[PoseLandmark.LEFT_ELBOW]!,
    rightElbow: landmarks[PoseLandmark.RIGHT_ELBOW]!,
    leftWrist: landmarks[PoseLandmark.LEFT_WRIST]!,
    rightWrist: landmarks[PoseLandmark.RIGHT_WRIST]!,
    leftHip: landmarks[PoseLandmark.LEFT_HIP]!,
    rightHip: landmarks[PoseLandmark.RIGHT_HIP]!,
    leftKnee: landmarks[PoseLandmark.LEFT_KNEE]!,
    rightKnee: landmarks[PoseLandmark.RIGHT_KNEE]!,
    leftAnkle: landmarks[PoseLandmark.LEFT_ANKLE]!,
    rightAnkle: landmarks[PoseLandmark.RIGHT_ANKLE]!,

    bodyCenter: new Vector3(),
    shoulderCenter: new Vector3(),
    hipCenter: new Vector3(),
    torsoRotation: 0,
    bodyScale: 0,
  };
}

/**
 * Copies every value out of `src` into `dest` in place — no allocation, no
 * reassignment of `dest`'s own object graph (its landmark/vector objects,
 * and its named joint aliases, are left exactly as `createTrackingFrame()`
 * wired them up). Used by `TrackingHistory.push()` to store an independent
 * snapshot of a frame that will keep being mutated by its owner afterward.
 */
export function copyTrackingFrame(dest: TrackingFrame, src: Readonly<TrackingFrame>): void {
  dest.timestampMs = src.timestampMs;
  dest.state = src.state;
  dest.present = src.present;
  dest.lost = src.lost;
  dest.confidence = src.confidence;

  for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
    dest.landmarks[i]!.position.copy(src.landmarks[i]!.position);
    dest.landmarks[i]!.visibility = src.landmarks[i]!.visibility;
  }

  dest.bodyCenter.copy(src.bodyCenter);
  dest.shoulderCenter.copy(src.shoulderCenter);
  dest.hipCenter.copy(src.hipCenter);
  dest.torsoRotation = src.torsoRotation;
  dest.bodyScale = src.bodyScale;
}

/**
 * Recomputes `bodyCenter`/`shoulderCenter`/`hipCenter`/`torsoRotation`/
 * `bodyScale` from a frame's current (already-positioned) named joints, in
 * place. The single source of truth for that math — `TrackingManager` calls
 * this for the live frame, and `IndependentShadowEffect` calls it for its
 * synthetic shadow frame, so the two can never drift apart by having
 * separately hand-copied formulas.
 */
export function computeDerivedFields(frame: TrackingFrame): void {
  frame.shoulderCenter.addVectors(frame.leftShoulder.position, frame.rightShoulder.position).multiplyScalar(0.5);
  frame.hipCenter.addVectors(frame.leftHip.position, frame.rightHip.position).multiplyScalar(0.5);
  frame.bodyCenter.addVectors(frame.shoulderCenter, frame.hipCenter).multiplyScalar(0.5);

  const dx = frame.rightShoulder.position.x - frame.leftShoulder.position.x;
  const dz = frame.rightShoulder.position.z - frame.leftShoulder.position.z;
  frame.torsoRotation = Math.atan2(dz, dx);
  frame.bodyScale = frame.leftShoulder.position.distanceTo(frame.rightShoulder.position);
}
