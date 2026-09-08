import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { CoordinateMapper, MAPPER_SCRATCH } from './CoordinateMapper';

// Regression test for the double-mirroring bug: the skeleton moved opposite
// to the visible (CSS-mirrored) body because CoordinateMapper flipped x in
// software AND the canvas was also flipped via CSS. This test locks in that
// CoordinateMapper's own output correctly reverses sign between mirrored and
// non-mirrored for the same input, so a future regression here is caught
// even before it reaches the CSS layer (see #scene-canvas in styles.css for
// the other half of the invariant).
describe('CoordinateMapper.mapJoint', () => {
  function makeMapper(): CoordinateMapper {
    // Square aspect + no crop (videoAspect === camera.aspect) isolates the
    // mirror behavior from the object-fit: cover crop math.
    const camera = new PerspectiveCamera(60, 1, 0.1, 50);
    const mapper = new CoordinateMapper(camera);
    mapper.setVideoAspect(1);
    return mapper;
  }

  it('places a right-of-center raw landmark on the opposite side when mirrored', () => {
    const mapper = makeMapper();
    const landmark = { x: 0.75, y: 0.5, z: 0 };
    const worldLandmark = { x: 0, y: 0, z: 0 };

    mapper.setCameraMirrored(false);
    const unmirrored = mapper.mapJoint(landmark, worldLandmark, MAPPER_SCRATCH.clone());

    mapper.setCameraMirrored(true);
    const mirrored = mapper.mapJoint(landmark, worldLandmark, MAPPER_SCRATCH.clone());

    expect(unmirrored.x).toBeGreaterThan(0); // raw x=0.75 is right of center
    expect(mirrored.x).toBeLessThan(0); // mirrored: same input lands left of center
    expect(mirrored.x).toBeCloseTo(-unmirrored.x, 10); // symmetric around the center
  });

  it('never mirrors the vertical axis', () => {
    const mapper = makeMapper();
    const landmark = { x: 0.5, y: 0.25, z: 0 };
    const worldLandmark = { x: 0, y: 0, z: 0 };

    mapper.setCameraMirrored(false);
    const unmirrored = mapper.mapJoint(landmark, worldLandmark, MAPPER_SCRATCH.clone());

    mapper.setCameraMirrored(true);
    const mirrored = mapper.mapJoint(landmark, worldLandmark, MAPPER_SCRATCH.clone());

    expect(mirrored.y).toBeCloseTo(unmirrored.y, 10);
  });

  it('computeRenderX matches the x used internally by mapJoint', () => {
    const mapper = makeMapper();
    mapper.setCameraMirrored(true);
    const rawX = 0.3;

    const renderX = mapper.computeRenderX(rawX);
    const joint = mapper.mapJoint({ x: rawX, y: 0.5, z: 0 }, { x: 0, y: 0, z: 0 }, MAPPER_SCRATCH.clone());

    // Re-derive the expected world x from renderX using the same formula as mapJoint.
    const camera = new PerspectiveCamera(60, 1, 0.1, 50);
    const depth = 2.5; // BASE_DEPTH with worldLandmark.z = 0
    const height = 2 * depth * Math.tan((camera.fov * Math.PI) / 360);
    const width = height * camera.aspect;
    expect(joint.x).toBeCloseTo((renderX - 0.5) * width, 10);
  });
});
