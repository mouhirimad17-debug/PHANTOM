import type { Scene } from 'three';
import { Avatar } from '../avatar/Avatar';
import { TrackingHistory } from '../tracking/TrackingHistory';
import { computeDerivedFields, createTrackingFrame } from '../tracking/trackingFrame';
import type { TrackingFrame } from '../types/tracking';
import { PoseLandmark } from '../utils/poseLandmarks';
import { transformLimbMotion, transformPosition, transformRotation } from './reverseTransforms';
import type { Effect } from './Effect';

export type ReversePreset = 'MIRROR' | 'REVERSE_HORIZONTAL' | 'DELAYED_MIRROR';

export interface ReverseParams {
  preset: ReversePreset;
}

export const DEFAULT_REVERSE_PARAMS: Readonly<ReverseParams> = {
  preset: 'MIRROR',
};

const VALID_PRESETS: readonly ReversePreset[] = ['MIRROR', 'REVERSE_HORIZONTAL', 'DELAYED_MIRROR'];

/**
 * DELAYED_MIRROR's fixed sampling delay. Not user-configurable in this
 * phase — presets are meant to be complete, ready-made behaviors (see
 * CloneEffect's BASE_SPACING / GhostEffect's breathing constants for the
 * same "fixed internal constant, not a UI knob" pattern).
 */
const DELAYED_MIRROR_DELAY_MS = 250;

// Comfortably covers DELAYED_MIRROR_DELAY_MS with margin.
const HISTORY_MAX_DURATION_MS = 600;

/**
 * Keeps the reverse phantom clearly beside the live avatar rather than
 * overlapping it. MIRROR's reflection leaves the source's own bodyCenter
 * fixed (reflecting a body about its own centerline doesn't move that
 * centerline), so without this offset a MIRROR/DELAYED_MIRROR phantom
 * would stand almost exactly where the live avatar stands — reading as
 * confusing overlap rather than an intentional second figure (the same
 * lesson CloneEffect's arrangement pattern already encodes for its own
 * copies).
 */
const REVERSE_OFFSET_X = 1.0;
const REVERSE_OFFSET_Z = 0.25;

/**
 * Each entry pairs a limb extremity with the proximal joint its outward/
 * inward motion is measured from, for REVERSE_HORIZONTAL. Core joints
 * (nose, shoulders, hips) are the anchors themselves and are never
 * transformed in that preset — see the class doc.
 */
const LIMB_ANCHORS: ReadonlyArray<{ landmark: number; anchor: number }> = [
  { landmark: PoseLandmark.LEFT_ELBOW, anchor: PoseLandmark.LEFT_SHOULDER },
  { landmark: PoseLandmark.LEFT_WRIST, anchor: PoseLandmark.LEFT_SHOULDER },
  { landmark: PoseLandmark.LEFT_INDEX, anchor: PoseLandmark.LEFT_SHOULDER },
  { landmark: PoseLandmark.RIGHT_ELBOW, anchor: PoseLandmark.RIGHT_SHOULDER },
  { landmark: PoseLandmark.RIGHT_WRIST, anchor: PoseLandmark.RIGHT_SHOULDER },
  { landmark: PoseLandmark.RIGHT_INDEX, anchor: PoseLandmark.RIGHT_SHOULDER },
  { landmark: PoseLandmark.LEFT_KNEE, anchor: PoseLandmark.LEFT_HIP },
  { landmark: PoseLandmark.LEFT_ANKLE, anchor: PoseLandmark.LEFT_HIP },
  { landmark: PoseLandmark.LEFT_FOOT_INDEX, anchor: PoseLandmark.LEFT_HIP },
  { landmark: PoseLandmark.RIGHT_KNEE, anchor: PoseLandmark.RIGHT_HIP },
  { landmark: PoseLandmark.RIGHT_ANKLE, anchor: PoseLandmark.RIGHT_HIP },
  { landmark: PoseLandmark.RIGHT_FOOT_INDEX, anchor: PoseLandmark.RIGHT_HIP },
];

/** Preview label shown in the UI for each preset — see CameraScreen's reverse panel. */
const PREVIEW_LABELS: Record<ReversePreset, string> = {
  MIRROR: 'Mirror',
  REVERSE_HORIZONTAL: 'Reverse Horizontal',
  DELAYED_MIRROR: 'Delayed Mirror',
};

function isValidPreset(value: string): value is ReversePreset {
  return (VALID_PRESETS as readonly string[]).includes(value);
}

/**
 * REVERSE — "the Phantom responds differently from the user," via three
 * clear, deterministic transformations (see reverseTransforms.ts; never
 * `Math.random()`) applied to the tracked pose before it drives a second
 * `Avatar`:
 *
 *   - `transformPosition()` reflects every joint across a vertical mirror
 *     plane (the source frame's own `bodyCenter.x`). Used by MIRROR/
 *     DELAYED_MIRROR — a full mirror-image duplicate. Because every joint
 *     shares the same mirror plane, this is a rigid reflection: limb
 *     lengths and proportions are preserved exactly, so the mirrored
 *     figure never looks stretched or broken.
 *   - `transformRotation()` reflects the frame's `torsoRotation` the same
 *     way, keeping that field's meaning ("which way is the phantom
 *     facing") consistent with the mirrored joint positions. (`Avatar`
 *     doesn't currently read `torsoRotation` to drive rendering — each
 *     limb is oriented directly from its own two tracked joint positions,
 *     see limbMath.ts — so this keeps the frame's own data internally
 *     consistent rather than changing what's drawn; applying an
 *     equivalent turn via `Avatar.setRotation()`'s root-level Euler
 *     override was deliberately avoided, since `Avatar` positions every
 *     limb with absolute scene coordinates, so rotating the root would
 *     swing the whole body through a wide arc around the world origin
 *     rather than spinning it in place — exactly the kind of distortion
 *     "must look intentionally designed, not broken" rules out.)
 *   - `transformLimbMotion()` inverts one joint's horizontal displacement
 *     from a fixed anchor (e.g. wrist from shoulder). Used by
 *     REVERSE_HORIZONTAL on the limb extremities only (see LIMB_ANCHORS)
 *     — "move a hand outward, the phantom moves the same hand inward" —
 *     while the core (nose, shoulders, hips) stays a direct copy of the
 *     user, so the phantom's stance/turning still reads as faithful to
 *     the user and only the limbs respond differently. Only the sign of
 *     one displacement component changes, so anchor-to-joint distance
 *     (limb length/reach) is preserved exactly here too.
 *
 * DELAYED_MIRROR reuses the exact MIRROR transform, just sourced from a
 * short historical sample (its own private `TrackingHistory`, same
 * pattern as every other effect in this codebase) instead of the live
 * frame — the "optional delayed response."
 */
export class ReverseEffect implements Effect {
  private readonly reverseAvatar: Avatar;
  private readonly history = new TrackingHistory(HISTORY_MAX_DURATION_MS);
  private readonly reverseFrame: TrackingFrame = createTrackingFrame();

  private params: ReverseParams = { ...DEFAULT_REVERSE_PARAMS };
  private enabled = false;

  constructor(scene: Scene) {
    this.reverseAvatar = new Avatar(scene);
    this.reverseAvatar.setDisplayMode('mannequin');
    this.reverseAvatar.setPosition(REVERSE_OFFSET_X, 0, REVERSE_OFFSET_Z);
  }

  enable(): void {
    this.enabled = true;
    // disable() below turns the avatar's own visibility override off; undo
    // that here so a disable() -> enable() cycle actually shows it again
    // (updateFromTracking() only ever reads that override, never sets it).
    this.reverseAvatar.setVisible(true);
  }

  disable(): void {
    this.enabled = false;
    this.reverseAvatar.setVisible(false);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Merges in any provided parameters; an unrecognized preset string is ignored rather than accepted. */
  configure(partial: Partial<ReverseParams>): void {
    if (partial.preset !== undefined && isValidPreset(partial.preset)) {
      this.params.preset = partial.preset;
    }
  }

  getParams(): Readonly<ReverseParams> {
    return this.params;
  }

  /** Human-readable label for the currently selected preset — drives the UI's preview label. */
  getPreviewLabel(): string {
    return PREVIEW_LABELS[this.params.preset];
  }

  update(_deltaTimeSeconds: number, trackingFrame: TrackingFrame): void {
    if (!this.enabled) return;

    if (!trackingFrame.present) {
      this.reverseFrame.present = false;
      this.reverseFrame.state = 'LOST';
      this.reverseAvatar.updateFromTracking(this.reverseFrame);
      return;
    }

    this.history.push(trackingFrame);

    const preset = this.params.preset;
    const source =
      preset === 'DELAYED_MIRROR' ? (this.history.getAtOffset(DELAYED_MIRROR_DELAY_MS) ?? trackingFrame) : trackingFrame;

    if (preset === 'REVERSE_HORIZONTAL') {
      this.applyReverseHorizontal(source);
    } else {
      this.applyMirror(source);
    }

    this.reverseFrame.present = true;
    this.reverseFrame.state = 'TRACKING';
    this.reverseFrame.confidence = source.confidence;
    this.reverseFrame.timestampMs = trackingFrame.timestampMs;
    computeDerivedFields(this.reverseFrame);
    if (preset !== 'REVERSE_HORIZONTAL') {
      // MIRROR/DELAYED_MIRROR: keep the reported facing direction consistent
      // with the mirrored joint positions (see the class doc). REVERSE_HORIZONTAL
      // leaves the core untransformed, so whatever computeDerivedFields just
      // derived from it is already correct as-is.
      this.reverseFrame.torsoRotation = transformRotation(source.torsoRotation);
    }

    this.reverseAvatar.updateFromTracking(this.reverseFrame);
  }

  /** MIRROR/DELAYED_MIRROR: reflect every joint about the source's own bodyCenter.x. */
  private applyMirror(source: Readonly<TrackingFrame>): void {
    const mirrorX = source.bodyCenter.x;
    for (let i = 0; i < source.landmarks.length; i++) {
      const src = source.landmarks[i]!;
      const dest = this.reverseFrame.landmarks[i]!;
      transformPosition(dest.position, src.position, mirrorX);
      dest.visibility = src.visibility;
    }
  }

  /** REVERSE_HORIZONTAL: core joints pass through unchanged; limb extremities invert around their proximal anchor. */
  private applyReverseHorizontal(source: Readonly<TrackingFrame>): void {
    for (let i = 0; i < source.landmarks.length; i++) {
      const src = source.landmarks[i]!;
      const dest = this.reverseFrame.landmarks[i]!;
      dest.position.copy(src.position);
      dest.visibility = src.visibility;
    }
    for (const { landmark, anchor } of LIMB_ANCHORS) {
      const anchorPosition = source.landmarks[anchor]!.position;
      const dest = this.reverseFrame.landmarks[landmark]!;
      transformLimbMotion(dest.position, source.landmarks[landmark]!.position, anchorPosition);
    }
  }

  /** Returns to a clean, just-constructed state: disabled, hidden, no held pose/history, default preset. */
  reset(): void {
    this.enabled = false;
    this.history.clear();
    this.params = { ...DEFAULT_REVERSE_PARAMS };
    this.reverseAvatar.reset(); // Avatar.reset() also zeroes position — re-apply our fixed offset right after
    this.reverseAvatar.setPosition(REVERSE_OFFSET_X, 0, REVERSE_OFFSET_Z);
  }

  dispose(): void {
    this.reverseAvatar.dispose();
  }
}
