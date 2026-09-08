import type { Vector3 } from 'three';
import { POSE_LANDMARK_COUNT } from '../types/tracking';
import { DEFAULT_ONE_EURO_CONFIG, OneEuroFilter, type OneEuroFilterConfig } from './OneEuroFilter';

const MIN_CUTOFF_RANGE: readonly [number, number] = [0.3, 2.5];

/**
 * Smooths noisy per-joint landmark positions with one OneEuroFilter per
 * axis (x/y/z) per joint — see OneEuroFilter's doc comment for why a plain
 * fixed-alpha average can't satisfy "don't lag" and "suppress jitter" at
 * the same time. All 33*3 filter instances are allocated once in the
 * constructor and reused every frame (no per-frame allocation).
 */
export class LandmarkSmoother {
  private readonly xFilters: OneEuroFilter[];
  private readonly yFilters: OneEuroFilter[];
  private readonly zFilters: OneEuroFilter[];
  private readonly initialized = new Array<boolean>(POSE_LANDMARK_COUNT).fill(false);

  constructor(config: OneEuroFilterConfig = DEFAULT_ONE_EURO_CONFIG) {
    this.xFilters = Array.from({ length: POSE_LANDMARK_COUNT }, () => new OneEuroFilter(config));
    this.yFilters = Array.from({ length: POSE_LANDMARK_COUNT }, () => new OneEuroFilter(config));
    this.zFilters = Array.from({ length: POSE_LANDMARK_COUNT }, () => new OneEuroFilter(config));
  }

  /**
   * Filters one joint's position in place: `current` is mutated toward
   * `sample`, `current` is never reassigned. `nowMs` must be non-decreasing
   * across calls for the same joint index (a stale/rewound clock will
   * misbehave — the caller is expected to reset() instead after a large
   * time gap; see TrackingManager's LOST -> TRACKING transition).
   */
  apply(index: number, current: Vector3, sample: Vector3, nowMs: number): void {
    if (!this.initialized[index]) {
      current.copy(sample);
      // Seed each filter with the initial sample so it doesn't report a
      // huge fake "speed" from an implicit jump on the very next call.
      this.xFilters[index]!.filter(sample.x, nowMs);
      this.yFilters[index]!.filter(sample.y, nowMs);
      this.zFilters[index]!.filter(sample.z, nowMs);
      this.initialized[index] = true;
      return;
    }

    current.x = this.xFilters[index]!.filter(sample.x, nowMs);
    current.y = this.yFilters[index]!.filter(sample.y, nowMs);
    current.z = this.zFilters[index]!.filter(sample.z, nowMs);
  }

  /**
   * Configurable smoothing strength, normalized to 0..1: 0 = minimal
   * smoothing (most responsive, jitter passes through), 1 = heavy smoothing
   * (least jitter, most lag). Maps onto the underlying filters' minCutoff —
   * see OneEuroFilterConfig for the full set of tunable parameters if finer
   * control is needed later (e.g. per-effect smoothing profiles).
   */
  setSmoothingStrength(strength: number): void {
    const clamped = Math.max(0, Math.min(1, strength));
    const [minCutoffAtMaxStrength, minCutoffAtZeroStrength] = MIN_CUTOFF_RANGE;
    const minCutoff = minCutoffAtZeroStrength + (minCutoffAtMaxStrength - minCutoffAtZeroStrength) * clamped;
    this.configure({ minCutoff });
  }

  /** Lower-level configuration for advanced tuning; see OneEuroFilterConfig. */
  configure(config: Partial<OneEuroFilterConfig>): void {
    for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
      this.xFilters[i]!.configure(config);
      this.yFilters[i]!.configure(config);
      this.zFilters[i]!.configure(config);
    }
  }

  /**
   * Clears all filter history so the next `apply()` call snaps immediately
   * to its input instead of lerping/extrapolating from stale state. Call
   * this after a long tracking gap (state LOST -> TRACKING) so recovery is
   * instant rather than dragging in from wherever the body was last seen.
   */
  reset(): void {
    this.initialized.fill(false);
    for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
      this.xFilters[i]!.reset();
      this.yFilters[i]!.reset();
      this.zFilters[i]!.reset();
    }
  }
}
