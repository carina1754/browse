// main/app.js
// Electron app entry point (package.json "main"). Boots the window and
// registers the chat IPC handler. main/index.js stays side-effect-free so
// test/shell.test.js can require it without booting the app.
const path = require('node:path');
const fs = require('node:fs');
const { app, ipcMain } = require('electron');
const { createWindow } = require('./index.js');
const { createTools } = require('./tools.js');
const { startMcpServer } = require('./mcp.js');
const { createAgent } = require('./claude.js');

const SYSTEM_PROMPT = [
  'You drive a web browser pane on behalf of the user. You are not a coding assistant.',
  'Your only tools are the browser tools; you have no filesystem or shell access.',
  '',
  'Workflow: navigate, then snapshot to see what is on the page, then click or type by ref.',
  'Refs come from the most recent snapshot and are invalidated by navigation — take a fresh',
  'snapshot after anything that changes the page. Use read_page to read or summarize content.',
  '',
  'Report what you did and what you found. Never claim a step succeeded without checking',
  'the page afterwards.',
].join('\n');

app.whenReady().then(async () => {
  const { chatView, pageView } = createWindow();

  // 프로젝트 CLAUDE.md 가 에이전트 컨텍스트로 새지 않도록 빈 전용 디렉터리를 쓴다.
  const agentCwd = path.join(app.getPath('userData'), 'agent-cwd');
  fs.mkdirSync(agentCwd, { recursive: true });

  const emit = (evt) => {
    if (!chatView.webContents.isDestroyed()) {
      chatView.webContents.send('chat:event', evt);
    }
  };

  const tools = await createTools(pageView.webContents);
  const mcp = await startMcpServer(tools);
  const agent = createAgent({ cwd: agentCwd, mcpUrl: mcp.url, systemPrompt: SYSTEM_PROMPT, onEvent: emit });

  ipcMain.on('chat:send', (_e, text) => agent.send(text));
  app.on('before-quit', () => {
    agent.stop();
    mcp.close();
  });
}).catch((e) => console.error('boot failed:', e));

app.on('window-all-closed', () => app.quit());
