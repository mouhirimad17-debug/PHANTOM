import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { computeSegmentTransform, SEGMENT_UP_AXIS } from './limbMath';

describe('computeSegmentTransform', () => {
  it('positions the segment at the midpoint of start and end', () => {
    const start = new Vector3(0, 0, 0);
    const end = new Vector3(2, 4, 6);
    const outPosition = new Vector3();
    const outQuaternion = new Quaternion();

    computeSegmentTransform(start, end, outPosition, outQuaternion);

    expect(outPosition.x).toBeCloseTo(1, 6);
    expect(outPosition.y).toBeCloseTo(2, 6);
    expect(outPosition.z).toBeCloseTo(3, 6);
  });

  it('returns the true distance between start and end as the length', () => {
    const start = new Vector3(0, 0, 0);
    const end = new Vector3(3, 4, 0); // 3-4-5 triangle
    const length = computeSegmentTransform(start, end, new Vector3(), new Quaternion());
    expect(length).toBeCloseTo(5, 6);
  });

  it('orients the up axis to point exactly from start to end', () => {
    const cases: Array<[Vector3, Vector3]> = [
      [new Vector3(0, 0, 0), new Vector3(0, 1, 0)], // already aligned
      [new Vector3(0, 0, 0), new Vector3(1, 0, 0)], // along +X
      [new Vector3(0, 0, 0), new Vector3(0, 0, 1)], // along +Z
      [new Vector3(0, 0, 0), new Vector3(0, -1, 0)], // exactly opposite (180 degree case)
      [new Vector3(1, 2, 3), new Vector3(-2, 5, 1)], // arbitrary
    ];

    for (const [start, end] of cases) {
      const outQuaternion = new Quaternion();
      computeSegmentTransform(start, end, new Vector3(), outQuaternion);

      const expectedDirection = end.clone().sub(start).normalize();
      const rotatedUpAxis = SEGMENT_UP_AXIS.clone().applyQuaternion(outQuaternion);

      expect(rotatedUpAxis.x).toBeCloseTo(expectedDirection.x, 5);
      expect(rotatedUpAxis.y).toBeCloseTo(expectedDirection.y, 5);
      expect(rotatedUpAxis.z).toBeCloseTo(expectedDirection.z, 5);
    }
  });

  it('does not produce NaN when start and end are (nearly) coincident', () => {
    const start = new Vector3(1, 1, 1);
    const end = new Vector3(1, 1, 1);
    const outPosition = new Vector3();
    const outQuaternion = new Quaternion();

    const length = computeSegmentTransform(start, end, outPosition, outQuaternion);

    expect(Number.isNaN(length)).toBe(false);
    expect(length).toBeGreaterThan(0);
    expect(Number.isNaN(outQuaternion.x)).toBe(false);
    expect(Number.isNaN(outQuaternion.y)).toBe(false);
    expect(Number.isNaN(outQuaternion.z)).toBe(false);
    expect(Number.isNaN(outQuaternion.w)).toBe(false);
  });

  it('leaves a previously-set orientation untouched on a degenerate segment (holds last pose instead of snapping)', () => {
    const outQuaternion = new Quaternion();
    // Establish a known non-identity orientation first.
    computeSegmentTransform(new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(), outQuaternion);
    const beforeDegenerate = outQuaternion.clone();

    // Now feed it a degenerate (coincident) pair.
    computeSegmentTransform(new Vector3(5, 5, 5), new Vector3(5, 5, 5), new Vector3(), outQuaternion);

    expect(outQuaternion.equals(beforeDegenerate)).toBe(true);
  });
});
