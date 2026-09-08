import { Vector3, type PerspectiveCamera } from 'three';
import type { NormalizedLandmark } from '../types/vision';
import { clamp, computeCoverCrop, type CoverCropRect } from '../utils/math';

const BASE_DEPTH = 2.5;
const MIN_DEPTH = 0.6;
const MAX_DEPTH = 6;

/**
 * Converts normalized MediaPipe landmarks (image space, no reliable depth)
 * plus metric world landmarks (relative depth) into Three.js scene-space
 * positions in front of the given perspective camera.
 *
 * Accounts for `object-fit: cover` cropping between the camera's native
 * aspect ratio and the on-screen viewport, and for horizontal mirroring of
 * the front-facing camera, so overlay geometry lines up with what the user
 * sees on screen.
 */
export class CoordinateMapper {
  private readonly camera: PerspectiveCamera;
  private videoAspect = 16 / 9;
  private mirrored = true;
  private cropRect: CoverCropRect = { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };

  constructor(camera: PerspectiveCamera) {
    this.camera = camera;
    this.updateCrop();
  }

  setVideoAspect(aspect: number): void {
    this.videoAspect = aspect;
    this.updateCrop();
  }

  setMirrored(mirrored: boolean): void {
    this.mirrored = mirrored;
  }

  /** Call whenever the render viewport (camera.aspect) changes, e.g. on resize. */
  notifyViewportChanged(): void {
    this.updateCrop();
  }

  private updateCrop(): void {
    this.cropRect = computeCoverCrop(this.videoAspect, this.camera.aspect);
  }

  mapJoint(landmark: NormalizedLandmark, worldLandmark: NormalizedLandmark, target: Vector3): Vector3 {
    const { xMin, xMax, yMin, yMax } = this.cropRect;

    let u = (landmark.x - xMin) / (xMax - xMin);
    const v = (landmark.y - yMin) / (yMax - yMin);
    if (this.mirrored) {
      u = 1 - u;
    }

    const depth = clamp(BASE_DEPTH + worldLandmark.z, MIN_DEPTH, MAX_DEPTH);
    const verticalFovRad = (this.camera.fov * Math.PI) / 180;
    const height = 2 * depth * Math.tan(verticalFovRad / 2);
    const width = height * this.camera.aspect;

    return target.set((u - 0.5) * width, (0.5 - v) * height, -depth);
  }
}

/** Shared scratch vector to avoid per-joint, per-frame allocations. */
export const MAPPER_SCRATCH = new Vector3();
