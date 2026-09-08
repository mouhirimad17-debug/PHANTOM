import { MeshStandardMaterial, Scene } from 'three';
import { describe, expect, it } from 'vitest';
import { CloneEffect } from './CloneEffect';
import { createTrackingFrame, computeDerivedFields } from '../tracking/trackingFrame';
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
  pool: Array<{ avatar: { root: { visible: boolean; position: { x: number; z: number } }; }; frame: TrackingFrame }>;
}

function internals(effect: CloneEffect): Internals {
  return effect as unknown as Internals;
}

function makeEffect(): CloneEffect {
  return new CloneEffect(new Scene());
}

describe('CloneEffect pooling', () => {
  it('creates exactly 5 pooled avatars up front, all hidden', () => {
    const effect = makeEffect();
    const pool = internals(effect).pool;
    expect(pool.length).toBe(5);
    for (const slot of pool) {
      expect(slot.avatar.root.visible).toBe(false);
    }
  });

  it('never recreates avatars across configure()/update() calls — same object identity throughout', () => {
    const effect = makeEffect();
    const before = internals(effect).pool.map((slot) => slot.avatar);

    effect.enable();
    effect.configure({ count: 5, mode: 'DELAYED' });
    effect.update(0.016, makeFrame({}, 0));
    effect.configure({ count: 2, mode: 'SAME' });
    effect.update(0.016, makeFrame({}, 16));

    const after = internals(effect).pool.map((slot) => slot.avatar);
    for (let i = 0; i < before.length; i++) {
      expect(after[i]).toBe(before[i]); // same object reference — never reallocated
    }
  });

  it('shows exactly `count` clones and hides the rest', () => {
    const effect = makeEffect();
    effect.enable();
    effect.configure({ count: 2 });
    effect.update(0.016, makeFrame({}, 0));

    const pool = internals(effect).pool;
    const visibleCount = pool.filter((slot) => slot.avatar.root.visible).length;
    expect(visibleCount).toBe(2);
  });
});

describe('CloneEffect modes', () => {
  it('SAME: every visible clone matches the current frame exactly (no delay)', () => {
    const effect = makeEffect();
    effect.enable();
    effect.configure({ count: 3, mode: 'SAME' });

    for (let i = 0; i < 10; i++) {
      effect.update(0.033, makeFrame({ [PoseLandmark.LEFT_WRIST]: { x: -0.45 - i * 0.05, y: 0.8, z: -2.5 } }, i * 33));
    }

    const pool = internals(effect).pool;
    const lastWristX = -0.45 - 9 * 0.05;
    for (let i = 0; i < 3; i++) {
      expect(pool[i]!.frame.leftWrist.position.x).toBeCloseTo(lastWristX, 6);
    }
  });

  it('DELAYED: later clones lag further behind a moving target than earlier ones', () => {
    const effect = makeEffect();
    effect.enable();
    effect.configure({ count: 3, mode: 'DELAYED', delayStepMilliseconds: 100 });

    let x = -0.45;
    for (let i = 0; i < 60; i++) {
      x += 0.01;
      effect.update(0.016, makeFrame({ [PoseLandmark.LEFT_WRIST]: { x, y: 0.8, z: -2.5 } }, i * 16));
    }

    const pool = internals(effect).pool;
    const x0 = pool[0]!.frame.leftWrist.position.x;
    const x1 = pool[1]!.frame.leftWrist.position.x;
    const x2 = pool[2]!.frame.leftWrist.position.x;
    // Moving in +x: less-delayed clones should be closer to the final (largest) x.
    expect(x0).toBeGreaterThan(x1);
    expect(x1).toBeGreaterThan(x2);
  });

  it('SPREAD: a larger spreadDistance produces a larger spatial offset for the same slot', () => {
    function offsetXForSpread(spreadDistance: number): number {
      const effect = makeEffect();
      effect.enable();
      effect.configure({ count: 2, mode: 'SPREAD', spreadDistance });
      effect.update(0.016, makeFrame({}, 0));
      return Math.abs(internals(effect).pool[0]!.avatar.root.position.x);
    }

    expect(offsetXForSpread(3)).toBeGreaterThan(offsetXForSpread(1));
  });

  it('SAME/DELAYED use a smaller base offset than SPREAD for the same slot', () => {
    const sameEffect = makeEffect();
    sameEffect.enable();
    sameEffect.configure({ count: 2, mode: 'SAME' });
    sameEffect.update(0.016, makeFrame({}, 0));
    const sameOffsetX = Math.abs(internals(sameEffect).pool[0]!.avatar.root.position.x);

    const spreadEffect = makeEffect();
    spreadEffect.enable();
    spreadEffect.configure({ count: 2, mode: 'SPREAD', spreadDistance: 2 });
    spreadEffect.update(0.016, makeFrame({}, 0));
    const spreadOffsetX = Math.abs(internals(spreadEffect).pool[0]!.avatar.root.position.x);

    expect(spreadOffsetX).toBeGreaterThan(sameOffsetX);
  });
});

describe('CloneEffect relation to the user (never arbitrary floating copies)', () => {
  it('keeps every clone offset within a small, bounded multiple of body scale', () => {
    const effect = makeEffect();
    effect.enable();
    effect.configure({ count: 5, mode: 'SPREAD', spreadDistance: 4 }); // max spread
    const frame = makeFrame({}, 0);
    effect.update(0.016, frame);

    const bodyScale = frame.bodyScale;
    for (const slot of internals(effect).pool) {
      if (!slot.avatar.root.visible) continue;
      expect(Math.abs(slot.avatar.root.position.x)).toBeLessThan(bodyScale * 20);
      expect(Math.abs(slot.avatar.root.position.z)).toBeLessThan(bodyScale * 20);
    }
  });
});

describe('CloneEffect visual variation', () => {
  it('fades opacity slightly across the clone lineup', () => {
    const effect = makeEffect();
    effect.enable();
    effect.configure({ count: 3, mode: 'SAME' });
    effect.update(0.016, makeFrame({}, 0));

    const rawPool = (effect as unknown as { pool: Array<{ avatar: { [k: string]: unknown } }> }).pool;
    const opacities = rawPool.map((slot) => {
      const headMesh = slot.avatar['headMesh'] as { material: MeshStandardMaterial };
      return headMesh.material.opacity;
    });
    expect(opacities[0]!).toBeGreaterThan(opacities[1]!);
    expect(opacities[1]!).toBeGreaterThan(opacities[2]!);
  });
});

describe('CloneEffect weak tracking / entering-leaving frame', () => {
  it('hides all clones when tracking is lost', () => {
    const effect = makeEffect();
    effect.enable();
    effect.configure({ count: 3 });
    effect.update(0.016, makeFrame({}, 0));
    expect(internals(effect).pool.filter((s) => s.avatar.root.visible).length).toBe(3);

    effect.update(0.016, notPresentFrame(16));
    expect(internals(effect).pool.filter((s) => s.avatar.root.visible).length).toBe(0);
  });

  it('resumes correctly after tracking is regained', () => {
    const effect = makeEffect();
    effect.enable();
    effect.configure({ count: 2 });
    effect.update(0.016, makeFrame({}, 0));
    effect.update(0.016, notPresentFrame(16));
    effect.update(0.016, makeFrame({}, 1000));

    expect(internals(effect).pool.filter((s) => s.avatar.root.visible).length).toBe(2);
  });
});

describe('CloneEffect lifecycle and validation', () => {
  it('reset() disables the effect, hides everything, and restores default params', () => {
    const effect = makeEffect();
    effect.enable();
    effect.configure({ count: 5, mode: 'DELAYED', opacity: 0.3 });
    effect.update(0.016, makeFrame({}, 0));

    effect.reset();

    expect(effect.isEnabled()).toBe(false);
    expect(effect.getParams().count).toBe(3);
    expect(effect.getParams().mode).toBe('SPREAD');
    for (const slot of internals(effect).pool) {
      expect(slot.avatar.root.visible).toBe(false);
    }
  });

  it('clamps an invalid count to the nearest valid option', () => {
    const effect = makeEffect();
    effect.configure({ count: 4 as never });
    expect([2, 3, 5]).toContain(effect.getParams().count);
  });

  it('ignores an invalid mode string', () => {
    const effect = makeEffect();
    const before = effect.getParams().mode;
    effect.configure({ mode: 'RANDOM' as never });
    expect(effect.getParams().mode).toBe(before);
  });

  it('clamps opacity/delayStepMilliseconds/spreadDistance to safe ranges', () => {
    const effect = makeEffect();
    effect.configure({ opacity: 5, delayStepMilliseconds: 100000, spreadDistance: -10 });
    const params = effect.getParams();
    expect(params.opacity).toBeLessThanOrEqual(1);
    expect(params.delayStepMilliseconds).toBeLessThanOrEqual(800);
    expect(params.spreadDistance).toBeGreaterThanOrEqual(0.5);
  });
});
