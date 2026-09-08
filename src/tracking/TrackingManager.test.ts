import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { TrackingManager } from './TrackingManager';
import { POSE_LANDMARK_COUNT } from '../types/tracking';
import { PoseLandmark } from '../utils/poseLandmarks';
import type { NormalizedLandmark } from '../types/vision';

const GRACE_MS = 600; // must match TrackingManager's LOSS_GRACE_MS

function makeRawFrame(
  timestampMs: number,
  overrides: Partial<Record<number, Partial<NormalizedLandmark>>> = {},
) {
  const base = (): NormalizedLandmark => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 });
  const landmarks: NormalizedLandmark[] = Array.from({ length: POSE_LANDMARK_COUNT }, () => base());
  const worldLandmarks: NormalizedLandmark[] = Array.from({ length: POSE_LANDMARK_COUNT }, () => base());
  for (const [indexStr, override] of Object.entries(overrides)) {
    if (!override) continue;
    const index = Number(indexStr);
    Object.assign(landmarks[index]!, override);
    Object.assign(worldLandmarks[index]!, { ...override, z: override.z ?? 0 });
  }
  return { landmarks, worldLandmarks, timestampMs };
}

function makeManager(): TrackingManager {
  const camera = new PerspectiveCamera(60, 1, 0.1, 50);
  const manager = new TrackingManager(camera);
  manager.setVideoAspect(1);
  manager.setCameraMirrored(false); // isolate state-machine/derived-field tests from mirroring math
  return manager;
}

describe('TrackingManager state machine', () => {
  it('starts INITIALIZING and stays there while nothing is detected', () => {
    const manager = makeManager();
    const frame = manager.update(null, 0);
    expect(frame.state).toBe('INITIALIZING');
    expect(frame.present).toBe(false);
    expect(frame.lost).toBe(false);
  });

  it('moves to TRACKING on the first detection', () => {
    const manager = makeManager();
    const frame = manager.update(makeRawFrame(0), 0);
    expect(frame.state).toBe('TRACKING');
    expect(frame.present).toBe(true);
    expect(frame.lost).toBe(false);
    expect(frame.confidence).toBeGreaterThan(0);
  });

  it('moves to RECOVERING (not LOST) during a brief dropout, holding the last pose', () => {
    const manager = makeManager();
    manager.update(makeRawFrame(0), 0);
    const held = manager.update(null, 300); // within the 600ms grace period
    expect(held.state).toBe('RECOVERING');
    expect(held.present).toBe(true); // still considered safe to render
    expect(held.lost).toBe(false);
  });

  it('moves to LOST once the dropout exceeds the grace period', () => {
    const manager = makeManager();
    manager.update(makeRawFrame(0), 0);
    const lost = manager.update(null, GRACE_MS + 100);
    expect(lost.state).toBe('LOST');
    expect(lost.present).toBe(false);
    expect(lost.lost).toBe(true);
    expect(lost.confidence).toBe(0);
  });

  it('recovers from LOST by snapping instantly to the new position (smoother reset)', () => {
    const manager = makeManager();
    manager.update(makeRawFrame(0, { [PoseLandmark.LEFT_SHOULDER]: { x: 0.2 } }), 0);
    manager.update(null, GRACE_MS + 100); // -> LOST

    const reacquired = manager.update(makeRawFrame(GRACE_MS + 5000, { [PoseLandmark.LEFT_SHOULDER]: { x: 0.9 } }), GRACE_MS + 5000);
    expect(reacquired.state).toBe('TRACKING');

    // Recompute what an unsmoothed x=0.9 landmark maps to, independent of TrackingManager,
    // by re-running a second manager fed x=0.9 from a cold start (also snaps on first sample).
    const reference = makeManager();
    const referenceFrame = reference.update(makeRawFrame(0, { [PoseLandmark.LEFT_SHOULDER]: { x: 0.9 } }), 0);

    expect(reacquired.leftShoulder.position.x).toBeCloseTo(referenceFrame.leftShoulder.position.x, 5);
  });

  it('does NOT snap instantly across a short RECOVERING gap (stays smoothed, not reset)', () => {
    const manager = makeManager();
    const first = manager.update(makeRawFrame(0, { [PoseLandmark.LEFT_SHOULDER]: { x: 0.2 } }), 0);
    const firstX = first.leftShoulder.position.x;

    manager.update(null, 300); // RECOVERING, well within grace

    const second = manager.update(makeRawFrame(320, { [PoseLandmark.LEFT_SHOULDER]: { x: 0.8 } }), 320);

    // A cold-start reference for x=0.8 would snap exactly; the real manager,
    // having NOT been reset, must land somewhere between the old and new
    // raw positions instead — proving continuity was preserved.
    const reference = makeManager();
    const referenceFrame = reference.update(makeRawFrame(0, { [PoseLandmark.LEFT_SHOULDER]: { x: 0.8 } }), 0);

    expect(second.leftShoulder.position.x).not.toBeCloseTo(referenceFrame.leftShoulder.position.x, 5);
    expect(second.leftShoulder.position.x).toBeGreaterThan(firstX);
    expect(second.leftShoulder.position.x).toBeLessThan(referenceFrame.leftShoulder.position.x);
  });
});

describe('TrackingManager derived fields', () => {
  it('aliases named joints to the same objects as the landmarks array', () => {
    const manager = makeManager();
    const frame = manager.update(makeRawFrame(0), 0);
    expect(frame.leftShoulder).toBe(frame.landmarks[PoseLandmark.LEFT_SHOULDER]);
    expect(frame.rightWrist).toBe(frame.landmarks[PoseLandmark.RIGHT_WRIST]);
  });

  it('computes shoulderCenter/hipCenter/bodyCenter/bodyScale/torsoRotation consistently with the resulting joint positions', () => {
    const manager = makeManager();
    const frame = manager.update(
      makeRawFrame(0, {
        [PoseLandmark.LEFT_SHOULDER]: { x: 0.3, y: 0.3 },
        [PoseLandmark.RIGHT_SHOULDER]: { x: 0.7, y: 0.3 },
        [PoseLandmark.LEFT_HIP]: { x: 0.35, y: 0.7 },
        [PoseLandmark.RIGHT_HIP]: { x: 0.65, y: 0.7 },
      }),
      0,
    );

    const ls = frame.leftShoulder.position;
    const rs = frame.rightShoulder.position;
    const lh = frame.leftHip.position;
    const rh = frame.rightHip.position;

    expect(frame.shoulderCenter.x).toBeCloseTo((ls.x + rs.x) / 2, 6);
    expect(frame.shoulderCenter.y).toBeCloseTo((ls.y + rs.y) / 2, 6);
    expect(frame.hipCenter.x).toBeCloseTo((lh.x + rh.x) / 2, 6);
    expect(frame.bodyCenter.x).toBeCloseTo((frame.shoulderCenter.x + frame.hipCenter.x) / 2, 6);
    expect(frame.bodyScale).toBeCloseTo(ls.distanceTo(rs), 6);
    expect(frame.torsoRotation).toBeCloseTo(Math.atan2(rs.z - ls.z, rs.x - ls.x), 6);
  });
});
