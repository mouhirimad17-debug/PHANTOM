import { Vector3, type PerspectiveCamera } from 'three';
import { POSE_LANDMARK_COUNT, type MirrorDiagnostics, type TrackingFrame } from '../types/tracking';
import type { RawPoseFrame } from '../types/vision';
import { CoordinateMapper, MAPPER_SCRATCH } from './CoordinateMapper';
import { LandmarkSmoother } from './LandmarkSmoother';
import { PoseLandmark } from '../utils/poseLandmarks';

const SMOOTHING_ALPHA = 0.45;
/** How long to keep holding the last known pose after tracking drops before declaring it lost. */
const LOSS_GRACE_MS = 600;
/** Landmark tracked by the temporary DEBUG-panel mirroring diagnostic. */
const DIAGNOSTIC_LANDMARK_INDEX: number = PoseLandmark.RIGHT_WRIST;

/**
 * Turns raw per-frame MediaPipe output into a stable TrackingFrame: smoothed,
 * mapped into Three.js scene space, and resilient to brief detection dropouts.
 * The returned TrackingFrame object identity never changes across calls —
 * its contents are mutated in place — so consumers must read it synchronously
 * each frame rather than caching it.
 */
export class TrackingManager {
  private readonly mapper: CoordinateMapper;
  private readonly smoother = new LandmarkSmoother(SMOOTHING_ALPHA);
  private readonly frame: TrackingFrame;
  private lastSeenAtMs = -Infinity;
  private diagnostics: MirrorDiagnostics | null = null;

  constructor(camera: PerspectiveCamera) {
    this.mapper = new CoordinateMapper(camera);
    this.frame = {
      joints: Array.from({ length: POSE_LANDMARK_COUNT }, () => ({ position: new Vector3(), visibility: 0 })),
      present: false,
      confidence: 0,
      timestampMs: 0,
      lost: false,
    };
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

  update(raw: RawPoseFrame | null, nowMs: number): TrackingFrame {
    if (raw) {
      this.lastSeenAtMs = nowMs;
      let totalVisibility = 0;
      let visibleCount = 0;

      for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
        const landmark = raw.landmarks[i];
        const worldLandmark = raw.worldLandmarks[i];
        const joint = this.frame.joints[i];
        if (!landmark || !worldLandmark) {
          joint.visibility = 0;
          continue;
        }

        const sample = this.mapper.mapJoint(landmark, worldLandmark, MAPPER_SCRATCH);
        this.smoother.apply(i, joint.position, sample);
        joint.visibility = landmark.visibility ?? 1;
        totalVisibility += joint.visibility;
        visibleCount++;
      }

      this.frame.present = true;
      this.frame.lost = false;
      this.frame.confidence = visibleCount > 0 ? totalVisibility / visibleCount : 0;
      this.frame.timestampMs = raw.timestampMs;

      const diagnosticLandmark = raw.landmarks[DIAGNOSTIC_LANDMARK_INDEX];
      this.diagnostics = diagnosticLandmark
        ? {
            landmarkIndex: DIAGNOSTIC_LANDMARK_INDEX,
            rawX: diagnosticLandmark.x,
            renderX: this.mapper.computeRenderX(diagnosticLandmark.x),
            cameraMirrored: this.mapper.isCameraMirrored(),
          }
        : null;

      return this.frame;
    }

    const elapsedSinceSeen = nowMs - this.lastSeenAtMs;
    if (elapsedSinceSeen > LOSS_GRACE_MS) {
      this.frame.present = false;
      this.frame.lost = this.lastSeenAtMs !== -Infinity;
      this.frame.confidence = 0;
    }
    // Within the grace period: keep exposing the last known smoothed pose
    // (present stays true) so brief dropouts don't cause visible flicker.
    this.frame.timestampMs = nowMs;
    return this.frame;
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
    this.frame.present = false;
    this.frame.lost = false;
    this.frame.confidence = 0;
    this.diagnostics = null;
  }
}
