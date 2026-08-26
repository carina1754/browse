// main/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  send: (text) => ipcRenderer.send('chat:send', text),
  onEvent: (cb) => ipcRenderer.on('chat:event', (_e, evt) => cb(evt)),

  checkDeps: () => ipcRenderer.invoke('deps:check'),
  installDep: (name) => ipcRenderer.invoke('deps:install', name),
  getAccount: (force) => ipcRenderer.invoke('account:get', force),
  logout: () => ipcRenderer.invoke('account:logout'),
  login: () => ipcRenderer.invoke('account:login'),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (next) => ipcRenderer.invoke('settings:set', next),
});
