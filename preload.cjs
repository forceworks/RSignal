const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('signalDesktop', {
  notify: payload => ipcRenderer.invoke('notify', payload),
  openExternal: url => ipcRenderer.invoke('open-external', url),
  setStartup: enabled => ipcRenderer.invoke('set-startup', enabled),
  getStartup: () => ipcRenderer.invoke('get-startup'),
  getApiCapability: () => ipcRenderer.invoke('get-api-capability'),
  onTriggerScan: callback => ipcRenderer.on('trigger-scan', callback),
  onNotificationClick: callback => ipcRenderer.on('notification-click', (_event, payload) => callback(payload))
});
