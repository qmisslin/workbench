const {
  app,
  BrowserWindow
} = require('electron/main');

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

const isDiagnostics =
  process.argv.includes('--diagnostics');

const isOffscreen =
  process.argv.includes('--offscreen') ||
  isDiagnostics;

let mainWindow =
  null;

let stereoPresenter =
  null;

let diagnosticsPrinted =
  false;

function getIndexPath() {
  return path.join(
    __dirname,
    '..',
    'dist',
    'index.html'
  );
}

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
    `NVAPI interface: ${nvapi.interfaceVersion ||
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
      `  DXGI stereo modes: ${output.stereoModeCount || 0
      } | query: ${output.stereoQueryStatus ||
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
        `    ... ${stereoModes.length -
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

app.whenReady().then(
  () => {
    if (isOffscreen) {
      createOffscreenWindow();
    } else {
      createPreviewWindow();
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