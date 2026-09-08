import type { TrackingFrame } from '../types/tracking';

/**
 * Contract every PHANTOM visual effect implements. An effect owns whatever
 * it renders (typically one or more `Avatar` instances — see
 * `avatar/Avatar.ts`) and is driven entirely by the same `TrackingFrame`
 * the base avatar consumes; it never touches camera/vision internals.
 */
export interface Effect {
  /** Starts rendering the effect. Should not require a subsequent reset() to look correct. */
  enable(): void;
  /** Hides/stops the effect. Internal state is not required to survive this (see reset()). */
  disable(): void;
  /** Returns the effect to a clean, just-constructed state (hidden, no held pose/velocity/history). */
  reset(): void;
  /**
   * Advances the effect by one tracking update.
   * @param deltaTimeSeconds time elapsed since the previous update() call, in seconds.
   * @param trackingFrame the current live tracking frame (already smoothed — see TrackingManager).
   */
  update(deltaTimeSeconds: number, trackingFrame: TrackingFrame): void;
}
