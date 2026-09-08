import type { Vector3 } from 'three';
import { POSE_LANDMARK_COUNT } from '../types/tracking';

/**
 * Per-joint exponential moving average. Keeps its own "has this joint been
 * seen yet" state per index so a joint snaps to its first sample instead of
 * lerping from the origin.
 */
export class LandmarkSmoother {
  private readonly initialized = new Array<boolean>(POSE_LANDMARK_COUNT).fill(false);
  private readonly alpha: number;

  /** @param alpha weight given to the new sample each update; 1 = no smoothing, closer to 0 = heavier smoothing. */
  constructor(alpha: number = 0.5) {
    this.alpha = alpha;
  }

  apply(index: number, current: Vector3, sample: Vector3): void {
    if (!this.initialized[index]) {
      current.copy(sample);
      this.initialized[index] = true;
      return;
    }
    current.lerp(sample, this.alpha);
  }

  reset(): void {
    this.initialized.fill(false);
  }
}
