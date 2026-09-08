import type { Vector3 } from 'three';

export const POSE_LANDMARK_COUNT = 33;

export interface TrackedJoint {
  /** Position in Three.js scene units. */
  position: Vector3;
  /** Per-joint detection confidence, 0..1. */
  visibility: number;
}

/**
 * Stable, smoothed, scene-space representation of a single tracked body for
 * one frame. This is what the avatar/effects/rendering modules consume —
 * they never touch raw MediaPipe output directly.
 */
export interface TrackingFrame {
  /** Always POSE_LANDMARK_COUNT entries; check `present`/`visibility` before use. */
  joints: TrackedJoint[];
  /** Whether a body is currently detected (post grace-period). */
  present: boolean;
  /** Overall pose confidence estimate, 0..1. */
  confidence: number;
  timestampMs: number;
  /** True while inside the grace period after tracking was lost (holding last known pose). */
  lost: boolean;
}
