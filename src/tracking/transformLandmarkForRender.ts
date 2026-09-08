/**
 * The single place horizontal mirroring is ever applied to a landmark
 * x-coordinate. Do not flip x anywhere else in the app.
 *
 * Coordinate pipeline (see CoordinateMapper.mapJoint for the full chain):
 *
 *   1. raw MediaPipe coordinate      — straight from the model, in the
 *      camera sensor's native (unmirrored) frame. Anatomical left/right
 *      landmark labels (e.g. "left wrist") are always correct here,
 *      regardless of front/back camera, because MediaPipe labels sides by
 *      the subject's own anatomy, not by screen position.
 *   2. normalized tracking coordinate — (1) re-based onto the visible
 *      `object-fit: cover` crop region (see computeCoverCrop), still in
 *      the camera's native (unmirrored) orientation.
 *   3. render coordinate             — (2) passed through this function.
 *      For the front camera, the <video> element is displayed mirrored via
 *      CSS (`transform: scaleX(-1)`) for the natural "mirror" UX. Nothing
 *      else mirrors it. So the skeleton, which is drawn into a canvas that
 *      is NEVER CSS-mirrored, must have this same flip baked into its
 *      geometry here — exactly once — to visually line up with the video.
 *      For the rear camera the video isn't mirrored, so this is a no-op.
 *
 * `cameraMirrored` is the single source of truth for this flip; it must be
 * kept in sync with whatever CSS mirror state is applied to the <video>
 * element (see CameraScreen.setMirrored).
 */
export function transformLandmarkForRender(normalizedTrackingX: number, cameraMirrored: boolean): number {
  return cameraMirrored ? 1 - normalizedTrackingX : normalizedTrackingX;
}
