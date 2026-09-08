import type { Vector3 } from 'three';

/**
 * Pure, deterministic pose transforms for ReverseEffect ("the Phantom
 * responds differently from the user"). Kept separate from ReverseEffect
 * itself — like limbMath.ts is kept separate from Avatar — so each
 * transform is a small, independently testable function with no effect
 * state, no Three.js scene access, and no randomness. All three are
 * geometric isometries or sign-flips of a single component, never
 * anything that could stretch a limb or produce an unstable/chaotic
 * result — see each function's doc for the specific guarantee.
 */

/**
 * Reflects a position across a vertical mirror plane at `mirrorX` — the
 * core "mirror image" transform. Only X changes; Y and Z pass through
 * unchanged, since this mirrors left/right, not up/down or near/far.
 * A pure reflection is an isometry: distances between two reflected points
 * are exactly preserved, so reflecting every joint of a body about the
 * SAME mirrorX never stretches or distorts it — the mirrored figure has
 * identical proportions to the source, just flipped.
 */
export function transformPosition(out: Vector3, position: Readonly<Vector3>, mirrorX: number): Vector3 {
  out.set(2 * mirrorX - position.x, position.y, position.z);
  return out;
}

/**
 * Reflects a yaw angle (radians, the same atan2(dz, dx) convention as
 * TrackingFrame.torsoRotation) the way transformPosition reflects a
 * coordinate: across that same vertical mirror plane. A mirror inverts
 * handedness, so a body turning one way reads as turning the other way
 * once reflected. Computed via atan2 of the reflected direction vector
 * (not a plain `Math.PI - rotation`) so the result stays correctly
 * wrapped to (-PI, PI] for every input, including angles near +-PI — a
 * plain subtraction would need its own manual wraparound to avoid
 * producing an out-of-range angle.
 */
export function transformRotation(rotation: number): number {
  return Math.atan2(Math.sin(rotation), -Math.cos(rotation));
}

/**
 * Inverts a joint's horizontal displacement from a fixed anchor (e.g. the
 * shoulder for a wrist, the hip for an ankle) — moving the joint outward
 * from the anchor becomes moving it inward by the same amount, and vice
 * versa. Only the horizontal (X) displacement is inverted; the vertical
 * and depth displacement pass through unchanged, so a raised arm still
 * looks raised, just reaching the "wrong" way. Negating one component of a
 * vector never changes its magnitude, so the anchor-to-joint distance
 * (limb length/reach) is preserved exactly — this can never stretch a limb
 * or produce a NaN, even when the joint sits exactly on its anchor (the
 * zero-displacement case is a no-op).
 */
export function transformLimbMotion(out: Vector3, jointPosition: Readonly<Vector3>, anchorPosition: Readonly<Vector3>): Vector3 {
  const dx = jointPosition.x - anchorPosition.x;
  out.set(anchorPosition.x - dx, jointPosition.y, jointPosition.z);
  return out;
}
