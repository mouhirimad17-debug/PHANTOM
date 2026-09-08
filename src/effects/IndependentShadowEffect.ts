import { Mesh, MeshBasicMaterial, type Scene, Vector3 } from 'three';
import { Avatar } from '../avatar/Avatar';
import { SPHERE_GEOMETRY } from '../avatar/avatarGeometry';
import { TrackingHistory } from '../tracking/TrackingHistory';
import { computeDerivedFields, createTrackingFrame } from '../tracking/trackingFrame';
import { POSE_LANDMARK_COUNT, type TrackingFrame } from '../types/tracking';
import { PoseLandmark } from '../utils/poseLandmarks';
import { clamp } from '../utils/math';
import type { Effect } from './Effect';

export interface IndependentShadowParams {
  /** Spring stiffness pulling the shadow toward its (delayed) target — higher = snaps into place faster. */
  followStrength: number;
  /** How far back in time, in milliseconds, the shadow's target pose is sampled from. */
  delayMilliseconds: number;
  /** Lateral (X) offset of the whole shadow from the live avatar, in scene units. */
  horizontalOffset: number;
  /** 0..1 — how much each joint is pulled toward the virtual floor. 0 = not flattened, 1 = pinned flat to the floor. */
  verticalFlatten: number;
  /** Extra yaw twist (radians) applied to the whole shadow, on top of its tracked orientation. */
  rotationOffset: number;
  /** 0..1 shadow material opacity. */
  opacity: number;
  /** 0..1 — how much extremities (hands, feet, elbows...) are allowed to lag/settle independently of the core (shoulders/hips). Deterministic — see DRIFT_FACTOR_BY_LANDMARK. */
  driftAmount: number;
  /** Spring damping — higher = overshoot/wobble settles to a stop faster. */
  recoverySpeed: number;
}

export const DEFAULT_INDEPENDENT_SHADOW_PARAMS: Readonly<IndependentShadowParams> = {
  followStrength: 6,
  delayMilliseconds: 220,
  horizontalOffset: 0.35,
  verticalFlatten: 0.55,
  rotationOffset: -0.3,
  opacity: 0.55,
  driftAmount: 0.45,
  recoverySpeed: 4,
};

// Clamp ranges keep the spring numerically stable and stop the illusion from
// ever fully detaching, however a control (e.g. the sensitivity slider) is
// driven — see the class doc below.
const PARAM_RANGES: Record<keyof IndependentShadowParams, readonly [number, number]> = {
  followStrength: [0.5, 20],
  delayMilliseconds: [0, 1000],
  horizontalOffset: [-1.5, 1.5],
  verticalFlatten: [0, 1],
  rotationOffset: [-Math.PI / 2, Math.PI / 2],
  opacity: [0, 1],
  driftAmount: [0, 1],
  recoverySpeed: [0.5, 20],
};

/**
 * Per-landmark "how independent this joint is allowed to feel," 0 (kept
 * tight to the target, anchor-like) to 1 (loosest). Fixed and deterministic
 * — never randomness. Modeled on the animation principle of "follow-
 * through / overlapping action": extremities lag behind and settle later
 * than the core. This is what makes "raise an arm and the shadow doesn't
 * perfectly copy it" happen without ever looking broken — shoulders and
 * hips stay anchored so the silhouette never detaches, while hands and feet
 * visibly trail.
 */
const DRIFT_FACTOR_BY_LANDMARK: Partial<Record<number, number>> = {
  [PoseLandmark.NOSE]: 0.2,
  [PoseLandmark.LEFT_SHOULDER]: 0.05,
  [PoseLandmark.RIGHT_SHOULDER]: 0.05,
  [PoseLandmark.LEFT_HIP]: 0.05,
  [PoseLandmark.RIGHT_HIP]: 0.05,
  [PoseLandmark.LEFT_ELBOW]: 0.35,
  [PoseLandmark.RIGHT_ELBOW]: 0.35,
  [PoseLandmark.LEFT_KNEE]: 0.3,
  [PoseLandmark.RIGHT_KNEE]: 0.3,
  [PoseLandmark.LEFT_WRIST]: 0.75,
  [PoseLandmark.RIGHT_WRIST]: 0.75,
  [PoseLandmark.LEFT_ANKLE]: 0.6,
  [PoseLandmark.RIGHT_ANKLE]: 0.6,
  [PoseLandmark.LEFT_INDEX]: 1,
  [PoseLandmark.RIGHT_INDEX]: 1,
  [PoseLandmark.LEFT_FOOT_INDEX]: 0.8,
  [PoseLandmark.RIGHT_FOOT_INDEX]: 0.8,
};
const DEFAULT_DRIFT_FACTOR = 0.15;

/** However high driftAmount goes, never reduce effective stiffness/damping below this fraction of their base value — keeps the spring stable and the shadow from ever fully detaching. */
const MIN_STIFFNESS_FRACTION = 0.25;
const DRIFT_REDUCTION_STRENGTH = 0.75;

/** Safety clamp on the integration step: a huge dt (e.g. a backgrounded tab resuming) must never make the spring overshoot wildly and read as a glitch. */
const MAX_DELTA_SECONDS = 0.1;

// Comfortably covers the clamped delayMilliseconds range above, so
// getAtOffset() is never asked to reach further back than history holds.
const HISTORY_MAX_DURATION_MS = 1200;

const CONTACT_BLOB_RADIUS_FACTOR = 0.4;
const CONTACT_BLOB_THICKNESS = 0.01;
const CONTACT_BLOB_Y_EPSILON = 0.015;
const CONTACT_BLOB_OPACITY = 0.45;
const MIN_BODY_SCALE = 0.05;

function clampParam(key: keyof IndependentShadowParams, value: number): number {
  const [min, max] = PARAM_RANGES[key];
  return clamp(value, min, max);
}

/**
 * INDEPENDENT SHADOW — a visual illusion, not a physical simulation: a dark,
 * flattened duplicate of the tracked body that trails the live avatar with a
 * short delay and settles into place rather than snapping, as if its own
 * shadow had taken on a will of its own. All motion is deterministic (a
 * time delay plus a damped spring, never `Math.random()`) so it reads as
 * *intentional* rather than glitchy, and the core joints (shoulders, hips)
 * are always kept closest to the real target so the illusion never
 * detaches far enough to look broken.
 *
 * Implementation: owns a second `Avatar` (in 'shadow' display mode) and
 * feeds it a synthetic `TrackingFrame` this effect computes itself each
 * update — reusing 100% of Avatar's existing per-limb quaternion/geometry
 * machinery rather than rendering anything bespoke.
 */
export class IndependentShadowEffect implements Effect {
  private readonly shadowAvatar: Avatar;
  private readonly floorY: number;
  private readonly history = new TrackingHistory(HISTORY_MAX_DURATION_MS);
  private readonly shadowFrame: TrackingFrame = createTrackingFrame();
  private readonly velocities: Vector3[] = Array.from({ length: POSE_LANDMARK_COUNT }, () => new Vector3());
  private readonly contactMaterial: MeshBasicMaterial;
  private readonly leftContactBlob: Mesh;
  private readonly rightContactBlob: Mesh;

  private params: IndependentShadowParams = { ...DEFAULT_INDEPENDENT_SHADOW_PARAMS };
  private enabled = false;
  private initialized = false;

  constructor(scene: Scene, floorY: number) {
    this.floorY = floorY;

    this.shadowAvatar = new Avatar(scene);
    this.shadowAvatar.setDisplayMode('shadow');
    this.shadowAvatar.setOpacity(this.params.opacity);

    this.contactMaterial = new MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: CONTACT_BLOB_OPACITY,
      depthWrite: false,
    });
    this.leftContactBlob = new Mesh(SPHERE_GEOMETRY, this.contactMaterial);
    this.rightContactBlob = new Mesh(SPHERE_GEOMETRY, this.contactMaterial);
    this.leftContactBlob.name = 'shadowLeftContactBlob';
    this.rightContactBlob.name = 'shadowRightContactBlob';
    this.shadowAvatar.root.add(this.leftContactBlob, this.rightContactBlob);
  }

  enable(): void {
    this.enabled = true;
    // disable() below turns the shadow avatar's own visibility override
    // off; undo that here so a disable() -> enable() cycle actually shows
    // it again (updateFromTracking() only ever reads that override, never
    // sets it).
    this.shadowAvatar.setVisible(true);
  }

  disable(): void {
    this.enabled = false;
    this.shadowAvatar.setVisible(false);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Merges in any provided parameters (clamped to safe ranges); omitted keys are left unchanged. */
  configure(partial: Partial<IndependentShadowParams>): void {
    for (const key of Object.keys(partial) as Array<keyof IndependentShadowParams>) {
      const value = partial[key];
      if (value === undefined) continue;
      this.params[key] = clampParam(key, value);
    }
  }

  getParams(): Readonly<IndependentShadowParams> {
    return this.params;
  }

  update(deltaTimeSeconds: number, trackingFrame: TrackingFrame): void {
    if (!this.enabled) return;

    if (!trackingFrame.present) {
      this.shadowFrame.present = false;
      this.shadowFrame.state = 'LOST';
      this.shadowAvatar.updateFromTracking(this.shadowFrame);
      return;
    }

    this.history.push(trackingFrame);
    const target = this.history.getAtOffset(this.params.delayMilliseconds) ?? trackingFrame;
    const dt = clamp(deltaTimeSeconds, 0, MAX_DELTA_SECONDS);

    for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
      const targetJoint = target.landmarks[i]!;
      const shadowJoint = this.shadowFrame.landmarks[i]!;
      const flatY = targetJoint.position.y + (this.floorY - targetJoint.position.y) * this.params.verticalFlatten;

      if (!this.initialized) {
        shadowJoint.position.set(targetJoint.position.x, flatY, targetJoint.position.z);
        this.velocities[i]!.set(0, 0, 0);
      } else {
        const driftFactor = DRIFT_FACTOR_BY_LANDMARK[i] ?? DEFAULT_DRIFT_FACTOR;
        const reduction = Math.max(
          MIN_STIFFNESS_FRACTION,
          1 - this.params.driftAmount * driftFactor * DRIFT_REDUCTION_STRENGTH,
        );
        const stiffness = this.params.followStrength * reduction;
        const damping = this.params.recoverySpeed * reduction;

        const velocity = this.velocities[i]!;
        const position = shadowJoint.position;

        const accelerationX = stiffness * (targetJoint.position.x - position.x) - damping * velocity.x;
        velocity.x += accelerationX * dt;
        position.x += velocity.x * dt;

        const accelerationY = stiffness * (flatY - position.y) - damping * velocity.y;
        velocity.y += accelerationY * dt;
        position.y += velocity.y * dt;

        const accelerationZ = stiffness * (targetJoint.position.z - position.z) - damping * velocity.z;
        velocity.z += accelerationZ * dt;
        position.z += velocity.z * dt;
      }

      shadowJoint.visibility = targetJoint.visibility;
    }

    this.initialized = true;
    this.shadowFrame.present = true;
    this.shadowFrame.state = 'TRACKING';
    this.shadowFrame.confidence = target.confidence;
    this.shadowFrame.timestampMs = trackingFrame.timestampMs;
    computeDerivedFields(this.shadowFrame);

    this.shadowAvatar.updateFromTracking(this.shadowFrame);
    this.shadowAvatar.setPosition(this.params.horizontalOffset, 0, 0);
    this.shadowAvatar.setRotation(0, this.params.rotationOffset, 0);
    this.shadowAvatar.setOpacity(this.params.opacity);
    this.updateContactBlobs();
  }

  private updateContactBlobs(): void {
    const f = this.shadowFrame;
    const bodyScale = Math.max(f.bodyScale, MIN_BODY_SCALE);
    const radius = bodyScale * CONTACT_BLOB_RADIUS_FACTOR;
    const y = this.floorY + CONTACT_BLOB_Y_EPSILON;

    this.leftContactBlob.position.set(f.leftAnkle.position.x, y, f.leftAnkle.position.z);
    this.leftContactBlob.scale.set(radius, CONTACT_BLOB_THICKNESS, radius);

    this.rightContactBlob.position.set(f.rightAnkle.position.x, y, f.rightAnkle.position.z);
    this.rightContactBlob.scale.set(radius, CONTACT_BLOB_THICKNESS, radius);
  }

  /** Returns to a clean, just-constructed state: hidden, no held pose/velocity/history. */
  reset(): void {
    this.enabled = false;
    this.initialized = false;
    this.history.clear();
    for (const velocity of this.velocities) velocity.set(0, 0, 0);
    this.shadowAvatar.reset(); // note: Avatar.reset() also resets opacity to 1, so re-apply ours right after
    this.shadowAvatar.setOpacity(this.params.opacity);
  }

  dispose(): void {
    this.shadowAvatar.dispose();
    this.contactMaterial.dispose();
  }
}
