// main/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  send: (text) => ipcRenderer.send('chat:send', text),
  onEvent: (cb) => ipcRenderer.on('chat:event', (_e, evt) => cb(evt)),
});
