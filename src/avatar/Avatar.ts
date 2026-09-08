import { Group, InstancedMesh, Mesh, Object3D, Quaternion, type Scene, Vector3 } from 'three';
import type { TrackingFrame } from '../types/tracking';
import { PoseLandmark } from '../utils/poseLandmarks';
import { computeSegmentTransform } from './limbMath';
import {
  createMannequinMaterial,
  createShadowMaterial,
  createSkeletonMaterial,
  SEGMENT_GEOMETRY,
  SPHERE_GEOMETRY,
} from './avatarGeometry';

/**
 * 'shadow': dark, minimally-emissive, transparent — for effects that render
 * a duplicate meant to read as "your shadow," not another body (see
 * effects/IndependentShadowEffect.ts). Uses the same full-body radius as
 * 'mannequin' (a shadow of a body is still body-shaped) — only the material
 * differs.
 */
export type AvatarDisplayMode = 'mannequin' | 'skeleton' | 'shadow';

/** Floor for bodyScale so a bad/zero reading can't collapse every segment to nothing. */
const MIN_BODY_SCALE = 0.05;

const HEAD_RADIUS_FACTOR_MANNEQUIN = 0.32;
const HEAD_RADIUS_FACTOR_SKELETON = 0.12;
const JOINT_MARKER_RADIUS_FACTOR = 0.16;

/** Joints marked with a small sphere in skeleton display mode. */
const JOINT_MARKER_LANDMARKS: readonly number[] = [
  PoseLandmark.NOSE,
  PoseLandmark.LEFT_SHOULDER,
  PoseLandmark.RIGHT_SHOULDER,
  PoseLandmark.LEFT_ELBOW,
  PoseLandmark.RIGHT_ELBOW,
  PoseLandmark.LEFT_WRIST,
  PoseLandmark.RIGHT_WRIST,
  PoseLandmark.LEFT_HIP,
  PoseLandmark.RIGHT_HIP,
  PoseLandmark.LEFT_KNEE,
  PoseLandmark.RIGHT_KNEE,
  PoseLandmark.LEFT_ANKLE,
  PoseLandmark.RIGHT_ANKLE,
];

type PointGetter = (frame: TrackingFrame) => Vector3;

interface LimbSegment {
  mesh: Mesh;
  getStart: PointGetter;
  getEnd: PointGetter;
  mannequinRadiusFactor: number;
  skeletonRadiusFactor: number;
}

/**
 * A lightweight procedural humanoid, built entirely from Three.js primitives
 * (no external 3D assets). Structure:
 *
 *   root
 *   ├─ torso group: head, neck, upper torso, lower torso, both arms
 *   └─ hips group: both legs
 *
 * Every limb is a single capsule mesh stretched and oriented between two
 * tracked joints each frame (see limbMath.ts) — there is no forward-
 * kinematic chain of rotations (each segment reads its own two endpoint
 * positions directly from the already-computed TrackingFrame, which are
 * independent per-joint scene positions, not a rigid rig), so one noisy
 * joint can only ever perturb the one or two segments touching it, never
 * propagate instability down a chain.
 *
 * All geometry is created once, in the constructor; `updateFromTracking()`
 * only ever mutates existing meshes' position/quaternion/scale.
 */
export class Avatar {
  readonly root = new Group();
  private readonly torsoGroup = new Group();
  private readonly hipsGroup = new Group();

  private readonly mannequinMaterial = createMannequinMaterial();
  private readonly skeletonMaterial = createSkeletonMaterial();
  private readonly shadowMaterial = createShadowMaterial();

  private readonly headMesh: Mesh;
  private readonly jointMarkers: InstancedMesh;
  private readonly limbs: LimbSegment[] = [];

  private displayMode: AvatarDisplayMode = 'mannequin';
  private visibleOverride = true;
  private lastPresent = false;

  // Reused every frame — see limbMath.ts and DebugSkeleton.ts for the same pattern.
  private readonly spineMidScratch = new Vector3();
  private readonly positionScratch = new Vector3();
  private readonly quaternionScratch = new Quaternion();
  private readonly jointMarkerDummy = new Object3D();

  constructor(scene: Scene) {
    this.root.name = 'avatarRoot';
    this.torsoGroup.name = 'avatarTorsoGroup';
    this.hipsGroup.name = 'avatarHipsGroup';
    this.root.add(this.torsoGroup, this.hipsGroup);
    this.root.visible = false; // nothing tracked yet
    scene.add(this.root);

    this.headMesh = new Mesh(SPHERE_GEOMETRY, this.mannequinMaterial);
    this.headMesh.name = 'head';
    this.headMesh.castShadow = true;
    this.torsoGroup.add(this.headMesh);

    this.jointMarkers = new InstancedMesh(SPHERE_GEOMETRY, this.skeletonMaterial, JOINT_MARKER_LANDMARKS.length);
    this.jointMarkers.name = 'avatarJointMarkers';
    this.jointMarkers.visible = false; // skeleton mode only
    this.jointMarkers.frustumCulled = false;
    this.root.add(this.jointMarkers);

    const spineMid: PointGetter = () => this.spineMidScratch;

    // Torso chain: neck, upper torso, lower torso.
    this.addLimb(
      'neck',
      this.torsoGroup,
      (f) => f.shoulderCenter,
      (f) => f.landmarks[PoseLandmark.NOSE]!.position,
      0.12,
      0.05,
    );
    this.addLimb('upperTorso', this.torsoGroup, (f) => f.shoulderCenter, spineMid, 0.55, 0.09);
    this.addLimb('lowerTorso', this.torsoGroup, spineMid, (f) => f.hipCenter, 0.5, 0.09);

    // Left arm: upper arm, forearm, hand.
    this.addLimb('leftUpperArm', this.torsoGroup, (f) => f.leftShoulder.position, (f) => f.leftElbow.position, 0.2, 0.07);
    this.addLimb('leftForearm', this.torsoGroup, (f) => f.leftElbow.position, (f) => f.leftWrist.position, 0.16, 0.06);
    this.addLimb(
      'leftHand',
      this.torsoGroup,
      (f) => f.leftWrist.position,
      (f) => f.landmarks[PoseLandmark.LEFT_INDEX]!.position,
      0.13,
      0.05,
    );

    // Right arm: upper arm, forearm, hand.
    this.addLimb(
      'rightUpperArm',
      this.torsoGroup,
      (f) => f.rightShoulder.position,
      (f) => f.rightElbow.position,
      0.2,
      0.07,
    );
    this.addLimb('rightForearm', this.torsoGroup, (f) => f.rightElbow.position, (f) => f.rightWrist.position, 0.16, 0.06);
    this.addLimb(
      'rightHand',
      this.torsoGroup,
      (f) => f.rightWrist.position,
      (f) => f.landmarks[PoseLandmark.RIGHT_INDEX]!.position,
      0.13,
      0.05,
    );

    // Left leg: thigh, shin, foot.
    this.addLimb('leftThigh', this.hipsGroup, (f) => f.leftHip.position, (f) => f.leftKnee.position, 0.28, 0.08);
    this.addLimb('leftShin', this.hipsGroup, (f) => f.leftKnee.position, (f) => f.leftAnkle.position, 0.2, 0.07);
    this.addLimb(
      'leftFoot',
      this.hipsGroup,
      (f) => f.leftAnkle.position,
      (f) => f.landmarks[PoseLandmark.LEFT_FOOT_INDEX]!.position,
      0.14,
      0.06,
    );

    // Right leg: thigh, shin, foot.
    this.addLimb('rightThigh', this.hipsGroup, (f) => f.rightHip.position, (f) => f.rightKnee.position, 0.28, 0.08);
    this.addLimb('rightShin', this.hipsGroup, (f) => f.rightKnee.position, (f) => f.rightAnkle.position, 0.2, 0.07);
    this.addLimb(
      'rightFoot',
      this.hipsGroup,
      (f) => f.rightAnkle.position,
      (f) => f.landmarks[PoseLandmark.RIGHT_FOOT_INDEX]!.position,
      0.14,
      0.06,
    );
  }

  private addLimb(
    name: string,
    parent: Group,
    getStart: PointGetter,
    getEnd: PointGetter,
    mannequinRadiusFactor: number,
    skeletonRadiusFactor: number,
  ): void {
    const mesh = new Mesh(SEGMENT_GEOMETRY, this.mannequinMaterial);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    this.limbs.push({ mesh, getStart, getEnd, mannequinRadiusFactor, skeletonRadiusFactor });
  }

  /**
   * Recomputes every segment's transform from the current tracking frame.
   * Safe to call every detection frame — allocates nothing (see the scratch
   * fields above). When `frame.present` is false, the avatar is hidden and
   * the previous pose is left exactly as-is (frozen, not reset) so it
   * doesn't glitch to a default pose while tracking briefly recovers.
   */
  updateFromTracking(frame: TrackingFrame): void {
    this.lastPresent = frame.present;
    this.applyVisibility();
    if (!frame.present) return;

    this.spineMidScratch.lerpVectors(frame.shoulderCenter, frame.hipCenter, 0.5);
    const bodyScale = Math.max(frame.bodyScale, MIN_BODY_SCALE);
    const useSkeleton = this.displayMode === 'skeleton';

    for (const limb of this.limbs) {
      const start = limb.getStart(frame);
      const end = limb.getEnd(frame);
      const length = computeSegmentTransform(start, end, this.positionScratch, this.quaternionScratch);
      limb.mesh.position.copy(this.positionScratch);
      limb.mesh.quaternion.copy(this.quaternionScratch);
      // 'shadow' mode shares the full-bodied mannequin radius — only the
      // material differs; flattening/offset is applied by the effect
      // driving this avatar, not by thinning the limbs.
      const radiusFactor = useSkeleton ? limb.skeletonRadiusFactor : limb.mannequinRadiusFactor;
      const radius = bodyScale * radiusFactor;
      limb.mesh.scale.set(radius, length, radius);
    }

    const headRadius = bodyScale * (useSkeleton ? HEAD_RADIUS_FACTOR_SKELETON : HEAD_RADIUS_FACTOR_MANNEQUIN);
    this.headMesh.position.copy(frame.landmarks[PoseLandmark.NOSE]!.position);
    this.headMesh.scale.setScalar(headRadius);

    if (useSkeleton) {
      this.updateJointMarkers(frame, bodyScale);
    }
  }

  private updateJointMarkers(frame: TrackingFrame, bodyScale: number): void {
    const radius = bodyScale * JOINT_MARKER_RADIUS_FACTOR;
    for (let i = 0; i < JOINT_MARKER_LANDMARKS.length; i++) {
      const joint = frame.landmarks[JOINT_MARKER_LANDMARKS[i]!]!;
      this.jointMarkerDummy.position.copy(joint.position);
      this.jointMarkerDummy.scale.setScalar(radius);
      this.jointMarkerDummy.updateMatrix();
      this.jointMarkers.setMatrixAt(i, this.jointMarkerDummy.matrix);
    }
    this.jointMarkers.instanceMatrix.needsUpdate = true;
  }

  /** Switches between the full-bodied mannequin look, a thin debug-style skeleton look, and a dark "shadow" look. Swaps material references only — never recreates meshes. */
  setDisplayMode(mode: AvatarDisplayMode): void {
    if (this.displayMode === mode) return;
    this.displayMode = mode;

    const material =
      mode === 'mannequin' ? this.mannequinMaterial : mode === 'skeleton' ? this.skeletonMaterial : this.shadowMaterial;
    for (const limb of this.limbs) {
      limb.mesh.material = material;
    }
    this.headMesh.material = material;
    this.headMesh.visible = mode !== 'skeleton';
    this.jointMarkers.visible = mode === 'skeleton';
  }

  getDisplayMode(): AvatarDisplayMode {
    return this.displayMode;
  }

  setPosition(x: number, y: number, z: number): void {
    this.root.position.set(x, y, z);
  }

  /**
   * Whole-avatar orientation override, as Euler angles. This is safe where
   * per-limb Euler angles would not be: it's one independent transform
   * applied once, not a chain of dependent joint rotations accumulating
   * error/gimbal lock — see limbMath.ts for why the limbs themselves use
   * quaternions instead.
   */
  setRotation(x: number, y: number, z: number): void {
    this.root.rotation.set(x, y, z);
  }

  setScale(scale: number): void {
    this.root.scale.setScalar(scale);
  }

  /** User/effect-level visibility override, independent of tracking presence — the avatar is only ever actually shown when both this AND the tracker report present. */
  setVisible(visible: boolean): void {
    this.visibleOverride = visible;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    this.root.visible = this.visibleOverride && this.lastPresent;
  }

  setOpacity(opacity: number): void {
    const clamped = Math.max(0, Math.min(1, opacity));
    const transparent = clamped < 1;
    this.mannequinMaterial.transparent = transparent;
    this.mannequinMaterial.opacity = clamped;
    this.skeletonMaterial.transparent = transparent;
    this.skeletonMaterial.opacity = clamped;
    this.shadowMaterial.transparent = true; // shadow mode is always at least slightly transparent
    this.shadowMaterial.opacity = clamped;
  }

  /** Returns the avatar to its just-constructed state: hidden, identity transform, opaque, ready for a new tracking session. */
  reset(): void {
    this.lastPresent = false;
    this.visibleOverride = true;
    this.root.visible = false;
    this.root.position.set(0, 0, 0);
    this.root.rotation.set(0, 0, 0);
    this.root.scale.setScalar(1);
    this.setOpacity(1);
  }

  /** Releases this instance's own materials (the shared geometries are never disposed — see avatarGeometry.ts) and detaches from the scene. */
  dispose(): void {
    this.mannequinMaterial.dispose();
    this.skeletonMaterial.dispose();
    this.shadowMaterial.dispose();
    this.root.removeFromParent();
  }
}
