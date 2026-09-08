import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { transformLimbMotion, transformPosition, transformRotation } from './reverseTransforms';

describe('transformPosition', () => {
  it('reflects X across the mirror plane and leaves Y/Z unchanged', () => {
    const out = new Vector3();
    const result = transformPosition(out, new Vector3(0.3, 1.5, -2.5), 0);
    expect(result).toBe(out); // mutates and returns the same instance — no allocation
    expect(out.x).toBeCloseTo(-0.3, 6);
    expect(out.y).toBeCloseTo(1.5, 6);
    expect(out.z).toBeCloseTo(-2.5, 6);
  });

  it('reflects correctly about a non-zero mirror plane', () => {
    const out = new Vector3();
    transformPosition(out, new Vector3(1.2, 0, 0), 0.5);
    expect(out.x).toBeCloseTo(2 * 0.5 - 1.2, 6); // -0.2
  });

  it('leaves a point exactly on the mirror plane unchanged', () => {
    const out = new Vector3();
    transformPosition(out, new Vector3(0.5, 1, 2), 0.5);
    expect(out.x).toBeCloseTo(0.5, 6);
  });

  it('is an involution — reflecting twice returns the original X', () => {
    const mirrorX = 0.4;
    const original = new Vector3(0.9, 1.1, -3);
    const once = new Vector3();
    transformPosition(once, original, mirrorX);
    const twice = new Vector3();
    transformPosition(twice, once, mirrorX);
    expect(twice.x).toBeCloseTo(original.x, 6);
  });

  it('preserves distance between two points reflected about the same plane (rigid, no stretching)', () => {
    const mirrorX = 0.2;
    const a = new Vector3(-0.3, 1.4, -2.5);
    const b = new Vector3(0.3, 1.1, -2.4);
    const originalDistance = a.distanceTo(b);

    const aOut = new Vector3();
    const bOut = new Vector3();
    transformPosition(aOut, a, mirrorX);
    transformPosition(bOut, b, mirrorX);

    expect(aOut.distanceTo(bOut)).toBeCloseTo(originalDistance, 6);
  });
});

describe('transformRotation', () => {
  it('reflects a rotation pointing along +X to point along -X', () => {
    expect(transformRotation(0)).toBeCloseTo(Math.PI, 6);
  });

  it('leaves a rotation pointing along the mirror plane (+Z) unchanged', () => {
    expect(transformRotation(Math.PI / 2)).toBeCloseTo(Math.PI / 2, 6);
  });

  it('reflects an arbitrary angle correctly (pi/4 -> 3pi/4)', () => {
    expect(transformRotation(Math.PI / 4)).toBeCloseTo((3 * Math.PI) / 4, 6);
  });

  it('always returns a value within (-PI, PI]', () => {
    for (const angle of [0, Math.PI / 6, Math.PI / 2, Math.PI, -Math.PI / 3, -Math.PI, 2.9, -2.9]) {
      const result = transformRotation(angle);
      expect(result).toBeGreaterThan(-Math.PI - 1e-9);
      expect(result).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
  });

  it('is an involution — reflecting twice returns the original angle', () => {
    for (const angle of [0, Math.PI / 6, Math.PI / 2, 2.1, -1.4, -Math.PI / 2]) {
      const twice = transformRotation(transformRotation(angle));
      // Compare via direction vector to sidestep any +-PI wraparound edge case.
      expect(Math.cos(twice)).toBeCloseTo(Math.cos(angle), 6);
      expect(Math.sin(twice)).toBeCloseTo(Math.sin(angle), 6);
    }
  });
});

describe('transformLimbMotion', () => {
  it('inverts horizontal displacement from the anchor, leaving Y/Z unchanged', () => {
    const anchor = new Vector3(0.2, 1.4, -2.5);
    const joint = new Vector3(0.5, 0.8, -2.5); // 0.3 to the right of, and below, the anchor
    const out = new Vector3();
    transformLimbMotion(out, joint, anchor);

    expect(out.x).toBeCloseTo(0.2 - 0.3, 6); // anchor.x - dx
    expect(out.y).toBeCloseTo(joint.y, 6);
    expect(out.z).toBeCloseTo(joint.z, 6);
  });

  it('is a no-op when the joint sits exactly on its anchor (no NaN, stays put)', () => {
    const anchor = new Vector3(0.1, 1.2, -2.5);
    const out = new Vector3();
    transformLimbMotion(out, anchor, anchor);
    expect(out.x).toBeCloseTo(anchor.x, 6);
    expect(out.y).toBeCloseTo(anchor.y, 6);
    expect(out.z).toBeCloseTo(anchor.z, 6);
    expect(Number.isNaN(out.x)).toBe(false);
  });

  it('preserves the anchor-to-joint distance exactly (no limb stretching)', () => {
    const anchor = new Vector3(-0.15, 1.35, -2.45);
    const joint = new Vector3(-0.4, 1.05, -2.5);
    const originalDistance = anchor.distanceTo(joint);

    const out = new Vector3();
    transformLimbMotion(out, joint, anchor);

    expect(anchor.distanceTo(out)).toBeCloseTo(originalDistance, 6);
  });

  it('an outward horizontal move becomes an inward one of the same magnitude', () => {
    const anchor = new Vector3(0, 1.4, -2.5);
    const outwardJoint = new Vector3(0.6, 1.4, -2.5); // 0.6 outward (to the right)
    const out = new Vector3();
    transformLimbMotion(out, outwardJoint, anchor);
    expect(out.x).toBeCloseTo(-0.6, 6); // same magnitude, now to the left (inward)
  });
});
