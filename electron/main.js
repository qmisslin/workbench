const {
  app,
  BrowserWindow,
  ipcMain
} = require('electron/main');

const fs =
  require('node:fs/promises');

const path =
  require('node:path');

const WORKBENCH_CONFIG =
  require('../config/workbench.json');

const SCREEN_WIDTH =
  WORKBENCH_CONFIG.output.screenWidthPx;

const SCREEN_HEIGHT =
  WORKBENCH_CONFIG.output.screenHeightPx;

const PACKED_WIDTH =
  SCREEN_WIDTH * 2;

const PACKED_HEIGHT =
  SCREEN_HEIGHT * 2;

const OFFSCREEN_FRAME_RATE =
  WORKBENCH_CONFIG.rendering.offscreenFrameRateHz;

const DIAGNOSTICS_SAMPLE_FRAMES =
  120;

const TRACKING_ASSET_ROOT =
  path.resolve(
    __dirname,
    '..',
    'dist',
    'tracking'
  );

const isDiagnostics =
  process.argv.includes('--diagnostics');

const isTrackingDebug =
  process.argv.includes('--tracking-debug');

const isOffscreen =
  process.argv.includes('--offscreen') ||
  isDiagnostics;

let mainWindow =
  null;

let trackingWindow =
  null;

let stereoPresenter =
  null;

let diagnosticsPrinted =
  false;

let latestTrackingState = {
  timestampMs: 0,
  sequence: 0,

  viewer: {
    tracked: false,
    calibrated: false,
    transform: null,
    leftEye: null,
    rightEye: null
  },

  body: {
    tracked: false,
    imageLandmarks: [],
    worldLandmarks: [],
    workbenchLandmarks: null
  },

  hands: {
    left: {
      tracked: false
    },
    right: {
      tracked: false
    },
    unassigned: []
  }
};

function getIndexPath() {
  return path.join(
    __dirname,
    '..',
    'dist',
    'index.html'
  );
}

function getTrackingDebugPath() {
  return path.join(
    __dirname,
    '..',
    'dist',
    'tracking-debug.html'
  );
}

function getWorkbenchPreloadPath() {
  return path.join(
    __dirname,
    'workbench-preload.js'
  );
}

function getTrackingPreloadPath() {
  return path.join(
    __dirname,
    'tracking-preload.js'
  );
}

function isTrackingSender(event) {
  return (
    trackingWindow &&
    !trackingWindow.isDestroyed() &&
    event.sender ===
      trackingWindow.webContents
  );
}

function resolveTrackingAsset(
  assetPath
) {
  if (
    typeof assetPath !== 'string' ||
    assetPath.length === 0
  ) {
    throw new TypeError(
      'Tracking asset path must be a non-empty string.'
    );
  }

  if (
    path.isAbsolute(
      assetPath
    )
  ) {
    throw new Error(
      'Absolute tracking asset paths are not allowed.'
    );
  }

  const resolvedPath =
    path.resolve(
      TRACKING_ASSET_ROOT,
      assetPath
    );

  const allowedPrefix =
    `${TRACKING_ASSET_ROOT}${path.sep}`;

  if (
    resolvedPath !==
      TRACKING_ASSET_ROOT &&
    !resolvedPath.startsWith(
      allowedPrefix
    )
  ) {
    throw new Error(
      'Tracking asset path escapes the tracking asset directory.'
    );
  }

  return resolvedPath;
}

ipcMain.handle(
  'workbench:get-config',
  () => WORKBENCH_CONFIG
);

ipcMain.handle(
  'workbench:get-tracking-state',
  () => latestTrackingState
);

ipcMain.handle(
  'workbench:read-tracking-text-asset',
  async (
    event,
    assetPath
  ) => {
    if (
      !isTrackingSender(
        event
      )
    ) {
      throw new Error(
        'Tracking asset access denied.'
      );
    }

    return fs.readFile(
      resolveTrackingAsset(
        assetPath
      ),
      'utf8'
    );
  }
);

ipcMain.handle(
  'workbench:read-tracking-binary-asset',
  async (
    event,
    assetPath
  ) => {
    if (
      !isTrackingSender(
        event
      )
    ) {
      throw new Error(
        'Tracking asset access denied.'
      );
    }

    const buffer =
      await fs.readFile(
        resolveTrackingAsset(
          assetPath
        )
      );

    return buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset +
        buffer.byteLength
    );
  }
);

ipcMain.on(
  'workbench:publish-tracking-state',
  (
    event,
    state
  ) => {
    if (
      !isTrackingSender(
        event
      )
    ) {
      return;
    }

    latestTrackingState =
      state;

    if (
      mainWindow &&
      !mainWindow.isDestroyed()
    ) {
      mainWindow.webContents.send(
        'workbench:tracking-state',
        latestTrackingState
      );
    }
  }
);

function formatHz(value) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return 'unknown';
  }

  return `${value.toFixed(2)} Hz`;
}

function formatBooleanStatus(
  value,
  status
) {
  if (
    typeof value ===
    'boolean'
  ) {
    return [
      value
        ? 'yes'
        : 'no',
      status
        ? `(${status})`
        : ''
    ]
      .filter(Boolean)
      .join(' ');
  }

  return status || 'unavailable';
}

function formatDiagnosticsReport(
  systemDiagnostics,
  stats
) {
  const lines = [
    '=== Workbench diagnostics ==='
  ];

  const nvapi =
    systemDiagnostics.nvapi || {};

  const dxgi =
    systemDiagnostics.dxgi || {};

  const outputs =
    Array.isArray(dxgi.outputs)
      ? dxgi.outputs
      : [];

  const nvapiGpus =
    Array.isArray(nvapi.gpus)
      ? nvapi.gpus
      : [];

  const dxgiGpus = [
    ...new Set(
      outputs
        .map(
          (output) =>
            output.adapterName
        )
        .filter(Boolean)
    )
  ];

  const gpuNames =
    nvapiGpus.length > 0
      ? nvapiGpus
      : dxgiGpus;

  lines.push(
    `GPU: ${gpuNames.length > 0
      ? gpuNames.join(', ')
      : 'unknown'
    }`
  );

  lines.push(
    `NVAPI interface: ${
      nvapi.interfaceVersion ||
      nvapi.interfaceStatus ||
      'unknown'
    }`
  );

  lines.push(
    `NVAPI stereo enabled: ${formatBooleanStatus(
      nvapi.stereoEnabled,
      nvapi.stereoEnabledStatus
    )}`
  );

  lines.push(
    `NVAPI windowed stereo supported: ${formatBooleanStatus(
      nvapi.windowedStereoSupported,
      nvapi.windowedStereoSupportedStatus
    )}`
  );

  lines.push(
    `DXGI windowed stereo enabled: ${formatBooleanStatus(
      dxgi.windowedStereoEnabled,
      dxgi.factory2Status
    )}`
  );

  lines.push(
    `Outputs: ${outputs.length}`
  );

  for (
    const output of outputs
  ) {
    const refresh =
      formatHz(
        output.currentRefreshHz
      );

    lines.push(
      [
        `Output ${output.index}:`,
        output.deviceName || 'unknown',
        '|',
        `${output.currentWidth || 0}x${output.currentHeight || 0}`,
        '@',
        refresh,
        '| desktop',
        `${output.left || 0},${output.top || 0}`,
        '->',
        `${output.right || 0},${output.bottom || 0}`,
        '| adapter',
        output.adapterName || 'unknown'
      ].join(' ')
    );

    lines.push(
      `  DXGI stereo modes: ${
        output.stereoModeCount || 0
      } | query: ${
        output.stereoQueryStatus ||
        'unknown'
      }`
    );

    const stereoModes =
      Array.isArray(
        output.stereoModes
      )
        ? output.stereoModes
        : [];

    const modesToPrint =
      stereoModes.slice(
        0,
        8
      );

    for (
      const mode of modesToPrint
    ) {
      lines.push(
        `    ${mode.width}x${mode.height} @ ${formatHz(
          mode.refreshHz
        )}`
      );
    }

    if (
      stereoModes.length >
      modesToPrint.length
    ) {
      lines.push(
        `    ... ${
          stereoModes.length -
          modesToPrint.length
        } more`
      );
    }
  }

  lines.push(
    [
      'Presentation:',
      `submitted=${stats.frameCount}`,
      `pairs=${stats.presentedStereoPairCount}`,
      `eyes=${stats.presentedSubframeCount}`,
      `rate=${formatHz(stats.presentRateHz)}`
    ].join(' | ')
  );

  lines.push(
    [
      'Packed texture:',
      `${stats.width}x${stats.height}`,
      `DXGI format=${stats.format}`
    ].join(' ')
  );

  lines.push(
    `Native output: ${stats.outputWidth}x${stats.outputHeight}`
  );

  lines.push(
    [
      'Calibration:',
      'config/workbench.json',
      '| tile',
      `${SCREEN_WIDTH}x${SCREEN_HEIGHT}`,
      '| eye distance',
      `${(
        WORKBENCH_CONFIG.stereo.eyeDistanceM *
        1000
      ).toFixed(1)} mm`
    ].join(' ')
  );

  lines.push(
    '=== End diagnostics ==='
  );

  return lines.join('\n');
}

function createPreviewWindow() {
  mainWindow =
    new BrowserWindow({
      width: SCREEN_WIDTH,
      height: SCREEN_HEIGHT,
      useContentSize: true,
      autoHideMenuBar: true,
      backgroundColor: '#000000',

      webPreferences: {
        preload:
          getWorkbenchPreloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    });

  mainWindow.setContentSize(
    PACKED_WIDTH,
    PACKED_HEIGHT
  );

  const [
    windowWidth,
    windowHeight
  ] =
    mainWindow.getSize();

  const [
    contentWidth,
    contentHeight
  ] =
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
  stereoPresenter =
    require('stereo-presenter');

  const initialization =
    stereoPresenter.initialize();

  if (!isDiagnostics) {
    console.log(
      'Native stereo presenter initialized'
    );

    console.log(
      `D3D feature level: ${initialization.featureLevel}`
    );
  }

  mainWindow =
    new BrowserWindow({
      x: 0,
      y: 0,

      width: PACKED_WIDTH,
      height: PACKED_HEIGHT,

      useContentSize: true,
      frame: false,
      show: false,
      resizable: false,
      enableLargerThanScreen: true,

      webPreferences: {
        preload:
          getWorkbenchPreloadPath(),
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

  mainWindow.setContentSize(
    PACKED_WIDTH,
    PACKED_HEIGHT
  );

  if (!isDiagnostics) {
    const [
      windowWidth,
      windowHeight
    ] =
      mainWindow.getSize();

    const [
      contentWidth,
      contentHeight
    ] =
      mainWindow.getContentSize();

    console.log(
      `Electron window size: ${windowWidth}x${windowHeight}`
    );

    console.log(
      `Electron content size: ${contentWidth}x${contentHeight}`
    );
  }

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

      if (
        !stereoPresenter ||
        (
          isDiagnostics &&
          diagnosticsPrinted
        )
      ) {
        texture.release();

        return;
      }

      let quitAfterPaint =
        false;

      try {
        const result =
          stereoPresenter.submitTexture(
            texture.textureInfo
          );

        if (
          firstFrame &&
          !isDiagnostics
        ) {
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
        }

        firstFrame =
          false;

        if (
          isDiagnostics &&
          !diagnosticsPrinted &&
          result.frameCount >=
            DIAGNOSTICS_SAMPLE_FRAMES
        ) {
          const systemDiagnostics =
            stereoPresenter.getSystemDiagnostics();

          const stats =
            stereoPresenter.getStats();

          console.log(
            formatDiagnosticsReport(
              systemDiagnostics,
              stats
            )
          );

          diagnosticsPrinted =
            true;

          quitAfterPaint =
            true;
        }

        if (
          !isDiagnostics &&
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
        texture.release();

        if (quitAfterPaint) {
          setImmediate(
            () => {
              app.quit();
            }
          );
        }
      }
    }
  );

  mainWindow.webContents.setFrameRate(
    OFFSCREEN_FRAME_RATE
  );

  mainWindow.loadFile(
    getIndexPath()
  );
}

function configureTrackingSession() {
  const trackingSession =
    trackingWindow.webContents.session;

  trackingSession.setPermissionCheckHandler(
    (
      webContents,
      permission
    ) => {
      return (
        permission === 'media' &&
        Boolean(webContents) &&
        webContents ===
          trackingWindow?.webContents
      );
    }
  );

  trackingSession.setPermissionRequestHandler(
    (
      webContents,
      permission,
      callback
    ) => {
      callback(
        permission === 'media' &&
        webContents ===
          trackingWindow?.webContents
      );
    }
  );

  /*
   * The tracking renderer is deliberately offline.
   *
   * All runtime resources are supplied from the packaged Workbench files.
   * This does not affect the main viewer session, which may later load a
   * remote application.
   */
  trackingSession.webRequest.onBeforeRequest(
    {
      urls: [
        'http://*/*',
        'https://*/*'
      ]
    },
    (
      _details,
      callback
    ) => {
      callback({
        cancel: true
      });
    }
  );
}

function createTrackingWindow() {
  const debugConfig =
    WORKBENCH_CONFIG.tracking.debugWindow;

  trackingWindow =
    new BrowserWindow({
      width:
        debugConfig.widthPx,
      height:
        debugConfig.heightPx,
      show: true,
      autoHideMenuBar: true,
      backgroundColor: '#111111',

      webPreferences: {
        preload:
          getTrackingPreloadPath(),
        partition:
          'workbench-tracking',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    });

  configureTrackingSession();

  trackingWindow.on(
    'closed',
    () => {
      trackingWindow =
        null;
    }
  );

  trackingWindow.loadFile(
    getTrackingDebugPath()
  );
}

app.whenReady().then(
  () => {
    if (isOffscreen) {
      createOffscreenWindow();
    } else {
      createPreviewWindow();
    }

    if (isTrackingDebug) {
      createTrackingWindow();
    }
  }
);

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