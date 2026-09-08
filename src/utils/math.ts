export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface CoverCropRect {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

/**
 * Given a source media aspect ratio and a container aspect ratio, computes
 * the normalized [0,1] rectangle of the source that remains visible when
 * displayed with CSS `object-fit: cover` (i.e. scaled to fill, cropped to
 * the container's aspect). Used to keep pose landmark coordinates aligned
 * with what the user actually sees on screen.
 */
export function computeCoverCrop(sourceAspect: number, containerAspect: number): CoverCropRect {
  if (sourceAspect > containerAspect) {
    const visibleFraction = containerAspect / sourceAspect;
    const xMin = (1 - visibleFraction) / 2;
    return { xMin, xMax: 1 - xMin, yMin: 0, yMax: 1 };
  }
  const visibleFraction = sourceAspect / containerAspect;
  const yMin = (1 - visibleFraction) / 2;
  return { xMin: 0, xMax: 1, yMin, yMax: 1 - yMin };
}
