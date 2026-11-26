'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('nebula', {
  state: () => ipcRenderer.invoke('state'),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  pickSaveDir: () => ipcRenderer.invoke('pick-save-dir'),
  sendFiles: (fp, paths, pin) => ipcRenderer.invoke('send-files', fp, paths, pin),
  sendText: (fp, text, pin) => ipcRenderer.invoke('send-text', fp, text, pin),
  cancel: (id) => ipcRenderer.invoke('cancel', id),
  respond: (id, accept, fileIds) => ipcRenderer.invoke('respond', id, accept, fileIds),
  refresh: () => ipcRenderer.invoke('refresh'),
  scan: () => ipcRenderer.invoke('scan'),
  addDevice: (host) => ipcRenderer.invoke('add-device', host),
  removeDevice: (fp) => ipcRenderer.invoke('remove-device', fp),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  openSaveDir: () => ipcRenderer.invoke('open-save-dir'),
  copy: (t) => ipcRenderer.invoke('copy', t),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onDevices: on('devices'),
  onSelf: on('self'),
  onTransfer: on('transfer'),
  onRequest: on('request'),
  onRequestClosed: on('request-closed'),
  onMessage: on('message'),
  onScanProgress: on('scan-progress'),
  onLog: on('log'),
});
