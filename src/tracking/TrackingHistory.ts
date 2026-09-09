import type { TrackingFrame } from '../types/tracking';
import { copyTrackingFrame, createTrackingFrame } from './trackingFrame';

/**
 * Physical storage capacity (number of pre-allocated slots), independent
 * from the logical time window (`maxDurationMs`). Generous enough to cover
 * several seconds of history at typical pose-inference rates (the app
 * throttles inference to roughly 4-30Hz depending on device — see
 * App.ts's adaptive detect interval) without ever needing to grow.
 */
const DEFAULT_CAPACITY = 400;
const DEFAULT_MAX_DURATION_MS = 5000;

/**
 * Fixed-size ring buffer of TrackingFrame snapshots, for effects that need
 * to look back in time. Each effect that needs this (IndependentShadowEffect,
 * CloneEffect's DELAYED mode, GhostEffect, ReverseEffect's DELAYED_MIRROR)
 * owns its own private instance, sized to its own lookback window — there is
 * no single shared/global history.
 *
 * All storage is pre-allocated in the constructor; `push()` copies frame
 * data into the next ring slot rather than allocating, so this can run
 * every frame indefinitely without generating garbage.
 */
export class TrackingHistory {
  private readonly slots: TrackingFrame[];
  private writeIndex = 0;
  private count = 0;
  private maxDurationMs: number;

  constructor(maxDurationMs: number = DEFAULT_MAX_DURATION_MS, capacity: number = DEFAULT_CAPACITY) {
    this.maxDurationMs = maxDurationMs;
    this.slots = Array.from({ length: capacity }, () => createTrackingFrame());
  }

  /** Copies `frame`'s current values into the next ring slot. Safe to call with a frame that will keep mutating afterward. */
  push(frame: Readonly<TrackingFrame>): void {
    const slot = this.slots[this.writeIndex]!;
    copyTrackingFrame(slot, frame);
    this.writeIndex = (this.writeIndex + 1) % this.slots.length;
    this.count = Math.min(this.count + 1, this.slots.length);
  }

  getLatest(): Readonly<TrackingFrame> | null {
    if (this.count === 0) return null;
    const lastIndex = (this.writeIndex - 1 + this.slots.length) % this.slots.length;
    return this.slots[lastIndex]!;
  }

  /**
   * Returns the stored frame whose timestamp is closest to
   * (latest.timestampMs - offsetMs), or null if there's no history yet or
   * the offset reaches further back than `maxDurationMs` / the oldest
   * stored sample. `offsetMs` should be >= 0 (0 behaves like getLatest()).
   */
  getAtOffset(offsetMs: number): Readonly<TrackingFrame> | null {
    const latest = this.getLatest();
    if (!latest) return null;
    const targetMs = latest.timestampMs - offsetMs;

    let best: Readonly<TrackingFrame> | null = null;
    let bestDiffMs = Infinity;

    for (let i = 0; i < this.count; i++) {
      const index = (this.writeIndex - 1 - i + this.slots.length * 2) % this.slots.length;
      const candidate = this.slots[index]!;
      if (latest.timestampMs - candidate.timestampMs > this.maxDurationMs) {
        break; // walking backward in time; everything older is outside the configured window
      }
      const diffMs = Math.abs(candidate.timestampMs - targetMs);
      if (diffMs < bestDiffMs) {
        bestDiffMs = diffMs;
        best = candidate;
      }
    }

    return best;
  }

  /** Logically empties the buffer. Slot storage is kept allocated for reuse. */
  clear(): void {
    this.count = 0;
    this.writeIndex = 0;
  }

  setMaxDuration(ms: number): void {
    this.maxDurationMs = ms;
  }

  getMaxDuration(): number {
    return this.maxDurationMs;
  }

  /** Number of frames currently stored (<= capacity). */
  get size(): number {
    return this.count;
  }

  /** Physical storage capacity (fixed at construction). */
  get capacity(): number {
    return this.slots.length;
  }
}
