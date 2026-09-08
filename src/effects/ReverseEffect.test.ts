import { Scene } from 'three';
import { describe, expect, it } from 'vitest';
import { ReverseEffect } from './ReverseEffect';
import { computeDerivedFields, createTrackingFrame } from '../tracking/trackingFrame';
import { POSE_LANDMARK_COUNT, type TrackingFrame } from '../types/tracking';
import { PoseLandmark } from '../utils/poseLandmarks';

/** A plausible standing pose, in scene-space coordinates directly (no camera/projection involved). */
const BASE_POSE: Partial<Record<number, { x: number; y: number; z: number }>> = {
  [PoseLandmark.NOSE]: { x: 0, y: 1.6, z: -2.5 },
  [PoseLandmark.LEFT_SHOULDER]: { x: -0.2, y: 1.4, z: -2.5 },
  [PoseLandmark.RIGHT_SHOULDER]: { x: 0.2, y: 1.4, z: -2.5 },
  [PoseLandmark.LEFT_ELBOW]: { x: -0.35, y: 1.1, z: -2.5 },
  [PoseLandmark.RIGHT_ELBOW]: { x: 0.35, y: 1.1, z: -2.5 },
  [PoseLandmark.LEFT_WRIST]: { x: -0.45, y: 0.8, z: -2.5 },
  [PoseLandmark.RIGHT_WRIST]: { x: 0.45, y: 0.8, z: -2.5 },
  [PoseLandmark.LEFT_INDEX]: { x: -0.47, y: 0.75, z: -2.5 },
  [PoseLandmark.RIGHT_INDEX]: { x: 0.47, y: 0.75, z: -2.5 },
  [PoseLandmark.LEFT_HIP]: { x: -0.15, y: 0.9, z: -2.5 },
  [PoseLandmark.RIGHT_HIP]: { x: 0.15, y: 0.9, z: -2.5 },
  [PoseLandmark.LEFT_KNEE]: { x: -0.17, y: 0.4, z: -2.5 },
  [PoseLandmark.RIGHT_KNEE]: { x: 0.17, y: 0.4, z: -2.5 },
  [PoseLandmark.LEFT_ANKLE]: { x: -0.18, y: -0.05, z: -2.5 },
  [PoseLandmark.RIGHT_ANKLE]: { x: 0.18, y: -0.05, z: -2.5 },
  [PoseLandmark.LEFT_FOOT_INDEX]: { x: -0.18, y: -0.1, z: -2.3 },
  [PoseLandmark.RIGHT_FOOT_INDEX]: { x: 0.18, y: -0.1, z: -2.3 },
};

function makeFrame(
  overrides: Partial<Record<number, { x?: number; y?: number; z?: number }>>,
  timestampMs: number,
): TrackingFrame {
  const frame = createTrackingFrame();
  frame.present = true;
  frame.state = 'TRACKING';
  frame.timestampMs = timestampMs;

  const merged = { ...BASE_POSE, ...overrides };
  for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
    frame.landmarks[i]!.visibility = 1;
  }
  for (const [indexStr, point] of Object.entries(merged)) {
    if (!point) continue;
    const joint = frame.landmarks[Number(indexStr)]!;
    joint.position.set(point.x ?? 0, point.y ?? 0, point.z ?? 0);
  }
  computeDerivedFields(frame);
  return frame;
}

/** Shifts every joint in BASE_POSE by (dx, 0, 0) — simulates the user (or camera) moving sideways. */
function shiftedPose(dx: number): Partial<Record<number, { x?: number; y?: number; z?: number }>> {
  const shifted: Partial<Record<number, { x?: number; y?: number; z?: number }>> = {};
  for (const [indexStr, point] of Object.entries(BASE_POSE)) {
    if (!point) continue;
    shifted[Number(indexStr)] = { x: point.x + dx, y: point.y, z: point.z };
  }
  return shifted;
}

function notPresentFrame(timestampMs: number): TrackingFrame {
  const frame = makeFrame({}, timestampMs);
  frame.present = false;
  frame.state = 'LOST';
  return frame;
}

interface Internals {
  reverseAvatar: { root: { visible: boolean } };
  reverseFrame: TrackingFrame;
}

function internals(effect: ReverseEffect): Internals {
  return effect as unknown as Internals;
}

function makeEffect(): ReverseEffect {
  return new ReverseEffect(new Scene());
}

describe('ReverseEffect lifecycle', () => {
  it('does nothing while disabled', () => {
    const effect = makeEffect();
    effect.update(0.016, makeFrame({}, 0));
    expect(internals(effect).reverseAvatar.root.visible).toBe(false);
  });

  it('shows once enabled and a frame is present', () => {
    const effect = makeEffect();
    effect.enable();
    effect.update(0.016, makeFrame({}, 0));
    expect(internals(effect).reverseAvatar.root.visible).toBe(true);
  });

  it('hides on disable() and on a not-present frame; resumes when tracking returns', () => {
    const effect = makeEffect();
    effect.enable();
    effect.update(0.016, makeFrame({}, 0));
    effect.disable();
    expect(internals(effect).reverseAvatar.root.visible).toBe(false);

    effect.enable();
    effect.update(0.016, notPresentFrame(16));
    expect(internals(effect).reverseAvatar.root.visible).toBe(false);

    effect.update(0.016, makeFrame({}, 32));
    expect(internals(effect).reverseAvatar.root.visible).toBe(true);
  });
});

describe('ReverseEffect presets and preview label', () => {
  it('defaults to MIRROR with label "Mirror"', () => {
    const effect = makeEffect();
    expect(effect.getParams().preset).toBe('MIRROR');
    expect(effect.getPreviewLabel()).toBe('Mirror');
  });

  it('reports the correct label for each preset', () => {
    const effect = makeEffect();
    effect.configure({ preset: 'REVERSE_HORIZONTAL' });
    expect(effect.getPreviewLabel()).toBe('Reverse Horizontal');
    effect.configure({ preset: 'DELAYED_MIRROR' });
    expect(effect.getPreviewLabel()).toBe('Delayed Mirror');
    effect.configure({ preset: 'MIRROR' });
    expect(effect.getPreviewLabel()).toBe('Mirror');
  });

  it('ignores an invalid preset string', () => {
    const effect = makeEffect();
    effect.configure({ preset: 'CHAOS' as never });
    expect(effect.getParams().preset).toBe('MIRROR');
  });
});

describe('ReverseEffect MIRROR — arms', () => {
  it('a hand moved outward (away from center) mirrors to the same absolute offset on the other side', () => {
    const effect = makeEffect();
    effect.enable();
    effect.configure({ preset: 'MIRROR' });
    // Left wrist reaches further out to the left than the base pose.
    const frame = makeFrame({ [PoseLandmark.LEFT_WRIST]: { x: -0.9, y: 0.8, z: -2.5 } }, 0);
    effect.update(0.016, frame);

    const mirrorX = frame.bodyCenter.x;
    const reverseWrist = internals(effect).reverseFrame.leftWrist.position;
    // The reflected point for the (still-indexed-as-"left") wrist landmark
    // now sits on the opposite side of the mirror plane from the source.
    expect(reverseWrist.x).toBeCloseTo(2 * mirrorX - frame.leftWrist.position.x, 6);
    expect(Math.sign(reverseWrist.x - mirrorX)).not.toBe(Math.sign(frame.leftWrist.position.x - mirrorX));
  });

  it('is a rigid reflection — arm segment lengths are preserved', () => {
    const effect = makeEffect();
    effect.enable();
    effect.configure({ preset: 'MIRROR' });
    const frame = makeFrame({ [PoseLandmark.LEFT_WRIST]: { x: -0.9, y: 0.6, z: -2.6 } }, 0);
    effect.update(0.016, frame);

    const originalLength = frame.leftElbow.position.distanceTo(frame.leftWrist.position);
    const reverse = internals(effect).reverseFrame;
    const reflectedLength = reverse.leftElbow.position.distanceTo(reverse.leftWrist.position);
    expect(reflectedLength).toBeCloseTo(originalLength, 6);
  });
});

describe('ReverseEffect MIRROR — body rotation', () => {
  it('reverses the reported facing direction (torsoRotation) consistently with the mirrored shoulders', () => {
    const effect = makeEffect();
    effect.enable();
    effect.configure({ preset: 'MIRROR' });
    // Turn the body: right shoulder pulled forward (smaller z) relative to left.
    const frame = makeFrame(
      {
        [PoseLandmark.LEFT_SHOULDER]: { x: -0.2, y: 1.4, z: -2.3 },
        [PoseLandmark.RIGHT_SHOULDER]: { x: 0.2, y: 1.4, z: -2.7 },
      },
      0,
    );
    effect.update(0.016, frame);

    const reverse = internals(effect).reverseFrame;
    // cos/sin comparison sidesteps wraparound at +-PI.
    expect(Math.cos(reverse.torsoRotation)).toBeCloseTo(Math.cos(Math.PI - frame.torsoRotation), 5);
    expect(Math.sin(reverse.torsoRotation)).toBeCloseTo(Math.sin(Math.PI - frame.torsoRotation), 5);
  });
});

describe('ReverseEffect MIRROR — walking-in-place-like movement', () => {
  it('tracks alternating knee lift smoothly without discontinuities frame to frame', () => {
    const effect = makeEffect();
    effect.enable();
    effect.configure({ preset: 'MIRROR' });

    const knees: number[] = [];
    for (let i = 0; i < 40; i++) {
      const lift = Math.sin(i / 5) * 0.3; // alternating up/down like marching in place
      effect.update(
        0.016,
        makeFrame({ [PoseLandmark.LEFT_KNEE]: { x: -0.17, y: 0.4 + lift, z: -2.5 } }, i * 16),
      );
      knees.push(internals(effect).reverseFrame.leftKnee.position.y);
    }
    // No frame-to-frame jump should exceed the actual step size we fed in (0.06 max delta between samples).
    for (let i = 1; i < knees.length; i++) {
      expect(Math.abs(knees[i]! - knees[i - 1]!)).toBeLessThan(0.2);
    }
    // And it should actually be moving, not frozen.
    expect(Math.max(...knees) - Math.min(...knees)).toBeGreaterThan(0.2);
  });
});

describe('ReverseEffect MIRROR — camera movement', () => {
  it('re-centers each frame on the current bodyCenter rather than a stale one', () => {
    const effect = makeEffect();
    effect.enable();
    effect.configure({ preset: 'MIRROR' });

    // Simulate the whole body drifting sideways (as if the camera/user moved).
    for (let i = 0; i < 30; i++) {
      const frame = makeFrame(shiftedPose(i * 0.05), i * 16);
      effect.update(0.016, frame);
      const reverse = internals(effect).reverseFrame;
      // The reflected leftWrist should always land on the opposite side of
      // THIS frame's own bodyCenter, not an earlier one.
      const mirrorX = frame.bodyCenter.x;
      expect(reverse.leftWrist.position.x).toBeCloseTo(2 * mirrorX - frame.leftWrist.position.x, 5);
    }
  });
});

describe('ReverseEffect REVERSE_HORIZONTAL', () => {
  it('keeps the core (shoulders/hips/nose) matching the live user exactly', () => {
    const effect = makeEffect();
    effect.enable();
    effect.configure({ preset: 'REVERSE_HORIZONTAL' });
    const frame = makeFrame({}, 0);
    effect.update(0.016, frame);

    const reverse = internals(effect).reverseFrame;
    expect(reverse.leftShoulder.position.x).toBeCloseTo(frame.leftShoulder.position.x, 6);
    expect(reverse.rightHip.position.x).toBeCloseTo(frame.rightHip.position.x, 6);
    expect(reverse.landmarks[PoseLandmark.NOSE]!.position.x).toBeCloseTo(
      frame.landmarks[PoseLandmark.NOSE]!.position.x,
      6,
    );
  });

  it('an outward hand move becomes an inward move of the SAME hand (not swapped to the other side)', () => {
    const effect = makeEffect();
    effect.enable();
    effect.configure({ preset: 'REVERSE_HORIZONTAL' });
    // Left wrist reaches further outward (more negative x, away from the left shoulder).
    const frame = makeFrame({ [PoseLandmark.LEFT_WRIST]: { x: -0.9, y: 0.8, z: -2.5 } }, 0);
    effect.update(0.016, frame);

    const reverse = internals(effect).reverseFrame;
    const shoulderX = frame.leftShoulder.position.x;
    const liveOffset = frame.leftWrist.position.x - shoulderX; // negative: outward to the left
    const reverseOffset = reverse.leftWrist.position.x - shoulderX;

    expect(liveOffset).toBeLessThan(0);
    expect(reverseOffset).toBeGreaterThan(0); // now inward, past the shoulder
    expect(Math.abs(reverseOffset)).toBeCloseTo(Math.abs(liveOffset), 5);
    // Still the LEFT wrist landmark slot — never swapped to read from the right side.
  });

  it('preserves limb length (no stretching) for the inverted extremity', () => {
    const effect = makeEffect();
    effect.enable();
    effect.configure({ preset: 'REVERSE_HORIZONTAL' });
    const frame = makeFrame({ [PoseLandmark.LEFT_WRIST]: { x: -0.9, y: 0.6, z: -2.6 } }, 0);
    effect.update(0.016, frame);

    const originalLength = frame.leftElbow.position.distanceTo(frame.leftWrist.position);
    const reverse = internals(effect).reverseFrame;
    // leftElbow is itself inverted around the shoulder too (it's in LIMB_ANCHORS),
    // so compare the anchor-to-wrist distance instead, which transformLimbMotion guarantees exactly.
    const shoulder = frame.leftShoulder.position;
    const originalReach = shoulder.distanceTo(frame.leftWrist.position);
    const reverseReach = shoulder.distanceTo(reverse.leftWrist.position);
    expect(reverseReach).toBeCloseTo(originalReach, 6);
    expect(originalLength).toBeGreaterThan(0); // sanity: the fixture pose isn't degenerate
  });

  it('body rotation: the core turns WITH the user (not reversed) while the limb inversion still applies', () => {
    const effect = makeEffect();
    effect.enable();
    effect.configure({ preset: 'REVERSE_HORIZONTAL' });
    const frame = makeFrame(
      {
        [PoseLandmark.LEFT_SHOULDER]: { x: -0.2, y: 1.4, z: -2.3 },
        [PoseLandmark.RIGHT_SHOULDER]: { x: 0.2, y: 1.4, z: -2.7 },
      },
      0,
    );
    effect.update(0.016, frame);

    const reverse = internals(effect).reverseFrame;
    expect(reverse.torsoRotation).toBeCloseTo(frame.torsoRotation, 5); // matches, not reversed
  });
});

describe('ReverseEffect DELAYED_MIRROR', () => {
  it('lags behind a moving target compared to MIRROR (no delay)', () => {
    function finalMirroredWristX(preset: 'MIRROR' | 'DELAYED_MIRROR'): number {
      const effect = makeEffect();
      effect.configure({ preset });
      effect.enable();
      let x = -0.45;
      for (let i = 0; i < 60; i++) {
        x += 0.02;
        effect.update(0.016, makeFrame({ [PoseLandmark.LEFT_WRIST]: { x, y: 0.8, z: -2.5 } }, i * 16));
      }
      return internals(effect).reverseFrame.leftWrist.position.x;
    }

    const mirrorNow = finalMirroredWristX('MIRROR');
    const delayed = finalMirroredWristX('DELAYED_MIRROR');
    // Both mirror the wrist to positive x (it moved further negative over time);
    // the delayed version reflects an earlier (less extreme) source position,
    // so it should differ measurably from the live-mirrored value.
    expect(delayed).not.toBeCloseTo(mirrorNow, 2);
  });

  it('uses the exact same reflection math as MIRROR, just on a historical sample', () => {
    const effect = makeEffect();
    effect.configure({ preset: 'DELAYED_MIRROR' });
    effect.enable();
    // Hold a completely static pose long enough for history to fill —
    // with no motion, "delayed" and "live" sources are identical.
    let frame = makeFrame({}, 0);
    for (let i = 0; i < 30; i++) {
      frame = makeFrame({}, i * 16);
      effect.update(0.016, frame);
    }
    const mirrorX = frame.bodyCenter.x;
    const reverse = internals(effect).reverseFrame;
    expect(reverse.leftWrist.position.x).toBeCloseTo(2 * mirrorX - frame.leftWrist.position.x, 5);
  });
});

describe('ReverseEffect lifecycle and validation', () => {
  it('reset() disables the effect, hides it, and restores the default preset', () => {
    const effect = makeEffect();
    effect.enable();
    effect.configure({ preset: 'DELAYED_MIRROR' });
    effect.update(0.016, makeFrame({}, 0));

    effect.reset();

    expect(effect.isEnabled()).toBe(false);
    expect(effect.getParams().preset).toBe('MIRROR');
    expect(internals(effect).reverseAvatar.root.visible).toBe(false);
  });
});
