// main/app.js
// Electron app entry point (package.json "main"). Boots the window and
// registers the chat IPC handler. main/index.js stays side-effect-free so
// test/shell.test.js can require it without booting the app.
const path = require('node:path');
const fs = require('node:fs');
const { app, ipcMain } = require('electron');
const { createWindow } = require('./index.js');
const { createAgent } = require('./claude.js');

app.whenReady().then(() => {
  const { chatView } = createWindow();

  // 프로젝트 CLAUDE.md 가 에이전트 컨텍스트로 새지 않도록 빈 전용 디렉터리를 쓴다.
  const agentCwd = path.join(app.getPath('userData'), 'agent-cwd');
  fs.mkdirSync(agentCwd, { recursive: true });

  const emit = (evt) => {
    if (!chatView.webContents.isDestroyed()) {
      chatView.webContents.send('chat:event', evt);
    }
  };

  // mcpUrl 은 Task 5 에서 붙인다.
  const agent = createAgent({ cwd: agentCwd, onEvent: emit });

  ipcMain.on('chat:send', (_e, text) => agent.send(text));
  app.on('before-quit', () => agent.stop());
});

app.on('window-all-closed', () => app.quit());
