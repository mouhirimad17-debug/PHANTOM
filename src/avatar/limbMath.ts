import { Quaternion, Vector3 } from 'three';

/**
 * The shared unit primitives in avatarGeometry.ts are built with their long
 * axis along +Y (a Three.js convention for cylinder/capsule geometry). Every
 * limb segment's orientation is computed as "the rotation that takes this
 * axis to the segment's actual direction" — never as Euler angles, which
 * would need an arbitrary rotation-order choice and can gimbal-lock.
 * setFromUnitVectors has neither problem for a single direction-align like
 * this.
 */
export const SEGMENT_UP_AXIS = new Vector3(0, 1, 0);

/**
 * Floor for segment length. Below this, `start` and `end` are treated as
 * coincident: the previous orientation is left alone (a zero-length
 * direction vector can't be normalized — attempting to would produce NaN
 * and corrupt the mesh's transform) and this minimum is returned instead of
 * the true (near-zero) length, so the segment stays a visible sliver rather
 * than collapsing to nothing.
 */
const MIN_SEGMENT_LENGTH = 0.02;

const directionScratch = new Vector3();

/**
 * Computes the position, orientation, and length needed to stretch a
 * unit-length, +Y-aligned primitive (see avatarGeometry.ts) into a segment
 * running from `start` to `end`.
 *
 * Writes into `outPosition` and `outQuaternion` in place (both reused by the
 * caller across frames — see Avatar.ts's per-segment scratch objects) and
 * returns the segment's length as a plain number for the caller to apply as
 * `mesh.scale.y`. No allocation beyond a single module-level scratch vector
 * reused across every call.
 */
export function computeSegmentTransform(
  start: Readonly<Vector3>,
  end: Readonly<Vector3>,
  outPosition: Vector3,
  outQuaternion: Quaternion,
): number {
  outPosition.addVectors(start, end).multiplyScalar(0.5);

  directionScratch.subVectors(end, start);
  const length = directionScratch.length();
  if (length < MIN_SEGMENT_LENGTH) {
    return MIN_SEGMENT_LENGTH;
  }

  directionScratch.divideScalar(length); // normalize using the length we already computed
  outQuaternion.setFromUnitVectors(SEGMENT_UP_AXIS, directionScratch);
  return length;
}
