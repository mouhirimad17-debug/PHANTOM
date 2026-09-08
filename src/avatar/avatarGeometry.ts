import { CapsuleGeometry, Color, MeshStandardMaterial, SphereGeometry } from 'three';

// PHANTOM's established accent color (already used by the DEBUG skeleton
// overlay and the UI) — reused here so the avatar reads as part of the same
// visual system rather than an unrelated asset.
const ACCENT_COLOR = 0x00ffc8;

/**
 * Capsule radius/height chosen so the TOTAL tip-to-tip length (height + 2 *
 * radius) is exactly 1 unit. Every limb segment then just sets
 * `mesh.scale.y` to its real length in scene units and gets the correct
 * tip-to-tip distance for free — see limbMath.ts.
 */
const UNIT_CAPSULE_RADIUS = 0.15;
const UNIT_CAPSULE_HEIGHT = 1 - 2 * UNIT_CAPSULE_RADIUS;
const CAPSULE_CAP_SEGMENTS = 4;
const CAPSULE_RADIAL_SEGMENTS = 8;
const SPHERE_WIDTH_SEGMENTS = 12;
const SPHERE_HEIGHT_SEGMENTS = 8;

/**
 * Shared geometries — pure shape data with no per-instance mutable visual
 * state (unlike materials, see below), so these are safe to share globally
 * across every Avatar instance rather than per-instance. Built once, ever.
 *
 * SEGMENT_GEOMETRY: every elongated body part (neck, torso halves, arm/leg
 * segments) reuses this ONE capsule, differentiated only by each mesh's own
 * position/quaternion/scale — never by creating a new geometry.
 *
 * SPHERE_GEOMETRY: unit-radius sphere, reused for both the head (scaled up)
 * and skeleton-mode joint markers (scaled down).
 */
export const SEGMENT_GEOMETRY = new CapsuleGeometry(
  UNIT_CAPSULE_RADIUS,
  UNIT_CAPSULE_HEIGHT,
  CAPSULE_CAP_SEGMENTS,
  CAPSULE_RADIAL_SEGMENTS,
);
export const SPHERE_GEOMETRY = new SphereGeometry(1, SPHERE_WIDTH_SEGMENTS, SPHERE_HEIGHT_SEGMENTS);

/**
 * Materials carry per-instance visual state (`setOpacity()` must affect one
 * Avatar without bleeding into every other Avatar sharing the scene), so —
 * unlike the geometries above — each Avatar constructs its own pair via
 * these factories rather than sharing a module-level singleton.
 */
export function createMannequinMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: 0x14181f, // dark, neutral — readable silhouette over the live camera feed
    roughness: 0.75,
    metalness: 0.1,
    emissive: new Color(ACCENT_COLOR),
    emissiveIntensity: 0.08, // soft accent, not a glow-in-the-dark character
  });
}

/** Brighter, more emissive variant for skeleton (debug-style) display mode. */
export function createSkeletonMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: 0x04110d,
    roughness: 0.5,
    metalness: 0,
    emissive: new Color(ACCENT_COLOR),
    emissiveIntensity: 0.9,
  });
}
