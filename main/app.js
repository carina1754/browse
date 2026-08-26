// main/app.js
// Electron app entry point (package.json "main"). Boots the window and
// registers the chat IPC handler. main/index.js stays side-effect-free so
// test/shell.test.js can require it without booting the app.
const { app, ipcMain } = require('electron');
const { createWindow } = require('./index.js');

app.whenReady().then(() => {
  const { chatView } = createWindow();
  // Task 3에서 여기에 에이전트를 붙인다.
  ipcMain.on('chat:send', (_e, text) => {
    chatView.webContents.send('chat:event', { type: 'text', text: `echo: ${text}\n` });
    chatView.webContents.send('chat:event', { type: 'done' });
  });
});

app.on('window-all-closed', () => app.quit());
