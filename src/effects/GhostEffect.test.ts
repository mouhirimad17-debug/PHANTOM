import { MeshBasicMaterial, MeshStandardMaterial, Scene } from 'three';
import { describe, expect, it } from 'vitest';
import { GhostEffect } from './GhostEffect';
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

function notPresentFrame(timestampMs: number): TrackingFrame {
  const frame = makeFrame({}, timestampMs);
  frame.present = false;
  frame.state = 'LOST';
  return frame;
}

interface Internals {
  ghostAvatar: {
    root: { visible: boolean; position: { y: number }; scale: { x: number } };
    ['headMesh']: { material: MeshStandardMaterial };
  };
  ghostFrame: TrackingFrame;
  trailSteps: Array<{ material: MeshBasicMaterial; mesh: { visible: boolean } }>;
}

function internals(effect: GhostEffect): Internals {
  return effect as unknown as Internals;
}

function makeEffect(): GhostEffect {
  return new GhostEffect(new Scene());
}

describe('GhostEffect lifecycle', () => {
  it('does nothing while disabled', () => {
    const effect = makeEffect();
    effect.update(0.016, makeFrame({}, 0));
    expect(internals(effect).ghostAvatar.root.visible).toBe(false);
  });

  it('shows the ghost avatar once enabled and a frame is present', () => {
    const effect = makeEffect();
    effect.enable();
    effect.update(0.016, makeFrame({}, 0));
    expect(internals(effect).ghostAvatar.root.visible).toBe(true);
  });

  it('hides on disable()', () => {
    const effect = makeEffect();
    effect.enable();
    effect.update(0.016, makeFrame({}, 0));
    effect.disable();
    expect(internals(effect).ghostAvatar.root.visible).toBe(false);
  });

  it('hides on a not-present frame and resumes when tracking returns', () => {
    const effect = makeEffect();
    effect.enable();
    effect.update(0.016, makeFrame({}, 0));
    effect.update(0.016, notPresentFrame(16));
    expect(internals(effect).ghostAvatar.root.visible).toBe(false);

    effect.update(0.016, makeFrame({}, 32));
    expect(internals(effect).ghostAvatar.root.visible).toBe(true);
  });

  it('hides every trail mesh when tracking is lost', () => {
    const effect = makeEffect();
    effect.enable();
    for (let i = 0; i < 10; i++) effect.update(0.016, makeFrame({}, i * 16));
    effect.update(0.016, notPresentFrame(200));

    for (const step of internals(effect).trailSteps) {
      expect(step.mesh.visible).toBe(false);
    }
  });
});

describe('GhostEffect determinism', () => {
  it('never uses randomness — identical input sequences produce identical output', () => {
    const sequence = Array.from({ length: 40 }, (_, i) =>
      makeFrame({ [PoseLandmark.LEFT_WRIST]: { x: -0.45 + i * 0.02, y: 0.8, z: -2.5 } }, i * 16),
    );

    function run(): { x: number; scale: number; y: number } {
      const effect = makeEffect();
      effect.enable();
      for (const frame of sequence) effect.update(0.016, frame);
      const inner = internals(effect);
      return {
        x: inner.ghostFrame.leftWrist.position.x,
        scale: inner.ghostAvatar.root.scale.x,
        y: inner.ghostAvatar.root.position.y,
      };
    }

    const a = run();
    const b = run();
    expect(a).toEqual(b);
  });
});

describe('GhostEffect opacity and glow', () => {
  it('applies configured opacity to the ghost avatar material', () => {
    const effect = makeEffect();
    effect.enable();
    effect.configure({ opacity: 0.2 });
    effect.update(0.016, makeFrame({}, 0));
    expect(internals(effect).ghostAvatar.headMesh.material.opacity).toBeCloseTo(0.2, 5);
  });

  it('applies configured glowStrength to the ghost material emissive intensity', () => {
    const effect = makeEffect();
    effect.enable();
    effect.configure({ glowStrength: 0 });
    effect.update(0.016, makeFrame({}, 0));
    const atZero = internals(effect).ghostAvatar.headMesh.material.emissiveIntensity;

    effect.configure({ glowStrength: 2 });
    effect.update(0.016, makeFrame({}, 16));
    const atTwo = internals(effect).ghostAvatar.headMesh.material.emissiveIntensity;

    expect(atZero).toBe(0);
    expect(atTwo).toBeGreaterThan(atZero);
  });
});

describe('GhostEffect delayed pose', () => {
  it('lags behind a moving target when delayMilliseconds > 0', () => {
    function finalWristX(delayMilliseconds: number): number {
      const effect = makeEffect();
      effect.configure({ delayMilliseconds });
      effect.enable();
      let x = -0.45;
      for (let i = 0; i < 60; i++) {
        x += 0.01;
        effect.update(0.016, makeFrame({ [PoseLandmark.LEFT_WRIST]: { x, y: 0.8, z: -2.5 } }, i * 16));
      }
      return internals(effect).ghostFrame.leftWrist.position.x;
    }

    const live = finalWristX(0);
    const delayed = finalWristX(300);
    expect(delayed).toBeLessThan(live); // still moving forward — the delayed copy reads an earlier, smaller x
  });

  it('matches the live frame exactly when delayMilliseconds is 0', () => {
    const effect = makeEffect();
    effect.configure({ delayMilliseconds: 0 });
    effect.enable();
    const frame = makeFrame({ [PoseLandmark.LEFT_WRIST]: { x: -0.9, y: 0.8, z: -2.5 } }, 0);
    effect.update(0.016, frame);
    expect(internals(effect).ghostFrame.leftWrist.position.x).toBeCloseTo(-0.9, 6);
  });
});

describe('GhostEffect breathing and drift', () => {
  it('keeps scale breathing within a small, bounded range around 1', () => {
    const effect = makeEffect();
    effect.enable();
    const scales: number[] = [];
    for (let i = 0; i < 200; i++) {
      effect.update(0.016, makeFrame({}, i * 16));
      scales.push(internals(effect).ghostAvatar.root.scale.x);
    }
    for (const s of scales) {
      expect(s).toBeGreaterThan(0.9);
      expect(s).toBeLessThan(1.1);
    }
    // It should actually vary, not sit frozen at exactly 1.
    expect(Math.max(...scales) - Math.min(...scales)).toBeGreaterThan(0.01);
  });

  it('keeps vertical drift small relative to body scale', () => {
    const effect = makeEffect();
    effect.enable();
    let maxAbsY = 0;
    for (let i = 0; i < 200; i++) {
      effect.update(0.016, makeFrame({}, i * 16));
      maxAbsY = Math.max(maxAbsY, Math.abs(internals(effect).ghostAvatar.root.position.y));
    }
    const bodyScale = internals(effect).ghostFrame.bodyScale;
    expect(maxAbsY).toBeGreaterThan(0); // it actually drifts...
    expect(maxAbsY).toBeLessThan(bodyScale * 0.2); // ...but only slightly
  });
});

describe('GhostEffect trail', () => {
  it('shows trail echoes once enough history exists, when trailEnabled', () => {
    const effect = makeEffect();
    effect.configure({ trailEnabled: true, trailStrength: 1 });
    effect.enable();
    for (let i = 0; i < 20; i++) effect.update(0.016, makeFrame({}, i * 16));

    const anyVisible = internals(effect).trailSteps.some((step) => step.mesh.visible);
    expect(anyVisible).toBe(true);
  });

  it('hides all trail echoes when trailEnabled is false', () => {
    const effect = makeEffect();
    effect.configure({ trailEnabled: false });
    effect.enable();
    for (let i = 0; i < 20; i++) effect.update(0.016, makeFrame({}, i * 16));

    for (const step of internals(effect).trailSteps) {
      expect(step.mesh.visible).toBe(false);
    }
  });

  it('a higher trailStrength produces more opaque trail echoes', () => {
    function firstStepOpacity(trailStrength: number): number {
      const effect = makeEffect();
      effect.configure({ trailEnabled: true, trailStrength });
      effect.enable();
      for (let i = 0; i < 20; i++) effect.update(0.016, makeFrame({}, i * 16));
      return internals(effect).trailSteps[0]!.material.opacity;
    }

    expect(firstStepOpacity(1)).toBeGreaterThan(firstStepOpacity(0.2));
  });
});

describe('GhostEffect lifecycle and validation', () => {
  it('reset() disables the effect, hides everything, and restores default params', () => {
    const effect = makeEffect();
    effect.enable();
    effect.configure({ opacity: 0.9, delayMilliseconds: 400, glowStrength: 2, trailEnabled: false });
    effect.update(0.016, makeFrame({}, 0));

    effect.reset();

    expect(effect.isEnabled()).toBe(false);
    expect(effect.getParams().opacity).toBeCloseTo(0.4, 5);
    expect(effect.getParams().trailEnabled).toBe(true);
    expect(internals(effect).ghostAvatar.root.visible).toBe(false);
    for (const step of internals(effect).trailSteps) {
      expect(step.mesh.visible).toBe(false);
    }
  });

  it('clamps opacity/delayMilliseconds/glowStrength/trailStrength to safe ranges', () => {
    const effect = makeEffect();
    effect.configure({ opacity: 5, delayMilliseconds: 100000, glowStrength: -1, trailStrength: -5 });
    const params = effect.getParams();
    expect(params.opacity).toBeLessThanOrEqual(1);
    expect(params.delayMilliseconds).toBeLessThanOrEqual(600);
    expect(params.glowStrength).toBeGreaterThanOrEqual(0);
    expect(params.trailStrength).toBeGreaterThanOrEqual(0);
  });
});
