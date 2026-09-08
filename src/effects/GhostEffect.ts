import { InstancedMesh, MeshBasicMaterial, Object3D, type Scene } from 'three';
import { Avatar } from '../avatar/Avatar';
import { SPHERE_GEOMETRY } from '../avatar/avatarGeometry';
import { TrackingHistory } from '../tracking/TrackingHistory';
import { copyTrackingFrame, createTrackingFrame } from '../tracking/trackingFrame';
import type { TrackingFrame } from '../types/tracking';
import { PoseLandmark } from '../utils/poseLandmarks';
import { clamp } from '../utils/math';
import type { Effect } from './Effect';

export interface GhostParams {
  /** 0..1 base material opacity — the ghost's overall translucency. */
  opacity: number;
  /** How far back in time, in milliseconds, the ghost's pose is sampled from. 0 = live pose (delay is optional, off by default feel — see DEFAULT_GHOST_PARAMS). */
  delayMilliseconds: number;
  /** 0..2 multiplier on the ghost material's emissive accent — see Avatar.setGlowIntensity(). */
  glowStrength: number;
  /** Whether the fading motion-trail echoes render at all. */
  trailEnabled: boolean;
  /** 0..1 — how pronounced the trail echoes are (opacity and size) when trailEnabled is true. */
  trailStrength: number;
}

export const DEFAULT_GHOST_PARAMS: Readonly<GhostParams> = {
  opacity: 0.4,
  delayMilliseconds: 90,
  glowStrength: 1,
  trailEnabled: true,
  trailStrength: 0.5,
};

// Clamp ranges keep the effect numerically stable and visually restrained
// (see the class doc's "do not make it visually noisy" note) regardless of
// how a control is driven.
const PARAM_RANGES = {
  opacity: [0, 1] as const,
  delayMilliseconds: [0, 600] as const,
  glowStrength: [0, 2] as const,
  trailStrength: [0, 1] as const,
};

/** Safety clamp on the integration step: a huge dt (e.g. a backgrounded tab resuming) must never make the breathing/drift phase jump wildly. */
const MAX_DELTA_SECONDS = 0.1;

// Comfortably covers the clamped delayMilliseconds range above plus the
// trail's own lookback window, so getAtOffset() is never asked to reach
// further back than history holds.
const HISTORY_MAX_DURATION_MS = 900;

/** Subtle scale "breathing" — deterministic sinusoid, never Math.random(). Small enough to read as alive, not pulsing. */
const BREATH_AMPLITUDE = 0.035;
const BREATH_ANGULAR_FREQUENCY = 2 * Math.PI * 0.3; // ~0.3 Hz — a slow, calm breathing rate

/** Slight vertical drift — same deterministic-sinusoid approach as breathing, on a different frequency/phase so the two don't visually sync into one obvious pulse. */
const DRIFT_AMPLITUDE_FACTOR = 0.04; // scaled by bodyScale so it stays "slight" at any distance from the camera
const DRIFT_ANGULAR_FREQUENCY = 2 * Math.PI * 0.18;
const DRIFT_PHASE_OFFSET = Math.PI / 3;
const MIN_BODY_SCALE = 0.05;

/**
 * Key joints echoed by the motion trail — extremities read a trail far more
 * clearly than a core joint like the hips, and keeping the list short keeps
 * the trail's draw-call cost small (see ARCHITECTURE.md's performance
 * section).
 */
const TRAIL_LANDMARKS: readonly number[] = [
  PoseLandmark.NOSE,
  PoseLandmark.LEFT_WRIST,
  PoseLandmark.RIGHT_WRIST,
  PoseLandmark.LEFT_ANKLE,
  PoseLandmark.RIGHT_ANKLE,
];
const TRAIL_STEP_COUNT = 3;
const TRAIL_STEP_MS = 65;
const TRAIL_RADIUS_FACTOR = 0.11;
const TRAIL_BASE_OPACITY = 0.35;

function clampParam<K extends keyof typeof PARAM_RANGES>(key: K, value: number): number {
  const [min, max] = PARAM_RANGES[key];
  return clamp(value, min, max);
}

interface TrailStep {
  material: MeshBasicMaterial;
  /** One InstancedMesh covering every TRAIL_LANDMARKS joint for this step — a single draw call instead of one Mesh per joint (see the class doc's performance note). */
  mesh: InstancedMesh;
}

/**
 * GHOST — a translucent, glow-accented duplicate of the tracked body: a
 * "spectral" read rather than the dark, grounded IndependentShadowEffect or
 * the faithful, opaque-ish CloneEffect. Unlike IndependentShadowEffect,
 * there is no spring/follow physics here — the ghost's pose is either the
 * live frame or a single fixed historical sample (`delayMilliseconds`),
 * which is enough to feel "detached from time" without needing a physics
 * simulation.
 *
 * Implementation: owns one `Avatar` (in the 'ghost' display mode) fed a
 * frame copied directly from the live tracker or its own private
 * `TrackingHistory`, plus a small fixed pool of trail-echo spheres at a
 * handful of extremity joints for the motion trail — one `InstancedMesh`
 * per trail step (covering every echoed joint in that step in a single
 * draw call) rather than one `Mesh` per joint, since a profiling pass (see
 * ARCHITECTURE.md's performance section) showed the naive one-mesh-per-
 * joint version measurably more expensive under CPU throttling. No new
 * geometry is ever created after construction, and nothing here uses
 * `Math.random()` — the breathing and vertical-drift motion are both
 * deterministic sinusoids so two runs with identical input produce
 * identical output.
 *
 * Readability over both bright and dark backgrounds (an explicit
 * requirement) is why the ghost material and the trail material both use
 * normal alpha blending rather than `AdditiveBlending`: additive light adds
 * on top of the background, which reads as a strong highlight over a dark
 * scene but nearly vanishes over a bright one (there's little headroom left
 * to add to). Normal blending keeps the silhouette's opacity-based
 * visibility consistent regardless of what's behind it; the "additive/
 * emissive accent" requirement is met by driving the material's emissive
 * channel (`glowStrength`, via `Avatar.setGlowIntensity()`) instead of the
 * GPU blend mode — see the rationale comment on `createGhostMaterial()` in
 * avatarGeometry.ts.
 *
 * Performance is optimized the same way as every other effect in this
 * codebase: everything (the Avatar, the trail meshes, their materials) is
 * allocated exactly once, in the constructor; `update()` only mutates
 * existing transforms/materials. No render-target-based post-processing
 * (bloom, blur) is used anywhere — see ARCHITECTURE.md's performance
 * section for the full draw-call budget and mobile guidance.
 */
export class GhostEffect implements Effect {
  private readonly ghostAvatar: Avatar;
  private readonly history = new TrackingHistory(HISTORY_MAX_DURATION_MS);
  private readonly ghostFrame: TrackingFrame = createTrackingFrame();
  private readonly trailSteps: TrailStep[];
  // Reused every frame to build each instance's matrix — see Avatar's
  // jointMarkerDummy for the same pattern.
  private readonly trailDummy = new Object3D();

  private params: GhostParams = { ...DEFAULT_GHOST_PARAMS };
  private enabled = false;
  private elapsedSeconds = 0;

  constructor(scene: Scene) {
    this.ghostAvatar = new Avatar(scene);
    this.ghostAvatar.setDisplayMode('ghost');
    this.ghostAvatar.setOpacity(this.params.opacity);
    this.ghostAvatar.setGlowIntensity(this.params.glowStrength);

    this.trailSteps = Array.from({ length: TRAIL_STEP_COUNT }, () => {
      const material = new MeshBasicMaterial({
        color: 0x00ffc8,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new InstancedMesh(SPHERE_GEOMETRY, material, TRAIL_LANDMARKS.length);
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      return { material, mesh };
    });
  }

  enable(): void {
    this.enabled = true;
    // disable() below turns the ghost avatar's own visibility override
    // off; undo that here so a disable() -> enable() cycle actually shows
    // it again (updateFromTracking() only ever reads that override, never
    // sets it).
    this.ghostAvatar.setVisible(true);
  }

  disable(): void {
    this.enabled = false;
    this.ghostAvatar.setVisible(false);
    this.hideTrail();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Merges in any provided parameters (clamped to safe ranges); omitted keys are left unchanged. */
  configure(partial: Partial<GhostParams>): void {
    if (partial.opacity !== undefined) this.params.opacity = clampParam('opacity', partial.opacity);
    if (partial.delayMilliseconds !== undefined) {
      this.params.delayMilliseconds = clampParam('delayMilliseconds', partial.delayMilliseconds);
    }
    if (partial.glowStrength !== undefined) this.params.glowStrength = clampParam('glowStrength', partial.glowStrength);
    if (partial.trailEnabled !== undefined) this.params.trailEnabled = partial.trailEnabled;
    if (partial.trailStrength !== undefined) this.params.trailStrength = clampParam('trailStrength', partial.trailStrength);
  }

  getParams(): Readonly<GhostParams> {
    return this.params;
  }

  update(deltaTimeSeconds: number, trackingFrame: TrackingFrame): void {
    if (!this.enabled) return;

    if (!trackingFrame.present) {
      this.ghostFrame.present = false;
      this.ghostFrame.state = 'LOST';
      this.ghostAvatar.updateFromTracking(this.ghostFrame);
      this.hideTrail();
      return;
    }

    this.history.push(trackingFrame);
    this.elapsedSeconds += clamp(deltaTimeSeconds, 0, MAX_DELTA_SECONDS);

    const source =
      this.params.delayMilliseconds > 0
        ? (this.history.getAtOffset(this.params.delayMilliseconds) ?? trackingFrame)
        : trackingFrame;
    copyTrackingFrame(this.ghostFrame, source);
    this.ghostAvatar.updateFromTracking(this.ghostFrame);

    const bodyScale = Math.max(this.ghostFrame.bodyScale, MIN_BODY_SCALE);
    const breathScale = 1 + BREATH_AMPLITUDE * Math.sin(this.elapsedSeconds * BREATH_ANGULAR_FREQUENCY);
    const driftY =
      bodyScale * DRIFT_AMPLITUDE_FACTOR * Math.sin(this.elapsedSeconds * DRIFT_ANGULAR_FREQUENCY + DRIFT_PHASE_OFFSET);

    this.ghostAvatar.setScale(breathScale);
    this.ghostAvatar.setPosition(0, driftY, 0);
    this.ghostAvatar.setOpacity(this.params.opacity);
    this.ghostAvatar.setGlowIntensity(this.params.glowStrength);

    this.updateTrail(bodyScale, driftY);
  }

  private updateTrail(bodyScale: number, driftY: number): void {
    if (!this.params.trailEnabled) {
      this.hideTrail();
      return;
    }

    for (let step = 0; step < this.trailSteps.length; step++) {
      const trailStep = this.trailSteps[step]!;
      const stepFade = 1 - step / this.trailSteps.length;
      const historical = this.history.getAtOffset((step + 1) * TRAIL_STEP_MS);

      trailStep.material.opacity = TRAIL_BASE_OPACITY * this.params.trailStrength * stepFade;

      if (!historical) {
        trailStep.mesh.visible = false;
        continue;
      }

      const radius = bodyScale * TRAIL_RADIUS_FACTOR * stepFade;
      for (let j = 0; j < TRAIL_LANDMARKS.length; j++) {
        const jointPosition = historical.landmarks[TRAIL_LANDMARKS[j]!]!.position;
        this.trailDummy.position.set(jointPosition.x, jointPosition.y + driftY, jointPosition.z);
        this.trailDummy.scale.setScalar(radius);
        this.trailDummy.updateMatrix();
        trailStep.mesh.setMatrixAt(j, this.trailDummy.matrix);
      }
      trailStep.mesh.instanceMatrix.needsUpdate = true;
      trailStep.mesh.visible = true;
    }
  }

  private hideTrail(): void {
    for (const step of this.trailSteps) step.mesh.visible = false;
  }

  /** Returns to a clean, just-constructed state: disabled, hidden, no held pose/history, default parameters. */
  reset(): void {
    this.enabled = false;
    this.elapsedSeconds = 0;
    this.history.clear();
    this.params = { ...DEFAULT_GHOST_PARAMS };
    this.ghostAvatar.reset(); // note: Avatar.reset() also resets opacity/glow to defaults; re-applied right after for our own defaults
    this.ghostAvatar.setOpacity(this.params.opacity);
    this.ghostAvatar.setGlowIntensity(this.params.glowStrength);
    this.hideTrail();
  }

  dispose(): void {
    this.ghostAvatar.dispose();
    for (const step of this.trailSteps) {
      step.mesh.removeFromParent();
      step.material.dispose();
    }
  }
}
