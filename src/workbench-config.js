export const WORKBENCH_CONFIG = {
  output: {
    screenWidthPx: 1400,
    screenHeightPx: 1050
  },

  stereo: {
    eyeDistanceM: 0.064
  },

  camera: {
    nearM: 0.05,
    farM: 100
  },

  /*
   * Three.js coordinate system used by this project:
   *
   * +X = right
   * +Y = up
   * -Z = forward
   *
   * The initial head position corresponds to the tracking origin.
   * Tracking will replace this fixed value later.
   */
  head: {
    positionM: [0, 0, 0]
  },

  screens: {
    /*
     * Original nDisplay center:
     *
     * X = 0.566
     * Y = 0
     * Z = 0.282
     *
     * Converted to Three.js:
     *
     * X = 0
     * Y = 0.282
     * Z = -0.566
     */
    up: {
      widthM: 1.8,
      heightM: 1.35,
      centerM: [0, 0.282, -0.566],
      pitchDeg: 0
    },

    /*
     * Original nDisplay center:
     *
     * X = -0.098
     * Y = 0
     * Z = -0.510
     *
     * Converted to Three.js:
     *
     * X = 0
     * Y = -0.510
     * Z = 0.098
     *
     * The -80 degree rotation reproduces the physical lower screen.
     */
    down: {
      widthM: 1.8,
      heightM: 1.35,
      centerM: [0, -0.510, 0.098],
      pitchDeg: -80
    }
  }
};