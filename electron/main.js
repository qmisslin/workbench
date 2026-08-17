const {
  app,
  BrowserWindow
} = require('electron/main');

const path =
  require('node:path');

const SCREEN_WIDTH =
  1400;

const SCREEN_HEIGHT =
  1050;

const PACKED_WIDTH =
  SCREEN_WIDTH * 2;

const PACKED_HEIGHT =
  SCREEN_HEIGHT * 2;

const isOffscreen =
  process.argv.includes('--offscreen');

let mainWindow =
  null;

let stereoPresenter =
  null;

function getIndexPath() {
  return path.join(
    __dirname,
    '..',
    'dist',
    'index.html'
  );
}

function createPreviewWindow() {
  mainWindow =
    new BrowserWindow({
      width: 1400,
      height: 1050,
      useContentSize: true,
      autoHideMenuBar: true,
      backgroundColor: '#000000',

      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    });

  /*
  * Force the Chromium content surface to match the packed stereo texture.
  *
  * The native presenter expects:
  *
  * 2800 x 2100
  *
  * [ LEFT 1400 x 2100 | RIGHT 1400 x 2100 ]
  */
  mainWindow.setContentSize(
    PACKED_WIDTH,
    PACKED_HEIGHT
  );

  const [windowWidth, windowHeight] =
    mainWindow.getSize();

  const [contentWidth, contentHeight] =
    mainWindow.getContentSize();

  console.log(
    `Electron window size: ${windowWidth}x${windowHeight}`
  );

  console.log(
    `Electron content size: ${contentWidth}x${contentHeight}`
  );

  mainWindow.loadFile(
    getIndexPath()
  );
}

function createOffscreenWindow() {
  /*
   * The native module is loaded inside Electron's main process.
   *
   * No secondary executable is started.
   */
  stereoPresenter =
    require('stereo-presenter');

  const initialization =
    stereoPresenter.initialize();

  console.log(
    'Native stereo presenter initialized'
  );

  console.log(
    `D3D feature level: ${initialization.featureLevel}`
  );

  mainWindow =
    new BrowserWindow({
      x: 0,
      y: 0,

      /*
       * The hidden Chromium surface must match the packed stereo texture:
       *
       * 2800 x 2100
       *
       * [ LEFT 1400 x 2100 | RIGHT 1400 x 2100 ]
       */
      width: PACKED_WIDTH,
      height: PACKED_HEIGHT,

      /*
       * Width and height describe the web content area directly.
       */
      useContentSize: true,

      /*
       * The offscreen renderer does not need any native window decoration.
       */
      frame: false,

      /*
       * The window is never shown.
       *
       * Chromium still renders into the offscreen shared GPU texture.
       */
      show: false,

      /*
       * Prevent Electron from resizing the hidden rendering surface.
       */
      resizable: false,

      /*
       * Allow the hidden rendering surface to exceed the dimensions of the
       * physical display attached to the development computer.
       */
      enableLargerThanScreen: true,

      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,

        offscreen: {
          useSharedTexture: true,
          sharedTexturePixelFormat: 'argb',
          deviceScaleFactor: 1
        }
      }
    });

  /*
   * Explicitly enforce the Chromium content surface size.
   */
  mainWindow.setContentSize(
    PACKED_WIDTH,
    PACKED_HEIGHT
  );

  const [windowWidth, windowHeight] =
    mainWindow.getSize();

  const [contentWidth, contentHeight] =
    mainWindow.getContentSize();

  console.log(
    `Electron window size: ${windowWidth}x${windowHeight}`
  );

  console.log(
    `Electron content size: ${contentWidth}x${contentHeight}`
  );

  let firstFrame =
    true;

  mainWindow.webContents.on(
    'paint',
    (event) => {
      const texture =
        event.texture;

      if (!texture) {
        return;
      }

      try {
        const result =
          stereoPresenter.submitTexture(
            texture.textureInfo
          );

        if (firstFrame) {
          console.log(
            'Shared texture successfully imported into D3D11'
          );

          console.log(
            `Width: ${result.width}`
          );

          console.log(
            `Height: ${result.height}`
          );

          console.log(
            `DXGI format: ${result.format}`
          );

          firstFrame =
            false;
        }

        if (
          result.frameCount % 300 ===
          0
        ) {
          const stats =
            stereoPresenter.getStats();

          console.log(
            [
              `Submitted: ${stats.frameCount}`,
              `Presented pairs: ${stats.presentedStereoPairCount}`,
              `Presented eyes: ${stats.presentedSubframeCount}`,
              `Present rate: ${stats.presentRateHz.toFixed(2)} Hz`
            ].join(' | ')
          );
        }
      } catch (error) {
        console.error(
          'Stereo presenter error:',
          error
        );
      } finally {
        /*
         * The native module has copied the frame into its own D3D11
         * texture before submitTexture() returns.
         *
         * Chromium's texture can now be returned to Electron's pool.
         */
        texture.release();
      }
    }
  );

  /*
   * Three.js currently produces complete stereo pairs at 60 Hz.
   *
   * The later native presenter will independently present left/right
   * images at the physical stereo refresh rate.
   */
  mainWindow.webContents.setFrameRate(
    60
  );

  mainWindow.loadFile(
    getIndexPath()
  );
}

app.whenReady().then(() => {
  if (isOffscreen) {
    createOffscreenWindow();
  } else {
    createPreviewWindow();
  }
});

app.on(
  'before-quit',
  () => {
    if (stereoPresenter) {
      stereoPresenter.shutdown();

      stereoPresenter =
        null;
    }
  }
);

app.on(
  'window-all-closed',
  () => {
    app.quit();
  }
);