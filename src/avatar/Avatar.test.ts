import { Mesh, MeshStandardMaterial, PerspectiveCamera, Scene } from 'three';
import { describe, expect, it } from 'vitest';
import { Avatar } from './Avatar';
import { SEGMENT_GEOMETRY } from './avatarGeometry';
import { TrackingManager } from '../tracking/TrackingManager';
import { POSE_LANDMARK_COUNT, type TrackingFrame } from '../types/tracking';
import { PoseLandmark } from '../utils/poseLandmarks';
import type { NormalizedLandmark } from '../types/vision';

function makeRawFrame(overrides: Partial<Record<number, Partial<NormalizedLandmark>>>) {
  const base = (): NormalizedLandmark => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 });
  const landmarks = Array.from({ length: POSE_LANDMARK_COUNT }, () => base());
  const worldLandmarks = Array.from({ length: POSE_LANDMARK_COUNT }, () => base());
  for (const [indexStr, override] of Object.entries(overrides)) {
    if (!override) continue;
    const index = Number(indexStr);
    Object.assign(landmarks[index]!, override);
    Object.assign(worldLandmarks[index]!, { ...override, z: override.z ?? 0 });
  }
  return { landmarks, worldLandmarks, timestampMs: 0 };
}

/** A plausible, spread-out standing pose so every limb has a non-degenerate length. */
function makeTrackedFrame(): Readonly<TrackingFrame> {
  const camera = new PerspectiveCamera(60, 1, 0.1, 50);
  const manager = new TrackingManager(camera);
  manager.setVideoAspect(1);
  manager.setCameraMirrored(false);
  return manager.update(
    makeRawFrame({
      [PoseLandmark.NOSE]: { x: 0.5, y: 0.15 },
      [PoseLandmark.LEFT_SHOULDER]: { x: 0.35, y: 0.3 },
      [PoseLandmark.RIGHT_SHOULDER]: { x: 0.65, y: 0.3 },
      [PoseLandmark.LEFT_ELBOW]: { x: 0.25, y: 0.45 },
      [PoseLandmark.RIGHT_ELBOW]: { x: 0.75, y: 0.45 },
      [PoseLandmark.LEFT_WRIST]: { x: 0.2, y: 0.6 },
      [PoseLandmark.RIGHT_WRIST]: { x: 0.8, y: 0.6 },
      [PoseLandmark.LEFT_INDEX]: { x: 0.18, y: 0.65 },
      [PoseLandmark.RIGHT_INDEX]: { x: 0.82, y: 0.65 },
      [PoseLandmark.LEFT_HIP]: { x: 0.4, y: 0.6 },
      [PoseLandmark.RIGHT_HIP]: { x: 0.6, y: 0.6 },
      [PoseLandmark.LEFT_KNEE]: { x: 0.38, y: 0.8 },
      [PoseLandmark.RIGHT_KNEE]: { x: 0.62, y: 0.8 },
      [PoseLandmark.LEFT_ANKLE]: { x: 0.37, y: 0.95 },
      [PoseLandmark.RIGHT_ANKLE]: { x: 0.63, y: 0.95 },
      [PoseLandmark.LEFT_FOOT_INDEX]: { x: 0.37, y: 1.0 },
      [PoseLandmark.RIGHT_FOOT_INDEX]: { x: 0.63, y: 1.0 },
    }),
    0,
  );
}

function getSegment(avatar: Avatar, name: string): Mesh {
  const obj = avatar.root.getObjectByName(name);
  if (!(obj instanceof Mesh)) throw new Error(`Segment "${name}" not found or not a Mesh`);
  return obj;
}

describe('Avatar', () => {
  it('attaches its root to the scene, hidden until something is tracked', () => {
    const scene = new Scene();
    const avatar = new Avatar(scene);
    expect(avatar.root.parent).toBe(scene);
    expect(avatar.root.visible).toBe(false);
  });

  it('becomes visible and positions segments correctly when a body is tracked', () => {
    const scene = new Scene();
    const avatar = new Avatar(scene);
    const frame = makeTrackedFrame();

    avatar.updateFromTracking(frame);

    expect(avatar.root.visible).toBe(true);

    const forearm = getSegment(avatar, 'leftForearm');
    const expectedMid = frame.leftElbow.position.clone().add(frame.leftWrist.position).multiplyScalar(0.5);
    expect(forearm.position.x).toBeCloseTo(expectedMid.x, 5);
    expect(forearm.position.y).toBeCloseTo(expectedMid.y, 5);
    expect(forearm.scale.y).toBeCloseTo(frame.leftElbow.position.distanceTo(frame.leftWrist.position), 5);

    const head = getSegment(avatar, 'head');
    expect(head.position.x).toBeCloseTo(frame.landmarks[PoseLandmark.NOSE]!.position.x, 5);
    expect(head.position.y).toBeCloseTo(frame.landmarks[PoseLandmark.NOSE]!.position.y, 5);
  });

  it('freezes the last pose and hides when tracking is no longer present, instead of resetting', () => {
    const scene = new Scene();
    const avatar = new Avatar(scene);
    const frame = makeTrackedFrame();
    avatar.updateFromTracking(frame);

    const forearm = getSegment(avatar, 'leftForearm');
    const positionBefore = forearm.position.clone();

    // Simulate the tracker dropping out (e.g. RECOVERING/LOST — see TrackingManager).
    avatar.updateFromTracking({ ...frame, present: false });

    expect(avatar.root.visible).toBe(false);
    expect(forearm.position.equals(positionBefore)).toBe(true);
  });

  it('setVisible(false) overrides tracking presence', () => {
    const scene = new Scene();
    const avatar = new Avatar(scene);
    avatar.setVisible(false);
    avatar.updateFromTracking(makeTrackedFrame());
    expect(avatar.root.visible).toBe(false);
  });

  it('setDisplayMode swaps material and joint-marker/head visibility without recreating meshes', () => {
    const scene = new Scene();
    const avatar = new Avatar(scene);
    avatar.updateFromTracking(makeTrackedFrame());

    const forearm = getSegment(avatar, 'leftForearm');
    const head = getSegment(avatar, 'head');
    const geometryBefore = forearm.geometry;
    const mannequinEmissive = (forearm.material as MeshStandardMaterial).emissiveIntensity;

    avatar.setDisplayMode('skeleton');

    expect(forearm.geometry).toBe(geometryBefore); // same geometry instance — never recreated
    expect((forearm.material as MeshStandardMaterial).emissiveIntensity).not.toBe(mannequinEmissive);
    expect(head.visible).toBe(false);
    expect(avatar.getDisplayMode()).toBe('skeleton');

    const jointMarkers = avatar.root.getObjectByName('avatarJointMarkers');
    expect(jointMarkers?.visible).toBe(true);
  });

  it('reset() returns to hidden, identity transform, full opacity', () => {
    const scene = new Scene();
    const avatar = new Avatar(scene);
    avatar.updateFromTracking(makeTrackedFrame());
    avatar.setPosition(1, 2, 3);
    avatar.setRotation(0.1, 0.2, 0.3);
    avatar.setScale(2);
    avatar.setOpacity(0.5);

    avatar.reset();

    expect(avatar.root.visible).toBe(false);
    expect(avatar.root.position.toArray()).toEqual([0, 0, 0]);
    expect(avatar.root.rotation.toArray().slice(0, 3)).toEqual([0, 0, 0]);
    expect(avatar.root.scale.x).toBe(1);

    // Opacity reset back to fully opaque should show up on a mesh's material.
    const forearm = getSegment(avatar, 'leftForearm');
    expect((forearm.material as MeshStandardMaterial).opacity).toBe(1);
  });

  it('reuses one shared geometry across every limb segment (no per-segment geometry duplication)', () => {
    const scene = new Scene();
    const avatar = new Avatar(scene);
    for (const name of ['neck', 'upperTorso', 'lowerTorso', 'leftThigh', 'rightForearm', 'rightFoot']) {
      expect(getSegment(avatar, name).geometry).toBe(SEGMENT_GEOMETRY);
    }
  });

  it('casts shadows so the existing floor/light can render a soft ground shadow', () => {
    const scene = new Scene();
    const avatar = new Avatar(scene);
    expect(getSegment(avatar, 'leftThigh').castShadow).toBe(true);
    expect(getSegment(avatar, 'head').castShadow).toBe(true);
  });
});
