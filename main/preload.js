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
  listTabs: () => ipcRenderer.invoke('tabs:list'),
  selectTab: (id) => ipcRenderer.invoke('tabs:select', id),
  closeTab: (id) => ipcRenderer.invoke('tabs:close', id),
  newTab: () => ipcRenderer.invoke('tabs:new'),
  onTabs: (cb) => ipcRenderer.on('tabs:changed', (_e, list) => cb(list)),

  openSettings: () => ipcRenderer.invoke('settings:open'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (next) => ipcRenderer.invoke('settings:set', next),
});
