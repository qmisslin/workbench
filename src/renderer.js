import * as THREE from 'three';

import './style.css';

import { WORKBENCH_CONFIG } from './workbench-config.js';

import {
  createPhysicalScreen,
  updateOffAxisCamera
} from './off-axis-camera.js';

const SCREEN_WIDTH =
  WORKBENCH_CONFIG.output.screenWidthPx;

const SCREEN_HEIGHT =
  WORKBENCH_CONFIG.output.screenHeightPx;

const PACKED_WIDTH =
  SCREEN_WIDTH * 2;

const PACKED_HEIGHT =
  SCREEN_HEIGHT * 2;

const NEAR =
  WORKBENCH_CONFIG.camera.nearM;

const FAR =
  WORKBENCH_CONFIG.camera.farM;

const EYE_DISTANCE =
  WORKBENCH_CONFIG.stereo.eyeDistanceM;

/*
 * Create one renderer for all four views.
 *
 * Internal framebuffer:
 *
 * 2800 x 2100
 *
 * +--------------------+--------------------+
 * | UP LEFT            | UP RIGHT           |
 * | 1400 x 1050        | 1400 x 1050        |
 * +--------------------+--------------------+
 * | DOWN LEFT          | DOWN RIGHT         |
 * | 1400 x 1050        | 1400 x 1050        |
 * +--------------------+--------------------+
 */
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance'
});

/*
 * The native stereo presenter expects exact pixel dimensions.
 *
 * OS display scaling must not change the internal framebuffer size.
 */
renderer.setPixelRatio(1);

renderer.setSize(
  PACKED_WIDTH,
  PACKED_HEIGHT,
  false
);

renderer.setScissorTest(true);

renderer.autoClear = false;

renderer.setClearColor(
  0x050505,
  1
);

document
  .getElementById('app')
  .appendChild(renderer.domElement);

/*
 * Scene
 */
const scene = new THREE.Scene();

/*
 * The cube is intentionally placed near the physical seam between the
 * upper and lower screens.
 *
 * This makes the screen-angle calibration visually easy to verify:
 * the virtual object should remain geometrically coherent across both
 * physical surfaces when viewed from the configured eye position.
 */
const cube = new THREE.Mesh(
  new THREE.BoxGeometry(
    0.28,
    0.28,
    0.28
  ),
  new THREE.MeshNormalMaterial()
);

cube.position.set(
  0,
  -0.52,
  -0.78
);

scene.add(cube);

/*
 * Build the physical screens once.
 */
const physicalScreens = {
  up: createPhysicalScreen(
    WORKBENCH_CONFIG.screens.up
  ),

  down: createPhysicalScreen(
    WORKBENCH_CONFIG.screens.down
  )
};

/*
 * Four cameras are used because each physical screen has a different
 * projection plane and each eye has a different viewpoint.
 *
 * The standard PerspectiveCamera FOV is irrelevant because its
 * projection matrix is replaced by updateOffAxisCamera().
 */
const cameras = {
  upLeft: new THREE.PerspectiveCamera(
    50,
    1,
    NEAR,
    FAR
  ),

  upRight: new THREE.PerspectiveCamera(
    50,
    1,
    NEAR,
    FAR
  ),

  downLeft: new THREE.PerspectiveCamera(
    50,
    1,
    NEAR,
    FAR
  ),

  downRight: new THREE.PerspectiveCamera(
    50,
    1,
    NEAR,
    FAR
  )
};

cameras.upLeft.name = 'UP_LEFT';
cameras.upRight.name = 'UP_RIGHT';
cameras.downLeft.name = 'DOWN_LEFT';
cameras.downRight.name = 'DOWN_RIGHT';

/*
 * Fixed head position for the first prototype.
 *
 * This will later be replaced by live tracking data.
 */
const headPosition = new THREE.Vector3(
  ...WORKBENCH_CONFIG.head.positionM
);

const leftEye = new THREE.Vector3();
const rightEye = new THREE.Vector3();

function updateEyes() {
  /*
   * For the initial prototype the head has no rotation.
   *
   * The interpupillary axis therefore matches world +X.
   *
   * Once head tracking is implemented, this offset will be transformed
   * by the tracked head orientation.
   */
  leftEye.copy(headPosition);

  leftEye.x -=
    EYE_DISTANCE / 2;

  rightEye.copy(headPosition);

  rightEye.x +=
    EYE_DISTANCE / 2;
}

function updateCameras() {
  updateEyes();

  updateOffAxisCamera(
    cameras.upLeft,
    leftEye,
    physicalScreens.up,
    NEAR,
    FAR
  );

  updateOffAxisCamera(
    cameras.upRight,
    rightEye,
    physicalScreens.up,
    NEAR,
    FAR
  );

  updateOffAxisCamera(
    cameras.downLeft,
    leftEye,
    physicalScreens.down,
    NEAR,
    FAR
  );

  updateOffAxisCamera(
    cameras.downRight,
    rightEye,
    physicalScreens.down,
    NEAR,
    FAR
  );
}

/*
 * Renders one camera into one physical 1400 x 1050 tile.
 */
function renderTile(
  camera,
  x,
  y
) {
  renderer.setViewport(
    x,
    y,
    SCREEN_WIDTH,
    SCREEN_HEIGHT
  );

  renderer.setScissor(
    x,
    y,
    SCREEN_WIDTH,
    SCREEN_HEIGHT
  );

  renderer.render(
    scene,
    camera
  );
}

function renderFrame(timeMs) {
  /*
   * Update the scene exactly once before rendering all four cameras.
   *
   * This guarantees that the left and right images describe the same
   * logical scene state.
   */
  const timeSeconds =
    timeMs * 0.001;

  cube.rotation.x =
    timeSeconds * 0.55;

  cube.rotation.y =
    timeSeconds * 0.8;

  updateCameras();

  /*
   * Clear the entire packed framebuffer once.
   */
  renderer.setViewport(
    0,
    0,
    PACKED_WIDTH,
    PACKED_HEIGHT
  );

  renderer.setScissor(
    0,
    0,
    PACKED_WIDTH,
    PACKED_HEIGHT
  );

  renderer.clear(
    true,
    true,
    true
  );

  /*
   * WebGL viewport coordinates start at the bottom-left.
   *
   * Left eye column.
   */
  renderTile(
    cameras.downLeft,
    0,
    0
  );

  renderTile(
    cameras.upLeft,
    0,
    SCREEN_HEIGHT
  );

  /*
   * Right eye column.
   */
  renderTile(
    cameras.downRight,
    SCREEN_WIDTH,
    0
  );

  renderTile(
    cameras.upRight,
    SCREEN_WIDTH,
    SCREEN_HEIGHT
  );

  requestAnimationFrame(renderFrame);
}

requestAnimationFrame(renderFrame);