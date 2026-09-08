import { type PerspectiveCamera } from 'three';
import { POSE_LANDMARK_COUNT, type MirrorDiagnostics, type TrackingFrame, type TrackingState } from '../types/tracking';
import type { RawPoseFrame } from '../types/vision';
import { CoordinateMapper, MAPPER_SCRATCH } from './CoordinateMapper';
import { LandmarkSmoother } from './LandmarkSmoother';
import { computeDerivedFields, createTrackingFrame } from './trackingFrame';
import { PoseLandmark } from '../utils/poseLandmarks';

/** How long to keep holding the last known pose (state RECOVERING) before declaring it LOST. */
const LOSS_GRACE_MS = 600;
/** Landmark tracked by the temporary DEBUG-panel mirroring diagnostic. */
const DIAGNOSTIC_LANDMARK_INDEX: number = PoseLandmark.RIGHT_WRIST;

/**
 * Turns raw per-frame MediaPipe output into a stable TrackingFrame: smoothed,
 * mapped into Three.js scene space, resilient to brief detection dropouts
 * (state machine: INITIALIZING -> TRACKING -> RECOVERING -> LOST, and back
 * to TRACKING), and carrying derived spatial values (bodyCenter, torso
 * rotation, approximate scale) ready for effects/avatar work.
 *
 * The returned TrackingFrame object identity never changes across calls —
 * its contents are mutated in place — so consumers must read it
 * synchronously each frame rather than caching it. To keep independent
 * snapshots over time, push it into a TrackingHistory instead.
 */
export class TrackingManager {
  private readonly mapper: CoordinateMapper;
  private readonly smoother = new LandmarkSmoother();
  private readonly frame: TrackingFrame = createTrackingFrame();
  private lastSeenAtMs = -Infinity;
  private diagnostics: MirrorDiagnostics | null = null;

  constructor(camera: PerspectiveCamera) {
    this.mapper = new CoordinateMapper(camera);
  }

  setVideoAspect(aspect: number): void {
    this.mapper.setVideoAspect(aspect);
  }

  setCameraMirrored(cameraMirrored: boolean): void {
    this.mapper.setCameraMirrored(cameraMirrored);
  }

  notifyViewportChanged(): void {
    this.mapper.notifyViewportChanged();
  }

  /** Configurable smoothing strength, 0 (most responsive) .. 1 (heaviest smoothing). See LandmarkSmoother. */
  setSmoothingStrength(strength: number): void {
    this.smoother.setSmoothingStrength(strength);
  }

  update(raw: RawPoseFrame | null, nowMs: number): TrackingFrame {
    if (raw) {
      this.applyDetection(raw, nowMs);
    } else {
      this.applyDropout(nowMs);
    }

    this.frame.present = this.frame.state === 'TRACKING' || this.frame.state === 'RECOVERING';
    this.frame.lost = this.frame.state === 'LOST';
    return this.frame;
  }

  private applyDetection(raw: RawPoseFrame, nowMs: number): void {
    // A long gap (state was LOST, or this is the very first detection ever)
    // means the smoother's filter history is stale or nonexistent — reset it
    // so the pose snaps immediately to the new detection instead of slowly
    // dragging in from wherever it last was (see LandmarkSmoother.reset()).
    // A short RECOVERING gap intentionally does NOT reset: the filters'
    // continuity across that gap is what makes recovery from a one-frame
    // dropout look smooth rather than jumpy.
    if (this.frame.state === 'LOST' || this.frame.state === 'INITIALIZING') {
      this.smoother.reset();
    }

    this.lastSeenAtMs = nowMs;
    let totalVisibility = 0;
    let visibleCount = 0;

    for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
      const landmark = raw.landmarks[i];
      const worldLandmark = raw.worldLandmarks[i];
      const joint = this.frame.landmarks[i]!;
      if (!landmark || !worldLandmark) {
        joint.visibility = 0;
        continue;
      }

      const sample = this.mapper.mapJoint(landmark, worldLandmark, MAPPER_SCRATCH);
      this.smoother.apply(i, joint.position, sample, nowMs);
      joint.visibility = landmark.visibility ?? 1;
      totalVisibility += joint.visibility;
      visibleCount++;
    }

    this.frame.state = 'TRACKING';
    this.frame.confidence = visibleCount > 0 ? totalVisibility / visibleCount : 0;
    this.frame.timestampMs = raw.timestampMs;
    computeDerivedFields(this.frame);

    const diagnosticLandmark = raw.landmarks[DIAGNOSTIC_LANDMARK_INDEX];
    this.diagnostics = diagnosticLandmark
      ? {
          landmarkIndex: DIAGNOSTIC_LANDMARK_INDEX,
          rawX: diagnosticLandmark.x,
          renderX: this.mapper.computeRenderX(diagnosticLandmark.x),
          cameraMirrored: this.mapper.isCameraMirrored(),
        }
      : null;
  }

  private applyDropout(nowMs: number): void {
    const previousState: TrackingState = this.frame.state;
    if (previousState === 'INITIALIZING') {
      // Never detected a body yet this session; nothing to hold or recover.
      this.frame.timestampMs = nowMs;
      return;
    }

    const elapsedSinceSeenMs = nowMs - this.lastSeenAtMs;
    if (elapsedSinceSeenMs > LOSS_GRACE_MS) {
      this.frame.state = 'LOST';
      this.frame.confidence = 0;
    } else {
      this.frame.state = 'RECOVERING';
      // Intentionally keep holding the last known smoothed pose (landmarks,
      // derived fields untouched) so a brief dropout doesn't flicker.
    }
    this.frame.timestampMs = nowMs;
  }

  /** Current frame, read-only from the caller's perspective; mutated in place on each `update()`. */
  getFrame(): Readonly<TrackingFrame> {
    return this.frame;
  }

  /** Temporary developer diagnostic (see MirrorDiagnostics); null when no body is tracked. */
  getMirrorDiagnostics(): Readonly<MirrorDiagnostics> | null {
    return this.diagnostics;
  }

  reset(): void {
    this.smoother.reset();
    this.lastSeenAtMs = -Infinity;
    this.frame.state = 'INITIALIZING';
    this.frame.present = false;
    this.frame.lost = false;
    this.frame.confidence = 0;
    this.diagnostics = null;
  }
}
