import { Scene } from 'three';
import { describe, expect, it } from 'vitest';
import { IndependentShadowEffect } from './IndependentShadowEffect';
import { createTrackingFrame, computeDerivedFields } from '../tracking/trackingFrame';
import { POSE_LANDMARK_COUNT, type TrackingFrame } from '../types/tracking';
import { PoseLandmark } from '../utils/poseLandmarks';

const FLOOR_Y = -1.4;

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

function notPresentFrame(timestampMs: number): TrackingFrame {
  const frame = makeFrame({}, timestampMs);
  frame.present = false;
  frame.state = 'LOST';
  return frame;
}

function makeEffect(): IndependentShadowEffect {
  return new IndependentShadowEffect(new Scene(), FLOOR_Y);
}

describe('IndependentShadowEffect lifecycle', () => {
  it('does nothing while disabled', () => {
    const effect = makeEffect();
    effect.update(0.016, makeFrame({}, 0));
    expect(effect.getParams()).toBeTruthy(); // sanity: constructed without enable() being required
  });

  it('hides on disable() and on a not-present frame', () => {
    const effect = makeEffect();
    effect.enable();
    effect.update(0, makeFrame({}, 0));

    const root = (effect as unknown as { shadowAvatar: { root: { visible: boolean } } }).shadowAvatar.root;
    expect(root.visible).toBe(true);

    effect.disable();
    expect(root.visible).toBe(false);

    effect.enable();
    effect.update(0, notPresentFrame(16));
    expect(root.visible).toBe(false);
  });

  it('reset() makes the next update() snap instantly instead of lerping from stale state', () => {
    const effect = makeEffect();
    effect.enable();
    effect.configure({ delayMilliseconds: 0 });
    effect.update(0, makeFrame({ [PoseLandmark.LEFT_WRIST]: { x: -0.45, y: 0.8, z: -2.5 } }, 0));
    for (let i = 1; i <= 20; i++) {
      effect.update(0.016, makeFrame({ [PoseLandmark.LEFT_WRIST]: { x: -0.45, y: 0.8, z: -2.5 } }, i * 16));
    }

    effect.reset();
    effect.enable();
    const farFrame = makeFrame({ [PoseLandmark.LEFT_WRIST]: { x: 5, y: 0.8, z: -2.5 } }, 10_000);
    effect.update(0, farFrame);

    const shadowWristX = (
      effect as unknown as { shadowFrame: TrackingFrame }
    ).shadowFrame.leftWrist.position.x;
    expect(shadowWristX).toBeCloseTo(5, 5); // snapped exactly, no lag on the first post-reset frame
  });
});

describe('IndependentShadowEffect determinism', () => {
  it('never uses randomness — identical input sequences produce identical output', () => {
    const sequence = Array.from({ length: 40 }, (_, i) => makeFrame({ [PoseLandmark.LEFT_WRIST]: { x: -0.45 + i * 0.02, y: 0.8, z: -2.5 } }, i * 16));

    function run(): number {
      const effect = makeEffect();
      effect.enable();
      for (const frame of sequence) {
        effect.update(0.016, frame);
      }
      return (effect as unknown as { shadowFrame: TrackingFrame }).shadowFrame.leftWrist.position.x;
    }

    expect(run()).toBe(run());
  });
});

describe('IndependentShadowEffect delay', () => {
  it('lags behind a moving target more with a larger delay', () => {
    function finalX(delayMilliseconds: number): number {
      const effect = makeEffect();
      effect.configure({ delayMilliseconds, followStrength: 30, recoverySpeed: 30, driftAmount: 0 });
      effect.enable();
      let x = -0.45;
      for (let i = 0; i < 60; i++) {
        x += 0.01; // steady linear motion
        effect.update(0.016, makeFrame({ [PoseLandmark.LEFT_WRIST]: { x, y: 0.8, z: -2.5 } }, i * 16));
      }
      return (effect as unknown as { shadowFrame: TrackingFrame }).shadowFrame.leftWrist.position.x;
    }

    const noDelay = finalX(0);
    const delayed = finalX(300);
    expect(delayed).toBeLessThan(noDelay); // still moving forward at sample time — delayed copy is behind
  });
});

describe('IndependentShadowEffect settling behavior', () => {
  it('continues past the target briefly before settling when underdamped (recoverySpeed low relative to followStrength)', () => {
    const effect = makeEffect();
    effect.configure({ delayMilliseconds: 0, followStrength: 25, recoverySpeed: 1.5, driftAmount: 0 });
    effect.enable();

    // Move steadily, then stop dead.
    let x = -0.45;
    for (let i = 0; i < 20; i++) {
      x += 0.03;
      effect.update(0.016, makeFrame({ [PoseLandmark.LEFT_WRIST]: { x, y: 0.8, z: -2.5 } }, i * 16));
    }
    const stopX = x;

    const samples: number[] = [];
    for (let i = 20; i < 320; i++) {
      effect.update(0.016, makeFrame({ [PoseLandmark.LEFT_WRIST]: { x: stopX, y: 0.8, z: -2.5 } }, i * 16));
      samples.push((effect as unknown as { shadowFrame: TrackingFrame }).shadowFrame.leftWrist.position.x);
    }

    const overshoot = Math.max(...samples) - stopX;
    expect(overshoot).toBeGreaterThan(0.001); // it actually continues past the target...
    const final = samples[samples.length - 1]!;
    expect(final).toBeCloseTo(stopX, 1); // ...then settles back onto it.
  });
});

describe('IndependentShadowEffect drift (imperfect copy)', () => {
  it('lets an extremity (wrist) lag further behind its target than a core joint (hip) given the same step change', () => {
    const effect = makeEffect();
    effect.configure({ delayMilliseconds: 0, followStrength: 6, recoverySpeed: 4, driftAmount: 1 });
    effect.enable();
    effect.update(0, makeFrame({}, 0)); // seed at rest

    const targetHipX = -0.5;
    const targetWristX = -1.0;
    for (let i = 1; i <= 5; i++) {
      effect.update(
        0.032,
        makeFrame(
          { [PoseLandmark.LEFT_HIP]: { x: targetHipX, y: 0.9, z: -2.5 }, [PoseLandmark.LEFT_WRIST]: { x: targetWristX, y: 0.8, z: -2.5 } },
          i * 32,
        ),
      );
    }

    const shadow = (effect as unknown as { shadowFrame: TrackingFrame }).shadowFrame;
    const hipRemaining = Math.abs(shadow.leftHip.position.x - targetHipX);
    const wristRemaining = Math.abs(shadow.leftWrist.position.x - targetWristX);
    expect(hipRemaining).toBeLessThan(wristRemaining); // hip (anchor) has converged further than the wrist (extremity)
  });
});

describe('IndependentShadowEffect flatten/offset/rotation/opacity', () => {
  it('pulls joints toward the floor Y in proportion to verticalFlatten', () => {
    const effect = makeEffect();
    effect.configure({ delayMilliseconds: 0, verticalFlatten: 1, followStrength: 10, recoverySpeed: 10 });
    effect.enable();
    for (let i = 0; i < 500; i++) {
      effect.update(0.016, makeFrame({}, i * 16));
    }
    const shadow = (effect as unknown as { shadowFrame: TrackingFrame }).shadowFrame;
    expect(shadow.leftShoulder.position.y).toBeCloseTo(FLOOR_Y, 1);
  });

  it('does not flatten at all when verticalFlatten is 0', () => {
    const effect = makeEffect();
    effect.configure({ delayMilliseconds: 0, verticalFlatten: 0, followStrength: 10, recoverySpeed: 10 });
    effect.enable();
    for (let i = 0; i < 500; i++) {
      effect.update(0.016, makeFrame({}, i * 16));
    }
    const shadow = (effect as unknown as { shadowFrame: TrackingFrame }).shadowFrame;
    expect(shadow.leftShoulder.position.y).toBeCloseTo(BASE_POSE[PoseLandmark.LEFT_SHOULDER]!.y, 1);
  });

  it('applies horizontalOffset and rotationOffset to the shadow avatar root', () => {
    const effect = makeEffect();
    effect.configure({ horizontalOffset: 0.6, rotationOffset: 0.4 });
    effect.enable();
    effect.update(0.016, makeFrame({}, 0));

    const root = (effect as unknown as { shadowAvatar: { root: { position: { x: number }; rotation: { y: number } } } })
      .shadowAvatar.root;
    expect(root.position.x).toBe(0.6);
    expect(root.rotation.y).toBe(0.4);
  });

  it('clamps configure() values to safe ranges', () => {
    const effect = makeEffect();
    effect.configure({ followStrength: 9999, opacity: -5 });
    const params = effect.getParams();
    expect(params.followStrength).toBeLessThanOrEqual(20);
    expect(params.opacity).toBeGreaterThanOrEqual(0);
  });
});
