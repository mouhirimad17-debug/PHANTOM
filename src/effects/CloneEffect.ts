import type { Scene } from 'three';
import { Avatar } from '../avatar/Avatar';
import { TrackingHistory } from '../tracking/TrackingHistory';
import { copyTrackingFrame, createTrackingFrame } from '../tracking/trackingFrame';
import type { TrackingFrame } from '../types/tracking';
import { clamp } from '../utils/math';
import type { Effect } from './Effect';

export type CloneCount = 2 | 3 | 5;
export type CloneMode = 'SAME' | 'DELAYED' | 'SPREAD';

export interface CloneParams {
  count: CloneCount;
  mode: CloneMode;
  /** Base opacity for the first clone; later clones fade slightly — see OPACITY_FADE_PER_INDEX. */
  opacity: number;
  /** DELAYED mode only: time between each successive clone's historical frame. */
  delayStepMilliseconds: number;
  /** SPREAD mode only: multiplier on the base arrangement pattern's spacing. */
  spreadDistance: number;
}

export const DEFAULT_CLONE_PARAMS: Readonly<CloneParams> = {
  count: 3,
  mode: 'SPREAD',
  opacity: 0.85,
  delayStepMilliseconds: 200,
  spreadDistance: 1.6,
};

/**
 * Hard cap on simultaneous clones — also the pool size (see the class doc).
 * Matches the largest selectable count (5); the UI only ever offers
 * 2/3/5, so this is never exceeded, but the type system enforces it too.
 */
const MAX_CLONES = 5;

// Comfortably covers the max selectable delayStepMilliseconds * (MAX_CLONES - 1).
const HISTORY_MAX_DURATION_MS = 4000;

const BASE_SPACING = 0.6;
const OPACITY_FADE_PER_INDEX = 0.12;
const MIN_OPACITY_FACTOR = 0.4;
const MIN_BODY_SCALE = 0.05;

const PARAM_RANGES = {
  opacity: [0, 1] as const,
  delayStepMilliseconds: [50, 800] as const,
  spreadDistance: [0.5, 4] as const,
};

const VALID_COUNTS: readonly CloneCount[] = [2, 3, 5];
const VALID_MODES: readonly CloneMode[] = ['SAME', 'DELAYED', 'SPREAD'];

/**
 * Deterministic, symmetric arrangement of clone slots around the user, in
 * (x, z) units later scaled by spacing * bodyScale. Every slot is a small,
 * fixed offset from the tracked body — never an arbitrary floating copy —
 * and is keyed by how many clones are actually showing, so e.g. 2 clones
 * are always a clean left/right pair rather than an arbitrary subset of
 * the 5-clone layout.
 */
const CLONE_SLOT_PATTERNS: Record<CloneCount, ReadonlyArray<{ x: number; z: number }>> = {
  2: [
    { x: 1, z: 0.1 },
    { x: -1, z: 0.1 },
  ],
  3: [
    { x: 1, z: 0.1 },
    { x: -1, z: 0.1 },
    { x: 0, z: 1.3 },
  ],
  5: [
    { x: 1, z: 0.1 },
    { x: -1, z: 0.1 },
    { x: 1.8, z: 0.3 },
    { x: -1.8, z: 0.3 },
    { x: 0.4, z: 1.5 },
  ],
};

function clampCount(value: number): CloneCount {
  let best: CloneCount = DEFAULT_CLONE_PARAMS.count;
  let bestDiff = Infinity;
  for (const candidate of VALID_COUNTS) {
    const diff = Math.abs(candidate - value);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }
  return best;
}

function isValidMode(value: string): value is CloneMode {
  return (VALID_MODES as readonly string[]).includes(value);
}

interface CloneSlot {
  avatar: Avatar;
  frame: TrackingFrame;
}

/**
 * CLONE — multiple virtual copies of the user, arranged around them (never
 * arbitrary floating copies), each driven directly from a stored tracking
 * frame rather than any smoothing/spring illusion (contrast
 * IndependentShadowEffect, which deliberately lags/settles — Clone's copies
 * are meant to read as faithful duplicates, just offset in space and/or
 * time).
 *
 * Performance: a fixed pool of MAX_CLONES `Avatar` instances is created
 * once, here, and reused for the whole session. Enabling the effect or
 * changing count/mode only changes which pool slots are visible and what
 * frame drives them — it never constructs or destroys an `Avatar`. See
 * ARCHITECTURE.md for the full performance rationale behind the count cap.
 */
export class CloneEffect implements Effect {
  private readonly pool: CloneSlot[];
  private readonly history = new TrackingHistory(HISTORY_MAX_DURATION_MS);

  private params: CloneParams = { ...DEFAULT_CLONE_PARAMS };
  private enabled = false;

  constructor(scene: Scene) {
    this.pool = Array.from({ length: MAX_CLONES }, () => {
      const avatar = new Avatar(scene);
      avatar.setDisplayMode('mannequin'); // clones are meant to look like real duplicates, not shadows
      return { avatar, frame: createTrackingFrame() };
    });
  }

  enable(): void {
    this.enabled = true;
    // disable() below turns every pooled avatar's own visibility override
    // off; undo that here so a disable() -> enable() cycle actually shows
    // them again (update() only ever reads that override via
    // updateFromTracking(), never sets it back to true — any slot beyond
    // the configured count is correctly hidden again on the very next
    // update() call regardless).
    for (const slot of this.pool) slot.avatar.setVisible(true);
  }

  disable(): void {
    this.enabled = false;
    for (const slot of this.pool) slot.avatar.setVisible(false);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Merges in any provided parameters (clamped/validated); omitted keys are left unchanged. */
  configure(partial: Partial<CloneParams>): void {
    if (partial.count !== undefined) this.params.count = clampCount(partial.count);
    if (partial.mode !== undefined && isValidMode(partial.mode)) this.params.mode = partial.mode;
    if (partial.opacity !== undefined) this.params.opacity = clamp(partial.opacity, ...PARAM_RANGES.opacity);
    if (partial.delayStepMilliseconds !== undefined) {
      this.params.delayStepMilliseconds = clamp(partial.delayStepMilliseconds, ...PARAM_RANGES.delayStepMilliseconds);
    }
    if (partial.spreadDistance !== undefined) {
      this.params.spreadDistance = clamp(partial.spreadDistance, ...PARAM_RANGES.spreadDistance);
    }
  }

  getParams(): Readonly<CloneParams> {
    return this.params;
  }

  update(_deltaTimeSeconds: number, trackingFrame: TrackingFrame): void {
    if (!this.enabled) return;

    if (!trackingFrame.present) {
      // Weak/lost tracking: hide every clone rather than leaving them
      // floating at a stale position with no relation to the (now absent) user.
      for (const slot of this.pool) {
        slot.frame.present = false;
        slot.frame.state = 'LOST';
        slot.avatar.updateFromTracking(slot.frame);
      }
      return;
    }

    this.history.push(trackingFrame);

    const { count, mode } = this.params;
    const pattern = CLONE_SLOT_PATTERNS[count];
    const spacing = mode === 'SPREAD' ? BASE_SPACING * this.params.spreadDistance : BASE_SPACING;
    const bodyScale = Math.max(trackingFrame.bodyScale, MIN_BODY_SCALE);

    for (let i = 0; i < this.pool.length; i++) {
      const slot = this.pool[i]!;
      if (i >= count) {
        slot.avatar.setVisible(false);
        continue;
      }

      const source =
        mode === 'DELAYED'
          ? (this.history.getAtOffset(i * this.params.delayStepMilliseconds) ?? trackingFrame)
          : trackingFrame;
      copyTrackingFrame(slot.frame, source);
      slot.avatar.updateFromTracking(slot.frame);

      const slotOffset = pattern[i]!;
      slot.avatar.setPosition(slotOffset.x * spacing * bodyScale, 0, slotOffset.z * spacing * bodyScale);

      const opacityFactor = Math.max(MIN_OPACITY_FACTOR, 1 - i * OPACITY_FADE_PER_INDEX);
      slot.avatar.setOpacity(this.params.opacity * opacityFactor);
    }
  }

  /** Returns to a clean, just-constructed state: disabled, every pooled clone hidden, default parameters. */
  reset(): void {
    this.enabled = false;
    this.history.clear();
    this.params = { ...DEFAULT_CLONE_PARAMS };
    for (const slot of this.pool) {
      slot.avatar.reset();
    }
  }

  dispose(): void {
    for (const slot of this.pool) slot.avatar.dispose();
  }
}
