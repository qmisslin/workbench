const {
  contextBridge,
  ipcRenderer
} = require('electron');

contextBridge.exposeInMainWorld(
  'trackingBridge',
  {
    getConfig: () =>
      ipcRenderer.invoke(
        'workbench:get-config'
      ),

    readTextAsset: (assetPath) =>
      ipcRenderer.invoke(
        'workbench:read-tracking-text-asset',
        assetPath
      ),

    readBinaryAsset: (assetPath) =>
      ipcRenderer.invoke(
        'workbench:read-tracking-binary-asset',
        assetPath
      ),

    publishTrackingState: (state) => {
      ipcRenderer.send(
        'workbench:publish-tracking-state',
        state
      );
    }
  }
);