const {
  contextBridge,
  ipcRenderer
} = require('electron');

contextBridge.exposeInMainWorld(
  'workbench',
  {
    getConfig: () =>
      ipcRenderer.invoke(
        'workbench:get-config'
      ),

    getTrackingState: () =>
      ipcRenderer.invoke(
        'workbench:get-tracking-state'
      ),

    onTrackingState: (callback) => {
      if (typeof callback !== 'function') {
        throw new TypeError(
          'onTrackingState expects a callback function.'
        );
      }

      const listener = (
        _event,
        state
      ) => {
        callback(state);
      };

      ipcRenderer.on(
        'workbench:tracking-state',
        listener
      );

      return () => {
        ipcRenderer.removeListener(
          'workbench:tracking-state',
          listener
        );
      };
    }
  }
);