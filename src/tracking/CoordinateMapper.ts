import { Vector3, type PerspectiveCamera } from 'three';
import type { NormalizedLandmark } from '../types/vision';
import { clamp, computeCoverCrop, type CoverCropRect } from '../utils/math';
import { transformLandmarkForRender } from './transformLandmarkForRender';

const BASE_DEPTH = 2.5;
const MIN_DEPTH = 0.6;
const MAX_DEPTH = 6;

/**
 * Converts normalized MediaPipe landmarks (image space, no reliable depth)
 * plus metric world landmarks (relative depth) into Three.js scene-space
 * positions in front of the given perspective camera.
 *
 * This is the app's one explicit coordinate transformation layer. Every
 * landmark passes through the same three stages, in order:
 *
 *   raw MediaPipe coordinate
 *     -> normalized tracking coordinate  (re-based onto the visible
 *        `object-fit: cover` crop region; see computeCoverCrop)
 *     -> render coordinate               (front-camera mirror applied;
 *        see transformLandmarkForRender)
 *     -> world position                  (perspective-projected into the
 *        Three.js scene at a depth derived from the metric world landmark)
 *
 * No other module in the app is allowed to flip an x-coordinate — see
 * transformLandmarkForRender's doc comment for why that matters.
 */
export class CoordinateMapper {
  private readonly camera: PerspectiveCamera;
  private videoAspect = 16 / 9;
  private cameraMirrored = true;
  private cropRect: CoverCropRect = { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };

  constructor(camera: PerspectiveCamera) {
    this.camera = camera;
    this.updateCrop();
  }

  setVideoAspect(aspect: number): void {
    this.videoAspect = aspect;
    this.updateCrop();
  }

  /**
   * Single source of truth for front-camera mirroring. Must match whatever
   * CSS mirror state is applied to the <video> element (see
   * CameraScreen.setMirrored) — this class only ever mirrors the render
   * coordinate in software, never via CSS.
   */
  setCameraMirrored(cameraMirrored: boolean): void {
    this.cameraMirrored = cameraMirrored;
  }

  isCameraMirrored(): boolean {
    return this.cameraMirrored;
  }

  /** Call whenever the render viewport (camera.aspect) changes, e.g. on resize. */
  notifyViewportChanged(): void {
    this.updateCrop();
  }

  private updateCrop(): void {
    this.cropRect = computeCoverCrop(this.videoAspect, this.camera.aspect);
  }

  /** Stage 1 -> 2: raw MediaPipe x -> normalized tracking x (crop-region-relative, still unmirrored). */
  private toTrackingX(rawX: number): number {
    const { xMin, xMax } = this.cropRect;
    return (rawX - xMin) / (xMax - xMin);
  }

  private toTrackingY(rawY: number): number {
    const { yMin, yMax } = this.cropRect;
    return (rawY - yMin) / (yMax - yMin);
  }

  /**
   * Stage 2 -> 3: normalized tracking x -> render x (mirror applied).
   * Exposed for the developer diagnostic overlay; not used elsewhere.
   */
  computeRenderX(rawX: number): number {
    return transformLandmarkForRender(this.toTrackingX(rawX), this.cameraMirrored);
  }

  /** Stage 1 -> 4: full pipeline for one joint, ending in a Three.js world position. */
  mapJoint(landmark: NormalizedLandmark, worldLandmark: NormalizedLandmark, target: Vector3): Vector3 {
    const trackingX = this.toTrackingX(landmark.x);
    const trackingY = this.toTrackingY(landmark.y);
    const renderX = transformLandmarkForRender(trackingX, this.cameraMirrored);
    const renderY = trackingY; // vertical axis is never mirrored

    const depth = clamp(BASE_DEPTH + worldLandmark.z, MIN_DEPTH, MAX_DEPTH);
    const verticalFovRad = (this.camera.fov * Math.PI) / 180;
    const height = 2 * depth * Math.tan(verticalFovRad / 2);
    const width = height * this.camera.aspect;

    return target.set((renderX - 0.5) * width, (0.5 - renderY) * height, -depth);
  }
}

/** Shared scratch vector to avoid per-joint, per-frame allocations. */
export const MAPPER_SCRATCH = new Vector3();
