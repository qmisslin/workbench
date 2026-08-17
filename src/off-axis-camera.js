import * as THREE from 'three';

/*
 * Builds the physical coordinate system of a screen.
 *
 * A screen is defined by:
 *
 * - its physical center;
 * - its width;
 * - its height;
 * - its pitch angle.
 *
 * The resulting vectors are expressed in world coordinates.
 */
export function createPhysicalScreen(config) {
  const center = new THREE.Vector3(...config.centerM);

  const rotation = new THREE.Matrix4().makeRotationX(
    THREE.MathUtils.degToRad(config.pitchDeg)
  );

  const right = new THREE.Vector3(1, 0, 0)
    .applyMatrix4(rotation)
    .normalize();

  const up = new THREE.Vector3(0, 1, 0)
    .applyMatrix4(rotation)
    .normalize();

  /*
   * The normal points toward the expected viewer side.
   *
   * For the upper screen this gives +Z.
   */
  const normal = new THREE.Vector3()
    .crossVectors(right, up)
    .normalize();

  const halfWidth = config.widthM / 2;
  const halfHeight = config.heightM / 2;

  const lowerLeft = center
    .clone()
    .addScaledVector(right, -halfWidth)
    .addScaledVector(up, -halfHeight);

  const lowerRight = center
    .clone()
    .addScaledVector(right, halfWidth)
    .addScaledVector(up, -halfHeight);

  const upperLeft = center
    .clone()
    .addScaledVector(right, -halfWidth)
    .addScaledVector(up, halfHeight);

  return {
    center,
    right,
    up,
    normal,
    lowerLeft,
    lowerRight,
    upperLeft
  };
}

/*
 * Updates a Three.js camera using generalized off-axis projection.
 *
 * The eye can move freely in front of the physical screen.
 *
 * When tracking is added later, only the eye position needs to change.
 */
export function updateOffAxisCamera(
  camera,
  eye,
  screen,
  near,
  far
) {
  const va = screen.lowerLeft.clone().sub(eye);
  const vb = screen.lowerRight.clone().sub(eye);
  const vc = screen.upperLeft.clone().sub(eye);

  /*
   * Distance between the eye and the physical screen plane.
   */
  const distance = -va.dot(screen.normal);

  if (distance <= 0) {
    throw new Error(
      'The eye is behind the physical screen plane.'
    );
  }

  /*
   * Project the physical screen edges onto the camera near plane.
   */
  const left =
    screen.right.dot(va) * near / distance;

  const right =
    screen.right.dot(vb) * near / distance;

  const bottom =
    screen.up.dot(va) * near / distance;

  const top =
    screen.up.dot(vc) * near / distance;

  /*
   * Do not call camera.updateProjectionMatrix() after this point.
   *
   * The default PerspectiveCamera projection is intentionally replaced
   * with the physical off-axis projection matrix.
   */
  camera.projectionMatrix.makePerspective(
    left,
    right,
    top,
    bottom,
    near,
    far
  );

  camera.projectionMatrixInverse
    .copy(camera.projectionMatrix)
    .invert();

  /*
   * A Three.js camera looks toward its local -Z axis.
   *
   * The screen normal points from the screen toward the viewer, so the
   * camera local +Z axis must match the screen normal.
   */
  const rotationMatrix = new THREE.Matrix4().makeBasis(
    screen.right,
    screen.up,
    screen.normal
  );

  camera.position.copy(eye);
  camera.quaternion.setFromRotationMatrix(rotationMatrix);

  camera.updateMatrixWorld(true);

  camera.matrixWorldInverse
    .copy(camera.matrixWorld)
    .invert();
}