const { app, BrowserWindow } = require('electron/main');
const path = require('node:path');

const SCREEN_WIDTH = 1400;
const SCREEN_HEIGHT = 1050;

const PACKED_WIDTH = SCREEN_WIDTH * 2;
const PACKED_HEIGHT = SCREEN_HEIGHT * 2;

const isOffscreen = process.argv.includes('--offscreen');

let mainWindow = null;

function getIndexPath() {
  return path.join(__dirname, '..', 'dist', 'index.html');
}

function createPreviewWindow() {
  mainWindow = new BrowserWindow({
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

  mainWindow.loadFile(getIndexPath());
}

function createOffscreenWindow() {
  mainWindow = new BrowserWindow({
    width: PACKED_WIDTH,
    height: PACKED_HEIGHT,
    show: false,
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

  let textureInfoPrinted = false;

  mainWindow.webContents.on('paint', (event) => {
    const texture = event.texture;

    if (!texture) {
      return;
    }

    if (!textureInfoPrinted) {
      const info = texture.textureInfo;

      console.log('Shared GPU texture available');
      console.log(`Pixel format: ${info.pixelFormat}`);
      console.log(`Width: ${info.codedSize.width}`);
      console.log(`Height: ${info.codedSize.height}`);
      console.log(`Widget type: ${info.widgetType}`);

      if (info.handle?.ntHandle) {
        console.log(`Windows NT handle size: ${info.handle.ntHandle.length} bytes`);
      }

      textureInfoPrinted = true;
    }

    /*
     * The future native stereo presenter will consume texture.textureInfo
     * here before release().
     *
     * For now, the texture is immediately released because no native
     * consumer is connected yet.
     */
    texture.release();
  });

  /*
   * This controls Chromium's offscreen frame production rate.
   * It is independent from the future physical stereo presentation rate.
   */
  mainWindow.webContents.setFrameRate(60);

  mainWindow.loadFile(getIndexPath());
}

app.whenReady().then(() => {
  if (isOffscreen) {
    createOffscreenWindow();
  } else {
    createPreviewWindow();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});