/**
 * One Euro Filter (Casiez, Roussel & Vogel, 2012) — an adaptive low-pass
 * filter designed exactly for this app's smoothing tradeoff: heavy fixed
 * smoothing lags behind fast movement, while light fixed smoothing lets
 * jitter through when the signal is nearly still. This filter widens its
 * cutoff (lets more signal through, less lag) in proportion to how fast the
 * value is currently changing, and narrows it (smooths harder) when the
 * value is nearly static — so it suppresses small jitter on a still body
 * without adding noticeable lag to a fast-moving one.
 *
 * Operates on a single scalar channel; LandmarkSmoother runs one instance
 * per axis (x/y/z) per joint. No per-call allocation — all state is fields.
 */

export interface OneEuroFilterConfig {
  /**
   * Minimum cutoff frequency (Hz). Lower = more smoothing (and more lag)
   * when the signal is nearly still. This is the primary "smoothing
   * strength" knob — see LandmarkSmoother.setSmoothingStrength.
   */
  minCutoff: number;
  /**
   * How much the cutoff widens in proportion to speed. Higher = more
   * responsive during fast movement, at the cost of a bit more jitter
   * while moving.
   */
  beta: number;
  /** Cutoff frequency (Hz) used to smooth the estimated speed itself. */
  dCutoff: number;
}

export const DEFAULT_ONE_EURO_CONFIG: OneEuroFilterConfig = {
  minCutoff: 1.0,
  beta: 0.4,
  dCutoff: 1.0,
};

function computeAlpha(cutoffHz: number, dtSeconds: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSeconds);
}

/** Exponential low-pass filter with a settable per-call alpha (not fixed). */
class LowPassFilter {
  private hasValue = false;
  private value = 0;

  filter(x: number, alpha: number): number {
    this.value = this.hasValue ? alpha * x + (1 - alpha) * this.value : x;
    this.hasValue = true;
    return this.value;
  }

  reset(): void {
    this.hasValue = false;
    this.value = 0;
  }
}

const MIN_DT_SECONDS = 1e-3;

export class OneEuroFilter {
  private config: OneEuroFilterConfig;
  private readonly valueFilter = new LowPassFilter();
  private readonly speedFilter = new LowPassFilter();
  private lastValue: number | null = null;
  private lastTimeMs: number | null = null;

  constructor(config: OneEuroFilterConfig = DEFAULT_ONE_EURO_CONFIG) {
    this.config = { ...config };
  }

  configure(config: Partial<OneEuroFilterConfig>): void {
    Object.assign(this.config, config);
  }

  /** Filters one sample. `nowMs` must be non-decreasing across calls (reset() first if it isn't). */
  filter(x: number, nowMs: number): number {
    if (this.lastTimeMs === null) {
      this.lastTimeMs = nowMs;
      this.lastValue = x;
      this.valueFilter.filter(x, 1);
      this.speedFilter.filter(0, 1);
      return x;
    }

    const dtSeconds = Math.max((nowMs - this.lastTimeMs) / 1000, MIN_DT_SECONDS);
    this.lastTimeMs = nowMs;

    const speed = (x - (this.lastValue ?? x)) / dtSeconds;
    this.lastValue = x;
    const smoothedSpeed = this.speedFilter.filter(speed, computeAlpha(this.config.dCutoff, dtSeconds));

    const cutoff = this.config.minCutoff + this.config.beta * Math.abs(smoothedSpeed);
    return this.valueFilter.filter(x, computeAlpha(cutoff, dtSeconds));
  }

  /** Clears all history so the next filter() call snaps immediately to its input instead of lerping from stale state. */
  reset(): void {
    this.valueFilter.reset();
    this.speedFilter.reset();
    this.lastValue = null;
    this.lastTimeMs = null;
  }
}
