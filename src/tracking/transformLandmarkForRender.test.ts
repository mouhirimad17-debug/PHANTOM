import { describe, expect, it } from 'vitest';
import { transformLandmarkForRender } from './transformLandmarkForRender';

describe('transformLandmarkForRender', () => {
  const inputs = [0, 0.25, 0.5, 0.75, 1];

  it('passes x through unchanged when the camera is not mirrored (rear camera)', () => {
    for (const x of inputs) {
      expect(transformLandmarkForRender(x, false)).toBe(x);
    }
  });

  it('flips x around the center when the camera is mirrored (front camera)', () => {
    const expected = [1, 0.75, 0.5, 0.25, 0];
    inputs.forEach((x, i) => {
      expect(transformLandmarkForRender(x, true)).toBeCloseTo(expected[i]!, 10);
    });
  });

  it('leaves the exact center (0.5) unchanged in both modes', () => {
    expect(transformLandmarkForRender(0.5, false)).toBe(0.5);
    expect(transformLandmarkForRender(0.5, true)).toBe(0.5);
  });

  it('is its own inverse when mirrored (applying it twice returns the original value)', () => {
    for (const x of inputs) {
      expect(transformLandmarkForRender(transformLandmarkForRender(x, true), true)).toBeCloseTo(x, 10);
    }
  });
});
